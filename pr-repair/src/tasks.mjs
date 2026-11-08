// prepare, infer, validate, and publish modes. Each runs in its own job with
// only the credential it needs; artifacts between them are sealed and bound to
// one ledger reservation.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { matchesAny } from "../../review-gate/src/glob.mjs";
import { admit, validateProposalShape } from "./admission.mjs";
import { loadBundle, promptFor, validateReview, writeBundle } from "./bundle.mjs";
import { dockerFroms, isDockerfile, syncRuntimeFields } from "./contract.mjs";
import { NO_CHANGE } from "./decide.mjs";
import { SHA, digest, sanitizeLog, seal, verifySeal } from "./digest.mjs";
import { REPLACEMENT_PREFIX } from "./eligibility.mjs";
import { transition } from "./ledger.mjs";
import { changeSet, fieldFilesAt, fileAt, originalRequest, treeAt } from "./repo.mjs";
import { findStateIssue, loadLedger, saveLedger } from "./reconcile.mjs";
import { REVIEW_CHECK, failedJobIds } from "./signals.mjs";
import { runOpenAI, TransportError } from "./transport-openai.mjs";

export function checkTask(task, policy) {
  const keys = ["nonce", "kind", "root", "target", "head", "base", "rootHead", "policyDigest"];
  if (Object.keys(task ?? {}).some((k) => ![...keys, "feedback"].includes(k))) throw new Error("task has unexpected fields");
  if (!task || keys.some((k) => task[k] === undefined) || !["sync", "repair", "review"].includes(task.kind)) throw new Error("invalid task");
  if (![task.head, task.base, task.rootHead].every((s) => SHA.test(s)) || !/^[0-9a-f-]{36}$/.test(task.nonce)) throw new Error("invalid task identity");
  if (task.policyDigest !== digest(policy)) throw new Error("repository policy changed since this task was reserved");
  return task;
}

async function assertUnchanged(gh, repo, policy, task) {
  const pr = await gh.get(`/repos/${repo}/pulls/${task.target}`);
  const def = await gh.get(`/repos/${repo}/git/ref/heads/${policy.defaultBranch}`);
  if (pr.state !== "open" || pr.head.sha !== task.head) throw new Error(`#${task.target} head changed since the reservation`);
  if (def.object.sha !== task.base) throw new Error(`${policy.defaultBranch} moved since the reservation`);
  return pr;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));

