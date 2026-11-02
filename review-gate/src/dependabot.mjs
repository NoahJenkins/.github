// Decides Dependabot pull requests from their own text, not from labels that
// another workflow adds later. Anything it cannot read needs a maintainer.

const BUMP_RE = /from `?v?([0-9][^\s`]*)`? to `?v?([0-9][^\s`]*)`?/gi;

function numbers(version) {
  const core = version.split(/[-+_]/)[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split(".").map(Number);
}

// "major" when the first non-zero component changes (0.x minor bumps count as major).
export function bumpKind(from, to) {
  const a = numbers(from);
  const b = numbers(to);
  if (!a || !b) return "unknown";
  const i = a.findIndex((n) => n !== 0);
  const lead = i === -1 ? a.length - 1 : i;
  if ((b[lead] ?? 0) !== a[lead] || b.slice(0, lead).some((n, k) => n !== (a[k] ?? 0))) return "major";
  return "minor-or-patch";
}

export function dependabotDecision({ title = "", body = "", labels = [], files = [] }, policy) {
  if (labels.includes(policy.force_review_label)) return { pass: false, reason: "labelled for maintainer review" };
  if (files.some((f) => f.filename.startsWith(".github/"))) return { pass: false, reason: "changes .github/ (Actions or automation)" };
  const text = `${title}\n${body.split("\n").slice(0, 80).join("\n")}`;
  const bumps = [...text.matchAll(BUMP_RE)].map((m) => bumpKind(m[1], m[2]));
  if (!bumps.length) return { pass: false, reason: "could not read the version change" };
  if (bumps.includes("unknown")) return { pass: false, reason: "non-semver version change" };
  if (bumps.includes("major")) return { pass: false, reason: "major version update" };
  return { pass: true, reason: "patch or minor update" };
}
