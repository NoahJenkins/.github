import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKER, emptyLedger, encodeLedger, prune, readLedger, reserve, transition, usage } from "../src/ledger.mjs";
import { inferenceGaps } from "../src/policy.mjs";
import { policy, rawPolicy } from "./fixtures.mjs";
import { parsePolicy } from "../src/policy.mjs";

const H = (c) => c.repeat(40);
const limits = { repairPerPr: 2, reviewPerPr: 4, syncPerHead: 1, dailyModelTasks: 3 };
const task = (kind, root = 7, head = H("a")) => ({ kind, root, target: root, head, base: H("b"), rootHead: head, transport: "openai-compatible", model: "openai/gpt-6-luna" });
const NOW = "2026-11-07T10:00:00.000Z";

test("reservations persist, block duplicates, and are never refunded", () => {
  let l = emptyLedger();
  const a = reserve(l, task("repair"), limits, NOW);
  l = a.ledger;
  assert.match(reserve(l, task("repair"), limits, NOW).reason, /still reserved/, "no duplicate dispatch while one is open");
  l = transition(l, a.entry.nonce, "failed", { note: "candidate failed" });
  const b = reserve(l, task("repair", 7, H("c")), limits, NOW);
  l = transition(b.ledger, b.entry.nonce, "expired");
  const c = reserve(l, task("repair", 7, H("d")), limits, NOW);
  assert.equal(c.exhausted, true, "failed and expired attempts stay consumed");
  assert.match(c.reason, /repair budget exhausted \(2\/2\)/);
});

test("budgets survive a provider or model change", () => {
  let l = emptyLedger();
  const a = reserve(l, task("repair"), limits, NOW);
  l = transition(a.ledger, a.entry.nonce, "failed");
  const b = reserve(l, { ...task("repair", 7, H("c")), transport: "openai-compatible", model: "other/model" }, limits, NOW);
  l = transition(b.ledger, b.entry.nonce, "failed");
  assert.equal(usage(l, 7, NOW).repair, 2);
  assert.equal(reserve(l, { ...task("repair", 7, H("e")), transport: "openai-compatible" }, limits, NOW).exhausted, true);
});

test("legacy controller attempts count toward the budget", () => {
  const l = { ...emptyLedger(), legacy: { 7: 2 } };
  assert.equal(reserve(l, task("repair"), limits, NOW).exhausted, true);
  assert.ok(reserve(l, task("repair", 8), limits, NOW).entry);
});

test("daily model limit and per-head sync limit", () => {
  let l = emptyLedger();
  for (const root of [1, 2, 3]) {
    const r = reserve(l, task("review", root), limits, NOW);
    l = transition(transition(r.ledger, r.entry.nonce, "publishing"), r.entry.nonce, "published");
  }
  assert.equal(reserve(l, task("repair", 4), limits, NOW).daily, true);
  assert.ok(reserve(l, task("sync", 4), limits, NOW).entry, "trusted sync is not model work");
  const s = reserve(l, task("sync", 4), limits, NOW);
  const after = transition(transition(s.ledger, s.entry.nonce, "publishing"), s.entry.nonce, "published");
  assert.equal(reserve(after, task("sync", 4), limits, NOW).exhausted, true);
});

test("ledger is trusted only from the controller bot and round-trips", () => {
  const l = reserve(emptyLedger(), task("review"), limits, NOW).ledger;
  const body = encodeLedger(l);
  assert.deepEqual(readLedger([{ id: 1, body, user: { id: 42 } }], 42).ledger, l);
  assert.throws(() => readLedger([{ id: 1, body, user: { id: 43 } }], 42), /not written by the controller App/);
  assert.throws(() => readLedger([{ id: 1, body, user: { id: 42 } }, { id: 2, body, user: { id: 42 } }], 42), /several ledgers/);
  assert.throws(() => readLedger([{ id: 1, body: `${MARKER}\n{"version":2}`, user: { id: 42 } }], 42));
});

test("illegal transitions are refused", () => {
  const r = reserve(emptyLedger(), task("repair"), limits, NOW);
  const failed = transition(r.ledger, r.entry.nonce, "failed");
  assert.throws(() => transition(failed, r.entry.nonce, "published"), /cannot move from failed/);
});

test("prune keeps open pull requests' budgets", () => {
  let l = emptyLedger();
  for (const root of [1, 2]) {
    const r = reserve(l, task("repair", root), limits, "2026-01-01T00:00:00.000Z");
    l = transition(r.ledger, r.entry.nonce, "failed");
  }
  const p = prune({ ...l, legacy: { 1: 1, 2: 1 } }, new Set([1]), NOW);
  assert.deepEqual(p.entries.map((e) => e.root), [1]);
  assert.deepEqual(p.legacy, { 1: 1 });
});

test("missing model, credential, or budget pauses paid work", () => {
  assert.deepEqual(inferenceGaps(policy(), { credentialReady: true }), []);
  const bare = parsePolicy({ ...rawPolicy(), inference: { transport: "openai-compatible" } });
  const gaps = inferenceGaps(bare, { credentialReady: false });
  for (const g of ["model", "budget", "endpoint", "credential"]) assert.ok(gaps.some((x) => x.includes(g)), g);
});

test("policy rejects human authors, unknown keys, and credential-looking validation env", () => {
  assert.throws(() => parsePolicy({ ...rawPolicy(), eligibility: { authors: ["NoahJenkins"], updates: { npm_and_yarn: "all" } } }), /only bot accounts/);
  assert.throws(() => parsePolicy({ ...rawPolicy(), surprise: 1 }), /not a known key/);
  assert.throws(() => parsePolicy({ ...rawPolicy(), validation: { ...rawPolicy().validation, env: { NPM_TOKEN: "x" } } }), /non-credential/);
  assert.throws(() => parsePolicy({ ...rawPolicy(), validation: { ...rawPolicy().validation, image: "node:24" } }), /digest-pinned/);
  assert.throws(() => parsePolicy({ ...rawPolicy(), review: { agentLogins: ["someone"] } }), /human threads/);
});

test("deployment interlocks accept real GitHub account ids", () => {
  const p = parsePolicy({ ...rawPolicy(), merge: { production: { kind: "deployments", environment: "production", creatorId: 41898282 } } });
  assert.equal(p.merge.production.creatorId, 41898282);
});

test("repair and review may use different models; Copilot is no longer a transport", () => {
  const split = parsePolicy(rawPolicy());
  assert.deepEqual(split.inference.model, { repair: "openai/gpt-6-luna", review: "deepseek/deepseek-v4-flash" });
  const one = parsePolicy({ ...rawPolicy(), inference: { ...rawPolicy().inference, model: "openai/gpt-6-luna" } });
  assert.deepEqual(one.inference.model, { repair: "openai/gpt-6-luna", review: "openai/gpt-6-luna" });
  assert.throws(() => parsePolicy({ ...rawPolicy(), inference: { ...rawPolicy().inference, model: { repair: "a/b" } } }), /repair, review/);
  assert.throws(() => parsePolicy({ ...rawPolicy(), inference: { ...rawPolicy().inference, transport: "copilot-cli" } }), /transport must be/);
  assert.throws(() => parsePolicy({ ...rawPolicy(), inference: { ...rawPolicy().inference, copilot: {} } }), /not a known key/);
});
