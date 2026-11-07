// Minimal GitHub client. Reads retry transient failures; writes never retry,
// because an ambiguous write must be verified, not replayed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function githubClient(token, { api = process.env.GITHUB_API_URL || "https://api.github.com", dryRun = false, log = console.log, fetcher = fetch } = {}) {
  if (!token) throw new Error("a GitHub token is required");
  async function request(method, path, { body, accept, raw, maxBytes = 4 * 1024 * 1024 } = {}) {
    if (!path.startsWith("/") || /[\r\n]/.test(path)) throw new Error("invalid API path");
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetcher(api + path, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: accept || "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "pr-repair",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        if (method === "GET" && attempt < 2) { await sleep(1500 * 2 ** attempt); continue; }
        throw e;
      }
      if (method === "GET" && attempt < 2 && (res.status >= 500 || res.status === 429)) { await sleep(Math.min(Number(res.headers.get("retry-after")) * 1000 || 1500 * 2 ** attempt, 30000)); continue; }
      if (!res.ok) {
        const err = new Error(`GitHub ${method} ${path.split("?")[0]} -> ${res.status}`);
        err.status = res.status;
        err.body = (await res.text()).slice(0, 300);
        throw err;
      }
      if (res.status === 204) return null;
      if (raw) {
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
      }
      const data = await res.json();
      if (data?.errors?.length) {
        const err = new Error(`GitHub GraphQL error: ${String(data.errors[0]?.message).slice(0, 200)}`);
        err.graphql = data.errors;
        throw err;
      }
      return data;
    }
  }
  const write = (method) => async (path, body) => {
    if (dryRun) {
      log(`[dry-run] ${method} ${path} ${body ? JSON.stringify(body).slice(0, 600) : ""}`);
      return { id: 0, dryRun: true, data: {} };
    }
    return request(method, path, { body });
  };
  const client = {
    dryRun,
    get: (path, opts) => request("GET", path, opts),
    post: write("POST"),
    patch: write("PATCH"),
    put: write("PUT"),
    del: write("DELETE"),
    // Queries are reads; mutations are writes and honor dry-run.
    graphql: (query, variables) => (/^\s*mutation\b/.test(query) ? write("POST")("/graphql", { query, variables }) : request("POST", "/graphql", { body: { query, variables } })),
    async paginate(path, { key, max = 2000 } = {}) {
      const out = [];
      for (let page = 1; out.length < max; page++) {
        const data = await request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
        const items = key ? data[key] : data;
        if (!Array.isArray(items)) throw new Error("unexpected paginated response");
        out.push(...items);
        if (items.length < 100) return out;
      }
      throw new Error(`more than ${max} items at ${path.split("?")[0]}; failing closed`);
    },
  };
  return client;
}
