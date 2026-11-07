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
