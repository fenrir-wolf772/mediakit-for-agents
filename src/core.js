/**
 * mediakit-for-agents — shared core.
 * Every operation runs ffmpeg/ffprobe through execFile with an argument
 * array. There is NO shell involved anywhere: user input can never be
 * interpreted as a shell command.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { auditStatus } from "./audit.js";

export const MEDIAKIT_VERSION = "0.1.0";

export const FFMPEG = process.env.MEDIAKIT_FFMPEG || "ffmpeg";
export const FFPROBE = process.env.MEDIAKIT_FFPROBE || "ffprobe";

// ffmpeg wall-clock timeout (lượt 98: a 1080x1920 burn-captions pass
// under load took >300s and died on the default cap). Env override
// MEDIAKIT_FFMPEG_TIMEOUT_MS, 60s–1h, default 300s — the default stays
// 300s so a hung ffmpeg still fails fast; raise it only when the
// machine is busy or the render is long. Read on every call, so the
// env can change without a restart.
export function ffmpegTimeoutMs() {
  const raw = process.env.MEDIAKIT_FFMPEG_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 300_000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 300_000;
  return Math.min(3_600_000, Math.max(60_000, Math.floor(n)));
}

// ---------------------------------------------------------------- sandbox
// Workspace sandbox (opt-in). Idea from alanveloper-epam/ffmpeg-mcp-server
// (FFMPEG_MCP_WORKDIR) and the sandboxing in
// samuelgursky/davinci-resolve-mcp: when MEDIAKIT_WORKDIR is set, every
// user-supplied input/output path must stay inside it — `..` traversal
// and symlink escapes are refused with SANDBOX_ESCAPE. Unset = no
// restriction (existing behaviour, default). Internal scratch — ffmpeg
// two-pass logs, svg frame temp dirs, burn_captions temp .ass — is not
// a user-supplied path and is exempt.
const WORKDIR_ENV = "MEDIAKIT_WORKDIR";

async function workdirRoot() {
  const raw = process.env[WORKDIR_ENV];
  if (!raw || !raw.trim()) return null;
  const abs = path.resolve(raw.trim());
  let real;
  try {
    real = await realpath(abs);
  } catch {
    throw new MediaKitError(`MEDIAKIT_WORKDIR does not exist or is not readable: ${raw}`, "SANDBOX_WORKDIR_MISSING");
  }
  if (!(await stat(real)).isDirectory()) {
    throw new MediaKitError(`MEDIAKIT_WORKDIR is not a directory: ${raw}`, "SANDBOX_WORKDIR_MISSING");
  }
  return real;
}

function isInsideDir(dir, p) {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function assertInsideWorkdir(abs, label) {
  const root = await workdirRoot();
  if (!root) return;
  if (!isInsideDir(root, abs)) {
    throw new MediaKitError(`${label} escapes MEDIAKIT_WORKDIR (${root}): ${abs}`, "SANDBOX_ESCAPE");
  }
  // Symlink escape: resolve the nearest existing ancestor. If abs
  // itself exists its realpath is checked; if it does not exist yet,
  // every component below the nearest existing ancestor is new, so it
  // cannot be a symlink pointing outside.
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      if (!isInsideDir(root, real)) {
        throw new MediaKitError(`${label} escapes MEDIAKIT_WORKDIR via symlink (${root}): ${abs} -> ${real}`, "SANDBOX_ESCAPE");
      }
      return;
    } catch (err) {
      if (err instanceof MediaKitError) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return; // filesystem root; the lexical check above already passed
      cur = parent;
    }
  }
}

export class MediaKitError extends Error {
  constructor(message, code = "MEDIAKIT_ERROR") {
    super(message);
    this.name = "MediaKitError";
    this.code = code;
  }
}

function runCapture(cmd, args, { timeoutMs = ffmpegTimeoutMs() } = {}) {
  // Like run(), but for non-ffmpeg helpers (the ASR python script):
  // same timeout/buffer discipline, a neutral error code, and the
  // helper's own stderr instead of an ffmpeg-labelled message.
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || "").trim().split("\n").filter(Boolean).slice(-5).join(" | ");
        reject(new MediaKitError(`${cmd} failed: ${err.message}${detail ? ` — ${detail}` : ""}`, "ASR_FAILED"));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function run(cmd, args, { timeoutMs = ffmpegTimeoutMs() } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || "").trim().split("\n").slice(-5).join(" | ");
        reject(new MediaKitError(`${cmd} failed: ${err.message}${detail ? ` — ${detail}` : ""}`, "FFMPEG_FAILED"));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// ---------------------------------------------------------------- ffmpeg progress
// Parse one chunk of ffmpeg `-progress pipe:1` output. Each block is
// `key=value` lines terminated by a blank line, e.g.
//   frame=90 / fps=30.00 / out_time_ms=3000000 / speed=2.1x / progress=continue
// Returns the LAST complete block's fields, or null when the chunk
// holds no recognizable key. `out_time` (HH:MM:SS.xx) is the fallback
// when `out_time_ms`/`out_time_us` are absent (older ffmpeg); `done`
// is true only on a `progress=end` block. Pure — unit-tested without
// spawning ffmpeg.
export function parseFfmpegProgress(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let out = null;
  let cur = null;
  const flush = () => {
    if (cur) out = cur;
    cur = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!["frame", "fps", "out_time_ms", "out_time_us", "out_time", "speed", "progress"].includes(key)) continue;
    if (!cur) cur = { outTimeMs: null, frame: null, fps: null, speed: null, done: false };
    if (key === "frame") cur.frame = Number.parseInt(value, 10);
    else if (key === "fps") cur.fps = Number.parseFloat(value);
    // `out_time_ms` LIES about its unit: ffmpeg prints microseconds
    // there, not milliseconds (measured 2026-11-17: out_time_ms=233333
    // next to out_time=00:00:00.233333 on the same block) — divide by
    // 1000, same as out_time_us. `out_time` is the last resort: it
    // only fills the value when neither microsecond field appeared.
    else if (key === "out_time_ms") cur.outTimeMs = Math.round(Number.parseInt(value, 10) / 1000);
    else if (key === "out_time_us") cur.outTimeMs = Math.round(Number.parseInt(value, 10) / 1000);
    else if (key === "out_time") {
      if (cur.outTimeMs === null) {
        const m = /^(\d+):(\d{2}):(\d{2})\.(\d+)$/.exec(value);
        if (m) cur.outTimeMs = ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + Math.round(Number.parseFloat(`0.${m[4]}`) * 1000);
      }
    } else if (key === "speed") cur.speed = Number.parseFloat(value.replace(/x$/, ""));
    // `progress=` ENDS a block: ffmpeg emits no blank line between
    // blocks (measured 2026-11-17: `progress=continue` is immediately
    // followed by the next block's `frame=`), so the block closes
    // here, not on an empty line.
    else if (key === "progress") { cur.done = value === "end"; flush(); continue; }
  }
  flush();
  if (!out) return null;
  if (out.frame !== null && !Number.isFinite(out.frame)) out.frame = null;
  if (out.fps !== null && !Number.isFinite(out.fps)) out.fps = null;
  if (out.outTimeMs !== null && !Number.isFinite(out.outTimeMs)) out.outTimeMs = null;
  if (out.speed !== null && !Number.isFinite(out.speed)) out.speed = null;
  return out;
}

// Like run(), but for long encodes where the caller wants LIVE
// progress: `-progress pipe:1` streams key=value blocks on stdout,
// parsed as they arrive (run() buffers stdout until exit, so it can
// never report mid-encode). `-nostats` keeps stderr clean for the
// error tail. The flags go right before the last argument — the
// output file — so they apply to that output. Callbacks are throttled
// to one per 250 ms (plus the final one), because the assemble worker
// writes job.json on every callback and a per-frame write would
// drown the render. `onProgress` gets { fraction, frame, fps, speed,
// outTimeMs }; fraction is out_time / totalSeconds, clamped 0..1, and
// is forced to 1 on a clean exit (some encodes never emit a block
// with out_time == total). Without totalSeconds or onProgress this is
// just run() — same args, same error shape — so callers can pass the
// options through unconditionally.
export async function runFfmpegWithProgress(args, { totalSeconds = null, onProgress = null, timeoutMs = ffmpegTimeoutMs() } = {}) {
  if (!(totalSeconds > 0) || typeof onProgress !== "function") {
    return run(FFMPEG, args, { timeoutMs });
  }
  const last = args[args.length - 1];
  if (typeof last !== "string" || last.startsWith("-")) {
    throw new MediaKitError("runFfmpegWithProgress needs the output file as the last argument", "INVALID_ARG");
  }
  const progressArgs = [...args.slice(0, -1), "-progress", "pipe:1", "-nostats", last];
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, progressArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let blockText = "";
    let stderrLines = [];
    let stderrBuf = "";
    let lastEmit = 0;
    let lastFraction = -1;
    let settled = false;
    const emit = (fraction, data, force = false) => {
      const now = Date.now();
      fraction = Math.min(1, Math.max(0, fraction));
      if (!force && now - lastEmit < 250 && fraction < 1) return;
      if (!force && fraction === lastFraction) return;
      lastEmit = now;
      lastFraction = fraction;
      try { onProgress({ fraction, ...data }); } catch { /* progress is advisory */ }
    };
    const handleBlock = (text) => {
      const parsed = parseFfmpegProgress(text);
      if (!parsed) return;
      const fraction = parsed.outTimeMs === null ? lastFraction < 0 ? 0 : lastFraction : parsed.outTimeMs / 1000 / totalSeconds;
      emit(fraction, { frame: parsed.frame, fps: parsed.fps, speed: parsed.speed, outTimeMs: parsed.outTimeMs }, parsed.done);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new MediaKitError(`ffmpeg timed out after ${timeoutMs} ms`, "FFMPEG_FAILED"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        // A block ends on its `progress=` line (no blank line between
        // blocks) — a stray blank line flushes too, defensively.
        if (!line.trim()) {
          if (blockText) { handleBlock(blockText); blockText = ""; }
        } else {
          blockText += `${line}\n`;
          if (line.startsWith("progress=")) { handleBlock(blockText); blockText = ""; }
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      let idx;
      while ((idx = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line.trim()) {
          stderrLines.push(line);
          if (stderrLines.length > 5) stderrLines.shift();
        }
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MediaKitError(`ffmpeg failed to start: ${err.message}`, "FFMPEG_FAILED"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (blockText) handleBlock(blockText);
      if (stderrBuf.trim()) {
        stderrLines.push(stderrBuf.trim());
        if (stderrLines.length > 5) stderrLines = stderrLines.slice(-5);
      }
      if (code === 0) {
        emit(1, { frame: null, fps: null, speed: null, outTimeMs: null }, true);
        resolve({ stdout: "", stderr: stderrLines.join("\n") });
      } else {
        const detail = stderrLines.join(" | ");
        reject(new MediaKitError(`ffmpeg failed: exited with code ${code}${detail ? ` — ${detail}` : ""}`, "FFMPEG_FAILED"));
      }
    });
  });
}

// Quote one argv element for display in dry-run plans (same rule
// mix() uses inline): bare when safe, single-quoted otherwise.
function quoteArg(s) {
  const str = String(s);
  return (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`);
}

// Render an ffmpeg argv as the exact shell command a dry-run plan
// shows — the command a real run would execute, nothing more.
function formatCommand(args) {
  return `${FFMPEG} ${args.map(quoteArg).join(" ")}`;
}

/** Resolve a path, require it to exist, and return the absolute path. */
export async function requireInput(p, label = "input") {
  if (typeof p !== "string" || !p.trim()) {
    throw new MediaKitError(`${label} path is required`, "INVALID_INPUT");
  }
  const abs = path.resolve(p);
  await assertInsideWorkdir(abs, label);
  try {
    await access(abs, fsConstants.R_OK);
  } catch {
    throw new MediaKitError(`${label} not found or not readable: ${p}`, "INPUT_NOT_FOUND");
  }
  return abs;
}

/**
 * Resolve an output path. Parent directory is created. Refuses to
 * overwrite an input file and refuses paths that escape via `..` only
 * in the sense that we always resolve to absolute — callers pass the
 * path they mean; the shell is never involved so traversal cannot
 * execute anything.
 */
export async function prepareOutput(p, inputs = []) {
  if (typeof p !== "string" || !p.trim()) {
    throw new MediaKitError("output path is required", "INVALID_OUTPUT");
  }
  const abs = path.resolve(p);
  for (const inPath of inputs) {
    if (inPath && path.resolve(inPath) === abs) {
      throw new MediaKitError(`output must not overwrite input: ${p}`, "OUTPUT_OVERWRITES_INPUT");
    }
  }
  await assertInsideWorkdir(abs, "output");
  await mkdir(path.dirname(abs), { recursive: true });
  await assertInsideWorkdir(abs, "output"); // re-check now the parent exists (symlinks resolved)
  // Writability pre-check (matthensleyio/FFMpeg.MCP validates the
  // output directory up front by writing a throwaway file into it):
  // a read-only directory must fail HERE, before a long render, not
  // after ffmpeg finishes and cannot write the output. The probe is
  // deleted immediately; a failure is a loud error, never a skip.
  await assertOutputWritable(path.dirname(abs));
  return abs;
}

/**
 * Resolve an output directory, create it, enforce the sandbox.
 * Used by tools that write a folder of files (frames, social) instead
 * of a single output file.
 */
export async function prepareOutputDir(dir) {
  if (typeof dir !== "string" || !dir.trim()) {
    throw new MediaKitError("output directory is required", "INVALID_OUTPUT");
  }
  const abs = path.resolve(dir);
  await assertInsideWorkdir(abs, "output directory");
  await mkdir(abs, { recursive: true });
  await assertInsideWorkdir(abs, "output directory");
  await assertOutputWritable(abs);
  return abs;
}

// Write + delete a throwaway file in `dirAbs`: proves the directory
// is writable right now. Used by prepareOutput / prepareOutputDir so
// every tool fails fast on a read-only output directory instead of
// after a render. The name is unique per call (pid + random) so two
// concurrent runs never collide on the same probe file.
async function assertOutputWritable(dirAbs) {
  const probe = path.join(dirAbs, `.mediakit-write-test-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(probe, "mediakit writability probe");
  } catch {
    throw new MediaKitError(`output directory is not writable: ${dirAbs}`, "OUTPUT_NOT_WRITABLE");
  }
  await rm(probe, { force: true }).catch(() => {});
}

export async function fileInfo(p) {
  const s = await stat(p);
  return { path: p, size_bytes: s.size, size_human: humanSize(s.size) };
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function num(v, label, { min = null, max = null, integer = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new MediaKitError(`${label} must be a number, got: ${v}`, "INVALID_ARG");
  if (integer && !Number.isInteger(n)) throw new MediaKitError(`${label} must be an integer, got: ${v}`, "INVALID_ARG");
  if (min !== null && n < min) throw new MediaKitError(`${label} must be >= ${min}, got: ${v}`, "INVALID_ARG");
  if (max !== null && n > max) throw new MediaKitError(`${label} must be <= ${max}, got: ${v}`, "INVALID_ARG");
  return n;
}

/**
 * Parse a time value: a number (seconds) or a string "SS", "MM:SS" or
 * "HH:MM:SS". (video-creator/ffmpeg-mcp accepts the same colon forms
 * for clip times; agents write "1:30" far more often than "90".)
 */
export function parseTime(v, label) {
  if (typeof v === "number") return num(v, label, { min: 0 });
  if (typeof v !== "string" || !v.trim()) {
    throw new MediaKitError(`${label} must be a time (seconds or MM:SS), got: ${v}`, "INVALID_ARG");
  }
  const parts = v.trim().split(":").map((p) => p.trim());
  if (parts.length > 3 || parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) {
    throw new MediaKitError(`${label} must be seconds or MM:SS / HH:MM:SS, got: ${v}`, "INVALID_ARG");
  }
  let s = 0;
  for (const n of parts.map(Number)) s = s * 60 + n;
  if (!Number.isFinite(s) || s < 0) throw new MediaKitError(`${label} must be >= 0, got: ${v}`, "INVALID_ARG");
  return s;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- probe

export async function probe(input) {
  const inPath = await requireInput(input);
  const { stdout } = await run(FFPROBE, [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", inPath,
  ]);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new MediaKitError("ffprobe returned unparseable output", "PROBE_FAILED");
  }
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const duration = parseFloat(data.format?.duration ?? video?.duration ?? audio?.duration ?? NaN);
  const rotation = video ? parseRotation(video) : null;
  // Display size is what a player shows: a phone clip coded 1920x1080
  // with a 90-degree display matrix is a 1080x1920 vertical video.
  // Only 90/270 swap the axes; other angles keep the coded size.
  const displayWidth = video ? ((rotation === 90 || rotation === 270) ? video.height : video.width) : null;
  const displayHeight = video ? ((rotation === 90 || rotation === 270) ? video.width : video.height) : null;
  return {
    input: inPath,
    format: data.format?.format_name ?? null,
    duration_seconds: Number.isFinite(duration) ? +duration.toFixed(3) : null,
    size_bytes: Number(data.format?.size ?? 0) || null,
    bit_rate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
    video: video ? {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      rotation,
      display_width: displayWidth,
      display_height: displayHeight,
      fps: video.r_frame_rate ? evalFps(video.r_frame_rate) : null,
      pixel_format: video.pix_fmt ?? null,
      time_base: video.time_base ?? null,
      bit_rate: numOrNull(video.bit_rate),
    } : null,
    audio: audio ? {
      codec: audio.codec_name,
      sample_rate: audio.sample_rate ? Number(audio.sample_rate) : null,
      channels: audio.channels ?? null,
      bit_rate: numOrNull(audio.bit_rate),
    } : null,
    streams: (data.streams ?? []).map((s) => ({ index: s.index, type: s.codec_type, codec: s.codec_name })),
  };
}

function evalFps(rate) {
  const [a, b] = String(rate).split("/").map(Number);
  if (!a || !b) return null;
  return +(a / b).toFixed(3);
}

// Display dims are what the viewer sees — and what ffmpeg's filters
// see, because decode autorotates by default: a phone clip stored
// 1280x720 with a 90-degree matrix is a 720x1280 frame to every
// filter. Geometry validation (crop rect, reframe window, resize
// preset fit) must use these, never the coded width/height:
// validating against coded dims rejects rects that are valid on
// screen and accepts rects ffmpeg then refuses ("Invalid too big ...
// for width '1280'"). Returns null when there is no video stream.
function displayDims(meta) {
  const v = meta?.video;
  if (!v) return null;
  return {
    width: v.display_width ?? v.width,
    height: v.display_height ?? v.height,
    rotation: v.rotation ?? null,
    stored_width: v.width,
    stored_height: v.height,
  };
}

// Rotation a viewer sees, in clockwise degrees (0/90/180/270), or
// null when the file carries no rotation metadata. Two sources, in
// order: the Display Matrix side data ffprobe reports for phone files
// (its `rotation` is counter-clockwise, so flip the sign), then the
// `rotate` stream tag (already clockwise). A file with no rotation
// returns null, not 0 — "no metadata" and "explicitly upright" are
// the same picture, and null keeps the probe output honest about
// what was actually measured.
function parseRotation(video) {
  let deg = null;
  const matrix = (video.side_data_list ?? []).find(
    (s) => s.side_data_type === "Display Matrix" && typeof s.rotation === "number");
  if (matrix) deg = -matrix.rotation;
  else if (video.tags?.rotate !== undefined && video.tags.rotate !== null) deg = Number(video.tags.rotate);
  if (deg === null || !Number.isFinite(deg)) return null;
  const norm = ((Math.round(deg) % 360) + 360) % 360;
  return norm === 0 ? null : norm;
}

// ---------------------------------------------------------------- find
// Find media files by name, recursively (idea: video-creator's
// find_video_path). Pure filesystem walk + probe per match — no
// guessing, no shell. Skips hidden dirs, .git and node_modules so a
// big project tree does not take forever; symlinked dirs are not
// followed (no loop risk). Results are sorted by path so the output
// is deterministic.

const FIND_EXTENSIONS = [
  "mp4", "mov", "mkv", "webm", "avi", "m4v",
  "mp3", "wav", "m4a", "flac", "ogg", "opus",
  "png", "jpg", "jpeg", "webp", "gif",
  "srt", "vtt", "ass",
];
const FIND_SKIP_DIRS = new Set([".git", "node_modules", ".next"]);

export async function findMedia({ directory, name, extensions = null, maxResults = 20 }) {
  const dirPath = await requireInput(directory, "directory");
  const dirStat = await stat(dirPath);
  if (!dirStat.isDirectory()) throw new MediaKitError(`not a directory: ${directory}`, "INVALID_ARG");
  if (typeof name !== "string" || !name.trim()) throw new MediaKitError("name is required (substring to match, case-insensitive)", "INVALID_ARG");
  const max = num(maxResults, "max_results", { min: 1, max: 100, integer: true });
  const exts = extensions === null || extensions === undefined ? FIND_EXTENSIONS
    : String(extensions).split(",").map((e) => e.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
  if (!exts.length) throw new MediaKitError("extensions must list at least one extension", "INVALID_ARG");
  const needle = name.trim().toLowerCase();

  const paths = [];
  let skippedDirectories = 0;
  async function walk(dir, isRoot) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skippedDirectories++;
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.isSymbolicLink()) continue;
        if (!isRoot && (e.name.startsWith(".") || FIND_SKIP_DIRS.has(e.name))) continue;
        await walk(full, false);
      } else if (e.isFile()) {
        const ext = e.name.includes(".") ? e.name.split(".").pop().toLowerCase() : "";
        if (exts.includes(ext) && e.name.toLowerCase().includes(needle)) paths.push(full);
      }
    }
  }
  await walk(dirPath, true);
  paths.sort();

  const matches = [];
  for (const p of paths.slice(0, max)) {
    const entry = { path: p, size_bytes: (await stat(p)).size };
    try {
      const m = await probe(p);
      entry.duration_seconds = m.duration_seconds;
      entry.dimensions = m.video ? `${m.video.width}x${m.video.height}` : null;
      entry.video_codec = m.video?.codec ?? null;
      entry.audio_codec = m.audio?.codec ?? null;
    } catch {
      entry.probe_error = "could not probe this file";
    }
    matches.push(entry);
  }
  return {
    operation: "find", directory: dirPath, name: name.trim(), extensions: exts,
    matches, total_matches: paths.length, returned_matches: matches.length,
    truncated: paths.length > max,
    ...(skippedDirectories ? { skipped_directories: skippedDirectories } : {}),
  };
}

// ---------------------------------------------------------------- workspace resources
// MCP Resources (idea: conneroisu/vfx-mcp's videos:// URIs). The
// workspace root is MEDIAKIT_WORKDIR when set, otherwise the process
// working directory — the same root the sandbox uses when it is on.
// Unlike tools, which accept any path (sandbox permitting), resources
// are ALWAYS confined to the root: a resource URI can never address a
// file outside the workspace, even with the sandbox off. That is the
// point of a workspace-scoped resource.
const WORKSPACE_MAX_FILES = 200;

/** Workspace root + whether it comes from the MEDIAKIT_WORKDIR sandbox. */
export async function workspaceRoot() {
  const root = await workdirRoot();
  if (root) return { root, sandbox_enabled: true };
  return { root: path.resolve(process.cwd()), sandbox_enabled: false };
}

async function walkWorkspaceFiles(dir, isRoot, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.isSymbolicLink()) continue;
      if (!isRoot && (e.name.startsWith(".") || FIND_SKIP_DIRS.has(e.name))) continue;
      await walkWorkspaceFiles(full, false, out);
    } else if (e.isFile()) {
      const ext = e.name.includes(".") ? e.name.split(".").pop().toLowerCase() : "";
      if (FIND_EXTENSIONS.includes(ext)) out.push(full);
    }
  }
}

/** `videos://list`: every media file under the root, sorted, capped — no probe, so it stays fast. */
export async function listWorkspaceFiles({ maxFiles = WORKSPACE_MAX_FILES } = {}) {
  const { root, sandbox_enabled } = await workspaceRoot();
  const paths = [];
  await walkWorkspaceFiles(root, true, paths);
  paths.sort();
  const truncated = paths.length > maxFiles;
  const files = [];
  for (const p of paths.slice(0, maxFiles)) {
    files.push({
      path: path.relative(root, p).split(path.sep).join("/"),
      size_bytes: (await stat(p)).size,
      extension: p.split(".").pop().toLowerCase(),
    });
  }
  return {
    resource: "videos://list",
    root,
    sandbox_enabled,
    files,
    count: files.length,
    total_files: paths.length,
    truncated,
    max_files: maxFiles,
  };
}

/** `videos://workspace/info`: root, versions, tool availability, media count, GPU state. */
export async function workspaceInfo() {
  const { root, sandbox_enabled } = await workspaceRoot();
  const [doc, listing] = await Promise.all([doctor(), listWorkspaceFiles()]);
  const tools = Object.values(doc.tools ?? {});
  return {
    resource: "videos://workspace/info",
    root,
    sandbox_enabled,
    ffmpeg_version: doc.ffmpeg_version,
    ffprobe_version: doc.ffprobe_version,
    node_version: doc.node_version,
    platform: doc.platform,
    tools_total: tools.length,
    tools_available: tools.filter((t) => t.available).length,
    media_files: listing.total_files,
    media_files_truncated: listing.truncated,
    gpu: doc.gpu ?? null,
  };
}

// Resolve a resource-relative path inside the workspace root. Always
// confined: lexical `..` / absolute paths are refused, and a symlink
// inside the root pointing outside is refused too (same
// nearest-ancestor realpath walk as the sandbox, but against the
// workspace root even when MEDIAKIT_WORKDIR is unset).
async function resolveInsideWorkspace(relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new MediaKitError("filename is required (path relative to the workspace root)", "INVALID_ARG");
  }
  const rel = relPath.trim();
  if (rel.includes("\0") || path.isAbsolute(rel) || rel.split("/").some((s) => s === "..")) {
    throw new MediaKitError(`filename escapes the workspace root: ${relPath}`, "RESOURCE_ESCAPE");
  }
  const { root } = await workspaceRoot();
  const abs = path.resolve(root, rel);
  if (!isInsideDir(root, abs)) {
    throw new MediaKitError(`filename escapes the workspace root: ${relPath}`, "RESOURCE_ESCAPE");
  }
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      if (!isInsideDir(root, real)) {
        throw new MediaKitError(`filename escapes the workspace root via symlink: ${relPath} -> ${real}`, "RESOURCE_ESCAPE");
      }
      return abs;
    } catch (err) {
      if (err instanceof MediaKitError) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      cur = parent;
    }
  }
}

/** `videos://{filename}/metadata`: probe one workspace media file by relative path. */
export async function workspaceMetadata(relPath) {
  const abs = await resolveInsideWorkspace(relPath);
  const ext = abs.includes(".") ? abs.split(".").pop().toLowerCase() : "";
  if (!FIND_EXTENSIONS.includes(ext)) {
    throw new MediaKitError(`not a media file known to this workspace (extension .${ext || "?"}): ${relPath}`, "INVALID_ARG");
  }
  const info = await probe(abs);
  const { root } = await workspaceRoot();
  return {
    resource: `videos://${relPath.trim()}/metadata`,
    relative_path: path.relative(root, abs).split(path.sep).join("/"),
    ...info,
  };
}

// ---------------------------------------------------------------- trim

// ---------------------------------------------------------------- trim
// Smart cut (idea: mifi/lossless-cut's smartcut.ts — re-encode only
// the GOP between the desired cut and the next keyframe, stream-copy
// the rest). A plain stream-copy trim whose start is NOT on a
// keyframe silently slides the cut to the previous keyframe; smart
// cut re-encodes just the head [start, nextKeyframe) at the source
// bitrate x1.2 (LosslessCut's margin for the re-encode loss, with a
// size/duration estimate when the stream bitrate is unknown, and
// CRF 18 when even that is unavailable), then stream-copies the
// tail and joins both parts with the concat demuxer. The result
// starts exactly where asked, and only a fraction of a second is
// ever re-encoded. Supported video codecs map to their ffmpeg
// encoder; anything else is refused with the codec named.
const SMART_CUT_VIDEO_ENCODERS = {
  h264: "libx264", hevc: "libx265", h265: "libx265",
  vp9: "libvpx-vp9", av1: "libsvtav1", mpeg4: "mpeg4",
};
const SMART_CUT_AUDIO_ENCODERS = {
  aac: "aac", mp3: "libmp3lame", opus: "libopus",
  vorbis: "libvorbis", flac: "flac", pcm_s16le: "pcm_s16le", ac3: "ac3",
};

// Check frames (idea: edigeh/broll-mcp's "frame-accurate cuts
// verified ±0.1s + 3 check frames", lượt 65 — AutoCut cuts by
// transcript and never verifies the cut landed; MediaKit does).
// After a video trim, compare 3 frames of the output (head /
// middle / tail) against the source frames at the REQUESTED cut
// times, using the same frameDiffMean the loopable seam check uses
// (mean abs gray diff, 0-255). A frame matches when the diff is at
// most max(5, normal_step): 5 covers re-encode noise (measured
// 0.05-0.54 on testsrc and a natural clip, vs 10.9+ for a 3.5s
// slip), and the normal_step floor covers fast content where even
// neighbouring frames differ by more than 5 — there a 1-frame slip
// is indistinguishable from re-encode noise anyway, so the check
// only rules out gross mis-cuts. Times are exact frame pts
// (idx/fps), so the trim window always contains exactly that frame. The check
// compares against the REQUESTED start, so a snap that moved the
// cut shows up as mismatched frames — while a plain stream-copy on
// ffmpeg 8.1.2 keeps the keyframe at negative pts and the content
// lands exactly, so it verifies (measured 2026-11-15: copy@0.05
// PSNR inf vs source@3.55). LIMIT: on frozen/static content every
// frame matches even a slipped cut (normal_step ~ 0) — run `motion`
// first if the source may be frozen.
const CHECK_FRAMES_BASE_THRESHOLD = 5;

async function checkTrimFrames({ inPath, outPath, requestedStart, durationActual, outMeta }) {
  if (!outMeta.video) {
    return { check_frames: null, check_frames_note: "audio-only input has no video frames to check" };
  }
  const dur = durationActual;
  if (!Number.isFinite(dur) || dur <= 0) {
    return { check_frames: null, check_frames_note: "could not measure the output duration, so no frames were checked" };
  }
  const inMeta = await probe(inPath);
  const fps = outMeta.video.fps ?? inMeta.video?.fps ?? null;
  const step = fps ? 1 / fps : 0.04;
  const srcDur = inMeta.duration_seconds;
  // Check times: exact frame pts (idx/fps, full precision — never
  // rounded to 4 decimals, or the window can slip past the frame it
  // should contain) of the second frame / middle frame / last frame,
  // deduped for short clips. The first frame is skipped: on some
  // sources it carries encoder warm-up artefacts.
  let tOuts;
  if (fps) {
    const n = Math.max(1, Math.round(dur * fps));
    const idxs = [...new Set([1, Math.floor((n - 1) / 2), n - 1].map((i) => Math.min(Math.max(i, 0), n - 1)))].sort((a, b) => a - b);
    tOuts = idxs.map((i) => i * step);
  } else {
    tOuts = [...new Set([0.05, dur / 2, dur - 0.05].map((t) => +Math.min(Math.max(t, 0), dur).toFixed(4)))].sort((a, b) => a - b);
  }
  const labels = tOuts.length === 1 ? ["middle"] : tOuts.length === 2 ? ["head", "tail"] : ["head", "middle", "tail"];
  // Baseline: how much one frame step changes on the source itself.
  const midSrc = Number.isFinite(srcDur)
    ? Math.min(Math.max(requestedStart + dur / 2, 0), Math.max(0, srcDur - 2 * step))
    : requestedStart + dur / 2;
  const normalStep = fps ? await frameDiffMean(inPath, midSrc, midSrc + step, fps) : null;
  const threshold = +(Math.max(CHECK_FRAMES_BASE_THRESHOLD, normalStep ?? 0).toFixed(2));
  const frames = [];
  let measureNote = null;
  for (let k = 0; k < tOuts.length; k++) {
    const tOut = tOuts[k];
    // Stream-copy outputs can have a ragged tail: -t stops on DTS,
    // so the last 1-3 frames near the cut can be missing even though
    // duration_actual says they should exist (measured 2026-11-15:
    // a snap cut's frames jump 8.3333 -> 8.4667). If the window is
    // empty, step back one frame at a time (max 3) and keep the
    // source time aligned to the frame actually measured.
    let diff = null; let usedTOut = tOut; let usedTSrc = requestedStart + tOut; let usedClamped = false;
    for (let back = 0; back <= 3 && diff === null; back++) {
      const t = tOut - back * step;
      if (t < 0) break;
      // Clamp the source time inside the source so the measurement
      // stays defined when the requested end runs past the source
      // (e.g. a snap whose actual end is longer than the source).
      let s = requestedStart + t;
      let c = false;
      if (Number.isFinite(srcDur) && s > srcDur - step) { s = Math.max(0, srcDur - step); c = true; }
      diff = await frameDiffMean(outPath, t, s, fps, inPath);
      if (diff !== null) { usedTOut = t; usedTSrc = s; usedClamped = c; }
    }
    if (diff === null) measureNote = `frame measurement failed at ${labels[k]} (output ${+tOut.toFixed(3)}s vs source ${+(requestedStart + tOut).toFixed(3)}s)`;
    frames.push({
      position: labels[k],
      output_time: +usedTOut.toFixed(3),
      source_time: +usedTSrc.toFixed(3),
      ...(usedClamped ? { source_time_clamped: true } : {}),
      mean_abs_diff: diff,
      matches: diff !== null && diff <= threshold,
    });
  }
  const matched = frames.filter((f) => f.matches).length;
  const result = {
    check_frames: frames,
    check_frames_match: `${matched}/${frames.length}`,
    cut_verified: frames.length > 0 && matched === frames.length,
    match_threshold: threshold,
    normal_step: normalStep,
  };
  if (normalStep !== null && normalStep < 1) {
    result.check_frames_note = `source barely changes frame-to-frame (normal_step ${normalStep}), so this check only rules out gross mis-cuts — a small slip would still match; run motion first if the source may be frozen`;
  } else if (measureNote) {
    result.check_frames_note = measureNote;
  }
  return result;
}

// Shared by trim() and smartCutTrim(): run the 3-frame check (or
// record why it was skipped) and spread the result into the trim
// result. `outMeta` is the output probe the caller already has;
// dry-run callers never reach here (no file exists to check).
async function withCheckFrames(base, { inPath, outPath, requestedStart, checkFrames, outMeta }) {
  if (!checkFrames) {
    return { ...base, check_frames: null, check_frames_note: "check frames skipped (check_frames=false)" };
  }
  return {
    ...base,
    ...(await checkTrimFrames({ inPath, outPath, requestedStart, durationActual: base.duration_actual ?? base.duration_seconds, outMeta })),
  };
}

async function smartCutTrim({ inPath, outPath, s, dur, dryRun = false, checkFrames = true }) {
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("smart_cut needs a video input (audio-only files cut exactly with a plain re-encode trim)", "INVALID_ARG");
  const reqEnd = s + dur;
  const kf = await listKeyframes({ input: inPath });
  const kfs = kf.keyframe_timestamps;
  if (!kfs.length) throw new MediaKitError("smart_cut found no keyframes in the input", "PROBE_FAILED");
  // Exact keyframe: no re-encode at all, plain stream copy.
  const exact = kfs.find((t) => Math.abs(t - s) < 0.001);
  if (exact !== undefined) {
    const exactArgs = ["-y", "-ss", String(s), "-i", inPath, "-t", String(dur), "-c", "copy", outPath];
    if (dryRun) {
      return {
        operation: "trim", dry_run: true, input: inPath, output: outPath,
        start: s, duration_seconds: dur, stream_copy: true,
        smart_cut: true, mode: "keyframe-exact", next_keyframe: exact, head_reencoded_seconds: 0,
        commands: [formatCommand(exactArgs)],
        note: "Dry run: no file written. The start lands exactly on a keyframe, so the plan is one stream-copy command.",
      };
    }
    await run(FFMPEG, exactArgs);
    const info = await fileInfo(outPath);
    const out = await probe(outPath);
    return withCheckFrames({
      operation: "trim", input: inPath, output: outPath,
      start: s, duration_seconds: dur, stream_copy: true,
      smart_cut: true, mode: "keyframe-exact", next_keyframe: exact, head_reencoded_seconds: 0,
      ...info, duration_actual: out.duration_seconds,
      duration_error_seconds: +(out.duration_seconds - dur).toFixed(3),
    }, { inPath, outPath, requestedStart: s, checkFrames, outMeta: out });
  }
  const nextKf = kfs.find((t) => t > s + 0.001) ?? null;
  const headDur = nextKf === null ? dur : +(nextKf - s).toFixed(3);
  const vEnc = SMART_CUT_VIDEO_ENCODERS[meta.video.codec];
  if (!vEnc) throw new MediaKitError(`smart_cut does not support video codec ${meta.video.codec} (supported: ${Object.keys(SMART_CUT_VIDEO_ENCODERS).join(", ")}) — use a plain re-encode trim instead`, "INVALID_ARG");
  // Whole request inside one GOP (or no keyframe after the start):
  // nothing to copy, re-encode the whole clip like a normal trim.
  if (nextKf === null || nextKf >= reqEnd - 0.001) {
    const aEnc = meta.audio ? (SMART_CUT_AUDIO_ENCODERS[meta.audio.codec] ?? null) : null;
    const args = ["-y", "-i", inPath, "-ss", String(s), "-t", String(dur)];
    args.push("-map", "0:v:0", "-c:v", vEnc, "-preset", "veryfast");
    args.push("-pix_fmt", meta.video.pixel_format ?? "yuv420p");
    if (meta.audio) {
      args.push("-map", "0:a:0");
      if (aEnc) args.push("-c:a", aEnc, ...audioBitrateArgs(aEnc));
      else args.push("-c:a", "copy");
    }
    args.push("-fps_mode", "passthrough", outPath);
    if (dryRun) {
      return {
        operation: "trim", dry_run: true, input: inPath, output: outPath,
        start: s, duration_seconds: dur, stream_copy: false,
        smart_cut: true, mode: "full-reencode",
        next_keyframe: nextKf, head_reencoded_seconds: dur,
        reason: nextKf === null ? "no keyframe after the requested start" : "the next keyframe is past the requested end, so the whole clip is inside one GOP",
        commands: [formatCommand(args)],
        note: "Dry run: no file written. The whole clip sits inside one GOP, so the plan is a single re-encode.",
      };
    }
    await run(FFMPEG, args);
    const info = await fileInfo(outPath);
    const out = await probe(outPath);
    return withCheckFrames({
      operation: "trim", input: inPath, output: outPath,
      start: s, duration_seconds: dur, stream_copy: false,
      smart_cut: true, mode: "full-reencode",
      next_keyframe: nextKf, head_reencoded_seconds: dur,
      reason: nextKf === null ? "no keyframe after the requested start" : "the next keyframe is past the requested end, so the whole clip is inside one GOP",
      ...info, duration_actual: out.duration_seconds,
      duration_error_seconds: +(out.duration_seconds - dur).toFixed(3),
    }, { inPath, outPath, requestedStart: s, checkFrames, outMeta: out });
  }
  // Head bitrate: stream bitrate x1.2; fall back to size/duration.
  let headBitrate = meta.video.bit_rate ? Math.floor(meta.video.bit_rate * 1.2) : null;
  if (headBitrate === null && meta.size_bytes && meta.duration_seconds) {
    headBitrate = Math.floor((meta.size_bytes * 8 / meta.duration_seconds) * 1.2);
  }
  const tailStart = nextKf;
  const tailDur = +(reqEnd - nextKf).toFixed(3);
  const ext = path.extname(outPath).slice(1).toLowerCase() || "mp4";
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediakit-smartcut-"));
  const headPath = path.join(tmpDir, `head.${ext}`);
  const tailPath = path.join(tmpDir, `tail.${ext}`);
  const listPath = path.join(tmpDir, "list.txt");
  try {
    const aEnc = meta.audio ? (SMART_CUT_AUDIO_ENCODERS[meta.audio.codec] ?? null) : null;
    const headArgs = ["-y", "-ss", String(s), "-i", inPath, "-t", String(headDur)];
    headArgs.push("-map", "0:v:0", "-c:v", vEnc, "-preset", "veryfast");
    if (headBitrate) headArgs.push("-b:v", String(headBitrate));
    else headArgs.push("-crf", "18");
    headArgs.push("-pix_fmt", meta.video.pixel_format ?? "yuv420p");
    if (meta.audio) {
      headArgs.push("-map", "0:a:0");
      if (aEnc) headArgs.push("-c:a", aEnc, ...audioBitrateArgs(aEnc));
      else headArgs.push("-c:a", "copy");
    }
    headArgs.push("-fps_mode", "passthrough", headPath);
    // Tail end cut: plain `-t` on a stream copy overshoots by up to
    // a few frames on B-frame sources (measured 2026-11-15: -t 3.5
    // gave 107 frames / 3.567s) because the stop check runs on DTS
    // while frames are stamped by PTS. The frame count is exact, so
    // cap it directly when the fps is known — measured: exactly 105
    // frames / 3.501s. The remaining +0.02s is AAC frame granularity.
    const tailArgs = ["-y", "-ss", String(tailStart), "-i", inPath, "-t", String(tailDur)];
    if (meta.video.fps) tailArgs.push("-frames:v", String(Math.max(1, Math.round(tailDur * meta.video.fps))));
    tailArgs.push("-c", "copy", tailPath);
    await writeFile(listPath, `file '${headPath}'\nfile '${tailPath}'\n`, "utf8");
    const joinArgs = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy"];
    if (["mp4", "mov", "m4v"].includes(ext)) joinArgs.push("-movflags", "+faststart");
    joinArgs.push(outPath);
    if (dryRun) {
      // The head/tail paths name a temp directory a real run creates
      // fresh each time — the three commands are otherwise exact, in
      // order: re-encode the head, stream-copy the tail, concat.
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return {
        operation: "trim", dry_run: true, input: inPath, output: outPath,
        start: s, duration_seconds: dur, stream_copy: true,
        smart_cut: true, mode: "smart-cut", next_keyframe: nextKf,
        head_reencoded_seconds: headDur,
        head_bitrate_bps: headBitrate,
        commands: [formatCommand(headArgs), formatCommand(tailArgs), formatCommand(joinArgs)],
        note: "Dry run: no file written. Three commands, in order: re-encode the head up to the next keyframe, stream-copy the tail, concat the two.",
      };
    }
    await run(FFMPEG, headArgs);
    await run(FFMPEG, tailArgs);
    await run(FFMPEG, joinArgs);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return withCheckFrames({
    operation: "trim", input: inPath, output: outPath,
    start: s, duration_seconds: dur, stream_copy: true,
    smart_cut: true, mode: "smart-cut", next_keyframe: nextKf,
    head_reencoded_seconds: headDur,
    head_bitrate_bps: headBitrate,
    ...info, duration_actual: out.duration_seconds,
    duration_error_seconds: +(out.duration_seconds - dur).toFixed(3),
  }, { inPath, outPath, requestedStart: s, checkFrames, outMeta: out });
}

export async function trim({ input, output, start = 0, duration = null, end = null, streamCopy = false, snapToKeyframe = false, smartCut = false, snapToBeat = false, snapBeatMethod = "grid", dryRun = false, checkFrames = true }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const s = parseTime(start, "start");
  let dur = null;
  if (duration !== null && duration !== undefined) dur = parseTime(duration, "duration");
  if (dur !== null && !(dur > 0)) throw new MediaKitError(`duration must be > 0, got: ${duration}`, "INVALID_ARG");
  if (end !== null && end !== undefined) {
    const e = parseTime(end, "end");
    if (e <= s) throw new MediaKitError(`end (${e}) must be greater than start (${s})`, "INVALID_ARG");
    if (dur !== null) throw new MediaKitError("pass duration OR end, not both", "INVALID_ARG");
    dur = e - s;
  }
  if (dur === null) throw new MediaKitError("trim needs duration or end", "INVALID_ARG");

  // snap_to_beat moves the cut onto the music's beat grid (measured
  // by detectBpm): start DOWN to the nearest beat at/before it, end
  // UP to the nearest beat at/after it — the same widening
  // convention as snap_to_keyframe, so a cut never loses content at
  // either edge. Unlike keyframe snap it works on re-encode cuts too
  // (the point is musical alignment, not keyframe alignment). It
  // cannot combine with snap_to_keyframe (two grids) or smart_cut
  // (which lands the start exactly by re-encoding the head) — check
  // before the smart_cut early return, or the flag would be silently
  // ignored.
  if (snapToBeat && snapToKeyframe) throw new MediaKitError("snap_to_beat and snap_to_keyframe cannot be combined (pick one grid: beats or keyframes)", "INVALID_ARG");
  if (snapToBeat && smartCut) throw new MediaKitError("snap_to_beat and smart_cut cannot be combined (smart_cut already lands the start exactly)", "INVALID_ARG");

  // smart_cut is a stream-copy cut with an exact start: it re-encodes
  // only the head up to the next keyframe. snap_to_keyframe would
  // move the cut instead of landing it exactly, so the two refuse
  // each other; and without stream_copy there is nothing to be
  // smart about (a plain re-encode trim is already frame-accurate).
  if (smartCut) {
    if (!streamCopy) throw new MediaKitError("smart_cut needs stream_copy (it is a stream-copy cut with an exact start)", "INVALID_ARG");
    if (snapToKeyframe) throw new MediaKitError("smart_cut and snap_to_keyframe cannot be combined (smart_cut already lands the start exactly)", "INVALID_ARG");
    return smartCutTrim({ inPath, outPath, s, dur, dryRun, checkFrames });
  }

  // snapToKeyframe only makes sense for stream copy: re-encode cuts are
  // already frame-accurate, and snapping them would only widen the clip.
  // Snapping moves start DOWN to the nearest keyframe at/before it and
  // end UP to the nearest keyframe at/after it, so the stream-copy cut
  // lands exactly on keyframes instead of ffmpeg's silent rounding.
  let sActual = s, durActual = dur, snapped = false, kfStart = null, kfEnd = null;
  let beatStart = null, beatEnd = null, beatBpm = null, beatConfidence = null, beatMethod = null;
  if (snapToKeyframe) {
    if (!streamCopy) throw new MediaKitError("snap_to_keyframe needs stream_copy (re-encode cuts are already frame-accurate)", "INVALID_ARG");
    const kf = await listKeyframes({ input: inPath });
    const kfs = kf.keyframe_timestamps;
    if (!kfs.length) throw new MediaKitError("snap_to_keyframe found no keyframes in the input", "PROBE_FAILED");
    const reqEnd = s + dur;
    kfStart = [...kfs].reverse().find((t) => t <= s + 1e-6) ?? 0;
    kfEnd = kfs.find((t) => t >= reqEnd - 1e-6) ?? kf.duration_seconds ?? reqEnd;
    if (kfEnd > (kf.duration_seconds ?? kfEnd)) kfEnd = kf.duration_seconds;
    if (kfEnd <= kfStart) throw new MediaKitError(`snap_to_keyframe cannot fit a clip between keyframes ${kfStart} and ${kfEnd}`, "INVALID_ARG");
    sActual = kfStart;
    durActual = +(kfEnd - kfStart).toFixed(3);
    snapped = sActual !== s || +(sActual + durActual).toFixed(3) !== +reqEnd.toFixed(3);
  }

  // Beat snap: measure the grid once (fullGrid — the whole file, not
  // the first 16 beats bpm returns), then snap the same way. An
  // unreliable grid refuses outright: a wrong grid is worse than no
  // snap, and the error names the measured confidence so the caller
  // can decide (plain trim, or a different section). A start before
  // the first beat snaps to 0 (the file start); an end past the last
  // beat snaps to the file duration.
  if (snapToBeat) {
    const grid = await detectBpm({ input: inPath, fullGrid: true, method: snapBeatMethod });
    if (!grid.reliable || !grid.beats.length) {
      throw new MediaKitError(`snap_to_beat needs a reliable beat grid — bpm measured ${grid.bpm ?? "unknown"} (confidence ${grid.confidence}, reliable: false); this audio has no steady beat, so there is nothing musical to snap to — cut with plain trim instead`, "INVALID_ARG");
    }
    const reqEnd = s + dur;
    const total = grid.duration_seconds;
    beatStart = [...grid.beats].reverse().find((t) => t <= s + 1e-6) ?? 0;
    beatEnd = grid.beats.find((t) => t >= reqEnd - 1e-6) ?? total;
    if (beatEnd > total) beatEnd = total;
    if (beatEnd <= beatStart) throw new MediaKitError(`snap_to_beat cannot fit a clip between beats ${beatStart} and ${beatEnd}`, "INVALID_ARG");
    sActual = beatStart;
    durActual = +(beatEnd - beatStart).toFixed(3);
    snapped = sActual !== s || +(sActual + durActual).toFixed(3) !== +reqEnd.toFixed(3);
    beatBpm = grid.bpm;
    beatConfidence = grid.confidence;
    beatMethod = grid.grid_method;
  }

  // -ss after -i = accurate seek (re-encode path); with stream copy we
  // put -ss before -i for fast keyframe seek.
  const args = streamCopy
    ? ["-y", "-ss", String(sActual), "-i", inPath, "-t", String(durActual), "-c", "copy", outPath]
    : ["-y", "-i", inPath, "-ss", String(sActual), "-t", String(durActual), outPath];
  if (dryRun) {
    return {
      operation: "trim", dry_run: true, input: inPath, output: outPath,
      start: sActual, duration_seconds: durActual, stream_copy: streamCopy,
      ...(snapToKeyframe ? {
        requested_start: s, requested_end: +(s + dur).toFixed(3),
        snapped, keyframe_start: kfStart, keyframe_end: kfEnd,
      } : {}),
      ...(snapToBeat ? {
        requested_start: s, requested_end: +(s + dur).toFixed(3),
        snapped, beat_start: beatStart, beat_end: beatEnd, bpm: beatBpm, beat_confidence: beatConfidence, beat_method: beatMethod,
      } : {}),
      commands: [formatCommand(args)],
      note: "Dry run: no file written. Probes (and the keyframe list for --snap) are read-only; they ran to compute the cut.",
    };
  }
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const meta = await probe(outPath);
  // The check compares against the REQUESTED start, so a snap that
  // moved the cut shows up as mismatched frames.
  return withCheckFrames({
    operation: "trim", input: inPath, output: outPath,
    start: sActual, duration_seconds: durActual, stream_copy: streamCopy,
    ...(snapToKeyframe ? {
      requested_start: s, requested_end: +(s + dur).toFixed(3),
      snapped, keyframe_start: kfStart, keyframe_end: kfEnd,
    } : {}),
    ...(snapToBeat ? {
      requested_start: s, requested_end: +(s + dur).toFixed(3),
      snapped, beat_start: beatStart, beat_end: beatEnd, bpm: beatBpm, beat_confidence: beatConfidence, beat_method: beatMethod,
    } : {}),
    ...info, duration_actual: meta.duration_seconds,
  }, { inPath, outPath, requestedStart: s, checkFrames, outMeta: meta });
}

// ---------------------------------------------------------------- fit
// Fit a file to an exact target duration. Three methods:
//   speed — speed the video/audio up or down (setpts + chained atempo),
//           the default: keeps the whole clip, just faster/slower.
//   trim  — cut a longer source down to the target (re-encode, exact).
//   loop  — loop a shorter source until it reaches the target, then cut.
// The output duration is measured with ffprobe and reported, so the
// caller verifies the fit instead of trusting the arithmetic.
// Speed factor = source/target must stay in [0.25, 4]: outside that,
// atempo chains get long and quality falls apart — the error says which
// other method to use.

const FIT_METHODS = ["speed", "trim", "loop"];

/** Split a speed factor into atempo steps, each inside [0.5, 2.0]. */
function atempoChain(factor) {
  const steps = [];
  let f = factor;
  while (f > 2.0) { steps.push(2.0); f /= 2; }
  while (f < 0.5) { steps.push(0.5); f /= 0.5; }
  steps.push(+f.toFixed(4));
  return steps.map((s) => `atempo=${s}`).join(",");
}

export async function fitDuration({ input, output, duration, method = "speed", maxFps = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const target = parseTime(duration, "duration");
  if (!(target > 0)) throw new MediaKitError(`duration must be > 0, got: ${duration}`, "INVALID_ARG");
  if (!FIT_METHODS.includes(method)) {
    throw new MediaKitError(`unknown fit method: ${method} (use ${FIT_METHODS.join(", ")})`, "INVALID_ARG");
  }
  const maxF = maxFps === null || maxFps === undefined ? null : num(maxFps, "max_fps", { min: 1, max: 120, integer: true });
  const meta = await probe(inPath);
  const srcDur = meta.duration_seconds;
  if (srcDur === null) throw new MediaKitError("fit needs an input with a known duration", "PROBE_FAILED");
  // Cap the output fps only when it actually lowers it: asking for 60 on
  // a 30fps source must not duplicate frames up to 60. Compare against
  // the EFFECTIVE fps, not the source fps — a 2x speed-up turns 30fps
  // into 60fps, so max_fps 30 on a 2x fit must still cap. Audio-only
  // input has no video chain, so max_fps is ignored there (fps_capped false).
  const srcFps = meta.video?.fps ?? null;
  const factor = srcDur / target; // >1 = speed up, <1 = slow down
  const effFps = srcFps === null ? null : (method === "speed" ? srcFps * factor : srcFps);
  const capFps = (maxF !== null && meta.video && (effFps === null || maxF < effFps)) ? maxF : null;
  const ext = path.extname(outPath).slice(1).toLowerCase();
  const audioCodec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext] ?? "aac";

  let args;
  let applied;
  if (method === "speed") {
    if (factor < 0.25 || factor > 4) {
      throw new MediaKitError(
        `speed fit needs a factor in [0.25, 4] (source ${srcDur}s to ${target}s is ${factor.toFixed(2)}x) — use method=trim to cut a longer source, or method=loop to extend a shorter one`,
        "INVALID_ARG");
    }
    applied = { method: "speed", speed_factor: +factor.toFixed(3) };
    const f = +factor.toFixed(4);
    args = ["-y", "-i", inPath];
    const filters = [];
    if (meta.video) filters.push(`[0:v]setpts=PTS/${f}${capFps ? `,fps=${capFps}` : ""}[v]`);
    if (meta.audio) filters.push(`[0:a]${atempoChain(f)}[a]`);
    if (filters.length) args.push("-filter_complex", filters.join(";"));
    if (meta.video) args.push("-map", "[v]", "-c:v", "libx264", "-crf", "18", "-preset", "veryfast");
    if (meta.audio) args.push("-map", "[a]", "-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
    // -fps_mode passthrough: without it, ffmpeg's default CFR resampling
    // duplicates frames back onto the source fps grid (300 frames at 2x
    // came out as 152 frames / 5.067s instead of 5.0s). -t trims the
    // AAC encoder padding tail so the measured duration lands on target.
    args.push("-fps_mode", "passthrough", "-t", String(target), outPath);
  } else if (method === "trim") {
    if (srcDur <= target) {
      throw new MediaKitError(`trim fit needs a longer source (${srcDur}s <= target ${target}s) — use method=speed or method=loop`, "INVALID_ARG");
    }
    applied = { method: "trim" };
    args = ["-y", "-i", inPath, "-t", String(target)];
    if (capFps) args.push("-vf", `fps=${capFps}`);
    if (meta.video) args.push("-c:v", "libx264", "-crf", "18", "-preset", "veryfast");
    if (meta.audio) args.push("-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
    args.push(outPath);
  } else { // loop
    if (srcDur >= target) {
      throw new MediaKitError(`loop fit needs a shorter source (${srcDur}s >= target ${target}s) — use method=speed or method=trim`, "INVALID_ARG");
    }
    applied = { method: "loop", loops: Math.ceil(target / srcDur) };
    args = ["-y", "-stream_loop", "-1", "-i", inPath, "-t", String(target)];
    if (capFps) args.push("-vf", `fps=${capFps}`);
    if (meta.video) args.push("-c:v", "libx264", "-crf", "18", "-preset", "veryfast");
    if (meta.audio) args.push("-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
    args.push(outPath);
  }
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const actual = out.duration_seconds;
  return {
    operation: "fit", input: inPath, output: outPath,
    source_duration_seconds: srcDur, target_duration_seconds: target,
    ...applied, ...info,
    duration_actual: actual,
    duration_error_seconds: actual === null ? null : +(actual - target).toFixed(3),
    max_fps: maxF, fps_capped: capFps !== null,
    fps: out.video ? out.video.fps : null,
  };
}

// ---------------------------------------------------------------- crop

export async function crop({ input, output, width, height, x = 0, y = 0, dryRun = false }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const w = num(width, "width", { min: 2, integer: true });
  const h = num(height, "height", { min: 2, integer: true });
  const cx = num(x, "x", { min: 0, integer: true });
  const cy = num(y, "y", { min: 0, integer: true });
  const meta = await probe(inPath);
  // Validate against display dims: the crop filter sees the
  // autorotated frame, so a rect valid in stored pixels but wider
  // than the display frame is refused by ffmpeg itself.
  const disp = displayDims(meta);
  if (disp && (cx + w > disp.width || cy + h > disp.height)) {
    const stored = disp.rotation ? ` (stored ${disp.stored_width}x${disp.stored_height}, rotation ${disp.rotation})` : "";
    throw new MediaKitError(`crop ${w}x${h}+${cx}+${cy} exceeds display ${disp.width}x${disp.height}${stored}`, "INVALID_ARG");
  }
  const args = ["-y", "-i", inPath, "-vf", `crop=${w}:${h}:${cx}:${cy}`, "-c:a", "copy", outPath];
  if (dryRun) {
    return {
      operation: "crop", dry_run: true, input: inPath, output: outPath,
      width: w, height: h, x: cx, y: cy,
      source_dimensions: disp ? `${disp.width}x${disp.height}` : null,
      source_rotation: disp?.rotation ?? null,
      dimensions: `${w}x${h}`,
      commands: [formatCommand(args)],
      note: "Dry run: no file written.",
    };
  }
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "crop", input: inPath, output: outPath, width: w, height: h, x: cx, y: cy, source_dimensions: disp ? `${disp.width}x${disp.height}` : null, source_rotation: disp?.rotation ?? null, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
}

// ---------------------------------------------------------------- resize

// Named resolution presets: the box the frame must fit inside,
// preserving aspect ratio. "720p" on a 1280x720 source is already a
// fit (no upscale — upscaling adds no detail, only bytes).
export const RESIZE_PRESETS = {
  "360p": [640, 360],
  "480p": [854, 480],
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "2160p": [3840, 2160],
};

export async function resize({ input, output, width = null, height = null, keepAspect = true, preset = null, dryRun = false }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  if (preset !== null && preset !== undefined) {
    if (width !== null || height !== null) {
      throw new MediaKitError("resize --preset cannot be combined with --width/--height", "INVALID_ARG");
    }
    if (!keepAspect) {
      throw new MediaKitError("resize --preset keeps the aspect ratio; --no-keep-aspect is not compatible with it", "INVALID_ARG");
    }
    const box = RESIZE_PRESETS[preset];
    if (!box) {
      throw new MediaKitError(`unknown resize preset: ${preset} (supported: ${Object.keys(RESIZE_PRESETS).join(", ")})`, "INVALID_ARG");
    }
    const meta = await probe(inPath);
    if (!meta.video) throw new MediaKitError("resize needs a video stream", "INVALID_ARG");
    const [boxW, boxH] = box;
    // Fit the DISPLAY frame in the box: on a rotated clip the decoded
    // frame is portrait while the stored pixels are landscape, so
    // fitting coded dims would scale a 720x1280 frame to 1280x720 —
    // a stretched picture, not a fit.
    const disp = displayDims(meta);
    const srcW = disp.width, srcH = disp.height;
    // Fit inside the box, never upscale; round to even (x264 yuv420p).
    const factor = Math.min(boxW / srcW, boxH / srcH, 1);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const tw = even(srcW * factor), th = even(srcH * factor);
    const presetArgs = ["-y", "-i", inPath, "-vf", `scale=${tw}:${th}`, "-c:a", "copy", outPath];
    if (dryRun) {
      return {
        operation: "resize", dry_run: true, input: inPath, output: outPath, preset,
        preset_box: `${boxW}x${boxH}`, scaled_down: factor < 1,
        source_dimensions: `${srcW}x${srcH}`,
        source_rotation: disp.rotation,
        dimensions: `${tw}x${th}`,
        commands: [formatCommand(presetArgs)],
        note: "Dry run: no file written.",
      };
    }
    await run(FFMPEG, presetArgs);
    const info = await fileInfo(outPath);
    const out = await probe(outPath);
    return {
      operation: "resize", input: inPath, output: outPath, preset,
      preset_box: `${boxW}x${boxH}`, scaled_down: factor < 1,
      source_dimensions: `${srcW}x${srcH}`,
      source_rotation: disp.rotation, ...info,
      dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    };
  }
  if (width === null && height === null) {
    throw new MediaKitError("resize needs width and/or height (or --preset)", "INVALID_ARG");
  }
  const w = width === null ? null : num(width, "width", { min: 2, integer: true });
  const h = height === null ? null : num(height, "height", { min: 2, integer: true });
  // -2 keeps aspect ratio and rounds to an even number (required by
  // most codecs, e.g. libx264 yuv420p).
  let scale;
  if (keepAspect) {
    scale = `scale=${w ?? -2}:${h ?? -2}`;
  } else {
    if (w === null || h === null) throw new MediaKitError("keep_aspect=false needs both width and height", "INVALID_ARG");
    scale = `scale=${w}:${h}`;
  }
  const plainArgs = ["-y", "-i", inPath, "-vf", scale, "-c:a", "copy", outPath];
  if (dryRun) {
    return {
      operation: "resize", dry_run: true, input: inPath, output: outPath,
      width: w, height: h, keep_aspect: keepAspect,
      scale_filter: scale,
      commands: [formatCommand(plainArgs)],
      note: "Dry run: no file written.",
    };
  }
  await run(FFMPEG, plainArgs);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "resize", input: inPath, output: outPath, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
}

// ---------------------------------------------------------------- extract_audio

const AUDIO_FORMATS = { mp3: "libmp3lame", aac: "aac", m4a: "aac", wav: "pcm_s16le", ogg: "libvorbis", opus: "libopus", flac: "flac" };

export async function extractAudio({ input, output, format = null, whisper = false, channel = null }) {
  const inPath = await requireInput(input);
  // --whisper forces the Whisper ASR preset (16 kHz mono WAV) and
  // renames the output to .wav when needed; the real output path is
  // reported back, so the caller never has to guess where it went.
  let outArg = output;
  if (whisper) {
    const parsed = path.parse(String(output));
    outArg = path.format({ dir: parsed.dir, name: parsed.name, ext: ".wav" });
  }
  const outPath = await prepareOutput(outArg, [inPath]);
  const ext = whisper ? "wav" : (format || path.extname(outPath).slice(1) || "mp3").toLowerCase();
  const codec = AUDIO_FORMATS[ext];
  if (!codec) throw new MediaKitError(`unsupported audio format: ${ext} (supported: ${Object.keys(AUDIO_FORMATS).join(", ")})`, "INVALID_ARG");
  // --channel N picks one channel out of a multi-channel input
  // (matthensleyio/FFMpeg.MCP's extract_audio_channel idea) and
  // returns it as mono — e.g. the left mic of a stereo interview.
  // Validated against the probed channel count, never assumed.
  let channelIdx = null;
  if (channel !== null && channel !== undefined) {
    channelIdx = num(channel, "channel", { integer: true, min: 0, max: 63 });
    const inMeta = await probe(inPath);
    const ch = inMeta.audio ? inMeta.audio.channels : null;
    if (ch === null) {
      throw new MediaKitError("extract_audio --channel needs an input with an audio stream", "INVALID_ARG");
    }
    if (channelIdx >= ch) {
      throw new MediaKitError(`extract_audio --channel ${channelIdx} is out of range: the input has ${ch} channel(s) (0-based)`, "INVALID_ARG");
    }
  }
  const args = ["-y", "-i", inPath, "-vn"];
  if (channelIdx !== null) args.push("-af", `pan=mono|c0=c${channelIdx}`);
  args.push("-c:a", codec, ...audioBitrateArgs(codec));
  if (whisper) args.push("-ar", "16000", "-ac", "1");
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "extract_audio", input: inPath, output: outPath, format: ext, codec, ...info,
    duration_seconds: out.duration_seconds,
    sample_rate_hz: out.audio ? out.audio.sample_rate : null,
    channels: out.audio ? out.audio.channels : null,
    ...(whisper ? { whisper_preset: true } : {}),
    ...(channelIdx !== null ? { channel: channelIdx } : {}),
  };
}

// ---------------------------------------------------------------- frame capture
// One frame at one exact timestamp, the vcsi accurate-seek way:
// input-seek to at most 2s before the target (lands on a keyframe),
// then output-seek the rest — the decoder walks forward to the real
// frame at t instead of handing back the keyframe before t (what a
// bare `-ss t -i` does) or whatever frame the `fps` filter's rounding
// lands on (lượt 69 probe: `frames --count 2` on a 25.878s film
// reported frame-002 at 12.939s but its pixels were shot 3, ~24s —
// PSNR 15.0 vs the true 12.939s frame). The capture is the first
// frame at-or-after t (frames only exist at discrete PTS, so a t
// between two frames lands on the later one — e.g. 5.019s on a
// 30fps clip is the 5.033s frame, not the 5.000s one). Every
// frame-grabbing tool below goes through this helper, so a reported
// timestamp is the frame's real timestamp. `labelFile` is a text file drawtext reads
// (avoids inline-text escaping); the caller owns the file.

function prettyTimestamp(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

async function captureFrameAt(inPath, t, outPath, { width = null, labelFile = null } = {}) {
  const pre = Math.min(2, t);
  const post = +(t - pre).toFixed(3);
  const vf = [];
  if (width !== null) vf.push(`scale=${width}:-2`);
  if (labelFile) {
    const esc = labelFile.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const fs = Math.max(12, Math.round((width ?? 320) / 16));
    vf.push(`drawtext=fontfile=${TITLECARD_FONT}:textfile=${esc}:fontsize=${fs}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4:x=8:y=8`);
  }
  const args = ["-y", "-ss", String(pre), "-i", inPath, "-ss", String(post), "-frames:v", "1"];
  if (vf.length) args.push("-vf", vf.join(","));
  args.push("-q:v", "2", outPath);
  await run(FFMPEG, args);
}

// ---------------------------------------------------------------- sharpness
// Sharpness of one still image: the mean of the Laplacian — the
// classic variance-of-Laplacian focus measure, as a mean because
// ffmpeg has no `laplacian` filter (the 3x3 kernel
// 0 -1 0 / -1 4 -1 / 0 -1 0 IS the Laplacian, applied with
// `convolution`). `edgedetect` is a poor substitute: it barely moves
// under mild blur (1.263 -> 1.177 at boxblur=1 on testsrc2), while
// the Laplacian mean drops 1.85 -> 0.31 -> 0.17 -> 0.11 at boxblur
// 1/2/5 — monotonic in blur, ~6x for a light blur, ~15x for a heavy
// one. The score is only comparable between frames of the SAME video
// measured at the SAME probe width, never across videos. Flat-colour
// frames score ~0 (no edges at all) — a tie keeps the earliest
// candidate, which is the right behaviour when nothing is sharper
// than anything else.
const LAPLACIAN_KERNEL = "0 -1 0 -1 4 -1 0 -1 0:0 -1 0 -1 4 -1 0 -1 0";

async function measureSharpness(imagePath) {
  const { stderr } = await run(FFMPEG, [
    "-hide_banner", "-nostats", "-i", imagePath,
    "-vf", `format=gray,convolution=${LAPLACIAN_KERNEL},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    "-frames:v", "1", "-f", "null", "-",
  ]);
  const m = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
  if (!m) throw new MediaKitError(`could not measure sharpness of ${imagePath}`, "MEASURE_FAILED");
  return +(+m[1]).toFixed(4);
}

// Pick the sharpest frame inside [winStart, winEnd): sample
// `samples` candidate timestamps at sub-window midpoints, capture
// each at probe width (320px — the score is relative, so the probe
// width only has to be constant), measure, keep the max. Ties keep
// the earliest candidate. Returns the winning timestamp + score;
// the caller re-captures the winner at full width for the output.
async function pickSharpestFrame(inPath, winStart, winEnd, samples, tmpDir) {
  const span = winEnd - winStart;
  let best = null;
  for (let j = 0; j < samples; j++) {
    const t = +(winStart + ((j + 0.5) * span) / samples).toFixed(3);
    const candPath = path.join(tmpDir, `sharp-${String(j).padStart(2, "0")}.png`);
    await captureFrameAt(inPath, t, candPath, { width: 320 });
    const sharpness = await measureSharpness(candPath);
    if (best === null || sharpness > best.sharpness) best = { timestamp: t, sharpness };
  }
  return best;
}

// ---------------------------------------------------------------- extract_frame

export async function extractFrame({ input, output, timestamp = 0 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const t = num(timestamp, "timestamp", { min: 0 });
  const ext = path.extname(outPath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    throw new MediaKitError(`frame output must be .png/.jpg/.webp, got ${ext || "(no extension)"}`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("extract_frame needs a video input", "INVALID_ARG");
  if (meta.duration_seconds !== null && t >= meta.duration_seconds) {
    throw new MediaKitError(`timestamp ${t}s is at/past the end of the file (${meta.duration_seconds}s)`, "INVALID_ARG");
  }
  await captureFrameAt(inPath, t, outPath);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "extract_frame", input: inPath, output: outPath, timestamp: t, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
}

// ---------------------------------------------------------------- thumbnail

export async function thumbnail({ input, output, frames = 6, columns = 3, width = 320, timestamps = true, startDelayPercent = 0, endDelayPercent = 0, header = false, timestampsList = null, sharpest = false, sharpestSamples = 5 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const cols = num(columns, "columns", { min: 1, max: 8, integer: true });
  const w = num(width, "width", { min: 80, max: 1280, integer: true });
  const showTs = timestamps !== false;
  const showHeader = header === true;
  const wantSharpest = sharpest === true;
  const samples = wantSharpest ? num(sharpestSamples, "sharpest_samples", { min: 2, max: 16, integer: true }) : 5;
  const startDelay = num(startDelayPercent, "start_delay_percent", { min: 0, max: 90 });
  const endDelay = num(endDelayPercent, "end_delay_percent", { min: 0, max: 90 });
  const manual = timestampsList !== null && timestampsList !== undefined;
  if (manual && (startDelay || endDelay)) {
    throw new MediaKitError("timestamps_list cannot be combined with start_delay_percent / end_delay_percent — the list already fixes every tile time", "INVALID_ARG");
  }
  if (!manual && startDelay + endDelay >= 100) {
    throw new MediaKitError(`start_delay_percent (${startDelay}) + end_delay_percent (${endDelay}) must leave a window to sample`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("thumbnail needs a video input", "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (duration === null || duration <= 0) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  // Manual timestamps (vcsi `-m` idea): the caller names every tile
  // time — seconds or MM:SS each — instead of even spacing. The list
  // sets the tile count; `frames` is ignored. Times are used in the
  // order given (the sheet order is the caller's order), each must
  // sit inside the file.
  let list = null;
  if (manual) {
    const raw = Array.isArray(timestampsList) ? timestampsList : [timestampsList];
    if (raw.length < 1 || raw.length > 64) {
      throw new MediaKitError(`timestamps_list needs 1-64 timestamps, got ${raw.length}`, "INVALID_ARG");
    }
    list = raw.map((v, i) => parseTime(v, `timestamps_list[${i}]`));
    for (const t of list) {
      if (t >= duration) {
        throw new MediaKitError(`timestamp ${t}s is at/past the end of the file (${duration}s)`, "INVALID_ARG");
      }
    }
  }
  const n = list ? list.length : num(frames, "frames", { min: 1, max: 64, integer: true });
  const rows = Math.ceil(n / cols);
  const winStart = duration * startDelay / 100;
  const winEnd = duration * (1 - endDelay / 100);
  const baseTimes = list ?? Array.from({ length: n }, (_, i) => +((winStart + (i * (winEnd - winStart)) / n).toFixed(3)));
  // Each tile is captured at its own exact timestamp (captureFrameAt),
  // labelled with that timestamp in MM:SS.d — never with %{pts}, whose
  // value follows the filter's frame-picking, not the reported time.
  // Tiles are PNGs in a temp dir, then tiled in one pass; a partial
  // last row is padded with black tiles so `tile` always sees a full
  // grid (it only emits on a complete grid or at EOF — padding keeps
  // both paths identical).
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediakit-thumbnail-"));
  let headerLines = null;
  let tileTimes = baseTimes;
  let sharpness = null;
  try {
    // With --sharpest each tile is the sharpest frame in its window:
    // the window starts at the tile's nominal time and runs to the
    // next tile's time (the last window runs to the end of the file
    // for a manual list, or to the end of the sampling window). The
    // tile label shows the picked time, and the result reports the
    // sharpness of every tile.
    if (wantSharpest) {
      sharpness = [];
      tileTimes = [];
      for (let i = 0; i < n; i++) {
        const wEnd = i + 1 < n ? baseTimes[i + 1] : (list ? duration : winEnd);
        const pick = await pickSharpestFrame(inPath, baseTimes[i], wEnd, samples, tmpDir);
        tileTimes.push(pick.timestamp);
        sharpness.push(pick.sharpness);
      }
    }
    const cells = cols * rows;
    for (let i = 0; i < n; i++) {
      const tilePath = path.join(tmpDir, `tile-${String(i + 1).padStart(3, "0")}.png`);
      let labelFile = null;
      if (showTs) {
        labelFile = path.join(tmpDir, `label-${i}.txt`);
        await writeFile(labelFile, prettyTimestamp(tileTimes[i]), "utf8");
      }
      await captureFrameAt(inPath, tileTimes[i], tilePath, { width: w, labelFile });
    }
    if (n < cells) {
      for (let i = n; i < cells; i++) {
        const black = path.join(tmpDir, `tile-${String(i + 1).padStart(3, "0")}.png`);
        const first = path.join(tmpDir, "tile-001.png");
        const size = await probe(first);
        await run(FFMPEG, ["-y", "-f", "lavfi", "-i", `color=c=black:s=${size.video.width}x${size.video.height}:d=0.1`, "-frames:v", "1", black]);
      }
    }
    // Tile into a temp sheet first: with a header the sheet is stacked
    // under a metadata band, so the final file is written afterwards.
    const sheetPath = path.join(tmpDir, "sheet.png");
    await run(FFMPEG, ["-y", "-framerate", "1", "-i", path.join(tmpDir, "tile-%03d.png"), "-vf", `tile=${cols}x${rows}`, "-frames:v", "1", "-q:v", "2", sheetPath]);
    if (showHeader) {
      // Header band (vcsi-style): filename + measured duration +
      // resolution/fps + codecs + size + grid, painted as text on a
      // dark strip above the tiles so a forwarded sheet still says
      // which file it came from. Text goes through a textfile (never
      // inline) so `|` and spaces need no escaping.
      const sheetMeta = await probe(sheetPath);
      const base = path.basename(inPath);
      const shown = base.length > 40 ? `${base.slice(0, 37)}...` : base;
      const fpsBit = meta.video.fps !== null ? ` | ${meta.video.fps} fps` : "";
      const audioBit = meta.audio ? ` | audio ${meta.audio.codec} ${meta.audio.channels ?? "?"}ch` : " | no audio";
      const sizeBit = meta.size_bytes !== null ? ` | ${(meta.size_bytes / (1024 * 1024)).toFixed(1)} MB` : "";
      headerLines = [
        `${shown} | ${duration}s | ${meta.video.width}x${meta.video.height}${fpsBit}`,
        `video ${meta.video.codec}${audioBit}${sizeBit} | ${n} frames ${cols}x${rows}`,
      ];
      const headerPath = path.join(tmpDir, "header.png");
      const headerFile = path.join(tmpDir, "header.txt");
      await writeFile(headerFile, headerLines.join("\n"), "utf8");
      const headerH = 68;
      const esc = headerFile.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
      await run(FFMPEG, ["-y", "-f", "lavfi", "-i", `color=c=0x111111:s=${sheetMeta.video.width}x${headerH}:d=0.1`,
        "-vf", `drawtext=fontfile=${TITLECARD_FONT}:textfile=${esc}:fontsize=20:fontcolor=white:line_spacing=8:x=12:y=10`,
        "-frames:v", "1", headerPath]);
      await run(FFMPEG, ["-y", "-i", headerPath, "-i", sheetPath, "-filter_complex", "[0:v][1:v]vstack", "-frames:v", "1", "-q:v", "2", outPath]);
    } else {
      await copyFile(sheetPath, outPath);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "thumbnail", input: inPath, output: outPath, frames: n, columns: cols, rows,
    timestamps: showTs,
    ...(showTs ? { timestamps_seconds: tileTimes } : {}),
    ...(showHeader ? { header: true, header_lines: headerLines } : {}),
    ...(list
      ? { manual_timestamps: true }
      : {
          window_seconds: { start: +winStart.toFixed(3), end: +winEnd.toFixed(3) },
          ...(startDelay || endDelay ? { start_delay_percent: startDelay, end_delay_percent: endDelay } : {}),
        }),
    ...(wantSharpest ? { sharpest: true, sharpest_samples: samples, sharpness } : {}),
    ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

// ---------------------------------------------------------------- frames
// Extract N evenly spaced frames as separate image files, so an agent
// can actually LOOK at a video (ffmpeg-mcp's extract_frames idea):
// one capture per timestamp, one file per frame, each with its
// timestamp — and the timestamp is now the frame's real time (see
// captureFrameAt), not the fps filter's guess.
// Output is a directory; files are frame-001.png, frame-002.png, ...
// Format tip: for screen recordings or any text-heavy footage use png
// (default) or webp, not jpg — JPEG chroma subsampling smears 1px
// text and thin borders, so a jpg frame can look broken when the
// video itself is fine.

export async function extractFrames({ input, outputDir, count = 6, format = "png", width = null, sharpest = false, sharpestSamples = 5 }) {
  const inPath = await requireInput(input);
  const n = num(count, "count", { min: 1, max: 120, integer: true });
  const wantSharpest = sharpest === true;
  const samples = wantSharpest ? num(sharpestSamples, "sharpest_samples", { min: 2, max: 16, integer: true }) : 5;
  const fmt = (format || "png").toLowerCase();
  if (!["png", "jpg", "jpeg", "webp"].includes(fmt)) {
    throw new MediaKitError(`frames format must be png/jpg/webp, got: ${format}`, "INVALID_ARG");
  }
  const ext = fmt === "jpg" ? "jpg" : fmt;
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new MediaKitError("output directory is required", "INVALID_OUTPUT");
  }
  const rawDir = path.resolve(outputDir);
  if (rawDir === inPath || rawDir.startsWith(inPath + path.sep)) {
    throw new MediaKitError("frames output directory must not be inside the input file", "INVALID_OUTPUT");
  }
  const dir = await prepareOutputDir(outputDir);
  const w = width === null || width === undefined ? null : num(width, "width", { min: 80, max: 3840, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("frames needs a video input", "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (duration === null || duration <= 0) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  // One capture per timestamp (captureFrameAt), not one `fps=N/D`
  // pass: the fps filter's rounding picks whatever frame its grid
  // lands on, so the file it writes can be seconds away from the
  // timestamp it is reported under (lượt 69 probe on a 25.878s film:
  // frame-002 reported 12.939s, pixels from shot 3 at ~24s). Captures
  // are sequential — each is a short seek + decode, and parallel
  // ffmpeg runs on this 1.5-CPU box starve each other. With --sharpest
  // each frame is the sharpest in its window [i*D/n, (i+1)*D/n)
  // instead of the window start, and the entry reports the score.
  const frames = [];
  let sharpTmp = null;
  try {
    if (wantSharpest) sharpTmp = await mkdtemp(path.join(os.tmpdir(), "mediakit-frames-sharp-"));
    for (let i = 0; i < n; i++) {
      const winStart = +((i * duration) / n).toFixed(3);
      const winEnd = +(((i + 1) * duration) / n).toFixed(3);
      let t = winStart;
      let sharp = null;
      if (wantSharpest) {
        const pick = await pickSharpestFrame(inPath, winStart, winEnd, samples, sharpTmp);
        t = pick.timestamp;
        sharp = pick.sharpness;
      }
      const fp = path.join(dir, `frame-${String(i + 1).padStart(3, "0")}.${ext}`);
      await captureFrameAt(inPath, t, fp, { width: w });
      const info = await fileInfo(fp);
      frames.push({
        file: path.basename(fp), path: fp, timestamp_seconds: t,
        ...(wantSharpest ? { sharpness: sharp, window_seconds: { start: winStart, end: winEnd } } : {}),
        ...info,
      });
    }
  } finally {
    if (sharpTmp) await rm(sharpTmp, { recursive: true, force: true }).catch(() => {});
  }
  return {
    operation: "frames", input: inPath, output_dir: dir,
    requested: n, extracted: frames.length, format: ext,
    ...(w !== null ? { width: w } : {}),
    ...(wantSharpest ? { sharpest: true, sharpest_samples: samples } : {}),
    duration_seconds: duration,
    frames,
  };
}

// ---------------------------------------------------------------- export_gif
// Animated GIF for READMEs / chat: two-pass palette in a single ffmpeg
// call (split + palettegen + paletteuse — the palette is built from
// the actual frames, not a generic one, which cuts size 30-50% at the
// same quality). Fits under a size budget (default 10 MB, the GitHub
// README limit; Slack only auto-plays GIFs under ~2 MB) by stepping
// down fps, then width, then palette colours — each attempt is
// measured on disk, and the result says honestly whether the budget
// was met instead of silently shipping an oversize file. (Idea:
// TMHSDigital/screencast-mcp's export_gif, which lowers fps/width/
// quality until the budget fits.)

export async function exportGif({ input, output, start = null, end = null, fps = null, width = null, maxSizeMb = 10 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  if (!/\.gif$/i.test(outPath)) {
    throw new MediaKitError(`export_gif output must end in .gif, got: ${output}`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("export_gif needs a video input", "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (duration === null || duration <= 0) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  const s = start === null || start === undefined ? 0 : parseTime(start, "start");
  const e = end === null || end === undefined ? duration : parseTime(end, "end");
  if (s >= duration) throw new MediaKitError(`start ${s}s is past the end of the file (${duration}s)`, "INVALID_ARG");
  if (e <= s) throw new MediaKitError(`end (${e}s) must be after start (${s}s)`, "INVALID_ARG");
  const clipEnd = Math.min(e, duration);
  const clipLen = clipEnd - s;
  const wantFps = fps === null || fps === undefined ? 15 : num(fps, "fps", { min: 1, max: 30, integer: true });
  const wantW = width === null || width === undefined ? 640 : num(width, "width", { min: 16, max: 4096, integer: true });
  const budgetMb = num(maxSizeMb, "max_size_mb", { min: 0.01, max: 10000 });
  const budgetBytes = Math.floor(budgetMb * 1_000_000);

  // Ladder: fps down (15/12/10/8), then width down (640/480/320),
  // then palette colours down (256/128/64). Each step only goes below
  // the requested start value, so an explicit --fps 8 --width 320
  // starts at the bottom and only steps the colours down.
  const ladder = [];
  const push = (f, w, c) => {
    const last = ladder[ladder.length - 1];
    if (!last || last.fps !== f || last.width !== w || last.colors !== c) ladder.push({ fps: f, width: w, colors: c });
  };
  push(wantFps, wantW, 256);
  let f = wantFps, w = wantW;
  for (const nf of [12, 10, 8]) if (nf < f) { f = nf; push(f, w, 256); }
  for (const nw of [480, 320]) if (nw < w) { w = nw; push(f, w, 256); }
  for (const nc of [128, 64]) push(f, w, nc);

  const before = await fileInfo(inPath);
  const attempts = [];
  let chosen = null;
  for (const step of ladder) {
    const vf = `fps=${step.fps},scale=${step.width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${step.colors}[p];[b][p]paletteuse`;
    await run(FFMPEG, ["-y", "-ss", String(s), "-i", inPath, "-t", String(clipLen), "-vf", vf, "-an", outPath]);
    const info = await fileInfo(outPath);
    attempts.push({ ...step, size_bytes: info.size_bytes, size_human: info.size_human });
    chosen = info;
    if (info.size_bytes <= budgetBytes) break;
  }
  const out = await probe(outPath);
  let frames = null;
  try {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", outPath]);
    const n = parseInt(stdout.trim(), 10);
    if (Number.isFinite(n)) frames = n;
  } catch { /* frame count is informational; the GIF itself is already verified by probe */ }
  const met = chosen.size_bytes <= budgetBytes;
  const last = attempts[attempts.length - 1];
  return {
    operation: "export_gif", input: inPath, output: outPath,
    start_seconds: s, end_seconds: clipEnd, duration_seconds: out.duration_seconds,
    width: out.video?.width ?? null, height: out.video?.height ?? null,
    fps: out.video?.fps ?? null, frames,
    size_bytes: chosen.size_bytes, size_human: chosen.size_human,
    size_before_bytes: before.size_bytes,
    size_budget_mb: budgetMb, size_budget_bytes: budgetBytes,
    size_budget_met: met, attempts_tried: attempts.length, attempts,
    ...(met ? {} : { warning: `size budget ${budgetMb} MB could not be met even at ${last.width}px / ${last.fps}fps / ${last.colors} colours — smallest output is ${chosen.size_human} (${chosen.size_bytes} bytes)` }),
  };
}

// ---------------------------------------------------------------- loudness

// Video containers loudness can write: audio is re-encoded, video is
// stream-copied (see loudness()).
const VIDEO_CONTAINER_AUDIO = { mp4: "aac", mov: "aac", m4v: "aac", mkv: "aac", webm: "libopus" };

// ffmpeg's default libmp3lame bitrate is 64k — low enough to lose ~0.5 LU
// in a re-measured master (measured: -14.5 at 64k vs -14.28 at 192k vs
// -14.0 lossless, same two-pass gain). Pin mp3 encodes to 192k in the
// mastering paths (loudness, mix) so the measured output stays inside
// the ±0.5 LUFS tolerance instead of sitting on its edge.
// Lossy audio encoders need an explicit bitrate: ffmpeg's default
// for AAC is ~69 kbps on mono, and at that rate the encoder smears
// inter-sample peaks — a voice mastered to TP -2.00 measured +1.37
// dBTP after the AAC encode (turn 53: the report film failed qa on
// true_peak while the same loudnorm into WAV measured exactly -2.00,
// and the same WAV into AAC 192k measured -1.98). Pin both lossy
// codecs to 192k so the master the limiter produced is the master
// on disk. Used by loudness() and mix().
// Pin the audio bitrate on every lossy re-encode: ffmpeg's native AAC
// encoder defaults to a low bitrate, and that bitrate — not loudnorm —
// was the root cause of the true-peak overshoot measured in turn 53
// (WAV at -2.00 dBTP came back from AAC at +1.37 dBTP). 192k is the
// floor everywhere a tool re-encodes AAC or MP3 without an explicit
// preset bitrate (compress/loudness keep their own preset numbers;
// image_to_video, slideshow and segment keep their deliberate 128k).
const audioBitrateArgs = (codec) => (codec === "libmp3lame" || codec === "aac" ? ["-b:a", "192k"] : []);

// acompressor takes a LINEAR threshold (0-1), so -24 dB = 0.0631 —
// the same conversion mix() uses for its -18 dB voice compressor
// (0.125). The compressor stage for loudness() is the same idea,
// exposed as an option: quiet, high-crest speech (Kokoro measured
// -25.5 LUFS, crest ~19 dB) hits the true-peak ceiling before the
// target, so two-pass alone stalls at ~-15.1; a gentle compressor
// first (threshold -24 dB, ratio 4, peak detection) lifts it to
// ~-14.5. The compressed audio is measured BEFORE the loudnorm pass
// so the gain is computed against what loudnorm actually receives.
function normalizeCompressor(compressor) {
  if (compressor === null || compressor === undefined || compressor === false) return null;
  const o = compressor === true ? {} : compressor;
  if (typeof o !== "object" || Array.isArray(o)) {
    throw new MediaKitError("loudness compressor must be true or an object {threshold_db?, ratio?, attack_ms?, release_ms?, knee_db?, detection?}", "INVALID_ARG");
  }
  return {
    threshold_db: num(o.threshold_db ?? o.threshold ?? -24, "compressor.threshold_db", { min: -60, max: 0 }),
    ratio: num(o.ratio ?? 4, "compressor.ratio", { min: 1, max: 20 }),
    attack_ms: num(o.attack_ms ?? o.attack ?? 1, "compressor.attack_ms", { min: 0.01, max: 1000 }),
    release_ms: num(o.release_ms ?? o.release ?? 250, "compressor.release_ms", { min: 10, max: 5000 }),
    knee_db: num(o.knee_db ?? o.knee ?? 2, "compressor.knee_db", { min: 0, max: 10 }),
    detection: o.detection ?? "peak",
  };
}

export async function loudness({ input, output, targetLufs = -14, format = null, compressor = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const target = num(targetLufs, "target_lufs", { min: -70, max: 0 });
  const comp = normalizeCompressor(compressor);
  if (comp && !["peak", "rms"].includes(comp.detection)) {
    throw new MediaKitError(`loudness compressor detection must be peak or rms, got: ${comp.detection}`, "INVALID_ARG");
  }
  const ext = (format || path.extname(outPath).slice(1) || "mp3").toLowerCase();
  const codec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext];
  if (!codec) throw new MediaKitError(`unsupported audio format: ${ext}`, "INVALID_ARG");
  const meta = await probe(inPath);
  if (!meta.audio) throw new MediaKitError("loudness needs an audio stream in the input", "INVALID_ARG");
  // Two-pass loudnorm: pass 1 measures the input (integrated loudness,
  // true peak, LRA, threshold, target offset); pass 2 applies the exact
  // linear gain. Single-pass cannot hit the target when the input is far
  // from it — a -26 LUFS music bed only reached -21.6 in one pass.
// Attack is 1 ms, not ffmpeg's 20 ms default: speech peaks are
// plosive transients, and a 20 ms attack lets them straight through
// (measured on the Kokoro fixture: TP -6.3 dB untouched, offset
// +0.81, output stuck at -15.2). With attack 1 ms the same
// compressor pulls TP to -15.8 while integrated only falls to
// -31.2, so the target becomes reachable: on-disk -14.3 LUFS
// (wav/m4a) and -14.6 (mp3 — the extra 0.3 is the known mp3
// encode loss). Same 1 ms attack mix() uses on its voice compressor.
  // TP is -2, not the usual -1.5: the AAC/MP3 encode after loudnorm
  // adds ~1-1.5 dB of inter-sample overshoot (measured 2026-11-13:
  // speech mastered at TP -1.5 measured -0.55 on disk, a film final
  // -0.04), so the in-graph target sits 0.5 dB below the -1.5 on-disk
  // goal and the file passes the qa true-peak max of -0.3 dBTP.
  const measured = await measureLoudnessFull(inPath);
  let twoPass = false;
  let compressedLufs = null;
  let compPath = null;
  try {
    // Compressor pre-stage: compress to a lossless temp, measure THAT,
    // then loudnorm with the compressed measurement. The temp is
    // audio-only, so pass 2 takes video (if any) from the original
    // input and audio from the temp — the picture is never dropped.
    let normSource = inPath;
    let normMeasured = measured;
    if (comp) {
      compPath = path.join(path.dirname(outPath), `.loudness-comp-${process.pid}.wav`);
      const thrLin = +(10 ** (comp.threshold_db / 20)).toFixed(4);
      await run(FFMPEG, [
        "-y", "-i", inPath, "-vn",
        "-af", `acompressor=threshold=${thrLin}:ratio=${comp.ratio}:attack=${comp.attack_ms}:release=${comp.release_ms}:knee=${comp.knee_db}:detection=${comp.detection}`,
        "-ar", "48000", "-c:a", "pcm_s16le", compPath,
      ]);
      const compMeasured = await measureLoudnessFull(compPath);
      if (compMeasured) {
        normMeasured = compMeasured;
        compressedLufs = compMeasured.i;
        normSource = compPath;
      }
    }
    if (normMeasured) {
      const args = ["-y", "-i", inPath];
      if (normSource !== inPath) args.push("-i", normSource);
      args.push(
        "-af", `loudnorm=I=${target}:TP=-2:LRA=11:measured_I=${normMeasured.i}:measured_TP=${normMeasured.tp}:measured_LRA=${normMeasured.lra}:measured_thresh=${normMeasured.thresh}:offset=${normMeasured.offset}:linear=true`,
        "-ar", "48000",
      );
      if (normSource !== inPath) args.push("-map", "0:v?", "-map", "1:a");
      args.push("-c:v", "copy", "-c:a", codec, ...audioBitrateArgs(codec), outPath);
      await run(FFMPEG, args);
      twoPass = true;
    } else {
      // Measurement failed (unusual input): fall back to single-pass.
      await run(FFMPEG, [
        "-y", "-i", inPath,
        "-af", `${comp ? `acompressor=threshold=${+(10 ** (comp.threshold_db / 20)).toFixed(4)}:ratio=${comp.ratio}:attack=${comp.attack_ms}:release=${comp.release_ms}:knee=${comp.knee_db}:detection=${comp.detection},` : ""}loudnorm=I=${target}:TP=-2:LRA=11`,
        "-ar", "48000", "-c:v", "copy", "-c:a", codec, ...audioBitrateArgs(codec), outPath,
      ]);
    }
  } finally {
    if (compPath) await unlink(compPath).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  // Measure the file on disk (not the filter's promise): the encode
  // after loudnorm can move the true peak — AAC at a low bitrate
  // added +3.4 dB on one voice (turn 53), so the reported peak must
  // come from the finished file. Reuse the one measurement for both
  // LUFS and TP instead of running loudnorm twice.
  const outFull = out.audio ? await measureLoudnessFull(outPath) : null;
  const outputLufs = outFull === null ? null : +outFull.i.toFixed(1);
  const outputTp = outFull === null ? null : outFull.tp;
  // Honest reporting: when the input is peak-limited (true peak caps the
  // gain — e.g. sub-bass-heavy music with a 20+ dB crest), even two-pass
  // cannot reach the target without clipping. Say so instead of
  // pretending the target was hit. Same for a true peak over the -0.3
  // dBTP delivery ceiling: the file fails qa_report on true_peak, so
  // the tool must say so here instead of reporting a clean -14 LUFS.
  const offTarget = outputLufs === null ? null : +(outputLufs - target).toFixed(1);
  const warnings = [];
  if (offTarget !== null && Math.abs(offTarget) > 0.5) {
    warnings.push(`reached ${outputLufs} LUFS, ${Math.abs(offTarget)} LUFS ${offTarget < 0 ? "below" : "above"} target — input is peak-limited (true peak caps the gain)${comp ? " (compressor already applied)" : "; high-pass sub-bass or compress first, then normalize again"}`);
  }
  if (outputTp !== null && outputTp > -0.3) {
    warnings.push(`true peak ${outputTp} dBTP is over the -0.3 dBTP delivery ceiling — the file fails qa_report on true_peak; re-master with --compressor and check the output again`);
  }
  const warning = warnings.length ? warnings.join("; ") : null;
  return { operation: "loudness", input: inPath, output: outPath, target_lufs: target, input_lufs: measured?.i ?? null, output_lufs: outputLufs, output_true_peak_db: outputTp, two_pass: twoPass, ...(comp ? { compressor: { threshold_db: comp.threshold_db, ratio: comp.ratio, attack_ms: comp.attack_ms, release_ms: comp.release_ms, knee_db: comp.knee_db, detection: comp.detection }, compressed_lufs: compressedLufs } : {}), ...(warning ? { warning } : {}), format: ext, ...info, duration_seconds: out.duration_seconds };
}

// ---------------------------------------------------------------- concat
// Plain mode: concat demuxer + re-encode (safe across codecs/sizes).
// Transition mode (ffmpeg-mcp's concat_clips_with_transition idea,
// rebuilt on ffmpeg directly): normalize every clip to the first
// clip's size/fps in one filter graph, then chain xfade + acrossfade
// pairwise. Output duration = sum(durations) - (n-1) * transition.
// Fast mode (video-creator/ffmpeg-mcp's fast/slow concat idea, and
// mcp-video's normalize-then-join): probe every clip first — when all
// clips are identical (codec, size, fps, pixel format, audio) the
// demuxer can stream-copy, which is ~10x faster and lossless. When
// they differ, fall back to the re-encode demuxer. fast=null means
// auto-detect, fast=true forces copy (errors with the mismatch
// reasons), fast=false always re-encodes. "Identical" includes the
// video time_base: the demuxer copies timestamps verbatim, so a
// different time_base stretches the join (measured: 10s + 10s with
// 1/15360 vs 1/90000 stream-copied to 116.9s).

// Transition catalog (turn 91 — kevinten-ai/mcp-ffmpeg's grouped
// catalog idea, applied to MediaKit's own list): every xfade name
// `concat` / `slideshow` / `assemble` accepts, grouped by family so
// an agent picks by look instead of guessing from a flat list. The
// flat list is derived from the categories — one source of truth,
// so the count in the docs can never drift from the validator again
// (it did: the list grew to 52 when slideshow added cover* in turn
// 43, but the docs kept saying 49). ffmpeg 8.1.2's xfade offers 6
// more names than the catalog had (fadefast, fadeslow, reveal* —
// verified by a real encode in turn 91); they are in here too, so
// the catalog is the complete xfade set on this ffmpeg minus `custom`
// (which needs a custom expression, not a bare name).
export const TRANSITION_CATEGORIES = [
  { name: "fade", description: "Cross-dissolve family: one shot melts into the next, optionally through black, white, grey, or faster/slower than the plain fade.", transitions: ["fade", "fadeblack", "fadewhite", "fadegrays", "fadefast", "fadeslow", "dissolve", "distance"] },
  { name: "wipe", description: "A hard edge sweeps across the frame — from a side, or from a corner.", transitions: ["wipeleft", "wiperight", "wipeup", "wipedown", "wipetl", "wipetr", "wipebl", "wipebr"] },
  { name: "slide", description: "The incoming shot pushes the outgoing one off the frame.", transitions: ["slideleft", "slideright", "slideup", "slidedown"] },
  { name: "smooth", description: "A slide with a soft, eased edge instead of a hard one.", transitions: ["smoothleft", "smoothright", "smoothup", "smoothdown"] },
  { name: "shape", description: "The new shot opens (or closes) through a geometric mask — circle, rectangle, horizontal or vertical band.", transitions: ["circlecrop", "rectcrop", "circleclose", "circleopen", "horzclose", "horzopen", "vertclose", "vertopen"] },
  { name: "diagonal", description: "A diagonal edge sweeps from one corner to the opposite.", transitions: ["diagbl", "diagbr", "diagtl", "diagtr"] },
  { name: "slice", description: "The frame splits into strips that peel away horizontally or vertically.", transitions: ["hlslice", "hrslice", "vuslice", "vdslice"] },
  { name: "wind", description: "Strips blow across the frame like wind, horizontally or vertically.", transitions: ["hlwind", "hrwind", "vuwind", "vdwind"] },
  { name: "cover", description: "The incoming shot covers the outgoing one like a curtain sliding in.", transitions: ["coverleft", "coverright", "coverup", "coverdown"] },
  { name: "reveal", description: "The outgoing shot slides away, revealing the incoming one underneath.", transitions: ["revealleft", "revealright", "revealup", "revealdown"] },
  { name: "other", description: "Effects with no direction family: pixel dissolve, radial spin, horizontal blur, zoom-in, vertical/horizontal squeeze.", transitions: ["pixelize", "radial", "hblur", "zoomin", "squeezev", "squeezeh"] },
];

const XFADE_TRANSITIONS = TRANSITION_CATEGORIES.flatMap((c) => c.transitions);

// List the transition catalog (probe-only, writes no file): the full
// grouped list `concat` / `slideshow` / `assemble` accept, or one
// category by name. An agent picking a transition reads this first
// instead of guessing a name and hitting "unknown transition".
export function listTransitions({ category = null } = {}) {
  if (category !== null && category !== undefined) {
    const found = TRANSITION_CATEGORIES.find((c) => c.name === category);
    if (!found) {
      throw new MediaKitError(
        `unknown transition category: ${category} (categories: ${TRANSITION_CATEGORIES.map((c) => c.name).join(", ")})`,
        "INVALID_ARG",
      );
    }
    return {
      operation: "transitions",
      total: found.transitions.length,
      category: found.name,
      categories: [{ name: found.name, description: found.description, count: found.transitions.length, transitions: [...found.transitions] }],
    };
  }
  return {
    operation: "transitions",
    total: XFADE_TRANSITIONS.length,
    categories: TRANSITION_CATEGORIES.map((c) => ({ name: c.name, description: c.description, count: c.transitions.length, transitions: [...c.transitions] })),
  };
}

/**
 * A concat clip spec: a plain path, "path@start-end" (either side may
 * be empty — "a.mp4@2-" trims from 2s to the end, "a.mp4@-5" keeps the
 * first 5s; times are seconds or MM:SS), or an object
 * {file, start, end}. Plain strings without a trailing @range pass
 * through untouched, so a filename that happens to contain "@" is
 * only treated as a trim when the part after it parses as a time range.
 */
function parseConcatInput(spec, idx) {
  if (typeof spec === "string") {
    const m = spec.match(/^(.+)@([0-9:.]*)-([0-9:.]*)$/);
    if (m && (m[2] !== "" || m[3] !== "")) {
      return {
        file: m[1],
        start: m[2] === "" ? null : parseTime(m[2], `clip ${idx} start`),
        end: m[3] === "" ? null : parseTime(m[3], `clip ${idx} end`),
      };
    }
    return { file: spec, start: null, end: null };
  }
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    if (typeof spec.file !== "string" || !spec.file) {
      throw new MediaKitError(`concat clip ${idx} needs a file path`, "INVALID_ARG");
    }
    return {
      file: spec.file,
      start: spec.start === null || spec.start === undefined ? null : parseTime(spec.start, `clip ${idx} start`),
      end: spec.end === null || spec.end === undefined ? null : parseTime(spec.end, `clip ${idx} end`),
    };
  }
  throw new MediaKitError(`concat clip ${idx} must be a file path, "path@start-end", or {file, start, end}`, "INVALID_ARG");
}

/** Validate trims against the probed durations and fill in effective ranges. */
function resolveConcatTrims(clips, metas) {
  clips.forEach((c, i) => {
    const dur = metas[i].duration_seconds;
    if (dur === null || dur === undefined) {
      throw new MediaKitError(`could not read the duration of clip ${i + 1} (${c.file})`, "PROBE_FAILED");
    }
    if (c.start !== null && c.start >= dur) {
      throw new MediaKitError(`clip ${i + 1} start (${c.start}s) is at or past its duration (${dur}s)`, "INVALID_ARG");
    }
    if (c.end !== null && c.end > dur) {
      throw new MediaKitError(`clip ${i + 1} end (${c.end}s) is past its duration (${dur}s)`, "INVALID_ARG");
    }
    if (c.start !== null && c.end !== null && c.end <= c.start) {
      throw new MediaKitError(`clip ${i + 1} end (${c.end}s) must be after its start (${c.start}s)`, "INVALID_ARG");
    }
    c.effStart = c.start ?? 0;
    c.effEnd = c.end ?? dur;
    c.effDur = +(c.effEnd - c.effStart).toFixed(3);
    if (c.effDur <= 0) {
      throw new MediaKitError(`clip ${i + 1} has a zero-length trim (${c.effStart}s–${c.effEnd}s)`, "INVALID_ARG");
    }
  });
}

function concatParts(clips) {
  return clips.map((c) => ({
    file: c.file,
    ...(c.start !== null ? { start: c.start } : {}),
    ...(c.end !== null ? { end: c.end } : {}),
    duration: c.effDur,
  }));
}

export async function concat({ inputs, output, videoCodec = "libx264", audioCodec = "aac", transition = null, transitionDuration = 1, transitions = null, transitionDurations = null, fast = null }) {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    throw new MediaKitError("concat needs at least 2 input files", "INVALID_ARG");
  }
  const clips = inputs.map((s, i) => parseConcatInput(s, i + 1));
  const inPaths = [];
  for (const c of clips) inPaths.push(await requireInput(c.file, "concat input"));
  const outPath = await prepareOutput(output, inPaths);
  // Probe once: the fast-path decision, the trim validation and the
  // transition graph all need the same durations.
  const metas = [];
  for (const p of inPaths) metas.push(await probe(p));
  resolveConcatTrims(clips, metas);
  const hasTrim = clips.some((c) => c.start !== null || c.end !== null);
  if (hasTrim && fast === true) {
    // Measured 2026-11-12: the concat demuxer's inpoint/outpoint does
    // NOT cut accurately — trimming 2–5s + 1–4s stream-copied 8.09s
    // instead of 6s (and re-encoded through the demuxer, 8.13s).
    // Accurate trims need the filter graph, so they always re-encode.
    throw new MediaKitError("concat --fast (stream copy) cannot trim clips — stream-copy cuts snap to keyframes (measured: inpoint/outpoint 2–5s + 1–4s copied 8.09s instead of 6s); omit --fast to re-encode with exact trims", "INVALID_ARG");
  }
  if (transition !== null && transition !== undefined || transitions !== null && transitions !== undefined) {
    if (fast === true) {
      throw new MediaKitError("concat --fast (stream copy) cannot be combined with --transition — transitions need re-encoding", "INVALID_ARG");
    }
    return concatTransition({ inPaths, outPath, videoCodec, audioCodec, transition, transitionDuration, transitions, transitionDurations, clips, metas });
  }
  if (hasTrim) {
    return concatTrimmed({ inPaths, outPath, videoCodec, audioCodec, clips, metas });
  }
  const compat = checkConcatCompat(metas);
  const useFast = fast === true ? true : fast === false ? false : compat.ok;
  if (fast === true && !compat.ok) {
    throw new MediaKitError(`concat --fast needs identical clips, but: ${compat.reasons.join("; ")}`, "INVALID_ARG");
  }
  // The demuxer copies timestamps verbatim, so even its re-encode
  // path stretches a clip whose time_base differs (measured
  // 2026-11-16: 10s + 10s re-encoded through the demuxer came out
  // 116.9s). The same holds for display size: the demuxer re-encode
  // of a rotated (display 720x1280) + upright (1280x720) pair plays
  // the upright half transposed 90 degrees (PSNR 51.8 dB vs the
  // transposed source frame, measured 2026-11-16). And any rotation
  // difference at all corrupts the demuxer path — even two clips
  // with the same display size: it applies the first clip's
  // display-matrix rotation to every clip, so an upright second
  // clip came out rotated 90 degrees and stretched (PSNR 3.1 dB vs
  // the correct picture). Route all three kinds of join through the
  // filter graph, which resets timestamps per clip with setpts and
  // normalizes every clip to the first clip's display size. Mode
  // stays "reencode"; the reason is reported.
  if (!useFast && (compat.timeBaseMismatch || compat.displayMismatch || compat.rotationMismatch)) {
    return concatTrimmed({ inPaths, outPath, videoCodec, audioCodec, clips, metas, mode: "reencode", fastSkipped: compat.reasons });
  }
  // Concat demuxer: stream-copy when clips match, re-encode otherwise.
  // The list file is written to a temp file in the output directory.
  const listPath = path.join(path.dirname(outPath), `.mediakit-concat-${Date.now()}.txt`);
  const { writeFile, unlink } = await import("node:fs/promises");
  const listContent = inPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  await writeFile(listPath, listContent, "utf8");
  try {
    if (useFast) {
      await run(FFMPEG, [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", "-movflags", "+faststart", outPath,
      ]);
    } else {
      await run(FFMPEG, [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", videoCodec, "-c:a", audioCodec, ...audioBitrateArgs(audioCodec), "-movflags", "+faststart", outPath,
      ]);
    }
  } finally {
    await unlink(listPath).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const outDisp = out.video ? displayDims(out) : null;
  return {
    operation: "concat", inputs: inPaths, output: outPath, parts: concatParts(clips),
    mode: useFast ? "fast" : "reencode",
    ...(useFast
      ? { fast_reason: "all clips identical (codec, size, fps, pixel format, time_base, audio) — stream-copied without re-encoding" }
      : { fast_skipped: compat.reasons.length ? compat.reasons : ["fast mode disabled"] }),
    ...info, duration_seconds: out.duration_seconds,
    dimensions: outDisp ? `${outDisp.width}x${outDisp.height}` : null,
  };
}

/**
 * Concat with per-clip trims: trim/atrim each clip in one filter
 * graph, normalize to the first clip's display size/fps (like the
 * transition path), then join with the concat filter. Always
 * re-encodes — the demuxer's inpoint/outpoint cannot cut accurately
 * (see the --fast error above), so there is no fast path here.
 * Display size, not stored size: decode autorotates, so a phone clip
 * stored 1280x720 with rotation 90 arrives as 720x1280 frames —
 * normalizing to the stored 1280x720 would pillarbox it into a
 * landscape output (measured 2026-11-16).
 */
async function concatTrimmed({ inPaths, outPath, videoCodec, audioCodec, clips, metas, mode = "trim", fastSkipped = null }) {
  const hasVideo = metas.some((m) => m.video);
  if (hasVideo && metas.some((m) => !m.video)) {
    throw new MediaKitError("concat with per-clip trims needs video in every input (or audio in every input) — mixed video/audio-only clips are not supported", "INVALID_ARG");
  }
  const firstVideo = metas.find((m) => m.video);
  const firstDisp = firstVideo ? displayDims(firstVideo) : null;
  const tw = firstDisp ? firstDisp.width : null;
  const th = firstDisp ? firstDisp.height : null;
  const fps = firstVideo ? firstVideo.video.fps || 30 : null;
  const graph = [];
  metas.forEach((m, i) => {
    const c = clips[i];
    const s = +c.effStart.toFixed(3);
    const e = +c.effEnd.toFixed(3);
    if (m.video) {
      graph.push(`[${i}:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS,scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps}[v${i}]`);
    }
    if (m.audio) {
      graph.push(`[${i}:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    } else if (hasVideo) {
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${c.effDur},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  const n = metas.length;
  if (hasVideo) {
    const ins = metas.map((_, i) => `[v${i}][a${i}]`).join("");
    graph.push(`${ins}concat=n=${n}:v=1:a=1[vout][aout]`);
  } else {
    const ins = metas.map((_, i) => `[a${i}]`).join("");
    graph.push(`${ins}concat=n=${n}:v=0:a=1[aout]`);
  }
  const expected = +clips.reduce((acc, c) => acc + c.effDur, 0).toFixed(3);
  const args = ["-y"];
  for (const p of inPaths) args.push("-i", p);
  args.push("-filter_complex", graph.join(";"));
  if (hasVideo) {
    args.push("-map", "[vout]", "-map", "[aout]", "-c:v", videoCodec, "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium");
  } else {
    args.push("-map", "[aout]");
  }
  args.push("-c:a", audioCodec, ...audioBitrateArgs(audioCodec), "-movflags", "+faststart", outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "concat", inputs: inPaths, output: outPath, parts: concatParts(clips),
    mode, expected_duration_seconds: expected,
    ...(fastSkipped ? { fast_skipped: fastSkipped } : {}),
    ...(firstDisp ? { normalize_dimensions: `${tw}x${th}`, source_dimensions: `${firstDisp.width}x${firstDisp.height}`, source_rotation: firstDisp.rotation } : {}),
    ...info, duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

/**
 * Stream-copy concat only works when every clip matches: same video
 * codec/size/fps/pixel format and same audio presence/codec/rate/
 * channels, in the same container family. Compare each clip against
 * the first and collect every mismatch (not just the first) so the
 * caller can see what to normalize. Size is compared on DISPLAY
 * dimensions — what the viewer sees after autorotate — because the
 * decoded frames are what the join actually stitches: two clips
 * stored 1280x720 where one carries rotation 90 display as 720x1280
 * and 1280x720, and stream-copying them plays one half sideways
 * (measured 2026-11-16). The fast path additionally needs identical
 * stored dims + rotation, because stream copy cannot re-orient a
 * clip. The demuxer re-encode path is NOT a safe fallback for any
 * rotation difference: it applies the first clip's display-matrix
 * rotation to every clip (measured 2026-11-16: an upright 720x1280
 * second clip came out rotated 90 degrees and stretched to fill
 * the frame, PSNR 3.1 dB vs the correct picture — while the filter
 * graph renders the same join at 52.1 dB). So any stored-orientation
 * difference sets rotationMismatch and the caller routes the join
 * through the filter graph, which autorotates each input
 * independently and normalizes to the first clip's display size.
 */
function checkConcatCompat(metas) {
  const reasons = [];
  let timeBaseMismatch = false;
  let displayMismatch = false;
  let rotationMismatch = false;
  const base = metas[0];
  const fmt = (m) => (m.format ?? "").split(",")[0];
  const vid = (m) => m.video;
  const aud = (m) => m.audio;
  const sameFps = (a, b) => a === b || (a !== null && b !== null && Math.abs(a - b) <= 0.01);
  for (let i = 1; i < metas.length; i++) {
    const m = metas[i];
    const label = `clip ${i + 1}`;
    if (fmt(m) !== fmt(base)) reasons.push(`${label}: container ${fmt(m)} != ${fmt(base)}`);
    if (!vid(base) || !vid(m)) {
      if (!!vid(base) !== !!vid(m)) reasons.push(`${label}: video presence differs`);
    } else {
      if (vid(m).codec !== vid(base).codec) reasons.push(`${label}: video codec ${vid(m).codec} != ${vid(base).codec}`);
      const dBase = displayDims(base);
      const dM = displayDims(m);
      if (dM.width !== dBase.width || dM.height !== dBase.height) {
        reasons.push(`${label}: display size ${dM.width}x${dM.height} != ${dBase.width}x${dBase.height} (stored ${vid(m).width}x${vid(m).height}, rotation ${vid(m).rotation ?? "none"})`);
        displayMismatch = true;
      } else if (vid(m).width !== vid(base).width || vid(m).height !== vid(base).height || (vid(m).rotation ?? null) !== (vid(base).rotation ?? null)) {
        // Same picture on screen, different coded orientation: the
        // demuxer re-encode would still corrupt the join (it applies
        // the first clip's rotation to every clip — measured
        // 2026-11-16), so this also routes through the filter graph.
        reasons.push(`${label}: same display size ${dM.width}x${dM.height} but stored orientation differs (${vid(m).width}x${vid(m).height}, rotation ${vid(m).rotation ?? "none"} vs ${vid(base).width}x${vid(base).height}, rotation ${vid(base).rotation ?? "none"}) — re-encode to normalize`);
        rotationMismatch = true;
      }
      if (!sameFps(vid(m).fps, vid(base).fps)) reasons.push(`${label}: fps ${vid(m).fps} != ${vid(base).fps}`);
      if (vid(m).pixel_format !== vid(base).pixel_format) reasons.push(`${label}: pixel format ${vid(m).pixel_format} != ${vid(base).pixel_format}`);
      // Same fps is not the same clock: the concat demuxer copies
      // timestamps verbatim, so a different time_base stretches the
      // second clip — measured 2026-11-16: 10s (1/15360) + 10s
      // (1/90000) stream-copied to 116.9s instead of 20s. Re-encode
      // instead; the demuxer cannot be trusted to rescale it.
      if (vid(m).time_base !== vid(base).time_base) {
        reasons.push(`${label}: time_base ${vid(m).time_base} != ${vid(base).time_base}`);
        timeBaseMismatch = true;
      }
    }
    if (!!aud(base) !== !!aud(m)) {
      reasons.push(`${label}: audio presence differs`);
    } else if (aud(base) && aud(m)) {
      if (aud(m).codec !== aud(base).codec) reasons.push(`${label}: audio codec ${aud(m).codec} != ${aud(base).codec}`);
      if (aud(m).sample_rate !== aud(base).sample_rate) reasons.push(`${label}: audio sample rate ${aud(m).sample_rate} != ${aud(base).sample_rate}`);
      if (aud(m).channels !== aud(base).channels) reasons.push(`${label}: audio channels ${aud(m).channels} != ${aud(base).channels}`);
    }
  }
  return { ok: reasons.length === 0, reasons, timeBaseMismatch, displayMismatch, rotationMismatch };
}

/** concat with an xfade transition between every pair of clips.
 * One transition type/duration for all joins (transition /
 * transitionDuration), or a different one per join (transitions /
 * transitionDurations, one entry per join — the slideshow tool's
 * per-pair form). Per-join durations change the handle math: each
 * join consumes its own duration, so the running total subtracts
 * that join's t, not a shared one. */
async function concatTransition({ inPaths, outPath, videoCodec, audioCodec, transition, transitionDuration, transitions = null, transitionDurations = null, clips, metas }) {
  const joins = metas.length - 1;
  const ts = transitions !== null && transitions !== undefined
    ? transitions
    : Array.from({ length: joins }, () => transition);
  if (!Array.isArray(ts) || ts.length !== joins) {
    throw new MediaKitError(`transitions must have one entry per join (${joins}), got ${Array.isArray(ts) ? ts.length : typeof ts}`, "INVALID_ARG");
  }
  for (const [i, name] of ts.entries()) {
    if (!XFADE_TRANSITIONS.includes(name)) {
      throw new MediaKitError(`unknown transition: ${name} (supported: ${XFADE_TRANSITIONS.join(", ")})`, "INVALID_ARG");
    }
  }
  const tds = transitionDurations !== null && transitionDurations !== undefined
    ? transitionDurations
    : Array.from({ length: joins }, () => transitionDuration);
  if (!Array.isArray(tds) || tds.length !== joins) {
    throw new MediaKitError(`transition_durations must have one entry per join (${joins}), got ${Array.isArray(tds) ? tds.length : typeof tds}`, "INVALID_ARG");
  }
  const tNums = tds.map((d, i) => num(d, `transition_durations[${i}]`, { min: 0.1, max: 10 }));
  if (metas.some((m) => !m.video)) {
    throw new MediaKitError("concat with a transition needs video in every input", "INVALID_ARG");
  }
  // Effective durations are the trimmed ones (or the full clip when
  // no trim was given), so transitions land on the trimmed timeline.
  const durations = clips.map((c) => c.effDur);
  if (durations.some((d) => d === null)) {
    throw new MediaKitError("could not read input durations for transition concat", "PROBE_FAILED");
  }
  for (let k = 1; k < metas.length; k++) {
    const t = tNums[k - 1];
    if (t >= Math.min(durations[k - 1], durations[k])) {
      throw new MediaKitError(`transition ${k} duration (${t}s) must be shorter than the clips it joins (${durations[k - 1]}s and ${durations[k]}s)`, "INVALID_ARG");
    }
  }
  // Normalize to the first clip's display size/fps (xfade needs
  // identical dimensions and frame rates on both inputs). A trimmed
  // clip is cut first (trim/atrim + PTS reset), then scaled like an
  // untrimmed one. Display size: decode autorotates, so a rotated
  // phone clip stored 1280x720 arrives as 720x1280 frames.
  const firstDisp = displayDims(metas[0]);
  const tw = firstDisp.width;
  const th = firstDisp.height;
  const fps = metas[0].video.fps || 30;
  const graph = [];
  metas.forEach((m, i) => {
    const c = clips[i];
    const s = +c.effStart.toFixed(3);
    const e = +c.effEnd.toFixed(3);
    graph.push(`[${i}:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS,scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps}[v${i}]`);
    if (m.audio) {
      graph.push(`[${i}:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      // Silent bed of exactly this clip's length, so acrossfade always
      // has two audio streams to work with.
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${c.effDur},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  // Chain xfade pairwise. After joining clips 0..k-1 the running total
  // is sum(d_0..d_{k-1}) - sum(t_0..t_{k-2}), and the next transition
  // starts t_{k-1} seconds before its end.
  let vLabel = "v0";
  let aLabel = "a0";
  let running = durations[0];
  for (let k = 1; k < metas.length; k++) {
    const t = tNums[k - 1];
    const offset = +(running - t).toFixed(3);
    const vOut = `x${k}`;
    const aOut = `c${k}`;
    graph.push(`[${vLabel}][v${k}]xfade=transition=${ts[k - 1]}:duration=${t}:offset=${offset}[${vOut}]`);
    graph.push(`[${aLabel}][a${k}]acrossfade=d=${t}[${aOut}]`);
    vLabel = vOut;
    aLabel = aOut;
    running = +(running + durations[k] - t).toFixed(3);
  }
  const args = ["-y"];
  for (const p of inPaths) args.push("-i", p);
  args.push(
    "-filter_complex", graph.join(";"),
    "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
    "-c:v", videoCodec, "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
    "-c:a", audioCodec, ...audioBitrateArgs(audioCodec), "-movflags", "+faststart", outPath,
  );
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "concat", inputs: inPaths, output: outPath, parts: concatParts(clips),
    // transition / transition_duration keep the old shape when every
    // join uses the same type and length, and are null otherwise —
    // transitions / transition_durations always carry the full list.
    transition: ts.every((x) => x === ts[0]) ? ts[0] : null,
    transition_duration: tNums.every((x) => x === tNums[0]) ? tNums[0] : null,
    transitions: ts,
    transition_durations: tNums,
    expected_duration_seconds: running,
    normalize_dimensions: `${tw}x${th}`,
    source_dimensions: `${firstDisp.width}x${firstDisp.height}`,
    source_rotation: firstDisp.rotation,
    ...info, duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

// ---------------------------------------------------------------- burn_captions
// Fit-to-width (ý từ kajisho5/ffmpeg-skill caption.py `fit_size` — đọc
// code thật lượt 79, chỉ học ý tưởng, tự implement bằng Node):
//   * ffmpeg-skill walks the size down linearly from the requested size
//     to a floor, because the wrap predicate is not guaranteed monotone
//     under phrase-wrap rules — a bisection could skip a fitting size.
//     MediaKit does the same linear walk, at most ~30 steps.
//   * Their width comes from a per-script average-advance table
//     (`text_width_em`); MediaKit measures real glyphs with node-canvas
//     instead — libass renders SRT through the default ASS font "Arial",
//     which fontconfig on this box resolves to Liberation Sans
//     (verified: `fc-match Arial` -> LiberationSans-Regular.ttf), so the
//     measurer uses that family. Words are measured once at 100px and
//     scaled linearly to any size (hinting aside, advance scales with
//     size); the rendered band is pixel-checked on disk by the tests.
//   * Their floor is 4.5% of the frame height — calibrated to their
//     ~160px house caption size. MediaKit's default is ~3.1% of height
//     (~60px at 1920), so a 4.5% floor would sit ABOVE the default and
//     leave no room to shrink. MediaKit's floor is 1.6% of the frame
//     height (~31px at 1920), never below 16px: still readable on a
//     phone, small enough that a long cue can actually shrink into it.
//   * Their wrap budget is 90% of the frame width (SAFE_WIDTH_FRACTION).
//     MediaKit keeps 0.9 as the default budget, and narrows it to the
//     platform's text-safe rect when --platform is given.
// Platform margin (cùng nguồn, `--platform`): the default margin_v
// becomes the platform's own bottom UI depth — the distance from the
// frame bottom to the safe zone's bottom edge, scaled to the frame
// height. An explicit --margin-v is the more specific statement and
// always wins (same rule as ffmpeg-skill). The safe zones are the ones
// `check` already reports (creator guidance, not platform-published
// specs), so burn and check agree on where the UI sits.

// Greedy word wrap: how many lines `text` needs at `sizePx` inside
// `budgetPx`. Hard \n breaks (and SRT \N) split first; a single word
// wider than the budget still counts as one line (libass breaks it
// mid-word on screen). `measure(word, sizePx)` returns the word's
// width in px at that size.
function wrapLineCount(text, sizePx, budgetPx, measure) {
  const clean = String(text).replace(/<[^>]*>/g, "").replace(/\\N/g, "\n");
  let total = 0;
  for (const hard of clean.split("\n")) {
    const words = hard.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) { total += 1; continue; }
    let lines = 1;
    let curW = 0;
    const spaceW = measure(" ", sizePx);
    for (const w of words) {
      const ww = measure(w, sizePx);
      const add = curW === 0 ? ww : curW + spaceW + ww;
      if (add > budgetPx && curW > 0) { lines += 1; curW = ww; }
      else curW = add;
    }
    total += lines;
  }
  return total;
}

// Largest size in [floor, requested] at which every cue wraps to at
// most maxLines lines (scope = whole file: one size per track, so the
// type size never jumps cue to cue). Pure function of strings +
// numbers + a measure callback — no ffmpeg, no I/O.
export function fitCaptionSize({ texts, requested, floor, maxLines, budgetPx, measure }) {
  const measurable = (texts ?? []).map((t) => String(t ?? "")).filter((t) => t.trim());
  const result = {
    requested_size: requested, size: requested, floor, max_lines: maxLines,
    shrunk: 0, fits: true, lines_at_size: 0, width_px: budgetPx,
  };
  if (!measurable.length) return result;
  const linesAt = (sz) => Math.max(...measurable.map((t) => wrapLineCount(t, sz, budgetPx, measure)));
  let size = requested;
  while (size > floor && linesAt(size) > maxLines) size -= 1;
  const lines = linesAt(size);
  result.size = size;
  result.shrunk = requested - size;
  result.fits = lines <= maxLines;
  result.lines_at_size = lines;
  return result;
}

// Measure callback backed by node-canvas: words measured once at
// 100px in the font libass actually draws with, then scaled linearly.
function canvasWordMeasurer() {
  const { createCanvas } = loadCanvasPackage("burn_captions fit");
  const canvas = createCanvas(1, 1);
  const ctx = canvas.getContext("2d");
  const cache = new Map();
  const at100 = (word) => {
    if (!cache.has(word)) {
      ctx.font = `100px "Liberation Sans"`;
      cache.set(word, ctx.measureText(word).width);
    }
    return cache.get(word);
  };
  return (word, sizePx) => at100(word) * sizePx / 100;
}

// Default margin_v for a platform: the platform's bottom UI depth
// (frame bottom minus safe-zone bottom edge), scaled to this frame.
function platformCaptionMargin(platform, vh) {
  const spec = PLATFORMS[platform];
  return Math.round((spec.height - spec.safeZone.y1) * vh / spec.height);
}

// Fit width budget: the platform's text-safe rect when a platform is
// given, else 90% of the frame width.
function captionFitBudgetPx(platform, vw) {
  if (!platform) return Math.round(vw * 0.9);
  const spec = PLATFORMS[platform];
  return Math.round((spec.safeZone.x1 - spec.safeZone.x0) * vw / spec.width);
}
// Styles (SRT/VTT only — .ass carries its own styles, style is ignored
// there): background = white text on a semi-transparent black box
// (BorderStyle 3, the default — the YouTube-style boxed caption);
// outline = white text with a black outline; shadow = thin outline +
// drop shadow; glow = thick outline in the text's own colour at 50%
// alpha, a halo that reads on bright footage. outline_color accepts a
// name (white/black/yellow/cyan/red/green/blue/orange/magenta) or a
// 6-digit RRGGBB hex (converted to ASS BBGGRR) or 8-digit AARRGGBB.
const CAPTION_STYLES = ["background", "outline", "shadow", "glow"];
const ASS_COLOR_NAMES = {
  white: "FFFFFF", black: "000000", yellow: "FFFF00", cyan: "00FFFF",
  red: "FF0000", green: "00FF00", blue: "0000FF", orange: "FFA500",
  magenta: "FF00FF",
};

function assColor(value, label) {
  const v = String(value).trim();
  if (/^&H[0-9a-fA-F]{8}&$/.test(v)) return v.toUpperCase();
  const named = ASS_COLOR_NAMES[v.toLowerCase()];
  const hex = named ?? (/^[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase()
    : /^[0-9a-fA-F]{8}$/.test(v) ? v.toUpperCase() : null);
  if (!hex) throw new MediaKitError(`${label} must be a colour name or RRGGBB hex, got: ${value}`, "INVALID_ARG");
  if (hex.length === 8) return `&H${hex.slice(0, 2)}${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}&`;
  return `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}&`;
}

export async function burnCaptions({ input, output, captions, fontSize = null, fontColor = "white", box = true, marginV = null, style = null, outlineColor = "black", maxLines = null, platform = null, onProgress = null }) {
  const inPath = await requireInput(input);
  const capPath = await requireInput(captions, "captions file");
  const outPath = await prepareOutput(output, [inPath]);
  const ext = path.extname(capPath).toLowerCase();
  if (![".srt", ".ass", ".vtt"].includes(ext)) {
    throw new MediaKitError(`captions must be .srt/.ass/.vtt, got ${ext}`, "INVALID_ARG");
  }
  if (maxLines !== null) {
    maxLines = num(maxLines, "max_lines", { min: 1, max: 4, integer: true });
  }
  if (platform !== null) {
    platform = String(platform).toLowerCase();
    if (!PLATFORMS[platform]) {
      throw new MediaKitError(`unknown platform: ${platform} (supported: ${Object.keys(PLATFORMS).join(", ")})`, "INVALID_ARG");
    }
  }
  const meta = await probe(inPath);
  // Filters see the autorotated frame, so defaults must scale with the
  // DISPLAY size, not the coded size: a phone clip stored 1920x1080
  // with a 90-degree matrix is a 1080x1920 frame to libass. Using the
  // coded height here made the default font ~33px (should be ~60px)
  // and the margin ~281px (should be ~499px) on such a clip, landing
  // the captions inside the platform UI zone instead of above it.
  // PlayRes pins libass to the same frame the filter draws on.
  const disp = displayDims(meta);
  const vw = disp?.width ?? meta.video?.width ?? 1280;
  const vh = disp?.height ?? meta.video?.height ?? 720;
  // Defaults scale with frame height so captions stay readable and clear
  // of platform overlays at any size: ~60px type on 1080x1920, sitting
  // ~500px above the bottom edge (TikTok/Shorts cover the bottom ~480px
  // with their own UI). Explicit values always win. With --platform the
  // margin default is that platform's own bottom UI depth instead of
  // the 26% rule (e.g. tiktok 520px at 1920 high, youtube 100px at
  // 1080 high). Applies to .srt/.vtt; .ass files carry their own styles.
  const requestedSize = fontSize === null ? Math.round(vh * 0.031) : num(fontSize, "font_size", { min: 8, max: 200, integer: true });
  const margin = marginV === null
    ? (platform !== null ? platformCaptionMargin(platform, vh) : Math.round(vh * 0.26))
    : num(marginV, "margin_v", { min: 0, max: vh, integer: true });
  // Fit-to-width: shrink the type until every cue wraps to at most
  // maxLines lines, never below the readability floor (1.6% of frame
  // height, min 16px). SRT/VTT only — .ass carries its own styles, so
  // fit and the platform margin are ignored there (reported, not
  // silently dropped). A cue that still overflows at the floor burns
  // at the floor and reports fits:false so the caller can split it.
  let size = requestedSize;
  let fit = null;
  let fitNote = null;
  if (maxLines !== null) {
    if (ext === ".ass") {
      fitNote = "max_lines ignored for .ass (styles are embedded in the file)";
    } else {
      const raw = await readFile(capPath, "utf8");
      const { cues } = parseCaptions(raw, ext === ".vtt" ? "vtt" : "srt");
      const floor = Math.min(Math.max(16, Math.round(vh * 0.016)), requestedSize);
      fit = fitCaptionSize({
        texts: cues.map((c) => c.text), requested: requestedSize, floor,
        maxLines, budgetPx: captionFitBudgetPx(platform, vw),
        measure: canvasWordMeasurer(),
      });
      size = fit.size;
    }
  }
  if (ext === ".ass" && platform !== null) {
    fitNote = (fitNote ? `${fitNote}; ` : "") + "platform margin ignored for .ass (styles are embedded in the file)";
  }
  // style wins over the legacy box flag; without style, box=true keeps
  // the old default (background box) and box=false means outline.
  const styleName = style === null ? (box ? "background" : "outline") : String(style).toLowerCase();
  if (!CAPTION_STYLES.includes(styleName)) {
    throw new MediaKitError(`style must be one of ${CAPTION_STYLES.join(", ")}, got: ${style}`, "INVALID_ARG");
  }
  const outlineAss = assColor(outlineColor, "outline_color");
  // Glow halo = the text's own colour at 50% alpha. PrimaryColour is
  // &HFFFFFF& for white, else &H<raw fontColor>& (callers pass BGR hex);
  // reuse the same six digits so the halo matches the text by
  // construction, whatever the caller meant by the colour.
  const primaryDigits = fontColor.toLowerCase() === "white" ? "FFFFFF"
    : /^[0-9a-fA-F]{6}$/.test(fontColor) ? fontColor.toUpperCase()
    : /^[0-9a-fA-F]{8}$/.test(fontColor) ? fontColor.slice(2).toUpperCase() : null;
  if (styleName === "glow" && primaryDigits === null) {
    throw new MediaKitError(`glow style needs font_color as a hex value, got: ${fontColor}`, "INVALID_ARG");
  }
  const glowAss = styleName === "glow"
    ? `&H80${primaryDigits.slice(4, 6)}${primaryDigits.slice(2, 4)}${primaryDigits.slice(0, 2)}&`
    : null;
  // libass scales FontSize against the ASS PlayRes (default 384x288) when
  // converting SRT -> ASS, so a "48px" font would render ~6x too big on
  // a 1080x1920 frame. Pin PlayRes to the real video size so FontSize
  // means actual pixels.
  // libass handles .ass natively; for .srt/.vtt use subtitles filter.
  // Escape : and ' inside the filter argument the ffmpeg way.
  const esc = capPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  let vf;
  if (ext === ".ass") {
    vf = `ass='${esc}'`;
  } else {
    // BorderStyle 3 = opaque box behind the text (background style);
    // BorderStyle 1 = outline/shadow/glow around the glyphs.
    const styleBits = {
      background: `BorderStyle=3,BackColour=&H80000000&,OutlineColour=&H80000000&,Outline=2,Shadow=0`,
      outline: `BorderStyle=1,OutlineColour=${outlineAss},Outline=2,Shadow=0`,
      shadow: `BorderStyle=1,OutlineColour=${outlineAss},Outline=1,Shadow=2`,
      glow: `BorderStyle=1,OutlineColour=${glowAss},Outline=4,Shadow=0`,
    }[styleName];
    const forceStyle = `PlayResX=${vw},PlayResY=${vh},FontSize=${size},PrimaryColour=&HFFFFFF&,${styleBits},MarginV=${margin}`;
    const color = fontColor.toLowerCase() === "white" ? "" : `,PrimaryColour=&H${fontColor}&`;
    vf = `subtitles='${esc}':force_style='${forceStyle}${color}'`;
  }
  await runFfmpegWithProgress(["-y", "-i", inPath, "-vf", vf, "-c:a", "copy", outPath], {
    totalSeconds: meta.duration_seconds, onProgress,
  });
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "burn_captions", input: inPath, output: outPath, captions: capPath, font_size: size, margin_v: margin, style: styleName, style_applied: ext !== ".ass", platform: platform ?? null, fit, fit_note: fitNote, ...info, duration_seconds: out.duration_seconds };
}

// ---------------------------------------------------------------- convert_captions
// Convert a subtitle file between SRT and VTT (pure Node, no ffmpeg).
// SRT: numbered cues, "HH:MM:SS,mmm --> HH:MM:SS,mmm". VTT: "WEBVTT"
// header, "HH:MM:SS.mmm --> HH:MM:SS.mmm" plus optional cue settings
// (line:/position:/align: — dropped on the way to SRT, counted in
// settings_dropped). Cue text is carried verbatim, never rewritten.
// Format is inferred from the output extension; converting a file to
// its own format is refused (nothing to do).

function parseCaptionTimestamp(ts, label) {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(ts.trim());
  if (!m) throw new MediaKitError(`${label} has a bad timestamp: ${ts}`, "INVALID_ARG");
  const [, h, mi, s, ms] = m.map(Number);
  if (mi > 59 || s > 59) throw new MediaKitError(`${label} has a bad timestamp: ${ts}`, "INVALID_ARG");
  return ((h * 60 + mi) * 60 + s) * 1000 + ms;
}

function formatCaptionTimestamp(ms, sep) {
  const total = Math.round(ms);
  const h = Math.floor(total / 3_600_000);
  const mi = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const m = total % 1000;
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(mi, 2)}:${p(s, 2)}${sep}${p(m, 3)}`;
}

function parseCaptions(text, format) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cues = [];
  let i = 0;
  let settingsDropped = 0;
  let inHeader = format === "vtt";
  while (i < lines.length) {
    const line = lines[i].trim();
    i++;
    if (!line) continue;
    if (inHeader) {
      // WEBVTT header + NOTE/STYLE/REGION blocks: skip until the first
      // timing line. A NOTE block runs to the next blank line.
      if (/^WEBVTT/.test(line) || /^NOTE(\s|$)/.test(line)) continue;
      if (/^(STYLE|REGION)(\s|$)/.test(line)) {
        while (i < lines.length && lines[i].trim()) i++;
        continue;
      }
      inHeader = false;
    }
    // Optional cue id (SRT number, or a VTT id line): any line that is
    // not a timing line, followed by a timing line.
    let timing = line;
    if (!timing.includes("-->")) {
      if (i >= lines.length) throw new MediaKitError(`captions: cue "${line}" has no timing line`, "INVALID_ARG");
      timing = lines[i].trim();
      i++;
    }
    const tm = /^(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/.exec(timing);
    if (!tm) throw new MediaKitError(`captions: bad timing line: ${timing}`, "INVALID_ARG");
    const startMs = parseCaptionTimestamp(tm[1], "cue");
    const endMs = parseCaptionTimestamp(tm[2], "cue");
    if (endMs <= startMs) throw new MediaKitError(`captions: cue ends before it starts: ${timing}`, "INVALID_ARG");
    if (tm[3]) settingsDropped++;
    const textLines = [];
    while (i < lines.length && lines[i].trim()) { textLines.push(lines[i]); i++; }
    if (!textLines.length) throw new MediaKitError(`captions: cue at ${timing} has no text`, "INVALID_ARG");
    cues.push({ startMs, endMs, text: textLines.join("\n") });
  }
  if (!cues.length) throw new MediaKitError("captions: no cues found in the file", "INVALID_ARG");
  return { cues, settingsDropped };
}

export async function convertCaptions({ input, output }) {
  const inPath = await requireInput(input, "captions file");
  const inExt = path.extname(inPath).toLowerCase();
  if (![".srt", ".vtt"].includes(inExt)) {
    throw new MediaKitError(`convert_captions input must be .srt or .vtt, got ${inExt}`, "INVALID_ARG");
  }
  const outPath = await prepareOutput(output, [inPath]);
  const outExt = path.extname(outPath).toLowerCase();
  if (![".srt", ".vtt"].includes(outExt)) {
    throw new MediaKitError(`convert_captions output must be .srt or .vtt, got ${outExt}`, "INVALID_ARG");
  }
  if (inExt === outExt) {
    throw new MediaKitError(`convert_captions: input is already ${inExt.slice(1)} — nothing to convert`, "INVALID_ARG");
  }
  const from = inExt.slice(1);
  const to = outExt.slice(1);
  const raw = await readFile(inPath, "utf8");
  const { cues, settingsDropped } = parseCaptions(raw, from);
  const sep = to === "srt" ? "," : ".";
  let out;
  if (to === "vtt") {
    out = `WEBVTT\n\n${cues.map((c) => `${formatCaptionTimestamp(c.startMs, sep)} --> ${formatCaptionTimestamp(c.endMs, sep)}\n${c.text}`).join("\n\n")}\n`;
  } else {
    out = cues.map((c, n) => `${n + 1}\n${formatCaptionTimestamp(c.startMs, sep)} --> ${formatCaptionTimestamp(c.endMs, sep)}\n${c.text}`).join("\n\n") + "\n";
  }
  await writeFile(outPath, out, "utf8");
  const info = await fileInfo(outPath);
  return {
    operation: "convert_captions",
    input: inPath,
    output: outPath,
    from_format: from,
    to_format: to,
    cue_count: cues.length,
    first_start_seconds: +(cues[0].startMs / 1000).toFixed(3),
    last_end_seconds: +(cues[cues.length - 1].endMs / 1000).toFixed(3),
    settings_dropped: settingsDropped,
    ...info,
  };
}

// ---------------------------------------------------------------- generate_srt
// Build a deterministic .srt from a cue list [{start, end, text}].
// Pure Node, no ffmpeg (the counterpart of convert_captions, and the
// input `burn_captions` wants). Times accept seconds or "MM:SS" /
// "HH:MM:SS" via parseTime. Cues must be in order and must not overlap;
// touching cues (next start == previous end) are fine. Text may span
// lines with \n; \r is stripped.

const MAX_SRT_CUES = 10_000;

// ---------------------------------------------------------------- semantic captions
// groupWords: stickman-video-director's semantic caption grouping,
// adapted to MediaKit's Shorts rules (2 lines x 42 chars per line).
// Words are [{start, end, word}] in timeline order (seconds or
// "MM:SS"); cues are grouped by meaning, not by a fixed word count:
//   - flush on a pause > 0.4s between words, or on sentence end [.?!]
//   - flush BEFORE a word that would push the cue past 8 words, 3.5s,
//     or 84 characters (2 lines of 42)
//   - a cue never ends on a stranded function word (the/a/of/to/...):
//     that word moves to the next cue instead
// Pure function (no I/O) so tests can call it directly. Deterministic:
// same words in -> same cues out, byte-identical SRT via formatSrtBody.
// Limits: abbreviations ending in "." (e.g. "U.S.") also flush —
// join them into one word ("U.S.") before calling if that matters.
const SEMANTIC_MAX_WORDS = 8;
const SEMANTIC_MAX_CUE_SECONDS = 3.5;
const SEMANTIC_MAX_CUE_CHARS = 84;
const SEMANTIC_MAX_LINE_CHARS = 42;
const SEMANTIC_PAUSE_SECONDS = 0.4;
const STRANDED_WORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "and", "but", "or",
  "with", "for", "from", "by", "as", "into", "over", "under",
]);

function wrapCaptionLines(text) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= SEMANTIC_MAX_LINE_CHARS) line += ` ${w}`;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export function groupWords(words) {
  if (!Array.isArray(words) || words.length === 0) {
    throw new MediaKitError("groupWords needs a non-empty words array", "INVALID_ARG");
  }
  if (words.length > MAX_SRT_CUES * 8) {
    throw new MediaKitError(`groupWords accepts at most ${MAX_SRT_CUES * 8} words, got ${words.length}`, "INVALID_ARG");
  }
  const normalized = words.map((w, i) => {
    const n = i + 1;
    if (!w || typeof w !== "object" || Array.isArray(w)) {
      throw new MediaKitError(`word ${n} must be an object {start, end, word}`, "INVALID_ARG");
    }
    const start = parseTime(w.start, `word ${n} start`);
    const end = parseTime(w.end, `word ${n} end`);
    if (!(end > start)) {
      throw new MediaKitError(`word ${n}: end (${w.end}) must be after start (${w.start})`, "INVALID_ARG");
    }
    if (typeof w.word !== "string" || !w.word.trim() || /\s/.test(w.word.trim())) {
      throw new MediaKitError(`word ${n}: word must be a single non-empty token, got: ${JSON.stringify(w.word)}`, "INVALID_ARG");
    }
    return { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), word: w.word.trim() };
  });
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].startMs < normalized[i - 1].endMs) {
      throw new MediaKitError(
        `word ${i + 1} starts at ${(normalized[i].startMs / 1000).toFixed(3)}s, before word ${i} ends at ${(normalized[i - 1].endMs / 1000).toFixed(3)}s — words must be in order and must not overlap`,
        "INVALID_ARG",
      );
    }
  }
  // Cues as word lists first, so the stranded-word repair below can
  // move a whole word (with its timings) between cues.
  const raw = [];
  let cur = [];
  const flush = (r) => {
    if (cur.length) raw.push({ words: cur, reason: r });
    cur = [];
  };
  for (const w of normalized) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gapS = (w.startMs - prev.endMs) / 1000;
      const joined = [...cur.map((x) => x.word), w.word].join(" ");
      const durS = (w.endMs - cur[0].startMs) / 1000;
      if (gapS > SEMANTIC_PAUSE_SECONDS) flush("pause");
      else if (cur.length >= SEMANTIC_MAX_WORDS) flush("word-limit");
      else if (joined.length > SEMANTIC_MAX_CUE_CHARS) flush("char-limit");
      else if (durS > SEMANTIC_MAX_CUE_SECONDS) flush("duration-limit");
      else if (/[.!?]$/.test(prev.word)) flush("sentence-end");
    }
    cur.push(w);
  }
  flush("end");
  // Stranded-word repair: a cue ending on the/a/of/to/... hands that
  // word to the next cue (with its real timings). One pass, left to
  // right; a cue of a single stranded word is left alone.
  for (let i = 0; i < raw.length - 1; i++) {
    const cue = raw[i];
    if (cue.words.length <= 1) continue;
    const last = cue.words[cue.words.length - 1];
    if (!STRANDED_WORDS.has(last.word.toLowerCase().replace(/[.,!?;:]+$/, ""))) continue;
    cue.words.pop();
    raw[i + 1].words.unshift(last);
  }
  const cues = raw.map((c) => {
    const text = c.words.map((w) => w.word).join(" ").replace(/\s+([,.!?;:])/g, "$1");
    return {
      startMs: c.words[0].startMs,
      endMs: c.words[c.words.length - 1].endMs,
      text: wrapCaptionLines(text),
      split_reason: c.reason,
    };
  });
  const warnings = [];
  for (const c of cues) {
    for (const line of c.text.split("\n")) {
      if (line.length > SEMANTIC_MAX_LINE_CHARS) {
        warnings.push(`cue "${c.text.split("\n")[0]}…" has a ${line.length}-char line (one word longer than ${SEMANTIC_MAX_LINE_CHARS} chars cannot wrap)`);
        break;
      }
    }
  }
  return {
    cues,
    words_in: normalized.length,
    cues_out: cues.length,
    max_words_in_cue: Math.max(...cues.map((c) => c.text.replace(/\n/g, " ").split(" ").length)),
    longest_cue_chars: Math.max(...cues.map((c) => c.text.replace(/\n/g, " ").length)),
    warnings,
  };
}

// One SRT body builder for generate_srt and transcribe, so both tools
// emit byte-identical cue formatting (index, HH:MM:SS,mmm, blank line).
function formatSrtBody(normalized) {
  return normalized
    .map((c, i) => `${i + 1}\n${formatCaptionTimestamp(c.startMs, ",")} --> ${formatCaptionTimestamp(c.endMs, ",")}\n${c.text}`)
    .join("\n\n") + (normalized.length ? "\n" : "");
}

export async function generateSrt({ cues = null, words = null, output }) {
  if (cues && words) {
    throw new MediaKitError("generate_srt takes cues or words, not both — cues are finished cue timings, words are word timings to group semantically", "INVALID_ARG");
  }
  if (!cues && !words) {
    throw new MediaKitError("generate_srt needs cues [{start, end, text}] or words [{start, end, word}]", "INVALID_ARG");
  }
  let grouping = null;
  let normalized;
  if (words) {
    const grouped = groupWords(words);
    grouping = {
      mode: "words",
      words_in: grouped.words_in,
      cues_out: grouped.cues_out,
      max_words_in_cue: grouped.max_words_in_cue,
      longest_cue_chars: grouped.longest_cue_chars,
      split_reasons: grouped.cues.map((c) => c.split_reason),
      warnings: grouped.warnings,
    };
    normalized = grouped.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }));
  } else {
  if (!Array.isArray(cues) || cues.length === 0) {
    throw new MediaKitError("generate_srt needs a non-empty cues array", "INVALID_ARG");
  }
  if (cues.length > MAX_SRT_CUES) {
    throw new MediaKitError(`generate_srt accepts at most ${MAX_SRT_CUES} cues, got ${cues.length}`, "INVALID_ARG");
  }
  normalized = cues.map((c, i) => {
    const n = i + 1;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new MediaKitError(`cue ${n} must be an object {start, end, text}`, "INVALID_ARG");
    }
    const start = parseTime(c.start, `cue ${n} start`);
    const end = parseTime(c.end, `cue ${n} end`);
    if (!(end > start)) {
      throw new MediaKitError(`cue ${n}: end (${c.end}) must be after start (${c.start})`, "INVALID_ARG");
    }
    if (typeof c.text !== "string" || !c.text.trim()) {
      throw new MediaKitError(`cue ${n}: text must be a non-empty string`, "INVALID_ARG");
    }
    const text = c.text.replace(/\r\n?/g, "\n").trim();
    if (text.length > 1000) {
      throw new MediaKitError(`cue ${n}: text exceeds 1000 characters`, "INVALID_ARG");
    }
    return { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text };
  });
  }
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].startMs < normalized[i - 1].endMs) {
      throw new MediaKitError(
        `cue ${i + 1} starts at ${(normalized[i].startMs / 1000).toFixed(3)}s, before cue ${i} ends at ${(normalized[i - 1].endMs / 1000).toFixed(3)}s — cues must be in order and must not overlap`,
        "INVALID_ARG",
      );
    }
  }
  const outPath = await prepareOutput(output, []);
  if (path.extname(outPath).toLowerCase() !== ".srt") {
    throw new MediaKitError(`generate_srt output must end in .srt, got ${path.extname(outPath) || "(no extension)"}`, "INVALID_ARG");
  }
  const body = formatSrtBody(normalized);
  await writeFile(outPath, body, "utf8");
  const info = await fileInfo(outPath);
  return {
    operation: "generate_srt",
    output: outPath,
    cue_count: normalized.length,
    first_start_seconds: +(normalized[0].startMs / 1000).toFixed(3),
    last_end_seconds: +(normalized[normalized.length - 1].endMs / 1000).toFixed(3),
    ...(grouping ? { grouping } : {}),
    ...info,
  };
}

// ---------------------------------------------------------------- chapters
// Auto-chapters for a long talk / film (the op7418/Youtube-clipper
// idea from turn 64, via edigeh/broll-mcp's lesson that a chapter list
// is only useful when its times are measured, not guessed): split a
// transcript on long pauses, or split audio on silence, and name each
// chapter from the first words spoken in it. Two modes, exactly one:
//   - words_file: a transcribe --word-timestamps JSON
//     ({words:[{start,end,word}]}) — a new chapter starts after a gap
//     >= min_gap between two words.
//   - input: a media file with audio — silencedetect finds the pauses
//     and a new chapter starts at each speech segment that follows a
//     silence >= min_gap; titles are "Part 1..N" (no words to name from).
// The first chapter is always at 0 (YouTube requires the first chapter
// at 0:00) — when the first word/speech starts later the chapter is
// clamped to 0 and reported. assemble caps chapters at 32, so this
// tool does too: an over-long list merges the closest neighbours
// first. Output is the assemble manifest shape {title, at} so the
// result drops straight into film.json's "chapters" — pass --output
// to also write that JSON to a file.
const CHAPTERS_MAX = 32;

function chapterTitleFromWords(words, titleWords) {
  const take = words.slice(0, titleWords).map((w) => w.word);
  const t = take.join(" ").replace(/[.,!?;:]+$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export async function autoChapters({ wordsFile = null, input = null, minGap = 2, titleWords = 4, maxChapters = 32, thresholdDb = -40, minDuration = 0.5, output = null }) {
  const gap = num(minGap, "min_gap", { min: 0.1, max: 3600 });
  const titleN = num(titleWords, "title_words", { min: 1, max: 8, integer: true });
  const maxC = num(maxChapters, "max_chapters", { min: 1, max: CHAPTERS_MAX, integer: true });
  if ((wordsFile && input) || (!wordsFile && !input)) {
    throw new MediaKitError("chapters needs exactly one source: --words-file <words.json> or an <input> media file", "INVALID_ARG");
  }
  let segments; // [{start, end, words?}]
  let durationSeconds;
  let mode;
  let source;
  if (wordsFile) {
    mode = "words";
    const wordsPath = await requireInput(wordsFile, "words file");
    source = wordsPath;
    let raw;
    try {
      raw = JSON.parse(await readFile(wordsPath, "utf8"));
    } catch (e) {
      throw new MediaKitError(`chapters could not parse the words file as JSON: ${e.message}`, "INVALID_ARG");
    }
    let words;
    try {
      words = normalizeTranscriptWords(raw, "words file");
    } catch (e) {
      throw new MediaKitError(e.message.replace(/^cut_words/, "chapters"), e.code ?? "INVALID_ARG");
    }
    const groups = [];
    let cur = [words[0]];
    for (let i = 1; i < words.length; i++) {
      if (words[i].start - words[i - 1].end >= gap) { groups.push(cur); cur = [words[i]]; }
      else cur.push(words[i]);
    }
    groups.push(cur);
    segments = groups.map((ws) => ({ start: ws[0].start, end: ws[ws.length - 1].end, words: ws }));
    durationSeconds = +words[words.length - 1].end.toFixed(3);
  } else {
    mode = "silence";
    let detected;
    try {
      detected = await detectSilence(input, { thresholdDb, minDuration });
    } catch (e) {
      throw new MediaKitError(e.message.replace(/^silence needs/, "chapters needs"), e.code ?? "INVALID_ARG");
    }
    source = detected.input;
    durationSeconds = detected.duration_seconds;
    // Speech is the complement of the silences; a chapter starts at
    // each speech segment whose preceding silence lasted >= min_gap.
    const speech = [];
    let cursor = 0;
    let prevSilence = 0;
    for (const s of detected.silences) {
      if (s.start > cursor) speech.push({ start: cursor, end: s.start, silenceBefore: prevSilence });
      prevSilence = s.duration;
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < durationSeconds) speech.push({ start: cursor, end: durationSeconds, silenceBefore: prevSilence });
    if (speech.length === 0) {
      throw new MediaKitError("chapters found no speech — the whole file is silence (lower --threshold-db or check the input)", "INVALID_ARG");
    }
    segments = speech.filter((seg, i) => i === 0 || seg.silenceBefore >= gap);
  }
  // Over the cap: merge the closest neighbours first (the smallest
  // pause is the least likely chapter boundary), until it fits.
  let merged = 0;
  while (segments.length > maxC) {
    let bi = 0;
    let bg = Infinity;
    for (let i = 0; i < segments.length - 1; i++) {
      const g = segments[i + 1].start - segments[i].end;
      if (g < bg) { bg = g; bi = i; }
    }
    const a = segments[bi];
    const b = segments[bi + 1];
    segments[bi] = { start: a.start, end: b.end, ...(a.words ? { words: [...a.words, ...b.words] } : {}) };
    segments.splice(bi + 1, 1);
    merged++;
  }
  const firstStart = segments[0].start;
  const clamped = firstStart > 0;
  const chapters = segments.map((seg, i) => ({
    title: mode === "words" ? chapterTitleFromWords(seg.words, titleN) : `Part ${i + 1}`,
    at: i === 0 ? 0 : +seg.start.toFixed(3),
  }));
  const base = {
    operation: "chapters",
    mode,
    source,
    chapters,
    count: chapters.length,
    segments_found: segments.length + merged,
    merged_segments: merged,
    min_gap_seconds: gap,
    duration_seconds: durationSeconds,
    first_chapter_clamped_to_zero: clamped,
    ...(clamped ? { first_segment_starts_at_seconds: +firstStart.toFixed(3) } : {}),
  };
  if (output === null || output === undefined) return base;
  const outPath = await prepareOutput(output, [source]);
  if (path.extname(outPath).toLowerCase() !== ".json") {
    throw new MediaKitError(`chapters output must end in .json, got ${path.extname(outPath) || "(no extension)"}`, "INVALID_ARG");
  }
  await writeFile(outPath, JSON.stringify({ chapters }, null, 2), "utf8");
  const info = await fileInfo(outPath);
  return { ...base, output: outPath, ...info };
}

// ---------------------------------------------------------------- publish_kit
// Thumbnail & Publishing Kit (stickman-video-director's finishing step,
// as a tool instead of prose): from a finished video + a 1280x720
// 16:9 thumbnail + agent-written copy, write publishing/metadata.md
// and publishing.json, and report a pre-publish checklist. What the
// tool CAN verify it checks (thumbnail size, 5 distinct titles,
// chapter times against the measured duration, SHA-256); what it
// CANNOT verify it marks human-review instead of passing — mobile
// readability, title/cover fidelity and licences are never certified
// by this tool. Titles are the agent's words, not the tool's: the
// tool only flags unsupported-promise phrasing as a warning.
export const SHORTS_STYLE_IDS = ["clean-bold", "minimal-line", "warm-story"];

// Named style library for titlecard + intro (backlog item; the
// registry-of-named-blocks idea from heygen-com/hyperframes, applied
// to MediaKit's own style-lock). One id picks the locked palette
// (text/box/font) for both tools, so a whole video keeps one look
// without retyping hex values. The JSON file is the single source of
// truth — it ships in the npm package ("skills" is in package.json
// "files") — and it is read lazily here, failing loudly when it is
// missing, malformed, or out of sync with SHORTS_STYLE_IDS, instead
// of silently falling back to defaults. An explicit colour/font arg
// is a scoped override for that one call only (per the styles.json
// rules): it wins over the locked value and is reported in
// style_overrides, never written back to the library.
let _shortsStylesCache = null;

export async function getShortsStyles() {
  if (_shortsStylesCache) return _shortsStylesCache;
  const url = new URL("../skills/shorts-video/styles.json", import.meta.url);
  let raw;
  try {
    raw = await readFile(url, "utf8");
  } catch {
    throw new MediaKitError("shorts style library missing: skills/shorts-video/styles.json not found next to the package", "STYLE_LIBRARY_MISSING");
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new MediaKitError("shorts style library is not valid JSON: skills/shorts-video/styles.json", "STYLE_LIBRARY_INVALID");
  }
  if (!doc || !Array.isArray(doc.styles) || doc.styles.length === 0) {
    throw new MediaKitError("shorts style library has no styles: skills/shorts-video/styles.json", "STYLE_LIBRARY_INVALID");
  }
  const byId = {};
  for (const s of doc.styles) {
    const tc = s?.locked?.titlecard;
    if (!s?.id || !tc || !tc.text_color || !tc.box_color || !Number.isFinite(tc.font_size)) {
      throw new MediaKitError(`shorts style library: style ${JSON.stringify(s?.id)} is missing locked.titlecard {text_color, box_color, font_size}`, "STYLE_LIBRARY_INVALID");
    }
    byId[s.id] = {
      id: s.id,
      name: s.name ?? s.id,
      titlecard: { text_color: String(tc.text_color), box_color: String(tc.box_color), font_size: tc.font_size },
    };
  }
  const ids = Object.keys(byId).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...SHORTS_STYLE_IDS].sort())) {
    throw new MediaKitError(`shorts style library ids (${ids.join(", ")}) do not match SHORTS_STYLE_IDS (${SHORTS_STYLE_IDS.join(", ")}); update both together`, "STYLE_LIBRARY_INVALID");
  }
  _shortsStylesCache = byId;
  return byId;
}

export async function resolveShortsStyle(style) {
  if (style === null || style === undefined) return null;
  if (typeof style !== "string" || !SHORTS_STYLE_IDS.includes(style)) {
    throw new MediaKitError(`style must be one of ${SHORTS_STYLE_IDS.join(", ")}, got: ${style}`, "INVALID_ARG");
  }
  const styles = await getShortsStyles();
  const found = styles[style];
  if (!found) {
    throw new MediaKitError(`style ${style} is listed but has no locked palette in skills/shorts-video/styles.json`, "STYLE_LIBRARY_INVALID");
  }
  return found;
}

const PUBLISH_KIT_HYPE = [
  /guaranteed/i,
  /100%\s*viral/i,
  /get rich/i,
  /make \$[\d,]+/i,
  /overnight (millionaire|success)/i,
  /click here/i,
];

function formatChapterTime(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export async function publishKit({ input, thumbnail, outputDir, style = null, titles, description, tags, pinnedComment, chapters = null }) {
  const inPath = await requireInput(input);
  const thumbPath = await requireInput(thumbnail, "thumbnail");
  const outDir = await prepareOutputDir(outputDir);
  if (style !== null && style !== undefined && !SHORTS_STYLE_IDS.includes(style)) {
    throw new MediaKitError(`publish_kit style must be one of ${SHORTS_STYLE_IDS.join(", ")}, got: ${style}`, "INVALID_ARG");
  }
  if (!Array.isArray(titles) || titles.length !== 5) {
    throw new MediaKitError(`publish_kit needs exactly 5 titles, got ${Array.isArray(titles) ? titles.length : "not an array"}`, "INVALID_ARG");
  }
  const cleanTitles = titles.map((t, i) => {
    if (typeof t !== "string" || !t.trim()) throw new MediaKitError(`title ${i + 1} must be a non-empty string`, "INVALID_ARG");
    const s = t.trim();
    if (s.length > 100) throw new MediaKitError(`title ${i + 1} is ${s.length} characters (max 100)`, "INVALID_ARG");
    return s;
  });
  if (new Set(cleanTitles.map((t) => t.toLowerCase())).size !== 5) {
    throw new MediaKitError("publish_kit titles must be 5 distinct titles", "INVALID_ARG");
  }
  if (typeof description !== "string" || !description.trim() || description.trim().length > 5000) {
    throw new MediaKitError("publish_kit description must be 1-5000 characters", "INVALID_ARG");
  }
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 30) {
    throw new MediaKitError(`publish_kit needs 1-30 tags, got ${Array.isArray(tags) ? tags.length : "not an array"}`, "INVALID_ARG");
  }
  const cleanTags = tags.map((t, i) => {
    if (typeof t !== "string" || !t.trim() || t.trim().length > 50) throw new MediaKitError(`tag ${i + 1} must be 1-50 characters`, "INVALID_ARG");
    return t.trim();
  });
  if (typeof pinnedComment !== "string" || !pinnedComment.trim() || pinnedComment.trim().length > 500) {
    throw new MediaKitError("publish_kit pinned_comment must be 1-500 characters", "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("publish_kit input must be a video file", "INVALID_ARG");
  if (!Number.isFinite(meta.duration_seconds)) throw new MediaKitError("publish_kit could not measure the video duration", "INVALID_ARG");
  const duration = meta.duration_seconds;
  const thumbMeta = await probe(thumbPath);
  if (!thumbMeta.video) throw new MediaKitError("publish_kit thumbnail must be an image file", "INVALID_ARG");
  const tw = thumbMeta.video.width;
  const th = thumbMeta.video.height;
  if (Math.abs(tw / th - 16 / 9) > 0.01 || tw < 1280) {
    throw new MediaKitError(`publish_kit thumbnail must be 16:9 and at least 1280px wide, got ${tw}x${th}`, "INVALID_ARG");
  }
  let cleanChapters = null;
  if (chapters !== null && chapters !== undefined) {
    if (!Array.isArray(chapters)) throw new MediaKitError("publish_kit chapters must be an array [{time, label}]", "INVALID_ARG");
    cleanChapters = chapters.map((c, i) => {
      if (!c || typeof c !== "object") throw new MediaKitError(`chapter ${i + 1} must be an object {time, label}`, "INVALID_ARG");
      const t = parseTime(c.time, `chapter ${i + 1} time`);
      if (!(t >= 0 && t < duration)) throw new MediaKitError(`chapter ${i + 1} time ${c.time} is outside the video (0..${duration}s)`, "INVALID_ARG");
      if (typeof c.label !== "string" || !c.label.trim() || c.label.trim().length > 80) {
        throw new MediaKitError(`chapter ${i + 1} label must be 1-80 characters`, "INVALID_ARG");
      }
      return { time_seconds: +t.toFixed(3), time: formatChapterTime(t), label: c.label.trim() };
    });
    for (let i = 1; i < cleanChapters.length; i++) {
      if (cleanChapters[i].time_seconds <= cleanChapters[i - 1].time_seconds) {
        throw new MediaKitError("publish_kit chapters must be in increasing time order", "INVALID_ARG");
      }
    }
  }
  const warnings = [];
  cleanTitles.forEach((t, i) => {
    for (const re of PUBLISH_KIT_HYPE) {
      if (re.test(t)) warnings.push(`title ${i + 1} looks like an unsupported promise (matches /${re.source}/): "${t}" — verify the claim is actually in the video before publishing`);
    }
  });
  const mediaSha = createHash("sha256").update(await readFile(inPath)).digest("hex");
  const thumbSha = createHash("sha256").update(await readFile(thumbPath)).digest("hex");
  const checklist = [
    { item: `thumbnail is ${tw}x${th} (16:9, >=1280px wide)`, status: "checked" },
    { item: "5 distinct titles, each 1-100 characters", status: "checked" },
    { item: cleanChapters ? `chapters (${cleanChapters.length}) verified against measured duration ${duration}s` : "no chapters requested", status: cleanChapters ? "checked" : "not-applicable" },
    { item: `media SHA-256 recorded (${mediaSha.slice(0, 12)}…)`, status: "checked" },
    { item: "mobile readability / safe zones of the thumbnail", status: "human-review" },
    { item: "script / title / cover fidelity — the thumbnail shows something actually in the video", status: "human-review" },
    { item: "music / SFX / image licences for everything in the video", status: "human-review" },
  ];
  const checkMark = (s) => (s === "checked" ? "[x]" : s === "not-applicable" ? "[-]" : "[ ]");
  const md = [
    `# Publishing kit — ${path.basename(inPath)}`,
    "",
    `- Media: ${path.basename(inPath)} (${meta.video.width}x${meta.video.height}, ${duration}s, SHA-256 ${mediaSha.slice(0, 12)}…)`,
    `- Thumbnail: ${path.basename(thumbPath)} (${tw}x${th}, SHA-256 ${thumbSha.slice(0, 12)}…)`,
    `- Style: ${style ?? "none — no style lock applied"}`,
    "",
    "## Titles (pick one)",
    "",
    ...cleanTitles.map((t, i) => `${i + 1}. ${t}`),
    "",
    "## Description",
    "",
    description.trim(),
    "",
    "## Tags",
    "",
    cleanTags.join(", "),
    "",
    "## Pinned comment",
    "",
    pinnedComment.trim(),
    "",
    ...(cleanChapters ? ["## Chapters", "", ...cleanChapters.map((c) => `- ${c.time} ${c.label}`), ""] : []),
    "## Pre-publish checklist",
    "",
    ...checklist.map((c) => `- ${checkMark(c.status)} ${c.item}${c.status === "human-review" ? " — HUMAN REVIEW, not verified by this tool" : ""}`),
    "",
  ].join("\n");
  const metadataPath = path.join(outDir, "metadata.md");
  const jsonPath = path.join(outDir, "publishing.json");
  await writeFile(metadataPath, md, "utf8");
  const doc = {
    tool: "mediakit-for-agents",
    mediakit_version: MEDIAKIT_VERSION,
    created_at: new Date().toISOString(),
    style: style ?? null,
    media: { file: path.basename(inPath), path: inPath, width: meta.video.width, height: meta.video.height, duration_seconds: duration, sha256: mediaSha },
    thumbnail: { file: path.basename(thumbPath), path: thumbPath, width: tw, height: th, sha256: thumbSha },
    titles: cleanTitles,
    description: description.trim(),
    tags: cleanTags,
    pinned_comment: pinnedComment.trim(),
    chapters: cleanChapters,
    checklist,
    warnings,
  };
  await writeFile(jsonPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return {
    operation: "publish_kit",
    output_dir: outDir,
    metadata: metadataPath,
    publishing_json: jsonPath,
    style: style ?? null,
    media: { width: meta.video.width, height: meta.video.height, duration_seconds: duration, sha256: mediaSha },
    thumbnail: { width: tw, height: th, sha256: thumbSha },
    titles: cleanTitles,
    checklist,
    warnings,
  };
}

// ---------------------------------------------------------------- transcribe

// ---------------------------------------------------------------- transcribe
// Speech-to-text with a LOCAL engine — faster-whisper (default) or
// whisper.cpp (--engine whisper), on this machine, audio never
// uploaded (the ffmpeg-skill pattern: optional local ASR, refuse with
// install lines rather than guessing). Pipeline: probe for an audio
// stream, extract 16 kHz mono WAV to a temp dir with ffmpeg, run the
// engine, write the segments as .srt with the same formatter
// generate_srt uses. Silence transcribes to 0 segments and an empty
// .srt — that is a correct result, not a failure.
// faster-whisper path: scripts/asr_faster_whisper.py (stdlib wave +
// numpy, so PyAV's version never matters). Env: MEDIAKIT_ASR_PYTHON
// (default "python3") picks the python that has faster-whisper;
// MEDIAKIT_ASR_MODEL (default "tiny") picks the default model. Model
// weights (~75 MB for tiny) download from Hugging Face on first use.
// whisper.cpp path: the whisper-cli binary (release b5454 or newer)
// with -ojf JSON output; segments come from transcription[].offsets
// (milliseconds) and the language from result.language. Env:
// MEDIAKIT_WHISPER_CPP_BIN (default ~/.local/share/mediakit/
// whisper.cpp/whisper-cli, else whisper-cli/main on PATH);
// MEDIAKIT_WHISPER_MODEL (default <same dir>/ggml-<model>.bin).

const ASR_MODELS = [
  "tiny", "tiny.en", "base", "base.en", "small", "small.en",
  "medium", "medium.en", "large-v1", "large-v2", "large-v3",
  "large-v3-turbo", "distil-small.en", "distil-medium.en",
  "distil-large-v2", "distil-large-v3",
];
const ASR_INSTALL_HINT = "no speech engine found — transcribe needs faster-whisper on this machine (local only, audio is never uploaded): python3 -m venv ~/.local/venv/mediakit-asr && ~/.local/venv/mediakit-asr/bin/pip install faster-whisper, then set MEDIAKIT_ASR_PYTHON to that venv's python (or point it at a python that already has faster-whisper). Model weights (~75 MB for tiny) download from Hugging Face on first use.";
const WHISPER_CPP_INSTALL_HINT = "no whisper.cpp binary found — transcribe --engine whisper needs the whisper.cpp CLI on this machine (local only, audio is never uploaded): download whisper-bin-ubuntu-x64.tar.gz from https://github.com/ggerganov/whisper.cpp/releases (tag b5454 or newer) and a ggml model from https://huggingface.co/ggerganov/whisper.cpp (e.g. ggml-tiny.bin, ~75 MB), then set MEDIAKIT_WHISPER_CPP_BIN to the whisper-cli binary and MEDIAKIT_WHISPER_MODEL to the model file.";
const WHISPER_CPP_MODEL_HINT = "whisper.cpp model file not found — download it from https://huggingface.co/ggerganov/whisper.cpp (e.g. ggml-tiny.bin, ~75 MB) and set MEDIAKIT_WHISPER_MODEL to its path";

function asrPython() {
  return process.env.MEDIAKIT_ASR_PYTHON || "python3";
}

function whisperCppDir() {
  return path.join(os.homedir(), ".local", "share", "mediakit", "whisper.cpp");
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function whichBin(name) {
  try {
    const { stdout } = await runCapture("which", [name], { timeoutMs: 10_000 });
    return String(stdout).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

export async function detectAsrEngine() {
  const python = asrPython();
  try {
    await runCapture(python, ["-c", "import faster_whisper"], { timeoutMs: 60_000 });
    return { engine: "faster-whisper", python, available: true };
  } catch {
    return { engine: "faster-whisper", python, available: false };
  }
}

// whisper.cpp: binary first, then the model file for the requested
// model name (ggml-<model>.bin). A missing binary and a missing model
// are different failures with different fixes, so they are reported
// separately (missing: ["binary"] vs ["model"]).
export async function detectWhisperCpp(model = "tiny") {
  // An explicit MEDIAKIT_WHISPER_CPP_BIN is a choice, not a hint:
  // if it does not exist, fail loudly instead of silently falling
  // back to another binary (a stale env var must never quietly pick
  // a different engine build).
  const envBin = process.env.MEDIAKIT_WHISPER_CPP_BIN;
  let binary = null;
  if (envBin?.trim()) {
    if (await fileExists(envBin.trim())) binary = envBin.trim();
    else return { engine: "whisper.cpp", binary: null, model: null, available: false, missing: ["binary"] };
  } else {
    const candidates = [path.join(whisperCppDir(), "whisper-cli")];
    for (const name of ["whisper-cli", "main"]) {
      const found = await whichBin(name);
      if (found) candidates.push(found);
    }
    for (const c of candidates) if (await fileExists(c)) { binary = c; break; }
    if (!binary) return { engine: "whisper.cpp", binary: null, model: null, available: false, missing: ["binary"] };
  }
  const envModel = process.env.MEDIAKIT_WHISPER_MODEL;
  const modelPath = envModel?.trim() ? envModel.trim() : path.join(whisperCppDir(), `ggml-${model}.bin`);
  if (!(await fileExists(modelPath))) return { engine: "whisper.cpp", binary, model: modelPath, available: false, missing: ["model"] };
  return { engine: "whisper.cpp", binary, model: modelPath, available: true };
}

// Combined probe for doctor() and engine=auto: faster-whisper first
// (pip install is enough, no binary to fetch), then whisper.cpp.
// Neither available -> engine "none" and a fix carrying both
// install lines, so the caller can pick whichever is easier.
export async function detectTranscribe(model = "tiny") {
  const fw = await detectAsrEngine();
  if (fw.available) return { ...fw, available: true };
  const cpp = await detectWhisperCpp(model);
  if (cpp.available) return { ...cpp, available: true };
  return {
    engine: "none", available: false, python: fw.python,
    fix: `${ASR_INSTALL_HINT} Alternatively: ${WHISPER_CPP_INSTALL_HINT}`,
  };
}

// Chunks overlap by 2s so a word straddling a boundary is heard whole
// by at least one chunk; the ownership rule below (a segment belongs
// to the chunk whose owned window its start falls in) keeps the merge
// from duplicating the overlapped speech.
const TRANSCRIBE_CHUNK_OVERLAP_SECONDS = 2;

// whisper.cpp -ojf JSON carries per-token ms offsets. Group tokens
// into words: a token starting with a space starts a new word, anything
// else (punctuation, "n't") attaches to the current word; special
// tokens ([_BEG_], [_END_]) are skipped. A word whose tokens all share
// one timestamp (the first token of a file often reports from == to)
// gets a 0.1s floor so end > start. Times come from the engine, never
// from the caller — the same rule transcriptcut states for its cuts.
export function wordsFromWhisperCppTokens(tokens) {
  const words = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.end <= cur.start) cur.end = cur.start + 0.1;
    words.push(cur);
    cur = null;
  };
  for (const t of tokens ?? []) {
    const text = String(t?.text ?? "");
    // Any bracketed token is a whisper.cpp special token ([_BEG_],
    // [_END_], [_TT_525] timestamp markers, ...) — never speech.
    // Note [_TT_525] ends in "5]", not "_]", so the test must be
    // "bracketed", not "starts [_ and ends _]".
    if (!text || /^\[.*\]$/.test(text)) continue;
    const from = (t?.offsets?.from ?? 0) / 1000;
    const to = (t?.offsets?.to ?? 0) / 1000;
    if (text.startsWith(" ")) {
      flush();
      cur = { start: from, end: to, word: text.trim() };
    } else if (cur) {
      cur.word += text;
      cur.end = Math.max(cur.end, to);
    } else {
      cur = { start: from, end: to, word: text.trim() };
    }
  }
  flush();
  return words.filter((w) => w.word && w.end > w.start);
}

// One ASR run over one WAV file, either engine. Returns raw segments
// in seconds ({start, end, text}), the detected language and its
// probability — the caller offsets and merges them. Separated out so
// the chunked path can call it once per chunk with the same code.
// With wantWords, also returns a flat words list [{start, end, word}]
// in timeline order (faster-whisper word_timestamps, whisper.cpp
// tokens grouped by wordsFromWhisperCppTokens).
async function runAsrOnWav(selected, wavPath, mdl, lang, tmpDir, tag, wantWords = false) {
  if (selected.engine === "whisper.cpp") {
    const outBase = path.join(tmpDir, `whisper-${tag}`);
    await runCapture(selected.binary, ["-m", selected.model, "-f", wavPath, "-l", lang, "-ojf", "-of", outBase, "-np"], { timeoutMs: 1_800_000 });
    let raw;
    try {
      raw = await readFile(`${outBase}.json`, "utf8");
    } catch {
      throw new MediaKitError("transcribe: whisper.cpp finished but wrote no JSON output", "ASR_FAILED");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MediaKitError(`transcribe: whisper.cpp returned unparseable JSON: ${raw.slice(0, 200)}`, "ASR_FAILED");
    }
    const segs = Array.isArray(parsed.transcription) ? parsed.transcription : [];
    const tokens = [];
    if (wantWords) for (const s of segs) if (Array.isArray(s.tokens)) tokens.push(...s.tokens);
    return {
      segments: segs.map((s) => ({ start: (s.offsets?.from ?? 0) / 1000, end: (s.offsets?.to ?? 0) / 1000, text: s.text ?? "" })),
      words: wantWords ? wordsFromWhisperCppTokens(tokens) : [],
      language: parsed.result?.language ?? null,
      language_probability: null,
    };
  }
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "asr_faster_whisper.py");
  const args = [helper, "--wav", wavPath, "--model", mdl];
  if (lang !== "auto") args.push("--language", lang);
  if (wantWords) args.push("--word-timestamps");
  const { stdout } = await runCapture(selected.python, args, { timeoutMs: 1_800_000 });
  try {
    const asr = JSON.parse(stdout);
    return {
      segments: Array.isArray(asr.segments) ? asr.segments : [],
      words: wantWords && Array.isArray(asr.words)
        ? asr.words.map((w) => ({ start: w.start, end: w.end, word: w.word, probability: w.probability ?? null }))
        : [],
      language: asr.language ?? null,
      language_probability: asr.language_probability ?? null,
    };
  } catch {
    throw new MediaKitError(`transcribe: the ASR helper returned unparseable output: ${String(stdout).slice(0, 200)}`, "ASR_FAILED");
  }
}

export async function transcribe({ input, output, model = "tiny", language = "auto", engine = "auto", chunk_seconds = null, word_timestamps = false }) {
  const inPath = await requireInput(input);
  const engRaw = String(engine ?? "auto").toLowerCase();
  const eng = engRaw === "whisper.cpp" ? "whisper" : engRaw;
  if (!["auto", "faster-whisper", "whisper"].includes(eng)) {
    throw new MediaKitError(`transcribe engine "${engine}" is not supported — use "auto", "faster-whisper" or "whisper" (whisper.cpp); the engine runs locally, audio is never uploaded`, "INVALID_ARG");
  }
  const mdl = String(model ?? process.env.MEDIAKIT_ASR_MODEL ?? "tiny").toLowerCase();
  if (!ASR_MODELS.includes(mdl)) {
    throw new MediaKitError(`unknown ASR model "${model}" (supported: ${ASR_MODELS.join(", ")})`, "INVALID_ARG");
  }
  const lang = String(language ?? "auto").toLowerCase();
  if (lang !== "auto" && !/^[a-z]{2,3}$/.test(lang)) {
    throw new MediaKitError(`language must be "auto" or an ISO 639-1 code (e.g. en, vi), got "${language}"`, "INVALID_ARG");
  }
  const cs = chunk_seconds === null || chunk_seconds === undefined
    ? null
    : num(chunk_seconds, "chunk_seconds", { min: 5, max: 1800, integer: true });
  const wantWords = word_timestamps === true;
  const outPath = await prepareOutput(output, [inPath]);
  if (path.extname(outPath).toLowerCase() !== ".srt") {
    throw new MediaKitError(`transcribe output must end in .srt, got ${path.extname(outPath) || "(no extension)"}`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.audio) throw new MediaKitError("transcribe needs an input with an audio stream", "INVALID_ARG");
  // Resolve the engine before extracting audio: auto prefers
  // faster-whisper, then whisper.cpp; an explicit engine must exist
  // (binary AND model for whisper.cpp).
  let selected;
  if (eng === "faster-whisper") {
    const fw = await detectAsrEngine();
    if (!fw.available) throw new MediaKitError(`transcribe: ${ASR_INSTALL_HINT}`, "ASR_NOT_INSTALLED");
    selected = fw;
  } else if (eng === "whisper") {
    const cpp = await detectWhisperCpp(mdl);
    if (!cpp.available) {
      if (cpp.missing?.includes("binary")) throw new MediaKitError(`transcribe: ${WHISPER_CPP_INSTALL_HINT}`, "ASR_NOT_INSTALLED");
      throw new MediaKitError(`transcribe: ${WHISPER_CPP_MODEL_HINT} (looked for ${cpp.model})`, "ASR_NOT_INSTALLED");
    }
    selected = cpp;
  } else {
    const both = await detectTranscribe(mdl);
    if (!both.available) throw new MediaKitError(`transcribe: ${both.fix}`, "ASR_NOT_INSTALLED");
    selected = both;
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediakit-asr-"));
  try {
    const wav = path.join(tmpDir, "asr.wav");
    await run(FFMPEG, ["-y", "-i", inPath, "-vn", "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", wav]);
    const duration = meta.duration_seconds ?? null;
    // Chunked mode: split the WAV into chunk_seconds pieces (+2s
    // overlap), transcribe each, offset the segments back onto the
    // full timeline. A file shorter than one chunk runs as a single
    // chunk — same result as the unchunked path, but the report says
    // chunks: 1 so the caller can see chunking was requested.
    const chunked = cs !== null && duration !== null && duration > cs;
    const chunkCount = chunked ? Math.ceil(duration / cs) : 1;
    const overlap = chunked ? TRANSCRIBE_CHUNK_OVERLAP_SECONDS : 0;
    let rawSegments = [];
    let rawWords = [];
    let language = null;
    let languageProbability = null;
    if (!chunked) {
      const asr = await runAsrOnWav(selected, wav, mdl, lang, tmpDir, "full", wantWords);
      rawSegments = asr.segments;
      rawWords = asr.words;
      language = asr.language;
      languageProbability = asr.language_probability;
    } else {
      for (let i = 0; i < chunkCount; i++) {
        const start = i * cs;
        const end = Math.min(start + cs + overlap, duration);
        const chunkWav = path.join(tmpDir, `chunk-${i}.wav`);
        await run(FFMPEG, ["-y", "-ss", String(start), "-t", String(+(end - start).toFixed(3)), "-i", wav, "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", chunkWav]);
        const asr = await runAsrOnWav(selected, chunkWav, mdl, lang, tmpDir, `chunk-${i}`, wantWords);
        // Ownership: a segment belongs to the chunk whose owned
        // window [chunk start, next chunk start) its start falls in,
        // so the 2s overlap is transcribed twice but kept once. The
        // last chunk owns everything to the end of the file.
        const ownedEnd = i === chunkCount - 1 ? Infinity : (i + 1) * cs;
        for (const s of asr.segments) {
          const st = s.start + start;
          const en = Math.min(s.end + start, end);
          if (st >= ownedEnd) continue;
          if (!(en > st)) continue;
          rawSegments.push({ start: st, end: en, text: s.text });
        }
        // Words follow the same ownership rule, so a word straddling
        // a boundary is kept once, by the chunk that owns its start.
        for (const w of asr.words ?? []) {
          const st = w.start + start;
          const en = Math.min(w.end + start, end);
          if (st >= ownedEnd) continue;
          if (!(en > st)) continue;
          rawWords.push({ start: st, end: en, word: w.word, probability: w.probability ?? null });
        }
        if (language === null && asr.language) {
          language = asr.language;
          languageProbability = asr.language_probability;
        }
      }
    }
    const segments = (rawSegments ?? [])
      .map((s) => ({
        start: num(s.start, "segment start", { min: 0 }),
        end: num(s.end, "segment end", { min: 0 }),
        text: String(s.text ?? "").trim(),
      }))
      .filter((s) => s.end > s.start && s.text)
      .sort((a, b) => a.start - b.start);
    // Words are normalized the same way, then numbered 0-based in
    // timeline order — those indices are what cut_words --indices
    // takes, so the transcript JSON is the single source of truth
    // for which word is which (never a hand-typed timestamp).
    const words = wantWords
      ? (rawWords ?? [])
        .map((w) => ({
          start: num(w.start, "word start", { min: 0 }),
          end: num(w.end, "word end", { min: 0 }),
          word: String(w.word ?? "").trim(),
          probability: typeof w.probability === "number" ? w.probability : null,
        }))
        .filter((w) => w.end > w.start && w.word && !/\s/.test(w.word))
        .sort((a, b) => a.start - b.start)
        .map((w, i) => ({ index: i, start: +w.start.toFixed(3), end: +w.end.toFixed(3), word: w.word, ...(w.probability === null ? {} : { probability: w.probability }) }))
      : [];
    const normalized = segments.map((s) => ({ startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: s.text }));
    await writeFile(outPath, formatSrtBody(normalized), "utf8");
    const info = await fileInfo(outPath);
    return {
      operation: "transcribe",
      input: inPath,
      output: outPath,
      engine: selected.engine,
      model: mdl,
      language: language ?? null,
      language_probability: languageProbability ?? null,
      duration_seconds: duration,
      chunk_seconds: cs,
      chunks: chunkCount,
      chunk_overlap_seconds: overlap,
      segment_count: segments.length,
      segments: segments.map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), text: s.text })),
      text: segments.map((s) => s.text).join(" "),
      ...(wantWords ? { word_timestamps: true, word_count: words.length, words } : {}),
      ...info,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- titlecard
// Title card image: a big bold hook (3-6 words) on a coloured box, on a
// transparent canvas so it overlays cleanly onto any frame (see overlay).
// Text wraps to ~14 chars per line; the block sits in the safe zone
// (centred horizontally, ~55% down the frame). One drawtext call with
// a textfile: newlines handled natively, one box around the whole block.

const TITLECARD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function wrapTitleLines(text, maxChars = 14) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function normalizeColor(c, name) {
  const v = String(c).trim().replace(/^#/, "");
  if (!/^(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8}|[a-zA-Z]+)$/.test(v)) {
    throw new MediaKitError(`titlecard ${name} must be a color name or hex like FFD60A, got: ${c}`, "INVALID_ARG");
  }
  return v;
}

export async function titlecard({ text, output, width = 1080, height = 1920, fontSize = null, textColor = null, boxColor = null, style = null, brand = null }) {
  if (!text || !String(text).trim()) throw new MediaKitError("titlecard needs text", "INVALID_ARG");
  const outPath = await prepareOutput(output, []);
  const w = num(width, "width", { min: 2, integer: true });
  const h = num(height, "height", { min: 2, integer: true });
  if (w % 2 !== 0 || h % 2 !== 0) throw new MediaKitError("titlecard width/height must be even", "INVALID_ARG");
  // Named style (clean-bold / minimal-line / warm-story) supplies the
  // locked palette; an explicit colour/font arg overrides just that
  // one value for this call and is reported in style_overrides.
  // A brand (same registry as assemble) paints the card in the
  // channel look: primary is the box, on_primary the text — so the
  // title card matches the film it opens. Resolution order is
  // explicit > brand > style > default. The brand never sets the
  // font size: brand.text_size is tuned for assemble text layers,
  // and a 64px hook would shrink the title card (default ~119px).
  const locked = await resolveShortsStyle(style);
  const brandProfile = await resolveAssembleBrand(brand, "brand");
  const overrides = [];
  const brandApplied = [];
  const brandOverrides = [];
  if (brandProfile) {
    if (textColor !== null && textColor !== undefined) brandOverrides.push("text_color");
    else brandApplied.push("text_color");
    if (boxColor !== null && boxColor !== undefined) brandOverrides.push("box_color");
    else brandApplied.push("box_color");
  }
  let size;
  let fg;
  let bg;
  if (locked) {
    if (textColor !== null && textColor !== undefined) overrides.push("text_color");
    if (boxColor !== null && boxColor !== undefined) overrides.push("box_color");
    if (fontSize !== null && fontSize !== undefined) overrides.push("font_size");
    size = fontSize === null || fontSize === undefined ? locked.titlecard.font_size : num(fontSize, "font_size", { min: 16, max: 400, integer: true });
  } else {
    size = fontSize === null || fontSize === undefined ? Math.round(w * 0.11) : num(fontSize, "font_size", { min: 16, max: 400, integer: true });
  }
  fg = normalizeColor(textColor ?? brandProfile?.palette?.on_primary ?? locked?.titlecard?.text_color ?? "FFD60A", "text_color");
  bg = normalizeColor(boxColor ?? brandProfile?.palette?.primary ?? locked?.titlecard?.box_color ?? "F97316", "box_color");
  const lines = wrapTitleLines(String(text).trim().toUpperCase());
  // Textfile (not inline text): drawtext reads newlines natively and
  // draws one box around the whole block.
  const tmpFile = path.join(path.dirname(outPath), `.titlecard-${process.pid}.txt`);
  await writeFile(tmpFile, lines.join("\n"), "utf8");
  const esc = tmpFile.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  try {
    // nullsrc + geq clears the whole canvas first (all channels to 0,
    // including alpha): lavfi color sources ignore alpha (always
    // opaque), so the canvas must be made transparent explicitly
    // before drawtext paints the opaque box+text.
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `nullsrc=s=${w}x${h}:r=30:d=0.1`,
      "-vf", `format=rgba,geq=r='0':g='0':b='0':a='0',drawtext=fontfile=${TITLECARD_FONT}:textfile=${esc}:fontsize=${size}:fontcolor=0x${fg}:borderw=6:bordercolor=black:box=1:boxcolor=0x${bg}:boxborderw=${Math.round(size * 0.25)}:x=(w-text_w)/2:y=(h-text_h)*0.55`,
      "-frames:v", "1", outPath,
    ]);
  } finally {
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpFile).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "titlecard", output: outPath, text: String(text).trim(), lines, font_size: size, text_color: fg, box_color: bg, style: style ?? null, brand: brand ?? null, brand_applied: brandApplied, brand_overrides: brandOverrides, style_overrides: overrides, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
}

// ---------------------------------------------------------------- intro
// A short intro clip: a title on a solid-colour background, fading in
// and out (the generateIntro idea from studiomeyer-io/mcp-video,
// rebuilt on ffmpeg directly). Text goes through a textfile like
// titlecard, so quoting can never break the filter. Silent video.

export async function intro({ text, output, width = 1280, height = 720, duration = 3, bgColor = null, textColor = null, fontSize = null, fadeIn = 0.5, fadeOut = 0.5, style = null, brand = null }) {
  if (!text || !String(text).trim()) throw new MediaKitError("intro needs text", "INVALID_ARG");
  const outPath = await prepareOutput(output, []);
  const w = num(width, "width", { min: 2, integer: true });
  const h = num(height, "height", { min: 2, integer: true });
  if (w % 2 !== 0 || h % 2 !== 0) throw new MediaKitError("intro width/height must be even", "INVALID_ARG");
  const d = num(duration, "duration", { min: 0.5, max: 30 });
  const fi = num(fadeIn, "fade_in", { min: 0, max: 30 });
  const fo = num(fadeOut, "fade_out", { min: 0, max: 30 });
  if (fi + fo >= d) throw new MediaKitError(`intro fade_in + fade_out (${fi + fo}s) must be shorter than duration (${d}s)`, "INVALID_ARG");
  // Named style reuses the locked titlecard palette: the box colour
  // becomes the intro background, the text colour stays the text
  // colour, and the titlecard font size is the intro font size — so
  // the intro card and the title card of one video share one look.
  // A brand (same registry as assemble) paints it in the channel
  // look instead: background is the intro background, text the text.
  // Resolution order is explicit > brand > style > default, and the
  // brand never sets the font size (same reason as titlecard).
  const locked = await resolveShortsStyle(style);
  const brandProfile = await resolveAssembleBrand(brand, "brand");
  const overrides = [];
  const brandApplied = [];
  const brandOverrides = [];
  if (brandProfile) {
    if (bgColor !== null && bgColor !== undefined) brandOverrides.push("bg_color");
    else brandApplied.push("bg_color");
    if (textColor !== null && textColor !== undefined) brandOverrides.push("text_color");
    else brandApplied.push("text_color");
  }
  let size;
  let bg;
  let fg;
  if (locked) {
    if (bgColor !== null && bgColor !== undefined) overrides.push("bg_color");
    if (textColor !== null && textColor !== undefined) overrides.push("text_color");
    if (fontSize !== null && fontSize !== undefined) overrides.push("font_size");
    size = fontSize === null || fontSize === undefined ? locked.titlecard.font_size : num(fontSize, "font_size", { min: 16, max: 400, integer: true });
  } else {
    size = fontSize === null || fontSize === undefined ? Math.round(w * 0.08) : num(fontSize, "font_size", { min: 16, max: 400, integer: true });
  }
  bg = normalizeColor(bgColor ?? brandProfile?.palette?.background ?? locked?.titlecard?.box_color ?? "0F172A", "bg_color");
  fg = normalizeColor(textColor ?? brandProfile?.palette?.text ?? locked?.titlecard?.text_color ?? "FFFFFF", "text_color");
  const lines = wrapTitleLines(String(text).trim().toUpperCase());
  const tmpFile = path.join(path.dirname(outPath), `.intro-${process.pid}.txt`);
  await writeFile(tmpFile, lines.join("\n"), "utf8");
  const esc = tmpFile.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  // Fade the text alpha in/out; each branch is only built when its
  // fade is > 0, so a zero fade never divides by zero in the filter.
  let alpha = "1";
  if (fi > 0 && fo > 0) alpha = `if(lt(t,${fi}),t/${fi},if(gt(t,${d - fo}),(${d}-t)/${fo},1))`;
  else if (fi > 0) alpha = `if(lt(t,${fi}),t/${fi},1)`;
  else if (fo > 0) alpha = `if(gt(t,${d - fo}),(${d}-t)/${fo},1)`;
  try {
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `color=c=0x${bg}:s=${w}x${h}:r=30:d=${d}`,
      "-vf", `drawtext=fontfile=${TITLECARD_FONT}:textfile=${esc}:fontsize=${size}:fontcolor=0x${fg}:alpha='${alpha}':x=(w-text_w)/2:y=(h-text_h)/2`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast",
      "-movflags", "+faststart", outPath,
    ]);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "intro", output: outPath, text: String(text).trim(), lines, font_size: size, bg_color: bg, text_color: fg, fade_in: fi, fade_out: fo, style: style ?? null, brand: brand ?? null, brand_applied: brandApplied, brand_overrides: brandOverrides, style_overrides: overrides, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null, duration_seconds: out.duration_seconds };
}

// ---------------------------------------------------------------- svg_animate
// Animate an SVG into a video, code-driven: Node interpolates keyframed
// translate/scale/rotate/opacity on elements (by id) for every frame,
// and ffmpeg's librsvg rasterizes each frame — no browser, no SMIL.
// (ffmpeg cannot play SVG animation: librsvg renders a static SVG, so
// the animation has to be computed outside, one SVG per frame, and the
// frames muxed through ffmpeg's image2 demuxer, which picks up .svg
// via librsvg — verified with a 2-frame probe: correct size, correct
// pixels, frames differ as expected.) An element's existing transform
// is kept as a prefix; the animated transform is appended. Two
// animations on the same element+property with adjacent windows chain
// (e.g. down then up = a bounce) as long as the boundary values match:
// at any time the last window that has started governs (holding at
// `to` after it ends), and before the first window the element sits
// at the first animation's `from` value — so a slide-in starts
// off-screen and a fade-in starts invisible, with no jump when the
// window opens.

const SVG_ANIM_PROPERTIES = ["translate", "scale", "rotate", "opacity"];
const SVG_ANIM_EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out"];

function svgEase(easing, p) {
  switch (easing) {
    case "ease-in": return p * p;
    case "ease-out": return 1 - (1 - p) * (1 - p);
    case "ease-in-out": return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    default: return p;
  }
}

function svgNum2(v, label) {
  if (!Array.isArray(v) || v.length !== 2 || v.some((n) => !Number.isFinite(Number(n)))) {
    throw new MediaKitError(`svg_animate ${label} must be [x, y], got: ${JSON.stringify(v)}`, "INVALID_ARG");
  }
  return [Number(v[0]), Number(v[1])];
}

function svgInterp(a, e) {
  if (a.property === "translate" || a.property === "scale") {
    return [a.from[0] + (a.to[0] - a.from[0]) * e, a.from[1] + (a.to[1] - a.from[1]) * e];
  }
  return a.from + (a.to - a.from) * e;
}

function svgScalar(v, label, { min = null, max = null } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new MediaKitError(`svg_animate ${label} must be a number, got: ${JSON.stringify(v)}`, "INVALID_ARG");
  if (min !== null && n < min) throw new MediaKitError(`svg_animate ${label} must be >= ${min}, got: ${v}`, "INVALID_ARG");
  if (max !== null && n > max) throw new MediaKitError(`svg_animate ${label} must be <= ${max}, got: ${v}`, "INVALID_ARG");
  return n;
}

// Set (or replace) one attribute on an element's opening tag.
function svgSetAttr(tag, name, value) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
  if (re.test(tag)) return tag.replace(re, `${name}="${value}"`);
  return tag.replace(/\/?>$/, (m) => ` ${name}="${value}"${m}`);
}

function svgGetAttr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2]) : null;
}

function svgEscapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const svgFmt = (n) => String(Math.round(n * 1000) / 1000);

export async function svgAnimate({ svg, animations, output, duration = 3, fps = 30, width = null, height = null, background = "FFFFFF" }) {
  const svgPath = await requireInput(svg, "svg");
  const outPath = await prepareOutput(output, [svgPath]);
  if (!Array.isArray(animations) || animations.length === 0) {
    throw new MediaKitError("svg_animate needs at least one animation", "INVALID_ARG");
  }
  const d = num(duration, "duration", { min: 0.5, max: 30 });
  const f = num(fps, "fps", { min: 1, max: 60, integer: true });
  const frames = Math.round(d * f);
  if (frames < 2) throw new MediaKitError("svg_animate needs duration * fps >= 2 frames", "INVALID_ARG");
  if (frames > 1800) throw new MediaKitError(`svg_animate caps at 1800 frames, got ${frames} (duration ${d}s x ${f}fps)`, "INVALID_ARG");

  const src = await readFile(svgPath, "utf8");
  const rootMatch = src.match(/<svg\b[^>]*>/);
  if (!rootMatch) throw new MediaKitError("svg_animate could not find a root <svg> element", "INVALID_ARG");
  const rootTag = rootMatch[0];
  const rootId = svgGetAttr(rootTag, "id");
  let w = width === null || width === undefined ? null : num(width, "width", { min: 2, integer: true });
  let h = height === null || height === undefined ? null : num(height, "height", { min: 2, integer: true });
  if ((w === null) !== (h === null)) throw new MediaKitError("svg_animate width and height must be given together", "INVALID_ARG");
  if (w === null) {
    const rw = svgGetAttr(rootTag, "width");
    const rh = svgGetAttr(rootTag, "height");
    const vb = svgGetAttr(rootTag, "viewBox");
    if (rw && rh) { w = Math.round(parseFloat(rw)); h = Math.round(parseFloat(rh)); }
    else if (vb) {
      const parts = vb.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) { w = Math.round(parts[2]); h = Math.round(parts[3]); }
    }
    if (!w || !h) throw new MediaKitError("svg_animate could not determine the canvas size: give width/height or a width/height/viewBox on the root <svg>", "INVALID_ARG");
  }
  if (w % 2 !== 0 || h % 2 !== 0) throw new MediaKitError("svg_animate width/height must be even (H.264)", "INVALID_ARG");

  // Validate + normalize every animation before rendering anything.
  const anims = animations.map((a, i) => {
    const label = `animations[${i}]`;
    if (!a || typeof a !== "object") throw new MediaKitError(`${label} must be an object`, "INVALID_ARG");
    if (typeof a.target !== "string" || !a.target.trim()) throw new MediaKitError(`${label}.target (element id) is required`, "INVALID_ARG");
    const target = a.target.trim();
    if (rootId && target === rootId) throw new MediaKitError(`${label}.target must not be the root <svg> element`, "INVALID_ARG");
    if (!SVG_ANIM_PROPERTIES.includes(a.property)) throw new MediaKitError(`${label}.property must be one of ${SVG_ANIM_PROPERTIES.join(", ")}, got: ${a.property}`, "INVALID_ARG");
    const start = a.start === undefined || a.start === null ? 0 : num(a.start, `${label}.start`, { min: 0 });
    const end = num(a.end, `${label}.end`, { min: 0 });
    if (end <= start) throw new MediaKitError(`${label}.end (${end}) must be greater than start (${start})`, "INVALID_ARG");
    if (end > d) throw new MediaKitError(`${label}.end (${end}) exceeds duration (${d})`, "INVALID_ARG");
    const easing = a.easing ?? "linear";
    if (!SVG_ANIM_EASINGS.includes(easing)) throw new MediaKitError(`${label}.easing must be one of ${SVG_ANIM_EASINGS.join(", ")}, got: ${easing}`, "INVALID_ARG");
    let from, to, center = null;
    if (a.property === "translate") { from = svgNum2(a.from, `${label}.from`); to = svgNum2(a.to, `${label}.to`); }
    else if (a.property === "scale") {
      const norm = (v, side) => Array.isArray(v) ? svgNum2(v, `${label}.${side}`)
        : [svgScalar(v, `${label}.${side}`, { min: 0 }), svgScalar(v, `${label}.${side}`, { min: 0 })];
      from = norm(a.from, "from");
      to = norm(a.to, "to");
    } else if (a.property === "rotate") {
      from = svgScalar(a.from, `${label}.from`);
      to = svgScalar(a.to, `${label}.to`);
      center = a.center === undefined || a.center === null ? [0, 0] : svgNum2(a.center, `${label}.center`);
    } else {
      from = svgScalar(a.from, `${label}.from`, { min: 0, max: 1 });
      to = svgScalar(a.to, `${label}.to`, { min: 0, max: 1 });
    }
    return { target, property: a.property, from, to, start, end, easing, center };
  });

  // Resolve each distinct target id once, on the source text.
  const targetTags = new Map();
  const missingTargets = [];
  for (const t of new Set(anims.map((a) => a.target))) {
    const re = new RegExp(`<([a-zA-Z][\\w:.-]*)\\b[^>]*\\bid=["']${svgEscapeRegExp(t)}["'][^>]*\\/?>`);
    const m = src.match(re);
    if (!m) { missingTargets.push(t); continue; }
    targetTags.set(t, m[0]);
  }

  // Base frame: explicit size on the root (so librsvg sizes every frame
  // identically even when the source only has a viewBox) + an opaque
  // background rect first (video has no alpha; without it the video
  // would flatten transparency to black).
  let base = src;
  const sizedRoot = svgSetAttr(svgSetAttr(rootTag, "width", String(w)), "height", String(h));
  base = base.replace(rootTag, () => sizedRoot);
  const bg = String(background ?? "FFFFFF").trim();
  if (bg.toLowerCase() !== "transparent") {
    const bgHex = normalizeColor(bg, "background");
    base = base.replace(sizedRoot, () => `${sizedRoot}<rect x="0" y="0" width="${w}" height="${h}" fill="#${bgHex}"/>`);
  }

  // Group animations by (target, property), sorted by start. At time t
  // the applicable animation is the last one whose window has started
  // (holding at `to` after it ends); before the first window the
  // element sits at the first animation's `from` value — so a slide-in
  // starts off-screen and a fade-in starts invisible, with no jump
  // when the window opens.
  const animGroups = [];
  {
    const byKey = new Map();
    for (const a of anims) {
      if (!targetTags.has(a.target)) continue;
      const key = `${a.target}\0${a.property}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(a);
    }
    for (const list of byKey.values()) {
      list.sort((x, y) => x.start - y.start);
      animGroups.push({ target: list[0].target, property: list[0].property, list });
    }
  }

  const tmpDir = path.join(path.dirname(outPath), `.svg-animate-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
  try {
    for (let i = 0; i < frames; i++) {
      const t = i / f;
      const perTarget = new Map();
      for (const g of animGroups) {
        let active = null;
        for (const a of g.list) { if (a.start <= t) active = a; else break; }
        const value = active === null ? g.list[0].from
          : svgInterp(active, svgEase(active.easing, Math.min(1, (t - active.start) / (active.end - active.start))));
        const cur = perTarget.get(g.target) ?? {};
        if (g.property === "translate") cur.translate = value;
        else if (g.property === "scale") cur.scale = value;
        else if (g.property === "rotate") cur.rotate = { angle: value, center: (active ?? g.list[0]).center };
        else cur.opacity = value;
        perTarget.set(g.target, cur);
      }
      let frame = base;
      for (const [id, vals] of perTarget) {
        const orig = targetTags.get(id);
        let tag = orig;
        const parts = [];
        if (vals.translate) parts.push(`translate(${svgFmt(vals.translate[0])} ${svgFmt(vals.translate[1])})`);
        if (vals.rotate) parts.push(`rotate(${svgFmt(vals.rotate.angle)} ${svgFmt(vals.rotate.center[0])} ${svgFmt(vals.rotate.center[1])})`);
        if (vals.scale) parts.push(`scale(${svgFmt(vals.scale[0])} ${svgFmt(vals.scale[1])})`);
        if (parts.length) {
          const existing = svgGetAttr(tag, "transform");
          tag = svgSetAttr(tag, "transform", existing ? `${existing} ${parts.join(" ")}` : parts.join(" "));
        }
        if (vals.opacity !== undefined) tag = svgSetAttr(tag, "opacity", svgFmt(vals.opacity));
        frame = frame.replace(orig, () => tag);
      }
      await writeFile(path.join(tmpDir, `frame-${String(i + 1).padStart(4, "0")}.svg`), frame, "utf8");
    }
    await run(FFMPEG, [
      "-y", "-framerate", String(f), "-i", path.join(tmpDir, "frame-%04d.svg"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast",
      "-movflags", "+faststart", outPath,
    ]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "svg_animate", output: outPath, svg: svgPath,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    duration_seconds: out.duration_seconds, fps: f, frames,
    animations_applied: anims.filter((a) => targetTags.has(a.target)).length,
    animations_total: anims.length,
    missing_targets: missingTargets,
    ...(missingTargets.length ? { warning: `target id(s) not found in the SVG and skipped: ${missingTargets.join(", ")}` } : {}),
    ...info,
  };
}

// ---------------------------------------------------------------- social
// One call, every platform: reframe each platform's size (blur keeps
// the whole frame by default), trim to the platform's max duration,
// normalize loudness, then check against that platform's spec. Writes
// <base>-<platform>.mp4 per platform plus a manifest.json receipt in
// the output directory (the per-job details file idea from
// priyanshum143/MCP-FFMPEG, which stores job_details.json next to its
// outputs). A platform whose check fails still writes its file — the
// result says so instead of hiding it.

const SOCIAL_PLATFORMS = ["tiktok", "reels", "shorts", "instagram-feed", "instagram-story", "linkedin", "youtube"];

export async function social({ input, outputDir, platforms = ["tiktok", "reels", "shorts"], strategy = "blur", targetLufs = -14, trimToMax = true }) {
  const inPath = await requireInput(input);
  if (!outputDir || !String(outputDir).trim()) throw new MediaKitError("social needs an output directory", "INVALID_OUTPUT");
  const outDir = await prepareOutputDir(outputDir);
  if (!["crop", "pad", "blur"].includes(strategy)) throw new MediaKitError(`social strategy must be crop, pad or blur, got: ${strategy}`, "INVALID_ARG");
  const target = num(targetLufs, "target_lufs", { min: -70, max: 0 });
  const list = Array.isArray(platforms) ? platforms : String(platforms).split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new MediaKitError("social needs at least one platform", "INVALID_ARG");
  for (const p of list) {
    if (!PLATFORMS[p]) throw new MediaKitError(`unknown platform: ${p} (supported: ${Object.keys(PLATFORMS).join(", ")})`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("social needs a video input", "INVALID_ARG");
  const base = path.basename(inPath, path.extname(inPath)).replace(/[^\w.-]+/g, "_") || "video";
  const results = [];
  for (const p of list) {
    const spec = PLATFORMS[p];
    const finalPath = path.join(outDir, `${base}-${p}.mp4`);
    const tmpReframe = path.join(outDir, `.social-${p}-${process.pid}-reframe.mp4`);
    const tmpTrim = path.join(outDir, `.social-${p}-${process.pid}-trim.mp4`);
    try {
      await reframe({ input: inPath, output: tmpReframe, width: spec.width, height: spec.height, mode: strategy });
      let stagePath = tmpReframe;
      let trimmed = false;
      const reframedMeta = await probe(tmpReframe);
      if (trimToMax && spec.maxDuration !== null && reframedMeta.duration_seconds !== null && reframedMeta.duration_seconds > spec.maxDuration) {
        await fitDuration({ input: tmpReframe, output: tmpTrim, duration: spec.maxDuration, method: "trim" });
        stagePath = tmpTrim;
        trimmed = true;
      }
      let lufs = null;
      let loudnessWarning = null;
      const stageMeta = await probe(stagePath);
      if (stageMeta.audio) {
        const loud = await loudness({ input: stagePath, output: finalPath, targetLufs: target });
        lufs = loud.output_lufs;
        loudnessWarning = loud.warning ?? null;
      } else {
        // Silent source: no loudness step, just place the file.
        await copyFile(stagePath, finalPath);
      }
      const chk = await check({ input: finalPath, platform: p });
      const outMeta = await probe(finalPath);
      const info = await fileInfo(finalPath);
      results.push({
        platform: p, platform_label: spec.label, output: finalPath,
        dimensions: outMeta.video ? `${outMeta.video.width}x${outMeta.video.height}` : null,
        duration_seconds: outMeta.duration_seconds, lufs, trimmed,
        check_pass: chk.pass,
        ...(chk.issues ? { issues: chk.issues } : {}),
        ...(chk.warnings ? { warnings: chk.warnings } : {}),
        ...(loudnessWarning ? { loudness_warning: loudnessWarning } : {}),
        ...info,
      });
    } finally {
      await unlink(tmpReframe).catch(() => {});
      await unlink(tmpTrim).catch(() => {});
    }
  }
  const manifestPath = path.join(outDir, "manifest.json");
  const manifest = {
    operation: "social", input: inPath, strategy, target_lufs: target,
    trim_to_max: trimToMax, generated_at: new Date().toISOString(), outputs: results,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { operation: "social", input: inPath, output_dir: outDir, manifest: manifestPath, outputs: results, all_pass: results.every((r) => r.check_pass) };
}

// ---------------------------------------------------------------- reframe
// One-step aspect reframe: 16:9 -> 9:16 (or any target aspect/size).
// mode "crop": cut the target aspect out of the source (centre, or the
// anchor x/y = top-left of the crop window), then scale to target size.
// mode "pad": scale the whole frame to fit inside the target and add
// black bars. mode "blur": same fit, but the empty area is filled with
// a blurred, darkened copy of the frame (the Shorts/Reels look).

export async function reframe({ input, output, width = 1080, height = 1920, mode = "crop", x = null, y = null, blur = 20, anchor = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const tw = num(width, "width", { min: 2, integer: true });
  const th = num(height, "height", { min: 2, integer: true });
  if (tw % 2 !== 0 || th % 2 !== 0) throw new MediaKitError("reframe target width/height must be even (H.264 yuv420p)", "INVALID_ARG");
  if (!["crop", "pad", "blur"].includes(mode)) throw new MediaKitError(`reframe mode must be crop, pad or blur, got: ${mode}`, "INVALID_ARG");
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("reframe needs a video input", "INVALID_ARG");
  // Geometry in display space: the crop window and the anchor bounds
  // are measured on the frame the viewer sees (autorotated on
  // decode). A 720x1280 phone clip reframed to 1080x1920 keeps ~100%
  // of its pixels; measured on coded 1280x720 dims it would keep
  // only ~32% and warn about softness that isn't there.
  const disp = displayDims(meta);
  const sw = disp.width;
  const sh = disp.height;
  const targetAspect = tw / th;
  const srcAspect = sw / sh;
  let vf;
  let cropRect = null;
  let cropStats = null;
  if (mode === "crop") {
    // Crop window with the target aspect, as large as fits in the source.
    let cw, ch;
    if (srcAspect > targetAspect) { ch = sh; cw = Math.floor((sh * targetAspect) / 2) * 2; }
    else { cw = sw; ch = Math.floor((sw / targetAspect) / 2) * 2; }
    const maxX = sw - cw;
    const maxY = sh - ch;
    // Named anchor ("left", "right", "top-left", ...) pins the crop
    // window to the subject's side so a subject at the frame edge is
    // not cut away; explicit x/y always win over it.
    let ax = null, ay = null;
    if (anchor !== null && anchor !== undefined) {
      const parts = String(anchor).toLowerCase().split("-");
      const allowed = ["center", "left", "right", "top", "bottom"];
      if (!parts.every((p) => allowed.includes(p)) || parts.length > 2) {
        throw new MediaKitError(`reframe anchor must be one of center, left, right, top, bottom, top-left, top-right, bottom-left, bottom-right, got: ${anchor}`, "INVALID_ARG");
      }
      if (parts.includes("left")) ax = 0;
      else if (parts.includes("right")) ax = maxX;
      if (parts.includes("top")) ay = 0;
      else if (parts.includes("bottom")) ay = maxY;
    }
    const ox = x === null || x === undefined ? (ax ?? Math.floor(maxX / 2)) : num(x, "x", { min: 0, max: maxX, integer: true });
    const oy = y === null || y === undefined ? (ay ?? Math.floor(maxY / 2)) : num(y, "y", { min: 0, max: maxY, integer: true });
    cropRect = { width: cw, height: ch, x: ox, y: oy };
    vf = `crop=${cw}:${ch}:${ox}:${oy},scale=${tw}:${th}`;
    // Report how much of the frame the crop keeps: a 16:9 -> 9:16 crop
    // keeps ~32% of the pixels and upscales ~2.7x, which is where the
    // softness comes from. Below 40% kept, say so.
    const kept = +(((cw * ch) / (sw * sh)) * 100).toFixed(1);
    const upscale = +(tw / cw).toFixed(2);
    cropStats = { kept_percent: kept, upscale };
    if (kept < 40) cropStats.warning = `crop keeps only ${kept}% of the frame (upscaled ${upscale}x) — the result may look soft; use pad or blur mode to keep the whole frame`;
  } else if (mode === "pad") {
    vf = `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`;
  } else {
    const b = num(blur, "blur", { min: 0, max: 100 });
    vf = `split[a][b];[a]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},gblur=sigma=${b},eq=brightness=-0.25[bg];[b]scale=${tw}:${th}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  }
  await run(FFMPEG, [
    "-y", "-i", inPath, "-vf", vf,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
    "-c:a", "copy", "-movflags", "+faststart", outPath,
  ]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "reframe", input: inPath, output: outPath, mode,
    target: `${tw}x${th}`, source: `${sw}x${sh}`,
    source_rotation: disp.rotation,
    ...(cropRect ? { crop: cropRect } : {}),
    ...(cropStats ? { crop_kept_percent: cropStats.kept_percent, upscale: cropStats.upscale, ...(cropStats.warning ? { warning: cropStats.warning } : {}) } : {}),
    ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    duration_seconds: out.duration_seconds,
  };
}

// ---------------------------------------------------------------- check
// Verify a finished file against a platform delivery spec. Measures the
// real file (probe + loudnorm stats) and reports pass/fail per rule —
// never trusts the filename or the tool that produced it.

export const PLATFORMS = {
  tiktok: {
    label: "TikTok", width: 1080, height: 1920, maxDuration: 600,
    videoCodecs: ["h264"], audioCodecs: ["aac"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
    // TikTok publishes no bitrate for regular posts; 8-12 Mbps @1080p
    // 30fps is the working figure creators converge on (12-16 @60fps).
    // File cap is the mobile-app upload limit, widely reported.
    maxFileSizeMB: 287,
    safeZone: {
      x0: 64, y0: 200, x1: 1016, y1: 1400,
      note: "Keep text/subtitles inside this rect: the top bar, right action rail, and bottom caption + buttons cover the rest. Creator guidance, not a platform-published spec.",
    },
  },
  reels: {
    label: "Instagram Reels", width: 1080, height: 1920, maxDuration: 900,
    videoCodecs: ["h264"], audioCodecs: ["aac"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
    safeZone: {
      x0: 64, y0: 200, x1: 1016, y1: 1400,
      note: "Keep text/subtitles inside this rect: the top bar, right action rail, and bottom caption + buttons cover the rest. Creator guidance, not a platform-published spec.",
    },
  },
  shorts: {
    label: "YouTube Shorts", width: 1080, height: 1920, maxDuration: 180,
    videoCodecs: ["h264", "vp9", "av1"], audioCodecs: ["aac", "opus"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
    safeZone: {
      x0: 64, y0: 200, x1: 1016, y1: 1400,
      note: "Keep text/subtitles inside this rect: the top bar, right action rail, and bottom caption + buttons cover the rest. Creator guidance, not a platform-published spec.",
    },
  },
  youtube: {
    label: "YouTube (long-form)", width: 1920, height: 1080, maxDuration: null,
    videoCodecs: ["h264", "vp9", "av1"], audioCodecs: ["aac", "opus"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
    safeZone: {
      x0: 96, y0: 64, x1: 1824, y1: 980,
      note: "Keep titles/text clear of the bottom player bar and the bottom-right end-screen area. Creator guidance, not a platform-published spec.",
    },
  },
  "instagram-feed": {
    label: "Instagram Feed", width: 1080, height: 1080, maxDuration: 3600,
    videoCodecs: ["h264"], audioCodecs: ["aac"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
    safeZone: {
      x0: 64, y0: 120, x1: 1016, y1: 960,
      note: "Keep text inside this square: the top bar and the bottom caption/like row cover the rest. Creator guidance, not a platform-published spec.",
    },
  },
  "instagram-story": {
    label: "Instagram Story", width: 1080, height: 1920, maxDuration: 60,
    videoCodecs: ["h264"], audioCodecs: ["aac"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
    safeZone: {
      x0: 64, y0: 200, x1: 1016, y1: 1400,
      note: "Keep text/subtitles inside this rect: the top bar, reply box and bottom UI cover the rest. Creator guidance, not a platform-published spec.",
    },
  },
  linkedin: {
    label: "LinkedIn", width: 1920, height: 1080, maxDuration: 600,
    videoCodecs: ["h264"], audioCodecs: ["aac"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
    safeZone: {
      x0: 96, y0: 64, x1: 1824, y1: 980,
      note: "Keep titles/text clear of the bottom player bar. Creator guidance, not a platform-published spec.",
    },
  },
};

/**
 * Recommended video bitrate (Mbps) for a resolution + fps band.
 * YouTube publishes this ladder ("Recommended upload encoding settings":
 * 1080p 8 Mbps @30fps / 12 @60fps, 720p 5 / 7.5, 1440p 16 / 24,
 * 2160p 35-45 / 53-68) and states "no bitrate limit is required" — so
 * check treats bitrate as a warning, never a failure. TikTok/Reels
 * publish no bitrate; the same ladder is the working figure.
 */
export function recommendedVideoBitrateMbps(width, height, fps) {
  // Resolution class = the SHORTER side: 1080x1920 vertical is "1080p",
  // not "1920p" (using the longer side would put it in the 1440p tier).
  const px = Math.min(width ?? 0, height ?? 0);
  const high = (fps ?? 30) >= 48;
  if (px >= 2160) return high ? 53 : 35;
  if (px >= 1440) return high ? 24 : 16;
  if (px >= 1080) return high ? 12 : 8;
  if (px >= 720) return high ? 7.5 : 5;
  if (px >= 480) return high ? 4 : 2.5;
  if (px > 0) return high ? 1.5 : 1;
  return null;
}

/** Measure loudness with a loudnorm analysis pass (no output file).
 * Returns the full measured set needed for a precise two-pass
 * normalization, or null when the input cannot be measured. */
export async function measureLoudnessFull(input) {
  const { stderr } = await run(FFMPEG, [
    "-i", input, "-vn",
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ]);
  const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const num = (k) => { const v = parseFloat(j[k]); return Number.isFinite(v) ? v : null; };
    const i = num("input_i");
    const tp = num("input_tp");
    const lra = num("input_lra");
    const thresh = num("input_thresh");
    const offset = num("target_offset");
    if (i === null || tp === null || lra === null || thresh === null || offset === null) return null;
    return { i: +i.toFixed(2), tp: +tp.toFixed(2), lra: +lra.toFixed(2), thresh: +thresh.toFixed(2), offset: +offset.toFixed(2) };
  } catch {
    return null;
  }
}

/** Measure integrated loudness (LUFS) with a loudnorm analysis pass. */
export async function measureLoudness(input) {
  const full = await measureLoudnessFull(input);
  return full === null ? null : +full.i.toFixed(1);
}

// ---------------------------------------------------------------- check
// Faststart probe (wilwaldon/Claude-Code-Video-Toolkit normalize
// preset: `-movflags faststart` on web/preview output): walk the
// top-level ISO BMFF boxes and report which of `moov` / `mdat`
// comes first. A faststart MP4 has moov before mdat so playback can
// start before the download finishes. Pure Node, no ffmpeg call —
// only box headers are read (8 bytes each, plus 8 more for a 64-bit
// largesize), never the box bodies, so the walk is cheap even on a
// multi-gigabyte file. The first of moov/mdat decides: whichever box
// opens first is the answer, and a size-0 box runs to end of file,
// so nothing can follow it.
export async function probeFaststart(input) {
  const inPath = await requireInput(input);
  const fh = await open(inPath, "r");
  try {
    let offset = 0;
    let moovOffset = null;
    let mdatOffset = null;
    const header = Buffer.alloc(16);
    for (;;) {
      const { bytesRead } = await fh.read(header, 0, 8, offset);
      if (bytesRead < 8) break; // end of file without moov or mdat
      let size = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerLen = 8;
      if (size === 1) {
        const { bytesRead: br2 } = await fh.read(header, 8, 8, offset + 8);
        if (br2 < 8) break;
        size = Number(header.readBigUInt64BE(8));
        headerLen = 16;
      } else if (size === 0) {
        if (type === "moov") moovOffset = offset;
        if (type === "mdat") mdatOffset = offset;
        break;
      }
      if (type === "moov" && moovOffset === null) moovOffset = offset;
      if (type === "mdat" && mdatOffset === null) mdatOffset = offset;
      if (moovOffset !== null || mdatOffset !== null) break;
      if (!Number.isFinite(size) || size < headerLen) break; // corrupt header: stop, report unknown
      offset += size;
    }
    const faststart = moovOffset !== null && (mdatOffset === null || moovOffset < mdatOffset);
    return {
      operation: "probe_faststart", input: inPath,
      faststart: moovOffset === null && mdatOffset === null ? null : faststart,
      moov_offset: moovOffset, mdat_offset: mdatOffset,
    };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- decoded work
// Decoded-work ceiling (MADPANDA3D/FFMPEG-MCP's media_limits.py idea,
// EncodeX's safety-envelope idea: estimate the work before committing
// to it). A decode-heavy input — 8K, 120fps, an hour long — can OOM
// this machine long before any tool reports progress, so `check` can
// estimate the decoded work from the probe and warn when it is over
// the ceiling. Pure function, unit-testable; the estimate uses the
// first video/audio stream only (probe keeps one of each), display
// dims (what ffmpeg's filters actually decode), and the container
// duration. Ceilings are MADPANDA's numbers: duration 3600s,
// geometry 8192px per side, fps 120, 250B decoded video pixel-frames,
// 8 audio channels, 192kHz, 6B audio sample-channels.
export const DECODED_WORK_LIMITS = {
  max_duration_seconds: 3600,
  max_geometry_px: 8192,
  max_fps: 120,
  max_video_pixel_frames: 250e9,
  max_audio_channels: 8,
  max_audio_sample_rate_hz: 192000,
  max_audio_sample_channels: 6e9,
};

function formatLarge(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function estimateDecodedWork(meta) {
  const v = meta?.video ?? null;
  const a = meta?.audio ?? null;
  const dur = meta?.duration_seconds ?? null;
  const violations = [];
  let videoPixelFrames = null;
  if (v) {
    const w = v.display_width ?? v.width;
    const h = v.display_height ?? v.height;
    if (w !== null && w !== undefined && h !== null && h !== undefined) {
      if (w > DECODED_WORK_LIMITS.max_geometry_px || h > DECODED_WORK_LIMITS.max_geometry_px) {
        violations.push(`geometry ${w}x${h} exceeds ${DECODED_WORK_LIMITS.max_geometry_px}px per side`);
      }
    }
    if (v.fps !== null && v.fps !== undefined && v.fps > DECODED_WORK_LIMITS.max_fps) {
      violations.push(`fps ${v.fps} exceeds ${DECODED_WORK_LIMITS.max_fps}`);
    }
    if (w && h && v.fps && dur) {
      videoPixelFrames = w * h * v.fps * dur;
      if (videoPixelFrames > DECODED_WORK_LIMITS.max_video_pixel_frames) {
        violations.push(`video pixel-frames ${formatLarge(videoPixelFrames)} exceeds ${formatLarge(DECODED_WORK_LIMITS.max_video_pixel_frames)}`);
      }
    }
  }
  let audioSampleChannels = null;
  if (a) {
    if (a.channels !== null && a.channels !== undefined && a.channels > DECODED_WORK_LIMITS.max_audio_channels) {
      violations.push(`audio channels ${a.channels} exceeds ${DECODED_WORK_LIMITS.max_audio_channels}`);
    }
    if (a.sample_rate !== null && a.sample_rate !== undefined && a.sample_rate > DECODED_WORK_LIMITS.max_audio_sample_rate_hz) {
      violations.push(`audio sample rate ${a.sample_rate} Hz exceeds ${DECODED_WORK_LIMITS.max_audio_sample_rate_hz} Hz`);
    }
    if (a.channels && a.sample_rate && dur) {
      audioSampleChannels = a.channels * a.sample_rate * dur;
      if (audioSampleChannels > DECODED_WORK_LIMITS.max_audio_sample_channels) {
        violations.push(`audio sample-channels ${formatLarge(audioSampleChannels)} exceeds ${formatLarge(DECODED_WORK_LIMITS.max_audio_sample_channels)}`);
      }
    }
  }
  if (dur !== null && dur !== undefined && dur > DECODED_WORK_LIMITS.max_duration_seconds) {
    violations.push(`duration ${dur}s exceeds ${DECODED_WORK_LIMITS.max_duration_seconds}s`);
  }
  return {
    video_pixel_frames: videoPixelFrames === null ? null : Math.round(videoPixelFrames),
    audio_sample_channels: audioSampleChannels === null ? null : Math.round(audioSampleChannels),
    limits: { ...DECODED_WORK_LIMITS },
    violations,
    over_ceiling: violations.length > 0,
  };
}

export async function check({ input, platform = "tiktok", content = false, contentStart = null, contentEnd = null, peakThresholdDb = -1, expectedDuration = null, faststart = false, decodedWork = false }) {
  const inPath = await requireInput(input);
  const spec = PLATFORMS[platform];
  if (!spec) throw new MediaKitError(`unknown platform: ${platform} (supported: ${Object.keys(PLATFORMS).join(", ")})`, "INVALID_ARG");
  // Same ±0.5s tolerance as qa_report's expected_duration: a render
  // that lands within half a second of the brief is on-spec; beyond
  // that the cut is wrong (trimmed short, looped long) and the check
  // must fail instead of passing a file of the wrong length.
  const expDur = expectedDuration === null || expectedDuration === undefined ? null : parseTime(expectedDuration, "expected_duration");
  const meta = await probe(inPath);
  const checks = [];
  // severity "error" (default) fails the check; "warn" is reported in
  // `warnings` and does not fail it — bitrate is a recommendation, not
  // an upload gate, so it warns instead of failing.
  const add = (name, expected, actual, pass, hint = null, severity = "error") =>
    checks.push({ name, expected, actual, pass, ...(hint ? { hint } : {}), ...(severity !== "error" ? { severity } : {}) });

  if (meta.video) {
    // Dimensions are judged as displayed, not as coded: a phone clip
    // stored 1920x1080 with a 90-degree display matrix IS a 1080x1920
    // vertical video, and must pass the TikTok rule as one.
    const dispW = meta.video.display_width ?? meta.video.width;
    const dispH = meta.video.display_height ?? meta.video.height;
    add("dimensions", `${spec.width}x${spec.height}`,
      `${dispW}x${dispH}`,
      dispW === spec.width && dispH === spec.height,
      `reframe to ${spec.width}x${spec.height} first`);
    add("video_codec", spec.videoCodecs.join(" or "), meta.video.codec,
      spec.videoCodecs.includes(meta.video.codec),
      `convert with --video-codec ${spec.videoCodecs[0]}`);
    if (meta.video.fps !== null) {
      add("fps", `${spec.fps[0]}–${spec.fps[1] - 1} fps`, `${meta.video.fps} fps`,
        meta.video.fps >= spec.fps[0] && meta.video.fps < spec.fps[1]);
    }
    // Video bitrate: warn only. Prefer the video stream's own bit_rate;
    // fall back to format bit_rate minus audio, then format bit_rate.
    const vBits = meta.video.bit_rate
      ?? (meta.bit_rate !== null && meta.audio?.bit_rate ? meta.bit_rate - meta.audio.bit_rate : null)
      ?? meta.bit_rate;
    const rec = recommendedVideoBitrateMbps(dispW, dispH, meta.video.fps);
    if (vBits !== null && vBits !== undefined && rec !== null) {
      const mbps = vBits / 1e6;
      const actual = `${mbps.toFixed(1)} Mbps`;
      const expected = `~${rec} Mbps recommended`;
      if (mbps < rec * 0.5) {
        add("video_bitrate", expected, actual, false,
          `may look soft after the platform re-encodes — export near ${rec} Mbps`, "warn");
      } else if (mbps > rec * 2) {
        add("video_bitrate", expected, actual, false,
          `oversized file, little gain after re-encode — export near ${rec} Mbps`, "warn");
      } else {
        add("video_bitrate", expected, actual, true, null, "warn");
      }
    }
  } else {
    add("dimensions", `${spec.width}x${spec.height}`, "no video stream", false);
  }
  if (meta.duration_seconds !== null && spec.maxDuration !== null) {
    add("duration", `<= ${spec.maxDuration}s`, `${meta.duration_seconds}s`,
      meta.duration_seconds <= spec.maxDuration,
      "trim to fit the platform limit");
  }
  if (expDur !== null && meta.duration_seconds !== null) {
    add("expected_duration", `${expDur}s ± 0.5s`, `${meta.duration_seconds}s`,
      Math.abs(meta.duration_seconds - expDur) <= 0.5,
      "trim or fit to the expected length first");
  }
  if (spec.maxFileSizeMB && meta.size_bytes !== null) {
    const mb = meta.size_bytes / (1024 * 1024);
    add("file_size", `<= ${spec.maxFileSizeMB} MB`, `${mb.toFixed(1)} MB`,
      mb <= spec.maxFileSizeMB,
      "upload from desktop/web, or re-encode at a lower bitrate");
  }
  // Faststart (opt-in): an MP4 whose moov box sits after mdat makes
  // a web player download the whole file before the first frame —
  // the check fails until the file is re-muxed with
  // `-movflags +faststart`. The box walk is pure Node (see
  // probeFaststart); a non-MP4 container cannot be faststart at all,
  // so it fails with that reason instead of a misleading box offset.
  if (faststart) {
    const isMp4 = /mp4|mov|m4v|3gp/i.test(meta.format ?? "");
    if (!isMp4) {
      add("faststart", "moov before mdat (MP4 faststart)", `not an MP4 container (${meta.format ?? "unknown"})`, false,
        "faststart only applies to MP4 — convert to MP4 first");
    } else {
      const fs = await probeFaststart(inPath);
      if (fs.faststart === null) {
        add("faststart", "moov before mdat (MP4 faststart)", "no moov/mdat box found", false,
          "re-mux with -movflags +faststart");
      } else {
        // The box walk stops at the first of moov/mdat, so exactly
        // one offset is known — and that is the whole answer: the
        // first box decides. Report it as an ordering, not as two
        // measured offsets (the second box was never walked to).
        const actual = fs.faststart
          ? `moov at ${fs.moov_offset} (before mdat)`
          : `mdat at ${fs.mdat_offset} (before moov)`;
        add("faststart", "moov before mdat (MP4 faststart)", actual, fs.faststart,
          "re-mux with -movflags +faststart");
      }
    }
  }
  // Decoded-work ceiling (opt-in): estimate the decode load from the
  // probe and warn when it is over the ceiling. Warn, not fail: the
  // file may still be a valid platform delivery — the warning says
  // the machine may OOM decoding it, so re-encode smaller/shorter
  // first (or split the job) before running a heavy tool on it.
  let decodedWorkResult = null;
  if (decodedWork) {
    decodedWorkResult = estimateDecodedWork(meta);
    const parts = [];
    if (decodedWorkResult.video_pixel_frames !== null) parts.push(`${formatLarge(decodedWorkResult.video_pixel_frames)} pixel-frames`);
    if (decodedWorkResult.audio_sample_channels !== null) parts.push(`${formatLarge(decodedWorkResult.audio_sample_channels)} sample-channels`);
    const actual = parts.length ? parts.join(" + ") : "no decodable streams";
    add("decoded_work",
      `<= ${formatLarge(DECODED_WORK_LIMITS.max_video_pixel_frames)} pixel-frames, <= ${formatLarge(DECODED_WORK_LIMITS.max_audio_sample_channels)} sample-channels`,
      decodedWorkResult.over_ceiling ? `${actual} — ${decodedWorkResult.violations.join("; ")}` : actual,
      !decodedWorkResult.over_ceiling,
      "re-encode smaller/shorter first, or split the job — this input may OOM the machine",
      "warn");
  }
  if (meta.audio) {
    add("audio_codec", spec.audioCodecs.join(" or "), meta.audio.codec,
      spec.audioCodecs.includes(meta.audio.codec));
    add("audio_channels", `<= ${spec.maxChannels}`, String(meta.audio.channels ?? "?"),
      (meta.audio.channels ?? 99) <= spec.maxChannels);
    const lufs = await measureLoudness(inPath);
    if (lufs !== null) {
      add("loudness", `${spec.lufs[0]} to ${spec.lufs[1]} LUFS`, `${lufs} LUFS`,
        lufs >= spec.lufs[0] && lufs <= spec.lufs[1],
        "loudness to -14 LUFS first");
    } else {
      checks.push({ name: "loudness", expected: `${spec.lufs[0]} to ${spec.lufs[1]} LUFS`, actual: "could not measure", pass: false, hint: "check the audio stream" });
    }
  } else {
    checks.push({ name: "audio", expected: "audio stream present", actual: "no audio stream", pass: false });
  }
  // Content QC (opt-in): black/frozen frames + silence in one decode
  // pass, folded into the same pass/fail list. A stream that does not
  // exist is "unavailable" in the content detail, not a failed rule.
  let contentResult = null;
  if (content) {
    contentResult = await detectContent(inPath, { start: contentStart, end: contentEnd, peakThresholdDb });
    const hints = {
      black: "re-cut or re-render the black stretch",
      freeze: "re-render or trim the frozen stretch",
      silence: "run silence to remove the dead air",
      peaks: "lower the level (loudness to -14 LUFS) or re-record the clipped stretch",
    };
    for (const [kind, label] of [["black", "black frames"], ["freeze", "frozen frames"], ["silence", "silence"], ["peaks", "audio peaks"]]) {
      const s = contentResult[kind];
      if (s.status === "unavailable") continue;
      const errs = s.intervals.filter((i) => i.severity === "error").length;
      const warns = s.intervals.filter((i) => i.severity === "warn").length;
      const actual = s.total_intervals === 0 ? "none"
        : `${s.total_intervals} interval${s.total_intervals === 1 ? "" : "s"} (${s.total_duration_seconds}s total)`;
      // Warn-level intervals fail the rule but not the check (same
      // pattern as video_bitrate): they show up in `warnings`.
      add(`content_${kind}`, `no ${label}`, actual, errs === 0 && warns === 0, hints[kind],
        errs > 0 ? "error" : "warn");
    }
  }
  const failed = checks.filter((c) => !c.pass && c.severity !== "warn");
  const warnings = checks.filter((c) => !c.pass && c.severity === "warn");
  return {
    operation: "check", input: inPath, platform, platform_label: spec.label,
    pass: failed.length === 0,
    checks,
    safe_zone: spec.safeZone,
    ...(decodedWorkResult ? { decoded_work: decodedWorkResult } : {}),
    ...(contentResult ? { content: contentResult } : {}),
    ...(failed.length ? { issues: failed.map((c) => `${c.name}: ${c.actual} (want ${c.expected})${c.hint ? ` — ${c.hint}` : ""}`) } : {}),
    ...(warnings.length ? { warnings: warnings.map((c) => `${c.name}: ${c.actual} (want ${c.expected})${c.hint ? ` — ${c.hint}` : ""}`) } : {}),
  };
}

// ---------------------------------------------------------------- qa_report
// One-call delivery gate (claude-video-studio's qa_report + video-qa
// skill idea: run the gate, plus a contact sheet, on every deliverable
// before calling it done). Composes pieces MediaKit already measures —
// probe, loudnorm, detectContent, detectScenes — and adds the checks
// `check` does not have: even dimensions, yuv420p pixel format,
// pacing (average shot length from real scene cuts), an expected
// duration, and an "any" target for files that are not platform-bound.
// Probe-only: no file is written. Verdict is fail if any check fails,
// warn if any warns, else pass. The per-check list is the report —
// an agent fixes the failing items and re-runs this, it does not need
// to re-run five tools to know what is left.

const QA_TARGETS = {
  any: { label: "Any delivery", aspect: null, maxDuration: null, lufs: [-16, -12], maxTp: -0.3 },
};

export async function qaReport({ input, target = "any", expectedDuration = null }) {
  const inPath = await requireInput(input);
  const t = String(target || "any").toLowerCase();
  const spec = t === "any" ? QA_TARGETS.any : PLATFORMS[t];
  if (!spec) throw new MediaKitError(`unknown target: ${target} (supported: any, ${Object.keys(PLATFORMS).join(", ")})`, "INVALID_ARG");
  const expDur = expectedDuration === null || expectedDuration === undefined ? null : parseTime(expectedDuration, "expected_duration");
  const meta = await probe(inPath);
  const checks = [];
  const add = (name, status, detail) => checks.push({ check: name, status, detail });
  const aspect = t === "any" ? null : spec.width / spec.height;
  const maxTp = t === "any" ? QA_TARGETS.any.maxTp : -0.5;
  const lufsBand = t === "any" ? QA_TARGETS.any.lufs : spec.lufs;

  if (!meta.video) {
    add("has_video", "fail", "no video stream");
  } else {
    const v = meta.video;
    add("has_video", "pass", `${v.width}x${v.height} ${v.codec}`);
    add("even_dimensions", v.width % 2 === 0 && v.height % 2 === 0 ? "pass" : "fail",
      `${v.width}x${v.height} (odd dimensions break most encoders)`);
    add("pixel_format", ["yuv420p", "yuvj420p"].includes(v.pixel_format) ? "pass" : "warn",
      `${v.pixel_format ?? "?"} (yuv420p plays everywhere)`);
    if (v.fps !== null) {
      add("frame_rate", v.fps >= 23 && v.fps <= 61 ? "pass" : "warn", `${v.fps} fps`);
    }
    if (aspect !== null) {
      const ratio = v.width / v.height;
      add("aspect_ratio", Math.abs(ratio - aspect) < 0.02 ? "pass" : "fail",
        `${ratio.toFixed(3)} vs target ${aspect.toFixed(3)}`);
    }
  }
  if (!meta.audio) {
    add("has_audio", "warn", "silent file — no audio stream");
  } else {
    add("has_audio", "pass", `${meta.audio.codec}, ${meta.audio.channels ?? "?"} channel(s)`);
  }
  if (meta.duration_seconds !== null) {
    if (spec.maxDuration !== null) {
      add("platform_length", meta.duration_seconds <= spec.maxDuration ? "pass" : "fail",
        `${meta.duration_seconds}s (max ${spec.maxDuration}s for ${spec.label})`);
    }
    if (expDur !== null) {
      add("expected_duration", Math.abs(meta.duration_seconds - expDur) <= 0.5 ? "pass" : "fail",
        `${meta.duration_seconds}s vs expected ${expDur}s`);
    }
  }
  let loudness = null;
  let truePeak = null;
  if (meta.audio) {
    const full = await measureLoudnessFull(inPath);
    if (full === null) {
      add("loudness", "fail", "could not measure");
      add("true_peak", "fail", "could not measure");
    } else {
      loudness = full.i;
      truePeak = full.tp;
      add("loudness", loudness >= lufsBand[0] && loudness <= lufsBand[1] ? "pass" : "fail",
        `${loudness} LUFS (target ${lufsBand[0]}..${lufsBand[1]})`);
      add("true_peak", truePeak <= maxTp ? "pass" : "fail",
        `${truePeak} dBTP (max ${maxTp})`);
    }
  }
  // Content QC: black mid-file warns, frozen frames fail, dead air
  // (silence over 2s) warns — same position-aware rules as check
  // --content, via detectContent. Peaks are not repeated here: the
  // true-peak check above already covers clipping.
  if (meta.video || meta.audio) {
    const content = await detectContent(inPath);
    if (content.black.status === "complete") {
      const mid = content.black.intervals.filter((i) => i.severity === "error");
      add("black_frames", mid.length === 0 ? "pass" : "warn",
        mid.length === 0 ? "none mid-video" : `mid-video black at ${mid.map((i) => `${i.start}–${i.end}s`).join(", ")}`);
    }
    if (content.freeze.status === "complete") {
      const errs = content.freeze.intervals.filter((i) => i.severity === "error");
      add("frozen_frames", errs.length === 0 ? "pass" : "fail",
        errs.length === 0 ? "none" : `frozen at ${errs.map((i) => `${i.start}–${i.end}s`).join(", ")}`);
    }
    if (content.silence.status === "complete") {
      const dead = content.silence.intervals.filter((i) => i.duration > 2);
      add("dead_air", dead.length === 0 ? "pass" : "warn",
        dead.length === 0 ? "none over 2s" : `silences over 2s at ${dead.map((i) => `${i.start}–${i.end}s`).join(", ")}`);
    }
  }
  // Pacing: average shot length from real scene cuts. Over 6s reads
  // slow for social — a warn, not a fail (long-form is allowed to
  // breathe, and "any" has no platform pacing rule either).
  if (meta.video && meta.duration_seconds !== null) {
    const scenes = await detectScenes({ input: inPath });
    const shots = scenes.segments.length;
    const avg = shots > 0 ? meta.duration_seconds / shots : meta.duration_seconds;
    add("pacing", avg <= 6 ? "pass" : "warn",
      `average shot ${avg.toFixed(1)}s over ${shots} shot(s)${avg > 6 ? " (over 6s reads slow for social)" : ""}`);
  }
  const verdict = checks.some((c) => c.status === "fail") ? "fail"
    : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  return {
    operation: "qa_report", input: inPath, target: t, verdict, checks,
    file: {
      duration_seconds: meta.duration_seconds,
      dimensions: meta.video ? `${meta.video.width}x${meta.video.height}` : null,
      fps: meta.video?.fps ?? null,
      video_codec: meta.video?.codec ?? null,
      audio_codec: meta.audio?.codec ?? null,
      pixel_format: meta.video?.pixel_format ?? null,
      size_bytes: meta.size_bytes,
      loudness_lufs: loudness,
      true_peak_db: truePeak,
    },
  };
}

// ---------------------------------------------------------------- content
// Content QC (idea: riqvip/codex-media-mcp inspect_media + the QC-gate
// "rules layer"): one decode pass runs blackdetect + freezedetect on
// the video and silencedetect on the audio, then position-aware rules
// turn raw intervals into pass/warn/fail — a short black stretch at
// the very start/end is usually a fade in/out, the same stretch
// mid-file is a broken render. A stream that does not exist reports
// "unavailable", never zero intervals.

const CONTENT_MAX_INTERVALS = 100;

function contentSummary(intervals) {
  return {
    status: "complete",
    intervals: intervals.slice(0, CONTENT_MAX_INTERVALS),
    total_intervals: intervals.length,
    total_duration_seconds: +intervals.reduce((s, i) => s + i.duration, 0).toFixed(3),
    intervals_truncated: intervals.length > CONTENT_MAX_INTERVALS,
  };
}

/** Rules layer: a raw detection -> severity + human reason. Position
 * matters — black/freeze/silence at an edge is often intentional
 * (fade, still intro, tail), mid-file it is a defect. When a time
 * range was scanned, the edges are the scan's edges, not the file's:
 * an interval that ends at the scan boundary is only known to last
 * that long, so it warns instead of failing. */
function classifyContent(kind, iv, duration, rangeStart = 0, rangeEnd = null) {
  const atStart = iv.start <= rangeStart + 0.5;
  const atEnd = rangeEnd !== null ? iv.end >= rangeEnd - 0.5 : (duration !== null && iv.end >= duration - 0.5);
  const where = atStart && atEnd ? "whole file" : atStart ? "at start" : atEnd ? "at end" : "mid-file";
  const edge = where !== "mid-file" && where !== "whole file";
  const span = `${iv.start}s–${iv.end}s (${iv.duration}s)`;
  if (kind === "peaks") {
    if (iv.peak_db >= 0) return { severity: "error", reason: `audio peak ${iv.peak_db} dBFS ${span} — digital clipping, lower the level or re-record` };
    return { severity: "warn", reason: `audio peak ${iv.peak_db} dBFS ${span} — near clipping, above the ${iv.threshold_db} dBFS threshold` };
  }
  if (kind === "black") {
    if (edge && iv.duration <= 2) return { severity: "warn", reason: `black ${where} ${span} — likely a fade in/out` };
    return { severity: "error", reason: `black ${where} ${span} — broken render or missing footage` };
  }
  if (kind === "freeze") {
    if (edge) return { severity: "warn", reason: `frozen frame ${where} ${span} — likely a still or fade` };
    return { severity: "error", reason: `frozen frame ${where} ${span} — video stalled while audio keeps playing` };
  }
  if (iv.duration >= 5 && !edge) return { severity: "error", reason: `silence ${where} ${span} — dead air; run silence to remove it` };
  return { severity: "warn", reason: `silence ${where} ${span} — pause or dead air; run silence to remove it` };
}

export async function detectContent(input, { blackMinDuration = 0.5, freezeMinDuration = 2, silenceThresholdDb = -40, silenceMinDuration = 0.5, start = null, end = null, peakThresholdDb = -1 } = {}) {
  const inPath = await requireInput(input);
  const blackD = num(blackMinDuration, "black_min_duration", { min: 0.1, max: 60 });
  const freezeD = num(freezeMinDuration, "freeze_min_duration", { min: 0.5, max: 60 });
  const silTh = num(silenceThresholdDb, "silence_threshold_db", { min: -90, max: 0 });
  const silD = num(silenceMinDuration, "silence_min_duration", { min: 0.05, max: 60 });
  const peakTh = num(peakThresholdDb, "peak_threshold_db", { min: -60, max: 12 });
  // Time range: scan only [start, end) — times accept seconds or
  // MM:SS. The decode is input-seeked (-ss before -i) so a long file
  // scans a short segment fast; every interval is reported on the
  // file's own timeline (offset by start).
  const startS = start === null || start === undefined ? 0 : parseTime(start, "start");
  const endS = end === null || end === undefined ? null : parseTime(end, "end");
  if (endS !== null && endS <= startS) throw new MediaKitError(`content end must be after start (got start ${startS}s, end ${endS}s)`, "INVALID_ARG");
  const meta = await probe(inPath);
  const duration = meta.duration_seconds;
  if (duration !== null && startS >= duration) throw new MediaKitError(`content start ${startS}s is past the end of the file (${duration}s)`, "INVALID_ARG");
  const scanEnd = endS === null ? duration : (duration === null ? endS : Math.min(endS, duration));
  const scanDur = scanEnd === null ? null : +(scanEnd - startS).toFixed(3);

  const black = [];
  const freeze = [];
  const silence = [];
  if (meta.video || meta.audio) {
    const args = ["-hide_banner", "-nostats"];
    if (startS > 0) args.push("-ss", String(startS));
    args.push("-i", inPath);
    if (scanDur !== null) args.push("-t", String(scanDur));
    if (meta.video) args.push("-vf", `blackdetect=d=${blackD}:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=${freezeD}`);
    if (meta.audio) args.push("-af", `silencedetect=noise=${silTh}dB:d=${silD}`);
    args.push("-f", "null", "-");
    const { stderr } = await run(FFMPEG, args);
    let openBlack = null, openFreeze = null, openSilence = null;
    for (const line of stderr.split("\n")) {
      let m;
      // blackdetect logs start+end on ONE line when the interval ends
      // ("black_start:3 black_end:6 black_duration:3") — match that
      // first, or a bare black_start would swallow the end.
      if ((m = line.match(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s*black_duration:\s*([\d.]+)/))) {
        black.push({ start: +(parseFloat(m[1]) + startS).toFixed(3), end: +(parseFloat(m[2]) + startS).toFixed(3), duration: +parseFloat(m[3]).toFixed(3) });
        openBlack = null;
        continue;
      }
      if ((m = line.match(/black_start:\s*([\d.]+)/))) { openBlack = parseFloat(m[1]) + startS; continue; }
      if ((m = line.match(/black_end:\s*([\d.]+)\s*black_duration:\s*([\d.]+)/))) {
        if (openBlack !== null) {
          black.push({ start: +openBlack.toFixed(3), end: +(parseFloat(m[1]) + startS).toFixed(3), duration: +parseFloat(m[2]).toFixed(3) });
          openBlack = null;
        }
        continue;
      }
      if ((m = line.match(/lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/))) { openFreeze = parseFloat(m[1]) + startS; continue; }
      if ((m = line.match(/lavfi\.freezedetect\.freeze_end:\s*([\d.]+)/))) {
        if (openFreeze !== null) {
          freeze.push({ start: +openFreeze.toFixed(3), end: +(parseFloat(m[1]) + startS).toFixed(3), duration: +(parseFloat(m[1]) + startS - openFreeze).toFixed(3) });
          openFreeze = null;
        }
        continue;
      }
      if ((m = line.match(/silence_start:\s*([\d.]+)/))) { openSilence = parseFloat(m[1]) + startS; continue; }
      if ((m = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/))) {
        if (openSilence !== null) {
          silence.push({ start: +openSilence.toFixed(3), end: +(parseFloat(m[1]) + startS).toFixed(3), duration: +parseFloat(m[2]).toFixed(3) });
          openSilence = null;
        }
      }
    }
    // An interval still open at the end of the scan runs to the end
    // of the scanned range (file end, or the --end the caller asked
    // for) — flagged, so a rule can tell "known to last this long"
    // from "ended here".
    if (scanEnd !== null) {
      const closeOpen = (list, open) => {
        if (open !== null) list.push({ start: +open.toFixed(3), end: +scanEnd.toFixed(3), duration: +(scanEnd - open).toFixed(3), ends_at_scan_boundary: true });
      };
      closeOpen(black, openBlack);
      closeOpen(freeze, openFreeze);
      closeOpen(silence, openSilence);
    }
  }

  // Audio peaks (idea: riqvip/codex-media-mcp audio_peaks — peak
  // -1 dBFS, 0.1s window): one more decode pass, per-frame astats,
  // grouped into 0.1s windows. A window above the threshold is a
  // near-clipping stretch; >= 0 dBFS is digital clipping. A missing
  // audio stream reports "unavailable", never zero peaks.
  const PEAK_WINDOW = 0.1;
  let peakIntervals = [];
  let maxPeak = null;
  if (meta.audio) {
    const pArgs = ["-hide_banner", "-nostats"];
    if (startS > 0) pArgs.push("-ss", String(startS));
    pArgs.push("-i", inPath);
    if (scanDur !== null) pArgs.push("-t", String(scanDur));
    pArgs.push("-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level", "-f", "null", "-");
    const { stderr: pErr } = await run(FFMPEG, pArgs);
    const windows = new Map(); // window start (s) -> max peak (dBFS)
    let curT = null;
    for (const line of pErr.split("\n")) {
      let m;
      if ((m = line.match(/pts_time:\s*([\d.]+)/))) { curT = parseFloat(m[1]); continue; }
      if ((m = line.match(/lavfi\.astats\.Overall\.Peak_level=(-?inf|[-\d.]+)/))) {
        if (curT === null) continue;
        const peak = m[1] === "-inf" ? -Infinity : parseFloat(m[1]);
        if (!Number.isFinite(peak)) continue; // silent frame: no peak
        const tAbs = curT + startS;
        if (maxPeak === null || peak > maxPeak) maxPeak = peak;
        const w = +(Math.floor(tAbs / PEAK_WINDOW) * PEAK_WINDOW).toFixed(3);
        const prev = windows.get(w);
        if (prev === undefined || peak > prev) windows.set(w, peak);
      }
    }
    const hot = [...windows.entries()].filter(([, p]) => p > peakTh).sort((a, b) => a[0] - b[0]);
    for (const [w, p] of hot) {
      const last = peakIntervals[peakIntervals.length - 1];
      if (last && w <= last.end + 0.001) {
        // Adjacent hot window: extend the interval (last.end is the
        // previous window's end, so adjacency is exact).
        last.end = +(w + PEAK_WINDOW).toFixed(3);
        if (p > last.peak_db) last.peak_db = +p.toFixed(2);
      } else {
        peakIntervals.push({ start: w, end: +(w + PEAK_WINDOW).toFixed(3), peak_db: +p.toFixed(2), threshold_db: peakTh });
      }
    }
    for (const iv of peakIntervals) {
      if (scanEnd !== null && iv.end > scanEnd) { iv.end = +scanEnd.toFixed(3); iv.ends_at_scan_boundary = true; }
      iv.duration = +(iv.end - iv.start).toFixed(3);
    }
  }

  const issues = [];
  const warnings = [];
  const out = {
    operation: "content", input: inPath, duration_seconds: duration,
    ...(startS > 0 || endS !== null ? { time_range: { start_seconds: startS, end_seconds: scanEnd } } : {}),
  };
  for (const [kind, list] of [["black", black], ["freeze", freeze], ["silence", silence], ["peaks", peakIntervals]]) {
    const hasStream = kind === "silence" || kind === "peaks" ? meta.audio : meta.video;
    if (!hasStream) { out[kind] = { status: "unavailable" }; continue; }
    const classified = list.map((iv) => ({ ...iv, ...classifyContent(kind, iv, duration, startS, scanEnd) }));
    for (const iv of classified) (iv.severity === "error" ? issues : warnings).push(`${kind}: ${iv.reason}`);
    out[kind] = kind === "peaks"
      ? { ...contentSummary(classified), threshold_db: peakTh, window_seconds: PEAK_WINDOW, max_peak_db: maxPeak === null ? null : +maxPeak.toFixed(2) }
      : contentSummary(classified);
  }
  return {
    ...out,
    pass: issues.length === 0,
    ...(issues.length ? { issues } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------- grade
// Color grade (idea: beeswaxpat/ffmpeg-render-pro color_grade —
// presets or a custom -vf chain). Named presets are fixed filter
// chains, so the same preset always grades the same way; --filter is
// the power-user escape hatch for one arbitrary video filter chain.
// The result measures the mean R/G/B of the middle frame before and
// after, so the grade is verified on pixels, not assumed from the
// filter string. Audio is copied through untouched.

export const GRADE_PRESETS = {
  // colorbalance needs all three ranges (shadows/midtones/highlights)
  // set — the rs=/bs= shadow-only form barely moves the frame mean
  // (measured 2026-11-12: warm R +2.9 with shadows only, +14.8 with
  // all three ranges on the same testsrc frame).
  warm: "eq=saturation=1.15:contrast=1.02,colorbalance=rs=0.15:rm=0.15:rh=0.15:gs=0.03:gm=0.03:gh=0.03:bs=-0.15:bm=-0.15:bh=-0.15",
  cool: "eq=saturation=1.10:contrast=1.02,colorbalance=rs=-0.15:rm=-0.15:rh=-0.15:bs=0.15:bm=0.15:bh=0.15",
  cinematic: "eq=contrast=1.10:saturation=0.85,colorbalance=rs=-0.05:rm=-0.05:rh=-0.05:gs=0.02:gm=0.02:gh=0.02:bs=0.08:bm=0.08:bh=0.08",
  noir: "hue=s=0,eq=contrast=1.18:brightness=-0.02",
  vintage: "eq=contrast=0.95:saturation=0.70:brightness=0.03,colorbalance=rs=0.10:rm=0.10:rh=0.10:gs=0.02:gm=0.02:gh=0.02:bs=-0.08:bm=-0.08:bh=-0.08",
};

/** Mean R/G/B of one frame (extractplanes + signalstats, the same
 * measurement the test suite uses independently). Null per channel
 * when the measurement fails — the grade still stands, the numbers
 * just do not claim to prove it. */
async function frameChannelMeans(file, timeSeconds) {
  const out = {};
  for (const plane of ["r", "g", "b"]) {
    try {
      const { stderr } = await run(FFMPEG, [
        "-hide_banner", "-nostats", "-ss", String(timeSeconds), "-i", file,
        "-vf", `format=rgba,extractplanes=${plane},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
        "-frames:v", "1", "-f", "null", "-",
      ]);
      const m = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
      out[plane] = m ? +parseFloat(m[1]).toFixed(1) : null;
    } catch {
      out[plane] = null;
    }
  }
  return out;
}

// ASC CDL (slope/offset/power per channel + saturation), applied
// with lutrgb — a per-channel point operation, so lutrgb builds a
// 256-entry LUT once per channel instead of evaluating per pixel
// (geq does the same math but took 77s for a 10s 720p clip; lutrgb
// does it in ~6s). Saturation rides on eq afterwards. lutrgb needs
// commas inside its expressions escaped (\,) — the helper does that,
// the ":" channel separators stay bare.
function cdlTriple(v, name, min, max) {
  if (!Array.isArray(v) || v.length !== 3) {
    throw new MediaKitError(`${name} must be [r, g, b] (3 numbers), got ${JSON.stringify(v)}`, "INVALID_ARG");
  }
  return v.map((x, i) => num(x, `${name}[${i}]`, { min, max }));
}

function normalizeCdl(cdl) {
  if (cdl === null || cdl === undefined) return null;
  if (typeof cdl !== "object" || Array.isArray(cdl)) {
    throw new MediaKitError(`grade --cdl must be an object {slope, offset, power, saturation}, got ${JSON.stringify(cdl)}`, "INVALID_ARG");
  }
  return {
    slope: cdlTriple(cdl.slope ?? [1, 1, 1], "cdl.slope", 0, 4),
    offset: cdlTriple(cdl.offset ?? [0, 0, 0], "cdl.offset", -1, 1),
    power: cdlTriple(cdl.power ?? [1, 1, 1], "cdl.power", 0.1, 4),
    saturation: num(cdl.saturation ?? 1, "cdl.saturation", { min: 0, max: 4 }),
  };
}

function cdlFilterChain(c) {
  const exprs = ["r", "g", "b"].map((_, i) => {
    const raw = `clip(pow(max(val*${c.slope[i]}+${c.offset[i]}*255,0)/255,${c.power[i]})*255,0,255)`;
    return raw.replaceAll(",", "\\,");
  });
  let chain = `lutrgb=r='${exprs[0]}':g='${exprs[1]}':b='${exprs[2]}'`;
  if (c.saturation !== 1) chain += `,eq=saturation=${c.saturation}`;
  return chain;
}

export async function grade({ input, output, preset = null, filter = null, crf = 23, cdl = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const cdlNorm = normalizeCdl(cdl);
  if (cdlNorm) {
    if (filter !== null && filter !== undefined && filter !== "") {
      throw new MediaKitError("grade --cdl and --filter are mutually exclusive (one way to pick the look)", "INVALID_ARG");
    }
    if (preset !== null && preset !== undefined) {
      throw new MediaKitError("grade --cdl and --preset are mutually exclusive (one way to pick the look)", "INVALID_ARG");
    }
  }
  if (filter !== null && filter !== undefined && filter !== "") {
    if (preset !== null && preset !== undefined) {
      throw new MediaKitError("grade --preset and --filter are mutually exclusive (one way to pick the look)", "INVALID_ARG");
    }
    if (typeof filter !== "string") throw new MediaKitError("grade --filter must be a filter chain string", "INVALID_ARG");
  }
  const name = cdlNorm ? null : (filter ? null : (preset ?? "warm"));
  const chain = cdlNorm ? cdlFilterChain(cdlNorm) : (filter || GRADE_PRESETS[name]);
  if (!chain) throw new MediaKitError(`unknown grade preset: ${name} (supported: ${Object.keys(GRADE_PRESETS).join(", ")})`, "INVALID_ARG");
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("grade needs a video input", "INVALID_ARG");
  const mid = meta.duration_seconds !== null ? +(meta.duration_seconds / 2).toFixed(3) : 0;
  const before = await frameChannelMeans(inPath, mid);
  const args = ["-y", "-i", inPath, "-vf", chain, "-c:v", "libx264", "-crf", String(c), "-preset", "medium", "-c:a", "copy", outPath];
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const after = await frameChannelMeans(outPath, mid);
  const outMeta = await probe(outPath);
  return {
    operation: "grade", input: inPath, output: outPath,
    preset: name, filter: chain, crf: c, cdl: cdlNorm,
    color_before: before, color_after: after,
    dimensions: outMeta.video ? `${outMeta.video.width}x${outMeta.video.height}` : null,
    duration_seconds: outMeta.duration_seconds,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- reverse
// Play a clip backwards (conneroisu/vfx-mcp's reverse idea): video
// frames via the `reverse` filter, audio via `areverse` (on by
// default; audio=false keeps the audio playing forward under
// reversed video — a valid creative choice). The `reverse` filter
// buffers every frame, so a long input costs memory; a 10s clip is
// trivial, an hour-long file is not what this tool is for. The
// result reports whether each stream was actually reversed, and the
// test suite verifies the swap on pixels (red/blue halves trade
// places) and on audio (the silence gaps trade places too).
export async function reverseClip({ input, output, audio = true, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const meta = await probe(inPath);
  if (!meta.video && !meta.audio) throw new MediaKitError("reverse needs a video or audio input", "INVALID_ARG");
  const reverseAudio = audio !== false && !!meta.audio;
  if (!meta.video && !reverseAudio) {
    throw new MediaKitError("reverse with --no-audio on an audio-only input reverses nothing (there is no video to reverse)", "INVALID_ARG");
  }
  // The audio codec follows the output extension (like loudness/fit):
  // .mp3 gets libmp3lame, .mp4 gets aac — hardcoding aac wrote AAC
  // into an .mp3 container, an invalid file ffmpeg itself could not
  // open again (caught by the test suite 2026-11-12).
  const ext = path.extname(outPath).slice(1).toLowerCase();
  const audioCodec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext] ?? "aac";
  const args = ["-y", "-i", inPath];
  if (meta.video) args.push("-vf", "reverse", "-c:v", "libx264", "-crf", String(c), "-preset", "medium");
  if (meta.audio) {
    if (reverseAudio) args.push("-af", "areverse", "-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
    else args.push("-c:a", "copy");
  }
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "reverse", input: inPath, output: outPath,
    video_reversed: !!meta.video, audio_reversed: reverseAudio,
    audio_codec: reverseAudio ? audioCodec : (meta.audio ? "copy" : null),
    duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- rotate
// Rotate or flip a clip (yuan66-hub/ffmpeg-mcp has a `rotate` tool;
// misbahsy/video-audio-mcp, studied this round, has none — and
// neither of them strips the rotation metadata after transposing,
// so a player applies the matrix twice. MediaKit does).
//
// Semantics, and the one decision that matters: the angle is
// applied to the frame THE VIEWER SEES, not the stored pixels.
// ffmpeg's CLI autorotates on decode by default (verified by hand
// 2026-11-16: plain re-encode of test/rotated.mp4 — stored
// 1280x720, display matrix -90 — comes out 720x1280 with no side
// data), so `transpose` runs on the already-upright frame and the
// result matches probe's display_width/display_height. That is why
// rotate 90 on the rotated fixture gives 1280x720 (the display
// axes swap), while rotate 180 keeps 720x1280. Do NOT add
// -noautorotate: transposing stored pixels would leave the output
// displaying 1280x720 for a clip the viewer saw as 720x1280
// rotated 180 — wrong by 90 degrees.
//
// The re-encode also drops the Display Matrix side data and any
// `rotate` stream tag (verified on the matrix fixture and on an
// mkv carrying a rotate tag), so the output reports rotation null
// and no player double-rotates it. The result proves that on disk:
// input_rotation vs output_rotation.
//
// 180 is hflip+vflip, not transpose twice — one filter chain,
// same pixels. Audio is re-encoded by output extension with the
// AAC 192k pin (reverseClip's rule: hardcoding aac wrote AAC into
// an .mp3 container once).
export async function rotateClip({ input, output, angle = null, flip = null, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("rotate needs a video input", "INVALID_ARG");
  const hasAngle = angle !== null && angle !== undefined;
  const hasFlip = flip !== null && flip !== undefined && String(flip).trim() !== "";
  if (hasAngle === hasFlip) {
    throw new MediaKitError("rotate needs exactly one of angle or flip (angle: 90/180/270 clockwise, flip: horizontal/vertical)", "INVALID_ARG");
  }
  let filter;
  let angleOut = null;
  let flipOut = null;
  if (hasAngle) {
    const a = num(angle, "angle", { integer: true });
    if (![90, 180, 270].includes(a)) throw new MediaKitError(`angle must be 90, 180 or 270 (clockwise degrees), got: ${angle}`, "INVALID_ARG");
    angleOut = a;
    filter = a === 90 ? "transpose=1" : a === 270 ? "transpose=2" : "hflip,vflip";
  } else {
    const f = String(flip).trim().toLowerCase();
    if (f !== "horizontal" && f !== "vertical") throw new MediaKitError(`flip must be "horizontal" or "vertical", got: ${flip}`, "INVALID_ARG");
    flipOut = f;
    filter = f === "horizontal" ? "hflip" : "vflip";
  }
  const ext = path.extname(outPath).slice(1).toLowerCase();
  const audioCodec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext] ?? "aac";
  const args = ["-y", "-i", inPath, "-vf", filter, "-c:v", "libx264", "-crf", String(c), "-preset", "medium"];
  if (meta.audio) args.push("-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "rotate", input: inPath, output: outPath,
    angle: angleOut, flip: flipOut, filter,
    input_rotation: meta.video.rotation ?? null,
    input_dimensions: `${meta.video.display_width}x${meta.video.display_height}`,
    output_rotation: out.video?.rotation ?? null,
    dimensions: out.video ? `${out.video.display_width}x${out.video.display_height}` : null,
    duration_seconds: out.duration_seconds,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- make_loopable
// Make a clip loop seamlessly (Zulko/moviepy's MakeLoopable idea,
// built with the tail-to-head crossfade from a 2026-11-11 dev.to
// write-up): split into head [0,F], mid [F,D-F], tail [D-F,D];
// output = mid + seam, where the seam is the tail with the head
// fading in on top of it (fade on the ALPHA channel + overlay).
// The output ends on the head's last frame — exactly where mid
// begins — so when the player jumps back to the start, frame N
// flows into frame N+1 of the original motion. Cost: the output
// is F seconds shorter (D-F). Audio gets the same treatment with
// acrossfade (tri/tri), so the beat does not click at the seam.
//
// Why alpha+overlay instead of xfade: after trim+setpts the
// branches lose their constant-frame-rate metadata and xfade
// refuses them ("The inputs needs to be a constant frame rate").
// The alpha version does the same blend and does not care.
//
// The result measures the loop on disk: seam_before (mean abs gray
// difference between the input's last and first frames) vs
// seam_after (same on the output), plus normal_step (two
// neighbouring mid frames) as the honest baseline — a good seam
// lands at the normal step, not at zero. The seam score is
// best-effort: null when the measurement fails, never fatal.
async function lastFramePts(file, fps) {
  try {
    const { stdout } = await run(FFPROBE, [
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file,
    ]);
    const n = parseInt(String(stdout).trim(), 10);
    if (!Number.isFinite(n) || n < 1 || !fps) return null;
    return (n - 1) / fps;
  } catch {
    return null;
  }
}

// Mean absolute gray difference (0-255) between the frames at t1
// and t2. MEASUREMENT TRAP (caught 2026-11-15, do not "fix" back):
// `blend=all_mode=difference` on YUV inputs does NOT return
// |gray1-gray2| — red-vs-blue measures 28 there, while the true
// mean abs gray difference is 47. Convert both branches to rgb24
// first and the number matches the definition (verified on
// red/blue 47, red/red 0). Two-input `-ss` seeking is ALSO out:
// the same command returned 76 once and nothing the next time
// (framesync race), and `-sseof` misses the last frame whenever
// its pts sits more than the offset before the duration. Trim
// branches in one graph are deterministic.
async function frameDiffMean(file, t1, t2, fps, file2 = file) {
  try {
    const w = fps ? +(1 / fps).toFixed(4) : 0.04;
    const { stderr } = await run(FFMPEG, [
      "-hide_banner", "-nostats", "-i", file, "-i", file2,
      "-filter_complex",
      `[0:v]trim=start=${t1}:end=${+(t1 + w).toFixed(4)},setpts=PTS-STARTPTS,format=rgb24[a];` +
      `[1:v]trim=start=${t2}:end=${+(t2 + w).toFixed(4)},setpts=PTS-STARTPTS,format=rgb24[b];` +
      `[a][b]blend=all_mode=difference,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
      "-frames:v", "1", "-f", "null", "-",
    ]);
    const m = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    return m ? +parseFloat(m[1]).toFixed(2) : null;
  } catch {
    return null;
  }
}

async function seamScores(file) {
  const meta = await probe(file);
  if (!meta.video || !meta.video.fps || !Number.isFinite(meta.duration_seconds)) {
    return { seam_score: null, normal_step: null };
  }
  const fps = meta.video.fps;
  const step = 1 / fps;
  const last = await lastFramePts(file, fps);
  const seam = last === null ? null : await frameDiffMean(file, last, 0, fps);
  const mid = meta.duration_seconds / 2;
  const normal = await frameDiffMean(file, mid, mid + step, fps);
  return { seam_score: seam, normal_step: normal };
}

export async function makeLoopable({ input, output, overlap = 0.5, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const F = num(overlap, "overlap", { min: 0.1, max: 3600 });
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const meta = await probe(inPath);
  if (!meta.video && !meta.audio) throw new MediaKitError("make_loopable needs a video or audio input", "INVALID_ARG");
  const D = meta.duration_seconds;
  if (!Number.isFinite(D) || D <= 0) throw new MediaKitError("make_loopable needs an input with a known duration", "INVALID_ARG");
  // The middle section must survive: mid = [F, D-F] is empty when
  // F >= D/2. The write-up also advises staying under ~D/4 — a
  // longer crossfade ghosts the picture — but that stays advice in
  // the docs, not a refusal: a 1s overlap on a 3s clip is legal.
  if (F >= D / 2) {
    throw new MediaKitError(`make_loopable --overlap ${F}s must be under half the clip duration (${(D / 2).toFixed(2)}s for this ${D}s input) so a middle section remains`, "INVALID_ARG");
  }
  const f = (n) => +n.toFixed(3);
  const body = f(D - F);
  const ext = path.extname(outPath).slice(1).toLowerCase();
  const audioCodec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext] ?? "aac";
  const before = meta.video ? await seamScores(inPath) : { seam_score: null, normal_step: null };
  const fc = [];
  if (meta.video) {
    fc.push(
      `[0:v]split=3[a][b][c];` +
      `[a]trim=0:${f(F)},setpts=PTS-STARTPTS[head];` +
      `[b]trim=${f(F)}:${body},setpts=PTS-STARTPTS[mid];` +
      `[c]trim=${body}:${f(D)},setpts=PTS-STARTPTS[tail];` +
      `[head]format=yuva420p,fade=t=in:st=0:d=${f(F)}:alpha=1[hf];` +
      `[tail][hf]overlay=shortest=1[seam];` +
      `[mid][seam]concat=n=2:v=1:a=0,format=yuv420p[v]`,
    );
  }
  if (meta.audio) {
    fc.push(
      `[0:a]asplit=3[x][y][z];` +
      `[x]atrim=0:${f(F)},asetpts=PTS-STARTPTS[ah];` +
      `[y]atrim=${f(F)}:${body},asetpts=PTS-STARTPTS[am];` +
      `[z]atrim=${body}:${f(D)},asetpts=PTS-STARTPTS[at];` +
      `[at][ah]acrossfade=d=${f(F)}:c1=tri:c2=tri[as];` +
      `[am][as]concat=n=2:v=0:a=1[aout]`,
    );
  }
  const args = ["-y", "-i", inPath, "-filter_complex", fc.join(";")];
  if (meta.video) args.push("-map", "[v]", "-c:v", "libx264", "-crf", String(c), "-preset", "medium");
  if (meta.audio) args.push("-map", "[aout]", "-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const after = meta.video ? await seamScores(outPath) : { seam_score: null, normal_step: null };
  return {
    operation: "make_loopable", input: inPath, output: outPath,
    overlap_seconds: F,
    duration_before_seconds: D,
    duration_seconds: out.duration_seconds,
    expected_duration_seconds: body,
    duration_error_seconds: +(out.duration_seconds - body).toFixed(3),
    seam_before: before.seam_score,
    seam_after: after.seam_score,
    normal_step: after.normal_step,
    has_audio: !!meta.audio,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    size_bytes: info.size_bytes,
  };
}

// Total frame count via -count_frames (null when ffprobe cannot
// count — callers fall back to round(duration * fps)). Same probe
// lastFramePts uses; split out so freeze can clamp a frame index.
async function countFrames(file) {
  try {
    const { stdout } = await run(FFPROBE, [
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file,
    ]);
    const n = parseInt(String(stdout).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- freeze
// Hold one frame still for N seconds (Zulko/moviepy's Freeze idea):
// insert a frozen-frame segment at time `at` — output = pre [0,fs]
// + hold (the frame starting at fs, looped) + post [fs,D], so the
// clip grows by exactly `hold` seconds and the tail keeps its place
// in the timeline. `at` defaults to the end of the clip (hold the
// last frame — the end-card use). The frozen frame is picked by
// INDEX (select eq(n,frameIdx)), never by a time window — real PTS
// sits ~0.3ms off nominal boundaries and a time trim can silently
// yield zero frames (see the trap note inside freezeFrame).
//
// Audio in the hold is SILENCE (the open question from lượt 59,
// decided here): audio "keep" would leave the video D+hold long
// against D seconds of audio and force trailing silence to fill the
// gap — confusing. Mute keeps audio and video the same length:
// [0,fs] + silence(hold) + [fs,D]. The silence is built from the
// input's own audio (a 10ms slice at volume 0, apad to `hold`) so
// sample rate / channel layout / format always match the concat —
// no anullsrc layout guessing for mono vs 5.1.
//
// The result measures the freeze on disk: frozen_frame_diff (input
// frame at fs vs output frame mid-hold, ~0 when truly frozen) and
// post_frame_diff (input frame fs+step vs output frame fs+hold+step,
// ~0 when the tail kept its place — null when the hold sits on the
// last frame and there is no second post frame to compare).
export async function freezeFrame({ input, output, at = null, hold = 2, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const H = num(hold, "hold", { min: 0.1, max: 30 });
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("freeze needs a video input (there is no frame to hold in an audio-only file)", "INVALID_ARG");
  const D = meta.duration_seconds;
  if (!Number.isFinite(D) || D <= 0) throw new MediaKitError("freeze needs an input with a known duration", "INVALID_ARG");
  const fps = meta.video.fps;
  if (!fps || !Number.isFinite(fps) || fps <= 0) throw new MediaKitError("freeze needs a video with a known frame rate", "INVALID_ARG");
  const atSec = at === null || at === undefined ? D : parseTime(at, "at");
  if (atSec > D) throw new MediaKitError(`freeze --at ${atSec}s is past the end of this ${D}s clip`, "INVALID_ARG");
  const f = (n) => +n.toFixed(3);
  const step = 1 / fps;
  // Pick the frozen frame BY INDEX, not by time window. MEASUREMENT
  // TRAP (caught 2026-11-15, do not "fix" back): nominal frame
  // boundaries do not match real PTS — scenes-source.mp4 has 300
  // frames, last PTS 9.999674, so trim start=10 silently yields
  // ZERO frames and the hold branch came out empty (the output
  // kept the right duration only because the audio carried it;
  // ffprobe counted 300 frames, not 361). Counting frames once
  // with -count_frames and selecting eq(n,frameIdx) is PTS-proof.
  // Pre/post still split by time at fs = frameIdx/fps, which sits
  // a full frame step away from the neighbouring frames' PTS, so
  // the ±0.3ms offset cannot flip a boundary.
  const totalFrames = (await countFrames(inPath)) ?? Math.max(1, Math.round(D * fps));
  const frameIdx = Math.max(0, Math.min(Math.round(atSec * fps), totalFrames - 1));
  const fs = frameIdx / fps;
  const holdFrames = Math.max(1, Math.round(H * fps));
  const ext = path.extname(outPath).slice(1).toLowerCase();
  const audioCodec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext] ?? "aac";
  const fc = [];
  // split counts only the branches that exist: pre is skipped when
  // frameIdx == 0 (trim 0:0 yields nothing and concat chokes on it).
  // Post always holds >= 1 frame (the frozen frame itself).
  // ESCAPING TRAP (caught 2026-11-15): the select expression needs
  // NO backslash before the comma — the single quotes already
  // protect it from the graph parser. `eq(n\\,299)` (two literal
  // backslashes, from `\\\\,` in a template literal) makes the
  // expression parser see one escaped comma and fails with
  // "Missing ')' or too many args". Plain `eq(n,299)` works.
  const holdChain = `select='eq(n,${frameIdx})',setpts=PTS-STARTPTS,loop=loop=${holdFrames - 1}:size=1:start=0,trim=0:${f(H)},setpts=PTS-STARTPTS[holdv]`;
  if (frameIdx > 0) {
    fc.push(
      `[0:v]split=3[vpre][vfrz][vpost];` +
      `[vpre]trim=0:${f(fs)},setpts=PTS-STARTPTS[pre];` +
      `[vfrz]${holdChain};` +
      `[vpost]trim=${f(fs)}:${f(D)},setpts=PTS-STARTPTS[post];` +
      `[pre][holdv][post]concat=n=3:v=1:a=0,fps=${fps},format=yuv420p[v]`,
    );
  } else {
    fc.push(
      `[0:v]split=2[vfrz][vpost];` +
      `[vfrz]${holdChain};` +
      `[vpost]trim=${f(fs)}:${f(D)},setpts=PTS-STARTPTS[post];` +
      `[holdv][post]concat=n=2:v=1:a=0,fps=${fps},format=yuv420p[v]`,
    );
  }
  if (meta.audio) {
    if (frameIdx > 0) {
      fc.push(
        `[0:a]asplit=3[apre][asil][apost];` +
        `[apre]atrim=0:${f(fs)},asetpts=PTS-STARTPTS[apre];` +
        `[asil]atrim=0:0.01,asetpts=PTS-STARTPTS,volume=0,apad=whole_dur=${f(H)},atrim=0:${f(H)},asetpts=PTS-STARTPTS[sil];` +
        `[apost]atrim=${f(fs)}:${f(D)},asetpts=PTS-STARTPTS[apost];` +
        `[apre][sil][apost]concat=n=3:v=0:a=1[aout]`,
      );
    } else {
      fc.push(
        `[0:a]asplit=2[asil][apost];` +
        `[asil]atrim=0:0.01,asetpts=PTS-STARTPTS,volume=0,apad=whole_dur=${f(H)},atrim=0:${f(H)},asetpts=PTS-STARTPTS[sil];` +
        `[apost]atrim=${f(fs)}:${f(D)},asetpts=PTS-STARTPTS[apost];` +
        `[sil][apost]concat=n=2:v=0:a=1[aout]`,
      );
    }
  }
  const args = ["-y", "-i", inPath, "-filter_complex", fc.join(";")];
  args.push("-map", "[v]", "-c:v", "libx264", "-crf", String(c), "-preset", "medium");
  if (meta.audio) args.push("-map", "[aout]", "-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const frozen = await frameDiffMean(inPath, fs, fs + H / 2, fps, outPath);
  const postDiff = frameIdx + 1 < totalFrames ? await frameDiffMean(inPath, fs + step, fs + H + step, fps, outPath) : null;
  return {
    operation: "freeze", input: inPath, output: outPath,
    at_seconds: atSec,
    frame_seconds: +fs.toFixed(3),
    frame_index: frameIdx,
    hold_seconds: H,
    duration_before_seconds: D,
    duration_seconds: out.duration_seconds,
    expected_duration_seconds: +(D + H).toFixed(3),
    duration_error_seconds: +(out.duration_seconds - (D + H)).toFixed(3),
    frozen_frame_diff: frozen,
    post_frame_diff: postDiff,
    hold_audio: meta.audio ? "silence" : null,
    has_audio: !!meta.audio,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- fastforward
// Speed up marked spans of a clip, with a badge on the sped-up
// footage (khang-nyb/demo-recorder's render() idea: their fastForward
// fast-forwards backend waits in a screen recording and burns a
// ">> tua nhanh x8" badge on the sped spans; MediaKit's version is
// a general tool, not a screen recorder). The timeline is split
// into pieces — normal spans at 1x, marked spans at N x — and the
// pieces are re-joined with concat, so the output is shorter by
// exactly the saved time and everything after a span keeps its
// place. Video speeds up with setpts; audio keeps its pitch with
// chained atempo (the same atempoChain fit uses). The badge is a
// dark box + drawtext bottom-right, sized from the display frame
// height, so it lands the same relative size on a vertical phone
// clip and a landscape one. Spans are clamped to the clip, sorted,
// and overlaps collapse onto the previous span's end (the
// demo-recorder merge rule) instead of erroring on input order.
// The result measures the speed-up on disk: timing_check_mapped
// (input frame mid-span vs the output frame it should land on,
// ~0 when the mapping is right) against timing_check_unmapped
// (the same input frame vs the output frame at the unshifted time
// — large on footage that actually changes, ~0 on a flat colour,
// which is why the tests use the red/blue scenes fixture).
const FASTFORWARD_MAX_SEGMENTS = 16;

export async function fastForwardClip({ input, segments, output, badge = true, label = null, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const wantBadge = badge !== false;
  const badgeLabel = label === null || label === undefined ? "fast-forward" : String(label);
  if (!badgeLabel.trim()) throw new MediaKitError("fastforward --label must not be empty", "INVALID_ARG");
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > FASTFORWARD_MAX_SEGMENTS) {
    throw new MediaKitError(`fastforward needs 1-${FASTFORWARD_MAX_SEGMENTS} segments {start, end, speed}, got: ${Array.isArray(segments) ? `${segments.length} entries` : typeof segments}`, "INVALID_ARG");
  }
  const spans = segments.map((s, j) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new MediaKitError(`fastforward segments[${j}] must be an object {start, end, speed}`, "INVALID_ARG");
    }
    for (const k of Object.keys(s)) {
      if (!["start", "end", "speed"].includes(k)) {
        throw new MediaKitError(`fastforward segments[${j}] does not take "${k}" (only start, end, speed)`, "INVALID_ARG");
      }
    }
    const start = parseTime(s.start, `segments[${j}].start`);
    const end = parseTime(s.end, `segments[${j}].end`);
    const speed = num(s.speed, `segments[${j}].speed`, { min: 1.1, max: 16 });
    if (!(end > start)) throw new MediaKitError(`fastforward segments[${j}] needs end > start (got ${start}s-${end}s)`, "INVALID_ARG");
    return { start, end, speed };
  });
  const meta = await probe(inPath);
  const D = meta.duration_seconds;
  if (!Number.isFinite(D) || D <= 0) throw new MediaKitError("fastforward needs an input with a known duration", "INVALID_ARG");
  if (!meta.video && !meta.audio) throw new MediaKitError("fastforward needs a video or audio input", "INVALID_ARG");
  const fps = meta.video?.fps ?? null;
  if (meta.video && (!fps || !Number.isFinite(fps) || fps <= 0)) {
    throw new MediaKitError("fastforward needs a video with a known frame rate", "INVALID_ARG");
  }
  const f = (n) => +n.toFixed(3);
  // Clamp to the clip, drop spans that land entirely outside it,
  // sort, then collapse overlaps onto the previous span's end.
  const clamped = spans
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(D, s.end), clamped: s.start < 0 || s.end > D }))
    .filter((s) => s.end - s.start > 0.05);
  if (!clamped.length) throw new MediaKitError(`fastforward: every span lies outside this ${D}s clip`, "INVALID_ARG");
  clamped.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of clamped) {
    const prev = merged[merged.length - 1];
    if (prev && s.start < prev.end) {
      if (s.end - prev.end <= 0.05) continue; // swallowed whole by the previous span
      merged.push({ ...s, start: prev.end, clamped: true });
    } else merged.push(s);
  }
  // Pieces alternate 1x and fast; outStart is the piece's position
  // on the shortened output timeline.
  const pieces = [];
  let cursor = 0;
  for (const s of merged) {
    if (s.start - cursor > 0.01) pieces.push({ start: cursor, end: s.start, speed: 1 });
    pieces.push({ start: s.start, end: s.end, speed: s.speed });
    cursor = s.end;
  }
  if (D - cursor > 0.01) pieces.push({ start: cursor, end: D, speed: 1 });
  let t = 0;
  for (const p of pieces) {
    p.outStart = +t.toFixed(3);
    p.outDur = (p.end - p.start) / p.speed;
    t += p.outDur;
  }
  const expected = +t.toFixed(3);
  const applied = merged.map((s) => {
    const p = pieces.find((q) => q.start === s.start && q.speed === s.speed);
    return {
      start_seconds: s.start, end_seconds: s.end, speed: s.speed,
      out_start_seconds: p.outStart, out_end_seconds: +(p.outStart + p.outDur).toFixed(3),
      clamped: s.clamped,
    };
  });
  // Badge geometry from the display frame (rotation-aware): the
  // box is drawn by drawtext itself (box=1 auto-sizes to the text,
  // so a long label can never overflow the frame — a fixed-size
  // drawbox would clip ">> fast-forward x16" on a 360p clip).
  // Font scales with frame height: 30px at 1080 high.
  const disp = displayDims(meta);
  let badgeGeom = null;
  let badgeFiles = {};
  let tmpDir = null;
  if (meta.video && wantBadge) {
    const sc = disp.height / 1080;
    badgeGeom = {
      label: badgeLabel,
      fontsize: Math.round(30 * sc),
      margin: Math.round(24 * sc),
      border: Math.max(4, Math.round(8 * sc)),
      anchor: "bottom-right",
    };
  }
  try {
    if (badgeGeom) {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediakit-fastforward-"));
      const speeds = [...new Set(pieces.filter((p) => p.speed > 1).map((p) => p.speed))];
      for (let i = 0; i < speeds.length; i++) {
        const file = path.join(tmpDir, `badge-${i}.txt`);
        await writeFile(file, `>> ${badgeLabel} x${String(+speeds[i].toFixed(2))}`, "utf8");
        badgeFiles[speeds[i]] = file;
      }
    }
    const n = pieces.length;
    const fc = [];
    if (meta.video) {
      fc.push(`[0:v]split=${n}${pieces.map((_, i) => `[v${i}]`).join("")}`);
      for (let i = 0; i < n; i++) {
        const p = pieces[i];
        // Parentheses matter: setpts=PTS-STARTPTS/4 parses as
        // PTS-(STARTPTS/4) and shifts every piece — the bug the
        // broll setpts fix taught (lượt 95).
        let chain = `[v${i}]trim=start=${f(p.start)}:end=${f(p.end)},setpts=(PTS-STARTPTS)${p.speed > 1 ? `/${f(p.speed)}` : ""}`;
        if (p.speed > 1 && badgeGeom) {
          const esc = badgeFiles[p.speed].replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
          const off = badgeGeom.margin + badgeGeom.border;
          chain += `,drawtext=fontfile=${TITLECARD_FONT}:textfile=${esc}:fontsize=${badgeGeom.fontsize}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=${badgeGeom.border}:x=w-tw-${off}:y=h-th-${off}`;
        }
        chain += `[pv${i}]`;
        fc.push(chain);
      }
      fc.push(`${pieces.map((_, i) => `[pv${i}]`).join("")}concat=n=${n}:v=1:a=0,fps=${fps},format=yuv420p[v]`);
    }
    if (meta.audio) {
      fc.push(`[0:a]asplit=${n}${pieces.map((_, i) => `[a${i}]`).join("")}`);
      for (let i = 0; i < n; i++) {
        const p = pieces[i];
        fc.push(`[a${i}]atrim=start=${f(p.start)}:end=${f(p.end)},asetpts=PTS-STARTPTS${p.speed > 1 ? `,${atempoChain(p.speed)}` : ""}[pa${i}]`);
      }
      fc.push(`${pieces.map((_, i) => `[pa${i}]`).join("")}concat=n=${n}:v=0:a=1[aout]`);
    }
    const ext = path.extname(outPath).slice(1).toLowerCase();
    const audioCodec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext] ?? "aac";
    const args = ["-y", "-i", inPath, "-filter_complex", fc.join(";")];
    if (meta.video) args.push("-map", "[v]", "-c:v", "libx264", "-crf", String(c), "-preset", "medium");
    if (meta.audio) args.push("-map", "[aout]", "-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
    // -t caps the AAC encoder padding tail so the measured duration
    // lands on the expected one (the fit --t lesson, lượt 8).
    args.push("-t", String(expected), outPath);
    await run(FFMPEG, args);
    const info = await fileInfo(outPath);
    const out = await probe(outPath);
    const actual = out.duration_seconds;
    let mapped = null;
    let unmapped = null;
    let frames = null;
    if (meta.video) {
      const fast = pieces.find((p) => p.speed > 1);
      const srcMid = fast.start + (fast.end - fast.start) / 2;
      const outMid = fast.outStart + (fast.end - fast.start) / 2 / fast.speed;
      mapped = await frameDiffMean(inPath, srcMid, outMid, fps, outPath);
      unmapped = await frameDiffMean(inPath, srcMid, fast.outStart + (fast.end - fast.start) / 2, fps, outPath);
      frames = await countFrames(outPath);
    }
    return {
      operation: "fastforward", input: inPath, output: outPath,
      source_duration_seconds: D,
      segments: applied,
      duration_expected_seconds: expected,
      duration_seconds: actual,
      duration_error_seconds: actual === null ? null : +(actual - expected).toFixed(3),
      timing_check_mapped: mapped,
      timing_check_unmapped: unmapped,
      frames,
      // Estimate: the source's last frame sits a fraction of a
      // frame before D, so the true count can land 1 frame under
      // duration*fps (probe: 300-frame source -> 240, not 241).
      frames_expected: meta.video ? Math.round(expected * fps) : null,
      badge: badgeGeom,
      has_audio: !!meta.audio,
      dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
      size_bytes: info.size_bytes,
    };
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- boomerang
// Play a clip forward then backwards — the ping-pong loop
// (Zulko/moviepy's TimeSymmetrize/TimeMirror idea): output = the
// clip followed by its own reverse, so a bounce, a swing or a
// wave returns to where it started with no cut. The seam is where
// the naive version breaks: the forward half ends on the last
// frame and the reversed half starts on that same frame, so the
// peak frame plays twice and the motion visibly stutters —
// moviepy v2.2.1 fixed exactly this clipping in TimeMirror by
// trimming one frame at the pivot. This tool does the same: the
// reversed video branch drops its first frame
// (`trim=start_frame=1`, the original's last frame) and the
// reversed audio branch drops one video-frame of audio
// (`atrim=start=1/fps`) at the same point, so the output is
// 2D - 1/fps and the seam joins two neighbouring frames, not a
// repeated one. Audio-only input has no video frame to pivot on,
// so it plays forward + reversed whole (2D) with no audio trim.
// The result measures the seam on disk: seam_diff (output frame
// just before the seam vs just after it) against normal_step
// (two neighbouring mid-forward frames) — a good seam lands at
// the normal step, and the frame count (2N-1) is the honest
// proof the pivot frame was really dropped, since duration alone
// cannot tell a duplicated frame from an adjacent one.
export async function boomerangClip({ input, output, audio = true, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const meta = await probe(inPath);
  if (!meta.video && !meta.audio) throw new MediaKitError("boomerang needs a video or audio input", "INVALID_ARG");
  const reverseAudio = audio !== false && !!meta.audio;
  if (!meta.video && !reverseAudio) {
    throw new MediaKitError("boomerang with --no-audio on an audio-only input reverses nothing (there is no video to reverse)", "INVALID_ARG");
  }
  const D = meta.duration_seconds;
  if (!Number.isFinite(D) || D <= 0) throw new MediaKitError("boomerang needs an input with a known duration", "INVALID_ARG");
  const fps = meta.video?.fps ?? null;
  // The reversed branch must keep at least one frame after the
  // pivot trim, so the clip needs at least 2 video frames.
  if (meta.video && (!fps || D < 2 / fps)) {
    throw new MediaKitError(`boomerang needs a clip of at least 2 frames (${fps ? (2 / fps).toFixed(3) : "?"}s at this frame rate), got ${D}s`, "INVALID_ARG");
  }
  const pivot = meta.video ? 1 / fps : 0;
  const expected = meta.video ? 2 * D - pivot : 2 * D;
  const f = (n) => +n.toFixed(4);
  const ext = path.extname(outPath).slice(1).toLowerCase();
  const audioCodec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext] ?? "aac";
  const fc = [];
  if (meta.video) {
    fc.push(
      `[0:v]split=2[fwd][rs];` +
      `[rs]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rev];` +
      `[fwd]setpts=PTS-STARTPTS[fwd0];` +
      `[fwd0][rev]concat=n=2:v=1:a=0[v]`,
    );
  }
  if (meta.audio) {
    // Audio-only has no video pivot: reverse the whole audio.
    const atrim = meta.video ? `atrim=start=${f(pivot)},` : "";
    fc.push(
      `[0:a]asplit=2[af][ar];` +
      `[ar]areverse,${atrim}asetpts=PTS-STARTPTS[ar2];` +
      `[af][ar2]concat=n=2:v=0:a=1[aout]`,
    );
  }
  const args = ["-y", "-i", inPath, "-filter_complex", fc.join(";")];
  if (meta.video) args.push("-map", "[v]", "-c:v", "libx264", "-crf", String(c), "-preset", "medium");
  if (meta.audio) {
    if (reverseAudio) args.push("-map", "[aout]", "-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
    else args.push("-c:a", "copy");
  }
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  let seamDiff = null;
  let normalStep = null;
  if (meta.video) {
    const step = 1 / fps;
    seamDiff = await frameDiffMean(outPath, D - step, D, fps);
    const mid = D / 2;
    normalStep = await frameDiffMean(outPath, mid, mid + step, fps);
  }
  return {
    operation: "boomerang", input: inPath, output: outPath,
    duration_before_seconds: D,
    duration_seconds: out.duration_seconds,
    expected_duration_seconds: +expected.toFixed(3),
    duration_error_seconds: +(out.duration_seconds - expected).toFixed(3),
    pivot_seconds: +pivot.toFixed(4),
    seam_diff: seamDiff,
    normal_step: normalStep,
    video_reversed: !!meta.video,
    audio_reversed: reverseAudio,
    audio_codec: reverseAudio ? audioCodec : (meta.audio ? "copy" : null),
    has_audio: !!meta.audio,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- chroma_key
// Remove a green/blue screen (ffmpeg-cookbook's chromakey recipe +
// MakeMyClip's backlog item): `chromakey=color:similarity:blend`
// makes the key color transparent. The transparency lives in an
// alpha channel, so the output container must carry one — and that
// is where the naive recipe breaks: on this ffmpeg 8.1.2 build,
// `libvpx-vp9 -pix_fmt yuva420p` decodes back as yuv420p (measured
// 2026-11-13, even with -auto-alt-ref 0: alphaextract fails with
// "Requested planes not available"). So transparent mode writes
// .mov with ProRes 4444 (measured: corner alpha 256/4095,
// subject 3760/4095 on 12-bit limited range — transparent vs
// opaque). .mp4 is refused outright (H.264 has no alpha) and
// .webm is refused with the reason above. With --background (an
// image file or a hex color) the keyed foreground is composited
// onto it in the same call and the output is a normal flat .mp4
// (or .webm). The result measures the alpha on disk (middle frame,
// 8-bit normalized via format=rgba so ProRes 12-bit depth does not
// leak into the numbers): full-frame mean plus a corner region
// (should be ~0 for a full-screen key) and a center region
// (should be ~255 where the subject sits).
function normalizeKeyColor(color) {
  if (typeof color !== "string") {
    throw new MediaKitError(`chroma_key --color must be a 6-digit hex color (e.g. 00FF00), got ${JSON.stringify(color)}`, "INVALID_ARG");
  }
  const hex = color.trim().replace(/^#/, "").replace(/^0x/i, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(hex)) {
    throw new MediaKitError(`chroma_key --color must be a 6-digit hex color (e.g. 00FF00 for green, 0000FF for blue), got "${color}"`, "INVALID_ARG");
  }
  return hex;
}

// Mean alpha (0-255, 8-bit normalized) of one frame, optionally
// cropped to a W:H:X:Y pixel rect. Null when the measurement fails
// (e.g. the file has no alpha plane at all — alphaextract refuses).
async function alphaMeanAt(file, timeSeconds, crop) {
  try {
    const vf = crop
      ? `format=rgba,crop=${crop},alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG`
      : `format=rgba,alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG`;
    const { stderr } = await run(FFMPEG, [
      "-hide_banner", "-nostats", "-ss", String(timeSeconds), "-i", file,
      "-vf", vf, "-frames:v", "1", "-f", "null", "-",
    ]);
    const m = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    return m ? +parseFloat(m[1]).toFixed(1) : null;
  } catch {
    return null;
  }
}

export async function chromaKey({ input, output, color = "00FF00", similarity = 0.1, blend = 0.0, background = null, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const key = normalizeKeyColor(color);
  const sim = num(similarity, "similarity", { min: 0, max: 1 });
  const bl = num(blend, "blend", { min: 0, max: 1 });
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("chroma_key needs a video input", "INVALID_ARG");
  const { width: W, height: H } = meta.video;
  const ext = path.extname(outPath).slice(1).toLowerCase();
  const keyFilter = `chromakey=0x${key}:${sim}:${bl}`;

  // --background: an image file, or a hex color (00FF00 / #00FF00).
  let bg = null;
  if (background !== null && background !== undefined && background !== "") {
    const b = String(background).trim();
    if (/^#?[0-9A-Fa-f]{6}$/.test(b) || /^0x[0-9A-Fa-f]{6}$/.test(b)) {
      bg = { kind: "color", value: b.replace(/^#|^0x/i, "").toUpperCase() };
    } else {
      bg = { kind: "image", path: await requireInput(b, "background") };
    }
  }

  let args;
  if (!bg) {
    // Transparent mode: only .mov (ProRes 4444) keeps the alpha on
    // this build — see the header comment for the measured WebM loss.
    if (ext !== "mov") {
      throw new MediaKitError(
        `chroma_key without --background keeps transparency, so the output must be .mov (ProRes 4444) — got .${ext || "(no extension)"}. ` +
        `.mp4/H.264 has no alpha channel, and this ffmpeg build drops VP9 alpha in .webm (measured 2026-11-13). ` +
        `Add --background <image|hex-color> to composite onto a background and write .mp4/.webm instead.`,
        "INVALID_ARG",
      );
    }
    args = ["-y", "-i", inPath, "-vf", `${keyFilter},format=yuva444p10le`,
      "-c:v", "prores_ks", "-profile:v", "4444"];
    if (meta.audio) args.push("-c:a", "aac", ...audioBitrateArgs("aac"));
    args.push(outPath);
  } else {
    // Composite mode: flat yuv420p output, .mp4 (libx264) or .webm (VP9).
    if (ext !== "mp4" && ext !== "webm") {
      throw new MediaKitError(`chroma_key with --background writes a flat video, so the output must be .mp4 or .webm — got .${ext || "(no extension)"}`, "INVALID_ARG");
    }
    const fps = meta.video.fps ?? 30;
    const dur = meta.duration_seconds ?? 0;
    const videoCodec = ext === "webm" ? "libvpx-vp9" : "libx264";
    const bgFilter = bg.kind === "color"
      ? null
      : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    const fc = bg.kind === "color"
      ? `[1:v]${keyFilter}[fg];[0:v][fg]overlay=0:0,format=yuv420p[v]`
      : `[0:v]${bgFilter}[bg];[1:v]${keyFilter}[fg];[bg][fg]overlay=0:0,format=yuv420p[v]`;
    args = ["-y"];
    if (bg.kind === "color") args.push("-f", "lavfi", "-i", `color=c=0x${bg.value}:s=${W}x${H}:r=${fps}:d=${dur}`);
    else args.push("-framerate", String(fps), "-loop", "1", "-i", bg.path);
    args.push("-i", inPath, "-filter_complex", fc, "-map", "[v]");
    if (meta.audio) args.push("-map", "1:a", "-c:a", "copy");
    args.push("-c:v", videoCodec, "-crf", String(c), "-preset", "medium");
    if (dur) args.push("-t", String(dur));
    args.push(outPath);
  }
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const pixFmt = out.video?.pixel_format ?? null;
  const hasAlpha = !!pixFmt && /(yuva|argb|rgba|abgr|bgra)/.test(pixFmt);
  // Alpha is measured on the middle frame; corner (1/8 of the frame)
  // should be ~0 for a full-screen key, center ~255 on the subject.
  let alphaMean = null, alphaCornerMean = null, alphaCenterMean = null;
  if (!bg && hasAlpha) {
    const t = (out.duration_seconds ?? meta.duration_seconds ?? 3) / 2;
    const cw = Math.max(2, Math.floor(W / 8));
    const ch = Math.max(2, Math.floor(H / 8));
    alphaMean = await alphaMeanAt(outPath, t, null);
    alphaCornerMean = await alphaMeanAt(outPath, t, `${cw}:${ch}:0:0`);
    alphaCenterMean = await alphaMeanAt(outPath, t, `${cw}:${ch}:${Math.floor(W / 2 - cw / 2)}:${Math.floor(H / 2 - ch / 2)}`);
  }
  return {
    operation: "chroma_key", input: inPath, output: outPath,
    color: key, similarity: sim, blend: bl,
    background: bg ? (bg.kind === "color" ? bg.value : bg.path) : null,
    mode: bg ? "composite" : "transparent",
    pixel_format: pixFmt, has_alpha: hasAlpha,
    alpha_mean: alphaMean, alpha_corner_mean: alphaCornerMean, alpha_center_mean: alphaCenterMean,
    duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- zoom_pan
// Ken Burns effect: turn a still image into a moving clip
// (dev.to's AI Shorts pipeline + salivity's zoompan guides —
// MakeMyClip's backlog item). zoompan crops a moving window out of
// the frame and scales it back to the output size, so zoom and pan
// are one linear interpolation each: zoom z0→z1 and focus
// (fx0,fy0)→(fx1,fy1), both driven by the output frame number `on`.
// Two measured gotchas baked in: (1) zoompan does its crop math in
// integer pixels, so slow moves jitter — the input is pre-scaled
// 1.25x bigger than the output first (the guides' fix); (2) a video
// input would be stretched by d frames per input frame, so this
// tool takes a still image only and refuses video/audio inputs.
// Frame 0 is exactly the full image (zoom z0, focus start) and the
// last frame is exactly the zoomed window (zoom z1, focus end) —
// the test suite verifies both against crops computed independently.
export async function zoomPan({ input, output, duration = 5, fps = 30, zoomFrom = 1, zoomTo = 1.5, focusX = 0.5, focusY = 0.5, focusEndX = null, focusEndY = null, width = 1280, height = 720, crf = 23, onProgress = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const dur = num(duration, "duration", { min: 0.5, max: 600 });
  const f = num(fps, "fps", { min: 1, max: 120, integer: true });
  const z0 = num(zoomFrom, "zoom_from", { min: 1, max: 10 });
  const z1 = num(zoomTo, "zoom_to", { min: 1, max: 10 });
  const fx0 = num(focusX, "focus_x", { min: 0, max: 1 });
  const fy0 = num(focusY, "focus_y", { min: 0, max: 1 });
  const fx1 = focusEndX === null || focusEndX === undefined ? fx0 : num(focusEndX, "focus_end_x", { min: 0, max: 1 });
  const fy1 = focusEndY === null || focusEndY === undefined ? fy0 : num(focusEndY, "focus_end_y", { min: 0, max: 1 });
  const w = num(width, "width", { min: 2, max: 7680, integer: true });
  const h = num(height, "height", { min: 2, max: 4320, integer: true });
  if (w % 2 || h % 2) throw new MediaKitError(`zoom_pan width/height must be even (got ${w}x${h})`, "INVALID_ARG");
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("zoom_pan needs a still image input", "INVALID_ARG");
  if (meta.audio || meta.duration_seconds !== null) {
    throw new MediaKitError("zoom_pan takes a still image, not a video (zoompan would stretch a video by d frames per input frame — extract a frame first)", "INVALID_ARG");
  }
  const n = Math.max(2, Math.round(dur * f));
  const preW = Math.ceil((w * 1.25) / 2) * 2;
  const preH = Math.ceil((h * 1.25) / 2) * 2;
  const fmt = (x) => +x.toFixed(4);
  // Linear in `on` (0..n-1); at on=0 the window is the full frame at
  // zoom z0, at on=n-1 it is the z1 window on the end focus.
  const zExpr = `${fmt(z0)}+(${fmt(z1 - z0)})*on/${n - 1}`;
  const fxExpr = `(${fmt(fx0)}+(${fmt(fx1 - fx0)})*on/${n - 1})`;
  const fyExpr = `(${fmt(fy0)}+(${fmt(fy1 - fy0)})*on/${n - 1})`;
  const xExpr = `min(max(${fxExpr}*iw-(iw/zoom)/2,0),iw-iw/zoom)`;
  const yExpr = `min(max(${fyExpr}*ih-(ih/zoom)/2,0),ih-ih/zoom)`;
  const vf = `scale=${preW}:${preH}:force_original_aspect_ratio=increase,crop=${preW}:${preH},zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${n}:s=${w}x${h}:fps=${f}`;
  await runFfmpegWithProgress([
    "-y", "-loop", "1", "-i", inPath, "-vf", vf,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(c), "-preset", "medium",
    "-t", String(dur), outPath,
  ], { totalSeconds: dur, onProgress });
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const frames = await countVideoFrames(outPath);
  return {
    operation: "zoom_pan", input: inPath, output: outPath,
    duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    fps: out.video?.fps ?? null, frames,
    zoom_from: z0, zoom_to: z1,
    focus_start: [fx0, fy0], focus_end: [fx1, fy1],
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- image_to_video
// Turn one still image into a fixed-duration video (the
// PedroMarianoAlmeida/ffmpeg-mcp `image_to_video` idea — MediaKit's
// zoom_pan always moves, this one holds still). One image, one
// duration, no motion: the use case is a podcast still, a song
// cover, or a title card held over audio. The image is looped at
// the output fps and capped with -t, so the frame count is exactly
// round(duration*fps) — the test asserts it on disk. Dimensions
// default to the image itself (made even); --width/--height fit the
// image inside the box and pad black to the exact size, so a
// 1280x720 photo asked for 1080x1920 comes out 1080x1920, not
// stretched. --audio loops the audio to the same duration (a short
// bed loops, a long one is trimmed by -t). Output is .mp4 (libx264)
// or .webm (VP9); a video input is refused — extract a frame first.
function evenDown(n) { return n % 2 ? n - 1 : n; }

export async function imageToVideo({ input, output, duration = 5, fps = 30, width = null, height = null, audio = null, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const dur = num(duration, "duration", { min: 0.5, max: 600 });
  const f = num(fps, "fps", { min: 1, max: 120, integer: true });
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("image_to_video needs a still image input", "INVALID_ARG");
  if (meta.audio || meta.duration_seconds !== null) {
    throw new MediaKitError("image_to_video takes a still image, not a video (extract a frame first, or use zoom_pan for a moving clip)", "INVALID_ARG");
  }
  const ext = path.extname(outPath).slice(1).toLowerCase();
  if (ext !== "mp4" && ext !== "webm") {
    throw new MediaKitError(`image_to_video writes .mp4 (H.264) or .webm (VP9) — got .${ext || "(no extension)"}`, "INVALID_ARG");
  }
  const srcW = meta.video.width;
  const srcH = meta.video.height;
  let w, h;
  if (width === null || width === undefined) {
    if (height === null || height === undefined) { w = evenDown(srcW); h = evenDown(srcH); }
    else { h = evenDown(num(height, "height", { min: 2, max: 4320, integer: true })); w = evenDown(Math.round((h * srcW) / srcH)); }
  } else {
    w = evenDown(num(width, "width", { min: 2, max: 7680, integer: true }));
    h = (height === null || height === undefined)
      ? evenDown(Math.round((w * srcH) / srcW))
      : evenDown(num(height, "height", { min: 2, max: 4320, integer: true }));
  }
  if (w < 2 || h < 2) throw new MediaKitError(`image_to_video output dimensions too small after even-rounding (got ${w}x${h})`, "INVALID_ARG");
  let audioPath = null;
  if (audio !== null && audio !== undefined && audio !== "") {
    audioPath = await requireInput(audio, "audio");
    const audioMeta = await probe(audioPath);
    if (!audioMeta.audio) throw new MediaKitError(`image_to_video --audio needs an audio file, got ${audio} (no audio stream)`, "INVALID_ARG");
  }
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
  const videoCodec = ext === "webm" ? "libvpx-vp9" : "libx264";
  const args = ["-y", "-loop", "1", "-framerate", String(f), "-i", inPath];
  if (audioPath) args.push("-stream_loop", "-1", "-i", audioPath);
  args.push("-vf", vf, "-c:v", videoCodec, "-crf", String(c), "-preset", "medium");
  if (audioPath) args.push("-c:a", ext === "webm" ? "libopus" : "aac", "-b:a", "128k");
  args.push("-t", String(dur), outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const frames = await countVideoFrames(outPath);
  return {
    operation: "image_to_video", input: inPath, output: outPath,
    duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    fps: out.video?.fps ?? null, frames,
    audio: !!audioPath,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- download
// Fetch a media file from an http(s) URL into the workspace, typed and
// guarded — the mrdainami/ffmpeg-mcp `download` idea, but the lesson
// from brookcs3/m3u8-mcp-server's m3u8_download is what NOT to do:
// that tool is one bare `ffmpeg -i <url> -c copy` with no URL
// validation, no size cap, no timeout and no check of what came back.
// MediaKit's download is the opposite: validate the URL first
// (http/https only, no embedded credentials), stream the body to
// disk with a byte cap enforced WHILE streaming (not just from
// Content-Length, which a server can lie about), cap redirects at
// 5, refuse a redirect off http(s), write to `<output>.partial` and
// rename only on success, then probe the file — a download that is
// not media is deleted and reported, never left on disk as a
// success. Content-Type must be media (video/*, audio/*, image/*)
// or application/octet-stream with a media extension; the output
// extension is either given (and must be a media extension, same
// list as `find`) or derived from the Content-Type / URL path. A
// caller extension whose category disagrees with a specific
// Content-Type (mp4 served as .mp3) is refused instead of silently
// mislabelled.
//
// HLS (.m3u8) / DASH (.mpd) playlists take a different fetcher — a
// playlist is a list of segments, not a file, so the direct path's
// streaming cap cannot apply. The playlist branch (downloadPlaylist-
// Media, below) fetches with ffmpeg `-c copy` (re-mux, never
// re-encode), fenced to network protocols only so a hostile playlist
// cannot pull file:// segments off disk, under the same timeout,
// and enforces the size cap AFTER the fetch: an over-cap file is
// deleted and reported, never left as a success. The probe check at
// the end is the same as the direct path.
const DOWNLOAD_MAX_REDIRECTS = 5;
const DOWNLOAD_DEFAULT_MAX_MB = 500;
const DOWNLOAD_DEFAULT_TIMEOUT_S = 300;
// Download only takes files ffprobe can read as media — the caption
// extensions in FIND_EXTENSIONS (srt/vtt/ass) are left out on
// purpose: a .srt would pass the extension check and then fail the
// probe, which is a confusing two-step refusal.
const DOWNLOAD_EXTENSIONS = FIND_EXTENSIONS.filter((e) => !["srt", "vtt", "ass"].includes(e));
const DOWNLOAD_CONTENT_TYPE_EXT = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "video/x-matroska": "mkv", "video/x-msvideo": "avi", "video/x-m4v": "m4v",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav",
  "audio/x-wav": "wav", "audio/flac": "flac", "audio/ogg": "ogg",
  "audio/opus": "opus",
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "image/gif": "gif",
};
const DOWNLOAD_MEDIA_CATEGORY = {
  mp4: "video", mov: "video", mkv: "video", webm: "video", avi: "video", m4v: "video",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", ogg: "audio", opus: "audio",
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
};

// Download cache + retry + token bucket (lượt 85, backlog; the
// lesson from tillo13/ai_storyboard_video_generator's naive
// `requests.get` download — no timeout, no retry, no validation):
// a director re-fetches the same stock URL across runs, and a CDN
// 503 must not fail the whole manifest. Three separate mechanisms:
//  - cache: opt-in per-URL disk cache under MEDIAKIT_DOWNLOAD_CACHE_DIR
//    (default ~/.cache/mediakit/downloads), keyed by sha256(url); a
//    hit is verified by size + sha256 before it is trusted, and a
//    corrupt entry is a miss, never served. Playlists are NOT cached
//    (their segments change under the same URL) — cache:true on a
//    playlist is refused, not silently ignored.
//  - retry: 429/5xx + network errors are retried (default 3) with
//    exponential backoff 1s/2s/4s, honouring Retry-After (capped
//    60s). Other 4xx, content-type/size refusals and timeouts are NOT
//    retried — retrying a deterministic refusal only burns time.
//  - token bucket: in-process, one token per download call, only when
//    rate_limit_rps > 0 (param wins, else MEDIAKIT_DOWNLOAD_RPS env).
//    A manifest fetching several URLs in one process is paced; a
//    single CLI call is unaffected (the bucket starts full).
const DOWNLOAD_DEFAULT_MAX_RETRIES = 3;
const DOWNLOAD_MAX_RETRIES = 5;
const DOWNLOAD_BACKOFF_BASE_MS = 1000;
const DOWNLOAD_BACKOFF_MAX_MS = 8000;
const DOWNLOAD_RETRY_AFTER_MAX_S = 60;
const DOWNLOAD_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function downloadEnvRps() {
  const raw = process.env.MEDIAKIT_DOWNLOAD_RPS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : 0;
}

function downloadCacheDir(cacheDir) {
  if (typeof cacheDir === "string" && cacheDir.trim()) return cacheDir.trim();
  const env = process.env.MEDIAKIT_DOWNLOAD_CACHE_DIR;
  if (typeof env === "string" && env.trim()) return env.trim();
  return path.join(os.homedir(), ".cache", "mediakit", "downloads");
}

function downloadCacheKey(url) {
  return createHash("sha256").update(url).digest("hex");
}

// A cache hit is trusted only after the stored bytes still match
// the meta (size + sha256) and the meta names this exact URL —
// anything else is a miss, never served.
async function readDownloadCacheEntry(dir, key, url) {
  const entryDir = path.join(dir, key);
  try {
    const meta = JSON.parse(await readFile(path.join(entryDir, "meta.json"), "utf8"));
    if (meta?.url !== url || typeof meta.sha256 !== "string" || typeof meta.size_bytes !== "number"
      || typeof meta.ext !== "string" || !meta.ext || typeof meta.stored_at !== "string") return null;
    const filePath = path.join(entryDir, "file");
    const st = await stat(filePath);
    if (st.size !== meta.size_bytes) return null;
    const sha = createHash("sha256").update(await readFile(filePath)).digest("hex");
    if (sha !== meta.sha256) return null;
    return { meta, filePath };
  } catch {
    return null;
  }
}

// Best effort by design: a cache that cannot be written must not
// fail a download that already succeeded — returns false instead of
// throwing. The file is renamed into place before the meta, so a
// crash mid-store leaves no meta to trust (a miss, not a lie).
async function storeDownloadCacheEntry(dir, key, { url, finalUrl, contentType, ext, redirects, filePath }) {
  try {
    const entryDir = path.join(dir, key);
    await mkdir(entryDir, { recursive: true });
    const bytes = await readFile(filePath);
    const meta = {
      schema: "mediakit-for-agents/download-cache/1",
      url, final_url: finalUrl, content_type: contentType ?? null, ext,
      redirects: redirects ?? null, size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      stored_at: new Date().toISOString(),
    };
    const tmpFile = path.join(entryDir, `file.tmp-${process.pid}`);
    await writeFile(tmpFile, bytes);
    await rename(tmpFile, path.join(entryDir, "file"));
    const tmpMeta = path.join(entryDir, "meta.json.tmp");
    await writeFile(tmpMeta, JSON.stringify(meta, null, 2), "utf8");
    await rename(tmpMeta, path.join(entryDir, "meta.json"));
    return true;
  } catch {
    return false;
  }
}

// In-process token bucket: capacity = rps (one burst of rps calls is
// free), refilled at rps/second. Returns the milliseconds waited
// (0 when a token was already available, or the limit is off).
let downloadBucket = null;
async function acquireDownloadToken(rps) {
  if (!rps || rps <= 0) return 0;
  const now = Date.now();
  if (!downloadBucket || downloadBucket.rps !== rps) {
    downloadBucket = { rps, tokens: rps, lastMs: now };
  }
  const elapsedS = (now - downloadBucket.lastMs) / 1000;
  downloadBucket.tokens = Math.min(rps, downloadBucket.tokens + elapsedS * rps);
  downloadBucket.lastMs = now;
  if (downloadBucket.tokens >= 1) {
    downloadBucket.tokens -= 1;
    return 0;
  }
  const waitMs = Math.ceil(((1 - downloadBucket.tokens) / rps) * 1000);
  await new Promise((r) => setTimeout(r, waitMs));
  downloadBucket.tokens = 0;
  downloadBucket.lastMs = Date.now();
  return waitMs;
}

// License policy gate for `download` (lượt 90, backlog from
// js713-lab/sonic-match-mcp, lượt 68 — provenance already recorded
// the license as "unknown", but nothing stopped a download whose
// license the caller KNEW was unusable). The gate is a policy FILE,
// never a guess: the caller declares the license with --license, the
// policy file lists what is allowed / denied, and a download whose
// declared license fails the policy is refused BEFORE any network
// fetch — zero bytes, zero server hits, no file written. Without a
// policy file the gate is off and the license is only recorded (the
// old behaviour): a policy that silently blocked every existing
// workflow would be a breaking change, so enforcement is opt-in by
// design. The policy file is MEDIAKIT_LICENSE_POLICY (env) or
// --license-policy-file (per call, wins over env):
//   { "allow": ["CC0", "CC-BY"], "deny": ["All Rights Reserved"], "require_license": true }
// allow null/absent = any label passes (unless denied);
// require_license = a download with no declared license is refused.
const LICENSE_POLICY_ENV = "MEDIAKIT_LICENSE_POLICY";
const LICENSE_ALIASES = {
  "cc0": "CC0",
  "cc-by": "CC-BY",
  "cc-by-sa": "CC-BY-SA",
  "cc-by-nc": "CC-BY-NC",
  "cc-by-nd": "CC-BY-ND",
  "cc-by-nc-sa": "CC-BY-NC-SA",
  "cc-by-nc-nd": "CC-BY-NC-ND",
  "public-domain": "Public Domain",
  "public domain": "Public Domain",
  "pd": "Public Domain",
  "unknown": "unknown",
  "all-rights-reserved": "All Rights Reserved",
  "all rights reserved": "All Rights Reserved",
  "arr": "All Rights Reserved",
  "proprietary": "All Rights Reserved",
  "copyrighted": "All Rights Reserved",
  "mit": "MIT",
  "apache-2.0": "Apache-2.0",
  "apache 2.0": "Apache-2.0",
  "gpl-3.0": "GPL-3.0",
  "ofl-1.1": "OFL-1.1",
};

// Canonicalize a declared license: aliases collapse to one spelling
// ("cc0" / "CC0" / "Cc0" are the same label), anything unlisted is
// kept verbatim — a label is never guessed or rewritten into a
// different license. No declaration means "unknown".
function canonicalLicense(label) {
  if (label === null || label === undefined) return "unknown";
  const trimmed = String(label).trim();
  if (!trimmed) return "unknown";
  const key = trimmed.toLowerCase().replace(/\s+/g, " ");
  return LICENSE_ALIASES[key] ?? trimmed;
}

function licenseList(value, field, policyPath) {
  if (!Array.isArray(value)) {
    throw new MediaKitError(`license policy ${policyPath}: "${field}" must be an array of license labels`, "LICENSE_POLICY_ERROR");
  }
  const out = [];
  for (const v of value) {
    if (typeof v !== "string" || !v.trim()) {
      throw new MediaKitError(`license policy ${policyPath}: "${field}" entries must be non-empty strings`, "LICENSE_POLICY_ERROR");
    }
    const c = canonicalLicense(v);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// Resolve the effective policy: explicit file > MEDIAKIT_LICENSE_POLICY
// env > the permissive default (gate off, record only). A set but
// unreadable / malformed policy file is a config error, not a silent
// fallback to permissive — a gate that fails open on a typo would be
// worse than no gate.
export async function loadLicensePolicy(policyFile = null) {
  const raw = typeof policyFile === "string" && policyFile.trim()
    ? policyFile.trim()
    : (typeof process.env[LICENSE_POLICY_ENV] === "string" ? process.env[LICENSE_POLICY_ENV].trim() : "");
  if (!raw) return { allow: null, deny: [], require_license: false, source: "default" };
  let doc;
  try {
    doc = JSON.parse(await readFile(raw, "utf8"));
  } catch (e) {
    throw new MediaKitError(`license policy file ${raw} cannot be read: ${e.message}`, "LICENSE_POLICY_ERROR");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new MediaKitError(`license policy ${raw} must be a JSON object {allow?, deny?, require_license?}`, "LICENSE_POLICY_ERROR");
  }
  const allow = doc.allow === undefined || doc.allow === null ? null : licenseList(doc.allow, "allow", raw);
  const deny = doc.deny === undefined || doc.deny === null ? [] : licenseList(doc.deny, "deny", raw);
  const requireLicense = doc.require_license === undefined ? false : doc.require_license;
  if (typeof requireLicense !== "boolean") {
    throw new MediaKitError(`license policy ${raw}: "require_license" must be true or false`, "LICENSE_POLICY_ERROR");
  }
  return { allow, deny, require_license: requireLicense, source: `file:${raw}` };
}

// The gate itself: deny wins over allow, allow is an exact match on
// the canonical label ("CC-BY 4.0" is NOT "CC-BY" — declare the exact
// label the policy lists). Returns the verdict for the result /
// provenance record; throws LICENSE_DENIED before any fetch.
function checkLicenseGate(label, policy) {
  if (policy.deny.includes(label)) {
    throw new MediaKitError(`download refused by license policy (${policy.source}): license "${label}" is in the deny list`, "LICENSE_DENIED");
  }
  if (policy.allow !== null && !policy.allow.includes(label)) {
    throw new MediaKitError(`download refused by license policy (${policy.source}): license "${label}" is not in the allow list [${policy.allow.join(", ")}]`, "LICENSE_DENIED");
  }
  if (policy.require_license && label === "unknown") {
    throw new MediaKitError(`download refused by license policy (${policy.source}): no license was declared and the policy requires one — pass --license <label>`, "LICENSE_DENIED");
  }
  return { label, policy_source: policy.source, decision: "allowed" };
}

function parseRetryAfterMs(res) {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return null;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, DOWNLOAD_RETRY_AFTER_MAX_S) * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, Math.min((when - Date.now()) / 1000, DOWNLOAD_RETRY_AFTER_MAX_S)) * 1000;
  return null;
}

function downloadBackoffMs(retryIndex, retryAfterMs) {
  if (retryAfterMs !== null && retryAfterMs !== undefined) return retryAfterMs;
  return Math.min(DOWNLOAD_BACKOFF_BASE_MS * 2 ** retryIndex, DOWNLOAD_BACKOFF_MAX_MS);
}

function retryableDownloadError(message, retryAfterMs = null) {
  const err = new MediaKitError(message, "DOWNLOAD_FAILED");
  err.retryable = true;
  if (retryAfterMs !== null) err.retryAfterMs = retryAfterMs;
  return err;
}

// Probe a downloaded file, write its provenance record, and return
// the result tail shared by the direct, playlist and cache-hit
// paths. A file that fails the probe is deleted and reported, never
// left on disk as a success.
async function probeAndRecordDownload({ outPath, url, finalUrl, redirects, contentType, playlist, maxBytes, cacheInfo = null, license = null, policy = null }) {
  const info = await fileInfo(outPath);
  let media;
  try {
    media = await probe(outPath);
  } catch {
    await unlink(outPath).catch(() => {});
    throw new MediaKitError("downloaded file is not media (ffprobe could not read it) — deleted", "DOWNLOAD_FAILED");
  }
  if (!media.video && !media.audio) {
    await unlink(outPath).catch(() => {});
    throw new MediaKitError("downloaded file has no video or audio stream — deleted", "DOWNLOAD_FAILED");
  }
  const provenance = await writeDownloadProvenance({
    outPath, url, finalUrl, redirects,
    contentType: contentType || null, playlist, media, sizeBytes: info.size_bytes, cache: cacheInfo,
    license, policy,
  });
  return {
    operation: "download",
    url,
    final_url: finalUrl,
    redirects,
    output: outPath,
    provenance,
    ...(license ? { license: { label: license, policy_source: policy?.source ?? "default", decision: "allowed" } } : {}),
    size_bytes: info.size_bytes,
    size_human: info.size_human,
    content_type: contentType || null,
    max_size_bytes: maxBytes,
    media: {
      format: media.format,
      duration_seconds: media.duration_seconds,
      video: media.video,
      audio: media.audio,
    },
  };
}

export async function downloadMedia({ url, output, maxSizeMb = DOWNLOAD_DEFAULT_MAX_MB, timeoutSeconds = DOWNLOAD_DEFAULT_TIMEOUT_S, cache = false, maxRetries = DOWNLOAD_DEFAULT_MAX_RETRIES, rateLimitRps = null, cacheDir = null, license = null, licensePolicyFile = null }) {
  if (typeof url !== "string" || !url.trim()) {
    throw new MediaKitError("download needs a URL", "INVALID_ARG");
  }
  let u;
  try { u = new URL(url.trim()); } catch {
    throw new MediaKitError(`download needs a valid URL, got: ${url}`, "INVALID_ARG");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new MediaKitError(`download needs an http(s) URL, got protocol ${u.protocol}`, "INVALID_ARG");
  }
  if (u.username || u.password) {
    throw new MediaKitError("download refuses URLs with embedded credentials — use a signed URL (query parameters) instead", "INVALID_ARG");
  }
  // License gate FIRST: before the cache lookup, before any fetch —
  // a refused license costs zero bytes and zero server hits. The
  // policy file is loaded here (not at import) so a per-call
  // --license-policy-file and the MEDIAKIT_LICENSE_POLICY env both
  // apply, and a broken policy file fails the call, never the import.
  const licenseLabel = canonicalLicense(license);
  const licensePolicy = await loadLicensePolicy(licensePolicyFile);
  checkLicenseGate(licenseLabel, licensePolicy);
  const urlExt = path.extname(u.pathname).slice(1).toLowerCase();
  const maxMb = num(maxSizeMb, "max_size_mb", { min: 0.01, max: 2000 });
  const maxBytes = Math.floor(maxMb * 1024 * 1024);
  const timeoutS = num(timeoutSeconds, "timeout_seconds", { min: 1, max: 3600, integer: true });
  if (typeof cache !== "boolean") {
    throw new MediaKitError(`download cache must be true or false, got: ${cache}`, "INVALID_ARG");
  }
  const retriesMax = num(maxRetries, "max_retries", { min: 0, max: DOWNLOAD_MAX_RETRIES, integer: true });
  const rps = rateLimitRps === null || rateLimitRps === undefined
    ? downloadEnvRps()
    : num(rateLimitRps, "rate_limit_rps", { min: 0, max: 1000 });
  const cacheRoot = downloadCacheDir(cacheDir);
  if (typeof output !== "string" || !output.trim()) {
    throw new MediaKitError("download needs an output path", "INVALID_ARG");
  }
  const requestedExt = path.extname(output).slice(1).toLowerCase();
  if (requestedExt && !DOWNLOAD_EXTENSIONS.includes(requestedExt)) {
    throw new MediaKitError(`download writes a media file (${DOWNLOAD_EXTENSIONS.join(", ")}) — got .${requestedExt}`, "INVALID_ARG");
  }
  // A playlist is not a file: hand it to the ffmpeg fetcher, which
  // re-muxes the segments with -c copy under the same timeout.
  if (urlExt === "m3u8" || urlExt === "mpd") {
    if (cache) {
      throw new MediaKitError("download --cache does not cache playlists yet (a playlist's segments change under the same URL) — re-run without --cache", "INVALID_ARG");
    }
    const rateWaitMs = await acquireDownloadToken(rps);
    const pl = await downloadPlaylistMedia({ url: url.trim(), urlExt, output, maxBytes, maxMb, timeoutS, requestedExt, maxRetries: retriesMax, license: licenseLabel, policy: licensePolicy });
    return { ...pl, cached: false, cache_age_seconds: null, cache_stored: null, rate_limited_wait_ms: rateWaitMs };
  }
  // Cache lookup first: a hit serves no network at all (and takes no
  // rate-limit token). The entry is trusted only after size + sha256
  // match the meta — a corrupt entry is a miss, never served.
  const cacheKey = downloadCacheKey(url.trim());
  const cachedEntry = cache ? await readDownloadCacheEntry(cacheRoot, cacheKey, url.trim()) : null;
  const rateWaitMs = await acquireDownloadToken(rps);
  if (cachedEntry) {
    const contentType = cachedEntry.meta.content_type;
    const typeCategory = (contentType ?? "").startsWith("video/") ? "video"
      : (contentType ?? "").startsWith("audio/") ? "audio"
      : (contentType ?? "").startsWith("image/") ? "image" : null;
    const ext = requestedExt || cachedEntry.meta.ext;
    if (!ext) {
      throw new MediaKitError("download cache entry has no extension — re-fetch without --cache", "DOWNLOAD_FAILED");
    }
    if (typeCategory && DOWNLOAD_MEDIA_CATEGORY[ext] !== typeCategory) {
      throw new MediaKitError(`download refuses: content-type ${contentType} is ${typeCategory} but the output extension .${ext} is ${DOWNLOAD_MEDIA_CATEGORY[ext]}`, "DOWNLOAD_FAILED");
    }
    const finalOutput = requestedExt ? output : `${output}.${ext}`;
    const outPath = await prepareOutput(finalOutput);
    const partialPath = `${outPath}.partial`;
    await copyFile(cachedEntry.filePath, partialPath);
    await rename(partialPath, outPath);
    const base = await probeAndRecordDownload({
      outPath, url: url.trim(), finalUrl: cachedEntry.meta.final_url, redirects: cachedEntry.meta.redirects ?? null,
      contentType: contentType || null, playlist: null, maxBytes,
      cacheInfo: { hit: true, stored_at: cachedEntry.meta.stored_at },
      license: licenseLabel, policy: licensePolicy,
    });
    return {
      ...base,
      cached: true,
      cache_age_seconds: Math.max(0, Math.round((Date.now() - Date.parse(cachedEntry.meta.stored_at)) / 1000)),
      cache_stored: null, attempts: 0, retries: 0, retry_wait_ms: 0, rate_limited_wait_ms: rateWaitMs,
    };
  }
  // Fresh fetch, with retries on transient failures only. Each
  // attempt gets its own timeout budget (timeout_seconds is per
  // attempt, not for the whole retry loop) — a slow server that
  // times out is not retried, a 503 that recovers is.
  let attempts = 0, retries = 0, retryWaitMs = 0;
  let fetched = null;
  for (let attempt = 0; attempt <= retriesMax; attempt++) {
    attempts++;
    try {
      fetched = await fetchDirectOnce({ u, output, requestedExt, maxBytes, maxMb, timeoutS });
      break;
    } catch (err) {
      if (attempt >= retriesMax || !err?.retryable) {
        if (retries > 0) throw new MediaKitError(`${err.message} (after ${attempts} attempts)`, err.code ?? "DOWNLOAD_FAILED");
        throw err;
      }
      const waitMs = downloadBackoffMs(attempt, err.retryAfterMs ?? null);
      retries++;
      retryWaitMs += waitMs;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  // Store the fresh bytes under the URL key for the next run.
  // Best effort: a cache that cannot be written must not fail a
  // download that already succeeded.
  let cacheStored = null;
  if (cache) {
    cacheStored = await storeDownloadCacheEntry(cacheRoot, cacheKey, {
      url: url.trim(), finalUrl: fetched.finalUrl, contentType: fetched.contentType,
      ext: fetched.ext, redirects: fetched.redirects, filePath: fetched.outPath,
    });
  }
  const base = await probeAndRecordDownload({
    outPath: fetched.outPath, url: url.trim(), finalUrl: fetched.finalUrl, redirects: fetched.redirects,
    contentType: fetched.contentType, playlist: null, maxBytes,
    cacheInfo: cache ? { hit: false, stored: cacheStored } : null,
    license: licenseLabel, policy: licensePolicy,
  });
  return {
    ...base,
    cached: false, cache_age_seconds: null, cache_stored: cacheStored,
    attempts, retries, retry_wait_ms: retryWaitMs, rate_limited_wait_ms: rateWaitMs,
  };
}

// One direct-file fetch attempt: the old downloadMedia body, with
// each failure classified retryable or not at the throw site.
// Returns the written file plus what the server said about it; the
// probe + provenance happen in the caller, outside the retry loop
// (a file whose bytes fail the probe is deterministic, not transient).
async function fetchDirectOnce({ u, output, requestedExt, maxBytes, maxMb, timeoutS }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutS * 1000);
  try {
    // Manual redirect loop: fetch's built-in follow does not cap the
    // count, and a redirect off http(s) must be refused, not followed.
    let current = u;
    let res = null;
    let redirects = 0;
    for (;;) {
      let attempt;
      try {
        attempt = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": `mediakit-for-agents/${MEDIAKIT_VERSION}` },
        });
      } catch (err) {
        if (err?.name === "AbortError") throw new MediaKitError(`download timed out after ${timeoutS}s`, "DOWNLOAD_TIMEOUT");
        throw retryableDownloadError(`download failed: ${err?.message ?? err}`);
      }
      if ([301, 302, 303, 307, 308].includes(attempt.status)) {
        const loc = attempt.headers.get("location");
        if (!loc) throw new MediaKitError(`download failed: redirect (${attempt.status}) without a location`, "DOWNLOAD_FAILED");
        if (redirects >= DOWNLOAD_MAX_REDIRECTS) throw new MediaKitError(`download failed: too many redirects (max ${DOWNLOAD_MAX_REDIRECTS})`, "DOWNLOAD_FAILED");
        let next;
        try { next = new URL(loc, current); } catch {
          throw new MediaKitError(`download failed: bad redirect location: ${loc}`, "DOWNLOAD_FAILED");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new MediaKitError(`download refuses a redirect to a non-http(s) URL: ${next.protocol}`, "DOWNLOAD_FAILED");
        }
        current = next;
        redirects++;
        continue;
      }
      res = attempt;
      break;
    }
    if (!res.ok) {
      if (DOWNLOAD_RETRYABLE_STATUS.has(res.status)) {
        throw retryableDownloadError(
          `download failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
          parseRetryAfterMs(res),
        );
      }
      throw new MediaKitError(`download failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`, "DOWNLOAD_FAILED");
    }
    if (!res.body) throw new MediaKitError("download failed: empty response body", "DOWNLOAD_FAILED");
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const typeCategory = contentType.startsWith("video/") ? "video"
      : contentType.startsWith("audio/") ? "audio"
      : contentType.startsWith("image/") ? "image" : null;
    if (!typeCategory && contentType !== "application/octet-stream" && contentType !== "") {
      throw new MediaKitError(`download refuses content-type ${contentType || "(missing)"} — not media`, "DOWNLOAD_FAILED");
    }
    const lengthHeader = res.headers.get("content-length");
    if (lengthHeader !== null) {
      const declared = Number(lengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new MediaKitError(`download refused: Content-Length ${declared} bytes exceeds max_size_mb ${maxMb} (${maxBytes} bytes)`, "SIZE_LIMIT");
      }
    }
    // Final extension: the caller's wins when given; otherwise the
    // Content-Type, then the URL path.
    const urlExt = path.extname(u.pathname).slice(1).toLowerCase();
    let ext = requestedExt;
    if (!ext) ext = DOWNLOAD_CONTENT_TYPE_EXT[contentType] ?? (DOWNLOAD_EXTENSIONS.includes(urlExt) ? urlExt : "");
    if (!ext) {
      throw new MediaKitError(`download cannot determine a media extension from content-type ${contentType || "(missing)"} or the URL — give the output a media extension`, "INVALID_ARG");
    }
    if (typeCategory && DOWNLOAD_MEDIA_CATEGORY[ext] !== typeCategory) {
      throw new MediaKitError(`download refuses: content-type ${contentType} is ${typeCategory} but the output extension .${ext} is ${DOWNLOAD_MEDIA_CATEGORY[ext]}`, "DOWNLOAD_FAILED");
    }
    const finalOutput = requestedExt ? output : `${output}.${ext}`;
    const outPath = await prepareOutput(finalOutput);
    const partialPath = `${outPath}.partial`;
    let bytes = 0;
    try {
      const counting = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            cb(new MediaKitError(`download stopped: exceeded max_size_mb ${maxMb} (${maxBytes} bytes) while streaming`, "SIZE_LIMIT"));
            return;
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counting, createWriteStream(partialPath));
    } catch (err) {
      await unlink(partialPath).catch(() => {});
      if (err instanceof MediaKitError) throw err;
      if (err?.name === "AbortError") throw new MediaKitError(`download timed out after ${timeoutS}s`, "DOWNLOAD_TIMEOUT");
      throw retryableDownloadError(`download failed while streaming: ${err?.message ?? err}`);
    }
    await rename(partialPath, outPath);
    return { outPath, finalUrl: current.href, redirects, contentType, ext };
  } finally {
    clearTimeout(timeoutId);
  }
}

// A playlist is fetched by ffmpeg, not by Node fetch: only ffmpeg
// knows how to walk segments. The output must be a video/audio
// container — an image extension makes no sense for a stream — and
// defaults to .mp4 when the caller gave no extension. The protocol
// whitelist is the guard that matters here: a playlist is attacker-
// controlled text, and without it a segment URI of file:///etc/...
// would be read straight off disk. The size cap cannot be enforced
// while streaming (a playlist's total size is unknowable until the
// last segment arrives), so it is enforced after the fetch instead:
// an over-cap file is deleted and reported, never left as a success.
const DOWNLOAD_PLAYLIST_CONTAINER_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mp3", "m4a", "wav", "flac", "ogg", "opus"];

async function downloadPlaylistMedia({ url, urlExt, output, maxBytes, maxMb, timeoutS, requestedExt, maxRetries = DOWNLOAD_DEFAULT_MAX_RETRIES, license = null, policy = null }) {
  const ext = requestedExt || "mp4";
  if (!DOWNLOAD_PLAYLIST_CONTAINER_EXTS.includes(ext)) {
    throw new MediaKitError(`download refuses: an HLS/DASH playlist (.${urlExt}) can only be written to a video/audio container (${DOWNLOAD_PLAYLIST_CONTAINER_EXTS.join(", ")}) — got .${ext}`, "INVALID_ARG");
  }
  const finalOutput = requestedExt ? output : `${output}.${ext}`;
  const outPath = await prepareOutput(finalOutput);
  const partialPath = `${outPath}.partial`;
  // The .partial suffix hides the real extension from ffmpeg, so
  // the muxer format is named explicitly (mp4/mov/m4v share the
  // mp4 muxer; m4a is mp4 audio-only).
  const PLAYLIST_FORMAT = {
    mp4: "mp4", mov: "mov", m4v: "mp4", mkv: "matroska", webm: "webm", avi: "avi",
    mp3: "mp3", m4a: "mp4", wav: "wav", flac: "flac", ogg: "ogg", opus: "opus",
  };
  const args = [
    "-hide_banner", "-nostdin", "-y",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "2",
    "-protocol_whitelist", "http,https,tcp,tls,crypto",
    "-i", url, "-c", "copy",
    ...(["mp4", "mov", "m4v"].includes(ext) ? ["-movflags", "+faststart"] : []),
    "-f", PLAYLIST_FORMAT[ext], partialPath,
  ];
  // The ffmpeg fetch itself is retried on failure (a 503 on the
  // playlist is transient; the post-fetch cap below is not — it is a
  // deterministic refusal). Timeouts are never retried.
  let attempts = 0, retries = 0, retryWaitMs = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    try {
      await run(FFMPEG, args, { timeoutMs: timeoutS * 1000 });
      break;
    } catch (err) {
      await unlink(partialPath).catch(() => {});
      if (err instanceof MediaKitError && /timed out/i.test(err.message)) {
        throw new MediaKitError(`download timed out after ${timeoutS}s`, "DOWNLOAD_TIMEOUT");
      }
      if (attempt >= maxRetries) {
        if (retries > 0 && err instanceof MediaKitError) throw new MediaKitError(`download failed fetching the playlist: ${err.message} (after ${attempts} attempts)`, "DOWNLOAD_FAILED");
        if (err instanceof MediaKitError) throw new MediaKitError(`download failed fetching the playlist: ${err.message}`, "DOWNLOAD_FAILED");
        throw err;
      }
      const waitMs = downloadBackoffMs(attempt, null);
      retries++;
      retryWaitMs += waitMs;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  // Post-fetch cap: the only place it can bite for a playlist.
  const fetched = await fileInfo(partialPath).catch(() => null);
  if (fetched && fetched.size_bytes > maxBytes) {
    await unlink(partialPath).catch(() => {});
    throw new MediaKitError(`download stopped: HLS/DASH output ${fetched.size_bytes} bytes exceeds max_size_mb ${maxMb} (${maxBytes} bytes) — a playlist's size cannot be capped while streaming, so the file was deleted after the fetch`, "SIZE_LIMIT");
  }
  await rename(partialPath, outPath);
  const base = await probeAndRecordDownload({
    outPath, url, finalUrl: url, redirects: null,
    contentType: null, playlist: urlExt, maxBytes,
    license, policy,
  });
  return { ...base, playlist: urlExt, attempts, retries, retry_wait_ms: retryWaitMs };
}

// Provenance by design (edigeh/broll-mcp's rule, turn 65): every
// successful download writes a provenance record next to the file, so
// a clip never exists without its record. The record holds what the
// server actually stated — URL, final URL, redirects, content-type,
// SHA-256, sizes, versions — and the license is the CALLER's
// declaration (or "unknown" when none was given): a license is never
// guessed from a filename or a domain. commercial_use stays "unknown"
// even for a permissive label — the declaration is unverified, and
// only the source can confirm it. The policy verdict is recorded
// alongside, so a later reader can tell whether a gate was even on.
// Check the source before publishing.
async function writeDownloadProvenance({ outPath, url, finalUrl, redirects, contentType, playlist, media, sizeBytes, cache = null, license = null, policy = null }) {
  const sha256 = createHash("sha256").update(await readFile(outPath)).digest("hex");
  const label = license ?? "unknown";
  const record = {
    schema: "mediakit-for-agents/provenance/1",
    file: path.basename(outPath),
    sha256,
    size_bytes: sizeBytes,
    source: { url, final_url: finalUrl, redirects, content_type: contentType, playlist: playlist ?? null },
    ...(cache ? { cache } : {}),
    license: {
      label,
      commercial_use: "unknown",
      note: label === "unknown"
        ? "No license was published with this download — check the source before publishing."
        : `License declared by the caller as "${label}" — verify it against the source before publishing.`,
    },
    license_policy: {
      source: policy?.source ?? "default",
      allow: policy?.allow ?? null,
      deny: policy?.deny ?? [],
      require_license: policy?.require_license ?? false,
      decision: "allowed",
    },
    retrieved_at: new Date().toISOString(),
    mediakit_version: MEDIAKIT_VERSION,
    ffmpeg_version: await ffmpegVersionString(),
    media: { format: media.format, duration_seconds: media.duration_seconds, video: media.video ?? null, audio: media.audio ?? null },
  };
  const provPath = `${outPath}.provenance.json`;
  await writeFile(provPath, JSON.stringify(record, null, 2), "utf8");
  return provPath;
}

// ---------------------------------------------------------------- slideshow
// Many still images -> one video with a transition between every pair
// (the TravnikovDev/ffmpegSlideshow + Twinklebear/ffmpeg-slideshow-py
// idea — MediaKit's image_to_video only does one image, and concat's
// --transition only joins videos). Two stages, exactly the lesson
// from ffmpeg-slideshow-py: image -> video is slow inside one big
// filter graph, so each image is first rendered to a short clip
// (image_to_video, up to 4 in parallel), then the clips are joined
// with concat's xfade chain. Semantics follow Twinklebear: each
// image is VISIBLE for its duration — the internal clip is
// duration + its OUTGOING transition (except the last, duration), so
// the transition eats a handle, not slide time, and the total is exactly
// the sum of the durations. One transition type/duration for all joins
// (transition / transitionDuration), or a different one per join
// (transitions / transitionDurations, one entry per join).
// sum(durations). One transition type for all pairs in v1 (a per-pair
// list is a follow-up — concat's xfade chain takes one type). Output
// is .mp4 only in v1: the concat transition path appends
// -movflags +faststart, which belongs to the mp4 muxer. --audio loops
// a bed under the whole slideshow (a short bed loops, a long one is
// cut by -t to the total).
function parseSlideshowImage(spec, idx) {
  if (typeof spec === "string") return { file: spec, duration: null };
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    if (typeof spec.file !== "string" || !spec.file) {
      throw new MediaKitError(`slideshow image ${idx} needs a file path`, "INVALID_ARG");
    }
    return {
      file: spec.file,
      duration: spec.duration === null || spec.duration === undefined ? null : parseTime(spec.duration, `image ${idx} duration`),
    };
  }
  throw new MediaKitError(`slideshow image ${idx} must be a file path or {file, duration}`, "INVALID_ARG");
}

// Plain file paths out of a slideshow images array (strings, or
// {file, duration} objects) — for cache keys and manifest
// resolution, which need the files, not the per-slide durations.
function slideshowImageFiles(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const s of images) {
    if (typeof s === "string") out.push(s);
    else if (s && typeof s === "object" && typeof s.file === "string") out.push(s.file);
  }
  return out;
}

/** Run async tasks with at most `limit` in flight; results in order. */
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function slideshow({ images, output, duration = 3, durations = null, transition = "fade", transitionDuration = 1, transitions = null, transitionDurations = null, fps = 30, width = 1280, height = 720, audio = null, crf = 23 }) {
  if (!Array.isArray(images) || images.length < 2) {
    throw new MediaKitError("slideshow needs at least 2 images", "INVALID_ARG");
  }
  if (images.length > 32) {
    throw new MediaKitError(`slideshow takes at most 32 images, got ${images.length}`, "INVALID_ARG");
  }
  const slides = images.map((s, i) => parseSlideshowImage(s, i + 1));
  const inPaths = [];
  for (const s of slides) inPaths.push(await requireInput(s.file, "slideshow image"));
  const outPath = await prepareOutput(output, inPaths);
  const ext = path.extname(outPath).slice(1).toLowerCase();
  if (ext !== "mp4") {
    throw new MediaKitError(`slideshow writes .mp4 only in v1 (the join path uses mp4 faststart flags) — got .${ext || "(no extension)"}`, "INVALID_ARG");
  }
  const defaultDur = num(duration, "duration", { min: 0.5, max: 600 });
  let perSlide = null;
  if (durations !== null && durations !== undefined) {
    if (!Array.isArray(durations) || durations.length !== slides.length) {
      throw new MediaKitError(`slideshow durations must be an array with one entry per image (${slides.length}), got ${Array.isArray(durations) ? durations.length : typeof durations}`, "INVALID_ARG");
    }
    perSlide = durations.map((d, i) => num(d, `durations[${i}]`, { min: 0.5, max: 600 }));
  }
  const durs = slides.map((s, i) => (s.duration !== null ? num(s.duration, `image ${i + 1} duration`, { min: 0.5, max: 600 }) : (perSlide !== null ? perSlide[i] : defaultDur)));
  const joins = slides.length - 1;
  // Per-pair transitions: one type/duration per join. The arrays win
  // over the single values when given; each name must be a known xfade
  // type, each duration must be shorter than both slides it joins, so
  // a slide is always fully visible at least briefly. The single-value
  // path keeps its original error wording (and its stricter rule:
  // shorter than the SHORTEST slide overall).
  const ts = transitions !== null && transitions !== undefined ? transitions : Array.from({ length: joins }, () => transition);
  if (!Array.isArray(ts) || ts.length !== joins) {
    throw new MediaKitError(`slideshow transitions must have one entry per join (${joins}), got ${Array.isArray(ts) ? ts.length : typeof ts}`, "INVALID_ARG");
  }
  for (const name of ts) {
    if (!XFADE_TRANSITIONS.includes(name)) {
      throw new MediaKitError(`unknown transition: ${name} (supported: ${XFADE_TRANSITIONS.join(", ")})`, "INVALID_ARG");
    }
  }
  const tds = transitionDurations !== null && transitionDurations !== undefined ? transitionDurations : Array.from({ length: joins }, () => transitionDuration);
  if (!Array.isArray(tds) || tds.length !== joins) {
    throw new MediaKitError(`slideshow transition_durations must have one entry per join (${joins}), got ${Array.isArray(tds) ? tds.length : typeof tds}`, "INVALID_ARG");
  }
  const tNums = tds.map((d, i) => num(d, `transition_durations[${i}]`, { min: 0.1, max: 10 }));
  if (transitions == null && transitionDurations == null) {
    const minDur = Math.min(...durs);
    if (tNums[0] >= minDur) {
      throw new MediaKitError(`transition_duration (${tNums[0]}s) must be shorter than the shortest slide (${minDur}s) — a slide needs to be fully visible at least briefly`, "INVALID_ARG");
    }
  } else {
    for (let i = 0; i < joins; i++) {
      if (tNums[i] >= durs[i] || tNums[i] >= durs[i + 1]) {
        throw new MediaKitError(`transition_durations[${i}] (${tNums[i]}s) must be shorter than the slides it joins (${durs[i]}s and ${durs[i + 1]}s) — a slide needs to be fully visible at least briefly`, "INVALID_ARG");
      }
    }
  }
  const f = num(fps, "fps", { min: 1, max: 120, integer: true });
  const w = num(width, "width", { min: 2, max: 7680, integer: true });
  const h = num(height, "height", { min: 2, max: 4320, integer: true });
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  // Each internal clip is duration + its OUTGOING transition (a handle
  // for the xfade) except the last slide, which is exactly its duration.
  // image_to_video caps a clip at 600s, so a long slide + handle can exceed it.
  const clipDurs = durs.map((d, i) => (i < durs.length - 1 ? d + tNums[i] : d));
  if (clipDurs.some((d) => d > 600)) {
    throw new MediaKitError(`slideshow slide duration + transition exceeds the 600s clip cap (longest clip would be ${Math.max(...clipDurs)}s)`, "INVALID_ARG");
  }
  let audioPath = null;
  if (audio !== null && audio !== undefined && audio !== "") {
    audioPath = await requireInput(audio, "audio");
    const audioMeta = await probe(audioPath);
    if (!audioMeta.audio) throw new MediaKitError(`slideshow --audio needs an audio file, got ${audio} (no audio stream)`, "INVALID_ARG");
  }
  const total = +durs.reduce((a, b) => a + b, 0).toFixed(3);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediakit-slideshow-"));
  try {
    // Stage 1: one still clip per image, up to 4 at a time
    // (ffmpeg-slideshow-py runs these in parallel for the same reason:
    // image -> video is the slow, serial part).
    const clips = await runPool(inPaths, 4, async (p, i) => {
      const clipPath = path.join(tmpDir, `slide-${String(i).padStart(3, "0")}.mp4`);
      await imageToVideo({ input: p, output: clipPath, duration: clipDurs[i], fps: f, width: w, height: h, crf: c });
      return clipPath;
    });
    // Stage 2: join with the same xfade chain concat --transition uses.
    // Its expected total is sum(clipDurs) - sum(tNums) = sum(durations).
    const joinPath = path.join(tmpDir, "joined.mp4");
    const joined = await concat({ inputs: clips, output: joinPath, transitions: ts, transitionDurations: tNums });
    if (Math.abs(joined.expected_duration_seconds - total) > 0.01) {
      throw new MediaKitError(`slideshow join total mismatch: expected ${total}s, concat reported ${joined.expected_duration_seconds}s`, "VERIFY_FAILED");
    }
    // Stage 3: loop the bed under the joined video, or move it as-is.
    if (audioPath) {
      await run(FFMPEG, [
        "-y", "-stream_loop", "-1", "-i", audioPath, "-i", joinPath,
        "-map", "1:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-t", String(total), outPath,
      ]);
    } else {
      try {
        await rename(joinPath, outPath);
      } catch {
        await copyFile(joinPath, outPath);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const frames = await countVideoFrames(outPath);
  return {
    operation: "slideshow", images: inPaths, output: outPath,
    slides: durs.map((d, i) => ({ file: inPaths[i], duration_seconds: d })),
    // transition / transition_duration keep the old shape when every
    // join is the same, and are null otherwise — transitions /
    // transition_durations always carry the full per-join list.
    transition: ts.every((x) => x === ts[0]) ? ts[0] : null,
    transition_duration: tNums.every((x) => x === tNums[0]) ? tNums[0] : null,
    transitions: ts,
    transition_durations: tNums,
    expected_duration_seconds: total,
    duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    fps: out.video?.fps ?? null, frames,
    audio: !!audioPath,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- interpolate
// Motion-interpolate a clip up to a higher frame rate
// (hyepartners-gmail/vibevideo-mcp's MotionInterpolator idea —
// minterpolate, modes dup/blend/mci). Only ever raises the frame
// rate: lowering it is fit --max-fps. mci is true motion-compensated
// interpolation and the slowest by far (measured 2026-11-12: 10s
// 720p 30→60fps took 91s mci vs 6.6s blend on this CPU); blend
// cross-fades neighbours and is the fast default, dup just repeats
// frames. The result counts frames on the output file (ffprobe
// -count_frames), so the fps is measured, not assumed — and the
// test asserts the frame count, not just r_frame_rate.
async function countVideoFrames(file) {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]);
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

const INTERPOLATE_MODES = ["mci", "blend", "dup"];

export async function interpolate({ input, output, fps, mode = "blend", crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const targetFps = num(fps, "fps", { min: 1, max: 240 });
  if (!INTERPOLATE_MODES.includes(mode)) {
    throw new MediaKitError(`unknown interpolate mode: ${mode} (supported: ${INTERPOLATE_MODES.join(", ")})`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("interpolate needs a video input", "INVALID_ARG");
  const srcFps = meta.video.fps;
  if (srcFps && targetFps <= srcFps) {
    throw new MediaKitError(`interpolate raises the frame rate: target ${targetFps}fps is not above source ${srcFps}fps (use fit --max-fps to lower it)`, "INVALID_ARG");
  }
  const framesBefore = await countVideoFrames(inPath);
  const args = ["-y", "-i", inPath, "-vf", `minterpolate=fps=${targetFps}:mi_mode=${mode}`, "-c:v", "libx264", "-crf", String(c), "-preset", "medium"];
  if (meta.audio) args.push("-c:a", "copy");
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const framesAfter = await countVideoFrames(outPath);
  return {
    operation: "interpolate", input: inPath, output: outPath,
    mode, fps_before: srcFps, fps_after: out.video ? out.video.fps : null,
    frames_before: framesBefore, frames_after: framesAfter,
    duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- denoise
// Reduce sensor noise (hyepartners-gmail/vibevideo-mcp's NoiseReducer
// idea — hqdn3d / nlmeans with a 0–1 strength). Vibevideo maps
// strength 0–1 to hqdn3d 0–10, but that scale is too weak for real
// noise: measured 2026-11-12, sigma-20 white noise on a flat
// gradient gained only +0.24 dB PSNR at hqdn3d=8, while hqdn3d=15
// gained +2.9 dB on sigma-10 noise (28.1→31.0 dB). So strength maps
// to hqdn3d 0–30 (0.5 → 15) and to nlmeans s 0–10. nlmeans is far
// slower (a 5s 720p clip did not finish in 120s on this CPU) —
// hqdn3d is the default. The result measures high-frequency noise
// energy before/after (mean |frame − gblur(frame)|, Y channel): on
// the test fixture it falls 5.49 → 3.43, and the test suite asserts
// PSNR vs the clean reference independently.
async function measureHfNoise(file, frames = 30) {
  try {
    const { stderr } = await run(FFMPEG, [
      "-hide_banner", "-nostats", "-i", file,
      "-vf", "split=2[a][b],[a]gblur=sigma=2[bl],[b][bl]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
      "-frames:v", String(frames), "-f", "null", "-",
    ]);
    const vals = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((m) => +m[1]);
    if (!vals.length) return null;
    return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
  } catch {
    return null;
  }
}

const DENOISE_FILTERS = ["hqdn3d", "nlmeans"];

export async function denoise({ input, output, filter = "hqdn3d", strength = 0.5, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const s = num(strength, "strength", { min: 0, max: 1 });
  if (!DENOISE_FILTERS.includes(filter)) {
    throw new MediaKitError(`unknown denoise filter: ${filter} (supported: ${DENOISE_FILTERS.join(", ")})`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("denoise needs a video input", "INVALID_ARG");
  // hqdn3d takes 4 strengths (luma/chroma spatial + temporal);
  // nlmeans takes s. Both scale from the single 0–1 strength.
  const value = filter === "hqdn3d" ? +(s * 30).toFixed(2) : +(s * 10).toFixed(2);
  const vf = filter === "hqdn3d"
    ? `hqdn3d=${value}:${value}:${value}:${value}`
    : `nlmeans=s=${value}`;
  const noiseBefore = await measureHfNoise(inPath);
  const args = ["-y", "-i", inPath, "-vf", vf, "-c:v", "libx264", "-crf", String(c), "-preset", "medium"];
  if (meta.audio) args.push("-c:a", "copy");
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const noiseAfter = await measureHfNoise(outPath);
  return {
    operation: "denoise", input: inPath, output: outPath,
    filter, strength: s, filter_value: value,
    noise_before: noiseBefore, noise_after: noiseAfter,
    duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    size_bytes: info.size_bytes,
  };
}

// ---------------------------------------------------------------- segment
// Cut a video into an HLS VOD playlist: index.m3u8 + .ts segments in
// an output directory, ready to serve statically or preview in a
// player (hyepartners-gmail/vibevideo-mcp's HLS segmenter idea).
// Stream-copy is the default — fast, lossless, but segments can
// only start on keyframes, so the actual segment lengths follow the
// source GOP: on the test fixture (keyframes every 8.333s) a
// --segment-time 2 copy gives 2 segments of 8.333s + 1.667s, NOT 5
// x 2s. --reencode re-encodes to libx264/aac with forced keyframes
// every segment_time seconds, so the segments land exactly on the
// requested grid (measured 2026-11-12: 5 x 2.000s). Copy mode
// refuses a non-H.264 video or non-AAC/MP3 audio up front instead
// of letting ffmpeg fail mid-mux — use --reencode for those.
// The result parses the playlist back from disk and stats every
// segment file, so the count and durations are measured, not
// assumed. Stale segments/playlist with the same prefix in the
// output dir are removed before the run so a re-run never counts
// leftovers.
const HLS_TS_AUDIO = ["aac", "mp3"];

export async function segment({ input, outputDir, segmentTime = 6, playlist = "index.m3u8", segmentPrefix = "seg", reencode = false, crf = 23 }) {
  const inPath = await requireInput(input);
  const seg = num(segmentTime, "segment_time", { min: 1, max: 60 });
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  if (typeof playlist !== "string" || !playlist.endsWith(".m3u8") || playlist.includes("/") || playlist.includes("\\") || playlist === ".m3u8") {
    throw new MediaKitError(`segment playlist must be a bare .m3u8 filename, got: ${playlist}`, "INVALID_ARG");
  }
  if (typeof segmentPrefix !== "string" || !/^[A-Za-z0-9._-]+$/.test(segmentPrefix) || segmentPrefix.startsWith(".")) {
    throw new MediaKitError(`segment prefix must be a plain filename stem (letters, digits, . _ -), got: ${segmentPrefix}`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("segment needs a video input", "INVALID_ARG");
  const mode = reencode ? "reencode" : "copy";
  if (!reencode) {
    if (meta.video.codec !== "h264") {
      throw new MediaKitError(`segment stream-copy needs H.264 video (got ${meta.video.codec}) — use --reencode to re-encode to H.264`, "INVALID_ARG");
    }
    if (meta.audio && !HLS_TS_AUDIO.includes(meta.audio.codec)) {
      throw new MediaKitError(`segment stream-copy needs AAC or MP3 audio in the .ts segments (got ${meta.audio.codec}) — use --reencode to re-encode the audio to AAC`, "INVALID_ARG");
    }
  }
  const rawDir = path.resolve(outputDir);
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new MediaKitError("output directory is required", "INVALID_OUTPUT");
  }
  if (rawDir === inPath || rawDir.startsWith(inPath + path.sep)) {
    throw new MediaKitError("segment output directory must not be inside the input file", "INVALID_OUTPUT");
  }
  const dir = await prepareOutputDir(outputDir);
  const { readdir, readFile, unlink } = await import("node:fs/promises");
  // Clear stale output from a previous run with the same prefix so
  // the segment count below never includes leftovers.
  for (const f of await readdir(dir)) {
    if ((f.startsWith(segmentPrefix) && f.endsWith(".ts")) || f === playlist) {
      await unlink(path.join(dir, f));
    }
  }
  const playlistPath = path.join(dir, playlist);
  const pattern = path.join(dir, `${segmentPrefix}%03d.ts`);
  const args = ["-y", "-i", inPath];
  if (reencode) {
    args.push("-c:v", "libx264", "-crf", String(c), "-preset", "medium",
      "-force_key_frames", `expr:gte(t,n_forced*${seg})`);
    if (meta.audio) {
      if (meta.audio.codec === "aac") args.push("-c:a", "copy");
      else args.push("-c:a", "aac", "-b:a", "128k");
    }
  } else {
    args.push("-c", "copy");
  }
  args.push("-hls_time", String(seg), "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", pattern, "-f", "hls", playlistPath);
  await run(FFMPEG, args);
  const text = await readFile(playlistPath, "utf8");
  if (!text.includes("#EXT-X-ENDLIST")) {
    throw new MediaKitError("segment playlist is missing #EXT-X-ENDLIST — the HLS mux did not finish a VOD playlist", "VERIFY_FAILED");
  }
  const lines = text.split(/\r?\n/);
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:([0-9.]+),/);
    if (!m) continue;
    const file = (lines[i + 1] || "").trim();
    if (!file) throw new MediaKitError("segment playlist has an #EXTINF line with no segment file after it", "VERIFY_FAILED");
    const info = await fileInfo(path.join(dir, file));
    segments.push({ file, duration_seconds: +parseFloat(m[1]).toFixed(3), size_bytes: info.size_bytes });
  }
  if (!segments.length) {
    throw new MediaKitError("segment playlist lists no segments", "VERIFY_FAILED");
  }
  const totalDuration = +segments.reduce((a, s) => a + s.duration_seconds, 0).toFixed(3);
  const sourceDuration = meta.duration_seconds;
  const playlistInfo = await fileInfo(playlistPath);
  const totalSize = segments.reduce((a, s) => a + s.size_bytes, 0) + playlistInfo.size_bytes;
  return {
    operation: "segment", input: inPath, output_dir: dir,
    playlist: playlistPath, playlist_name: playlist, mode,
    segment_time_seconds: seg,
    segment_count: segments.length, segments,
    total_duration_seconds: totalDuration,
    source_duration_seconds: sourceDuration,
    duration_error_seconds: sourceDuration === null ? null : +(totalDuration - sourceDuration).toFixed(3),
    dimensions: meta.video ? `${meta.video.width}x${meta.video.height}` : null,
    size_bytes: totalSize,
  };
}

// ---------------------------------------------------------------- convert

const VIDEO_CODECS = { libx264: "mp4", libx265: "mp4", vp9: "webm", av1: "mp4", mpeg4: "mp4", copy: null };

// ---------------------------------------------------------------- convert
// Change container/codec. --gop / --gop-seconds (beambuilder's
// increase_keyframes idea) set the keyframe interval on re-encode:
// -g N -keyint_min N, with scene-cut keyframes disabled for the
// codecs that support it (libx264/mpeg4: -sc_threshold 0, libx265:
// -x265-params scenecut=0), so keyframes land exactly every N
// frames — what trim --snap and stream-copy cuts need. Other codecs
// (vp9/av1) take -g only and may still insert scene-cut keyframes,
// so the GOP there is a maximum, not an exact spacing. The result
// measures the keyframes on the output file (count + gap stats), so
// the spacing is verified, not assumed.
export async function convert({ input, output, videoCodec = null, audioCodec = null, crf = 23, preset = "medium", gop = null, gopSeconds = null, dryRun = false }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  if (gop !== null && gop !== undefined && gopSeconds !== null && gopSeconds !== undefined) {
    throw new MediaKitError("convert --gop and --gop-seconds are mutually exclusive (one way to set the interval)", "INVALID_ARG");
  }
  const gopFramesReq = (gop === null || gop === undefined) ? null : num(gop, "gop", { min: 1, max: 10000, integer: true });
  const gopSecsReq = (gopSeconds === null || gopSeconds === undefined) ? null : num(gopSeconds, "gop_seconds", { min: 0.1, max: 3600 });
  const meta = gopFramesReq !== null || gopSecsReq !== null ? await probe(inPath) : null;
  let gopFrames = null;
  let gopSecondsOut = null;
  if (meta) {
    if (!meta.video) throw new MediaKitError("convert --gop needs a video input", "INVALID_ARG");
    if (!videoCodec || videoCodec === "copy") {
      throw new MediaKitError("convert --gop needs a video re-encode (pass --video-codec libx264); stream-copy cannot move keyframes", "INVALID_ARG");
    }
    if (gopFramesReq !== null) {
      gopFrames = gopFramesReq;
      gopSecondsOut = meta.video.fps ? +(gopFrames / meta.video.fps).toFixed(3) : null;
    } else {
      if (!meta.video.fps) throw new MediaKitError("convert --gop-seconds needs a source with a known frame rate", "INVALID_ARG");
      gopFrames = Math.max(1, Math.round(meta.video.fps * gopSecsReq));
      gopSecondsOut = gopSecsReq;
    }
  }
  const args = ["-y", "-i", inPath];
  if (videoCodec) {
    if (!(videoCodec in VIDEO_CODECS)) throw new MediaKitError(`unsupported video codec: ${videoCodec}`, "INVALID_ARG");
    args.push("-c:v", videoCodec);
    if (videoCodec !== "copy") {
      args.push("-crf", String(c), "-preset", preset);
      if (gopFrames !== null) {
        // -keyint_min is a libx264/libx265/mpeg4 option; libvpx/aom
        // take -g only. Scene-cut suppression is codec-specific too.
        args.push("-g", String(gopFrames));
        if (["libx264", "libx265", "mpeg4"].includes(videoCodec)) args.push("-keyint_min", String(gopFrames));
        if (["libx264", "mpeg4"].includes(videoCodec)) args.push("-sc_threshold", "0");
        if (videoCodec === "libx265") args.push("-x265-params", "scenecut=0");
      }
    }
  } else {
    args.push("-c:v", "copy");
  }
  if (audioCodec) args.push("-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
  else args.push("-c:a", "copy");
  args.push(outPath);
  if (dryRun) {
    return {
      operation: "convert", dry_run: true, input: inPath, output: outPath,
      video_codec: videoCodec ?? "copy", audio_codec: audioCodec ?? "copy",
      gop_frames: gopFrames, gop_seconds: gopSecondsOut, keyframes: null,
      commands: [formatCommand(args)],
      note: "Dry run: no file written. The keyframe spacing is measured on the real output, so it reports null here.",
    };
  }
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  let keyframes = null;
  if (gopFrames !== null) {
    // Measure the spacing on the output file — the GOP is only real
    // if the keyframes actually land where they should.
    const kf = await listKeyframes({ input: outPath });
    const gaps = kf.gop_seconds;
    keyframes = {
      count: kf.count,
      min_gap_seconds: gaps?.min_seconds ?? null,
      max_gap_seconds: gaps?.max_seconds ?? null,
      avg_gap_seconds: gaps?.avg_seconds ?? null,
    };
  }
  return {
    operation: "convert", input: inPath, output: outPath,
    video_codec: videoCodec ?? "copy", audio_codec: audioCodec ?? "copy",
    gop_frames: gopFrames, gop_seconds: gopSecondsOut, keyframes,
    ...info, duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

// ---------------------------------------------------------------- compress
// Shrink a file with one named quality preset (ffmpeg-mcp-lite's
// compress idea, rebuilt on libx264): low/medium/high map to a CRF +
// x264 preset + audio bitrate, so the agent picks a size/quality
// tradeoff instead of guessing CRF numbers. crf/preset override the
// preset's values when given. Reports the size before/after and the
// reduction actually achieved, measured on disk — never assumed.
// Audio-only input is re-encoded at the preset's audio bitrate.
const COMPRESS_PRESETS = {
  low: { crf: 32, preset: "veryfast", audio_bitrate_kbps: 96 },
  medium: { crf: 26, preset: "medium", audio_bitrate_kbps: 128 },
  high: { crf: 20, preset: "slow", audio_bitrate_kbps: 192 },
};
// email-25mb is not a CRF preset: it is shorthand for "target 18 MB"
// (25 MB Gmail attachment limit ÷ ~1.37 base64 inflation ≈ 18.2 MB,
// so the file still fits after base64 encoding). It runs the
// target-size path below, with the resolution ladder on.
const EMAIL_25MB_TARGET_MB = 18;
// Resolution ladder (0xmortuex/ffmpeg-mcp's idea): below ~0.045 bits
// per pixel per frame, x264 at the target bitrate smears detail into
// mush — a smaller frame at the same bitrate looks better than a big
// frame starved of bits. In target-size mode the ladder steps the
// frame down (1080 → 720 → 480 → 360 → 240) until the bitrate buys
// at least that many bits per pixel per frame; if even 240p is
// starved it takes 240p anyway. Only ever scales down, never up.
const LADDER_MIN_BPP = 0.045;
const LADDER_HEIGHTS = [1080, 720, 480, 360, 240];

// Quality proof for compress --target-size (halfsize's idea: SSIM at
// 3 sample points + VMAF mid-clip + a verdict in words, so the caller
// sees what the size actually cost instead of trusting the bitrate).
// VMAF is NOT in this ffmpeg build (no libvmaf filter — doctor
// reports it), so the verdict is SSIM-only and says so. SSIM is
// measured against the source scaled to the OUTPUT size, so it rates
// encode fidelity at the delivered resolution — it does NOT penalize
// the resolution ladder: a smaller frame is easier to encode, so on
// hard content a 426x240 encode scores HIGHER than the same bitrate
// at 720p (measured 2026-11-17: static-noise source, 5 MB at 720p
// SSIM 0.957 vs 0.5 MB at 240p SSIM 0.966 — the downscaled reference
// has less detail to lose). Compare `dimensions` + `bpp_after`
// across targets for the resolution tradeoff, not SSIM alone.
// Bands are SSIM-mean working figures (cross-checked against
// halfsize's VMAF bands ≥95/90/80/70): calibrated on a static-noise
// stress clip (5 MB → 0.957, 1 MB → 0.918, 0.5 MB → 0.966) and on
// smooth testsrc2 (all targets ≥0.9997, CRF 32 → 0.9966) — a verdict
// is a fidelity reading at the delivered size, not a beauty score.
const QUALITY_PROOF_VERDICTS = [
  { min: 0.99, verdict: "indistinguishable", detail: "no visible difference from the source at this size" },
  { min: 0.97, verdict: "looks_the_same", detail: "indistinguishable in normal viewing; pixel-peeping finds it" },
  { min: 0.95, verdict: "slight_softening", detail: "fine detail softens slightly; fine for sharing" },
  { min: 0.90, verdict: "visible_loss", detail: "softening and smearing are visible on close inspection" },
  { min: -Infinity, verdict: "clearly_degraded", detail: "clearly worse than the source — raise the target or accept the loss" },
];

// Measure a compressed file against its source: SSIM at 3 sample
// points (10% / 50% / 90% of duration, 1s windows) plus PSNR-Y at
// the middle point, in one ffmpeg run per point (the mid run chains
// ssim -> psnr on the same frames). Input seeking (-ss before -i)
// on both inputs lands the first compared frame at the same
// timestamp — verified by identity: source vs itself reads SSIM
// All 1.000000 at all three points. Returns { available: false,
// reason } when there is nothing to measure (no video, clip too
// short, ssim filter missing); never throws, so a proof failure
// cannot fail the compress that already succeeded.
async function measureQualityProof({ source, compressed, duration }) {
  if (!duration || duration < 0.5) {
    return { available: false, reason: `clip too short to sample (duration ${duration ?? "?"}s < 0.5s)` };
  }
  const filtersOut = await listCapabilities("filters");
  if (!new RegExp("\\bssim\\b").test(filtersOut)) {
    return { available: false, reason: "ssim filter not in this ffmpeg build (doctor reports it)" };
  }
  const outMeta = await probe(compressed);
  if (!outMeta.video) {
    return { available: false, reason: "no video stream in the compressed output" };
  }
  const { width: w, height: h } = outMeta.video;
  const win = Math.min(1, duration / 5);
  const points = [];
  for (let i = 0; i < 3; i++) {
    const t = Math.min([0.1, 0.5, 0.9][i] * duration, duration - win);
    const tStr = String(+t.toFixed(3));
    const mid = i === 1;
    // The mid run chains ssim -> psnr on the same frames; a filter
    // label can only feed ONE consumer, so the scaled reference is
    // split in two (feeding [ref] to both filters fails: the second
    // silently falls back to the raw input and psnr dies on the size
    // mismatch — caught by CLI smoke, 2026-11-17).
    const filter = mid
      ? `[0:v]scale=${w}:${h},split=2[ref1][ref2];[1:v][ref1]ssim[s];[s][ref2]psnr`
      : `[0:v]scale=${w}:${h}[ref];[1:v][ref]ssim`;
    const { stderr } = await run(FFMPEG, ["-v", "info", "-ss", tStr, "-t", String(win), "-i", source, "-ss", tStr, "-t", String(win), "-i", compressed, "-filter_complex", filter, "-an", "-f", "null", "-"]);
    const ssim = stderr.match(/SSIM Y:([0-9.]+) \([^)]*\) U:([0-9.]+) \([^)]*\) V:([0-9.]+) \([^)]*\) All:([0-9.]+)/);
    if (!ssim) throw new MediaKitError(`quality proof: no SSIM reading at t=${tStr}s (ffmpeg output changed?)`, "FFMPEG_FAILED");
    const point = { t_seconds: +tStr, ssim_y: +ssim[1], ssim_u: +ssim[2], ssim_v: +ssim[3], ssim_all: +ssim[4] };
    if (mid) {
      const psnr = stderr.match(/PSNR y:([0-9.]+) u:([0-9.]+) v:([0-9.]+) average:([0-9.]+)/);
      if (psnr) point.psnr_y_db = +psnr[1];
    }
    points.push(point);
  }
  const mean = points.reduce((a, p) => a + p.ssim_all, 0) / points.length;
  const min = Math.min(...points.map((p) => p.ssim_all));
  const band = QUALITY_PROOF_VERDICTS.find((b) => mean >= b.min);
  return {
    available: true,
    method: "ssim",
    sample_points: points,
    ssim_mean: +mean.toFixed(6),
    ssim_min: +min.toFixed(6),
    ...(points[1].psnr_y_db !== undefined ? { psnr_y_db: points[1].psnr_y_db } : {}),
    vmaf: null,
    vmaf_note: "VMAF (libvmaf) is not in this ffmpeg build — SSIM is the measured proxy",
    verdict: band.verdict,
    verdict_detail: band.detail,
    resolution_note: "SSIM is measured against the source scaled to the output size, so it rates encode fidelity at the delivered resolution — it does not penalize the resolution ladder; compare dimensions and bpp_after for that tradeoff",
  };
}

export async function compress({ input, output, quality = "medium", maxWidth = null, crf = null, preset = null, targetSizeMb = null, resolutionLadder = true, qualityProof = true }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const emailPreset = quality === "email-25mb";
  const targetMb = targetSizeMb === null || targetSizeMb === undefined ? null : num(targetSizeMb, "target_size_mb", { min: 0.05, max: 10000 });
  let effectiveTargetMb = targetMb;
  if (emailPreset) {
    if (targetMb !== null) {
      throw new MediaKitError("compress --quality email-25mb and --target-size are mutually exclusive (email-25mb already targets 18 MB)", "INVALID_ARG");
    }
    effectiveTargetMb = EMAIL_25MB_TARGET_MB;
  }
  if (effectiveTargetMb !== null && crf !== null && crf !== undefined) {
    throw new MediaKitError("compress --target-size and --crf are mutually exclusive (target size picks the bitrate itself)", "INVALID_ARG");
  }
  if (!(quality in COMPRESS_PRESETS) && !emailPreset) {
    throw new MediaKitError(`unknown quality: ${quality} (supported: ${Object.keys(COMPRESS_PRESETS).join(", ")}, email-25mb)`, "INVALID_ARG");
  }
  const settings = COMPRESS_PRESETS[quality] ?? COMPRESS_PRESETS.medium;
  const X264_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
  const p = preset ?? settings.preset;
  if (!X264_PRESETS.includes(p)) throw new MediaKitError(`unknown x264 preset: ${p} (supported: ${X264_PRESETS.join(", ")})`, "INVALID_ARG");
  const maxW = maxWidth === null || maxWidth === undefined ? null : num(maxWidth, "max_width", { min: 16, integer: true });
  const meta = await probe(inPath);
  const before = await fileInfo(inPath);
  let scaledTo = null;
  let scaleFilter = null;
  if (meta.video && maxW !== null && meta.video.width > maxW) {
    const w = maxW % 2 === 0 ? maxW : maxW - 1;
    const h = Math.max(2, Math.round((meta.video.height * w) / meta.video.width / 2) * 2);
    scaleFilter = `scale=${w}:${h}`;
    scaledTo = `${w}x${h}`;
  }

  if (effectiveTargetMb !== null) {
    // Target-size mode (Ashutos1997/ffmpeg-mcp-server's compress_video
    // targetSizeMB idea, rebuilt as two-pass ABR): the bitrate budget
    // comes from the size + duration, not from a CRF. A 10% safety
    // margin absorbs container overhead AND two-pass ABR overshoot:
    // measured 2026-11-13, downscaled testsrc overshoots its video
    // bitrate by +6.5–8.4% at 480p (400k→426k, 656k→705k, 1000k→
    // 1084k) while the same content at 720p lands within 0.2% — the
    // old 2% margin let the 1 MB ladder case land at 1,015,839 bytes
    // (target_met false). quality/crf are ignored in this mode — the
    // result says so (mode: target_size).
    const duration = meta.duration_seconds;
    if (!duration || duration <= 0) {
      throw new MediaKitError("compress --target-size needs a file with a known duration", "INVALID_ARG");
    }
    const targetBytes = Math.floor(effectiveTargetMb * 1_000_000); // decimal MB, like Discord's 10 MB / 25 MB limits
    const budgetBytes = Math.floor(targetBytes * 0.90);
    const totalKbps = (budgetBytes * 8) / duration / 1000;
    const MIN_VIDEO_KBPS = 100;
    const MIN_AUDIO_KBPS = 32;
    let audioKbps;
    let videoKbps = null;
    if (meta.video) {
      audioKbps = meta.audio ? 128 : 0;
      videoKbps = Math.floor(totalKbps - audioKbps);
      if (videoKbps < MIN_VIDEO_KBPS) {
        const minMb = (((MIN_VIDEO_KBPS + audioKbps) * 1000 * duration) / 8 / 0.90 / 1_000_000).toFixed(2);
        throw new MediaKitError(`target ${effectiveTargetMb} MB is too small for ${duration}s — minimum is about ${minMb} MB (${MIN_VIDEO_KBPS} kbps video + ${audioKbps} kbps audio)`, "INVALID_ARG");
      }
    } else if (meta.audio) {
      audioKbps = Math.floor(totalKbps);
      if (audioKbps < MIN_AUDIO_KBPS) {
        const minMb = ((MIN_AUDIO_KBPS * 1000 * duration) / 8 / 0.90 / 1_000_000).toFixed(2);
        throw new MediaKitError(`target ${effectiveTargetMb} MB is too small for ${duration}s of audio — minimum is about ${minMb} MB (${MIN_AUDIO_KBPS} kbps audio)`, "INVALID_ARG");
      }
    } else {
      throw new MediaKitError("compress needs a video or audio stream", "INVALID_ARG");
    }
    // Resolution ladder: measure bits per pixel per frame at the
    // budgeted bitrate and step the frame down until the bitrate can
    // actually buy detail (see LADDER_MIN_BPP). The bpp numbers are
    // measured whether the ladder runs or not — they are the
    // diagnosis; only the stepping down is gated by the flag. Starts
    // from the --max-width dimensions when one already scaled the frame.
    let ladderApplied = false;
    let bppBefore = null;
    let bppAfter = null;
    if (meta.video) {
      const fps = meta.video.fps;
      let effW = meta.video.width;
      let effH = meta.video.height;
      if (scaledTo) [effW, effH] = scaledTo.split("x").map(Number);
      if (fps && fps > 0) {
        const bppAt = (w, h) => (videoKbps * 1000) / (w * h * fps);
        bppBefore = +bppAt(effW, effH).toFixed(4);
        bppAfter = bppBefore;
        if (bppBefore < LADDER_MIN_BPP && resolutionLadder !== false) {
          for (const h of LADDER_HEIGHTS) {
            if (h >= effH) continue;
            const w = Math.max(2, Math.round((effW * h) / effH / 2) * 2);
            if (bppAt(w, h) >= LADDER_MIN_BPP) {
              scaleFilter = `scale=${w}:${h}`;
              scaledTo = `${w}x${h}`;
              ladderApplied = true;
              break;
            }
          }
          if (!ladderApplied && LADDER_HEIGHTS[LADDER_HEIGHTS.length - 1] < effH) {
            const h = LADDER_HEIGHTS[LADDER_HEIGHTS.length - 1];
            const w = Math.max(2, Math.round((effW * h) / effH / 2) * 2);
            scaleFilter = `scale=${w}:${h}`;
            scaledTo = `${w}x${h}`;
            ladderApplied = true;
          }
          if (ladderApplied) {
            const [lw, lh] = scaledTo.split("x").map(Number);
            bppAfter = +bppAt(lw, lh).toFixed(4);
          }
        }
      }
    }
    let passes = 1;
    if (meta.video) {
      // Two-pass libx264: pass 1 analyses (no output file), pass 2
      // encodes to the bitrate budget. The passlog lives in a temp
      // dir that is always cleaned up afterwards. Pass 1 MUST encode
      // the audio too (to -f null): ffmpeg >= 8.1 applies `-pass 2`
      // to the AAC encoder as well, and it fails reading
      // `<passlogfile>-1.log` when pass 1 ran with `-an` and never
      // created it (CI run #43062155627 on the BtbN master build).
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediakit-pass-"));
      const passlog = path.join(tmpDir, "pass");
      try {
        const vf = scaleFilter ? ["-vf", scaleFilter] : [];
        const vArgs = ["-c:v", "libx264", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps * 2}k`, "-bufsize", `${videoKbps * 4}k`, "-preset", p];
        const aArgs = meta.audio ? ["-c:a", "aac", "-b:a", `${audioKbps}k`] : ["-an"];
        await run(FFMPEG, ["-y", "-i", inPath, ...vf, ...vArgs, "-pass", "1", "-passlogfile", passlog, ...aArgs, "-f", "null", "-"]);
        const pass2 = ["-y", "-i", inPath, ...vf, ...vArgs, "-pass", "2", "-passlogfile", passlog];
        if (meta.audio) pass2.push("-c:a", "aac", "-b:a", `${audioKbps}k`);
        else pass2.push("-an");
        pass2.push(outPath);
        await run(FFMPEG, pass2);
        passes = 2;
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    } else {
      await run(FFMPEG, ["-y", "-i", inPath, "-vn", "-c:a", "aac", "-b:a", `${audioKbps}k`, outPath]);
    }
    const after = await fileInfo(outPath);
    const out = await probe(outPath);
    const reduction = +(((before.size_bytes - after.size_bytes) / before.size_bytes) * 100).toFixed(1);
    // Quality proof: measure what the size actually cost, on disk.
    // A proof failure must not fail the compress that already
    // succeeded — it degrades to { available: false, reason }.
    let proof = null;
    let proofNote = null;
    if (qualityProof !== false) {
      if (!out.video) {
        proofNote = "audio-only input: no video frames to compare";
      } else {
        try {
          proof = await measureQualityProof({ source: inPath, compressed: outPath, duration: out.duration_seconds });
        } catch (err) {
          proof = { available: false, reason: `measurement failed: ${err.message}` };
        }
      }
    }
    return {
      operation: "compress", input: inPath, output: outPath, mode: "target_size",
      target_size_mb: effectiveTargetMb, target_size_bytes: targetBytes,
      video_bitrate_kbps: videoKbps, audio_bitrate_kbps: audioKbps, passes,
      ...(meta.video ? {
        resolution_ladder_applied: ladderApplied,
        bpp_before: bppBefore, bpp_after: bppAfter, bpp_threshold: LADDER_MIN_BPP,
      } : {}),
      ...(emailPreset ? { quality: "email-25mb" } : {}),
      ...(scaledTo ? { scaled_to: scaledTo } : {}),
      size_before_bytes: before.size_bytes, size_before_human: before.size_human,
      size_after_bytes: after.size_bytes, size_after_human: after.size_human,
      target_met: after.size_bytes <= targetBytes,
      reduction_percent: reduction,
      duration_seconds: out.duration_seconds,
      dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
      quality_proof: proof,
      ...(proofNote ? { quality_proof_note: proofNote } : {}),
    };
  }

  const c = crf === null || crf === undefined ? settings.crf : num(crf, "crf", { min: 0, max: 51, integer: true });
  const args = ["-y", "-i", inPath];
  if (meta.video) {
    if (scaleFilter) args.push("-vf", scaleFilter);
    args.push("-c:v", "libx264", "-crf", String(c), "-preset", p);
    if (meta.audio) args.push("-c:a", "aac", "-b:a", `${settings.audio_bitrate_kbps}k`);
    else args.push("-an");
  } else if (meta.audio) {
    args.push("-c:a", "aac", "-b:a", `${settings.audio_bitrate_kbps}k`);
  } else {
    throw new MediaKitError("compress needs a video or audio stream", "INVALID_ARG");
  }
  args.push(outPath);
  await run(FFMPEG, args);
  const after = await fileInfo(outPath);
  const out = await probe(outPath);
  const reduction = +(((before.size_bytes - after.size_bytes) / before.size_bytes) * 100).toFixed(1);
  return {
    operation: "compress", input: inPath, output: outPath, mode: "quality",
    quality, crf: c, preset: p,
    ...(scaledTo ? { scaled_to: scaledTo } : {}),
    size_before_bytes: before.size_bytes, size_before_human: before.size_human,
    size_after_bytes: after.size_bytes, size_after_human: after.size_human,
    reduction_percent: reduction,
    duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

// ---------------------------------------------------------------- silence
// Remove silent stretches from speech/video. Detection runs the
// silencedetect filter; speech is kept with a margin of silence on
// each side (so words are never clipped), then the kept segments are
// cut and re-joined in one filter graph.

export async function detectSilence(input, { thresholdDb = -40, minDuration = 0.5 } = {}) {
  const inPath = await requireInput(input);
  const threshold = num(thresholdDb, "threshold_db", { min: -90, max: 0 });
  const minDur = num(minDuration, "min_duration", { min: 0.05, max: 60 });
  const meta = await probe(inPath);
  if (!meta.audio) throw new MediaKitError("silence needs an audio stream", "INVALID_ARG");
  const duration = meta.duration_seconds;
  const { stderr } = await run(FFMPEG, [
    "-i", inPath, "-vn",
    "-af", `silencedetect=noise=${threshold}dB:d=${minDur}`,
    "-f", "null", "-",
  ]);
  const silences = [];
  let open = null;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) { open = parseFloat(start[1]); continue; }
    const end = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (end && open !== null) {
      silences.push({
        start: +open.toFixed(3),
        end: +parseFloat(end[1]).toFixed(3),
        duration: +parseFloat(end[2]).toFixed(3),
      });
      open = null;
    }
  }
  // A trailing silence runs to the end of the file with no silence_end line.
  if (open !== null && duration !== null) {
    silences.push({
      start: +open.toFixed(3),
      end: +duration.toFixed(3),
      duration: +(duration - open).toFixed(3),
    });
  }
  return { input: inPath, threshold_db: threshold, min_duration: minDur, duration_seconds: duration, silences };
}

/** Complement of the silence intervals, expanded by margin, merged. */
function keptSegments(duration, silences, margin) {
  const kept = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) kept.push([cursor, s.start]);
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) kept.push([cursor, duration]);
  const expanded = kept
    .map(([a, b]) => [Math.max(0, a - margin), Math.min(duration, b + margin)])
    .filter(([a, b]) => b - a >= 0.05);
  const merged = [];
  for (const seg of expanded) {
    const last = merged[merged.length - 1];
    if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else merged.push([...seg]);
  }
  return merged.map(([a, b]) => ({
    start: +a.toFixed(3), end: +b.toFixed(3), duration: +(b - a).toFixed(3),
  }));
}

// Audio joins cut at atrim boundaries — a hard cut at a non-zero
// sample is an audible click. Every kept segment gets a 12ms fade
// out at its end and a 15ms fade in at its start (backlog, lượt 37):
// short enough to be inaudible as a fade, long enough to kill the
// step. Segments shorter than the two fades combined skip them —
// the fades would overlap and swallow the segment. cut_words builds
// the same graph shape, so it shares this helper (remove_retakes
// inherits it through cutWords).
const JOIN_FADE_IN_SECONDS = 0.015;
const JOIN_FADE_OUT_SECONDS = 0.012;
function joinFadeAudio(seg, i) {
  const dur = seg.end - seg.start;
  let chain = `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS`;
  if (dur > JOIN_FADE_IN_SECONDS + JOIN_FADE_OUT_SECONDS) {
    chain += `,afade=t=in:st=0:d=${JOIN_FADE_IN_SECONDS},afade=t=out:st=${+(dur - JOIN_FADE_OUT_SECONDS).toFixed(3)}:d=${JOIN_FADE_OUT_SECONDS}`;
  }
  return `${chain}[a${i}]`;
}

export async function silence({ input, output = null, thresholdDb = -40, minDuration = 0.5, margin = 0.2, detectOnly = false }) {
  const inPath = await requireInput(input);
  const m = num(margin, "margin", { min: 0, max: 5 });
  const det = await detectSilence(inPath, { thresholdDb, minDuration });
  const duration = det.duration_seconds;
  if (duration === null) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  const kept = keptSegments(duration, det.silences, m);
  if (kept.length === 0) {
    throw new MediaKitError("input is entirely silent — nothing to keep", "INVALID_ARG");
  }
  const keptTotal = kept.reduce((s, k) => s + k.duration, 0);
  const removed = +(duration - keptTotal).toFixed(3);
  const base = {
    operation: "silence", input: inPath,
    threshold_db: det.threshold_db, min_duration: det.min_duration, margin: m,
    duration_before: duration,
    silences: det.silences,
    kept_segments: kept,
    removed_seconds: removed,
    removed_count: det.silences.length,
  };
  if (detectOnly) return { ...base, detect_only: true };

  const outPath = await prepareOutput(output, [inPath]);
  const meta = await probe(inPath);
  if (removed < 0.05) {
    // Nothing worth cutting: copy the streams as-is.
    await run(FFMPEG, ["-y", "-i", inPath, "-c", "copy", outPath]);
    const info = await fileInfo(outPath);
    return { ...base, output: outPath, duration_after: duration, stream_copy: true, ...info };
  }

  // One filter graph: trim each kept segment (video + audio), then concat.
  const vParts = [];
  const aParts = [];
  const vLabels = [];
  const aLabels = [];
  kept.forEach((seg, i) => {
    if (meta.video) {
      vParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
      vLabels.push(`[v${i}]`);
    }
    aParts.push(joinFadeAudio(seg, i));
    aLabels.push(`[a${i}]`);
  });
  const graph = [...vParts, ...aParts];
  if (meta.video) graph.push(`${vLabels.join("")}concat=n=${kept.length}:v=1:a=0[vout]`);
  graph.push(`${aLabels.join("")}concat=n=${kept.length}:v=0:a=1[aout]`);
  const args = ["-y", "-i", inPath, "-filter_complex", graph.join(";")];
  if (meta.video) {
    args.push("-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
      "-c:a", "aac", ...audioBitrateArgs("aac"), "-movflags", "+faststart");
  } else {
    const ext = path.extname(outPath).slice(1).toLowerCase();
    const codec = AUDIO_FORMATS[ext];
    if (!codec) throw new MediaKitError(`audio-only input needs an audio output format (.mp3/.aac/.wav/.ogg/.opus/.flac), got .${ext || "(none)"}`, "INVALID_ARG");
    args.push("-map", "[aout]", "-c:a", codec, ...audioBitrateArgs(codec));
  }
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    ...base, output: outPath,
    duration_after: out.duration_seconds,
    ...info,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

// ---------------------------------------------------------------- cut_words
// Edit by transcript (transcriptcut + kevs-talking-head-editor's
// filler_cut.py, idea only — no code copied): cut filler words, false
// starts and restarts out of a talking-head clip, using word timings
// from `transcribe --word-timestamps`. Times always come from the
// transcript file — never a hand-typed timestamp (transcriptcut's
// rule) — and a cut never eats into a kept word: keep-run padding is
// clamped to the gap to the neighbouring cut word, and kept words that
// end up mostly outside the keep segments are reported, the same cut
// check filler_cut calls swallowed().
//
// Selection is by word, three ways that OR together: --remove (match
// the word text, case-insensitive, punctuation ignored — "Um," matches
// "um"), --fillers (the built-in filler set below), --indices
// ("0-5,96-98", 0-based word indices as printed by transcribe).
// --keep rescues indices even when auto-flagged. No match at all
// stream-copies the input, the same no-op path silence takes.

// filler_cut.py's FILLERS, verbatim as a set — "like" and "you know"
// are deliberately NOT in it: transcriptcut only classifies those
// ambiguous words with an LLM in context, and MediaKit has no LLM
// here, so they are cut only when named explicitly in --remove.
const CUT_WORDS_FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "mm", "mhm", "ah", "eh"]);

export function normalizeWord(w) {
  return String(w ?? "").toLowerCase().replace(/[^a-z']/g, "");
}

// "0-5,96-98,137" -> Set of 0-based indices (filler_cut's parse_idx).
// A reversed range or a negative index is a loud error, not a silent
// empty set — a typo in the cut list must never silently cut nothing.
export function parseWordIndices(spec, label = "indices") {
  const out = new Set();
  const parts = String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new MediaKitError(`cut_words ${label} is empty — give ranges like "0-5,96-98"`, "INVALID_ARG");
  for (const part of parts) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((x) => Number(x));
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || b < a) {
        throw new MediaKitError(`cut_words ${label} has a bad range "${part}" — want "start-end" with start <= end, both >= 0`, "INVALID_ARG");
      }
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0) {
        throw new MediaKitError(`cut_words ${label} has a bad index "${part}" — want a whole number >= 0`, "INVALID_ARG");
      }
      out.add(n);
    }
  }
  return out;
}

// Validate a words array from a transcript JSON (transcribe's stdout,
// or a hand-written file): [{start, end, word}], seconds or "MM:SS".
// Sorted by start; slight overlaps are tolerated (ASR token timings
// can overlap by a few ms) — overlapping cut intervals merge later.
export function normalizeTranscriptWords(raw, label = "words file") {
  const arr = Array.isArray(raw) ? raw : raw?.words;
  if (!Array.isArray(arr)) {
    throw new MediaKitError(`cut_words ${label} must be a JSON object with a "words" array (from transcribe --word-timestamps) or a bare words array, got ${typeof raw}`, "INVALID_ARG");
  }
  if (arr.length === 0) throw new MediaKitError(`cut_words ${label} has 0 words — nothing to cut from`, "INVALID_ARG");
  if (arr.length > 20000) throw new MediaKitError(`cut_words ${label} has ${arr.length} words (max 20000)`, "INVALID_ARG");
  const words = arr.map((w, i) => {
    const start = parseTime(w?.start, `word ${i} start`);
    const end = parseTime(w?.end, `word ${i} end`);
    if (!(end > start)) throw new MediaKitError(`word ${i}: end (${w?.end}) must be after start (${w?.start})`, "INVALID_ARG");
    if (typeof w?.word !== "string" || !w.word.trim() || /\s/.test(w.word.trim())) {
      throw new MediaKitError(`word ${i} in the words array must be a single non-empty token {start, end, word}, got: ${JSON.stringify(w?.word)} (a cues file with "text" instead of "word" is not a words file — run transcribe --word-timestamps)`, "INVALID_ARG");
    }
    return { start: +start.toFixed(3), end: +end.toFixed(3), word: w.word.trim() };
  });
  words.sort((a, b) => a.start - b.start);
  return words;
}

// Kept-word runs, padded and merged. A run is a maximal run of kept
// words; it is padded PRE before its first word and POST after its
// last (filler_cut: 0.06 / 0.12), but the pad is clamped to the gap to
// the neighbouring cut word, so a cut never keeps a fragment of the
// word it removed. Runs shorter than minKeep are dropped, and any
// kept word that ends up <50% inside the keep segments is reported
// as swallowed — play it before trusting the cut.
export function buildKeepSegmentsFromWords(words, cutSet, duration, { padBefore = 0.06, padAfter = 0.12, minKeep = 0.2 } = {}) {
  const runs = [];
  let cur = null;
  words.forEach((w, i) => {
    if (cutSet.has(i)) {
      if (cur) { runs.push(cur); cur = null; }
      return;
    }
    cur = cur === null ? { start: w.start, end: w.end, indices: [i] } : { start: cur.start, end: w.end, indices: [...cur.indices, i] };
  });
  if (cur) runs.push(cur);
  // Neighbour boundaries for clamping: the cut word (or file edge)
  // on each side of the run.
  const padded = runs.map((r) => {
    const firstIdx = r.indices[0];
    const lastIdx = r.indices[r.indices.length - 1];
    const leftEdge = firstIdx === 0 ? 0 : words[firstIdx - 1].end;
    const rightEdge = lastIdx === words.length - 1 ? duration : words[lastIdx + 1].start;
    const start = Math.max(0, r.start - Math.min(padBefore, Math.max(0, r.start - leftEdge)));
    const end = Math.min(duration, r.end + Math.min(padAfter, Math.max(0, rightEdge - r.end)));
    return { start: +start.toFixed(3), end: +end.toFixed(3), duration: +(end - start).toFixed(3), indices: r.indices };
  }).filter((s) => s.end - s.start >= minKeep);
  const merged = [];
  for (const seg of padded) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end) {
      last.end = Math.max(last.end, seg.end);
      last.duration = +(last.end - last.start).toFixed(3);
      last.indices.push(...seg.indices);
    } else merged.push({ ...seg, indices: [...seg.indices] });
  }
  const keep = merged.map(({ start, end, duration: d }) => ({ start, end, duration: d }));
  const swallowed = [];
  words.forEach((w, i) => {
    if (cutSet.has(i)) return;
    const cov = keep.reduce((s, k) => s + Math.max(0, Math.min(w.end, k.end) - Math.max(w.start, k.start)), 0);
    if (cov / (w.end - w.start) < 0.5) swallowed.push({ index: i, word: w.word, start: w.start });
  });
  return { keep, swallowed };
}

export async function cutWords({ input, output = null, wordsFile, remove = null, fillers = false, indices = null, keep = null, padBefore = 0.06, padAfter = 0.12, minKeep = 0.2, dryRun = false }) {
  const inPath = await requireInput(input);
  const wordsPath = await requireInput(wordsFile, "words file");
  const padB = num(padBefore, "pad_before", { min: 0, max: 1 });
  const padA = num(padAfter, "pad_after", { min: 0, max: 1 });
  const minK = num(minKeep, "min_keep", { min: 0.05, max: 5 });
  let rawWords;
  try {
    rawWords = JSON.parse(await readFile(wordsPath, "utf8"));
  } catch (e) {
    throw new MediaKitError(`cut_words could not parse the words file as JSON: ${e.message}`, "INVALID_ARG");
  }
  const words = normalizeTranscriptWords(rawWords, "words file");
  // At least one selector is required: cutting "nothing in
  // particular" is a typo, not a plan.
  if (!remove && !fillers && !indices) {
    throw new MediaKitError("cut_words needs a selector: --remove <words>, --fillers, or --indices <ranges>", "INVALID_ARG");
  }
  const cut = new Set();
  if (typeof remove === "string" && remove.trim()) {
    const targets = new Set(remove.split(",").map((s) => normalizeWord(s)).filter(Boolean));
    if (!targets.size) throw new MediaKitError('cut_words --remove has no usable words — give comma-separated single words, e.g. "um,uh"', "INVALID_ARG");
    words.forEach((w, i) => { if (targets.has(normalizeWord(w.word))) cut.add(i); });
  }
  if (fillers === true) {
    words.forEach((w, i) => { if (CUT_WORDS_FILLERS.has(normalizeWord(w.word))) cut.add(i); });
  }
  if (typeof indices === "string" && indices.trim()) {
    for (const i of parseWordIndices(indices, "--indices")) {
      if (i >= words.length) throw new MediaKitError(`cut_words --indices ${i} is out of range — the transcript has ${words.length} words (indices 0-${words.length - 1})`, "INVALID_ARG");
      cut.add(i);
    }
  }
  if (typeof keep === "string" && keep.trim()) {
    for (const i of parseWordIndices(keep, "--keep")) cut.delete(i);
  }
  const meta = await probe(inPath);
  if (!meta.audio) throw new MediaKitError("cut_words needs an input with an audio stream", "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (duration === null) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  const removedWords = [...cut].sort((a, b) => a - b).map((i) => ({ index: i, word: words[i].word, start: words[i].start, end: words[i].end }));
  const { keep: kept, swallowed } = buildKeepSegmentsFromWords(words, cut, duration, { padBefore: padB, padAfter: padA, minKeep: minK });
  const keptTotal = kept.reduce((s, k) => s + k.duration, 0);
  const base = {
    operation: "cut_words",
    input: inPath,
    words_file: wordsPath,
    words_total: words.length,
    removed_words: removedWords,
    removed_count: removedWords.length,
    keep_segments: kept,
    removed_seconds: +(duration - keptTotal).toFixed(3),
    duration_before: duration,
    pad_before: padB,
    pad_after: padA,
    min_keep: minK,
    cut_check: { swallowed, warnings: swallowed.map((s) => `kept word #${s.index} '${s.word}' @${s.start}s is mostly cut out — play it, then pass --keep ${s.index}`) },
  };
  if (dryRun === true) return { ...base, dry_run: true };
  if (kept.length === 0) {
    throw new MediaKitError("cut_words would remove everything — nothing to keep (pass --keep for words to rescue)", "INVALID_ARG");
  }
  const outPath = await prepareOutput(output, [inPath, wordsPath]);
  if (removedWords.length === 0) {
    // Nothing matched: copy the streams as-is (silence's no-op path).
    await run(FFMPEG, ["-y", "-i", inPath, "-c", "copy", outPath]);
    const info = await fileInfo(outPath);
    return { ...base, output: outPath, duration_after: duration, stream_copy: true, warning: "no words matched — copied unchanged", ...info };
  }
  // One filter graph: trim each kept segment (video + audio), then concat —
  // the same graph silence builds, so a word cut and a silence cut compose.
  const vParts = [];
  const aParts = [];
  const vLabels = [];
  const aLabels = [];
  kept.forEach((seg, i) => {
    if (meta.video) {
      vParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
      vLabels.push(`[v${i}]`);
    }
    aParts.push(joinFadeAudio(seg, i));
    aLabels.push(`[a${i}]`);
  });
  const graph = [...vParts, ...aParts];
  if (meta.video) graph.push(`${vLabels.join("")}concat=n=${kept.length}:v=1:a=0[vout]`);
  graph.push(`${aLabels.join("")}concat=n=${kept.length}:v=0:a=1[aout]`);
  const args = ["-y", "-i", inPath, "-filter_complex", graph.join(";")];
  if (meta.video) {
    args.push("-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
      "-c:a", "aac", ...audioBitrateArgs("aac"), "-movflags", "+faststart");
  } else {
    const ext = path.extname(outPath).slice(1).toLowerCase();
    const codec = AUDIO_FORMATS[ext];
    if (!codec) throw new MediaKitError(`audio-only input needs an audio output format (.mp3/.aac/.wav/.ogg/.opus/.flac), got .${ext || "(none)"}`, "INVALID_ARG");
    args.push("-map", "[aout]", "-c:a", codec, ...audioBitrateArgs(codec));
  }
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    ...base, output: outPath,
    duration_after: out.duration_seconds,
    ...info,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

// ---------------------------------------------------------------- remove_retakes
// Find and cut repeated takes from a talking-head recording, on the
// word timings from transcribe --word-timestamps. The idea is
// mariagorskikh/talking-head-reel's take selection, made
// deterministic: a speaker says a sentence, dislikes it, says it
// again — the transcript holds the same phrase twice with only
// restart junk ("okay, again", a filler) between the two takes.
// Later wins over earlier (people warm up), the fluent run is kept
// whole, and cut points come from word times via cutWords' pads.
// Two shapes are detected:
//   * a full repeat: >= min_words identical words, then a short gap
//     (<= max_gap_words words, <= max_gap_seconds), then the same
//     phrase again — the earlier take + the gap junk are removed.
//   * an abandoned start: 2..min_words-1 words that are a strict
//     prefix of the phrase that follows right after (e.g. "the
//     quick" — "um" — "the quick brown fox") — the short start +
//     the gap are removed, the full phrase is kept.
// Detection scans a live word list left to right: after a cluster
// the removed words leave the list, so a third take of the same
// phrase is found as a new pair against the kept take (keep=last),
// and with keep=first the scan restarts from the top so the third
// take is matched against the kept first one. What it deliberately
// does NOT do: judge delivery. An intentional repetition ("I like
// cats. I like cats a lot.") looks identical to a retake to this
// detector — the gap bounds (<= 8 words, <= 5 s by default) are the
// only guard, so --detect-only is the review gate: read the
// clusters before cutting.
export function detectRetakes(words, { minWords = 3, maxGapWords = 8, maxGapSeconds = 5, keep = "last" } = {}) {
  const minW = num(minWords, "min_words", { min: 1, max: 10, integer: true });
  const maxGW = num(maxGapWords, "max_gap_words", { min: 0, max: 50, integer: true });
  const maxGS = num(maxGapSeconds, "max_gap_seconds", { min: 0, max: 60 });
  if (keep !== "first" && keep !== "last") throw new MediaKitError(`remove_retakes --keep must be "first" or "last", got: ${keep}`, "INVALID_ARG");
  const norm = words.map((w) => normalizeWord(w.word));
  // Live list of word indices still present; removals splice it, so
  // later pairs are matched on the transcript as it will sound.
  let live = words.map((_, i) => i);
  const clusters = [];
  const removed = new Set();
  let pos = 0;
  while (pos < live.length) {
    const i = live[pos];
    let best = null;
    const jLast = Math.min(live.length - 1, pos + minW + maxGW);
    for (let jpos = pos + 1; jpos <= jLast; jpos++) {
      const j = live[jpos];
      let L = 0;
      while (pos + L < live.length && jpos + L < live.length && norm[live[pos + L]] !== "" && norm[live[pos + L]] === norm[live[jpos + L]]) L++;
      if (L === 0) continue;
      const gapWords = jpos - (pos + L);
      if (gapWords < 0 || gapWords > maxGW) continue;
      const gapSeconds = words[j].start - words[live[pos + L - 1]].end;
      if (gapSeconds > maxGS) continue;
      const isFull = L >= minW;
      const isAbandoned = L >= 2 && L < minW && (live.length - jpos) >= minW;
      if (!isFull && !isAbandoned) continue;
      if (!best || L > best.L || (L === best.L && gapWords < best.gapWords)) best = { jpos, L, gapWords, gapSeconds };
    }
    if (!best) { pos++; continue; }
    const { jpos, L, gapWords, gapSeconds } = best;
    const removedPos = keep === "last"
      ? Array.from({ length: jpos - pos }, (_, k) => pos + k)
      : Array.from({ length: L + gapWords }, (_, k) => pos + L + k);
    const removedIdx = removedPos.map((p) => live[p]);
    removedIdx.forEach((ix) => removed.add(ix));
    clusters.push({
      kept_start_index: live[keep === "last" ? jpos : pos],
      kept_start: +words[live[keep === "last" ? jpos : pos]].start.toFixed(3),
      repeat_words: L,
      gap_words: gapWords,
      gap_seconds: +gapSeconds.toFixed(3),
      removed_indices: removedIdx,
      removed_text: removedIdx.map((ix) => words[ix].word).join(" "),
      kept_text: live.slice(jpos, jpos + L).map((ix) => words[ix].word).join(" "),
    });
    live = live.filter((_, p) => !removedPos.includes(p));
    if (keep === "last") {
      // The kept take now sits at live[pos]; it can itself be the
      // earlier take of a third repeat, so keep scanning from it.
      if (pos >= live.length) break;
    } else {
      // The kept take is the first one; restart from the top so a
      // third take is matched against it.
      pos = 0;
    }
  }
  return { clusters, removed: [...removed].sort((a, b) => a - b) };
}

// "0,1,2,5,6" -> "0-2,5-6" — the --indices string cutWords takes.
function formatWordRanges(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  const parts = [];
  let start = null, prev = null;
  for (const i of sorted) {
    if (start === null) { start = i; prev = i; continue; }
    if (i === prev + 1) { prev = i; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = i; prev = i;
  }
  if (start !== null) parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(",");
}

export async function removeRetakes({ input, output = null, wordsFile, minWords = 3, maxGapWords = 8, maxGapSeconds = 5, keep = "last", padBefore = 0.06, padAfter = 0.12, minKeep = 0.2, detectOnly = false }) {
  const inPath = await requireInput(input);
  const wordsPath = await requireInput(wordsFile, "words file");
  let rawWords;
  try {
    rawWords = JSON.parse(await readFile(wordsPath, "utf8"));
  } catch (e) {
    throw new MediaKitError(`remove_retakes could not parse the words file as JSON: ${e.message}`, "INVALID_ARG");
  }
  const words = normalizeTranscriptWords(rawWords, "words file");
  const { clusters, removed } = detectRetakes(words, { minWords, maxGapWords, maxGapSeconds, keep });
  const removedWords = removed.map((i) => ({ index: i, word: words[i].word, start: words[i].start, end: words[i].end }));
  const meta = await probe(inPath);
  if (!meta.audio) throw new MediaKitError("remove_retakes needs an input with an audio stream", "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (duration === null) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  const base = {
    operation: "remove_retakes",
    input: inPath,
    words_file: wordsPath,
    words_total: words.length,
    min_words: num(minWords, "min_words", { min: 1, max: 10, integer: true }),
    max_gap_words: num(maxGapWords, "max_gap_words", { min: 0, max: 50, integer: true }),
    max_gap_seconds: num(maxGapSeconds, "max_gap_seconds", { min: 0, max: 60 }),
    keep,
    clusters,
    removed_count: removed.length,
    removed_words: removedWords,
    duration_before: duration,
    pad_before: num(padBefore, "pad_before", { min: 0, max: 1 }),
    pad_after: num(padAfter, "pad_after", { min: 0, max: 1 }),
    min_keep: num(minKeep, "min_keep", { min: 0.05, max: 5 }),
  };
  if (detectOnly === true) {
    const cut = new Set(removed);
    const { keep: kept, swallowed } = buildKeepSegmentsFromWords(words, cut, duration, { padBefore: base.pad_before, padAfter: base.pad_after, minKeep: base.min_keep });
    const keptTotal = kept.reduce((s, k) => s + k.duration, 0);
    return {
      ...base, detect_only: true,
      keep_segments: kept,
      removed_seconds: +(duration - keptTotal).toFixed(3),
      cut_check: { swallowed, warnings: swallowed.map((s) => `kept word #${s.index} '${s.word}' @${s.start}s is mostly cut out — play it, then re-run with a larger --max-gap-words or smaller --min-words`) },
    };
  }
  if (removed.length === 0) {
    // No retake found: copy the streams as-is (cut_words' no-op path).
    const outPath = await prepareOutput(output, [inPath, wordsPath]);
    await run(FFMPEG, ["-y", "-i", inPath, "-c", "copy", outPath]);
    const info = await fileInfo(outPath);
    return { ...base, output: outPath, duration_after: duration, stream_copy: true, warning: "no retakes found — copied unchanged", ...info };
  }
  // Cut through cutWords: one code path for word cuts, so pads,
  // min-keep, swallowed warnings and the no-match behaviour stay
  // identical. cutWords re-probes and re-reads the words file.
  const cut = await cutWords({
    input: inPath, output, wordsFile: wordsPath,
    indices: formatWordRanges(removed),
    padBefore: base.pad_before, padAfter: base.pad_after, minKeep: base.min_keep,
  });
  return {
    ...base,
    output: cut.output,
    duration_after: cut.duration_after,
    keep_segments: cut.keep_segments,
    removed_seconds: cut.removed_seconds,
    cut_check: cut.cut_check,
    ...(cut.dimensions ? { dimensions: cut.dimensions } : {}),
    ...(cut.size_bytes !== undefined ? { size_bytes: cut.size_bytes } : {}),
  };
}

// ---------------------------------------------------------------- doctor
// Read-only environment preflight (kinocut's video_doctor idea): what
// ffmpeg/ffprobe can actually do on this machine, and which mediakit
// tools that enables. Never writes anything.

const DOCTOR_FILTERS = [
  "silencedetect", "loudnorm", "subtitles", "ass", "scale", "crop",
  "cropdetect", "blackdetect", "freezedetect", "gblur", "trim", "atrim", "concat", "select", "tile", "pad", "overlay",
  "drawtext", "volume", "sidechaincompress", "amix", "aresample",
  "acompressor",
  "xfade", "acrossfade", "fps", "anullsrc", "setpts", "asetpts",
  "format", "colorchannelmixer", "atempo", "aloop", "geq", "color",
  "palettegen", "paletteuse", "adelay", "apad", "pan",
  "astats", "ametadata", "eq", "hue", "colorbalance", "lutrgb",
  "reverse", "areverse",
  "transpose", "hflip", "vflip",
  "minterpolate", "hqdn3d", "nlmeans",
  "chromakey", "zoompan",
  "afade",
  "tblend", "signalstats",
  "convolution",
  "ssim", "psnr", "libvmaf",
  "blend", "split",
  "fade", "asplit",
  "vstack",
  "loop",
];
const DOCTOR_ENCODERS = [
  "libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4", "prores_ks",
  "aac", "libopus", "libmp3lame", "libvorbis", "flac", "pcm_s16le",
];
const DOCTOR_DECODERS = [
  "librsvg",
];
const DOCTOR_MUXERS = [
  "framemd5",
];
// Tool -> capabilities it needs. A tool is available when all listed
// filters exist and at least one listed encoder exists (empty list =
// no requirement).
const TOOL_REQUIREMENTS = {
  probe: {},
  trim: { encoders: ["libx264"] },
  crop: { filters: ["crop"] },
  resize: { filters: ["scale"] },
  extract_audio: { encoders: ["libmp3lame", "aac", "pcm_s16le", "libvorbis", "libopus", "flac"] },
  extract_frame: {},
  thumbnail: { filters: ["scale", "tile", "drawtext", "vstack", "convolution", "signalstats"] },
  loudness: { filters: ["loudnorm", "acompressor"] },
  qa_report: { filters: ["loudnorm", "blackdetect", "freezedetect", "silencedetect", "astats", "ametadata", "select"] },
  concat: { filters: ["concat", "xfade", "acrossfade", "fps", "scale", "pad"] },
  frames: { filters: ["scale", "convolution", "signalstats"] },
  export_gif: { filters: ["palettegen", "paletteuse", "fps", "scale"] },
  burn_captions: { filters: ["subtitles", "ass"] },
  reframe: { filters: ["crop", "scale", "pad", "gblur", "overlay"], encoders: ["libx264"] },
  check: { filters: ["loudnorm", "blackdetect", "freezedetect", "silencedetect", "astats", "ametadata"] },
  grade: { filters: ["eq", "hue", "colorbalance", "lutrgb"], encoders: ["libx264"] },
  reverse: { filters: ["reverse", "areverse"], encoders: ["libx264", "aac"] },
  rotate: { filters: ["transpose", "hflip", "vflip"], encoders: ["libx264", "aac"] },
  boomerang: { filters: ["split", "reverse", "trim", "setpts", "concat", "asplit", "areverse", "atrim", "asetpts", "blend", "signalstats"], encoders: ["libx264", "aac"] },
  make_loopable: { filters: ["split", "asplit", "trim", "atrim", "setpts", "asetpts", "format", "fade", "overlay", "concat", "acrossfade", "blend", "signalstats"], encoders: ["libx264", "aac"] },
  freeze: { filters: ["split", "asplit", "trim", "atrim", "setpts", "asetpts", "loop", "concat", "fps", "format", "volume", "apad", "blend", "signalstats"], encoders: ["libx264", "aac"] },
  fastforward: { filters: ["split", "asplit", "trim", "atrim", "setpts", "asetpts", "atempo", "concat", "fps", "format", "drawtext"], encoders: ["libx264", "aac"] },
  interpolate: { filters: ["minterpolate"], encoders: ["libx264"] },
  denoise: { filters: ["hqdn3d", "nlmeans"], encoders: ["libx264"] },
  segment: {},
  convert: { encoders: ["libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4"] },
  compress: { filters: ["scale"], encoders: ["libx264", "aac"] },
  receipt: { filters: ["loudnorm"] },
  silence: { filters: ["silencedetect", "trim", "atrim", "concat", "afade"], encoders: ["libx264", "aac"] },
  cut_words: { filters: ["trim", "atrim", "concat", "setpts", "asetpts", "afade"], encoders: ["libx264", "aac"] },
  remove_retakes: { filters: ["trim", "atrim", "concat", "setpts", "asetpts", "afade"], encoders: ["libx264", "aac"] },
  cropdetect: { filters: ["cropdetect"] },
  package: {},
  publish_kit: {},
  assemble: {
    filters: ["zoompan", "xfade", "scale", "crop", "fps", "trim", "setpts", "format", "subtitles", "sidechaincompress", "amix", "aresample", "volume", "loudnorm", "adelay", "apad", "drawtext"],
    encoders: ["libx264", "aac"],
  },
  // verify re-runs assemble on --rerender and measures loudness on
  // check, so it needs assemble's capabilities.
  verify: {
    filters: ["zoompan", "xfade", "scale", "crop", "fps", "trim", "setpts", "format", "subtitles", "sidechaincompress", "amix", "aresample", "volume", "loudnorm", "adelay", "apad", "drawtext"],
    encoders: ["libx264", "aac"],
  },
  // diagnose measures motion (tblend/blend/signalstats), loudness
  // and seam frames on the film's own assets — same filters as
  // motion + verify, no new capability.
  diagnose: {
    filters: ["tblend", "blend", "fps", "split", "trim", "setpts", "geq", "signalstats", "scale", "loudnorm"],
    encoders: ["libx264"],
  },
  // init_project only needs ffmpeg to render the placeholder voice
  // (lavfi sine source + pcm_s16le WAV encoder) — no filter.
  init_project: { encoders: ["pcm_s16le"] },
  mix: { filters: ["sidechaincompress", "amix", "aresample", "volume", "loudnorm", "adelay"], encoders: ["aac", "libmp3lame"] },
  overlay: { filters: ["overlay", "format", "scale", "colorchannelmixer"], encoders: ["libx264"] },
  scenes: { filters: ["select", "signalstats"] },
  hook: { filters: ["astats", "ametadata", "silencedetect", "select"] },
  // bpm decodes to raw PCM with -ac/-ar (the resampler, not a filter)
  // and does the analysis in pure Node — no ffmpeg capability needed.
  bpm: {},
  // beat_grid is the same measurement as bpm with the full grid
  // expanded — same (lack of) ffmpeg capability.
  beat_grid: {},
  // tempo_drift is the same family (decode + pure-Node tempogram) —
  // no ffmpeg capability needed either.
  tempo_drift: {},
  // transitions is a pure data lookup over the catalog — no ffmpeg
  // capability needed either.
  transitions: {},
  // patch_manifest is pure JSON + a manifest --dry-run validation —
  // no ffmpeg capability needed either.
  patch_manifest: {},
  // chapters only needs silencedetect, and only in input mode — the
  // words-file mode is pure JSON and needs no ffmpeg capability.
  chapters: { filters: ["silencedetect"] },
  motion: { filters: ["tblend", "blend", "fps", "split", "trim", "setpts", "geq", "signalstats", "scale"] },
  keyframes: {},
  fit: { filters: ["setpts", "atempo", "fps"], encoders: ["libx264", "aac"] },
  pip: { filters: ["overlay", "format", "scale", "colorchannelmixer", "amix"], encoders: ["libx264"] },
  // broll overlays like pip (plus trim/setpts/fade on each clip)
  // and mutes the main track inside windows with volume:enable
  // (broll audio mode) or mixes delayed B-roll tracks in (mix).
  broll: { filters: ["overlay", "format", "scale", "trim", "setpts", "fade", "volume", "atrim", "asetpts", "adelay", "amix"], encoders: ["libx264"] },
  titlecard: { filters: ["drawtext", "geq"] },
  intro: { filters: ["color", "drawtext"], encoders: ["libx264"] },
  social: { filters: ["crop", "scale", "pad", "gblur", "overlay", "loudnorm"], encoders: ["libx264"] },
  convert_captions: {},
  generate_srt: {},
  find: {},
  download: {},
  batch: {},
  manifest: {},
  mux: {},
  svg_animate: { decoders: ["librsvg"], encoders: ["libx264"] },
  transcribe: {},
  chroma_key: { filters: ["chromakey", "overlay", "scale"], encoders: ["libvpx-vp9", "prores_ks", "libx264"] },
  zoom_pan: { filters: ["zoompan", "scale", "crop"], encoders: ["libx264"] },
  image_to_video: { filters: ["scale", "pad"], encoders: ["libx264", "libvpx-vp9"] },
  slideshow: { filters: ["scale", "pad", "xfade", "acrossfade", "fps"], encoders: ["libx264", "aac"] },
  // determinism hashes decoded frames with the framemd5 muxer
  // (moviepy's test pattern: compare decoded frames, never bytes) —
  // the muxer is a capability like a filter or encoder.
  determinism: { muxers: ["framemd5"] },
  job: {},
  doctor: {},
  audit: {},
};

async function listCapabilities(kind) {
  // `ffmpeg -filters` / `-encoders` print a table; match whole words so
  // "crop" does not match "cropdetect".
  const { stdout } = await run(FFMPEG, ["-hide_banner", `-${kind}`]);
  return stdout;
}

// One-sentence fix for a list of missing capabilities, so `doctor`
// tells the caller HOW to fix the machine, not just what is missing
// (davinci-resolve-mcp reports a fix per problem; most ffmpeg MCP
// servers only list install steps in their README). Pure function —
// unit-tested directly, since a healthy machine has nothing missing.
export function fixForMissing(missing) {
  if (!missing?.length) return null;
  return `missing ${missing.join(", ")} — install a full ffmpeg build with those capabilities (Debian/Ubuntu: sudo apt install ffmpeg; macOS: brew install ffmpeg; static build with librsvg: BtbN GPL build from github.com/BtbN/FFmpeg-Builds — the johnvansickle.com static build has no librsvg decoder, so svg_animate will not work on it). A minimal ffmpeg build ships without some filters/encoders.`;
}

// Hardware encoders worth probing, best first (ffmpeg-render-pro's
// detect_gpu idea). Presence in `ffmpeg -encoders` only means the
// build was compiled with them — a machine with no GPU still lists
// nvenc/vaapi/qsv, so doctor actually tries a tiny encode before
// calling one available. Listed is not usable; a failed probe encode
// is the truth. A missing GPU never fails doctor (CPU-only machines
// are fine) — this is informational, so agents can pick a hardware
// encoder when one really works.
const GPU_ENCODERS = [
  "h264_nvenc", "hevc_nvenc", "av1_nvenc",
  "h264_qsv", "hevc_qsv", "av1_qsv",
  "h264_vaapi", "hevc_vaapi", "vp9_vaapi", "av1_vaapi",
  "h264_videotoolbox", "hevc_videotoolbox",
  "h264_amf", "hevc_amf", "av1_amf",
];

async function detectGpu(encodersOut) {
  const has = (name) => new RegExp(`\\b${name}\\b`).test(encodersOut);
  const present = GPU_ENCODERS.filter(has);
  let working = null;
  for (const enc of present) {
    try {
      // 0.2s of 64x64 testsrc straight to null: 2 frames, and a hard
      // 10s cap per encoder so a hanging driver init cannot stall
      // doctor. On a GPU-less machine every attempt fails in well
      // under a second (measured 2026-11-12: nvenc/qsv/vaapi all
      // fail in <1s total).
      await run(FFMPEG, ["-hide_banner", "-nostats", "-f", "lavfi", "-i", "testsrc=duration=0.2:size=64x64:rate=10", "-c:v", enc, "-frames:v", "2", "-f", "null", "-"], { timeoutMs: 10_000 });
      working = enc;
      break;
    } catch { /* not usable on this machine — try the next one */ }
  }
  return { available: working !== null, encoders: present, working_encoder: working };
}

// ---------------------------------------------------------------- doctor smoke
// `doctor --smoke` (turn 93, idea from AH64-dll/OpenEdit's installer
// rule: only report success after a real end-to-end workflow runs):
// generate a 2s clip from lavfi, then run the real trim -> loudness
// chain on it and verify the file on disk (duration, dimensions,
// LUFS). Static capability checks can pass while a render still fails
// (a broken encoder, a bad filter graph), so the smoke is the only
// honest "this machine can render" answer. Runs in a temp dir (inside
// the sandbox workdir when one is set, so the sandbox rules that
// guard trim/loudness apply here too) and removes it afterwards; each
// step reports its own seconds so a slow machine shows where time
// went. Skipped (ran:false) when trim or loudness is statically
// unavailable — a skip is not a pass, and doctor's ok is already
// false then because those tools are missing.
async function runDoctorSmoke(tools) {
  const started = Date.now();
  const steps = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, seconds: +((Date.now() - t0) / 1000).toFixed(2), ...(detail ? { detail } : {}) });
      return true;
    } catch (err) {
      steps.push({ name, ok: false, seconds: +((Date.now() - t0) / 1000).toFixed(2), error: err?.message ?? String(err) });
      return false;
    }
  };
  const missing = ["trim", "loudness"].filter((t) => tools[t] && !tools[t].available);
  if (missing.length) {
    return { ran: false, ok: false, seconds: 0, steps, reason: `smoke needs trim + loudness available (missing: ${missing.join(", ")})` };
  }
  let workRoot = null;
  try { workRoot = await workdirRoot(); } catch { workRoot = null; }
  const tmpDir = await mkdtemp(path.join(workRoot ?? os.tmpdir(), "mediakit-doctor-smoke-"));
  let ok = true;
  try {
    const src = path.join(tmpDir, "smoke-source.mp4");
    const trimmed = path.join(tmpDir, "smoke-trimmed.mp4");
    const mastered = path.join(tmpDir, "smoke-mastered.mp4");
    ok = await step("generate", async () => {
      await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
      const m = await probe(src);
      if (!m.video || !m.audio || Math.abs(m.duration_seconds - 2) > 0.15) {
        throw new MediaKitError(`generated source failed verification: ${m.duration_seconds}s video=${!!m.video} audio=${!!m.audio}`, "SMOKE_FAILED");
      }
      return "2s 640x360 testsrc2 + 440 Hz tone";
    });
    if (ok) ok = await step("trim", async () => {
      await trim({ input: src, output: trimmed, start: 0.25, duration: 1.5 });
      const m = await probe(trimmed);
      if (Math.abs(m.duration_seconds - 1.5) > 0.15) {
        throw new MediaKitError(`trim output is ${m.duration_seconds}s, expected 1.5s`, "SMOKE_FAILED");
      }
      return "0.25s + 1.5s";
    });
    if (ok) ok = await step("loudness", async () => {
      const r = await loudness({ input: trimmed, output: mastered, targetLufs: -14 });
      if (r.output_lufs === null || Math.abs(r.output_lufs - (-14)) > 1) {
        throw new MediaKitError(`loudness output is ${r.output_lufs} LUFS, expected -14 +/-1`, "SMOKE_FAILED");
      }
      return `output ${r.output_lufs} LUFS (target -14)`;
    });
    if (ok) ok = await step("verify", async () => {
      const m = await probe(mastered);
      if (!m.video || !m.audio || Math.abs(m.duration_seconds - 1.5) > 0.15 || m.video.width !== 640 || m.video.height !== 360) {
        throw new MediaKitError(`mastered file failed verification: ${m.duration_seconds}s ${m.video?.width}x${m.video?.height} audio=${!!m.audio}`, "SMOKE_FAILED");
      }
      return "1.5s 640x360 + audio, on disk";
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  return { ran: true, ok, seconds: +((Date.now() - started) / 1000).toFixed(2), steps };
}

export async function doctor({ smoke = false } = {}) {
  const { stdout: ffmpegVer } = await run(FFMPEG, ["-version"]);
  const { stdout: ffprobeVer } = await run(FFPROBE, ["-version"]);
  const ffmpegVersion = (ffmpegVer.match(/ffmpeg version (\S+)/) || [])[1] ?? null;
  const ffprobeVersion = (ffprobeVer.match(/ffprobe version (\S+)/) || [])[1] ?? null;
  const filtersOut = await listCapabilities("filters");
  const encodersOut = await listCapabilities("encoders");
  const decodersOut = await listCapabilities("decoders");
  const muxersOut = await listCapabilities("muxers");
  const has = (text, name) => new RegExp(`\\b${name}\\b`).test(text);
  const filters = Object.fromEntries(DOCTOR_FILTERS.map((f) => [f, has(filtersOut, f)]));
  const encoders = Object.fromEntries(DOCTOR_ENCODERS.map((e) => [e, has(encodersOut, e)]));
  const decoders = Object.fromEntries(DOCTOR_DECODERS.map((d) => [d, has(decodersOut, d)]));
  const muxers = Object.fromEntries(DOCTOR_MUXERS.map((m) => [m, has(muxersOut, m)]));
  const gpu = await detectGpu(encodersOut);
  const tools = {};
  let allOk = Boolean(ffmpegVersion && ffprobeVersion);
  for (const [name, req] of Object.entries(TOOL_REQUIREMENTS)) {
    const missing = [];
    for (const f of req.filters ?? []) if (!filters[f]) missing.push(`filter:${f}`);
    for (const d of req.decoders ?? []) if (!decoders[d]) missing.push(`decoder:${d}`);
    for (const m of req.muxers ?? []) if (!muxers[m]) missing.push(`muxer:${m}`);
    const enc = req.encoders ?? [];
    if (enc.length && !enc.some((e) => encoders[e])) missing.push(`encoder:${enc.join("|")}`);
    tools[name] = { available: missing.length === 0, ...(missing.length ? { missing, fix: fixForMissing(missing) } : {}) };
    if (missing.length) allOk = false;
  }
  // Sandbox status: enabled only when MEDIAKIT_WORKDIR is set; a set
  // but broken workdir is a config error, so ok goes false.
  let sandbox = { enabled: false, workdir: null };
  try {
    const root = await workdirRoot();
    if (root) sandbox = { enabled: true, workdir: root };
  } catch (err) {
    sandbox = { enabled: true, workdir: process.env[WORKDIR_ENV] ?? null, error: err.message };
    allOk = false;
  }
  // Brand registry: built-ins plus any custom file MEDIAKIT_BRANDS
  // points at. A set but broken file is a config error, so ok goes
  // false — same treatment as a broken workdir.
  let brandsFile = { set: false, path: null, brands: [...ASSEMBLE_BRAND_IDS], custom: [] };
  try {
    const brands = await getAssembleBrands();
    const custom = Object.keys(brands).filter((id) => !ASSEMBLE_BRAND_IDS.includes(id)).sort();
    const raw = process.env[BRANDS_FILE_ENV]?.trim() || null;
    brandsFile = { set: raw !== null, path: raw, brands: Object.keys(brands).sort(), custom };
  } catch (err) {
    brandsFile = { set: true, path: process.env[BRANDS_FILE_ENV] ?? null, error: err.message };
    allOk = false;
  }
  // License policy: MEDIAKIT_LICENSE_POLICY (or a per-call
  // --license-policy-file) gates downloads. A set but broken file is
  // a config error, so ok goes false — same treatment as a broken
  // workdir or brands file: a gate that fails open on a typo would
  // be worse than no gate.
  let licensePolicy = { set: false, path: null, allow: null, deny: [], require_license: false };
  try {
    const p = await loadLicensePolicy(null);
    licensePolicy = {
      set: p.source !== "default",
      path: p.source === "default" ? null : p.source.slice("file:".length),
      allow: p.allow, deny: p.deny, require_license: p.require_license,
    };
  } catch (err) {
    licensePolicy = { set: true, path: process.env[LICENSE_POLICY_ENV] ?? null, error: err.message };
    allOk = false;
  }
  // transcribe is optional (ffmpeg-skill's ASR rule: a speech engine is
  // never required): report the engine state, but a missing engine
  // must not fail ok — everything else still works without it.
  // detectTranscribe() prefers faster-whisper, then whisper.cpp.
  const asr = await detectTranscribe();
  tools.transcribe = asr.available
    ? { available: true, engine: asr.engine, ...(asr.python ? { python: asr.python } : {}), ...(asr.binary ? { binary: asr.binary, model: asr.model } : {}) }
    : { available: false, engine: asr.engine, ...(asr.python ? { python: asr.python } : {}), fix: asr.fix };
  // Audit log state: enabled/path/entries, so a caller can tell
  // whether tool calls are being recorded before trusting `audit`.
  const audit = await auditStatus();
  // --smoke runs a real render chain after the static checks; a
  // failed smoke fails doctor.ok — "available" must mean "renders".
  let smokeResult = null;
  if (smoke) {
    smokeResult = await runDoctorSmoke(tools);
    if (smokeResult.ran && !smokeResult.ok) allOk = false;
  }
  return {
    operation: "doctor",
    ffmpeg_version: ffmpegVersion,
    ffprobe_version: ffprobeVersion,
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    sandbox,
    brands_file: brandsFile,
    license_policy: licensePolicy,
    decoded_work_limits: DECODED_WORK_LIMITS,
    job_admission_limits: jobAdmissionLimits(),
    ffmpeg_timeout_ms: ffmpegTimeoutMs(),
    audit,
    gpu,
    filters,
    encoders,
    decoders,
    muxers,
    tools,
    ...(smokeResult ? { smoke: smokeResult } : {}),
    ok: allOk,
  };
}

// ---------------------------------------------------------------- cropdetect
// Measure letterbox/pillarbox bars with the cropdetect filter, so a
// crop/reframe starts from a measured rectangle instead of a guess.
// Samples frames across the file and reports the most common crop
// rectangle (mode) plus the distinct values seen, so a caller can tell
// a constant letterbox apart from a scene that changes aspect.

export async function cropdetect({ input, frames = 30, limit = 24 }) {
  const inPath = await requireInput(input);
  const n = num(frames, "frames", { min: 1, max: 300, integer: true });
  const lim = num(limit, "limit", { min: 0, max: 255, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("cropdetect needs a video input", "INVALID_ARG");
  // Sample evenly across the whole file: the first frames of a clip are
  // often a fade-in / dark intro, so sampling only the start biases the
  // result toward a too-tight crop.
  const fps = meta.video.fps || 30;
  const totalFrames = Math.max(1, Math.floor((meta.duration_seconds ?? 0) * fps));
  const step = Math.max(1, Math.floor(totalFrames / n));
  const { stderr } = await run(FFMPEG, [
    "-i", inPath,
    "-vf", `select='not(mod(n\\,${step}))',cropdetect=limit=${lim}:round=2:reset=0`,
    "-frames:v", String(n), "-f", "null", "-",
  ]);
  const counts = new Map();
  for (const line of stderr.split("\n")) {
    const m = line.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    if (!m) continue;
    const key = m.slice(1).join(":");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) {
    throw new MediaKitError("cropdetect found no crop values (is the video black?)", "PROBE_FAILED");
  }
  const ranked = [...counts.entries()]
    .map(([key, count]) => {
      const [width, height, x, y] = key.split(":").map(Number);
      return { width, height, x, y, frames: count };
    })
    .sort((a, b) => b.frames - a.frames);
  const best = ranked[0];
  const sw = meta.video.width;
  const sh = meta.video.height;
  const hasBars = best.width !== sw || best.height !== sh;
  return {
    operation: "cropdetect",
    input: inPath,
    source: `${sw}x${sh}`,
    frames_sampled: n,
    crop: { width: best.width, height: best.height, x: best.x, y: best.y },
    has_black_bars: hasBars,
    black_bars: {
      top: best.y,
      bottom: sh - best.y - best.height,
      left: best.x,
      right: sw - best.x - best.width,
    },
    distinct_values: ranked.slice(0, 3).map(({ width, height, x, y, frames: f }) =>
      ({ crop: `${width}:${height}:${x}:${y}`, frames: f })),
    ...(hasBars ? {
      suggested_crop_command: `mediakit crop ${path.basename(inPath)} --width ${best.width} --height ${best.height} --x ${best.x} --y ${best.y} -o cropped.mp4`,
    } : {}),
  };
}

// ---------------------------------------------------------------- package
// Delivery bundle (video-edit-mcp's export.package idea + kinocut's
// Video Receipt): a ZIP with the finished media, a spec.json receipt
// (measured probe + loudness + optional platform check, so the bundle
// proves what was delivered), checksums.sha256, and the captions sidecar
// when given. The ZIP is written by a small pure-Node writer (stored
// entries, no compression — media is already compressed) so no new
// dependency and no external `zip` binary are needed.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** Build a ZIP (stored entries) from [{ name, data: Buffer }]. */
function buildZip(entries) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

export async function packageDelivery({ input, output, captions = null, platform = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  if (!outPath.toLowerCase().endsWith(".zip")) {
    throw new MediaKitError(`package output must end in .zip, got: ${output}`, "INVALID_ARG");
  }
  const mediaName = path.basename(inPath);
  const mediaData = await readFile(inPath);
  const mediaSha = createHash("sha256").update(mediaData).digest("hex");
  const meta = await probe(inPath);
  const lufs = meta.audio ? await measureLoudness(inPath) : null;
  let checkResult = null;
  if (platform) {
    if (!PLATFORMS[platform]) {
      throw new MediaKitError(`unknown platform: ${platform} (supported: ${Object.keys(PLATFORMS).join(", ")})`, "INVALID_ARG");
    }
    checkResult = await check({ input: inPath, platform });
  }
  const files = [{ name: mediaName, data: mediaData, sha256: mediaSha }];
  let captionsName = null;
  if (captions) {
    const capPath = await requireInput(captions, "captions file");
    const capExt = path.extname(capPath).toLowerCase();
    if (![".srt", ".ass", ".vtt"].includes(capExt)) {
      throw new MediaKitError(`captions must be .srt/.ass/.vtt, got ${capExt}`, "INVALID_ARG");
    }
    const capData = await readFile(capPath);
    captionsName = path.basename(capPath);
    files.push({
      name: captionsName,
      data: capData,
      sha256: createHash("sha256").update(capData).digest("hex"),
    });
  }
  const spec = {
    tool: "mediakit-for-agents",
    mediakit_version: MEDIAKIT_VERSION,
    created_at: new Date().toISOString(),
    media: mediaName,
    ...(captionsName ? { captions: captionsName } : {}),
    probe: meta,
    loudness_lufs: lufs,
    ...(checkResult ? { platform_check: { platform, pass: checkResult.pass, checks: checkResult.checks } } : {}),
  };
  const specData = Buffer.from(JSON.stringify(spec, null, 2) + "\n", "utf8");
  files.push({
    name: "spec.json",
    data: specData,
    sha256: createHash("sha256").update(specData).digest("hex"),
  });
  const checksumLines = files
    .map((f) => `${f.sha256}  ${f.name}\n`)
    .join("");
  const checksumData = Buffer.from(checksumLines, "utf8");
  files.push({ name: "checksums.sha256", data: checksumData, sha256: null });
  const zipData = buildZip(files.map(({ name, data }) => ({ name, data })));
  await writeFile(outPath, zipData);
  const info = await fileInfo(outPath);
  return {
    operation: "package",
    input: inPath,
    output: outPath,
    ...info,
    files: files.map((f) => f.name),
    media_sha256: mediaSha,
    loudness_lufs: lufs,
    ...(checkResult ? { platform: checkResult.platform, platform_pass: checkResult.pass } : {}),
    verify_hint: `unzip -l ${path.basename(outPath)} && sha256sum -c <(unzip -p ${path.basename(outPath)} checksums.sha256)`,
  };
}

// ---------------------------------------------------------------- receipt
// Provenance receipt for one finished file (kinocut's Video Receipt
// idea): probe + SHA-256 + size + measured loudness + optional
// platform check + the exact ffmpeg/ffprobe versions that produced
// it, written as a JSON sidecar. The file itself is the evidence —
// re-run `sha256sum` against it any time to prove the media has not
// changed since the receipt was written. `package` already embeds a
// spec.json inside its ZIP; `receipt` is the standalone version for
// a file that is delivered on its own.
export async function receipt({ input, output, platform = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  if (!outPath.toLowerCase().endsWith(".json")) {
    throw new MediaKitError(`receipt output must end in .json, got: ${output}`, "INVALID_ARG");
  }
  const data = await readFile(inPath);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const meta = await probe(inPath);
  const lufs = meta.audio ? await measureLoudness(inPath) : null;
  let checkResult = null;
  if (platform) {
    if (!PLATFORMS[platform]) {
      throw new MediaKitError(`unknown platform: ${platform} (supported: ${Object.keys(PLATFORMS).join(", ")})`, "INVALID_ARG");
    }
    checkResult = await check({ input: inPath, platform });
  }
  const { stdout: ffmpegVer } = await run(FFMPEG, ["-version"]);
  const { stdout: ffprobeVer } = await run(FFPROBE, ["-version"]);
  const rec = {
    tool: "mediakit-for-agents",
    mediakit_version: MEDIAKIT_VERSION,
    created_at: new Date().toISOString(),
    media: path.basename(inPath),
    sha256,
    size_bytes: data.length,
    size_human: humanSize(data.length),
    probe: meta,
    loudness_lufs: lufs,
    ...(checkResult ? { platform_check: { platform, pass: checkResult.pass, checks: checkResult.checks } } : {}),
    environment: {
      ffmpeg_version: (ffmpegVer.match(/ffmpeg version (\S+)/) || [])[1] ?? null,
      ffprobe_version: (ffprobeVer.match(/ffprobe version (\S+)/) || [])[1] ?? null,
      node_version: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
  };
  await writeFile(outPath, JSON.stringify(rec, null, 2) + "\n");
  const info = await fileInfo(outPath);
  return {
    operation: "receipt",
    input: inPath,
    output: outPath,
    ...info,
    media: path.basename(inPath),
    sha256,
    size_bytes: data.length,
    size_human: humanSize(data.length),
    duration_seconds: meta.duration_seconds,
    dimensions: meta.video ? `${meta.video.width}x${meta.video.height}` : null,
    loudness_lufs: lufs,
    ...(checkResult ? { platform: checkResult.platform, platform_pass: checkResult.pass } : {}),
    verify_hint: `sha256sum ${path.basename(inPath)}`,
  };
}

// ---------------------------------------------------------------- mix
// Voice + music bed with sidechain ducking (soniccraft's ducking idea,
// rebuilt on ffmpeg): level the voice to a target LUFS first, duck the
// bed under the voice with sidechaincompress (attack/release in ms),
// mix, then master the result to a target LUFS. The music input is
// looped to the voice length. The tool also MEASURES the ducking it
// actually achieved: it re-runs the ducked bed alone and compares its
// mean volume in a speech window vs a silence window, so the returned
// ducking_measured_db is observed, not assumed. --sfx (outtake's
// mix_sfx idea) drops short sounds at exact timestamps: each one is
// delayed with adelay and mixed in AFTER the ducking, so a sting or
// whoosh punches through instead of being ducked with the bed.

/** Mean volume (dB) of the ducked music bed alone in [start, end). */
async function duckedBedVolume(voicePath, musicPath, voiceGainDb, musicVolume, duck, start, end) {
  const graph = [
    `[0:a]aresample=48000,acompressor=threshold=0.125:ratio=4:attack=1:release=250:detection=peak,volume=${voiceGainDb}dB[voice]`,
    `[1:a]aresample=48000,volume=${musicVolume}[bed]`,
    `[bed][voice]sidechaincompress=threshold=0.0316:ratio=${duck.ratio}:attack=${duck.attack}:release=${duck.release}[ducked]`,
    `[ducked]atrim=start=${start}:end=${end},volumedetect`,
  ].join(";");
  const { stderr } = await run(FFMPEG, [
    "-y", "-i", voicePath, "-stream_loop", "-1", "-i", musicPath,
    "-vn", "-filter_complex", graph, "-f", "null", "-",
  ]);
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  return m ? parseFloat(m[1]) : null;
}

export async function mix({
  voice, music, output,
  musicVolume = 0.3, duckDb = 12, attackMs = 100, releaseMs = 400,
  voiceLufs = -16, targetLufs = -14, master = true, dryRun = false,
  sfx = [],
}) {
  const voicePath = await requireInput(voice, "voice file");
  const musicPath = await requireInput(music, "music file");
  const outPath = await prepareOutput(output, [voicePath, musicPath]);
  const bedVol = num(musicVolume, "music_volume", { min: 0, max: 1 });
  const duck = num(duckDb, "duck_db", { min: 0, max: 24 });
  const attack = num(attackMs, "attack_ms", { min: 1, max: 1000, integer: true });
  const release = num(releaseMs, "release_ms", { min: 10, max: 5000, integer: true });
  const vTarget = num(voiceLufs, "voice_lufs", { min: -70, max: 0 });
  const mTarget = master ? num(targetLufs, "target_lufs", { min: -70, max: 0 }) : null;

  const voiceMeta = await probe(voicePath);
  if (!voiceMeta.audio) throw new MediaKitError("mix needs an audio stream in the voice file", "INVALID_ARG");
  const musicMeta = await probe(musicPath);
  if (!musicMeta.audio) throw new MediaKitError("mix needs an audio stream in the music file", "INVALID_ARG");
  const voiceDuration = voiceMeta.duration_seconds;
  if (voiceDuration === null) throw new MediaKitError("could not read voice duration", "PROBE_FAILED");

  // SFX list: [{ file, at (seconds or MM:SS), volume 0-1 }]. Each file
  // must have audio, and the timestamp must fall inside the voice —
  // a sting landing after the mix ends would be silently cut by
  // amix duration=first, so refuse it loudly instead.
  if (!Array.isArray(sfx)) throw new MediaKitError("sfx must be a list of {file, at, volume}", "INVALID_ARG");
  if (sfx.length > 16) throw new MediaKitError(`at most 16 sfx entries, got ${sfx.length}`, "INVALID_ARG");
  const sfxList = [];
  for (const [i, entry] of sfx.entries()) {
    if (!entry || typeof entry !== "object") throw new MediaKitError(`sfx[${i}] must be an object {file, at, volume}`, "INVALID_ARG");
    const sfxPath = await requireInput(entry.file, `sfx[${i}] file`);
    const sfxMeta = await probe(sfxPath);
    if (!sfxMeta.audio) throw new MediaKitError(`sfx[${i}] needs an audio stream in ${entry.file}`, "INVALID_ARG");
    const atSeconds = parseTime(entry.at ?? entry.at_seconds, `sfx[${i}] at`);
    if (atSeconds >= voiceDuration) {
      throw new MediaKitError(`sfx[${i}] at ${atSeconds}s is past the voice end (${voiceDuration}s) — it would be cut off`, "INVALID_ARG");
    }
    sfxList.push({
      file: sfxPath,
      at_seconds: +atSeconds.toFixed(3),
      volume: num(entry.volume ?? 1, `sfx[${i}] volume`, { min: 0, max: 1 }),
    });
  }

  // Level the voice first (soniccraft levels each cue before mixing):
  // a plain gain, clamped so a very quiet/loud voice cannot explode.
  const voiceLufsBefore = await measureLoudness(voicePath);
  const voiceGainDb = voiceLufsBefore === null
    ? 0
    : Math.max(-12, Math.min(12, +(vTarget - voiceLufsBefore).toFixed(1)));

  // sidechaincompress takes a LINEAR threshold (0-1), so -30 dB =
  // 0.0316. Reduction for a voice ~20 dB over that threshold is
  // (1 - 1/ratio) * 20 dB, so ratio follows from duckDb.
  const ratio = duck === 0 ? 1 : Math.max(1.2, Math.min(20, +(20 / (20 - duck)).toFixed(2)));
  const duckParams = { ratio, attack, release };

  const ext = path.extname(outPath).slice(1).toLowerCase();
  const audioCodec = voiceMeta.video
    ? (VIDEO_CONTAINER_AUDIO[ext] ?? "aac")
    : (AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext]);
  if (!audioCodec) throw new MediaKitError(`unsupported mix output format: .${ext || "(none)"}`, "INVALID_ARG");

  // The voice feeds TWO filters (sidechaincompress's sidechain AND the
  // final amix), so it MUST be split explicitly. A reused label is NOT
  // split by ffmpeg: the second reference silently binds to the raw
  // input instead — measured 2026-11-13: the amix branch got the
  // UNGAINED voice, so the mix measured -25.8 LUFS instead of -16.0
  // (the -9.6 dB voice gain never reached the mix). The bug lived
  // since the tool was written and stayed hidden because the old
  // single-pass loudnorm at the end of the graph re-levelled the total
  // to -14 anyway; two-pass mastering exposed it (the unmastered mix
  // is measured first, and a 10 dB-quiet mix cannot be lifted to -14
  // under the true-peak cap). Never reuse a filter label — asplit.
  // The voice is also compressed before levelling (threshold -18 dB,
  // ratio 4:1, attack 1 ms, peak detection): real speech has ~19 dB
  // crest, so a plain gain to -16 puts peaks at +3 dBTP and the master
  // cannot reach -14 under the -1.5 dBTP cap (measured: -14.5, on the
  // tolerance edge). Attack must be 1 ms: a 20 ms attack lets plosive
  // transients slip through (measured: only 2.6 dB peak reduction vs
  // 8.9 dB at 1 ms). With the fast compressor the mix crest drops to
  // ~15 dB and the master lands on -14.0. The master measures the
  // finished mix, so the small level shift from compression is
  // corrected there, not here.
  const graphParts = [
    `[0:a]aresample=48000,acompressor=threshold=0.125:ratio=4:attack=1:release=250:detection=peak,volume=${voiceGainDb}dB,asplit=2[voice][voice_sc]`,
    `[1:a]aresample=48000,volume=${bedVol}[bed]`,
    `[bed][voice_sc]sidechaincompress=threshold=0.0316:ratio=${ratio}:attack=${attack}:release=${release}[ducked]`,
    `[ducked][voice]amix=inputs=2:duration=first:normalize=0[mix]`,
  ];
  // SFX inputs are 2..N+1; each is delayed to its timestamp, then all
  // are mixed with the voice+bed mix. duration=first keeps the voice
  // length, so an SFX longer than the remaining mix is cut, not kept.
  const sfxLabels = [];
  sfxList.forEach((s, i) => {
    const label = `[sfx${i}]`;
    sfxLabels.push(label);
    graphParts.push(`[${2 + i}:a]aresample=48000,adelay=${Math.round(s.at_seconds * 1000)}:all=1,volume=${s.volume}${label}`);
  });
  let finalLabel = "[mix]";
  if (sfxLabels.length) {
    graphParts.push(`[mix]${sfxLabels.join("")}amix=inputs=${1 + sfxLabels.length}:duration=first:normalize=0[final]`);
    finalLabel = "[final]";
  }
  // Mastering is two-pass (the loudness() tool's approach): the mix is
  // rendered unmastered first, measured, then normalised with the
  // measured values + linear=true. A single-pass loudnorm chained onto
  // the mix graph systematically undershoots on quiet voices with long
  // gaps under a bed — measured -14.7/-14.8 LUFS against a -14 target
  // on a -34.6 LUFS voice, while two-pass lands on target (VERIFY
  // lượt 44). master=false (--no-master) keeps the old one-render path.
  const graph = graphParts.join(";");
  const mixLabel = finalLabel;
  const renderArgs = ["-y", "-i", voicePath, "-stream_loop", "-1", "-i", musicPath];
  for (const s of sfxList) renderArgs.push("-i", s.file);
  renderArgs.push("-filter_complex", graph);
  if (voiceMeta.video) {
    renderArgs.push("-map", "0:v", "-map", mixLabel, "-c:v", "copy", "-c:a", audioCodec, ...audioBitrateArgs(audioCodec), "-shortest");
  } else {
    renderArgs.push("-map", mixLabel, "-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
  }
  // The unmastered render lives next to the output so the plan can name
  // it exactly (dry-run prints real paths); it is deleted after the
  // master pass, even when the master fails.
  const unmasteredPath = mTarget !== null
    ? path.join(path.dirname(outPath), `${path.basename(outPath, path.extname(outPath))}.unmastered${path.extname(outPath)}`)
    : null;
  const renderCmd = [...renderArgs, mTarget !== null ? unmasteredPath : outPath];
  // Master pass: same shape as loudness() pass 2 — measured values when
  // the render could be measured, single-pass loudnorm as fallback.
  // TP -2 (see loudness()): the encode after loudnorm overshoots ~1 dB.
  const masterArgsFor = (measured) => {
    const af = measured
      ? `loudnorm=I=${mTarget}:TP=-2:LRA=11:measured_I=${measured.i}:measured_TP=${measured.tp}:measured_LRA=${measured.lra}:measured_thresh=${measured.thresh}:offset=${measured.offset}:linear=true`
      : `loudnorm=I=${mTarget}:TP=-2:LRA=11`;
    const a = ["-y", "-i", unmasteredPath, "-af", af, "-ar", "48000"];
    if (voiceMeta.video) a.push("-map", "0:v", "-map", "0:a", "-c:v", "copy", "-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
    else a.push("-c:a", audioCodec, ...audioBitrateArgs(audioCodec));
    if (voiceMeta.video && ["mp4", "mov", "m4v"].includes(ext)) a.push("-movflags", "+faststart");
    a.push(outPath);
    return a;
  };
  if (dryRun) {
    // Plan before render (ffmpeg-skill's --dry-run idea): the probe and
    // the loudnorm measurement above are read-only — they ran so the
    // gain in the plan is the real one — but no file is written. With
    // mastering on, the plan lists both passes; the master command is
    // shown without measured_* values because the real run measures the
    // unmastered render first and substitutes them (two-pass).
    const quote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
    const commands = mTarget !== null
      ? [`${FFMPEG} ${renderCmd.map(quote).join(" ")}`, `${FFMPEG} ${masterArgsFor(null).map(quote).join(" ")}`]
      : [`${FFMPEG} ${renderCmd.map(quote).join(" ")}`];
    return {
      operation: "mix",
      dry_run: true,
      voice: voicePath,
      music: musicPath,
      output: outPath,
      music_volume: bedVol,
      duck_db: duck,
      attack_ms: attack,
      release_ms: release,
      sidechain_ratio: ratio,
      voice_lufs_before: voiceLufsBefore,
      voice_lufs_target: vTarget,
      voice_gain_db: voiceGainDb,
      mastered_to_lufs: mTarget,
      mastering: mTarget !== null ? "two-pass" : "none",
      output_lufs: null,
      ducking_measured_db: null,
      sfx: sfxList,
      sfx_count: sfxList.length,
      duration_seconds: voiceDuration,
      has_video: Boolean(voiceMeta.video),
      commands,
      note: "Dry run: no file written. Probes and the loudnorm measurement are read-only; they ran to compute voice_gain_db. With mastering on, the real run renders to <output>.unmastered<ext>, measures it, then masters with the measured values — the master command above is shown without measured_* values.",
    };
  }
  let twoPass = false;
  if (mTarget !== null) {
    try {
      await run(FFMPEG, renderCmd);
      const measured = await measureLoudnessFull(unmasteredPath);
      await run(FFMPEG, masterArgsFor(measured));
      twoPass = measured !== null;
    } finally {
      await rm(unmasteredPath, { force: true }).catch(() => {});
    }
  } else {
    await run(FFMPEG, renderCmd);
  }

  const info = await fileInfo(outPath);
  const outMeta = await probe(outPath);
  const outputLufs = outMeta.audio ? await measureLoudness(outPath) : null;
  // Honest reporting (same rule as loudness()): when the render is
  // peak-limited, even two-pass cannot reach the target — say so.
  const offTarget = mTarget !== null && outputLufs !== null ? +(outputLufs - mTarget).toFixed(1) : null;
  const warning = offTarget !== null && Math.abs(offTarget) > 0.5
    ? `reached ${outputLufs} LUFS, ${Math.abs(offTarget)} LUFS ${offTarget < 0 ? "below" : "above"} target — input is peak-limited (true peak caps the gain); high-pass sub-bass or compress first, then normalize again`
    : null;

  // Measure the ducking actually achieved: a speech window vs a silence
  // window on the ducked bed alone. Speech windows sit 0.1s into a
  // speech stretch; silence windows 0.6s into a silence (past release),
  // so attack/release tails do not pollute the numbers.
  let duckingMeasuredDb = null;
  if (duck > 0) {
    try {
      const det = await detectSilence(voicePath, { thresholdDb: -40, minDuration: 0.5 });
      const silences = det.silences;
      const speechSegs = [];
      let cursor = 0;
      for (const s of silences) {
        if (s.start > cursor) speechSegs.push([cursor, s.start]);
        cursor = Math.max(cursor, s.end);
      }
      if (cursor < voiceDuration) speechSegs.push([cursor, voiceDuration]);
      const speech = speechSegs.find(([a, b]) => b - a >= 0.6);
      const gap = silences.find((s) => s.duration >= 1.1);
      if (speech && gap) {
        const speechVol = await duckedBedVolume(voicePath, musicPath, voiceGainDb, bedVol, duckParams, +(speech[0] + 0.1).toFixed(3), +(speech[0] + 0.5).toFixed(3));
        const gapVol = await duckedBedVolume(voicePath, musicPath, voiceGainDb, bedVol, duckParams, +(gap.start + 0.6).toFixed(3), +(gap.start + 1.0).toFixed(3));
        if (speechVol !== null && gapVol !== null) {
          duckingMeasuredDb = +(gapVol - speechVol).toFixed(1);
        }
      }
    } catch {
      // Measurement is best-effort: the mix itself already succeeded.
      duckingMeasuredDb = null;
    }
  }

  return {
    operation: "mix",
    voice: voicePath,
    music: musicPath,
    output: outPath,
    music_volume: bedVol,
    duck_db: duck,
    attack_ms: attack,
    release_ms: release,
    sidechain_ratio: ratio,
    voice_lufs_before: voiceLufsBefore,
    voice_lufs_target: vTarget,
    voice_gain_db: voiceGainDb,
    mastered_to_lufs: mTarget,
    mastering: mTarget !== null ? "two-pass" : "none",
    two_pass: twoPass,
    output_lufs: outputLufs,
    ...(warning ? { warning } : {}),
    ducking_measured_db: duckingMeasuredDb,
    sfx: sfxList,
    sfx_count: sfxList.length,
    duration_seconds: outMeta.duration_seconds,
    has_video: Boolean(voiceMeta.video),
    ...info,
  };
}

// ---------------------------------------------------------------- overlay
// Logo/watermark image over a video (ffmpeg-mcp's add_image_overlay
// idea, but with named positions instead of free-form expressions:
// free-form x/y strings are an injection surface in a filter graph,
// and an agent should not have to spell "W-w-10" to put a logo in a
// corner). Position is computed in JS from the probed frame size, the
// overlay is scaled to --width keeping aspect, opacity goes through
// colorchannelmixer, and start/end gate it with enable=between().
// The overlay frame is held for the whole video (a still image input
// repeats its last frame), audio is stream-copied.

const OVERLAY_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right", "center"];

export async function overlayImage({
  input, overlay, output,
  position = "top-right", margin = 24, width = null, opacity = 1,
  start = null, end = null,
}) {
  const inPath = await requireInput(input);
  const ovPath = await requireInput(overlay, "overlay image");
  const outPath = await prepareOutput(output, [inPath, ovPath]);
  if (!OVERLAY_POSITIONS.includes(position)) {
    throw new MediaKitError(`overlay position must be one of ${OVERLAY_POSITIONS.join(", ")}, got: ${position}`, "INVALID_ARG");
  }
  const m = num(margin, "margin", { min: 0, integer: true });
  const op = num(opacity, "opacity", { min: 0, max: 1 });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("overlay needs a video input", "INVALID_ARG");
  const ovMeta = await probe(ovPath);
  if (!ovMeta.video) throw new MediaKitError("overlay file must be an image or video", "INVALID_ARG");
  // Geometry is measured on the display frame: decode autorotates,
  // so a phone clip stored 1280x720 with rotation 90 is a 720x1280
  // frame to the overlay filter — positioning from the stored size
  // puts x=1136 on a 720-wide frame and ffmpeg silently draws
  // nothing (measured 2026-11-16: output byte-identical to the
  // plain re-encode). The overlay image/video uses its own display
  // size too, so a rotated overlay video keeps its aspect.
  const disp = displayDims(meta);
  const sw = disp.width;
  const sh = disp.height;
  const ovDisp = displayDims(ovMeta);
  const owNative = ovDisp.width;
  const ohNative = ovDisp.height;
  const ow = width === null || width === undefined ? owNative : num(width, "width", { min: 2, integer: true });
  const oh = Math.max(2, Math.round((ohNative * ow) / owNative));
  if (ow + 2 * m > sw || oh + 2 * m > sh) {
    throw new MediaKitError(`overlay ${ow}x${oh} with margin ${m}px does not fit display ${sw}x${sh} (stored ${meta.video.width}x${meta.video.height}, rotation ${meta.video.rotation ?? "none"}) — use a smaller --width or --margin`, "INVALID_ARG");
  }
  let s = null;
  let e = null;
  if (start !== null && start !== undefined) s = num(start, "start", { min: 0 });
  if (end !== null && end !== undefined) e = num(end, "end", { min: 0 });
  if (s !== null && e !== null && e <= s) throw new MediaKitError(`end (${e}) must be greater than start (${s})`, "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (s !== null && duration !== null && s >= duration) {
    throw new MediaKitError(`start (${s}) is past the end of the video (${duration}s)`, "INVALID_ARG");
  }
  if (e !== null && duration !== null && e > duration) e = duration;
  const x = position === "top-left" || position === "bottom-left" ? m
    : position === "top-right" || position === "bottom-right" ? sw - ow - m
    : Math.floor((sw - ow) / 2);
  const y = position.startsWith("top") ? m
    : position.startsWith("bottom") ? sh - oh - m
    : Math.floor((sh - oh) / 2);
  let enable = "";
  if (s !== null && e !== null) enable = `:enable=between(t\\,${s}\\,${e})`;
  else if (s !== null) enable = `:enable=gte(t\\,${s})`;
  else if (e !== null) enable = `:enable=lte(t\\,${e})`;
  // Opacity 0 means "invisible overlay": still a valid no-op render,
  // but refuse it — it is almost certainly a mistake.
  if (op === 0) throw new MediaKitError("opacity 0 would render nothing — use at least 0.05", "INVALID_ARG");
  const graph = `[1:v]scale=${ow}:-2,format=rgba${op < 1 ? `,colorchannelmixer=aa=${op}` : ""}[ovr];[0:v][ovr]overlay=${x}:${y}${enable}[out]`;
  await run(FFMPEG, [
    "-y", "-i", inPath, "-i", ovPath,
    "-filter_complex", graph, "-map", "[out]", "-map", "0:a?",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
    "-c:a", "copy", "-movflags", "+faststart", outPath,
  ]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "overlay",
    input: inPath, overlay: ovPath, output: outPath,
    position, x, y, margin: m,
    overlay_size: `${ow}x${oh}`,
    opacity: op,
    source_dimensions: `${sw}x${sh}`,
    source_rotation: disp.rotation,
    ...(s !== null ? { visible_from_seconds: s } : {}),
    ...(e !== null ? { visible_until_seconds: e } : {}),
    ...info,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    duration_seconds: out.duration_seconds,
  };
}

// ---------------------------------------------------------------- pip
// Picture-in-picture: a second video over the main one (mcp-video's
// video_edit pip + video-creator/ffmpeg-mcp's overlay_video idea,
// rebuilt on ffmpeg directly). 9 named positions, size by width or by
// fraction of the main width (default 1/4), opacity, optional time
// window (the PiP clip loops with -stream_loop so it never runs out
// inside the window), and audio: main (default, PiP audio dropped),
// pip (PiP audio only), or mix (amix both, levels kept).

const PIP_POSITIONS = [
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export async function pictureInPicture({
  input, pip, output,
  position = "bottom-right", margin = 24, width = null, scale = 0.25,
  opacity = 1, start = null, end = null, audio = "main",
}) {
  const inPath = await requireInput(input);
  const pipPath = await requireInput(pip, "pip video");
  const outPath = await prepareOutput(output, [inPath, pipPath]);
  if (!PIP_POSITIONS.includes(position)) {
    throw new MediaKitError(`pip position must be one of ${PIP_POSITIONS.join(", ")}, got: ${position}`, "INVALID_ARG");
  }
  const m = num(margin, "margin", { min: 0, integer: true });
  const op = num(opacity, "opacity", { min: 0, max: 1 });
  if (op === 0) throw new MediaKitError("opacity 0 would render nothing — use at least 0.05", "INVALID_ARG");
  if (!["main", "pip", "mix"].includes(audio)) {
    throw new MediaKitError(`pip audio must be main|pip|mix, got: ${audio}`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("pip needs a video input", "INVALID_ARG");
  const pipMeta = await probe(pipPath);
  if (!pipMeta.video) throw new MediaKitError("pip file must be a video", "INVALID_ARG");
  // Geometry is measured on the display frame (see overlay above):
  // a rotated main clip is 720 wide to the filter, not 1280, and a
  // rotated PiP clip is portrait to the scale filter, not landscape
  // — sizing it from the stored aspect squashes it (measured
  // 2026-11-16: PiP silently vanished, output byte-identical to the
  // plain re-encode).
  const disp = displayDims(meta);
  const sw = disp.width;
  const sh = disp.height;
  const pipDisp = displayDims(pipMeta);
  const pwRaw = width === null || width === undefined
    ? Math.round(sw * num(scale, "scale", { min: 0.05, max: 0.9 }))
    : num(width, "width", { min: 2, integer: true });
  // Keep even dimensions: yuv420p + overlay chroma subsampling
  // misbehave on odd widths/heights. Scale to explicit pw x ph so the
  // reported size is exactly what ffmpeg renders.
  const pw = Math.max(2, pwRaw - (pwRaw % 2));
  const phRaw = (pipDisp.height * pw) / pipDisp.width;
  const ph = Math.max(2, 2 * Math.round(phRaw / 2));
  if (pw + 2 * m > sw || ph + 2 * m > sh) {
    throw new MediaKitError(`pip ${pw}x${ph} with margin ${m}px does not fit display ${sw}x${sh} (stored ${meta.video.width}x${meta.video.height}, rotation ${meta.video.rotation ?? "none"}) — use a smaller --width/--scale or --margin`, "INVALID_ARG");
  }
  let s = null;
  let e = null;
  if (start !== null && start !== undefined) s = parseTime(start, "start");
  if (end !== null && end !== undefined) e = parseTime(end, "end");
  if (s !== null && e !== null && e <= s) throw new MediaKitError(`end (${e}) must be greater than start (${s})`, "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (s !== null && duration !== null && s >= duration) {
    throw new MediaKitError(`start (${s}) is past the end of the video (${duration}s)`, "INVALID_ARG");
  }
  if (e !== null && duration !== null && e > duration) e = duration;
  const x = position.endsWith("left") ? m
    : position.endsWith("right") ? sw - pw - m
    : Math.floor((sw - pw) / 2);
  const y = position.startsWith("top") ? m
    : position.startsWith("bottom") ? sh - ph - m
    : Math.floor((sh - ph) / 2);
  let enable = "";
  if (s !== null && e !== null) enable = `:enable=between(t\\,${s}\\,${e})`;
  else if (s !== null) enable = `:enable=gte(t\\,${s})`;
  else if (e !== null) enable = `:enable=lte(t\\,${e})`;
  const graph = `[1:v]scale=${pw}:${ph},format=rgba${op < 1 ? `,colorchannelmixer=aa=${op}` : ""}[pipv];[0:v][pipv]overlay=${x}:${y}${enable}[out]`;
  // Audio: main = copy main audio (PiP audio dropped); pip = PiP audio
  // only; mix = amix both, falling back to whichever stream exists.
  // The PiP input loops forever (-stream_loop -1), so the output MUST
  // be capped with -t (main duration): without it the overlay filter
  // keeps pulling frames from the infinite loop and ffmpeg never ends.
  const mainAudio = Boolean(meta.audio);
  const pipAudio = Boolean(pipMeta.audio);
  let audioArgs = [];
  let audioFilter = null;
  if (audio === "main") {
    audioArgs = ["-map", "0:a?", "-c:a", "copy"];
  } else if (audio === "pip") {
    if (!pipAudio) throw new MediaKitError("pip audio=pip needs audio in the pip video", "INVALID_ARG");
    audioArgs = ["-map", "1:a", "-c:a", "aac", "-b:a", "192k"];
  } else {
    if (mainAudio && pipAudio) {
      audioFilter = "[0:a][1:a]amix=inputs=2:normalize=0[aout]";
      audioArgs = ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"];
    } else if (mainAudio) {
      audioArgs = ["-map", "0:a", "-c:a", "copy"];
    } else if (pipAudio) {
      audioArgs = ["-map", "1:a", "-c:a", "aac", "-b:a", "192k"];
    } else {
      audioArgs = [];
    }
  }
  const filterComplex = audioFilter ? `${graph};${audioFilter}` : graph;
  const durationArgs = duration !== null ? ["-t", String(duration)] : [];
  await run(FFMPEG, [
    "-y", "-i", inPath, "-stream_loop", "-1", "-i", pipPath,
    "-filter_complex", filterComplex, "-map", "[out]", ...audioArgs,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
    "-movflags", "+faststart", ...durationArgs, outPath,
  ]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "pip",
    input: inPath, pip: pipPath, output: outPath,
    position, x, y, margin: m,
    pip_size: `${pw}x${ph}`,
    opacity: op,
    audio,
    source_dimensions: `${sw}x${sh}`,
    source_rotation: disp.rotation,
    pip_source_dimensions: `${pipDisp.width}x${pipDisp.height}`,
    ...(s !== null ? { visible_from_seconds: s } : {}),
    ...(e !== null ? { visible_until_seconds: e } : {}),
    ...info,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    duration_seconds: out.duration_seconds,
  };
}

// ---------------------------------------------------------------- broll
// Insert B-roll clips into a main video at timestamps
// (misbahsy/video-audio-mcp's add_b_roll idea, re-implemented the
// MediaKit way): one filter graph, no intermediate files — their
// version renders each clip to a temp file first, then overlays it
// in a second pass. Here the main timeline is never cut: every clip
// is trimmed, scaled and overlaid with enable=between(t,at,end), so
// the output duration is exactly the main duration and a fullscreen
// clip simply covers the frame (opaque overlay) while a corner clip
// is a PiP. A fade on a clip is a true dissolve (alpha fade over the
// main underneath), not a dip to black. The B-roll input loops
// (-stream_loop -1), so a window longer than its clip repeats it
// instead of freezing on the last frame.
// Audio: main (default — main audio copied untouched), broll (main
// audio muted inside each window, B-roll audio takes over — a
// window whose clip has no audio goes silent, reported per clip),
// mix (main + delayed B-roll audio, levels kept).
// Clips must not overlap; a window running past the end of the main
// clip is clamped and reported, never silently trimmed.

const BROLL_MAX_CLIPS = 8;
const BROLL_POSITIONS = ["fullscreen", ...PIP_POSITIONS];

export async function insertBroll({ input, clips, output, audio = "main" }) {
  const inPath = await requireInput(input);
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > BROLL_MAX_CLIPS) {
    throw new MediaKitError(`broll needs 1-${BROLL_MAX_CLIPS} clips, got: ${Array.isArray(clips) ? clips.length : typeof clips}`, "INVALID_ARG");
  }
  if (!["main", "broll", "mix"].includes(audio)) {
    throw new MediaKitError(`broll audio must be main|broll|mix, got: ${audio}`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("broll needs a video input", "INVALID_ARG");
  if (meta.duration_seconds === null || meta.duration_seconds === undefined) {
    throw new MediaKitError("broll needs an input with a measurable duration", "INVALID_ARG");
  }
  const duration = meta.duration_seconds;
  const disp = displayDims(meta);
  const sw = disp.width;
  const sh = disp.height;
  const fmt = (n) => String(Math.round(n * 1000) / 1000);

  // Validate + normalize every clip first: a bad clip fails before
  // any ffmpeg runs, and overlap is checked on the clamped windows
  // (a clamp can only shrink a window, so checking after clamping
  // is the honest order).
  const normalized = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new MediaKitError(`broll clips[${i}] must be an object {file, at, ...}`, "INVALID_ARG");
    }
    for (const k of Object.keys(c)) {
      if (!["file", "at", "duration", "position", "scale", "width", "margin", "fade"].includes(k)) {
        throw new MediaKitError(`broll clips[${i}] does not take "${k}" (only file, at, duration, position, scale, width, margin, fade)`, "INVALID_ARG");
      }
    }
    if (typeof c.file !== "string" || !c.file.trim()) {
      throw new MediaKitError(`broll clips[${i}] needs a file path`, "INVALID_ARG");
    }
    const file = await requireInput(c.file, `broll clip ${i + 1}`);
    const at = parseTime(c.at, `clips[${i}].at`);
    if (at >= duration) {
      throw new MediaKitError(`broll clips[${i}].at (${at}) is past the end of the main video (${duration}s)`, "INVALID_ARG");
    }
    const position = c.position ?? "fullscreen";
    if (!BROLL_POSITIONS.includes(position)) {
      throw new MediaKitError(`broll clips[${i}] position must be one of ${BROLL_POSITIONS.join(", ")}, got: ${position}`, "INVALID_ARG");
    }
    if (position === "fullscreen" && (c.width !== undefined && c.width !== null || c.scale !== undefined && c.scale !== null)) {
      throw new MediaKitError(`broll clips[${i}] is fullscreen — width/scale only apply to PiP positions`, "INVALID_ARG");
    }
    const clipMeta = await probe(file);
    if (!clipMeta.video) throw new MediaKitError(`broll clips[${i}] file must be a video`, "INVALID_ARG");
    let d = c.duration === undefined || c.duration === null
      ? clipMeta.duration_seconds
      : parseTime(c.duration, `clips[${i}].duration`);
    if (d === null || d === undefined || !(d > 0)) {
      throw new MediaKitError(`broll clips[${i}] needs a positive duration (clip has no measurable duration and none was given)`, "INVALID_ARG");
    }
    let clamped = false;
    if (at + d > duration) { d = duration - at; clamped = true; }
    const fade = num(c.fade ?? 0, `clips[${i}].fade`, { min: 0, max: 2 });
    if (fade > d / 2) {
      throw new MediaKitError(`broll clips[${i}].fade (${fade}) must be at most half the window (${(d / 2).toFixed(3)}s)`, "INVALID_ARG");
    }
    const margin = num(c.margin ?? 24, `clips[${i}].margin`, { min: 0, integer: true });
    // Geometry, same math as pip (display frame, even dims): a
    // fullscreen clip covers the whole display frame; a PiP clip is
    // sized from its own display aspect.
    const clipDisp = displayDims(clipMeta);
    let w, h, x, y;
    if (position === "fullscreen") {
      w = sw; h = sh; x = 0; y = 0;
    } else {
      const pwRaw = c.width === null || c.width === undefined
        ? Math.round(sw * num(c.scale ?? 0.5, `clips[${i}].scale`, { min: 0.05, max: 0.9 }))
        : num(c.width, `clips[${i}].width`, { min: 2, integer: true });
      const pw = Math.max(2, pwRaw - (pwRaw % 2));
      const phRaw = (clipDisp.height * pw) / clipDisp.width;
      const ph = Math.max(2, 2 * Math.round(phRaw / 2));
      if (pw + 2 * margin > sw || ph + 2 * margin > sh) {
        throw new MediaKitError(`broll clips[${i}] ${pw}x${ph} with margin ${margin}px does not fit display ${sw}x${sh} — use a smaller width/scale or margin`, "INVALID_ARG");
      }
      w = pw; h = ph;
      x = position.endsWith("left") ? margin
        : position.endsWith("right") ? sw - pw - margin
        : Math.floor((sw - pw) / 2);
      y = position.startsWith("top") ? margin
        : position.startsWith("bottom") ? sh - ph - margin
        : Math.floor((sh - ph) / 2);
    }
    normalized.push({
      file, at, duration: d, end: at + d, position, width: w, height: h,
      x, y, margin, fade, hasAudio: Boolean(clipMeta.audio), clamped,
    });
  }
  normalized.sort((a, b) => a.at - b.at);
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].at < normalized[i - 1].end) {
      throw new MediaKitError(`broll clips overlap: clip at ${normalized[i].at}s starts before the previous window ends at ${normalized[i - 1].end}s`, "INVALID_ARG");
    }
  }
  // Output is prepared only after every clip validates — and the
  // clip files join the guard list, so the output cannot overwrite
  // a B-roll source the same way it cannot overwrite the main input.
  const outPath = await prepareOutput(output, [inPath, ...normalized.map((c) => c.file)]);

  // One filter graph: each clip trimmed to its window (looped input
  // so a short clip repeats), scaled, alpha-faded at both edges,
  // then overlaid in timeline order with enable=between.
  // The last setpts is the load-bearing one: overlay syncs its
  // second input by TIMESTAMP, consuming B-roll frames from main
  // t=0 — without the +at shift the window [at, at+d) shows the
  // clip's [at, at+d) seconds (its first `at` seconds are skipped)
  // and the fades land `at` seconds early (measured 2026-11-18:
  // fade-out ran during main [3,4] instead of [5,6], fade-in was
  // already done when the window opened). Shifting the chain to
  // [at, at+d) makes the overlay pick local 0 at main `at`, so the
  // fade (applied on local time, before the shift) lands exactly.
  const videoChains = [];
  const overlaySteps = [];
  let cur = "[0:v]";
  normalized.forEach((c, i) => {
    const fadeFilters = c.fade > 0
      ? `,fade=t=in:st=0:d=${fmt(c.fade)}:alpha=1,fade=t=out:st=${fmt(c.duration - c.fade)}:d=${fmt(c.fade)}:alpha=1`
      : "";
    videoChains.push(`[${i + 1}:v]trim=0:${fmt(c.duration)},setpts=PTS-STARTPTS,scale=${c.width}:${c.height},format=rgba${fadeFilters},setpts=PTS+${fmt(c.at)}/TB[bv${i}]`);
    overlaySteps.push(`${cur}[bv${i}]overlay=${c.x}:${c.y}:enable=between(t\\,${fmt(c.at)}\\,${fmt(c.end)})[v${i}]`);
    cur = `[v${i}]`;
  });
  const graph = [...videoChains, ...overlaySteps].join(";");

  // Audio: main copies the main track; broll mutes the main track
  // inside each window (volume enable, one expression per window
  // joined with +) and mixes in the delayed B-roll tracks; mix
  // keeps the main track and adds the delayed B-roll tracks.
  const mainAudio = Boolean(meta.audio);
  const audioNotes = [];
  let audioArgs = [];
  let audioFilter = null;
  if (audio === "main") {
    audioArgs = ["-map", "0:a?", "-c:a", "copy"];
  } else {
    const branches = [];
    if (mainAudio) {
      if (audio === "broll") {
        const windows = normalized.map((c) => `between(t\\,${fmt(c.at)}\\,${fmt(c.end)})`).join("+");
        audioFilter = `[0:a]volume=0:enable=${windows}[amain]`;
        branches.push("[amain]");
      } else {
        branches.push("[0:a]");
      }
    }
    normalized.forEach((c, i) => {
      if (!c.hasAudio) {
        if (audio === "broll") audioNotes.push(`window at ${fmt(c.at)}s has no B-roll audio — it goes silent`);
        return;
      }
      audioFilter = (audioFilter ? `${audioFilter};` : "") + `[${i + 1}:a]atrim=0:${fmt(c.duration)},asetpts=PTS-STARTPTS,adelay=${Math.round(c.at * 1000)}:all=1[ba${i}]`;
      branches.push(`[ba${i}]`);
    });
    if (branches.length === 0) {
      audioArgs = [];
      audioNotes.push("no audio in the main video or any B-roll clip — output has no audio track");
    } else if (branches.length === 1) {
      // A raw input stream maps as 0:a (no brackets — "[0:a]" is
      // only a label inside a filter graph, and -map rejects it
      // once a filter_complex exists); a filtered branch maps by
      // its filter label.
      const mapTarget = branches[0] === "[0:a]" ? "0:a" : branches[0];
      audioArgs = ["-map", mapTarget, "-c:a", "aac", "-b:a", "192k"];
    } else {
      audioFilter = `${audioFilter ? `${audioFilter};` : ""}${branches.join("")}amix=inputs=${branches.length}:normalize=0[aout]`;
      audioArgs = ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"];
    }
  }
  const filterComplex = audioFilter ? `${graph};${audioFilter}` : graph;
  const args = ["-y", "-i", inPath];
  normalized.forEach((c) => { args.push("-stream_loop", "-1", "-i", c.file); });
  args.push(
    "-filter_complex", filterComplex, "-map", cur,
    ...audioArgs,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
    "-movflags", "+faststart", "-t", String(duration), outPath,
  );
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "broll",
    input: inPath, output: outPath,
    audio,
    ...(audioNotes.length ? { audio_notes: audioNotes } : {}),
    clips: normalized.map((c) => ({
      file: c.file, at: c.at, duration_seconds: +c.duration.toFixed(3),
      end_seconds: +c.end.toFixed(3), position: c.position,
      x: c.x, y: c.y, size: `${c.width}x${c.height}`,
      fade_seconds: c.fade, has_audio: c.hasAudio, clamped: c.clamped,
    })),
    source_dimensions: `${sw}x${sh}`,
    source_rotation: disp.rotation,
    ...info,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    duration_seconds: out.duration_seconds,
    has_audio: Boolean(out.audio),
  };
}

// ---------------------------------------------------------------- scenes
// Detect scene changes / hard cuts (ffmpeg-mcp's detect_scene_changes
// idea): ffprobe over a lavfi movie source with select=gt(scene,threshold).
// Returns the cut timestamps plus the segments between them, so a caller
// can trim on real boundaries instead of guessing. Probe-only: no file
// is written. The lavfi path is escaped for the filter parser
// (backslash -> /, : -> \:, ' -> \'); the command itself still goes
// through execFile with no shell.
//
// detector "content" (PySceneDetect's ContentDetector idea, measured
// with ffmpeg only — no OpenCV): per-frame mean Y/U/V from signalstats,
// scored as the mean of three independent 0-1 terms — hue distance
// (weighted by the smaller saturation, because hue is meaningless on
// grey), saturation distance, luma distance. A flat red->dark-green cut
// (same luma, hue+sat only) scores 0.183 while continuous testsrc2
// never exceeds 0.005, so the default threshold 0.05 sits 3.4x below
// the weakest measured flat cut and 10x above the noisiest continuous
// frame. The ffmpeg detector misses that cut entirely (its scene
// metric is luma-driven: it scores red->blue 0.4 but red->green 0).
// Two PySceneDetect filters ride on the candidate list: min_scene_len
// (frames; a cut is dropped when the scene it would open is shorter
// than this) and the flash filter (a cut followed within flash_frames
// by another cut whose content matches the frame before the first cut
// is a 1-frame blip, not a scene — both cuts are dropped). Fades
// (PySceneDetect's ThresholdDetector idea) come from the same stats
// pass: runs of frames with mean luma at/below fade_threshold are the
// dark core of a fade; the ramp is measured outward from the core
// while the luma keeps moving (>=1 unit/frame, 2-frame grace), so a
// 1s fade-in on the fixture reports 0-1.0s, not just its 3-frame dark
// core. Files over 20 minutes are refused: the per-frame JSON would
// approach run()'s 16 MB capture buffer (same cap as hook).

const SCENES_MAX_DURATION_SECONDS = 1200;
const CONTENT_DETECTOR_DEFAULT_THRESHOLD = 0.05;
const CONTENT_DETECTOR_DEFAULT_MIN_SCENE_LEN = 15;
const CONTENT_DETECTOR_DEFAULT_FLASH_FRAMES = 5;
const FADES_DEFAULT_THRESHOLD = 20;
const FADES_DEFAULT_MIN_FRAMES = 2;

function hueSatOf(u, v) {
  const du = u - 128, dv = v - 128;
  return { sat: Math.sqrt(du * du + dv * dv), hue: Math.atan2(dv, du) };
}

// Content change between two frames, 0-1 (mean of hue/sat/luma terms).
function contentScore(a, b) {
  const ha = hueSatOf(a.u, a.v), hb = hueSatOf(b.u, b.v);
  const dluma = Math.abs(b.y - a.y) / 255;
  const dsat = Math.abs(hb.sat - ha.sat) / 181;
  let dhue = Math.abs(hb.hue - ha.hue);
  if (dhue > Math.PI) dhue = 2 * Math.PI - dhue;
  const hueTerm = (dhue / Math.PI) * (Math.min(ha.sat, hb.sat) / 181);
  return (hueTerm + dsat + dluma) / 3;
}

async function frameColorStats(input) {
  const escaped = input.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const { stdout } = await run(FFPROBE, [
    "-v", "quiet", "-print_format", "json",
    "-show_entries", "frame=best_effort_timestamp_time:frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.UAVG,lavfi.signalstats.VAVG",
    "-f", "lavfi", `movie=${escaped},signalstats`,
  ]);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new MediaKitError("ffprobe returned unparseable output", "PROBE_FAILED");
  }
  const frames = [];
  for (const f of data.frames ?? []) {
    const t = f.tags ?? {};
    const y = parseFloat(t["lavfi.signalstats.YAVG"]);
    const u = parseFloat(t["lavfi.signalstats.UAVG"]);
    const v = parseFloat(t["lavfi.signalstats.VAVG"]);
    const pts = parseFloat(f.best_effort_timestamp_time ?? NaN);
    if (!Number.isFinite(y) || !Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(pts)) continue;
    frames.push({ pts, y, u, v });
  }
  return frames;
}

// Dark runs (mean luma <= fadeThreshold, at least minFadeFrames long)
// with the fade ramp measured outward from each core. type: "in" when
// the core touches frame 0, "out" when it touches the last frame,
// "black" in the middle (a fade-out + fade-in pair with no gap).
function detectFades(frames, { fadeThreshold, minFadeFrames, duration }) {
  const dark = frames.map((f) => f.y <= fadeThreshold);
  const runs = [];
  for (let i = 0; i < frames.length;) {
    if (!dark[i]) { i++; continue; }
    let j = i;
    while (j + 1 < frames.length && dark[j + 1]) j++;
    if (j - i + 1 >= minFadeFrames) runs.push([i, j]);
    i = j + 1;
  }
  const fades = [];
  for (const [a, b] of runs) {
    const frameDur = frames.length > 1 ? (frames[frames.length - 1].pts - frames[0].pts) / (frames.length - 1) : 0;
    const darkStart = +frames[a].pts.toFixed(3);
    const darkEnd = +(Math.min(frames[b].pts + frameDur, duration ?? frames[b].pts + frameDur)).toFixed(3);
    let start = darkStart, end = darkEnd;
    const type = a === 0 ? "in" : b === frames.length - 1 ? "out" : "black";
    // Ramp out: walk while luma keeps moving >=1 unit/frame, allowing
    // 2 consecutive stalled frames (encoder noise) before stopping.
    const extendForward = (fromIdx) => {
      let last = fromIdx, stalls = 0;
      for (let i = fromIdx + 1; i < frames.length; i++) {
        if (frames[i].y - frames[i - 1].y >= 1) { last = i; stalls = 0; }
        else if (++stalls >= 2) break;
      }
      return last;
    };
    const extendBackward = (fromIdx) => {
      let first = fromIdx, stalls = 0;
      for (let i = fromIdx - 1; i >= 0; i--) {
        if (frames[i].y - frames[i + 1].y >= 1) { first = i; stalls = 0; }
        else if (++stalls >= 2) break;
      }
      return first;
    };
    if (type === "in" || type === "black") {
      const last = extendForward(b);
      end = +(Math.min(frames[last].pts + frameDur, duration ?? frames[last].pts + frameDur)).toFixed(3);
    }
    if (type === "out" || type === "black") {
      const first = extendBackward(a);
      start = +frames[first].pts.toFixed(3);
    }
    fades.push({
      type,
      start,
      end,
      duration_seconds: +(end - start).toFixed(3),
      dark_start: darkStart,
      dark_end: darkEnd,
    });
  }
  return fades;
}

export async function detectScenes({
  input,
  threshold = null,
  detector = "ffmpeg",
  minSceneLen = CONTENT_DETECTOR_DEFAULT_MIN_SCENE_LEN,
  flashFrames = CONTENT_DETECTOR_DEFAULT_FLASH_FRAMES,
  fades = false,
  fadeThreshold = FADES_DEFAULT_THRESHOLD,
  minFadeFrames = FADES_DEFAULT_MIN_FRAMES,
}) {
  const inPath = await requireInput(input);
  const det = String(detector ?? "ffmpeg");
  if (det !== "ffmpeg" && det !== "content") {
    throw new MediaKitError(`detector must be "ffmpeg" or "content", got "${det}"`, "INVALID_ARG");
  }
  const t = num(threshold ?? (det === "content" ? CONTENT_DETECTOR_DEFAULT_THRESHOLD : 0.3), "threshold", { min: 0, max: 1 });
  const minLen = num(minSceneLen, "min_scene_len", { min: 1, integer: true });
  const flashLen = num(flashFrames, "flash_frames", { min: 0, integer: true });
  const fadeT = num(fadeThreshold, "fade_threshold", { min: 0, max: 255 });
  const minFade = num(minFadeFrames, "min_fade_frames", { min: 1, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("scenes needs a video input", "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (duration !== null && duration > SCENES_MAX_DURATION_SECONDS && (det === "content" || fades)) {
    throw new MediaKitError(`scenes with detector=content or fades refuses files over ${SCENES_MAX_DURATION_SECONDS}s (per-frame stats would exceed the capture buffer) — trim a section first`, "INVALID_ARG");
  }

  let changes, extra = {};
  let colorFrames = null;
  if (det === "ffmpeg") {
    const escaped = inPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const { stdout } = await run(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_frames",
      "-f", "lavfi", `movie=${escaped},select=gt(scene\\,${t})`,
    ]);
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new MediaKitError("ffprobe returned unparseable output", "PROBE_FAILED");
    }
    const raw = (data.frames ?? [])
      .map((f) => parseFloat(f.best_effort_timestamp_time ?? NaN))
      .filter((v) => Number.isFinite(v))
      .map((v) => +v.toFixed(3));
    // The first frame has no predecessor, so a hit at ~0 is not a cut.
    changes = [...new Set(raw)].filter((v) => v > 0.05).sort((a, b) => a - b);
  } else {
    const frames = await frameColorStats(inPath);
    colorFrames = frames;
    if (frames.length < 2) {
      changes = [];
    } else {
      // Candidate cuts: content score between consecutive frames.
      const candidates = [];
      for (let i = 1; i < frames.length; i++) {
        if (contentScore(frames[i - 1], frames[i]) > t) candidates.push(i);
      }
      const candidateCount = candidates.length;
      // Flash filter: a cut followed within flash_frames by another
      // cut whose content matches the frame before the first cut is a
      // blip, not a scene — drop both.
      let droppedFlash = 0;
      const afterFlash = [];
      const used = new Set();
      for (let k = 0; k < candidates.length; k++) {
        if (used.has(k)) continue;
        const i = candidates[k];
        let paired = -1;
        for (let m = k + 1; m < candidates.length; m++) {
          const j = candidates[m];
          if (j - i > flashLen) break;
          if (contentScore(frames[i - 1], frames[j]) <= t) { paired = m; break; }
        }
        if (paired >= 0) {
          used.add(k); used.add(paired); droppedFlash += 2;
        } else {
          afterFlash.push(i);
        }
      }
      // min_scene_len: drop a cut when the scene it would open is
      // shorter than this many frames.
      let droppedShort = 0;
      const kept = [];
      let lastKept = 0;
      for (const i of afterFlash) {
        if (i - lastKept < minLen) { droppedShort++; continue; }
        kept.push(i);
        lastKept = i;
      }
      changes = kept.map((i) => +frames[i].pts.toFixed(3));
      extra = {
        candidates: candidateCount,
        filtered: { flash: droppedFlash, min_scene_len: droppedShort },
        min_scene_len_frames: minLen,
        flash_frames: flashLen,
      };
    }
  }

  const result = {
    operation: "scenes",
    input: inPath,
    detector: det,
    threshold: t,
    duration_seconds: duration,
    scene_changes: changes,
    count: changes.length,
    ...extra,
  };
  if (fades) {
    // Reuse the content detector's stats pass when available.
    const frames = colorFrames ?? await frameColorStats(inPath);
    result.fades = detectFades(frames, { fadeThreshold: fadeT, minFadeFrames: minFade, duration });
  }
  const bounds = [0, ...changes, ...(duration !== null ? [duration] : [])];
  const segments = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    segments.push({
      start: +bounds[i].toFixed(3),
      end: +bounds[i + 1].toFixed(3),
      duration_seconds: +(bounds[i + 1] - bounds[i]).toFixed(3),
    });
  }
  result.segments = segments;
  return result;
}

// ---------------------------------------------------------------- hook
// Find the best hook window in a clip (sonic-match-mcp's hook_window
// idea, measured from the footage instead of a script): slide a
// window of --duration across the file and score each candidate on
// three measured signals — mean audio energy (astats RMS per frame,
// binned and normalized against the file's own loudest bin), speech
// coverage (silencedetect complement), and scene cuts (a window that
// opens on a cut, plus cuts inside it, reads as a new beat). The
// score is 0.5*energy + 0.3*speech + 0.2*cut; the weights are fixed
// so two runs on the same file rank the same way. Top candidates are
// greedy non-overlapping (overlap under half the hook length), so
// the list is alternatives, not the same window shifted by one step.
// Probe-only: no file is written. The suggested_trim is a real
// command that cuts the winning window. Video-only input scores on
// cuts alone (energy/speech 0, noted in warnings); audio-only scores
// on energy+speech (cuts 0). astats prints ~2 log lines per audio
// frame (~11 KB/s), and run() caps stderr at 16 MB, so files over
// 20 minutes are refused with a clear error instead of dying on a
// buffer limit — hook is a short-form tool anyway.
const HOOK_ENERGY_FLOOR_DB = -60;
const HOOK_MAX_DURATION_SECONDS = 1200;

async function energyCurveDb(input, step) {
  const { stderr } = await run(FFMPEG, [
    "-i", input, "-vn",
    "-af", "astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-",
  ]);
  const bins = new Map();
  let lastPts = null;
  for (const line of stderr.split("\n")) {
    const pts = line.match(/pts_time:([0-9.]+)/);
    if (pts) { lastPts = parseFloat(pts[1]); continue; }
    const rms = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+|-inf)/);
    if (rms && lastPts !== null) {
      const db = rms[1] === "-inf" ? HOOK_ENERGY_FLOOR_DB : parseFloat(rms[1]);
      const bin = Math.floor(lastPts / step);
      const acc = bins.get(bin) ?? { sum: 0, n: 0 };
      acc.sum += Number.isFinite(db) ? db : HOOK_ENERGY_FLOOR_DB;
      acc.n += 1;
      bins.set(bin, acc);
    }
  }
  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bin, acc]) => ({ t: +(bin * step).toFixed(3), energy_db: +(acc.sum / acc.n).toFixed(2) }));
}

// ---------------------------------------------------------------- hook history
// Clip history (podcli's clip-history idea, lượt 99): a JSON file of
// hook windows already cut/published, keyed by the source file's
// sha256. `hook --history-file` checks every candidate against it so
// the director never re-suggests a moment that already shipped, and
// `--record` appends the winning window after the run. Duplicate =
// same source sha256 AND overlap >= history_overlap (default 0.5) of
// the SHORTER window — a 10s window overlapping a recorded 10s window
// by 5s is a duplicate; a window merely touching it is not. Only the
// winner is recorded, never the also-ran candidates: the alternatives
// were never cut, so they stay eligible. A corrupt history file fails
// loudly (unknown is not missing); a missing file is an empty
// history, not an error — the first run creates it. Appends are
// atomic (.partial + rename, like patch_manifest) under a lockdir so
// parallel batch workers cannot clobber each other's record (mkdir is
// atomic; a lock older than 30s is stolen, so a crashed worker never
// blocks the file forever). The manifest cache key hashes the history
// file (MANIFEST_FILE_ARGS) and the batch cache key hashes it via
// spec.extraHash, so recording a window invalidates the cached hook
// result instead of serving stale duplicate flags.
const HOOK_HISTORY_VERSION = 1;

export function hookOverlapSeconds(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function hookDuplicateOf(window, records, overlapThreshold = 0.5) {
  const len = window.end - window.start;
  if (!(len > 0)) return null;
  for (const r of records) {
    const overlap = hookOverlapSeconds(window, r);
    const shorter = Math.min(len, r.end - r.start);
    if (shorter > 0 && overlap / shorter >= overlapThreshold) {
      return {
        start: r.start,
        end: r.end,
        score: typeof r.score === "number" ? r.score : null,
        recorded_at: typeof r.recorded_at === "string" ? r.recorded_at : null,
        overlap_seconds: +overlap.toFixed(3),
      };
    }
  }
  return null;
}

async function loadHookHistory(historyFile) {
  let raw;
  try {
    raw = await readFile(historyFile, "utf8");
  } catch {
    return { version: HOOK_HISTORY_VERSION, records: [] }; // missing file = empty history
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new MediaKitError(`hook history file is not valid JSON: ${historyFile}`, "INVALID_ARG");
  }
  if (!doc || doc.version !== HOOK_HISTORY_VERSION || !Array.isArray(doc.records)) {
    throw new MediaKitError(`hook history file has the wrong shape (want {version: 1, records: [...]}): ${historyFile}`, "INVALID_ARG");
  }
  for (const r of doc.records) {
    if (typeof r?.source_sha256 !== "string" || typeof r?.start !== "number" || typeof r?.end !== "number" || !(r.end > r.start)) {
      throw new MediaKitError(`hook history file has a bad record (want {source_sha256, start, end, ...}): ${historyFile}`, "INVALID_ARG");
    }
  }
  return doc;
}

async function appendHookHistory(historyFile, record) {
  const abs = await prepareOutput(historyFile, []);
  const lockDir = `${abs}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch {
      // Lock held: wait a tick, or steal it if the holder crashed
      // (mtime older than 30s) instead of waiting forever.
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.mtimeMs > 30_000) await rm(lockDir, { recursive: true, force: true });
      } catch { /* lock vanished between mkdir and stat: retry */ }
      if (Date.now() > deadline) throw new MediaKitError(`hook history file is locked by another run: ${historyFile}`, "ERROR");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    const doc = await loadHookHistory(abs);
    const already = doc.records.some((r) => r.source_sha256 === record.source_sha256 && r.start === record.start && r.end === record.end);
    if (!already) doc.records.push(record);
    const partial = `${abs}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(partial, JSON.stringify(doc, null, 2), "utf8");
    await rename(partial, abs);
    return doc.records.length;
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function findHook({ input, duration = 15, step = 0.5, top = 3, thresholdDb = -40, historyFile = null, record = false, historyOverlap = 0.5 }) {
  const inPath = await requireInput(input);
  const hookDur = num(duration, "duration", { min: 4, max: 20 });
  const stepSec = num(step, "step", { min: 0.25, max: 2 });
  const topN = num(top, "top", { min: 1, max: 5, integer: true });
  const threshold = num(thresholdDb, "threshold_db", { min: -90, max: 0 });
  const overlapThreshold = num(historyOverlap, "history_overlap", { min: 0.05, max: 1 });
  if (record !== false && record !== true) throw new MediaKitError(`record must be true or false, got: ${record}`, "INVALID_ARG");
  const historyAbs = historyFile === null || historyFile === undefined ? null : path.resolve(String(historyFile));
  if (record && !historyAbs) throw new MediaKitError("hook --record needs --history-file: there is nowhere to record the window", "INVALID_ARG");
  if (historyAbs) await assertInsideWorkdir(historyAbs, "history file");
  const meta = await probe(inPath);
  const total = meta.duration_seconds;
  if (total === null) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  if (total > HOOK_MAX_DURATION_SECONDS) {
    throw new MediaKitError(`hook refuses files over ${HOOK_MAX_DURATION_SECONDS}s (astats log would exceed the capture buffer) — trim a section first`, "INVALID_ARG");
  }
  const warnings = [];
  // Energy curve (audio only) and speech coverage (silence complement).
  let energyBins = [];
  let silences = [];
  let speechSeconds = 0;
  if (meta.audio) {
    energyBins = await energyCurveDb(inPath, stepSec);
    const det = await detectSilence(inPath, { thresholdDb: threshold, minDuration: 0.25 });
    silences = det.silences;
    speechSeconds = total - silences.reduce((a, s) => a + (s.end - s.start), 0);
  } else {
    warnings.push("no audio stream — scored on scene cuts only (energy/speech 0)");
  }
  // Scene cuts (video only).
  let cuts = [];
  if (meta.video) {
    cuts = (await detectScenes({ input: inPath })).scene_changes;
  } else {
    warnings.push("no video stream — no scene cuts to score");
  }
  const maxDb = energyBins.length ? Math.max(...energyBins.map((b) => b.energy_db)) : null;
  // All-silent file: maxDb sits on the floor, span is 0 — every bin
  // is 0 energy, not NaN (caught in review before any test ran).
  const energySpan = maxDb === null ? 0 : maxDb - HOOK_ENERGY_FLOOR_DB;
  const binCount = Math.max(1, Math.ceil(total / stepSec));
  const curve = [];
  for (let i = 0; i < binCount; i++) {
    const t = +(i * stepSec).toFixed(3);
    const binEnd = Math.min(total, t + stepSec);
    const found = energyBins.find((b) => Math.abs(b.t - t) < 0.001);
    const db = found ? found.energy_db : null;
    const energy = db === null || energySpan <= 0 ? 0
      : +Math.min(1, Math.max(0, (db - HOOK_ENERGY_FLOOR_DB) / energySpan)).toFixed(3);
    const silenceOverlap = silences.reduce((a, s) => a + Math.max(0, Math.min(s.end, binEnd) - Math.max(s.start, t)), 0);
    const speech = meta.audio ? +Math.min(1, Math.max(0, 1 - silenceOverlap / (binEnd - t))).toFixed(3) : 0;
    curve.push({ t, energy_db: db, energy, speech });
  }
  const binAt = (t) => curve[Math.min(curve.length - 1, Math.floor(t / stepSec))];
  const meanOver = (start, end, key) => {
    let sum = 0; let n = 0;
    for (let t = start; t < end - 0.001; t += stepSec) { sum += binAt(t)[key]; n++; }
    return n ? sum / n : 0;
  };
  const scored = [];
  const effDur = Math.min(hookDur, total);
  if (effDur >= total - 0.001) {
    scored.push({ start: 0, end: +total.toFixed(3) });
  } else {
    for (let s = 0; s + effDur <= total + 0.001; s += stepSec) {
      scored.push({ start: +s.toFixed(3), end: +(s + effDur).toFixed(3) });
    }
  }
  for (const w of scored) {
    const energy = +meanOver(w.start, w.end, "energy").toFixed(3);
    const speech = +meanOver(w.start, w.end, "speech").toFixed(3);
    const cutsInside = cuts.filter((c) => c > w.start && c < w.end).length;
    const startsNearCut = cuts.some((c) => Math.abs(c - w.start) <= 0.75);
    const cutScore = +(0.6 * (startsNearCut ? 1 : 0) + 0.4 * (Math.min(cutsInside, 3) / 3)).toFixed(3);
    w.energy = energy;
    w.speech = speech;
    w.cuts_inside = cutsInside;
    w.starts_near_cut = startsNearCut;
    w.cut_score = cutScore;
    w.score = +(0.5 * energy + 0.3 * speech + 0.2 * cutScore).toFixed(3);
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start);
  const candidates = [];
  for (const w of scored) {
    if (candidates.length >= topN) break;
    const overlaps = candidates.some((p) => Math.min(p.end, w.end) - Math.max(p.start, w.start) >= effDur / 2);
    if (!overlaps) candidates.push(w);
  }
  const best = candidates[0];
  const cutsPerMinute = meta.video ? +(cuts.length / (total / 60)).toFixed(1) : null;
  const pacing = cutsPerMinute === null ? null : cutsPerMinute < 6 ? "slow" : cutsPerMinute <= 20 ? "medium" : "fast-cut";
  if (effDur < hookDur) warnings.push(`file is ${total}s, shorter than --duration ${hookDur}s — the whole file is the only window`);
  // Clip history: same source (sha256) + overlap >= threshold of the
  // shorter window marks a candidate a duplicate of a moment already
  // cut. Without a history file every candidate is fresh (duplicate
  // false, not "unknown") — the absence of a file is not a verdict.
  let history = null;
  if (historyAbs) {
    const sourceSha256 = await hashFile(inPath);
    const doc = await loadHookHistory(historyAbs);
    const sameSource = doc.records.filter((r) => r.source_sha256 === sourceSha256);
    let duplicatesFound = 0;
    for (const w of candidates) {
      const dup = hookDuplicateOf(w, sameSource, overlapThreshold);
      w.duplicate = dup !== null;
      w.duplicate_of = dup;
      if (dup) duplicatesFound++;
    }
    let recorded = false;
    let recordsTotal = doc.records.length;
    if (record && best && !best.duplicate) {
      recordsTotal = await appendHookHistory(historyAbs, {
        source_sha256: sourceSha256,
        source: path.basename(inPath),
        start: best.start,
        end: best.end,
        score: best.score,
        recorded_at: new Date().toISOString(),
      });
      recorded = true;
    }
    history = { file: historyAbs, records_checked: sameSource.length, duplicates_found: duplicatesFound, recorded, records_total: recordsTotal };
  } else {
    for (const w of candidates) { w.duplicate = false; w.duplicate_of = null; }
  }
  return {
    operation: "hook",
    input: inPath,
    duration_seconds: total,
    hook_duration_seconds: effDur,
    step_seconds: stepSec,
    speech_coverage: meta.audio ? +Math.min(1, Math.max(0, speechSeconds / total)).toFixed(3) : null,
    energy_curve: curve,
    cuts_per_minute: cutsPerMinute,
    pacing,
    candidates,
    hook: best,
    suggested_trim: `mediakit trim ${inPath} -o hook.mp4 --start ${best.start} --end ${best.end}`,
    history,
    warnings,
  };
}

// ---------------------------------------------------------------- bpm
// Measure the musical tempo of a clip (the missing piece before
// beat-grid cut snapping, backlog since turn 68): decode the audio to
// mono float PCM, build a spectral-flux onset function, then find the
// period by autocorrelation + a shift-invariant comb filterbank —
// aubio's tempo pipeline (phase vocoder -> onset function -> peak
// picker -> beattracking autocorrelation + comb), re-implemented in
// pure Node with no new dependency. Three traps, each found by
// measuring the probe in /tmp before any of this shipped:
//  (1) Integer lags lie: 120 BPM is 21.53 flux frames, and the DOUBLE
//      period (43.06, nearly integer) out-scored the true one, so the
//      comb is evaluated at FRACTIONAL lags via linear interpolation
//      of the autocorrelation, and the winning lag is refined by a
//      parabola through comb(L-0.5), comb(L), comb(L+0.5) — a 150 BPM
//      click track read as 152 before the refinement, 150.7 after.
//  (2) A click is a 1-2 frame spike, and linear ACF interpolation
//      between a spike frame and a zero frame halves the value at
//      fractional lags — so the flux is smoothed with a [1,2,1]
//      kernel before any correlation.
//  (3) Octaves are genuinely ambiguous on comb alone: a 120 BPM drum
//      pattern (kick + off-beat hat) scores identically at 60/120/240.
//      Two tie-breaks, in order: a log-normal prior centred at 120 BPM
//      (sigma 0.8 in log space — aubio's Rayleigh period weighting,
//      same idea: 240 BPM keeps 69% of its score, 90 BPM 94%), then
//      onset recall among candidates within 90% of the best weighted
//      score — the fraction of strong onsets (weighted by flux) that
//      land within a quarter-period of the grid. A 60 BPM grid on 120
//      BPM clicks recalls 0.52; the true grid recalls 1.0.
// Probe-only: no file is written. The beat grid (first 16 beats) is
// what the future beat-snapping cut will snap to. A steady tone has
// no onsets (confidence 0) and speech scores ~0.09 — both report
// reliable: false instead of a confident wrong number. Files over 10
// minutes are refused (the raw PCM would be ~53 MB); under 4s there
// are too few beats to trust.
const BPM_SAMPLE_RATE = 22050;
const BPM_MAX_DURATION_SECONDS = 600;
const BPM_MIN_DURATION_SECONDS = 4;
const BPM_RELIABLE_CONFIDENCE = 0.35;

// Iterative radix-2 FFT, in place on (re, im). Pure — unit-tested
// through spectralFluxOnset/estimateTempo without spawning ffmpeg.
function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

// Spectral-flux onset function (aubio's "specdiff"): 1024-point FFT,
// 512 hop, Hann window; flux is the sum of positive magnitude
// differences per bin. Returns the smoothed flux (for correlation),
// the raw flux (for onset events) and the flux frame rate.
export function spectralFluxOnset(samples, sampleRate) {
  const WIN = 1024, HOP = 512;
  const hann = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));
  const re = new Float64Array(WIN), im = new Float64Array(WIN);
  const prev = new Float64Array(WIN / 2 + 1);
  const raw = [];
  for (let start = 0; start + WIN <= samples.length; start += HOP) {
    for (let i = 0; i < WIN; i++) { re[i] = samples[start + i] * hann[i]; im[i] = 0; }
    fftRadix2(re, im);
    let f = 0;
    for (let k = 0; k <= WIN / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const d = mag - prev[k];
      if (d > 0) f += d;
      prev[k] = mag;
    }
    raw.push(f);
  }
  const flux = raw.map((v, i) => ((raw[i - 1] ?? 0) + 2 * v + (raw[i + 1] ?? 0)) / 4);
  return { flux, rawFlux: raw, fps: sampleRate / HOP };
}

// Pure tempo estimation from a flux curve: autocorrelation + comb
// filterbank + 120 BPM prior + onset-recall tie-break (see the bpm
// header). Returns bpm (1 decimal), confidence 0-1, reliable flag,
// the beat period in flux frames, onset recall, event count, and the
// first maxBeats beat times in seconds (16 by default — the grid a
// cut snaps to; beat_grid asks for the whole file). Unit-tested on a
// synthetic flux train without touching ffmpeg.
export function estimateTempo(flux, fps, rawFlux = flux, minBpm = 40, maxBpm = 240, maxBeats = 16) {
  const n = flux.length;
  if (n < 8) return { bpm: null, confidence: 0, reliable: false, lag: null, onset_recall: 0, onsets_detected: 0, first_beat_seconds: null, beats: [], reason: "too few flux frames" };
  const mean = flux.reduce((a, b) => a + b, 0) / n;
  const x = flux.map((v) => v - mean);
  const acf0 = x.reduce((a, v) => a + v * v, 0);
  if (acf0 <= 0) return { bpm: null, confidence: 0, reliable: false, lag: null, onset_recall: 0, onsets_detected: 0, first_beat_seconds: null, beats: [], reason: "no onset energy" };
  const minLag = Math.max(1, Math.floor((fps * 60) / maxBpm));
  const maxLag = Math.min(n - 1, Math.ceil((fps * 60) / minBpm));
  const acfMax = Math.min(n - 1, 3 * maxLag);
  const acfArr = new Float64Array(acfMax + 1);
  for (let lag = 0; lag <= acfMax; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += x[i] * x[i + lag];
    acfArr[lag] = s;
  }
  const acfF = (lag) => {
    if (lag <= 0) return acf0;
    if (lag >= acfMax) return 0;
    const lo = Math.floor(lag), frac = lag - lo;
    return acfArr[lo] * (1 - frac) + acfArr[lo + 1] * frac;
  };
  const combF = (lag) => acfF(lag) + 0.5 * acfF(2 * lag) + 0.25 * acfF(3 * lag);
  const prior = (bpm) => Math.exp(-((Math.log(bpm / 120)) ** 2) / (2 * 0.8 * 0.8));
  const cands = [];
  for (let bpm = minBpm; bpm <= maxBpm + 0.001; bpm += 0.1) {
    const lag = (fps * 60) / bpm;
    if (lag < minLag || lag > maxLag) continue;
    cands.push({ bpm: +bpm.toFixed(1), lag, score: combF(lag) * prior(bpm) });
  }
  if (!cands.length) return { bpm: null, confidence: 0, reliable: false, lag: null, onset_recall: 0, onsets_detected: 0, first_beat_seconds: null, beats: [], reason: "no candidate period in range" };
  let best = cands[0];
  for (const c of cands) if (c.score > best.score) best = c;
  // Onset events from the raw flux: runs above 25% of max, weighted
  // by their peak flux (a drum pattern's quiet off-beat hats must not
  // veto the kick grid, so recall is flux-weighted).
  const maxFlux = Math.max(...rawFlux);
  const events = [];
  {
    let runStart = -1, runBest = -1;
    for (let i = 0; i <= n; i++) {
      const above = i < n && rawFlux[i] >= 0.25 * maxFlux;
      if (above && runStart < 0) { runStart = i; runBest = i; }
      else if (above && rawFlux[i] > rawFlux[runBest]) runBest = i;
      else if (!above && runStart >= 0) { events.push({ frame: runBest, weight: rawFlux[runBest] }); runStart = -1; }
    }
  }
  const totalWeight = events.reduce((a, e) => a + e.weight, 0);
  const recall = (lag) => {
    if (!events.length || totalWeight <= 0) return { recall: 0, phase: 0 };
    let bestOff = 0, bestSum = -Infinity;
    for (let off = 0; off < lag; off += 0.5) {
      let s = 0;
      for (let k = 0; ; k++) {
        const idx = Math.round(off + k * lag);
        if (idx >= n) break;
        s += flux[idx];
      }
      if (s > bestSum) { bestSum = s; bestOff = off; }
    }
    const tol = lag * 0.25;
    let hitWeight = 0;
    for (const e of events) {
      const k = Math.round((e.frame - bestOff) / lag);
      const dist = Math.abs(e.frame - (bestOff + k * lag));
      if (dist <= tol) hitWeight += e.weight;
    }
    return { recall: hitWeight / totalWeight, phase: bestOff };
  };
  const tied = cands.filter((c) => c.score >= 0.9 * best.score);
  let pick = best;
  let pickRec = recall(best.lag);
  for (const c of tied) {
    const rec = recall(c.lag);
    if (rec.recall >= 0.7 && pickRec.recall < 0.7) { pick = c; pickRec = rec; }
    else if (rec.recall >= 0.7 && pickRec.recall >= 0.7 && c.score > pick.score) { pick = c; pickRec = rec; }
  }
  const refineLag = (L) => {
    const h = 0.5;
    const y0 = combF(L - h), y1 = combF(L), y2 = combF(L + h);
    const denom = y0 - 2 * y1 + y2;
    if (!(denom < 0)) return L;
    const off = (h * (y0 - y2)) / (2 * denom);
    return L + Math.max(-h, Math.min(h, off));
  };
  const refinedLag = refineLag(pick.lag);
  const bpm = +((fps * 60) / refinedLag).toFixed(1);
  const confidence = Math.max(0, Math.min(1, pick.score / (1.75 * acf0)));
  const beats = [];
  for (let k = 0; beats.length < maxBeats; k++) {
    const t = (pickRec.phase + k * refinedLag) / fps;
    if (t >= n / fps) break;
    beats.push(+t.toFixed(3));
  }
  return {
    bpm,
    confidence: +confidence.toFixed(3),
    reliable: confidence >= BPM_RELIABLE_CONFIDENCE,
    lag: +refinedLag.toFixed(2),
    onset_recall: +pickRec.recall.toFixed(2),
    onsets_detected: events.length,
    first_beat_seconds: beats[0] ?? null,
    beats,
  };
}

// DP beat tracker (librosa's beat_track, Ellis 2007, re-implemented
// in pure Node — no librosa code): the rigid grid above assumes one
// tempo + one phase for the whole file, so a take that speeds up
// drifts off it by the end. The DP instead picks REAL onset peaks
// near the grid: state = flux frame, transition cost =
// tightness * (log(interval / period))^2, so a beat exactly one
// period after the last costs nothing and a beat half a period away
// costs ~0.48 * tightness. Flux is normalised to [0, 1] first, so
// tightness 2 (calibrated on disk 2026-11-17): tightness 1 lets the
// DP subdivide the kick+hat drum fixture — a hat onset (~0.45
// normalised flux) pays two half-period jumps at 0.48 each, so it
// inserts 5 extra beats (29 vs 24); tightness 2 prices the pair at
// ~1.92, above any single onset's gain, and the drum grid comes out
// clean at 24 beats / 0.5s apart. Drift tracking is unaffected
// from 2 to 20 (a 5% interval drift costs 2*(log 1.05)^2 = 0.005),
// so 2 is the stiffest setting that still follows real drift.
// Predecessors are windowed to [0.5, 1.5] x period —
// O(n * period) instead of O(n^2), so a 10-minute file stays fast.
// The chain backtracks from the best score in the last period, and
// the first/last beat is trimmed when its onset is weak (librosa
// trim). Returns beats in seconds plus the interval CV (how much
// the spacing itself varies — ~0.02 even on a steady click track,
// because flux frames quantise to ~23ms, so compare against a
// steady fixture rather than against 0).
export function trackBeatsDP(flux, fps, periodFrames, { tightness = 2 } = {}) {
  const n = flux.length;
  const maxFlux = Math.max(...flux);
  if (n < 8 || !(maxFlux > 0) || !(periodFrames >= 2)) {
    return { beats: [], beat_count: 0, intervals_seconds: [], tempo_drift_cv: 0, reason: "too few flux frames or no onset energy" };
  }
  const fn = flux.map((v) => v / maxFlux);
  const tau = periodFrames;
  const lo = Math.max(1, Math.ceil(0.5 * tau));
  const hi = Math.max(lo, Math.floor(1.5 * tau));
  const dp = new Float64Array(n);
  const prev = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0, bestPrev = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const p = t - d;
      const r = d / tau;
      const cand = dp[p] - tightness * (Math.log(r) ** 2);
      if (cand > best) { best = cand; bestPrev = p; }
    }
    dp[t] = fn[t] + best;
    prev[t] = bestPrev;
  }
  // Backtrack from the best score in the last period — the final
  // beat must sit within one period of the end.
  const lastWin = Math.max(0, n - Math.ceil(1.5 * tau));
  let end = lastWin;
  for (let t = lastWin + 1; t < n; t++) if (dp[t] > dp[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = prev[t]) {
    frames.push(t);
    if (prev[t] < 0) break;
  }
  frames.reverse();
  // Trim weak end beats (librosa trim): a chain that starts/ends on
  // a frame below 25% of the max flux is an onset the grid found by
  // accident, not a beat.
  while (frames.length > 1 && fn[frames[0]] < 0.25) frames.shift();
  while (frames.length > 1 && fn[frames[frames.length - 1]] < 0.25) frames.pop();
  const beats = frames.map((f) => +(f / fps).toFixed(3));
  const intervals = [];
  for (let i = 1; i < beats.length; i++) intervals.push(+(beats[i] - beats[i - 1]).toFixed(3));
  let cv = 0;
  if (intervals.length >= 2) {
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const sd = Math.sqrt(intervals.reduce((a, v) => a + (v - mean) ** 2, 0) / intervals.length);
    cv = +(sd / mean).toFixed(3);
  }
  return { beats, beat_count: beats.length, intervals_seconds: intervals, tempo_drift_cv: cv };
}

// Decode a file to mono f32 PCM at 22050 Hz — the shared input for
// the bpm family (bpm, beat_grid, tempo_drift). Extracted from
// detectBpm (lượt 89) so the three tools decode identically.
async function decodeMono22050(inPath) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediakit-bpm-"));
  const rawPath = path.join(tmpDir, "audio.f32");
  try {
    await run(FFMPEG, ["-y", "-v", "error", "-i", inPath, "-vn", "-ac", "1", "-ar", String(BPM_SAMPLE_RATE), "-f", "f32le", rawPath]);
    const buf = await readFile(rawPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float32Array(ab);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function detectBpm({ input, minBpm = 40, maxBpm = 240, fullGrid = false, method = "grid" }) {
  const inPath = await requireInput(input);
  const lo = num(minBpm, "min_bpm", { min: 20, max: 300 });
  const hi = num(maxBpm, "max_bpm", { min: 20, max: 300 });
  if (lo >= hi) throw new MediaKitError(`bpm: min_bpm (${lo}) must be below max_bpm (${hi})`, "INVALID_ARG");
  if (method !== "grid" && method !== "dp") throw new MediaKitError(`beat_grid method must be "grid" or "dp", got: ${method}`, "INVALID_ARG");
  const meta = await probe(inPath);
  if (!meta.audio) throw new MediaKitError("bpm needs an audio stream — this file has none", "INVALID_ARG");
  const total = meta.duration_seconds;
  if (total === null) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  if (total > BPM_MAX_DURATION_SECONDS) {
    throw new MediaKitError(`bpm refuses files over ${BPM_MAX_DURATION_SECONDS}s (the raw PCM decode would exceed memory) — trim a section first`, "INVALID_ARG");
  }
  if (total < BPM_MIN_DURATION_SECONDS) {
    throw new MediaKitError(`bpm needs at least ${BPM_MIN_DURATION_SECONDS}s of audio (too few beats to trust)`, "INVALID_ARG");
  }
  const warnings = [];
  if (total < 8) warnings.push(`file is ${total}s — fewer than ~10 beats at slow tempos, treat the number as rough`);
  const samples = await decodeMono22050(inPath);
  if (!samples.length) throw new MediaKitError("bpm: decoded audio is empty", "PROBE_FAILED");
  const { flux, rawFlux, fps } = spectralFluxOnset(samples, BPM_SAMPLE_RATE);
  // fullGrid (the beat_grid tool) expands the grid over the whole
  // file instead of the first 16 beats: 5000 beats covers 10 minutes
  // even at 300 BPM (2000), with headroom. The beats are generated
  // from the refined lag at full precision inside estimateTempo —
  // never by stepping the rounded 1-decimal bpm, which would drift
  // ~0.02s over 100 beats at 120 BPM.
  const est = estimateTempo(flux, fps, rawFlux, lo, hi, fullGrid ? 5000 : 16);
  if (est.bpm === null) warnings.push(est.reason ?? "no periodic onset found — the number below is a guess");
  if (!est.reliable) warnings.push(`low confidence (${est.confidence}) — the audio may have no steady beat (speech, ambience, a drone); do not snap cuts to this grid`);
  // method "dp" (beat_grid only — bpm keeps the rigid grid's first
  // 16): run the DP tracker on the measured period and replace the
  // rigid beats with real onset peaks. tempo_drift_seconds is the
  // headline number — how far the DP beats sit from the rigid grid
  // at worst (0.373s on the 120->132 drift fixture, 0.026s on a
  // steady 120 click track): it is what a cut snapped to the rigid
  // grid would miss by the end of the clip. When the DP finds too
  // few beats it falls back to the rigid grid and says so, instead
  // of returning a confident wrong track.
  let beats = est.beats;
  let gridMethod = "grid";
  let tempoDriftSeconds = null;
  let tempoDriftCv = null;
  if (fullGrid && method === "dp" && est.bpm !== null) {
    const dp = trackBeatsDP(flux, fps, est.lag);
    if (dp.beat_count >= 2) {
      let drift = 0;
      for (const b of dp.beats) {
        let m = Infinity;
        for (const g of est.beats) m = Math.min(m, Math.abs(b - g));
        drift = Math.max(drift, m);
      }
      beats = dp.beats;
      gridMethod = "dp";
      tempoDriftSeconds = +drift.toFixed(3);
      tempoDriftCv = dp.tempo_drift_cv;
    } else {
      warnings.push("DP beat tracker found too few beats — fell back to the rigid grid");
    }
  }
  return {
    operation: fullGrid ? "beat_grid" : "bpm",
    input: inPath,
    duration_seconds: total,
    sample_rate_hz: BPM_SAMPLE_RATE,
    bpm: est.bpm,
    beat_period_seconds: est.bpm === null ? null : +(60 / est.bpm).toFixed(3),
    confidence: est.confidence,
    reliable: est.reliable,
    onset_recall: est.onset_recall,
    onsets_detected: est.onsets_detected,
    first_beat_seconds: beats[0] ?? null,
    beats,
    ...(fullGrid ? {
      beat_count: beats.length,
      last_beat_seconds: beats.length ? beats[beats.length - 1] : null,
      grid_method: gridMethod,
      tempo_drift_seconds: tempoDriftSeconds,
      tempo_drift_cv: tempoDriftCv,
    } : {}),
    method: "spectral-flux onset + autocorrelation/comb period + 120 BPM prior + onset-recall tie-break (aubio tempo, re-implemented in pure Node)",
    warnings,
  };
}

// The full beat grid for a clip (the beat_grid tool): same measurement
// as bpm, but every beat across the file instead of the first 16 —
// what trim --snap-beat snaps to, and what a director hands to an
// editor as the cut points. Same limits as bpm (audio required,
// 4s-10min); an unreliable grid is still returned with reliable:
// false and a warning, never a confident wrong number — the caller
// (trim --snap-beat) refuses to snap to it.
export async function detectBeatGrid({ input, minBpm = 40, maxBpm = 240, method = "grid" }) {
  return detectBpm({ input, minBpm, maxBpm, fullGrid: true, method });
}

// ------------------------------------------------------------- tempo drift
// Local tempo over time — the local-tempo idea of librosa's `plp`
// (Grosche & Muller 2011): analyse the onset envelope in sliding
// windows instead of once for the whole file, so a take that speeds
// up shows up as a rising curve rather than one mean number. The
// per-window estimator is the SAME aubio pipeline `bpm` uses
// (spectral-flux + autocorrelation/comb + 120 BPM prior +
// onset-recall tie-break, `estimateTempo` on each window slice) —
// deliberately not a second estimator. The first attempt (lượt 89
// run 1) read the per-frame tempo off the Fourier tempogram peak
// (librosa plp steps 1-4) and FAILED on the kick+hat drum fixture:
// it read 239.1 on every bin. The reason is structural, not a
// threshold: the flux of a kick+off-beat-hat pattern is genuinely
// periodic at 0.25s (240 BPM) — the kick and hat 2 Hz components
// cancel (measured in one window: mag 120 BPM = 92.5 vs mag 240 BPM
// = 4352.3), and even comb scoring (120: 2302 vs 240: 4346) cannot
// recover the musical beat, because the tempogram looks at one
// frequency at a time while the 120 information lives in the
// alternating strong/weak onset pattern — which the autocorrelation
// DOES see (a 0.5s lag aligns strong-with-strong) and the prior +
// recall tie-break then resolves to 120. So the tempogram peak was
// dropped and the windowed estimateTempo kept: it reads 120 flat on
// the drum, 120 flat on a steady click, 90.0 on a steady 90 click,
// and tracks drift 120->132 as 122.7 -> 129.2 (probe
// /tmp/probe-windowed-tempo.mjs, synthetic trains).
//
// Calibration, measured on disk 2026-11-17: steady 120 reads 120.0
// flat, steady 90 reads 90.0 flat, drift 120->132 reads 122.7 at
// t=2 rising to 129.2 at t=9 (truth 122.5 / 129.5 at the bin
// centres), drift 132->120 falls 129.5 -> 123.0. Per-window
// confidence is a ratio, so a steady tone's float-noise flux can
// score "reliable" on a window with bpm 171.9 — reliability is
// therefore gated on ONSET ENERGY as well: a window counts only
// when its mean raw flux is at least 2% of the file's max raw flux
// (a steady tone's flux is numerical noise, ~1e-6 of a click
// track's). A bin is reliable with >= 3 usable+reliable windows;
// the window cannot centre on the first/last ~W/2 frames, so a 12s
// take reports bins t=2..9 and the edge bins are unreliable by
// construction. Hop is 4 flux frames, capped so a 10-minute file
// runs ~2000 windows instead of ~6000.
export function localTempoCurve(flux, rawFlux, fps, { minBpm = 40, maxBpm = 240 } = {}) {
  const n = flux.length;
  const W = Math.min(384, Math.max(172, Math.round(n * 0.4)));
  const HOP = Math.max(4, Math.ceil((n - W) / 2000));
  if (n < W + 8) return { window_frames: W, frames: [], bins: [], reason: "too few flux frames for a tempogram window" };
  const maxRawFlux = Math.max(...rawFlux);
  const frames = [];
  const half = Math.floor(W / 2);
  for (let c = half; c + half < n; c += HOP) {
    const start = c - half;
    let rawMean = 0;
    for (let i = 0; i < W; i++) rawMean += rawFlux[start + i];
    rawMean /= W;
    const est = estimateTempo(flux.slice(start, start + W), fps, rawFlux.slice(start, start + W), minBpm, maxBpm, 1);
    frames.push({
      t_seconds: +(c / fps).toFixed(3),
      bpm: est.bpm,
      confidence: est.confidence,
      reliable: est.reliable,
      usable: maxRawFlux > 0 && rawMean >= 0.02 * maxRawFlux,
    });
  }
  const bins = [];
  for (let s = 0; s < Math.floor(n / fps); s++) {
    const inBin = frames.filter((f) => f.t_seconds >= s && f.t_seconds < s + 1 && f.usable && f.reliable);
    if (inBin.length >= 3) {
      const sorted = inBin.map((f) => f.bpm).sort((a, b) => a - b);
      bins.push({
        t_seconds: s,
        bpm: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
        confidence: +(inBin.reduce((a, f) => a + f.confidence, 0) / inBin.length).toFixed(3),
        reliable: true,
        frames: inBin.length,
      });
    } else {
      bins.push({ t_seconds: s, bpm: null, confidence: 0, reliable: false, frames: inBin.length });
    }
  }
  return { window_frames: W, frames, bins };
}

const TEMPO_DRIFT_MIN_DURATION_SECONDS = 8;
const TEMPO_DRIFT_THRESHOLD_BPM = 3;

// The tempo_drift tool: local tempo curve + drift verdict for a clip
// (probe-only, writes no file). Same decode + limits as bpm, except
// the minimum is 8s — below that the tempogram window (~4-9s) leaves
// almost no curve to report. Returns the 1s tempo_curve, start/end
// bpm (median of the first/last 20% of reliable bins), delta,
// max_deviation_bpm (worst bin vs the curve median), direction and
// verdict: steady (|delta| < 3 and max deviation < 3), drifting
// (|delta| >= 3), variable (a wobble that is neither), unreliable
// (global bpm unreliable or < half the bins reliable — speech, tone,
// drone). An unreliable curve is still returned with its bins, never
// a confident wrong verdict.
export async function detectTempoDrift({ input, minBpm = 40, maxBpm = 240 }) {
  const inPath = await requireInput(input);
  const lo = num(minBpm, "min_bpm", { min: 20, max: 300 });
  const hi = num(maxBpm, "max_bpm", { min: 20, max: 300 });
  if (lo >= hi) throw new MediaKitError(`tempo_drift: min_bpm (${lo}) must be below max_bpm (${hi})`, "INVALID_ARG");
  const meta = await probe(inPath);
  if (!meta.audio) throw new MediaKitError("tempo_drift needs an audio stream — this file has none", "INVALID_ARG");
  const total = meta.duration_seconds;
  if (total === null) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  if (total > BPM_MAX_DURATION_SECONDS) {
    throw new MediaKitError(`tempo_drift refuses files over ${BPM_MAX_DURATION_SECONDS}s (the raw PCM decode would exceed memory) — trim a section first`, "INVALID_ARG");
  }
  if (total < TEMPO_DRIFT_MIN_DURATION_SECONDS) {
    throw new MediaKitError(`tempo_drift needs at least ${TEMPO_DRIFT_MIN_DURATION_SECONDS}s of audio (the tempogram window alone is ~4-9s) — use bpm for a single number instead`, "INVALID_ARG");
  }
  const warnings = [];
  const samples = await decodeMono22050(inPath);
  if (!samples.length) throw new MediaKitError("tempo_drift: decoded audio is empty", "PROBE_FAILED");
  const { flux, rawFlux, fps } = spectralFluxOnset(samples, BPM_SAMPLE_RATE);
  const est = estimateTempo(flux, fps, rawFlux, lo, hi, 16);
  if (est.bpm === null) warnings.push(est.reason ?? "no periodic onset found — the curve below is a guess");
  if (!est.reliable) warnings.push(`low confidence (${est.confidence}) — the audio may have no steady beat (speech, ambience, a drone); do not trust this curve`);
  const curve = localTempoCurve(flux, rawFlux, fps, { minBpm: lo, maxBpm: hi });
  const reliableBins = curve.bins.filter((b) => b.reliable);
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  let startBpm = null, endBpm = null, deltaBpm = null, maxDeviationBpm = null, direction = "steady", verdict = "unreliable";
  if (reliableBins.length) {
    const take = Math.max(1, Math.floor(reliableBins.length * 0.2));
    startBpm = +median(reliableBins.slice(0, take).map((b) => b.bpm)).toFixed(1);
    endBpm = +median(reliableBins.slice(-take).map((b) => b.bpm)).toFixed(1);
    deltaBpm = +(endBpm - startBpm).toFixed(1);
    const med = median(reliableBins.map((b) => b.bpm));
    maxDeviationBpm = +Math.max(...reliableBins.map((b) => Math.abs(b.bpm - med))).toFixed(1);
    direction = deltaBpm >= TEMPO_DRIFT_THRESHOLD_BPM ? "speeding_up" : deltaBpm <= -TEMPO_DRIFT_THRESHOLD_BPM ? "slowing_down" : "steady";
    const enoughBins = reliableBins.length >= Math.ceil(curve.bins.length / 2);
    verdict = !est.reliable || !enoughBins ? "unreliable"
      : Math.abs(deltaBpm) >= TEMPO_DRIFT_THRESHOLD_BPM ? "drifting"
      : maxDeviationBpm < TEMPO_DRIFT_THRESHOLD_BPM ? "steady" : "variable";
    if (verdict === "unreliable") warnings.push(`only ${reliableBins.length}/${curve.bins.length} curve bins are reliable — the tempo verdict is unreliable`);
  } else {
    warnings.push("no reliable curve bins — the audio has no measurable local tempo");
  }
  return {
    operation: "tempo_drift",
    input: inPath,
    duration_seconds: total,
    sample_rate_hz: BPM_SAMPLE_RATE,
    bpm: est.bpm,
    confidence: est.confidence,
    reliable: verdict !== "unreliable",
    tempo_curve: curve.bins,
    window_frames: curve.window_frames,
    start_bpm: startBpm,
    end_bpm: endBpm,
    delta_bpm: deltaBpm,
    max_deviation_bpm: maxDeviationBpm,
    direction,
    verdict,
    method: "Sliding-window tempo estimation — the aubio pipeline (spectral-flux + autocorrelation/comb + 120 BPM prior + onset-recall tie-break) run on overlapping windows of the onset envelope, aggregated to 1s median bins (the local-tempo idea of librosa's plp)",
    warnings,
  };
}

// ---------------------------------------------------------------- motion
// Measure REAL movement, not just cuts (PySceneDetect's ContentDetector
// idea: a per-frame change score, aggregated here into a per-second
// curve): downscale to 160px gray, tblend difference between adjacent
// frames, geq binarizes "pixel changed by >2 levels", signalstats YAVG
// / 255 = fraction of pixels that moved in that frame. Measured on
// disk 2026-11-14: a static title card scores 0.0000-0.0001, a
// bouncing ball 0.003-0.009, testsrc 0.06, a frozen stretch exactly
// 0.0000 — so the default still threshold 0.001 (0.1% of pixels)
// splits "the picture is moving" from "encoder noise on a still" with
// a wide margin on every fixture. Raw lavfi scene_score does NOT work
// for this: testsrc scores 0.0006 while a bounce scores 0.0005 — the
// two are indistinguishable on that scale. Probe-only: no file is
// written. Windows are [k*w, (k+1)*w) aligned to 0; a still interval
// is a maximal run of still windows lasting >= min_still_seconds
// (FlashFilter/min_scene_len idea from PySceneDetect — a 1-frame blip
// is not a still). The first output frame compares input frames 0 and
// 1 (tblend needs a pair), so frames_analyzed = total frames - 1.
// Metadata prints only at info level: never add -v error here (same
// trap as the loudnorm/astats parsers).
// --lag-seconds N (integer 1-30, default 0 = off) compares frames N
// seconds apart instead of adjacent frames, so motion too slow for
// one frame step becomes visible: a 10s fade-in from black reads
// 0.00043 adjacent (verdict static — the per-frame level change is
// under the >2-level binarization) but ~1.0 at lag 2 (51 levels over
// 2s). The graph samples one frame per second (fps=1), splits it,
// delays one copy by N seconds, and diffs the pair with blend (NOT
// tblend: tblend blends successive frames of ONE stream and takes a
// single input — the two-stream diff needs blend). The value at
// second k is the fraction of pixels that changed between second k
// and second k+N, so the curve is "change over the last N seconds
// ending at k+N", not "change during second k". Consequences, all
// deliberate: a still run [s0, s1) in lag mode means the picture was
// still over [s0, s1+N) — the flush corrects the end by +N (clamped
// to the duration) and min_still_seconds applies to the corrected
// length; a still shorter than N+1s produces no pair fully inside
// it and is not reported in lag mode (use lag 1 for short freezes);
// a still in the final N seconds has no later frame to compare
// against and is not reported. frames_analyzed counts lag pairs
// (one per second minus N), and motion_energy is the mean lag
// fraction — not comparable with the adjacent-frame energy of the
// same clip. Lag mode and --adaptive compose: the adaptive floor is
// taken from the lag curve.
export async function measureMotion({ input, threshold = 0.001, minStillSeconds = 2, windowSeconds = 1, adaptive = false, adaptiveFactor = 2, adaptiveCap = 0.005, lagSeconds = 0 }) {
  const inPath = await requireInput(input);
  const t = num(threshold, "threshold", { min: 0, max: 0.5 });
  const adapt = adaptive === true;
  const factor = adapt ? num(adaptiveFactor, "adaptive_factor", { min: 1, max: 10 }) : 2;
  const cap = adapt ? num(adaptiveCap, "adaptive_cap", { min: 0.0005, max: 0.05 }) : 0.005;
  const minStill = num(minStillSeconds, "min_still_seconds", { min: 0.5, max: 60 });
  const win = num(windowSeconds, "window_seconds", { min: 0.25, max: 5 });
  const lag = num(lagSeconds, "lag_seconds", { min: 0, max: 30, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("motion needs a video input", "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (lag > 0) {
    if (duration == null) throw new MediaKitError("motion --lag-seconds needs a clip with a known duration", "INVALID_ARG");
    if (lag >= duration) throw new MediaKitError(`lag_seconds (${lag}) must be less than the clip duration (${duration}s)`, "INVALID_ARG");
  }
  const vf = lag === 0
    ? "scale=160:-2,format=gray,tblend=all_mode=difference,geq=lum='if(gt(lum(X,Y)\\,2)\\,255\\,0)',signalstats,metadata=print:key=lavfi.signalstats.YAVG"
    : `scale=160:-2,format=gray,fps=1,split[a][b];[a]trim=start=${lag},setpts=PTS-STARTPTS[a2];[b]trim=end=${+(duration - lag).toFixed(3)},setpts=PTS-STARTPTS[b2];[b2][a2]blend=all_mode=difference,geq=lum='if(gt(lum(X,Y)\\,2)\\,255\\,0)',signalstats,metadata=print:key=lavfi.signalstats.YAVG`;
  const { stderr } = await run(FFMPEG, [
    "-hide_banner", "-nostats", "-i", inPath, "-vf", vf, "-f", "null", "-",
  ]);
  const frames = [];
  let curT = null;
  for (const line of stderr.split("\n")) {
    let m;
    if ((m = line.match(/pts_time:\s*([\d.]+)/))) { curT = parseFloat(m[1]); continue; }
    if ((m = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/))) {
      if (curT === null) continue;
      frames.push({ t: curT, fraction: +(+m[1] / 255).toFixed(5) });
    }
  }
  const buckets = new Map(); // window start -> { sum, count }
  for (const f of frames) {
    const wStart = Math.floor(f.t / win) * win;
    const b = buckets.get(wStart) ?? { sum: 0, count: 0 };
    b.sum += f.fraction;
    b.count++;
    buckets.set(wStart, b);
  }
  const motionCurve = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([s, b]) => ({
    start_seconds: +s.toFixed(3),
    end_seconds: +(Math.min(s + win, duration ?? s + win)).toFixed(3),
    motion_fraction: +(b.sum / b.count).toFixed(5),
    frames: b.count,
  }));
  // Adaptive threshold (PySceneDetect's AdaptiveDetector idea, ported
  // to a still detector): pass 2 calibrates the threshold to this
  // clip's own quiet quarter. floor = 25th percentile of the curve,
  // threshold = min(max(fixed, floor * factor), max(cap, fixed)).
  // The cap sits in the measured gap between light grain (max 0.0013)
  // and the slowest real motion (a bouncing ball's slowest second,
  // 0.00695), so steady motion can never be thresholded away. What
  // did NOT transfer from AdaptiveDetector: its adaptive_ratio
  // (score / rolling local average) — that detects *cuts*, and a
  // smoothly moving ball scores ratio ~1.0 against its neighbours, so
  // using it for the verdict would call a bounce "still". Heavy grain
  // (measured 0.53 changed-fraction) still reads as moving in both
  // modes — at that level no threshold can separate grain from real
  // motion by magnitude alone. The fixed threshold stays as the
  // absolute floor (AdaptiveDetector's min_content_val idea).
  let thresholdMode = "fixed";
  let effectiveThreshold = t;
  let adaptiveInfo = null;
  if (adapt && motionCurve.length) {
    const sorted = motionCurve.map((w) => w.motion_fraction).sort((a, b) => a - b);
    const floorP25 = sorted[Math.floor(0.25 * (sorted.length - 1))];
    const raw = floorP25 * factor;
    const effCap = Math.max(cap, t);
    effectiveThreshold = Math.min(Math.max(t, raw), effCap);
    thresholdMode = "adaptive";
    adaptiveInfo = {
      floor_p25: +floorP25.toFixed(5),
      factor,
      cap: +effCap.toFixed(5),
      raw_threshold: +raw.toFixed(5),
      capped: raw > effCap,
    };
  }
  const stillIntervals = [];
  let runStart = null;
  let runEnd = null;
  const flushRun = () => {
    // In lag mode the value at second k compares frames k and k+lag,
    // so a still run [s0, s1) in lag time means the picture was still
    // over [s0, s1+lag) in clip time — correct the end (clamped to
    // the duration) and apply min_still_seconds to the corrected
    // length. In adjacent mode the run is already in clip time.
    if (runStart !== null) {
      const end = lag ? Math.min(runEnd + lag, duration ?? runEnd + lag) : runEnd;
      if (end - runStart >= minStill - 1e-9) {
        stillIntervals.push({
          start_seconds: +runStart.toFixed(3),
          end_seconds: +end.toFixed(3),
          duration_seconds: +(end - runStart).toFixed(3),
        });
      }
    }
    runStart = null;
    runEnd = null;
  };
  for (const w of motionCurve) {
    if (w.motion_fraction < effectiveThreshold) {
      if (runStart === null) runStart = w.start_seconds;
      runEnd = w.end_seconds;
    } else {
      flushRun();
    }
  }
  flushRun();
  const motionEnergy = frames.length
    ? +(frames.reduce((a, b) => a + b.fraction, 0) / frames.length).toFixed(5)
    : 0;
  if (!frames.length && duration) {
    // A 1-frame video has no pair to diff: nothing ever moves.
    stillIntervals.push({ start_seconds: 0, end_seconds: +duration.toFixed(3), duration_seconds: +duration.toFixed(3) });
  }
  const totalStill = stillIntervals.reduce((a, b) => a + b.duration_seconds, 0);
  const movingFraction = duration ? +(1 - totalStill / duration).toFixed(3) : null;
  let verdict;
  if (!stillIntervals.length) {
    verdict = "moving";
  } else if (movingFraction !== null && movingFraction < 0.5) {
    verdict = "static";
  } else {
    verdict = "mostly-static";
  }
  let peakWindow = null;
  for (const w of motionCurve) {
    if (!peakWindow || w.motion_fraction > peakWindow.motion_fraction) {
      peakWindow = { start_seconds: w.start_seconds, motion_fraction: w.motion_fraction };
    }
  }
  return {
    operation: "motion",
    input: inPath,
    threshold: +effectiveThreshold.toFixed(5),
    threshold_mode: thresholdMode,
    adaptive: adaptiveInfo,
    min_still_seconds: minStill,
    window_seconds: win,
    lag_seconds: lag,
    duration_seconds: duration,
    dimensions: meta.video ? `${meta.video.width}x${meta.video.height}` : null,
    frames_analyzed: frames.length,
    motion_energy: motionEnergy,
    moving_fraction: movingFraction,
    verdict,
    motion_curve: motionCurve,
    still_intervals: stillIntervals,
    peak_window: peakWindow,
  };
}

// ---------------------------------------------------------------- keyframes
// List keyframe (I-frame) timestamps (dubnium0/ffmpeg-mcp's get_keyframes
// idea): ffprobe with -skip_frame nokey so only keyframes are decoded.
// Probe-only: no file is written. Needed before any lossless
// stream-copy trim — cutting between keyframes silently shifts the cut.

export async function listKeyframes({ input }) {
  const inPath = await requireInput(input);
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("keyframes needs a video input", "INVALID_ARG");
  const { stdout } = await run(FFPROBE, [
    "-v", "quiet", "-print_format", "json",
    "-skip_frame", "nokey", "-select_streams", "v:0",
    "-show_frames", "-show_entries", "frame=pts_time,key_frame", inPath,
  ]);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new MediaKitError("ffprobe returned unparseable output", "PROBE_FAILED");
  }
  const ts = [...new Set(
    (data.frames ?? [])
      .filter((f) => f.key_frame === 1)
      .map((f) => parseFloat(f.pts_time ?? NaN))
      .filter((v) => Number.isFinite(v)),
  )].sort((a, b) => a - b).map((v) => +v.toFixed(3));
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(+(ts[i] - ts[i - 1]).toFixed(3));
  const gop = gaps.length ? {
    min_seconds: Math.min(...gaps),
    max_seconds: Math.max(...gaps),
    avg_seconds: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3),
  } : null;
  return {
    operation: "keyframes",
    input: inPath,
    duration_seconds: meta.duration_seconds,
    keyframe_timestamps: ts,
    count: ts.length,
    first_keyframe_seconds: ts.length ? ts[0] : null,
    starts_with_keyframe: ts.length ? ts[0] === 0 : false,
    gop_seconds: gop,
  };
}

// ---------------------------------------------------------------- mux
// Replace a video's audio track with an external one, stream-copying
// both (idea: Ashutos1997's mux_media). No re-encode, so it is fast
// and lossless; the video's original audio is dropped, not mixed in
// (mix it first if you want both). --audio-offset shifts the new
// audio against the video: positive delays the audio, negative delays
// the video, via -itsoffset on the delayed input. --shortest stops at
// the shorter stream. --dry-run prints the exact ffmpeg argv and
// writes no file (the alanveloper-epam/ffmpeg-mcp-server idea:
// dry-run on mutative tools, so an agent can inspect before it runs).
export async function mux({ video, audio, output, audioOffsetSeconds = 0, shortest = false, dryRun = false }) {
  const videoPath = await requireInput(video, "video file");
  const audioPath = await requireInput(audio, "audio file");
  const outPath = await prepareOutput(output, [videoPath, audioPath]);
  const offset = num(audioOffsetSeconds, "audio_offset_seconds", { min: -3600, max: 3600 });

  const vMeta = await probe(videoPath);
  if (!vMeta.video) throw new MediaKitError("mux needs a video stream in the video file", "INVALID_ARG");
  const aMeta = await probe(audioPath);
  if (!aMeta.audio) throw new MediaKitError("mux needs an audio stream in the audio file", "INVALID_ARG");

  const args = ["-y"];
  if (offset >= 0) {
    args.push("-i", videoPath);
    if (offset > 0) args.push("-itsoffset", String(offset));
    args.push("-i", audioPath);
  } else {
    args.push("-itsoffset", String(-offset), "-i", videoPath, "-i", audioPath);
  }
  args.push("-map", "0:v:0", "-map", "1:a:0", "-c", "copy");
  if (shortest) args.push("-shortest");
  const ext = path.extname(outPath).slice(1).toLowerCase();
  if (["mp4", "mov", "m4v"].includes(ext)) args.push("-movflags", "+faststart");
  args.push(outPath);

  if (dryRun) {
    return {
      operation: "mux",
      dry_run: true,
      video: videoPath,
      audio: audioPath,
      output: outPath,
      audio_offset_seconds: offset,
      shortest: Boolean(shortest),
      mode: "stream-copy",
      command: [FFMPEG, ...args],
    };
  }

  await run(FFMPEG, args);
  const outMeta = await probe(outPath);
  const info = await fileInfo(outPath);
  return {
    operation: "mux",
    video: videoPath,
    audio: audioPath,
    output: outPath,
    audio_offset_seconds: offset,
    shortest: Boolean(shortest),
    mode: "stream-copy",
    video_codec: outMeta.video?.codec ?? null,
    audio_codec: outMeta.audio?.codec ?? null,
    width: outMeta.video?.width ?? null,
    height: outMeta.video?.height ?? null,
    duration_seconds: outMeta.duration_seconds,
    ...info,
  };
}

// ---------------------------------------------------------------- batch
// Apply ONE operation to many files matching a glob under a folder
// (AmolDerickSoans/ffmpeg-mcp's batch_process idea, rebuilt the
// MediaKit way — and the design of kajisho5/ffmpeg-skill's batch.py:
// a content-hash cache so unchanged inputs are skipped, --jobs N
// files at once under ONE shared timeout, and a result row for every
// input, in input order, even after an error or a stop).
//
// Operations are the single-input/single-output tools only: each file
// gets the same args, one output per input named
// <stem>-<operation>.<ext> under the output dir, mirroring the input
// tree (so two same-named files in different subfolders never
// collide). Per-file failures are recorded, not hidden: the batch
// still returns every row, and the summary counts ok/error/cached/
// skipped. A bad argument fails fast on the file itself (each core
// function validates before spawning ffmpeg), and in sequential mode
// three leading INVALID_ARG failures abort the batch — a mistyped
// arg must not burn through 200 files one by one.

// The words file for one clip in a batch: <words_dir>/<stem>.words.json.
// Shared with the cut_words batch spec below (run + cache key).
function cutWordsFileFor(input, wordsDir) {
  return path.join(wordsDir ?? path.dirname(input), `${path.basename(input, path.extname(input))}.words.json`);
}

// Hash a sidecar file for the batch cache key; a missing file hashes
// to null — the run then fails per-file as designed, and a missing
// file can never collide with a present one (the present one hashes
// to real bytes).
async function hashSidecar(p) {
  try { return await hashFile(p); } catch { return null; }
}

export const BATCH_OPERATIONS = {
  loudness: {
    args: ["target_lufs", "format", "compressor", "compressor_threshold", "compressor_ratio"],
    run: (input, output, a) => loudness({ input, output, targetLufs: a.target_lufs ?? -14, format: a.format ?? null, compressor: a.compressor ? { threshold_db: a.compressor_threshold ?? -24, ratio: a.compressor_ratio ?? 4 } : null }),
  },
  resize: {
    args: ["width", "height", "keep_aspect", "preset"],
    run: (input, output, a) => resize({ input, output, width: a.width ?? null, height: a.height ?? null, keepAspect: a.keep_aspect ?? true, preset: a.preset ?? null }),
  },
  reframe: {
    args: ["width", "height", "mode", "x", "y", "blur", "anchor"],
    run: (input, output, a) => reframe({ input, output, width: a.width ?? 1080, height: a.height ?? 1920, mode: a.mode ?? "crop", x: a.x ?? null, y: a.y ?? null, blur: a.blur ?? 20, anchor: a.anchor ?? null }),
  },
  compress: {
    args: ["quality", "max_width", "crf", "preset", "target_size_mb", "resolution_ladder", "quality_proof"],
    run: (input, output, a) => compress({ input, output, quality: a.quality ?? "medium", maxWidth: a.max_width ?? null, crf: a.crf ?? null, preset: a.preset ?? null, targetSizeMb: a.target_size_mb ?? null, resolutionLadder: a.resolution_ladder ?? true, qualityProof: a.quality_proof ?? true }),
  },
  convert: {
    args: ["video_codec", "audio_codec", "crf", "preset", "gop", "gop_seconds"],
    run: (input, output, a) => convert({ input, output, videoCodec: a.video_codec ?? null, audioCodec: a.audio_codec ?? null, crf: a.crf ?? 23, preset: a.preset ?? "medium", gop: a.gop ?? null, gopSeconds: a.gop_seconds ?? null }),
  },
  extract_audio: {
    args: ["format", "whisper", "channel"],
    run: (input, output, a) => extractAudio({ input, output, format: a.format ?? null, whisper: a.whisper ?? false, channel: a.channel ?? null }),
  },
  reverse: {
    args: ["audio", "crf"],
    run: (input, output, a) => reverseClip({ input, output, audio: a.audio ?? true, crf: a.crf ?? 23 }),
  },
  rotate: {
    args: ["angle", "flip", "crf"],
    run: (input, output, a) => rotateClip({ input, output, angle: a.angle ?? null, flip: a.flip ?? null, crf: a.crf ?? 23 }),
  },
  boomerang: {
    args: ["audio", "crf"],
    run: (input, output, a) => boomerangClip({ input, output, audio: a.audio ?? true, crf: a.crf ?? 23 }),
  },
  make_loopable: {
    args: ["overlap", "crf"],
    run: (input, output, a) => makeLoopable({ input, output, overlap: a.overlap ?? 0.5, crf: a.crf ?? 23 }),
  },
  freeze: {
    args: ["at", "hold", "crf"],
    run: (input, output, a) => freezeFrame({ input, output, at: a.at ?? null, hold: a.hold ?? 2, crf: a.crf ?? 23 }),
  },
  grade: {
    args: ["preset", "filter", "crf", "cdl"],
    run: (input, output, a) => grade({ input, output, preset: a.preset ?? null, filter: a.filter ?? null, crf: a.crf ?? 23, cdl: a.cdl ?? null }),
  },
  fit: {
    args: ["duration", "method", "max_fps"],
    run: (input, output, a) => fitDuration({ input, output, duration: a.duration, method: a.method ?? "speed", maxFps: a.max_fps ?? null }),
  },
  trim: {
    args: ["start", "end", "duration", "stream_copy", "snap_to_keyframe", "snap_to_beat", "snap_beat_method", "smart_cut", "check_frames"],
    run: (input, output, a) => trim({ input, output, start: a.start ?? 0, duration: a.duration ?? null, end: a.end ?? null, streamCopy: a.stream_copy ?? false, snapToKeyframe: a.snap_to_keyframe ?? false, snapToBeat: a.snap_to_beat ?? false, snapBeatMethod: a.snap_beat_method ?? "grid", smartCut: a.smart_cut ?? false, checkFrames: a.check_frames ?? true }),
  },
  silence: {
    args: ["threshold_db", "min_duration", "margin"],
    run: (input, output, a) => silence({ input, output, thresholdDb: a.threshold_db ?? -40, minDuration: a.min_duration ?? 0.5, margin: a.margin ?? 0.2, detectOnly: false }),
  },
  chroma_key: {
    args: ["color", "similarity", "blend", "background", "crf"],
    run: (input, output, a) => chromaKey({ input, output, color: a.color ?? "00FF00", similarity: a.similarity ?? 0.1, blend: a.blend ?? 0.0, background: a.background ?? null, crf: a.crf ?? 23 }),
    // A background image is a sidecar: its bytes (not just its path)
    // belong in the cache key, or editing the image re-serves the old
    // composite. A hex color needs no hash — it is already in args.
    extraHash: async (input, a) => {
      const b = a.background == null ? null : String(a.background).trim();
      if (!b) return null;
      if (/^#?[0-9A-Fa-f]{6}$/.test(b) || /^0x[0-9A-Fa-f]{6}$/.test(b)) return null;
      return hashSidecar(b);
    },
  },
  // cut_words in batch: one words file per input, found by convention
  // — <words_dir>/<stem>.words.json, defaulting to the input's own
  // folder (the file transcribe --word-timestamps writes next to the
  // clip when its output is <stem>.words.json). A shared words file
  // cannot apply to many clips — each clip has its own timings — so
  // there is no plain `words_file` arg here; a file with no words
  // file fails its own row only, the rest of the batch still runs.
  cut_words: {
    args: ["words_dir", "remove", "fillers", "indices", "keep", "pad_before", "pad_after", "min_keep"],
    run: (input, output, a) => cutWords({
      input, output,
      wordsFile: cutWordsFileFor(input, a.words_dir),
      remove: a.remove ?? null, fillers: a.fillers ?? false, indices: a.indices ?? null, keep: a.keep ?? null,
      padBefore: a.pad_before ?? 0.06, padAfter: a.pad_after ?? 0.12, minKeep: a.min_keep ?? 0.2,
    }),
    // Two byte-identical clips with different words files are
    // different jobs: the words bytes belong in the cache key, or
    // the second clip is served the first clip's cut.
    extraHash: async (input, a) => hashSidecar(cutWordsFileFor(input, a.words_dir)),
  },
  // remove_retakes in batch: same words-file-by-convention as
  // cut_words — <words_dir>/<stem>.words.json per clip.
  remove_retakes: {
    args: ["words_dir", "min_words", "max_gap_words", "max_gap_seconds", "keep", "pad_before", "pad_after", "min_keep"],
    run: (input, output, a) => removeRetakes({
      input, output,
      wordsFile: cutWordsFileFor(input, a.words_dir),
      minWords: a.min_words ?? 3, maxGapWords: a.max_gap_words ?? 8, maxGapSeconds: a.max_gap_seconds ?? 5,
      keep: a.keep ?? "last",
      padBefore: a.pad_before ?? 0.06, padAfter: a.pad_after ?? 0.12, minKeep: a.min_keep ?? 0.2,
    }),
    extraHash: async (input, a) => hashSidecar(cutWordsFileFor(input, a.words_dir)),
  },
  // hook in batch is the first PROBE-ONLY batch operation: it writes
  // no file, so there is no output path, no suffix and no output to
  // verify in the cache — the ranked windows come back in the row's
  // `result`, and the cache stores that result (the key already
  // covers the input bytes + operation + args, so a hit can only come
  // from an identical input). batch() branches on spec.probeOnly for
  // all of this: items get output null, the cache skips the
  // size+sha256 output check, and the summary reports
  // output_suffix null.
  hook: {
    probeOnly: true,
    args: ["duration", "step", "top", "threshold_db", "history_file", "record", "history_overlap"],
    run: (input, output, a) => findHook({ input, duration: a.duration ?? 15, step: a.step ?? 0.5, top: a.top ?? 3, thresholdDb: a.threshold_db ?? -40, historyFile: a.history_file ?? null, record: a.record ?? false, historyOverlap: a.history_overlap ?? 0.5 }),
    // The history file is a sidecar like cut_words' words file: hash
    // its bytes into the cache key, so a recorded window invalidates
    // the cached duplicate flags instead of serving stale ones.
    extraHash: async (input, a) => hashSidecar(a.history_file),
  },
  // bpm / beat_grid in batch are probe-only like hook: no file is
  // written, the measurement comes back in the row's `result`, and
  // the cache stores that result (the key already covers the input
  // bytes + operation + args). In a manifest they are the probe-only
  // steps that record WHY the next trim --snap-beat cuts where it
  // does — the grid is measured once, then the trim step snaps to it.
  bpm: {
    probeOnly: true,
    args: ["min_bpm", "max_bpm"],
    run: (input, output, a) => detectBpm({ input, minBpm: a.min_bpm ?? 40, maxBpm: a.max_bpm ?? 240 }),
  },
  beat_grid: {
    probeOnly: true,
    args: ["min_bpm", "max_bpm", "method"],
    run: (input, output, a) => detectBeatGrid({ input, minBpm: a.min_bpm ?? 40, maxBpm: a.max_bpm ?? 240, method: a.method ?? "grid" }),
  },
  // tempo_drift in batch/manifest is probe-only like bpm/beat_grid:
  // the local tempo curve comes back in the row's `result` (batch)
  // or the step's result (manifest) and the cache stores that result.
  tempo_drift: {
    probeOnly: true,
    args: ["min_bpm", "max_bpm"],
    run: (input, output, a) => detectTempoDrift({ input, minBpm: a.min_bpm ?? 40, maxBpm: a.max_bpm ?? 240 }),
  },
  // slideshow in batch is a SET operation, not a per-file one: the
  // whole matched set becomes ONE slideshow (batch() branches on it
  // before the per-file loop, so this run is only ever called from
  // a manifest step, where images come from args). `images` /
  // `durations` are arrays — batch args must be scalars, so batch
  // never passes them; a manifest may (see the manifest validator's
  // array exception). output_name is batch-only: the single output
  // file's name inside the output dir.
  slideshow: {
    args: ["images", "durations", "duration", "transition", "transition_duration", "fps", "width", "height", "audio", "crf", "output_name"],
    run: (input, output, a) => slideshow({
      images: a.images, output,
      durations: a.durations ?? null,
      duration: a.duration ?? 3,
      transition: a.transition ?? "fade",
      transitionDuration: a.transition_duration ?? 1,
      fps: a.fps ?? 30, width: a.width ?? 1280, height: a.height ?? 720,
      audio: a.audio ?? null, crf: a.crf ?? 23,
    }),
    // The slides are the input: their bytes belong in the cache
    // key, or editing one image re-serves the old slideshow.
    extraHash: async (input, a) => {
      const files = slideshowImageFiles(a.images ?? []);
      if (!files.length) return null;
      const hashes = [];
      for (const f of files) hashes.push(await hashFile(f));
      return createHash("sha256").update(hashes.join(":")).digest("hex");
    },
  },
};

const BATCH_CACHE_FILENAME = ".mediakit-batch-cache.json";
const BATCH_MANIFEST_FILENAME = "batch-manifest.json";

// Output extension for a batch item: the input's, except
// extract_audio (whisper forces .wav; an explicit format wins; an
// audio input keeps its own audio extension, a video input defaults
// to .mp3) and loudness with an explicit --format (the file's
// container must match the codec the tool was told to write).
function batchOutputExt(operation, inputExt, args) {
  // hook is probe-only: it never changes the file, so the chain
  // extension passes through unchanged (the batch path never calls
  // this for hook — a probe-only item's output is null).
  if (operation === "hook") return inputExt;
  if (operation === "slideshow") return "mp4";
  // download: the URL's extension wins when it names a media file
  // (a signed URL with no extension falls back to the input — for a
  // download-first manifest that is the manifest output's extension,
  // since the manifest seeds `ext` from its output then).
  if (operation === "download") {
    try {
      const u = new URL(String(args.url ?? ""));
      const urlExt = path.extname(u.pathname).slice(1).toLowerCase();
      if (DOWNLOAD_EXTENSIONS.includes(urlExt)) return urlExt;
    } catch { /* no usable URL: fall through to the input extension */ }
    return inputExt;
  }
  if (operation === "extract_audio") {
    if (args.whisper) return "wav";
    if (args.format) return String(args.format).toLowerCase().replace(/^\./, "");
    return AUDIO_FORMATS[inputExt] ? inputExt : "mp3";
  }
  if (operation === "loudness" && args.format) return String(args.format).toLowerCase().replace(/^\./, "");
  // chroma_key without a background keeps transparency, so the batch
  // output must be .mov (ProRes 4444); with a background it is a
  // flat video — .mp4, or .webm when the input already was one.
  if (operation === "chroma_key") {
    if (!args.background) return "mov";
    return inputExt === "webm" ? "webm" : "mp4";
  }
  return inputExt;
}

function globSegmentToRegExp(seg) {
  let re = "^";
  for (const ch of seg) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

// Match a glob against a '/'-separated relative path. `**` crosses
// directories; a bare pattern with no '/' (e.g. `*.mp4`) matches the
// basename at any depth — the form people actually type for "every
// mp4 in this folder".
function matchBatchPattern(pattern, relPosix) {
  const patSegs = pattern.split("/");
  const pathSegs = relPosix.split("/");
  if (patSegs.length === 1) return globSegmentToRegExp(patSegs[0]).test(pathSegs[pathSegs.length - 1]);
  function match(pi, si) {
    if (pi === patSegs.length) return si === pathSegs.length;
    if (patSegs[pi] === "**") {
      for (let k = si; k <= pathSegs.length; k++) if (match(pi + 1, k)) return true;
      return false;
    }
    if (si >= pathSegs.length) return false;
    return globSegmentToRegExp(patSegs[pi]).test(pathSegs[si]) && match(pi + 1, si + 1);
  }
  return match(0, 0);
}

async function hashFile(file) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const s = createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", resolve);
  });
  return h.digest("hex");
}

// Digest of the DECODED frames (moviepy's test pattern: compare
// decoded frames, never bytes — a re-encode is lossy and container
// metadata moves, so bytes are the stricter check, not the content
// check). `ffmpeg -f framemd5` hashes every decoded frame of every
// stream (video + audio); the `#` comment header lines are stripped
// before hashing so only frame lines count. Null when the file has
// no decodable stream.
async function frameDigest(file) {
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "framemd5", "-"]);
  const lines = stdout.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) return null;
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// Container-level metadata tags (creation_time, encoder, ...) —
// the usual suspect when two renders have identical frames but
// different bytes. Null when ffprobe cannot read the file.
async function formatTags(file) {
  try {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format_tags", "-of", "json", file]);
    return JSON.parse(stdout).format?.tags ?? {};
  } catch {
    return null;
  }
}

// ffmpeg version string for receipts (leclap's render manifest
// records the toolchain, so a rerender on a different ffmpeg build
// can be told apart from a real drift instead of silently failing
// the byte comparison). Null when ffmpeg cannot be run.
async function ffmpegVersionString() {
  try {
    const { stdout } = await run(FFMPEG, ["-version"]);
    return (stdout.match(/ffmpeg version (\S+)/) || [])[1] ?? null;
  } catch {
    return null;
  }
}

// JSON with sorted keys, so the same args hash the same way no
// matter what order the caller wrote them in.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

async function collectBatchFiles(dirPath, pattern, excludeDir) {
  const found = [];
  let skippedDirectories = 0;
  async function walk(dir, isRoot) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skippedDirectories++;
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.isSymbolicLink()) continue;
        // Never treat a previous batch's outputs as new inputs when
        // the output dir sits inside the input tree.
        if (excludeDir && (full === excludeDir || isInsideDir(excludeDir, full))) continue;
        if (!isRoot && (e.name.startsWith(".") || FIND_SKIP_DIRS.has(e.name))) continue;
        await walk(full, false);
      } else if (e.isFile()) {
        const ext = e.name.includes(".") ? e.name.split(".").pop().toLowerCase() : "";
        if (!FIND_EXTENSIONS.includes(ext)) continue;
        const rel = path.relative(dirPath, full).split(path.sep).join("/");
        if (matchBatchPattern(pattern, rel)) found.push(full);
      }
    }
  }
  await walk(dirPath, true);
  found.sort();
  return { files: found, skippedDirectories };
}

export async function batch({ operation, pattern, inputDir, outputDir, args = {}, jobs = 1, outputSuffix = null, cache = true, stopOnError = false, timeoutSeconds = 1800, maxFiles = 200, dryRun = false }) {
  const spec = BATCH_OPERATIONS[operation];
  if (!spec) throw new MediaKitError(`unknown batch operation: ${operation} (supported: ${Object.keys(BATCH_OPERATIONS).join(", ")})`, "INVALID_ARG");
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new MediaKitError("batch args must be an object", "INVALID_ARG");
  for (const k of Object.keys(args)) {
    if (!spec.args.includes(k)) throw new MediaKitError(`batch ${operation} does not take argument "${k}" (supported: ${spec.args.join(", ") || "none"})`, "INVALID_ARG");
    const v = args[k];
    if (v !== null && typeof v === "object") throw new MediaKitError(`batch argument "${k}" must be a string, number or boolean`, "INVALID_ARG");
  }
  if (typeof pattern !== "string" || !pattern.trim()) throw new MediaKitError("batch pattern is required (glob like **/*.mp4)", "INVALID_ARG");
  const inDir = await requireInput(inputDir, "input directory");
  if (!(await stat(inDir)).isDirectory()) throw new MediaKitError(`not a directory: ${inputDir}`, "INVALID_ARG");
  const max = num(maxFiles, "max_files", { min: 1, max: 1000, integer: true });
  // Parallelism capped like ffmpeg-skill's batch.py: min(N, cpus, 8).
  const jobCount = Math.min(num(jobs, "jobs", { min: 1, max: 8, integer: true }), os.cpus().length, 8);
  const timeout = num(timeoutSeconds, "timeout_seconds", { min: 1, max: 86400 });
  // A probe-only operation writes no file, so there is no suffix to
  // validate and no overwrite to guard against — the summary reports
  // output_suffix: null.
  const probeOnly = spec.probeOnly === true;
  const suffix = probeOnly ? null : (outputSuffix === null || outputSuffix === undefined ? `-${operation}` : String(outputSuffix));
  if (!probeOnly && !/^[A-Za-z0-9._-]{0,32}$/.test(suffix)) throw new MediaKitError(`batch output suffix must be 0-32 chars of [A-Za-z0-9._-], got: ${suffix}`, "INVALID_ARG");
  const outDirAbs = path.resolve(String(outputDir));
  await assertInsideWorkdir(outDirAbs, "output directory");
  if (!probeOnly && suffix === "" && path.resolve(inDir) === outDirAbs) {
    throw new MediaKitError("batch with an empty suffix would overwrite its inputs — use a suffix or a different output directory", "INVALID_ARG");
  }

  const { files, skippedDirectories } = await collectBatchFiles(inDir, pattern.trim(), outDirAbs);
  if (!files.length) throw new MediaKitError(`batch matched no files: pattern "${pattern}" under ${inDir}`, "NO_MATCH");
  // slideshow is a SET operation: the whole matched set becomes ONE
  // slideshow, not one output per file — it branches here, before
  // the per-file items exist. The per-file content-hash cache does
  // not apply (the "file" is a set of images); the summary says so
  // instead of pretending cache:true. output_name names the single
  // output file inside the output dir.
  if (operation === "slideshow") {
    const imageExts = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
    const images = files.filter((f) => imageExts.has(path.extname(f).slice(1).toLowerCase()));
    if (images.length < 2) {
      throw new MediaKitError(`batch slideshow needs at least 2 images, pattern "${pattern}" matched ${files.length} file(s) but only ${images.length} image(s) — use a pattern like **/*.jpg`, "NO_MATCH");
    }
    if (images.length > 32) {
      throw new MediaKitError(`batch slideshow takes at most 32 images, pattern "${pattern}" matched ${images.length} — narrow the pattern (a subfolder, or fewer images)`, "INVALID_ARG");
    }
    const outputName = args.output_name ?? "slideshow.mp4";
    if (typeof outputName !== "string" || !/^[A-Za-z0-9._-]+\.mp4$/.test(outputName)) {
      throw new MediaKitError(`batch slideshow output_name must be a plain filename ending in .mp4, got: ${JSON.stringify(outputName)}`, "INVALID_ARG");
    }
    const startedAt = Date.now();
    // Dry-run writes nothing — not even the output directory (the
    // per-file path returns before prepareOutputDir for the same
    // reason, and a dry-run that mkdirs would fail its own test).
    const output = path.join(outDirAbs, outputName);
    const summaryBase = {
      operation, pattern: pattern.trim(), input_dir: inDir, output_dir: outDirAbs,
      args, jobs: 1, cache: false,
      cache_note: "slideshow is a set operation — the per-file content-hash cache does not apply in v1",
      output_suffix: null,
      files_total: files.length, files_matched: images.length, truncated: files.length > max,
      ...(skippedDirectories ? { skipped_directories: skippedDirectories } : {}),
    };
    if (dryRun) {
      return { ...summaryBase, dry_run: true, succeeded: 0, failed: 0, cached: 0, skipped: 0, elapsed_seconds: 0, results: [{ input: images, output, status: "planned" }] };
    }
    const outDir = await prepareOutputDir(outDirAbs);
    if (Date.now() > startedAt + timeout * 1000) {
      return { ...summaryBase, dry_run: false, succeeded: 0, failed: 0, cached: 0, skipped: 1, elapsed_seconds: 0, results: [{ input: images, output, status: "skipped", error: `batch timeout exceeded (${timeout}s shared budget)` }] };
    }
    const fileStarted = Date.now();
    let result;
    let status = "ok";
    let error = null;
    let code = null;
    try {
      result = await slideshow({
        images, output,
        duration: args.duration ?? 3,
        transition: args.transition ?? "fade",
        transitionDuration: args.transition_duration ?? 1,
        fps: args.fps ?? 30, width: args.width ?? 1280, height: args.height ?? 720,
        audio: args.audio ?? null, crf: args.crf ?? 23,
      });
    } catch (e) {
      status = "error";
      error = e.message;
      code = e instanceof MediaKitError ? e.code : "ERROR";
    }
    const summary = {
      ...summaryBase, dry_run: false,
      succeeded: status === "ok" ? 1 : 0, failed: status === "error" ? 1 : 0, cached: 0, skipped: 0,
      elapsed_seconds: +((Date.now() - startedAt) / 1000).toFixed(1),
      results: [{ input: images, output, status, elapsed_ms: Date.now() - fileStarted, ...(result ? { result } : {}), ...(error ? { error, code } : {}) }],
    };
    summary.manifest = path.join(outDir, BATCH_MANIFEST_FILENAME);
    await writeFile(summary.manifest, JSON.stringify(summary, null, 2), "utf8");
    return summary;
  }
  const truncated = files.length > max;
  const selected = files.slice(0, max);
  const items = selected.map((f) => {
    const rel = path.relative(inDir, f);
    // A probe-only item has no output file — its row carries the
    // analysis in `result` instead.
    if (probeOnly) return { input: f, relative: rel.split(path.sep).join("/"), output: null, outputRelative: null };
    const ext = batchOutputExt(operation, path.extname(f).slice(1).toLowerCase(), args);
    const outRel = path.join(path.dirname(rel), `${path.basename(f, path.extname(f))}${suffix}.${ext}`);
    return { input: f, relative: rel.split(path.sep).join("/"), output: path.join(outDirAbs, outRel), outputRelative: outRel.split(path.sep).join("/") };
  });

  if (dryRun) {
    return {
      operation, pattern: pattern.trim(), input_dir: inDir, output_dir: outDirAbs,
      args, jobs: jobCount, cache, output_suffix: suffix, dry_run: true,
      files_total: files.length, files_matched: selected.length, truncated,
      results: items.map((it) => ({ input: it.input, output: it.output, status: "planned" })),
      ...(skippedDirectories ? { skipped_directories: skippedDirectories } : {}),
    };
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeout * 1000;
  const outDir = await prepareOutputDir(outDirAbs);

  // Content-hash cache (ffmpeg-skill's batch.py idea): the key covers
  // the input bytes + operation + args + suffix, so an unchanged file
  // is never re-encoded. Operations with a sidecar file (cut_words'
  // words file, chroma_key's background image) add the sidecar's
  // bytes via spec.extraHash — two byte-identical inputs with
  // different sidecars are different jobs. A hit is only trusted when
  // the cached output still exists on disk with the recorded size AND
  // sha256 — a stale or hand-edited output is re-run, not reported
  // as done.
  const cachePath = path.join(outDir, BATCH_CACHE_FILENAME);
  let cacheData = { version: 1, entries: {} };
  if (cache) {
    try {
      const raw = JSON.parse(await readFile(cachePath, "utf8"));
      if (raw && raw.version === 1 && raw.entries && typeof raw.entries === "object") cacheData = raw;
    } catch { /* missing or corrupt cache starts fresh, never fails the batch */ }
  }
  const cacheKeyFor = async (item) => {
    const inputHash = await hashFile(item.input);
    let extraHash = null;
    if (typeof spec.extraHash === "function") {
      try { extraHash = await spec.extraHash(item.input, args); } catch { extraHash = null; }
    }
    return createHash("sha256").update(stableStringify({ operation, args, suffix, inputHash, extraHash })).digest("hex");
  };

  const results = new Array(items.length);
  let next = 0;
  let aborted = false;
  let invalidArgStreak = 0;
  async function worker() {
    for (;;) {
      if (aborted) return;
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (Date.now() > deadline) {
        results[i] = { input: item.input, output: item.output, status: "skipped", error: `batch timeout exceeded (${timeout}s shared budget)` };
        continue;
      }
      if (cache) {
        const key = await cacheKeyFor(item);
        const hit = cacheData.entries[key];
        if (hit) {
          // A probe-only hit has no output file to verify: the key
          // already covers the input bytes + operation + args, so a
          // hit can only come from an identical input — the stored
          // result IS the cache.
          if (probeOnly && hit.result !== undefined) {
            results[i] = { input: item.input, output: null, status: "cached", result: hit.result };
            continue;
          }
          try {
            const st = await stat(hit.output);
            if (st.size === hit.output_size_bytes && (await hashFile(hit.output)) === hit.output_sha256) {
              // A hit still owes this item its own output file: a
              // byte-identical twin input must not be reported
              // "cached" while its file only exists under the first
              // twin's name. Copy (same bytes, verified above) — but
              // only when this item's own output is missing or stale:
              // a second run of the same batch must leave its files
              // untouched (mtime), not re-copy them.
              if (hit.output !== item.output) {
                let needCopy = true;
                try {
                  const ost = await stat(item.output);
                  if (ost.size === hit.output_size_bytes && (await hashFile(item.output)) === hit.output_sha256) needCopy = false;
                } catch { /* missing output: copy below */ }
                if (needCopy) await copyFile(hit.output, item.output);
              }
              results[i] = { input: item.input, output: item.output, status: "cached", result: { ...hit.result, output: item.output } };
              continue;
            }
          } catch { /* cached output gone or changed: fall through and re-run */ }
        }
        item.cacheKey = key;
      }
      const fileStarted = Date.now();
      try {
        const r = await spec.run(item.input, item.output, args);
        const elapsedMs = Date.now() - fileStarted;
        results[i] = { input: item.input, output: item.output, status: "ok", elapsed_ms: elapsedMs, result: r };
        invalidArgStreak = 0;
        if (cache) {
          // A probe-only result is stored bare — there is no output
          // file whose size + sha256 could verify it.
          if (probeOnly) {
            cacheData.entries[item.cacheKey] = { result: r };
          } else {
            try {
              const st = await stat(item.output);
              cacheData.entries[item.cacheKey] = {
                output: item.output, output_size_bytes: st.size,
                output_sha256: await hashFile(item.output), result: r,
              };
            } catch { /* cache write is best-effort; the file itself is done */ }
          }
        }
      } catch (e) {
        const code = e instanceof MediaKitError ? e.code : "ERROR";
        results[i] = { input: item.input, output: item.output, status: "error", elapsed_ms: Date.now() - fileStarted, error: e.message, code };
        if (stopOnError) aborted = true;
        else if (jobCount === 1 && code === "INVALID_ARG") {
          // A mistyped arg fails every file identically — abort after
          // three leading validation failures instead of burning
          // through the whole folder. (Sequential mode only: with
          // parallel workers the "first three" are not well-defined.)
          invalidArgStreak++;
          if (invalidArgStreak >= 3) aborted = true;
        } else invalidArgStreak = 0;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobCount, items.length) }, worker));
  for (let i = 0; i < items.length; i++) {
    if (!results[i]) {
      results[i] = { input: items[i].input, output: items[i].output, status: "skipped", error: "batch stopped early (see the first error)" };
    }
  }

  const summary = {
    operation, pattern: pattern.trim(), input_dir: inDir, output_dir: outDir,
    args, jobs: jobCount, cache, output_suffix: suffix,
    files_total: files.length, files_matched: selected.length, truncated,
    succeeded: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "error").length,
    cached: results.filter((r) => r.status === "cached").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    elapsed_seconds: +((Date.now() - startedAt) / 1000).toFixed(1),
    results,
    ...(skippedDirectories ? { skipped_directories: skippedDirectories } : {}),
  };
  const manifestPath = path.join(outDir, BATCH_MANIFEST_FILENAME);
  summary.manifest = manifestPath;
  await writeFile(manifestPath, JSON.stringify(summary, null, 2), "utf8");
  if (cache) await writeFile(cachePath, JSON.stringify(cacheData, null, 2), "utf8");
  return summary;
}

// ---------------------------------------------------------------- manifest
// Run a whole edit pipeline from ONE declarative JSON file (the idea
// behind kaomei/stickman-video-director's Autopilot manifest + the
// edit.json plan in KKHS AI Video Studio: an agent writes the plan,
// a human can read and tweak it, one call renders it).
//
//   {
//     "version": 1,
//     "input": "source.mp4",            // relative to the manifest file
//     "output": "final.mp4",            // relative to the manifest file
//     "steps": [
//       {"tool": "trim", "args": {"start": 2, "end": 8}},
//       {"tool": "reframe", "args": {"strategy": "blur", "width": 1080, "height": 1920}},
//       {"tool": "loudness", "args": {"target_lufs": -14}}
//     ],
//     "qa": "tiktok"                    // optional: qa_report the result
//   }
//
// Rules, all enforced before any ffmpeg runs (lint-before-render):
// the whole manifest is validated up front — version, tool names,
// arg keys, output extension chain — so a typo fails in seconds,
// not after step 3 of 5. Steps run in order, each one's output
// feeding the next; a step failure aborts the run and the
// intermediates are kept for inspection. Each step is cached by
// content hash (input bytes + tool + args + sidecar-file bytes, same
// design as batch's cache), verified against the cached output's
// size + sha256 — re-running an unchanged manifest re-encodes
// nothing, and editing step 3 only re-runs from step 3 (its input
// hash is unchanged, its args differ). --dry-run prints the plan
// and writes nothing: the approve-before-render gate. Intermediates
// live under the output dir (never /tmp, so MEDIAKIT_WORKDIR still
// holds) and are deleted on success unless --keep-intermediates.

// Single-input/single-output steps a manifest may chain: the batch
// operations plus the four single-input tools batch does not cover.
// slideshow is the exception that proves the rule — it builds from
// images in args, so it may only be step 1 (it ignores the chain
// input; the manifest's input should be the first slide image).
// download is the second exception: it fetches from a URL in args,
// so it may only be step 1 too — and when it is step 1 the
// manifest's `input` may be omitted entirely (there is no local file
// to start from; the extension then seeds from the manifest output
// unless the URL names one). Multi-input tools (concat, mix, mux,
// pip) and probe-only tools that only describe a file (probe, check,
// keyframes...) are not chainable steps — a manifest is one pipeline
// through one file. hook is the probe-only exception: it analyzes the
// chain file at that point and passes it through unchanged, so the
// director can record WHY the next trim cuts where it does — its
// step result carries the ranked windows, its output is the file it
// analyzed, and the cache stores the result with no file to verify.
export const MANIFEST_STEPS = {
  ...BATCH_OPERATIONS,
  denoise: {
    args: ["filter", "strength", "crf"],
    run: (input, output, a) => denoise({ input, output, filter: a.filter ?? "hqdn3d", strength: a.strength ?? 0.5, crf: a.crf ?? 23 }),
  },
  interpolate: {
    args: ["fps", "mode", "crf"],
    run: (input, output, a) => interpolate({ input, output, fps: a.fps, mode: a.mode ?? "blend", crf: a.crf ?? 23 }),
  },
  burn_captions: {
    args: ["captions", "font_size", "margin_v", "style", "outline_color", "max_lines", "platform"],
    run: (input, output, a) => burnCaptions({ input, output, captions: a.captions, fontSize: a.font_size ?? null, marginV: a.margin_v ?? null, style: a.style ?? null, outlineColor: a.outline_color ?? "black", maxLines: a.max_lines ?? null, platform: a.platform ?? null }),
  },
  overlay: {
    args: ["overlay", "position", "margin", "width", "opacity", "start", "end"],
    run: (input, output, a) => overlayImage({ input, output, overlay: a.overlay, position: a.position ?? "top-right", margin: a.margin ?? 24, width: a.width ?? null, opacity: a.opacity ?? 1, start: a.start ?? null, end: a.end ?? null }),
  },
  chroma_key: {
    args: ["color", "similarity", "blend", "background", "crf"],
    run: (input, output, a) => chromaKey({ input, output, color: a.color ?? "00FF00", similarity: a.similarity ?? 0.1, blend: a.blend ?? 0.0, background: a.background ?? null, crf: a.crf ?? 23 }),
  },
  // broll inserts clips at timestamps (fullscreen cover or PiP) —
  // clips is an array of {file, at, duration?, position?, ...} like
  // the MCP shape, so it needs the same array exemption as
  // slideshow images (see validateBrollManifestArgs + the resolver
  // and cache hash below).
  broll: {
    args: ["clips", "audio"],
    run: (input, output, a) => insertBroll({ input, output, clips: a.clips, audio: a.audio ?? "main" }),
  },
  // fastforward speeds up marked spans — segments is an array of
  // {start, end, speed} like the MCP shape (same exemption as
  // broll's clips). Batch does NOT take it: spans are per-clip
  // editorial decisions, like broll clips (lượt 95).
  fastforward: {
    args: ["segments", "badge", "label", "crf"],
    run: (input, output, a) => fastForwardClip({ input, output, segments: a.segments, badge: a.badge ?? true, label: a.label ?? null, crf: a.crf ?? 23 }),
  },
  // Manifest overrides the batch shape: a manifest is one input, so
  // the step takes one words file, not a words directory.
  cut_words: {
    args: ["words_file", "remove", "fillers", "indices", "keep", "pad_before", "pad_after", "min_keep"],
    run: (input, output, a) => cutWords({
      input, output, wordsFile: a.words_file,
      remove: a.remove ?? null, fillers: a.fillers ?? false, indices: a.indices ?? null, keep: a.keep ?? null,
      padBefore: a.pad_before ?? 0.06, padAfter: a.pad_after ?? 0.12, minKeep: a.min_keep ?? 0.2,
    }),
  },
  // Same override for remove_retakes: one words file for the one input.
  remove_retakes: {
    args: ["words_file", "min_words", "max_gap_words", "max_gap_seconds", "keep", "pad_before", "pad_after", "min_keep"],
    run: (input, output, a) => removeRetakes({
      input, output, wordsFile: a.words_file,
      minWords: a.min_words ?? 3, maxGapWords: a.max_gap_words ?? 8, maxGapSeconds: a.max_gap_seconds ?? 5,
      keep: a.keep ?? "last",
      padBefore: a.pad_before ?? 0.06, padAfter: a.pad_after ?? 0.12, minKeep: a.min_keep ?? 0.2,
    }),
  },
  // download is manifest-only, not a batch operation: batch maps one
  // operation over files matching a glob, and a download's input is
  // a URL, not a file — there is nothing to map over. In a manifest
  // it is the pipeline's source, like slideshow: step 1 only, and
  // the manifest's `input` may be omitted (see manifest()).
  download: {
    // args must list every key run() reads: cache/cache_dir/
    // max_retries/rate_limit_rps were read but not listed, so a
    // manifest download step with cache:true was rejected at lint
    // time even though determinism's docs promised it works (lượt 90).
    args: ["url", "max_size_mb", "timeout_seconds", "cache", "cache_dir", "max_retries", "rate_limit_rps", "license"],
    run: (input, output, a) => downloadMedia({ url: a.url, output, maxSizeMb: a.max_size_mb ?? 500, timeoutSeconds: a.timeout_seconds ?? 300, cache: a.cache ?? false, maxRetries: a.max_retries ?? 3, rateLimitRps: a.rate_limit_rps ?? 0, cacheDir: a.cache_dir ?? null, license: a.license ?? null }),
  },
};

const MANIFEST_CACHE_DIRNAME = ".mediakit-manifest-cache";
const MANIFEST_MAX_STEPS = 32;

// Step args that name a sidecar file: resolved relative to the
// manifest file (like input/output), and hashed into the cache key
// so editing the captions file re-runs the burn step. chroma_key's
// `background` is the odd one: it is either an image file or a hex
// color — only a file resolves and hashes (the hex is already in
// args, and resolving "FF0000" relative to the manifest would turn
// a color into a missing file). The resolver and the cache-key loop
// below both skip hex backgrounds via isHexColorArg.
const MANIFEST_FILE_ARGS = ["captions", "overlay", "words_file", "background", "audio", "history_file"];

// A manifest slideshow step's array args, validated here (the
// generic loop below only allows scalars). images: paths or
// {file, duration} objects, 2-32 entries; durations: one number
// per image. transitions/transition_durations arrays are NOT
// exposed in v1 — one transition type for all joins in a manifest.
function validateSlideshowManifestArgs(step, args, label) {
  if (args.images === undefined || args.images === null) {
    throw new MediaKitError(`${label} (slideshow) needs images — an array of 2-32 image paths (or {file, duration} objects)`, "INVALID_ARG");
  }
  if (!Array.isArray(args.images) || args.images.length < 2 || args.images.length > 32) {
    throw new MediaKitError(`${label} (slideshow) images must be an array of 2-32 image paths (or {file, duration} objects), got: ${Array.isArray(args.images) ? `${args.images.length} entries` : typeof args.images}`, "INVALID_ARG");
  }
  args.images.forEach((s, j) => {
      if (typeof s === "string") {
        if (!s.trim()) throw new MediaKitError(`${label} (slideshow) images[${j}] is an empty path`, "INVALID_ARG");
      } else if (s && typeof s === "object" && !Array.isArray(s)) {
        if (typeof s.file !== "string" || !s.file.trim()) throw new MediaKitError(`${label} (slideshow) images[${j}] needs a file path`, "INVALID_ARG");
        if (s.duration !== undefined && s.duration !== null && typeof s.duration !== "number") throw new MediaKitError(`${label} (slideshow) images[${j}].duration must be a number of seconds`, "INVALID_ARG");
        for (const k of Object.keys(s)) {
          if (!["file", "duration"].includes(k)) throw new MediaKitError(`${label} (slideshow) images[${j}] does not take "${k}" (only file, duration)`, "INVALID_ARG");
        }
      } else {
        throw new MediaKitError(`${label} (slideshow) images[${j}] must be a file path or {file, duration}`, "INVALID_ARG");
      }
  });
  if (args.durations !== undefined && args.durations !== null) {
    if (!Array.isArray(args.durations) || args.durations.some((d) => typeof d !== "number")) {
      throw new MediaKitError(`${label} (slideshow) durations must be an array of numbers, one per image`, "INVALID_ARG");
    }
  }
}

function validateBrollManifestArgs(step, args, label) {
  if (!Array.isArray(args.clips) || args.clips.length < 1 || args.clips.length > BROLL_MAX_CLIPS) {
    throw new MediaKitError(`${label} (broll) clips must be an array of 1-${BROLL_MAX_CLIPS} {file, at, ...} objects, got: ${Array.isArray(args.clips) ? `${args.clips.length} entries` : typeof args.clips}`, "INVALID_ARG");
  }
  args.clips.forEach((c, j) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new MediaKitError(`${label} (broll) clips[${j}] must be an object {file, at, ...}`, "INVALID_ARG");
    }
    if (typeof c.file !== "string" || !c.file.trim()) {
      throw new MediaKitError(`${label} (broll) clips[${j}] needs a file path`, "INVALID_ARG");
    }
    if ((typeof c.at !== "number" && typeof c.at !== "string") || (typeof c.at === "number" && !(c.at >= 0))) {
      throw new MediaKitError(`${label} (broll) clips[${j}].at must be seconds or MM:SS >= 0`, "INVALID_ARG");
    }
    for (const k of Object.keys(c)) {
      if (!["file", "at", "duration", "position", "scale", "width", "margin", "fade"].includes(k)) {
        throw new MediaKitError(`${label} (broll) clips[${j}] does not take "${k}" (only file, at, duration, position, scale, width, margin, fade)`, "INVALID_ARG");
      }
    }
  });
  if (args.audio !== undefined && args.audio !== null && !["main", "broll", "mix"].includes(args.audio)) {
    throw new MediaKitError(`${label} (broll) audio must be main|broll|mix, got: ${args.audio}`, "INVALID_ARG");
  }
}

function validateFastForwardManifestArgs(step, args, label) {
  if (!Array.isArray(args.segments) || args.segments.length < 1 || args.segments.length > FASTFORWARD_MAX_SEGMENTS) {
    throw new MediaKitError(`${label} (fastforward) segments must be an array of 1-${FASTFORWARD_MAX_SEGMENTS} {start, end, speed} objects, got: ${Array.isArray(args.segments) ? `${args.segments.length} entries` : typeof args.segments}`, "INVALID_ARG");
  }
  args.segments.forEach((s, j) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new MediaKitError(`${label} (fastforward) segments[${j}] must be an object {start, end, speed}`, "INVALID_ARG");
    }
    if ((typeof s.start !== "number" && typeof s.start !== "string") || (typeof s.start === "number" && !(s.start >= 0))) {
      throw new MediaKitError(`${label} (fastforward) segments[${j}].start must be seconds or MM:SS >= 0`, "INVALID_ARG");
    }
    if ((typeof s.end !== "number" && typeof s.end !== "string") || (typeof s.end === "number" && !(s.end >= 0))) {
      throw new MediaKitError(`${label} (fastforward) segments[${j}].end must be seconds or MM:SS >= 0`, "INVALID_ARG");
    }
    if (typeof s.speed !== "number" || !(s.speed > 1) || s.speed > 16) {
      throw new MediaKitError(`${label} (fastforward) segments[${j}].speed must be a number in (1, 16], got: ${s.speed}`, "INVALID_ARG");
    }
    for (const k of Object.keys(s)) {
      if (!["start", "end", "speed"].includes(k)) {
        throw new MediaKitError(`${label} (fastforward) segments[${j}] does not take "${k}" (only start, end, speed)`, "INVALID_ARG");
      }
    }
  });
  if (args.badge !== undefined && args.badge !== null && typeof args.badge !== "boolean") {
    throw new MediaKitError(`${label} (fastforward) badge must be true/false, got: ${args.badge}`, "INVALID_ARG");
  }
}

const isHexColorArg = (v) => typeof v === "string" && (/^#?[0-9A-Fa-f]{6}$/.test(v.trim()) || /^0x[0-9A-Fa-f]{6}$/.test(v.trim()));

export async function manifest({ manifestPath, output = null, cache = true, dryRun = false, keepIntermediates = false }) {
  const manifestAbs = await requireInput(manifestPath, "manifest");
  let raw;
  try {
    raw = await readFile(manifestAbs, "utf8");
  } catch (e) {
    throw new MediaKitError(`cannot read manifest ${manifestPath}: ${e.message}`, "INVALID_INPUT");
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new MediaKitError(`manifest is not valid JSON: ${e.message}`, "INVALID_ARG");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new MediaKitError("manifest must be a JSON object {version, input, steps}", "INVALID_ARG");
  }
  if (doc.version !== 1) {
    throw new MediaKitError(`manifest version must be 1, got: ${doc.version}`, "INVALID_ARG");
  }
  // Revision is managed by patch_manifest (absent = 0); a hand-edited
  // manifest with a non-integer revision fails lint here, not at
  // patch time with a confusing mismatch.
  if (doc.revision !== undefined && doc.revision !== null && (!Number.isInteger(doc.revision) || doc.revision < 0)) {
    throw new MediaKitError(`manifest revision must be a non-negative integer, got: ${doc.revision}`, "INVALID_ARG");
  }
  // A download-first manifest has no local input file: the URL in
  // step 1 IS the input, so `input` may be omitted (any other
  // manifest still needs one).
  const downloadFirst = Array.isArray(doc.steps) && doc.steps.length > 0 && doc.steps[0]?.tool === "download";
  if ((typeof doc.input !== "string" || !doc.input.trim()) && !downloadFirst) {
    throw new MediaKitError("manifest needs an \"input\" file path", "INVALID_ARG");
  }
  if (!Array.isArray(doc.steps) || !doc.steps.length || doc.steps.length > MANIFEST_MAX_STEPS) {
    throw new MediaKitError(`manifest needs 1-${MANIFEST_MAX_STEPS} steps, got: ${Array.isArray(doc.steps) ? doc.steps.length : "not an array"}`, "INVALID_ARG");
  }
  const qaTargets = [...Object.keys(PLATFORMS), "any"];
  if (doc.qa !== undefined && doc.qa !== null && !qaTargets.includes(doc.qa)) {
    throw new MediaKitError(`manifest qa must be one of ${qaTargets.join(", ")}, got: ${doc.qa}`, "INVALID_ARG");
  }
  const manifestDir = path.dirname(manifestAbs);
  const resolveRel = (p) => (path.isAbsolute(p) ? p : path.join(manifestDir, p));
  const inputAbs = typeof doc.input === "string" && doc.input.trim()
    ? await requireInput(resolveRel(doc.input), "manifest input")
    : null;
  const outputRaw = output ?? doc.output;
  if (typeof outputRaw !== "string" || !outputRaw.trim()) {
    throw new MediaKitError("manifest needs an \"output\" file path (in the manifest or -o)", "INVALID_ARG");
  }

  // Validate every step up front: unknown tool / unknown arg key /
  // non-scalar arg value all fail before step 1 runs.
  const steps = doc.steps.map((step, i) => {
    const label = `manifest step ${i + 1}`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new MediaKitError(`${label} must be an object {tool, args}`, "INVALID_ARG");
    }
    const spec = MANIFEST_STEPS[step.tool];
    if (!spec) {
      throw new MediaKitError(`${label}: unknown tool "${step.tool}" (supported: ${Object.keys(MANIFEST_STEPS).join(", ")})`, "INVALID_ARG");
    }
    const args = step.args ?? {};
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new MediaKitError(`${label}: args must be an object`, "INVALID_ARG");
    }
    // slideshow builds a video from images — it cannot transform
    // the previous step's output, so it is only the first step.
    if (step.tool === "slideshow" && i > 0) {
      throw new MediaKitError(`${label}: slideshow must be the first step — it builds a video from images in args, it does not transform the previous step's output`, "INVALID_ARG");
    }
    if (step.tool === "slideshow") validateSlideshowManifestArgs(step, args, label);
    if (step.tool === "broll") validateBrollManifestArgs(step, args, label);
    if (step.tool === "fastforward") validateFastForwardManifestArgs(step, args, label);
    // download fetches from a URL — same rule as slideshow, and the
    // URL is checked at lint time, not after step 1 starts.
    if (step.tool === "download" && i > 0) {
      throw new MediaKitError(`${label}: download must be the first step — it fetches from a URL in args, it does not transform the previous step's output`, "INVALID_ARG");
    }
    if (step.tool === "download" && (typeof args.url !== "string" || !args.url.trim())) {
      throw new MediaKitError(`${label} (download) needs a url`, "INVALID_ARG");
    }
    for (const k of Object.keys(args)) {
      if (!spec.args.includes(k)) {
        throw new MediaKitError(`${label} (${step.tool}) does not take argument "${k}" (supported: ${spec.args.join(", ") || "none"})`, "INVALID_ARG");
      }
      const v = args[k];
      if (step.tool === "slideshow" && (k === "images" || k === "durations")) continue; // arrays, validated above
      if (step.tool === "broll" && k === "clips") continue; // array of {file, at, ...}, validated above
      if (step.tool === "fastforward" && k === "segments") continue; // array of {start, end, speed}, validated above
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new MediaKitError(`${label} (${step.tool}): argument "${k}" must be a string, number or boolean`, "INVALID_ARG");
      }
    }
    // Sidecar files resolve relative to the manifest, like input —
    // except a chroma_key hex background, which is a color, not a file.
    const resolved = { ...args };
    for (const k of MANIFEST_FILE_ARGS) {
      if (typeof resolved[k] === "string" && resolved[k].trim()) {
        if (k === "background" && isHexColorArg(resolved[k])) continue;
        // A broll step's `audio` is the main|broll|mix enum, not the
        // slideshow music-bed file MANIFEST_FILE_ARGS was written
        // for — resolving "main" relative to the manifest turned it
        // into a bogus path (measured 2026-11-18: ".../outputs/main").
        if (step.tool === "broll" && k === "audio") continue;
        resolved[k] = resolveRel(resolved[k]);
      }
    }
    // Slideshow images resolve the same way (each entry a path, or
    // a {file, duration} object whose file resolves).
    if (step.tool === "slideshow" && Array.isArray(resolved.images)) {
      resolved.images = resolved.images.map((s) => (typeof s === "string" ? resolveRel(s) : { ...s, file: resolveRel(s.file) }));
    }
    // B-roll clips resolve the same way (each {file, ...} object's
    // file resolves relative to the manifest).
    if (step.tool === "broll" && Array.isArray(resolved.clips)) {
      resolved.clips = resolved.clips.map((c) => ({ ...c, file: resolveRel(c.file) }));
    }
    return { index: i, tool: step.tool, spec, args, resolved };
  });

  // Output extension follows the step chain (extract_audio changes
  // it); a mismatched output extension is adjusted and reported,
  // never silently written with wrong bytes under a wrong name. A
  // download-first manifest has no input file, so the chain seeds
  // from the manifest output's extension instead (the download step
  // itself prefers the URL's extension when it names a media file).
  let ext = inputAbs
    ? path.extname(inputAbs).slice(1).toLowerCase()
    : path.extname(resolveRel(outputRaw)).slice(1).toLowerCase();
  const chainExts = steps.map((s) => {
    ext = batchOutputExt(s.tool, ext, s.args);
    return ext;
  });
  const finalExt = chainExts[chainExts.length - 1];
  let finalOutput = resolveRel(outputRaw);
  let outputAdjusted = false;
  if (path.extname(finalOutput).slice(1).toLowerCase() !== finalExt) {
    finalOutput = `${finalOutput.slice(0, finalOutput.length - path.extname(finalOutput).length)}.${finalExt}`;
    outputAdjusted = true;
  }
  const outDir = path.dirname(finalOutput);
  const inputProbe = inputAbs ? await probe(inputAbs) : null;

  if (dryRun) {
    // Plan only: probe the input (read-only) and list the chain.
    // No directory is created, no file is written.
    let cur = inputAbs;
    const planned = steps.map((s, i) => {
      // A probe-only step passes the chain file through unchanged:
      // its "output" is the input it analyzed, not a new file.
      const out = s.spec.probeOnly ? cur : path.join(outDir, `.mediakit-manifest-tmp-plan`, `step-${String(i).padStart(2, "0")}-${s.tool}.${chainExts[i]}`);
      const row = { index: i, tool: s.tool, args: s.args, input: cur, output: out, status: "planned" };
      cur = out;
      return row;
    });
    return {
      operation: "manifest", manifest: manifestAbs, input: inputAbs, output: finalOutput,
      ...(outputAdjusted ? { output_adjusted: true } : {}),
      qa: doc.qa ?? null, dry_run: true, cache,
      input_duration_seconds: inputProbe?.duration_seconds ?? null,
      input_dimensions: inputProbe?.video ? `${inputProbe.video.width}x${inputProbe.video.height}` : null,
      steps: planned,
    };
  }

  const outDirAbs = await prepareOutputDir(outDir);
  const finalOutputAbs = await prepareOutput(finalOutput, [inputAbs]);
  const tmpDir = path.join(outDirAbs, `.mediakit-manifest-tmp-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
  const cacheDir = path.join(outDirAbs, MANIFEST_CACHE_DIRNAME);
  const cacheIndexPath = path.join(cacheDir, "index.json");
  let cacheIndex = {};
  if (cache) {
    await mkdir(cacheDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(cacheIndexPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cacheIndex = parsed;
    } catch { /* missing or corrupt cache index starts fresh */ }
  }
  const saveCacheIndex = async () => {
    if (!cache) return;
    try { await writeFile(cacheIndexPath, JSON.stringify(cacheIndex, null, 2), "utf8"); } catch { /* cache index is best-effort */ }
  };

  const startedAt = Date.now();
  const stepResults = [];
  let cacheHits = 0;
  let curInput = inputAbs;
  try {
    for (const s of steps) {
      const nextExt = chainExts[s.index];
      const stepOut = path.join(tmpDir, `step-${String(s.index).padStart(2, "0")}-${s.tool}.${nextExt}`);
      // A download-first manifest has no chain input for step 1 —
      // the URL is already in the cache key via args, so null is the
      // honest input hash there.
      const inputHash = curInput ? await hashFile(curInput) : null;
      let extraHash = null;
      for (const k of MANIFEST_FILE_ARGS) {
        if (typeof s.resolved[k] === "string") {
          if (k === "background" && isHexColorArg(s.resolved[k])) continue;
          if (s.tool === "broll" && k === "audio") continue; // enum, not a file (see the resolver above)
          try { extraHash = await hashFile(s.resolved[k]); } catch { extraHash = null; }
        }
      }
      // Slideshow: the slides ARE the input — hash every slide
      // (plus the bed, already hashed above when present) so
      // editing one image re-runs the step instead of serving the
      // old slideshow from cache.
      if (s.tool === "slideshow") {
        const slideFiles = slideshowImageFiles(s.resolved.images ?? []);
        if (slideFiles.length) {
          const hashes = [];
          for (const f of slideFiles) {
            try { hashes.push(await hashFile(f)); } catch { hashes.push(null); }
          }
          if (extraHash) hashes.push(extraHash);
          extraHash = createHash("sha256").update(hashes.join(":")).digest("hex");
        }
      }
      // B-roll: the clips ARE part of the input — hash every clip
      // file so editing one re-runs the step instead of serving
      // the old B-roll from cache (same pattern as slideshow).
      if (s.tool === "broll") {
        const clipFiles = (s.resolved.clips ?? []).map((c) => c.file).filter((f) => typeof f === "string");
        if (clipFiles.length) {
          const hashes = [];
          for (const f of clipFiles) {
            try { hashes.push(await hashFile(f)); } catch { hashes.push(null); }
          }
          if (extraHash) hashes.push(extraHash);
          extraHash = createHash("sha256").update(hashes.join(":")).digest("hex");
        }
      }
      const key = createHash("sha256")
        .update(stableStringify({ index: s.index, tool: s.tool, args: s.args, inputHash, extraHash }))
        .digest("hex");
      const cacheFile = path.join(cacheDir, `${key}.${nextExt}`);
      let hit = null;
      if (cache) {
        const entry = cacheIndex[key];
        if (entry) {
          // Probe-only entries store no file: the key covers the
          // input bytes + tool + args, so a matching key IS the
          // verification — there is nothing on disk to re-check.
          if (s.spec.probeOnly) {
            if (entry.result !== undefined) hit = entry;
          } else {
            try {
              const st = await stat(cacheFile);
              if (st.size === entry.output_size_bytes && (await hashFile(cacheFile)) === entry.output_sha256) hit = entry;
            } catch { /* cached intermediate gone or changed: re-run */ }
          }
        }
      }
      if (hit) {
        if (s.spec.probeOnly) {
          cacheHits++;
          stepResults.push({ index: s.index, tool: s.tool, args: s.args, status: "cached", output: curInput, result: hit.result });
        } else {
          await copyFile(cacheFile, stepOut);
          cacheHits++;
          stepResults.push({ index: s.index, tool: s.tool, args: s.args, status: "cached", output: stepOut, result: hit.result });
        }
      } else {
        const stepStarted = Date.now();
        let r;
        try {
          r = await s.spec.run(curInput, s.spec.probeOnly ? null : stepOut, s.resolved);
        } catch (e) {
          const code = e instanceof MediaKitError ? e.code : "ERROR";
          throw new MediaKitError(`manifest step ${s.index + 1} (${s.tool}) failed: ${e.message} [${code}] — intermediates kept in ${tmpDir}`, code);
        }
        stepResults.push({ index: s.index, tool: s.tool, args: s.args, status: "ok", elapsed_ms: Date.now() - stepStarted, output: s.spec.probeOnly ? curInput : stepOut, result: r });
        if (cache) {
          if (s.spec.probeOnly) {
            try {
              cacheIndex[key] = { result: r };
              await saveCacheIndex();
            } catch { /* cache write is best-effort; the step itself is done */ }
          } else {
            try {
              await copyFile(stepOut, cacheFile);
              const st = await stat(cacheFile);
              cacheIndex[key] = {
                output: cacheFile, output_size_bytes: st.size,
                output_sha256: await hashFile(cacheFile), result: r,
              };
              await saveCacheIndex();
            } catch { /* cache write is best-effort; the step itself is done */ }
          }
        }
      }
      // A probe-only step passes the chain file through unchanged.
      if (!s.spec.probeOnly) curInput = stepOut;
    }
  } catch (e) {
    // Intermediates are kept on failure so the broken step can be
    // inspected and re-run by hand; the error names the directory.
    throw e;
  }

  await copyFile(curInput, finalOutputAbs);
  const finalProbe = await probe(finalOutputAbs);
  const finalInfo = await fileInfo(finalOutputAbs);
  let qaResult = null;
  if (doc.qa) qaResult = await qaReport({ input: finalOutputAbs, target: doc.qa });
  if (!keepIntermediates) {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
  return {
    operation: "manifest", manifest: manifestAbs, input: inputAbs, output: finalOutputAbs,
    ...(outputAdjusted ? { output_adjusted: true } : {}),
    qa: doc.qa ?? null, dry_run: false, cache,
    steps: stepResults,
    cache_hits: cacheHits,
    steps_run: stepResults.filter((r) => r.status === "ok").length,
    elapsed_seconds: +((Date.now() - startedAt) / 1000).toFixed(1),
    final: {
      duration_seconds: finalProbe.duration_seconds,
      dimensions: finalProbe.video ? `${finalProbe.video.width}x${finalProbe.video.height}` : null,
      ...finalInfo,
    },
    qa_result: qaResult,
    ...(keepIntermediates ? { intermediates_dir: tmpDir } : {}),
  };
}

// ---------------------------------------------------------------- patch_manifest
// Revision-guarded manifest patch (AH64-dll/OpenEdit's revision guard
// idea: a write against a stale revision is refused instead of
// silently overwriting newer work — and MADPANDA3D/FFMPEG-MCP's
// atomic-reservation philosophy: concurrent writers must not clobber
// each other). A manifest carries an optional top-level `revision`
// (absent = 0); patching requires the caller's `expected_revision`
// to match the file's current revision, applies 1-32 ops to a clone,
// proves the patched manifest still lints + plans (manifest
// --dry-run on a temp copy), then writes atomically (.partial +
// rename) with revision + 1. Any failure before the rename leaves
// the original file byte-identical: a revision mismatch, a bad op,
// or a patched manifest that no longer validates all refuse without
// touching the file.
//
// Ops:
//   {op: "set", path: "output", value: "final2.mp4"}   — top-level
//     input/output/qa, or steps.N.tool / steps.N.args.KEY (scalar
//     values only; version/revision are managed, not settable)
//   {op: "add_step", step: {tool, args?}, index?}      — append, or
//     insert at index
//   {op: "remove_step", index}                         — never the
//     last remaining step
//   {op: "replace_step", index, step: {tool, args?}}
export async function patchManifest({ manifestPath, patch, expectedRevision }) {
  const manifestAbs = await requireInput(manifestPath, "manifest");
  const expected = num(expectedRevision, "expected_revision", { min: 0, integer: true });
  if (!Array.isArray(patch) || patch.length < 1 || patch.length > 32) {
    throw new MediaKitError(`patch must be an array of 1-32 operations, got: ${Array.isArray(patch) ? `${patch.length} operations` : typeof patch}`, "INVALID_ARG");
  }
  let raw;
  try {
    raw = await readFile(manifestAbs, "utf8");
  } catch (e) {
    throw new MediaKitError(`cannot read manifest ${manifestPath}: ${e.message}`, "INVALID_INPUT");
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new MediaKitError(`manifest is not valid JSON: ${e.message}`, "INVALID_ARG");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new MediaKitError("manifest must be a JSON object {version, input, steps}", "INVALID_ARG");
  }
  const currentRevision = doc.revision ?? 0;
  if (!Number.isInteger(currentRevision) || currentRevision < 0) {
    throw new MediaKitError(`manifest revision must be a non-negative integer, got: ${doc.revision}`, "INVALID_ARG");
  }
  if (expected !== currentRevision) {
    throw new MediaKitError(`manifest revision is ${currentRevision}, expected ${expected} — re-read the manifest and retry with the current revision (nothing was written)`, "REVISION_MISMATCH");
  }

  // Validate every op structurally BEFORE touching the doc, so a bad
  // op list fails as a whole instead of half-applying. Ops apply in
  // order, each addressing the list as the previous ops left it
  // (JSON Patch semantics) — so the bounds below simulate the
  // running step count: an add grows it, a remove shrinks it, and a
  // batch that would empty the list is refused at the remove that
  // would take the last step, not after the fact.
  const steps = doc.steps;
  if (!Array.isArray(steps) || !steps.length) {
    throw new MediaKitError("manifest has no steps to patch", "INVALID_ARG");
  }
  let simLen = steps.length;
  const stepIndex = (v, label) => {
    if (!Number.isInteger(v) || v < 0 || v >= simLen) {
      throw new MediaKitError(`${label} must be a step index 0-${simLen - 1}, got: ${v}`, "INVALID_ARG");
    }
    return v;
  };
  const checkStepShape = (s, label) => {
    if (!s || typeof s !== "object" || Array.isArray(s) || typeof s.tool !== "string" || !s.tool.trim()) {
      throw new MediaKitError(`${label} must be an object {tool, args?} with a tool name`, "INVALID_ARG");
    }
    if (s.args !== undefined && s.args !== null && (typeof s.args !== "object" || Array.isArray(s.args))) {
      throw new MediaKitError(`${label}.args must be an object`, "INVALID_ARG");
    }
    for (const k of Object.keys(s)) {
      if (k !== "tool" && k !== "args") throw new MediaKitError(`${label} does not take "${k}" (only tool, args)`, "INVALID_ARG");
    }
  };
  for (let i = 0; i < patch.length; i++) {
    const op = patch[i];
    const label = `patch[${i}]`;
    if (!op || typeof op !== "object" || Array.isArray(op) || typeof op.op !== "string") {
      throw new MediaKitError(`${label} must be an object with an "op"`, "INVALID_ARG");
    }
    if (op.op === "set") {
      if (typeof op.path !== "string" || !op.path.trim()) throw new MediaKitError(`${label} (set) needs a path`, "INVALID_ARG");
      if (op.value !== null && typeof op.value !== "string" && typeof op.value !== "number" && typeof op.value !== "boolean") {
        throw new MediaKitError(`${label} (set) value must be a string, number, boolean or null`, "INVALID_ARG");
      }
      const parts = op.path.split(".");
      if (["version", "revision"].includes(parts[0]) || (parts[0] === "steps" && parts.length < 3) || parts.length > 4) {
        throw new MediaKitError(`${label} (set) cannot set "${op.path}" — version/revision are managed, whole steps change via add/remove/replace_step`, "INVALID_ARG");
      }
      if (parts[0] === "steps") {
        const idx = stepIndex(Number(parts[1]), `${label} (set)`);
        if (parts.length !== 3 && parts.length !== 4) throw new MediaKitError(`${label} (set) path must be steps.N.tool or steps.N.args.KEY, got: ${op.path}`, "INVALID_ARG");
        if (parts[2] === "tool" && parts.length !== 3) throw new MediaKitError(`${label} (set) path must be steps.N.tool or steps.N.args.KEY, got: ${op.path}`, "INVALID_ARG");
        if (parts[2] === "args" && parts.length !== 4) throw new MediaKitError(`${label} (set) path must be steps.N.tool or steps.N.args.KEY, got: ${op.path}`, "INVALID_ARG");
        if (parts[2] !== "tool" && parts[2] !== "args") throw new MediaKitError(`${label} (set) path must be steps.N.tool or steps.N.args.KEY, got: ${op.path}`, "INVALID_ARG");
        if (parts[2] === "tool" && (typeof op.value !== "string" || !op.value.trim())) throw new MediaKitError(`${label} (set) steps.${idx}.tool needs a tool name`, "INVALID_ARG");
      } else if (!["input", "output", "qa"].includes(parts[0]) || parts.length !== 1) {
        throw new MediaKitError(`${label} (set) path must be input, output, qa, steps.N.tool or steps.N.args.KEY, got: ${op.path}`, "INVALID_ARG");
      }
    } else if (op.op === "add_step") {
      checkStepShape(op.step, `${label} (add_step).step`);
      if (op.index !== undefined && op.index !== null && (!Number.isInteger(op.index) || op.index < 0 || op.index > simLen)) {
        throw new MediaKitError(`${label} (add_step) index must be 0-${simLen} (append), got: ${op.index}`, "INVALID_ARG");
      }
      simLen += 1;
    } else if (op.op === "remove_step") {
      stepIndex(op.index, `${label} (remove_step) index`);
      if (simLen === 1) throw new MediaKitError(`${label} (remove_step) cannot remove the last remaining step`, "INVALID_ARG");
      simLen -= 1;
    } else if (op.op === "replace_step") {
      stepIndex(op.index, `${label} (replace_step) index`);
      checkStepShape(op.step, `${label} (replace_step).step`);
    } else {
      throw new MediaKitError(`${label}: unknown op "${op.op}" (supported: set, add_step, remove_step, replace_step)`, "INVALID_ARG");
    }
  }

  // Apply to a clone, in order — each op addresses the list as the
  // previous ops left it, exactly as the simulation above checked.
  const next = JSON.parse(JSON.stringify(doc));
  const changes = [];
  for (const op of patch) {
    if (op.op === "set") {
      const parts = op.path.split(".");
      if (parts[0] === "steps") {
        const idx = Number(parts[1]);
        if (parts[2] === "tool") {
          const old = next.steps[idx].tool;
          next.steps[idx].tool = op.value;
          changes.push(`set steps.${parts[1]}.tool = ${JSON.stringify(op.value)} (was ${JSON.stringify(old)})`);
        } else {
          next.steps[idx].args = next.steps[idx].args ?? {};
          const old = next.steps[idx].args[parts[3]];
          next.steps[idx].args[parts[3]] = op.value;
          changes.push(`set steps.${parts[1]}.args.${parts[3]} = ${JSON.stringify(op.value)} (was ${JSON.stringify(old ?? null)})`);
        }
      } else {
        const old = next[parts[0]];
        next[parts[0]] = op.value;
        changes.push(`set ${parts[0]} = ${JSON.stringify(op.value)} (was ${JSON.stringify(old ?? null)})`);
      }
    } else if (op.op === "add_step") {
      const at = op.index ?? next.steps.length;
      const entry = { tool: op.step.tool, args: op.step.args ?? {} };
      next.steps.splice(at, 0, entry);
      changes.push(`add step ${at} (${op.step.tool})`);
    } else if (op.op === "remove_step") {
      const removed = next.steps.splice(op.index, 1)[0];
      changes.push(`remove step ${op.index} (${removed.tool})`);
    } else if (op.op === "replace_step") {
      const old = next.steps[op.index].tool;
      next.steps[op.index] = { tool: op.step.tool, args: op.step.args ?? {} };
      changes.push(`replace step ${op.index} (${old} -> ${op.step.tool})`);
    }
  }
  next.revision = currentRevision + 1;

  // Prove the patched manifest still lints + plans before writing
  // it: run the real validator (manifest --dry-run) on a temp copy
  // in the same directory, so relative paths resolve identically.
  // A failure here leaves the original file untouched.
  const tmpValidate = path.join(path.dirname(manifestAbs), `.mediakit-patch-validate-${process.pid}-${randomBytes(4).toString("hex")}.json`);
  let planned;
  try {
    await writeFile(tmpValidate, JSON.stringify(next, null, 2), "utf8");
    planned = await manifest({ manifestPath: tmpValidate, dryRun: true });
  } catch (e) {
    throw new MediaKitError(`patched manifest fails validation: ${e.message}`, e.code ?? "INVALID_ARG");
  } finally {
    await rm(tmpValidate, { force: true }).catch(() => {});
  }

  // Atomic write: .partial + rename, after the writability pre-check
  // fails fast on a read-only directory instead of after the work.
  await prepareOutput(manifestAbs, []);
  const partial = `${manifestAbs}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(partial, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(partial, manifestAbs);
  } catch (e) {
    await rm(partial, { force: true }).catch(() => {});
    throw e;
  }
  return {
    operation: "patch_manifest",
    manifest: manifestAbs,
    revision_before: currentRevision,
    revision_after: currentRevision + 1,
    ops_applied: patch.length,
    changes,
    validated: { dry_run: true, steps: planned.steps.length, output: planned.output },
  };
}

// ---------------------------------------------------------------- determinism
// Manifest determinism check (heristop/leclap's `verify --rerender`
// idea, applied to the linear manifest tool instead of assemble —
// assemble already has verify --rerender; the manifest cache only
// verifies size + sha256 of an output it already stored, it never
// proves a fresh run reproduces the same bytes). Run the same
// manifest N times with the cache OFF — a cache hit would prove
// nothing — into per-run temp dirs, then compare:
//   * byte sha256 equal on every run -> verdict "byte_identical":
//     the pipeline reproduces exactly (measured on this machine:
//     two identical libx264 encodes are byte-identical, and ffmpeg
//     8.1.2 writes no creation_time into mp4 by default).
//   * bytes differ but framemd5 (decoded-frame digest) equal on
//     every run -> verdict "content_identical": same pictures and
//     same sound, different container bytes — the differing format
//     tags are named (usually creation_time), so the cause is
//     visible instead of a bare "differs".
//   * framemd5 differs -> verdict "differs": the pipeline itself is
//     nondeterministic (a step embeds wall-clock time, randomness,
//     or a re-fetched download that changed); the first differing
//     run pair and the level that moved are named.
// Measured properties (duration/frames/dimensions) are compared too
// — a run that drifts in length is not identical even if its digest
// somehow matches. A download-first manifest re-fetches its URL on
// every run, so a changed server file reports "differs" honestly.
// The temp dir is removed unless keepOutputs (then outputs_dir is
// returned so the runs can be inspected by hand).
export async function checkManifestDeterminism({ manifestPath, runs = 2, keepOutputs = false }) {
  const n = num(runs, "runs", { min: 2, max: 5, integer: true });
  const manifestAbs = await requireInput(manifestPath, "manifest");
  const manifestDir = path.dirname(manifestAbs);
  const workDir = await prepareOutputDir(path.join(manifestDir, `.mediakit-determinism-${process.pid}`));
  const startedAt = Date.now();
  const runRows = [];
  let failed = false;
  try {
    for (let i = 0; i < n; i++) {
      const runOut = path.join(workDir, `run-${i}`, "final.mp4");
      let r;
      try {
        r = await manifest({ manifestPath: manifestAbs, output: runOut, cache: false });
      } catch (e) {
        failed = true;
        const code = e instanceof MediaKitError ? e.code : "ERROR";
        throw new MediaKitError(`determinism run ${i + 1}/${n} failed: ${e.message} [${code}] — outputs kept in ${workDir}`, code);
      }
      const outPath = r.output;
      const info = await fileInfo(outPath);
      const meta = await probe(outPath);
      const frames = meta.video ? await countVideoFrames(outPath) : null;
      runRows.push({
        index: i,
        output: outPath,
        sha256: await hashFile(outPath),
        framemd5: await frameDigest(outPath),
        size_bytes: info.size_bytes,
        duration_seconds: meta.duration_seconds,
        frames,
        dimensions: meta.video ? `${meta.video.width}x${meta.video.height}` : null,
        format_tags: await formatTags(outPath),
      });
    }
  } finally {
    // A failed run keeps its outputs for inspection (the error
    // names the directory); a successful run removes them unless
    // the caller asked to keep them.
    if (!keepOutputs && !failed) {
      try { await rm(workDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
  const comparison = compareDeterminismRuns(runRows);
  return {
    operation: "determinism",
    manifest: manifestAbs,
    runs: n,
    ...comparison,
    ffmpeg_version: await ffmpegVersionString(),
    elapsed_seconds: +((Date.now() - startedAt) / 1000).toFixed(1),
    ...(keepOutputs ? { outputs_dir: workDir } : {}),
    runs_detail: runRows,
  };
}

// Pure comparison of per-run digests, so every verdict branch is
// unit-testable without faking a nondeterministic render (the suite
// imports this directly and feeds it fabricated rows). `rows` are the
// runs_detail rows: {sha256, framemd5, duration_seconds, frames,
// dimensions, format_tags}.
export function compareDeterminismRuns(rows) {
  const first = rows[0];
  const byteIdentical = rows.every((r) => r.sha256 === first.sha256);
  const framesIdentical = rows.every((r) => r.framemd5 !== null && r.framemd5 === first.framemd5);
  const propsIdentical = rows.every((r) =>
    r.duration_seconds === first.duration_seconds && r.frames === first.frames && r.dimensions === first.dimensions);
  let verdict;
  let firstDifference = null;
  let differingTags = null;
  if (byteIdentical && propsIdentical) {
    verdict = "byte_identical";
  } else if (framesIdentical && propsIdentical) {
    verdict = "content_identical";
    // Same frames, different bytes: name the container tags that
    // moved, so the cause is visible. A tag present in one run and
    // absent (or different) in another is a difference.
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r.format_tags ?? {})))];
    differingTags = keys.filter((k) => rows.some((r) => (r.format_tags ?? {})[k] !== (first.format_tags ?? {})[k]));
    firstDifference = {
      level: "bytes",
      detail: differingTags.length
        ? `identical frames, different container bytes — format tags differ: ${differingTags.join(", ")}`
        : "identical frames, different container bytes — no format tag differs, the bytes moved inside the container",
    };
  } else {
    verdict = "differs";
    let pair = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].framemd5 !== first.framemd5 || rows[i].duration_seconds !== first.duration_seconds
        || rows[i].frames !== first.frames || rows[i].dimensions !== first.dimensions) { pair = i; break; }
    }
    firstDifference = {
      level: framesIdentical ? "properties" : "frames",
      runs: pair === null ? [0, 1] : [0, pair],
      detail: framesIdentical
        ? "decoded frames match but a measured property moved between runs"
        : "decoded frames differ between runs — the pipeline is nondeterministic",
    };
  }
  return {
    verdict,
    deterministic: verdict !== "differs",
    byte_identical: byteIdentical,
    frames_identical: framesIdentical,
    properties_identical: propsIdentical,
    ...(differingTags ? { differing_format_tags: differingTags } : {}),
    ...(firstDifference ? { first_difference: firstDifference } : {}),
  };
}

// ---------------------------------------------------------------- assemble
// Film assembler (Autopilot-style, MediaKit tools underneath): one
// declarative film manifest -> a finished video. Voice is the master
// clock: total = lead + measured voice duration + tail, shots are
// converted to frames and must cover the total EXACTLY (no silent
// trim/pad/speed change). Four modes: validate (no writes), preview
// (first N seconds, half size), approve (fingerprint-bound, needs a
// matching preview), render (needs approval unless force:true).
// Shot segments are cached per shot (content hash, like the manifest
// tool) and verified by size + SHA-256 on reuse. v1 limits (stated,
// not hidden): plain cuts, one aspect per manifest, video shots are
// assumed to move. Per-shot text layers ARE supported (shot.text):
// drawtext lower-thirds/titles timed inside the shot, rendered in a
// second pass over the built segment.
const ASSEMBLE_VERSION = "assemble-v3";
// Average glyph advance of DejaVu Sans Bold all-caps text, in em per
// character — used to wrap a text layer before drawtext renders it.
// 0.55 was measured wrong: "IT MEASURES REAL MOVEMENT" is 1118px at
// 64px (0.73 em/char; "TAMPERED = CHANGED" 0.72, "STILL SCORES ZERO"
// 0.65), so a 24-char layer at 64px overflowed a 1080-wide frame by
// ~40px instead of wrapping (caught by eye on the lượt 56 report
// preview, 2026-11-14). 0.75 covers the widest all-caps text measured.
const ASSEMBLE_TEXT_EM_PER_CHAR = 0.75;
const ASSEMBLE_MAX_SHOTS = 64;
const ASSEMBLE_MOTION_GATE_SECONDS = 2.5;
const ASSEMBLE_CANVAS_MAX_SECONDS = 60;
const ASSEMBLE_CACHE_DIRNAME = ".mediakit-assemble-cache";

// Locked style values, read from skills/shorts-video/styles.json (the
// single source of truth, shipped in the npm package under "files").
// If the file is missing or corrupt, fall back to these embedded
// values (identical numbers) and flag it — the render never blocks
// on a docs file, but the result says which source was used.
const SHORTS_STYLE_FALLBACK_BURN = {
  "clean-bold": { font_size: 60, margin_v: 500, style: "background" },
  "minimal-line": { font_size: 56, margin_v: 500, style: "outline" },
  "warm-story": { font_size: 56, margin_v: 500, style: "background" },
};
const SHORTS_STYLES_PATH = fileURLToPath(new URL("../skills/shorts-video/styles.json", import.meta.url));
let cachedShortsStyles = null;
export async function loadShortsStyles() {
  if (cachedShortsStyles) return cachedShortsStyles;
  try {
    const doc = JSON.parse(await readFile(SHORTS_STYLES_PATH, "utf8"));
    const ids = (doc.styles ?? []).map((s) => s.id);
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...SHORTS_STYLE_IDS].sort())) {
      throw new Error("styles.json ids do not match SHORTS_STYLE_IDS");
    }
    for (const s of doc.styles) {
      if (!s.locked?.burn_captions) throw new Error(`style ${s.id} has no locked burn_captions`);
    }
    cachedShortsStyles = { ...doc, fallback: false };
    return cachedShortsStyles;
  } catch {
    cachedShortsStyles = {
      version: 1, fallback: true,
      styles: SHORTS_STYLE_IDS.map((id) => ({ id, locked: { burn_captions: SHORTS_STYLE_FALLBACK_BURN[id] } })),
    };
    return cachedShortsStyles;
  }
}

async function assembleStyleValues(style) {
  if (!style) return null;
  const doc = await loadShortsStyles();
  const entry = doc.styles.find((s) => s.id === style);
  if (!entry) throw new MediaKitError(`assemble style must be one of ${SHORTS_STYLE_IDS.join(", ")}, got: ${style}`, "INVALID_ARG");
  return { burn_captions: { ...entry.locked.burn_captions }, from_fallback: Boolean(doc.fallback) };
}

function assembleOptNum(v, def, label, opts = {}) {
  if (v === null || v === undefined) return def;
  return num(v, label, opts);
}

// Named assemble presets, read from skills/shorts-video/
// assemble-presets.json (the single source of truth, shipped in
// the npm package under "files"). One id picks the film geometry
// + fps + caption style for the whole manifest, so a manifest can
// say `"preset": "vertical"` instead of retyping width/height/fps/
// style — the setup-gate idea from kaomei/stickman-video-director:
// aspect ratio + style are one explicit named choice, never
// silently defaulted. An explicit field in the manifest always
// wins over the preset and is reported in preset_overrides; fields
// the preset filled are listed in preset_applied. Unlike
// styles.json there is no embedded fallback — a missing or corrupt
// presets file fails loudly, because a preset that silently
// resolved to different geometry would ship the wrong aspect ratio.
export const ASSEMBLE_PRESET_IDS = ["vertical", "horizontal", "square", "cinematic", "vertical-60"];
const ASSEMBLE_PRESETS_PATH = fileURLToPath(new URL("../skills/shorts-video/assemble-presets.json", import.meta.url));
let cachedAssemblePresets = null;
export async function getAssemblePresets() {
  if (cachedAssemblePresets) return cachedAssemblePresets;
  let doc;
  try {
    doc = JSON.parse(await readFile(ASSEMBLE_PRESETS_PATH, "utf8"));
  } catch {
    throw new MediaKitError("assemble preset library missing: skills/shorts-video/assemble-presets.json not found next to the package", "PRESET_LIBRARY_MISSING");
  }
  if (!doc || !Array.isArray(doc.presets) || doc.presets.length === 0) {
    throw new MediaKitError("assemble preset library has no presets: skills/shorts-video/assemble-presets.json", "PRESET_LIBRARY_INVALID");
  }
  const byId = {};
  for (const p of doc.presets) {
    if (typeof p?.id !== "string" || !p.id) throw new MediaKitError("assemble preset library: preset without an id", "PRESET_LIBRARY_INVALID");
    if (byId[p.id]) throw new MediaKitError(`assemble preset library: duplicate preset id "${p.id}"`, "PRESET_LIBRARY_INVALID");
    const width = Number(p.width), height = Number(p.height), fps = Number(p.fps);
    if (!Number.isInteger(width) || width < 2 || width > 7680 || width % 2) throw new MediaKitError(`assemble preset library: preset "${p.id}" has bad width ${p.width}`, "PRESET_LIBRARY_INVALID");
    if (!Number.isInteger(height) || height < 2 || height > 4320 || height % 2) throw new MediaKitError(`assemble preset library: preset "${p.id}" has bad height ${p.height}`, "PRESET_LIBRARY_INVALID");
    if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new MediaKitError(`assemble preset library: preset "${p.id}" has bad fps ${p.fps}`, "PRESET_LIBRARY_INVALID");
    if (p.style !== null && p.style !== undefined && !SHORTS_STYLE_IDS.includes(p.style)) throw new MediaKitError(`assemble preset library: preset "${p.id}" has unknown style ${JSON.stringify(p.style)}`, "PRESET_LIBRARY_INVALID");
    byId[p.id] = { id: p.id, name: p.name ?? p.id, description: p.description ?? "", width, height, fps, style: p.style ?? null };
  }
  const ids = Object.keys(byId).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...ASSEMBLE_PRESET_IDS].sort())) {
    throw new MediaKitError(`assemble preset library ids (${ids.join(", ")}) do not match ASSEMBLE_PRESET_IDS (${ASSEMBLE_PRESET_IDS.join(", ")}); update both together`, "PRESET_LIBRARY_INVALID");
  }
  cachedAssemblePresets = byId;
  return byId;
}

export async function resolveAssemblePreset(preset) {
  if (preset === null || preset === undefined) return null;
  if (typeof preset !== "string" || !preset.trim()) {
    throw new MediaKitError(`assemble preset must be one of ${ASSEMBLE_PRESET_IDS.join(", ")}, got: ${JSON.stringify(preset)}`, "INVALID_ARG");
  }
  const presets = await getAssemblePresets();
  const found = presets[preset];
  if (!found) {
    throw new MediaKitError(`assemble preset must be one of ${ASSEMBLE_PRESET_IDS.join(", ")}, got: ${preset}`, "INVALID_ARG");
  }
  return found;
}

// Scene templates: reusable built-in canvas_scene shots for
// assemble — a manifest shot says `"template": "bounce"` + params
// instead of writing a scene file. Same pattern as assemble
// presets: a JSON registry
// (skills/shorts-video/scene-templates.json) + one .cjs module per
// template under src/canvas-scene-lib/templates/. No embedded
// fallback — a missing or corrupt registry fails loudly, because a
// template that silently resolved to different motion would ship
// the wrong shot. Params are declared per template (string /
// number / boolean / color, each with a default); the manifest may
// override any of them, and an unknown param name fails validate.
export const SCENE_TEMPLATE_IDS = ["title-card", "bounce", "slide-in", "rings"];
const SCENE_TEMPLATES_PATH = fileURLToPath(new URL("../skills/shorts-video/scene-templates.json", import.meta.url));
const SCENE_TEMPLATES_DIR = fileURLToPath(new URL("./canvas-scene-lib/templates/", import.meta.url));
let cachedSceneTemplates = null;
const SCENE_TEMPLATE_PARAM_TYPES = ["string", "number", "boolean", "color"];

function normalizeSceneTemplateColor(value, where) {
  if (typeof value !== "string" || !/^#?[0-9a-fA-F]{6}$/.test(value)) {
    throw new MediaKitError(`${where} must be a 6-digit hex color (RRGGBB or #RRGGBB), got: ${JSON.stringify(value)}`, "PRESET_LIBRARY_INVALID");
  }
  return value.startsWith("#") ? value.toUpperCase() : `#${value.toUpperCase()}`;
}

export async function getSceneTemplates() {
  if (cachedSceneTemplates) return cachedSceneTemplates;
  let doc;
  try {
    doc = JSON.parse(await readFile(SCENE_TEMPLATES_PATH, "utf8"));
  } catch {
    throw new MediaKitError("assemble scene template library missing: skills/shorts-video/scene-templates.json not found next to the package", "PRESET_LIBRARY_MISSING");
  }
  if (!doc || !Array.isArray(doc.templates) || doc.templates.length === 0) {
    throw new MediaKitError("assemble scene template library has no templates: skills/shorts-video/scene-templates.json", "PRESET_LIBRARY_INVALID");
  }
  const byId = {};
  for (const t of doc.templates) {
    if (typeof t?.id !== "string" || !t.id) throw new MediaKitError("assemble scene template library: template without an id", "PRESET_LIBRARY_INVALID");
    if (byId[t.id]) throw new MediaKitError(`assemble scene template library: duplicate template id "${t.id}"`, "PRESET_LIBRARY_INVALID");
    if (typeof t.file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.cjs$/.test(t.file)) {
      throw new MediaKitError(`assemble scene template library: template "${t.id}" has a bad file ${JSON.stringify(t.file)} (one .cjs filename, no path)`, "PRESET_LIBRARY_INVALID");
    }
    const fileAbs = path.join(SCENE_TEMPLATES_DIR, t.file);
    try {
      const st = await stat(fileAbs);
      if (!st.isFile()) throw new Error("not a file");
    } catch {
      throw new MediaKitError(`assemble scene template library: template "${t.id}" file ${t.file} is missing under src/canvas-scene-lib/templates/`, "PRESET_LIBRARY_INVALID");
    }
    if (t.params !== undefined && (typeof t.params !== "object" || t.params === null || Array.isArray(t.params))) {
      throw new MediaKitError(`assemble scene template library: template "${t.id}" params must be an object`, "PRESET_LIBRARY_INVALID");
    }
    const params = {};
    for (const [name, spec] of Object.entries(t.params ?? {})) {
      const where = `assemble scene template library: template "${t.id}" param "${name}"`;
      if (!spec || typeof spec !== "object" || !SCENE_TEMPLATE_PARAM_TYPES.includes(spec.type)) {
        throw new MediaKitError(`${where} needs a type (one of ${SCENE_TEMPLATE_PARAM_TYPES.join(", ")})`, "PRESET_LIBRARY_INVALID");
      }
      if (!("default" in spec)) throw new MediaKitError(`${where} needs a default`, "PRESET_LIBRARY_INVALID");
      const param = { type: spec.type, default: spec.default, description: spec.description ?? "" };
      if (spec.type === "string") {
        if (typeof spec.default !== "string") throw new MediaKitError(`${where} default must be a string`, "PRESET_LIBRARY_INVALID");
        if (spec.maxLength !== undefined) {
          if (!Number.isInteger(spec.maxLength) || spec.maxLength < 1) throw new MediaKitError(`${where} maxLength must be a positive integer`, "PRESET_LIBRARY_INVALID");
          if (spec.default.length > spec.maxLength) throw new MediaKitError(`${where} default is longer than maxLength ${spec.maxLength}`, "PRESET_LIBRARY_INVALID");
          param.maxLength = spec.maxLength;
        }
      } else if (spec.type === "boolean") {
        if (typeof spec.default !== "boolean") throw new MediaKitError(`${where} default must be true or false`, "PRESET_LIBRARY_INVALID");
      } else if (spec.type === "color") {
        param.default = normalizeSceneTemplateColor(spec.default, where);
      } else {
        if (typeof spec.default !== "number" || !Number.isFinite(spec.default)) throw new MediaKitError(`${where} default must be a number`, "PRESET_LIBRARY_INVALID");
        if (spec.integer) param.integer = true;
        if (spec.min !== undefined) {
          if (typeof spec.min !== "number" || !Number.isFinite(spec.min)) throw new MediaKitError(`${where} min must be a number`, "PRESET_LIBRARY_INVALID");
          param.min = spec.min;
        }
        if (spec.max !== undefined) {
          if (typeof spec.max !== "number" || !Number.isFinite(spec.max)) throw new MediaKitError(`${where} max must be a number`, "PRESET_LIBRARY_INVALID");
          param.max = spec.max;
        }
        if (param.min !== undefined && param.max !== undefined && param.min > param.max) throw new MediaKitError(`${where} min ${param.min} is above max ${param.max}`, "PRESET_LIBRARY_INVALID");
        if (param.min !== undefined && spec.default < param.min) throw new MediaKitError(`${where} default ${spec.default} is below min ${param.min}`, "PRESET_LIBRARY_INVALID");
        if (param.max !== undefined && spec.default > param.max) throw new MediaKitError(`${where} default ${spec.default} is above max ${param.max}`, "PRESET_LIBRARY_INVALID");
        if (param.integer && !Number.isInteger(spec.default)) throw new MediaKitError(`${where} default must be a whole number`, "PRESET_LIBRARY_INVALID");
      }
      params[name] = param;
    }
    byId[t.id] = { id: t.id, name: t.name ?? t.id, description: t.description ?? "", file: fileAbs, params };
  }
  const ids = Object.keys(byId).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...SCENE_TEMPLATE_IDS].sort())) {
    throw new MediaKitError(`assemble scene template library ids (${ids.join(", ")}) do not match SCENE_TEMPLATE_IDS (${SCENE_TEMPLATE_IDS.join(", ")}); update both together`, "PRESET_LIBRARY_INVALID");
  }
  cachedSceneTemplates = byId;
  return byId;
}

export async function resolveSceneTemplate(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new MediaKitError(`assemble scene template must be one of ${SCENE_TEMPLATE_IDS.join(", ")}, got: ${JSON.stringify(id)}`, "INVALID_ARG");
  }
  const templates = await getSceneTemplates();
  const found = templates[id];
  if (!found) {
    throw new MediaKitError(`assemble scene template must be one of ${SCENE_TEMPLATE_IDS.join(", ")}, got: ${id}`, "INVALID_ARG");
  }
  return found;
}

// Merge a template's defaults with the shot's params: shot values
// win, unknown names fail, every value is type/range-checked, so a
// bad param fails validate instead of drawing garbage mid-render.
export function resolveSceneTemplateParams(template, rawParams, label) {
  const merged = {};
  for (const [name, spec] of Object.entries(template.params)) merged[name] = spec.default;
  if (rawParams === undefined || rawParams === null) return merged;
  if (typeof rawParams !== "object" || Array.isArray(rawParams)) {
    throw new MediaKitError(`${label}: params must be a plain JSON object`, "INVALID_ARG");
  }
  for (const [name, value] of Object.entries(rawParams)) {
    const spec = template.params[name];
    if (!spec) {
      throw new MediaKitError(`${label}: unknown param "${name}" for template "${template.id}" (allowed: ${Object.keys(template.params).join(", ") || "none"})`, "INVALID_ARG");
    }
    const where = `${label}: template "${template.id}" param "${name}"`;
    if (spec.type === "string") {
      if (typeof value !== "string") throw new MediaKitError(`${where} must be a string`, "INVALID_ARG");
      if (spec.maxLength !== undefined && value.length > spec.maxLength) throw new MediaKitError(`${where} is too long (${value.length} > ${spec.maxLength} characters)`, "INVALID_ARG");
      merged[name] = value;
    } else if (spec.type === "boolean") {
      if (typeof value !== "boolean") throw new MediaKitError(`${where} must be true or false`, "INVALID_ARG");
      merged[name] = value;
    } else if (spec.type === "color") {
      if (typeof value !== "string" || !/^#?[0-9a-fA-F]{6}$/.test(value)) {
        throw new MediaKitError(`${where} must be a 6-digit hex color (RRGGBB or #RRGGBB), got: ${JSON.stringify(value)}`, "INVALID_ARG");
      }
      merged[name] = value.startsWith("#") ? value.toUpperCase() : `#${value.toUpperCase()}`;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new MediaKitError(`${where} must be a number`, "INVALID_ARG");
      if (spec.integer && !Number.isInteger(value)) throw new MediaKitError(`${where} must be a whole number`, "INVALID_ARG");
      if (spec.min !== undefined && value < spec.min) throw new MediaKitError(`${where} must be >= ${spec.min}`, "INVALID_ARG");
      if (spec.max !== undefined && value > spec.max) throw new MediaKitError(`${where} must be <= ${spec.max}`, "INVALID_ARG");
      merged[name] = value;
    }
  }
  return merged;
}

function assembleEvenDown(n) { return n % 2 ? n - 1 : n; }

// Brand profiles: one named id paints the whole film in a
// channel's look — palette + text size + caption style — instead
// of retyping colors on every shot. Same pattern as assemble
// presets and scene templates: a JSON registry
// (skills/shorts-video/brands.json), ids locked in code, no
// embedded fallback — a missing or corrupt registry fails loudly,
// because a brand that silently resolved to different colors
// would ship the wrong look. A brand only fills what the
// manifest leaves out: an explicit value always wins and is
// reported in brand_overrides; brand-filled fields are listed in
// brand_applied. Resolution order for the caption style is
// explicit > preset > brand. Palette keys: background (shot
// backgrounds), primary (the brand's main color), accent (the
// second color), text (default text-layer color), on_primary
// (text meant to sit ON the primary color — picked per brand so
// a light card never gets light text).
export const ASSEMBLE_BRAND_IDS = ["amber-teal", "warm-story", "minimal-line"];
const ASSEMBLE_BRANDS_PATH = fileURLToPath(new URL("../skills/shorts-video/brands.json", import.meta.url));
const ASSEMBLE_BRAND_PALETTE_KEYS = ["background", "primary", "accent", "text", "on_primary"];
// Extra brands from a file of your own: set MEDIAKIT_BRANDS to the
// path of a JSON file shaped like skills/shorts-video/brands.json
// ({"brands": [...]}). Its ids ADD to the three built-ins —
// redefining a built-in id is refused, so a channel's locked look
// can never be shadowed by a stray file. A custom brand is
// validated exactly like a built-in (5 hex palette keys, text_size
// 8-400, style must be a known style id). The cache key includes
// the file's content hash, so editing the file takes effect on the
// next call — and the assemble fingerprint already carries the
// resolved palette, so a palette edit re-approves the film.
const BRANDS_FILE_ENV = "MEDIAKIT_BRANDS";
let cachedAssembleBrands = null; // { key, brands }
function parseBrandDoc(doc, label, forbiddenIds = []) {
  if (!doc || !Array.isArray(doc.brands) || doc.brands.length === 0) {
    throw new MediaKitError(`${label} has no brands`, "PRESET_LIBRARY_INVALID");
  }
  const byId = {};
  for (const b of doc.brands) {
    if (typeof b?.id !== "string" || !b.id) throw new MediaKitError(`${label}: brand without an id`, "PRESET_LIBRARY_INVALID");
    if (byId[b.id]) throw new MediaKitError(`${label}: duplicate brand id "${b.id}"`, "PRESET_LIBRARY_INVALID");
    if (forbiddenIds.includes(b.id)) {
      throw new MediaKitError(`${label}: brand "${b.id}" redefines a built-in brand id — built-in ids (${ASSEMBLE_BRAND_IDS.join(", ")}) are locked; pick a new id for your brand`, "PRESET_LIBRARY_INVALID");
    }
    if (!b.palette || typeof b.palette !== "object" || Array.isArray(b.palette)) {
      throw new MediaKitError(`${label}: brand "${b.id}" needs a palette object`, "PRESET_LIBRARY_INVALID");
    }
    for (const key of ASSEMBLE_BRAND_PALETTE_KEYS) {
      const v = b.palette[key];
      if (typeof v !== "string" || !/^[0-9a-fA-F]{6}$/.test(v)) {
        throw new MediaKitError(`${label}: brand "${b.id}" palette.${key} must be a 6-digit hex color, got: ${JSON.stringify(v)}`, "PRESET_LIBRARY_INVALID");
      }
    }
    const textSize = Number(b.text_size);
    if (!Number.isInteger(textSize) || textSize < 8 || textSize > 400) {
      throw new MediaKitError(`${label}: brand "${b.id}" has bad text_size ${b.text_size}`, "PRESET_LIBRARY_INVALID");
    }
    if (b.style !== null && b.style !== undefined && !SHORTS_STYLE_IDS.includes(b.style)) {
      throw new MediaKitError(`${label}: brand "${b.id}" has unknown style ${JSON.stringify(b.style)}`, "PRESET_LIBRARY_INVALID");
    }
    byId[b.id] = {
      id: b.id, name: b.name ?? b.id, description: b.description ?? "",
      palette: Object.fromEntries(ASSEMBLE_BRAND_PALETTE_KEYS.map((k) => [k, b.palette[k].toUpperCase()])),
      text_size: textSize, style: b.style ?? null,
    };
  }
  return byId;
}
export async function getAssembleBrands() {
  const customPath = process.env[BRANDS_FILE_ENV]?.trim() || null;
  let customContent = null;
  if (customPath) {
    try {
      customContent = await readFile(path.resolve(customPath), "utf8");
    } catch {
      throw new MediaKitError(`MEDIAKIT_BRANDS file not found: ${customPath}`, "PRESET_LIBRARY_MISSING");
    }
  }
  const key = customPath ? `${customPath}\0${createHash("sha256").update(customContent).digest("hex")}` : "";
  if (cachedAssembleBrands && cachedAssembleBrands.key === key) return cachedAssembleBrands.brands;
  let doc;
  try {
    doc = JSON.parse(await readFile(ASSEMBLE_BRANDS_PATH, "utf8"));
  } catch {
    throw new MediaKitError("assemble brand library missing: skills/shorts-video/brands.json not found next to the package", "PRESET_LIBRARY_MISSING");
  }
  const byId = parseBrandDoc(doc, "assemble brand library");
  const ids = Object.keys(byId).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...ASSEMBLE_BRAND_IDS].sort())) {
    throw new MediaKitError(`assemble brand library ids (${ids.join(", ")}) do not match ASSEMBLE_BRAND_IDS (${ASSEMBLE_BRAND_IDS.join(", ")}); update both together`, "PRESET_LIBRARY_INVALID");
  }
  if (customPath) {
    let customDoc;
    try {
      customDoc = JSON.parse(customContent);
    } catch {
      throw new MediaKitError(`MEDIAKIT_BRANDS file is not valid JSON: ${customPath}`, "PRESET_LIBRARY_INVALID");
    }
    Object.assign(byId, parseBrandDoc(customDoc, `MEDIAKIT_BRANDS file ${customPath}`, ASSEMBLE_BRAND_IDS));
  }
  cachedAssembleBrands = { key, brands: byId };
  return byId;
}

// Shared brand registry (skills/shorts-video/brands.json, plus any
// extra brands from the MEDIAKIT_BRANDS file): one id paints a whole
// film in assemble, and the same id paints the titlecard/intro of
// that film so the opening card matches the film. `label` names the
// caller in the error so a bad --brand on titlecard does not blame
// assemble. Built-in ids are locked in code (ASSEMBLE_BRAND_IDS)
// and the JSON must match them, so a brand can never silently
// resolve to different colours; custom ids are listed after the
// built-ins in the error.
export async function resolveAssembleBrand(brand, label = "assemble brand") {
  if (brand === null || brand === undefined) return null;
  if (typeof brand !== "string" || !brand.trim()) {
    throw new MediaKitError(`${label} must be one of ${ASSEMBLE_BRAND_IDS.join(", ")}, got: ${JSON.stringify(brand)}`, "INVALID_ARG");
  }
  const brands = await getAssembleBrands();
  const found = brands[brand];
  if (!found) {
    const customIds = Object.keys(brands).filter((id) => !ASSEMBLE_BRAND_IDS.includes(id)).sort();
    throw new MediaKitError(`${label} must be one of ${[...ASSEMBLE_BRAND_IDS, ...customIds].join(", ")}, got: ${brand}`, "INVALID_ARG");
  }
  return found;
}

// Which template color param a brand palette key fills, per
// template. Only color params are mapped — numbers and strings
// stay the template's own defaults, and a shot's explicit param
// always wins. bg2 of title-card is deliberately unmapped: the
// gradient's second stop keeps the template default so the card
// keeps its depth instead of going flat.
const BRAND_TEMPLATE_COLOR_MAP = {
  "title-card": { bg1: "background", accent: "primary", fg: "text" },
  bounce: { bg: "background", color: "primary" },
  "slide-in": { bg: "background", card: "primary", fg: "on_primary" },
  rings: { bg: "background", color: "accent" },
};

// Transition handles, in frames. A transition of F frames is
// centered on its cut: floor(F/2) frames come from the previous
// shot's tail (its outgoing handle, shown after the cut) and the
// rest from the next shot's head (its incoming handle, shown
// before the cut). Each shot segment is built longer by its
// handles, so the xfade chain consumes exactly the handles and
// the joined video keeps the nominal frame count. A 0.5s
// transition at 30fps is 15 frames: 8 before the cut, 7 after.
function deriveAssembleHandles(shots, fps) {
  const out = shots.map((s) => ({ ...s, handleInFrames: 0, handleOutFrames: 0 }));
  for (let i = 1; i < out.length; i++) {
    const t = out[i].transition;
    if (!t) continue;
    const hBefore = Math.floor(t.frames / 2);
    const hAfter = t.frames - hBefore;
    out[i - 1].handleOutFrames = hBefore;
    out[i].handleInFrames = hAfter;
  }
  for (const s of out) {
    s.buildFrames = s.frames + s.handleInFrames + s.handleOutFrames;
    s.buildSeconds = s.buildFrames / fps;
    if (s.kind === "video") s.buildStart = s.start - s.handleInFrames / fps;
  }
  return out;
}

// The xfade joins for a shot list: one per transition, with the
// offset (in frames and seconds) where the blend starts in the
// joined timeline. The offset is frame-aligned by construction:
// cutFrames - hAfter is an integer number of frames.
function deriveAssembleJoins(shots, fps) {
  const joins = [];
  let cutFrames = 0;
  for (let i = 0; i < shots.length - 1; i++) {
    cutFrames += shots[i].frames;
    const next = shots[i + 1];
    if (!next.transition) continue;
    const t = next.transition;
    const hAfter = t.frames - Math.floor(t.frames / 2);
    joins.push({
      index: i + 1,
      type: t.type,
      durationSeconds: t.frames / fps,
      frames: t.frames,
      offsetFrames: cutFrames - hAfter,
      offsetSeconds: (cutFrames - hAfter) / fps,
    });
  }
  return joins;
}

// Full video plan for a shot list: built segments (with handles)
// plus the xfade joins. Pure — used for the full render and for
// previews (whose shot list is clipped first).
function planAssembleVideo(shots, fps) {
  const built = deriveAssembleHandles(shots, fps);
  return { shots: built, joins: deriveAssembleJoins(built, fps) };
}

// Per-shot text layers (the director's lower-thirds / titles).
// shot.text is one layer object or an array of up to 4:
//   {text, position?, size?, color?, box?, start?, end?}
// position is top (default — clear of the burned captions, which
// sit ~500px from the bottom), center or bottom; size defaults to
// min(width,height)/12; color is 6-digit hex, default white; box
// draws the black@0.6 box behind the text (default on); start/end
// are seconds inside the NOMINAL shot (default the whole shot).
// Long lines are wrapped to fit the frame — drawtext never wraps
// on its own. Text goes through a textfile like titlecard (no
// inline-text escaping traps, newlines and Vietnamese diacritics
// pass through). Caveat, from ffmpeg-skill 1.17: drawtext shapes
// Latin/Vietnamese correctly but not complex scripts (Indic, Thai)
// — those need libass, which assemble does not use for layers.
const ASSEMBLE_TEXT_POSITIONS = ["top", "center", "bottom"];
const ASSEMBLE_MAX_TEXT_LAYERS = 4;
function parseAssembleTextLayers(raw, label, id, duration, width, height, brandDefaults = null) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > ASSEMBLE_MAX_TEXT_LAYERS) {
    throw new MediaKitError(`${label} (${id}): at most ${ASSEMBLE_MAX_TEXT_LAYERS} text layers, got ${list.length}`, "INVALID_ARG");
  }
  const defaultSize = brandDefaults?.size ?? Math.round(Math.min(width, height) / 12);
  const defaultColor = brandDefaults?.color ?? "FFFFFF";
  return list.map((entry, j) => {
    const llabel = `${label} (${id}) text[${j}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MediaKitError(`${llabel} must be an object {text, position?, size?, color?, box?, start?, end?}`, "INVALID_ARG");
    }
    if (typeof entry.text !== "string" || !entry.text.trim()) {
      throw new MediaKitError(`${llabel} needs non-empty text`, "INVALID_ARG");
    }
    const text = entry.text.trim();
    if (text.length > 200) {
      throw new MediaKitError(`${llabel} text is ${text.length} characters (max 200)`, "INVALID_ARG");
    }
    const position = entry.position ?? "top";
    if (!ASSEMBLE_TEXT_POSITIONS.includes(position)) {
      throw new MediaKitError(`${llabel} position must be top, center or bottom, got: ${position}`, "INVALID_ARG");
    }
    const size = entry.size === undefined || entry.size === null
      ? defaultSize
      : num(entry.size, `${llabel} size`, { min: 8, max: 400, integer: true });
    const color = entry.color === undefined || entry.color === null
      ? defaultColor
      : String(entry.color).trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(color)) {
      throw new MediaKitError(`${llabel} color must be a 6-digit hex like FFFFFF, got: ${entry.color}`, "INVALID_ARG");
    }
    const box = entry.box ?? true;
    if (typeof box !== "boolean") {
      throw new MediaKitError(`${llabel} box must be true or false`, "INVALID_ARG");
    }
    const start = entry.start === undefined || entry.start === null
      ? 0 : num(entry.start, `${llabel} start`, { min: 0 });
    const end = entry.end === undefined || entry.end === null
      ? duration : num(entry.end, `${llabel} end`, { min: 0 });
    if (!(start < end)) {
      throw new MediaKitError(`${llabel} start ${start}s must be before end ${end}s`, "INVALID_ARG");
    }
    if (end > duration + 1e-9) {
      throw new MediaKitError(`${llabel} end ${end}s is past the shot duration ${duration}s`, "INVALID_ARG");
    }
    const maxChars = Math.max(8, Math.floor(width / (size * ASSEMBLE_TEXT_EM_PER_CHAR)));
    const lines = wrapTitleLines(text, maxChars);
    return { text, lines, position, size, color: color.toUpperCase(), box, start_seconds: +start.toFixed(3), end_seconds: +end.toFixed(3) };
  });
}

// Validate a parsed film manifest against the files on disk and
// return the build plan (frame-exact). Probes the voice and every
// asset; nothing is written. Throws MediaKitError on the first
// problem, naming the shot/field.
async function validateAssembleManifest(doc, manifestAbs) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new MediaKitError("assemble manifest must be a JSON object", "INVALID_ARG");
  }
  if (doc.version !== 1) {
    throw new MediaKitError(`assemble manifest version must be 1, got: ${doc.version}`, "INVALID_ARG");
  }
  const manifestDir = path.dirname(manifestAbs);
  const resolveRel = (p) => (path.isAbsolute(p) ? p : path.join(manifestDir, p));
  const title = doc.title === undefined || doc.title === null ? path.basename(manifestAbs, path.extname(manifestAbs)) : String(doc.title);
  // Named preset (optional): one id picks width/height/fps/style
  // for the whole film. An explicit field in the manifest always
  // wins over the preset; without a preset, width/height stay
  // required (num() throws on undefined) — the aspect ratio is
  // never silently defaulted.
  const preset = await resolveAssemblePreset(doc.preset ?? null);
  const presetApplied = [];
  const presetOverrides = [];
  const pickPresetField = (field, raw, fallback) => {
    if (raw !== undefined && raw !== null) {
      if (preset && preset[field] !== null && preset[field] !== undefined && raw !== preset[field]) presetOverrides.push(field);
      return raw;
    }
    if (preset && preset[field] !== null && preset[field] !== undefined) {
      presetApplied.push(field);
      return preset[field];
    }
    return fallback;
  };
  const width = num(pickPresetField("width", doc.width, undefined), "width", { min: 2, max: 7680, integer: true });
  const height = num(pickPresetField("height", doc.height, undefined), "height", { min: 2, max: 4320, integer: true });
  if (width % 2 || height % 2) {
    throw new MediaKitError(`assemble width/height must be even (got ${width}x${height})`, "INVALID_ARG");
  }
  const fps = assembleOptNum(pickPresetField("fps", doc.fps, 30), 30, "fps", { min: 1, max: 120, integer: true });
  let style = pickPresetField("style", doc.style === undefined || doc.style === null ? null : String(doc.style), null);
  if (style !== null && !SHORTS_STYLE_IDS.includes(style)) {
    throw new MediaKitError(`assemble style must be one of ${SHORTS_STYLE_IDS.join(", ")}, got: ${style}`, "INVALID_ARG");
  }
  // Brand profile (optional): one id paints the whole film —
  // palette + text size + caption style. Resolution order for
  // the style is explicit > preset > brand; the brand only fills
  // what is still empty, and every field it fills or loses to an
  // explicit/preset value is reported below.
  const brand = await resolveAssembleBrand(doc.brand ?? null);
  const brandApplied = [];
  const brandOverrides = [];
  if (brand) {
    if (style === null && brand.style) {
      style = brand.style;
      brandApplied.push("style");
    } else if (style !== null && brand.style && style !== brand.style) {
      brandOverrides.push("style");
    }
  }
  const styleValues = await assembleStyleValues(style);
  if (!doc.voice || typeof doc.voice !== "object" || Array.isArray(doc.voice)) {
    throw new MediaKitError("assemble manifest needs a voice {path, lead?, tail?} — the voice is the master clock", "INVALID_ARG");
  }
  if (typeof doc.voice.path !== "string" || !doc.voice.path.trim()) {
    throw new MediaKitError("assemble voice needs a path", "INVALID_ARG");
  }
  const voicePath = await requireInput(resolveRel(doc.voice.path), "voice file");
  const voiceMeta = await probe(voicePath);
  if (!voiceMeta.audio) throw new MediaKitError(`assemble voice ${doc.voice.path} has no audio stream`, "INVALID_ARG");
  if (!Number.isFinite(voiceMeta.duration_seconds)) throw new MediaKitError("assemble could not measure the voice duration", "PROBE_FAILED");
  const lead = assembleOptNum(doc.voice.lead, 0, "voice.lead", { min: 0, max: 600 });
  const tail = assembleOptNum(doc.voice.tail, 0, "voice.tail", { min: 0, max: 600 });
  const voiceDuration = voiceMeta.duration_seconds;
  const totalSeconds = +(lead + voiceDuration + tail).toFixed(3);
  const totalFrames = Math.round(totalSeconds * fps);
  if (totalFrames < 1) throw new MediaKitError("assemble total duration is too short (lead + voice + tail must cover at least 1 frame)", "INVALID_ARG");

  let music = null;
  if (doc.music !== undefined && doc.music !== null) {
    if (typeof doc.music !== "object" || Array.isArray(doc.music) || typeof doc.music.path !== "string" || !doc.music.path.trim()) {
      throw new MediaKitError("assemble music must be an object {path, volume?, duck_db?}", "INVALID_ARG");
    }
    const musicPath = await requireInput(resolveRel(doc.music.path), "music file");
    const musicMeta = await probe(musicPath);
    if (!musicMeta.audio) throw new MediaKitError(`assemble music ${doc.music.path} has no audio stream`, "INVALID_ARG");
    music = {
      path: musicPath,
      volume: assembleOptNum(doc.music.volume, 0.3, "music.volume", { min: 0, max: 1 }),
      duck_db: assembleOptNum(doc.music.duck_db, 12, "music.duck_db", { min: 0, max: 24 }),
    };
  }
  let sfx = [];
  if (doc.sfx !== undefined && doc.sfx !== null) {
    if (!Array.isArray(doc.sfx) || doc.sfx.length > 16) {
      throw new MediaKitError(`assemble sfx must be an array of at most 16 entries, got: ${Array.isArray(doc.sfx) ? doc.sfx.length : "not an array"}`, "INVALID_ARG");
    }
    for (const [i, entry] of doc.sfx.entries()) {
      if (!entry || typeof entry !== "object" || typeof entry.file !== "string" || !entry.file.trim()) {
        throw new MediaKitError(`sfx[${i}] must be an object {file, at, volume?}`, "INVALID_ARG");
      }
      const sfxPath = await requireInput(resolveRel(entry.file), `sfx[${i}] file`);
      const sfxMeta = await probe(sfxPath);
      if (!sfxMeta.audio) throw new MediaKitError(`sfx[${i}] ${entry.file} has no audio stream`, "INVALID_ARG");
      const at = parseTime(entry.at ?? entry.at_seconds, `sfx[${i}] at`);
      if (!(at >= 0 && at < totalSeconds)) {
        throw new MediaKitError(`sfx[${i}] at ${at}s is outside the film (0..${totalSeconds}s)`, "INVALID_ARG");
      }
      sfx.push({ file: sfxPath, at_seconds: +at.toFixed(3), volume: assembleOptNum(entry.volume, 1, `sfx[${i}] volume`, { min: 0, max: 1 }) });
    }
  }
  let captions = null;
  if (doc.captions !== undefined && doc.captions !== null) {
    if (typeof doc.captions !== "string" || !doc.captions.trim()) {
      throw new MediaKitError("assemble captions must be a file path (.srt/.ass/.vtt)", "INVALID_ARG");
    }
    const capPath = await requireInput(resolveRel(doc.captions), "captions file");
    const capExt = path.extname(capPath).toLowerCase();
    if (![".srt", ".ass", ".vtt"].includes(capExt)) {
      throw new MediaKitError(`assemble captions must be .srt/.ass/.vtt, got ${capExt}`, "INVALID_ARG");
    }
    let cueCount = null;
    if (capExt !== ".ass") {
      const { cues } = parseCaptions(await readFile(capPath, "utf8"), capExt.slice(1));
      cueCount = cues.length;
      for (const c of cues) {
        if (c.endMs / 1000 > totalSeconds + 0.05) {
          throw new MediaKitError(`captions cue "${c.text.split("\n")[0]}" ends at ${(c.endMs / 1000).toFixed(3)}s, past the film end (${totalSeconds}s)`, "INVALID_ARG");
        }
      }
    }
    captions = { path: capPath, cue_count: cueCount };
  }
  if (!Array.isArray(doc.shots) || doc.shots.length < 1 || doc.shots.length > ASSEMBLE_MAX_SHOTS) {
    throw new MediaKitError(`assemble needs 1-${ASSEMBLE_MAX_SHOTS} shots, got: ${Array.isArray(doc.shots) ? doc.shots.length : "not an array"}`, "INVALID_ARG");
  }
  const seenIds = new Set();
  const shots = [];
  let framesSum = 0;
  const warnings = [];
  if (voiceMeta.video) warnings.push("voice file has a video stream — only its audio is used");
  for (const [i, raw] of doc.shots.entries()) {
    const label = `shot ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MediaKitError(`${label} must be an object {id, kind, duration, ...}`, "INVALID_ARG");
    }
    if (typeof raw.id !== "string" || !raw.id.trim() || raw.id.length > 64) {
      throw new MediaKitError(`${label} needs an id (1-64 characters)`, "INVALID_ARG");
    }
    const id = raw.id.trim();
    if (seenIds.has(id)) throw new MediaKitError(`duplicate shot id "${id}"`, "INVALID_ARG");
    seenIds.add(id);
    const kind = raw.kind;
    if (!["image", "video", "color", "canvas_scene"].includes(kind)) {
      throw new MediaKitError(`${label} (${id}): kind must be image, video, color or canvas_scene, got: ${kind}`, "INVALID_ARG");
    }
    const duration = num(raw.duration, `${label} (${id}) duration`, { min: 0.5, max: 600 });
    const frames = Math.round(duration * fps);
    if (Math.abs(frames / fps - duration) > 0.005) {
      warnings.push(`${label} (${id}): duration ${duration}s does not land on a frame boundary at ${fps}fps — built as ${frames} frames (${(frames / fps).toFixed(3)}s)`);
    }
    framesSum += frames;
    const shot = { id, kind, duration, frames };
    if (kind === "image") {
      if (typeof raw.source !== "string" || !raw.source.trim()) throw new MediaKitError(`${label} (${id}): image shot needs a source`, "INVALID_ARG");
      const srcPath = await requireInput(resolveRel(raw.source), `${label} (${id}) source`);
      const meta = await probe(srcPath);
      if (!meta.video) throw new MediaKitError(`${label} (${id}): image source ${raw.source} has no video stream`, "INVALID_ARG");
      if (meta.audio || meta.duration_seconds !== null) {
        throw new MediaKitError(`${label} (${id}): image source must be a still image, not a video (extract a frame first)`, "INVALID_ARG");
      }
      shot.source = srcPath;
      shot.assetHash = await hashFile(srcPath);
      if (raw.zoom !== undefined && raw.zoom !== null) {
        if (typeof raw.zoom !== "object" || Array.isArray(raw.zoom)) {
          throw new MediaKitError(`${label} (${id}): zoom must be an object {from, to, focus?, focus_end?}`, "INVALID_ARG");
        }
        const focus = raw.zoom.focus ?? [0.5, 0.5];
        const focusEnd = raw.zoom.focus_end ?? focus;
        for (const [name, v] of [["focus", focus], ["focus_end", focusEnd]]) {
          if (!Array.isArray(v) || v.length !== 2 || v.some((x) => typeof x !== "number" || x < 0 || x > 1)) {
            throw new MediaKitError(`${label} (${id}): zoom.${name} must be [x, y] with each 0-1`, "INVALID_ARG");
          }
        }
        shot.zoom = {
          from: assembleOptNum(raw.zoom.from, 1, `${label} (${id}) zoom.from`, { min: 1, max: 10 }),
          to: assembleOptNum(raw.zoom.to, 1.15, `${label} (${id}) zoom.to`, { min: 1, max: 10 }),
          focus, focus_end: focusEnd,
        };
      } else if (duration > ASSEMBLE_MOTION_GATE_SECONDS) {
        throw new MediaKitError(
          `${label} (${id}): motion-gate — a still image without zoom may last at most ${ASSEMBLE_MOTION_GATE_SECONDS}s, got ${duration}s (add a zoom, or split the shot)`,
          "INVALID_ARG",
        );
      }
    } else if (kind === "video") {
      if (typeof raw.source !== "string" || !raw.source.trim()) throw new MediaKitError(`${label} (${id}): video shot needs a source`, "INVALID_ARG");
      const srcPath = await requireInput(resolveRel(raw.source), `${label} (${id}) source`);
      const meta = await probe(srcPath);
      if (!meta.video) throw new MediaKitError(`${label} (${id}): video source ${raw.source} has no video stream`, "INVALID_ARG");
      if (!Number.isFinite(meta.duration_seconds)) throw new MediaKitError(`${label} (${id}): could not measure the video source duration`, "PROBE_FAILED");
      const start = assembleOptNum(raw.start, 0, `${label} (${id}) start`, { min: 0 });
      shot.source = srcPath;
      shot.start = start;
      shot.sourceDuration = meta.duration_seconds;
      shot.assetHash = await hashFile(srcPath);
    } else if (kind === "canvas_scene") {
      const hasScene = typeof raw.scene === "string" && raw.scene.trim();
      const hasTemplate = typeof raw.template === "string" && raw.template.trim();
      if (hasScene && hasTemplate) {
        throw new MediaKitError(`${label} (${id}): canvas_scene shot takes either scene or template, not both`, "INVALID_ARG");
      }
      let scenePath;
      if (hasTemplate) {
        const tpl = await resolveSceneTemplate(raw.template.trim());
        shot.template = tpl.id;
        scenePath = tpl.file;
        // A template shot is self-contained: it draws everything in
        // code, so no external assets are accepted.
        if (raw.assets !== undefined && raw.assets !== null) {
          throw new MediaKitError(`${label} (${id}): template "${tpl.id}" takes no assets (it draws everything in code)`, "INVALID_ARG");
        }
        shot.params = resolveSceneTemplateParams(tpl, raw.params, `${label} (${id})`);
        // Brand palette fills the template's color params the shot
        // did not pass explicitly (explicit params win, like the
        // preset rule) — recorded in brand_applied/overrides.
        if (brand) {
          const colorMap = BRAND_TEMPLATE_COLOR_MAP[tpl.id] ?? {};
          const passed = raw.params ?? {};
          for (const [param, key] of Object.entries(colorMap)) {
            const brandValue = `#${brand.palette[key]}`;
            if (passed[param] === undefined || passed[param] === null) {
              shot.params[param] = brandValue;
              brandApplied.push(`${label} (${id}) template.${tpl.id}.${param}`);
            } else if (String(passed[param]).replace(/^#/, "").toUpperCase() !== brand.palette[key]) {
              brandOverrides.push(`${label} (${id}) template.${tpl.id}.${param}`);
            }
          }
        }
      } else {
        if (!hasScene) throw new MediaKitError(`${label} (${id}): canvas_scene shot needs a scene (JS module path) or a template (one of ${SCENE_TEMPLATE_IDS.join(", ")})`, "INVALID_ARG");
        scenePath = await requireInput(resolveRel(raw.scene), `${label} (${id}) scene`);
        if (!/\.(cjs|js|mjs)$/i.test(path.extname(scenePath))) {
          throw new MediaKitError(`${label} (${id}): scene must be a .js/.cjs/.mjs module, got ${path.extname(scenePath) || "(no extension)"}`, "INVALID_ARG");
        }
        if (raw.params !== undefined && raw.params !== null) {
          if (typeof raw.params !== "object" || Array.isArray(raw.params)) {
            throw new MediaKitError(`${label} (${id}): params must be a plain JSON object`, "INVALID_ARG");
          }
          shot.params = raw.params;
        }
      }
      // Loading the module runs its top-level code — same trust as
      // rendering it. Validate fails here, not mid-render, if the
      // module cannot load or has no draw export.
      await loadCanvasSceneModule(scenePath, `${label} (${id})`);
      shot.scene = scenePath;
      shot.sceneHash = await hashFile(scenePath);
      const assetHashes = {};
      shot.assets = {};
      if (raw.assets !== undefined && raw.assets !== null) {
        if (typeof raw.assets !== "object" || Array.isArray(raw.assets)) {
          throw new MediaKitError(`${label} (${id}): assets must be an object {name: path}`, "INVALID_ARG");
        }
        for (const [name, assetRaw] of Object.entries(raw.assets)) {
          if (typeof assetRaw !== "string" || !assetRaw.trim()) throw new MediaKitError(`${label} (${id}): assets.${name} needs a path`, "INVALID_ARG");
          const assetPath = await requireInput(resolveRel(assetRaw), `${label} (${id}) assets.${name}`);
          const meta = await probe(assetPath);
          if (!meta.video) throw new MediaKitError(`${label} (${id}): assets.${name} ${assetRaw} has no video stream`, "INVALID_ARG");
          if (meta.audio || meta.duration_seconds !== null) {
            throw new MediaKitError(`${label} (${id}): assets.${name} must be a still image, not a video (extract a frame first)`, "INVALID_ARG");
          }
          shot.assets[name] = assetPath;
          assetHashes[name] = await hashFile(assetPath);
        }
      }
      if (duration > ASSEMBLE_CANVAS_MAX_SECONDS) {
        throw new MediaKitError(`${label} (${id}): canvas_scene duration ${duration}s exceeds the ${ASSEMBLE_CANVAS_MAX_SECONDS}s cap (render cost is one PNG per frame — split the shot)`, "INVALID_ARG");
      }
      // One hash covers the scene code + its assets + its params, so
      // the segment cache and the fingerprint both see any of them change.
      shot.assetHash = createHash("sha256").update(stableStringify({ scene: shot.sceneHash, assets: assetHashes, params: shot.params ?? null })).digest("hex");
    } else {
      if (typeof raw.color !== "string" || !/^[0-9a-fA-F]{6}$/.test(raw.color.trim())) {
        throw new MediaKitError(`${label} (${id}): color shot needs a 6-digit hex color (RRGGBB), got: ${raw.color}`, "INVALID_ARG");
      }
      shot.color = raw.color.trim().toUpperCase();
      if (duration > ASSEMBLE_MOTION_GATE_SECONDS) {
        throw new MediaKitError(
          `${label} (${id}): motion-gate — a solid color card may last at most ${ASSEMBLE_MOTION_GATE_SECONDS}s, got ${duration}s (split the shot)`,
          "INVALID_ARG",
        );
      }
    }
    // Per-shot text layers (any kind): parsed + validated here so
    // a bad layer fails validate, not mid-render. The brand fills
    // a layer's missing color/size with its palette text / text
    // size; an explicit value that differs is a brand override.
    shot.textLayers = parseAssembleTextLayers(raw.text, label, id, duration, width, height, brand ? { color: brand.palette.text, size: brand.text_size } : null);
    if (brand && raw.text !== undefined && raw.text !== null) {
      const rawLayers = Array.isArray(raw.text) ? raw.text : [raw.text];
      rawLayers.forEach((entry, j) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        if (entry.color === undefined || entry.color === null) brandApplied.push(`${label} (${id}) text[${j}].color`);
        else if (String(entry.color).replace(/^#/, "").toUpperCase() !== brand.palette.text) brandOverrides.push(`${label} (${id}) text[${j}].color`);
        if (entry.size === undefined || entry.size === null) brandApplied.push(`${label} (${id}) text[${j}].size`);
        else if (entry.size !== brand.text_size) brandOverrides.push(`${label} (${id}) text[${j}].size`);
      });
    }
    // Transition into this shot (the join from the previous shot).
    // Parsed here, cross-shot rules checked after the loop, when
    // both neighbors exist.
    if (raw.transition !== undefined && raw.transition !== null) {
      if (i === 0) {
        throw new MediaKitError(`shot 1 (${id}): the first shot cannot have a transition (there is no cut before it)`, "INVALID_ARG");
      }
      if (typeof raw.transition !== "object" || Array.isArray(raw.transition)) {
        throw new MediaKitError(`${label} (${id}): transition must be an object {type, duration}`, "INVALID_ARG");
      }
      const type = raw.transition.type;
      if (!XFADE_TRANSITIONS.includes(type)) {
        throw new MediaKitError(`${label} (${id}): unknown transition "${type}" (supported: ${XFADE_TRANSITIONS.join(", ")})`, "INVALID_ARG");
      }
      const tDur = num(raw.transition.duration, `${label} (${id}) transition.duration`, { min: 0.1, max: 10 });
      const tFrames = Math.round(tDur * fps);
      if (tFrames < 2) {
        throw new MediaKitError(`${label} (${id}): transition duration ${tDur}s is less than 2 frames at ${fps}fps`, "INVALID_ARG");
      }
      shot.transition = { type, duration_seconds: tFrames / fps, frames: tFrames, requested_seconds: tDur };
    }
    shots.push(shot);
  }
  // Cross-shot transition rules: length against both neighbors,
  // and the handle footage a video shot needs in its source.
  const builtShots = deriveAssembleHandles(shots, fps);
  for (let i = 1; i < builtShots.length; i++) {
    const s = builtShots[i];
    const t = s.transition;
    if (!t) continue;
    const prev = builtShots[i - 1];
    if (t.frames > Math.min(prev.frames, s.frames)) {
      throw new MediaKitError(
        `shot ${i + 1} (${s.id}): transition ${t.frames} frames (${t.duration_seconds}s) is longer than the shorter adjacent shot (${Math.min(prev.frames, s.frames)} frames) — shorten the transition or lengthen the shots`,
        "INVALID_ARG",
      );
    }
  }
  for (const [i, s] of builtShots.entries()) {
    if (s.kind === "image" && s.buildSeconds > 600) {
      throw new MediaKitError(`shot ${i + 1} (${s.id}): built segment ${s.buildSeconds.toFixed(1)}s exceeds the 600s image-shot limit (shorten the shot or its transitions)`, "INVALID_ARG");
    }
    if (s.kind === "video") {
      if (s.buildStart < -1e-9) {
        throw new MediaKitError(
          `shot ${i + 1} (${s.id}): the incoming ${s.transition?.type ?? ""} transition needs ${(s.handleInFrames / fps).toFixed(3)}s of handle before the shot start (${s.start}s) — raise start or shorten the transition`,
          "INVALID_ARG",
        );
      }
      if (s.buildStart + s.buildSeconds > s.sourceDuration + 0.05) {
        throw new MediaKitError(
          `shot ${i + 1} (${s.id}): start ${s.start}s + duration ${s.duration}s${s.handleOutFrames ? ` + ${(s.handleOutFrames / fps).toFixed(3)}s outgoing handle` : ""} passes the source end (${s.sourceDuration}s)`,
          "INVALID_ARG",
        );
      }
    }
  }
  if (framesSum !== totalFrames) {
    const diffFrames = framesSum - totalFrames;
    const diffSeconds = diffFrames / fps;
    throw new MediaKitError(
      `assemble shots cover ${framesSum} frames (${(framesSum / fps).toFixed(3)}s) but the voice timeline is ${totalFrames} frames (${totalSeconds}s) — ${diffFrames > 0 ? "over by" : "short by"} ${Math.abs(diffFrames)} frames (${Math.abs(diffSeconds).toFixed(3)}s). Shots must fit the voice exactly: adjust shot durations (lead ${lead}s + voice ${voiceDuration}s + tail ${tail}s).`,
      "INVALID_ARG",
    );
  }
  // Chapters (optional): named markers on the film timeline —
  // written as real MP4 chapters into final.mp4 on render (not
  // preview: the preview is a clipped window, so chapter times
  // would not line up). Validated here so a bad chapter fails
  // validate, not mid-render. The fingerprint already covers them
  // through the manifest hash.
  let chapters = [];
  if (doc.chapters !== undefined && doc.chapters !== null) {
    if (!Array.isArray(doc.chapters) || doc.chapters.length < 1 || doc.chapters.length > 32) {
      throw new MediaKitError(`assemble chapters must be an array of 1-32 entries, got: ${Array.isArray(doc.chapters) ? doc.chapters.length : "not an array"}`, "INVALID_ARG");
    }
    let prevAt = -1;
    for (const [i, entry] of doc.chapters.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new MediaKitError(`chapters[${i}] must be an object {title, at}`, "INVALID_ARG");
      }
      if (typeof entry.title !== "string" || !entry.title.trim() || entry.title.trim().length > 128) {
        throw new MediaKitError(`chapters[${i}] needs a title (1-128 characters)`, "INVALID_ARG");
      }
      const at = parseTime(entry.at ?? entry.at_seconds, `chapters[${i}] at`);
      if (!(at >= 0 && at < totalSeconds)) {
        throw new MediaKitError(`chapters[${i}] "${entry.title.trim()}" at ${at}s is outside the film (0..${totalSeconds}s)`, "INVALID_ARG");
      }
      if (at <= prevAt) {
        throw new MediaKitError(`chapters[${i}] at ${at}s must come after the previous chapter (${prevAt}s) — chapters must be strictly increasing`, "INVALID_ARG");
      }
      prevAt = at;
      chapters.push({ title: entry.title.trim(), at_seconds: +at.toFixed(3) });
    }
  }
  const manifestHash = await hashFile(manifestAbs);
  const voiceHash = await hashFile(voicePath);
  const musicHash = music ? await hashFile(music.path) : null;
  const sfxHashes = [];
  for (const s of sfx) sfxHashes.push(await hashFile(s.file));
  const captionsHash = captions ? await hashFile(captions.path) : null;
  const assetHashes = {};
  for (const s of shots) if (s.assetHash) assetHashes[s.id] = s.assetHash;
  // The resolved brand (not just its id) goes into the
  // fingerprint: editing brands.json re-approves the film, the
  // same way editing a scene file does.
  const brandResolved = brand ? { id: brand.id, palette: brand.palette, text_size: brand.text_size, style: brand.style } : null;
  const fingerprint = createHash("sha256").update(stableStringify({
    renderer: ASSEMBLE_VERSION,
    manifest: manifestHash,
    voice: voiceHash,
    music: musicHash,
    sfx: sfxHashes,
    captions: captionsHash,
    assets: assetHashes,
    style: styleValues ? stableStringify(styleValues.burn_captions) : null,
    width, height, fps,
    preset: preset ? preset.id : null,
    brand: brandResolved,
  })).digest("hex");
  return {
    manifest: manifestAbs, manifestDir, title, width, height, fps, style, styleValues,
    preset: preset ? preset.id : null, preset_applied: presetApplied, preset_overrides: presetOverrides,
    brand: brand ? brand.id : null, brand_applied: brandApplied, brand_overrides: brandOverrides,
    voice: { path: voicePath, lead, tail, duration_seconds: voiceDuration },
    total_seconds: totalSeconds, total_frames: totalFrames,
    music, sfx, captions, shots, chapters, warnings, fingerprint,
    fingerprint_parts: { manifest: manifestHash, voice: voiceHash, music: musicHash, sfx: sfxHashes, captions: captionsHash, assets: assetHashes, brand: brandResolved ? stableStringify(brandResolved) : null },
  };
}

// ---------------------------------------------------------------- canvas_scene
// A canvas_scene shot is a JS module that draws every frame in code
// (Canvas 2D, node-canvas). Same contract as the local-video-pipeline
// skill: module.exports.draw = async (ctx, t, W, H, assets, M) => {}.
// Frame N is a pure function of t = N/fps — deterministic, no clock,
// no network. The scene runs as local code with the user's
// privileges; only render manifests you trust. The module is loaded
// through createRequire (scenes are CommonJS, like the pipeline
// skill's scene.js) and the top-level module is cache-busted on
// every load, so editing the scene file takes effect without
// restarting the server. M.lib is vendored from the pipeline skill
// (src/canvas-scene-lib/): camera + fx, pure functions, no deps.
const canvasRequire = createRequire(import.meta.url);

async function loadCanvasSceneModule(scenePath, label) {
  try {
    delete canvasRequire.cache[canvasRequire.resolve(scenePath)];
  } catch { /* first load: nothing cached */ }
  let mod;
  try {
    mod = canvasRequire(scenePath);
  } catch (e) {
    // A .js scene under a "type": "module" package is treated as ESM,
    // so module.exports is not defined there. .cjs always works.
    const hint = /ES module scope|Cannot use import statement/.test(e.message)
      ? " (rename the scene to .cjs — the nearest package.json sets \"type\": \"module\")"
      : "";
    throw new MediaKitError(`${label}: cannot load scene module ${scenePath}: ${e.message}${hint}`, "INVALID_ARG");
  }
  const draw = mod?.draw ?? mod?.default?.draw ?? (typeof mod?.default === "function" ? mod.default : null);
  if (typeof draw !== "function") {
    throw new MediaKitError(`${label}: scene module must export draw(ctx, t, W, H, assets, M) (module.exports.draw)`, "INVALID_ARG");
  }
  return draw;
}

function canvasSceneLib() {
  const libDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "canvas-scene-lib");
  return {
    camera: canvasRequire(path.join(libDir, "camera.cjs")),
    fx: canvasRequire(path.join(libDir, "fx.cjs")),
  };
}

function loadCanvasPackage(label) {
  try {
    return canvasRequire("canvas");
  } catch {
    throw new MediaKitError(`${label}: canvas_scene needs the "canvas" npm package — run "npm i canvas" in the mediakit directory`, "CANVAS_MISSING");
  }
}

// Render a canvas_scene shot: run the scene's draw() for every
// frame (t = N/fps, deterministic), write PNGs to a scratch dir
// inside tmpDir, encode them to one segment. Frame count is
// counted on disk, like every other shot kind. The scratch dir is
// removed with tmpDir by the caller.
async function buildAssembleCanvasShot(plan, shot, opts, outPath, tmpDir, onEncodeProgress = null) {
  const { width, height, fps, crf, preset } = opts;
  const frames = shot.buildFrames;
  const { createCanvas, loadImage } = loadCanvasPackage(`assemble shot ${shot.id}`);
  const draw = await loadCanvasSceneModule(shot.scene, `assemble shot ${shot.id}`);
  const assets = {};
  for (const [name, assetPath] of Object.entries(shot.assets ?? {})) {
    assets[name] = await loadImage(assetPath);
  }
  const lib = canvasSceneLib();
  const M = { duration: shot.buildSeconds, fps, params: shot.params ?? {}, lib };
  const framesDir = path.join(tmpDir, `canvas-${shot.id}-frames`);
  await mkdir(framesDir, { recursive: true });
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  try {
    // Drawing is CPU work in Node, not an ffmpeg encode, so it has no
    // out_time to measure — the fraction stays 0 while drawing, but
    // the detail still moves (frame n/N, at most one callback per
    // 500 ms, so the job record keeps proving the worker is alive).
    let lastDrawEmit = 0;
    for (let n = 0; n < frames; n++) {
      const t = n / fps;
      ctx.clearRect(0, 0, width, height);
      await draw(ctx, t, width, height, assets, M);
      await writeFile(path.join(framesDir, `frame_${String(n).padStart(5, "0")}.png`), canvas.toBuffer("image/png"));
      if (typeof onEncodeProgress === "function" && (n === frames - 1 || Date.now() - lastDrawEmit >= 500)) {
        lastDrawEmit = Date.now();
        try { onEncodeProgress(0, { frame: n + 1, fps: null, speed: null, outTimeMs: null, phase: `drawing ${n + 1}/${frames}` }); } catch { /* advisory */ }
      }
    }
    await runFfmpegWithProgress([
      "-y", "-framerate", String(fps), "-i", path.join(framesDir, "frame_%05d.png"),
      "-frames:v", String(frames),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf), "-preset", preset, "-an", outPath,
    ], {
      totalSeconds: shot.buildSeconds,
      onProgress: typeof onEncodeProgress === "function" ? (p) => onEncodeProgress(p.fraction, p) : null,
    });
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
  const counted = await countVideoFrames(outPath);
  if (counted !== frames) {
    throw new MediaKitError(`assemble shot ${shot.id}: built ${counted} frames, expected ${frames}`, "ASSEMBLE_FRAME_MISMATCH");
  }
  return outPath;
}

// Per-shot text layers, applied as one drawtext re-encode over the
// built segment (uniform across image/video/color/canvas_scene, so
// each kind's builder stays untouched). Timing is nominal-shot
// seconds, shifted by the incoming transition handle — the segment
// is longer than the shot by its handles, and the visible window
// starts at handleInFrames/fps. Frame count is pinned with
// -frames:v so the join math downstream never shifts.
// Size and wrapping scale with the RENDER width (plan.width is the
// manifest size, opts.width is what this build actually renders):
// a preview renders at half size, and a 90px layer drawn unscaled
// on a 540-wide frame overflows both sides (measured 2026-11-13:
// "MINUS 14 LUFS" clipped to "NUS 14 LU" in the preview). So the
// layer is re-wrapped for the render width here, not at validate.
async function applyAssembleTextLayers(plan, shot, opts, inPath, onTextProgress = null) {
  const layers = shot.textLayers ?? [];
  if (!layers.length) return inPath;
  const { fps, crf, preset } = opts;
  const scale = opts.width / plan.width;
  const handleInSec = (shot.handleInFrames ?? 0) / fps;
  const tmpFiles = [];
  try {
    const jobs = [];
    for (const [i, layer] of layers.entries()) {
      const tmpFile = path.join(path.dirname(inPath), `.assemble-text-${process.pid}-${i}.txt`);
      tmpFiles.push(tmpFile);
      const size = Math.max(8, Math.round(layer.size * scale));
      const maxChars = Math.max(8, Math.floor(opts.width / (size * ASSEMBLE_TEXT_EM_PER_CHAR)));
      await writeFile(tmpFile, wrapTitleLines(layer.text, maxChars).join("\n"), "utf8");
      jobs.push({ layer, tmpFile, size });
    }
    const vf = jobs.map(({ layer, tmpFile, size }) => {
      const esc = tmpFile.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
      const y = layer.position === "top" ? "h*0.08"
        : layer.position === "center" ? "(h-text_h)/2" : "h-text_h-h*0.08";
      const segStart = +(handleInSec + layer.start_seconds).toFixed(4);
      const segEnd = +(handleInSec + layer.end_seconds).toFixed(4);
      const box = layer.box ? `:box=1:boxcolor=black@0.6:boxborderw=${Math.round(size * 0.25)}` : "";
      return `drawtext=fontfile=${TITLECARD_FONT}:textfile=${esc}:fontsize=${size}:fontcolor=0x${layer.color}:borderw=4:bordercolor=black${box}:x=(w-text_w)/2:y=${y}:enable=between(t\\,${segStart}\\,${segEnd})`;
    }).join(",");
    const tmpOut = `${inPath}.text.mp4`;
    await runFfmpegWithProgress([
      "-y", "-i", inPath, "-vf", vf, "-frames:v", String(shot.buildFrames),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf), "-preset", preset, "-an", tmpOut,
    ], {
      totalSeconds: shot.buildSeconds,
      onProgress: typeof onTextProgress === "function" ? (p) => onTextProgress(p.fraction, p) : null,
    });
    await rename(tmpOut, inPath);
  } finally {
    for (const f of tmpFiles) await unlink(f).catch(() => {});
  }
  return inPath;
}

// One shot -> one uniform segment (libx264/yuv420p, target size/fps,
// no audio, exactly shot.buildFrames frames — counted on disk, not
// assumed). The segment covers the nominal shot PLUS its transition
// handles (buildStart/buildDuration for video, buildDuration for
// image/color); the xfade join consumes exactly the handles, so the
// joined video keeps the nominal frame count. Image shots go through
// zoomPan (a fixed 1.0 zoom fills the frame for a still hold); video
// shots are trimmed + reframed (crop) in one encode; color shots come
// from the lavfi color source. Any frame-count mismatch throws — a
// segment that is a frame short would silently shift every shot
// after it.
async function buildAssembleShot(plan, shot, opts, outPath, onShotProgress = null) {
  const { width, height, fps, crf, preset } = opts;
  // A shot is 1 encode, or 2 when it carries text layers (base build
  // + drawtext re-encode). Each encode counts equally: the base maps
  // to [0, 1/n), the text pass to [1/n, 1]. The detail string carries
  // the live frame/speed so a poller sees movement, not just a number.
  const encodes = (shot.textLayers?.length ? 2 : 1);
  const detailFor = (p, phase) => {
    const parts = [shot.id];
    if (phase) parts.push(phase);
    if (p?.frame != null) parts.push(`frame ${p.frame}/${shot.buildFrames}`);
    if (p?.speed != null) parts.push(`${p.speed}x`);
    return parts.join(" · ");
  };
  const baseProgress = typeof onShotProgress === "function"
    ? (frac, p, phase) => { try { onShotProgress(frac / encodes, detailFor(p, phase ?? p?.phase)); } catch { /* advisory */ } }
    : null;
  const textProgress = typeof onShotProgress === "function"
    ? (frac, p) => { try { onShotProgress((1 + frac) / encodes, detailFor(p, "text")); } catch { /* advisory */ } }
    : null;
  if (shot.kind === "canvas_scene") {
    await buildAssembleCanvasShot(plan, shot, opts, outPath, opts.tmpDir, baseProgress);
  } else if (shot.kind === "image") {
    const z = shot.zoom ?? { from: 1, to: 1, focus: [0.5, 0.5], focus_end: [0.5, 0.5] };
    const r = await zoomPan({
      input: shot.source, output: outPath, duration: shot.buildSeconds, fps,
      zoomFrom: z.from, zoomTo: z.to,
      focusX: z.focus[0], focusY: z.focus[1],
      focusEndX: z.focus_end[0], focusEndY: z.focus_end[1],
      width, height, crf,
      onProgress: baseProgress ? (p) => baseProgress(p.fraction, p) : null,
    });
    if (r.frames !== shot.buildFrames) {
      throw new MediaKitError(`assemble shot ${shot.id}: built ${r.frames} frames, expected ${shot.buildFrames}`, "ASSEMBLE_FRAME_MISMATCH");
    }
  } else if (shot.kind === "video") {
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p`;
    await runFfmpegWithProgress([
      "-y", "-ss", String(shot.buildStart), "-t", String(shot.buildSeconds), "-i", shot.source,
      "-vf", vf, "-frames:v", String(shot.buildFrames),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf), "-preset", preset, "-an", outPath,
    ], {
      totalSeconds: shot.buildSeconds,
      onProgress: baseProgress ? (p) => baseProgress(p.fraction, p) : null,
    });
  } else {
    await runFfmpegWithProgress([
      "-y", "-f", "lavfi", "-i", `color=c=0x${shot.color}:s=${width}x${height}:r=${fps}`,
      "-frames:v", String(shot.buildFrames),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf), "-preset", preset, "-an", outPath,
    ], {
      totalSeconds: shot.buildSeconds,
      onProgress: baseProgress ? (p) => baseProgress(p.fraction, p) : null,
    });
  }
  await applyAssembleTextLayers(plan, shot, opts, outPath, textProgress);
  const counted = await countVideoFrames(outPath);
  if (counted !== shot.buildFrames) {
    throw new MediaKitError(`assemble shot ${shot.id}: built ${counted} frames, expected ${shot.buildFrames}`, "ASSEMBLE_FRAME_MISMATCH");
  }
  return outPath;
}

// Join uniform segments with xfade transitions (video-only — the
// audio is mixed separately from the voice timeline). Every offset
// is frame-aligned by construction (see deriveAssembleJoins), so the
// joined video has exactly the nominal frame count; the caller
// verifies that on disk. The final fps filter pins the frame rate
// after the chain.
async function joinAssembleSegments(segmentPaths, joins, opts, outPath, onJoinProgress = null, totalSeconds = null) {
  const { fps, crf, preset } = opts;
  const graph = [];
  let vLabel = "0:v";
  for (let k = 0; k < joins.length; k++) {
    const j = joins[k];
    const vOut = `x${k}`;
    // Full double precision on the offset: it is (cutFrames -
    // hAfter)/fps, and a repeating decimal like 542/30 =
    // 18.0666... rounded to 4 decimals (18.0667) overshoots by
    // 33us — enough for the trailing fps filter to emit one extra
    // frame at the end (measured 2026-11-14: 601 frames instead of
    // 600 on a 20s preview; full precision gives exactly 600).
    // durationSeconds is already printed at full precision.
    graph.push(`[${vLabel}][${k + 1}:v]xfade=transition=${j.type}:duration=${j.durationSeconds}:offset=${j.offsetSeconds}[${vOut}]`);
    vLabel = vOut;
  }
  graph.push(`[${vLabel}]fps=${fps},format=yuv420p[vout]`);
  const args = ["-y"];
  for (const p of segmentPaths) args.push("-i", p);
  args.push(
    "-filter_complex", graph.join(";"),
    "-map", "[vout]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-crf", String(crf), "-preset", preset, "-an", outPath,
  );
  await runFfmpegWithProgress(args, {
    totalSeconds,
    onProgress: typeof onJoinProgress === "function" ? (p) => onJoinProgress(p.fraction, p) : null,
  });
  return outPath;
}

// Per-shot segment cache, same shape as the manifest tool's cache:
// <manifestDir>/.mediakit-assemble-cache/<sha256>.mp4 + index.json
// {key: {output_size_bytes, output_sha256}}. A hit is verified by
// size + SHA-256, never trusted on filename alone.
async function assembleCachedShot(plan, shot, opts, tmpDir, onShotProgress = null) {
  const cacheDir = path.join(plan.manifestDir, ASSEMBLE_CACHE_DIRNAME);
  const indexPath = path.join(cacheDir, "index.json");
  const key = createHash("sha256").update(stableStringify({
    renderer: ASSEMBLE_VERSION,
    kind: shot.kind,
    template: shot.template ?? null,
    asset: shot.assetHash ?? shot.color,
    start: shot.buildStart ?? shot.start ?? null,
    duration: shot.buildSeconds,
    frames: shot.buildFrames,
    transition: shot.transition ? { type: shot.transition.type, frames: shot.transition.frames } : null,
    zoom: shot.zoom ?? null,
    text: shot.textLayers ?? null,
    params: shot.params ?? null,
    width: opts.width, height: opts.height, fps: opts.fps, crf: opts.crf, preset: opts.preset,
  })).digest("hex");
  const cacheFile = path.join(cacheDir, `${key}.mp4`);
  const segPath = path.join(tmpDir, `shot-${shot.id}.mp4`);
  let cacheIndex = {};
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cacheIndex = parsed;
  } catch { /* missing or corrupt cache index starts fresh */ }
  if (cacheIndex[key]) {
    try {
      const st = await stat(cacheFile);
      if (st.size === cacheIndex[key].output_size_bytes && (await hashFile(cacheFile)) === cacheIndex[key].output_sha256) {
        await copyFile(cacheFile, segPath);
        return { path: segPath, cached: true };
      }
    } catch { /* cached segment gone or changed: rebuild */ }
  }
  await mkdir(cacheDir, { recursive: true });
  await buildAssembleShot(plan, shot, { ...opts, tmpDir }, segPath, onShotProgress);
  try {
    await copyFile(segPath, cacheFile);
    const st = await stat(cacheFile);
    cacheIndex[key] = { output_size_bytes: st.size, output_sha256: await hashFile(cacheFile) };
    await writeFile(indexPath, JSON.stringify(cacheIndex, null, 2), "utf8");
  } catch { /* cache write is best-effort; the segment itself is built */ }
  return { path: segPath, cached: false };
}

// Voice padded to the film timeline: adelay by lead, apad to the
// total duration. The padded voice IS the final timeline, so mix()
// SFX timestamps and the music loop both land in absolute time.
async function buildPaddedVoice(plan, totalSeconds, outPath, onVoiceProgress = null) {
  const leadMs = Math.round(plan.voice.lead * 1000);
  const af = leadMs > 0
    ? `adelay=${leadMs}:all=1,apad=whole_dur=${totalSeconds}`
    : `apad=whole_dur=${totalSeconds}`;
  await runFfmpegWithProgress([
    "-y", "-i", plan.voice.path, "-af", af,
    "-c:a", "aac", "-b:a", "192k", "-t", String(totalSeconds), outPath,
  ], {
    totalSeconds,
    onProgress: typeof onVoiceProgress === "function" ? (p) => onVoiceProgress(p.fraction, p) : null,
  });
  const meta = await probe(outPath);
  if (!meta.audio) throw new MediaKitError("assemble could not build the padded voice track", "PROBE_FAILED");
  return outPath;
}

function assembleApprovalPath(plan) {
  const stem = path.basename(plan.manifest, path.extname(plan.manifest));
  return path.join(plan.manifestDir, `${stem}.assemble-approval.json`);
}

// Approval gate for full renders, shared by the sync render path
// and startAssembleJob: the async job must fail fast with the same
// error instead of being born dead and hiding it behind a poll.
async function requireAssembleApproval(plan, force) {
  if (force) return "forced";
  let approval = null;
  try {
    approval = JSON.parse(await readFile(assembleApprovalPath(plan), "utf8"));
  } catch { /* no approval file */ }
  if (!approval) {
    throw new MediaKitError("assemble render needs approval: run --mode preview, show it to the user, then --mode approve (or pass force:true to render without approval)", "INVALID_ARG");
  }
  if (approval.fingerprint !== plan.fingerprint) {
    const changed = [];
    const parts = approval.fingerprint_parts ?? {};
    for (const k of ["manifest", "voice", "music", "captions", "brand"]) {
      if (JSON.stringify(parts[k] ?? null) !== JSON.stringify(plan.fingerprint_parts[k] ?? null)) changed.push(k);
    }
    if (JSON.stringify(parts.assets ?? {}) !== JSON.stringify(plan.fingerprint_parts.assets ?? {})) changed.push("assets");
    if (JSON.stringify(parts.sfx ?? []) !== JSON.stringify(plan.fingerprint_parts.sfx ?? [])) changed.push("sfx");
    throw new MediaKitError(
      `assemble approval is stale — changed since approval: ${changed.length ? changed.join(", ") : "unknown"}. Re-render the preview and approve again (or pass force:true).`,
      "INVALID_ARG",
    );
  }
  return "approved";
}

export async function assemble({ manifestPath, mode = "validate", outputDir = null, previewSeconds = 20, force = false, onProgress = null, jobId = null, jobDir = null }) {
  const manifestAbs = await requireInput(manifestPath, "manifest");
  let raw;
  try {
    raw = await readFile(manifestAbs, "utf8");
  } catch (e) {
    throw new MediaKitError(`cannot read manifest ${manifestPath}: ${e.message}`, "INVALID_INPUT");
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new MediaKitError(`assemble manifest is not valid JSON: ${e.message}`, "INVALID_ARG");
  }
  const plan = await validateAssembleManifest(doc, manifestAbs);
  const startedAt = Date.now();
  const base = {
    operation: "assemble",
    mode,
    manifest: manifestAbs,
    title: plan.title,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    style: plan.style,
    preset: plan.preset,
    preset_applied: plan.preset_applied,
    preset_overrides: plan.preset_overrides,
    brand: plan.brand,
    brand_applied: plan.brand_applied,
    brand_overrides: plan.brand_overrides,
    total_seconds: plan.total_seconds,
    total_frames: plan.total_frames,
    fingerprint: plan.fingerprint,
    warnings: plan.warnings,
  };
  if (mode === "validate") {
    return {
      ...base,
      voice: plan.voice,
      music: plan.music ? { volume: plan.music.volume, duck_db: plan.music.duck_db } : null,
      sfx_count: plan.sfx.length,
      captions: plan.captions,
      chapters: plan.chapters,
      shots: plan.shots.map((s) => ({ id: s.id, kind: s.kind, duration: s.duration, frames: s.frames, ...(s.template ? { template: s.template, params: s.params ?? null } : {}), ...(s.transition ? { transition: { type: s.transition.type, duration_seconds: s.transition.duration_seconds, frames: s.transition.frames } } : {}), ...(s.textLayers?.length ? { text_layers: s.textLayers.map((t) => ({ text: t.text, lines: t.lines, position: t.position, size: t.size, color: t.color, box: t.box, start_seconds: t.start_seconds, end_seconds: t.end_seconds })) } : {}) })),
    };
  }
  if (!["preview", "approve", "render"].includes(mode)) {
    throw new MediaKitError(`assemble mode must be validate, preview, approve or render, got: ${mode}`, "INVALID_ARG");
  }
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new MediaKitError(`assemble --mode ${mode} needs an output directory`, "INVALID_ARG");
  }
  const outDirAbs = await prepareOutputDir(outputDir);

  if (mode === "approve") {
    const previewPath = path.join(outDirAbs, "preview.json");
    let previewDoc;
    try {
      previewDoc = JSON.parse(await readFile(previewPath, "utf8"));
    } catch {
      throw new MediaKitError(`assemble approve needs a preview first: no preview.json in ${outputDir} — run --mode preview, show it to the user, then approve`, "INVALID_ARG");
    }
    if (previewDoc.fingerprint !== plan.fingerprint) {
      throw new MediaKitError("assemble approve refused: the preview is stale — the manifest, voice, assets or captions changed since the preview was rendered. Re-render the preview first.", "INVALID_ARG");
    }
    const approvalPath = assembleApprovalPath(plan);
    const approval = {
      fingerprint: plan.fingerprint,
      fingerprint_parts: plan.fingerprint_parts,
      manifest: manifestAbs,
      preview: previewPath,
      approved_at: new Date().toISOString(),
    };
    await writeFile(approvalPath, JSON.stringify(approval, null, 2) + "\n", "utf8");
    return { ...base, approval_file: approvalPath, preview: previewPath, approved_at: approval.approved_at };
  }

  const isPreview = mode === "preview";
  const previewTotal = isPreview ? Math.min(num(previewSeconds, "preview_seconds", { min: 1, max: 60 }), plan.total_seconds) : plan.total_seconds;
  const previewFrames = Math.round(previewTotal * plan.fps);
  const outW = isPreview ? assembleEvenDown(Math.floor(plan.width / 2)) : plan.width;
  const outH = isPreview ? assembleEvenDown(Math.floor(plan.height / 2)) : plan.height;
  const crf = isPreview ? 28 : 23;
  const preset = isPreview ? "ultrafast" : "medium";
  const opts = { width: outW, height: outH, fps: plan.fps, crf, preset };

  // Approval gate for full renders (preview never needs approval).
  let approvalStatus = null;
  if (!isPreview) {
    approvalStatus = await requireAssembleApproval(plan, force);
  }

  // Progress reporting for async jobs: stage-level at the boundaries,
  // and frame-level INSIDE the long ffmpeg steps — each shot encode,
  // the xfade join, the voice pad and the caption burn report
  // out_time/total through runFfmpegWithProgress, so the percent
  // moves continuously instead of jumping stage to stage (turn 84).
  // The mux is a stream copy and the qa is probes, so those two stay
  // boundary-only. A progress callback must never fail the render.
  const PROGRESS_STAGES = isPreview ? ["shots", "join", "audio", "mux", "captions"] : ["shots", "join", "audio", "mux", "captions", "qa"];
  const emitProgress = (stage, fraction, detail = null) => {
    if (typeof onProgress !== "function") return;
    const idx = PROGRESS_STAGES.indexOf(stage);
    if (idx === -1) return;
    const percent = Math.min(100, Math.round((100 * (idx + Math.min(1, Math.max(0, fraction)))) / PROGRESS_STAGES.length));
    try { onProgress({ stage, percent, detail }); } catch { /* never fail the render on progress */ }
  };
  // The worker process marks itself running (with its pid, so `job
  // --cancel` can kill the whole process group) as soon as the gate
  // has passed — before the first ffmpeg call. If the job was
  // cancelled while queued, the worker aborts here instead of
  // rendering into a cancelled job.
  if (jobId && jobDir) {
    const rec = await markJobRunning(jobId, jobDir, process.pid);
    if (rec?.status === "cancelled") {
      throw new MediaKitError(`job ${jobId} was cancelled before the render started`, "JOB_CANCELLED");
    }
  }

  // Clip shots to the preview window (preview only): the last
  // intersecting shot is cut to the exact preview frame count.
  // A transition is dropped (hard cut, with a warning) when the
  // next shot is clipped below its incoming handle.
  let renderShots = plan.shots;
  let renderTotalSeconds = plan.total_seconds;
  let renderTotalFrames = plan.total_frames;
  const previewWarnings = [];
  if (isPreview) {
    renderShots = [];
    let used = 0;
    for (const s of plan.shots) {
      if (used >= previewFrames) break;
      const take = Math.min(s.frames, previewFrames - used);
      renderShots.push({ ...s, frames: take, duration: take / plan.fps });
      used += take;
    }
    renderTotalSeconds = previewTotal;
    renderTotalFrames = previewFrames;
    for (let i = 1; i < renderShots.length; i++) {
      const t = renderShots[i].transition;
      if (!t) continue;
      const hAfter = t.frames - Math.floor(t.frames / 2);
      if (renderShots[i].frames < hAfter) {
        previewWarnings.push(`preview: transition into shot ${renderShots[i].id} dropped — the shot is clipped to ${renderShots[i].frames} frames, below its ${hAfter}-frame handle (hard cut instead)`);
        delete renderShots[i].transition;
      }
    }
  }
  const videoPlan = planAssembleVideo(renderShots, plan.fps);
  const renderShotsBuilt = videoPlan.shots;
  const joins = videoPlan.joins;

  const tmpDir = path.join(outDirAbs, `.mediakit-assemble-tmp-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
  let cacheHits = 0;
  let completed = false;
  const segmentPaths = [];
  try {
    for (const [i, shot] of renderShotsBuilt.entries()) {
      emitProgress("shots", i / renderShotsBuilt.length, shot.id);
      const r = await assembleCachedShot(plan, shot, opts, tmpDir, (frac, detail) => {
        emitProgress("shots", (i + frac) / renderShotsBuilt.length, detail);
      });
      if (r.cached) cacheHits++;
      segmentPaths.push(r.path);
    }
    emitProgress("shots", 1);
    const videoOnlyPath = path.join(tmpDir, "video-only.mp4");
    emitProgress("join", 0);
    if (joins.length === 0) {
      const listPath = path.join(tmpDir, "concat.txt");
      await writeFile(listPath, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
      await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", videoOnlyPath]);
    } else {
      await joinAssembleSegments(segmentPaths, joins, opts, videoOnlyPath, (frac, p) => {
        emitProgress("join", frac, p?.speed != null ? `join · ${p.speed}x` : "join");
      }, renderTotalSeconds);
    }
    emitProgress("join", 1);
    const concatFrames = await countVideoFrames(videoOnlyPath);
    if (concatFrames !== renderTotalFrames) {
      throw new MediaKitError(`assemble concat produced ${concatFrames} frames, expected ${renderTotalFrames}`, "ASSEMBLE_FRAME_MISMATCH");
    }
    // Audio: padded voice (the final timeline) + music bed + SFX.
    // The pad is the first of two audio steps (pad, then mix/loudness),
    // so it reports 0..0.5 of the stage and the mix completes it — an
    // approximation of the work split, stated here, not a measurement.
    emitProgress("audio", 0);
    const paddedPath = path.join(tmpDir, "voice-padded.m4a");
    await buildPaddedVoice(plan, renderTotalSeconds, paddedPath, (frac, p) => {
      emitProgress("audio", frac * 0.5, p?.speed != null ? `voice · ${p.speed}x` : "voice");
    });
    const previewSfx = isPreview ? plan.sfx.filter((s) => s.at_seconds < renderTotalSeconds) : plan.sfx;
    const mixedPath = path.join(tmpDir, "mixed.m4a");
    if (plan.music) {
      await mix({
        voice: paddedPath, music: plan.music.path, output: mixedPath,
        musicVolume: plan.music.volume, duckDb: plan.music.duck_db,
        sfx: previewSfx.map((s) => ({ file: s.file, at: s.at_seconds, volume: s.volume })),
      });
    } else {
      await loudness({ input: paddedPath, output: mixedPath, targetLufs: -14 });
    }
    emitProgress("audio", 1);
    // Chapters (render only): an ffmetadata sidecar with one
    // [CHAPTER] per entry — the last chapter runs to the film end.
    // Titles are sanitized: ffmetadata treats = ; # \ and newlines
    // as syntax, so they become spaces.
    let chapterPath = null;
    if (!isPreview && plan.chapters?.length) {
      chapterPath = path.join(tmpDir, "chapters.txt");
      const lines = [";FFMETADATA1"];
      for (let i = 0; i < plan.chapters.length; i++) {
        const startMs = Math.round(plan.chapters[i].at_seconds * 1000);
        const endMs = i + 1 < plan.chapters.length ? Math.round(plan.chapters[i + 1].at_seconds * 1000) : Math.round(renderTotalSeconds * 1000);
        lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${startMs}`, `END=${endMs}`, `title=${plan.chapters[i].title.replace(/[\r\n=;#\\]/g, " ")}`);
      }
      await writeFile(chapterPath, lines.join("\n") + "\n", "utf8");
    }
    const muxedPath = path.join(tmpDir, "muxed.mp4");
    emitProgress("mux", 0);
    const muxArgs = ["-y", "-i", videoOnlyPath, "-i", mixedPath];
    if (chapterPath) muxArgs.push("-i", chapterPath);
    muxArgs.push("-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-t", String(renderTotalSeconds));
    if (chapterPath) muxArgs.push("-map_metadata", "2", "-map_chapters", "2");
    muxArgs.push("-movflags", "+faststart", muxedPath);
    await run(FFMPEG, muxArgs);
    emitProgress("mux", 1);
    const finalName = isPreview ? "preview.mp4" : "final.mp4";
    const finalPath = path.join(outDirAbs, finalName);
    emitProgress("captions", 0);
    if (plan.captions) {
      const bv = plan.styleValues?.burn_captions ?? { font_size: null, margin_v: null, style: "background" };
      // Locked burn values are tuned for the manifest size
      // (1080x1920): scale them to the actual render height, or the
      // preview's subtitles render 2x too big and climb over the
      // text layers (measured turn 54: 60px/500px on a 540x960
      // preview put 6 lines across y=0-540, R mean 42.9 in the
      // 300-450 band that must stay dark). A null stays null, so
      // burnCaptions' own height-relative defaults still apply.
      const burnScale = opts.height / plan.height;
      await burnCaptions({
        input: muxedPath, output: finalPath, captions: plan.captions.path,
        fontSize: bv.font_size == null ? null : Math.max(8, Math.round(bv.font_size * burnScale)),
        marginV: bv.margin_v == null ? null : Math.max(0, Math.round(bv.margin_v * burnScale)),
        style: bv.style ?? "background",
        onProgress: (p) => emitProgress("captions", p.fraction, p?.speed != null ? `captions · ${p.speed}x` : "captions"),
      });
    } else {
      await copyFile(muxedPath, finalPath);
    }
    emitProgress("captions", 1);
    const finalProbe = await probe(finalPath);
    const finalFrames = await countVideoFrames(finalPath);
    if (finalFrames !== renderTotalFrames) {
      throw new MediaKitError(`assemble ${finalName} has ${finalFrames} frames, expected ${renderTotalFrames}`, "ASSEMBLE_FRAME_MISMATCH");
    }
    const finalLufs = finalProbe.audio ? await measureLoudness(finalPath) : null;
    const elapsed = +((Date.now() - startedAt) / 1000).toFixed(1);
    if (isPreview) {
      const previewDoc = {
        ...base,
        preview_seconds: renderTotalSeconds,
        preview_frames: renderTotalFrames,
        output: finalPath,
        dimensions: `${outW}x${outH}`,
        cache_hits: cacheHits,
        transition_warnings: previewWarnings,
        elapsed_seconds: elapsed,
      };
      await writeFile(path.join(outDirAbs, "preview.json"), JSON.stringify(previewDoc, null, 2) + "\n", "utf8");
      completed = true;
      return {
        ...previewDoc,
        final: { duration_seconds: finalProbe.duration_seconds, dimensions: `${finalProbe.video?.width}x${finalProbe.video?.height}`, loudness_lufs: finalLufs },
      };
    }
    emitProgress("qa", 0);
    const qa = await qaReport({ input: finalPath, target: "any", expectedDuration: plan.total_seconds });
    emitProgress("qa", 1);
    const finalSha = await hashFile(finalPath);
    const receipt = {
      ...base,
      approval: approvalStatus,
      output: finalPath,
      // Render manifest digests (leclap's render-manifest idea):
      // per-input content hashes + the paths they were read from, so
      // `verify` can re-hash every input and name exactly which one
      // changed instead of only reporting that the combined
      // fingerprint moved. The fingerprint itself is the same
      // combined hash the approval gate uses.
      fingerprint_parts: plan.fingerprint_parts,
      inputs: {
        manifest: manifestAbs,
        voice: plan.voice.path,
        music: plan.music?.path ?? null,
        captions: plan.captions?.path ?? null,
        sfx: plan.sfx.map((s) => s.file),
        shots: Object.fromEntries(plan.shots.map((s) => [s.id, {
          ...(s.source ? { source: s.source } : {}),
          ...(s.scene ? { scene: s.scene } : {}),
          ...(s.assets ? { assets: s.assets } : {}),
          ...(s.color ? { color: s.color } : {}),
        }])),
      },
      mediakit_version: MEDIAKIT_VERSION,
      ffmpeg_version: await ffmpegVersionString(),
      cache_hits: cacheHits,
      chapters: plan.chapters,
      shots_run: renderShots.length,
      joins: joins.map((j) => ({ into_shot: renderShotsBuilt[j.index]?.id ?? null, type: j.type, duration_seconds: j.durationSeconds, offset_seconds: j.offsetSeconds })),
      elapsed_seconds: elapsed,
      final: {
        duration_seconds: finalProbe.duration_seconds,
        dimensions: finalProbe.video ? `${finalProbe.video.width}x${finalProbe.video.height}` : null,
        frames: finalFrames,
        loudness_lufs: finalLufs,
        sha256: finalSha,
        ...(await fileInfo(finalPath)),
      },
      qa,
    };
    await writeFile(path.join(outDirAbs, "assemble-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", "utf8");
    // The async worker's terminal write: the job record carries the
    // receipt summary so a poller never has to open the receipt file.
    if (jobId && jobDir) {
      await finishJob(jobId, jobDir, {
        output: finalPath,
        duration_seconds: finalProbe.duration_seconds,
        dimensions: finalProbe.video ? `${finalProbe.video.width}x${finalProbe.video.height}` : null,
        frames: finalFrames,
        loudness_lufs: finalLufs,
        sha256: finalSha,
        qa_verdict: qa?.verdict ?? null,
      });
    }
    completed = true;
    return receipt;
  } catch (e) {
    // The worker records its own failure — unless the job was
    // cancelled meanwhile, in which case the canceller's record wins.
    if (jobId && jobDir) {
      await failJob(jobId, jobDir, e);
    }
    // Intermediates are kept on failure so the broken shot can be
    // inspected and re-run by hand; the error names the directory.
    if (e instanceof MediaKitError && !e.message.includes(tmpDir)) {
      throw new MediaKitError(`${e.message} — intermediates kept in ${tmpDir}`, e.code);
    }
    throw e;
  } finally {
    // The tmp dir is removed on success; on failure it stays, so the
    // broken shot can be inspected (the error names its path).
    if (completed) {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}

// ---------------------------------------------------------------- init_project
// Director scaffold (wilwaldon/Claude-Code-Video-Toolkit project
// lifecycle idea, lượt 93): one command starts a video project the
// way assemble expects to finish it — a film.json that already
// validates, a placeholder voice so the timeline math is real,
// captions, an assets/ layout, and a CLAUDE.md that walks the agent
// (or the user) through validate → diagnose → preview → approve →
// render → verify. The scaffold is deliberately runnable, not a blank
// template: the starter film renders a real 4-second film out of the
// box (two template shots, no image assets needed), so the first
// `assemble --mode validate` passes and the first preview shows
// motion — the project is then edited, not debugged into existence.
// The placeholder voice is a 440 Hz tone WAV (WAV, not MP3: MP3
// encoder delay would shift the measured duration off 3.000s and
// break the exact frame math), and CLAUDE.md says in plain words to
// replace it before delivery.
const INIT_VOICE_SECONDS = 3;
const INIT_LEAD_SECONDS = 0.5;
const INIT_TAIL_SECONDS = 0.5;

export async function initProject({ dir, title = null, preset = "vertical", brand = null, force = false }) {
  if (typeof dir !== "string" || !dir.trim()) {
    throw new MediaKitError("init_project needs a project directory", "INVALID_ARG");
  }
  // Preset + brand go through the same resolvers assemble uses, so a
  // bad id fails here with the same message — not at first render.
  const presetDoc = await resolveAssemblePreset(preset ?? "vertical");
  const brandDoc = await resolveAssembleBrand(brand ?? null, "init_project brand");
  const absDir = path.resolve(dir);
  await assertInsideWorkdir(absDir, "project directory");
  const projectTitle = (typeof title === "string" && title.trim())
    ? title.trim()
    : path.basename(absDir);
  const filmPath = path.join(absDir, "film.json");
  const claudePath = path.join(absDir, "CLAUDE.md");
  // Refuse to clobber an existing project unless force says so —
  // silently overwriting a film.json someone edited would destroy
  // their film. The check runs before any directory is created, so a
  // refusal writes nothing.
  if (!force) {
    for (const p of [filmPath, claudePath]) {
      try {
        await access(p, fsConstants.F_OK);
        throw new MediaKitError(`init_project refuses to overwrite existing ${path.basename(p)} in ${absDir} (pass force:true to replace it)`, "ALREADY_EXISTS");
      } catch (err) {
        if (err instanceof MediaKitError) throw err;
        // ENOENT: the file does not exist yet — that is the happy path.
      }
    }
  }
  await mkdir(absDir, { recursive: true });
  await assertInsideWorkdir(absDir, "project directory"); // re-check now it exists (symlinks resolved)
  await assertOutputWritable(absDir);
  const assetsDir = path.join(absDir, "assets");
  const voicePath = path.join(assetsDir, "voice.wav");
  const captionsPath = path.join(assetsDir, "captions.srt");
  await mkdir(path.join(assetsDir, "shots"), { recursive: true });
  await mkdir(path.join(assetsDir, "music"), { recursive: true });
  await mkdir(path.join(absDir, "outputs"), { recursive: true });
  // Placeholder voice: exact 3.000s tone, verified by probe below.
  // The film math is built on that exact duration (lead 0.5 + voice
  // 3 + tail 0.5 = 4s; two 2s shots = 120 frames at 30fps), so a
  // drifted voice would fail validation — measure, do not assume.
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${INIT_VOICE_SECONDS}`,
    "-af", "volume=0.5", "-c:a", "pcm_s16le", "-ar", "48000", voicePath]);
  const voiceMeta = await probe(voicePath);
  if (!voiceMeta.audio || Math.abs(voiceMeta.duration_seconds - INIT_VOICE_SECONDS) > 0.05) {
    throw new MediaKitError(`init_project placeholder voice measured ${voiceMeta.duration_seconds}s, expected ${INIT_VOICE_SECONDS}s`, "SMOKE_FAILED");
  }
  const totalSeconds = INIT_LEAD_SECONDS + INIT_VOICE_SECONDS + INIT_TAIL_SECONDS;
  const fps = presetDoc.fps;
  const cardText = projectTitle.replace(/\s+/g, " ").toUpperCase();
  const film = {
    version: 1,
    title: projectTitle,
    preset: presetDoc.id,
    ...(brandDoc ? { brand } : {}),
    voice: { path: "assets/voice.wav", lead: INIT_LEAD_SECONDS, tail: INIT_TAIL_SECONDS },
    captions: "assets/captions.srt",
    chapters: [
      { title: "Intro", at: 0 },
      { title: "The turn", at: 2 },
    ],
    shots: [
      { id: "s1", kind: "canvas_scene", template: "title-card", params: { text: cardText }, duration: 2 },
      { id: "s2", kind: "canvas_scene", template: "rings", duration: 2 },
    ],
  };
  await writeFile(filmPath, `${JSON.stringify(film, null, 2)}\n`, "utf8");
  const captions = [
    "1",
    "00:00:00,500 --> 00:00:02,000",
    "This is a placeholder voice.",
    "",
    "2",
    "00:00:02,000 --> 00:00:03,500",
    "Replace assets/voice.wav with your real narration.",
    "",
  ].join("\n");
  await writeFile(captionsPath, captions, "utf8");
  const brandLine = brandDoc ? ` Brand: ${brand}.` : "";
  const claudeMd = [
    `# ${projectTitle} — video project`,
    "",
    `Scaffolded by \`mediakit init_project\` (preset: ${presetDoc.id}, ${presetDoc.width}x${presetDoc.height} @ ${fps}fps).${brandLine}`,
    "This file is the project memory: the layout, the lifecycle, and the rules. Read it before touching film.json.",
    "",
    "## Layout",
    "",
    "- `film.json` — the film manifest (assemble schema). The voice is the master clock.",
    "- `assets/voice.wav` — PLACEHOLDER voice (440 Hz tone, 3s). Replace it with the real narration before delivery.",
    "- `assets/captions.srt` — placeholder captions; rewrite them to match the real voice.",
    "- `assets/shots/` — still images / video clips referenced by shots.",
    "- `assets/music/` — music bed (optional).",
    "- `outputs/` — previews and the final render live here.",
    "",
    "## Lifecycle (never skip a step)",
    "",
    "validate → diagnose → preview → approve → render → verify.",
    "",
    "1. Edit `film.json` (shots, voice, captions, chapters).",
    "2. `mediakit assemble film.json --mode validate` — the timeline math must pass.",
    "3. `mediakit diagnose film.json` — real motion, voice loudness, caption coverage. Fix every error.",
    "4. `mediakit assemble film.json --mode preview -o outputs/preview` — render the first seconds at half size.",
    "5. Show the preview to the user. Do not approve your own checks — approval means a human saw it.",
    "6. `mediakit assemble film.json --mode approve -o outputs/preview`",
    "7. `mediakit assemble film.json --mode render -o outputs`",
    "8. `mediakit verify outputs/assemble-receipt.json` — the render must verify clean.",
    "",
    "## Rules",
    "",
    "- The voice is the master clock: total = lead + voice + tail. Shot durations must cover it exactly in frames — no silent trim, pad, or speed change.",
    "- A still image without zoom may last at most 2.5s (motion gate) — add a zoom or split the shot.",
    "- Preview before approve, always. `render --force` only when the user explicitly says so.",
    "- Replace the placeholder voice and captions before delivery — the tone is not narration.",
    "",
  ].join("\n");
  await writeFile(claudePath, claudeMd, "utf8");
  return {
    operation: "init_project",
    dir: absDir,
    title: projectTitle,
    preset: presetDoc.id,
    ...(brandDoc ? { brand } : {}),
    film: filmPath,
    voice: voicePath,
    voice_seconds: voiceMeta.duration_seconds,
    captions: captionsPath,
    claude_md: claudePath,
    total_seconds: totalSeconds,
    total_frames: Math.round(totalSeconds * fps),
    shots: film.shots.map((s) => ({ id: s.id, template: s.template, duration: s.duration })),
    created: [filmPath, voicePath, captionsPath, claudePath],
    next_steps: [
      "mediakit assemble film.json --mode validate",
      "mediakit diagnose film.json",
      "mediakit assemble film.json --mode preview -o outputs/preview",
    ],
  };
}

// ---------------------------------------------------------------- verify
// Verify an assemble render against its receipt (heristop/leclap's
// `verify` idea, adapted to MediaKit's assemble receipt): the receipt
// records per-input digests, the combined fingerprint, the output
// sha256 and measured properties. Check mode re-hashes everything on
// disk and names the first thing that moved; --rerender re-runs
// assemble from the recorded manifest (force, so no approval is
// needed — the receipt IS the approval record) and compares the new
// receipt against the old one. On this machine renders are
// byte-identical (measured turn 63: two renders of the same film,
// same sha256), so the output-bytes comparison is real; across
// machines only the measured properties are comparable (a different
// ffmpeg build or encoder gives different bytes — leclap's own caveat).
// One honest limit: rerender reuses the content-addressed shot cache
// (each cached segment is verified by size + sha256 on read), so it
// proves join/audio/mux determinism + cache integrity, not a fresh
// build of every shot — delete .mediakit-assemble-cache first to
// force fresh shot builds.

const VERIFY_TOLERANCE = { duration_seconds: 0.05, lufs: 0.5 };

async function verifyFileExists(p) {
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// One comparison item: {name, status, expected?, actual?, path?,
// detail?}. Status matched/changed/missing/unknown. "absent" inputs
// (music null on both sides) report matched with actual null.
function verifyItem(name, expected, actual, { path: p = null, detail = null } = {}) {
  if (expected === undefined || expected === null) {
    if (actual === undefined || actual === null) return { name, status: "matched", expected: null, actual: null, ...(p ? { path: p } : {}) };
    return { name, status: "changed", expected: null, actual, ...(p ? { path: p } : {}), ...(detail ? { detail } : {}) };
  }
  if (actual === undefined || actual === null) return { name, status: "changed", expected, actual: null, ...(p ? { path: p } : {}), ...(detail ? { detail } : {}) };
  if (expected === actual) return { name, status: "matched", expected, actual, ...(p ? { path: p } : {}) };
  return { name, status: "changed", expected, actual, ...(p ? { path: p } : {}), ...(detail ? { detail } : {}) };
}

async function verifyOutputFile(outPath, finalRec) {
  const items = [];
  if (!(await verifyFileExists(outPath))) {
    items.push({ name: "output", status: "missing", path: outPath, detail: "the rendered file is gone" });
    return items;
  }
  const sha = await hashFile(outPath);
  items.push(verifyItem("output_bytes", finalRec.sha256, sha, { path: outPath }));
  const meta = await probe(outPath);
  if (finalRec.duration_seconds !== null && finalRec.duration_seconds !== undefined) {
    const actual = meta.duration_seconds;
    items.push(actual !== null && Math.abs(actual - finalRec.duration_seconds) <= VERIFY_TOLERANCE.duration_seconds
      ? { name: "duration_seconds", status: "matched", expected: finalRec.duration_seconds, actual }
      : { name: "duration_seconds", status: "changed", expected: finalRec.duration_seconds, actual });
  }
  if (finalRec.dimensions) {
    const actual = meta.video ? `${meta.video.width}x${meta.video.height}` : null;
    items.push(verifyItem("dimensions", finalRec.dimensions, actual));
  }
  if (finalRec.frames !== null && finalRec.frames !== undefined) {
    const actual = await countVideoFrames(outPath);
    items.push(verifyItem("frames", finalRec.frames, actual));
  }
  if (finalRec.loudness_lufs !== null && finalRec.loudness_lufs !== undefined) {
    const actual = meta.audio ? await measureLoudness(outPath) : null;
    items.push(actual !== null && Math.abs(actual - finalRec.loudness_lufs) <= VERIFY_TOLERANCE.lufs
      ? { name: "loudness_lufs", status: "matched", expected: finalRec.loudness_lufs, actual }
      : { name: "loudness_lufs", status: "changed", expected: finalRec.loudness_lufs, actual });
  }
  return items;
}

// Diff two fingerprint_parts objects into per-input items, in the
// fixed order the report uses (manifest first, so the first
// difference is the most upstream cause). `paths` is the receipt's
// recorded inputs map, used only to name files.
function verifyPartsDiff(oldParts, newParts, paths) {
  const items = [];
  const shotPaths = paths?.shots ?? {};
  const shotLabel = (id) => {
    const s = shotPaths[id];
    if (!s) return id;
    return s.source ?? s.scene ?? (s.color ? `color ${s.color}` : id);
  };
  items.push(verifyItem("manifest", oldParts?.manifest, newParts?.manifest, { path: paths?.manifest ?? null }));
  items.push(verifyItem("brand", oldParts?.brand ?? null, newParts?.brand ?? null, { path: paths?.manifest ?? null }));
  items.push(verifyItem("voice", oldParts?.voice, newParts?.voice, { path: paths?.voice ?? null }));
  items.push(verifyItem("music", oldParts?.music ?? null, newParts?.music ?? null, { path: paths?.music ?? null }));
  items.push(verifyItem("captions", oldParts?.captions ?? null, newParts?.captions ?? null, { path: paths?.captions ?? null }));
  const oldSfx = oldParts?.sfx ?? [];
  const newSfx = newParts?.sfx ?? [];
  const sfxPaths = paths?.sfx ?? [];
  for (let i = 0; i < Math.max(oldSfx.length, newSfx.length); i++) {
    items.push(verifyItem(`sfx[${i}]`, oldSfx[i] ?? null, newSfx[i] ?? null, { path: sfxPaths[i] ?? null }));
  }
  const oldAssets = oldParts?.assets ?? {};
  const newAssets = newParts?.assets ?? {};
  for (const id of Object.keys({ ...oldAssets, ...newAssets }).sort()) {
    items.push(verifyItem(`asset:${id}`, oldAssets[id] ?? null, newAssets[id] ?? null, { path: shotLabel(id) }));
  }
  return items;
}

export async function verifyRender({ receipt, rerender = false, outputDir = null }) {
  const receiptAbs = await requireInput(receipt, "receipt");
  let rec;
  try {
    rec = JSON.parse(await readFile(receiptAbs, "utf8"));
  } catch (e) {
    throw new MediaKitError(`verify needs a readable assemble receipt JSON, got: ${e.message}`, "INVALID_ARG");
  }
  if (!rec || typeof rec !== "object" || rec.operation !== "assemble" || typeof rec.manifest !== "string" || typeof rec.output !== "string" || !rec.final || typeof rec.final.sha256 !== "string" || typeof rec.fingerprint !== "string") {
    throw new MediaKitError("verify needs an assemble render receipt (assemble-receipt.json from a full render) — this file is missing manifest/output/final.sha256/fingerprint", "INVALID_ARG");
  }
  const receiptDir = path.dirname(receiptAbs);

  // Fresh fingerprint parts from the manifest as it stands on disk
  // now. A missing input is reported by name from the receipt's
  // recorded paths instead of failing the whole verify with a bare
  // INPUT_NOT_FOUND — the point of verify is to SAY what moved.
  let freshParts = null;
  let freshFingerprint = null;
  let manifestError = null;
  const missingInputs = [];
  const recordedInputs = rec.inputs ?? null;
  if (recordedInputs) {
    const checkPaths = [
      ["manifest", recordedInputs.manifest],
      ["voice", recordedInputs.voice],
      ["music", recordedInputs.music],
      ["captions", recordedInputs.captions],
      ...(Array.isArray(recordedInputs.sfx) ? recordedInputs.sfx.map((p, i) => [`sfx[${i}]`, p]) : []),
      ...Object.entries(recordedInputs.shots ?? {}).flatMap(([id, s]) => [
        [`asset:${id}`, s.source ?? null],
        [`asset:${id}`, s.scene ?? null],
        ...Object.entries(s.assets ?? {}).map(([n, p]) => [`asset:${id}:${n}`, p]),
      ]),
    ];
    for (const [name, p] of checkPaths) {
      if (p && !(await verifyFileExists(p))) missingInputs.push({ name, path: p });
    }
  }
  if (missingInputs.some((m) => m.name === "manifest")) {
    manifestError = "manifest file is missing";
  } else {
    try {
      const raw = await readFile(rec.manifest, "utf8");
      const doc = JSON.parse(raw);
      const plan = await validateAssembleManifest(doc, path.resolve(rec.manifest));
      freshParts = plan.fingerprint_parts;
      freshFingerprint = plan.fingerprint;
    } catch (e) {
      manifestError = e instanceof MediaKitError ? e.message : `cannot re-validate manifest: ${e.message}`;
    }
  }

  const mode = rerender ? "rerender" : "check";
  let items = [];
  let rerenderReceipt = null;
  let rerenderRemoved = false;
  if (!rerender) {
    // Check mode: inputs vs the receipt's recorded digests, then the
    // output file vs the recorded bytes + measurements.
    if (rec.fingerprint_parts && freshParts) {
      items = verifyPartsDiff(rec.fingerprint_parts, freshParts, recordedInputs);
    } else if (freshFingerprint !== null) {
      items = [verifyItem("fingerprint", rec.fingerprint, freshFingerprint, { path: rec.manifest, ...(manifestError ? { detail: manifestError } : {}) })];
    } else if (manifestError && !missingInputs.some((m) => m.name === "manifest")) {
      // The manifest file is there but no longer validates (edited
      // into an invalid film, or an input it needs is unreadable):
      // that is a manifest change, not an unknown fingerprint.
      items = [{ name: "manifest", status: "changed", path: rec.manifest, detail: manifestError }];
    } else if (missingInputs.some((m) => m.name === "manifest")) {
      // The manifest itself is gone: name it first, so the first
      // difference is the missing manifest, not the fingerprint that
      // could not be recomputed without it.
      items = [{ name: "manifest", status: "missing", path: rec.manifest, detail: "manifest file is missing" }];
    } else {
      items = [{ name: "fingerprint", status: "unknown", path: rec.manifest, detail: manifestError ?? "manifest could not be re-validated" }];
    }
    for (const m of missingInputs) {
      const it = items.find((x) => x.name === m.name);
      if (it) { it.status = "missing"; it.path = m.path; }
      else items.push({ name: m.name, status: "missing", path: m.path });
    }
    items.push(...await verifyOutputFile(rec.output, rec.final));
  } else {
    // Rerender mode: render the recorded manifest again (force — the
    // receipt is the approval record) and compare receipts.
    const outDirAbs = outputDir
      ? await prepareOutputDir(outputDir)
      : await prepareOutputDir(path.join(receiptDir, `.mediakit-verify-rerender-${process.pid}`));
    try {
      rerenderReceipt = await assemble({ manifestPath: rec.manifest, mode: "render", outputDir: outDirAbs, force: true });
    } catch (e) {
      throw new MediaKitError(`verify rerender failed: ${e.message}`, e.code ?? "VERIFY_RERENDER_FAILED");
    }
    if (rec.fingerprint_parts && rerenderReceipt.fingerprint_parts) {
      items = verifyPartsDiff(rec.fingerprint_parts, rerenderReceipt.fingerprint_parts, recordedInputs);
    } else {
      items = [verifyItem("fingerprint", rec.fingerprint, rerenderReceipt.fingerprint)];
    }
    for (const m of missingInputs) {
      const it = items.find((x) => x.name === m.name);
      if (it) { it.status = "missing"; it.path = m.path; }
    }
    items.push(...await verifyOutputFile(rerenderReceipt.output, rec.final));
    // The rerendered file itself is also checked against the OLD
    // receipt's output bytes — that is the byte-reproducibility proof.
    // (verifyOutputFile above already compared the rerendered file's
    // bytes + measurements against the old receipt.)
    if (!outputDir) {
      try { await rm(outDirAbs, { recursive: true, force: true }); rerenderRemoved = true; } catch { /* best-effort */ }
    }
  }

  const bad = items.filter((i) => i.status !== "matched");
  const firstDifference = bad.length ? bad[0].name : null;
  const verdict = bad.length ? "fail" : "pass";
  return {
    operation: "verify",
    mode,
    receipt: receiptAbs,
    manifest: rec.manifest,
    output: rec.output,
    verdict,
    ...(rerender ? {
      rerender_output: rerenderReceipt?.output ?? null,
      rerender_removed: rerenderRemoved,
      rerender_fingerprint: rerenderReceipt?.fingerprint ?? null,
      note: "Rerender reuses the content-addressed shot cache (segments verified by size + sha256 on read), so it proves join/audio/mux determinism + cache integrity. Delete .mediakit-assemble-cache next to the manifest to force fresh shot builds.",
    } : {}),
    ...(manifestError && mode === "check" ? { manifest_error: manifestError } : {}),
    mediakit_version: MEDIAKIT_VERSION,
    ffmpeg_version: rec.ffmpeg_version ?? null,
    first_difference: firstDifference,
    changed: bad.length,
    total: items.length,
    items,
    summary: verdict === "pass"
      ? (mode === "rerender" ? "Rerender is byte-identical and all inputs match the receipt — the render reproduces." : "All inputs and the output match the receipt — nothing moved.")
      : `${bad.length} of ${items.length} checks differ, first: ${firstDifference}.`,
  };
}

// ---------------------------------------------------------------- diagnose
// Director preflight for a film manifest (heristop/leclap's `diagnose`
// idea, turn 64): validate is the FORMAT gate — it throws on the
// first hard error and says nothing about quality. Diagnose is the
// JUDGEMENT gate — it runs validate, then measures what validate
// cannot: real motion inside each video shot's exact window, source
// geometry vs the film frame (upscale / fps), the visual seam across
// each transition, caption coverage, music loops, sfx tails, chapter
// alignment and text-layer collisions. Probe-only: nothing is
// written except temp files under os.tmpdir, removed afterwards.
// A broken manifest is a FINDING, not a crash — validate errors
// come back as verdict "fail" with format_error, so an agent can
// fix the manifest and re-run diagnose in a loop.
function diagnoseShotBoundaryFrame(shot, atEnd, fps) {
  // The frame the viewer actually sees at the boundary: for a video
  // shot the last displayed frame (start + duration − 1 frame) or
  // the first displayed frame (start); for an image shot the image
  // itself. Returns { file, at } — file is a path ffmpeg can read
  // (the image directly, or a temp PNG for a video frame).
  if (shot.kind === "image") return { file: shot.source, at: null };
  const t = atEnd ? shot.start + shot.duration - 1 / fps : shot.start;
  return { file: null, at: +Math.max(0, t).toFixed(3) };
}

async function diagnoseExtractFrame(source, t, outPng) {
  await run(FFMPEG, ["-hide_banner", "-nostats", "-ss", String(t), "-i", source, "-frames:v", "1", "-y", outPng]);
}

async function diagnoseFrameMeanDiff(aPng, bPng) {
  // Mean absolute luma difference between two frames, 0-255.
  // blend difference on RGB, then gray + signalstats YAVG — the
  // same measurement motion uses for a frame step, so a seam score
  // reads on the same scale as a normal frame step (testsrc step
  // ~8, a red/blue cut ~47).
  const { stderr } = await run(FFMPEG, [
    "-hide_banner", "-nostats", "-i", aPng, "-i", bPng,
    "-filter_complex", "[0:v][1:v]blend=all_mode=difference,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f", "null", "-",
  ]);
  const m = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
  if (!m) return null;
  return +(+m[1]).toFixed(2);
}

export async function diagnoseFilm({ manifestPath }) {
  const manifestAbs = await requireInput(manifestPath, "film manifest");
  let doc;
  try {
    doc = JSON.parse(await readFile(manifestAbs, "utf8"));
  } catch (e) {
    return {
      manifest: manifestAbs, verdict: "fail", format_error: `manifest is not valid JSON: ${e.message}`,
      errors: 1, warnings: 0, first_issue: "manifest is not valid JSON",
      checks: [{ id: "format", severity: "error", message: `manifest is not valid JSON: ${e.message}` }],
      summary: "The manifest is not valid JSON — fix it and re-run diagnose.",
    };
  }
  let plan;
  try {
    plan = await validateAssembleManifest(doc, manifestAbs);
  } catch (e) {
    const msg = e instanceof MediaKitError ? e.message : `cannot validate manifest: ${e.message}`;
    return {
      manifest: manifestAbs, verdict: "fail", format_error: msg,
      errors: 1, warnings: 0, first_issue: msg,
      checks: [{ id: "format", severity: "error", message: msg }],
      summary: "The manifest fails validation — fix the format error and re-run diagnose.",
    };
  }
  const checks = [];
  const add = (id, severity, message, extra = {}) => checks.push({ id, severity, message, ...extra });
  const built = deriveAssembleHandles(plan.shots, plan.fps);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediakit-diagnose-"));
  try {
    add("timeline", "info",
      `${plan.shots.length} shots cover ${plan.total_seconds}s (${plan.total_frames} frames @${plan.fps}fps, ${plan.width}x${plan.height}) on a voice of ${plan.voice.duration_seconds}s + ${plan.voice.lead}s lead + ${plan.voice.tail}s tail`,
      { total_seconds: plan.total_seconds, total_frames: plan.total_frames, shots: plan.shots.length });

    // Voice loudness: the master clock should sit in a range the
    // -14 LUFS master can reach without strain. A whisper-quiet
    // voice forces a big gain (noise + pumping); a hot one clips.
    const voiceFull = await measureLoudnessFull(plan.voice.path);
    if (voiceFull === null) {
      add("voice_loudness", "error", "could not measure the voice loudness (loudnorm returned nothing)");
    } else if (voiceFull.i < -30) {
      add("voice_loudness", "warn", `voice is very quiet (${voiceFull.i} LUFS, true peak ${voiceFull.tp} dBTP) — the -14 LUFS master will push it hard; gain the voice up or re-record before rendering`, { lufs: voiceFull.i, true_peak_db: voiceFull.tp });
    } else if (voiceFull.i > -8) {
      add("voice_loudness", "warn", `voice is hot (${voiceFull.i} LUFS, true peak ${voiceFull.tp} dBTP) — peaks may clip in the -14 LUFS master; turn it down first`, { lufs: voiceFull.i, true_peak_db: voiceFull.tp });
    } else {
      add("voice_loudness", "pass", `voice measures ${voiceFull.i} LUFS (true peak ${voiceFull.tp} dBTP, LRA ${voiceFull.lra} LU) — the master can reach -14 LUFS cleanly`, { lufs: voiceFull.i, true_peak_db: voiceFull.tp, lra: voiceFull.lra });
    }

    // Per-shot motion + geometry, measured on the exact source
    // window the render will use (handles included).
    for (const s of built) {
      if (s.kind === "video") {
        const meta = await probe(s.source);
        const upscale = Math.max(plan.width / meta.video.width, plan.height / meta.video.height);
        if (upscale > 2) {
          add(`shot_geometry:${s.id}`, "warn", `shot ${s.id} upscales ${upscale.toFixed(2)}x (${meta.video.width}x${meta.video.height} → ${plan.width}x${plan.height}) — the render will soften; use a higher-resolution source or a smaller frame`, { upscale: +upscale.toFixed(2), source_width: meta.video.width, source_height: meta.video.height });
        } else if (meta.video.fps !== null && meta.video.fps < plan.fps) {
          add(`shot_geometry:${s.id}`, "warn", `shot ${s.id} is ${meta.video.fps}fps in a ${plan.fps}fps film — frames will duplicate; use a ${plan.fps}fps source or drop the film fps`, { source_fps: meta.video.fps, film_fps: plan.fps });
        } else {
          add(`shot_geometry:${s.id}`, "pass", `shot ${s.id} geometry is clean (${meta.video.width}x${meta.video.height} @${meta.video.fps}fps, upscale ${upscale.toFixed(2)}x)`, { upscale: +upscale.toFixed(2), source_fps: meta.video.fps });
        }
        const winPath = path.join(tmpDir, `motion-${s.id}.mp4`);
        await run(FFMPEG, ["-hide_banner", "-nostats", "-ss", String(s.buildStart), "-i", s.source, "-t", String(s.buildSeconds), "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", "-y", winPath]);
        const m = await measureMotion({ input: winPath, threshold: 0.001, minStillSeconds: 2, windowSeconds: 1 });
        const meanMotion = m.motion_curve.length ? +(m.motion_curve.reduce((a, w) => a + w.motion_fraction, 0) / m.motion_curve.length).toFixed(5) : 0;
        if (m.verdict === "static") {
          add(`shot_motion:${s.id}`, "error", `shot ${s.id} is a frozen video (motion ${meanMotion} over ${s.buildSeconds}s) — use an image shot or pick a moving clip`, { mean_motion: meanMotion, motion_verdict: m.verdict });
        } else if (m.verdict === "mostly-static") {
          add(`shot_motion:${s.id}`, "warn", `shot ${s.id} is mostly static (motion ${meanMotion} over ${s.buildSeconds}s) — check the clip really moves where it matters`, { mean_motion: meanMotion, motion_verdict: m.verdict });
        } else {
          add(`shot_motion:${s.id}`, "pass", `shot ${s.id} moves (mean motion ${meanMotion} over ${s.buildSeconds}s)`, { mean_motion: meanMotion, motion_verdict: m.verdict });
        }
      } else if (s.kind === "image") {
        const meta = await probe(s.source);
        const upscale = Math.max(plan.width / meta.video.width, plan.height / meta.video.height);
        if (upscale > 2) {
          add(`shot_geometry:${s.id}`, "warn", `shot ${s.id} upscales ${upscale.toFixed(2)}x (${meta.video.width}x${meta.video.height} → ${plan.width}x${plan.height}) — the render will soften; use a higher-resolution source or a smaller frame`, { upscale: +upscale.toFixed(2), source_width: meta.video.width, source_height: meta.video.height });
        } else {
          add(`shot_geometry:${s.id}`, "pass", `shot ${s.id} geometry is clean (${meta.video.width}x${meta.video.height}, upscale ${upscale.toFixed(2)}x)`, { upscale: +upscale.toFixed(2) });
        }
      }
    }

    // Transition seams: the frames on either side of each join.
    // A fade between near-identical frames adds nothing (a cut
    // would do); a huge jump means the fade is doing real work.
    // Only video/image neighbours have a single readable frame —
    // canvas_scene and color shots are skipped, not guessed at.
    for (let i = 1; i < built.length; i++) {
      const prev = built[i - 1];
      const next = built[i];
      if (!next.transition) continue;
      if (!["video", "image"].includes(prev.kind) || !["video", "image"].includes(next.kind)) continue;
      const prevSide = diagnoseShotBoundaryFrame(prev, true, plan.fps);
      const nextSide = diagnoseShotBoundaryFrame(next, false, plan.fps);
      const prevPng = prevSide.file ?? path.join(tmpDir, `seam-${next.id}-prev.png`);
      const nextPng = nextSide.file ?? path.join(tmpDir, `seam-${next.id}-next.png`);
      if (!prevSide.file) await diagnoseExtractFrame(prev.source, prevSide.at, prevPng);
      if (!nextSide.file) await diagnoseExtractFrame(next.source, nextSide.at, nextPng);
      const seam = await diagnoseFrameMeanDiff(prevPng, nextPng);
      if (seam === null) {
        add(`transition_seam:${next.id}`, "warn", `transition into shot ${next.id} (${next.transition.type} ${next.transition.duration_seconds}s): could not measure the seam frames`);
      } else if (seam < 2) {
        add(`transition_seam:${next.id}`, "warn", `transition into shot ${next.id} joins near-identical frames (seam ${seam}) — a plain cut would do; the ${next.transition.type} adds nothing`, { seam });
      } else if (seam > 200) {
        add(`transition_seam:${next.id}`, "info", `transition into shot ${next.id} crosses a hard visual jump (seam ${seam}) — the ${next.transition.type} is doing real work`, { seam });
      } else {
        add(`transition_seam:${next.id}`, "pass", `transition into shot ${next.id} has a real but gentle seam (${seam})`, { seam });
      }
    }

    // Captions: how much of the film actually has words on screen,
    // and whether any silence between cues swallows a whole beat.
    if (plan.captions) {
      const capExt = path.extname(plan.captions.path).toLowerCase();
      if (capExt === ".ass") {
        add("captions_coverage", "info", `captions are .ass (${plan.captions.cue_count ?? "unknown"} cues) — coverage is not measured for styled captions`);
      } else {
        const { cues } = parseCaptions(await readFile(plan.captions.path, "utf8"), capExt.slice(1));
        const covered = cues.reduce((a, c) => a + (c.endMs - c.startMs) / 1000, 0);
        const coverage = plan.total_seconds > 0 ? +(covered / plan.total_seconds).toFixed(2) : 0;
        let largestGap = 0;
        for (let j = 1; j < cues.length; j++) largestGap = Math.max(largestGap, (cues[j].startMs - cues[j - 1].endMs) / 1000);
        if (coverage < 0.5) {
          add("captions_coverage", "warn", `captions cover only ${Math.round(coverage * 100)}% of the film (${cues.length} cues, ${covered.toFixed(1)}s of ${plan.total_seconds}s) — half the film has no words on screen`, { coverage, cue_count: cues.length });
        } else if (largestGap > 3) {
          add("captions_coverage", "warn", `captions cover ${Math.round(coverage * 100)}% of the film but leave a ${largestGap.toFixed(1)}s gap with no words — check the voice really pauses there`, { coverage, cue_count: cues.length, largest_gap_seconds: +largestGap.toFixed(2) });
        } else {
          add("captions_coverage", "pass", `captions cover ${Math.round(coverage * 100)}% of the film (${cues.length} cues, largest gap ${largestGap.toFixed(1)}s)`, { coverage, cue_count: cues.length, largest_gap_seconds: +largestGap.toFixed(2) });
        }
      }
    }

    // Music: a bed shorter than the film loops; too many loops and
    // the listener hears the seam.
    if (plan.music) {
      const musicMeta = await probe(plan.music.path);
      const musicDur = musicMeta.duration_seconds;
      if (musicDur === null) {
        add("music_loop", "warn", "could not measure the music duration — the loop count is unknown");
      } else {
        const loops = Math.ceil(plan.total_seconds / musicDur);
        if (loops > 3) {
          add("music_loop", "warn", `music (${musicDur}s) loops ${loops}x over the ${plan.total_seconds}s film — the loop seam will be audible; use a longer bed`, { loops, music_seconds: musicDur });
        } else {
          add("music_loop", "pass", `music (${musicDur}s) covers the film in ${loops} loop${loops === 1 ? "" : "s"}`, { loops, music_seconds: musicDur });
        }
      }
    }

    // SFX: a tail that runs past the film end is clipped, silently.
    if (plan.sfx.length) {
      const clipped = [];
      for (const s of plan.sfx) {
        const meta = await probe(s.file);
        const dur = meta.duration_seconds;
        if (dur !== null && s.at_seconds + dur > plan.total_seconds + 0.05) {
          clipped.push(`${path.basename(s.file)} at ${s.at_seconds}s runs ${(s.at_seconds + dur - plan.total_seconds).toFixed(2)}s past the film end`);
        }
      }
      if (clipped.length) {
        add("sfx_tail", "warn", `sfx tail is clipped: ${clipped.join("; ")}`, { clipped: clipped.length });
      } else {
        add("sfx_tail", "pass", `${plan.sfx.length} sfx entr${plan.sfx.length === 1 ? "y" : "ies"} all end inside the film`);
      }
    }

    // Chapters should land on cuts: a chapter that starts mid-shot
    // drops the viewer into the middle of a thought.
    if (plan.chapters.length) {
      const boundaries = [0];
      let acc = 0;
      for (const s of plan.shots) { acc += s.duration; boundaries.push(+acc.toFixed(3)); }
      let worst = null;
      for (const c of plan.chapters) {
        const dist = Math.min(...boundaries.map((b) => Math.abs(b - c.at_seconds)));
        if (!worst || dist > worst.dist) worst = { chapter: c, dist };
      }
      if (worst.dist > 1) {
        add("chapters_alignment", "warn", `chapter "${worst.chapter.title}" at ${worst.chapter.at_seconds}s lands ${worst.dist.toFixed(2)}s from the nearest cut — it starts mid-shot; move it to a shot boundary`, { worst_distance_seconds: +worst.dist.toFixed(2) });
      } else {
        add("chapters_alignment", "pass", `${plan.chapters.length} chapters all land within 1s of a cut (worst ${worst.dist.toFixed(2)}s)`, { worst_distance_seconds: +worst.dist.toFixed(2) });
      }
    }

    // Text layers: a block taller than 4 wrapped lines crowds the
    // frame, and a bottom layer sits exactly where the burned
    // captions live (~500px from the bottom — the bounce floor was
    // moved to 0.62H for the same reason).
    const textIssues = [];
    for (const s of plan.shots) {
      for (const [j, layer] of (s.textLayers ?? []).entries()) {
        if (layer.lines.length > 4) textIssues.push(`shot ${s.id} text[${j}] wraps to ${layer.lines.length} lines — shorten the copy or shrink the size`);
        if (layer.position === "bottom" && plan.captions) textIssues.push(`shot ${s.id} text[${j}] sits at the bottom, in the burned-caption band — move it to top or center`);
      }
    }
    if (textIssues.length) {
      for (const msg of textIssues) add("text_layer", "warn", msg);
    } else if (plan.shots.some((s) => (s.textLayers ?? []).length)) {
      add("text_layer", "pass", "text layers fit: no tall blocks, none in the caption band");
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  const errors = checks.filter((c) => c.severity === "error").length;
  const warnings = checks.filter((c) => c.severity === "warn").length;
  const verdict = errors ? "fail" : warnings ? "warn" : "pass";
  const firstIssue = checks.find((c) => c.severity === "error" || c.severity === "warn")?.message ?? null;
  return {
    manifest: manifestAbs,
    title: plan.title,
    verdict,
    total_seconds: plan.total_seconds,
    total_frames: plan.total_frames,
    fps: plan.fps,
    dimensions: `${plan.width}x${plan.height}`,
    shots: plan.shots.length,
    errors,
    warnings,
    first_issue: firstIssue,
    checks,
    summary: verdict === "pass"
      ? "Preflight clean — the film should render as written."
      : verdict === "warn"
        ? `${warnings} warning${warnings === 1 ? "" : "s"} to look at before rendering; first: ${firstIssue}`
        : `${errors} error${errors === 1 ? "" : "s"} — fix before rendering; first: ${firstIssue}`,
  };
}

// ---------------------------------------------------------------- render jobs
// Durable async render jobs (idea: AH64-dll/OpenEdit's trigger_render /
// get_render_job / cancel_render_job): a long assemble render runs in a
// detached worker process, so the MCP call returns in milliseconds with
// a job_id and the caller polls `job` for progress and the terminal
// result. The job record is the source of truth — a running job carries
// its live pid, a finished job its receipt summary or its error. Jobs
// live under MEDIAKIT_JOBS_DIR, else <MEDIAKIT_WORKDIR or cwd>/
// .mediakit-jobs. The id is validated on every read so no job path can
// escape the jobs root, and the worker is its own process group, so
// cancelling kills the ffmpeg children too — not just the wrapper.
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const JOB_TERMINAL = new Set(["done", "failed", "cancelled"]);

export function jobsRoot() {
  const env = process.env.MEDIAKIT_JOBS_DIR;
  if (env?.trim()) return path.resolve(env.trim());
  const base = process.env.MEDIAKIT_WORKDIR?.trim() ? path.resolve(process.env.MEDIAKIT_WORKDIR.trim()) : process.cwd();
  return path.join(base, ".mediakit-jobs");
}

function newJobId() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  return `job-${stamp}-${createHash("sha256").update(`${process.pid}-${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8)}`;
}

function jobRecordPath(root, id) {
  if (!JOB_ID_RE.test(id)) throw new MediaKitError(`invalid job id: ${id}`, "INVALID_ARG");
  return path.join(root, id, "job.json");
}

// Serialized job-record writes: progress callbacks fire without await,
// so two writes could otherwise read the same stale record and the
// second would clobber the first. One promise chain per process keeps
// every read-modify-write in order.
let jobWriteChain = Promise.resolve();
function queueJobWrite(fn) {
  jobWriteChain = jobWriteChain.then(fn, fn);
  return jobWriteChain;
}

async function writeJobRecord(root, record) {
  const dir = path.join(root, record.job_id);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.job.json.tmp-${process.pid}`);
  await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  await rename(tmp, path.join(dir, "job.json"));
}

async function readJobRecord(dir) {
  return JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"));
}

async function updateJobRecord(jobId, jobDir, patch) {
  // jobDir is supplied by the worker (it knows its own directory);
  // the id is still validated so a bad caller cannot address a path
  // outside the jobs root.
  if (!JOB_ID_RE.test(jobId)) throw new MediaKitError(`invalid job id: ${jobId}`, "INVALID_ARG");
  if (path.basename(path.resolve(jobDir)) !== jobId) throw new MediaKitError(`job directory does not match job id: ${jobDir}`, "INVALID_ARG");
  return queueJobWrite(async () => {
    let record;
    try {
      record = await readJobRecord(jobDir);
    } catch {
      return null;
    }
    // A cancelled job stays cancelled: the worker must not overwrite
    // the canceller's record with done/failed after the kill.
    if (JOB_TERMINAL.has(record.status) && record.status === "cancelled") return record;
    const next = { ...record, ...patch, updated_at: new Date().toISOString() };
    // Progress history: every distinct (stage, percent) the worker
    // reports is appended, so a caller can prove the percent moved
    // INSIDE a stage without depending on poll timing. Turn 92's CI
    // failed exactly on that: the poll loop only ever saw [0, 17,
    // 100] because the whole 4s render finished between two 2s
    // polls — the worker HAD emitted in-stage values, but no poll
    // landed on one. The history is written by the worker itself, so
    // it survives any poll cadence. Capped at 1000 entries (a render
    // emits at most ~4/s through the 250 ms throttle); only a change
    // is recorded, so a stalled stage does not spam the file.
    if (patch.progress && typeof patch.progress.percent === "number") {
      const history = Array.isArray(record.progress_history) ? [...record.progress_history] : [];
      const last = history[history.length - 1];
      if (!last || last.stage !== patch.progress.stage || last.percent !== patch.progress.percent) {
        history.push({ at: next.updated_at, stage: patch.progress.stage ?? null, percent: patch.progress.percent });
        next.progress_history = history.slice(-1000);
      } else {
        next.progress_history = history;
      }
    }
    await writeJobRecord(path.dirname(jobDir), next);
    return next;
  });
}

async function markJobRunning(jobId, jobDir, pid) {
  try {
    return await updateJobRecord(jobId, jobDir, { status: "running", pid, progress: { stage: "shots", percent: 0, detail: null } });
  } catch { /* a job-record write must never fail the render itself */ return null; }
}

async function finishJob(jobId, jobDir, result) {
  try {
    await updateJobRecord(jobId, jobDir, { status: "done", result, progress: { stage: "done", percent: 100, detail: null } });
  } catch { /* best-effort: the receipt file on disk is the backup */ }
}

async function failJob(jobId, jobDir, err) {
  try {
    await updateJobRecord(jobId, jobDir, { status: "failed", error: { message: err?.message ?? String(err), code: err?.code ?? "ERROR" } });
  } catch { /* best-effort: the thrown error still reaches the caller */ }
}

export async function updateJobProgress(jobId, jobDir, progress) {
  // Called by the CLI worker's onProgress (fire-and-forget): the
  // write chain serializes it, and a failure here is swallowed so a
  // progress write can never break the render.
  try {
    await updateJobRecord(jobId, jobDir, { progress: { stage: progress.stage ?? null, percent: progress.percent ?? 0, detail: progress.detail ?? null } });
  } catch { /* progress is advisory */ }
}

// ---------------------------------------------------------------- job admission
// Admission cap for async renders (MADPANDA3D/FFMPEG-MCP media_limits
// idea + EncodeX MAX_BATCH_FILES, lượt 97-98: decoded-work got a
// ceiling in lượt 98, but nothing stopped N renders from starting at
// once — each spawns its own ffmpeg and they OOM/starve each other on
// a small machine). Two durable limits, counted from the job store on
// disk (so every process — stdio, HTTP, CLI — sees the same numbers):
// at most N jobs queued-or-running, and at most M job starts in the
// last 60 seconds. Defaults: 2 active / 10 starts per minute (this
// box has 1.5 shared CPUs; 2 concurrent renders already saturate it).
// Env overrides MEDIAKIT_MAX_JOBS (1–8) /
// MEDIAKIT_MAX_JOB_STARTS_PER_MINUTE (1–60), read on every check so a
// restart is not needed to retune. A refused start creates NO job
// record and spawns NO worker — the caller gets JOB_ADMISSION_LIMIT
// (HTTP 429) with the retry delay in the message.
function jobAdmissionEnvInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function jobAdmissionLimits() {
  return {
    max_active_jobs: jobAdmissionEnvInt("MEDIAKIT_MAX_JOBS", 2, 1, 8),
    max_starts_per_minute: jobAdmissionEnvInt("MEDIAKIT_MAX_JOB_STARTS_PER_MINUTE", 10, 1, 60),
  };
}

export async function getJobAdmission() {
  const limits = jobAdmissionLimits();
  const { jobs } = await listJobs({ limit: 200 });
  const now = Date.now();
  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const recentStarts = jobs.filter((j) => {
    const t = Date.parse(j.created_at ?? "");
    return Number.isFinite(t) && now - t < 60_000;
  });
  const startsLastMinute = recentStarts.length;
  let admitted = true;
  let reason = null;
  let retryAfterSeconds = null;
  if (activeJobs >= limits.max_active_jobs) {
    admitted = false;
    reason = `too many active render jobs: ${activeJobs} already queued or running (max ${limits.max_active_jobs})`;
    retryAfterSeconds = 30;
  } else if (startsLastMinute >= limits.max_starts_per_minute) {
    admitted = false;
    const oldest = Math.min(...recentStarts.map((j) => Date.parse(j.created_at)));
    retryAfterSeconds = Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000));
    reason = `too many job starts: ${startsLastMinute} in the last minute (max ${limits.max_starts_per_minute})`;
  }
  return {
    admitted,
    active_jobs: activeJobs,
    starts_last_minute: startsLastMinute,
    limits: { ...limits },
    reason,
    retry_after_seconds: retryAfterSeconds,
  };
}

export async function checkJobAdmission() {
  const a = await getJobAdmission();
  if (a.admitted) return a;
  throw new MediaKitError(`job admission limit: ${a.reason} — retry in ~${a.retry_after_seconds}s`, "JOB_ADMISSION_LIMIT");
}

export async function startAssembleJob({ manifestPath, outputDir, force = false }) {
  // Fail fast, before spawning anything: the manifest must validate
  // and the approval gate must pass — a job that is born dead hides
  // the real error behind a poll.
  const manifestAbs = await requireInput(manifestPath, "manifest");
  let raw;
  try {
    raw = await readFile(manifestAbs, "utf8");
  } catch (e) {
    throw new MediaKitError(`cannot read manifest ${manifestPath}: ${e.message}`, "INVALID_INPUT");
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new MediaKitError(`assemble manifest is not valid JSON: ${e.message}`, "INVALID_ARG");
  }
  const plan = await validateAssembleManifest(doc, manifestAbs);
  const approvalStatus = await requireAssembleApproval(plan, force);
  // Admission gate: refuse before creating a record or spawning a
  // worker, so a refused start leaves nothing behind to poll or cancel.
  await checkJobAdmission();
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new MediaKitError("assemble --mode render needs an output directory", "INVALID_ARG");
  }
  const outDirAbs = await prepareOutputDir(outputDir);
  const root = jobsRoot();
  const jobId = newJobId();
  const jobDir = path.join(root, jobId);
  await mkdir(jobDir, { recursive: true });
  const now = new Date().toISOString();
  const record = {
    job_id: jobId, operation: "assemble", status: "queued",
    manifest: manifestAbs, output_dir: outDirAbs, mode: "render", force: !!force,
    approval: approvalStatus, title: plan.title,
    total_seconds: plan.total_seconds, total_frames: plan.total_frames,
    pid: null, progress: { stage: null, percent: 0, detail: null }, progress_history: [],
    created_at: now, updated_at: now, result: null, error: null,
  };
  await writeJobRecord(root, record);
  const cliPath = fileURLToPath(new URL("../bin/mediakit.js", import.meta.url));
  // The worker's stdout/stderr go to worker.log. spawn needs a real
  // fd (a WriteStream is still opening when spawn runs — it threw
  // "The argument 'stdio' is invalid"), so open the file
  // synchronously and hand the fd over; the parent closes its own
  // copy right after spawn, the child's inherited fd stays valid.
  const { openSync, closeSync } = await import("node:fs");
  const logFd = openSync(path.join(jobDir, "worker.log"), "w");
  let child;
  try {
    child = spawn(process.execPath, [
      cliPath, "assemble", manifestAbs, "--mode", "render", "-o", outDirAbs,
      "--job-id", jobId, "--job-dir", jobDir, ...(force ? ["--force"] : []),
    ], { detached: true, stdio: ["ignore", logFd, logFd], env: process.env });
  } catch (e) {
    try { closeSync(logFd); } catch { /* already closed */ }
    await failJob(jobId, jobDir, e);
    throw e;
  }
  try { closeSync(logFd); } catch { /* already closed */ }
  child.unref();
  const started = { ...record, pid: child.pid ?? null };
  await writeJobRecord(root, started);
  return {
    job_id: jobId, status: "queued", operation: "assemble",
    jobs_root: root, manifest: manifestAbs, output_dir: outDirAbs,
    title: plan.title, total_seconds: plan.total_seconds, total_frames: plan.total_frames,
    approval: approvalStatus,
    hint: `poll with: mediakit job ${jobId}`,
  };
}

export async function getJob(jobId) {
  const root = jobsRoot();
  let raw;
  try {
    raw = await readFile(jobRecordPath(root, jobId), "utf8");
  } catch {
    throw new MediaKitError(`unknown job id: ${jobId} (jobs live under ${root})`, "JOB_NOT_FOUND");
  }
  return JSON.parse(raw);
}

export async function listJobs({ limit = 50 } = {}) {
  const root = jobsRoot();
  let names = [];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* no jobs dir yet — zero jobs, not an error */ }
  const jobs = [];
  for (const name of names.sort().reverse()) {
    if (!JOB_ID_RE.test(name)) continue;
    try {
      const rec = JSON.parse(await readFile(path.join(root, name, "job.json"), "utf8"));
      // List is a summary: the per-entry progress_history (up to
      // 1000 points) stays on the status view, not in every row.
      const { progress_history: _history, ...summary } = rec;
      jobs.push(summary);
    } catch { /* skip unreadable entries */ }
    if (jobs.length >= limit) break;
  }
  return { jobs_root: root, count: jobs.length, jobs };
}

export async function cancelJob(jobId) {
  const root = jobsRoot();
  const record = await getJob(jobId);
  if (JOB_TERMINAL.has(record.status)) {
    throw new MediaKitError(`job ${jobId} is already ${record.status} — nothing to cancel`, "INVALID_ARG");
  }
  if (record.pid) {
    // The worker is its own process group (detached spawn), so a
    // negative-pid kill takes the ffmpeg children with it. Fall back
    // to the bare pid when the group is already gone.
    try { process.kill(-record.pid, "SIGTERM"); } catch { try { process.kill(record.pid, "SIGTERM"); } catch { /* already gone */ } }
    // Give the worker a moment to die on its own; if it finished in
    // the meantime, its done/failed record stands and the cancel
    // does not overwrite it.
    await new Promise((r) => setTimeout(r, 300));
    const current = await getJob(jobId);
    if (JOB_TERMINAL.has(current.status)) return current;
  }
  const cancelled = { ...record, status: "cancelled", updated_at: new Date().toISOString(), error: { message: "cancelled by user", code: "JOB_CANCELLED" } };
  await writeJobRecord(root, cancelled);
  return cancelled;
}
