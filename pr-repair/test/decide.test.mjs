import { test } from "node:test";
import assert from "node:assert/strict";
import { conclusionFor, decide } from "../src/decide.mjs";
import { originalEligibility, replacementEligibility, updateKind } from "../src/eligibility.mjs";
import { policy } from "./fixtures.mjs";

const H = (c) => c.repeat(40);
const pr = (n, head, extra = {}) => ({ number: n, head: { sha: head, ref: `dependabot/docker/x-${n}` }, mergeable_state: "clean", auto_merge: null, ...extra });
const green = { state: "success", failed: [], missing: [] };
const red = { state: "failure", failed: ["verify"], missing: [] };
const use = (o = {}) => ({ repair: 0, review: 0, todayModel: 0, syncFor: () => 0, ...o });

function snap(overrides = {}) {
  const p = overrides.policy ?? policy();
  return {
    policy: p,
    enabled: true,
    exclusiveActive: false,
    inferenceGaps: [],
    productionHealthy: true,
    productionReason: "Merges paused: release failed.",
    strict: true,
    botLogin: "pr-repair-app[bot]",
    baseSha: H("b"),
    limits: p.repair.limits,
    usage: use(),
    original: { pr: pr(167, H("1")), eligibility: { eligible: true }, moves: [], ci: green },
    replacement: null,
    marks: {},
    targetHead: H("1"),
    ...overrides,
  };
}

const replacement = (o = {}) => ({
  pr: pr(200, H("2"), { head: { sha: H("2"), ref: "pr-repair/167" } }),
  eligibility: { eligible: true },
  provenance: { root: 167, rootHead: H("1") },
  ci: green,
  review: { verdict: "pass", head: H("2"), base: H("b") },
  codex: "pass",
  threads: { obsolete: 0, blocking: 0 },
  approved: false,
  merged: false,
  ...o,
});

test("disabled and duplicate-controller states never act", () => {
  assert.equal(decide(snap({ enabled: false })).state, "disabled");
  const d = decide(snap({ exclusiveActive: true }));
  assert.equal(d.state, "missing-configuration");
  assert.equal(d.action, "none");
});

test("ineligible updates are reported, not touched", () => {
  const d = decide(snap({ original: { ...snap().original, eligibility: { eligible: false, reason: "major npm updates stay with a maintainer" } } }));
  assert.deepEqual([d.state, d.action], ["unsupported-scope", "none"]);
});

test("runtime sync runs before any model work, once per head", () => {
  const s = snap({ original: { ...snap().original, ci: red, syncNeeded: true, moves: [{ image: "oven/bun", from: { tag: "1.4.0-slim" }, to: { tag: "1.4.4-slim" } }] } });
  assert.equal(decide(s).action, "sync");
  assert.equal(decide({ ...s, usage: use({ syncFor: () => 1 }) }).state, "exhausted");
});

test("failed CI reserves a bounded repair, then exhausts", () => {
  const s = snap({ original: { ...snap().original, ci: red } });
  assert.deepEqual([decide(s).state, decide(s).action], ["repairing", "repair"]);
  const done = decide({ ...s, usage: use({ repair: 2 }) });
  assert.deepEqual([done.state, done.action], ["exhausted", "none"]);
  assert.equal(conclusionFor(done.state), "action_required");
});

test("missing configuration pauses repair before any reservation", () => {
  const d = decide(snap({ original: { ...snap().original, ci: red }, inferenceGaps: ["inference.model is not set"] }));
  assert.deepEqual([d.state, d.action], ["missing-configuration", "none"]);
  assert.match(d.detail, /inference\.model is not set/);
});

test("pending and interrupted CI wait or retry once", () => {
  assert.equal(decide(snap({ original: { ...snap().original, ci: { state: "pending", failed: [], missing: ["verify"] } } })).state, "waiting-ci");
  const s = snap({ original: { ...snap().original, ci: { state: "interrupted", failed: [], missing: [] } } });
  assert.equal(decide(s).action, "rerun-ci");
  assert.equal(decide({ ...s, marks: { rerun: true } }).state, "needs-human");
});

test("conflicts ask the update bot to rebase once", () => {
  const s = snap({ original: { ...snap().original, pr: pr(167, H("1"), { mergeable_state: "dirty" }) } });
  assert.equal(decide(s).action, "request-rebase");
  assert.deepEqual([decide({ ...s, marks: { rebase: true } }).state, decide({ ...s, marks: { rebase: true } }).action], ["conflict", "none"]);
});

test("a green original follows the repository's existing merge path unless policy grants it", () => {
  const p = policy((r) => ({ ...r, merge: { ...r.merge, originals: false } }));
  assert.equal(decide(snap({ policy: p, limits: p.repair.limits })).state, "waiting-merge-path");
  assert.equal(decide(snap()).action, "merge");
  assert.equal(decide(snap({ productionHealthy: false })).state, "production-paused");
});

test("a replacement needs a fresh independent review for its exact head and base", () => {
  const stale = decide(snap({ replacement: replacement({ review: { verdict: "pass", head: H("9"), base: H("b") } }), targetHead: H("2") }));
  assert.equal(stale.action, "review");
  const oldBase = decide(snap({ replacement: replacement({ review: { verdict: "pass", head: H("2"), base: H("a") } }), targetHead: H("2") }));
  assert.equal(oldBase.action, "review");
});

test("blocking review findings re-enter repair", () => {
  assert.equal(decide(snap({ replacement: replacement({ review: { verdict: "fail", head: H("2"), base: H("b") } }), targetHead: H("2") })).action, "repair");
  assert.equal(decide(snap({ replacement: replacement({ codex: "findings" }), targetHead: H("2") })).action, "repair");
});

