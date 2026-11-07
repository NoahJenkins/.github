// Repository policy for pr-repair. It is read from the default branch only, so a
// pull request can never widen its own scope, budget, model, or merge path.

export const POLICY_PATH = ".github/pr-repair.json";

// Paths a model may never edit. Trusted runtime-contract sync and lockfile
// regeneration are the only writers allowed here.
export const ALWAYS_PROTECTED = [
  ".github/**",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.claude/**",
  "**/.mcp.json",
  "**/.npmrc",
  "**/.pnpmfile.cjs",
  "**/.yarnrc*",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/migrations/**",
  "**/__tests__/**",
  "**/__snapshots__/**",
  "**/test/**",
  "**/tests/**",
  "**/e2e/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.go",
  "**/testdata/**",
  "scripts/safety/**",
];

const ECOSYSTEMS = ["npm_and_yarn", "docker", "github_actions", "go_modules", "pip", "bundler", "cargo", "composer", "gradle", "maven", "nuget", "terraform"];
const TRANSPORTS = ["openai-compatible"];
const MODEL_ID = /^[\w./:-]{1,120}$/;
const PRODUCTION_KINDS = ["none", "deployments", "workflow-run"];
const APPROVALS = ["none", "app", "approver-token"];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0 && s.length < 300);
const posInt = (v, max = 1e6) => Number.isSafeInteger(v) && v >= 1 && v <= max;
const digestPinned = (image) => typeof image === "string" && /^[a-z0-9._/-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/.test(image);

function fail(errors) {
  const err = new Error(`invalid ${POLICY_PATH}: ${errors.join("; ")}`);
  err.errors = errors;
  throw err;
}

function only(obj, keys, where, errors) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${where}.${k} is not a known key`);
}

// Returns a normalized, frozen policy or throws with every problem found.
export function parsePolicy(raw) {
  const e = [];
  if (!isObj(raw)) fail(["policy must be a JSON object"]);
  only(raw, ["version", "defaultBranch", "ci", "eligibility", "repair", "runtimes", "validation", "inference", "review", "merge", "legacy"], "policy", e);
  if (raw.version !== 1) e.push("version must be 1");

  const ci = raw.ci ?? {};
  if (!isObj(ci) || !strings(ci.requiredChecks) || !ci.requiredChecks.length) e.push("ci.requiredChecks must list the required check names");
  if (isObj(ci)) only(ci, ["requiredChecks", "checkAppId"], "ci", e);

  const el = raw.eligibility ?? {};
  if (isObj(el)) only(el, ["authors", "updates", "securityMajors", "maxChangedFiles"], "eligibility", e);
  const updates = el.updates ?? {};
  if (!isObj(updates) || !Object.keys(updates).length) e.push("eligibility.updates must map ecosystems to all|non-major");
  for (const [eco, kind] of Object.entries(isObj(updates) ? updates : {})) {
    if (!ECOSYSTEMS.includes(eco)) e.push(`eligibility.updates.${eco} is not a Dependabot ecosystem`);
    if (!["all", "non-major"].includes(kind)) e.push(`eligibility.updates.${eco} must be all or non-major`);
  }
  if (el.authors !== undefined && (!strings(el.authors) || el.authors.some((a) => !a.endsWith("[bot]")))) {
    e.push("eligibility.authors may list only bot accounts; human pull requests are never eligible");
  }

  const rp = raw.repair ?? {};
  if (isObj(rp)) only(rp, ["editable", "protected", "context", "maxFiles", "maxBytes", "limits"], "repair", e);
  if (!strings(rp.editable ?? [])) e.push("repair.editable must be path globs");
  const limits = { repairPerPr: 2, reviewPerPr: 4, syncPerHead: 1, dailyModelTasks: 6, ...(rp.limits ?? {}) };
  for (const [k, v] of Object.entries(limits)) {
    if (!["repairPerPr", "reviewPerPr", "syncPerHead", "dailyModelTasks"].includes(k)) e.push(`repair.limits.${k} is not a known limit`);
    else if (!posInt(v, 50)) e.push(`repair.limits.${k} must be an integer from 1 to 50`);
  }

  const runtimes = raw.runtimes ?? [];
  if (!Array.isArray(runtimes)) e.push("runtimes must be an array");
  for (const [i, r] of (Array.isArray(runtimes) ? runtimes : []).entries()) {
    const at = `runtimes[${i}]`;
    if (!isObj(r)) { e.push(`${at} must be an object`); continue; }
    only(r, ["name", "image", "versionPattern", "fields"], at, e);
    if (typeof r.name !== "string" || !/^[a-z0-9-]+$/.test(r.name)) e.push(`${at}.name must be a lowercase identifier`);
    if (typeof r.image !== "string" || !/^[a-z0-9._/-]+$/.test(r.image)) e.push(`${at}.image must be a Docker image name without a tag`);
    try {
      const re = new RegExp(r.versionPattern);
      if (!r.versionPattern.includes("(?<version>")) e.push(`${at}.versionPattern needs a named group "version"`);
      void re;
    } catch {
      e.push(`${at}.versionPattern is not a regular expression`);
    }
    if (!Array.isArray(r.fields) || !r.fields.length) e.push(`${at}.fields must list the synchronized fields`);
    for (const [j, f] of (Array.isArray(r.fields) ? r.fields : []).entries()) {
      if (!isObj(f) || !strings(f.files) || typeof f.template !== "string" || !/\{(major|minor|version|tag|imageRef)\}/.test(f.template)) {
        e.push(`${at}.fields[${j}] needs files and a template with {major}, {minor}, {version}, {tag}, or {imageRef}`);
      } else {
        only(f, ["files", "template", "optional", "escape"], `${at}.fields[${j}]`, e);
        if (f.escape !== undefined && f.escape !== "regex") e.push(`${at}.fields[${j}].escape must be "regex"`);
      }
    }
  }

  const v = raw.validation ?? {};
  if (isObj(v)) only(v, ["image", "setup", "install", "lockfile", "commands", "dockerBuilds", "timeoutMinutes", "memory", "cpus", "env"], "validation", e);
  if (!(digestPinned(v.image) || (typeof v.image === "string" && /^runtime:[a-z0-9-]+$/.test(v.image)))) {
    e.push("validation.image must be a digest-pinned image or runtime:<name>");
  }
  if (!strings(v.commands) || !v.commands.length) e.push("validation.commands must list the candidate checks");
  if (v.lockfile !== undefined && (!isObj(v.lockfile) || typeof v.lockfile.path !== "string" || typeof v.lockfile.command !== "string")) {
    e.push("validation.lockfile needs path and command");
  }
  for (const [i, b] of (v.dockerBuilds ?? []).entries()) {
    if (!isObj(b) || typeof b.file !== "string" || typeof (b.context ?? ".") !== "string") e.push(`validation.dockerBuilds[${i}] needs file and context`);
  }
  if (v.env !== undefined && (!isObj(v.env) || Object.entries(v.env).some(([k, val]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof val !== "string" || /TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL/i.test(k)))) {
    e.push("validation.env may hold only plain, non-credential variables");
  }

  const inf = raw.inference ?? {};
  if (isObj(inf)) only(inf, ["transport", "model", "endpoint", "budget"], "inference", e);
  if (inf.transport != null && !TRANSPORTS.includes(inf.transport)) e.push(`inference.transport must be one of ${TRANSPORTS.join(", ")} or null`);
  // One model for both kinds, or {repair, review} so a different model family reviews each repair.
  if (inf.model != null && !(typeof inf.model === "string" && MODEL_ID.test(inf.model)) && !(isObj(inf.model) && Object.keys(inf.model).sort().join() === "repair,review" && Object.values(inf.model).every((m) => typeof m === "string" && MODEL_ID.test(m)))) {
    e.push("inference.model must be a model id, {repair, review} model ids, or null");
  }
  if (inf.transport === "openai-compatible" && inf.endpoint != null && !/^https:\/\/[a-z0-9.-]+(?::\d+)?(\/[\w./-]*)?$/.test(inf.endpoint)) {
    e.push("inference.endpoint must be an https base URL");
  }
  if (inf.budget != null) {
    const b = inf.budget;
    if (!isObj(b) || !isObj(b.maxCalls) || !posInt(b.maxCalls.repair, 64) || !posInt(b.maxCalls.review, 64) || !posInt(b.maxOutputTokens, 200000)) {
      e.push("inference.budget needs maxCalls.repair, maxCalls.review, and maxOutputTokens");
    }
    if (b?.maxAiCredits !== undefined && !posInt(b.maxAiCredits, 1000)) e.push("inference.budget.maxAiCredits must be a positive integer");
  }

  const rv = raw.review ?? {};
  if (isObj(rv)) only(rv, ["requireCodex", "agentLogins", "originals"], "review", e);
  if (rv.agentLogins !== undefined && (!strings(rv.agentLogins) || rv.agentLogins.some((a) => !a.endsWith("[bot]")))) {
    e.push("review.agentLogins may list only bot accounts; human threads are never resolved automatically");
  }

  const m = raw.merge ?? {};
  if (isObj(m)) only(m, ["originals", "approve", "closeOriginal", "production", "pauseBranches"], "merge", e);
  if (m.approve !== undefined && !APPROVALS.includes(m.approve)) e.push(`merge.approve must be one of ${APPROVALS.join(", ")}`);
  const prod = m.production ?? { kind: "none" };
  if (!isObj(prod) || !PRODUCTION_KINDS.includes(prod.kind)) e.push(`merge.production.kind must be one of ${PRODUCTION_KINDS.join(", ")}`);
  else if (prod.kind === "deployments" && (typeof prod.environment !== "string" || !posInt(prod.creatorId ?? 1, Number.MAX_SAFE_INTEGER))) e.push("merge.production deployments needs environment and an optional numeric creatorId");
  else if (prod.kind === "workflow-run" && typeof prod.workflow !== "string") e.push("merge.production workflow-run needs workflow");

  const lg = raw.legacy ?? {};
  if (isObj(lg)) only(lg, ["attemptChecks"], "legacy", e);
  for (const [i, c] of (lg.attemptChecks ?? []).entries()) {
    if (!isObj(c) || typeof c.name !== "string" || !posInt(c.appId, 1e10)) e.push(`legacy.attemptChecks[${i}] needs name and appId`);
  }

  if (e.length) fail(e);

  return Object.freeze({
    version: 1,
    defaultBranch: raw.defaultBranch ?? "main",
    ci: { requiredChecks: [...ci.requiredChecks], checkAppId: ci.checkAppId ?? 15368 },
    eligibility: {
      authors: el.authors ?? ["dependabot[bot]"],
      updates: { ...updates },
      securityMajors: el.securityMajors === true,
      maxChangedFiles: el.maxChangedFiles ?? 64,
    },
    repair: {
      editable: rp.editable ?? [],
      protected: [...ALWAYS_PROTECTED, ...(rp.protected ?? [])],
      context: rp.context ?? rp.editable ?? [],
      maxFiles: rp.maxFiles ?? 24,
      maxBytes: rp.maxBytes ?? 256 * 1024,
      limits,
    },
    runtimes: runtimes.map((r) => ({ ...r, fields: r.fields.map((f) => ({ optional: false, ...f })) })),
    validation: { timeoutMinutes: 20, memory: "6g", cpus: 2, setup: "", install: "", dockerBuilds: [], env: {}, ...v },
    inference: {
      transport: inf.transport ?? null,
      model: inf.model == null ? null : typeof inf.model === "string" ? { repair: inf.model, review: inf.model } : { ...inf.model },
      endpoint: inf.endpoint ?? null,
      budget: inf.budget ?? null,
    },
    review: { requireCodex: rv.requireCodex === true, agentLogins: rv.agentLogins ?? [], originals: rv.originals === true },
    merge: {
      originals: m.originals === true,
      approve: m.approve ?? "none",
      closeOriginal: m.closeOriginal !== false,
      production: prod,
      pauseBranches: m.pauseBranches ?? [],
    },
    legacy: { attemptChecks: lg.attemptChecks ?? [] },
  });
}

// Paid work needs every one of these. A missing value pauses work before any
// attempt is reserved; nothing here is ever defaulted to a model or provider.
export function inferenceGaps(policy, { credentialReady }) {
  const gaps = [];
  const inf = policy.inference;
  if (!inf.transport) gaps.push("inference.transport is not set");
  if (!inf.model) gaps.push("inference.model is not set");
  if (!inf.budget) gaps.push("inference.budget is not set");
  if (inf.transport === "openai-compatible" && !inf.endpoint) gaps.push("inference.endpoint is not set");
  if (!credentialReady) gaps.push("the inference credential is not available to the inference job");
  return gaps;
}
