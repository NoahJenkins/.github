// Repository reads shared by every mode: file contents at exact commits, the
// original update's own change set, and runtime-contract inputs.
import { matchesAny } from "../../review-gate/src/glob.mjs";
import { POLICY_PATH } from "./policy.mjs";
import { isDockerfile, requestedTargets, resolveImageVersions, runtimeMoves, syncRuntimeFields } from "./contract.mjs";
import { SHA, sha256 } from "./digest.mjs";

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

export async function fileAt(gh, repo, path, sha) {
  try {
    const d = await gh.get(`/repos/${repo}/contents/${enc(path)}?ref=${sha}`);
    if (Array.isArray(d) || d.type !== "file") throw new Error(`${path} is not a file`);
    const blob = d.content ? d : await gh.get(`/repos/${repo}/git/blobs/${d.sha}`);
    const bytes = Buffer.from(blob.content, "base64");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error(`${path} is not UTF-8`);
    return text;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function treeAt(gh, repo, sha) {
  const t = await gh.get(`/repos/${repo}/git/trees/${sha}?recursive=1`);
  if (t.truncated) throw new Error("repository tree is too large to inspect completely");
  return t.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, mode: e.mode, size: e.size }));
}

// Files a pull request changes relative to its merge base with the default branch.
export async function changeSet(gh, repo, baseSha, headSha, { withContent = (p) => true, max = 300 } = {}) {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error("invalid commit identity");
  const cmp = await gh.get(`/repos/${repo}/compare/${baseSha}...${headSha}`);
  const mergeBase = cmp.merge_base_commit?.sha;
  if (!SHA.test(mergeBase || "")) throw new Error("no merge base");
  if ((cmp.files ?? []).length >= max || (cmp.files ?? []).length >= 300) throw new Error("change set too large to inspect completely");
  const changes = [];
  for (const f of cmp.files ?? []) {
    if (f.status === "renamed" || f.previous_filename) throw new Error(`renamed file ${f.filename} is unsupported`);
    const want = withContent(f.filename);
    changes.push({
      path: f.filename,
      status: f.status,
      before: want && f.status !== "added" ? await fileAt(gh, repo, f.filename, mergeBase) : null,
      after: want && f.status !== "removed" ? await fileAt(gh, repo, f.filename, headSha) : null,
    });
  }
  return { mergeBase, status: cmp.status, behindBy: cmp.behind_by, changes };
}

// Files among `paths` that the default branch changed between two of its
// commits, or null when that cannot be shown completely (main was rewritten,
// or the comparison is truncated). A rename counts for both of its names.
// The policy file always counts: a review is bound to the policy it ran under.
export async function driftOverlap(gh, repo, fromBase, toBase, paths) {
  if (!SHA.test(fromBase) || !SHA.test(toBase)) throw new Error("invalid commit identity");
  if (fromBase === toBase) return [];
  let cmp;
  try {
    cmp = await gh.get(`/repos/${repo}/compare/${fromBase}...${toBase}`);
  } catch {
    return null;
  }
  const files = cmp.files ?? [];
  if (cmp.status !== "ahead" || files.length >= 300) return null;
  const touched = new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
  return [...new Set([...paths, POLICY_PATH])].filter((p) => touched.has(p));
}

// The controller App's update-branch merges on an original, when provably
// harmless: every App commit is a GitHub-committed (web-flow) two-parent merge
// of a commit already on the default branch, no bot commit follows one, the
// default branch has not touched the bot's files since the bot's base, and the
// head tree is exactly that default-branch commit plus the bot's own changes
// (every path, blob, and mode). Anything else returns an empty set.
export async function soundRefreshes(gh, repo, { commits, head, baseSha, botLogin, authors }) {
  const none = new Set();
  const app = commits.filter((c) => c.author?.login === botLogin);
  if (!app.length) return none;
  try {
    const bot = commits.filter((c) => authors.includes(c.author?.login));
    const tip = bot.at(-1);
    if (!tip || app.length + bot.length !== commits.length) return none;
    if (commits.indexOf(tip) > commits.indexOf(app[0])) return none;
    for (const c of app) {
      if (c.parents?.length !== 2 || c.committer?.login !== "web-flow") return none;
      const cmp = await gh.get(`/repos/${repo}/compare/${c.parents[1].sha}...${baseSha}`);
      if (!["identical", "ahead"].includes(cmp.status)) return none;
    }
    const merged = app.at(-1).parents[1].sha;
    const botBase = (await gh.get(`/repos/${repo}/compare/${baseSha}...${tip.sha}`)).merge_base_commit?.sha;
    if (!SHA.test(botBase || "")) return none;
    const tree = async (sha) => {
      const t = await gh.get(`/repos/${repo}/git/trees/${sha}?recursive=1`);
      if (t.truncated) throw new Error("tree truncated");
      return new Map(t.tree.filter((e) => e.type !== "tree").map((e) => [e.path, `${e.mode} ${e.sha}`]));
    };
    const [tHead, tTip, tMain, tBotBase] = [await tree(head), await tree(tip.sha), await tree(merged), await tree(botBase)];
    const paths = new Set([...tHead.keys(), ...tTip.keys(), ...tMain.keys(), ...tBotBase.keys()]);
    for (const p of paths) {
      const botChanged = tTip.get(p) !== tBotBase.get(p);
      if (botChanged && tMain.get(p) !== tBotBase.get(p)) return none;
      if (tHead.get(p) !== (botChanged ? tTip.get(p) : tMain.get(p))) return none;
    }
  } catch {
    return none;
  }
  return new Set(app.map((c) => c.sha));
}

const needsText = (p) => isDockerfile(p) || /(^|\/)(package\.json|go\.mod)$/.test(p) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p);

// The original update's request: its runtime image moves and concrete targets.
export async function originalRequest(gh, repo, policy, baseSha, originalHead) {
  const cs = await changeSet(gh, repo, baseSha, originalHead, { withContent: needsText });
  const targets = requestedTargets(cs.changes);
  const lock = policy.validation.lockfile?.path;
  if (lock && cs.changes.some((c) => c.path === lock) && !targets.some((t) => t.kind === "npm")) {
    targets.push({ path: lock, kind: "identical", key: lock, value: sha256(await fileAt(gh, repo, lock, originalHead)) });
  }
  return { moves: await resolveImageVersions(policy, runtimeMoves(policy, cs.changes)), targets, changed: cs.changes.map((c) => c.path) };
}

// Every file the moved runtimes' fields address, at one commit.
export async function fieldFilesAt(gh, repo, policy, moves, sha) {
  const globs = moves.flatMap((m) => policy.runtimes.find((r) => r.name === m.runtime).fields.flatMap((f) => f.files));
  if (!globs.length) return new Map();
  const paths = (await treeAt(gh, repo, sha)).filter((e) => matchesAny(e.path, globs) && e.size <= 2 * 1024 * 1024).map((e) => e.path);
  if (paths.length > 200) throw new Error("runtime fields address more than 200 files");
  const files = new Map();
  for (const p of paths) files.set(p, await fileAt(gh, repo, p, sha));
  return files;
}

export function syncFor(policy, moves, fieldFiles) {
  return syncRuntimeFields(policy, moves, fieldFiles);
}
