// Which pull requests pr-repair may touch. Only bot-authored dependency updates
// and the replacements this controller published are eligible; a human pull
// request is never repaired, approved, resolved, or merged.
import { bumpKind } from "../../review-gate/src/dependabot.mjs";

export const REPLACEMENT_PREFIX = "pr-repair/";
export const PROVENANCE_RE = /<!-- pr-repair:(\{[^\n]*?\}) -->/;

const BUMP_RE = /from `?v?([0-9][^\s`]*)`? to `?v?([0-9][^\s`]*)`?/gi;

export function ecosystemOf(branch) {
  const m = /^dependabot\/([a-z_]+)\//.exec(branch || "");
  return m ? m[1] : null;
}

// Reads only the title and Dependabot's own "Bumps ..."/"Updates ..." sentences;
// release notes quoted in the body are not evidence. Sentence punctuation after
// a version ("to 7.0.153.") is not part of it.
export function updateKind({ title = "", body = "" }) {
  const own = String(body).split("\n").slice(0, 200).filter((l) => /^\s*(?:[-*]\s*)?(?:Bumps|Updates)\b/.test(l));
  const text = [title, ...own].join("\n");
  const trim = (v) => v.replace(/[.,;:)\]]+$/, "");
  const kinds = [...text.matchAll(BUMP_RE)].map((m) => bumpKind(trim(m[1]), trim(m[2])));
  if (!kinds.length || kinds.includes("unknown")) return "unknown";
  return kinds.includes("major") ? "major" : "non-major";
}

const isSecurity = (body) => /This update includes (?:a security fix|security fixes)/i.test(body || "");

// pr: full pull request; commits: its commits; repo: "owner/name".
// trustedRefreshes: shas of the App's update-branch merges that soundRefreshes
// (repo.mjs) proved carry only the default branch and Dependabot's content.
export function originalEligibility(policy, pr, commits, repo, { trustedRefreshes = new Set() } = {}) {
  const no = (reason) => ({ eligible: false, reason });
  if (pr.state !== "open" || pr.draft) return no("not an open, ready pull request");
  if (!policy.eligibility.authors.includes(pr.user?.login) || pr.user?.type !== "Bot") return no("author is not an eligible bot");
  if (pr.head?.repo?.full_name !== repo || pr.base?.ref !== policy.defaultBranch) return no("not a same-repository pull request to the default branch");
  const eco = ecosystemOf(pr.head.ref);
  const allowed = eco && policy.eligibility.updates[eco];
  if (!allowed) return no(`ecosystem ${eco ?? "unknown"} is outside this repository's policy`);
  const kind = updateKind(pr);
  if (kind === "unknown") return no("could not read the requested version change");
  if (kind === "major" && allowed === "non-major" && !(policy.eligibility.securityMajors && isSecurity(pr.body))) {
    return no(`major ${eco} updates stay with a maintainer in this repository`);
  }
  if (pr.changed_files > policy.eligibility.maxChangedFiles) return no(`more than ${policy.eligibility.maxChangedFiles} changed files`);
  const foreign = commits.filter((c) => (!policy.eligibility.authors.includes(c.author?.login) && !trustedRefreshes.has(c.sha)) || c.commit?.verification?.verified !== true);
  if (foreign.length) return no("a commit is not a verified commit by the update bot");
  return { eligible: true, ecosystem: eco, kind };
}

export function parseProvenance(body) {
  const m = PROVENANCE_RE.exec(body || "");
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (!Number.isSafeInteger(p.root) || !/^[0-9a-f]{40}$/.test(p.rootHead)) return null;
    return p;
  } catch {
    return null;
  }
}

// A replacement is eligible only while it is the controller App's own pull
// request on its own branch and every commit after the original head is the
// App's (or the update bot's) verified commit.
export function replacementEligibility(policy, pr, commits, { botLogin, repo }) {
  const no = (reason) => ({ eligible: false, reason });
  const prov = parseProvenance(pr.body);
  if (pr.user?.login !== botLogin || !prov) return no("not a controller replacement");
  if (pr.head?.ref !== `${REPLACEMENT_PREFIX}${prov.root}` || pr.head?.repo?.full_name !== repo || pr.base?.ref !== policy.defaultBranch) return no("replacement branch or base is not the controller's");
  const trusted = new Set([botLogin, ...policy.eligibility.authors]);
  if (commits.some((c) => !trusted.has(c.author?.login) || c.commit?.verification?.verified !== true)) return no("someone else pushed to the replacement");
  return { eligible: true, provenance: prov };
}
