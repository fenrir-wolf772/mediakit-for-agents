/**
 * mediakit-for-agents — shared core.
 * Every operation runs ffmpeg/ffprobe through execFile with an argument
 * array. There is NO shell involved anywhere: user input can never be
 * interpreted as a shell command.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEDIAKIT_VERSION = "0.1.0";

export const FFMPEG = process.env.MEDIAKIT_FFMPEG || "ffmpeg";
export const FFPROBE = process.env.MEDIAKIT_FFPROBE || "ffprobe";

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

function runCapture(cmd, args, { timeoutMs = 300_000 } = {}) {
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

function run(cmd, args, { timeoutMs = 300_000 } = {}) {
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
  return abs;
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
      fps: video.r_frame_rate ? evalFps(video.r_frame_rate) : null,
      pixel_format: video.pix_fmt ?? null,
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

export async function trim({ input, output, start = 0, duration = null, end = null, streamCopy = false, snapToKeyframe = false }) {
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

  // snapToKeyframe only makes sense for stream copy: re-encode cuts are
  // already frame-accurate, and snapping them would only widen the clip.
  // Snapping moves start DOWN to the nearest keyframe at/before it and
  // end UP to the nearest keyframe at/after it, so the stream-copy cut
  // lands exactly on keyframes instead of ffmpeg's silent rounding.
  let sActual = s, durActual = dur, snapped = false, kfStart = null, kfEnd = null;
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

  // -ss after -i = accurate seek (re-encode path); with stream copy we
  // put -ss before -i for fast keyframe seek.
  const args = streamCopy
    ? ["-y", "-ss", String(sActual), "-i", inPath, "-t", String(durActual), "-c", "copy", outPath]
    : ["-y", "-i", inPath, "-ss", String(sActual), "-t", String(durActual), outPath];
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const meta = await probe(outPath);
  return {
    operation: "trim", input: inPath, output: outPath,
    start: sActual, duration_seconds: durActual, stream_copy: streamCopy,
    ...(snapToKeyframe ? {
      requested_start: s, requested_end: +(s + dur).toFixed(3),
      snapped, keyframe_start: kfStart, keyframe_end: kfEnd,
    } : {}),
    ...info, duration_actual: meta.duration_seconds,
  };
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
    if (meta.audio) args.push("-map", "[a]", "-c:a", audioCodec);
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
    if (meta.audio) args.push("-c:a", audioCodec);
    args.push(outPath);
  } else { // loop
    if (srcDur >= target) {
      throw new MediaKitError(`loop fit needs a shorter source (${srcDur}s >= target ${target}s) — use method=speed or method=trim`, "INVALID_ARG");
    }
    applied = { method: "loop", loops: Math.ceil(target / srcDur) };
    args = ["-y", "-stream_loop", "-1", "-i", inPath, "-t", String(target)];
    if (capFps) args.push("-vf", `fps=${capFps}`);
    if (meta.video) args.push("-c:v", "libx264", "-crf", "18", "-preset", "veryfast");
    if (meta.audio) args.push("-c:a", audioCodec);
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

export async function crop({ input, output, width, height, x = 0, y = 0 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const w = num(width, "width", { min: 2, integer: true });
  const h = num(height, "height", { min: 2, integer: true });
  const cx = num(x, "x", { min: 0, integer: true });
  const cy = num(y, "y", { min: 0, integer: true });
  const meta = await probe(inPath);
  if (meta.video && (cx + w > meta.video.width || cy + h > meta.video.height)) {
    throw new MediaKitError(`crop ${w}x${h}+${cx}+${cy} exceeds source ${meta.video.width}x${meta.video.height}`, "INVALID_ARG");
  }
  await run(FFMPEG, ["-y", "-i", inPath, "-vf", `crop=${w}:${h}:${cx}:${cy}`, "-c:a", "copy", outPath]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "crop", input: inPath, output: outPath, width: w, height: h, x: cx, y: cy, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
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

export async function resize({ input, output, width = null, height = null, keepAspect = true, preset = null }) {
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
    const srcW = meta.video.width, srcH = meta.video.height;
    // Fit inside the box, never upscale; round to even (x264 yuv420p).
    const factor = Math.min(boxW / srcW, boxH / srcH, 1);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const tw = even(srcW * factor), th = even(srcH * factor);
    await run(FFMPEG, ["-y", "-i", inPath, "-vf", `scale=${tw}:${th}`, "-c:a", "copy", outPath]);
    const info = await fileInfo(outPath);
    const out = await probe(outPath);
    return {
      operation: "resize", input: inPath, output: outPath, preset,
      preset_box: `${boxW}x${boxH}`, scaled_down: factor < 1,
      source_dimensions: `${srcW}x${srcH}`, ...info,
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
  await run(FFMPEG, ["-y", "-i", inPath, "-vf", scale, "-c:a", "copy", outPath]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "resize", input: inPath, output: outPath, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
}

// ---------------------------------------------------------------- extract_audio

const AUDIO_FORMATS = { mp3: "libmp3lame", aac: "aac", wav: "pcm_s16le", ogg: "libvorbis", opus: "libopus", flac: "flac" };

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
  args.push("-c:a", codec);
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

// ---------------------------------------------------------------- extract_frame

export async function extractFrame({ input, output, timestamp = 0 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const t = num(timestamp, "timestamp", { min: 0 });
  const ext = path.extname(outPath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    throw new MediaKitError(`frame output must be .png/.jpg/.webp, got ${ext || "(no extension)"}`, "INVALID_ARG");
  }
  await run(FFMPEG, ["-y", "-ss", String(t), "-i", inPath, "-frames:v", "1", "-q:v", "2", outPath]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "extract_frame", input: inPath, output: outPath, timestamp: t, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
}

// ---------------------------------------------------------------- thumbnail

export async function thumbnail({ input, output, frames = 6, columns = 3, width = 320 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const n = num(frames, "frames", { min: 1, max: 64, integer: true });
  const cols = num(columns, "columns", { min: 1, max: 8, integer: true });
  const w = num(width, "width", { min: 80, max: 1280, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("thumbnail needs a video input", "INVALID_ARG");
  const rows = Math.ceil(n / cols);
  // select N evenly spaced frames, scale, tile into a contact sheet.
  const vf = `select='not(mod(n\\,${Math.max(1, Math.floor((meta.duration_seconds * (meta.video.fps || 30)) / n))}))',scale=${w}:-2,tile=${cols}x${rows}`;
  await run(FFMPEG, ["-y", "-i", inPath, "-vf", vf, "-frames:v", "1", "-q:v", "2", outPath]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "thumbnail", input: inPath, output: outPath, frames: n, columns: cols, rows, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
}

// ---------------------------------------------------------------- frames
// Extract N evenly spaced frames as separate image files, so an agent
// can actually LOOK at a video (ffmpeg-mcp's extract_frames idea):
// one fps-filter pass, one file per frame, each with its timestamp.
// Output is a directory; files are frame-001.png, frame-002.png, ...
// Format tip: for screen recordings or any text-heavy footage use png
// (default) or webp, not jpg — JPEG chroma subsampling smears 1px
// text and thin borders, so a jpg frame can look broken when the
// video itself is fine.

export async function extractFrames({ input, outputDir, count = 6, format = "png", width = null }) {
  const inPath = await requireInput(input);
  const n = num(count, "count", { min: 1, max: 120, integer: true });
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
  // fps=N/D emits one frame per interval [i*D/N, (i+1)*D/N) — exactly
  // N frames, evenly spaced, timestamps i*D/N.
  let vf = `fps=${n}/${duration}`;
  if (w !== null) vf += `,scale=${w}:-2`;
  const pattern = path.join(dir, `frame-%03d.${ext}`);
  const q = ext === "png" ? [] : ["-q:v", "2"];
  await run(FFMPEG, ["-y", "-i", inPath, "-vf", vf, ...q, pattern]);
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir))
    .filter((f) => f.startsWith("frame-") && f.endsWith(`.${ext}`))
    .sort();
  const frames = [];
  for (let i = 0; i < files.length; i++) {
    const fp = path.join(dir, files[i]);
    const info = await fileInfo(fp);
    frames.push({ file: files[i], path: fp, timestamp_seconds: +(i * duration / n).toFixed(3), ...info });
  }
  return {
    operation: "frames", input: inPath, output_dir: dir,
    requested: n, extracted: frames.length, format: ext,
    ...(w !== null ? { width: w } : {}),
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

export async function loudness({ input, output, targetLufs = -14, format = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const target = num(targetLufs, "target_lufs", { min: -70, max: 0 });
  const ext = (format || path.extname(outPath).slice(1) || "mp3").toLowerCase();
  const codec = AUDIO_FORMATS[ext] ?? VIDEO_CONTAINER_AUDIO[ext];
  if (!codec) throw new MediaKitError(`unsupported audio format: ${ext}`, "INVALID_ARG");
  const meta = await probe(inPath);
  if (!meta.audio) throw new MediaKitError("loudness needs an audio stream in the input", "INVALID_ARG");
  // Two-pass loudnorm: pass 1 measures the input (integrated loudness,
  // true peak, LRA, threshold, target offset); pass 2 applies the exact
  // linear gain. Single-pass cannot hit the target when the input is far
  // from it — a -26 LUFS music bed only reached -21.6 in one pass.
  const measured = await measureLoudnessFull(inPath);
  let twoPass = false;
  if (measured) {
    await run(FFMPEG, [
      "-y", "-i", inPath,
      "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${measured.i}:measured_TP=${measured.tp}:measured_LRA=${measured.lra}:measured_thresh=${measured.thresh}:offset=${measured.offset}:linear=true`,
      "-ar", "48000", "-c:v", "copy", "-c:a", codec, outPath,
    ]);
    twoPass = true;
  } else {
    // Measurement failed (unusual input): fall back to single-pass.
    await run(FFMPEG, [
      "-y", "-i", inPath,
      "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11`,
      "-ar", "48000", "-c:v", "copy", "-c:a", codec, outPath,
    ]);
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  const outputLufs = out.audio ? await measureLoudness(outPath) : null;
  // Honest reporting: when the input is peak-limited (true peak caps the
  // gain — e.g. sub-bass-heavy music with a 20+ dB crest), even two-pass
  // cannot reach the target without clipping. Say so instead of
  // pretending the target was hit.
  const offTarget = outputLufs === null ? null : +(outputLufs - target).toFixed(1);
  const warning = offTarget !== null && Math.abs(offTarget) > 0.5
    ? `reached ${outputLufs} LUFS, ${Math.abs(offTarget)} LUFS ${offTarget < 0 ? "below" : "above"} target — input is peak-limited (true peak caps the gain); high-pass sub-bass or compress first, then normalize again`
    : null;
  return { operation: "loudness", input: inPath, output: outPath, target_lufs: target, input_lufs: measured?.i ?? null, output_lufs: outputLufs, two_pass: twoPass, ...(warning ? { warning } : {}), format: ext, ...info, duration_seconds: out.duration_seconds };
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
// reasons), fast=false always re-encodes.

const XFADE_TRANSITIONS = [
  "fade", "fadeblack", "fadewhite", "distance",
  "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown",
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "circlecrop", "rectcrop", "circleclose", "circleopen",
  "horzclose", "horzopen", "vertclose", "vertopen",
  "diagbl", "diagbr", "diagtl", "diagtr",
  "hlslice", "hrslice", "vuslice", "vdslice",
  "dissolve", "pixelize", "radial", "hblur",
  "wipetl", "wipetr", "wipebl", "wipebr",
  "zoomin", "fadegrays", "squeezev", "squeezeh",
  "hlwind", "hrwind", "vuwind", "vdwind",
  "coverleft", "coverright", "coverup", "coverdown",
];

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

export async function concat({ inputs, output, videoCodec = "libx264", audioCodec = "aac", transition = null, transitionDuration = 1, fast = null }) {
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
  if (transition !== null && transition !== undefined) {
    if (fast === true) {
      throw new MediaKitError("concat --fast (stream copy) cannot be combined with --transition — transitions need re-encoding", "INVALID_ARG");
    }
    return concatTransition({ inPaths, outPath, videoCodec, audioCodec, transition, transitionDuration, clips, metas });
  }
  if (hasTrim) {
    return concatTrimmed({ inPaths, outPath, videoCodec, audioCodec, clips, metas });
  }
  const compat = checkConcatCompat(metas);
  const useFast = fast === true ? true : fast === false ? false : compat.ok;
  if (fast === true && !compat.ok) {
    throw new MediaKitError(`concat --fast needs identical clips, but: ${compat.reasons.join("; ")}`, "INVALID_ARG");
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
        "-c:v", videoCodec, "-c:a", audioCodec, "-movflags", "+faststart", outPath,
      ]);
    }
  } finally {
    await unlink(listPath).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "concat", inputs: inPaths, output: outPath, parts: concatParts(clips),
    mode: useFast ? "fast" : "reencode",
    ...(useFast
      ? { fast_reason: "all clips identical (codec, size, fps, pixel format, audio) — stream-copied without re-encoding" }
      : { fast_skipped: compat.reasons.length ? compat.reasons : ["fast mode disabled"] }),
    ...info, duration_seconds: out.duration_seconds,
  };
}

/**
 * Concat with per-clip trims: trim/atrim each clip in one filter
 * graph, normalize to the first clip's size/fps (like the transition
 * path), then join with the concat filter. Always re-encodes — the
 * demuxer's inpoint/outpoint cannot cut accurately (see the --fast
 * error above), so there is no fast path here.
 */
