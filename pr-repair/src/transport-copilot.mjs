// GitHub Copilot CLI transport, ported from the repository controllers. The
// pinned CLI runs in a locked-down container that sees only the curated data
// (read-only) and its provider credential. Version, digest, image, and model
// come from repository policy.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { TransportError } from "./transport-openai.mjs";
import { dockerEnv } from "./validate.mjs";

const DATA_SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../copilot/copilot-data.cjs");

export function cleanEnv(home = "/home/agent") {
  return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, COPILOT_HOME: `${home}/.copilot`, CI: "true", NO_COLOR: "1", COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES: "65536" };
}

export function cliArgs({ model, prompt, maxAiCredits }, { work = "/tmp", server = "/trusted/copilot-data.cjs", data = "/data", usage = "/output/usage.json", session = randomUUID() } = {}) {
  const mcp = { mcpServers: { curated: { type: "local", command: "node", args: [server, data], tools: ["read_data"] } } };
  return ["-C", work, "--prompt", prompt, "--model", model, "--context", "default", "--max-ai-credits", String(maxAiCredits), "--max-autopilot-continues", "0",
    "--no-auto-update", "--no-custom-instructions", "--disable-builtin-mcps", "--no-ask-user", "--sync-session=off", "--no-bash-env", "--no-experimental",
    "--disallow-temp-dir", "--log-level", "none", "--output-format", "json", "--session-id", session, "--usage-output-file", usage,
    "--secret-env-vars=COPILOT_GITHUB_TOKEN", "--additional-mcp-config", JSON.stringify(mcp), "--available-tools=curated-read_data", "--allow-tool=curated(read_data)"];
}

function agentError(error) {
  const known = ["authentication", "authorization", "policy", "quota", "rate_limit", "context_limit", "query"];
  const cat = known.includes(error?.errorType) ? error.errorType : "agent_error";
  const status = error?.statusCode ?? error?.data?.statusCode;
  return new TransportError(cat, Number.isInteger(status) && status >= 400 && status <= 599 ? `HTTP ${status}` : "session error");
}

