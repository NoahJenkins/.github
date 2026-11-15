// Regression tests for the engine fixes: real pagination at the 100-item
// boundary, bounded production-health reads, transport retries, no-op plans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub } from "./fake-github.mjs";
import { BUN_NEW, NODE_OLD, dockerfile, rawPolicy, tree } from "./fixtures.mjs";
import { githubClient } from "../src/github.mjs";
import { parsePolicy } from "../src/policy.mjs";
import { runPlan } from "../src/reconcile.mjs";
import { productionHealth } from "../src/signals.mjs";
import { runOpenAI } from "../src/transport-openai.mjs";

const NOW = () => new Date().toISOString();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// A real githubClient (real pagination, retry, and URL handling) served from the
// in-memory fake: list endpoints are sliced into pages exactly like GitHub does.
function realClient(fake, calls = []) {
  const fetcher = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    calls.push(`${init.method} ${path}`);
    const perPage = Number(u.searchParams.get("per_page") || 30);
    const page = Number(u.searchParams.get("page") || 1);
    u.searchParams.delete("per_page");
    u.searchParams.delete("page");
    const clean = u.pathname + (u.search || "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    try {
      if (init.method === "GET") {
        let data;
        try {
          data = await fake.paginate(clean);
        } catch {
          data = await fake.get(clean);
        }
        if (Array.isArray(data)) data = data.slice((page - 1) * perPage, page * perPage);
        // Some endpoints wrap their list in a key, like GitHub does.
        const key = /\/check-runs$/.test(u.pathname) ? "check_runs" : /\/runs$/.test(u.pathname) && u.pathname.includes("/workflows/") ? "workflow_runs" : null;
        return json(key && Array.isArray(data) ? { [key]: data } : data);
      }
      const method = { POST: "post", PATCH: "patch", PUT: "put", DELETE: "del" }[init.method];
      return json((await fake[method](clean, body)) ?? {});
    } catch (e) {
      return json({ message: e.message }, e.status ?? 500);
    }
  };
  return githubClient("t", { fetcher, log: () => {} });
}

test("paginate: the cap fails closed only above it (100 and 101 items)", async () => {
  const pages = (n) => {
    const all = Array.from({ length: n }, (_, i) => ({ i }));
    return githubClient("t", { fetcher: async (url) => { const p = Number(new URL(url).searchParams.get("page")); return json(all.slice((p - 1) * 100, p * 100)); } });
  };
  assert.equal((await pages(100).paginate("/x", { max: 2000 })).length, 100);
  assert.equal((await pages(100).paginate("/x", { max: 100 })).length, 100, "exactly the cap is not an overflow");
  await assert.rejects(pages(101).paginate("/x", { max: 100 }), /more than 100 items/);
  assert.equal((await pages(200).paginate("/x", { max: 200 })).length, 200);
  await assert.rejects(pages(201).paginate("/x", { max: 200 }), /more than 200 items/);
});

function world() {
  const raw = rawPolicy();
  const policy = parsePolicy(raw);
  const gh = new FakeGitHub();
  const mainTree = tree();
  mainTree.set(".github/pr-repair.json", JSON.stringify(raw));
  const main = gh.commit(mainTree, [], "main", "NoahJenkins");
  gh.refs.set("main", main);
  const headTree = new Map(mainTree);
  headTree.set("apps/api/Dockerfile", dockerfile(NODE_OLD, BUN_NEW));
  const head = gh.commit(headTree, [main], "bump oven/bun", "dependabot[bot]");
  gh.refs.set("dependabot/docker/apps/api/bun", head);
  gh.pr(167, { title: "fix: bump oven/bun from 1.4.0-slim to 1.4.4-slim in /apps/api", head: { ref: "dependabot/docker/apps/api/bun", sha: head } });
  gh.runs = [{ id: 1, status: "completed", conclusion: "success", updated_at: NOW(), head_sha: main, run_attempt: 1 }];
  for (const name of policy.ci.requiredChecks) gh.checks.push({ id: gh.id(), name, app: { id: 15368 }, head_sha: head, status: "completed", conclusion: "success" });
  const ctx = { approverGh: null, repo: gh.repo, policy, appId: gh.appId, botId: gh.botId, botLogin: gh.botLogin, enabled: true, credentialReady: true, exclusiveActive: false, now: NOW(), log: () => {}, runUrl: "https://example.invalid/run" };
  return { gh, ctx, head, main };
}

test("H1: a merged replacement is found in a repo with 150 closed pull requests (real client)", async () => {
  const w = world();
  for (let n = 1; n <= 150; n++) w.gh.pr(10_000 + n, { state: "closed", merged_at: NOW(), user: { login: "someone" }, head: { ref: `topic/${n}`, sha: w.main } });
  const provenance = `<!-- pr-repair:${JSON.stringify({ root: 167, rootHead: w.head })} -->`;
  w.gh.pr(168, { state: "closed", merged_at: NOW(), body: provenance, user: { login: w.gh.botLogin, type: "Bot" }, head: { ref: "pr-repair/167", sha: w.head } });
  const calls = [];
  const out = await runPlan({ ...w.ctx, gh: realClient(w.gh, calls) });
  assert.equal(out.rows[0].state, "resolved", out.rows[0].detail);
  assert.equal(w.gh.pulls.get(167).state, "closed", "the superseded original is closed");
  assert.ok(!calls.some((c) => /state=closed&base=/.test(c)), "closed history is not listed");
});

