// End-to-end over a fake GitHub: Metriks #167 from failed CI through trusted
// sync, validation, publication, review, merge, and closing the original.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeGitHub } from "./fake-github.mjs";
import { BUN_NEW, NODE_OLD, dockerfile, rawPolicy, tree } from "./fixtures.mjs";
import { parsePolicy } from "../src/policy.mjs";
import { runPlan } from "../src/reconcile.mjs";
import { runPublish, runValidate } from "../src/tasks.mjs";
import { MARKER, readLedger } from "../src/ledger.mjs";
import { seal } from "../src/digest.mjs";
import { REVIEW_CHECK, STATUS_CHECK } from "../src/signals.mjs";

const NOW = () => new Date().toISOString();

function gitCheckout(files) {
  const dir = mkdtempSync(join(tmpdir(), "pr-repair-e2e-"));
  for (const [p, c] of files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "head");
  return { dir, sha: git("rev-parse", "HEAD") };
}

function world(patch = (p) => p) {
  const raw = patch(rawPolicy());
  const policy = parsePolicy(raw);
  const gh = new FakeGitHub();
  const mainTree = tree();
  mainTree.set(".github/pr-repair.json", JSON.stringify(raw));
  const main = gh.commit(mainTree, [], "main", "NoahJenkins");
  gh.refs.set("main", main);
  const headTree = new Map(mainTree);
  headTree.set("apps/api/Dockerfile", dockerfile(NODE_OLD, BUN_NEW));
  const checkout = gitCheckout(headTree);
  const head = gh.commit(headTree, [main], "bump oven/bun", "dependabot[bot]", checkout.sha);
  gh.refs.set("dependabot/docker/apps/api/bun", head);
  gh.pr(167, { title: "fix: bump oven/bun from 1.4.0-slim to 1.4.4-slim in /apps/api", head: { ref: "dependabot/docker/apps/api/bun", sha: head } });
  const ci = (sha, conclusion) => {
    for (const name of policy.ci.requiredChecks) gh.checks.push({ id: gh.id(), name, app: { id: 15368 }, head_sha: sha, status: "completed", conclusion: name === "browser e2e" ? "success" : conclusion });
  };
  ci(head, "failure");
  gh.runs = [{ id: 1, status: "completed", conclusion: "success", updated_at: NOW(), head_sha: main, run_attempt: 1 }];
  const ctx = { gh, approverGh: null, repo: gh.repo, policy, appId: gh.appId, botId: gh.botId, botLogin: gh.botLogin, enabled: true, credentialReady: true, exclusiveActive: false, now: NOW(), log: () => {}, runUrl: "https://example.invalid/run" };
  return { gh, policy, ctx, head, main, ci, checkout };
}

const ledgerOf = (gh) => readLedger(gh.comments.filter((c) => c.body.startsWith(MARKER)), gh.botId).ledger;

