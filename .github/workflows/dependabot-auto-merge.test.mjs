// Runs the auto-merge step from dependabot-auto-merge.yml against a fake `gh`.
// The decision must follow fetch-metadata: github_actions majors arm native
// auto-merge; every other ecosystem's semver-major stays labelled for a person.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflowPath = new URL("./dependabot-auto-merge.yml", import.meta.url);
const PR_URL = "https://github.com/NoahJenkins/.github/pull/99";

function workflow() {
  return readFileSync(workflowPath, "utf8");
}

function runScript() {
  const yml = workflow();
  const marker = "        run: |\n";
  const start = yml.indexOf(marker);
  assert.notEqual(start, -1, "auto-merge run script not found");
  const lines = [];
  for (const line of yml.slice(start + marker.length).split("\n")) {
    if (line === "") {
      lines.push("");
      continue;
    }
    if (!line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  assert.ok(lines.some((line) => line.startsWith("set -")), "run script was empty");
  return `${lines.join("\n")}\n`;
}

function decide({ updateType = "", ecosystem, omitEcosystem = false }) {
  const dir = mkdtempSync(join(tmpdir(), "dependabot-automerge-"));
  const log = join(dir, "gh.log");
  writeFileSync(join(dir, "gh"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const script = join(dir, "step.sh");
  writeFileSync(script, runScript());
  const env = {
    PATH: `${dir}:${process.env.PATH}`,
    GH_TOKEN: "test-token",
    GH_REPO: "NoahJenkins/.github",
    PR_URL,
    UPDATE_TYPE: updateType,
  };
  if (!omitEcosystem) env.ECOSYSTEM = ecosystem;
  let error = null;
  try {
    execFileSync("bash", [script], { env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    error = err;
  }
  let lines = [];
  try {
    lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    lines = [];
  }
  return { lines, error };
}

function armed(lines) {
  return lines.includes(`pr merge ${PR_URL} --auto --squash`);
}

function held(lines) {
  return lines.some((line) => line.startsWith(`pr edit ${PR_URL} --add-label dependency-major`)) && !armed(lines);
}

test("workflow reads fetch-metadata and merges only through native auto-merge", () => {
  const yml = workflow();
  assert.match(yml, /uses: dependabot\/fetch-metadata@/);
  assert.match(yml, /UPDATE_TYPE: \$\{\{ steps\.meta\.outputs\.update-type \}\}/);
  assert.match(yml, /ECOSYSTEM: \$\{\{ steps\.meta\.outputs\.package-ecosystem \}\}/);
  assert.match(yml, /gh pr merge "\$PR_URL" --auto --squash\n/);
  assert.doesNotMatch(yml, /--admin\b/);
  assert.doesNotMatch(yml, /actions\/checkout/);
});

test("github_actions semver-major arms squash auto-merge", () => {
  const { lines, error } = decide({ updateType: "version-update:semver-major", ecosystem: "github_actions" });
  assert.equal(error, null);
  assert.equal(armed(lines), true);
  assert.equal(lines.some((line) => line.includes("dependency-major")), false);
});

test("semver-major outside github_actions stays labelled for a person", () => {
  for (const ecosystem of ["npm_and_yarn", "docker", "pip", "gomod", "github-actions", ""]) {
    const { lines, error } = decide({ updateType: "version-update:semver-major", ecosystem });
    assert.equal(error, null, ecosystem || "(empty ecosystem)");
    assert.equal(held(lines), true, ecosystem || "(empty ecosystem)");
  }
});

test("a major with no ecosystem output is not merged", () => {
  const { lines } = decide({ updateType: "version-update:semver-major", omitEcosystem: true });
  assert.equal(armed(lines), false);
});

test("minor and patch updates still auto-merge in every ecosystem", () => {
  for (const ecosystem of ["github_actions", "npm_and_yarn", "docker", "pip"]) {
    for (const updateType of ["version-update:semver-minor", "version-update:semver-patch"]) {
      const { lines, error } = decide({ updateType, ecosystem });
      assert.equal(error, null, `${ecosystem} ${updateType}`);
      assert.equal(armed(lines), true, `${ecosystem} ${updateType}`);
    }
  }
});