test("H1: a failed merged-replacement read fails that evaluation instead of meaning 'never merged'", async () => {
  const w = world();
  const real = realClient(w.gh);
  const gh = Object.create(real);
  gh.get = (path, o) => (path.includes("state=closed") ? Promise.reject(Object.assign(new Error("boom"), { status: 500 })) : real.get(path, o));
  const out = await runPlan({ ...w.ctx, gh });
  assert.equal(out.rows[0].state, "needs-human");
  assert.match(out.rows[0].detail, /evaluation failed/);
});

test("M3: with nothing eligible, plan skips production, workflow, and config reads and rewrites nothing", async () => {
  const w = world();
  w.gh.pulls.clear();
  const calls = [];
  const gh = realClient(w.gh, calls);
  const first = await runPlan({ ...w.ctx, gh });
  assert.deepEqual(first.tasks, []);
  assert.ok(!calls.some((c) => /actions\/workflows|deployments|dependabot\.yml|contents\//.test(c)), calls.join("\n"));
  const writes = w.gh.writes.length;
  await runPlan({ ...w.ctx, gh, now: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(w.gh.writes.length, writes, "a later no-op run writes nothing (the timestamp alone is not a change)");
});

test("M3: unchanged status checks and dashboards are not rewritten on later runs", async () => {
  const w = world();
  const gh = realClient(w.gh);
  await runPlan({ ...w.ctx, gh });
  await runPlan({ ...w.ctx, gh, now: NOW() }); // the reservation changes the state once
  const writes = w.gh.writes.length;
  await runPlan({ ...w.ctx, gh, now: new Date(Date.now() + 3600_000).toISOString(), runUrl: "https://example.invalid/other-run" });
  assert.deepEqual(w.gh.writes.slice(writes).map((x) => `${x.method} ${x.path}`), [], "only the run link and timestamp differ, so nothing is written");
});

test("H2: a failed dashboard write after the ledger is saved still hands over the reserved tasks", async () => {
  const w = world();
  const real = realClient(w.gh);
  const gh = Object.create(real);
  let refused = 0;
  gh.patch = (path, body) => (/\/issues\/\d+$/.test(path) && body?.body?.includes("pr-repair status") ? (refused++, Promise.reject(Object.assign(new Error("502"), { status: 502 }))) : real.patch(path, body));
  const out = await runPlan({ ...w.ctx, gh });
  assert.ok(refused > 0, "the dashboard write was attempted and refused");
  assert.ok(out.tasks.length > 0, "the reservation is not stranded");
});

test("H3: production health reads newest-first pages and never paginates history", async () => {
  const calls = [];
  const gh = {
    get: async (p) => { calls.push(p); return p.includes("/runs?") ? { workflow_runs: [{ id: 9, status: "completed", conclusion: "success", head_sha: "a".repeat(40), created_at: "2026-11-14T00:00:00Z" }, { id: 1, status: "queued", created_at: "2020-01-01T00:00:00Z" }] } : []; },
    paginate: async () => { throw new Error("must not paginate"); },
  };
  const policy = { defaultBranch: "main", merge: { production: { kind: "workflow-run", workflow: "release.yml" } } };
  const h = await productionHealth(gh, "o/r", policy, "a".repeat(40));
  assert.equal(h.healthy, true, "an ancient stuck run does not pause merges");
  assert.match(calls[0], /per_page=10/);
  const dep = {
    get: async (p) => (p.includes("/statuses") ? [{ id: 2, state: "success" }, { id: 1, state: "pending" }] : [{ id: 5, creator: { id: 7 } }, { id: 4, creator: { id: 7 } }]),
    paginate: async () => { throw new Error("must not paginate"); },
  };
  assert.equal((await productionHealth(dep, "o/r", { defaultBranch: "main", merge: { production: { kind: "deployments", environment: "Production", creatorId: 7 } } }, "x")).healthy, true);
});

const OK = { choices: [{ message: { content: '{"files":[]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const base = { endpoint: "http://x", apiKey: "k", model: "m", budget: { maxCalls: { repair: 1 }, maxOutputTokens: 100 }, kind: "repair", prompt: "p", files: new Map([["input.json", "{}"]]), retryDelayMs: 1 };

test("M1: 429, 5xx, and network errors are retried without spending the call budget", async () => {
  const script = [() => json({}, 429, { "retry-after": "0" }), () => { throw new TypeError("fetch failed"); }, () => json(OK)];
  let n = 0;
  const r = await runOpenAI({ ...base, fetcher: async () => script[n++]() });
  assert.deepEqual(r.result, { files: [] });
  assert.equal(n, 3);
  assert.equal(r.usage.requests, 1, "only the successful response is counted");
});

test("M1: retries are bounded and non-transient errors are not retried", async () => {
  let n = 0;
  await assert.rejects(runOpenAI({ ...base, fetcher: async () => (n++, json({}, 503)) }), (e) => e.category === "provider_unavailable");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(runOpenAI({ ...base, fetcher: async () => (n++, json({}, 401)) }), (e) => e.category === "authentication");
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(runOpenAI({ ...base, fetcher: async () => { n++; throw new TypeError("fetch failed"); } }), (e) => e.category === "network");
  assert.equal(n, 3);
});
