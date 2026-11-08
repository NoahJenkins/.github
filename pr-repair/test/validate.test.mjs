import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerArgs, removeTree } from "../src/validate.mjs";

// Metriks hosted run 2026-11-08: the runner user is uid 1001, candidate
// containers ran as 1000, and the runner could not delete what they wrote.
test("candidate containers run as the runner's own user, without capabilities", () => {
  const args = containerArgs({ name: "n", image: "i", workspace: "/w", network: "none", memory: "1g", cpus: 1, env: {}, command: "true", uid: 1001, gid: 121 });
  assert.equal(args[args.indexOf("--user") + 1], "1001:121");
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.some((a) => a.includes("/tmp:") && a.includes("uid=1001,gid=121")));
});

test("cleanup is best effort and never replaces a validation result", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-repair-cleanup-"));
  mkdirSync(join(dir, "store", "v11"), { recursive: true });
  writeFileSync(join(dir, "store", "v11", "f"), "x");
  chmodSync(join(dir, "store"), 0o500); // the runner cannot delete entries in here
  const notes = [];
  assert.doesNotThrow(() => removeTree(dir, (m) => notes.push(m)));
  chmodSync(join(dir, "store"), 0o700);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  if (process.getuid?.() !== 0) assert.match(notes.join(), /could not remove/);
});

test("a runner running as root still starts candidates unprivileged", () => {
  const args = containerArgs({ name: "n", image: "i", workspace: "/w", network: "none", memory: "1g", cpus: 1, env: {}, command: "true", uid: 0, gid: 0 });
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
});
