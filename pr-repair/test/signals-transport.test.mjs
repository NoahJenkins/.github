import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { ciState, classifyThreads, reviewResult, REVIEW_CHECK } from "../src/signals.mjs";
import { runOpenAI, isVercelGateway } from "../src/transport-openai.mjs";
import { emptyLedger } from "../src/ledger.mjs";
import { sanitizeLog } from "../src/digest.mjs";
import { validateReview } from "../src/bundle.mjs";

const H = (c) => c.repeat(40);

test("required checks: failure beats pending; wrong app does not count", () => {
  const run = (id, name, conclusion, app = 15368) => ({ id, name, status: conclusion ? "completed" : "in_progress", conclusion, app: { id: app } });
  assert.equal(ciState([run(1, "verify", "success"), run(2, "e2e", null)], ["verify", "e2e"], 15368).state, "pending");
  assert.equal(ciState([run(1, "verify", "failure"), run(2, "e2e", null)], ["verify", "e2e"], 15368).state, "failure");
  assert.equal(ciState([run(1, "verify", "success", 999)], ["verify"], 15368).state, "pending", "a check from another app is not evidence");
  assert.equal(ciState([run(1, "verify", "cancelled")], ["verify"], 15368).state, "interrupted");
  assert.equal(ciState([run(1, "verify", "failure"), run(2, "verify", "success")], ["verify"], 15368).state, "success", "latest run wins");
});

test("only all-agent threads from earlier heads are obsolete", () => {
  const t = (id, comments, total = comments.length) => ({ id, comments: { totalCount: total, nodes: comments.map(([login, oid]) => ({ author: { login }, originalCommit: { oid } })) } });
  const r = classifyThreads(
    [t("old-agent", [["chatgpt-codex-connector", H("1")]]), t("current-agent", [["chatgpt-codex-connector", H("2")]]), t("human", [["NoahJenkins", H("1")]]), t("mixed", [["chatgpt-codex-connector", H("1")], ["NoahJenkins", H("1")]]), t("truncated", [["chatgpt-codex-connector", H("1")]], 60)],
    { agentLogins: ["chatgpt-codex-connector[bot]"], head: H("2") },
  );
  assert.deepEqual(r.obsolete, ["old-agent"]);
  assert.deepEqual(r.blocking, ["current-agent", "human", "mixed", "truncated"]);
});

test("a review check counts only when bound to a published ledger reservation", () => {
  const nonce = "11111111-1111-1111-1111-111111111111";
  const check = { name: REVIEW_CHECK, app: { id: 7 }, head_sha: H("2"), status: "completed", conclusion: "success", id: 1, output: { text: JSON.stringify({ nonce, head: H("2"), base: H("b"), verdict: "approve" }) } };
  const ledger = { ...emptyLedger(), entries: [{ nonce, kind: "review", status: "published", head: H("2"), base: H("b"), root: 1, target: 2, rootHead: H("1"), createdAt: "2026-11-07T00:00:00.000Z" }] };
  assert.equal(reviewResult([check], { appId: 7, head: H("2"), ledger }).verdict, "pass");
  assert.equal(reviewResult([check], { appId: 7, head: H("2"), ledger: emptyLedger() }), null, "a fabricated review without a reservation is ignored");
  assert.equal(reviewResult([{ ...check, app: { id: 8 } }], { appId: 7, head: H("2"), ledger }), null, "another app cannot sign off");
});

test("review reports must cover every changed file", () => {
  const ok = { verdict: "approve", summary: "fine", coveredFiles: ["a", "b"], findings: [] };
  assert.equal(validateReview(ok, ["b", "a"]).passed, true);
  assert.throws(() => validateReview({ ...ok, coveredFiles: ["a"] }, ["a", "b"]), /cover exactly/);
  assert.equal(validateReview({ ...ok, findings: [{ severity: "medium", file: "a", message: "x" }] }, ["a", "b"]).passed, false);
  assert.throws(() => validateReview({ ...ok, findings: [{ severity: "medium", file: "elsewhere", message: "x" }] }, ["a", "b"]));
});

