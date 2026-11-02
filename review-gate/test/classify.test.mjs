import test from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesAny } from "../src/glob.mjs";
import { classify, resolvePolicy, DEFAULT_POLICY } from "../src/classify.mjs";

const f = (filename, additions = 1, deletions = 0, extra = {}) => ({ filename, additions, deletions, ...extra });
const policy = resolvePolicy(null);

test("globs", () => {
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("**/*.md").test("docs/a/b.md"));
  assert.ok(globToRegExp("docs/**").test("docs/x/y.ts"));
  assert.ok(!globToRegExp("docs/**").test("src/docs.ts"));
  assert.ok(globToRegExp("**/*.{png,svg}").test("a/b.svg"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp(".github/workflows/**").test(".github/workflows/ci.yml"));
  assert.ok(globToRegExp("a?c.txt").test("abc.txt"));
  assert.ok(!globToRegExp("a.b").test("axb"));
  assert.ok(matchesAny("LICENSE", DEFAULT_POLICY.skip_paths));
});

test("docs-only pull requests skip", () => {
  const c = classify([f("README.md", 200), f("docs/guide.md", 50), f("img/logo.png", 0)], policy);
  assert.equal(c.tier, "skip");
  assert.match(c.reason, /docs/);
});

test("small code changes skip, larger ones review", () => {
  assert.equal(classify([f("src/a.ts", 10, 5)], policy).tier, "skip");
  const c = classify([f("src/a.ts", 10, 6), f("README.md", 500)], policy);
  assert.equal(c.tier, "review");
  assert.match(c.reason, /16 changed code lines in 1 files/);
});

test("risky paths always review, whatever the size", () => {
  const c = classify([f(".github/workflows/ci.yml", 1)], policy);
  assert.equal(c.tier, "always");
  assert.deepEqual(c.riskyFiles, [".github/workflows/ci.yml"]);
  // AGENTS.md is both a doc and an agent rule; the rule wins.
  assert.equal(classify([f("AGENTS.md", 1)], policy).tier, "always");
  assert.equal(classify([f("sub/CLAUDE.md", 1)], policy).tier, "always");
});

test("a rename out of a risky path still counts as risky", () => {
  const c = classify([f("old-workflow.yml", 0, 0, { previous_filename: ".github/workflows/deploy.yml" })], policy);
  assert.equal(c.tier, "always");
});

test("the force label raises a small change to review; no label can skip", () => {
  assert.equal(classify([f("src/a.ts", 1)], policy, { labels: ["needs-review"] }).tier, "review");
  assert.equal(classify([f(".github/workflows/x.yml", 1)], policy, { labels: ["skip-review"] }).tier, "always");
});

test("truncated file lists review", () => {
  assert.equal(classify([f("src/a.ts", 1)], policy, { truncated: true }).tier, "always");
});

test("policy files tune defaults but always protect themselves", () => {
  const p = resolvePolicy({ always_review_paths: ["infra/**"], small_change_lines: 0, max_rounds: 0, junk: true });
  assert.ok(p.always_review_paths.includes("infra/**"));
  assert.ok(p.always_review_paths.includes(".github/review-policy.json"));
  assert.equal(p.small_change_lines, 0);
  assert.equal(p.max_rounds, DEFAULT_POLICY.max_rounds);
  const q = resolvePolicy({ extra_always_review_paths: ["config/tailscale/**"] });
  assert.ok(q.always_review_paths.includes(".github/workflows/**"));
  assert.ok(q.always_review_paths.includes("config/tailscale/**"));
  assert.equal(classify([f("src/a.ts", 1)], resolvePolicy({ small_change_lines: 0 })).tier, "review");
});
