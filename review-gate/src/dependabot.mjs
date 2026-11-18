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
// Both sides must contain a hex letter so a plain number is never read as a
// digest. Only Docker branches qualify: a hash bump elsewhere (a submodule or a
// git dependency) can move any distance.
const DIGEST_RE = /from `?(?:sha256:)?([0-9a-f]{7,64})`? to `?(?:sha256:)?([0-9a-f]{7,64})`?(?![\w.-])/gi;
const isDigest = (h) => /^[0-9a-f]{7,64}$/i.test(h) && /[a-f]/i.test(h);
const DOCKER_BRANCH_RE = /^dependabot\/docker(?:_compose)?\//;

// Files whose only legitimate Dependabot change is a `uses:` pin bump.
const ACTION_FILE_RE = /^(\.github\/workflows\/[^/]+\.ya?ml|(?:[^/]+\/)*action\.ya?ml)$/;
// One changed line: `uses: owner/repo[/path]@<40-hex sha> # v1.2.3`. Group 2 is
// everything before the `@` (indentation, list dash, action name).
const USES_LINE_RE = /^([+-])(\s*(?:-\s+)?uses:\s+[\w.-]+\/[\w./-]+)@([0-9a-f]{40})(?:\s+#\s*v?([\w.+-]+))?\s*$/;

// null when `files` is not purely in-place `uses:` SHA-pin bumps; otherwise one
// bump kind per action. Each run of removed lines must be followed directly by
// the same number of added lines, and each pair must be the same line apart
// from the SHA and the version comment (same indentation, dash, and action),
// so no step can move, merge, or change action. Bump kinds come from the
// `# vX.Y.Z` comments ("unknown" when a side has none).
export function pinBumps(files) {
  if (!files.length || !files.every((f) => ACTION_FILE_RE.test(f.filename) && (f.status ?? "modified") === "modified")) return null;
  const kinds = [];
  for (const f of files) {
    if (typeof f.patch !== "string" || !f.patch) return null;
    let removed = [];
    let added = [];
    let pairs = 0;
    const flush = () => {
      if (removed.length !== added.length) return false;
      for (let i = 0; i < removed.length; i++) {
        const [r, a] = [removed[i], added[i]];
        if (r.prefix !== a.prefix || r.sha === a.sha) return false; // moved, re-indented, another action, or no real change
        kinds.push(r.version && a.version ? bumpKind(r.version, a.version) : "unknown");
      }
      pairs += removed.length;
      removed = [];
      added = [];
      return true;
    };
    for (const line of f.patch.split("\n")) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file" may sit between - and +
      if (line.startsWith("@@") || line.startsWith(" ") || line === "") {
        if (!flush()) return null;
        continue;
      }
      const m = USES_LINE_RE.exec(line);
      if (!m) return null;
      const entry = { prefix: m[2], sha: m[3], version: m[4] };
      if (m[1] === "-") {
        if (added.length) return null; // git lists a run's removals before its additions
        removed.push(entry);
      } else {
        if (!removed.length) return null; // an added line that replaces nothing
        added.push(entry);
      }
    }
    if (!flush() || !pairs) return null;
  }
  return kinds;
}

export function dependabotDecision({ title = "", body = "", labels = [], files = [], branch = "" }, policy) {
  if (labels.includes(policy.force_review_label)) return { pass: false, reason: "labelled for maintainer review" };
  const actionsBranch = branch.startsWith("dependabot/github_actions/");
  const dockerBranch = DOCKER_BRANCH_RE.test(branch);
  const pins = actionsBranch ? pinBumps(files) : null;
  if (!pins && files.some((f) => f.filename.startsWith(".github/") || (actionsBranch && ACTION_FILE_RE.test(f.filename)))) return { pass: false, reason: "changes .github/ (Actions or automation)" };
  const text = `${title}\n${body.split("\n").slice(0, 80).join("\n")}`;
  // Version changes named in the PR text. On Docker branches a digest pair is a
  // same-tag rebuild, not a version number that happens to start with a digit.
  const textBumps = () => {
    const out = [];
    for (const m of text.matchAll(BUMP_RE)) if (!(dockerBranch && isDigest(m[1]) && isDigest(m[2]))) out.push(bumpKind(m[1], m[2]));
    if (dockerBranch) for (const m of text.matchAll(DIGEST_RE)) if (isDigest(m[1]) && isDigest(m[2])) out.push("minor-or-patch");
    return out;
  };
  let bumps = pins ?? textBumps();
  if (pins?.includes("unknown")) {
    // A pin without a readable version comment: the PR text must account for
    // it, and every pin whose comments were readable still counts.
    const fromText = textBumps();
    if (!fromText.length || fromText.length < pins.length) return { pass: false, reason: "could not read the version change" };
    bumps = [...pins.filter((k) => k !== "unknown"), ...fromText];
  }
  if (!bumps.length) return { pass: false, reason: "could not read the version change" };
  if (bumps.includes("unknown")) return { pass: false, reason: "non-semver version change" };
  if (bumps.includes("major")) {
    // Only a fully readable in-place SHA pin on Dependabot's Actions branch.
    // An unknown pin, any other ecosystem, or allow_actions_major: false stays held.
    if (actionsBranch && pins && !pins.includes("unknown") && policy.allow_actions_major === true) {
      return { pass: true, reason: "major Actions pin update" };
    }
    return { pass: false, reason: "major version update" };
  }
  return { pass: true, reason: pins ? "patch or minor Actions pin update" : "patch or minor update" };
}
