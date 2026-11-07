// plan mode: reconcile every eligible pull request, take the non-model steps,
// reserve model and sync work durably, and publish an actionable status.
import { conclusionFor, decide, STATES } from "./decide.mjs";
import { digest } from "./digest.mjs";
import { REPLACEMENT_PREFIX, originalEligibility, parseProvenance, replacementEligibility } from "./eligibility.mjs";
import { encodeLedger, mark, marked, prune, readLedger, reserve, RESERVATION_TTL, transition, usage } from "./ledger.mjs";
import { inferenceGaps } from "./policy.mjs";
import { fieldFilesAt, originalRequest, syncFor } from "./repo.mjs";
import { STATUS_CHECK, ciState, classifyThreads, codexState, productionHealth, reviewResult, reviewThreads } from "./signals.mjs";

export const STATE_LABEL = "pr-repair";
const DASHBOARD = "<!-- pr-repair-dashboard:v1 -->";
const MAX_TASKS = 6;

export async function findStateIssue(ctx) {
  const issues = await ctx.gh.paginate(`/repos/${ctx.repo}/issues?state=open&labels=${STATE_LABEL}&creator=${encodeURIComponent(ctx.botLogin)}`);
  const mine = issues.filter((i) => !i.pull_request && i.user?.id === ctx.botId && i.body?.startsWith(DASHBOARD));
  if (mine.length > 1) throw new Error("several pr-repair state issues are open; close the extras (operator action)");
  if (mine.length) return mine[0];
  try {
    await ctx.gh.post(`/repos/${ctx.repo}/labels`, { name: STATE_LABEL, color: "5319E7", description: "pr-repair controller state" });
  } catch (e) {
    if (e.status !== 422) throw e;
  }
  return ctx.gh.post(`/repos/${ctx.repo}/issues`, { title: "pr-repair status", labels: [STATE_LABEL], body: `${DASHBOARD}\nNo pull requests evaluated yet.` });
}

export async function loadLedger(ctx, issue) {
  if (!issue.number) return { ledger: (await import("./ledger.mjs")).emptyLedger(), commentId: null };
  const comments = await ctx.gh.paginate(`/repos/${ctx.repo}/issues/${issue.number}/comments`);
  return readLedger(comments, ctx.botId);
}

// Optimistic persistence: re-read before writing, verify after.
export async function saveLedger(ctx, issue, state, next) {
  const body = encodeLedger(next);
  if (ctx.gh.dryRun) return ctx.log("[dry-run] ledger not saved");
  if (state.commentId) {
    const current = await ctx.gh.get(`/repos/${ctx.repo}/issues/comments/${state.commentId}`);
    if (current.body !== state.raw) throw new Error("the ledger changed concurrently; failing closed");
    const saved = await ctx.gh.patch(`/repos/${ctx.repo}/issues/comments/${state.commentId}`, { body });
    if (saved.body !== body || saved.user?.id !== ctx.botId) throw new Error("ledger write could not be verified");
  } else {
    const saved = await ctx.gh.post(`/repos/${ctx.repo}/issues/${issue.number}/comments`, { body });
    if (saved.body !== body || saved.user?.id !== ctx.botId) throw new Error("ledger write could not be verified");
    state.commentId = saved.id;
  }
  state.raw = body;
  state.ledger = next;
}

async function checksAt(ctx, sha) {
  return ctx.gh.paginate(`/repos/${ctx.repo}/commits/${sha}/check-runs?filter=latest`, { key: "check_runs" });
}

