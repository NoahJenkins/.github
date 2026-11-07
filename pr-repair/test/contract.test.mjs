import { test } from "node:test";
import assert from "node:assert/strict";
import { contractViolations, droppedTargets, requestedTargets, runtimeMoves, syncRuntimeFields } from "../src/contract.mjs";
import { contractAtRest } from "../src/selftest.mjs";
import { BUN_NEW, BUN_OLD, NODE_NEW, NODE_OLD, dockerfile, policy, tree } from "./fixtures.mjs";

// Metriks #167: Dependabot moved only the Bun FROM line; assertions still pinned 1.4.0.
test("#167 Bun patch: trusted sync moves every declared Bun field", () => {
  const p = policy();
  const change = { path: "apps/api/Dockerfile", before: dockerfile(NODE_OLD, BUN_OLD), after: dockerfile(NODE_OLD, BUN_NEW) };
  const moves = runtimeMoves(p, [change]);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].from.version, "1.4.0");
  assert.equal(moves[0].to.version, "1.4.4");

  const files = tree();
  files.set("apps/api/Dockerfile", change.after);
  assert.ok(contractViolations(p, moves, files).length > 0, "the update alone leaves the contract broken");
  const { edits } = syncRuntimeFields(p, moves, files);
  const after = new Map([...files, ...edits]);
  assert.match(after.get("scripts/ops/smoke-api-docker.sh"), /== '1\.4\.4'/);
  assert.match(after.get("scripts/ops/smoke-api-docker.sh"), /expected Bun 1\.4\.4/, "the message field in the smoke script moves too");
  assert.ok(after.get("scripts/safety/test-runtime-contract.sh").includes(`expected_bun_image='${BUN_NEW}'`));
  assert.match(after.get("AGENTS.md"), /Bun 1\.4\.4/);
  assert.deepEqual(contractViolations(p, moves, after), []);
});

// Metriks #168: Node 24 -> 25 across build/runtime/rollback images.
test("#168 Node major: engines, CI selector, rollback image, and docs move together", () => {
  const p = policy();
  const changes = [
    { path: "apps/api/Dockerfile", before: dockerfile(NODE_OLD, BUN_OLD), after: dockerfile(NODE_NEW, BUN_OLD) },
    { path: "apps/api/Dockerfile.node", before: tree().get("apps/api/Dockerfile.node"), after: tree({ node: NODE_NEW }).get("apps/api/Dockerfile.node") },
  ];
  const moves = runtimeMoves(p, changes);
  assert.deepEqual(moves.map((m) => [m.from.major, m.to.major]), [["24", "25"]]);
  const files = tree();
  for (const c of changes) files.set(c.path, c.after);
  const { edits } = syncRuntimeFields(p, moves, files);
  const after = new Map([...files, ...edits]);
  assert.equal(JSON.parse(after.get("package.json")).engines.node, "25.x");
  assert.equal(JSON.parse(after.get("apps/api/package.json")).engines.node, "25.x");
  assert.match(after.get(".github/workflows/pr-checks.yml"), /node-version: 25\n/);
  assert.ok(after.get("scripts/safety/test-runtime-contract.sh").includes(`expected_node_image='${NODE_NEW}'`));
  assert.match(after.get("AGENTS.md"), /Node 25 remains required/);
  assert.match(after.get("AGENTS.md"), /Node 24\.19\.0/, "a full version is not rewritten by a major-only field");
  assert.deepEqual(contractViolations(p, moves, after), []);
});

test("a required field that names neither version fails closed", () => {
  const p = policy();
  const files = tree();
  files.set("scripts/ops/smoke-api-docker.sh", "echo no version here\n");
  const moves = runtimeMoves(p, [{ path: "apps/api/Dockerfile", before: dockerfile(NODE_OLD, BUN_OLD), after: dockerfile(NODE_OLD, BUN_NEW) }]);
  assert.throws(() => syncRuntimeFields(p, moves, files), /no file in scripts\/ops\/smoke-api-docker\.sh/);
});

