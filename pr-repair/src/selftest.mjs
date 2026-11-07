// Credential-free consumer check: the policy parses, every declared runtime
// field holds the current runtime value, and the inference transport works
// against a local fake endpoint. Safe on pull_request.
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { matchesAny } from "../../review-gate/src/glob.mjs";
import { dockerFroms, exactImageVersion, isDockerfile, syncRuntimeFields } from "./contract.mjs";
import { POLICY_PATH, parsePolicy, inferenceGaps } from "./policy.mjs";
import { runOpenAI, TransportError } from "./transport-openai.mjs";

function files(root, accept, prefix = "", out = new Map()) {
  for (const name of readdirSync(join(root, prefix))) {
    if (name === ".git" || name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(join(root, rel));
    if (st.isDirectory()) files(root, accept, rel, out);
    else if (st.isFile() && accept(rel) && st.size < 2 * 1024 * 1024) out.set(rel, readFileSync(join(root, rel), "utf8"));
  }
  return out;
}

// The contract holds at rest when syncing the current runtime to itself finds
// every required field (same value on both sides of the move).
export async function contractAtRest(policy, tree, { fetcher = fetch } = {}) {
  const problems = [];
  const docker = [...tree].filter(([p]) => isDockerfile(p));
  for (const runtime of policy.runtimes) {
    const refs = new Set(docker.flatMap(([, t]) => dockerFroms(t).filter((f) => f.image === runtime.image).map((f) => f.ref)));
    if (refs.size !== 1) {
      problems.push(`${runtime.name}: expected one ${runtime.image} image across Dockerfiles, found ${refs.size}`);
      continue;
    }
    const ref = [...refs][0];
    const [, tag, dg] = ref.match(/^[^:]+:([^@]+)@sha256:([0-9a-f]{64})$/);
    const m = tag.match(new RegExp(runtime.versionPattern));
    if (!m?.groups?.version) {
      problems.push(`${runtime.name}: ${tag} does not match versionPattern`);
      continue;
    }
    const parts = m.groups.version.split(".");
    let v = { ref, tag, digest: dg, version: m.groups.version, major: parts[0], minor: parts.length > 1 ? parts.slice(0, 2).join(".") : null };
    try {
      if (runtime.versionFromImageEnv) v = await exactImageVersion(runtime, v, fetcher);
      syncRuntimeFields(policy, [{ runtime: runtime.name, image: runtime.image, from: v, to: v }], tree);
    } catch (e) {
      problems.push(e.message);
    }
  }
  return problems;
}

async function fakeEndpointCheck() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    calls++;
    if (req.headers.authorization !== "Bearer fake-key") { res.writeHead(401); return res.end("{}"); }
    if (msg.model === "fake/fail") { res.writeHead(503); return res.end("{}"); }
    const toolDone = msg.messages.some((m) => m.role === "tool");
    const message = toolDone
      ? { role: "assistant", content: '{"files":[]}' }
      : { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_data", arguments: '{"operation":"read","file":"input.json"}' } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: msg.model, choices: [{ message, finish_reason: toolDone ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const budget = { maxCalls: { repair: 4, review: 4 }, maxOutputTokens: 1000 };
  const data = new Map([["input.json", '{"task":"selftest"}']]);
  try {
    const ok = await runOpenAI({ endpoint, apiKey: "fake-key", model: "fake/model", budget, kind: "repair", prompt: "selftest", files: data });
    if (JSON.stringify(ok.result) !== '{"files":[]}' || ok.usage.requests !== 2) throw new Error("fake endpoint round trip failed");
    try {
      await runOpenAI({ endpoint, apiKey: "fake-key", model: "fake/fail", budget, kind: "repair", prompt: "selftest", files: data });
      throw new Error("a provider failure was not reported");
    } catch (e) {
      if (!(e instanceof TransportError) || e.category !== "provider_unavailable") throw e;
    }
    return `openai-compatible transport passed against a local fake endpoint (${calls} requests, no credential)`;
  } finally {
    server.close();
  }
}

export async function selftest({ root, log }) {
  const policy = parsePolicy(JSON.parse(readFileSync(join(root, POLICY_PATH), "utf8")));
  log(`policy: ${POLICY_PATH} parses (${Object.keys(policy.eligibility.updates).join(", ")}; checks: ${policy.ci.requiredChecks.join(", ")})`);
  const globs = policy.runtimes.flatMap((r) => r.fields.flatMap((f) => f.files));
  const tree = files(root, (p) => isDockerfile(p) || (globs.length > 0 && matchesAny(p, globs)));
  const problems = await contractAtRest(policy, tree);
  for (const p of problems) log(`::error title=pr-repair runtime contract::${p}`);
  log(`runtime contract: ${policy.runtimes.length} runtime(s), ${problems.length ? `${problems.length} problem(s)` : "every required field holds the current value"}`);
  log(await fakeEndpointCheck());
  const gaps = inferenceGaps(policy, { credentialReady: true }).filter((g) => !g.includes("credential"));
  log(gaps.length ? `activation: paid work stays paused until ${gaps.join("; ")}` : `activation: inference configured (${policy.inference.transport}; repair ${policy.inference.model.repair}, review ${policy.inference.model.review})`);
  if (problems.length) throw new Error("runtime contract does not hold at rest");
}