export async function setStatusCheck(ctx, sha, decision, number) {
  const existing = (await checksAt(ctx, sha)).filter((c) => c.name === STATUS_CHECK && c.app?.id === ctx.appId).sort((a, b) => b.id - a.id)[0];
  const conclusion = conclusionFor(decision.state);
  const body = {
    status: "completed",
    conclusion,
    output: { title: `pr-repair: ${decision.state}`, summary: `${decision.detail}\n\nPull request #${number}. ${STATES[decision.state] ?? ""}\n\n[Controller run](${ctx.runUrl ?? ""})`.slice(0, 4000) },
  };
  if (existing) await ctx.gh.patch(`/repos/${ctx.repo}/check-runs/${existing.id}`, body);
  else await ctx.gh.post(`/repos/${ctx.repo}/check-runs`, { name: STATUS_CHECK, head_sha: sha, ...body });
}

// Interrupted publication recovery: an entry stuck in publishing is published
// only when the branch head carries its nonce; otherwise it is failed and the
// ambiguous write is never replayed.
async function settleStale(ctx, ledger) {
  let next = ledger;
  for (const e of ledger.entries) {
    const age = Date.parse(ctx.now) - Date.parse(e.updatedAt ?? e.createdAt);
    if (e.status === "reserved" && age > RESERVATION_TTL) next = transition(next, e.nonce, "expired", { note: "worker never published; attempt stays consumed" });
    if (e.status === "publishing" && age > 15 * 60000) {
      let sha = null;
      if (e.kind !== "review") {
        try {
          const ref = await ctx.gh.get(`/repos/${ctx.repo}/git/ref/heads/${REPLACEMENT_PREFIX}${e.root}`);
          const commit = await ctx.gh.get(`/repos/${ctx.repo}/git/commits/${ref.object.sha}`);
          if (commit.message.includes(`PR-Repair-Nonce: ${e.nonce}`)) sha = commit.sha;
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
      next = sha ? transition(next, e.nonce, "published", { resultSha: sha, note: "recovered after interrupted publication" }) : transition(next, e.nonce, "failed", { note: "publication was interrupted; not replayed" });
    }
  }
  return next;
}

// A commit that landed without its pull request (the job died in between) gets
// its pull request now, once, from the recorded reservation.
async function recoverReplacements(ctx, ledger) {
  let next = ledger;
  for (const e of ledger.entries.filter((x) => x.status === "published" && x.kind !== "review" && x.target === x.root && !x.replacement && x.resultSha)) {
    const branch = `${REPLACEMENT_PREFIX}${e.root}`;
    const prs = await ctx.gh.paginate(`/repos/${ctx.repo}/pulls?state=all&head=${encodeURIComponent(`${ctx.repo.split("/")[0]}:${branch}`)}`, { max: 100 });
    const existing = prs.find((p) => p.user?.login === ctx.botLogin);
    let number = existing?.number;
    if (!existing) {
      const o = await ctx.gh.get(`/repos/${ctx.repo}/pulls/${e.root}`);
      let ref = null;
      try {
        ref = await ctx.gh.get(`/repos/${ctx.repo}/git/ref/heads/${branch}`);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      if (o.state !== "open" || o.head.sha !== e.rootHead || ref?.object?.sha !== e.resultSha) continue;
      const { openReplacement } = await import("./tasks.mjs");
      number = (await openReplacement(ctx, e, branch)).number;
      ctx.log(`#${e.root}: recovered replacement #${number} after interrupted publication`);
    }
    const i = next.entries.findIndex((x) => x.nonce === e.nonce);
    next = { ...next, entries: next.entries.map((x, k) => (k === i ? { ...x, replacement: number } : x)) };
  }
  return next;
}

async function legacyAttempts(ctx, sha) {
  if (!ctx.policy.legacy.attemptChecks.length) return 0;
  const runs = await ctx.gh.paginate(`/repos/${ctx.repo}/commits/${sha}/check-runs`, { key: "check_runs" });
  return runs.filter((r) => ctx.policy.legacy.attemptChecks.some((c) => c.name === r.name && c.appId === r.app?.id)).length;
}

async function act(ctx, d, { o, r, target, reviewSha }) {
  const { gh, repo } = ctx;
  const pr = target;
  const fresh = async (n, sha) => {
    const cur = await gh.get(`/repos/${repo}/pulls/${n}`);
    if (cur.state !== "open" || cur.head.sha !== sha) throw new Error(`#${n} moved before ${d.action}`);
    return cur;
  };
  switch (d.action) {
    case "request-rebase":
      if (!ctx.approverGh) throw new Error("only an account with push access can ask Dependabot to rebase");
      await fresh(o.number, o.head.sha);
      await ctx.approverGh.post(`/repos/${repo}/issues/${o.number}/comments`, { body: "@dependabot rebase\n\n<sub>Requested once for this head by pr-repair.</sub>" });
      return "rebase";
    case "refresh":
      await fresh(pr.number, pr.head.sha);
      await gh.put(`/repos/${repo}/pulls/${pr.number}/update-branch`, { expected_head_sha: pr.head.sha });
      return "refresh";
    case "rerun-ci": {
      const runs = await gh.paginate(`/repos/${repo}/actions/runs?head_sha=${pr.head.sha}&event=pull_request`, { key: "workflow_runs", max: 200 });
      for (const run of runs.filter((x) => ["cancelled", "timed_out", "startup_failure"].includes(x.conclusion))) await gh.post(`/repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`);
      return "rerun";
    }
    case "close-stale-replacement":
      await gh.post(`/repos/${repo}/issues/${r.pr.number}/comments`, { body: `${d.detail}\n\n<sub>pr-repair</sub>` });
      await gh.patch(`/repos/${repo}/pulls/${r.pr.number}`, { state: "closed" });
      await gh.del(`/repos/${repo}/git/refs/heads/${REPLACEMENT_PREFIX}${o.number}`);
      return null;
    case "close-original": {
      const cur = await fresh(o.number, r.provenance.rootHead);
      await gh.post(`/repos/${repo}/issues/${cur.number}/comments`, { body: `Superseded by #${r.pr.number}, which merged this update with validated repairs. Closing.\n\n<sub>pr-repair</sub>` });
      await gh.patch(`/repos/${repo}/pulls/${cur.number}`, { state: "closed" });
      return null;
    }
    case "request-codex":
      await fresh(pr.number, pr.head.sha);
      await (ctx.approverGh ?? gh).post(`/repos/${repo}/issues/${pr.number}/comments`, { body: `@codex review\n\n<!-- pr-repair-codex:${pr.head.sha} -->` });
      return "codex";
    case "resolve-threads":
      for (const id of r.threadIds.obsolete) {
        await gh.graphql("mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}", { id });
      }
      return null;
    case "pause-merge":
      for (const p of [o, r?.pr].filter((x) => x?.auto_merge)) {
        await gh.graphql("mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}", { id: p.node_id });
      }
      return null;
    case "merge": {
      const cur = await fresh(pr.number, reviewSha);
      if (cur.base.sha !== ctx.baseSha && cur.mergeable_state === "behind") throw new Error("base moved before merge");
      if (ctx.policy.merge.approve !== "none") {
        const approver = ctx.policy.merge.approve === "approver-token" ? ctx.approverGh : gh;
        if (!approver) throw new Error("merge.approve is approver-token but no approver token was provided");
        await approver.post(`/repos/${repo}/pulls/${pr.number}/reviews`, {
          commit_id: reviewSha,
          event: "APPROVE",
          body: "pr-repair: required checks, independent current-head review, protected scope, and production health verified for this exact head.",
        });
      }
      await fresh(pr.number, reviewSha);
      await gh.graphql("mutation($id:ID!,$head:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:SQUASH}){pullRequest{id}}}", { id: cur.node_id, head: reviewSha });
      return null;
    }
    default:
      return null;
  }
}

// ctx: {gh, approverGh?, repo, policy, appId, botId, botLogin, enabled, credentialReady, exclusiveActive, now, log, runUrl, baseSha}
export async function runPlan(ctx) {
  const { gh, repo, policy } = ctx;
  const rows = [];
  const tasks = [];
  const policyDigest = digest(policy);
  const def = await gh.get(`/repos/${repo}/git/ref/heads/${policy.defaultBranch}`);
  ctx.baseSha = def.object.sha;
  const gaps = inferenceGaps(policy, { credentialReady: ctx.credentialReady });
  const issue = ctx.enabled ? await findStateIssue(ctx) : { number: 0 };
  const state = await loadLedger(ctx, issue);
  state.ledger = state.ledger ?? (await import("./ledger.mjs")).emptyLedger();
  let ledger = await settleStale(ctx, state.ledger);
  if (ctx.enabled) ledger = await recoverReplacements(ctx, ledger);
  const production = await productionHealth(gh, repo, policy, ctx.baseSha);
  // A handoff waits until every declared legacy workflow has drained, whatever
  // concurrency group it uses, so two controllers never act at once.
  let exclusiveDetail = null;
  for (const wf of ctx.exclusiveWorkflows ?? []) {
    for (const status of ["in_progress", "queued", "waiting", "pending", "requested"]) {
      const runs = await gh.paginate(`/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/runs?status=${status}`, { key: "workflow_runs", max: 100 });
      if (runs.length && !exclusiveDetail) exclusiveDetail = `${wf} run ${runs[0].id} is still ${status}; pr-repair acts once it has finished, so two controllers never act at once.`;
    }
  }
  // GitHub reports "behind" only when protection requires an up-to-date branch.
  const strict = true;

  const open = await gh.paginate(`/repos/${repo}/pulls?state=open&base=${policy.defaultBranch}`);
  const originals = open.filter((p) => policy.eligibility.authors.includes(p.user?.login));
  const replacements = new Map();
  for (const p of open.filter((x) => x.user?.login === ctx.botLogin && x.head.ref.startsWith(REPLACEMENT_PREFIX))) {
    const prov = parseProvenance(p.body);
    if (prov) replacements.set(prov.root, p);
  }
  const closed = await gh.paginate(`/repos/${repo}/pulls?state=closed&base=${policy.defaultBranch}&sort=updated&direction=desc`, { max: 100 }).catch(() => []);
  const merged = new Map();
  for (const p of closed.filter((x) => x.merged_at && x.user?.login === ctx.botLogin && x.head.ref.startsWith(REPLACEMENT_PREFIX))) {
    const prov = parseProvenance(p.body);
    if (prov && !merged.has(prov.root)) merged.set(prov.root, p);
  }

  for (const listed of originals.sort((a, b) => a.number - b.number)) {
    try {
      const o = await gh.get(`/repos/${repo}/pulls/${listed.number}`);
      const oCommits = await gh.paginate(`/repos/${repo}/pulls/${o.number}/commits`, { max: 250 });
      const eligibility = originalEligibility(policy, o, oCommits, repo);
      if (eligibility.eligible && ledger.legacy[String(o.number)] === undefined && policy.legacy.attemptChecks.length) {
        ledger = { ...ledger, legacy: { ...ledger.legacy, [String(o.number)]: await legacyAttempts(ctx, o.head.sha) } };
      }
      const s = {
        policy,
        enabled: ctx.enabled,
        exclusiveActive: ctx.exclusiveActive || Boolean(exclusiveDetail),
        exclusiveDetail,
        inferenceGaps: gaps,
        productionHealthy: production.healthy,
        productionReason: `Merges paused: ${production.reason}.`,
        strict,
        canAskRebase: Boolean(ctx.approverGh),
        botLogin: ctx.botLogin,
        baseSha: ctx.baseSha,
        limits: policy.repair.limits,
        usage: usage(ledger, o.number, ctx.now),
        original: { pr: o, eligibility, moves: [], ci: { state: "pending", failed: [], missing: [] } },
        replacement: null,
        marks: {},
      };
      let r = null;
      let target = o;
      if (ctx.enabled && eligibility.eligible) {
        const req = await originalRequest(gh, repo, policy, ctx.baseSha, o.head.sha);
        s.original.moves = req.moves;
        // Some runtimes live outside the repository too (for example a CI runner
        // image); their major moves stay with a maintainer by policy.
        const held = req.moves.find((m) => policy.runtimes.find((r) => r.name === m.runtime)?.majors === "maintainer" && m.from.major !== m.to.major);
        if (held) s.original.eligibility = { eligible: false, reason: `${held.runtime} ${held.from.major} → ${held.to.major} is a major runtime move; this repository keeps those with a maintainer (runtimes[].majors).` };
        const rp = replacements.get(o.number);
        const mp = merged.get(o.number);
        if (mp) {
          r = { pr: mp, merged: true, provenance: parseProvenance(mp.body) };
        } else if (rp) {
          const full = await gh.get(`/repos/${repo}/pulls/${rp.number}`);
          const commits = await gh.paginate(`/repos/${repo}/pulls/${rp.number}/commits`, { max: 250 });
          const elig = replacementEligibility(policy, full, commits, { botLogin: ctx.botLogin, repo });
          r = { pr: full, eligibility: elig, provenance: parseProvenance(full.body), merged: false };
          target = full;
        }
        const checks = await checksAt(ctx, target.head.sha);
        const t = r && !r.merged ? r : s.original;
        t.ci = ciState(checks, policy.ci.requiredChecks, policy.ci.checkAppId);
        if (req.moves.length) {
          try {
            const fields = await fieldFilesAt(gh, repo, policy, req.moves, target.head.sha);
            t.syncNeeded = syncFor(policy, req.moves, fields).edits.size > 0;
          } catch (e) {
            s.original.syncError = e.message;
          }
        }
        if (r && !r.merged) {
          r.review = reviewResult(checks, { appId: ctx.appId, head: target.head.sha, ledger });
          r.codex = policy.review.requireCodex ? await codexState(gh, repo, target.number, target.head.sha) : null;
          const threads = await reviewThreads(gh, repo, target.number);
          const signedOff = r.review?.verdict === "pass" && (!policy.review.requireCodex || r.codex === "pass");
          const cls = classifyThreads(threads, { agentLogins: [...policy.review.agentLogins, ctx.botLogin], head: target.head.sha });
          // Obsolete agent threads are resolved only after a fresh signoff.
          r.threadIds = cls;
          r.threads = { obsolete: signedOff ? cls.obsolete.length : 0, blocking: signedOff ? cls.blocking.length : cls.blocking.length + cls.obsolete.length };
          const reviews = await gh.paginate(`/repos/${repo}/pulls/${target.number}/reviews`);
          r.approved = reviews.some((x) => x.state === "APPROVED" && x.commit_id === target.head.sha);
        }
        s.replacement = r;
        const key = (k) => `${o.number}:${target.head.sha}:${k}`;
        s.marks = { rebase: marked(ledger, key("rebase")), refresh: marked(ledger, key("refresh")), rerun: marked(ledger, key("rerun")), codex: marked(ledger, key("codex")) };
      }
      s.targetHead = target.head.sha;
      const d = decide(s);
      ctx.log(`#${o.number}${r && !r.merged ? ` (replacement #${r.pr.number})` : ""}: ${d.state} / ${d.action}: ${d.detail}`);

      if (["sync", "repair", "review"].includes(d.action)) {
        if (tasks.length >= MAX_TASKS) {
          d.state = "waiting-ci";
          d.detail = "The task batch is full; deferred to the next run without reserving an attempt.";
        } else {
          const res = reserve(ledger, { kind: d.action, root: o.number, target: target.number, head: target.head.sha, base: ctx.baseSha, rootHead: o.head.sha, transport: policy.inference.transport, model: policy.inference.model?.[d.action] ?? null }, policy.repair.limits, ctx.now);
          if (res.entry) {
            ledger = res.ledger;
            const feedback = ledger.entries.filter((e) => e.root === o.number && e.status === "failed").slice(-3).map((e) => ({ kind: e.kind, head: e.head, note: e.note, ...(e.feedback ?? {}) }));
            tasks.push({ nonce: res.entry.nonce, kind: d.action, root: o.number, target: target.number, head: target.head.sha, base: ctx.baseSha, rootHead: o.head.sha, policyDigest, ...(d.action === "repair" && feedback.length ? { feedback } : {}) });
          } else {
            d.state = res.exhausted ? "exhausted" : "waiting-ci";
            d.detail = res.reason;
          }
        }
      } else if (d.action !== "none" && ctx.enabled) {
        const markName = await act(ctx, d, { o, r, target, reviewSha: target.head.sha });
        if (markName) ledger = mark(ledger, `${o.number}:${target.head.sha}:${markName}`, ctx.now);
      }
      rows.push({ number: o.number, target: target.number, head: target.head.sha, state: d.state, detail: d.detail });
      if (ctx.enabled && eligibility.eligible) {
        await setStatusCheck(ctx, target.head.sha, d, o.number);
        if (target !== o && !r?.merged) await setStatusCheck(ctx, o.head.sha, { ...d, detail: `Replacement #${target.number}: ${d.detail}` }, o.number);
      }
    } catch (e) {
      ctx.log(`#${listed.number}: evaluation failed: ${e.message}`);
      rows.push({ number: listed.number, target: listed.number, head: listed.head.sha, state: "needs-human", detail: `evaluation failed: ${e.message}`.slice(0, 300) });
      ctx.failed = true;
    }
  }

  // Configured extra branches (for example a weekly audit fix) are paused, never merged.
  if (ctx.enabled && !production.healthy) {
    for (const p of open.filter((x) => x.auto_merge && policy.merge.pauseBranches.includes(x.head.ref) && x.head.repo?.full_name === repo)) {
      await gh.graphql("mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}", { id: p.node_id });
      rows.push({ number: p.number, target: p.number, head: p.head.sha, state: "production-paused", detail: production.reason });
    }
  }

  if (ctx.enabled) {
    ledger = prune(ledger, new Set(originals.map((p) => p.number)), ctx.now);
    if (JSON.stringify(ledger) !== JSON.stringify(state.ledger)) await saveLedger(ctx, issue, state, ledger);
    await writeDashboard(ctx, issue, rows, { gaps, production });
  }
  return { tasks, rows, gaps, production };
}

export function dashboard(rows, { gaps, production, runUrl, now }) {
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    DASHBOARD,
    "## pr-repair status",
    "",
    `Updated ${now}${runUrl ? ` by [this run](${runUrl})` : ""}. Production: ${production.healthy ? "healthy" : `**paused** (${esc(production.reason)})`}.`,
    gaps.length ? `\n**Paid repair and review are paused:** ${gaps.map(esc).join("; ")}.` : "",
    "",
    "| Update | Working PR | Head | State | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| #${r.number} | #${r.target} | \`${r.head.slice(0, 7)}\` | **${r.state}** | ${esc(r.detail).slice(0, 300)} |`),
    rows.length ? "" : "_No eligible pull requests are open._",
    "",
    "<sub>The ledger comment below is the durable attempt record. Do not edit it.</sub>",
  ].join("\n");
}

async function writeDashboard(ctx, issue, rows, extra) {
  const body = dashboard(rows, { ...extra, runUrl: ctx.runUrl, now: ctx.now });
  if (!issue.number) return ctx.log(`[dry-run] dashboard:\n${body}`);
  if (issue.body !== body) await ctx.gh.patch(`/repos/${ctx.repo}/issues/${issue.number}`, { body });
}
