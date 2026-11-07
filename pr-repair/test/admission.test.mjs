import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, validateProposalShape } from "../src/admission.mjs";
import { requestedTargets, runtimeMoves, syncRuntimeFields } from "../src/contract.mjs";
import { BUN_OLD, NODE_NEW, NODE_OLD, dockerfile, policy, tree } from "./fixtures.mjs";

// The #168 scenario: the update moved Node; trusted sync ran; the model may now
// fix the corepack bootstrap in the Dockerfile but nothing else.
function scenario() {
  const p = policy();
  const changes = [
    { path: "apps/api/Dockerfile", before: dockerfile(NODE_OLD, BUN_OLD), after: dockerfile(NODE_NEW, BUN_OLD) },
    { path: "apps/api/Dockerfile.node", before: tree().get("apps/api/Dockerfile.node"), after: tree({ node: NODE_NEW }).get("apps/api/Dockerfile.node") },
    { path: "apps/api/package.json", before: tree().get("apps/api/package.json"), after: tree().get("apps/api/package.json").replace('"4.9.0"', '"4.10.0"') },
  ];
  const moves = runtimeMoves(p, changes);
  const targets = requestedTargets(changes);
  const head = tree();
  for (const c of changes) head.set(c.path, c.after);
  const synced = syncRuntimeFields(p, moves, head).edits;
  return { policy: p, head, synced, moves, targets, fieldFiles: head, generatedPaths: ["pnpm-lock.yaml"] };
}

test("sync-only candidate is admitted and keeps the update", () => {
  const r = admit(scenario());
  assert.equal(r.ok, true, r.reasons.join("; "));
  assert.ok(r.files.some((f) => f.path === "package.json"));
  assert.ok(r.files.some((f) => f.path === ".github/workflows/pr-checks.yml"), "trusted sync may write the CI selector");
});

test("a model may fix bootstrap lines in an editable Dockerfile", () => {
  const s = scenario();
  const fixed = s.head.get("apps/api/Dockerfile").replace("RUN corepack enable", "RUN npm install --global pnpm@11.15.1");
  const r = admit({ ...s, proposal: [{ path: "apps/api/Dockerfile", content: fixed }] });
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("a model may not change an image identity (FROM line)", () => {
  const s = scenario();
  const reverted = s.head.get("apps/api/Dockerfile").replace(NODE_NEW, NODE_OLD);
  const r = admit({ ...s, proposal: [{ path: "apps/api/Dockerfile", content: reverted }] });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /FROM lines are immutable/);
});

test("a model may not add a FROM line", () => {
  const s = scenario();
  const r = admit({ ...s, proposal: [{ path: "apps/api/Dockerfile", content: `${s.head.get("apps/api/Dockerfile")}FROM busybox AS extra\n` }] });
  assert.equal(r.ok, false);
});

test("reverting a requested version is rejected", () => {
  const s = scenario();
  const r = admit({ ...s, proposal: [{ path: "apps/api/package.json", content: s.synced.get("apps/api/package.json").replace('"4.10.0"', '"4.9.0"') }] });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /drops the requested npm target dependencies:hono/);
});

test("weakening a test, editing a workflow, policy, instructions, or the lockfile is rejected", () => {
  const s = scenario();
  for (const path of ["apps/api/src/__tests__/runtime.test.ts", "scripts/safety/test-runtime-contract.sh", ".github/workflows/pr-checks.yml", ".github/pr-repair.json", "AGENTS.md", "pnpm-lock.yaml", "apps/api/src/db/migrations/0001.sql"]) {
    const r = admit({ ...s, proposal: [{ path, content: "x" }] });
    assert.equal(r.ok, false, path);
  }
});

test("package.json scripts and new dependencies are not model-editable", () => {
  const s = scenario();
  const pkg = JSON.parse(s.synced.get("apps/api/package.json"));
  const scripts = admit({ ...s, proposal: [{ path: "apps/api/package.json", content: JSON.stringify({ ...pkg, scripts: { test: "true" } }) }] });
  assert.match(scripts.reasons.join(), /only dependency versions/);
  const added = admit({ ...s, proposal: [{ path: "apps/api/package.json", content: JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, leftpad: "1.0.0" } }) }] });
  assert.match(added.reasons.join(), /cannot be added or removed/);
  const git = admit({ ...s, proposal: [{ path: "apps/api/package.json", content: JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, hono: "github:evil/hono" } }) }] });
  assert.equal(git.ok, false);
});

test("a model edit that reintroduces an old runtime field is rejected", () => {
  const s = scenario();
  const r = admit({ ...s, proposal: [{ path: "package.json", content: s.head.get("package.json") }] });
  assert.equal(r.ok, false);
});

test("a runtime field left stale outside the sync is reported", () => {
  const s = scenario();
  const fieldFiles = new Map(s.fieldFiles);
  fieldFiles.set("docs/DEVELOPMENT.md", "Use Node 24 locally.\n");
  const r = admit({ ...s, fieldFiles });
  assert.match(r.reasons.join(), /runtime contract: docs\/DEVELOPMENT\.md still has "Node 24"/);
});

test("validator-generated lockfile is accepted only on its declared path", () => {
  const s = scenario();
  assert.equal(admit({ ...s, generated: new Map([["pnpm-lock.yaml", "lock"]]) }).ok, true);
  assert.equal(admit({ ...s, generated: new Map([["yarn.lock", "lock"]]) }).ok, false);
});

test("malformed proposals are rejected before admission", () => {
  const limits = { maxFiles: 2, maxBytes: 100 };
  for (const bad of [null, [], { files: "x" }, { files: [], extra: 1 }, { files: [{ path: "../etc/passwd", content: "" }] }, { files: [{ path: "a", content: "x", mode: "755" }] }, { files: [{ path: "a", content: 1 }] }, { files: [{ path: "a", content: "x" }, { path: "a", content: "y" }] }, { files: [{ path: "a", content: "x".repeat(101) }] }, { files: [1, 2, 3] }, { files: [{ path: ".git/config", content: "" }] }]) {
    assert.throws(() => validateProposalShape(bad, limits), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(validateProposalShape({ files: [{ path: "src/a.ts", content: "ok" }] }, limits), [{ path: "src/a.ts", content: "ok" }]);
});
