// Runtime contract: when an update moves a runtime image (node, bun, golang...),
// every field the repository declares for that runtime moves with it. Only this
// trusted code writes those fields; a model never edits them.
import { matchesAny } from "../../review-gate/src/glob.mjs";
import { sha256 } from "./digest.mjs";

const FROM = /^(\s*FROM\s+(?:--platform=\S+\s+)?)([a-z0-9._/-]+):([\w.-]+)@sha256:([0-9a-f]{64})(\s+AS\s+[\w.-]+)?\s*$/i;

export const isDockerfile = (p) => /(^|\/)(Dockerfile(\.[\w.-]+)?|[\w.-]+\.Dockerfile)$/.test(p);

export function dockerFroms(text) {
  const out = [];
  for (const [i, line] of String(text).split("\n").entries()) {
    const m = line.match(FROM);
    if (m) out.push({ line: i, image: m[2], tag: m[3], digest: m[4], stage: (m[5] || "").trim(), ref: `${m[2]}:${m[3]}@sha256:${m[4]}`, text: line });
  }
  return out;
}

function versionOf(runtime, tag) {
  const m = tag.match(new RegExp(runtime.versionPattern));
  if (!m?.groups?.version) return null;
  const version = m.groups.version;
  const parts = version.split(".");
  return { version, major: parts[0], minor: parts.length > 1 ? parts.slice(0, 2).join(".") : null, precision: parts.length };
}

// Finds the runtime image moves an update requests, from its own base->head diff.
// changes: [{path, before, after}] for the files the original pull request changed.
export function runtimeMoves(policy, changes) {
  const moves = [];
  for (const runtime of policy.runtimes) {
    const pairs = new Map();
    for (const c of changes) {
      if (!isDockerfile(c.path) || typeof c.before !== "string" || typeof c.after !== "string") continue;
      const before = dockerFroms(c.before).filter((f) => f.image === runtime.image);
      const after = dockerFroms(c.after).filter((f) => f.image === runtime.image);
      if (before.length !== after.length) throw new Error(`${c.path}: ${runtime.image} FROM lines were added or removed`);
      before.forEach((b, i) => {
        const a = after[i];
        if (b.ref === a.ref) return;
        if (b.stage !== a.stage) throw new Error(`${c.path}: ${runtime.image} stage changed`);
        const prior = pairs.get(b.ref);
        if (prior && prior !== a.ref) throw new Error(`${runtime.image}: one image moved to two targets`);
        pairs.set(b.ref, a.ref);
      });
    }
    if (pairs.size > 1) throw new Error(`${runtime.image}: several distinct image moves in one update`);
    for (const [from, to] of pairs) {
      const parse = (ref) => {
        const [, tag, digest] = ref.match(/^[^:]+:([^@]+)@sha256:([0-9a-f]{64})$/);
        const v = versionOf(runtime, tag);
        if (!v) throw new Error(`${runtime.image}:${tag} does not match versionPattern`);
        return { ref, tag, digest, ...v };
      };
      moves.push({ runtime: runtime.name, image: runtime.image, from: parse(from), to: parse(to) });
    }
  }
  return moves;
}

// escape "regex" renders values the way a JavaScript regex literal spells them
// (for example oven\/bun:1\.4\.0-slim inside /FROM .../).
const ESCAPES = { regex: (s) => s.replace(/[.\/+*?()[\]{}|^$\\]/g, "\\$&") };

function render(template, v, image, escape) {
  const esc = ESCAPES[escape] ?? ((s) => s);
  const raw = { major: v.major, minor: v.minor, version: v.version, tag: v.tag, imageRef: v.ref };
  const values = Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, x == null ? x : esc(x)]));
  let missing = false;
  const out = template.replace(/\{(major|minor|version|tag|imageRef)\}/g, (_, k) => {
    if (values[k] == null) missing = true;
    return values[k] ?? "";
  });
  if (missing) throw new Error(`${image}: a field needs more version precision than the image tag provides`);
  return out;
}

// Replaces whole-token occurrences only: "Node 24" never rewrites "Node 24.19.0"
// and "24" never rewrites "124".
function boundedOccurrences(text, needle) {
  const hits = [];
  if (!needle) return hits;
  const versiony = /[0-9A-Za-z_]/;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const prev = text[i - 1] ?? "";
    const next = text[i + needle.length] ?? "";
    const after2 = text[i + needle.length + 1] ?? "";
    const leftOk = !(versiony.test(needle[0]) && versiony.test(prev)) && !(prev === "." && /\d/.test(needle[0]));
    const rightOk =
      !(versiony.test(needle.at(-1)) && versiony.test(next)) && !(/\d/.test(needle.at(-1)) && next === "." && /\d/.test(after2));
    if (leftOk && rightOk) hits.push(i);
  }
  return hits;
}

function replaceBounded(text, from, to) {
  const hits = boundedOccurrences(text, from);
  if (!hits.length) return { text, count: 0 };
  let out = "";
  let last = 0;
  for (const i of hits) {
    out += text.slice(last, i) + to;
    last = i + from.length;
  }
  return { text: out + text.slice(last), count: hits.length };
}

