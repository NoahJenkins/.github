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
});

test("real Dependabot titles from your repositories", () => {
  const d = (title, body = "") => dependabotDecision({ title, body, files }, policy);
  assert.equal(d("fix: bump @clerk/backend from 3.26.4 to 3.26.5 in the clerk-backend group").pass, true);
  assert.equal(d("chore(deps): bump ai from 6.0.238 to 7.0.153").pass, false);
  assert.equal(d("Bump node from 24.20.0-bookworm-slim to 26.13.0-bookworm-slim in /services/x").reason, "major version update");
  assert.equal(d("Bump playwright from `d65108d` to `47b510d` in /services/opt").reason, "could not read the version change");
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
