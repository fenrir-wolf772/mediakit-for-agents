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

// ---------------------------------------------------------------- reframe
// One-step aspect reframe: 16:9 -> 9:16 (or any target aspect/size).
// mode "crop": cut the target aspect out of the source (centre, or the
// anchor x/y = top-left of the crop window), then scale to target size.
// mode "pad": scale the whole frame to fit inside the target and add
// black bars. mode "blur": same fit, but the empty area is filled with
// a blurred, darkened copy of the frame (the Shorts/Reels look).

export async function reframe({ input, output, width = 1080, height = 1920, mode = "crop", x = null, y = null, blur = 20 }) {
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
  if (mode === "crop") {
    // Crop window with the target aspect, as large as fits in the source.
    let cw, ch;
    if (srcAspect > targetAspect) { ch = sh; cw = Math.floor((sh * targetAspect) / 2) * 2; }
    else { cw = sw; ch = Math.floor((sw / targetAspect) / 2) * 2; }
    const maxX = sw - cw;
    const maxY = sh - ch;
    const ox = x === null || x === undefined ? Math.floor(maxX / 2) : num(x, "x", { min: 0, max: maxX, integer: true });
    const oy = y === null || y === undefined ? Math.floor(maxY / 2) : num(y, "y", { min: 0, max: maxY, integer: true });
    cropRect = { width: cw, height: ch, x: ox, y: oy };
    vf = `crop=${cw}:${ch}:${ox}:${oy},scale=${tw}:${th}`;
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
  },
  reels: {
    label: "Instagram Reels", width: 1080, height: 1920, maxDuration: 900,
    videoCodecs: ["h264"], audioCodecs: ["aac"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
  },
  shorts: {
    label: "YouTube Shorts", width: 1080, height: 1920, maxDuration: 180,
    videoCodecs: ["h264", "vp9", "av1"], audioCodecs: ["aac", "opus"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
  },
  youtube: {
    label: "YouTube (long-form)", width: 1920, height: 1080, maxDuration: null,
    videoCodecs: ["h264", "vp9", "av1"], audioCodecs: ["aac", "opus"], maxChannels: 2,
    lufs: [-16, -12], fps: [23, 61],
  },
};

/** Measure integrated loudness with a loudnorm analysis pass (no output file). */
export async function measureLoudness(input) {
  const { stderr } = await run(FFMPEG, [
    "-i", input, "-vn",
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ]);
  const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const v = parseFloat(j.input_i);
    return Number.isFinite(v) ? +v.toFixed(1) : null;
  } catch {
    return null;
  }
}

export async function check({ input, platform = "tiktok" }) {
  const inPath = await requireInput(input);
  const spec = PLATFORMS[platform];
  if (!spec) throw new MediaKitError(`unknown platform: ${platform} (supported: ${Object.keys(PLATFORMS).join(", ")})`, "INVALID_ARG");
  const meta = await probe(inPath);
  const checks = [];
  const add = (name, expected, actual, pass, hint = null) =>
    checks.push({ name, expected, actual, pass, ...(hint ? { hint } : {}) });

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
  } else {
    add("dimensions", `${spec.width}x${spec.height}`, "no video stream", false);
  }
  if (meta.duration_seconds !== null && spec.maxDuration !== null) {
    add("duration", `<= ${spec.maxDuration}s`, `${meta.duration_seconds}s`,
      meta.duration_seconds <= spec.maxDuration,
      "trim to fit the platform limit");
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
  const failed = checks.filter((c) => !c.pass);
  return {
    operation: "check", input: inPath, platform, platform_label: spec.label,
    pass: failed.length === 0,
    checks,
    ...(failed.length ? { issues: failed.map((c) => `${c.name}: ${c.actual} (want ${c.expected})${c.hint ? ` — ${c.hint}` : ""}`) } : {}),
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
  "drawtext", "volume",
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
  concat: { filters: ["concat"] },
  burn_captions: { filters: ["subtitles", "ass"] },
  reframe: { filters: ["crop", "scale", "pad", "gblur", "overlay"], encoders: ["libx264"] },
  check: { filters: ["loudnorm"] },
  convert: { encoders: ["libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4"] },
  silence: { filters: ["silencedetect", "trim", "atrim", "concat"], encoders: ["libx264", "aac"] },
  cropdetect: { filters: ["cropdetect"] },
  package: {},
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
