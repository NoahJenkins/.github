// Reads the Codex GitHub connector's comments and reviews. None of this format
// is documented by OpenAI, so every parser fails closed: anything it cannot
// read is "not done", and the gate falls back after its timeout.

export const CODEX_BOT = "chatgpt-codex-connector[bot]";

const STATE_RE = /codex-review-state:v1\s*(\{[\s\S]*?\})\s*-->/;
const RECEIPT_CLEAN_RE = /Didn't find any major issues/i;
const RECEIPT_SHA_RE = /Reviewed commit:\*{0,2}\s*`([0-9a-f]{7,40})`/i;

const ERRORS = [
  [/usage limits?/i, "Codex usage limit reached"],
  [/create an environment/i, "no Codex environment for this repo"],
  [/create a Codex account|connect to github/i, "Codex account not linked"],
  [/something went wrong/i, "Codex reported an error"],
  [/not enabled for this repo/i, "Codex review not enabled for this repo"],
  [/workspace is deactivated/i, "Codex workspace deactivated"],
];

export function parseSummary(body) {
  if (typeof body !== "string" || !body.includes("codex-pull-request-review-summary")) return null;
  const m = body.match(STATE_RE);
  if (!m) return { unparsed: true };
  try {
    const review = JSON.parse(m[1]).code_review;
    return review && typeof review === "object" ? review : { unparsed: true };
  } catch {
    return { unparsed: true };
  }
}

export function codexError(body) {
  if (typeof body !== "string" || body.includes("codex-pull-request-review-summary")) return null;
  for (const [re, reason] of ERRORS) if (re.test(body)) return reason;
  return null;
}

const t = (s) => Date.parse(s);
const byCodex = (x) => x?.user?.login === CODEX_BOT;

// requestedAt: ms epoch of our `@codex review`, or null to read existing state only.
export function codexVerdict({ headSha, comments, reviews, requestedAt = null }) {
  const after = (s) => requestedAt === null || t(s) >= requestedAt;
  const fromCodex = comments.filter(byCodex);

  const summaries = fromCodex
    .map((c) => ({ c, s: parseSummary(c.body) }))
    .filter((x) => x.s)
    .sort((a, b) => t(b.c.updated_at) - t(a.c.updated_at));
  const latest = summaries[0];
  let running = false;
  if (latest && !latest.s.unparsed && latest.s.commit_sha === headSha) {
    if (latest.s.status === "completed") {
      if (latest.s.has_unresolved_findings === false) return { done: true, kind: "pass", via: "summary" };
      if (latest.s.has_unresolved_findings === true) return { done: true, kind: "findings", via: "summary" };
    } else if (latest.s.status) {
      running = true;
    }
  }

  const errors = fromCodex.filter((c) => after(c.created_at)).map((c) => codexError(c.body)).filter(Boolean);
  if (errors.length) return { done: true, kind: "error", reason: errors[errors.length - 1] };

  for (const c of fromCodex) {
    if (!after(c.created_at) || !RECEIPT_CLEAN_RE.test(c.body || "")) continue;
    const m = (c.body || "").match(RECEIPT_SHA_RE);
    if (m && headSha.startsWith(m[1].toLowerCase())) return { done: true, kind: "pass", via: "receipt" };
  }

  if (reviews.some((r) => byCodex(r) && r.commit_id === headSha && after(r.submitted_at))) {
    return { done: true, kind: "findings", via: "review" };
  }

  const activity = fromCodex.some((c) => requestedAt !== null && t(c.updated_at) >= requestedAt);
  return { done: false, running, activity, summaryUnparsed: Boolean(latest?.s.unparsed) };
}