test("logs are sanitized before a model sees them", () => {
  const out = sanitizeLog("2026-01-01T00:00:00Z ::add-mask::x\n\x1b[31mError: token ghp_abcdefghijklmnopqrstuvwxyz123456 leaked\nok");
  assert.doesNotMatch(out, /ghp_|add-mask|\x1b/);
  assert.match(out, /\[redacted\]/);
});

// ---- OpenAI-compatible transport against a local fake endpoint ----
async function fake(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ headers: req.headers, body: JSON.parse(body) });
    handler(seen.length, JSON.parse(body), res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
}
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
const msg = (message, finish = "stop", usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({ choices: [{ message, finish_reason: finish }], usage });
const budget = { maxCalls: { repair: 3, review: 3 }, maxOutputTokens: 100 };
const files = new Map([["input.json", '{"x":1}']]);
const call = (endpoint, extra = {}) => runOpenAI({ endpoint, apiKey: "k", model: "provider/model", budget, kind: "repair", prompt: "p", files, ...extra });

test("transport: tool loop then JSON answer; sends only the configured model and key", async () => {
  const f = await fake((n, body, res) => reply(res, 200, n === 1 ? msg({ content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_data", arguments: '{"operation":"read","file":"input.json"}' } }] }, "tool_calls") : msg({ content: '```json\n{"files":[]}\n```' })));
  try {
    const r = await call(f.endpoint);
    assert.deepEqual(r.result, { files: [] });
    assert.equal(f.seen[0].body.model, "provider/model");
    assert.equal(f.seen[0].headers.authorization, "Bearer k");
    assert.equal(JSON.parse(f.seen[1].body.messages.at(-1).content).content, '{"x":1}');
  } finally { f.close(); }
});

for (const [name, status, category] of [["auth", 401, "authentication"], ["quota", 402, "quota"], ["rate", 429, "rate_limit"], ["outage", 503, "provider_unavailable"], ["model", 404, "model_not_found"]]) {
  test(`transport: HTTP ${status} is a typed ${name} failure`, async () => {
    const f = await fake((n, b, res) => reply(res, status, {}));
    try {
      await assert.rejects(call(f.endpoint), (e) => e.category === category);
      assert.equal(f.seen.length, 1, "paid calls are never retried silently");
    } finally { f.close(); }
  });
}

test("transport: malformed responses and answers fail closed", async () => {
  for (const [body, category] of [["not json", "malformed_response"], [{ choices: [] }, "malformed_response"], [msg({ content: "I fixed it!" }), "malformed_output"], [msg({ content: '{"files":[' }, "length"), "budget"]]) {
    const f = await fake((n, b, res) => reply(res, 200, body));
    try {
      await assert.rejects(call(f.endpoint), (e) => e.category === category, JSON.stringify(body));
    } finally { f.close(); }
  }
});

test("transport: call, token, and time budgets stop the loop", async () => {
  const loop = await fake((n, b, res) => reply(res, 200, msg({ content: null, tool_calls: [{ id: String(n), type: "function", function: { name: "read_data", arguments: '{"operation":"list"}' } }] }, "tool_calls")));
  try {
    await assert.rejects(call(loop.endpoint), (e) => e.category === "budget" && /call limit 3/.test(e.message));
    assert.equal(loop.seen.length, 3);
    assert.deepEqual(loop.seen.map((x) => x.body.tool_choice), ["auto", "auto", "none"]);
  } finally { loop.close(); }
  const greedy = await fake((n, b, res) => reply(res, 200, msg({ content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_data", arguments: '{"operation":"list"}' } }] }, "tool_calls", { prompt_tokens: 1, completion_tokens: 100 })));
  try {
    await assert.rejects(call(greedy.endpoint), (e) => e.category === "budget" && /output token/.test(e.message));
  } finally { greedy.close(); }
  const slow = await fake(() => {});
  try {
    await assert.rejects(call(slow.endpoint, { timeoutMs: 300 }), (e) => e.category === "timeout");
  } finally { slow.close(); }
});

// Metriks #186: the reviewer read files on all 16 allowed calls and never
// answered, so the paid attempt ended with nothing.
test("transport: the last allowed call withholds tools and asks for the answer", async () => {
  const f = await fake((n, b, res) => reply(res, 200, b.tool_choice === "none" ? msg({ content: '{"files":[]}' }) : msg({ content: null, tool_calls: [{ id: String(n), type: "function", function: { name: "read_data", arguments: '{"operation":"list"}' } }] }, "tool_calls")));
  try {
    const r = await call(f.endpoint);
    assert.deepEqual(r.result, { files: [] });
    assert.equal(f.seen.length, 3);
    assert.match(f.seen[2].body.messages.at(-1).content, /final/i);
    assert.equal(f.seen[2].body.messages.at(-1).role, "user");
  } finally { f.close(); }
});

test("transport: refuses to run without endpoint, key, model, or budget", async () => {
  await assert.rejects(runOpenAI({ endpoint: "http://x", apiKey: "", model: "m", budget, kind: "repair", prompt: "", files }), (e) => e.category === "configuration");
  await assert.rejects(runOpenAI({ endpoint: "http://x", apiKey: "k", model: null, budget, kind: "repair", prompt: "", files }), (e) => e.category === "configuration");
});

test("transport: Vercel AI Gateway requests ask for prefix caching and record cache reads", async () => {
  const f = await fake((n, b, res) => reply(res, 200, msg({ content: '{"files":[]}' }, "stop", { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90 } })));
  try {
    const r = await call(f.endpoint, { gatewayCaching: true });
    assert.deepEqual(f.seen[0].body.providerOptions, { gateway: { caching: "auto" } });
    assert.equal(r.usage.cachedTokens, 90);
    await call(f.endpoint);
    assert.equal(f.seen[1].body.providerOptions, undefined, "other endpoints get the plain request");
  } finally { f.close(); }
  assert.equal(isVercelGateway("https://ai-gateway.vercel.sh/v1"), true);
  assert.equal(isVercelGateway("https://ai-gateway.vercel.sh.evil.example/v1"), false);
});

test("finding files come from current-head Codex comments and the controller's review", async () => {
  const { findingFiles } = await import("../src/signals.mjs");
  const head = "2".repeat(40);
  const comments = [
    { user: { login: "chatgpt-codex-connector[bot]" }, commit_id: head, path: "docs/TODO.md" },
    { user: { login: "chatgpt-codex-connector[bot]" }, commit_id: "9".repeat(40), path: "apps/api/src/old.ts" },
    { user: { login: "someone" }, commit_id: head, path: "apps/web/src/x.ts" },
  ];
  assert.deepEqual(findingFiles({ codex: "findings", reviewComments: comments, review: null, head }), ["docs/TODO.md"]);
  assert.deepEqual(findingFiles({ codex: "findings", reviewComments: comments, review: { verdict: "fail", findings: [{ file: "README.md" }] }, head }), ["docs/TODO.md", "README.md"]);
  // Findings without a location are unknown, so a repair stays possible.
  assert.equal(findingFiles({ codex: "findings", reviewComments: [], review: null, head }), null);
  assert.equal(findingFiles({ codex: "pass", reviewComments: [], review: { verdict: "fail", findings: [{ message: "x" }] }, head }), null);
  assert.deepEqual(findingFiles({ codex: "pass", reviewComments: comments, review: null, head }), []);
});

test("base drift: only files main changed since the review, and only when main moved forward", async () => {
  const { driftOverlap } = await import("../src/repo.mjs");
  const A = "a".repeat(40), B = "b".repeat(40);
  const gh = (cmp) => ({ get: async () => cmp });
  assert.deepEqual(await driftOverlap(gh({ status: "ahead", files: [{ filename: ".github/workflows/x.yml" }] }), "o/r", A, B, ["apps/api/Dockerfile"]), []);
  assert.deepEqual(await driftOverlap(gh({ status: "ahead", files: [{ filename: "apps/api/Dockerfile" }] }), "o/r", A, B, ["apps/api/Dockerfile"]), ["apps/api/Dockerfile"]);
  assert.equal(await driftOverlap(gh({ status: "diverged", files: [] }), "o/r", A, B, ["x"]), null, "a rewritten main is never trusted");
  assert.equal(await driftOverlap(gh({ status: "ahead", files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) }), "o/r", A, B, ["x"]), null);
  assert.deepEqual(await driftOverlap(gh({ status: "ahead", files: [{ filename: "y", previous_filename: "x" }] }), "o/r", A, B, ["x"]), ["x"], "a rename away from a reviewed file overlaps");
});

test("an App refresh counts only when the head is exactly main plus the bot's own changes", async () => {
  const { soundRefreshes } = await import("../src/repo.mjs");
  const { FakeGitHub } = await import("./fake-github.mjs");
  const make = ({ mainChange = ["SECURITY.md", "fixed"], head = (t) => t, botAfter = false, committer = "web-flow", mergeParent = null } = {}) => {
    const gh = new FakeGitHub();
    const base = gh.commit(new Map([["package.json", "x 1.0.0"], ["auth.js", "old"]]), [], "base", "NoahJenkins");
    const tip = gh.commit(new Map([["package.json", "x 1.0.1"], ["auth.js", "old"]]), [base], "bump", "dependabot[bot]");
    const mainTree = new Map(gh.commits.get(base).tree).set(...mainChange);
    const main = gh.commit(mainTree, [base], "main", "NoahJenkins");
    gh.refs.set("main", main);
    const clean = new Map(mainTree).set("package.json", "x 1.0.1");
    const merge = gh.commit(head(clean), [tip, mergeParent ?? main], "Merge main", gh.botLogin);
    gh.commits.get(merge).committer = committer;
    let last = merge;
    if (botAfter) last = gh.commit(new Map(head(clean)).set("evil.js", "x"), [merge], "bump", "dependabot[bot]");
    gh.refs.set("dependabot/x", last);
    gh.pr(1, { head: { ref: "dependabot/x", sha: last }, base: { ref: "main", sha: base } });
    return { gh, args: { commits: gh.prCommits(1), head: last, baseSha: main, botLogin: gh.botLogin, authors: ["dependabot[bot]"] }, merge };
  };
  const ok = make();
  assert.deepEqual([...(await soundRefreshes(ok.gh, ok.gh.repo, ok.args))], [ok.merge], "a clean update-branch merge");
  const reject = async (opts, why) => { const w = make(opts); assert.equal((await soundRefreshes(w.gh, w.gh.repo, w.args)).size, 0, why); };
  await reject({ mainChange: ["auth.js", "fixed"], head: (t) => new Map(t).set("auth.js", "old") }, "reverting a file main changed");
  await reject({ mainChange: ["SECURITY.md", "new"], head: (t) => { const n = new Map(t); n.delete("SECURITY.md"); return n; } }, "deleting a file main added");
  await reject({ head: (t) => new Map(t).set("evil.js", "x") }, "adding content");
  await reject({ mainChange: ["package.json", "x 1.0.0\nscripts"] }, "main changed a file the bot changes");

  // ark #180/#182: main (#181) and the bot changed one workflow file on
  // different lines. The head must be exactly the three-way merge.
  const shared = async (headCi, { mainCi = "a: checkout@7\nb: x\nc: setup-node@4\n", botCi = "a: checkout@4\nb: x\nc: setup-node@7\n" } = {}) => {
    const gh = new FakeGitHub();
    const ci = ".github/workflows/ci.yaml";
    const base = gh.commit(new Map([[ci, "a: checkout@4\nb: x\nc: setup-node@4\n"], ["README.md", "r"]]), [], "base", "NoahJenkins");
    const tip = gh.commit(new Map(gh.commits.get(base).tree).set(ci, botCi), [base], "bump setup-node", "dependabot[bot]");
    const main = gh.commit(new Map(gh.commits.get(base).tree).set(ci, mainCi), [base], "bump checkout", "NoahJenkins");
    gh.refs.set("main", main);
    const merge = gh.commit(new Map(gh.commits.get(main).tree).set(ci, headCi), [tip, main], "Merge main", gh.botLogin);
    gh.commits.get(merge).committer = "web-flow";
    gh.refs.set("dependabot/x", merge);
    gh.pr(1, { head: { ref: "dependabot/x", sha: merge }, base: { ref: "main", sha: base } });
    return (await soundRefreshes(gh, gh.repo, { commits: gh.prCommits(1), head: merge, baseSha: main, botLogin: gh.botLogin, authors: ["dependabot[bot]"] })).size;
  };
  assert.equal(await shared("a: checkout@7\nb: x\nc: setup-node@7\n"), 1, "a clean merge of non-overlapping lines");
  assert.equal(await shared("a: checkout@4\nb: x\nc: setup-node@7\n"), 0, "the merge undoes main's line");
  assert.equal(await shared("a: checkout@7\nb: x\nc: setup-node@7\nrun: evil\n"), 0, "the merge adds a line");
  assert.equal(await shared("a: checkout@7\nb: x\nc: setup-node@9\n", { mainCi: "a: checkout@4\nb: x\nc: setup-node@9\n" }), 0, "both changed the same line: a conflict is never proven");
  await reject({ botAfter: true }, "a bot commit after the App merge");
  await reject({ committer: "app[bot]" }, "not committed by GitHub");
  // A merge of a main commit older than the bot's base would undo main's later work.
  {
    const gh = new FakeGitHub();
    const p0 = gh.commit(new Map([["package.json", "x 1.0.0"], ["auth.js", "old"]]), [], "P", "NoahJenkins");
    const o = gh.commit(new Map(gh.commits.get(p0).tree).set("auth.js", "fixed").set("SECURITY.md", "s"), [p0], "O", "NoahJenkins");
    const tip = gh.commit(new Map(gh.commits.get(o).tree).set("package.json", "x 1.0.1"), [o], "bump", "dependabot[bot]");
    gh.refs.set("main", o);
    const forged = gh.commit(new Map(gh.commits.get(p0).tree).set("package.json", "x 1.0.1"), [tip, p0], "Merge", gh.botLogin);
    gh.commits.get(forged).committer = "web-flow";
    gh.refs.set("dependabot/x", forged);
    gh.pr(1, { head: { ref: "dependabot/x", sha: forged }, base: { ref: "main", sha: o } });
    const set = await soundRefreshes(gh, gh.repo, { commits: gh.prCommits(1), head: forged, baseSha: o, botLogin: gh.botLogin, authors: ["dependabot[bot]"] });
    assert.equal(set.size, 0, "merging a main commit older than the bot's base");
  }
  const side = new FakeGitHub();
  const stray = side.commit(new Map([["x", "y"]]), [], "x", "NoahJenkins");
  await reject({ mergeParent: stray }, "second parent is not on main");
});

test("base drift: the policy file always counts, and a failed comparison is not trusted", async () => {
  const { driftOverlap } = await import("../src/repo.mjs");
  const A = "a".repeat(40), B = "b".repeat(40);
  const ok = { get: async () => ({ status: "ahead", files: [{ filename: ".github/pr-repair.json" }] }) };
  assert.deepEqual(await driftOverlap(ok, "o/r", A, B, ["apps/api/Dockerfile"]), [".github/pr-repair.json"]);
  const broken = { get: async () => { throw Object.assign(new Error("404"), { status: 404 }); } };
  assert.equal(await driftOverlap(broken, "o/r", A, B, ["x"]), null);
});
