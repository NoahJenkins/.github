import { githubClient } from "./github.mjs";
import { CONTEXT, UNAVAILABLE, TIMING, runGate, setStatus } from "./gate.mjs";
import { runSweep } from "./sweep.mjs";

const env = process.env;
const log = (...a) => console.log(...a);
const dryRun = env.RG_DRY_RUN === "1";
const repo = env.GITHUB_REPOSITORY;
const token = env.RG_GITHUB_TOKEN;
if (!repo || !token) {
  console.error("GITHUB_REPOSITORY and github-token are required");
  process.exit(2);
}
const gh = githubClient(token, { dryRun, log });
const workflowRef = env.GITHUB_WORKFLOW_REF || "";

const ctx = {
  gh,
  triggerGh: env.RG_CODEX_TOKEN ? githubClient(env.RG_CODEX_TOKEN, { dryRun, log }) : gh,
  token,
  repo,
  owner: repo.split("/")[0],
  dryRun,
  log,
  gatewayKey: env.RG_GATEWAY_KEY || "",
  policyPath: env.RG_POLICY_PATH || ".github/review-policy.json",
  fallbackModel: env.RG_FALLBACK_MODEL || "anthropic/claude-sonnet-5.5",
  claudeVersion: env.RG_CLAUDE_VERSION || "2.1.316",
  runUrl: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,
  workflowFile: workflowRef.split("@")[0].split("/").pop() || "review-gate.yml",
};

async function gate() {
  const number = Number(env.RG_PR);
  if (!Number.isInteger(number) || number < 1) throw new Error("pr-number is required in gate mode");
  if (!env.RG_CODEX_TOKEN) log("note: no codex-trigger-token; posting @codex review as github-actions");
  // Final statuses go only to the commit this run evaluated, never to a newer head.
  const finish = async (message) => {
    if (!ctx.currentSha) return;
    const pr = await gh.get(`/repos/${repo}/pulls/${number}`);
    if (pr.state === "open" && !pr.draft && pr.head.sha === ctx.currentSha) {
      await setStatus(ctx, ctx.currentSha, "failure", `${UNAVAILABLE}: ${message}`);
    }
  };
  const deadline = setTimeout(async () => {
    try {
      await finish(`gate hit its ${TIMING.deadline / 60000} min deadline`);
    } finally {
      process.exit(1);
    }
  }, TIMING.deadline);
  try {
    await runGate(ctx, number);
  } catch (e) {
    console.error(e);
    // Never leave the head without a final status; the sweep retries this.
    try {
      await finish(e.message);
    } catch (inner) {
      console.error(`could not set ${CONTEXT} status:`, inner);
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

if (env.RG_MODE === "gate") await gate();
else if (env.RG_MODE === "sweep") await runSweep(ctx);
else {
  console.error(`unknown mode: ${env.RG_MODE}`);
  process.exit(2);
}
