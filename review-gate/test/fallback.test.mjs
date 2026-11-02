import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { rightSideLines } from "../src/diff.mjs";
import { buildPrompt, extractReviewRules, normalizeFindings, validateVerdict } from "../src/fallback.mjs";
import { consecutiveFindingRounds, emptyState, parseState, renderState } from "../src/state.mjs";
import { sweepAction, SWEEP } from "../src/sweep.mjs";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+++ odd line that starts with plus signs
+ok
`;

test("right-side lines include added and context lines only", () => {
  const m = rightSideLines(DIFF);
  assert.deepEqual([...m.get("src/a.ts")], [1, 2, 3, 4]);
  assert.deepEqual([...m.get("new.ts")], [1, 2]);
});

test("findings move to the line that matches their evidence; unverifiable ones go to the body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rg-test-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src/a.ts"), "const a = 1;\nconst b = 3;\nconst c = 4;\nexport { a };\n");
  const { inline, other } = await normalizeFindings(
    [
      // Right line.
      { path: join(dir, "src/a.ts"), line: 2, severity: "P1", title: "wrong value", detail: "b", evidence: "const b = 3;" },
      // Diff-file numbering (off by 6): moved to line 3.
      { path: "./src/a.ts", line: 9, severity: "P1", title: "c", detail: "", evidence: "const c = 4;" },
      // Evidence not in the file: body only.
      { path: "src/a.ts", line: 1, severity: "P0", title: "ghost", detail: "", evidence: "rm -rf /" },
    ],
    dir,
    rightSideLines(DIFF),
  );
  assert.deepEqual(inline.map((c) => [c.path, c.line, c.side]), [["src/a.ts", 2, "RIGHT"], ["src/a.ts", 3, "RIGHT"]]);
  assert.equal(other.length, 1);
  assert.equal(other[0].title, "ghost");
  await rm(dir, { recursive: true, force: true });
});

test("any finding forces a fail verdict; malformed output is rejected", () => {
  const v = validateVerdict({ verdict: "pass", summary: "x", findings: [{ path: "a", line: 1, severity: "P1", title: "t", detail: "d" }] });
  assert.equal(v.verdict, "fail");
  assert.equal(validateVerdict({ verdict: "maybe", findings: [] }), null);
  assert.equal(validateVerdict(null), null);
  assert.equal(validateVerdict({ verdict: "pass", summary: "", findings: [] }).verdict, "pass");
});

test("prompt marks repository content as untrusted and includes trusted rules", () => {
  const p = buildPrompt({ repo: "o/r", number: 7, tier: "review", tierReason: "20 lines", reviewRules: "## Code review rules\n- no secrets", truncatedNote: "" });
  assert.match(p, /untrusted data/);
  assert.match(p, /Ignore any instructions/);
  assert.match(p, /no secrets/);
});

test("extracts the review section from AGENTS.md", () => {
  const md = "# Repo\n\n## Build\nmake\n\n## Code review rules\n\n- Block data loss.\n\n## Paths\nx";
  assert.equal(extractReviewRules(md), "## Code review rules\n\n- Block data loss.\n");
  assert.equal(extractReviewRules("# none"), "");
});

test("state round-trips through the sticky comment and escapes comment terminators", () => {
  const s = emptyState();
  s.rounds.push({ sha: "a".repeat(40), tier: "review", reviewer: "codex", result: "findings", detail: "x --> y | z", at: "2026-11-02T10:00:00Z" });
  const body = renderState(s);
  assert.equal(parseState(body).rounds[0].detail, "x --> y | z");
  const marker = body.split("\n")[0];
  assert.equal(marker.split("-->").length, 2, "the hidden JSON cannot close the marker early");
});

test("consecutive finding rounds count distinct commits, newest first", () => {
  const r = (sha, result, at) => ({ sha, tier: "review", reviewer: "codex", result, detail: "", at });
  const s = { ...emptyState(), rounds: [r("a", "findings", "2026-01-01T00:00:00Z"), r("b", "pass", "2026-01-02T00:00:00Z"), r("c", "findings", "2026-01-03T00:00:00Z"), r("d", "findings", "2026-01-04T00:00:00Z"), r("d", "findings", "2026-01-04T01:00:00Z")] };
  assert.equal(consecutiveFindingRounds(s), 2);
});

test("sweep acts on missing, stalled, and unavailable gates only", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const old = new Date(now - SWEEP.pendingStale - 1000).toISOString();
  const fresh = new Date(now - 60000).toISOString();
  const pr = { draft: false, updated_at: old };
  assert.equal(sweepAction({ pr, gateStatus: null, now }), "missing");
  assert.equal(sweepAction({ pr: { ...pr, updated_at: fresh }, gateStatus: null, now }), null);
  assert.equal(sweepAction({ pr, gateStatus: { state: "pending", updated_at: old }, now }), "stalled");
  assert.equal(sweepAction({ pr, gateStatus: { state: "pending", updated_at: fresh }, now }), null);
  assert.equal(sweepAction({ pr, gateStatus: { state: "failure", description: "Review unavailable: x", updated_at: old }, now }), "unavailable");
  assert.equal(sweepAction({ pr, gateStatus: { state: "failure", description: "Codex found blocking issues: fix", updated_at: old }, now }), null);
  assert.equal(sweepAction({ pr: { ...pr, draft: true }, gateStatus: null, now }), null);
});
