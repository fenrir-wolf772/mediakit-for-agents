#!/usr/bin/env node
/**
 * mediakit-for-agents — MCP server (stdio transport).
 * Exposes the ffmpeg core as tools for Claude Code / Cursor / Codex.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as core from "./core.js";

const server = new McpServer({
  name: "mediakit-for-agents",
  version: "0.1.0",
});

function result(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

async function safe(fn) {
  try {
    return result(await fn());
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message, code: err.code ?? "ERROR" }, null, 2) }],
      isError: true,
    };
  }
}

// Errors end with the exact retry command (kinocut's eyes-free design
// law, backlog since turn 2): every tool error carries
// `retry: {tool, arguments}` so an agent can re-issue the identical
// call instead of reconstructing it from the message. One choke point
// here — the per-tool handlers keep calling safe() unchanged, and this
// wrapper enriches any isError result with the tool name + the exact
// arguments the call carried (zod defaults already applied).
const registerTool = server.tool.bind(server);
server.tool = (name, description, schema, handler) => registerTool(name, description, schema, async (a) => {
  const res = await handler(a);
  if (res && res.isError) {
    try {
      const body = JSON.parse(res.content?.[0]?.text ?? "");
      if (body && typeof body === "object" && body.error) {
        body.retry = { tool: name, arguments: a };
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
      }
    } catch { /* error text is not JSON — leave it as-is */ }
  }
  return res;
});

const pathSchema = z.string().min(1).describe("Path to the file (relative or absolute)");

server.tool(
  "probe",
  "Inspect a media file with ffprobe: duration, dimensions, codecs, streams.",
  { input: pathSchema },
  async ({ input }) => safe(() => core.probe(input)),
);

server.tool(
  "trim",
  "Cut a clip out of a media file. Give start (seconds) plus duration OR end. Re-encodes by default for frame-accurate cuts; set stream_copy=true for fast lossless cuts (keyframe boundaries only). With stream_copy, set snap_to_keyframe=true to move start down / end up to the nearest keyframes so the cut lands exactly (see the keyframes tool first).",
  {
    input: pathSchema,
    output: pathSchema.describe("Output file path"),
    start: z.number().min(0).default(0).describe("Start time in seconds"),
    duration: z.number().positive().optional().describe("Clip length in seconds"),
    end: z.number().positive().optional().describe("End time in seconds (alternative to duration)"),
    stream_copy: z.boolean().default(false).describe("Copy streams without re-encoding (fast, keyframe-accurate only)"),
    snap_to_keyframe: z.boolean().default(false).describe("With stream_copy only: snap start/end to the nearest keyframes (start down, end up)"),
  },
  async (a) => safe(() => core.trim({
    input: a.input,
    output: a.output,
    start: a.start,
    duration: a.duration ?? null,
    end: a.end ?? null,
    streamCopy: a.stream_copy,
    snapToKeyframe: a.snap_to_keyframe,
  })),
);

server.tool(
  "crop",
  "Crop a video to a rectangle. width/height/x/y in pixels; must fit inside the source frame.",
  {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(2),
    height: z.number().int().min(2),
    x: z.number().int().min(0).default(0),
    y: z.number().int().min(0).default(0),
  },
  async (a) => safe(() => core.crop(a)),
);

server.tool(
  "resize",
  "Resize a video. Give width and/or height; with keep_aspect (default) the other dimension follows the aspect ratio and is rounded to an even number. Or give preset (360p/480p/720p/1080p/2160p): the frame is fit inside that box, preserving aspect, and never upscaled.",
  {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(2).optional(),
    height: z.number().int().min(2).optional(),
    keep_aspect: z.boolean().default(true),
    preset: z.enum(["360p", "480p", "720p", "1080p", "2160p"]).optional().describe("Named preset box: 360p=640x360, 480p=854x480, 720p=1280x720, 1080p=1920x1080, 2160p=3840x2160; fit inside, never upscale; cannot combine with width/height"),
  },
  async (a) => safe(() => core.resize({
    input: a.input,
    output: a.output,
    width: a.width ?? null,
    height: a.height ?? null,
    keepAspect: a.keep_aspect,
    preset: a.preset ?? null,
  })),
);

server.tool(
  "extract_audio",
  "Extract the audio track to mp3, aac, wav, ogg, opus or flac (from the output extension). Set whisper=true for the Whisper ASR preset: 16 kHz mono WAV (the output is renamed to .wav when needed) — the direct input for a transcribe step. Set channel (0-based) to pick one channel out of a multi-channel input and return it as mono.",
  {
    input: pathSchema,
    output: pathSchema,
    format: z.enum(["mp3", "aac", "wav", "ogg", "opus", "flac"]).optional().describe("Overrides the output extension (ignored when whisper=true)"),
    whisper: z.boolean().default(false).describe("Whisper preset: force 16 kHz mono WAV, rename output to .wav"),
    channel: z.number().int().min(0).max(63).optional().describe("Channel index (0-based) to extract as mono from a multi-channel input; refused when out of range"),
  },
  async (a) => safe(() => core.extractAudio({
    input: a.input,
    output: a.output,
    format: a.format ?? null,
    whisper: a.whisper,
    channel: a.channel ?? null,
  })),
);

server.tool(
  "extract_frame",
  "Grab a single frame at a timestamp as PNG/JPG/WebP.",
  {
    input: pathSchema,
    output: pathSchema,
    timestamp: z.number().min(0).default(0).describe("Timestamp in seconds"),
  },
  async (a) => safe(() => core.extractFrame(a)),
);

server.tool(
  "thumbnail",
  "Build a contact sheet: N evenly spaced frames tiled into a grid image. Each tile is labelled with its own timestamp in seconds (timestamps=true by default), so the sheet shows WHEN each frame is, not just what it shows — look at it before cutting or publishing.",
  {
    input: pathSchema,
    output: pathSchema,
    frames: z.number().int().min(1).max(64).default(6),
    columns: z.number().int().min(1).max(8).default(3),
    width: z.number().int().min(80).max(1280).default(320).describe("Width of each tile in pixels"),
    timestamps: z.boolean().default(true).describe("Label each tile with its timestamp in seconds (drawtext %{pts}); set false for a clean sheet"),
  },
  async (a) => safe(() => core.thumbnail(a)),
);

server.tool(
  "loudness",
  "Normalize loudness to a target (default -14 LUFS, the YouTube/Spotify standard) with two-pass loudnorm: the input is measured first, then the exact linear gain is applied, and the output is re-measured on disk. Pass compressor=true for quiet, high-crest speech (a gentle compressor, threshold -24 dB / ratio 4 by default, runs before the loudnorm pass — without it a peak-limited voice stalls below target and the result says so in `warning`). Good for speech and creator audio.",
  {
    input: pathSchema,
    output: pathSchema,
    target_lufs: z.number().min(-70).max(0).default(-14),
    format: z.enum(["mp3", "aac", "wav", "ogg", "opus", "flac"]).optional(),
    compressor: z.boolean().optional().describe("Run a gentle compressor (threshold -24 dB, ratio 4, peak detection) before the loudnorm pass — for quiet, high-crest speech that two-pass alone cannot lift to target"),
    compressor_threshold: z.number().min(-60).max(0).optional().describe("Compressor threshold in dB (default -24, only with compressor=true)"),
    compressor_ratio: z.number().min(1).max(20).optional().describe("Compressor ratio (default 4, only with compressor=true)"),
  },
  async (a) => safe(() => core.loudness({
    input: a.input,
    output: a.output,
    targetLufs: a.target_lufs,
    format: a.format ?? null,
    compressor: a.compressor ? { threshold_db: a.compressor_threshold ?? -24, ratio: a.compressor_ratio ?? 4 } : null,
  })),
);

server.tool(
  "concat",
  "Join 2+ media files into one. By default it probes the clips first: identical clips (codec, size, fps, audio) are stream-copied with no re-encoding (fast, lossless); differing clips are re-encoded so the join still works. Set fast=true to require the stream-copy path (errors with the exact mismatch if clips differ), or fast=false to always re-encode. Set transition (e.g. fade, wipeleft, dissolve, circlecrop) to crossfade between clips instead of a hard cut — clips are normalized to the first clip's size/fps first, and the output is sum(durations) minus (n-1) x transition_duration. Per-clip trim: give an input as {file, start, end} (seconds or MM:SS) — trims always re-encode with exact cuts, and fast=true refuses them (stream-copy cuts snap to keyframes).",
  {
    inputs: z.array(z.union([
      z.string().min(1),
      z.object({
        file: z.string().min(1),
        start: z.union([z.number(), z.string()]).optional().describe("Trim start in seconds or MM:SS (omit = clip start)"),
        end: z.union([z.number(), z.string()]).optional().describe("Trim end in seconds or MM:SS (omit = clip end)"),
      }),
    ])).min(2).describe("Files in order; each may be a plain path or {file, start, end} to trim that clip"),
    output: pathSchema,
    video_codec: z.string().default("libx264"),
    audio_codec: z.string().default("aac"),
    transition: z.string().optional().describe("xfade transition between clips: fade, fadeblack, wipeleft, wiperight, slideleft, dissolve, pixelize, circlecrop, ... (omit for a hard cut)"),
    transition_duration: z.number().min(0.1).max(10).default(1).describe("Transition length in seconds (must be shorter than the shortest clip)"),
    fast: z.boolean().optional().describe("true = require stream-copy (error if clips differ), false = always re-encode, omit = auto-detect (copy when identical, re-encode otherwise)"),
  },
  async (a) => safe(() => core.concat({
    inputs: a.inputs,
    output: a.output,
    videoCodec: a.video_codec,
    audioCodec: a.audio_codec,
    transition: a.transition ?? null,
    transitionDuration: a.transition_duration,
    fast: a.fast ?? null,
  })),
);

server.tool(
  "frames",
  "Extract N evenly spaced frames as separate image files (frame-001.png, ...) into a directory, each with its timestamp — so you can actually look at what is in a video before cutting it. One frame per interval; timestamps are i * duration / count.",
  {
    input: pathSchema,
    output_dir: pathSchema.describe("Directory to write the frame files into (created if needed)"),
    count: z.number().int().min(1).max(120).default(6).describe("Number of frames to extract"),
    format: z.enum(["png", "jpg", "webp"]).default("png"),
    width: z.number().int().min(80).max(3840).optional().describe("Scale frames to this width (keeps aspect)"),
  },
  async (a) => safe(() => core.extractFrames({
    input: a.input,
    outputDir: a.output_dir,
    count: a.count,
    format: a.format,
    width: a.width ?? null,
  })),
);