// ---------- prepare (read-only token) ----------
export async function runPrepare(ctx, task, outDir) {
  const { gh, repo, policy } = ctx;
  checkTask(task, policy);
  await assertUnchanged(gh, repo, policy, task);
  const req = await originalRequest(gh, repo, policy, task.base, task.rootHead);
  const cs = await changeSet(gh, repo, task.base, task.head);
  const changed = cs.changes.map((c) => c.path);
  const base = {};
  const head = {};
  for (const c of cs.changes) {
    base[c.path] = (await fileAt(gh, repo, c.path, task.base)) ?? "";
    head[c.path] = c.after ?? "";
  }
  // Context is optional reading for the model: binary files (icons, images,
  // fonts) are skipped. Changed files are never skipped; they fail closed above.
  const BINARY = /\.(?:ico|png|jpe?g|gif|webp|avif|bmp|tiff?|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|br|wasm|mp[34]|mov|webm|wav|ogg|db|sqlite)$/i;
  const context = {};
  for (const e of (await treeAt(gh, repo, task.head)).filter((x) => matchesAny(x.path, policy.repair.context) && !matchesAny(x.path, policy.repair.protected) && !changed.includes(x.path) && !BINARY.test(x.path) && x.size <= 256 * 1024)) {
    if (Object.keys(context).length >= 48) break;
    try {
      context[e.path] = await fileAt(gh, repo, e.path, task.head);
    } catch (err) {
      if (!/is not UTF-8/.test(err.message)) throw err;
    }
  }
  const evidence = {};
  if (task.kind === "repair") {
    const checks = await gh.paginate(`/repos/${repo}/commits/${task.head}/check-runs?filter=latest`, { key: "check_runs" });
    for (const job of failedJobIds(checks, policy.ci.requiredChecks, policy.ci.checkAppId).slice(0, 4)) {
      try {
        evidence[`failed-${job.name.replace(/[^\w.-]+/g, "-")}.log`] = sanitizeLog(await gh.get(`/repos/${repo}/actions/jobs/${job.id}/logs`, { raw: true, maxBytes: 512 * 1024 }));
      } catch (e) {
        evidence[`failed-${job.name.replace(/[^\w.-]+/g, "-")}.log`] = `log unavailable (${e.status ?? "error"})`;
      }
    }
    const review = checks.filter((c) => c.name === REVIEW_CHECK && c.app?.id === ctx.appId).sort((a, b) => b.id - a.id)[0];
    if (review?.output?.text) evidence["independent-review.json"] = review.output.text.slice(0, 48000);
    if (policy.review.requireCodex) {
      const comments = await gh.paginate(`/repos/${repo}/pulls/${task.target}/comments`);
      const codex = comments.filter((c) => c.user?.login === "chatgpt-codex-connector[bot]" && c.commit_id === task.head).map((c) => `${c.path}:${c.line ?? c.original_line}\n${c.body}`);
      if (codex.length) evidence["codex-findings.txt"] = sanitizeLog(codex.join("\n\n---\n\n"));
    }
    if (task.feedback?.length) evidence["previous-attempts.json"] = JSON.stringify(task.feedback, null, 2);
  }
  mkdirSync(join(outDir, "data"), { recursive: true });
  const bundleDigest = writeBundle(join(outDir, "data"), { task, policy, changed, base, head, context, evidence, targets: req.targets, moves: req.moves });
  writeJson(join(outDir, "meta.json"), seal({ task, bundleDigest, changed }));
}

// ---------- infer (provider credential only; no GitHub access) ----------
export async function runInfer(ctx, task, dir) {
  const { policy, env } = ctx;
  checkTask(task, policy);
  const meta = verifySeal(readJson(join(dir, "meta.json")));
  if (digest(meta.task) !== digest(task)) throw new Error("input bundle belongs to another task");
  const files = loadBundle(join(dir, "data"));
  const inf = policy.inference;
  const prompt = promptFor(task.kind, task);
  const model = inf.model?.[task.kind];
  const record = (fields) => writeJson(join(dir, "proposal.json"), seal({ task, bundleDigest: meta.bundleDigest, transport: inf.transport, model, ...fields }));
  try {
    let out;
    if (inf.transport === "openai-compatible") {
      out = await runOpenAI({ endpoint: inf.endpoint, apiKey: env.PR_REPAIR_API_KEY, model, budget: inf.budget, kind: task.kind, prompt, files, fetcher: ctx.fetcher });
    } else throw new TransportError("configuration", "no inference transport configured");
    const result = task.kind === "review" ? validateReview(out.result, meta.changed).report : { files: validateProposalShape(out.result, policy.repair) };
    record({ usage: out.usage ?? null, result });
    return { usage: out.usage };
  } catch (e) {
    const category = e instanceof TransportError ? e.category : "invalid_output";
    record({ error: { category, message: String(e.message).slice(0, 300) } });
    throw e;
  }
}

// ---------- validate (no secrets; runs candidate code in containers) ----------
function walk(root, accept, prefix = "", out = new Map()) {
  for (const name of readdirSync(join(root, prefix))) {
    if (!prefix && name === ".git") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(join(root, rel));
    if (st.isDirectory() && name !== "node_modules") walk(root, accept, rel, out);
    else if (st.isFile() && accept(rel) && st.size <= 2 * 1024 * 1024) out.set(rel, readFileSync(join(root, rel), "utf8"));
  }
  return out;
}

