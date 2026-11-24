import test from "node:test";
import assert from "node:assert/strict";
import { waitForCodex } from "../src/gate.mjs";

const HEAD = "4f1abb745bfbd0aba733f269a46c8f131465bf9e";
const denied = (status) => {
  const err = new Error(`POST -> ${status}`);
  err.status = status;
  return err;
};
const ctx = (post) => ({
  repo: "o/r",
  log: () => {},
  gh: { paginate: async () => [] },
  triggerGh: { post },
});

test("a trigger token without repository access hands off to the backup review", async () => {
  const v = await waitForCodex(ctx(async () => { throw denied(403); }), 1, HEAD);
  assert.deepEqual(v, { done: true, kind: "error", reason: "cannot request Codex (HTTP 403)" });
});

test("other request errors still fail the run", async () => {
  await assert.rejects(waitForCodex(ctx(async () => { throw denied(422); }), 1, HEAD), /422/);
});

test("timing budget: Codex plus backup plus margin fit inside the deadline", async () => {
  const { TIMING } = await import("../src/gate.mjs");
  assert.ok(TIMING.codex + TIMING.backup + TIMING.margin <= TIMING.deadline);
  assert.ok(TIMING.poll >= 45000, "after the fast window, polling stays at one round per minute or slower");
  assert.ok(TIMING.fastPoll >= 15000 && TIMING.fastUntil <= 6 * 60000, "fast polling is bounded");
});

test("poll schedule: first check at 90 s, fast until 6 min, then once a minute", async () => {
  const { TIMING, pollDelay } = await import("../src/gate.mjs");
  assert.equal(pollDelay(0), TIMING.firstPoll);
  assert.equal(pollDelay(30000), TIMING.firstPoll - 30000);
  assert.equal(pollDelay(TIMING.firstPoll), TIMING.fastPoll);
  assert.equal(pollDelay(TIMING.fastUntil - 1), TIMING.fastPoll);
  assert.equal(pollDelay(TIMING.fastUntil), TIMING.poll);
  // Request rounds over the whole Codex window stay within 2x the old fixed schedule.
  let elapsed = 0, rounds = 0;
  while (elapsed < TIMING.codex) { elapsed += pollDelay(elapsed); rounds += 1; }
  assert.ok(rounds <= 2 * Math.ceil(TIMING.codex / 60000), `rounds=${rounds}`);
  assert.ok(TIMING.deadline < 40 * 60000, "the caller job timeout is 40 minutes");
});