async function concatTrimmed({ inPaths, outPath, videoCodec, audioCodec, clips, metas }) {
  const hasVideo = metas.some((m) => m.video);
  if (hasVideo && metas.some((m) => !m.video)) {
    throw new MediaKitError("concat with per-clip trims needs video in every input (or audio in every input) — mixed video/audio-only clips are not supported", "INVALID_ARG");
  }
  const firstVideo = metas.find((m) => m.video);
  const tw = firstVideo ? firstVideo.video.width : null;
  const th = firstVideo ? firstVideo.video.height : null;
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
  args.push("-c:a", audioCodec, "-movflags", "+faststart", outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "concat", inputs: inPaths, output: outPath, parts: concatParts(clips),
    mode: "trim", expected_duration_seconds: expected,
    ...info, duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

/**
 * Stream-copy concat only works when every clip matches: same video
 * codec/size/fps/pixel format and same audio presence/codec/rate/
 * channels, in the same container family. Compare each clip against
 * the first and collect every mismatch (not just the first) so the
 * caller can see what to normalize.
 */
function checkConcatCompat(metas) {
  const reasons = [];
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
      if (vid(m).width !== vid(base).width || vid(m).height !== vid(base).height) {
        reasons.push(`${label}: size ${vid(m).width}x${vid(m).height} != ${vid(base).width}x${vid(base).height}`);
      }
      if (!sameFps(vid(m).fps, vid(base).fps)) reasons.push(`${label}: fps ${vid(m).fps} != ${vid(base).fps}`);
      if (vid(m).pixel_format !== vid(base).pixel_format) reasons.push(`${label}: pixel format ${vid(m).pixel_format} != ${vid(base).pixel_format}`);
    }
    if (!!aud(base) !== !!aud(m)) {
      reasons.push(`${label}: audio presence differs`);
    } else if (aud(base) && aud(m)) {
      if (aud(m).codec !== aud(base).codec) reasons.push(`${label}: audio codec ${aud(m).codec} != ${aud(base).codec}`);
      if (aud(m).sample_rate !== aud(base).sample_rate) reasons.push(`${label}: audio sample rate ${aud(m).sample_rate} != ${aud(base).sample_rate}`);
      if (aud(m).channels !== aud(base).channels) reasons.push(`${label}: audio channels ${aud(m).channels} != ${aud(base).channels}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** concat with an xfade transition between every pair of clips. */
async function concatTransition({ inPaths, outPath, videoCodec, audioCodec, transition, transitionDuration, clips, metas }) {
  if (!XFADE_TRANSITIONS.includes(transition)) {
    throw new MediaKitError(`unknown transition: ${transition} (supported: ${XFADE_TRANSITIONS.join(", ")})`, "INVALID_ARG");
  }
  const t = num(transitionDuration, "transition_duration", { min: 0.1, max: 10 });
  if (metas.some((m) => !m.video)) {
    throw new MediaKitError("concat with a transition needs video in every input", "INVALID_ARG");
  }
  // Effective durations are the trimmed ones (or the full clip when
  // no trim was given), so transitions land on the trimmed timeline.
  const durations = clips.map((c) => c.effDur);
  if (durations.some((d) => d === null)) {
    throw new MediaKitError("could not read input durations for transition concat", "PROBE_FAILED");
  }
  const minDur = Math.min(...durations);
  if (t >= minDur) {
    throw new MediaKitError(`transition_duration (${t}s) must be shorter than the shortest clip (${minDur}s)`, "INVALID_ARG");
  }
  // Normalize to the first clip's size/fps (xfade needs identical
  // dimensions and frame rates on both inputs). A trimmed clip is cut
  // first (trim/atrim + PTS reset), then scaled like an untrimmed one.
  const tw = metas[0].video.width;
  const th = metas[0].video.height;
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
  // is sum(d_0..d_{k-1}) - (k-1)*t, and the next transition starts
  // t seconds before its end.
  let vLabel = "v0";
  let aLabel = "a0";
  let running = durations[0];
  for (let k = 1; k < metas.length; k++) {
    const offset = +(running - t).toFixed(3);
    const vOut = `x${k}`;
    const aOut = `c${k}`;
    graph.push(`[${vLabel}][v${k}]xfade=transition=${transition}:duration=${t}:offset=${offset}[${vOut}]`);
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
    "-c:a", audioCodec, "-movflags", "+faststart", outPath,
  );
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "concat", inputs: inPaths, output: outPath, parts: concatParts(clips),
    transition, transition_duration: t,
    expected_duration_seconds: running,
    ...info, duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

// ---------------------------------------------------------------- burn_captions
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

export async function burnCaptions({ input, output, captions, fontSize = null, fontColor = "white", box = true, marginV = null, style = null, outlineColor = "black" }) {
  const inPath = await requireInput(input);
  const capPath = await requireInput(captions, "captions file");
  const outPath = await prepareOutput(output, [inPath]);
  const ext = path.extname(capPath).toLowerCase();
  if (![".srt", ".ass", ".vtt"].includes(ext)) {
    throw new MediaKitError(`captions must be .srt/.ass/.vtt, got ${ext}`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  const vw = meta.video?.width ?? 1280;
  const vh = meta.video?.height ?? 720;
  // Defaults scale with frame height so captions stay readable and clear
  // of platform overlays at any size: ~60px type on 1080x1920, sitting
  // ~500px above the bottom edge (TikTok/Shorts cover the bottom ~480px
  // with their own UI). Explicit values always win. Applies to .srt/.vtt;
  // .ass files carry their own styles.
  const size = fontSize === null ? Math.round(vh * 0.031) : num(fontSize, "font_size", { min: 8, max: 200, integer: true });
  const margin = marginV === null ? Math.round(vh * 0.26) : num(marginV, "margin_v", { min: 0, max: vh, integer: true });
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
  await run(FFMPEG, ["-y", "-i", inPath, "-vf", vf, "-c:a", "copy", outPath]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "burn_captions", input: inPath, output: outPath, captions: capPath, font_size: size, margin_v: margin, style: styleName, style_applied: ext !== ".ass", ...info, duration_seconds: out.duration_seconds };
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

export async function transcribe({ input, output, model = "tiny", language = "auto", engine = "auto" }) {
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
    let asr;
    if (selected.engine === "whisper.cpp") {
      const outBase = path.join(tmpDir, "whisper-out");
      await runCapture(selected.binary, ["-m", selected.model, "-f", wav, "-l", lang, "-ojf", "-of", outBase, "-np"], { timeoutMs: 1_800_000 });
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
      asr = {
        segments: segs.map((s) => ({ start: (s.offsets?.from ?? 0) / 1000, end: (s.offsets?.to ?? 0) / 1000, text: s.text ?? "" })),
        language: parsed.result?.language ?? null,
        language_probability: null,
        duration_seconds: meta.duration_seconds ?? null,
      };
    } else {
      const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "asr_faster_whisper.py");
      const args = [helper, "--wav", wav, "--model", mdl];
      if (lang !== "auto") args.push("--language", lang);
      const { stdout } = await runCapture(selected.python, args, { timeoutMs: 1_800_000 });
      try {
        asr = JSON.parse(stdout);
      } catch {
        throw new MediaKitError(`transcribe: the ASR helper returned unparseable output: ${String(stdout).slice(0, 200)}`, "ASR_FAILED");
      }
    }
    const segments = (asr.segments ?? [])
      .map((s) => ({
        start: num(s.start, "segment start", { min: 0 }),
        end: num(s.end, "segment end", { min: 0 }),
        text: String(s.text ?? "").trim(),
      }))
      .filter((s) => s.end > s.start && s.text)
      .sort((a, b) => a.start - b.start);
    const normalized = segments.map((s) => ({ startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: s.text }));
    await writeFile(outPath, formatSrtBody(normalized), "utf8");
    const info = await fileInfo(outPath);
    return {
      operation: "transcribe",
      input: inPath,
      output: outPath,
      engine: selected.engine,
      model: mdl,
      language: asr.language ?? null,
      language_probability: asr.language_probability ?? null,
      duration_seconds: asr.duration_seconds ?? meta.duration_seconds ?? null,
      segment_count: segments.length,
      segments: segments.map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), text: s.text })),
      text: segments.map((s) => s.text).join(" "),
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

export async function titlecard({ text, output, width = 1080, height = 1920, fontSize = null, textColor = "FFD60A", boxColor = "F97316" }) {
  if (!text || !String(text).trim()) throw new MediaKitError("titlecard needs text", "INVALID_ARG");
  const outPath = await prepareOutput(output, []);
  const w = num(width, "width", { min: 2, integer: true });
  const h = num(height, "height", { min: 2, integer: true });
  if (w % 2 !== 0 || h % 2 !== 0) throw new MediaKitError("titlecard width/height must be even", "INVALID_ARG");
  const size = fontSize === null ? Math.round(w * 0.11) : num(fontSize, "font_size", { min: 16, max: 400, integer: true });
  const fg = normalizeColor(textColor, "text_color");
  const bg = normalizeColor(boxColor, "box_color");
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
  return { operation: "titlecard", output: outPath, text: String(text).trim(), lines, font_size: size, text_color: fg, box_color: bg, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null };
}

// ---------------------------------------------------------------- intro
// A short intro clip: a title on a solid-colour background, fading in
// and out (the generateIntro idea from studiomeyer-io/mcp-video,
// rebuilt on ffmpeg directly). Text goes through a textfile like
// titlecard, so quoting can never break the filter. Silent video.

export async function intro({ text, output, width = 1280, height = 720, duration = 3, bgColor = "0F172A", textColor = "FFFFFF", fontSize = null, fadeIn = 0.5, fadeOut = 0.5 }) {
  if (!text || !String(text).trim()) throw new MediaKitError("intro needs text", "INVALID_ARG");
  const outPath = await prepareOutput(output, []);
  const w = num(width, "width", { min: 2, integer: true });
  const h = num(height, "height", { min: 2, integer: true });
  if (w % 2 !== 0 || h % 2 !== 0) throw new MediaKitError("intro width/height must be even", "INVALID_ARG");
  const d = num(duration, "duration", { min: 0.5, max: 30 });
  const fi = num(fadeIn, "fade_in", { min: 0, max: 30 });
  const fo = num(fadeOut, "fade_out", { min: 0, max: 30 });
  if (fi + fo >= d) throw new MediaKitError(`intro fade_in + fade_out (${fi + fo}s) must be shorter than duration (${d}s)`, "INVALID_ARG");
  const size = fontSize === null ? Math.round(w * 0.08) : num(fontSize, "font_size", { min: 16, max: 400, integer: true });
  const bg = normalizeColor(bgColor, "bg_color");
  const fg = normalizeColor(textColor, "text_color");
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
  return { operation: "intro", output: outPath, text: String(text).trim(), lines, font_size: size, bg_color: bg, text_color: fg, fade_in: fi, fade_out: fo, ...info, dimensions: out.video ? `${out.video.width}x${out.video.height}` : null, duration_seconds: out.duration_seconds };
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
  const sw = meta.video.width;
  const sh = meta.video.height;
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

export async function check({ input, platform = "tiktok", content = false, contentStart = null, contentEnd = null, peakThresholdDb = -1 }) {
  const inPath = await requireInput(input);
  const spec = PLATFORMS[platform];
  if (!spec) throw new MediaKitError(`unknown platform: ${platform} (supported: ${Object.keys(PLATFORMS).join(", ")})`, "INVALID_ARG");
  const meta = await probe(inPath);
  const checks = [];
  // severity "error" (default) fails the check; "warn" is reported in
  // `warnings` and does not fail it — bitrate is a recommendation, not
  // an upload gate, so it warns instead of failing.
  const add = (name, expected, actual, pass, hint = null, severity = "error") =>
    checks.push({ name, expected, actual, pass, ...(hint ? { hint } : {}), ...(severity !== "error" ? { severity } : {}) });

  if (meta.video) {
    add("dimensions", `${spec.width}x${spec.height}`,
      `${meta.video.width}x${meta.video.height}`,
      meta.video.width === spec.width && meta.video.height === spec.height,
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
    const rec = recommendedVideoBitrateMbps(meta.video.width, meta.video.height, meta.video.fps);
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
  if (spec.maxFileSizeMB && meta.size_bytes !== null) {
    const mb = meta.size_bytes / (1024 * 1024);
    add("file_size", `<= ${spec.maxFileSizeMB} MB`, `${mb.toFixed(1)} MB`,
      mb <= spec.maxFileSizeMB,
      "upload from desktop/web, or re-encode at a lower bitrate");
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
    ...(contentResult ? { content: contentResult } : {}),
    ...(failed.length ? { issues: failed.map((c) => `${c.name}: ${c.actual} (want ${c.expected})${c.hint ? ` — ${c.hint}` : ""}`) } : {}),
    ...(warnings.length ? { warnings: warnings.map((c) => `${c.name}: ${c.actual} (want ${c.expected})${c.hint ? ` — ${c.hint}` : ""}`) } : {}),
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

export async function grade({ input, output, preset = null, filter = null, crf = 23 }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  if (filter !== null && filter !== undefined && filter !== "") {
    if (preset !== null && preset !== undefined) {
      throw new MediaKitError("grade --preset and --filter are mutually exclusive (one way to pick the look)", "INVALID_ARG");
    }
    if (typeof filter !== "string") throw new MediaKitError("grade --filter must be a filter chain string", "INVALID_ARG");
  }
  const name = filter ? null : (preset ?? "warm");
  const chain = filter || GRADE_PRESETS[name];
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
    preset: name, filter: chain, crf: c,
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
    if (reverseAudio) args.push("-af", "areverse", "-c:a", audioCodec);
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
export async function convert({ input, output, videoCodec = null, audioCodec = null, crf = 23, preset = "medium", gop = null, gopSeconds = null }) {
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
  if (audioCodec) args.push("-c:a", audioCodec);
  else args.push("-c:a", "copy");
  args.push(outPath);
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

export async function compress({ input, output, quality = "medium", maxWidth = null, crf = null, preset = null, targetSizeMb = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const targetMb = targetSizeMb === null || targetSizeMb === undefined ? null : num(targetSizeMb, "target_size_mb", { min: 0.05, max: 10000 });
  if (targetMb !== null && crf !== null && crf !== undefined) {
    throw new MediaKitError("compress --target-size and --crf are mutually exclusive (target size picks the bitrate itself)", "INVALID_ARG");
  }
  if (!(quality in COMPRESS_PRESETS)) {
    throw new MediaKitError(`unknown quality: ${quality} (supported: ${Object.keys(COMPRESS_PRESETS).join(", ")})`, "INVALID_ARG");
  }
  const settings = COMPRESS_PRESETS[quality];
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

  if (targetMb !== null) {
    // Target-size mode (Ashutos1997/ffmpeg-mcp-server's compress_video
    // targetSizeMB idea, rebuilt as two-pass ABR): the bitrate budget
    // comes from the size + duration, not from a CRF. A 2% safety
    // margin absorbs container overhead so the measured size lands
    // under the target instead of just near it. quality/crf are
    // ignored in this mode — the result says so (mode: target_size).
    const duration = meta.duration_seconds;
    if (!duration || duration <= 0) {
      throw new MediaKitError("compress --target-size needs a file with a known duration", "INVALID_ARG");
    }
    const targetBytes = Math.floor(targetMb * 1_000_000); // decimal MB, like Discord's 10 MB / 25 MB limits
    const budgetBytes = Math.floor(targetBytes * 0.98);
    const totalKbps = (budgetBytes * 8) / duration / 1000;
    const MIN_VIDEO_KBPS = 100;
    const MIN_AUDIO_KBPS = 32;
    let audioKbps;
    let videoKbps = null;
    if (meta.video) {
      audioKbps = meta.audio ? 128 : 0;
      videoKbps = Math.floor(totalKbps - audioKbps);
      if (videoKbps < MIN_VIDEO_KBPS) {
        const minMb = (((MIN_VIDEO_KBPS + audioKbps) * 1000 * duration) / 8 / 0.98 / 1_000_000).toFixed(2);
        throw new MediaKitError(`target ${targetMb} MB is too small for ${duration}s — minimum is about ${minMb} MB (${MIN_VIDEO_KBPS} kbps video + ${audioKbps} kbps audio)`, "INVALID_ARG");
      }
    } else if (meta.audio) {
      audioKbps = Math.floor(totalKbps);
      if (audioKbps < MIN_AUDIO_KBPS) {
        const minMb = ((MIN_AUDIO_KBPS * 1000 * duration) / 8 / 0.98 / 1_000_000).toFixed(2);
        throw new MediaKitError(`target ${targetMb} MB is too small for ${duration}s of audio — minimum is about ${minMb} MB (${MIN_AUDIO_KBPS} kbps audio)`, "INVALID_ARG");
      }
    } else {
      throw new MediaKitError("compress needs a video or audio stream", "INVALID_ARG");
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
    return {
      operation: "compress", input: inPath, output: outPath, mode: "target_size",
      target_size_mb: targetMb, target_size_bytes: targetBytes,
      video_bitrate_kbps: videoKbps, audio_bitrate_kbps: audioKbps, passes,
      ...(scaledTo ? { scaled_to: scaledTo } : {}),
      size_before_bytes: before.size_bytes, size_before_human: before.size_human,
      size_after_bytes: after.size_bytes, size_after_human: after.size_human,
      target_met: after.size_bytes <= targetBytes,
      reduction_percent: reduction,
      duration_seconds: out.duration_seconds,
      dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
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
    aParts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
    aLabels.push(`[a${i}]`);
  });
  const graph = [...vParts, ...aParts];
  if (meta.video) graph.push(`${vLabels.join("")}concat=n=${kept.length}:v=1:a=0[vout]`);
  graph.push(`${aLabels.join("")}concat=n=${kept.length}:v=0:a=1[aout]`);
  const args = ["-y", "-i", inPath, "-filter_complex", graph.join(";")];
  if (meta.video) {
    args.push("-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
      "-c:a", "aac", "-movflags", "+faststart");
  } else {
    const ext = path.extname(outPath).slice(1).toLowerCase();
    const codec = AUDIO_FORMATS[ext];
    if (!codec) throw new MediaKitError(`audio-only input needs an audio output format (.mp3/.aac/.wav/.ogg/.opus/.flac), got .${ext || "(none)"}`, "INVALID_ARG");
    args.push("-map", "[aout]", "-c:a", codec);
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

// ---------------------------------------------------------------- doctor
// Read-only environment preflight (kinocut's video_doctor idea): what
// ffmpeg/ffprobe can actually do on this machine, and which mediakit
// tools that enables. Never writes anything.

const DOCTOR_FILTERS = [
  "silencedetect", "loudnorm", "subtitles", "ass", "scale", "crop",
  "cropdetect", "blackdetect", "freezedetect", "gblur", "trim", "atrim", "concat", "select", "tile", "pad", "overlay",
  "drawtext", "volume", "sidechaincompress", "amix", "aresample",
  "xfade", "acrossfade", "fps", "anullsrc", "setpts", "asetpts",
  "format", "colorchannelmixer", "atempo", "aloop", "geq", "color",
  "palettegen", "paletteuse", "adelay", "pan",
  "astats", "ametadata", "eq", "hue", "colorbalance",
  "reverse", "areverse",
  "minterpolate", "hqdn3d", "nlmeans",
];
const DOCTOR_ENCODERS = [
  "libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4",
  "aac", "libopus", "libmp3lame", "libvorbis", "flac", "pcm_s16le",
];
const DOCTOR_DECODERS = [
  "librsvg",
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
  thumbnail: { filters: ["select", "scale", "tile"] },
  loudness: { filters: ["loudnorm"] },
  concat: { filters: ["concat", "xfade", "acrossfade", "fps", "scale", "pad"] },
  frames: { filters: ["fps", "scale"] },
  export_gif: { filters: ["palettegen", "paletteuse", "fps", "scale"] },
  burn_captions: { filters: ["subtitles", "ass"] },
  reframe: { filters: ["crop", "scale", "pad", "gblur", "overlay"], encoders: ["libx264"] },
  check: { filters: ["loudnorm", "blackdetect", "freezedetect", "silencedetect", "astats", "ametadata"] },
  grade: { filters: ["eq", "hue", "colorbalance"], encoders: ["libx264"] },
  reverse: { filters: ["reverse", "areverse"], encoders: ["libx264", "aac"] },
  interpolate: { filters: ["minterpolate"], encoders: ["libx264"] },
  denoise: { filters: ["hqdn3d", "nlmeans"], encoders: ["libx264"] },
  segment: {},
  convert: { encoders: ["libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4"] },
  compress: { filters: ["scale"], encoders: ["libx264", "aac"] },
  receipt: { filters: ["loudnorm"] },
  silence: { filters: ["silencedetect", "trim", "atrim", "concat"], encoders: ["libx264", "aac"] },
  cropdetect: { filters: ["cropdetect"] },
  package: {},
  publish_kit: {},
  mix: { filters: ["sidechaincompress", "amix", "aresample", "volume", "loudnorm", "adelay"], encoders: ["aac", "libmp3lame"] },
  overlay: { filters: ["overlay", "format", "scale", "colorchannelmixer"], encoders: ["libx264"] },
  scenes: { filters: ["select"] },
  keyframes: {},
  fit: { filters: ["setpts", "atempo", "fps"], encoders: ["libx264", "aac"] },
  pip: { filters: ["overlay", "format", "scale", "colorchannelmixer", "amix"], encoders: ["libx264"] },
  titlecard: { filters: ["drawtext", "geq"] },
  intro: { filters: ["color", "drawtext"], encoders: ["libx264"] },
  social: { filters: ["crop", "scale", "pad", "gblur", "overlay", "loudnorm"], encoders: ["libx264"] },
  convert_captions: {},
  generate_srt: {},
  find: {},
  batch: {},
  mux: {},
  svg_animate: { decoders: ["librsvg"], encoders: ["libx264"] },
  transcribe: {},
  doctor: {},
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

export async function doctor() {
  const { stdout: ffmpegVer } = await run(FFMPEG, ["-version"]);
  const { stdout: ffprobeVer } = await run(FFPROBE, ["-version"]);
  const ffmpegVersion = (ffmpegVer.match(/ffmpeg version (\S+)/) || [])[1] ?? null;
  const ffprobeVersion = (ffprobeVer.match(/ffprobe version (\S+)/) || [])[1] ?? null;
  const filtersOut = await listCapabilities("filters");
  const encodersOut = await listCapabilities("encoders");
  const decodersOut = await listCapabilities("decoders");
  const has = (text, name) => new RegExp(`\\b${name}\\b`).test(text);
  const filters = Object.fromEntries(DOCTOR_FILTERS.map((f) => [f, has(filtersOut, f)]));
  const encoders = Object.fromEntries(DOCTOR_ENCODERS.map((e) => [e, has(encodersOut, e)]));
  const decoders = Object.fromEntries(DOCTOR_DECODERS.map((d) => [d, has(decodersOut, d)]));
  const gpu = await detectGpu(encodersOut);
  const tools = {};
  let allOk = Boolean(ffmpegVersion && ffprobeVersion);
  for (const [name, req] of Object.entries(TOOL_REQUIREMENTS)) {
    const missing = [];
    for (const f of req.filters ?? []) if (!filters[f]) missing.push(`filter:${f}`);
    for (const d of req.decoders ?? []) if (!decoders[d]) missing.push(`decoder:${d}`);
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
  // transcribe is optional (ffmpeg-skill's ASR rule: a speech engine is
  // never required): report the engine state, but a missing engine
  // must not fail ok — everything else still works without it.
  // detectTranscribe() prefers faster-whisper, then whisper.cpp.
  const asr = await detectTranscribe();
  tools.transcribe = asr.available
    ? { available: true, engine: asr.engine, ...(asr.python ? { python: asr.python } : {}), ...(asr.binary ? { binary: asr.binary, model: asr.model } : {}) }
    : { available: false, engine: asr.engine, ...(asr.python ? { python: asr.python } : {}), fix: asr.fix };
  return {
    operation: "doctor",
    ffmpeg_version: ffmpegVersion,
    ffprobe_version: ffprobeVersion,
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    sandbox,
    gpu,
    filters,
    encoders,
    decoders,
    tools,
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
    `[0:a]aresample=48000,volume=${voiceGainDb}dB[voice]`,
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

  const graphParts = [
    `[0:a]aresample=48000,volume=${voiceGainDb}dB[voice]`,
    `[1:a]aresample=48000,volume=${bedVol}[bed]`,
    `[bed][voice]sidechaincompress=threshold=0.0316:ratio=${ratio}:attack=${attack}:release=${release}[ducked]`,
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
  if (mTarget !== null) graphParts.push(`${finalLabel}loudnorm=I=${mTarget}:TP=-1.5:LRA=11[out]`);
  const graph = graphParts.join(";");
  const mixLabel = mTarget !== null ? "[out]" : finalLabel;
  const args = ["-y", "-i", voicePath, "-stream_loop", "-1", "-i", musicPath];
  for (const s of sfxList) args.push("-i", s.file);
  args.push("-filter_complex", graph);
  if (voiceMeta.video) {
    args.push("-map", "0:v", "-map", mixLabel, "-c:v", "copy", "-c:a", audioCodec, "-shortest");
    if (["mp4", "mov", "m4v"].includes(ext)) args.push("-movflags", "+faststart");
  } else {
    args.push("-map", mixLabel, "-c:a", audioCodec);
  }
  args.push(outPath);
  if (dryRun) {
    // Plan before render (ffmpeg-skill's --dry-run idea): the probe and
    // the loudnorm measurement above are read-only — they ran so the
    // gain in the plan is the real one — but no file is written.
    const quote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
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
      output_lufs: null,
      ducking_measured_db: null,
      sfx: sfxList,
      sfx_count: sfxList.length,
      duration_seconds: voiceDuration,
      has_video: Boolean(voiceMeta.video),
      commands: [`${FFMPEG} ${args.map(quote).join(" ")}`],
      note: "Dry run: no file written. Probes and the loudnorm measurement are read-only; they ran to compute voice_gain_db.",
    };
  }
  await run(FFMPEG, args);

  const info = await fileInfo(outPath);
  const outMeta = await probe(outPath);
  const outputLufs = outMeta.audio ? await measureLoudness(outPath) : null;

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
    output_lufs: outputLufs,
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
  const sw = meta.video.width;
  const sh = meta.video.height;
  const owNative = ovMeta.video.width;
  const ohNative = ovMeta.video.height;
  const ow = width === null || width === undefined ? owNative : num(width, "width", { min: 2, integer: true });
  const oh = Math.max(2, Math.round((ohNative * ow) / owNative));
  if (ow + 2 * m > sw || oh + 2 * m > sh) {
    throw new MediaKitError(`overlay ${ow}x${oh} with margin ${m}px does not fit source ${sw}x${sh} — use a smaller --width or --margin`, "INVALID_ARG");
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
  const sw = meta.video.width;
  const sh = meta.video.height;
  const pwRaw = width === null || width === undefined
    ? Math.round(sw * num(scale, "scale", { min: 0.05, max: 0.9 }))
    : num(width, "width", { min: 2, integer: true });
  // Keep even dimensions: yuv420p + overlay chroma subsampling
  // misbehave on odd widths/heights. Scale to explicit pw x ph so the
  // reported size is exactly what ffmpeg renders.
  const pw = Math.max(2, pwRaw - (pwRaw % 2));
  const phRaw = (pipMeta.video.height * pw) / pipMeta.video.width;
  const ph = Math.max(2, 2 * Math.round(phRaw / 2));
  if (pw + 2 * m > sw || ph + 2 * m > sh) {
    throw new MediaKitError(`pip ${pw}x${ph} with margin ${m}px does not fit source ${sw}x${sh} — use a smaller --width/--scale or --margin`, "INVALID_ARG");
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
    audioArgs = ["-map", "1:a", "-c:a", "aac"];
  } else {
    if (mainAudio && pipAudio) {
      audioFilter = "[0:a][1:a]amix=inputs=2:normalize=0[aout]";
      audioArgs = ["-map", "[aout]", "-c:a", "aac"];
    } else if (mainAudio) {
      audioArgs = ["-map", "0:a", "-c:a", "copy"];
    } else if (pipAudio) {
      audioArgs = ["-map", "1:a", "-c:a", "aac"];
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
    ...(s !== null ? { visible_from_seconds: s } : {}),
    ...(e !== null ? { visible_until_seconds: e } : {}),
    ...info,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
    duration_seconds: out.duration_seconds,
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

export async function detectScenes({ input, threshold = 0.3 }) {
  const inPath = await requireInput(input);
  const t = num(threshold, "threshold", { min: 0, max: 1 });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("scenes needs a video input", "INVALID_ARG");
  const duration = meta.duration_seconds;
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
  const changes = [...new Set(raw)].filter((v) => v > 0.05).sort((a, b) => a - b);
  const bounds = [0, ...changes, ...(duration !== null ? [duration] : [])];
  const segments = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    segments.push({
      start: +bounds[i].toFixed(3),
      end: +bounds[i + 1].toFixed(3),
      duration_seconds: +(bounds[i + 1] - bounds[i]).toFixed(3),
    });
  }
  return {
    operation: "scenes",
    input: inPath,
    threshold: t,
    duration_seconds: duration,
    scene_changes: changes,
    count: changes.length,
    segments,
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

export const BATCH_OPERATIONS = {
  loudness: {
    args: ["target_lufs", "format"],
    run: (input, output, a) => loudness({ input, output, targetLufs: a.target_lufs ?? -14, format: a.format ?? null }),
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
    args: ["quality", "max_width", "crf", "preset", "target_size_mb"],
    run: (input, output, a) => compress({ input, output, quality: a.quality ?? "medium", maxWidth: a.max_width ?? null, crf: a.crf ?? null, preset: a.preset ?? null, targetSizeMb: a.target_size_mb ?? null }),
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
  grade: {
    args: ["preset", "filter", "crf"],
    run: (input, output, a) => grade({ input, output, preset: a.preset ?? null, filter: a.filter ?? null, crf: a.crf ?? 23 }),
  },
  fit: {
    args: ["duration", "method", "max_fps"],
    run: (input, output, a) => fitDuration({ input, output, duration: a.duration, method: a.method ?? "speed", maxFps: a.max_fps ?? null }),
  },
  trim: {
    args: ["start", "end", "duration", "stream_copy", "snap_to_keyframe"],
    run: (input, output, a) => trim({ input, output, start: a.start ?? 0, duration: a.duration ?? null, end: a.end ?? null, streamCopy: a.stream_copy ?? false, snapToKeyframe: a.snap_to_keyframe ?? false }),
  },
  silence: {
    args: ["threshold_db", "min_duration", "margin"],
    run: (input, output, a) => silence({ input, output, thresholdDb: a.threshold_db ?? -40, minDuration: a.min_duration ?? 0.5, margin: a.margin ?? 0.2, detectOnly: false }),
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
  if (operation === "extract_audio") {
    if (args.whisper) return "wav";
    if (args.format) return String(args.format).toLowerCase().replace(/^\./, "");
    return AUDIO_FORMATS[inputExt] ? inputExt : "mp3";
  }
  if (operation === "loudness" && args.format) return String(args.format).toLowerCase().replace(/^\./, "");
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
  const suffix = outputSuffix === null || outputSuffix === undefined ? `-${operation}` : String(outputSuffix);
  if (!/^[A-Za-z0-9._-]{0,32}$/.test(suffix)) throw new MediaKitError(`batch output suffix must be 0-32 chars of [A-Za-z0-9._-], got: ${suffix}`, "INVALID_ARG");
  const outDirAbs = path.resolve(String(outputDir));
  await assertInsideWorkdir(outDirAbs, "output directory");
  if (suffix === "" && path.resolve(inDir) === outDirAbs) {
    throw new MediaKitError("batch with an empty suffix would overwrite its inputs — use a suffix or a different output directory", "INVALID_ARG");
  }

  const { files, skippedDirectories } = await collectBatchFiles(inDir, pattern.trim(), outDirAbs);
  if (!files.length) throw new MediaKitError(`batch matched no files: pattern "${pattern}" under ${inDir}`, "NO_MATCH");
  const truncated = files.length > max;
  const selected = files.slice(0, max);
  const items = selected.map((f) => {
    const rel = path.relative(inDir, f);
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
  // is never re-encoded. A hit is only trusted when the cached output
  // still exists on disk with the recorded size AND sha256 — a stale
  // or hand-edited output is re-run, not reported as done.
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
    return createHash("sha256").update(stableStringify({ operation, args, suffix, inputHash })).digest("hex");
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
          try {
            const st = await stat(hit.output);
            if (st.size === hit.output_size_bytes && (await hashFile(hit.output)) === hit.output_sha256) {
              results[i] = { input: item.input, output: item.output, status: "cached", result: hit.result };
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
          try {
            const st = await stat(item.output);
            cacheData.entries[item.cacheKey] = {
              output: item.output, output_size_bytes: st.size,
              output_sha256: await hashFile(item.output), result: r,
            };
          } catch { /* cache write is best-effort; the file itself is done */ }
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
