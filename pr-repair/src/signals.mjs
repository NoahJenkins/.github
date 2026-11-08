// Reads the evidence a decision needs: required checks, production health,
// review conversations, and the controller's own review check.
import { CODEX_BOT, codexVerdict } from "../../review-gate/src/codex.mjs";

export const REVIEW_CHECK = "pr-repair / independent review";
export const STATUS_CHECK = "pr-repair";

// Latest check run per required name, published by the expected app (GitHub Actions).
export function ciState(checkRuns, required, appId) {
  const failed = [];
  const missing = [];
  let interrupted = false;
  for (const name of required) {
    const run = checkRuns.filter((c) => c.name === name && c.app?.id === appId).sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed") { missing.push(name); continue; }
    if (["failure", "timed_out"].includes(run.conclusion)) failed.push(name);
    else if (["cancelled", "stale", "startup_failure"].includes(run.conclusion)) interrupted = true;
    else if (!["success", "neutral", "skipped"].includes(run.conclusion)) failed.push(name);
  }
  if (failed.length) return { state: "failure", failed, missing };
  if (missing.length) return { state: "pending", failed, missing };
  if (interrupted) return { state: "interrupted", failed, missing };
  return { state: "success", failed, missing };
}

export const failedJobIds = (checkRuns, required, appId) =>
  checkRuns.filter((c) => required.includes(c.name) && c.app?.id === appId && ["failure", "timed_out"].includes(c.conclusion)).map((c) => ({ id: c.id, name: c.name }));

// Production health for the policy's interlock kind. Any read error is unhealthy.
export async function productionHealth(gh, repo, policy, baseSha) {
  const p = policy.merge.production;
  try {
    if (p.kind === "none") return { healthy: true, reason: "no production interlock configured" };
    if (p.kind === "deployments") {
      const deployments = await gh.paginate(`/repos/${repo}/deployments?environment=${encodeURIComponent(p.environment)}`, { max: 300 });
      const mine = deployments.filter((d) => !p.creatorId || d.creator?.id === p.creatorId).sort((a, b) => b.id - a.id);
      const latest = mine[0];
      if (!latest) return { healthy: false, reason: `no ${p.environment} deployment evidence` };
      const statuses = await gh.paginate(`/repos/${repo}/deployments/${latest.id}/statuses`, { max: 300 });
      const state = statuses.sort((a, b) => b.id - a.id)[0]?.state;
      if (state !== "success") return { healthy: false, reason: `latest ${p.environment} deployment is ${state ?? "without status"}` };
      return { healthy: true, reason: `latest ${p.environment} deployment succeeded` };
    }
    // workflow-run: the newest attempt of the release workflow on the default
    // branch must be complete, successful, for the current base, with every
    // required job and step successful, and an optional promoted ref must match.
    const runs = await gh.paginate(`/repos/${repo}/actions/workflows/${encodeURIComponent(p.workflow)}/runs?branch=${encodeURIComponent(policy.defaultBranch)}`, { key: "workflow_runs", max: 1000 });
    if (!runs.length) return { healthy: false, reason: `no ${p.workflow} run on ${policy.defaultBranch}` };
    if (runs.some((r) => r.status !== "completed")) return { healthy: false, reason: `a ${p.workflow} run is still in progress` };
    const latest = runs.reduce((a, b) => (Date.parse(b.updated_at) > Date.parse(a.updated_at) ? b : a));
    if (latest.conclusion !== "success") return { healthy: false, reason: `latest ${p.workflow} run concluded ${latest.conclusion}` };
    if (p.requireCurrentBase !== false && latest.head_sha !== baseSha) return { healthy: false, reason: `latest ${p.workflow} run is for ${latest.head_sha.slice(0, 7)}, not current ${policy.defaultBranch}` };
    if (p.requiredJobs?.length || p.requiredSteps) {
      const jobs = await gh.paginate(`/repos/${repo}/actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs`, { key: "jobs" });
      const named = new Map(jobs.map((j) => [j.name, j]));
      for (const name of p.requiredJobs ?? []) if (named.get(name)?.conclusion !== "success") return { healthy: false, reason: `release job "${name}" did not succeed` };
      for (const [job, steps] of Object.entries(p.requiredSteps ?? {})) {
        for (const step of steps) {
          if (named.get(job)?.steps?.find((s) => s.name === step)?.conclusion !== "success") return { healthy: false, reason: `release step "${job} / ${step}" did not succeed` };
        }
      }
    }
    if (p.promotedRef) {
      const ref = await gh.get(`/repos/${repo}/git/ref/heads/${p.promotedRef}`);
      if (ref.object.sha !== baseSha) return { healthy: false, reason: `${p.promotedRef} is not the current ${policy.defaultBranch}` };
    }
    return { healthy: true, reason: `${p.workflow} succeeded for the current base` };
  } catch (e) {
    return { healthy: false, reason: `production evidence unreadable (${e.status ?? e.message})` };
  }
}

