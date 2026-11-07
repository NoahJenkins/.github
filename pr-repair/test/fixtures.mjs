import { parsePolicy } from "../src/policy.mjs";

export const BUN_OLD = "oven/bun:1.4.0-slim@sha256:" + "a".repeat(64);
export const BUN_NEW = "oven/bun:1.4.4-slim@sha256:" + "b".repeat(64);
export const NODE_OLD = "node:24-bookworm-slim@sha256:" + "c".repeat(64);
export const NODE_NEW = "node:25-bookworm-slim@sha256:" + "d".repeat(64);

// A Metriks-shaped policy: Docker majors allowed, runtime fields declared.
export const rawPolicy = () => ({
  version: 1,
  ci: { requiredChecks: ["verify", "runtime-packaging", "browser e2e"] },
  eligibility: { updates: { npm_and_yarn: "all", docker: "all", github_actions: "all" } },
  repair: { editable: ["apps/*/src/**", "packages/shared/src/**", "apps/api/Dockerfile", "apps/api/Dockerfile.node", "**/package.json"] },
  runtimes: [
    {
      name: "bun",
      image: "oven/bun",
      versionPattern: "^(?<version>\\d+\\.\\d+\\.\\d+)",
      fields: [
        { files: ["scripts/ops/smoke-api-docker.sh"], template: "'{version}'" },
        { files: ["scripts/safety/*.sh"], template: "{imageRef}" },
        { files: ["AGENTS.md", "README.md", "docs/*.md", "scripts/ops/smoke-api-docker.sh"], template: "Bun {version}", optional: true },
      ],
    },
    {
      name: "node",
      image: "node",
      versionPattern: "^(?<version>\\d+)",
      fields: [
        { files: ["apps/api/Dockerfile", "apps/api/Dockerfile.node"], template: "{imageRef}" },
        { files: ["scripts/safety/*.sh"], template: "{imageRef}", optional: true },
        { files: ["**/package.json"], template: '"node": "{major}.x"' },
        { files: [".github/workflows/*.yml"], template: "node-version: {major}" },
        { files: ["AGENTS.md", "README.md", "docs/*.md"], template: "Node {major}", optional: true },
      ],
    },
  ],
  validation: { image: "runtime:node", setup: "npm install --global pnpm@11.15.1", lockfile: { path: "pnpm-lock.yaml", command: "pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile" }, install: "pnpm install --frozen-lockfile", commands: ["pnpm typecheck", "pnpm test"] },
  inference: { transport: "copilot-cli", model: "gpt-6-luna", copilot: { version: "1.0.103", sha256: "9".repeat(64), image: "node:24-bookworm-slim@sha256:" + "e".repeat(64) }, budget: { maxCalls: { repair: 24, review: 16 }, maxOutputTokens: 32000 } },
  review: { requireCodex: true, agentLogins: ["chatgpt-codex-connector[bot]"] },
  merge: { originals: true, approve: "approver-token", production: { kind: "workflow-run", workflow: "deploy-production.yml" } },
});

export const policy = (patch = (p) => p) => parsePolicy(patch(rawPolicy()));

export const dockerfile = (build, runtime) => `FROM ${build} AS build\nWORKDIR /workspace\nRUN corepack enable\nFROM ${runtime} AS runtime\nCMD ["bun","dist/index.js"]\n`;

// A small Metriks-like tree at rest on Node 24 + Bun 1.4.0.
export function tree({ node = NODE_OLD, bun = BUN_OLD } = {}) {
  const nodeMajor = node.match(/node:(\d+)/)[1];
  const bunVersion = bun.match(/bun:([\d.]+)/)[1];
  return new Map([
    ["apps/api/Dockerfile", dockerfile(node, bun)],
    ["apps/api/Dockerfile.node", `FROM ${node} AS build\nRUN corepack enable\nFROM ${node} AS runtime\n`],
    ["scripts/ops/smoke-api-docker.sh", `[[ "\${bun_version}" == '${bunVersion}' ]] || fail "expected Bun ${bunVersion}"\n`],
    ["scripts/safety/test-runtime-contract.sh", `expected_bun_image='${bun}'\nexpected_node_image='${node}'\n`],
    ["package.json", JSON.stringify({ name: "root", engines: { node: `${nodeMajor}.x` }, devDependencies: { typescript: "5.9.3" } }, null, 2)],
    ["apps/api/package.json", JSON.stringify({ name: "api", engines: { node: `${nodeMajor}.x` }, dependencies: { hono: "4.9.0" } }, null, 2)],
    [".github/workflows/pr-checks.yml", `jobs:\n  verify:\n    steps:\n      - uses: actions/setup-node@${"f".repeat(40)}\n        with:\n          node-version: ${nodeMajor}\n`],
    ["AGENTS.md", `The production API runtime is Bun ${bunVersion}. Node ${nodeMajor} remains required. Image tool has Node ${nodeMajor}.19.0.\n`],
  ]);
}
