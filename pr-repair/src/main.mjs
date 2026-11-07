// Entry point for the pr-repair composite action. One mode per job; each job
// receives only the credential its mode needs.
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { conclusionFor } from "./decide.mjs";
import { digest } from "./digest.mjs";
import { githubClient } from "./github.mjs";
import { POLICY_PATH, parsePolicy } from "./policy.mjs";
import { fileAt } from "./repo.mjs";
import { runPlan } from "./reconcile.mjs";
import { runInfer, runPrepare, runPublish, runValidate } from "./tasks.mjs";
import { selftest } from "./selftest.mjs";

const env = process.env;
const log = (...a) => console.log(...a);
const mode = env.PR_REPAIR_MODE;
const repo = env.GITHUB_REPOSITORY;
const dir = env.PR_REPAIR_DIR || join(env.RUNNER_TEMP || "/tmp", "pr-repair");
const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
const output = (fields) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}\n`).join(""));
const summary = (text) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);

async function policyAt(gh, ref) {
  const text = await fileAt(gh, repo, POLICY_PATH, ref);
  if (text === null) throw new Error(`${POLICY_PATH} is missing on the default branch`);
  return parsePolicy(JSON.parse(text));
}

async function identity(gh) {
  const slug = env.PR_REPAIR_APP_SLUG || "";
  const appId = Number(env.PR_REPAIR_APP_ID);
  if (!/^[a-z0-9-]+$/.test(slug) || !Number.isSafeInteger(appId) || appId < 1) throw new Error("the controller App id and slug are required");
  const bot = await gh.get(`/users/${slug}%5Bbot%5D`);
  if (bot.type !== "Bot") throw new Error("the controller App bot account was not found");
  return { appId, botId: bot.id, botLogin: `${slug}[bot]` };
}

const task = () => JSON.parse(env.PR_REPAIR_TASK || "null");

async function main() {
  if (mode === "selftest") return selftest({ root: env.PR_REPAIR_ROOT || process.cwd(), log });
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");

  if (mode === "infer") {
    const policy = parsePolicy(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")));
    const t = task();
    const r = await runInfer({ policy, env, log }, t, dir);
    summary(`pr-repair ${t.kind} for #${t.target}: model output recorded${r.usage ? ` (${JSON.stringify(r.usage)})` : ""}.`);
    return;
  }

  const gh = githubClient(env.PR_REPAIR_TOKEN, { dryRun: env.PR_REPAIR_DRY_RUN === "1", log });

  if (mode === "plan") {
    const ids = await identity(gh);
    const def = (await gh.get(`/repos/${repo}`)).default_branch;
    const head = (await gh.get(`/repos/${repo}/git/ref/heads/${def}`)).object.sha;
    // A local policy is accepted only for read-only dry runs, never for writes.
    const policy = gh.dryRun && env.PR_REPAIR_POLICY_FILE ? parsePolicy(JSON.parse(readFileSync(env.PR_REPAIR_POLICY_FILE, "utf8"))) : await policyAt(gh, head);
    const ctx = {
      gh,
      approverGh: env.PR_REPAIR_APPROVER_TOKEN ? githubClient(env.PR_REPAIR_APPROVER_TOKEN, { dryRun: gh.dryRun, log }) : null,
      repo,
      policy,
      ...ids,
      enabled: env.PR_REPAIR_ENABLED === "true",
      credentialReady: env.PR_REPAIR_CREDENTIAL_READY === "true",
      exclusiveActive: env.PR_REPAIR_EXCLUSIVE_ACTIVE === "true",
      exclusiveWorkflows: (env.PR_REPAIR_EXCLUSIVE_WORKFLOWS || "").split(",").map((w) => w.trim()).filter((w) => /^[\w.-]+\.ya?ml$/.test(w)),
      now: new Date().toISOString(),
      runUrl,
      log,
    };
    const { tasks, rows, gaps, production } = await runPlan(ctx);
    output({ tasks, has_tasks: tasks.length > 0 ? "true" : "false" });
    summary(`## pr-repair\n\nEnabled: ${ctx.enabled}. Production: ${production.healthy ? "healthy" : production.reason}.${gaps.length ? ` Paid work paused: ${gaps.join("; ")}.` : ""}\n`);
    summary(["| Update | Working PR | State | Detail |", "| --- | --- | --- | --- |", ...rows.map((r) => `| #${r.number} | #${r.target} | ${r.state} | ${String(r.detail).replace(/\|/g, "\\|")} |`)].join("\n"));
    for (const r of rows) if (conclusionFor(r.state) === "action_required") console.log(`::warning title=pr-repair #${r.number}::${r.state}: ${String(r.detail).replace(/\n/g, " ")}`);
    summary(`\nReserved tasks: ${tasks.map((t) => `${t.kind} #${t.target}`).join(", ") || "none"}.`);
    if (ctx.failed) throw new Error("one or more pull requests could not be evaluated; see the log and dashboard");
    return;
  }

  const t = task();
  const policy = await policyAt(gh, t.base);
  if (digest(policy) !== t.policyDigest) throw new Error("repository policy changed since the reservation");
  if (mode === "prepare") {
    const ids = { appId: Number(env.PR_REPAIR_APP_ID) || 0 };
    await runPrepare({ gh, repo, policy, log, ...ids }, t, dir);
    writeFileSync(join(dir, "policy.json"), JSON.stringify(JSON.parse(await fileAt(gh, repo, POLICY_PATH, t.base))));
    return;
  }
  if (mode === "validate") {
    const out = join(dir, "validated");
    mkdirSync(out, { recursive: true });
    const r = await runValidate({ gh, repo, policy, log }, t, { candidateRoot: env.PR_REPAIR_CANDIDATE, proposalDir: dir, outDir: out });
    summary(`pr-repair validation for #${t.target}: ${r.passed ? "passed" : `failed: ${(r.reasons ?? []).join("; ")}`}`);
    return;
  }
  if (mode === "publish") {
    const ids = await identity(gh);
    const r = await runPublish({ gh, repo, policy, log, ...ids, runUrl }, t, { proposalDir: dir, validatedDir: join(dir, "validated") });
    summary(`pr-repair ${t.kind} for #${t.target}: ${r.published ? `published${r.replacement ? ` to #${r.replacement}` : ""}` : `not published: ${r.note}`}`);
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((e) => {
  console.error(`pr-repair ${mode}: ${e.message}`);
  process.exitCode = 1;
});