// Applies every declared field for every move. files: Map(path -> content) of
// the whole candidate tree subset that the fields can address. Returns the
// edits and fails closed when a required field is absent or inconsistent.
export function syncRuntimeFields(policy, moves, files) {
  const edits = new Map();
  const report = [];
  for (const move of moves) {
    const runtime = policy.runtimes.find((r) => r.name === move.runtime);
    for (const field of runtime.fields) {
      const from = render(field.template, move.from, move.image, field.escape);
      const to = render(field.template, move.to, move.image, field.escape);
      let seen = 0;
      for (const [path, original] of files) {
        if (!matchesAny(path, field.files)) continue;
        const current = edits.get(path) ?? original;
        if (boundedOccurrences(current, to).length) seen++;
        if (from === to) continue;
        const r = replaceBounded(current, from, to);
        if (r.count) {
          edits.set(path, r.text);
          seen++;
          report.push({ runtime: move.runtime, path, template: field.template, from, to, count: r.count });
        }
      }
      if (!seen && !field.optional) {
        throw new Error(`runtime contract: no file in ${field.files.join(", ")} holds "${from}" or "${to}" for ${move.runtime}`);
      }
    }
  }
  return { edits, report };
}

// After sync, no declared field may still name the old runtime.
export function contractViolations(policy, moves, files) {
  const problems = [];
  for (const move of moves) {
    const runtime = policy.runtimes.find((r) => r.name === move.runtime);
    for (const field of runtime.fields) {
      const from = render(field.template, move.from, move.image, field.escape);
      const to = render(field.template, move.to, move.image, field.escape);
      if (from === to) continue;
      for (const [path, text] of files) {
        if (matchesAny(path, field.files) && boundedOccurrences(text, from).length) problems.push(`${path} still has "${from}"`);
      }
    }
  }
  return problems;
}

const DEP_GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

// The concrete values an update requested. A repair must keep every one of them.
export function requestedTargets(changes) {
  const targets = [];
  for (const c of changes) {
    if (typeof c.after !== "string") continue;
    if (/(^|\/)package\.json$/.test(c.path)) {
      let before = {};
      let after;
      try {
        before = c.before ? JSON.parse(c.before) : {};
        after = JSON.parse(c.after);
      } catch {
        throw new Error(`${c.path} is not valid JSON`);
      }
      for (const g of DEP_GROUPS) {
        for (const [name, version] of Object.entries(after[g] ?? {})) {
          if (before[g]?.[name] !== version) targets.push({ path: c.path, kind: "npm", key: `${g}:${name}`, value: version });
        }
      }
      for (const key of ["packageManager"]) {
        if (after[key] !== undefined && before[key] !== after[key]) targets.push({ path: c.path, kind: "npm", key, value: after[key] });
      }
    } else if (isDockerfile(c.path)) {
      const before = new Set(dockerFroms(c.before ?? "").map((f) => f.ref));
      for (const f of dockerFroms(c.after)) if (!before.has(f.ref)) targets.push({ path: c.path, kind: "docker", key: f.stage || f.image, value: f.ref });
    } else if (/(^|\/)go\.mod$/.test(c.path)) {
      const before = new Set(goRequires(c.before ?? "").map((r) => `${r.module}@${r.version}`));
      for (const r of goRequires(c.after)) if (!before.has(`${r.module}@${r.version}`)) targets.push({ path: c.path, kind: "go", key: r.module, value: r.version });
    } else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(c.path)) {
      const before = new Set(actionPins(c.before ?? ""));
      for (const pin of actionPins(c.after)) if (!before.has(pin)) targets.push({ path: c.path, kind: "action", key: pin.split("@")[0], value: pin });
    }
  }
  return targets;
}

function goRequires(text) {
  const out = [];
  for (const m of String(text).matchAll(/^(?:require\s+|\t|\s{2,})?([\w.\-/]+\.[\w.\-/]+)\s+(v[\w.+-]+)(?:\s*\/\/.*)?$/gm)) out.push({ module: m[1], version: m[2] });
  for (const m of String(text).matchAll(/^(go|toolchain)\s+(\S+)\s*$/gm)) out.push({ module: m[1], version: m[2] });
  return out;
}

function actionPins(text) {
  return [...String(text).matchAll(/uses:\s*['"]?([\w.-]+\/[\w./-]+@[\w.-]+)/g)].map((m) => m[1]);
}

// Returns the requested targets the candidate dropped or changed.
export function droppedTargets(targets, files) {
  const lost = [];
  for (const t of targets) {
    const text = files.get(t.path);
    if (typeof text !== "string") { lost.push(t); continue; }
    if (t.kind === "npm") {
      let pkg;
      try { pkg = JSON.parse(text); } catch { lost.push(t); continue; }
      const [group, ...rest] = t.key.split(":");
      const value = rest.length ? pkg[group]?.[rest.join(":")] : pkg[group];
      if (value !== t.value) lost.push(t);
    } else if (t.kind === "docker") {
      if (!dockerFroms(text).some((f) => f.ref === t.value)) lost.push(t);
    } else if (t.kind === "go") {
      if (!goRequires(text).some((r) => r.module === t.key && r.version === t.value)) lost.push(t);
    } else if (t.kind === "action") {
      if (!actionPins(text).includes(t.value)) lost.push(t);
    } else if (t.kind === "identical") {
      // A lockfile-only update has no manifest target; its resolved tree is the request.
      if (sha256(text) !== t.value) lost.push(t);
    }
  }
  return lost;
}
