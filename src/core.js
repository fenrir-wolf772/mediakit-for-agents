/**
 * mediakit-for-agents — shared core.
 * Every operation runs ffmpeg/ffprobe through execFile with an argument
 * array. There is NO shell involved anywhere: user input can never be
 * interpreted as a shell command.
 */
import { execFile } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

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
    } : null,
    audio: audio ? {
      codec: audio.codec_name,
      sample_rate: audio.sample_rate ? Number(audio.sample_rate) : null,
      channels: audio.channels ?? null,
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

export async function trim({ input, output, start = 0, duration = null, end = null, streamCopy = false }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const s = num(start, "start", { min: 0 });
  let dur = null;
  if (duration !== null && duration !== undefined) dur = num(duration, "duration", { min: 0.0001 });
  if (end !== null && end !== undefined) {
    const e = num(end, "end", { min: 0 });
    if (e <= s) throw new MediaKitError(`end (${e}) must be greater than start (${s})`, "INVALID_ARG");
    if (dur !== null) throw new MediaKitError("pass duration OR end, not both", "INVALID_ARG");
    dur = e - s;
  }
  if (dur === null) throw new MediaKitError("trim needs duration or end", "INVALID_ARG");

  // -ss after -i = accurate seek (re-encode path); with stream copy we
  // put -ss before -i for fast keyframe seek.
  const args = streamCopy
    ? ["-y", "-ss", String(s), "-i", inPath, "-t", String(dur), "-c", "copy", outPath]
    : ["-y", "-i", inPath, "-ss", String(s), "-t", String(dur), outPath];
  await run(FFMPEG, args);
  const info = await fileInfo(outPath);
  const meta = await probe(outPath);
  return { operation: "trim", input: inPath, output: outPath, start: s, duration_seconds: dur, stream_copy: streamCopy, ...info, duration_actual: meta.duration_seconds };
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

// ---------------------------------------------------------------- loudness

export async function loudness({ input, output, targetLufs = -14, format = null }) {
  const inPath = await requireInput(input);
  const outPath = await prepareOutput(output, [inPath]);
  const target = num(targetLufs, "target_lufs", { min: -70, max: 0 });
  const ext = (format || path.extname(outPath).slice(1) || "mp3").toLowerCase();
  const codec = AUDIO_FORMATS[ext];
  if (!codec) throw new MediaKitError(`unsupported audio format: ${ext}`, "INVALID_ARG");
  // Single-pass loudnorm: fast, good enough for speech/creator audio.
  // Two-pass is more precise; see SKILL.md if you need broadcast exactness.
  await run(FFMPEG, [
    "-y", "-i", inPath,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11`,
    "-ar", "48000", "-c:v", "copy", "-c:a", codec, outPath,
  ]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "loudness", input: inPath, output: outPath, target_lufs: target, format: ext, ...info, duration_seconds: out.duration_seconds };
}

// ---------------------------------------------------------------- concat

export async function concat({ inputs, output, videoCodec = "libx264", audioCodec = "aac" }) {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    throw new MediaKitError("concat needs at least 2 input files", "INVALID_ARG");
  }
  const inPaths = [];
  for (const p of inputs) inPaths.push(await requireInput(p, "concat input"));
  const outPath = await prepareOutput(output, inPaths);
  // Concat demuxer with re-encode: safe across differing codecs/sizes.
  // The list file is written to a temp file in the output directory.
  const listPath = path.join(path.dirname(outPath), `.mediakit-concat-${Date.now()}.txt`);
  const { writeFile, unlink } = await import("node:fs/promises");
  const listContent = inPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  await writeFile(listPath, listContent, "utf8");
  try {
    await run(FFMPEG, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:v", videoCodec, "-c:a", audioCodec, "-movflags", "+faststart", outPath,
    ]);
  } finally {
    await unlink(listPath).catch(() => {});
  }
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "concat", inputs: inPaths, output: outPath, parts: inPaths.length, ...info, duration_seconds: out.duration_seconds };
}

// ---------------------------------------------------------------- burn_captions

export async function burnCaptions({ input, output, captions, fontSize = 24, fontColor = "white", box = true }) {
  const inPath = await requireInput(input);
  const capPath = await requireInput(captions, "captions file");
  const outPath = await prepareOutput(output, [inPath]);
  const ext = path.extname(capPath).toLowerCase();
  if (![".srt", ".ass", ".vtt"].includes(ext)) {
    throw new MediaKitError(`captions must be .srt/.ass/.vtt, got ${ext}`, "INVALID_ARG");
  }
  const size = num(fontSize, "font_size", { min: 8, max: 200, integer: true });
  // libass scales FontSize against the ASS PlayRes (default 384x288) when
  // converting SRT -> ASS, so a "48px" font would render ~6x too big on
  // a 1080x1920 frame. Pin PlayRes to the real video size so FontSize
  // means actual pixels.
  const meta = await probe(inPath);
  const vw = meta.video?.width ?? 1280;
  const vh = meta.video?.height ?? 720;
  // libass handles .ass natively; for .srt/.vtt use subtitles filter.
  // Escape : and ' inside the filter argument the ffmpeg way.
  const esc = capPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  let vf;
  if (ext === ".ass") {
    vf = `ass='${esc}'`;
  } else {
    const forceStyle = `PlayResX=${vw},PlayResY=${vh},FontSize=${size},PrimaryColour=&HFFFFFF&,OutlineColour=&H80000000&,BorderStyle=${box ? 3 : 1},BackColour=&H80000000&,Outline=2,Shadow=0,MarginV=40`;
    const color = fontColor.toLowerCase() === "white" ? "" : `,PrimaryColour=&H${fontColor}&`;
    vf = `subtitles='${esc}':force_style='${forceStyle}${color}'`;
  }
  await run(FFMPEG, ["-y", "-i", inPath, "-vf", vf, "-c:a", "copy", outPath]);
  const info = await fileInfo(outPath);
  const out = await probe(outPath);
  return { operation: "burn_captions", input: inPath, output: outPath, captions: capPath, font_size: size, ...info, duration_seconds: out.duration_seconds };
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
