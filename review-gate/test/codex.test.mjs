import test from "node:test";
import assert from "node:assert/strict";
import { codexVerdict, parseSummary, codexError, CODEX_BOT } from "../src/codex.mjs";

const HEAD = "4f1abb745bfbd0aba733f269a46c8f131465bf9e";
const bot = { login: CODEX_BOT };
const summary = (state, at = "2026-11-02T17:13:30Z") => ({
  user: bot,
  created_at: "2026-11-02T17:00:00Z",
  updated_at: at,
  // Shape copied from a real connector comment (Metriks-Performance #176).
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: state,
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  })} -->\n\n## Codex Review Summary\n`,
});
const comment = (body, at = "2026-11-02T17:20:00Z", user = bot) => ({ user, body, created_at: at, updated_at: at });
const T = (s) => Date.parse(s);

test("parses the nested state block", () => {
  const s = parseSummary(summary({ commit_sha: HEAD, has_any_findings: false, has_unresolved_findings: false, status: "completed" }).body);
  assert.equal(s.commit_sha, HEAD);
  assert.equal(s.status, "completed");
  assert.deepEqual(parseSummary("<!-- codex-pull-request-review-summary --> no state"), { unparsed: true });
  assert.equal(parseSummary("hello"), null);
});

test("completed clean summary for the head passes", () => {
  const v = codexVerdict({ headSha: HEAD, comments: [summary({ commit_sha: HEAD, has_unresolved_findings: false, status: "completed" })], reviews: [] });
  assert.deepEqual(v, { done: true, kind: "pass", via: "summary" });
});

test("unresolved findings fail", () => {
  const v = codexVerdict({ headSha: HEAD, comments: [summary({ commit_sha: HEAD, has_unresolved_findings: true, status: "completed" })], reviews: [] });
  assert.equal(v.kind, "findings");
});

test("a summary for an older commit, or with null verdicts, is not done", () => {
  const old = codexVerdict({ headSha: HEAD, comments: [summary({ commit_sha: "a".repeat(40), has_unresolved_findings: false, status: "completed" })], reviews: [] });
  assert.equal(old.done, false);
  const nulls = codexVerdict({ headSha: HEAD, comments: [summary({ commit_sha: HEAD, has_unresolved_findings: null, status: "completed" })], reviews: [] });
  assert.equal(nulls.done, false);
  const running = codexVerdict({ headSha: HEAD, comments: [summary({ commit_sha: HEAD, has_unresolved_findings: null, status: "running" })], reviews: [] });
  assert.equal(running.done, false);
  assert.equal(running.running, true);
});

test("error replies after the request end the wait; older ones do not", () => {
  const err = comment("You have reached your Codex usage limits for code reviews. You can see your limits in the dashboard.");
  assert.equal(codexVerdict({ headSha: HEAD, comments: [err], reviews: [], requestedAt: T("2026-11-02T17:10:00Z") }).reason, "Codex usage limit reached");
  assert.equal(codexVerdict({ headSha: HEAD, comments: [err], reviews: [], requestedAt: T("2026-11-02T17:30:00Z") }).done, false);
  assert.equal(codexError("To use Codex here, [create an environment for this repo](https://x)"), "no Codex environment for this repo");
  assert.equal(codexError("Codex Review: Something went wrong. Try again later"), "Codex reported an error");
  assert.equal(codexError("Looks good to me"), null);
});

test("errors from other users are ignored", () => {
  const fake = comment("Codex Review: Something went wrong", "2026-11-02T17:20:00Z", { login: "someone" });
  assert.equal(codexVerdict({ headSha: HEAD, comments: [fake], reviews: [], requestedAt: 0 }).done, false);
});

test("clean receipt with a matching short sha passes; a mismatched one does not", () => {
  const ok = comment("Codex Review: Didn't find any major issues. Breezy!\n\n**Reviewed commit:** `4f1abb745b`");
  assert.equal(codexVerdict({ headSha: HEAD, comments: [ok], reviews: [], requestedAt: 0 }).kind, "pass");
  const other = comment("Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `deadbeef00`");
  assert.equal(codexVerdict({ headSha: HEAD, comments: [other], reviews: [], requestedAt: 0 }).done, false);
});

test("a Codex review on the head commit counts as findings", () => {
  const review = { user: bot, commit_id: HEAD, submitted_at: "2026-11-02T17:20:00Z", body: "### 💡 Codex Review" };
  assert.equal(codexVerdict({ headSha: HEAD, comments: [], reviews: [review], requestedAt: 0 }).kind, "findings");
  assert.equal(codexVerdict({ headSha: HEAD, comments: [], reviews: [{ ...review, commit_id: "b".repeat(40) }], requestedAt: 0 }).done, false);
});

test("the newest summary wins", () => {
  const older = summary({ commit_sha: HEAD, has_unresolved_findings: true, status: "completed" }, "2026-11-02T17:00:00Z");
  const newer = summary({ commit_sha: HEAD, has_unresolved_findings: false, status: "completed" }, "2026-11-02T17:30:00Z");
  assert.equal(codexVerdict({ headSha: HEAD, comments: [older, newer], reviews: [] }).kind, "pass");
});

test("activity after the request counts as acknowledgement", () => {
  const s = summary({ commit_sha: "c".repeat(40), has_unresolved_findings: null, status: "running" }, "2026-11-02T17:21:00Z");
  assert.equal(codexVerdict({ headSha: HEAD, comments: [s], reviews: [], requestedAt: T("2026-11-02T17:20:00Z") }).activity, true);
});