// Parses the CLI's JSON event stream. Any tool other than the curated reader,
// any other model, an incomplete answer, or extra output fails closed.
export function observe(child, { model, maxCalls, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "", bytes = 0, calls = 0, output = "", completion = null, settled = false, group = null, sawMessage = false, callHasTools = false;
    const stop = (error) => { if (settled) return; settled = true; clearTimeout(timer); child.kill("SIGKILL"); reject(error); };
    const timer = setTimeout(() => stop(new TransportError("timeout", "agent deadline reached")), timeoutMs);
    child.on("error", () => stop(new TransportError("runtime", "Copilot process failed")));
    child.stderr?.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 20 * 1024 * 1024) return stop(new TransportError("budget", "agent output limit"));
      buffer += decoder.write(chunk);
      let pos;
      while ((pos = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line), data = event.data || {};
          if (completion) throw new TransportError("malformed_output", "output after completion");
          if (event.type === "session.error") throw agentError(data);
          if (event.type === "error") throw agentError(data.error || event.error);
          if (event.type === "model.call_start") {
            if (group && group.next !== group.count) throw new TransportError("malformed_output", "incomplete message chunks");
            if (data.model !== model) throw new TransportError("model_mismatch", "untrusted Copilot model");
            if (++calls > maxCalls) throw new TransportError("budget", `model call limit ${maxCalls} reached`);
            output = ""; group = null; sawMessage = false; callHasTools = false;
          }
          if (event.type === "tool.execution_start" && data.toolName !== "curated-read_data") throw new TransportError("policy", "denied agent tool");
          if (event.type === "assistant.message") {
            if ((data.model !== undefined && data.model !== model) || (data.toolRequests || []).some((t) => t.name !== "curated-read_data")) throw new TransportError("policy", "untrusted Copilot message");
            if (typeof data.content !== "string") throw new TransportError("malformed_output", "invalid message content");
            if (data.chunkIndex !== undefined || data.chunkCount !== undefined) {
              if (!Number.isInteger(data.chunkCount) || data.chunkCount < 1 || data.chunkCount > 64 || !Number.isInteger(data.chunkIndex) || data.chunkIndex < 0) throw new TransportError("malformed_output", "invalid message chunks");
              if (!group) {
                if (sawMessage || data.chunkIndex !== 0) throw new TransportError("malformed_output", "missing message chunk");
                group = { id: data.apiCallId ?? null, count: data.chunkCount, next: 0 };
              }
              if (group.id !== (data.apiCallId ?? null) || group.count !== data.chunkCount || group.next !== data.chunkIndex) throw new TransportError("malformed_output", "mixed message chunks");
              group.next++;
              output += data.content;
            } else {
              if (sawMessage) throw new TransportError("malformed_output", "ambiguous messages");
              output = data.content;
            }
            sawMessage = true;
            if (data.toolRequests?.length) callHasTools = true;
          }
          if (event.type === "result") {
            if (callHasTools || (group && group.next !== group.count)) throw new TransportError("malformed_output", "incomplete final response");
            if (event.exitCode !== 0 || !/^[0-9a-f-]{36}$/.test(event.sessionId || "")) throw new TransportError("runtime", "Copilot session failed");
            completion = event;
          }
        } catch (error) {
          return stop(error instanceof TransportError ? error : new TransportError("malformed_output", "unreadable event"));
        }
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        buffer += decoder.end();
        if (code !== 0 || buffer.trim() || !completion || !calls || !output) throw new TransportError("malformed_output", "incomplete Copilot output");
        resolvePromise({ text: output, sessionId: `ses_${completion.sessionId}`, calls });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function summarizeUsage(value, model) {
  const m = value?.modelMetrics;
  if (!m || Object.keys(m).length !== 1 || !m[model]) throw new Error("missing or unexpected Copilot usage model");
  const counts = { requests: m[model].requests?.count, ...m[model].usage, nanoAiu: value.totalNanoAiu };
  for (const n of Object.values(counts)) if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid Copilot usage");
  return { model, ...counts };
}

// dataRoot: curated input directory. Runs with no GitHub token and no repository code.
export async function runCopilot({ binaryPath, apiKey, model, budget, kind, prompt, dataRoot, copilot, timeoutMs = 20 * 60000, spawnImpl = spawn }) {
  if (!binaryPath || !apiKey || !model || !copilot) throw new TransportError("configuration", "Copilot binary, credential, model, and runtime pin are required");
  const id = `pr-repair-copilot-${randomUUID()}`;
  const outputDir = join(dirname(dataRoot), "usage");
  mkdirSync(outputDir, { recursive: true, mode: 0o777 });
  chmodSync(outputDir, 0o777);
  const config = { model, prompt, maxAiCredits: budget.maxAiCredits ?? 30 };
  const args = ["run", "--platform", "linux/amd64", "--name", id, "--network", "bridge", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--user", "1000:1000", "--memory=2g", "--cpus=2", "--pids-limit=128",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000", "--tmpfs", "/home/agent:rw,nosuid,nodev,size=512m,uid=1000,gid=1000",
    // The pinned bundle loads native addons here. Every other temporary mount stays non-executable.
    "--tmpfs", "/home/agent/.cache/copilot:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000",
    "-v", `${binaryPath}:/usr/local/bin/copilot:ro`, "--mount", "type=bind,source=/etc/ssl/certs/ca-certificates.crt,target=/etc/ssl/certs/ca-certificates.crt,readonly",
    "-v", `${DATA_SERVER}:/trusted/copilot-data.cjs:ro`, "-v", `${dataRoot}:/data:ro`, "-v", `${outputDir}:/output:rw`,
    ...Object.entries(cleanEnv()).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "-e", "COPILOT_GITHUB_TOKEN", copilot.image, "copilot", ...cliArgs(config)];
  const child = spawnImpl("docker", args, { env: { ...dockerEnv(), COPILOT_GITHUB_TOKEN: apiKey } });
  const usagePath = join(outputDir, "usage.json");
  try {
    const r = await observe(child, { model, maxCalls: budget.maxCalls[kind], timeoutMs });
    const usage = existsSync(usagePath) ? summarizeUsage(JSON.parse(readFileSync(usagePath, "utf8")), model) : null;
    let result;
    try {
      result = JSON.parse(r.text.trim());
    } catch {
      throw new TransportError("malformed_output", "final answer is not JSON");
    }
    return { result, usage: { ...usage, sessionId: r.sessionId, calls: r.calls } };
  } finally {
    try { execFileSync("docker", ["rm", "-f", id], { stdio: "ignore", env: dockerEnv() }); } catch { /* already gone */ }
  }
}
