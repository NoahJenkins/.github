// Offline check of the pinned Copilot CLI: real CLI, real curated data tool,
// local fake model. No credential, no GitHub access, no paid provider call.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv, cliArgs, observe, summarizeUsage } from "./transport-copilot.mjs";

const DATA_SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../copilot/copilot-data.cjs");

export async function copilotSmoke({ binary, model }) {
  if (!binary || !model) throw new Error("smoke needs the verified binary and the configured model");
  const root = mkdtempSync(join(tmpdir(), "pr-repair-copilot-smoke-"));
  const payload = "é".repeat(11000);
  const tail = "offline-complete-marker";
  let requests = 0;
  let child;
  let events = "";
  const server = createServer(async (req, res) => {
    try {
      if (++requests > 6) throw new Error("request limit");
      let body = "";
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      if (value.tools?.length !== 1 || value.tools[0].function?.name !== "curated-read_data") throw new Error("unexpected runtime tools");
      const complete = value.messages?.some((m) => m.role === "tool" && JSON.stringify(m.content).includes(tail));
      const delta = complete ? { content: '{"ok":true}' } : { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "curated-read_data", arguments: JSON.stringify({ operation: "read", file: "input.json", length: 12000 }) } }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [part, finish] of [[{ role: "assistant", ...delta }, null], [{}, delta.tool_calls ? "tool_calls" : "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: part, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } catch {
      res.writeHead(400);
      res.end("{}");
    }
  });
  try {
    for (const d of ["data", "work", "home"]) mkdirSync(join(root, d));
    writeFileSync(join(root, "data", "input.json"), JSON.stringify({ payload, tail }));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const usage = join(root, "usage.json");
    child = spawn(binary, cliArgs({ model, prompt: 'Read input.json completely, then return JSON {"ok":true}.', maxAiCredits: 1 }, { work: join(root, "work"), data: join(root, "data"), server: DATA_SERVER, usage }), {
      env: { ...cleanEnv(join(root, "home")), PATH: process.env.PATH, COPILOT_OFFLINE: "true", COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_WIRE_API: "completions" },
    });
    child.stdout.on("data", (c) => { events += c; });
    const r = await observe(child, { model, maxCalls: 4, timeoutMs: 60000 });
    const read = events.split("\n").filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.type === "tool.execution_complete" && e.data?.success === true && e.data?.result?.content?.includes(tail));
    if (JSON.parse(r.text).ok !== true || !read || requests !== 2) throw new Error("offline Copilot tool verification failed");
    summarizeUsage(JSON.parse(readFileSync(usage, "utf8")), model);
    return "offline Copilot curated read passed (no credits used)";
  } finally {
    child?.kill("SIGKILL");
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
}
