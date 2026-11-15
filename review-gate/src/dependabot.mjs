// Decides Dependabot pull requests from their own text, not from labels that
// another workflow adds later. Anything it cannot read needs a maintainer.

const BUMP_RE = /from `?v?([0-9][^\s`]*)`? to `?v?([0-9][^\s`]*)`?/gi;

function numbers(version) {
  // PEP 440 post and dev releases (1.4.1.post1) are the release they follow.
  const core = version.replace(/\.(post|dev)\d+$/i, "").split(/[-+_]/)[0];
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

// A container digest moved under an unchanged tag: "from `e697c81` to `935c3c5`".
// Both sides must contain a hex letter so a plain number is never read as a digest.
const DIGEST_RE = /from `?(?:sha256:)?([0-9a-f]{7,64})`? to `?(?:sha256:)?([0-9a-f]{7,64})`?/gi;
const isDigest = (h) => /[a-f]/i.test(h);

// Files whose only legitimate Dependabot change is a `uses:` pin bump.
const ACTION_FILE_RE = /^(\.github\/workflows\/[^/]+\.ya?ml|(?:[^/]+\/)*action\.ya?ml)$/;
// One changed line: `uses: owner/repo[/path]@<40-hex sha> # v1.2.3`.
const USES_LINE_RE = /^[+-]\s*(?:-\s+)?uses:\s+([\w.-]+\/[\w./-]+)@([0-9a-f]{40})(?:\s+#\s*v?([\w.+-]+))?\s*$/;

// null when `files` is not purely `uses:` SHA-pin bumps; otherwise one bump
// kind per action. The bump kinds come from the `# vX.Y.Z` comments in the diff.
export function pinBumps(files) {
  if (!files.length || !files.every((f) => ACTION_FILE_RE.test(f.filename) && (f.status ?? "modified") === "modified")) return null;
  const kinds = [];
  for (const f of files) {
    if (typeof f.patch !== "string" || !f.patch) return null;
    const removed = [];
    const added = [];
    for (const line of f.patch.split("\n")) {
      if (line.startsWith("@@") || line.startsWith(" ") || line === "" || line.startsWith("\\")) continue;
      const m = USES_LINE_RE.exec(line);
      if (!m) return null;
      (line[0] === "-" ? removed : added).push({ name: m[1], sha: m[2], version: m[3] });
    }
    if (!removed.length || removed.length !== added.length) return null;
    const pending = new Map();
    for (const r of removed) pending.set(r.name, [...(pending.get(r.name) ?? []), r]);
    for (const a of added) {
      const r = pending.get(a.name)?.shift();
      if (!r || r.sha === a.sha) return null; // a different action, or no real change
      kinds.push(r.version && a.version ? bumpKind(r.version, a.version) : "unknown");
    }
  }
  return kinds;
}

export function dependabotDecision({ title = "", body = "", labels = [], files = [], branch = "" }, policy) {
  if (labels.includes(policy.force_review_label)) return { pass: false, reason: "labelled for maintainer review" };
  const actionsBranch = branch.startsWith("dependabot/github_actions/");
  const pins = actionsBranch ? pinBumps(files) : null;
  if (!pins && files.some((f) => f.filename.startsWith(".github/") || (actionsBranch && ACTION_FILE_RE.test(f.filename)))) return { pass: false, reason: "changes .github/ (Actions or automation)" };
  const text = `${title}\n${body.split("\n").slice(0, 80).join("\n")}`;
  let bumps = pins ?? [];
  if (!pins) {
    bumps = [...text.matchAll(BUMP_RE)].map((m) => bumpKind(m[1], m[2]));
    for (const m of text.matchAll(DIGEST_RE)) if (isDigest(m[1]) && isDigest(m[2])) bumps.push("minor-or-patch");
  } else if (pins.includes("unknown")) {
    // A pin without a readable version comment: fall back to the PR text.
    bumps = [...text.matchAll(BUMP_RE)].map((m) => bumpKind(m[1], m[2]));
    if (!bumps.length || bumps.length < pins.length) return { pass: false, reason: "could not read the version change" };
  }
  if (!bumps.length) return { pass: false, reason: "could not read the version change" };
  if (bumps.includes("unknown")) return { pass: false, reason: "non-semver version change" };
  if (bumps.includes("major")) return { pass: false, reason: "major version update" };
  return { pass: true, reason: pins ? "patch or minor Actions pin update" : "patch or minor update" };
}
