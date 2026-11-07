// In-memory GitHub for end-to-end tests. Commits are snapshots of whole trees.
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha1").update(s).digest("hex");

export class FakeGitHub {
  constructor({ repo = "o/r", botId = 900, botLogin = "pr-repair-app[bot]", appId = 77 } = {}) {
    Object.assign(this, { repo, botId, botLogin, appId, dryRun: false });
    this.commits = new Map(); // sha -> {tree: Map, parents, message, author}
    this.refs = new Map();
    this.pulls = new Map();
    this.checks = [];
    this.issues = new Map();
    this.comments = [];
    this.writes = [];
    this.runs = [];
    this.nextId = 1000;
  }
  commit(tree, parents = [], message = "c", author = "dependabot[bot]", fixed = null) {
    const id = fixed ?? sha(JSON.stringify([[...tree], parents, message, this.nextId++]));
    this.commits.set(id, { tree: new Map(tree), parents, message, author });
    return id;
  }
  pr(number, fields) {
    this.pulls.set(number, { number, state: "open", draft: false, mergeable_state: "clean", auto_merge: null, node_id: `PR_${number}`, changed_files: 1, body: "", title: `PR ${number}`, user: { login: "dependabot[bot]", type: "Bot" }, base: { ref: "main", sha: this.refs.get("main") }, ...fields, head: { repo: { full_name: this.repo }, ...fields.head } });
  }
  id() { return this.nextId++; }
  async get(path, opts = {}) {
    const [p, q = ""] = path.split("?");
    const query = Object.fromEntries(new URLSearchParams(q));
    const r = `/repos/${this.repo}`;
    let m;
    if (p === `/users/${this.botLogin.replace("[bot]", "")}%5Bbot%5D`) return { id: this.botId, type: "Bot" };
    if ((m = p.match(new RegExp(`^${r}/git/ref/heads/(.+)$`)))) {
      if (!this.refs.has(m[1])) throw Object.assign(new Error("404"), { status: 404 });
      return { object: { sha: this.refs.get(m[1]) } };
    }
    if ((m = p.match(new RegExp(`^${r}/git/commits/(\\w+)$`)))) return { sha: m[1], message: this.commits.get(m[1]).message };
    if ((m = p.match(new RegExp(`^${r}/pulls/(\\d+)$`)))) {
      const x = this.pulls.get(Number(m[1]));
      if (!x) throw Object.assign(new Error("404"), { status: 404 });
      return structuredClone(x);
    }
    if ((m = p.match(new RegExp(`^${r}/compare/(\\w+)\\.\\.\\.(\\w+)$`)))) return this.compare(m[1], m[2]);
    if ((m = p.match(new RegExp(`^${r}/contents/(.+)$`)))) {
      const t = this.commits.get(query.ref)?.tree;
      const path2 = decodeURIComponent(m[1]);
      if (!t?.has(path2)) throw Object.assign(new Error("404"), { status: 404 });
      return { type: "file", content: Buffer.from(t.get(path2)).toString("base64") };
    }
    if ((m = p.match(new RegExp(`^${r}/git/trees/(\\w+)$`)))) return { truncated: false, tree: [...this.commits.get(m[1]).tree].map(([path2, c]) => ({ path: path2, type: "blob", mode: "100644", size: c.length })) };
    if ((m = p.match(new RegExp(`^${r}/issues/comments/(\\d+)$`)))) return structuredClone(this.comments.find((c) => c.id === Number(m[1])));
    if (p === `/repos/${this.repo}`) return { default_branch: "main" };
    if ((m = p.match(new RegExp(`^${r}/actions/jobs/(\\d+)/logs$`)))) return `2026-11-07T00:00:00Z ##[group]Run pnpm test\nFAIL src/a.test.ts\nTypeError: hono.newApi is not a function (job ${m[1]})\n`;
    throw new Error(`fake GET not implemented: ${path}`);
  }
  async paginate(path) {
    const [p, q = ""] = path.split("?");
    const query = Object.fromEntries(new URLSearchParams(q));
    const r = `/repos/${this.repo}`;
    let m;
    if (p === `${r}/pulls`) return [...this.pulls.values()].filter((x) => (query.state === "all" || x.state === (query.state ?? "open")) && (!query.head || `${this.repo.split("/")[0]}:${x.head.ref}` === query.head)).map((x) => structuredClone(x));
    if ((m = p.match(new RegExp(`^${r}/pulls/(\\d+)/commits$`)))) return this.prCommits(Number(m[1]));
    if ((m = p.match(new RegExp(`^${r}/commits/(\\w+)/check-runs$`)))) return this.checks.filter((c) => c.head_sha === m[1]).map((c) => structuredClone(c));
    if (p === `${r}/issues`) return [...this.issues.values()].filter((i) => i.state === "open").map((i) => structuredClone(i));
    if ((m = p.match(new RegExp(`^${r}/issues/(\\d+)/comments$`)))) return this.comments.filter((c) => c.issue === Number(m[1])).map((c) => structuredClone(c));
    if ((m = p.match(new RegExp(`^${r}/pulls/(\\d+)/(reviews|comments)$`)))) return [];
    if (p.startsWith(`${r}/actions/workflows/`)) return this.runs;
    throw new Error(`fake paginate not implemented: ${path}`);
  }
  prCommits(n) {
    const pr = this.pulls.get(n);
    const out = [];
    for (let c = pr.head.sha; c && c !== pr.base.sha && this.commits.has(c); c = this.commits.get(c).parents[0]) {
      out.unshift({ sha: c, author: { login: this.commits.get(c).author }, commit: { verification: { verified: true } } });
      if (this.commits.get(c).parents[0] === this.refs.get("main")) break;
    }
    return out;
  }
  compare(base, head) {
    const ancestors = (s) => { const set = []; for (let c = s; c; c = this.commits.get(c)?.parents[0]) set.push(c); return set; };
    const a = ancestors(base);
    const mergeBase = ancestors(head).find((c) => a.includes(c));
    const before = this.commits.get(mergeBase).tree;
    const after = this.commits.get(head).tree;
    const files = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).map((p) => ({ filename: p, status: !before.has(p) ? "added" : !after.has(p) ? "removed" : "modified" }));
    return { merge_base_commit: { sha: mergeBase }, status: mergeBase === base ? "ahead" : "diverged", behind_by: 0, files };
  }
  record(method, path, body) { this.writes.push({ method, path, body }); }
  async post(path, body) {
    this.record("POST", path, body);
    const r = `/repos/${this.repo}`;
    let m;
    if (path === `${r}/check-runs`) {
      const c = { id: this.id(), app: { id: this.appId }, head_sha: body.head_sha, name: body.name, status: body.status, conclusion: body.conclusion, output: body.output };
      this.checks.push(c);
      return c;
    }
    if (path === `${r}/labels`) return {};
    if (path.match(/\/pulls\/\d+\/reviews$/)) return { id: this.id() };
    if (path === `${r}/issues`) {
      const i = { number: this.id(), state: "open", user: { id: this.botId }, body: body.body, labels: body.labels };
      this.issues.set(i.number, i);
      return i;
    }
    if ((m = path.match(new RegExp(`^${r}/issues/(\\d+)/comments$`)))) {
      const c = { id: this.id(), issue: Number(m[1]), body: body.body, user: { id: this.botId, login: this.botLogin } };
      this.comments.push(c);
      return structuredClone(c);
    }
    if (path === `${r}/git/refs`) {
      const name = body.ref.replace("refs/heads/", "");
      if (this.refs.has(name)) throw Object.assign(new Error("exists"), { status: 422 });
      this.refs.set(name, body.sha);
      return {};
    }
    if (path === `${r}/pulls`) {
      const number = this.id();
      this.pr(number, { title: body.title, body: body.body, user: { login: this.botLogin, type: "Bot" }, head: { ref: body.head, sha: this.refs.get(body.head) } });
      return { number };
    }
    throw new Error(`fake POST not implemented: ${path}`);
  }
  async patch(path, body) {
    this.record("PATCH", path, body);
    let m;
    if ((m = path.match(/issues\/comments\/(\d+)$/))) {
      const c = this.comments.find((x) => x.id === Number(m[1]));
      c.body = body.body;
      return structuredClone(c);
    }
    if ((m = path.match(/issues\/(\d+)$/))) { Object.assign(this.issues.get(Number(m[1])), body); return {}; }
    if ((m = path.match(/check-runs\/(\d+)$/))) { Object.assign(this.checks.find((c) => c.id === Number(m[1])), body); return {}; }
    if ((m = path.match(/pulls\/(\d+)$/))) { Object.assign(this.pulls.get(Number(m[1])), body); return {}; }
    throw new Error(`fake PATCH not implemented: ${path}`);
  }
  async put(path, body) { this.record("PUT", path, body); return {}; }
  async del(path) { this.record("DELETE", path); return null; }
  async graphql(query, variables) {
    this.record("GRAPHQL", query.match(/\{\s*(\w+)/)[1], variables);
    if (query.includes("createCommitOnBranch")) {
      const { branch, expectedHeadOid, fileChanges, message } = variables.input;
      if (this.refs.get(branch.branchName) !== expectedHeadOid) throw new Error("expectedHeadOid mismatch");
      const tree = new Map(this.commits.get(expectedHeadOid).tree);
      for (const a of fileChanges.additions) tree.set(a.path, Buffer.from(a.contents, "base64").toString());
      const id = this.commit(tree, [expectedHeadOid], `${message.headline}\n\n${message.body}`, this.botLogin);
      this.refs.set(branch.branchName, id);
      for (const p of this.pulls.values()) if (p.head.ref === branch.branchName && p.state === "open") p.head.sha = id;
      return { data: { createCommitOnBranch: { commit: { oid: id } } } };
    }
    if (query.includes("reviewThreads")) return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } };
    return { data: {} };
  }
}