test("#167: failed Bun patch -> trusted sync -> validated replacement -> review -> merge -> original closed", async (t) => {
  const w = world((p) => ({ ...p, review: { requireCodex: false, agentLogins: [] }, merge: { ...p.merge, approve: "app" } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));

  // 1. Plan reserves a free, trusted sync before any model work.
  const p1 = await runPlan(w.ctx);
  assert.deepEqual(p1.tasks.map((x) => [x.kind, x.target]), [["sync", 167]]);
  assert.equal(p1.rows[0].state, "repairing");
  assert.ok(w.gh.checks.some((c) => c.name === STATUS_CHECK && c.head_sha === w.head), "the PR shows an actionable status");
  assert.match([...w.gh.issues.values()][0].body, /\| #167 \| #167 \| `.{7}` \| \*\*repairing\*\*/);
  const task = p1.tasks[0];

  // 2. Validate in the candidate checkout (container run replaced by a stub).
  const out = mkdtempSync(join(tmpdir(), "pr-repair-out-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const v = await runValidate({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {} }, task, {
    candidateRoot: w.checkout.dir,
    proposalDir: out,
    outDir: join(out, "validated"),
    validation: ({ image }) => {
      assert.equal(image, NODE_OLD, "validation runs on the repository's runtime image");
      return { passed: true, results: [{ name: "pnpm test", passed: true }], generated: new Map([["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"]]) };
    },
  });
  assert.equal(v.passed, true, (v.reasons ?? []).join("; "));

  // 3. Publish: authenticated branch, atomic commit, replacement PR.
  const pub = await runPublish({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin }, task, { proposalDir: out, validatedDir: join(out, "validated") });
  assert.equal(pub.published, true);
  const replacement = w.gh.pulls.get(pub.replacement);
  const repaired = w.gh.commits.get(replacement.head.sha).tree;
  assert.match(repaired.get("scripts/ops/smoke-api-docker.sh"), /'1\.4\.4'/);
  assert.ok(repaired.get("scripts/safety/test-runtime-contract.sh").includes(BUN_NEW));
  assert.ok(repaired.get("apps/api/Dockerfile").includes(BUN_NEW), "the requested image is retained");
  assert.match(w.gh.commits.get(replacement.head.sha).message, new RegExp(`PR-Repair-Nonce: ${task.nonce}`));
  assert.equal(ledgerOf(w.gh).entries.find((e) => e.nonce === task.nonce).status, "published");
  await assert.rejects(runPublish({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin }, task, { proposalDir: out, validatedDir: join(out, "validated") }), /nothing is published twice/);

  // 4. Fresh CI on the replacement, then an independent review is reserved.
  w.ci(replacement.head.sha, "success");
  const p2 = await runPlan({ ...w.ctx, now: NOW() });
  assert.deepEqual(p2.tasks.map((x) => [x.kind, x.target]), [["review", pub.replacement]]);
  const reviewTask = p2.tasks[0];
  const files = w.gh.compare(w.main, replacement.head.sha).files.map((f) => f.filename);
  writeFileSync(join(out, "proposal.json"), JSON.stringify(seal({ task: reviewTask, transport: "openai-compatible", model: "deepseek/deepseek-v4-flash", result: { verdict: "approve", summary: "Bun 1.4.4 and its declared fields agree.", coveredFiles: files, findings: [] } })));
  const rev = await runPublish({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin }, reviewTask, { proposalDir: out, validatedDir: join(out, "validated") });
  assert.equal(rev.review, "approve");
  assert.ok(w.gh.checks.some((c) => c.name === REVIEW_CHECK && c.conclusion === "success" && c.head_sha === replacement.head.sha));

  // 5. Merge: approval and native auto-merge bound to the exact head.
  const p3 = await runPlan({ ...w.ctx, now: NOW() });
  assert.equal(p3.rows[0].state, "queued-merge");
  const merge = w.gh.writes.find((x) => x.method === "GRAPHQL" && x.path === "enablePullRequestAutoMerge");
  assert.equal(merge.body.head, replacement.head.sha);
  assert.ok(w.gh.writes.some((x) => x.path.endsWith(`/pulls/${pub.replacement}/reviews`) && x.body.event === "APPROVE" && x.body.commit_id === replacement.head.sha));

  // 6. After the replacement merges, the original closes because its head still matches.
  Object.assign(replacement, { state: "closed", merged_at: NOW() });
  const p4 = await runPlan({ ...w.ctx, now: NOW() });
  assert.equal(p4.rows[0].state, "resolved");
  assert.equal(w.gh.pulls.get(167).state, "closed");
});

test("a stale head at publication consumes the attempt and writes nothing", async (t) => {
  const w = world();
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const { tasks } = await runPlan(w.ctx);
  const out = mkdtempSync(join(tmpdir(), "pr-repair-out-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await runValidate({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {} }, tasks[0], { candidateRoot: w.checkout.dir, proposalDir: out, outDir: join(out, "validated"), validation: () => ({ passed: true, results: [], generated: new Map() }) });
  w.gh.pulls.get(167).head.sha = "9".repeat(40); // Dependabot pushed a new head
  const before = w.gh.writes.length;
  const r = await runPublish({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin }, tasks[0], { proposalDir: out, validatedDir: join(out, "validated") });
  assert.equal(r.published, false);
  assert.ok(w.gh.writes.slice(before).every((x) => x.path.includes("/issues/comments/")), "only the ledger changed");
  assert.equal(ledgerOf(w.gh).entries[0].status, "failed");
  assert.equal(w.gh.refs.has("pr-repair/167"), false);
});

test("a failed candidate is recorded as feedback and its attempt stays consumed", async (t) => {
  const w = world();
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const { tasks } = await runPlan(w.ctx);
  const out = mkdtempSync(join(tmpdir(), "pr-repair-out-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await runValidate({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {} }, tasks[0], { candidateRoot: w.checkout.dir, proposalDir: out, outDir: join(out, "validated"), validation: () => ({ passed: false, results: [{ name: "pnpm test", passed: false, output: "expected Bun 1.4.0" }], generated: new Map() }) });
  const r = await runPublish({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin }, tasks[0], { proposalDir: out, validatedDir: join(out, "validated") });
  assert.equal(r.published, false);
  const entry = ledgerOf(w.gh).entries[0];
  assert.equal(entry.status, "failed");
  assert.equal(entry.feedback.failing[0].step, "pnpm test");
  // The per-head sync is spent; the next run escalates to model repair.
  const p2 = await runPlan({ ...w.ctx, now: NOW() });
  assert.deepEqual(p2.tasks.map((x) => x.kind), []);
  assert.equal(p2.rows[0].state, "exhausted");
});

test("interrupted publication is recovered from the branch, never replayed", async (t) => {
  const w = world();
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const { tasks } = await runPlan(w.ctx);
  const nonce = tasks[0].nonce;
  // Simulate a job that wrote the commit and died before the PR and receipt.
  const comment = w.gh.comments.find((c) => c.body.startsWith(MARKER));
  const ledger = JSON.parse(comment.body.slice(MARKER.length));
  ledger.entries[0].status = "publishing";
  ledger.entries[0].updatedAt = new Date(Date.now() - 20 * 60000).toISOString();
  comment.body = `${MARKER}\n${JSON.stringify(ledger)}`;
  const tree2 = new Map(w.gh.commits.get(w.head).tree);
  tree2.set("scripts/ops/smoke-api-docker.sh", "== '1.4.4' expected Bun 1.4.4\n");
  w.gh.refs.set("pr-repair/167", w.gh.commit(tree2, [w.head], `fix(deps): repair\n\nPR-Repair-Nonce: ${nonce}`, w.gh.botLogin));

  await runPlan({ ...w.ctx, now: NOW() });
  const entry = ledgerOf(w.gh).entries.find((e) => e.nonce === nonce);
  assert.equal(entry.status, "published");
  assert.ok(entry.replacement, "the missing replacement PR was opened from the recorded reservation");
  assert.equal([...w.gh.pulls.values()].filter((p) => p.head.ref === "pr-repair/167").length, 1);
});

test("missing configuration pauses visibly before reserving anything", async (t) => {
  const w = world((p) => ({ ...p, inference: { transport: null, model: null } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const first = await runPlan(w.ctx);
  assert.equal(first.tasks[0].kind, "sync", "trusted sync needs no model");
  const inflight = await runPlan({ ...w.ctx, now: NOW() });
  assert.deepEqual([inflight.tasks.length, inflight.rows[0].state], [0, "repairing"], "an open reservation is shown as in progress, not exhausted");
  // The sync published, yet CI still fails on the new head: model repair is next.
  const comment = w.gh.comments.find((c) => c.body.startsWith(MARKER));
  const ledger = JSON.parse(comment.body.slice(MARKER.length));
  Object.assign(ledger.entries[0], { status: "failed", updatedAt: NOW() });
  comment.body = `${MARKER}\n${JSON.stringify(ledger)}`;
  w.gh.pulls.get(167).head.sha = w.gh.commit(w.gh.commits.get(w.head).tree, [w.head], "rebased", "dependabot[bot]");
  w.ci(w.gh.pulls.get(167).head.sha, "failure");
  const contract = await runPlan({ ...w.ctx, credentialReady: false, now: NOW() });
  assert.equal(contract.tasks[0]?.kind, "sync", "a new head gets its own trusted sync");
  Object.assign(ledger.entries[0], {});
  const l2 = JSON.parse(w.gh.comments.find((c) => c.body.startsWith(MARKER)).body.slice(MARKER.length));
  for (const e of l2.entries) Object.assign(e, { status: "failed", updatedAt: NOW() });
  w.gh.comments.find((c) => c.body.startsWith(MARKER)).body = `${MARKER}\n${JSON.stringify(l2)}`;
  const paused = await runPlan({ ...w.ctx, credentialReady: false, now: NOW() });
  assert.deepEqual(paused.tasks, []);
  assert.equal(paused.rows[0].state, "exhausted", "sync for this head is spent");
});

test("model repair pauses on missing model, credential, or budget without a reservation", async (t) => {
  const w = world((p) => ({ ...p, runtimes: [], inference: { transport: "openai-compatible", model: null } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const first = await runPlan({ ...w.ctx, credentialReady: false });
  assert.equal(first.rows[0].state, "waiting-ci", "the failure is re-run once first");
  const p = await runPlan({ ...w.ctx, credentialReady: false, now: NOW() });
  assert.deepEqual(p.tasks, []);
  assert.equal(p.rows[0].state, "missing-configuration");
  assert.match(p.rows[0].detail, /inference\.model is not set.*credential/);
  assert.deepEqual(ledgerOf(w.gh).entries, [], "no attempt was reserved (only the re-run mark is recorded)");
  assert.ok(w.gh.checks.some((c) => c.name === STATUS_CHECK && c.conclusion === "action_required"));
});

test("disabled automation reports status without writing", async (t) => {
  const w = world();
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const p = await runPlan({ ...w.ctx, enabled: false });
  assert.equal(p.rows[0].state, "disabled");
  assert.deepEqual(w.gh.writes, []);
});

test("model repair: prepare -> infer over a fake endpoint -> admission rejects test weakening, accepts a source fix", async (t) => {
  const { createServer } = await import("node:http");
  const { runInfer, runPrepare } = await import("../src/tasks.mjs");
  const w = world((p) => ({ ...p, runtimes: [], validation: { ...p.validation, image: NODE_OLD }, inference: { transport: "openai-compatible", model: { repair: "openai/gpt-6-luna", review: "deepseek/deepseek-v4-flash" }, endpoint: "https://gateway.invalid/v1", budget: { maxCalls: { repair: 4, review: 4 }, maxOutputTokens: 4000 } } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  assert.deepEqual((await runPlan(w.ctx)).tasks, [], "first the failed checks are re-run");
  assert.ok(w.gh.writes.some((x) => x.path.endsWith("/actions/runs/555/rerun-failed-jobs")), "the failed run was re-run");
  const { tasks } = await runPlan({ ...w.ctx, now: NOW() });
  assert.deepEqual(tasks.map((x) => x.kind), ["repair"]);
  const task = tasks[0];

  let answer;
  const models = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    models.push(JSON.parse(body).model);
    const done = JSON.parse(body).messages.some((m) => m.role === "tool");
    const message = done ? { content: JSON.stringify(answer) } : { content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_data", arguments: '{"operation":"list"}' } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: done ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const fetcher = (url, init) => fetch(url.replace("https://gateway.invalid", `http://127.0.0.1:${server.address().port}`), init);

  for (const [proposal, ok] of [
    [{ files: [{ path: "apps/api/src/__tests__/runtime.test.ts", content: "test.skip('x')" }] }, false],
    [{ files: [{ path: "apps/api/src/index.ts", content: "export const app = 1;\n" }] }, true],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "pr-repair-model-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await runPrepare({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId }, task, dir);
    const evidence = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(dir, "data/input.json"), "utf8"))).evidence;
    assert.ok(evidence.some((e) => e.startsWith("evidence/failed-verify")), "failed-check logs reach the model as data");
    answer = proposal;
    await runInfer({ policy: w.policy, env: { PR_REPAIR_API_KEY: "fake" }, fetcher, log: () => {} }, task, dir);
    const fresh = gitCheckout(w.gh.commits.get(w.head).tree);
    t.after(() => rmSync(fresh.dir, { recursive: true, force: true }));
    const v = await runValidate({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {} }, { ...task, head: task.head }, {
      candidateRoot: w.checkout.dir,
      proposalDir: dir,
      outDir: join(dir, "validated"),
      validation: () => ({ passed: true, results: [], generated: new Map() }),
    });
    assert.equal(v.passed, ok, (v.reasons ?? []).join("; "));
    if (!ok) assert.match(v.reasons.join(), /runtime\.test\.ts is protected/);
  }
  assert.deepEqual([...new Set(models)], ["openai/gpt-6-luna"], "repairs use the repair model");
  const entry = JSON.parse(w.gh.comments.find((c) => c.body.startsWith(MARKER)).body.slice(MARKER.length)).entries[0];
  assert.equal(entry.model, "openai/gpt-6-luna", "the ledger records the model each attempt used");
});

test("pr-repair holds off while a declared legacy workflow still has a run in flight", async (t) => {
  const w = world();
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  w.gh.workflowRuns = { "dependabot-repair.yml": [{ id: 99, status: "in_progress", html_url: "https://example.invalid/runs/99" }] };
  const busy = await runPlan({ ...w.ctx, exclusiveWorkflows: ["dependabot-repair.yml"] });
  assert.deepEqual(busy.tasks, []);
  assert.equal(busy.rows[0].state, "missing-configuration");
  assert.match(busy.rows[0].detail, /dependabot-repair\.yml run 99 is still in_progress/);
  w.gh.workflowRuns = { "dependabot-repair.yml": [] };
  const idle = await runPlan({ ...w.ctx, exclusiveWorkflows: ["dependabot-repair.yml"], now: NOW() });
  assert.equal(idle.tasks[0]?.kind, "sync", "work resumes once the legacy run has drained");
});

test("a runtime whose majors stay with a maintainer is reported, not repaired", async (t) => {
  // Metriks: Dell runners preinstall Node; a Dockerfile update cannot move them.
  const w = world((p) => ({ ...p, runtimes: p.runtimes.map((r) => (r.name === "node" ? { ...r, majors: "maintainer" } : r)) }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const pr = w.gh.pulls.get(167);
  const tree = new Map(w.gh.commits.get(pr.head.sha).tree);
  tree.set("apps/api/Dockerfile", dockerfile("node:25-bookworm-slim@sha256:" + "d".repeat(64), BUN_NEW));
  pr.head.sha = w.gh.commit(tree, [w.main], "bump node", "dependabot[bot]");
  pr.title = "fix: bump node from 24-bookworm-slim to 25-bookworm-slim";
  w.ci(pr.head.sha, "failure");
  const p = await runPlan(w.ctx);
  assert.deepEqual(p.tasks, []);
  assert.equal(p.rows[0].state, "unsupported-scope");
  assert.match(p.rows[0].detail, /node 24 → 25 is a major runtime move; this repository keeps those with a maintainer/);
});

test("prepare skips binary context files instead of failing the attempt (ark canary)", async (t) => {
  const { runPrepare } = await import("../src/tasks.mjs");
  const w = world((p) => ({ ...p, runtimes: [], validation: { ...p.validation, image: NODE_OLD }, repair: { ...p.repair, context: ["apps/api/src/**"] } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const pr = w.gh.pulls.get(167);
  // Unchanged context on both sides, like ark's src/app/favicon.ico.
  const ico = Buffer.from([0, 0, 1, 0, 0xff, 0xfe, 0x89]);
  const bin = Buffer.from([0xff, 0xfe, 0xfd]);
  for (const sha of [w.main, pr.head.sha]) {
    w.gh.commits.get(sha).tree.set("apps/api/src/favicon.ico", ico);
    w.gh.commits.get(sha).tree.set("apps/api/src/logo.bin", bin);
    w.gh.commits.get(sha).tree.set("apps/api/src/index.ts", "export const app = 1;\n");
  }
  await runPlan(w.ctx);
  const { tasks } = await runPlan({ ...w.ctx, now: NOW() });
  const dir = mkdtempSync(join(tmpdir(), "pr-repair-binary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await runPrepare({ gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId }, tasks.find((x) => x.kind === "repair"), dir);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(dir, "data/context/apps/api/src/index.ts")), true);
  assert.equal(existsSync(join(dir, "data/context/apps/api/src/favicon.ico")), false, "binary by extension");
  assert.equal(existsSync(join(dir, "data/context/apps/api/src/logo.bin")), false, "binary by content");
});

// Metriks #183: findings only in a file repair may not edit (there docs/TODO.md).
test("review findings only in non-editable files reach a maintainer without a paid repair", async (t) => {
  const w = world((p) => ({ ...p, review: { requireCodex: false, agentLogins: [] } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const app = { gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin };
  const [sync] = (await runPlan(w.ctx)).tasks;
  const out = mkdtempSync(join(tmpdir(), "pr-repair-out-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await runValidate(app, sync, { candidateRoot: w.checkout.dir, proposalDir: out, outDir: join(out, "validated"), validation: () => ({ passed: true, results: [], generated: new Map([["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"]]) }) });
  const pub = await runPublish(app, sync, { proposalDir: out, validatedDir: join(out, "validated") });
  const replacement = w.gh.pulls.get(pub.replacement);
  w.ci(replacement.head.sha, "success");
  const [review] = (await runPlan({ ...w.ctx, now: NOW() })).tasks;
  const files = w.gh.compare(w.main, replacement.head.sha).files.map((f) => f.filename);
  writeFileSync(join(out, "proposal.json"), JSON.stringify(seal({ task: review, transport: "openai-compatible", model: "deepseek/deepseek-v4-flash", result: { verdict: "request_changes", summary: "The smoke message is stale.", coveredFiles: files, findings: [{ severity: "high", file: "scripts/ops/smoke-api-docker.sh", message: "Name the new Bun version in the smoke message." }] } })));
  assert.equal((await runPublish(app, review, { proposalDir: out, validatedDir: join(out, "validated") })).review, "request_changes");

  const p = await runPlan({ ...w.ctx, now: NOW() });
  assert.deepEqual(p.tasks, []);
  assert.equal(p.rows[0].state, "needs-human");
  assert.match(p.rows[0].detail, /smoke-api-docker\.sh/);
  assert.equal(ledgerOf(w.gh).entries.filter((e) => e.kind === "repair").length, 0, "no paid repair is reserved");
});

// Metriks replacement 183 was closed by a closing keyword in another PR, so
// the controller never deleted pr-repair/167, and the next sync for #167's new
// head failed with "pr-repair/167 already exists at another commit".
test("a branch left by a closed, unmerged App replacement is reused; anything else is refused", async (t) => {
  const w = world((p) => ({ ...p, review: { requireCodex: false, agentLogins: [] } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const app = { gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin };
  const syncOnce = async (checkout) => {
    const [task] = (await runPlan({ ...w.ctx, now: NOW() })).tasks;
    const out = mkdtempSync(join(tmpdir(), "pr-repair-out-"));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    await runValidate(app, task, { candidateRoot: checkout, proposalDir: out, outDir: join(out, "validated"), validation: () => ({ passed: true, results: [], generated: new Map([["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"]]) }) });
    return runPublish(app, task, { proposalDir: out, validatedDir: join(out, "validated") });
  };
  const first = await syncOnce(w.checkout.dir);
  const stale = w.gh.pulls.get(first.replacement);
  stale.state = "closed"; // closed outside the controller; its branch stays

  // Dependabot recreates the original on a new head.
  const files = new Map(w.gh.commits.get(w.head).tree);
  files.set("README.md", "recreated\n");
  const next = gitCheckout(files);
  t.after(() => rmSync(next.dir, { recursive: true, force: true }));
  const head2 = w.gh.commit(files, [w.main], "bump oven/bun", "dependabot[bot]", next.sha);
  w.gh.refs.set("dependabot/docker/apps/api/bun", head2);
  w.gh.pulls.get(167).head.sha = head2;
  w.ci(head2, "failure");
  const second = await syncOnce(next.dir);
  assert.equal(second.published, true, second.note);
  assert.notEqual(second.replacement, first.replacement);
  assert.equal(w.gh.pulls.get(second.replacement).head.ref, "pr-repair/167");

  // A branch whose head no closed App replacement explains is never reset.
  w.gh.pulls.get(second.replacement).state = "closed";
  w.gh.refs.set("pr-repair/167", w.gh.commit(files, [head2], "someone else's work", "NoahJenkins"));
  const files3 = new Map(files).set("README.md", "again\n");
  const third = gitCheckout(files3);
  t.after(() => rmSync(third.dir, { recursive: true, force: true }));
  const head3 = w.gh.commit(files3, [w.main], "bump oven/bun", "dependabot[bot]", third.sha);
  w.gh.refs.set("dependabot/docker/apps/api/bun", head3);
  w.gh.pulls.get(167).head.sha = head3;
  w.ci(head3, "failure");
  const refused = await syncOnce(third.dir);
  assert.equal(refused.published, false);
  assert.match(refused.note, /already exists at another commit/);
});

// Metriks #186: checks and reviews passed, the App approved, and GitHub refused
// auto-merge because the pull request was already mergable ("unstable status").
test("an already-mergeable replacement is merged directly at the exact head, approved once", async (t) => {
  const w = world((p) => ({ ...p, review: { requireCodex: false, agentLogins: [] }, merge: { ...p.merge, approve: "app" } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const app = { gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin };
  const [sync] = (await runPlan(w.ctx)).tasks;
  const out = mkdtempSync(join(tmpdir(), "pr-repair-out-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await runValidate(app, sync, { candidateRoot: w.checkout.dir, proposalDir: out, outDir: join(out, "validated"), validation: () => ({ passed: true, results: [], generated: new Map([["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"]]) }) });
  const pub = await runPublish(app, sync, { proposalDir: out, validatedDir: join(out, "validated") });
  const replacement = w.gh.pulls.get(pub.replacement);
  w.ci(replacement.head.sha, "success");
  const [review] = (await runPlan({ ...w.ctx, now: NOW() })).tasks;
  const files = w.gh.compare(w.main, replacement.head.sha).files.map((f) => f.filename);
  writeFileSync(join(out, "proposal.json"), JSON.stringify(seal({ task: review, transport: "openai-compatible", model: "deepseek/deepseek-v4-flash", result: { verdict: "approve", summary: "Consistent.", coveredFiles: files, findings: [] } })));
  await runPublish(app, review, { proposalDir: out, validatedDir: join(out, "validated") });

  w.gh.mergeableNow = true;
  const p = await runPlan({ ...w.ctx, now: NOW() });
  assert.equal(p.rows[0].state, "queued-merge");
  const merged = w.gh.writes.find((x) => x.method === "GRAPHQL" && x.path === "mergePullRequest");
  assert.equal(merged?.body.head, replacement.head.sha, "the direct merge is bound to the reviewed head");
  assert.ok(replacement.merged_at);
  await runPlan({ ...w.ctx, now: NOW() });
  assert.equal(w.gh.pulls.get(167).state, "closed");
  assert.equal(w.gh.writes.filter((x) => x.path.endsWith(`/pulls/${pub.replacement}/reviews`)).length, 1, "approved once");
});

test("a repeated merge attempt does not approve the same head twice", async (t) => {
  const w = world((p) => ({ ...p, review: { requireCodex: false, agentLogins: [] }, merge: { ...p.merge, approve: "app" } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const app = { gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin };
  const [sync] = (await runPlan(w.ctx)).tasks;
  const out = mkdtempSync(join(tmpdir(), "pr-repair-out-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await runValidate(app, sync, { candidateRoot: w.checkout.dir, proposalDir: out, outDir: join(out, "validated"), validation: () => ({ passed: true, results: [], generated: new Map([["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"]]) }) });
  const pub = await runPublish(app, sync, { proposalDir: out, validatedDir: join(out, "validated") });
  const replacement = w.gh.pulls.get(pub.replacement);
  w.ci(replacement.head.sha, "success");
  const [review] = (await runPlan({ ...w.ctx, now: NOW() })).tasks;
  const files = w.gh.compare(w.main, replacement.head.sha).files.map((f) => f.filename);
  writeFileSync(join(out, "proposal.json"), JSON.stringify(seal({ task: review, transport: "openai-compatible", model: "deepseek/deepseek-v4-flash", result: { verdict: "approve", summary: "Consistent.", coveredFiles: files, findings: [] } })));
  await runPublish(app, review, { proposalDir: out, validatedDir: join(out, "validated") });
  await runPlan({ ...w.ctx, now: NOW() });
  replacement.auto_merge = null; // auto-merge did not stick; the next run tries again
  await runPlan({ ...w.ctx, now: NOW() });
  assert.equal(w.gh.writes.filter((x) => x.path.endsWith(`/pulls/${pub.replacement}/reviews`)).length, 1);
  assert.equal(w.gh.writes.filter((x) => x.path === "enablePullRequestAutoMerge").length, 2);
});

// Shared steps: sync -> replacement with green CI -> a reserved review task.
async function toReview(t, w) {
  const app = { gh: w.gh, repo: w.gh.repo, policy: w.policy, log: () => {}, appId: w.gh.appId, botId: w.gh.botId, botLogin: w.gh.botLogin };
  const [sync] = (await runPlan(w.ctx)).tasks;
  const out = mkdtempSync(join(tmpdir(), "pr-repair-out-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await runValidate(app, sync, { candidateRoot: w.checkout.dir, proposalDir: out, outDir: join(out, "validated"), validation: () => ({ passed: true, results: [], generated: new Map([["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"]]) }) });
  const pub = await runPublish(app, sync, { proposalDir: out, validatedDir: join(out, "validated") });
  const replacement = w.gh.pulls.get(pub.replacement);
  w.ci(replacement.head.sha, "success");
  const [review] = (await runPlan({ ...w.ctx, now: NOW() })).tasks;
  assert.equal(review.kind, "review");
  const files = w.gh.compare(w.main, replacement.head.sha).files.map((f) => f.filename);
  writeFileSync(join(out, "proposal.json"), JSON.stringify(seal({ task: review, transport: "openai-compatible", model: "deepseek/deepseek-v4-flash", result: { verdict: "approve", summary: "Consistent.", coveredFiles: files, findings: [] } })));
  return { app, out, replacement, review, publishReview: () => runPublish(app, review, { proposalDir: out, validatedDir: join(out, "validated") }) };
}
const moveMain = (w, path, content) => {
  const tree = new Map(w.gh.commits.get(w.gh.refs.get("main")).tree).set(path, content);
  const next = w.gh.commit(tree, [w.gh.refs.get("main")], `change ${path}`, "NoahJenkins");
  w.gh.refs.set("main", next);
  w.gh.runs = [{ id: w.gh.id(), status: "completed", conclusion: "success", updated_at: NOW(), head_sha: next, run_attempt: 1 }]; // its release passed
  return next;
};

// Metriks #186: a passed review was thrown away twice because main moved with
// pin-only changes to two workflow files, and the review budget ran out.
test("a review survives main moving in files the replacement does not touch", async (t) => {
  const w = world((p) => ({ ...p, review: { requireCodex: false, agentLogins: [] }, merge: { ...p.merge, approve: "app" } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const r = await toReview(t, w);
  moveMain(w, ".github/workflows/pr-repair.yml", "pinned: next\n"); // between reservation and publication
  assert.equal((await r.publishReview()).review, "approve", "an unrelated move does not void the review");
  moveMain(w, ".github/workflows/pr-repair-contract.yml", "pinned: next\n");
  const p = await runPlan({ ...w.ctx, now: NOW() });
  assert.deepEqual(p.tasks, [], "no second review is reserved");
  assert.equal(p.rows[0].state, "queued-merge");
  assert.equal(ledgerOf(w.gh).entries.filter((e) => e.kind === "review").length, 1);
});

test("a review is redone when main changes a file the replacement changes", async (t) => {
  const w = world((p) => ({ ...p, review: { requireCodex: false, agentLogins: [] }, merge: { ...p.merge, approve: "app" } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const r = await toReview(t, w);
  assert.equal((await r.publishReview()).review, "approve");
  moveMain(w, "scripts/ops/smoke-api-docker.sh", "echo changed on main\n");
  const p = await runPlan({ ...w.ctx, now: NOW() });
  assert.deepEqual(p.tasks.map((x) => x.kind), ["review"]);
});

test("a review whose reviewed files changed on main before publication is not published", async (t) => {
  const w = world((p) => ({ ...p, review: { requireCodex: false, agentLogins: [] } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const r = await toReview(t, w);
  moveMain(w, "scripts/ops/smoke-api-docker.sh", "echo changed on main\n");
  const res = await r.publishReview();
  assert.equal(res.published, false);
  assert.match(res.note, /main moved/);
});

// noahjenkins.com-v2 #296, RooferChat #104: out-of-scope originals showed no
// status on the pull request, only on the dashboard.
test("an out-of-scope original still shows its state on the pull request", async (t) => {
  const w = world((p) => ({ ...p, eligibility: { ...p.eligibility, updates: { ...p.eligibility.updates, npm_and_yarn: "non-major" } } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const tree = new Map(w.gh.commits.get(w.main).tree).set("package.json", '{"dependencies":{"ai":"7.0.1"}}\n');
  const head = w.gh.commit(tree, [w.main], "bump ai", "dependabot[bot]");
  w.gh.refs.set("dependabot/npm_and_yarn/ai-7", head);
  w.gh.pr(296, { title: "bump ai from 6.0.1 to 7.0.1", head: { ref: "dependabot/npm_and_yarn/ai-7", sha: head } });
  const p = await runPlan(w.ctx);
  assert.equal(p.rows.find((x) => x.number === 296).state, "unsupported-scope");
  const check = w.gh.checks.find((c) => c.name === STATUS_CHECK && c.head_sha === head);
  assert.ok(check, "a status check is posted on the out-of-scope original");
  assert.equal(check.conclusion, "neutral", "informational: it never blocks another workflow's merge");
  assert.match(check.output.title, /unsupported-scope/);
});

// ark: the App brings a behind original up to date; the result stays eligible.
test("an original refreshed by the App with a merge from main stays eligible", async (t) => {
  const w = world((p) => ({ ...p, merge: { ...p.merge, approve: "app" } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const tree = new Map(w.gh.commits.get(w.main).tree).set("package.json", '{"dependencies":{"x":"1.0.1"}}\n');
  const head = w.gh.commit(tree, [w.main], "bump x", "dependabot[bot]");
  const newMain = moveMain(w, ".github/workflows/ci.yml", "x\n");
  const merged = new Map(w.gh.commits.get(newMain).tree).set("package.json", tree.get("package.json"));
  const refreshed = w.gh.commit(merged, [head, newMain], "Merge branch 'main' into dependabot/npm_and_yarn/x", w.gh.botLogin);
  w.gh.commits.get(refreshed).committer = "web-flow";
  w.gh.refs.set("dependabot/npm_and_yarn/x", refreshed);
  w.gh.pr(181, { title: "bump x from 1.0.0 to 1.0.1", head: { ref: "dependabot/npm_and_yarn/x", sha: refreshed } });
  w.ci(refreshed, "success");
  const p = await runPlan(w.ctx);
  const row = p.rows.find((x) => x.number === 181);
  assert.equal(row.state, "queued-merge", row.detail);

  // The same shape with extra content in the merge is not Dependabot's change.
  const tampered = w.gh.commit(new Map(merged).set("src/evil.js", "x"), [head, newMain], "Merge branch 'main'", w.gh.botLogin);
  w.gh.commits.get(tampered).committer = "web-flow";
  w.gh.refs.set("dependabot/npm_and_yarn/x", tampered);
  w.gh.pulls.get(181).head.sha = tampered;
  w.ci(tampered, "success");
  const q = await runPlan({ ...w.ctx, now: NOW() });
  assert.equal(q.rows.find((x) => x.number === 181).state, "needs-human");
  assert.match(q.rows.find((x) => x.number === 181).detail, /@dependabot recreate/);
  assert.equal(w.gh.checks.filter((c) => c.name === STATUS_CHECK && c.head_sha === tampered).at(-1).conclusion, "action_required");
});

test("a green original behind main is brought up to date by the App once", async (t) => {
  const w = world();
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const tree = new Map(w.gh.commits.get(w.main).tree).set("package.json", '{"dependencies":{"x":"1.0.1"}}\n');
  const head = w.gh.commit(tree, [w.main], "bump x", "dependabot[bot]");
  w.gh.refs.set("dependabot/npm_and_yarn/x", head);
  w.gh.pr(180, { title: "bump x from 1.0.0 to 1.0.1", head: { ref: "dependabot/npm_and_yarn/x", sha: head }, mergeable_state: "behind" });
  w.ci(head, "success");
  await runPlan(w.ctx);
  await runPlan({ ...w.ctx, now: NOW() });
  const updates = w.gh.writes.filter((x) => x.method === "PUT" && x.path.endsWith("/pulls/180/update-branch"));
  assert.equal(updates.length, 1, "once per head");
  assert.equal(updates[0].body.expected_head_sha, head);
});

// Metriks #195: the npm group moved Playwright to 1.65.0 while the Dell runner
// image still pinned 1.64.1. The version check failed and one paid repair
// proposed nothing. A declared environment check now reaches a maintainer first.
test("a failure at a declared environment check reaches a maintainer with no re-run or reservation", async (t) => {
  const reason = "the Dell runner image pins Playwright; rebuild it in homelab first";
  const w = world((p) => ({ ...p, runtimes: [], ci: { ...p.ci, environmentChecks: [{ check: "browser e2e", step: "verify preinstalled browser version", reason }] } }));
  t.after(() => rmSync(w.checkout.dir, { recursive: true, force: true }));
  const step = (number, name, conclusion) => ({ number, name, conclusion });
  for (const c of w.gh.checks.filter((x) => x.head_sha === w.head)) {
    c.conclusion = c.name === "browser e2e" ? "failure" : "success";
    w.gh.jobs.set(c.id, { id: c.id, name: c.name, steps: c.name === "browser e2e" ? [step(1, "Set up job", "success"), step(4, "verify preinstalled browser version", "failure"), step(5, "upload browser failure diagnostics", "failure")] : [step(1, "Set up job", "success")] });
  }
  for (let i = 0; i < 2; i++) {
    const p = await runPlan({ ...w.ctx, now: NOW() });
    assert.deepEqual(p.tasks, [], "no task is handed to inference");
    assert.equal(p.rows[0].state, "needs-human");
    assert.match(p.rows[0].detail, /browser e2e \/ verify preinstalled browser version/);
  }
  assert.deepEqual(ledgerOf(w.gh).entries, [], "no attempt is reserved");
  assert.ok(!w.gh.writes.some((x) => /rerun/.test(x.path)), "a known environment failure is not re-run");
  const status = w.gh.checks.find((c) => c.name === STATUS_CHECK && c.head_sha === w.head);
  assert.equal(status.conclusion, "action_required");
  assert.match(status.output.summary, /rebuild it in homelab first/);

  // Another required check failing too is ordinary evidence: the normal path resumes.
  w.gh.checks.find((c) => c.head_sha === w.head && c.name === "verify").conclusion = "failure";
  w.gh.jobs.get(w.gh.checks.find((c) => c.head_sha === w.head && c.name === "verify").id).steps.push(step(3, "pnpm test", "failure"));
  const mixed = await runPlan({ ...w.ctx, now: NOW() });
  assert.equal(mixed.rows[0].state, "waiting-ci");
  assert.match(mixed.rows[0].detail, /re-running the failed checks once/);
});
