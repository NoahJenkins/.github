// Last line of defence: finds pull requests whose gate never finished or
// whose auto-merge is blocked, retries the gate twice, then escalates.
import { CONTEXT, UNAVAILABLE, escalate, loadStateComment, saveStateComment } from "./gate.mjs";

const MIN = 60000;
export const SWEEP = { pendingStale: 45 * MIN, missingStale: 30 * MIN, maxRetries: 2 };

export function sweepAction({ pr, gateStatus, now }) {
  if (pr.draft) return null;
  if (!gateStatus) return now - Date.parse(pr.updated_at) > SWEEP.missingStale ? "missing" : null;
  if (gateStatus.state === "pending" && now - Date.parse(gateStatus.updated_at) > SWEEP.pendingStale) return "stalled";
  if (gateStatus.state === "failure" && gateStatus.description?.startsWith(UNAVAILABLE)) return "unavailable";
  return null;
}

export async function runSweep(ctx, { now = Date.now() } = {}) {
  const prs = await ctx.gh.paginate(`/repos/${ctx.repo}/pulls?state=open`);
  for (const listed of prs) {
    if (listed.head.repo?.full_name !== ctx.repo || listed.draft) continue;
    const pr = await ctx.gh.get(`/repos/${ctx.repo}/pulls/${listed.number}`);
    const sha = pr.head.sha;
    const combined = await ctx.gh.get(`/repos/${ctx.repo}/commits/${sha}/status`);
    const gateStatus = combined.statuses.find((s) => s.context === CONTEXT);
    const action = sweepAction({ pr, gateStatus, now });
    const conflict = pr.auto_merge && pr.mergeable_state === "dirty";
    if (!action && !conflict) continue;

    const { comment, state } = await loadStateComment(ctx, pr.number);
    if (conflict) {
      await escalate(ctx, pr.number, sha, state, "a merge conflict blocks auto-merge");
    }
    if (action) {
      const tries = state.sweep[sha] || 0;
      if (tries < SWEEP.maxRetries) {
        state.sweep[sha] = tries + 1;
        ctx.log(`#${pr.number}: gate ${action}; dispatching retry ${tries + 1}`);
        await ctx.gh.post(`/repos/${ctx.repo}/actions/workflows/${ctx.workflowFile}/dispatches`, {
          ref: pr.base.repo.default_branch,
          inputs: { pr: String(pr.number) },
        });
      } else {
        await escalate(ctx, pr.number, sha, state, `review-gate is ${action} after ${SWEEP.maxRetries} automatic retries`);
      }
    }
    await saveStateComment(ctx, pr.number, comment, state);
  }
}
