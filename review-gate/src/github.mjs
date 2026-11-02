const API = process.env.GITHUB_API_URL || "https://api.github.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// dryRun: write calls are logged and skipped; reads still hit the API.
export function githubClient(token, { dryRun = false, log = console.log } = {}) {
  async function request(method, path, { body, accept, raw } = {}) {
    const url = path.startsWith("http") ? path : API + path;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: accept || "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "review-gate",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const retryable =
        res.status >= 500 || res.status === 429 || (res.status === 403 && res.headers.get("retry-after"));
      if (retryable && attempt < 3) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt;
        await sleep(Math.min(wait, 60000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      if (raw) return res.text();
      return res.status === 204 ? null : res.json();
    }
  }

  const write = (method) => async (path, body) => {
    if (dryRun) {
      log(`[dry-run] ${method} ${path} ${body ? JSON.stringify(body).slice(0, 4000) : ""}`);
      return { id: 0, dryRun: true };
    }
    return request(method, path, { body });
  };

  return {
    get: (path, opts) => request("GET", path, opts),
    post: write("POST"),
    patch: write("PATCH"),
    put: write("PUT"),
    async paginate(path, { max = 3000 } = {}) {
      const out = [];
      for (let page = 1; out.length < max; page++) {
        const sep = path.includes("?") ? "&" : "?";
        const items = await request("GET", `${path}${sep}per_page=100&page=${page}`);
        out.push(...items);
        if (items.length < 100) break;
      }
      return out;
    },
  };
}