server.tool(
  "burn_captions",
  "Burn subtitles into the video (hardcoded, always visible). Accepts .srt, .ass or .vtt. Style: background (default — white text on a semi-transparent black box), outline (black outline, no box), shadow (thin outline + drop shadow), or glow (thick halo in the text's own colour, reads on bright footage). Defaults scale with frame height: ~60px type on 1080x1920, sitting ~500px above the bottom edge so platform UI (bottom ~480px) never covers the text. Explicit font_size / margin_v override. .ass files carry their own styles, so style is ignored there (style_applied=false).",
  {
    input: pathSchema,
    output: pathSchema,
    captions: pathSchema.describe("Path to the .srt/.ass/.vtt file"),
    font_size: z.number().int().min(8).max(200).optional().describe("Font size in px; default scales with frame height (~60px at 1920 high)"),
    margin_v: z.number().int().min(0).optional().describe("Distance from bottom edge in px; default is 26% of frame height (above platform UI)"),
    style: z.enum(["background", "outline", "shadow", "glow"]).optional().describe("Caption style; default background (boxed). Ignored for .ass inputs"),
    outline_color: z.string().optional().describe("Outline colour for outline/shadow styles: name (white/black/yellow/cyan/red/green/blue/orange/magenta) or RRGGBB hex; default black"),
  },
  async (a) => safe(() => core.burnCaptions({
    input: a.input,
    output: a.output,
    captions: a.captions,
    fontSize: a.font_size ?? null,
    marginV: a.margin_v ?? null,
    style: a.style ?? null,
    outlineColor: a.outline_color ?? "black",
  })),
);