const THREADS = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
  reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated
    comments(first:50){totalCount nodes{author{login} originalCommit{oid}}}}}}}}`;

export async function reviewThreads(gh, repo, number) {
  const [owner, name] = repo.split("/");
  const out = [];
  for (let cursor = null; ;) {
    const d = await gh.graphql(THREADS, { owner, name, number, cursor });
    const t = d.data.repository.pullRequest.reviewThreads;
    out.push(...t.nodes.filter((n) => !n.isResolved));
    if (!t.pageInfo.hasNextPage) return out;
    cursor = t.pageInfo.endCursor;
  }
}

// GraphQL logins omit "[bot]"; compare both forms.
const bare = (l) => String(l || "").replace(/\[bot\]$/, "");

// A thread is obsolete only if every comment is by an agent login and none was
// written against the current head. Human and current-head threads block.
export function classifyThreads(threads, { agentLogins, head }) {
  const agents = new Set(agentLogins.map(bare));
  const obsolete = [];
  const blocking = [];
  for (const t of threads) {
    const comments = t.comments.nodes;
    const allAgents = comments.length > 0 && comments.length === t.comments.totalCount && comments.every((c) => agents.has(bare(c.author?.login)));
    const current = comments.some((c) => c.originalCommit?.oid === head);
    (allAgents && !current ? obsolete : blocking).push(t.id);
  }
  return { obsolete, blocking };
}

export async function codexState(gh, repo, number, head) {
  const [comments, reviews] = await Promise.all([gh.paginate(`/repos/${repo}/issues/${number}/comments`), gh.paginate(`/repos/${repo}/pulls/${number}/reviews`)]);
  const v = codexVerdict({ headSha: head, comments, reviews });
  if (!v.done) return "pending";
  return v.kind === "pass" ? "pass" : v.kind === "findings" ? "findings" : "error";
}

// Files named by the blocking findings on this head, or null when a finding
// has no location (then only a repair attempt can tell whether it is fixable).
export function findingFiles({ codex, reviewComments, review, head }) {
  const files = [];
  if (codex === "findings") {
    const named = reviewComments.filter((c) => c.user?.login === CODEX_BOT && c.commit_id === head && c.path).map((c) => c.path);
    if (!named.length) return null;
    files.push(...named);
  }
  if (review?.verdict === "fail") {
    if (!review.findings?.length || review.findings.some((f) => !f.file)) return null;
    files.push(...review.findings.map((f) => f.file));
  }
  return [...new Set(files)];
}

// The controller's own review: the newest App check on this head, bound to the
// head, base, and a published ledger reservation.
export function reviewResult(checkRuns, { appId, head, ledger }) {
  const run = checkRuns.filter((c) => c.name === REVIEW_CHECK && c.app?.id === appId && c.head_sha === head && c.status === "completed").sort((a, b) => b.id - a.id)[0];
  if (!run) return null;
  try {
    const report = JSON.parse(run.output?.text || "");
    const entry = ledger.entries.find((e) => e.nonce === report.nonce && e.kind === "review" && e.status === "published");
    if (!entry || entry.head !== head || report.head !== head || report.base !== entry.base) return null;
    const verdict = run.conclusion === "success" && report.verdict === "approve" ? "pass" : "fail";
    return { verdict, head, base: report.base, findings: report.findings ?? [], nonce: report.nonce };
  } catch {
    return null;
  }
}
