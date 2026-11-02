import { classify, resolvePolicy } from "./classify.mjs";
import { dependabotDecision } from "./dependabot.mjs";
import { codexVerdict, CODEX_BOT } from "./codex.mjs";
import { rightSideLines } from "./diff.mjs";
import { buildPrompt, checkoutCommit, extractReviewRules, normalizeFindings, runBackupReview } from "./fallback.mjs";
import { STATE_MARKER, consecutiveFindingRounds, parseState, renderState } from "./state.mjs";

export const CONTEXT = "review-gate";
export const ESCALATION_LABEL = "needs-human";
export const UNAVAILABLE = "Review unavailable";

const MIN = 60000;
export const TIMING = {
  poll: 20000,
  ack: 5 * MIN, // no 👀 from Codex: ask once more
  codex: 20 * MIN, // no Codex result: run the backup
  backup: 12 * MIN,
  deadline: 34 * MIN, // the caller job has timeout-minutes: 40
};
const MAX_DIFF_BYTES = 400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const modelName = (m) => m.replace(/^[^/]+\//, "");

export async function setStatus(ctx, sha, state, description) {
  await ctx.gh.post(`/repos/${ctx.repo}/statuses/${sha}`, {
    state,
    context: CONTEXT,
    description: short(description),
    target_url: ctx.runUrl,
  });
  ctx.log(`status ${state}: ${description}`);
}

export async function loadStateComment(ctx, number) {
  const comments = await ctx.gh.paginate(`/repos/${ctx.repo}/issues/${number}/comments`);
  const mine = comments.find((c) => c.user?.type === "Bot" && c.body?.startsWith(STATE_MARKER));
  return { comment: mine, state: parseState(mine?.body), comments };
}

// Returns the comment so later saves edit it instead of posting a new one.
export async function saveStateComment(ctx, number, comment, state) {
  const body = renderState(state);
  if (comment?.id) {
    await ctx.gh.patch(`/repos/${ctx.repo}/issues/comments/${comment.id}`, { body });
    return comment;
  }
  return ctx.gh.post(`/repos/${ctx.repo}/issues/${number}/comments`, { body });
}

// Labels the PR and mentions the owner once per commit and reason.
export async function escalate(ctx, number, sha, state, reason) {
  const key = `${sha}:${reason}`;
  if (state.escalated[key]) return;
  state.escalated[key] = new Date().toISOString();
  try {
    await ctx.gh.post(`/repos/${ctx.repo}/labels`, { name: ESCALATION_LABEL, color: "B60205", description: "review-gate needs a person" });
  } catch (e) {
    if (e.status !== 422) throw e;
  }
  await ctx.gh.post(`/repos/${ctx.repo}/issues/${number}/labels`, { labels: [ESCALATION_LABEL] });
  await ctx.gh.post(`/repos/${ctx.repo}/issues/${number}/comments`, {
    body: `@${ctx.owner} review-gate needs you on \`${sha.slice(0, 7)}\`: ${reason}`,
  });
}

async function readCodex(ctx, number, sha, requestedAt) {
  const [comments, reviews] = await Promise.all([
    ctx.gh.paginate(`/repos/${ctx.repo}/issues/${number}/comments`),
    ctx.gh.paginate(`/repos/${ctx.repo}/pulls/${number}/reviews`),
  ]);
  return codexVerdict({ headSha: sha, comments, reviews, requestedAt });
}

async function codexAcked(ctx, commentId) {
  if (!commentId) return false;
  const reactions = await ctx.gh.get(`/repos/${ctx.repo}/issues/comments/${commentId}/reactions`);
  return reactions.some((r) => r.user?.login === CODEX_BOT && r.content === "eyes");
}

async function requestCodex(ctx, number) {
  const c = await ctx.triggerGh.post(`/repos/${ctx.repo}/issues/${number}/comments`, { body: "@codex review" });
  ctx.log(`requested Codex review (comment ${c.id})`);
  return c.id;
}

export async function waitForCodex(ctx, number, sha) {
  const existing = await readCodex(ctx, number, sha, null);
  if (existing.done && existing.kind !== "error") return existing;
  if (ctx.dryRun) return { done: false, kind: "error", reason: "dry run: Codex not requested" };

  const requestedAt = Date.now() - 10000;
  let commentId = await requestCodex(ctx, number);
  let acked = false;
  let reasked = false;
  const start = Date.now();
  while (Date.now() - start < TIMING.codex) {
    await sleep(TIMING.poll);
    const pr = await ctx.gh.get(`/repos/${ctx.repo}/pulls/${number}`);
    if (pr.state !== "open" || pr.head.sha !== sha) return { done: true, kind: "moved" };
    const v = await readCodex(ctx, number, sha, requestedAt);
    if (v.done) return v;
    acked ||= v.running || v.activity || (await codexAcked(ctx, commentId));
    if (!acked && Date.now() - start > TIMING.ack) {
      if (reasked) return { done: true, kind: "error", reason: "Codex did not respond" };
      ctx.log("no Codex acknowledgement; asking once more");
      commentId = await requestCodex(ctx, number);
      reasked = true;
    }
  }
  return { done: true, kind: "error", reason: `Codex gave no result in ${TIMING.codex / MIN} min` };
}

async function prDiff(ctx, number, files, riskyFiles) {
  let diff = null;
  try {
    diff = await ctx.gh.get(`/repos/${ctx.repo}/pulls/${number}`, { accept: "application/vnd.github.v3.diff", raw: true });
  } catch (e) {
    if (e.status !== 406) throw e; // 406: diff too large for the API
  }
  if (diff !== null && diff.length <= MAX_DIFF_BYTES) return { diff, note: "" };
  const focus = riskyFiles.length ? files.filter((f) => riskyFiles.includes(f.filename)) : files;
  let out = "";
  for (const f of focus) {
    if (!f.patch) continue;
    const chunk = `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.previous_filename || f.filename}\n+++ b/${f.filename}\n${f.patch}\n`;
    if (out.length + chunk.length > MAX_DIFF_BYTES) break;
    out += chunk;
  }
  return {
    diff: out,
    note: "This pull request is too large to review in full. The diff file holds only part of it. Review what is there and mention in the summary that the pull request should be split.",
  };
}

export async function backupReview(ctx, pr, files, c, codexReason) {
  if (!ctx.gatewayKey) return { ok: false, error: "no AI_GATEWAY_API_KEY for the backup review" };
  const { diff, note } = await prDiff(ctx, pr.number, files, c.riskyFiles);
  let reviewRules = "";
  try {
    const f = await ctx.gh.get(`/repos/${ctx.repo}/contents/AGENTS.md?ref=${pr.base.sha}`);
    reviewRules = extractReviewRules(Buffer.from(f.content, "base64").toString("utf8"));
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const prompt = buildPrompt({ repo: ctx.repo, number: pr.number, tier: c.tier, tierReason: c.reason, reviewRules, truncatedNote: note });
  const dir = await checkoutCommit({ repoFullName: ctx.repo, sha: pr.head.sha, token: ctx.token });
  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    result = await runBackupReview({ dir, diff, prompt, model: ctx.fallbackModel, version: ctx.claudeVersion, gatewayKey: ctx.gatewayKey, timeoutMs: TIMING.backup });
    ctx.log(`backup review attempt ${attempt}: ${result.ok ? result.verdict : result.error} (cost $${(result.cost || 0).toFixed(3)})`);
    if (result.ok) break;
  }
  if (!result.ok) return result;

  const { inline, other } = normalizeFindings(result.findings, dir, rightSideLines(diff));
  const name = modelName(ctx.fallbackModel);
  const lines = [
    `### review-gate backup review (${name})`,
    `Codex was unavailable (${codexReason}), so ${name} reviewed \`${pr.head.sha.slice(0, 7)}\`.`,
    "",
    `**Verdict:** ${result.verdict === "pass" ? "no blocking issues" : `${result.findings.length} blocking issue(s)`}`,
    "",
    result.summary,
    ...(other.length ? ["", "**Findings outside the diff:**", ...other.map((f) => `- \`${f.path}:${f.line}\` **${f.severity}: ${f.title}** ${f.detail || ""}`)] : []),
    "",
    `<sub>Cost $${result.cost.toFixed(3)}. Only P0/P1 issues block the merge.</sub>`,
  ];
  const review = { commit_id: pr.head.sha, event: "COMMENT", body: lines.join("\n"), comments: inline };
  try {
    await ctx.gh.post(`/repos/${ctx.repo}/pulls/${pr.number}/reviews`, review);
  } catch (e) {
    if (e.status !== 422) throw e;
    const flat = inline.map((f) => `- \`${f.path}:${f.line}\` ${f.body.replace(/\n+/g, " ")}`);
    await ctx.gh.post(`/repos/${ctx.repo}/pulls/${pr.number}/reviews`, { ...review, comments: [], body: [review.body, ...flat].join("\n") });
  }
  return result;
}

async function loadPolicy(ctx, baseSha) {
  try {
    const f = await ctx.gh.get(`/repos/${ctx.repo}/contents/${ctx.policyPath}?ref=${baseSha}`);
    return resolvePolicy(JSON.parse(Buffer.from(f.content, "base64").toString("utf8")));
  } catch (e) {
    if (e.status === 404) return resolvePolicy(null);
    throw new Error(`cannot read ${ctx.policyPath}: ${e.message}`);
  }
}

// Returns once the `review-gate` status for the current head is final.
export async function runGate(ctx, number) {
  const pr = await ctx.gh.get(`/repos/${ctx.repo}/pulls/${number}`);
  if (pr.state !== "open") return ctx.log("pull request is not open");
  if (pr.draft) return ctx.log("draft pull request: no status until it is ready for review");
  const sha = pr.head.sha;
  ctx.currentSha = sha; // error and deadline handlers may only touch this commit
  const labels = pr.labels.map((l) => l.name);

  if (pr.head.repo?.full_name !== ctx.repo) {
    return setStatus(ctx, sha, "failure", "Fork pull request: needs maintainer review");
  }

  const policy = await loadPolicy(ctx, pr.base.sha);

  const files = await ctx.gh.paginate(`/repos/${ctx.repo}/pulls/${number}/files`);

  if (pr.user.login === "dependabot[bot]") {
    // Dependabot runs get no Actions secrets, so Codex and the backup cannot run here.
    const d = dependabotDecision({ title: pr.title, body: pr.body || "", labels, files }, policy);
    return d.pass
      ? setStatus(ctx, sha, "success", `Dependabot ${d.reason}: required CI is the gate`)
      : setStatus(ctx, sha, "failure", `Dependabot needs maintainer review: ${d.reason}`);
  }

  const c = classify(files, policy, { labels, truncated: files.length >= 3000 });
  ctx.log(`tier ${c.tier}: ${c.reason}`);

  const loaded = await loadStateComment(ctx, number);
  const state = loaded.state;
  let comment = loaded.comment;
  const save = async () => {
    comment = await saveStateComment(ctx, number, comment, state);
  };
  const record = async (reviewer, result, detail) => {
    state.rounds.push({ sha, tier: c.tier, reviewer, result, detail: short(detail, 120), at: new Date().toISOString() });
    await save();
  };

  if (c.tier === "skip") {
    await setStatus(ctx, sha, "success", `Skipped: ${c.reason}`);
    return record("none", "skipped", c.reason);
  }

  const tierLabel = c.tier === "always" ? "Always-review" : "Review";
  await setStatus(ctx, sha, "pending", `${tierLabel}: waiting for Codex (${c.reason})`);
  const codex = await waitForCodex(ctx, number, sha);
  if (codex.kind === "moved") return ctx.log("head moved; the newer run owns the status");

  let outcome;
  if (codex.kind === "pass") {
    await setStatus(ctx, sha, "success", "Codex: no blocking issues");
    return record("codex", "pass", `no blocking issues (${codex.via})`);
  }
  if (codex.kind === "findings") {
    outcome = { reviewer: "codex", detail: "Codex found blocking issues" };
  } else {
    ctx.log(`Codex unavailable: ${codex.reason}`);
    await setStatus(ctx, sha, "pending", `${codex.reason}; running backup review`);
    const b = await backupReview(ctx, pr, files, c, codex.reason);
    if (!b.ok) {
      await setStatus(ctx, sha, "failure", `${UNAVAILABLE}: ${b.error}`);
      await record("backup", "error", b.error);
      await escalate(ctx, number, sha, state, `no reviewer could finish (${codex.reason}; ${b.error})`);
      return save();
    }
    if (b.verdict === "pass") {
      await setStatus(ctx, sha, "success", `Backup review (${modelName(ctx.fallbackModel)}): no blocking issues`);
      return record("backup", "pass", `no blocking issues; Codex: ${codex.reason}`);
    }
    outcome = { reviewer: "backup", detail: `${b.findings.length} blocking issue(s)` };
  }

  await record(outcome.reviewer, "findings", outcome.detail);
  const rounds = consecutiveFindingRounds(state);
  if (rounds >= policy.max_rounds) {
    await setStatus(ctx, sha, "failure", `Escalated: ${rounds} review rounds found blocking issues`);
    await escalate(ctx, number, sha, state, `${rounds} review rounds in a row found blocking issues`);
    return save();
  }
  return setStatus(ctx, sha, "failure", `${outcome.detail}: fix, resolve threads, push`);
}