server.tool(
  "reframe",
  "Reframe a video to a target aspect/size in one step (e.g. 16:9 to 9:16 vertical 1080x1920). mode crop cuts the target aspect out (centre, or x/y anchor, or a named anchor: left/right/top/bottom/top-left/... to keep an edge subject in frame); pad letterboxes with black bars; blur fills the empty area with a blurred copy of the frame. Crop mode reports crop_kept_percent and warns below 40% kept (upscaled, may look soft).",
  {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(2).default(1080).describe("Target width in pixels (must be even)"),
    height: z.number().int().min(2).default(1920).describe("Target height in pixels (must be even)"),
    mode: z.enum(["crop", "pad", "blur"]).default("crop"),
    x: z.number().int().min(0).optional().describe("Crop anchor: left offset of the crop window (crop mode only)"),
    y: z.number().int().min(0).optional().describe("Crop anchor: top offset of the crop window (crop mode only)"),
    anchor: z.enum(["center", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"]).optional().describe("Named crop anchor (crop mode only); explicit x/y win over it"),
    blur: z.number().min(0).max(100).default(20).describe("Blur strength for the background fill (blur mode only)"),
  },
  async (a) => safe(() => core.reframe(a)),
);

server.tool(
  "check",
  "Verify a finished file against a platform delivery spec (tiktok, reels, shorts, youtube): dimensions, codecs, fps, duration limit, audio channels and measured loudness, plus a file-size limit where the platform has one. Video bitrate is checked as a warning only (platforms publish recommendations, not gates) and the result also reports the platform's text-safe zone. With content=true, one extra decode pass scans for black frames, frozen frames, silence and audio peaks (0.1s windows above peak_threshold_db, default -1 dBFS; >= 0 dBFS is clipping) and folds them into the same pass/fail list with position-aware rules (a short black stretch at the very start/end is a warning — likely a fade — the same stretch mid-file fails). content_start/content_end (seconds) scan only that time range, reported on the file's own timeline. Returns pass/fail per rule with fix hints. Run this before publishing.",
  {
    input: pathSchema,
    platform: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin"]).default("tiktok"),
    content: z.boolean().default(false).describe("Also scan content: black/frozen frames, silence and audio peaks; adds content_black/content_freeze/content_silence/content_peaks rules"),
    content_start: z.number().min(0).optional().describe("Scan only from this time (seconds); needs content=true"),
    content_end: z.number().min(0).optional().describe("Scan only up to this time (seconds); needs content=true"),
    peak_threshold_db: z.number().min(-60).max(12).default(-1).describe("Audio peak threshold in dBFS for the content_peaks rule (windows above it are reported; >= 0 dBFS is clipping; float audio can peak above 0)"),
  },
  async (a) => safe(() => core.check({
    input: a.input,
    platform: a.platform,
    content: a.content,
    contentStart: a.content_start ?? null,
    contentEnd: a.content_end ?? null,
    peakThresholdDb: a.peak_threshold_db,
  })),
);

server.tool(
  "qa_report",
  "One-call delivery gate for a finished file: even dimensions, yuv420p pixel format, frame rate, aspect ratio and length for the target (tiktok, reels, shorts, youtube, instagram-feed, instagram-story, linkedin, or any for a platform-free file), measured loudness in -16..-12 LUFS and true peak, black/frozen frames and dead air (silence over 2s), pacing (average shot length from real scene cuts), and an optional expected duration. Probe-only — writes no file. Returns one verdict (pass/warn/fail) plus a per-check list with details; run this, plus thumbnail, on every deliverable before calling it done.",
  {
    input: pathSchema,
    target: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin", "any"]).default("any").describe("Delivery target; 'any' skips aspect ratio and platform length"),
    expected_duration: z.number().min(0).optional().describe("Expected duration in seconds (fail when the measured duration is more than 0.5s off)"),
  },
  async (a) => safe(() => core.qaReport({
    input: a.input,
    target: a.target,
    expectedDuration: a.expected_duration ?? null,
  })),
);

server.tool(
  "grade",
  "Color-grade a video with a named preset (warm, cool, cinematic, noir, vintage) or one custom video filter chain (--filter). Re-encodes video (libx264, crf 23 default), copies audio through untouched. The result reports the filter actually applied and the mean R/G/B of the middle frame before and after, measured on disk — so the grade is verified on pixels, not assumed from the filter string. Presets are fixed chains: warm pushes red and pulls blue, cool does the opposite, noir is black-and-white, vintage is faded and desaturated.",
  {
    input: pathSchema,
    output: pathSchema,
    preset: z.enum(["warm", "cool", "cinematic", "noir", "vintage"]).optional().describe("Named grade preset (default warm when neither preset nor filter is given; mutually exclusive with filter)"),
    filter: z.string().optional().describe("One custom video filter chain, e.g. 'eq=saturation=0.5' (mutually exclusive with preset)"),
    crf: z.number().int().min(0).max(51).default(23),
    cdl: z.object({
      slope: z.array(z.number().min(0).max(4)).length(3).optional().describe("ASC CDL slope per channel [r, g, b] (0-4, default 1,1,1)"),
      offset: z.array(z.number().min(-1).max(1)).length(3).optional().describe("ASC CDL offset per channel [r, g, b] (-1 to 1, default 0,0,0)"),
      power: z.array(z.number().min(0.1).max(4)).length(3).optional().describe("ASC CDL power (gamma) per channel [r, g, b] (0.1-4, default 1,1,1)"),
      saturation: z.number().min(0).max(4).optional().describe("ASC CDL saturation (0-4, 0 = grayscale, 1 = unchanged, default 1)"),
    }).optional().describe("ASC CDL grade (mutually exclusive with preset and filter); applied per channel with a LUT, saturation on top"),
  },
  async (a) => safe(() => core.grade({
    input: a.input,
    output: a.output,
    preset: a.preset ?? null,
    filter: a.filter ?? null,
    crf: a.crf,
    cdl: a.cdl ?? null,
  })),
);

server.tool(
  "reverse",
  "Play a clip backwards: video frames reversed with the `reverse` filter, audio reversed with `areverse` (on by default; set audio false to keep the audio playing forward under reversed video). Re-encodes video (libx264, crf 23 default). The `reverse` filter buffers every frame, so very long inputs cost memory. The result reports whether video/audio were actually reversed, plus duration measured on disk.",
  {
    input: pathSchema,
    output: pathSchema,
    audio: z.boolean().default(true).describe("Reverse the audio too (default true); false copies the audio forward under the reversed video"),
    crf: z.number().int().min(0).max(51).default(23),
  },
  async (a) => safe(() => core.reverseClip({
    input: a.input,
    output: a.output,
    audio: a.audio,
    crf: a.crf,
  })),
);

server.tool(
  "chroma_key",
  "Remove a green/blue screen: keys out one color (chromakey filter) and either keeps the transparency (output MUST be .mov, ProRes 4444 — .mp4 has no alpha channel, and this ffmpeg build drops VP9 alpha in .webm) or composites the subject onto a background in the same call (image file or hex color, output .mp4/.webm). similarity 0-1 is the tolerance (too high eats the subject), blend 0-1 softens the edge. The result measures the alpha on disk (middle frame, 0-255): full-frame mean plus corner (should be ~0 for a full-screen key) and center (should be ~255 on the subject).",
  {
    input: pathSchema,
    output: pathSchema.describe("Output file path: .mov for transparency, .mp4/.webm when background is given"),
    color: z.string().default("00FF00").describe("Key color as 6-digit hex (default 00FF00 green; 0000FF for blue)"),
    similarity: z.number().min(0).max(1).default(0.1).describe("Color tolerance 0-1 (default 0.1)"),
    blend: z.number().min(0).max(1).default(0).describe("Edge blend 0-1 (default 0)"),
    background: z.string().optional().describe("Optional background to composite onto: an image file path, or a hex color (e.g. 1E40AF). Without it the output keeps transparency and must be .mov"),
    crf: z.number().int().min(0).max(51).default(23),
  },
  async (a) => safe(() => core.chromaKey({
    input: a.input,
    output: a.output,
    color: a.color,
    similarity: a.similarity,
    blend: a.blend,
    background: a.background ?? null,
    crf: a.crf,
  })),
);

server.tool(
  "zoom_pan",
  "Ken Burns effect: turn a still image into a moving clip (zoompan filter). Zooms linearly from zoom_from to zoom_to while the focus point moves from (focus_x, focus_y) to (focus_end_x, focus_end_y) — all 0-1 fractions of the frame, 0.5 is center. The input is pre-scaled 1.25x before zooming (avoids the integer-crop jitter zoompan is known for). Input must be a still image, not a video. The result counts frames on the output file, so duration and fps are measured, not assumed.",
  {
    input: pathSchema.describe("Still image file (PNG/JPG/WebP)"),
    output: pathSchema,
    duration: z.number().min(0.5).max(600).default(5).describe("Clip length in seconds (default 5)"),
    fps: z.number().int().min(1).max(120).default(30).describe("Output frame rate (default 30)"),
    zoom_from: z.number().min(1).max(10).default(1).describe("Zoom at the first frame, 1 = full image (default 1)"),
    zoom_to: z.number().min(1).max(10).default(1.5).describe("Zoom at the last frame (default 1.5)"),
    focus_x: z.number().min(0).max(1).default(0.5).describe("Focus point x at the first frame, 0-1 (default 0.5 center)"),
    focus_y: z.number().min(0).max(1).default(0.5).describe("Focus point y at the first frame, 0-1 (default 0.5 center)"),
    focus_end_x: z.number().min(0).max(1).optional().describe("Focus point x at the last frame (default = focus_x)"),
    focus_end_y: z.number().min(0).max(1).optional().describe("Focus point y at the last frame (default = focus_y)"),
    width: z.number().int().min(2).max(7680).default(1280).describe("Output width in pixels, even (default 1280)"),
    height: z.number().int().min(2).max(4320).default(720).describe("Output height in pixels, even (default 720)"),
    crf: z.number().int().min(0).max(51).default(23),
  },
  async (a) => safe(() => core.zoomPan({
    input: a.input,
    output: a.output,
    duration: a.duration,
    fps: a.fps,
    zoomFrom: a.zoom_from,
    zoomTo: a.zoom_to,
    focusX: a.focus_x,
    focusY: a.focus_y,
    focusEndX: a.focus_end_x ?? null,
    focusEndY: a.focus_end_y ?? null,
    width: a.width,
    height: a.height,
    crf: a.crf,
  })),
);

server.tool(
  "image_to_video",
  "Turn one still image into a fixed-duration video that holds still (no motion — use zoom_pan for Ken Burns). Use it for a podcast still, a song cover, or a title card held over audio. Dimensions default to the image itself; width/height fit the image inside the box and pad black to the exact size. audio loops an audio file to the same duration (a short bed loops, a long one is trimmed). Output .mp4 (H.264) or .webm (VP9). The result counts frames on the output file, so the duration is measured, not assumed.",
  {
    input: pathSchema.describe("Still image file (PNG/JPG/WebP)"),
    output: pathSchema,
    duration: z.number().min(0.5).max(600).default(5).describe("Clip length in seconds (default 5)"),
    fps: z.number().int().min(1).max(120).default(30).describe("Output frame rate (default 30)"),
    width: z.number().int().min(2).max(7680).optional().describe("Output width in pixels, rounded down to even (default = image width)"),
    height: z.number().int().min(2).max(4320).optional().describe("Output height in pixels, rounded down to even (default = image height)"),
    audio: pathSchema.optional().describe("Audio file to loop under the still (optional)"),
    crf: z.number().int().min(0).max(51).default(23),
  },
  async (a) => safe(() => core.imageToVideo({
    input: a.input,
    output: a.output,
    duration: a.duration,
    fps: a.fps,
    width: a.width ?? null,
    height: a.height ?? null,
    audio: a.audio ?? null,
    crf: a.crf,
  })),
);

server.tool(
  "slideshow",
  "Turn 2-32 still images into one video with an xfade transition between every pair. Each image is visible for its own duration — the transition eats a handle, not slide time — so the total is exactly the sum of the durations. One transition type for all pairs (transition/transition_duration), or a different one per join: transitions (one xfade name per join, n-1 entries) and transition_durations (one length per join, each shorter than both slides it joins). Images are rendered to clips in parallel first, then joined with the concat xfade chain. audio loops a bed under the whole slideshow. Output .mp4 only in v1. The result counts frames on the output file, so the duration is measured, not assumed.",
  {
    images: z.array(z.union([
      z.string().describe("Image file path"),
      z.object({
        file: z.string().describe("Image file path"),
        duration: z.number().min(0.5).max(600).optional().describe("How long this image stays visible, in seconds (overrides duration/durations for this slide)"),
      }),
    ])).min(2).max(32).describe("Images in display order, as paths or {file, duration} objects"),
    output: pathSchema,
    duration: z.number().min(0.5).max(600).default(3).describe("Visible seconds per image when no per-image duration is given (default 3)"),
    durations: z.array(z.number().min(0.5).max(600)).min(2).max(32).optional().describe("One visible duration per image, in order (overrides duration; a per-image duration in images wins over this)"),
    transition: z.string().default("fade").describe("xfade transition between every pair: fade (default), fadeblack, wipeleft, dissolve, circlecrop, ... (one of the 49 names concat accepts)"),
    transition_duration: z.number().min(0.1).max(10).default(1).describe("Transition length in seconds (default 1, must be shorter than the shortest slide)"),
    transitions: z.array(z.string()).min(1).max(31).optional().describe("One xfade transition name per join, in order (n-1 entries for n images) — overrides transition when given"),
    transition_durations: z.array(z.number().min(0.1).max(10)).min(1).max(31).optional().describe("One transition length per join, in order (n-1 entries) — each must be shorter than both slides it joins; overrides transition_duration when given"),
    fps: z.number().int().min(1).max(120).default(30).describe("Output frame rate (default 30)"),
    width: z.number().int().min(2).max(7680).default(1280).describe("Output width in pixels (default 1280)"),
    height: z.number().int().min(2).max(4320).default(720).describe("Output height in pixels (default 720)"),
    audio: pathSchema.optional().describe("Audio file to loop under the whole slideshow (optional)"),
    crf: z.number().int().min(0).max(51).default(23),
  },
  async (a) => safe(() => core.slideshow({
    images: a.images,
    output: a.output,
    duration: a.duration,
    durations: a.durations ?? null,
    transition: a.transition,
    transitionDuration: a.transition_duration,
    transitions: a.transitions ?? null,
    transitionDurations: a.transition_durations ?? null,
    fps: a.fps,
    width: a.width,
    height: a.height,
    audio: a.audio ?? null,
    crf: a.crf,
  })),
);

server.tool(
  "interpolate",
  "Raise a clip's frame rate with motion interpolation (minterpolate): 30fps to 60fps for smoother playback or slow motion. Modes: blend (fast default, cross-fades neighbours), mci (true motion-compensated frames, best quality but much slower — about 9x realtime on CPU), dup (repeats frames). Only raises the frame rate; use fit --max-fps to lower it. The result counts frames on the output file, so the fps is measured, not assumed.",
  {
    input: pathSchema,
    output: pathSchema,
    fps: z.number().min(1).max(240).describe("Target frame rate, must be above the source fps"),
    mode: z.enum(["mci", "blend", "dup"]).default("blend").describe("Interpolation mode (default blend)"),
    crf: z.number().int().min(0).max(51).default(23),
  },
  async (a) => safe(() => core.interpolate({
    input: a.input,
    output: a.output,
    fps: a.fps,
    mode: a.mode,
    crf: a.crf,
  })),
);

server.tool(
  "denoise",
  "Reduce sensor noise on a video: hqdn3d (fast default) or nlmeans (better on fine detail, much slower — minutes for a few seconds of 720p). strength 0-1 maps to hqdn3d 0-30 (0.5 is 15, the strength that gained +2.9 dB PSNR on sigma-10 noise in testing) or nlmeans s 0-10. The result measures high-frequency noise energy before and after (mean |frame minus blurred frame|), so the reduction is measured, not assumed.",
  {
    input: pathSchema,
    output: pathSchema,
    filter: z.enum(["hqdn3d", "nlmeans"]).default("hqdn3d").describe("Denoise filter (default hqdn3d)"),
    strength: z.number().min(0).max(1).default(0.5).describe("Noise-reduction strength 0-1 (default 0.5)"),
    crf: z.number().int().min(0).max(51).default(23),
  },
  async (a) => safe(() => core.denoise({
    input: a.input,
    output: a.output,
    filter: a.filter,
    strength: a.strength,
    crf: a.crf,
  })),
);

server.tool(
  "segment",
  "Cut a video into an HLS VOD playlist: index.m3u8 plus .ts segments in an output directory, ready to serve statically or preview in a player. Stream-copy is the default (fast, lossless) but segments can only start on keyframes, so actual segment lengths follow the source GOP — a sparse-GOP source gives fewer, longer segments than requested; use reencode=true to re-encode to libx264/aac with forced keyframes so segments land exactly on the requested grid. Copy mode refuses non-H.264 video or non-AAC/MP3 audio up front. The result parses the playlist back from disk and stats every segment file, so the count and durations are measured, not assumed.",
  {
    input: pathSchema,
    output_dir: pathSchema.describe("Output directory for the playlist and .ts segments (created if needed)"),
    segment_time: z.number().min(1).max(60).default(6).describe("Target segment length in seconds (default 6)"),
    playlist: z.string().default("index.m3u8").describe("Playlist filename, must end .m3u8 (default index.m3u8)"),
    segment_prefix: z.string().default("seg").describe("Segment filename stem (default seg -> seg000.ts, seg001.ts, ...)"),
    reencode: z.boolean().default(false).describe("Re-encode to libx264/aac with forced keyframes for exact segment boundaries (default false = stream-copy)"),
    crf: z.number().int().min(0).max(51).default(23),
  },
  async (a) => safe(() => core.segment({
    input: a.input,
    outputDir: a.output_dir,
    segmentTime: a.segment_time,
    playlist: a.playlist,
    segmentPrefix: a.segment_prefix,
    reencode: a.reencode,
    crf: a.crf,
  })),
);

server.tool(
  "convert",
  "Change container or codec. Omit video_codec/audio_codec to stream-copy that stream. crf 23 is a good default for H.264. gop (frames) or gop_seconds sets an exact keyframe interval on re-encode (scene-cut keyframes disabled for libx264/libx265/mpeg4); the result measures the keyframes on the output file. A GOP is required for keyframe-snapped stream-copy cuts.",
  {
    input: pathSchema,
    output: pathSchema,
    video_codec: z.enum(["libx264", "libx265", "vp9", "av1", "mpeg4", "copy"]).optional(),
    audio_codec: z.string().optional().describe("e.g. aac, libmp3lame, copy"),
    crf: z.number().int().min(0).max(51).default(23),
    preset: z.string().default("medium"),
    gop: z.number().int().min(1).max(10000).optional().describe("Keyframe interval in frames (needs a video re-encode; mutually exclusive with gop_seconds)"),
    gop_seconds: z.number().min(0.1).max(3600).optional().describe("Keyframe interval in seconds, converted to frames from the source fps (mutually exclusive with gop)"),
  },
  async (a) => safe(() => core.convert({
    input: a.input,
    output: a.output,
    videoCodec: a.video_codec ?? null,
    audioCodec: a.audio_codec ?? null,
    crf: a.crf,
    preset: a.preset,
    gop: a.gop ?? null,
    gopSeconds: a.gop_seconds ?? null,
  })),
);

server.tool(
  "compress",
  "Shrink a file with one named quality preset instead of guessing CRF numbers: low (CRF 32), medium (CRF 26), high (CRF 20) or email-25mb (targets 18 MB so the file still fits a 25 MB email attachment after base64 inflation), each with its own x264 preset and audio bitrate. Optional max_width scales the video down first. Set target_size_mb to hit an exact size instead (e.g. 10 for a Discord upload): two-pass ABR encoding from the size + duration budget, with a 10% safety margin; reports target_met measured on disk. In target-size mode a resolution ladder steps the frame down (1080→720→480→360→240) when the bitrate buys less than 0.045 bits per pixel per frame, so a starved encode stays watchable instead of mush; set resolution_ladder=false to keep the source frame. target_size_mb ignores quality and cannot be combined with crf. Returns the size before/after and the reduction percent actually measured on disk, so the agent can check the tradeoff worked.",
  {
    input: pathSchema,
    output: pathSchema.describe("Output file path"),
    quality: z.enum(["low", "medium", "high", "email-25mb"]).default("medium").describe("Size/quality tradeoff: low = smallest, high = best quality, email-25mb = target 18 MB for a 25 MB email attachment (ignored when target_size_mb is set)"),
    max_width: z.number().int().min(16).optional().describe("Scale video down to this width first (only when the source is wider)"),
    crf: z.number().int().min(0).max(51).optional().describe("Override the preset's CRF (cannot combine with target_size_mb)"),
    preset: z.string().optional().describe("Override the preset's x264 preset (ultrafast..veryslow)"),
    target_size_mb: z.number().min(0.05).max(10000).optional().describe("Target size in decimal MB (1 MB = 1,000,000 bytes): two-pass encode to fit under it"),
    resolution_ladder: z.boolean().default(true).describe("In target-size mode, step the frame down when the bitrate buys less than 0.045 bits per pixel per frame (default true; false keeps the source frame)"),
  },
  async (a) => safe(() => core.compress({
    input: a.input,
    output: a.output,
    quality: a.quality,
    maxWidth: a.max_width ?? null,
    crf: a.crf ?? null,
    preset: a.preset ?? null,
    targetSizeMb: a.target_size_mb ?? null,
    resolutionLadder: a.resolution_ladder ?? true,
  })),
);

server.tool(
  "silence",
  "Remove silent stretches from speech/video. Detects silence with silencedetect, keeps the speech plus a margin of silence on each side (so words are never clipped), then cuts and re-joins — every kept segment gets a 12ms fade out + 15ms fade in at the join, so a cut mid-tone has no click. Set detect_only=true to just report the silence/kept segments without writing a file. Returns removed_seconds and the kept segment list — verify those before trusting the cut.",
  {
    input: pathSchema,
    output: pathSchema.optional().describe("Output file path (not needed with detect_only=true)"),
    threshold_db: z.number().min(-90).max(0).default(-40).describe("Silence threshold in dB (more negative = stricter)"),
    min_duration: z.number().min(0.05).max(60).default(0.5).describe("Minimum silence length in seconds to cut"),
    margin: z.number().min(0).max(5).default(0.2).describe("Seconds of silence kept around each speech segment"),
    detect_only: z.boolean().default(false).describe("Report silence/kept segments without writing output"),
  },
  async (a) => safe(() => core.silence({
    input: a.input,
    output: a.output ?? null,
    thresholdDb: a.threshold_db,
    minDuration: a.min_duration,
    margin: a.margin,
    detectOnly: a.detect_only,
  })),
);

server.tool(
  "cropdetect",
  "Measure letterbox/pillarbox black bars with the cropdetect filter: samples frames and returns the most common crop rectangle plus a ready-to-run mediakit crop command. Run before crop/reframe when the source may have black bars.",
  {
    input: pathSchema,
    frames: z.number().int().min(1).max(300).default(30).describe("Frames to sample across the file"),
    limit: z.number().int().min(0).max(255).default(24).describe("Black threshold (0-255, higher = stricter)"),
  },
  async (a) => safe(() => core.cropdetect(a)),
);

server.tool(
  "package",
  "Bundle a finished file for delivery: a ZIP with the media, spec.json (measured probe + loudness + optional platform check receipt), checksums.sha256, and the captions sidecar when given. Run after check passes, before publishing.",
  {
    input: pathSchema,
    output: pathSchema.describe("Output .zip path"),
    captions: pathSchema.optional().describe("Optional .srt/.ass/.vtt file to include in the bundle"),
    platform: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin"]).optional().describe("If given, run check for this platform and record the result in spec.json"),
  },
  async (a) => safe(() => core.packageDelivery(a)),
);

server.tool(
  "receipt",
  "Write a provenance receipt (JSON sidecar) for a finished file: probe data, SHA-256, size, measured loudness, optional platform check result, and the exact ffmpeg/ffprobe versions that produced it. Re-run sha256sum against the receipt any time to prove the media has not changed since it was written.",
  {
    input: pathSchema,
    output: pathSchema.describe("Output .json path for the receipt"),
    platform: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin"]).optional().describe("If given, run check for this platform and record the result in the receipt"),
  },
  async (a) => safe(() => core.receipt(a)),
);

server.tool(
  "convert_captions",
  "Convert a subtitle file between SRT and VTT (pure text, no ffmpeg). Cue text is carried verbatim; VTT cue settings (line:/position:/align:) are dropped on the way to SRT and counted in settings_dropped. The output format comes from the output extension; converting a file to its own format is refused.",
  {
    input: pathSchema.describe("Input subtitle file (.srt or .vtt)"),
    output: pathSchema.describe("Output subtitle file (.vtt or .srt — must differ from the input format)"),
  },
  async (a) => safe(() => core.convertCaptions(a)),
);

server.tool(
  "generate_srt",
  "Build a deterministic .srt subtitle file from a cue list [{start, end, text}] — pure text, no ffmpeg. Times accept seconds or \"MM:SS\" / \"HH:MM:SS\". Cues must be in order and must not overlap (touching is fine); each text must be non-empty and may span lines with \\n. This is the input burn_captions wants. Or pass words [{start, end, word}] instead of cues: they are grouped into semantic cues (max 8 words, 3.5s, 84 chars / 2 lines of 42; split on pauses >0.4s and sentence ends; a cue never ends on a stranded word like 'the'/'of') and the grouping report is returned. Pass cues or words, never both.",
  {
    cues: z.array(z.object({
      start: z.union([z.number(), z.string()]).describe("Cue start: seconds or \"MM:SS\""),
      end: z.union([z.number(), z.string()]).describe("Cue end: seconds or \"MM:SS\" (must be after start)"),
      text: z.string().min(1).describe("Cue text (may contain \\n for multiple lines)"),
    })).min(1).max(10000).optional().describe("Cue list, in timeline order, non-overlapping. Omit when passing words."),
    words: z.array(z.object({
      start: z.union([z.number(), z.string()]).describe("Word start: seconds or \"MM:SS\""),
      end: z.union([z.number(), z.string()]).describe("Word end: seconds or \"MM:SS\" (must be after start)"),
      word: z.string().min(1).describe("One word (a single token, no spaces)"),
    })).min(1).max(80000).optional().describe("Word timings to group into semantic cues. Omit when passing cues."),
    output: pathSchema.describe("Output .srt file path"),
  },
  async (a) => safe(() => core.generateSrt({ cues: a.cues ?? null, words: a.words ?? null, output: a.output })),
);

server.tool(
  "publish_kit",
  "Thumbnail & Publishing Kit: from a finished video + a 1280x720 16:9 thumbnail + agent-written copy, write publishing/metadata.md and publishing.json and report a pre-publish checklist. Verifies what it can (thumbnail size, exactly 5 distinct 1-100-char titles, chapter times against the measured video duration, SHA-256 of media + thumbnail) and marks what it cannot verify as human-review (mobile readability, title/cover fidelity, licences) — never a pass. Flags unsupported-promise phrasing in titles as warnings. Does not publish or upload anything.",
  {
    input: pathSchema.describe("Finished video file"),
    thumbnail: pathSchema.describe("Thumbnail image, 16:9 and at least 1280px wide (e.g. 1280x720)"),
    output_dir: pathSchema.describe("Directory to write metadata.md + publishing.json into"),
    style: z.enum(["clean-bold", "minimal-line", "warm-story"]).optional().describe("Shorts style lock id from skills/shorts-video/styles.json, recorded in the kit (optional)"),
    titles: z.array(z.string().min(1).max(100)).length(5).describe("Exactly 5 distinct titles (the agent writes them; the tool only checks length/distinctness and flags hype phrasing)"),
    description: z.string().min(1).max(5000).describe("Video description (paste-ready)"),
    tags: z.array(z.string().min(1).max(50)).min(1).max(30).describe("1-30 tags"),
    pinned_comment: z.string().min(1).max(500).describe("One pinned comment: a genuine question for viewers"),
    chapters: z.array(z.object({
      time: z.union([z.number(), z.string()]).describe("Chapter time: seconds or \"MM:SS\" (must be inside the video, increasing)"),
      label: z.string().min(1).max(80).describe("Chapter label"),
    })).optional().describe("Optional chapters [{time, label}] — omitted when the final cut has no verified timeline"),
  },
  async (a) => safe(() => core.publishKit({
    input: a.input,
    thumbnail: a.thumbnail,
    outputDir: a.output_dir,
    style: a.style ?? null,
    titles: a.titles,
    description: a.description,
    tags: a.tags,
    pinnedComment: a.pinned_comment,
    chapters: a.chapters ?? null,
  })),
);

server.tool(
  "transcribe",
  "Transcribe speech to subtitles with a LOCAL engine (no cloud, audio never uploaded) — faster-whisper by default, or whisper.cpp with engine=\"whisper\". Writes a .srt and returns the segments with timestamps, detected language and full text — the direct input for burn_captions. The engine is optional: if no engine is installed the call fails with install lines (set MEDIAKIT_ASR_PYTHON to a python that has faster-whisper, or MEDIAKIT_WHISPER_CPP_BIN / MEDIAKIT_WHISPER_MODEL to a whisper.cpp binary + ggml model). Silence transcribes to 0 segments and an empty .srt.",
  {
    input: pathSchema.describe("Audio or video file with a speech track"),
    output: pathSchema.describe("Output .srt file path"),
    model: z.enum(["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v1", "large-v2", "large-v3", "large-v3-turbo", "distil-small.en", "distil-medium.en", "distil-large-v2", "distil-large-v3"]).optional().describe("Whisper model (default tiny, or MEDIAKIT_ASR_MODEL): tiny is fast and fine for clear speech; base/small are more accurate; large-v3-turbo is the accurate/slow end"),
    language: z.string().default("auto").describe("\"auto\" (detect) or an ISO 639-1 code, e.g. en, vi"),
    engine: z.enum(["auto", "faster-whisper", "whisper"]).default("auto").describe("ASR engine: auto prefers faster-whisper, then whisper.cpp; \"whisper\" forces the whisper.cpp CLI"),
    chunk_seconds: z.number().int().min(5).max(1800).optional().describe("Split long audio into N-second chunks (5-1800, 2s overlap, segments re-offset onto the full timeline) so hour-long recordings transcribe without one giant ASR run; a file shorter than one chunk runs as a single chunk"),
    word_timestamps: z.boolean().default(false).describe("Also return per-word timings (words: [{index, start, end, word}], 0-based indices in timeline order) — the input cut_words cuts by. Word times come from the engine, never from the caller"),
  },
  async (a) => safe(() => core.transcribe({
    input: a.input,
    output: a.output,
    model: a.model,
    language: a.language,
    engine: a.engine,
    chunk_seconds: a.chunk_seconds ?? null,
    word_timestamps: a.word_timestamps ?? false,
  })),
);

server.tool(
  "cut_words",
  "Cut words out of a talking-head clip by transcript: filler words (um/uh), false starts and restarts, using word timings from transcribe --word-timestamps. Give a words file (the JSON transcribe prints — save its stdout — or a hand-written {words:[{start,end,word}]}), then select by word text (--remove 'um,uh'), the built-in filler set (--fillers), or 0-based word-index ranges (--indices '0-5,96-98', as printed by transcribe); --keep rescues indices even when auto-flagged. Keep runs are padded 0.06s before / 0.12s after, clamped so a cut never keeps a fragment of the word it removed, and kept words that end up mostly cut out are reported in cut_check.swallowed — play them before trusting the cut. Every kept segment gets a 12ms fade out + 15ms fade in at the join, so a cut mid-word has no click. --dry-run returns the plan (cut intervals + keep segments) without writing a file. No match stream-copies the input unchanged.",
  {
    input: pathSchema.describe("Audio or video file with a speech track"),
    output: pathSchema.optional().describe("Output media file path (not needed with dry_run=true)"),
    words_file: pathSchema.describe("Transcript JSON with a words array — the stdout of `transcribe --word-timestamps` saved to a file, or a hand-written {words:[{start,end,word}]}"),
    remove: z.string().optional().describe("Comma-separated words to cut by text, e.g. 'um,uh' (case-insensitive, punctuation ignored — 'Um,' matches 'um')"),
    fillers: z.boolean().default(false).describe("Also cut the built-in filler set: um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh. 'like' / 'you know' are NOT fillers — they are ambiguous, cut them only via --remove"),
    indices: z.string().optional().describe("0-based word-index ranges to cut, e.g. '0-5,96-98' (indices as printed by transcribe --word-timestamps)"),
    keep: z.string().optional().describe("0-based word-index ranges to keep even when matched by --remove/--fillers/--indices, e.g. '3,7-9'"),
    pad_before: z.number().min(0).max(1).default(0.06).describe("Seconds kept before each kept-word run (default 0.06, clamped to the gap to the neighbouring cut word)"),
    pad_after: z.number().min(0).max(1).default(0.12).describe("Seconds kept after each kept-word run (default 0.12, clamped the same way)"),
    min_keep: z.number().min(0.05).max(5).default(0.2).describe("Drop keep segments shorter than this many seconds (default 0.2); words lost that way are reported in cut_check.swallowed"),
    dry_run: z.boolean().default(false).describe("Return the cut plan (removed words, keep segments, cut_check) without writing any file"),
  },
  async (a) => safe(() => core.cutWords({
    input: a.input,
    output: a.output,
    wordsFile: a.words_file,
    remove: a.remove ?? null,
    fillers: a.fillers ?? false,
    indices: a.indices ?? null,
    keep: a.keep ?? null,
    padBefore: a.pad_before ?? 0.06,
    padAfter: a.pad_after ?? 0.12,
    minKeep: a.min_keep ?? 0.2,
    dryRun: a.dry_run ?? false,
  })),
);

server.tool(
  "remove_retakes",
  "Cut repeated takes out of a talking-head clip, on word timings from transcribe --word-timestamps: when the speaker says a sentence, restarts, and says it again, the earlier take plus the restart junk ('okay, again', a filler) is cut and the fluent take is kept whole. A repeat is >= min_words identical words (default 3) with at most max_gap_words words (default 8) and max_gap_seconds (default 5) between the takes; a 2-word abandoned start ('the quick' — 'um' — 'the quick brown fox') is also cut. keep=last (default) keeps the later take — people warm up — keep=first keeps the earlier one. Returns the clusters found (kept take + removed indices + text) so the cut can be reviewed; detect_only=true returns the plan and writes no file. No retake stream-copies the input unchanged. Deterministic, not a judge: an intentional repetition ('I like cats. I like cats a lot.') looks like a retake to this detector — read the clusters (or run detect_only) before cutting.",
  {
    input: pathSchema.describe("Audio or video file with a speech track"),
    output: pathSchema.optional().describe("Output media file path (not needed with detect_only=true)"),
    words_file: pathSchema.describe("Transcript JSON with a words array — the stdout of `transcribe --word-timestamps` saved to a file, or a hand-written {words:[{start,end,word}]}"),
    min_words: z.number().int().min(1).max(10).default(3).describe("Minimum repeated-phrase length in words (default 3); 2 also catches short restarts, 1 catches stutters ('the the') but flags common words more often"),
    max_gap_words: z.number().int().min(0).max(50).default(8).describe("Max words allowed between the two takes — the restart junk ('okay, again', fillers) (default 8)"),
    max_gap_seconds: z.number().min(0).max(60).default(5).describe("Max seconds between the end of the earlier take and the start of the later one (default 5)"),
    keep: z.enum(["first", "last"]).default("last").describe("Which take to keep: 'last' (default — later takes are usually the warmed-up one) or 'first'"),
    pad_before: z.number().min(0).max(1).default(0.06).describe("Seconds kept before each kept-word run (default 0.06, clamped to the gap to the neighbouring cut word)"),
    pad_after: z.number().min(0).max(1).default(0.12).describe("Seconds kept after each kept-word run (default 0.12, clamped the same way)"),
    min_keep: z.number().min(0.05).max(5).default(0.2).describe("Drop keep segments shorter than this many seconds (default 0.2)"),
    detect_only: z.boolean().default(false).describe("Report the clusters and the cut plan without writing any file"),
  },
  async (a) => safe(() => core.removeRetakes({
    input: a.input,
    output: a.output,
    wordsFile: a.words_file,
    minWords: a.min_words ?? 3,
    maxGapWords: a.max_gap_words ?? 8,
    maxGapSeconds: a.max_gap_seconds ?? 5,
    keep: a.keep ?? "last",
    padBefore: a.pad_before ?? 0.06,
    padAfter: a.pad_after ?? 0.12,
    minKeep: a.min_keep ?? 0.2,
    detectOnly: a.detect_only ?? false,
  })),
);

server.tool(
  "find",
  "Find media files by filename, recursively under a directory (case-insensitive substring match). Returns each match with probe info (duration, dimensions, codecs) so the agent can pick the right file without guessing paths. Skips .git, node_modules and hidden folders; does not follow symlinked directories.",
  {
    directory: pathSchema.describe("Directory to search under (recursive)"),
    name: z.string().min(1).describe("Substring to match in the filename (case-insensitive)"),
    extensions: z.string().optional().describe("Comma-separated extensions to include, e.g. 'mp4,mov' (default: common video/audio/image/caption extensions)"),
    max_results: z.number().int().min(1).max(100).default(20).describe("Max matches to return with probe info; the result still reports total_matches"),
  },
  async (a) => safe(() => core.findMedia({
    directory: a.directory, name: a.name,
    extensions: a.extensions ?? null, maxResults: a.max_results,
  })),
);

server.tool(
  "svg_animate",
  "Animate an SVG file into an MP4, code-driven: Node interpolates keyframed translate/scale/rotate/opacity on elements (by id) per frame and ffmpeg's librsvg rasterizes each frame — no browser, no SMIL (ffmpeg cannot play SVG animation). Give animations as a list with target id, property, from/to, start/end seconds and easing. A target id that does not exist in the SVG is reported in missing_targets, not fatal.",
  {
    svg: pathSchema.describe("Input SVG file (elements to animate need an id attribute)"),
    animations: z.array(z.object({
      target: z.string().min(1).describe("id of the SVG element to animate"),
      property: z.enum(["translate", "scale", "rotate", "opacity"]).describe("What to animate"),
      from: z.union([z.number(), z.array(z.number()).length(2)]).describe("Start value: [x, y] for translate, a number or [sx, sy] for scale, degrees for rotate, 0-1 for opacity"),
      to: z.union([z.number(), z.array(z.number()).length(2)]).describe("End value, same shape as from"),
      start: z.number().min(0).default(0).describe("Animation start time in seconds"),
      end: z.number().min(0).describe("Animation end time in seconds (must be <= duration)"),
      easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).default("linear").describe("Easing curve"),
      center: z.array(z.number()).length(2).optional().describe("Rotation center [cx, cy] for rotate (default 0,0)"),
    })).min(1).describe("Animations to apply, in order"),
    output: pathSchema,
    duration: z.number().min(0.5).max(30).default(3).describe("Clip duration in seconds"),
    fps: z.number().int().min(1).max(60).default(30).describe("Frames per second"),
    width: z.number().int().min(2).optional().describe("Output width in pixels (default: the SVG's own size; must be even)"),
    height: z.number().int().min(2).optional().describe("Output height in pixels"),
    background: z.string().default("FFFFFF").describe("Background hex color (e.g. 0F172A) or 'transparent' for no background rect (flattens to black in video)"),
  },
  async (a) => safe(() => core.svgAnimate({
    svg: a.svg,
    animations: a.animations,
    output: a.output,
    duration: a.duration,
    fps: a.fps,
    width: a.width ?? null,
    height: a.height ?? null,
    background: a.background,
  })),
);

server.tool(
  "mix",
  "Mix voice over a music bed with sidechain ducking: the bed drops by duck_db whenever the voice speaks (attack/release in ms), the voice is levelled to voice_lufs first, the music loops to the voice length, and the mix is mastered to target_lufs with two-pass loudnorm (render unmastered, measure it, then normalise with the measured values — single-pass undershoots on quiet voices with long gaps under a bed). Returns the ducking actually measured (ducking_measured_db, speech vs silence window on the ducked bed) and a warning when the mix is peak-limited and cannot reach the target. sfx drops short sounds at exact timestamps (each {file, at_seconds, volume 0-1}, max 16) — they are mixed in after the ducking, so a sting punches through; a timestamp past the voice end is refused. If the voice file is a video, its video stream is copied through. Set dry_run=true to print the exact ffmpeg commands that would run (render + master) and write no file (probes and the loudnorm measurement still run, read-only, to compute the voice gain).",
  {
    voice: pathSchema.describe("Voice/speech file (audio or video with an audio track)"),
    music: pathSchema.describe("Music bed audio file (looped to the voice length)"),
    output: pathSchema,
    music_volume: z.number().min(0).max(1).default(0.3).describe("Bed level when the voice is silent (0-1)"),
    duck_db: z.number().min(0).max(24).default(12).describe("How far the bed drops under speech, in dB (0 = no ducking)"),
    attack_ms: z.number().int().min(1).max(1000).default(100).describe("Ducking attack time in ms"),
    release_ms: z.number().int().min(10).max(5000).default(400).describe("Ducking release time in ms"),
    voice_lufs: z.number().min(-70).max(0).default(-16).describe("Voice level target before mixing"),
    target_lufs: z.number().min(-70).max(0).default(-14).describe("Master the mix to this LUFS"),
    master: z.boolean().default(true).describe("Master the mix (false = leave the raw mix levels)"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg commands that would run (render + master), write no file"),
    sfx: z.array(z.object({
      file: pathSchema.describe("Short sound file with an audio track"),
      at_seconds: z.number().min(0).max(3600).describe("Timestamp in the voice where the sound lands (must be before the voice ends)"),
      volume: z.number().min(0).max(1).default(1).describe("SFX level (0-1, default 1)"),
    })).max(16).optional().describe("Short sounds to drop at exact timestamps, mixed after ducking"),
  },
  async (a) => safe(() => core.mix({
    voice: a.voice,
    music: a.music,
    output: a.output,
    musicVolume: a.music_volume,
    duckDb: a.duck_db,
    attackMs: a.attack_ms,
    releaseMs: a.release_ms,
    voiceLufs: a.voice_lufs,
    targetLufs: a.target_lufs,
    master: a.master,
    dryRun: a.dry_run,
    sfx: (a.sfx ?? []).map((s) => ({ file: s.file, at: s.at_seconds, volume: s.volume })),
  })),
);

server.tool(
  "overlay",
  "Overlay a logo/watermark image on a video. Named position (top-right, top-left, bottom-left, bottom-right, center) plus a margin from the edge; the overlay is scaled to width keeping its aspect ratio, opacity 0-1, and start/end (seconds) show it only during that window. Audio is copied through.",
  {
    input: pathSchema,
    overlay: pathSchema.describe("Overlay image file (PNG with transparency recommended)"),
    output: pathSchema,
    position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"]).default("top-right").describe("Corner/center placement"),
    margin: z.number().int().min(0).default(24).describe("Margin from the edge in pixels"),
    width: z.number().int().min(2).optional().describe("Overlay width in pixels (keeps aspect; default = native size)"),
    opacity: z.number().min(0).max(1).default(1).describe("Overlay opacity (0-1)"),
    start: z.number().min(0).optional().describe("Show the overlay from this time in seconds"),
    end: z.number().min(0).optional().describe("Hide the overlay after this time in seconds"),
  },
  async (a) => safe(() => core.overlayImage({
    input: a.input,
    overlay: a.overlay,
    output: a.output,
    position: a.position,
    margin: a.margin,
    width: a.width ?? null,
    opacity: a.opacity,
    start: a.start ?? null,
    end: a.end ?? null,
  })),
);

server.tool(
  "pip",
  "Picture-in-picture: place a second video over the main one. 9 named positions (corners, edges, center), size by width in pixels or by scale fraction of the main width (default 0.25), opacity 0-1, and start/end (seconds) show it only during that window — the PiP clip loops so it never runs out. Audio: main (default, PiP audio dropped), pip (PiP audio only), or mix (both mixed, levels kept).",
  {
    input: pathSchema,
    pip: pathSchema.describe("Video to place on top"),
    output: pathSchema,
    position: z.enum(["top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right"]).default("bottom-right").describe("Placement (9 positions)"),
    margin: z.number().int().min(0).default(24).describe("Margin from the edge in pixels"),
    width: z.number().int().min(2).optional().describe("PiP width in pixels (keeps aspect; overrides scale)"),
    scale: z.number().min(0.05).max(0.9).default(0.25).describe("PiP width as a fraction of the main video width (used when width is omitted)"),
    opacity: z.number().min(0).max(1).default(1).describe("PiP opacity (0-1)"),
    start: z.number().min(0).optional().describe("Show the PiP from this time in seconds"),
    end: z.number().min(0).optional().describe("Hide the PiP after this time in seconds"),
    audio: z.enum(["main", "pip", "mix"]).default("main").describe("Which audio to keep: main, pip, or mix (both)"),
  },
  async (a) => safe(() => core.pictureInPicture({
    input: a.input,
    pip: a.pip,
    output: a.output,
    position: a.position,
    margin: a.margin,
    width: a.width ?? null,
    scale: a.scale,
    opacity: a.opacity,
    start: a.start ?? null,
    end: a.end ?? null,
    audio: a.audio,
  })),
);

server.tool(
  "scenes",
  "Detect scene changes / hard cuts in a video (probe-only, writes no file). Returns the cut timestamps plus the segments between them — trim on these boundaries instead of guessing. Lower threshold = more sensitive.",
  {
    input: pathSchema,
    threshold: z.number().min(0).max(1).default(0.3).describe("Scene sensitivity (0-1, lower = more sensitive)"),
  },
  async (a) => safe(() => core.detectScenes(a)),
);

server.tool(
  "keyframes",
  "List the keyframe (I-frame) timestamps of a video (probe-only, writes no file), plus GOP min/max/avg interval. Check this before a stream-copy trim — cutting between keyframes silently shifts the cut. Pair with trim snap_to_keyframe=true to snap the cut onto keyframes.",
  { input: pathSchema },
  async (a) => safe(() => core.listKeyframes(a)),
);

server.tool(
  "fit",
  "Fit a media file to an exact target duration in seconds. method speed (default) speeds it up/down with setpts + chained atempo (factor must stay in 0.25-4x); trim cuts a longer source down; loop repeats a shorter source until it reaches the target. max_fps caps the output frame rate (e.g. 15 for a smaller file) — it only ever lowers the fps, never raises it by duplicating frames. Returns the output duration and fps actually measured with ffprobe, plus duration_error_seconds.",
  {
    input: pathSchema,
    output: pathSchema,
    duration: z.number().positive().describe("Target duration in seconds"),
    method: z.enum(["speed", "trim", "loop"]).default("speed").describe("speed = change playback speed (keeps the whole clip), trim = cut a longer source, loop = repeat a shorter source"),
    max_fps: z.number().int().min(1).max(120).optional().describe("Cap the output frame rate (1-120). Only lowers fps — a 30fps source with max_fps 60 keeps 30fps; video only, ignored for audio-only input"),
  },
  async (a) => safe(() => core.fitDuration({
    input: a.input,
    output: a.output,
    duration: a.duration,
    method: a.method,
    maxFps: a.max_fps ?? null,
  })),
);

server.tool(
  "export_gif",
  "Export a clip (or segment) as an animated GIF with a two-pass palette (palettegen + paletteuse from the actual frames). Fits under max_size_mb (default 10 MB, the GitHub README limit; Slack only auto-plays GIFs under ~2 MB) by stepping down fps, then width, then palette colours — each attempt is measured on disk, and size_budget_met says honestly whether the budget was met.",
  {
    input: pathSchema,
    output: pathSchema.describe("Output file path, must end in .gif"),
    start: z.number().min(0).optional().describe("Segment start in seconds (default 0)"),
    end: z.number().positive().optional().describe("Segment end in seconds (default: end of file)"),
    fps: z.number().int().min(1).max(30).optional().describe("Frames per second (default 15; stepped down if the size budget needs it)"),
    width: z.number().int().min(16).max(4096).optional().describe("GIF width in pixels (default 640; stepped down if the size budget needs it)"),
    max_size_mb: z.number().min(0.01).max(10000).default(10).describe("Size budget in decimal MB (default 10)"),
  },
  async (a) => safe(() => core.exportGif({
    input: a.input,
    output: a.output,
    start: a.start ?? null,
    end: a.end ?? null,
    fps: a.fps ?? null,
    width: a.width ?? null,
    maxSizeMb: a.max_size_mb,
  })),
);

server.tool(
  "doctor",
  "Read-only environment preflight: ffmpeg/ffprobe versions, which filters and encoders this build has, and which mediakit tools that enables. An unavailable tool also reports a one-sentence fix telling you how to repair the ffmpeg install. Run first on a new machine — a tool that reports available=false will fail at runtime.",
  {},
  async () => safe(() => core.doctor()),
);

server.tool(
  "titlecard",
  "Render a title card PNG: a big bold hook (3-6 words) on a coloured box, on a transparent canvas so it overlays onto any frame. Text wraps to short lines; the block sits centred in the safe zone (~55% down the frame). Default: yellow text on an orange box, ~120px type at 1080 wide. Pass style: clean-bold | minimal-line | warm-story to use that style's locked palette from skills/shorts-video/styles.json instead; an explicit text_color/box_color/font_size overrides just that one locked value for this call.",
  {
    text: z.string().min(1).describe("The hook text, 3-6 words (e.g. 'The Moon Is Leaving Us')"),
    output: pathSchema,
    width: z.number().int().min(2).default(1080).describe("Canvas width in pixels (must be even)"),
    height: z.number().int().min(2).default(1920).describe("Canvas height in pixels (must be even)"),
    font_size: z.number().int().min(16).max(400).optional().describe("Font size in px; default scales with canvas width (~120px at 1080 wide); with style, the style's locked size"),
    text_color: z.string().optional().describe("Text color: name or hex, default FFD60A (yellow); with style, the style's locked text color"),
    box_color: z.string().optional().describe("Box color: name or hex, default F97316 (orange); with style, the style's locked box color"),
    style: z.string().optional().describe("Named style id (clean-bold | minimal-line | warm-story): use that style's locked text/box/font palette"),
  },
  async (a) => safe(() => core.titlecard({
    text: a.text,
    output: a.output,
    width: a.width,
    height: a.height,
    fontSize: a.font_size ?? null,
    textColor: a.text_color ?? null,
    boxColor: a.box_color ?? null,
    style: a.style ?? null,
  })),
);

server.tool(
  "intro",
  "Render a short intro clip: a title on a solid-colour background that fades in and out. Silent video (no audio); use it as the opening card, then concat it in front of the main clip. Text wraps to short lines, centred on the frame. Pass style: clean-bold | minimal-line | warm-story to use that style's locked palette (its box colour becomes the background, its text colour the text) from skills/shorts-video/styles.json; an explicit bg_color/text_color/font_size overrides just that one locked value for this call.",
  {
    text: z.string().min(1).describe("The intro title, e.g. 'Welcome Back'"),
    output: pathSchema,
    width: z.number().int().min(2).default(1280).describe("Canvas width in pixels (must be even)"),
    height: z.number().int().min(2).default(720).describe("Canvas height in pixels (must be even)"),
    duration: z.number().min(0.5).max(30).default(3).describe("Clip length in seconds"),
    bg_color: z.string().optional().describe("Background color: name or hex, default 0F172A (dark navy); with style, the style's locked box color"),
    text_color: z.string().optional().describe("Text color: name or hex, default FFFFFF (white); with style, the style's locked text color"),
    font_size: z.number().int().min(16).max(400).optional().describe("Font size in px; default scales with canvas width (~100px at 1280 wide); with style, the style's locked size"),
    fade_in: z.number().min(0).max(30).default(0.5).describe("Text fade-in length in seconds (0 = no fade-in)"),
    fade_out: z.number().min(0).max(30).default(0.5).describe("Text fade-out length in seconds (0 = no fade-out)"),
    style: z.string().optional().describe("Named style id (clean-bold | minimal-line | warm-story): use that style's locked palette"),
  },
  async (a) => safe(() => core.intro({
    text: a.text,
    output: a.output,
    width: a.width,
    height: a.height,
    duration: a.duration,
    bgColor: a.bg_color ?? null,
    textColor: a.text_color ?? null,
    fontSize: a.font_size ?? null,
    fadeIn: a.fade_in,
    fadeOut: a.fade_out,
    style: a.style ?? null,
  })),
);

server.tool(
  "social",
  "Export one video to several platform specs in a single call: reframes each platform's size (blur keeps the whole frame by default), trims clips longer than the platform's max duration (Shorts 180s, Story 60s), normalizes loudness to target_lufs, then checks each output against that platform's spec. Writes <base>-<platform>.mp4 per platform plus manifest.json (receipt with dimensions, duration, LUFS and check results) into the output directory. A platform whose check fails still writes its file — the result says so instead of hiding it.",
  {
    input: pathSchema,
    output_dir: pathSchema.describe("Directory to write the platform files + manifest.json into (created if needed)"),
    platforms: z.array(z.enum(["tiktok", "reels", "shorts", "instagram-feed", "instagram-story", "linkedin", "youtube"])).min(1).default(["tiktok", "reels", "shorts"]).describe("Platforms to export (default: tiktok, reels, shorts)"),
    strategy: z.enum(["crop", "pad", "blur"]).default("blur").describe("How to fit the source frame into each platform size: crop cuts the aspect out, pad letterboxes, blur fills with a blurred copy (default)"),
    target_lufs: z.number().min(-70).max(0).default(-14).describe("Normalize audio to this LUFS"),
    trim_to_max: z.boolean().default(true).describe("Trim clips longer than the platform's max duration (false keeps the full length; check will then fail the duration rule)"),
  },
  async (a) => safe(() => core.social({
    input: a.input,
    outputDir: a.output_dir,
    platforms: a.platforms,
    strategy: a.strategy,
    targetLufs: a.target_lufs,
    trimToMax: a.trim_to_max,
  })),
);

server.tool(
  "mux",
  "Replace a video's audio track with an external audio file, stream-copying both (no re-encode: fast and lossless). The video's original audio is dropped, not mixed in — mix first if you want both. audio_offset_seconds shifts the new audio against the video (positive = audio starts later, negative = video starts later). shortest stops the output at the shorter stream. dry_run prints the exact ffmpeg argv and writes no file.",
  {
    video: pathSchema.describe("Video file (must have a video stream)"),
    audio: pathSchema.describe("Audio file (must have an audio stream; a video file's audio track works too)"),
    output: pathSchema.describe("Output file path"),
    audio_offset_seconds: z.number().min(-3600).max(3600).default(0).describe("Shift the new audio in seconds: positive delays the audio, negative delays the video"),
    shortest: z.boolean().default(false).describe("Stop at the shorter of the two streams"),
    dry_run: z.boolean().default(false).describe("Return the ffmpeg command without writing a file"),
  },
  async (a) => safe(() => core.mux({
    video: a.video,
    audio: a.audio,
    output: a.output,
    audioOffsetSeconds: a.audio_offset_seconds,
    shortest: a.shortest,
    dryRun: a.dry_run,
  })),
);

server.tool(
  "batch",
  "Apply ONE operation to many files matching a glob under a folder, in one call: loudness, resize, reframe, compress, convert, extract_audio, reverse, grade, fit, trim, silence, chroma_key, cut_words or remove_retakes — the same args for every file. Outputs are named <stem>-<operation>.<ext> under the output directory, mirroring the input tree. Returns one row per file (input order) with status ok/error/cached/skipped plus counts, so a failure in one file never hides the rest. Unchanged files are skipped via a content-hash cache (.mediakit-batch-cache.json in the output dir, verified against the output's size + sha256); jobs runs up to 8 files at once under one shared timeout_seconds budget; dry_run lists the planned outputs and writes nothing. cut_words and remove_retakes find each clip's words file by convention (<words_dir>/<stem>.words.json, default the input's own folder) — a clip with no words file fails its own row only. slideshow is the exception: a SET operation — the whole matched set of images (2-32) becomes ONE slideshow video (output_name, default slideshow.mp4) instead of one output per file, and the per-file cache does not apply.",
  {
    operation: z.enum(["loudness", "resize", "reframe", "compress", "convert", "extract_audio", "reverse", "grade", "fit", "trim", "silence", "chroma_key", "cut_words", "remove_retakes", "slideshow"]).describe("The operation to apply to every matched file"),
    pattern: z.string().min(1).describe("Glob matched against paths under input_dir: **/*.mp4 for every mp4 at any depth, sub/*.mp4 for one folder, or a bare *.mp4 (matches the basename at any depth)"),
    input_dir: pathSchema.describe("Folder to search under (recursive; hidden dirs, .git, node_modules and .next are skipped)"),
    output_dir: pathSchema.describe("Directory to write outputs + batch-manifest.json into (created if needed; files under it are never treated as inputs)"),
    args: z.record(z.unknown()).default({}).describe("Operation arguments, same for every file (snake_case, e.g. {target_lufs: -14} for loudness, {preset: '720p'} for resize, {duration: 30, method: 'trim'} for fit). Unknown keys are refused, never silently ignored"),
    jobs: z.number().int().min(1).max(8).default(1).describe("Files processed at once (default 1 = sequential; capped at min(jobs, cpu count, 8))"),
    output_suffix: z.string().max(32).optional().describe("Output filename suffix (default -<operation>). Empty string only with an output_dir different from the input dir"),
    cache: z.boolean().default(true).describe("Skip files whose input bytes + operation + args already produced the cached output (verified by output size + sha256)"),
    stop_on_error: z.boolean().default(false).describe("Stop starting new files after the first failure (in-flight files still finish; the rest are reported skipped)"),
    timeout_seconds: z.number().min(1).max(86400).default(1800).describe("Shared time budget for the whole batch in seconds (default 1800); files not started before it expires are reported skipped"),
    max_files: z.number().int().min(1).max(1000).default(200).describe("Cap on matched files (extra matches are reported via truncated)"),
    dry_run: z.boolean().default(false).describe("List matched files + planned outputs without running anything or writing any file"),
  },
  async (a) => safe(() => core.batch({
    operation: a.operation,
    pattern: a.pattern,
    inputDir: a.input_dir,
    outputDir: a.output_dir,
    args: a.args ?? {},
    jobs: a.jobs,
    outputSuffix: a.output_suffix ?? null,
    cache: a.cache,
    stopOnError: a.stop_on_error,
    timeoutSeconds: a.timeout_seconds,
    maxFiles: a.max_files,
    dryRun: a.dry_run,
  })),
);

server.tool(
  "manifest",
  "Run a whole edit pipeline from ONE declarative JSON manifest file: {version: 1, input, output, steps: [{tool, args}], qa?} — paths in the manifest are relative to the manifest file. Steps run in order, each feeding the next (slideshow as step 1 only — it builds a video from images in args, so the manifest input should be the first slide image; download as step 1 only — it fetches from a URL in args, and when it is step 1 the manifest input may be omitted entirely; then trim, resize, reframe, compress, convert, extract_audio, reverse, grade, fit, silence, denoise, interpolate, burn_captions, overlay, chroma_key, cut_words, remove_retakes); the whole plan is validated before anything renders, so a typo fails in seconds. Each step is cached by content hash (input bytes + tool + args + sidecar-file bytes, verified against the cached output's size + sha256) — re-running an unchanged manifest re-encodes nothing, and editing step 3 only re-runs from step 3. Set qa to a platform (or 'any') to run qa_report on the final file. dry_run prints the plan and writes nothing — the approve-before-render gate. A step failure aborts the run and keeps the intermediates for inspection.",
  {
    manifest_path: pathSchema.describe("Path to the manifest JSON file"),
    output: pathSchema.optional().describe("Output file path (overrides the manifest's output; the extension is adjusted to the step chain's final format when needed)"),
    dry_run: z.boolean().default(false).describe("Validate the manifest and list the planned steps without running anything or writing any file"),
    cache: z.boolean().default(true).describe("Skip steps whose input bytes + tool + args already produced the cached intermediate (verified by size + sha256)"),
    keep_intermediates: z.boolean().default(false).describe("Keep the per-step intermediate files under the output dir (deleted on success by default; always kept when a step fails)"),
  },
  async (a) => safe(() => core.manifest({
    manifestPath: a.manifest_path,
    output: a.output ?? null,
    cache: a.cache,
    dryRun: a.dry_run,
    keepIntermediates: a.keep_intermediates,
  })),
);

server.tool(
  "assemble",
  "Film assembler (Autopilot-style): build a finished video from ONE declarative film manifest — shots on a voice-led timeline, mixed audio, burned captions, QA and a receipt. The voice is the master clock: total = lead + measured voice duration + tail, and shot durations must cover that total EXACTLY in frames (no silent trim/pad/speed change). Modes: validate (no writes), preview (first N seconds at half size — show it to the user), approve (records the fingerprint of the previewed files; a human must have seen the preview), render (needs a matching approval, unless force:true). Shot segments are cached by content hash, so a re-render rebuilds only changed shots. v1: plain cuts, no per-shot text layers, one aspect per manifest. async:true (render only) returns a job_id immediately and renders in the background — poll the job tool. chapters [{title, at}] in the manifest become MP4 chapters in final.mp4. `preset` in the manifest (vertical/horizontal/square/cinematic/vertical-60) picks width/height/fps/style for the whole film; explicit fields win and are reported in preset_overrides, preset-filled fields in preset_applied. NOT the manifest tool (that runs a linear edit pipeline).",
  {
    manifest_path: pathSchema.describe("Path to the film manifest JSON file (see skills/shorts-video/references/assemble-manifest.md for the schema)"),
    mode: z.enum(["validate", "preview", "approve", "render"]).default("validate").describe("validate: check the timeline math and files, write nothing. preview: render the first preview_seconds at half size. approve: record approval for the previewed files. render: full-resolution film (needs approval unless force)."),
    output_dir: pathSchema.optional().describe("Output directory (required for preview/approve/render): preview.mp4 + preview.json, or final.mp4 + assemble-receipt.json"),
    preview_seconds: z.number().min(1).max(60).default(20).describe("Preview length in seconds (preview mode only, default 20)"),
    force: z.boolean().default(false).describe("Render without approval (render mode only; recorded as approval:'forced' in the receipt — use only when the user explicitly says so)"),
    async: z.boolean().default(false).describe("Render in the background (render mode only): validate + approval are checked now, then the call returns a job_id immediately and the render runs in a detached worker — poll the job tool for progress and the terminal result. Chapters [{title, at}] in the manifest become MP4 chapters in final.mp4."),
  },
  async (a) => safe(async () => {
    if (a.async) {
      if (a.mode !== "render") throw new core.MediaKitError("assemble async:true needs mode render (validate/preview/approve are already fast)", "INVALID_ARG");
      return core.startAssembleJob({
        manifestPath: a.manifest_path,
        outputDir: a.output_dir ?? null,
        force: a.force,
      });
    }
    return core.assemble({
      manifestPath: a.manifest_path,
      mode: a.mode,
      outputDir: a.output_dir ?? null,
      previewSeconds: a.preview_seconds,
      force: a.force,
    });
  }),
);

// Durable render jobs (idea: AH64-dll/OpenEdit's get_render_job /
// cancel_render_job): assemble --async returns a job_id; this tool
// polls it. status shows progress + the terminal result/error, list
// shows all jobs newest-first, cancel stops a queued/running job
// (kills the worker's whole process group, ffmpeg children included).
server.tool(
  "job",
  "Inspect a durable async render job (started by assemble async:true): status shows progress (stage + percent) and the terminal result or error; list shows all jobs newest-first; cancel stops a queued or running job. Jobs live under MEDIAKIT_JOBS_DIR or <workdir>/.mediakit-jobs.",
  {
    job_id: z.string().optional().describe("Job id (e.g. job-20261114-005800-a1b2c3d4) — required for status/cancel"),
    action: z.enum(["status", "list", "cancel"]).default("status").describe("status: read one job; list: all jobs; cancel: stop a queued/running job"),
  },
  async (a) => safe(async () => {
    if (a.action === "list") return core.listJobs({});
    if (!a.job_id) throw new core.MediaKitError("job needs a job_id for status/cancel", "INVALID_ARG");
    return a.action === "cancel" ? core.cancelJob(a.job_id) : core.getJob(a.job_id);
  }),
);

// Download a media file from the web (idea: mrdainami/ffmpeg-mcp's
// `download`, but typed and guarded — brookcs3/m3u8-mcp-server's
// m3u8_download is one bare `ffmpeg -i <url> -c copy` with no URL
// validation, no size cap, no timeout and no check of the result, and
// MediaKit does the opposite on every one of those). The director's
// way to pull stock footage, a reference clip or a music bed into the
// workspace: http(s) only, no credentials in the URL, 500 MB cap by
// default, 5 redirects max, streamed to disk with the cap enforced
// while streaming, written atomically via .partial, then probed — a
// non-media download is deleted, not reported as a success. HLS
// (.m3u8) / DASH (.mpd) playlists are fetched with ffmpeg -c copy
// under a protocol whitelist (no file:// segments) and the cap is
// enforced after the fetch, since a playlist's size is unknowable
// until the last segment arrives.
server.tool(
  "download",
  "Download a media file from an http(s) URL into the workspace — stock footage, a reference clip, a music bed. Typed and guarded: http/https only (no credentials in the URL), size cap enforced while streaming for direct files (default 500 MB, refused upfront when Content-Length already exceeds it), 5 redirects max, 300s timeout, written atomically via <output>.partial and renamed only on success, then probed — a file that is not media is deleted and reported, never left as a success. HLS (.m3u8) / DASH (.mpd) playlists are fetched with ffmpeg -c copy (re-mux, never re-encode) under a protocol whitelist, and the size cap is enforced after the fetch. The output extension is either given (must be a media extension) or derived from the Content-Type / URL path. Returns the output path, size, content-type, redirect count and the probe summary (duration, dimensions, codecs).",
  {
    url: z.string().url().describe("http(s) URL of a direct media file (video/audio/image) or an HLS (.m3u8) / DASH (.mpd) playlist"),
    output: pathSchema.describe("Output file path — with a media extension, or without one (the extension is then derived from the Content-Type / URL path)"),
    max_size_mb: z.number().min(0.01).max(2000).default(500).describe("Maximum download size in MB (default 500); refused upfront when Content-Length exceeds it, aborted mid-stream otherwise"),
    timeout_seconds: z.number().int().min(1).max(3600).default(300).describe("Whole-download timeout in seconds (default 300)"),
  },
  async (a) => safe(() => core.downloadMedia({
    url: a.url,
    output: a.output,
    maxSizeMb: a.max_size_mb,
    timeoutSeconds: a.timeout_seconds,
  })),
);

// ---------------------------------------------------------------- MCP resources
// Workspace-scoped reads (idea: conneroisu/vfx-mcp's videos:// URIs):
// a client can list the workspace's media, read one file's probe, and
// read workspace info — without guessing paths and without a tool
// call. All three are confined to the workspace root (MEDIAKIT_WORKDIR
// or the process cwd); `..` and symlink escapes are refused in core.
// The metadata template uses {+filename} (reserved expansion) so
// nested paths such as test/nested/deep-clip.mp4 match — a plain
// {filename} only matches one path segment.
function resourceResult(uri, obj) {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(obj, null, 2) }] };
}

server.resource(
  "workspace-media-list",
  "videos://list",
  { description: "List every media file in the workspace (recursive, sorted, capped at 200) with size and extension — read this before guessing a path.", mimeType: "application/json" },
  async (uri) => resourceResult(uri, await core.listWorkspaceFiles()),
);

server.resource(
  "workspace-file-metadata",
  new ResourceTemplate("videos://{+filename}/metadata", { list: undefined }),
  { description: "Probe one workspace media file by relative path (e.g. test/source.mp4, nested paths allowed): duration, dimensions, codecs, streams.", mimeType: "application/json" },
  async (uri, { filename }) => resourceResult(uri, await core.workspaceMetadata(filename)),
);

server.resource(
  "workspace-info",
  "videos://workspace/info",
  { description: "Workspace root, ffmpeg/ffprobe versions, tool availability, media file count, GPU state.", mimeType: "application/json" },
  async (uri) => resourceResult(uri, await core.workspaceInfo()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
