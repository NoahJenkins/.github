// One sticky comment per pull request holds the gate history as hidden JSON,
// plus a short table so a person can see what happened.

export const STATE_MARKER = "<!-- review-gate-state:v1";
const STATE_RE = /<!-- review-gate-state:v1 ([\s\S]*?) -->/;

export const emptyState = () => ({ rounds: [], sweep: {}, escalated: {} });

export function parseState(body) {
  const m = typeof body === "string" ? body.match(STATE_RE) : null;
  if (!m) return emptyState();
  try {
    const s = JSON.parse(m[1]);
    return { rounds: Array.isArray(s.rounds) ? s.rounds : [], sweep: s.sweep || {}, escalated: s.escalated || {} };
  } catch {
    return emptyState();
  }
}

export function renderState(state) {
  const rounds = state.rounds.slice(-20);
  const rows = rounds
    .slice(-10)
    .map((r) => `| \`${r.sha.slice(0, 7)}\` | ${r.tier} | ${r.reviewer} | ${r.result} | ${r.detail.replace(/\|/g, "\\|")} |`);
  const json = JSON.stringify({ ...state, rounds }).replace(/-->/g, "--\\u003e");
  return [
    `${STATE_MARKER} ${json} -->`,
    "### review-gate",
    "",
    "| Commit | Tier | Reviewer | Result | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "<sub>Updated by the review-gate workflow. The required `review-gate` status on the head commit is the source of truth.</sub>",
  ].join("\n");
}

// Number of distinct head commits, newest first, whose latest round found blocking issues.
export function consecutiveFindingRounds(state) {
  const latestBySha = new Map();
  for (const r of state.rounds) latestBySha.set(r.sha, r);
  const ordered = [...latestBySha.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let n = 0;
  for (const r of ordered) {
    if (r.result !== "findings") break;
    n++;
  }
  return n;
}