test("a field that needs more precision than the tag gives fails closed", () => {
  const p = policy((raw) => {
    raw.runtimes[1].fields.push({ files: ["AGENTS.md"], template: "Node {minor}" });
    return raw;
  });
  const moves = runtimeMoves(p, [{ path: "apps/api/Dockerfile", before: dockerfile(NODE_OLD, BUN_OLD), after: dockerfile(NODE_NEW, BUN_OLD) }]);
  assert.throws(() => syncRuntimeFields(p, moves, tree()), /more version precision/);
});

test("ambiguous image moves are rejected", () => {
  const p = policy();
  const other = "node:26-bookworm-slim@sha256:" + "1".repeat(64);
  assert.throws(
    () => runtimeMoves(p, [
      { path: "apps/api/Dockerfile", before: dockerfile(NODE_OLD, BUN_OLD), after: dockerfile(NODE_NEW, BUN_OLD) },
      { path: "apps/api/Dockerfile.node", before: `FROM ${NODE_OLD} AS build\n`, after: `FROM ${other} AS build\n` },
    ]),
    /two targets/,
  );
});

test("the contract holds at rest in a consistent tree", async () => {
  assert.deepEqual(await contractAtRest(policy(), tree()), []);
  const drifted = tree();
  drifted.set("scripts/ops/smoke-api-docker.sh", "echo '1.3.9'\n");
  assert.equal((await contractAtRest(policy(), drifted)).length, 1);
});

test("requested targets cover manifests, images, actions, and go modules", () => {
  const targets = requestedTargets([
    { path: "apps/api/package.json", before: '{"dependencies":{"hono":"4.9.0"}}', after: '{"dependencies":{"hono":"5.0.0"}}' },
    { path: "apps/api/Dockerfile", before: dockerfile(NODE_OLD, BUN_OLD), after: dockerfile(NODE_OLD, BUN_NEW) },
    { path: ".github/workflows/ci.yml", before: "uses: actions/checkout@v4\n", after: "uses: actions/checkout@v5\n" },
    { path: "go.mod", before: "module x\n\nrequire (\n\tgolang.org/x/net v0.30.0\n)\n", after: "module x\n\nrequire (\n\tgolang.org/x/net v0.31.0\n)\n" },
  ]);
  assert.deepEqual(targets.map((t) => `${t.kind}:${t.key}=${t.value}`), [
    "npm:dependencies:hono=5.0.0",
    `docker:AS runtime=${BUN_NEW}`,
    "action:actions/checkout=actions/checkout@v5",
    "go:golang.org/x/net=v0.31.0",
  ]);
  const reverted = new Map([["apps/api/package.json", '{"dependencies":{"hono":"4.9.0"}}'], ["apps/api/Dockerfile", dockerfile(NODE_OLD, BUN_NEW)], [".github/workflows/ci.yml", "uses: actions/checkout@v5\n"], ["go.mod", "require golang.org/x/net v0.31.0\n"]]);
  assert.deepEqual(droppedTargets(targets, reverted).map((t) => t.key), ["dependencies:hono"]);
});

test("regex-escaped image references in safety tests move too", () => {
  const p = policy((raw) => {
    raw.runtimes[0].fields.push({ files: ["scripts/safety/*.sh"], template: "{imageRef}", escape: "regex", optional: true });
    return raw;
  });
  const files = tree();
  files.set("scripts/safety/test-do-deployment-contract.sh", `expectMatch(d, /FROM oven\\/bun:1\\.4\\.0-slim@sha256:${"a".repeat(64)} AS runtime/);\n`);
  const moves = runtimeMoves(p, [{ path: "apps/api/Dockerfile", before: dockerfile(NODE_OLD, BUN_OLD), after: dockerfile(NODE_OLD, BUN_NEW) }]);
  const { edits } = syncRuntimeFields(p, moves, files);
  assert.equal(edits.get("scripts/safety/test-do-deployment-contract.sh"), `expectMatch(d, /FROM oven\\/bun:1\\.4\\.4-slim@sha256:${"b".repeat(64)} AS runtime/);\n`);
});

// Codex P1 on Metriks #180: smoke-api-docker.sh asserts Node "v24.19.0", but the
// tag only says "24". The exact version comes from the digest-pinned image config.
import { createHash } from "node:crypto";
import { resolveImageVersions } from "../src/contract.mjs";

