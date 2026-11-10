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
    this.jobs = new Map(); // Actions job id (= check run id) -> {id, name, steps}
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
      const v = t.get(path2);
      return { type: "file", content: (Buffer.isBuffer(v) ? v : Buffer.from(v)).toString("base64") };
    }
    if ((m = p.match(new RegExp(`^${r}/git/trees/(\\w+)$`)))) return { truncated: false, tree: [...this.commits.get(m[1]).tree].map(([path2, c]) => ({ path: path2, type: "blob", mode: this.commits.get(m[1]).modes?.[path2] ?? "100644", size: c.length, sha: sha(`blob ${c}`) })) };
    if ((m = p.match(new RegExp(`^${r}/issues/comments/(\\d+)$`)))) return structuredClone(this.comments.find((c) => c.id === Number(m[1])));
    if (p === `/repos/${this.repo}`) return { default_branch: "main" };
    if ((m = p.match(new RegExp(`^${r}/actions/jobs/(\\d+)$`)))) {
      const job = this.jobs.get(Number(m[1]));
      if (!job) throw Object.assign(new Error("404"), { status: 404 });
      if (job.status) throw Object.assign(new Error(String(job.status)), { status: job.status });
      return structuredClone(job);
    }
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
    if ((m = p.match(new RegExp(`^${r}/pulls/(\\d+)/reviews$`)))) return (this.reviews ?? []).filter((x) => x.pr === Number(m[1])).map((x) => structuredClone(x));
    if ((m = p.match(new RegExp(`^${r}/pulls/(\\d+)/comments$`)))) return [];
    if ((m = p.match(new RegExp(`^${r}/actions/workflows/([^/]+)/runs$`))) && this.workflowRuns?.[decodeURIComponent(m[1])]) {
      return this.workflowRuns[decodeURIComponent(m[1])].filter((x) => !query.status || x.status === query.status);
    }
    if (p.startsWith(`${r}/actions/workflows/`)) return this.runs;
    if (p === `${r}/actions/runs`) return [{ id: 555, head_sha: query.head_sha, conclusion: "failure" }];
    throw new Error(`fake paginate not implemented: ${path}`);
  }
  // Like GitHub: every commit reachable from the head and not from main.
  prCommits(n) {
    const pr = this.pulls.get(n);
    const onMain = new Set();
    for (let c = this.refs.get("main"); c; c = this.commits.get(c)?.parents[0]) onMain.add(c);
    const out = [];
    const seen = new Set();
    const walk = (c) => {
      if (!c || seen.has(c) || onMain.has(c) || !this.commits.has(c)) return;
      seen.add(c);
      for (const p of this.commits.get(c).parents) walk(p);
      out.push({ sha: c, author: { login: this.commits.get(c).author }, committer: { login: this.commits.get(c).committer ?? this.commits.get(c).author }, commit: { verification: { verified: true } }, parents: this.commits.get(c).parents.map((sha) => ({ sha })) });
    };
    walk(pr.head.sha);
    return out;
  }
  compare(base, head) {
    // Breadth-first over all parents, so a merge commit's merge base is right.
    const ancestors = (s) => {
      const out = [];
      for (let queue = [s]; queue.length;) {
        const c = queue.shift();
        if (!c || out.includes(c) || !this.commits.has(c)) continue;
        out.push(c);
        queue.push(...this.commits.get(c).parents);
      }
      return out;
    };
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
    if (path.match(/\/actions\/runs\/\d+\/rerun-failed-jobs$/)) return null;
    if ((m = path.match(/\/pulls\/(\d+)\/reviews$/))) {
      const review = { id: this.id(), pr: Number(m[1]), state: body.event === "APPROVE" ? "APPROVED" : body.event, commit_id: body.commit_id };
      (this.reviews ??= []).push(review);
      return { id: review.id };
    }
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
    if ((m = path.match(/git\/refs\/heads\/(.+)$/))) {
      if (!body.force) throw Object.assign(new Error("not a fast-forward"), { status: 422 });
      this.refs.set(m[1], body.sha);
      return {};
    }
    throw new Error(`fake PATCH not implemented: ${path}`);
  }
  async put(path, body) { this.record("PUT", path, body); return {}; }
  async del(path) {
    this.record("DELETE", path);
    const m = path.match(/git\/refs\/heads\/(.+)$/);
    if (m) this.refs.delete(m[1]);
    return null;
  }
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
    if (query.includes("enablePullRequestAutoMerge") && this.mergeableNow) {
      throw Object.assign(new Error("GitHub GraphQL error: Pull request Pull request is in unstable status"), { graphql: true });
    }
    if (query.includes("mergePullRequest")) {
      const pr = [...this.pulls.values()].find((x) => x.node_id === variables.id);
      if (pr.head.sha !== variables.head) throw new Error("GitHub GraphQL error: Head branch was modified");
      Object.assign(pr, { state: "closed", merged_at: new Date().toISOString() });
      return { data: { mergePullRequest: { pullRequest: { id: pr.node_id } } } };
    }
    if (query.includes("reviewThreads")) return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } };
    return { data: {} };
  }
}
