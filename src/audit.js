/**
 * mediakit-for-agents — audit log / operation envelope.
 *
 * Every tool call (CLI, MCP stdio, MCP HTTP) appends one JSONL line to
 * `.mediakit-audit.jsonl` in the workspace root, so a render can be
 * traced back later: which tool ran, with which arguments (hash +
 * redacted copy), which files went in and came out (path + size +
 * SHA-256), how long it took, and whether it failed.
 *
 * Idea: Mnehmos/ffmpeg-llm's src/audit.ts (studied turn 54) + the
 * Verified-Trap Guard ledger in the backlog — the ledger that proves
 * a file on disk is still the file a tool claims it produced. The
 * shape of the verify step follows heristop/leclap's `leclap verify`
 * (studied turn 55): re-hash the recorded files and compare, per
 * file, instead of trusting the log. A log line is a claim; the
 * hashes on disk are the evidence.
 *
 * Rules:
 * - Audit is best-effort and NEVER fails a tool call: every public
 *   function swallows its own errors (a broken audit file must not
 *   break a render). `recordToolCall` resolves even when the write
 *   fails; `queryAudit` reports the failure in its own result.
 * - No secrets in the log: URL query strings are stripped from
 *   recorded arguments (a download URL can carry a token), long
 *   strings are truncated, and the whole args blob is capped.
 * - Files are hashed by streaming SHA-256; files over 512 MB are
 *   recorded with sha256 null + skipped "too_large" instead of
 *   stalling the call. Only paths named by the call's own args or
 *   result are hashed — never a directory walk.
 * - Opt-out: MEDIAKIT_AUDIT=0 disables recording (query still
 *   reads whatever log exists). MEDIAKIT_AUDIT_PATH overrides the
 *   log location. Default: <MEDIAKIT_WORKDIR or cwd>/.mediakit-audit.jsonl
 *   (same root rule as the durable job store in core.js).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const AUDIT_FILE_NAME = ".mediakit-audit.jsonl";
const MAX_HASH_BYTES = 512 * 1024 * 1024;
const MAX_FILES_PER_ENTRY = 32;
const MAX_ARG_STRING = 2048;
const MAX_ARGS_JSON_BYTES = 8192;
const MAX_QUERY_READ_BYTES = 4 * 1024 * 1024;

export function auditEnabled() {
  return process.env.MEDIAKIT_AUDIT !== "0";
}

export function auditPath() {
  const override = process.env.MEDIAKIT_AUDIT_PATH;
  if (override?.trim()) return path.resolve(override.trim());
  const base = process.env.MEDIAKIT_WORKDIR?.trim()
    ? path.resolve(process.env.MEDIAKIT_WORKDIR.trim())
    : process.cwd();
  return path.join(base, AUDIT_FILE_NAME);
}

// ---------------------------------------------------------------- hashing
function hashFile(file) {
  return new Promise((resolve) => {
    let size = 0;
    try {
      const st = statSync(file);
      if (!st.isFile()) return resolve(null);
      size = st.size;
    } catch {
      return resolve(null);
    }
    if (size > MAX_HASH_BYTES) return resolve({ sha256: null, size_bytes: size, skipped: "too_large" });
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", () => resolve(null));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), size_bytes: size }));
  });
}

// ---------------------------------------------------------------- extraction
// Only these keys name a file worth hashing. Deliberately NOT `path`
// on its own: audit-query results carry `files[].path` for every
// recorded file, and hashing those again would re-hash the whole
// workspace on every `audit` call.
const FILE_KEYS = new Set([
  "input", "output", "output_dir", "output_file", "final",
  "video", "audio", "music", "image", "pip", "overlay",
  "manifest", "manifest_path", "manifest_file", "file",
  "directory", "input_dir", "words_file", "captions",
  "background", "kit_file", "svg", "anim",
]);
const INPUT_KEYS = new Set(["input", "video", "audio", "music", "image", "pip", "overlay", "manifest", "manifest_path", "manifest_file", "directory", "input_dir", "words_file", "captions", "background", "kit_file", "svg", "anim"]);
const OUTPUT_KEYS = new Set(["output", "output_dir", "output_file", "final"]);

function collectFiles(value, role, out, depth = 0) {
  if (out.length >= MAX_FILES_PER_ENTRY || depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, role, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FILE_KEYS.has(key)) collectFiles(item, INPUT_KEYS.has(key) ? "input" : OUTPUT_KEYS.has(key) ? "output" : role, out, depth + 1);
      else if (key === "sfx" && Array.isArray(item)) {
        for (const sfx of item) if (sfx && typeof sfx.file === "string") collectFiles(sfx.file, "input", out, depth + 1);
      }
    }
    return;
  }
  if (typeof value === "string" && value.length > 0 && value.length < 4096) {
    // A string is a file only if it exists on disk as a file — a
    // bare name, a URL, or a number-as-string never qualifies.
    let st;
    try {
      st = statSync(path.resolve(value));
    } catch {
      return;
    }
    if (st.isFile() && !out.some((f) => f.path === path.resolve(value))) {
      out.push({ path: path.resolve(value), role });
    }
  }
}

// ---------------------------------------------------------------- redaction
function redactValue(value, depth = 0) {
  if (typeof value === "string") {
    let s = value;
    // A URL can carry a token in its query string — keep the path,
    // drop everything after ? or #. Same rule as download's
    // no-credentials-in-URL guard, applied to the log instead.
    if (/^https?:\/\//i.test(s)) s = s.split(/[?#]/)[0];
    if (s.length > MAX_ARG_STRING) s = `${s.slice(0, MAX_ARG_STRING)}…(truncated ${s.length - MAX_ARG_STRING} chars)`;
    return s;
  }
  if (Array.isArray(value)) return depth > 4 ? "[array]" : value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 4) return "[object]";
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, depth + 1);
    return out;
  }
  return value;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ---------------------------------------------------------------- ffmpeg version (memoized, one spawn per process)
let ffmpegVersionCache = null;
function ffmpegVersion() {
  if (ffmpegVersionCache !== null) return ffmpegVersionCache;
  ffmpegVersionCache = new Promise((resolve) => {
    execFile(process.env.MEDIAKIT_FFMPEG || "ffmpeg", ["-version"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve((stdout.match(/ffmpeg version (\S+)/) || [])[1] ?? null);
    });
  });
  return ffmpegVersionCache;
}

// ---------------------------------------------------------------- recording
// Serialized appends: the HTTP server handles concurrent invokes, and
// two appendFile calls could otherwise interleave mid-line. One
// promise chain per process keeps every line whole.
let writeChain = Promise.resolve();

export async function recordToolCall({ tool, via, args, result, status, errorCode = null, durationMs = null }) {
  if (!auditEnabled()) return null;
  try {
    const started = Date.now();
    const candidates = [];
    collectFiles(args, "arg", candidates);
    collectFiles(result, "result", candidates);
    const files = [];
    for (const c of candidates.slice(0, MAX_FILES_PER_ENTRY)) {
      const hashed = await hashFile(c.path);
      if (!hashed) continue;
      files.push({ path: c.path, role: c.role, ...hashed });
    }
    const redacted = redactValue(args ?? {});
    const argsJson = JSON.stringify(redacted);
    const entry = {
      id: `audit-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${createHash("sha256").update(`${process.pid}-${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8)}`,
      ts: new Date().toISOString(),
      tool,
      via,
      duration_ms: durationMs ?? Date.now() - started,
      status,
      ...(errorCode ? { error_code: errorCode } : {}),
      args_sha256: sha256Json(redacted),
      args: argsJson.length > MAX_ARGS_JSON_BYTES
        ? { truncated: true, preview: argsJson.slice(0, MAX_ARGS_JSON_BYTES) }
        : redacted,
      files,
      ffmpeg_version: await ffmpegVersion(),
    };
    const line = `${JSON.stringify(entry)}\n`;
    const target = auditPath();
    writeChain = writeChain.then(() => appendFile(target, line, "utf8"), () => appendFile(target, line, "utf8"));
    await writeChain;
    return entry.id;
  } catch {
    // Audit must never fail the call it records.
    return null;
  }
}

// ---------------------------------------------------------------- querying
export async function queryAudit({ limit = 20, tool = null, status = null, since = null, verify = false } = {}) {
  const target = auditPath();
  const base = { operation: "audit", audit_path: target, entries: [], total: 0 };
  let raw;
  try {
    const st = await stat(target);
    if (st.size > MAX_QUERY_READ_BYTES) {
      const buf = Buffer.alloc(MAX_QUERY_READ_BYTES);
      const { open } = await import("node:fs/promises");
      const fh = await open(target, "r");
      try {
        await fh.read(buf, 0, MAX_QUERY_READ_BYTES, st.size - MAX_QUERY_READ_BYTES);
      } finally {
        await fh.close();
      }
      raw = buf.toString("utf8");
      base.truncated = true;
      base.note = `audit log larger than ${MAX_QUERY_READ_BYTES} bytes — only the tail was read`;
    } else {
      raw = await readFile(target, "utf8");
    }
  } catch (err) {
    if (err?.code === "ENOENT") return { ...base, note: "no audit log yet — run a tool first" };
    return { ...base, error: err.message, note: "audit log could not be read" };
  }
  let malformed = 0;
  const all = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  if (malformed) base.malformed_lines = malformed;
  const sinceMs = since ? Date.parse(since) : NaN;
  let filtered = all.filter((e) => {
    if (tool && e.tool !== tool) return false;
    if (status && e.status !== status) return false;
    if (!Number.isNaN(sinceMs) && Date.parse(e.ts) < sinceMs) return false;
    return true;
  });
  base.total = filtered.length;
  filtered = filtered.slice(-Math.max(1, limit)).reverse();
  if (verify) {
    for (const entry of filtered) {
      const checks = [];
      for (const f of entry.files ?? []) {
        const hashed = await hashFile(f.path);
        if (!hashed) checks.push({ path: f.path, role: f.role, state: "missing" });
        else if (hashed.sha256 !== f.sha256) checks.push({ path: f.path, role: f.role, state: "changed", recorded_sha256: (f.sha256 ?? "").slice(0, 12), actual_sha256: (hashed.sha256 ?? "").slice(0, 12) });
        else checks.push({ path: f.path, role: f.role, state: "matched" });
      }
      entry.file_checks = checks;
      entry.verified = checks.length > 0 && checks.every((c) => c.state === "matched");
      if (checks.length === 0) entry.verified = null;
    }
  }
  base.entries = filtered;
  return base;
}

// ---------------------------------------------------------------- doctor status
export async function auditStatus() {
  if (!auditEnabled()) return { enabled: false, path: auditPath(), note: "disabled by MEDIAKIT_AUDIT=0" };
  const target = auditPath();
  try {
    const st = await stat(target);
    let entries = null;
    let lastTs = null;
    if (st.size < 2 * 1024 * 1024) {
      const raw = await readFile(target, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      entries = lines.length;
      try {
        lastTs = JSON.parse(lines[lines.length - 1]).ts ?? null;
      } catch { /* last line malformed — leave null */ }
    }
    return { enabled: true, path: target, entries, size_bytes: st.size, ...(lastTs ? { last_ts: lastTs } : {}) };
  } catch (err) {
    if (err?.code === "ENOENT") return { enabled: true, path: target, entries: 0, size_bytes: 0, note: "no audit log yet" };
    return { enabled: true, path: target, error: err.message };
  }
}

// Exists only so the test suite can assert the log file itself is
// created where the docs say it is, without importing internals.
export function auditFileExists() {
  return existsSync(auditPath());
}
