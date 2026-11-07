// Runs candidate checks in disposable, credential-free containers. Candidate
// code never sees a token, a host mount other than its own copy, or the Docker
// socket. Generated files are snapshotted before any candidate code runs.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { sanitizeLog } from "./digest.mjs";

export function rejectLinks(root, skip = new Set([".git", "node_modules"])) {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`candidate contains a symbolic link: ${p.slice(root.length + 1)}`);
    if (st.isDirectory() && !skip.has(name)) rejectLinks(p, skip);
  }
}

export function readCandidateFile(root, rel) {
  const real = realpathSync(root);
  let cur = real;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    if (lstatSync(cur).isSymbolicLink()) throw new Error(`validation output ${rel} is a link`);
  }
  const st = lstatSync(cur);
  if (!st.isFile() || !realpathSync(cur).startsWith(real + sep) || st.size > 4 * 1024 * 1024) throw new Error(`unsupported validation output ${rel}`);
  const bytes = readFileSync(cur);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error(`${rel} is not UTF-8`);
  return text;
}

// The Docker CLI keeps only the settings that locate the daemon (rootless and
// contexted runners need them). No token or other runner variable is passed;
// containers never inherit the CLI's environment anyway.
export const dockerEnv = (env = process.env) => ({
  PATH: env.PATH,
  DOCKER_BUILDKIT: "1",
  ...Object.fromEntries(["HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR"].filter((k) => env[k]).map((k) => [k, env[k]])),
});

const docker = (args, { timeout, input } = {}) =>
  execFileSync("docker", args, { env: dockerEnv(), timeout, input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

export function containerArgs({ name, image, workspace, network, memory, cpus, env, command }) {
  return ["run", "--rm", "--name", name, "--init", `--network=${network}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "1000:1000",
    `--memory=${memory}`, `--cpus=${cpus}`, "--pids-limit=1024", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=2g,uid=1000,gid=1000",
    "-e", "HOME=/tmp/home", "-e", "CI=true", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-v", `${workspace}:/workspace:rw`, "-w", "/workspace", image, "sh", "-eu", "-c", command];
}

// root: candidate checkout with the admitted changes already written.
// Returns {passed, results, generated: Map(path -> content)}.
export function runValidation({ root, policy, image, exec = docker, log = console.log }) {
  const v = policy.validation;
  const deadline = Date.now() + v.timeoutMinutes * 60000;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("validation time limit reached");
    return ms;
  };
  rmSync(join(root, ".git"), { recursive: true, force: true });
  rejectLinks(root);
  const results = [];
  const tag = `pr-repair-validator-${randomBytes(6).toString("hex")}`;
  // RUNNER_TEMP is a daemon-visible path on hosted, self-hosted, and Desktop setups.
  const scratch = process.env.RUNNER_TEMP || tmpdir();
  const ctx = mkdtempSync(join(scratch, "pr-repair-validator-"));
  // The trusted setup runs as root while building a validator image; it gets
  // no candidate files, no build arguments, and no secrets.
  writeFileSync(join(ctx, "Dockerfile"), `FROM ${image}\n${v.setup ? `RUN ${v.setup}\n` : ""}`);
  const workspace = mkdtempSync(join(scratch, "pr-repair-workspace-"));
  const step = (name, fn) => {
    const started = Date.now();
    try {
      fn();
      results.push({ name, passed: true, seconds: Math.round((Date.now() - started) / 1000) });
      return true;
    } catch (e) {
      const out = sanitizeLog(`${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`, 12000);
      results.push({ name, passed: false, seconds: Math.round((Date.now() - started) / 1000), output: out });
      log(`validation step failed: ${name}`);
      return false;
    }
  };
  const generated = new Map();
  try {
    cpSync(root, workspace, { recursive: true, verbatimSymlinks: true });
    chmodRecursive(workspace);
    if (!step("build validator image", () => docker(["build", "--quiet", "--network=default", "--tag", tag, ctx], { timeout: left() }))) return { passed: false, results, generated };
    const run = (name, command, network) =>
      step(name, () => exec(containerArgs({ name: `${tag}-${results.length}`, image: tag, workspace, network, memory: v.memory, cpus: v.cpus, env: v.env, command }), { timeout: left() }));
    if (v.lockfile) {
      if (!run("regenerate lockfile", v.lockfile.command, "bridge")) return { passed: false, results, generated };
      generated.set(v.lockfile.path, readCandidateFile(workspace, v.lockfile.path));
    }
    if (v.install && !run("install", v.install, "bridge")) return { passed: false, results, generated };
    for (const command of v.commands) if (!run(command, command, "none")) return { passed: false, results, generated };
    for (const [p, c] of generated) {
      if (readCandidateFile(workspace, p) !== c) {
        results.push({ name: `generated ${p} unchanged`, passed: false, output: "candidate checks rewrote a generated file" });
        return { passed: false, results, generated };
      }
    }
    // Image builds run the candidate's Dockerfile in BuildKit without secrets.
    for (const b of v.dockerBuilds) {
      const t = `${tag}-image-${results.length}`;
      if (!step(`docker build ${b.file}`, () => docker(["build", "--quiet", "--network=default", "--file", join(root, b.file), "--tag", t, join(root, b.context ?? ".")], { timeout: left() }))) return { passed: false, results, generated };
      try { docker(["image", "rm", "--force", t]); } catch { /* best effort */ }
    }
    return { passed: true, results, generated };
  } finally {
    try { docker(["image", "rm", "--force", tag]); } catch { /* best effort */ }
    rmSync(ctx, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

function chmodRecursive(dir) {
  chmodSync(dir, 0o777);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) chmodRecursive(p);
    else if (st.isFile()) chmodSync(p, st.mode & 0o111 ? 0o777 : 0o666);
  }
}

export function writeCandidate(root, files) {
  for (const f of files) {
    const target = join(root, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
}
