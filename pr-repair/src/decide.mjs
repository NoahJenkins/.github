import { matchesAny } from "../../review-gate/src/glob.mjs";

// Recorded by publish when a repair proposal is empty; decide() reads it back.
export const NO_CHANGE = "the repair proposal changes nothing";

// The pure decision for one original update and its replacement. Every path
// ends in a named state, so a stalled pull request is always visible.

export const STATES = Object.freeze({
  disabled: "Automation is not enabled for this repository.",
  "missing-configuration": "Paid repair is paused until its configuration is complete.",
  "unsupported-scope": "This change is outside the repository's repair policy.",
  "waiting-ci": "Waiting for required checks on the current head.",
  "waiting-review": "Waiting for independent review of the current head.",
  "waiting-merge-path": "The repository's existing workflow merges this original update.",
  repairing: "A bounded repair attempt is reserved for this head.",
  reviewing: "An independent review is reserved for this head.",
  conflict: "A merge conflict blocks this update.",
  exhausted: "The bounded attempts are used up. A maintainer decides next.",
  "production-paused": "Production is not healthy; merges are paused.",
  "queued-merge": "Native auto-merge is queued for the exact validated head.",
  resolved: "The replacement merged and the original was closed.",
  "needs-human": "A maintainer must act on this pull request.",
});

const BLOCKED = new Set(["missing-configuration", "unsupported-scope", "conflict", "exhausted", "production-paused", "needs-human"]);
export const conclusionFor = (state) => (state === "resolved" || state === "queued-merge" ? "success" : BLOCKED.has(state) ? "action_required" : "neutral");

const out = (state, action = "none", detail = STATES[state], extra = {}) => ({ state, action, detail, ...extra });

