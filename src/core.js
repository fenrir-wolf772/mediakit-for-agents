/**
 * mediakit-for-agents — shared core.
 * Every operation runs ffmpeg/ffprobe through execFile with an argument
 * array. There is NO shell involved anywhere: user input can never be
 * interpreted as a shell command.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export const MEDIAKIT_VERSION = "0.1.0";

export const FFMPEG = process.env.MEDIAKIT_FFMPEG || "ffmpeg";
export const FFPROBE = process.env.MEDIAKIT_FFPROBE || "ffprobe";

export class MediaKitError extends Error {
  constructor(message, code = "MEDIAKIT_ERROR") {
    super(message);
    this.name = "MediaKitError";
    this.code = code;
  }
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
  await mkdir(path.dirname(abs), { recursive: true });
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

export async function fitDuration({ input, output, duration, method = "speed" }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const target = parseTime(duration, "duration");
  if (!(target > 0)) throw new MediaKitError(`duration must be > 0, got: ${duration}`, "INVALID_ARG");
  if (!FIT_METHODS.includes(method)) {
    throw new MediaKitError(`unknown fit method: ${method} (use ${FIT_METHODS.join(", ")})`, "INVALID_ARG");
  }
  const meta = await probe(inPath);
  const srcDur = meta.duration_seconds;
  if (srcDur === null) throw new MediaKitError("fit needs an input with a known duration", "PROBE_FAILED");
  const factor = srcDur / target; // >1 = speed up, <1 = slow down
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
    if (meta.video) filters.push(`[0:v]setpts=PTS/${f}[v]`);
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
    if (meta.video) args.push("-c:v", "libx264", "-crf", "18", "-preset", "veryfast");
    if (meta.audio) args.push("-c:a", audioCodec);
    args.push(outPath);
  } else { // loop
    if (srcDur >= target) {
      throw new MediaKitError(`loop fit needs a shorter source (${srcDur}s >= target ${target}s) — use method=speed or method=trim`, "INVALID_ARG");
    }
    applied = { method: "loop", loops: Math.ceil(target / srcDur) };
    args = ["-y", "-stream_loop", "-1", "-i", inPath, "-t", String(target)];
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

export async function resize({ input, output, width = null, height = null, keepAspect = true }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  if (width === null && height === null) {
    throw new MediaKitError("resize needs width and/or height", "INVALID_ARG");
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

export async function extractAudio({ input, output, format = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const ext = (format || path.extname(outPath).slice(1) || "mp3").toLowerCase();
  const codec = AUDIO_FORMATS[ext];
  if (!codec) throw new MediaKitError(`unsupported audio format: ${ext} (supported: ${Object.keys(AUDIO_FORMATS).join(", ")})`, "INVALID_ARG");
  await run(FFMPEG, ["-y", "-i", inPath, "-vn", "-c:a", codec, outPath]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "extract_audio", input: inPath, output: outPath, format: ext, codec, ...info, duration_seconds: out.duration_seconds };
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
  const dir = path.resolve(outputDir);
  if (dir === inPath || dir.startsWith(inPath + path.sep)) {
    throw new MediaKitError("frames output directory must not be inside the input file", "INVALID_OUTPUT");
  }
  const w = width === null || width === undefined ? null : num(width, "width", { min: 80, max: 3840, integer: true });
  const meta = await probe(inPath);
  if (!meta.video) throw new MediaKitError("frames needs a video input", "INVALID_ARG");
  const duration = meta.duration_seconds;
  if (duration === null || duration <= 0) throw new MediaKitError("could not read input duration", "PROBE_FAILED");
  await mkdir(dir, { recursive: true });
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

export async function concat({ inputs, output, videoCodec = "libx264", audioCodec = "aac", transition = null, transitionDuration = 1, fast = null }) {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    throw new MediaKitError("concat needs at least 2 input files", "INVALID_ARG");
  }
  const inPaths = [];
  for (const p of inputs) inPaths.push(await requireInput(p, "concat input"));
  const outPath = await prepareOutput(output, inPaths);
  if (transition !== null && transition !== undefined) {
    if (fast === true) {
      throw new MediaKitError("concat --fast (stream copy) cannot be combined with --transition — transitions need re-encoding", "INVALID_ARG");
    }
    return concatTransition({ inPaths, outPath, videoCodec, audioCodec, transition, transitionDuration });
  }
  // Probe once for the fast-path decision (also reused for the result).
  const metas = [];
  for (const p of inPaths) metas.push(await probe(p));
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
    operation: "concat", inputs: inPaths, output: outPath, parts: inPaths.length,
    mode: useFast ? "fast" : "reencode",
    ...(useFast
      ? { fast_reason: "all clips identical (codec, size, fps, pixel format, audio) — stream-copied without re-encoding" }
      : { fast_skipped: compat.reasons.length ? compat.reasons : ["fast mode disabled"] }),
    ...info, duration_seconds: out.duration_seconds,
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
async function concatTransition({ inPaths, outPath, videoCodec, audioCodec, transition, transitionDuration }) {
  if (!XFADE_TRANSITIONS.includes(transition)) {
    throw new MediaKitError(`unknown transition: ${transition} (supported: ${XFADE_TRANSITIONS.join(", ")})`, "INVALID_ARG");
  }
  const t = num(transitionDuration, "transition_duration", { min: 0.1, max: 10 });
  const metas = [];
  for (const p of inPaths) metas.push(await probe(p));
  if (metas.some((m) => !m.video)) {
    throw new MediaKitError("concat with a transition needs video in every input", "INVALID_ARG");
  }
  if (metas.some((m) => m.duration_seconds === null)) {
    throw new MediaKitError("could not read input durations for transition concat", "PROBE_FAILED");
  }
  const minDur = Math.min(...metas.map((m) => m.duration_seconds));
  if (t >= minDur) {
    throw new MediaKitError(`transition_duration (${t}s) must be shorter than the shortest clip (${minDur}s)`, "INVALID_ARG");
  }
  // Normalize to the first clip's size/fps (xfade needs identical
  // dimensions and frame rates on both inputs).
  const tw = metas[0].video.width;
  const th = metas[0].video.height;
  const fps = metas[0].video.fps || 30;
  const graph = [];
  metas.forEach((m, i) => {
    graph.push(`[${i}:v]scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps}[v${i}]`);
    if (m.audio) {
      graph.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      // Silent bed of exactly this clip's length, so acrossfade always
      // has two audio streams to work with.
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${m.duration_seconds},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  // Chain xfade pairwise. After joining clips 0..k-1 the running total
  // is sum(d_0..d_{k-1}) - (k-1)*t, and the next transition starts
  // t seconds before its end.
  let vLabel = "v0";
  let aLabel = "a0";
  let running = metas[0].duration_seconds;
  for (let k = 1; k < metas.length; k++) {
    const offset = +(running - t).toFixed(3);
    const vOut = `x${k}`;
    const aOut = `c${k}`;
    graph.push(`[${vLabel}][v${k}]xfade=transition=${transition}:duration=${t}:offset=${offset}[${vOut}]`);
    graph.push(`[${aLabel}][a${k}]acrossfade=d=${t}[${aOut}]`);
    vLabel = vOut;
    aLabel = aOut;
    running = +(running + metas[k].duration_seconds - t).toFixed(3);
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
    operation: "concat", inputs: inPaths, output: outPath, parts: inPaths.length,
    transition, transition_duration: t,
    expected_duration_seconds: running,
    ...info, duration_seconds: out.duration_seconds,
    dimensions: out.video ? `${out.video.width}x${out.video.height}` : null,
  };
}

// ---------------------------------------------------------------- burn_captions

export async function burnCaptions({ input, output, captions, fontSize = null, fontColor = "white", box = true, marginV = null }) {
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
    const forceStyle = `PlayResX=${vw},PlayResY=${vh},FontSize=${size},PrimaryColour=&HFFFFFF&,OutlineColour=&H80000000&,BorderStyle=${box ? 3 : 1},BackColour=&H80000000&,Outline=2,Shadow=0,MarginV=${margin}`;
    const color = fontColor.toLowerCase() === "white" ? "" : `,PrimaryColour=&H${fontColor}&`;
    vf = `subtitles='${esc}':force_style='${forceStyle}${color}'`;
  }
  await run(FFMPEG, ["-y", "-i", inPath, "-vf", vf, "-c:a", "copy", outPath]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "burn_captions", input: inPath, output: outPath, captions: capPath, font_size: size, margin_v: margin, ...info, duration_seconds: out.duration_seconds };
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
    // nullsrc + geq clears the alpha channel first: lavfi color sources
    // ignore alpha (always opaque), so the canvas must be made
    // transparent explicitly before drawtext paints the opaque box+text.
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `nullsrc=s=${w}x${h}:r=30:d=0.1`,
      "-vf", `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='0',drawtext=fontfile=${TITLECARD_FONT}:textfile=${esc}:fontsize=${size}:fontcolor=0x${fg}:borderw=6:bordercolor=black:box=1:boxcolor=0x${bg}:boxborderw=${Math.round(size * 0.25)}:x=(w-text_w)/2:y=(h-text_h)*0.55`,
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

export async function check({ input, platform = "tiktok" }) {
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
  const failed = checks.filter((c) => !c.pass && c.severity !== "warn");
  const warnings = checks.filter((c) => !c.pass && c.severity === "warn");
  return {
    operation: "check", input: inPath, platform, platform_label: spec.label,
    pass: failed.length === 0,
    checks,
    safe_zone: spec.safeZone,
    ...(failed.length ? { issues: failed.map((c) => `${c.name}: ${c.actual} (want ${c.expected})${c.hint ? ` — ${c.hint}` : ""}`) } : {}),
    ...(warnings.length ? { warnings: warnings.map((c) => `${c.name}: ${c.actual} (want ${c.expected})${c.hint ? ` — ${c.hint}` : ""}`) } : {}),
  };
}

// ---------------------------------------------------------------- convert

const VIDEO_CODECS = { libx264: "mp4", libx265: "mp4", vp9: "webm", av1: "mp4", mpeg4: "mp4", copy: null };

export async function convert({ input, output, videoCodec = null, audioCodec = null, crf = 23, preset = "medium" }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const c = num(crf, "crf", { min: 0, max: 51, integer: true });
  const args = ["-y", "-i", inPath];
  if (videoCodec) {
    if (!(videoCodec in VIDEO_CODECS)) throw new MediaKitError(`unsupported video codec: ${videoCodec}`, "INVALID_ARG");
    args.push("-c:v", videoCodec);
    if (videoCodec !== "copy") args.push("-crf", String(c), "-preset", preset);
  } else {
    args.push("-c:v", "copy");
  }
  if (audioCodec) args.push("-c:a", audioCodec);
  else args.push("-c:a", "copy");
  args.push(outPath);
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return {
    operation: "convert", input: inPath, output: outPath,
    video_codec: videoCodec ?? "copy", audio_codec: audioCodec ?? "copy",
    ...info, duration_seconds: out.duration_seconds,
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
  "cropdetect", "gblur", "trim", "atrim", "concat", "select", "tile", "pad", "overlay",
  "drawtext", "volume", "sidechaincompress", "amix", "aresample",
  "xfade", "acrossfade", "fps", "anullsrc", "setpts", "asetpts",
  "format", "colorchannelmixer", "atempo", "aloop", "geq",
];
const DOCTOR_ENCODERS = [
  "libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4",
  "aac", "libopus", "libmp3lame", "libvorbis", "flac", "pcm_s16le",
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
  burn_captions: { filters: ["subtitles", "ass"] },
  reframe: { filters: ["crop", "scale", "pad", "gblur", "overlay"], encoders: ["libx264"] },
  check: { filters: ["loudnorm"] },
  convert: { encoders: ["libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4"] },
  silence: { filters: ["silencedetect", "trim", "atrim", "concat"], encoders: ["libx264", "aac"] },
  cropdetect: { filters: ["cropdetect"] },
  package: {},
  mix: { filters: ["sidechaincompress", "amix", "aresample", "volume", "loudnorm"], encoders: ["aac", "libmp3lame"] },
  overlay: { filters: ["overlay", "format", "scale", "colorchannelmixer"], encoders: ["libx264"] },
  scenes: { filters: ["select"] },
  keyframes: {},
  fit: { filters: ["setpts", "atempo"], encoders: ["libx264", "aac"] },
  pip: { filters: ["overlay", "format", "scale", "colorchannelmixer", "amix"], encoders: ["libx264"] },
  titlecard: { filters: ["drawtext", "geq"] },
  doctor: {},
};

async function listCapabilities(kind) {
  // `ffmpeg -filters` / `-encoders` print a table; match whole words so
  // "crop" does not match "cropdetect".
  const { stdout } = await run(FFMPEG, ["-hide_banner", `-${kind}`]);
  return stdout;
}

export async function doctor() {
  const { stdout: ffmpegVer } = await run(FFMPEG, ["-version"]);
  const { stdout: ffprobeVer } = await run(FFPROBE, ["-version"]);
  const ffmpegVersion = (ffmpegVer.match(/ffmpeg version (\S+)/) || [])[1] ?? null;
  const ffprobeVersion = (ffprobeVer.match(/ffprobe version (\S+)/) || [])[1] ?? null;
  const filtersOut = await listCapabilities("filters");
  const encodersOut = await listCapabilities("encoders");
  const has = (text, name) => new RegExp(`\\b${name}\\b`).test(text);
  const filters = Object.fromEntries(DOCTOR_FILTERS.map((f) => [f, has(filtersOut, f)]));
  const encoders = Object.fromEntries(DOCTOR_ENCODERS.map((e) => [e, has(encodersOut, e)]));
  const tools = {};
  let allOk = Boolean(ffmpegVersion && ffprobeVersion);
  for (const [name, req] of Object.entries(TOOL_REQUIREMENTS)) {
    const missing = [];
    for (const f of req.filters ?? []) if (!filters[f]) missing.push(`filter:${f}`);
    const enc = req.encoders ?? [];
    if (enc.length && !enc.some((e) => encoders[e])) missing.push(`encoder:${enc.join("|")}`);
    tools[name] = { available: missing.length === 0, ...(missing.length ? { missing } : {}) };
    if (missing.length) allOk = false;
  }
  return {
    operation: "doctor",
    ffmpeg_version: ffmpegVersion,
    ffprobe_version: ffprobeVersion,
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    filters,
    encoders,
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

// ---------------------------------------------------------------- mix
// Voice + music bed with sidechain ducking (soniccraft's ducking idea,
// rebuilt on ffmpeg): level the voice to a target LUFS first, duck the
// bed under the voice with sidechaincompress (attack/release in ms),
// mix, then master the result to a target LUFS. The music input is
// looped to the voice length. The tool also MEASURES the ducking it
// actually achieved: it re-runs the ducked bed alone and compares its
// mean volume in a speech window vs a silence window, so the returned
// ducking_measured_db is observed, not assumed.

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
  voiceLufs = -16, targetLufs = -14, master = true,
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

  const graph = [
    `[0:a]aresample=48000,volume=${voiceGainDb}dB[voice]`,
    `[1:a]aresample=48000,volume=${bedVol}[bed]`,
    `[bed][voice]sidechaincompress=threshold=0.0316:ratio=${ratio}:attack=${attack}:release=${release}[ducked]`,
    `[ducked][voice]amix=inputs=2:duration=first:normalize=0[mix]`,
    ...(mTarget !== null ? [`[mix]loudnorm=I=${mTarget}:TP=-1.5:LRA=11[out]`] : []),
  ].join(";");
  const mixLabel = mTarget !== null ? "[out]" : "[mix]";
  const args = ["-y", "-i", voicePath, "-stream_loop", "-1", "-i", musicPath,
    "-filter_complex", graph];
  if (voiceMeta.video) {
    args.push("-map", "0:v", "-map", mixLabel, "-c:v", "copy", "-c:a", audioCodec, "-shortest");
    if (["mp4", "mov", "m4v"].includes(ext)) args.push("-movflags", "+faststart");
  } else {
    args.push("-map", mixLabel, "-c:a", audioCodec);
  }
  args.push(outPath);
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
