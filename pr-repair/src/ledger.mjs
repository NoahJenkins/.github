// Durable attempt accounting. One comment by the controller App on the state
// issue holds every reservation. Attempts are never refunded: a failed,
// expired, or ambiguous attempt stays consumed, across transports and models.
import { randomUUID } from "node:crypto";
import { SHA } from "./digest.mjs";

export const MARKER = "<!-- pr-repair-ledger:v1 -->";
export const KINDS = ["sync", "repair", "review"];
export const MODEL_KINDS = ["repair", "review"];
const STATUSES = ["reserved", "publishing", "published", "failed", "expired"];
const MAX_BYTES = 60000;
export const RESERVATION_TTL = 3 * 3600 * 1000;

export const emptyLedger = () => ({ version: 1, entries: [], marks: {}, legacy: {} });

export function validateLedger(l) {
  if (!l || l.version !== 1 || !Array.isArray(l.entries) || typeof l.marks !== "object" || typeof l.legacy !== "object") throw new Error("invalid ledger schema");
  const nonces = new Set();
  for (const e of l.entries) {
    if (!/^[0-9a-f-]{36}$/.test(e.nonce) || nonces.has(e.nonce)) throw new Error("invalid or duplicate ledger nonce");
    if (!Number.isSafeInteger(e.root) || e.root < 1 || !Number.isSafeInteger(e.target) || !SHA.test(e.head) || !SHA.test(e.base) || !SHA.test(e.rootHead)) throw new Error("invalid ledger identity");
    if (!KINDS.includes(e.kind) || !STATUSES.includes(e.status) || new Date(e.createdAt).toISOString() !== e.createdAt) throw new Error("invalid ledger entry");
    nonces.add(e.nonce);
  }
  return l;
}

export function encodeLedger(l) {
  validateLedger(l);
  const body = `${MARKER}\n${JSON.stringify(l)}`;
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("ledger is full; archive closed pull requests (operator action)");
  return body;
}

// comments: issue comments. Only the App bot may author the ledger.
export function readLedger(comments, botId) {
  const found = comments.filter((c) => c.body?.startsWith(MARKER));
  if (!found.length) return { ledger: emptyLedger(), commentId: null, raw: null };
  if (found.length > 1) throw new Error("several ledgers on the state issue; operator action required");
  if (found[0].user?.id !== botId) throw new Error("the ledger was not written by the controller App");
  const ledger = validateLedger(JSON.parse(found[0].body.slice(MARKER.length)));
  return { ledger, commentId: found[0].id, raw: found[0].body };
}

const day = (iso) => iso.slice(0, 10);

// Counts every attempt ever reserved for an original pull request, including
// attempts the previous controller recorded (legacy) and failed ones.
export function usage(ledger, root, now) {
  const mine = ledger.entries.filter((e) => e.root === root);
  const legacy = ledger.legacy[String(root)] ?? 0;
  return {
    repair: mine.filter((e) => e.kind === "repair").length + legacy,
    review: mine.filter((e) => e.kind === "review").length,
    syncFor: (head) => mine.filter((e) => e.kind === "sync" && e.head === head).length,
    todayModel: ledger.entries.filter((e) => MODEL_KINDS.includes(e.kind) && day(e.createdAt) === day(now)).length,
    open: mine.filter((e) => e.status === "reserved" || e.status === "publishing"),
  };
}

// Returns {ledger, entry} or {reason}. The caller persists before any spend.
export function reserve(ledger, task, limits, now) {
  validateLedger(ledger);
  if (!KINDS.includes(task.kind)) throw new Error("invalid task kind");
  const u = usage(ledger, task.root, now);
  if (u.open.length) return { reason: `attempt ${u.open[0].nonce.slice(0, 8)} for #${task.root} is still ${u.open[0].status}` };
  if (task.kind === "repair" && u.repair >= limits.repairPerPr) return { reason: `repair budget exhausted (${u.repair}/${limits.repairPerPr})`, exhausted: true };
  if (task.kind === "review" && u.review >= limits.reviewPerPr) return { reason: `review budget exhausted (${u.review}/${limits.reviewPerPr})`, exhausted: true };
  if (task.kind === "sync" && u.syncFor(task.head) >= limits.syncPerHead) return { reason: "runtime sync already attempted for this head", exhausted: true };
  if (MODEL_KINDS.includes(task.kind) && u.todayModel >= limits.dailyModelTasks) return { reason: `daily model budget reached (${limits.dailyModelTasks})`, daily: true };
  const entry = { ...task, nonce: randomUUID(), createdAt: now, status: "reserved" };
  const next = { ...ledger, entries: [...ledger.entries, entry] };
  encodeLedger(next);
  return { ledger: next, entry };
}

export function transition(ledger, nonce, status, fields = {}) {
  const i = ledger.entries.findIndex((e) => e.nonce === nonce);
  if (i === -1) throw new Error("unknown reservation");
  const cur = ledger.entries[i];
  const allowed = { reserved: ["publishing", "failed", "expired"], publishing: ["published", "failed"], published: [], failed: [], expired: [] };
  if (!allowed[cur.status].includes(status)) throw new Error(`reservation cannot move from ${cur.status} to ${status}`);
  const entries = [...ledger.entries];
  entries[i] = { ...cur, ...fields, status, updatedAt: new Date().toISOString() };
  return { ...ledger, entries };
}

// Marks are once-per-key actions (a rebase request, a branch refresh).
export const marked = (ledger, key) => Boolean(ledger.marks[key]);
export const mark = (ledger, key, now) => ({ ...ledger, marks: { ...ledger.marks, [key]: now } });

// Drops entries only for pull requests that are closed, so open budgets survive.
export function prune(ledger, openRoots, now) {
  const cutoff = Date.parse(now) - 30 * 86400000;
  const entries = ledger.entries.filter((e) => openRoots.has(e.root) || Date.parse(e.createdAt) > cutoff);
  const marks = Object.fromEntries(Object.entries(ledger.marks).filter(([, at]) => Date.parse(at) > cutoff));
  const legacy = Object.fromEntries(Object.entries(ledger.legacy).filter(([root]) => openRoots.has(Number(root))));
  return { ...ledger, entries, marks, legacy };
}
