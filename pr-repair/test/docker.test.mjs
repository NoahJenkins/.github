// Real containers. Opt in with PR_REPAIR_DOCKER_TESTS=1 (needs a Docker daemon).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidation } from "../src/validate.mjs";
import { policy } from "./fixtures.mjs";

const IMAGE = "node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";
const enabled = process.env.PR_REPAIR_DOCKER_TESTS === "1";

function candidate() {
  const dir = mkdtempSync(join(tmpdir(), "pr-repair-docker-"));
  writeFileSync(join(dir, "package.json"), '{"name":"c"}');
  return dir;
}

test("candidate checks see no credential, no network, no Docker socket, and run unprivileged", { skip: !enabled }, () => {
  const dir = candidate();
  process.env.GITHUB_TOKEN = "ghs_should_never_reach_a_candidate";
  try {
    const p = policy((r) => ({ ...r, validation: { image: IMAGE, commands: [
      'test -z "${GITHUB_TOKEN:-}${ACTIONS_RUNTIME_TOKEN:-}${PR_REPAIR_API_KEY:-}"',
      'test "$(id -u)" = 1000',
      "test ! -e /var/run/docker.sock",
      "node -e \"require('https').get('https://registry.npmjs.org',()=>process.exit(1)).on('error',()=>process.exit(0))\"",
    ] } }));
    const r = runValidation({ root: dir, policy: p, image: IMAGE, log: () => {} });
    assert.equal(r.passed, true, JSON.stringify(r.results));
  } finally {
    delete process.env.GITHUB_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a candidate that rewrites the generated lockfile during its checks fails", { skip: !enabled }, () => {
  const dir = candidate();
  try {
    const p = policy((r) => ({ ...r, validation: { image: IMAGE, lockfile: { path: "lock.txt", command: "echo trusted > lock.txt" }, commands: ["echo tampered > lock.txt"] } }));
    const r = runValidation({ root: dir, policy: p, image: IMAGE, log: () => {} });
    assert.equal(r.passed, false);
    assert.match(r.results.at(-1).name, /generated lock\.txt unchanged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing check is reported with sanitized output", { skip: !enabled }, () => {
  const dir = candidate();
  try {
    const p = policy((r) => ({ ...r, validation: { image: IMAGE, commands: ["echo 'expected Bun 1.4.0, got 1.4.4' >&2; exit 3"] } }));
    const r = runValidation({ root: dir, policy: p, image: IMAGE, log: () => {} });
    assert.equal(r.passed, false);
    assert.match(r.results.at(-1).output, /expected Bun 1\.4\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
