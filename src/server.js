#!/usr/bin/env node
/**
 * mediakit-for-agents — MCP server (stdio transport).
 * Exposes the ffmpeg core as tools for Claude Code / Cursor / Codex.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  "Resize a video. Give width and/or height; with keep_aspect (default) the other dimension follows the aspect ratio and is rounded to an even number.",
  {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(2).optional(),
    height: z.number().int().min(2).optional(),
    keep_aspect: z.boolean().default(true),
  },
  async (a) => safe(() => core.resize({
    input: a.input,
    output: a.output,
    width: a.width ?? null,
    height: a.height ?? null,
    keepAspect: a.keep_aspect,
  })),
);

server.tool(
  "extract_audio",
  "Extract the audio track to mp3, aac, wav, ogg, opus or flac (from the output extension).",
  {
    input: pathSchema,
    output: pathSchema,
    format: z.enum(["mp3", "aac", "wav", "ogg", "opus", "flac"]).optional().describe("Overrides the output extension"),
  },
  async (a) => safe(() => core.extractAudio(a)),
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
  "Build a contact sheet: N evenly spaced frames tiled into a grid image.",
  {
    input: pathSchema,
    output: pathSchema,
    frames: z.number().int().min(1).max(64).default(6),
    columns: z.number().int().min(1).max(8).default(3),
    width: z.number().int().min(80).max(1280).default(320).describe("Width of each tile in pixels"),
  },
  async (a) => safe(() => core.thumbnail(a)),
);

server.tool(
  "loudness",
  "Normalize loudness to a target (default -14 LUFS, the YouTube/Spotify standard) with a single-pass loudnorm filter. Good for speech and creator audio.",
  {
    input: pathSchema,
    output: pathSchema,
    target_lufs: z.number().min(-70).max(0).default(-14),
    format: z.enum(["mp3", "aac", "wav", "ogg", "opus", "flac"]).optional(),
  },
  async (a) => safe(() => core.loudness({
    input: a.input,
    output: a.output,
    targetLufs: a.target_lufs,
    format: a.format ?? null,
  })),
);

server.tool(
  "concat",
  "Join 2+ media files into one. By default it probes the clips first: identical clips (codec, size, fps, audio) are stream-copied with no re-encoding (fast, lossless); differing clips are re-encoded so the join still works. Set fast=true to require the stream-copy path (errors with the exact mismatch if clips differ), or fast=false to always re-encode. Set transition (e.g. fade, wipeleft, dissolve, circlecrop) to crossfade between clips instead of a hard cut — clips are normalized to the first clip's size/fps first, and the output is sum(durations) minus (n-1) x transition_duration.",
  {
    inputs: z.array(z.string().min(1)).min(2).describe("Files in order"),
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
  "Burn subtitles into the video (hardcoded, always visible). Accepts .srt, .ass or .vtt. Style: white bold text on a semi-transparent black box. Defaults scale with frame height: ~60px type on 1080x1920, sitting ~500px above the bottom edge so platform UI (bottom ~480px) never covers the text. Explicit font_size / margin_v override.",
  {
    input: pathSchema,
    output: pathSchema,
    captions: pathSchema.describe("Path to the .srt/.ass/.vtt file"),
    font_size: z.number().int().min(8).max(200).optional().describe("Font size in px; default scales with frame height (~60px at 1920 high)"),
    margin_v: z.number().int().min(0).optional().describe("Distance from bottom edge in px; default is 26% of frame height (above platform UI)"),
  },
  async (a) => safe(() => core.burnCaptions({
    input: a.input,
    output: a.output,
    captions: a.captions,
    fontSize: a.font_size ?? null,
    marginV: a.margin_v ?? null,
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
  "Verify a finished file against a platform delivery spec (tiktok, reels, shorts, youtube): dimensions, codecs, fps, duration limit, audio channels and measured loudness, plus a file-size limit where the platform has one. Video bitrate is checked as a warning only (platforms publish recommendations, not gates) and the result also reports the platform's text-safe zone. Returns pass/fail per rule with fix hints. Run this before publishing.",
  {
    input: pathSchema,
    platform: z.enum(["tiktok", "reels", "shorts", "youtube"]).default("tiktok"),
  },
  async (a) => safe(() => core.check(a)),
);

server.tool(
  "convert",
  "Change container or codec. Omit video_codec/audio_codec to stream-copy that stream. crf 23 is a good default for H.264.",
  {
    input: pathSchema,
    output: pathSchema,
    video_codec: z.enum(["libx264", "libx265", "vp9", "av1", "mpeg4", "copy"]).optional(),
    audio_codec: z.string().optional().describe("e.g. aac, libmp3lame, copy"),
    crf: z.number().int().min(0).max(51).default(23),
    preset: z.string().default("medium"),
  },
  async (a) => safe(() => core.convert({
    input: a.input,
    output: a.output,
    videoCodec: a.video_codec ?? null,
    audioCodec: a.audio_codec ?? null,
    crf: a.crf,
    preset: a.preset,
  })),
);

server.tool(
  "silence",
  "Remove silent stretches from speech/video. Detects silence with silencedetect, keeps the speech plus a margin of silence on each side (so words are never clipped), then cuts and re-joins. Set detect_only=true to just report the silence/kept segments without writing a file. Returns removed_seconds and the kept segment list — verify those before trusting the cut.",
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
    platform: z.enum(["tiktok", "reels", "shorts", "youtube"]).optional().describe("If given, run check for this platform and record the result in spec.json"),
  },
  async (a) => safe(() => core.packageDelivery(a)),
);

server.tool(
  "mix",
  "Mix voice over a music bed with sidechain ducking: the bed drops by duck_db whenever the voice speaks (attack/release in ms), the voice is levelled to voice_lufs first, the music loops to the voice length, and the mix is mastered to target_lufs. Returns the ducking actually measured (ducking_measured_db, speech vs silence window on the ducked bed). If the voice file is a video, its video stream is copied through.",
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
  "Fit a media file to an exact target duration in seconds. method speed (default) speeds it up/down with setpts + chained atempo (factor must stay in 0.25-4x); trim cuts a longer source down; loop repeats a shorter source until it reaches the target. Returns the output duration actually measured with ffprobe, plus duration_error_seconds.",
  {
    input: pathSchema,
    output: pathSchema,
    duration: z.number().positive().describe("Target duration in seconds"),
    method: z.enum(["speed", "trim", "loop"]).default("speed").describe("speed = change playback speed (keeps the whole clip), trim = cut a longer source, loop = repeat a shorter source"),
  },
  async (a) => safe(() => core.fitDuration({
    input: a.input,
    output: a.output,
    duration: a.duration,
    method: a.method,
  })),
);

server.tool(
  "doctor",
  "Read-only environment preflight: ffmpeg/ffprobe versions, which filters and encoders this build has, and which mediakit tools that enables. Run first on a new machine — a tool that reports available=false will fail at runtime.",
  {},
  async () => safe(() => core.doctor()),
);

server.tool(
  "titlecard",
  "Render a title card PNG: a big bold hook (3-6 words) on a coloured box, on a transparent canvas so it overlays onto any frame. Text wraps to short lines; the block sits centred in the safe zone (~55% down the frame). Default: yellow text on an orange box, ~120px type at 1080 wide.",
  {
    text: z.string().min(1).describe("The hook text, 3-6 words (e.g. 'The Moon Is Leaving Us')"),
    output: pathSchema,
    width: z.number().int().min(2).default(1080).describe("Canvas width in pixels (must be even)"),
    height: z.number().int().min(2).default(1920).describe("Canvas height in pixels (must be even)"),
    font_size: z.number().int().min(16).max(400).optional().describe("Font size in px; default scales with canvas width (~120px at 1080 wide)"),
    text_color: z.string().optional().describe("Text color: name or hex, default FFD60A (yellow)"),
    box_color: z.string().optional().describe("Box color: name or hex, default F97316 (orange)"),
  },
  async (a) => safe(() => core.titlecard({
    text: a.text,
    output: a.output,
    width: a.width,
    height: a.height,
    fontSize: a.font_size ?? null,
    textColor: a.text_color ?? "FFD60A",
    boxColor: a.box_color ?? "F97316",
  })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