test("codex, obsolete agent threads, human threads, production, then merge", () => {
  assert.equal(decide(snap({ replacement: replacement({ codex: "pending" }), targetHead: H("2") })).action, "request-codex");
  assert.equal(decide(snap({ replacement: replacement({ codex: "pending" }), targetHead: H("2"), marks: { codex: true } })).state, "waiting-review");
  assert.equal(decide(snap({ replacement: replacement({ threads: { obsolete: 2, blocking: 0 } }), targetHead: H("2") })).action, "resolve-threads");
  assert.deepEqual(Object.values(decide(snap({ replacement: replacement({ threads: { obsolete: 0, blocking: 1 } }), targetHead: H("2") }))).slice(0, 2), ["needs-human", "none"]);
  assert.equal(decide(snap({ replacement: replacement(), targetHead: H("2"), productionHealthy: false })).state, "production-paused");
  const m = decide(snap({ replacement: replacement(), targetHead: H("2") }));
  assert.deepEqual([m.state, m.action], ["queued-merge", "merge"]);
});

test("production failure pauses a queued merge", () => {
  const d = decide(snap({ replacement: replacement({ pr: { ...replacement().pr, auto_merge: { merge_method: "squash" } } }), targetHead: H("2"), productionHealthy: false }));
  assert.deepEqual([d.state, d.action], ["production-paused", "pause-merge"]);
});

test("the original closes only after its replacement merged and its head still matches", () => {
  const merged = replacement({ merged: true });
  assert.equal(decide(snap({ replacement: merged })).action, "close-original");
  const moved = decide(snap({ replacement: merged, original: { ...snap().original, pr: pr(167, H("3")) } }));
  assert.deepEqual([moved.state, moved.action], ["needs-human", "none"]);
});

test("a stale or foreign replacement is not trusted", () => {
  assert.equal(decide(snap({ replacement: replacement({ provenance: { root: 167, rootHead: H("0") } }) })).action, "close-stale-replacement");
  assert.equal(decide(snap({ replacement: replacement({ eligibility: { eligible: false, reason: "someone else pushed" } }) })).state, "needs-human");
});

test("update kind and eligibility read Dependabot's own text", () => {
  assert.equal(updateKind({ title: "bump node from 24-bookworm-slim to 25-bookworm-slim" }), "major");
  assert.equal(updateKind({ title: "bump oven/bun from 1.4.0-slim to 1.4.4-slim" }), "non-major");
  // RooferChat #104: the body sentence ends with a period after the version.
  assert.equal(updateKind({ title: "chore(deps): bump ai from 6.0.238 to 7.0.153", body: "Bumps [ai](https://x) from 6.0.238 to 7.0.153.\n<p>Streams audio from 3 sources to 2 sinks</p>" }), "major");
  assert.equal(updateKind({ title: "bump the aws-sdk group with 2 updates", body: "Updates `@aws-sdk/client-s3` from 3.1.0 to 3.2.0\nUpdates `@aws-sdk/s3-request-presigner` from 3.1.0 to 3.2.0" }), "non-major");
  const p = policy((r) => ({ ...r, eligibility: { updates: { npm_and_yarn: "non-major", docker: "all" } } }));
  const base = { state: "open", draft: false, user: { login: "dependabot[bot]", type: "Bot" }, head: { ref: "dependabot/npm_and_yarn/ai-7", repo: { full_name: "o/r" } }, base: { ref: "main" }, changed_files: 2, body: "" };
  const commits = [{ author: { login: "dependabot[bot]" }, commit: { verification: { verified: true } } }];
  assert.match(originalEligibility(p, { ...base, title: "bump ai from 6.0.1 to 7.0.1" }, commits, "o/r").reason, /major npm_and_yarn/);
  assert.equal(originalEligibility(p, { ...base, title: "bump ai from 6.0.1 to 6.1.0" }, commits, "o/r").eligible, true);
  assert.match(originalEligibility(p, { ...base, title: "bump ai from 6.0.1 to 6.1.0" }, [...commits, { author: { login: "someone" }, commit: { verification: { verified: true } } }], "o/r").reason, /not a verified commit/);
  assert.match(originalEligibility(p, { ...base, user: { login: "NoahJenkins", type: "User" }, title: "x" }, commits, "o/r").reason, /eligible bot/);
  const docker = { ...base, head: { ref: "dependabot/docker/apps/api/x", repo: { full_name: "o/r" } }, title: "bump node from 24-bookworm-slim to 25-bookworm-slim" };
  assert.equal(originalEligibility(p, docker, commits, "o/r").eligible, true, "Docker majors are eligible where policy says all");
});

test("a replacement is eligible only on the App's branch with App or bot commits", () => {
  const p = policy();
  const body = `<!-- pr-repair:{"root":167,"rootHead":"${H("1")}","nonce":"x"} -->`;
  const r = { user: { login: "app[bot]" }, body, head: { ref: "pr-repair/167", repo: { full_name: "o/r" } }, base: { ref: "main" } };
  const ok = [{ author: { login: "dependabot[bot]" }, commit: { verification: { verified: true } } }, { author: { login: "app[bot]" }, commit: { verification: { verified: true } } }];
  assert.equal(replacementEligibility(p, r, ok, { botLogin: "app[bot]", repo: "o/r" }).eligible, true);
  assert.equal(replacementEligibility(p, r, [...ok, { author: { login: "NoahJenkins" }, commit: { verification: { verified: true } } }], { botLogin: "app[bot]", repo: "o/r" }).eligible, false);
  assert.equal(replacementEligibility(p, { ...r, user: { login: "NoahJenkins" } }, ok, { botLogin: "app[bot]", repo: "o/r" }).eligible, false);
});
