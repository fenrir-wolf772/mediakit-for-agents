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
  "Cut a clip out of a media file. Give start (seconds) plus duration OR end. Re-encodes by default for frame-accurate cuts; set stream_copy=true for fast lossless cuts (keyframe boundaries only).",
  {
    input: pathSchema,
    output: pathSchema.describe("Output file path"),
    start: z.number().min(0).default(0).describe("Start time in seconds"),
    duration: z.number().positive().optional().describe("Clip length in seconds"),
    end: z.number().positive().optional().describe("End time in seconds (alternative to duration)"),
    stream_copy: z.boolean().default(false).describe("Copy streams without re-encoding (fast, keyframe-accurate only)"),
  },
  async (a) => safe(() => core.trim(a)),
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
  async (a) => safe(() => core.resize(a)),
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
  async (a) => safe(() => core.loudness(a)),
);

server.tool(
  "concat",
  "Join 2+ media files into one. Re-encodes, so inputs may differ in codec or size.",
  {
    inputs: z.array(z.string().min(1)).min(2).describe("Files in order"),
    output: pathSchema,
    video_codec: z.string().default("libx264"),
    audio_codec: z.string().default("aac"),
  },
  async (a) => safe(() => core.concat(a)),
);

server.tool(
  "burn_captions",
  "Burn subtitles into the video (hardcoded, always visible). Accepts .srt, .ass or .vtt. Style: white bold text on a semi-transparent black box at the bottom.",
  {
    input: pathSchema,
    output: pathSchema,
    captions: pathSchema.describe("Path to the .srt/.ass/.vtt file"),
    font_size: z.number().int().min(8).max(200).default(24),
  },
  async (a) => safe(() => core.burnCaptions(a)),
);

server.tool(
  "reframe",
  "Reframe a video to a target aspect/size in one step (e.g. 16:9 to 9:16 vertical 1080x1920). mode crop cuts the target aspect out (centre, or x/y anchor); pad letterboxes with black bars; blur fills the empty area with a blurred copy of the frame.",
  {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(2).default(1080).describe("Target width in pixels (must be even)"),
    height: z.number().int().min(2).default(1920).describe("Target height in pixels (must be even)"),
    mode: z.enum(["crop", "pad", "blur"]).default("crop"),
    x: z.number().int().min(0).optional().describe("Crop anchor: left offset of the crop window (crop mode only)"),
    y: z.number().int().min(0).optional().describe("Crop anchor: top offset of the crop window (crop mode only)"),
    blur: z.number().min(0).max(100).default(20).describe("Blur strength for the background fill (blur mode only)"),
  },
  async (a) => safe(() => core.reframe(a)),
);

server.tool(
  "check",
  "Verify a finished file against a platform delivery spec (tiktok, reels, shorts, youtube): dimensions, codecs, fps, duration limit, audio channels and measured loudness. Returns pass/fail per rule with fix hints. Run this before publishing.",
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
  async (a) => safe(() => core.convert(a)),
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
  "doctor",
  "Read-only environment preflight: ffmpeg/ffprobe versions, which filters and encoders this build has, and which mediakit tools that enables. Run first on a new machine — a tool that reports available=false will fail at runtime.",
  {},
  async () => safe(() => core.doctor()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
