import { matchesAny } from "./glob.mjs";

export const DEFAULT_POLICY = Object.freeze({
  skip_paths: [
    "**/*.md",
    "**/*.mdx",
    "**/*.txt",
    "docs/**",
    "**/*.{png,jpg,jpeg,gif,svg,webp,ico}",
    "LICENSE",
    "**/.gitignore",
  ],
  always_review_paths: [
    ".github/workflows/**",
    ".github/review-policy.json",
    "**/AGENTS.md",
    "**/CLAUDE.md",
  ],
  small_change_lines: 15,
  force_review_label: "needs-review",
  max_rounds: 3,
});

// The policy file can only add to or tune the defaults; unknown keys are ignored.
export function resolvePolicy(raw) {
  const p = { ...DEFAULT_POLICY };
  if (!raw || typeof raw !== "object") return p;
  for (const key of ["skip_paths", "always_review_paths"]) {
    if (Array.isArray(raw[key]) && raw[key].every((g) => typeof g === "string")) p[key] = raw[key];
  }
  if (Array.isArray(raw.extra_always_review_paths)) {
    p.always_review_paths = [...p.always_review_paths, ...raw.extra_always_review_paths.filter((g) => typeof g === "string")];
  }
  if (Number.isInteger(raw.small_change_lines) && raw.small_change_lines >= 0) p.small_change_lines = raw.small_change_lines;
  if (typeof raw.force_review_label === "string" && raw.force_review_label) p.force_review_label = raw.force_review_label;
  if (Number.isInteger(raw.max_rounds) && raw.max_rounds >= 1) p.max_rounds = raw.max_rounds;
  // The policy file always protects itself.
  if (!p.always_review_paths.includes(".github/review-policy.json")) {
    p.always_review_paths = [...p.always_review_paths, ".github/review-policy.json"];
  }
  return p;
}

const paths = (f) => [f.filename, f.previous_filename].filter(Boolean);

// files: GitHub "list pull request files" entries.
export function classify(files, policy, { labels = [], truncated = false } = {}) {
  const risky = files.filter((f) => paths(f).some((p) => matchesAny(p, policy.always_review_paths)));
  if (risky.length) {
    const more = risky.length > 1 ? ` and ${risky.length - 1} more` : "";
    return { tier: "always", reason: `touches ${risky[0].filename}${more}`, riskyFiles: risky.map((f) => f.filename) };
  }
  if (truncated) {
    return { tier: "always", reason: "too many files to classify", riskyFiles: [] };
  }
  const code = files.filter((f) => !paths(f).every((p) => matchesAny(p, policy.skip_paths)));
  const lines = code.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
  if (labels.includes(policy.force_review_label)) {
    return { tier: "review", reason: `label ${policy.force_review_label}`, riskyFiles: [] };
  }
  if (code.length === 0) return { tier: "skip", reason: "docs or assets only", riskyFiles: [] };
  if (lines <= policy.small_change_lines) {
    return { tier: "skip", reason: `${lines} changed code lines (limit ${policy.small_change_lines})`, riskyFiles: [] };
  }
  return { tier: "review", reason: `${lines} changed code lines in ${code.length} files`, riskyFiles: [] };
}