function fakeRegistry() {
  const blobs = new Map();
  let tamper = false;
  const put = (body) => {
    const d = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    blobs.set(d, body);
    return d;
  };
  // Returns the index digest an image with this environment would have.
  const image = (env) => {
    const config = put(JSON.stringify({ config: { Env: env } }));
    const manifest = put(JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: config } }));
    return put(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: manifest, platform: { os: "linux", architecture: "amd64" } }] }));
  };
  const fetcher = async (url) => {
    if (url.startsWith("https://auth.docker.io/")) return new Response(JSON.stringify({ token: "t" }));
    const m = url.match(/\/v2\/library\/node\/(?:manifests|blobs)\/(sha256:[0-9a-f]{64})$/);
    const body = m && blobs.get(m[1]);
    if (!body) return new Response("nope", { status: 404 });
    return new Response(tamper ? body.replace("linux", "linux ") : body);
  };
  return { image, fetcher, tamper: () => { tamper = true; } };
}
const nodeRef = (major, d) => `node:${major}-bookworm-slim@${d}`;

test("versionFromImageEnv supplies the exact runtime version from the pinned image config", async () => {
  const p = policy((raw) => {
    raw.runtimes[1].versionFromImageEnv = "NODE_VERSION";
    raw.runtimes[1].fields.push({ files: ["scripts/ops/smoke-api-docker.sh"], template: "v{version}" });
    return raw;
  });
  const reg = fakeRegistry();
  const oldRef = nodeRef(24, reg.image(["NODE_VERSION=24.19.0"]));
  const newRef = nodeRef(25, reg.image(["NODE_VERSION=25.9.0", "YARN_VERSION=1.22.22"]));
  const moves = runtimeMoves(p, [{ path: "apps/api/Dockerfile", before: dockerfile(oldRef, BUN_OLD), after: dockerfile(newRef, BUN_OLD) }]);
  const resolved = await resolveImageVersions(p, moves, { fetcher: reg.fetcher });
  assert.deepEqual([resolved[0].from.version, resolved[0].to.version, resolved[0].to.major], ["24.19.0", "25.9.0", "25"]);
  const files = tree({ node: oldRef });
  files.set("scripts/ops/smoke-api-docker.sh", `${files.get("scripts/ops/smoke-api-docker.sh")}[[ "\${node_version}" == 'v24.19.0' ]] || fail "expected Node v24.19.0"\n`);
  files.set("apps/api/Dockerfile", dockerfile(newRef, BUN_OLD));
  const after = new Map([...files, ...syncRuntimeFields(p, resolved, files).edits]);
  assert.match(after.get("scripts/ops/smoke-api-docker.sh"), /== 'v25\.9\.0' \]\] \|\| fail "expected Node v25\.9\.0"/);
  assert.equal(JSON.parse(after.get("package.json")).engines.node, "25.x", "major-only fields still use the major");
});

test("versionFromImageEnv fails closed on tampered content, a missing variable, or a major mismatch", async () => {
  const p = policy((raw) => ({ ...raw, runtimes: [{ ...raw.runtimes[1], versionFromImageEnv: "NODE_VERSION" }] }));
  const move = (reg, oldEnv, newMajor, newEnv) => runtimeMoves(p, [{ path: "apps/api/Dockerfile", before: dockerfile(nodeRef(24, reg.image(oldEnv)), BUN_OLD), after: dockerfile(nodeRef(newMajor, reg.image(newEnv)), BUN_OLD) }]);
  const tampered = fakeRegistry();
  const m1 = move(tampered, ["NODE_VERSION=24.19.0"], 25, ["NODE_VERSION=25.9.0"]);
  tampered.tamper();
  await assert.rejects(resolveImageVersions(p, m1, { fetcher: tampered.fetcher }), /does not match digest/);
  const missing = fakeRegistry();
  await assert.rejects(resolveImageVersions(p, move(missing, ["NODE_VERSION=24.19.0"], 25, ["OTHER=1"]), { fetcher: missing.fetcher }), /no usable NODE_VERSION/);
  const wrong = fakeRegistry();
  await assert.rejects(resolveImageVersions(p, move(wrong, ["NODE_VERSION=24.19.0"], 25, ["NODE_VERSION=26.0.0"]), { fetcher: wrong.fetcher }), /disagrees with the tag's major/);
});