export function resolveImage(policy, moves, headFiles) {
  const img = policy.validation.image;
  if (!img.startsWith("runtime:")) return img;
  const name = img.slice("runtime:".length);
  const runtime = policy.runtimes.find((r) => r.name === name);
  if (!runtime) throw new Error(`validation.image names unknown runtime ${name}`);
  const move = moves.find((m) => m.runtime === name);
  if (move) return move.to.ref;
  const refs = new Set();
  for (const [p, text] of headFiles) if (isDockerfile(p)) for (const f of dockerFroms(text)) if (f.image === runtime.image) refs.add(f.ref);
  if (refs.size !== 1) throw new Error(`cannot resolve one ${runtime.image} image for validation`);
  return [...refs][0];
}

export async function runValidate(ctx, task, { candidateRoot, proposalDir, outDir, validation }) {
  const { gh, repo, policy } = ctx;
  checkTask(task, policy);
  if (task.kind === "review") throw new Error("review tasks are not validated by execution");
  const headSha = execFileSync("git", ["-C", candidateRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (headSha !== task.head) throw new Error("candidate checkout is not the reserved head");
  await assertUnchanged(gh, repo, policy, task);
  const req = await originalRequest(gh, repo, policy, task.base, task.rootHead);
  const result = (fields) => {
    mkdirSync(outDir, { recursive: true });
    const sealed = seal({ task, proposalDigest: fields.proposalDigest ?? null, passed: false, results: [], reasons: [], files: [], ...fields });
    writeJson(join(outDir, "validated.json"), sealed);
    return sealed;
  };
  let proposal = [];
  let proposalDigest = null;
  if (task.kind === "repair") {
    const p = verifySeal(readJson(join(proposalDir, "proposal.json")));
    if (digest(p.task) !== digest(task)) throw new Error("proposal belongs to another task");
    proposalDigest = p.digest;
    if (p.error) return result({ proposalDigest, reasons: [`inference failed (${p.error.category})`] });
    proposal = validateProposalShape(p.result, policy.repair);
  }
  const globs = req.moves.flatMap((m) => policy.runtimes.find((r) => r.name === m.runtime).fields.flatMap((f) => f.files));
  const generatedPaths = policy.validation.lockfile ? [policy.validation.lockfile.path] : [];
  const interesting = new Set([...proposal.map((f) => f.path), ...req.targets.map((t) => t.path), ...generatedPaths]);
  const headFiles = walk(candidateRoot, (p) => interesting.has(p) || isDockerfile(p) || (globs.length && matchesAny(p, globs)));
  const fieldFiles = new Map([...headFiles].filter(([p]) => globs.length && matchesAny(p, globs)));
  const synced = syncRuntimeFields(policy, req.moves, fieldFiles).edits;
  const head = new Map([...interesting].map((p) => [p, headFiles.get(p) ?? null]));
  for (const [p, c] of headFiles) head.set(p, c);
  const first = admit({ policy, head, synced, proposal, generatedPaths, targets: req.targets, moves: req.moves, fieldFiles });
  if (!first.ok) return result({ proposalDigest, reasons: first.reasons });
  if (!first.files.length && task.kind === "repair") return result({ proposalDigest, reasons: [NO_CHANGE] });
  // A link in the candidate tree could redirect these writes; refuse it first.
  const { rejectLinks, writeCandidate } = await import("./validate.mjs");
  rejectLinks(candidateRoot);
  writeCandidate(candidateRoot, first.files);
  const image = resolveImage(policy, req.moves, headFiles);
  const run = (validation ?? (await import("./validate.mjs")).runValidation)({ root: candidateRoot, policy, image, log: ctx.log });
  const v = await run;
  const second = admit({ policy, head, synced, proposal, generated: v.generated, generatedPaths, targets: req.targets, moves: req.moves, fieldFiles });
  const passed = v.passed && second.ok;
  return result({ proposalDigest, passed, results: v.results, reasons: second.ok ? (v.passed ? [] : ["candidate checks failed"]) : second.reasons, files: passed ? second.files : [], image });
}

// ---------- publish (controller App token) ----------
function feedbackOf(validated) {
  const failing = (validated.results ?? []).filter((r) => !r.passed).map((r) => ({ step: r.name, output: (r.output ?? "").slice(-1500) }));
  return { reasons: (validated.reasons ?? []).slice(0, 10), failing: failing.slice(0, 3) };
}

export async function runPublish(ctx, task, { proposalDir, validatedDir }) {
  const { gh, repo, policy } = ctx;
  checkTask(task, policy);
  const issue = await findStateIssue(ctx);
  const state = await loadLedger(ctx, issue);
  const entry = state.ledger.entries.find((e) => e.nonce === task.nonce);
  if (!entry || entry.status !== "reserved" || entry.head !== task.head || entry.base !== task.base || entry.root !== task.root) throw new Error("no matching open reservation; nothing is published twice");
  const settle = async (status, fields) => saveLedger(ctx, issue, state, transition(state.ledger, task.nonce, status, fields));
  const failWith = async (note, feedback) => {
    await settle("failed", { note: String(note).slice(0, 300), ...(feedback ? { feedback } : {}) });
    ctx.log(`attempt ${task.nonce.slice(0, 8)} failed and stays consumed: ${note}`);
    return { published: false, note };
  };
  try {
    await assertUnchanged(gh, repo, policy, task);
  } catch (e) {
    return failWith(e.message);
  }

  if (task.kind === "review") {
    const p = existsSync(join(proposalDir, "proposal.json")) ? verifySeal(readJson(join(proposalDir, "proposal.json"))) : null;
    if (!p || digest(p.task) !== digest(task)) return failWith("no review output from the inference job");
    if (p.error) return failWith(`inference failed (${p.error.category})`);
    const cs = await changeSet(gh, repo, task.base, task.head, { withContent: () => false });
    let checked;
    try {
      checked = validateReview(p.result, cs.changes.map((c) => c.path));
    } catch (e) {
      return failWith(`invalid review: ${e.message}`);
    }
    await settle("publishing", {});
    const report = { nonce: task.nonce, head: task.head, base: task.base, verdict: checked.report.verdict, summary: checked.report.summary, findings: checked.report.findings, transport: p.transport, model: p.model };
    const run = await gh.post(`/repos/${repo}/check-runs`, {
      name: REVIEW_CHECK,
      head_sha: task.head,
      status: "completed",
      conclusion: checked.passed ? "success" : "failure",
      external_id: task.nonce,
      output: { title: checked.passed ? "Independent review passed" : "Independent review requires changes", summary: `${checked.report.summary}\n\nReviewed ${task.head.slice(0, 7)} against ${task.base.slice(0, 7)} with ${p.model}.`.slice(0, 4000), text: JSON.stringify(report).slice(0, 60000) },
    });
    if (!checked.passed) {
      const lines = checked.report.findings.map((f) => `- **${f.severity}** \`${f.file}\`: ${f.message}`);
      await gh.post(`/repos/${repo}/issues/${task.target}/comments`, { body: [`### pr-repair independent review: changes required on \`${task.head.slice(0, 7)}\``, "", checked.report.summary, "", ...lines, "", "<sub>Blocking findings re-enter bounded repair.</sub>"].join("\n").slice(0, 60000) });
    }
    await settle("published", { resultId: run.id ?? 0, verdict: checked.report.verdict });
    return { published: true, review: checked.report.verdict };
  }

  // sync / repair
  const vPath = join(validatedDir, "validated.json");
  if (!existsSync(vPath)) return failWith("no validation result");
  const validated = verifySeal(readJson(vPath));
  if (digest(validated.task) !== digest(task)) return failWith("validation result belongs to another task");
  if (task.kind === "repair") {
    const p = verifySeal(readJson(join(proposalDir, "proposal.json")));
    if (p.digest !== validated.proposalDigest) return failWith("validation did not check this proposal");
  }
  if (!validated.passed) return failWith("candidate validation failed", feedbackOf(validated));

  // Trusted re-admission against the authenticated head, independent of the validator job.
  const req = await originalRequest(gh, repo, policy, task.base, task.rootHead);
  const fieldFiles = await fieldFilesAt(gh, repo, policy, req.moves, task.head);
  const synced = syncRuntimeFields(policy, req.moves, fieldFiles).edits;
  const generatedPaths = policy.validation.lockfile ? [policy.validation.lockfile.path] : [];
  const head = new Map(fieldFiles);
  for (const p of new Set([...validated.files.map((f) => f.path), ...req.targets.map((t) => t.path)])) if (!head.has(p)) head.set(p, await fileAt(gh, repo, p, task.head));
  const generated = new Map(validated.files.filter((f) => generatedPaths.includes(f.path)).map((f) => [f.path, f.content]));
  const proposal = validated.files.filter((f) => !generatedPaths.includes(f.path) && synced.get(f.path) !== f.content);
  const again = admit({ policy, head, synced, proposal, generated, generatedPaths, targets: req.targets, moves: req.moves, fieldFiles });
  if (!again.ok || digest(again.files) !== digest(validated.files)) return failWith(`publisher re-admission failed: ${again.reasons.join("; ") || "file set differs from the validated candidate"}`);

  await settle("publishing", { intent: digest(validated.files) });
  try {
    await assertUnchanged(gh, repo, policy, task);
  } catch (e) {
    return failWith(e.message);
  }
  const branch = task.target === task.root ? `${REPLACEMENT_PREFIX}${task.root}` : (await gh.get(`/repos/${repo}/pulls/${task.target}`)).head.ref;
  if (task.target === task.root) {
    try {
      await gh.post(`/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: task.head });
    } catch (e) {
      if (e.status !== 422) throw e;
      const ref = await gh.get(`/repos/${repo}/git/ref/heads/${branch}`);
      if (ref.object.sha !== task.head) return failWith(`${branch} already exists at another commit`);
    }
  }
  const commit = await gh.graphql(
    "mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}",
    {
      input: {
        branch: { repositoryNameWithOwner: repo, branchName: branch },
        expectedHeadOid: task.head,
        message: { headline: `fix(deps): ${task.kind === "sync" ? "synchronize runtime contract" : "repair"} for #${task.root}`, body: `Validated by pr-repair in credential-free containers.\n\nPR-Repair-Nonce: ${task.nonce}` },
        fileChanges: { additions: validated.files.map((f) => ({ path: f.path, contents: Buffer.from(f.content).toString("base64") })) },
      },
    },
  );
  const sha = commit?.data?.createCommitOnBranch?.commit?.oid ?? (gh.dryRun ? "0".repeat(40) : null);
  if (!SHA.test(sha ?? "")) return failWith("the commit result could not be confirmed");
  let replacement = task.target === task.root ? null : task.target;
  if (!replacement) replacement = (await openReplacement(ctx, task, branch)).number;
  await settle("published", { resultSha: sha, replacement });
  return { published: true, sha, replacement };
}

export async function openReplacement(ctx, task, branch) {
  const { gh, repo, policy } = ctx;
  const o = await gh.get(`/repos/${repo}/pulls/${task.root}`);
  const prov = JSON.stringify({ root: task.root, rootHead: task.rootHead, nonce: task.nonce });
  const body = [
    `<!-- pr-repair:${prov} -->`,
    `Replaces #${task.root} (${o.title}) at \`${task.rootHead.slice(0, 7)}\` with validated repairs.`,
    "",
    "- Every requested dependency version and image is kept; the controller rejects any candidate that drops one.",
    "- Runtime fields declared in `.github/pr-repair.json` were synchronized by trusted code; model edits were limited to the policy's editable paths.",
    "- Candidate checks ran in disposable containers without credentials before this commit was published.",
    "- This pull request merges only after the required checks and an independent review pass on its exact head. The original closes after this merges.",
    "",
    "<sub>Opened by pr-repair. Pushes by anyone else remove its automatic merge eligibility.</sub>",
  ].join("\n");
  const pr = await gh.post(`/repos/${repo}/pulls`, { title: `${o.title} (repaired)`.slice(0, 250), head: branch, base: policy.defaultBranch, body, maintainer_can_modify: false });
  await gh.post(`/repos/${repo}/issues/${task.root}/comments`, { body: `pr-repair opened #${pr.number} with validated repairs for this update. This pull request stays open until that one merges.` });
  return pr;
}
