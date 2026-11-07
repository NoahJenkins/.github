// Canonical JSON, digests, and the size/text guards every artifact passes.
import { createHash } from "node:crypto";

export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  throw new Error("value is not canonical JSON");
}

export const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Seals an object with a digest of everything except the digest itself.
export function seal(value) {
  const { digest: _drop, ...rest } = value;
  return { ...rest, digest: digest(rest) };
}

export function verifySeal(value) {
  if (!value || typeof value !== "object" || typeof value.digest !== "string") throw new Error("artifact is not sealed");
  if (seal(value).digest !== value.digest) throw new Error("artifact digest mismatch");
  return value;
}

export function assertText(value, max, what = "text") {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > max) {
    throw new Error(`${what} is not bounded UTF-8 text`);
  }
  return value;
}

export const SHA = /^[0-9a-f]{40}$/;

// Repository-relative path without traversal, git internals, or control characters.
export function assertPath(p) {
  if (
    typeof p !== "string" ||
    !p ||
    p.length > 300 ||
    /[\\\x00-\x1f\x7f]/.test(p) ||
    p.startsWith("/") ||
    p.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`invalid repository path: ${JSON.stringify(String(p).slice(0, 80))}`);
  }
  return p;
}

// Removes ANSI escapes, workflow commands, and anything that looks like a token.
export function sanitizeLog(text, max = 48 * 1024) {
  const clean = String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .filter((l) => !/^\S*\s*::/.test(l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, "")))
    .map((l) => l.replace(/\b(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|vck_[A-Za-z0-9_-]{20,})\b/g, "[redacted]").slice(0, 1000))
    .join("\n");
  const bytes = Buffer.from(clean);
  return bytes.length <= max ? clean : bytes.subarray(bytes.length - max).toString("utf8").replace(/^�+/, "");
}