// s: snapshot assembled by reconcile.mjs; see the README for each field.
export function decide(s) {
  const { policy, original: o, replacement: r, usage, limits } = s;
  if (!s.enabled) return out("disabled");
  if (s.exclusiveActive) return out("missing-configuration", "none", s.exclusiveDetail ?? "Another dependency controller is active for this repository. Disable it before pr-repair takes over, so two controllers never race on one pull request.");
  if (!o.eligibility.eligible) return out("unsupported-scope", "none", o.eligibility.reason);

  // Replacement lifecycle first: it may be merged, stale, or foreign.
  if (r) {
    if (r.merged) {
      if (!policy.merge.closeOriginal) return out("resolved", "none", `Replacement #${r.pr.number} merged.`);
      if (o.pr.head.sha !== r.provenance.rootHead) return out("needs-human", "none", `Replacement #${r.pr.number} merged, but the original head moved; it is left open for a maintainer.`);
      return out("resolved", "close-original", `Replacement #${r.pr.number} merged; closing the superseded original.`);
    }
    if (!r.eligibility.eligible) return out("needs-human", "none", `Replacement #${r.pr.number}: ${r.eligibility.reason}.`);
    if (r.provenance.rootHead !== o.pr.head.sha) {
      return out("waiting-ci", "close-stale-replacement", `The original moved to ${o.pr.head.sha.slice(0, 7)}; the replacement for ${r.provenance.rootHead.slice(0, 7)} is closed and work restarts from the new head.`);
    }
  }

  const target = r ? r.pr : o.pr;
  const t = r ?? o;
  const label = r ? `replacement #${target.number}` : `#${target.number}`;
  // Production pauses only merges pr-repair owns: its replacements, and
  // originals only where policy lets pr-repair merge them. Another workflow's
  // queued original is that workflow's to pause.
  const pause = [r?.pr.auto_merge && r.pr.number, policy.merge.originals && o.pr.auto_merge && o.pr.number].filter(Boolean);
  const paused = (state, detail) => out(state, pause.length ? "pause-merge" : "none", detail, pause.length ? { pause } : {});

  const inflight = (usage.open ?? [])[0];
  if (inflight) {
    return out(inflight.kind === "review" ? "reviewing" : "repairing", "none", `Attempt ${inflight.nonce.slice(0, 8)} (${inflight.kind}) is ${inflight.status}; waiting for it to publish or expire.`);
  }

  // Dependabot obeys "@dependabot rebase" only from accounts with push access,
  // so only the approver token may ask; an App comment is ignored.
  if (target.mergeable_state === "dirty") {
    if (r) return out("conflict", "close-stale-replacement", `${label} conflicts with ${policy.defaultBranch}; it is closed and rebuilt after the update bot rebases the original.`);
    if (!s.canAskRebase) return out("conflict", "none", "Dependabot rebases conflicting updates on its own; a maintainer can comment `@dependabot rebase` to hurry it.");
    return s.marks.rebase ? out("conflict", "none", "The update bot was asked to rebase this conflicting head; waiting.") : out("conflict", "request-rebase", "Asking the update bot to rebase the conflicting head.");
  }
  if (target.mergeable_state === "behind" && s.strict) {
    if (r) {
      if (!s.marks.refresh) return out("waiting-ci", "refresh", `${label} is behind ${policy.defaultBranch}; refreshing once for this head.`);
    } else if (policy.merge.originals && s.canAskRebase && !s.marks.rebase && t.ci.state === "success") {
      return out("waiting-ci", "request-rebase", `${label} is behind ${policy.defaultBranch}; asking the update bot to rebase once for this head.`);
    } else if (policy.merge.originals && !s.canAskRebase && !s.marks.refresh && t.ci.state === "success") {
      // No account Dependabot obeys: the App merges the default branch in (ark).
      return out("waiting-ci", "refresh", `${label} is behind ${policy.defaultBranch}; updating its branch once for this head.`);
    }
    // Otherwise evaluate the head as it is: a failing head can still be repaired,
    // and the replacement branch is refreshed by the App.
  }

  // Runtime contract sync is trusted and free. Run it before any model work.
  if (o.syncError) return out("unsupported-scope", "none", `Runtime contract: ${o.syncError}`);
  if (t.syncNeeded) {
    if (usage.syncFor(target.head.sha) >= limits.syncPerHead) return out("exhausted", "none", "The trusted runtime sync for this head already ran and did not settle it.");
    return out("repairing", "sync", `Synchronizing declared runtime fields (${o.moves.map((m) => `${m.image} ${m.from.tag} -> ${m.to.tag}`).join(", ")}).`);
  }

  const ci = t.ci;
  if (ci.state === "pending") return out("waiting-ci", "none", `Waiting for ${ci.missing.join(", ") || "required checks"} on ${target.head.sha.slice(0, 7)}.`);
  if (ci.state === "interrupted") {
    return s.marks.rerun ? out("needs-human", "none", `Required checks were interrupted twice on ${target.head.sha.slice(0, 7)}.`) : out("waiting-ci", "rerun-ci", "Re-running interrupted required checks once.");
  }

  const findings = r?.review?.verdict === "fail" || r?.codex === "findings";
  // A failure must reproduce on a fresh run before any paid repair: stale runs
  // and infrastructure timeouts (ark #180) cost a free re-run, not an attempt.
  if (ci.state === "failure" && !findings && !s.marks.rerun) {
    return out("waiting-ci", "rerun-ci", `${label} failed ${ci.failed.join(", ")}; re-running the failed checks once to confirm before paid repair.`);
  }
  if (ci.state === "failure" || findings) {
    const why = ci.state === "failure" ? `failed ${ci.failed.join(", ")}` : "blocking review findings";
    // Paid repair only where the model can act: Metriks #183 spent three
    // attempts on findings in docs the model may not edit.
    if (s.emptyRepairOnHead) return out("needs-human", "none", `${label} ${why}; a repair of this head proposed no change, so a maintainer decides next.`);
    if (ci.state !== "failure" && r.findingFiles?.length) {
      const editable = (f) => matchesAny(f, policy.repair.editable) && !matchesAny(f, policy.repair.protected ?? []);
      if (!r.findingFiles.some(editable)) return out("needs-human", "none", `${label} has review findings only in files repair may not edit (${r.findingFiles.join(", ")}); a maintainer resolves them.`);
    }
    if (usage.repair >= limits.repairPerPr) return out("exhausted", "none", `${label} ${why}; repair budget used (${usage.repair}/${limits.repairPerPr}).`);
    if (s.inferenceGaps.length) return out("missing-configuration", "none", `${label} ${why}. Repair is paused: ${s.inferenceGaps.join("; ")}.`);
    if (usage.todayModel >= limits.dailyModelTasks) return out("waiting-ci", "none", `${label} ${why}; the daily model budget is used. Resumes tomorrow (UTC).`);
    return out("repairing", "repair", `${label} ${why}; reserving repair ${usage.repair + 1}/${limits.repairPerPr}.`);
  }

  // Required checks pass on the current head.
  if (!r) {
    if (!policy.merge.originals) return out("waiting-merge-path");
    if (policy.review.originals && !o.review) return reviewOrPause(s, label);
    if (!s.productionHealthy) return paused("production-paused", s.productionReason);
    if (o.pr.auto_merge?.enabled_by?.login === s.botLogin) return out("queued-merge");
    return out("queued-merge", "merge", `${label} passed required checks; queueing native auto-merge for ${target.head.sha.slice(0, 7)}.`);
  }

  if (!r.review || r.review.head !== target.head.sha || r.review.base !== s.baseSha) return reviewOrPause(s, label);
  if (policy.review.requireCodex && r.codex !== "pass") {
    if (r.codex === "error") return out("needs-human", "none", "Codex review reported an error for this head.");
    if (s.marks.codex) return out("waiting-review", "none", "Waiting for Codex review of the current head.");
    return out("waiting-review", "request-codex", "Requesting Codex review of the current head.");
  }
  if (r.threads.obsolete) return out("waiting-review", "resolve-threads", `Resolving ${r.threads.obsolete} obsolete agent conversation(s) after fresh signoff.`);
  if (r.threads.blocking) return out("needs-human", "none", `${r.threads.blocking} unresolved human or current-head conversation(s) need a maintainer.`);
  if (!s.productionHealthy) return paused("production-paused", s.productionReason);
  if (r.pr.auto_merge && r.approved) return out("queued-merge");
  return out("queued-merge", "merge", `Independent review and required checks passed on ${target.head.sha.slice(0, 7)}; approving per policy and queueing native auto-merge.`);
}

function reviewOrPause(s, label) {
  const { usage, limits } = s;
  if (usage.review >= s.limits.reviewPerPr) return out("exhausted", "none", `${label}: review budget used (${usage.review}/${limits.reviewPerPr}).`);
  if (s.inferenceGaps.length) return out("missing-configuration", "none", `${label} needs independent review. Paused: ${s.inferenceGaps.join("; ")}.`);
  if (usage.todayModel >= limits.dailyModelTasks) return out("waiting-review", "none", "The daily model budget is used. Resumes tomorrow (UTC).");
  return out("reviewing", "review", `Reserving independent review of ${label} at ${s.targetHead.slice(0, 7)}.`);
}
