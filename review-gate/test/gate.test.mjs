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
