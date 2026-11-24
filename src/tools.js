#!/usr/bin/env node
/**
 * mediakit-for-agents — tool registry (single source of truth).
 * Every MCP tool is one entry here: name, description, zod input
 * schema, and the handler that maps MCP (snake_case) arguments onto
 * the core (camelCase) call. Both transports share it:
 *  - src/server.js registers each entry on the stdio MCP server
 *  - src/http.js dispatches the same entries over HTTP (REST + JSON-RPC)
 * so a tool cannot exist on one transport and silently differ (or be
 * missing) on the other. Add a tool here and it appears on both.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as core from "./core.js";
import { queryAudit } from "./audit.js";

function result(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

async function safe(fn) {
  try {
    return result(await fn());
  } catch (err) {
    // The error envelope carries the retry guidance with it:
    // `retryable` (always — false means re-issuing the identical
    // call cannot help) and `retry_after_seconds` (only when the
    // failure named a wait: a server Retry-After, the admission
    // gate). Both transports surface this same body. Since lượt 140
    // it also carries `explain: { kind, fixes }` — structured fixes
    // from core.explainError (retry / switch / fix-arg / check-env /
    // none); safe() has no tool/args context, so a retry fix here is
    // label-only and the transport wrappers fill in tool + args.
    const body = { error: err.message, code: err.code ?? "ERROR", ...core.errorRetryInfo(err), explain: core.explainError(err) };
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      isError: true,
    };
  }
}

const pathSchema = z.string().min(1).describe("Path to the file (relative or absolute)");

export const TOOL_DEFS = [
  {
    name: "probe",
    tier: "READ",
    description: "Inspect a media file with ffprobe: duration, dimensions, codecs, streams. The video block reports the coded size plus rotation (clockwise degrees from the display matrix or rotate tag, null when absent) and the display size — what a player actually shows, so a phone clip coded 1920x1080 with rotation 90 reports display 1080x1920. It also reports time_base, which concat --fast compares before stream-copying.",
    schema: { input: pathSchema },
    handler: async ({ input }) => safe(() => core.probe(input)),
  },


  {
    name: "trim",
    tier: "WRITE",
    description: "Cut a clip out of a media file. Give start (seconds) plus duration OR end. Re-encodes by default for frame-accurate cuts; set stream_copy=true for fast lossless cuts (keyframe boundaries only). With stream_copy, set snap_to_keyframe=true to move start down / end up to the nearest keyframes so the cut lands exactly (see the keyframes tool first), or smart_cut=true to keep the exact start instead: only the head up to the next keyframe is re-encoded (source bitrate x1.2), the rest is stream-copied — exact start, near-lossless speed. Set snap_to_beat=true to move start down / end up to the nearest beats of the music instead (see the beat_grid tool first): the grid is measured from the audio, and the cut refuses when the grid is unreliable (speech, tone, drone — no steady beat to snap to). snap_to_beat works on re-encode cuts too, and refuses snap_to_keyframe and smart_cut. Set edge_buffer (0-1s, default 0) to widen the requested window by that much on both sides, clamped to the file edges — Outtake's 0.1s clip-edge buffer, so the cut never lands exactly on a word or action onset; the result reports requested_start/requested_end plus edge_buffer_applied (how much each side actually grew — less at the file edges). It composes with snap_to_keyframe/snap_to_beat (the buffer widens first, then the snap moves the buffered window) and refuses smart_cut (which lands the start exactly). Every video trim verifies the cut by default: check_frames compares 3 frames of the output (head/middle/tail) against the source at the requested times and reports cut_verified plus mean_abs_diff per frame (threshold max(5, normal_step)); a snap that moved the cut shows up as mismatched frames, but a buffer-only trim checks against the buffered start, so it verifies. Set check_frames=false to skip the verification. Set dry_run=true to print the exact ffmpeg command(s) that would run and write no file.",
    schema: {
    input: pathSchema,
    output: pathSchema.describe("Output file path"),
    start: z.number().min(0).default(0).describe("Start time in seconds"),
    duration: z.number().positive().optional().describe("Clip length in seconds"),
    end: z.number().positive().optional().describe("End time in seconds (alternative to duration)"),
    stream_copy: z.boolean().default(false).describe("Copy streams without re-encoding (fast, keyframe-accurate only)"),
    snap_to_keyframe: z.boolean().default(false).describe("With stream_copy only: snap start/end to the nearest keyframes (start down, end up)"),
    snap_to_beat: z.boolean().default(false).describe("Snap start/end to the nearest beats of the music (start down, end up; see beat_grid first). Works on re-encode cuts too; refuses snap_to_keyframe and smart_cut, and refuses when the measured beat grid is unreliable"),
    snap_beat_method: z.enum(["grid", "dp"]).default("grid").describe("Which beat grid snap_to_beat snaps to: grid (one steady tempo for the whole file) or dp (the DP tracker follows real onset peaks, so it stays on the beat when the tempo drifts — see beat_grid)"),
    smart_cut: z.boolean().default(false).describe("With stream_copy only: exact start by re-encoding only the head up to the next keyframe (source bitrate x1.2); refuses snap_to_keyframe"),
    edge_buffer: z.number().min(0).max(1).default(0).describe("Seconds of handle kept past each edge of the requested window (default 0): start moves earlier and end later by this much, clamped to the file edges — Outtake's 0.1s clip-edge buffer, so a cut never lands exactly on a word or action onset. Composes with snap_to_keyframe/snap_to_beat (buffer first, then snap); refuses smart_cut"),
    check_frames: z.boolean().default(true).describe("Verify the cut: compare 3 output frames against the source at the requested times (default true; false skips the check, audio-only inputs have nothing to check)"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command(s) that would run (one for a plain cut, three for smart_cut: head re-encode, tail copy, concat) and write no file"),
  },
    handler: async (a) => safe(() => core.trim({
    input: a.input,
    output: a.output,
    start: a.start,
    duration: a.duration ?? null,
    end: a.end ?? null,
    streamCopy: a.stream_copy,
    snapToKeyframe: a.snap_to_keyframe,
    snapToBeat: a.snap_to_beat,
    snapBeatMethod: a.snap_beat_method ?? "grid",
    smartCut: a.smart_cut,
    edgeBuffer: a.edge_buffer ?? 0,
    checkFrames: a.check_frames ?? true,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "crop",
    tier: "WRITE",
    description: "Crop a video to a rectangle. width/height/x/y in pixels; must fit inside the source frame. Set dry_run=true to print the exact ffmpeg command and write no file.",
    schema: {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(2),
    height: z.number().int().min(2),
    x: z.number().int().min(0).default(0),
    y: z.number().int().min(0).default(0),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.crop({
    input: a.input,
    output: a.output,
    width: a.width,
    height: a.height,
    x: a.x,
    y: a.y,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "resize",
    tier: "WRITE",
    description: "Resize a video. Give width and/or height; with keep_aspect (default) the other dimension follows the aspect ratio and is rounded to an even number. Or give preset (360p/480p/720p/1080p/2160p): the frame is fit inside that box, preserving aspect, and never upscaled. Set dry_run=true to print the exact ffmpeg command and write no file.",
    schema: {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(2).optional(),
    height: z.number().int().min(2).optional(),
    keep_aspect: z.boolean().default(true),
    preset: z.enum(["360p", "480p", "720p", "1080p", "2160p"]).optional().describe("Named preset box: 360p=640x360, 480p=854x480, 720p=1280x720, 1080p=1920x1080, 2160p=3840x2160; fit inside, never upscale; cannot combine with width/height"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.resize({
    input: a.input,
    output: a.output,
    width: a.width ?? null,
    height: a.height ?? null,
    keepAspect: a.keep_aspect,
    preset: a.preset ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "extract_audio",
    tier: "WRITE",
    description: "Extract the audio track to mp3, aac, wav, ogg, opus or flac (from the output extension). Set whisper=true for the Whisper ASR preset: 16 kHz mono WAV (the output is renamed to .wav when needed) — the direct input for a transcribe step. Set channel (0-based) to pick one channel out of a multi-channel input and return it as mono. Set dry_run=true to print the exact ffmpeg command and write no file (duration/size/output_codec report null — measured on the real output; with whisper=true the sample rate/channels are forced by the command, so they are exact).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    format: z.enum(["mp3", "aac", "wav", "ogg", "opus", "flac"]).optional().describe("Overrides the output extension (ignored when whisper=true)"),
    whisper: z.boolean().default(false).describe("Whisper preset: force 16 kHz mono WAV, rename output to .wav"),
    channel: z.number().int().min(0).max(63).optional().describe("Channel index (0-based) to extract as mono from a multi-channel input; refused when out of range"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.extractAudio({
    input: a.input,
    output: a.output,
    format: a.format ?? null,
    whisper: a.whisper,
    channel: a.channel ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "extract_frame",
    tier: "WRITE",
    description: "Grab a single frame at a timestamp as PNG/JPG/WebP. Frame-accurate: the frame is captured at the exact timestamp (two-stage seek), not the keyframe before it.",
    schema: {
    input: pathSchema,
    output: pathSchema,
    timestamp: z.number().min(0).default(0).describe("Timestamp in seconds"),
  },
    handler: async (a) => safe(() => core.extractFrame(a)),
  },


  {
    name: "thumbnail",
    tier: "WRITE",
    description: "Build a contact sheet: N evenly spaced frames tiled into a grid image. Each tile is captured at its own exact timestamp and labelled with it (timestamps=true by default), so the sheet shows WHEN each frame is, not just what it shows — look at it before cutting or publishing. start_delay_percent / end_delay_percent skip the first/last slice of the file (intros, credits) before spacing the tiles. header=true adds a metadata band on top (filename, measured duration, resolution, fps, codecs, size, grid) so a forwarded sheet still says which file it came from. timestamps_list names every tile time explicitly (seconds or MM:SS each; sets the tile count, cannot combine with the delay percents). sharpest=true picks the sharpest frame in each tile's window instead of the window start (Laplacian mean measured on disk; each tile reports its sharpness) — use it when the sheet must show the cleanest frame, not just the first one.",
    schema: {
    input: pathSchema,
    output: pathSchema,
    frames: z.number().int().min(1).max(64).default(6),
    columns: z.number().int().min(1).max(8).default(3),
    width: z.number().int().min(80).max(1280).default(320).describe("Width of each tile in pixels"),
    timestamps: z.boolean().default(true).describe("Label each tile with its timestamp (MM:SS.d); set false for a clean sheet"),
    header: z.boolean().default(false).describe("Add a metadata band on top: filename, duration, resolution, fps, codecs, size, grid"),
    start_delay_percent: z.number().min(0).max(90).default(0).describe("Skip this percent of the file at the start before spacing tiles (intros)"),
    end_delay_percent: z.number().min(0).max(90).default(0).describe("Skip this percent of the file at the end before spacing tiles (credits)"),
    timestamps_list: z.array(z.union([z.number(), z.string()])).min(1).max(64).optional().describe("Explicit tile times in seconds or MM:SS (e.g. [1, 6, \"0:30\"]); sets the tile count, cannot combine with the delay percents"),
    sharpest: z.boolean().default(false).describe("Pick the sharpest frame in each tile's window (Laplacian mean, measured on disk) instead of the window start"),
    sharpest_samples: z.number().int().min(2).max(16).default(5).describe("Candidate frames sampled per window when sharpest=true (default 5)"),
  },
    handler: async (a) => safe(() => core.thumbnail({
      input: a.input,
      output: a.output,
      frames: a.frames,
      columns: a.columns,
      width: a.width,
      timestamps: a.timestamps,
      header: a.header,
      startDelayPercent: a.start_delay_percent,
      endDelayPercent: a.end_delay_percent,
      timestampsList: a.timestamps_list ?? null,
      sharpest: a.sharpest,
      sharpestSamples: a.sharpest_samples,
    })),
  },


  {
    name: "loudness",
    tier: "WRITE",
    description: "Normalize loudness to a target (default -14 LUFS, the YouTube/Spotify standard) with two-pass loudnorm: the input is measured first, then the exact linear gain is applied, and the output is re-measured on disk. Pass compressor=true for quiet, high-crest speech (a gentle compressor, threshold -24 dB / ratio 4 by default, runs before the loudnorm pass — without it a peak-limited voice stalls below target and the result says so in `warning`). Good for speech and creator audio. Set dry_run=true to print the exact ffmpeg command(s) that would run and write no file (the loudnorm measurement still runs, read-only; with a compressor the loudnorm measured_* values come from the uncompressed input because the real run re-measures the compressed temp first — the note says so).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    target_lufs: z.number().min(-70).max(0).default(-14),
    format: z.enum(["mp3", "aac", "wav", "ogg", "opus", "flac"]).optional(),
    compressor: z.boolean().optional().describe("Run a gentle compressor (threshold -24 dB, ratio 4, peak detection) before the loudnorm pass — for quiet, high-crest speech that two-pass alone cannot lift to target"),
    compressor_threshold: z.number().min(-60).max(0).optional().describe("Compressor threshold in dB (default -24, only with compressor=true)"),
    compressor_ratio: z.number().min(1).max(20).optional().describe("Compressor ratio (default 4, only with compressor=true)"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command(s) that would run (two when a compressor is used: render the temp, then normalize) and write no file"),
  },
    handler: async (a) => safe(() => core.loudness({
    input: a.input,
    output: a.output,
    targetLufs: a.target_lufs,
    format: a.format ?? null,
    compressor: a.compressor ? { threshold_db: a.compressor_threshold ?? -24, ratio: a.compressor_ratio ?? 4 } : null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "concat",
    tier: "WRITE",
    description: "Join 2+ media files into one. By default it probes the clips first: identical clips (codec, size, fps, pixel format, time_base, audio) are stream-copied with no re-encoding (fast, lossless); differing clips are re-encoded so the join still works — except a time_base mismatch, a display-size mismatch, or any rotation difference, which go through the filter graph instead of the demuxer, because the demuxer copies timestamps verbatim and stretches the join (measured 10s+10s → 116.9s) and applies the first clip's display-matrix rotation to every clip (an upright second clip came out rotated 90 degrees and stretched). Size is compared on display dimensions (what the viewer sees after autorotate): a clip stored 1280x720 with rotation 90 displays 720x1280, and fast=true additionally needs identical stored dims + rotation. Set fast=true to require the stream-copy path (errors with the exact mismatch if clips differ), or fast=false to always re-encode. Set transition (e.g. fade, wipeleft, dissolve, circlecrop) to crossfade between clips instead of a hard cut — clips are normalized to the first clip's display size/fps first, and the output is sum(durations) minus (n-1) x transition_duration. Per-clip trim: give an input as {file, start, end} (seconds or MM:SS) — trims always re-encode with exact cuts, and fast=true refuses them (stream-copy cuts snap to keyframes). Set dry_run=true to print the exact ffmpeg command that would run and write no file (the demuxer path also returns list_file + list_content — write the content to that path first, then run the printed command as-is; the transition and trim paths print one exact filter-graph command; mode/expected_duration are computed from the probes, so they are exact; duration/size report null — measured on the real output).",
    schema: {
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
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command that would run and write no file (the demuxer path also returns list_file + list_content — write the content to that path first, then run the command as-is)"),
  },
    handler: async (a) => safe(() => core.concat({
    inputs: a.inputs,
    output: a.output,
    videoCodec: a.video_codec,
    audioCodec: a.audio_codec,
    transition: a.transition ?? null,
    transitionDuration: a.transition_duration,
    fast: a.fast ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "frames",
    tier: "WRITE",
    description: "Extract N evenly spaced frames as separate image files (frame-001.png, ...) into a directory, each with its timestamp — so you can actually look at what is in a video before cutting it. One frame per interval; timestamps are i * duration / count, and each frame is captured at its exact timestamp (two-stage seek), so the reported time is the frame's real time. sharpest=true picks the sharpest frame in each interval instead of the interval start (Laplacian mean, measured on disk; each entry reports sharpness and its window) — use it when a frame must be the cleanest one in its stretch, e.g. picking a cover frame out of a shaky pan.",
    schema: {
    input: pathSchema,
    output_dir: pathSchema.describe("Directory to write the frame files into (created if needed)"),
    count: z.number().int().min(1).max(120).default(6).describe("Number of frames to extract"),
    format: z.enum(["png", "jpg", "webp"]).default("png"),
    width: z.number().int().min(80).max(3840).optional().describe("Scale frames to this width (keeps aspect)"),
    sharpest: z.boolean().default(false).describe("Pick the sharpest frame in each interval (Laplacian mean, measured on disk) instead of the interval start"),
    sharpest_samples: z.number().int().min(2).max(16).default(5).describe("Candidate frames sampled per interval when sharpest=true (default 5)"),
  },
    handler: async (a) => safe(() => core.extractFrames({
    input: a.input,
    outputDir: a.output_dir,
    count: a.count,
    format: a.format,
    width: a.width ?? null,
    sharpest: a.sharpest,
    sharpestSamples: a.sharpest_samples,
  })),
  },


  {
    name: "extract_frames",
    tier: "WRITE",
    description: "Export EVERY frame of a clip (or a time range) as a sequence of images (frame-0001.png, ...) into a directory — the full sequence, not N samples like frames. Use it to scrub a shot frame by frame: a fast move, a blink, a lip-sync slip that a 6-frame sample hides. fps defaults to the source frame rate (every frame); set it lower for a sparser sequence. Frame i lands at start + i/fps, and the count is verified on disk against round((end-start) * fps). PNG is written rgba (keeps alpha, e.g. ProRes 4444 sources). Refuses over 5000 frames — lower fps or shorten the range instead of filling the disk. Set dedup (0-10) to drop near-duplicate frames after extraction — one extra decode into 16x16 gray thumbs (siemd2/reel-relay's rule: a frame whose thumb differs from the last kept thumb by <= threshold is deleted); 2.0 is their summary default but collapses slow motion (measured: 8/20 of moving testsrc kept), so 0.5-1 only drops truly frozen frames. Set dry_run=true to print the exact ffmpeg command and write no file.",
    schema: {
    input: pathSchema,
    output_dir: pathSchema.describe("Directory to write the frame files into (created if needed)"),
    format: z.enum(["png", "jpg", "webp"]).default("png"),
    fps: z.number().min(0.1).max(120).optional().describe("Frames per second to extract (default: the source frame rate, i.e. every frame)"),
    start: z.union([z.number(), z.string()]).optional().describe("Range start in seconds or MM:SS (default 0)"),
    end: z.union([z.number(), z.string()]).optional().describe("Range end in seconds or MM:SS (default the end of the file)"),
    width: z.number().int().min(80).max(3840).optional().describe("Scale frames to this width (keeps aspect)"),
    quality: z.number().int().min(1).max(100).optional().describe("jpg/webp quality 1-100 (default jpg q 2, webp libwebp 75); refused for png, which is lossless"),
    dedup: z.number().min(0).max(10).optional().describe("Near-duplicate removal threshold (mean abs diff on 16x16 gray thumbs, 0-255 scale; omit to keep every frame). 2.0 is reel-relay's summary default — it keeps 1/20 of a frozen clip but only 8/20 of steadily moving testsrc, so it collapses slow motion; 0.5-1 only drops truly frozen frames. Dropped frames are deleted from disk and keep their original timestamps on the survivors"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.extractFramesSequence({
    input: a.input,
    outputDir: a.output_dir,
    format: a.format,
    fps: a.fps ?? null,
    start: a.start ?? null,
    end: a.end ?? null,
    width: a.width ?? null,
    quality: a.quality ?? null,
    dedup: a.dedup ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "burn_captions",
    tier: "WRITE",
    description: "Burn subtitles into the video (hardcoded, always visible). Accepts .srt, .ass or .vtt. Style: background (default — white text on a semi-transparent black box), outline (black outline, no box), shadow (thin outline + drop shadow), or glow (thick halo in the text's own colour, reads on bright footage). Defaults scale with frame height: ~60px type on 1080x1920, sitting ~500px above the bottom edge so platform UI (bottom ~480px) never covers the text. Explicit font_size / margin_v override. max_lines shrinks the type (measured with the same font libass draws, Liberation Sans) until every cue wraps to at most that many lines, never below a readability floor (1.6% of frame height, min 16px); a cue that still overflows at the floor burns at the floor and reports fit.fits=false. platform sets the default margin from that platform's own bottom UI depth (tiktok 520px at 1920 high, youtube 100px at 1080 high) and narrows the fit width to its text-safe rect; explicit margin_v wins. .ass files carry their own styles, so style, max_lines and the platform margin are ignored there (style_applied=false, fit=null with a note). Set dry_run=true to print the exact ffmpeg command and write no file (font_size/margin/style/fit are computed from the input, so they are exact; duration/size report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    captions: pathSchema.describe("Path to the .srt/.ass/.vtt file"),
    font_size: z.number().int().min(8).max(200).optional().describe("Font size in px; default scales with frame height (~60px at 1920 high)"),
    margin_v: z.number().int().min(0).optional().describe("Distance from bottom edge in px; default is 26% of frame height (above platform UI), or the platform's bottom UI depth when platform is set"),
    style: z.enum(["background", "outline", "shadow", "glow"]).optional().describe("Caption style; default background (boxed). Ignored for .ass inputs"),
    outline_color: z.string().optional().describe("Outline colour for outline/shadow styles: name (white/black/yellow/cyan/red/green/blue/orange/magenta) or RRGGBB hex; default black"),
    max_lines: z.number().int().min(1).max(4).optional().describe("Fit-to-width: shrink the font until every cue wraps to at most this many lines (default 2 in spirit, off unless set); never below the readability floor. Ignored for .ass inputs"),
    platform: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin"]).optional().describe("Destination platform: default margin_v becomes that platform's bottom UI depth, and the fit width narrows to its text-safe rect. Explicit margin_v wins"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.burnCaptions({
    input: a.input,
    output: a.output,
    captions: a.captions,
    fontSize: a.font_size ?? null,
    marginV: a.margin_v ?? null,
    style: a.style ?? null,
    outlineColor: a.outline_color ?? "black",
    maxLines: a.max_lines ?? null,
    platform: a.platform ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "reframe",
    tier: "WRITE",
    description: "Reframe a video to a target aspect/size in one step (e.g. 16:9 to 9:16 vertical 1080x1920). mode crop cuts the target aspect out (centre, or x/y anchor, or a named anchor: left/right/top/bottom/top-left/... to keep an edge subject in frame); pad letterboxes with black bars; blur fills the empty area with a blurred copy of the frame. Crop mode reports crop_kept_percent and warns below 40% kept (upscaled, may look soft). Set dry_run=true to print the exact ffmpeg command and write no file (crop/kept-percent are computed from the input geometry, so they are exact; duration/size report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(2).default(1080).describe("Target width in pixels (must be even)"),
    height: z.number().int().min(2).default(1920).describe("Target height in pixels (must be even)"),
    mode: z.enum(["crop", "pad", "blur"]).default("crop"),
    x: z.number().int().min(0).optional().describe("Crop anchor: left offset of the crop window (crop mode only)"),
    y: z.number().int().min(0).optional().describe("Crop anchor: top offset of the crop window (crop mode only)"),
    anchor: z.enum(["center", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"]).optional().describe("Named crop anchor (crop mode only); explicit x/y win over it"),
    blur: z.number().min(0).max(100).default(20).describe("Blur strength for the background fill (blur mode only)"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.reframe({
    input: a.input,
    output: a.output,
    width: a.width,
    height: a.height,
    mode: a.mode,
    x: a.x ?? null,
    y: a.y ?? null,
    anchor: a.anchor ?? null,
    blur: a.blur,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "check",
    tier: "READ",
    description: "Verify a finished file against a platform delivery spec (tiktok, reels, shorts, youtube): dimensions, codecs, fps, duration limit, audio channels and measured loudness, plus a file-size limit where the platform has one. Video bitrate is checked as a warning only (platforms publish recommendations, not gates) and the result also reports the platform's text-safe zone. expected_duration fails the check when the measured duration is more than 0.5s off the brief (same tolerance as qa_report). audio_sync is always checked when both streams carry a duration: the video and audio stream lengths must agree within ±0.2s, or the file fails (a mux that pads or truncates one stream drifts captions and sync on some players); when either duration is missing the rule is skipped, not failed. With content=true, one extra decode pass scans for black frames, frozen frames, silence and audio peaks (0.1s windows above peak_threshold_db, default -1 dBFS; >= 0 dBFS is clipping) and folds them into the same pass/fail list with position-aware rules (a short black stretch at the very start/end is a warning — likely a fade — the same stretch mid-file fails). content_start/content_end (seconds) scan only that time range, reported on the file's own timeline. With baseline (a JSON file: a previous check --content result, a raw content result, or a plain {black, freeze, silence, peaks} span list — needs content=true), spans already in the baseline are reported as pre-existing and do not fail the gate, so only NEW spans fail: a render is judged on what it introduced, not on what the source already had (a detected interval counts as pre-existing when it overlaps a baseline span of the same kind by >= 50% of its own duration). With decoded_work=true, the decoded work is estimated from the probe (video pixel-frames + audio sample-channels) and warned when over the ceiling (250B pixel-frames / 6B sample-channels, plus per-stream limits: 3600s, 8192px, 120fps, 8ch, 192kHz) — a heavy input can OOM the machine before any tool reports progress. With palette (2-6 hex colors, e.g. \"#DCC0A0,#A02D19,#1B2740\") or palette_brand (amber-teal | warm-story | minimal-line, the same registry as assemble), frames are sampled at 2 fps and measured against the locked look: time-averaged share per color, off-palette share (pixels farther than 60 RGB from every palette color), mean luma, crushed/blown share and luma swing — crushed or blown past 2% fails, a mean luma outside 95-175 or more than half the pixels off-palette only warns. Policy tiers (idea: OpenEdit qc/policy.py): policy=full (default) runs every requested detector; light runs probe-based rules only and refuses content/baseline/palette (decode-heavy detectors are skipped, reported in `skipped` with complete:false — a light pass is not a full verification); skip runs nothing at all (no probe, no decode) and returns pass:true, complete:false with the skipped list — the stamp for a cache-hit proxy render. Env MEDIAKIT_QC_POLICY sets the default when policy is absent. With stamp=true it also writes a QC stamp sidecar <input>.mediakit-check.json (the verdict + the exact args + the media sha256/size + the ffmpeg/ffprobe versions, written atomically); with use_stamp=true it reuses the stamp instead of re-running the check when the media, the args and the toolchain all still match, and reports stamp.used=false with the stale reason (no_stamp/media_changed/args_mismatch/environment_mismatch/stamp_invalid) when they do not — a stamp never overrides a fresh run. stamp/use_stamp are refused under policy skip (a skip measures nothing, so there is nothing to stamp or reuse). Returns pass/fail per rule with fix hints. Run this before publishing.",
    schema: {
    input: pathSchema,
    platform: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin"]).default("tiktok"),
    expected_duration: z.number().min(0).optional().describe("Expected duration in seconds (fail when the measured duration is more than 0.5s off)"),
    content: z.boolean().default(false).describe("Also scan content: black/frozen frames, silence and audio peaks; adds content_black/content_freeze/content_silence/content_peaks rules"),
    content_start: z.number().min(0).optional().describe("Scan only from this time (seconds); needs content=true"),
    content_end: z.number().min(0).optional().describe("Scan only up to this time (seconds); needs content=true"),
    peak_threshold_db: z.number().min(-60).max(12).default(-1).describe("Audio peak threshold in dBFS for the content_peaks rule (windows above it are reported; >= 0 dBFS is clipping; float audio can peak above 0)"),
    baseline: pathSchema.optional().describe("Baseline JSON file (a previous check --content result, a raw content result, or a plain {black, freeze, silence, peaks} span list): spans it covers are reported as pre-existing and do not fail the gate — only NEW spans fail; needs content=true"),
    faststart: z.boolean().default(false).describe("Also check MP4 faststart (moov before mdat, measured by a pure-Node box walk) — fails when the file is not an MP4 or its moov box comes after mdat; re-mux with -movflags +faststart to fix"),
    decoded_work: z.boolean().default(false).describe("Also estimate the decoded work from the probe (video pixel-frames + audio sample-channels) and warn when it is over the ceiling (250B pixel-frames / 6B sample-channels, plus per-stream limits: 3600s, 8192px, 120fps, 8ch, 192kHz) — a heavy input can OOM the machine before any tool reports progress"),
    palette: z.string().optional().describe("Locked look as 2-6 comma-separated hex colors, e.g. \"#DCC0A0,#A02D19,#1B2740\": frames are sampled at 2 fps and measured against it (time-averaged share per color, off-palette share, mean luma, crushed/blown share, luma swing) — crushed or blown past 2% fails; mutually exclusive with palette_brand"),
    palette_brand: z.string().optional().describe("Locked look as a brand id (amber-teal | warm-story | minimal-line, same registry as assemble): the brand palette is measured instead of explicit colors; mutually exclusive with palette"),
    policy: z.enum(["skip", "light", "full"]).optional().describe("QC policy tier (idea: OpenEdit qc/policy.py): full (default) runs every requested detector; light runs probe-based rules only and refuses content/baseline/palette — decode-heavy detectors are skipped, reported in `skipped` with complete:false; skip runs nothing at all (no probe, no decode) and returns pass:true, complete:false with the skipped list. Env MEDIAKIT_QC_POLICY sets the default when absent"),
    stamp: z.boolean().default(false).describe("Write a QC stamp sidecar <input>.mediakit-check.json (the verdict + the exact args + the media sha256/size + the ffmpeg/ffprobe versions, written atomically); refused under policy skip (a skip measures nothing, so there is nothing to stamp)"),
    use_stamp: z.boolean().default(false).describe("Reuse the QC stamp instead of re-running the check when the media, the args and the toolchain all still match; reports stamp.used=false with the stale reason (no_stamp/media_changed/args_mismatch/environment_mismatch/stamp_invalid) when they do not — a stamp never overrides a fresh run; refused under policy skip"),
  },
    handler: async (a) => safe(() => core.check({
    input: a.input,
    platform: a.platform,
    expectedDuration: a.expected_duration ?? null,
    content: a.content,
    contentStart: a.content_start ?? null,
    contentEnd: a.content_end ?? null,
    peakThresholdDb: a.peak_threshold_db,
    baseline: a.baseline ?? null,
    faststart: a.faststart,
    decodedWork: a.decoded_work,
    palette: a.palette ?? null,
    paletteBrand: a.palette_brand ?? null,
    policy: a.policy ?? null,
    stamp: a.stamp,
    useStamp: a.use_stamp,
  })),
  },


  {
    name: "qa_report",
    tier: "READ",
    description: "One-call delivery gate for a finished file: even dimensions, yuv420p pixel format, frame rate, aspect ratio and length for the target (tiktok, reels, shorts, youtube, instagram-feed, instagram-story, linkedin, or any for a platform-free file), measured loudness in -16..-12 LUFS and true peak, black/frozen frames and dead air (silence over 2s), pacing (average shot length from real scene cuts), and an optional expected duration. Probe-only — writes no file. Returns one verdict (pass/warn/fail) plus a per-check list with details; run this, plus thumbnail, on every deliverable before calling it done.",
    schema: {
    input: pathSchema,
    target: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin", "any"]).default("any").describe("Delivery target; 'any' skips aspect ratio and platform length"),
    expected_duration: z.number().min(0).optional().describe("Expected duration in seconds (fail when the measured duration is more than 0.5s off)"),
  },
    handler: async (a) => safe(() => core.qaReport({
    input: a.input,
    target: a.target,
    expectedDuration: a.expected_duration ?? null,
  })),
  },


  {
    name: "grade",
    tier: "WRITE",
    description: "Color-grade a video with a named preset (warm, cool, cinematic, noir, vintage) or one custom video filter chain (--filter). Re-encodes video (libx264, crf 23 default), copies audio through untouched. The result reports the filter actually applied and the mean R/G/B of the middle frame before and after, measured on disk — so the grade is verified on pixels, not assumed from the filter string. Presets are fixed chains: warm pushes red and pulls blue, cool does the opposite, noir is black-and-white, vintage is faded and desaturated. Set dry_run=true to print the exact ffmpeg command and write no file (color_before is still measured on the input, read-only; color_after reports null — it is measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    preset: z.enum(["warm", "cool", "cinematic", "noir", "vintage"]).optional().describe("Named grade preset (default warm when neither preset nor filter is given; mutually exclusive with filter)"),
    filter: z.string().optional().describe("One custom video filter chain, e.g. 'eq=saturation=0.5' (mutually exclusive with preset)"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
    cdl: z.object({
      slope: z.array(z.number().min(0).max(4)).length(3).optional().describe("ASC CDL slope per channel [r, g, b] (0-4, default 1,1,1)"),
      offset: z.array(z.number().min(-1).max(1)).length(3).optional().describe("ASC CDL offset per channel [r, g, b] (-1 to 1, default 0,0,0)"),
      power: z.array(z.number().min(0.1).max(4)).length(3).optional().describe("ASC CDL power (gamma) per channel [r, g, b] (0.1-4, default 1,1,1)"),
      saturation: z.number().min(0).max(4).optional().describe("ASC CDL saturation (0-4, 0 = grayscale, 1 = unchanged, default 1)"),
    }).optional().describe("ASC CDL grade (mutually exclusive with preset and filter); applied per channel with a LUT, saturation on top"),
  },
    handler: async (a) => safe(() => core.grade({
    input: a.input,
    output: a.output,
    preset: a.preset ?? null,
    filter: a.filter ?? null,
    crf: a.crf,
    cdl: a.cdl ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "make_loopable",
    tier: "WRITE",
    description: "Make a clip loop seamlessly: crossfade the tail into the head (tail-to-head crossfade, moviepy MakeLoopable idea), so the end flows back into the start with no visible jump or audio click. The output is the overlap shorter (a 10s clip with 0.5s overlap becomes 9.5s) and re-encodes (libx264, crf 23 default). Works on audio-only input too (acrossfade only). The result measures the loop on disk: seam_before vs seam_after (mean abs gray difference between the last and first frames) plus normal_step (two neighbouring mid frames) as the baseline — a good seam lands at the normal step, not at zero. Set dry_run=true to print the exact ffmpeg command and write no file (seam_before is measured on the input, so it is exact; seam_after/normal_step/duration report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    overlap: z.number().min(0.1).max(3600).default(0.5).describe("Crossfade length in seconds (default 0.5; 0.3-0.5s is enough for slow motion, 1s for very different start/end poses). Must be under half the clip duration so a middle section remains"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.makeLoopable({
    input: a.input,
    output: a.output,
    overlap: a.overlap,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "freeze",
    tier: "WRITE",
    description: "Hold one frame still for N seconds: insert a frozen-frame segment at time `at` (default the end of the clip — hold the last frame, the end-card use), so the clip grows by exactly the hold and the tail keeps its place in the timeline (moviepy Freeze idea). The frozen frame is the frame starting at or before `at`. Audio in the hold is silence (not the original audio continuing — that would leave the video longer than the audio and force trailing silence); the audio timeline is [0,at] + silence(hold) + [at,end]. Re-encodes video (libx264, crf 23 default), AAC pinned 192k. The result measures the freeze on disk: frozen_frame_diff (input frame vs output frame mid-hold, ~0 when truly frozen) and post_frame_diff (input frame after the freeze point vs the same frame in the output tail, ~0 when the tail kept its place; null when the hold sits on the last frame). Set dry_run=true to print the exact ffmpeg command and write no file (frame_index/frame_seconds are computed from the input's frame count, so they are exact; the diffs and the duration report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    at: z.union([z.number().min(0), z.string()]).optional().describe("Time to freeze, in seconds or MM:SS (default: the end of the clip, i.e. hold the last frame). Must not be past the end of the clip"),
    hold: z.number().min(0.1).max(30).default(2).describe("Hold length in seconds (default 2; 0.1-30)"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.freezeFrame({
    input: a.input,
    output: a.output,
    at: a.at ?? null,
    hold: a.hold,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "fastforward",
    tier: "WRITE",
    description: "Speed up marked spans of a clip and burn a badge on them (khang-nyb/demo-recorder's render() idea: their demo tool fast-forwards dead backend waits and stamps \">> tua nhanh x8\" on the sped footage; this is the general version). The timeline is split into pieces — normal spans at 1x, marked spans at N x — and re-joined, so the output is shorter by exactly the saved time and everything after a span keeps its place. Video speeds up with setpts, audio keeps its pitch with chained atempo. Spans are clamped to the clip, sorted, and overlaps collapse onto the previous span's end instead of failing on input order. The badge is a dark box + text bottom-right, sized from the display frame height (same relative size on vertical and landscape clips); set badge false to skip it. Re-encodes video (libx264, crf 23 default), AAC pinned 192k. The result measures the speed-up on disk: duration_expected vs duration_seconds, timing_check_mapped (input frame mid-span vs the output frame it should land on, ~0 when the mapping is right) vs timing_check_unmapped, and the frame count. Set dry_run=true to print the exact ffmpeg command and write no file (duration/timing/frames report null — measured on the real output; the badge label files are written to a deterministic temp dir and kept, so the printed command runs as-is).",
    schema: {
    input: pathSchema,
    segments: z.array(z.object({
      start: z.union([z.number().min(0), z.string()]).describe("Span start, seconds or MM:SS"),
      end: z.union([z.number().min(0), z.string()]).describe("Span end, seconds or MM:SS (must be after start)"),
      speed: z.number().min(1.1).max(16).describe("Speed factor for this span, 1.1-16 (1.1 = barely faster, 16 = sixteen times faster)"),
    })).min(1).max(16).describe("1-16 spans to speed up, in any order (sorted; overlaps collapse onto the previous span's end)"),
    output: pathSchema,
    badge: z.boolean().default(true).describe("Burn the \">> fast-forward xN\" badge on sped spans (default true)"),
    label: z.string().optional().describe("Badge word (default \"fast-forward\"); the badge reads \">> <label> x<speed>\""),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.fastForwardClip({
    input: a.input,
    segments: a.segments,
    output: a.output,
    badge: a.badge,
    label: a.label ?? null,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "reverse",
    tier: "WRITE",
    description: "Play a clip backwards: video frames reversed with the `reverse` filter, audio reversed with `areverse` (on by default; set audio false to keep the audio playing forward under reversed video). Re-encodes video (libx264, crf 23 default). The `reverse` filter buffers every frame, so very long inputs cost memory. The result reports whether video/audio were actually reversed, plus duration measured on disk. Set dry_run=true to print the exact ffmpeg command and write no file (duration/size report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    audio: z.boolean().default(true).describe("Reverse the audio too (default true); false copies the audio forward under the reversed video"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.reverseClip({
    input: a.input,
    output: a.output,
    audio: a.audio,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "rotate",
    tier: "WRITE",
    description: "Rotate or flip a clip: angle 90/180/270 clockwise, or flip horizontal/vertical (exactly one of angle/flip). The angle applies to the frame the viewer sees — ffmpeg autorotates on decode, so a phone clip coded 1280x720 with rotation 90 rotates from its 720x1280 display size (rotate 90 gives 1280x720, rotate 180 keeps 720x1280). The re-encode strips the display-matrix/rotate metadata, so the output reports rotation null and no player double-rotates it (yuan66-hub's rotate has no such guard). Re-encodes video (libx264, crf 23 default), AAC pinned 192k. Set metadata_only=true to rotate WITHOUT re-encoding: only the display-matrix metadata is rewritten (stream copy, coded video packets byte-identical — verified with a packet MD5 on disk), so it is instant and lossless; the angle ADDS to any rotation the input already carries (90 on a rotation-90 clip gives 180; 270 on it strips the matrix to null). Only mp4/mov/mkv (the matrix is a QuickTime/Matroska feature — webm refuses it), angle only, no flip. The result reports input_rotation vs output_rotation plus the display dimensions before and after, measured on disk. Set dry_run=true to print the exact ffmpeg command and write no file (dimensions is the expected display size after the rotation; output_rotation/duration/size report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    angle: z.number().int().optional().describe("Clockwise degrees: 90, 180 or 270 (exactly one of angle/flip)"),
    flip: z.enum(["horizontal", "vertical"]).optional().describe("Flip direction (exactly one of angle/flip)"),
    crf: z.number().int().min(0).max(51).default(23),
    metadata_only: z.boolean().default(false).describe("Rewrite only the display-matrix metadata (stream copy, no re-encode): instant and lossless. mp4/mov/mkv only, angle only, no flip; the angle adds to the input's existing rotation"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.rotateClip({
    input: a.input,
    output: a.output,
    angle: a.angle ?? null,
    flip: a.flip ?? null,
    crf: a.crf,
    dryRun: a.dry_run,
    metadataOnly: a.metadata_only,
  })),
  },


  {
    name: "boomerang",
    tier: "WRITE",
    description: "Play a clip forward then backwards — the ping-pong loop (moviepy TimeSymmetrize/TimeMirror idea): the clip followed by its own reverse, so a bounce, swing or wave returns to where it started with no cut. The peak frame is NOT played twice: the reversed half drops its first frame (moviepy v2.2.1's TimeMirror clipping fix) and the reversed audio drops one video-frame of audio at the same point, so the output is 2D - 1/fps (audio-only input has no video frame to pivot on, so it plays forward + reversed whole, 2D). Re-encodes video (libx264, crf 23 default), AAC pinned 192k. The result measures the seam on disk: seam_diff (output frame just before the seam vs just after it) against normal_step (two neighbouring mid-forward frames) — a good seam lands at the normal step; the frame count (2N-1) is the honest proof the pivot frame was dropped. Set dry_run=true to print the exact ffmpeg command and write no file (pivot/expected duration are computed from the input, so they are exact; seam_diff/normal_step/duration report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    audio: z.boolean().default(true).describe("Reverse the audio too (default true); false copies the audio forward under the ping-pong video"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.boomerangClip({
    input: a.input,
    output: a.output,
    audio: a.audio,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "chroma_key",
    tier: "WRITE",
    description: "Remove a green/blue screen: keys out one color (chromakey filter) and either keeps the transparency (output MUST be .mov, ProRes 4444 — .mp4 has no alpha channel, and this ffmpeg build drops VP9 alpha in .webm) or composites the subject onto a background in the same call (image file or hex color, output .mp4/.webm). similarity 0-1 is the tolerance (too high eats the subject), blend 0-1 softens the edge. The result measures the alpha on disk (middle frame, 0-255): full-frame mean plus corner (should be ~0 for a full-screen key) and center (should be ~255 on the subject). Set dry_run=true to print the exact ffmpeg command and write no file (mode/background are decided before the run; pixel_format/alpha/duration/dimensions/size report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema.describe("Output file path: .mov for transparency, .mp4/.webm when background is given"),
    color: z.string().default("00FF00").describe("Key color as 6-digit hex (default 00FF00 green; 0000FF for blue)"),
    similarity: z.number().min(0).max(1).default(0.1).describe("Color tolerance 0-1 (default 0.1)"),
    blend: z.number().min(0).max(1).default(0).describe("Edge blend 0-1 (default 0)"),
    background: z.string().optional().describe("Optional background to composite onto: an image file path, or a hex color (e.g. 1E40AF). Without it the output keeps transparency and must be .mov"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.chromaKey({
    input: a.input,
    output: a.output,
    color: a.color,
    similarity: a.similarity,
    blend: a.blend,
    background: a.background ?? null,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "zoom_pan",
    tier: "WRITE",
    description: "Ken Burns effect: turn a still image into a moving clip (zoompan filter). Zooms linearly from zoom_from to zoom_to while the focus point moves from (focus_x, focus_y) to (focus_end_x, focus_end_y) — all 0-1 fractions of the frame, 0.5 is center. The input is pre-scaled 1.25x before zooming (avoids the integer-crop jitter zoompan is known for). Input must be a still image, not a video — unless events_file is set: chain mode takes a VIDEO and drives the same zoompan filter (d=1, one output frame per input frame) from an event timeline [{time, x, y, hold?}] (JSON file; a bare array or {\"events\": [...]}). Events closer than chain_gap_seconds group into one chain — the camera stays zoomed and pans between targets, arriving at each exactly at its time; wider gaps split chains and the camera zooms out to the full frame between them. Per chain: zoom-in starts pre_lead_seconds before the first event and takes transition_seconds, the last target is held hold_seconds past its time, then zoom-out takes transition_seconds; pans start pan_seconds before the next event. In chain mode the output keeps the input's dimensions, fps and duration (image-mode options are ignored) and the input audio is copied (AAC 192k). The result counts frames on the output file, so duration and fps are measured, not assumed. Set dry_run=true to print the exact ffmpeg command and write no file (zoom/focus expressions are computed from the arguments, so they are exact; duration/frames report null — measured on the real output).",
    schema: {
    input: pathSchema.describe("Still image file (PNG/JPG/WebP) — or a video file when events_file is set (chain mode)"),
    output: pathSchema,
    duration: z.number().min(0.5).max(600).default(5).describe("Clip length in seconds, image mode only (default 5)"),
    fps: z.number().int().min(1).max(120).default(30).describe("Output frame rate, image mode only (default 30)"),
    zoom_from: z.number().min(1).max(10).default(1).describe("Zoom at the first frame, 1 = full image (default 1)"),
    zoom_to: z.number().min(1).max(10).default(1.5).describe("Zoom at the last frame (default 1.5)"),
    focus_x: z.number().min(0).max(1).default(0.5).describe("Focus point x at the first frame, 0-1 (default 0.5 center)"),
    focus_y: z.number().min(0).max(1).default(0.5).describe("Focus point y at the first frame, 0-1 (default 0.5 center)"),
    focus_end_x: z.number().min(0).max(1).optional().describe("Focus point x at the last frame (default = focus_x)"),
    focus_end_y: z.number().min(0).max(1).optional().describe("Focus point y at the last frame (default = focus_y)"),
    width: z.number().int().min(2).max(7680).default(1280).describe("Output width in pixels, even (default 1280)"),
    height: z.number().int().min(2).max(4320).default(720).describe("Output height in pixels, even (default 720)"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
    events_file: pathSchema.optional().describe("Chain mode: JSON file of camera events [{time, x, y, hold?}] (x/y 0-1, time in seconds, sorted) — switches the input to video and the camera to the event timeline"),
    zoom: z.number().min(1).max(8).default(2).describe("Chain mode: zoom level while zoomed in, 1 = full frame (default 2)"),
    chain_gap_seconds: z.number().min(0.1).max(60).default(2.5).describe("Chain mode: gap between events above which a new chain starts (default 2.5)"),
    transition_seconds: z.number().min(0.05).max(2).default(0.3).describe("Chain mode: seconds to zoom in/out (default 0.3)"),
    pre_lead_seconds: z.number().min(0).max(2).default(0.2).describe("Chain mode: seconds before the first event of a chain to start zooming in (default 0.2)"),
    pan_seconds: z.number().min(0.05).max(2).default(0.25).describe("Chain mode: seconds before the next event to start panning to it (default 0.25)"),
    hold_seconds: z.number().min(0).max(10).default(0.8).describe("Chain mode: seconds to hold the last target of a chain past its event time (default 0.8)"),
  },
    handler: async (a) => safe(() => core.zoomPan({
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
    dryRun: a.dry_run,
    eventsFile: a.events_file ?? null,
    zoom: a.zoom,
    chainGapSeconds: a.chain_gap_seconds,
    transitionSeconds: a.transition_seconds,
    preLeadSeconds: a.pre_lead_seconds,
    panSeconds: a.pan_seconds,
    holdSeconds: a.hold_seconds,
  })),
  },


  {
    name: "image_to_video",
    tier: "WRITE",
    description: "Turn one still image into a fixed-duration video that holds still (no motion — use zoom_pan for Ken Burns). Use it for a podcast still, a song cover, or a title card held over audio. Dimensions default to the image itself; width/height fit the image inside the box and pad black to the exact size. audio loops an audio file to the same duration (a short bed loops, a long one is trimmed). Output .mp4 (H.264) or .webm (VP9). The result counts frames on the output file, so the duration is measured, not assumed. Set dry_run=true to print the exact ffmpeg command and write no file (dimensions/fps/duration are computed from the arguments, so they are exact; frames report null — measured on the real output).",
    schema: {
    input: pathSchema.describe("Still image file (PNG/JPG/WebP)"),
    output: pathSchema,
    duration: z.number().min(0.5).max(600).default(5).describe("Clip length in seconds (default 5)"),
    fps: z.number().int().min(1).max(120).default(30).describe("Output frame rate (default 30)"),
    width: z.number().int().min(2).max(7680).optional().describe("Output width in pixels, rounded down to even (default = image width)"),
    height: z.number().int().min(2).max(4320).optional().describe("Output height in pixels, rounded down to even (default = image height)"),
    audio: pathSchema.optional().describe("Audio file to loop under the still (optional)"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.imageToVideo({
    input: a.input,
    output: a.output,
    duration: a.duration,
    fps: a.fps,
    width: a.width ?? null,
    height: a.height ?? null,
    audio: a.audio ?? null,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "slideshow",
    tier: "WRITE",
    description: "Turn 2-32 still images into one video with an xfade transition between every pair. Each image is visible for its own duration — the transition eats a handle, not slide time — so the total is exactly the sum of the durations. One transition type for all pairs (transition/transition_duration), or a different one per join: transitions (one xfade name per join, n-1 entries) and transition_durations (one length per join, each shorter than both slides it joins). Images are rendered to clips in parallel first, then joined with the concat xfade chain. Pass the slides either as images (paths or {file, duration} objects, in display order) or as images_glob, a pattern like 'slides/*.png' — matched images are used in natural sort order (shot-2 before shot-10), 2-32 images, only still-image files count; pass exactly one of images / images_glob, not both. audio loops a bed under the whole slideshow. Output .mp4 only in v1. The result counts frames on the output file, so the duration is measured, not assumed. Set dry_run=true to print the exact commands for all three stages and write no file (one exact command per slide clip, the exact xfade join command — built by the same builder concat --transition runs — and the exact audio command when a bed is given; run them in order to reproduce the real output; duration/frames report null — measured on the real output).",
    schema: {
    images: z.array(z.union([
      z.string().describe("Image file path"),
      z.object({
        file: z.string().describe("Image file path"),
        duration: z.number().min(0.5).max(600).optional().describe("How long this image stays visible, in seconds (overrides duration/durations for this slide)"),
      }),
    ])).min(2).max(32).optional().describe("Images in display order, as paths or {file, duration} objects — or use images_glob instead"),
    images_glob: z.string().optional().describe("Glob pattern for the slides instead of images, e.g. 'slides/*.png' or '**/*.jpg' — matched images are used in natural sort order (shot-2 before shot-10), 2-32 images, only still-image files count; pass either images or images_glob, not both"),
    output: pathSchema,
    duration: z.number().min(0.5).max(600).default(3).describe("Visible seconds per image when no per-image duration is given (default 3)"),
    durations: z.array(z.number().min(0.5).max(600)).min(2).max(32).optional().describe("One visible duration per image, in order (overrides duration; a per-image duration in images wins over this)"),
    transition: z.string().default("fade").describe("xfade transition between every pair: fade (default), fadeblack, wipeleft, dissolve, circlecrop, ... (one of the 58 names concat accepts — see the transitions tool for the grouped catalog)"),
    transition_duration: z.number().min(0.1).max(10).default(1).describe("Transition length in seconds (default 1, must be shorter than the shortest slide)"),
    transitions: z.array(z.string()).min(1).max(31).optional().describe("One xfade transition name per join, in order (n-1 entries for n images) — overrides transition when given"),
    transition_durations: z.array(z.number().min(0.1).max(10)).min(1).max(31).optional().describe("One transition length per join, in order (n-1 entries) — each must be shorter than both slides it joins; overrides transition_duration when given"),
    fps: z.number().int().min(1).max(120).default(30).describe("Output frame rate (default 30)"),
    width: z.number().int().min(2).max(7680).default(1280).describe("Output width in pixels (default 1280)"),
    height: z.number().int().min(2).max(4320).default(720).describe("Output height in pixels (default 720)"),
    audio: pathSchema.optional().describe("Audio file to loop under the whole slideshow (optional)"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the plan (one exact command per slide clip, the join as a plan, the exact audio command when a bed is given) and write no file"),
  },
    handler: async (a) => safe(() => core.slideshow({
    images: a.images ?? null,
    imagesGlob: a.images_glob ?? null,
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
    dryRun: a.dry_run,
  })),
  },


  {
    name: "interpolate",
    tier: "WRITE",
    description: "Raise a clip's frame rate with motion interpolation (minterpolate): 30fps to 60fps for smoother playback or slow motion. Modes: blend (fast default, cross-fades neighbours), mci (true motion-compensated frames, best quality but much slower — about 9x realtime on CPU), dup (repeats frames). Only raises the frame rate; use fit --max-fps to lower it. The result counts frames on the output file, so the fps is measured, not assumed. Set dry_run=true to print the exact ffmpeg command and write no file (frames_before is counted on the input, so it is exact; fps_after/frames_after report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    fps: z.number().min(1).max(240).describe("Target frame rate, must be above the source fps"),
    mode: z.enum(["mci", "blend", "dup"]).default("blend").describe("Interpolation mode (default blend)"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.interpolate({
    input: a.input,
    output: a.output,
    fps: a.fps,
    mode: a.mode,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "denoise",
    tier: "WRITE",
    description: "Reduce sensor noise on a video: hqdn3d (fast default) or nlmeans (better on fine detail, much slower — minutes for a few seconds of 720p). strength 0-1 maps to hqdn3d 0-30 (0.5 is 15, the strength that gained +2.9 dB PSNR on sigma-10 noise in testing) or nlmeans s 0-10. The result measures high-frequency noise energy before and after (mean |frame minus blurred frame|), so the reduction is measured, not assumed. Set dry_run=true to print the exact ffmpeg command and write no file (noise_before is measured on the input, so it is exact; noise_after reports null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    filter: z.enum(["hqdn3d", "nlmeans"]).default("hqdn3d").describe("Denoise filter (default hqdn3d)"),
    strength: z.number().min(0).max(1).default(0.5).describe("Noise-reduction strength 0-1 (default 0.5)"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.denoise({
    input: a.input,
    output: a.output,
    filter: a.filter,
    strength: a.strength,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "segment",
    tier: "WRITE",
    description: "Cut a video into an HLS VOD playlist: index.m3u8 plus .ts segments in an output directory, ready to serve statically or preview in a player. Stream-copy is the default (fast, lossless) but segments can only start on keyframes, so actual segment lengths follow the source GOP — a sparse-GOP source gives fewer, longer segments than requested; use reencode=true to re-encode to libx264/aac with forced keyframes so segments land exactly on the requested grid. Copy mode refuses non-H.264 video or non-AAC/MP3 audio up front. The result parses the playlist back from disk and stats every segment file, so the count and durations are measured, not assumed. Set dry_run=true to print the exact ffmpeg command and write no file — no directory is created and no stale segments are deleted (segment_count/durations report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output_dir: pathSchema.describe("Output directory for the playlist and .ts segments (created if needed)"),
    segment_time: z.number().min(1).max(60).default(6).describe("Target segment length in seconds (default 6)"),
    playlist: z.string().default("index.m3u8").describe("Playlist filename, must end .m3u8 (default index.m3u8)"),
    segment_prefix: z.string().default("seg").describe("Segment filename stem (default seg -> seg000.ts, seg001.ts, ...)"),
    reencode: z.boolean().default(false).describe("Re-encode to libx264/aac with forced keyframes for exact segment boundaries (default false = stream-copy)"),
    crf: z.number().int().min(0).max(51).default(23),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file (no directory created)"),
  },
    handler: async (a) => safe(() => core.segment({
    input: a.input,
    outputDir: a.output_dir,
    segmentTime: a.segment_time,
    playlist: a.playlist,
    segmentPrefix: a.segment_prefix,
    reencode: a.reencode,
    crf: a.crf,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "convert",
    tier: "WRITE",
    description: "Change container or codec. Omit video_codec/audio_codec to stream-copy that stream. crf 23 is a good default for H.264. gop (frames) or gop_seconds sets an exact keyframe interval on re-encode (scene-cut keyframes disabled for libx264/libx265/mpeg4); the result measures the keyframes on the output file. A GOP is required for keyframe-snapped stream-copy cuts. encoder picks the video encoder: \"auto\" probes for the first working hardware encoder of the codec family and falls back to software when none works (the fallback is reported in encoder_fallback, never silent); a named hardware encoder (h264_nvenc, hevc_qsv, h264_vaapi, ...) must probe-usable or the call fails. The result reports encoder_used and verifies the output codec on disk (codec_verified). Set dry_run=true to print the exact ffmpeg command and write no file.",
    schema: {
    input: pathSchema,
    output: pathSchema,
    video_codec: z.enum(["libx264", "libx265", "vp9", "av1", "mpeg4", "copy"]).optional(),
    audio_codec: z.string().optional().describe("e.g. aac, libmp3lame, copy"),
    crf: z.number().int().min(0).max(51).default(23),
    preset: z.string().default("medium"),
    gop: z.number().int().min(1).max(10000).optional().describe("Keyframe interval in frames (needs a video re-encode; mutually exclusive with gop_seconds)"),
    gop_seconds: z.number().min(0.1).max(3600).optional().describe("Keyframe interval in seconds, converted to frames from the source fps (mutually exclusive with gop)"),
    encoder: z.enum(["auto", ...core.GPU_ENCODERS]).optional().describe("Hardware encoder: \"auto\" probes for the first working encoder of the codec family and falls back to software (reported, never silent); a named encoder must probe-usable or the call fails. Needs a video re-encode (pass video_codec); mpeg4 has no hardware encoder"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file (keyframes report null — they are measured on the real output)"),
  },
    handler: async (a) => safe(() => core.convert({
    input: a.input,
    output: a.output,
    videoCodec: a.video_codec ?? null,
    audioCodec: a.audio_codec ?? null,
    crf: a.crf,
    preset: a.preset,
    gop: a.gop ?? null,
    gopSeconds: a.gop_seconds ?? null,
    dryRun: a.dry_run,
    encoder: a.encoder ?? null,
  })),
  },


  {
    name: "normalize",
    tier: "WRITE",
    description: "Bring a clip to the canonical pipeline profile in one call — the reusable pre-assemble step (yubraaj11/ffmpeg-mcp's normalize-then-join idea): video becomes libx264 + yuv420p + even dimensions + CFR at the source frame rate (or fps), audio becomes AAC 192k at 48 kHz, and MP4 outputs get +faststart, so assemble/concat never have to guess what a clip is. Optional width/height fits the frame inside that box (aspect kept, dims forced even — odd values are refused); optional fps caps the frame rate; optional target_lufs runs the same two-pass loudnorm loudness() uses (measured on the input first). Decode autorotates, so a phone clip stored 1280x720 with rotation 90 normalizes to 720x1280 and the rotation metadata is gone with the re-encode. Always re-encodes — a normalize that sometimes stream-copied would leave odd dims / a VFR timebase in the chain. The result reports before/after (probe-measured) plus a changes list in words, and verifies the output codec + faststart on disk. Video inputs must write .mp4/.mov/.m4v (use convert for other containers); audio-only inputs write an audio format. Set dry_run=true to print the exact ffmpeg command and write no file.",
    schema: {
    input: pathSchema,
    output: pathSchema,
    width: z.number().int().min(16).max(8192).optional().describe("Fit the frame inside this width (aspect kept, must be even)"),
    height: z.number().int().min(16).max(8192).optional().describe("Fit the frame inside this height (aspect kept, must be even)"),
    fps: z.number().min(1).max(120).optional().describe("Cap the frame rate (constant frame rate)"),
    crf: z.number().int().min(0).max(51).default(23),
    preset: z.string().default("medium"),
    target_lufs: z.number().min(-70).max(0).optional().describe("Also normalize loudness to this target (two-pass loudnorm, default off)"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file (before/after report null — measured on the real output)"),
  },
    handler: async (a) => safe(() => core.normalize({
    input: a.input,
    output: a.output,
    width: a.width ?? null,
    height: a.height ?? null,
    fps: a.fps ?? null,
    crf: a.crf,
    preset: a.preset,
    targetLufs: a.target_lufs ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "compress",
    tier: "WRITE",
    description: "Shrink a file with one named quality preset instead of guessing CRF numbers: low (CRF 32), medium (CRF 26), high (CRF 20) or email-25mb (targets 18 MB so the file still fits a 25 MB email attachment after base64 inflation), each with its own x264 preset and audio bitrate. Optional max_width scales the video down first. Set target_size_mb to hit an exact size instead (e.g. 10 for a Discord upload): two-pass ABR encoding from the size + duration budget, with a 10% safety margin; reports target_met measured on disk. In target-size mode a resolution ladder steps the frame down (1080→720→480→360→240) when the bitrate buys less than 0.045 bits per pixel per frame, so a starved encode stays watchable instead of mush; set resolution_ladder=false to keep the source frame. Target-size mode also returns a quality_proof: SSIM measured against the source at 3 sample points plus PSNR mid-clip and a verdict in words (indistinguishable / looks_the_same / slight_softening / visible_loss / clearly_degraded) — VMAF is measured at the mid point when the ffmpeg build has libvmaf (default vmaf_v0.6.1 model); otherwise SSIM is the measured proxy and the proof says so, and the proof rates encode fidelity at the delivered resolution (it does not penalize the ladder's resolution drop; compare dimensions and bpp_after for that tradeoff). Set quality_proof=false to skip the measurement. target_size_mb ignores quality and cannot be combined with crf. Returns the size before/after and the reduction percent actually measured on disk, so the agent can check the tradeoff worked. Set dry_run=true to print the exact ffmpeg command(s) — two passes in target-size video mode — and write no file (bitrate/ladder are computed from the input, so they are exact; size_after/target_met/reduction/quality_proof report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema.describe("Output file path"),
    quality: z.enum(["low", "medium", "high", "email-25mb"]).default("medium").describe("Size/quality tradeoff: low = smallest, high = best quality, email-25mb = target 18 MB for a 25 MB email attachment (ignored when target_size_mb is set)"),
    max_width: z.number().int().min(16).optional().describe("Scale video down to this width first (only when the source is wider)"),
    crf: z.number().int().min(0).max(51).optional().describe("Override the preset's CRF (cannot combine with target_size_mb)"),
    preset: z.string().optional().describe("Override the preset's x264 preset (ultrafast..veryslow)"),
    target_size_mb: z.number().min(0.05).max(10000).optional().describe("Target size in decimal MB (1 MB = 1,000,000 bytes): two-pass encode to fit under it"),
    resolution_ladder: z.boolean().default(true).describe("In target-size mode, step the frame down when the bitrate buys less than 0.045 bits per pixel per frame (default true; false keeps the source frame)"),
    quality_proof: z.boolean().default(true).describe("In target-size mode, measure the output against the source (SSIM at 3 sample points + PSNR mid-clip) and report a verdict in words; false skips the measurement"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command(s) that would run and write no file"),
  },
    handler: async (a) => safe(() => core.compress({
    input: a.input,
    output: a.output,
    quality: a.quality,
    maxWidth: a.max_width ?? null,
    crf: a.crf ?? null,
    preset: a.preset ?? null,
    targetSizeMb: a.target_size_mb ?? null,
    resolutionLadder: a.resolution_ladder ?? true,
    qualityProof: a.quality_proof ?? true,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "silence",
    tier: "WRITE",
    description: "Remove silent stretches from speech/video. Detects silence with silencedetect, keeps the speech plus a margin of silence on each side (so words are never clipped), then cuts and re-joins — every kept segment gets a 12ms fade out + 15ms fade in at the join, so a cut mid-tone has no click. Set detect_only=true to just report the silence/kept segments without writing a file. Returns removed_seconds and the kept segment list — verify those before trusting the cut. Set dry_run=true to print the exact ffmpeg command that would run and write no file (the silencedetect measurement still runs, read-only; duration_after/size report null — measured on the real output; with nothing worth cutting the command is a stream-copy).",
    schema: {
    input: pathSchema,
    output: pathSchema.optional().describe("Output file path (not needed with detect_only=true; dry_run=true still needs it to print the command)"),
    threshold_db: z.number().min(-90).max(0).default(-40).describe("Silence threshold in dB (more negative = stricter)"),
    min_duration: z.number().min(0.05).max(60).default(0.5).describe("Minimum silence length in seconds to cut"),
    margin: z.number().min(0).max(5).default(0.2).describe("Seconds of silence kept around each speech segment"),
    detect_only: z.boolean().default(false).describe("Report silence/kept segments without writing output"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.silence({
    input: a.input,
    output: a.output ?? null,
    thresholdDb: a.threshold_db,
    minDuration: a.min_duration,
    margin: a.margin,
    detectOnly: a.detect_only,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "cropdetect",
    tier: "READ",
    description: "Measure letterbox/pillarbox black bars with the cropdetect filter: samples frames and returns the most common crop rectangle plus a ready-to-run mediakit crop command. Run before crop/reframe when the source may have black bars.",
    schema: {
    input: pathSchema,
    frames: z.number().int().min(1).max(300).default(30).describe("Frames to sample across the file"),
    limit: z.number().int().min(0).max(255).default(24).describe("Black threshold (0-255, higher = stricter)"),
  },
    handler: async (a) => safe(() => core.cropdetect(a)),
  },


  {
    name: "package",
    tier: "WRITE",
    description: "Bundle a finished file for delivery: a ZIP with the media, spec.json (measured probe + loudness + optional platform check receipt), checksums.sha256, and the captions sidecar when given. Run after check passes, before publishing.",
    schema: {
    input: pathSchema,
    output: pathSchema.describe("Output .zip path"),
    captions: pathSchema.optional().describe("Optional .srt/.ass/.vtt file to include in the bundle"),
    platform: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin"]).optional().describe("If given, run check for this platform and record the result in spec.json"),
  },
    handler: async (a) => safe(() => core.packageDelivery(a)),
  },


  {
    name: "receipt",
    tier: "WRITE",
    description: "Write a provenance receipt (JSON sidecar) for a finished file: probe data, SHA-256, size, measured loudness, optional platform check result, and the exact ffmpeg/ffprobe versions that produced it. Re-run sha256sum against the receipt any time to prove the media has not changed since it was written.",
    schema: {
    input: pathSchema,
    output: pathSchema.describe("Output .json path for the receipt"),
    platform: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin"]).optional().describe("If given, run check for this platform and record the result in the receipt"),
  },
    handler: async (a) => safe(() => core.receipt(a)),
  },


  {
    name: "convert_captions",
    tier: "WRITE",
    description: "Convert a subtitle file between SRT and VTT (pure text, no ffmpeg). Cue text is carried verbatim; VTT cue settings (line:/position:/align:) are dropped on the way to SRT and counted in settings_dropped. The output format comes from the output extension; converting a file to its own format is refused.",
    schema: {
    input: pathSchema.describe("Input subtitle file (.srt or .vtt)"),
    output: pathSchema.describe("Output subtitle file (.vtt or .srt — must differ from the input format)"),
  },
    handler: async (a) => safe(() => core.convertCaptions(a)),
  },


  {
    name: "generate_srt",
    tier: "WRITE",
    description: "Build a deterministic .srt subtitle file from a cue list [{start, end, text}] — pure text, no ffmpeg. Times accept seconds or \"MM:SS\" / \"HH:MM:SS\". Cues must be in order and must not overlap (touching is fine); each text must be non-empty and may span lines with \\n. This is the input burn_captions wants. Or pass words [{start, end, word}] instead of cues: they are grouped into semantic cues (max 8 words, 3.5s, 84 chars / 2 lines of 42; split on pauses >0.4s and sentence ends; a cue never ends on a stranded word like 'the'/'of') and the grouping report is returned. Pass cues or words, never both.",
    schema: {
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
    handler: async (a) => safe(() => core.generateSrt({ cues: a.cues ?? null, words: a.words ?? null, output: a.output })),
  },


  {
    name: "publish_kit",
    tier: "WRITE",
    description: "Thumbnail & Publishing Kit: from a finished video + a 1280x720 16:9 thumbnail + agent-written copy, write publishing/metadata.md and publishing.json and report a pre-publish checklist. Verifies what it can (thumbnail size, exactly 5 distinct 1-100-char titles, chapter times against the measured video duration, SHA-256 of media + thumbnail) and marks what it cannot verify as human-review (mobile readability, title/cover fidelity, licences) — never a pass. Flags unsupported-promise phrasing in titles as warnings. Does not publish or upload anything.",
    schema: {
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
    handler: async (a) => safe(() => core.publishKit({
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
  },


  {
    name: "transcribe",
    tier: "WRITE",
    description: "Transcribe speech to subtitles with a LOCAL engine (no cloud, audio never uploaded) — faster-whisper by default, or whisper.cpp with engine=\"whisper\". Writes a .srt and returns the segments with timestamps, detected language and full text — the direct input for burn_captions. The engine is optional: if no engine is installed the call fails with install lines (set MEDIAKIT_ASR_PYTHON to a python that has faster-whisper, or MEDIAKIT_WHISPER_CPP_BIN / MEDIAKIT_WHISPER_MODEL to a whisper.cpp binary + ggml model). Silence transcribes to 0 segments and an empty .srt.",
    schema: {
    input: pathSchema.describe("Audio or video file with a speech track"),
    output: pathSchema.describe("Output .srt file path"),
    model: z.enum(["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v1", "large-v2", "large-v3", "large-v3-turbo", "distil-small.en", "distil-medium.en", "distil-large-v2", "distil-large-v3"]).optional().describe("Whisper model (default tiny, or MEDIAKIT_ASR_MODEL): tiny is fast and fine for clear speech; base/small are more accurate; large-v3-turbo is the accurate/slow end"),
    language: z.string().default("auto").describe("\"auto\" (detect) or an ISO 639-1 code, e.g. en, vi"),
    engine: z.enum(["auto", "faster-whisper", "whisper"]).default("auto").describe("ASR engine: auto prefers faster-whisper, then whisper.cpp; \"whisper\" forces the whisper.cpp CLI"),
    chunk_seconds: z.number().int().min(5).max(1800).optional().describe("Split long audio into N-second chunks (5-1800, 2s overlap, segments re-offset onto the full timeline) so hour-long recordings transcribe without one giant ASR run; a file shorter than one chunk runs as a single chunk"),
    word_timestamps: z.boolean().default(false).describe("Also return per-word timings (words: [{index, start, end, word}], 0-based indices in timeline order) — the input cut_words cuts by. Word times come from the engine, never from the caller"),
  },
    handler: async (a) => safe(() => core.transcribe({
    input: a.input,
    output: a.output,
    model: a.model,
    language: a.language,
    engine: a.engine,
    chunk_seconds: a.chunk_seconds ?? null,
    word_timestamps: a.word_timestamps ?? false,
  })),
  },


  {
    name: "cut_words",
    tier: "WRITE",
    description: "Cut words out of a talking-head clip by transcript: filler words (um/uh), false starts and restarts, using word timings from transcribe --word-timestamps. Give a words file (the JSON transcribe prints — save its stdout — or a hand-written {words:[{start,end,word}]}), then select by word text (--remove 'um,uh'), the built-in filler set (--fillers), or 0-based word-index ranges (--indices '0-5,96-98', as printed by transcribe); --keep rescues indices even when auto-flagged. Keep runs are padded 0.06s before / 0.12s after, clamped so a cut never keeps a fragment of the word it removed, and kept words that end up mostly cut out are reported in cut_check.swallowed — play them before trusting the cut. Set edge_buffer (0-1s, default 0) to widen every keep segment past its pads, clamped only to the file edges — Outtake's 0.1s clip-edge buffer, so a cut never lands exactly on a kept word's onset; it deliberately keeps up to that much of the neighbouring removed word's edge, and a buffer wider than the gap between two kept runs merges them (the cut between them disappears). Every kept segment gets a 12ms fade out + 15ms fade in at the join, so a cut mid-word has no click. --dry-run returns the plan (cut intervals + keep segments) without writing a file. No match stream-copies the input unchanged.",
    schema: {
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
    edge_buffer: z.number().min(0).max(1).default(0).describe("Seconds of handle kept past each edge of every keep segment (default 0), clamped only to the file edges — Outtake's 0.1s clip-edge buffer, so a cut never lands exactly on a kept word's onset. It deliberately keeps up to that much of the neighbouring removed word's edge; a buffer wider than the gap between two kept runs merges them"),
    dry_run: z.boolean().default(false).describe("Return the cut plan (removed words, keep segments, cut_check) without writing any file"),
  },
    handler: async (a) => safe(() => core.cutWords({
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
    edgeBuffer: a.edge_buffer ?? 0,
    dryRun: a.dry_run ?? false,
  })),
  },


  {
    name: "remove_retakes",
    tier: "WRITE",
    description: "Cut repeated takes out of a talking-head clip, on word timings from transcribe --word-timestamps: when the speaker says a sentence, restarts, and says it again, the earlier take plus the restart junk ('okay, again', a filler) is cut and the fluent take is kept whole. A repeat is >= min_words identical words (default 3) with at most max_gap_words words (default 8) and max_gap_seconds (default 5) between the takes; a 2-word abandoned start ('the quick' — 'um' — 'the quick brown fox') is also cut. keep=last (default) keeps the later take — people warm up — keep=first keeps the earlier one. Returns the clusters found (kept take + removed indices + text) so the cut can be reviewed; detect_only=true returns the plan and writes no file. No retake stream-copies the input unchanged. Deterministic, not a judge: an intentional repetition ('I like cats. I like cats a lot.') looks like a retake to this detector — read the clusters (or run detect_only) before cutting.",
    schema: {
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
    handler: async (a) => safe(() => core.removeRetakes({
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
  },


  {
    name: "smart_cut",
    tier: "WRITE",
    description: "Tighten a talking-head clip on word timings from transcribe --word-timestamps: cut the hesitation out of a take in one pass — long pauses between words (gap >= min_gap * (1.2 - 0.6*aggressiveness), default min_gap 0.45s), long filler words (a filler only counts when held >= 0.35s - 0.15*aggressiveness, so a quick 0.1s 'um' survives and a stretched 'ummm' does not), and words held so long they became a stall ('soooo', 'this...', cut from 0.05s in so the attack survives). One aggressiveness knob (0-1, default 0.5) scales all three thresholds at once. The default filler list is um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh, like, you know, basically, actually — 'like'/'you know'/'basically'/'actually' are contextual: a long one is only cut when flanked by >= 0.15s pauses on both sides or sitting at the very start/end of the take (contextual_gate, default true — a 0.6s 'like' inside 'I like this' survives and is listed in gated_fillers; set contextual_gate=false for the old duration-only behaviour). Pass fillers to use your own list (phrases like 'you know' match consecutive words). min_segment (default 0 = off) merges removals separated by less than that many seconds of kept speech, so a sub-2s keep fragment between two cuts is cut with them instead of making a choppy clip (2.0 follows OpenEdit's silence_cutter default — but it can swallow real words on a dense take, so it stays off unless asked). Returns the removed intervals (reason filler/stretched/gap/mixed + text), gated_fillers, min_segment_merges, keep segments and cut_check.swallowed; detect_only=true returns the plan and writes no file. Nothing to cut stream-copies the input unchanged. Deterministic, not a judge: a dramatic pause is indistinguishable from a hesitation to this detector — read the removed list (or run detect_only) before cutting.",
    schema: {
    input: pathSchema.describe("Audio or video file with a speech track"),
    output: pathSchema.optional().describe("Output media file path (not needed with detect_only=true)"),
    words_file: pathSchema.describe("Transcript JSON with a words array — the stdout of `transcribe --word-timestamps` saved to a file, or a hand-written {words:[{start,end,word}]}"),
    min_gap: z.number().min(0.1).max(5).default(0.45).describe("Gap between two words, in seconds, that counts as a hesitation pause before aggressiveness scaling (default 0.45)"),
    aggressiveness: z.number().min(0).max(1).default(0.5).describe("One knob 0-1 scaling all three cut thresholds (default 0.5): 0 is gentle (gap x1.2, filler >= 0.35s, stretch >= 0.9s), 1 is tight (gap x0.6, filler >= 0.2s, stretch >= 0.6s)"),
    fillers: z.array(z.string()).optional().describe("Filler phrases to cut when held long, e.g. ['um', 'uh', 'you know'] — omit for the default list (um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh, like, you know, basically, actually)"),
    min_keep: z.number().min(0.05).max(5).default(0.2).describe("Drop keep segments shorter than this many seconds (default 0.2)"),
    contextual_gate: z.boolean().default(true).describe("Context gate for 'like'/'you know'/'basically'/'actually' (default true): a long contextual filler is only cut when flanked by >= 0.15s pauses on both sides or at the very start/end of the take; survivors are listed in gated_fillers. Set false for the old duration-only behaviour"),
    min_segment: z.number().min(0).max(5).default(0).describe("Merge removals separated by less than this many seconds of kept speech (default 0 = off; 2.0 follows OpenEdit's silence_cutter default — a sub-2s keep fragment between two cuts is cut with them instead of making a choppy clip)"),
    detect_only: z.boolean().default(false).describe("Report the removed intervals and the cut plan without writing any file"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.smartCut({
    input: a.input,
    output: a.output,
    wordsFile: a.words_file,
    minGap: a.min_gap ?? 0.45,
    aggressiveness: a.aggressiveness ?? 0.5,
    fillers: a.fillers ?? null,
    minKeep: a.min_keep ?? 0.2,
    contextualGate: a.contextual_gate ?? true,
    minSegment: a.min_segment ?? 0,
    detectOnly: a.detect_only ?? false,
    dryRun: a.dry_run ?? false,
  })),
  },


  // Clean a recorded voice (idea: marvtub/takes-public
  // clean_voice.py — diagnose first, then pick the steps; no code
  // copied). Diagnose measures peak, clipped runs, noise floor,
  // SNR, echo tail, bandwidth and 50/60 Hz hum from the decoded
  // audio in pure Node, then picks the steps: declip (adeclip),
  // dehum (bandreject harmonics), clearvoice (echo above -24 dB or
  // SNR below 50 dB), sr (bandwidth below 15 kHz). The voice chain
  // (highpass 80 + EQ + 3.5:1 compressor + gain to target LUFS +
  // -1 dBFS limiter) runs exactly once, at the end, in float, and
  // the output is a 48 kHz mono float WAV on the input's clock.
  // clearvoice/sr need the ClearVoice engine (PyTorch + ~1.7 GB
  // checkpoints) — not installed here, so a plan that needs them
  // refuses the run instead of cleaning without them; pass --steps
  // with only the ffmpeg-native steps to clean anyway. --diagnose
  // only measures and prints the plan and writes nothing; --ab
  // writes a 12 s speech window through every runnable candidate
  // chain (0.8 s gaps, order in OUT.ab.txt) so a new mic or room
  // can be heard before committing. A report is written to
  // OUT.report.json.
  {
    name: "clean_voice",
    tier: "WRITE",
    description: "Clean a recorded voice for a video: diagnose the recording first (peak, clipped runs, noise floor, SNR, echo tail, bandwidth, 50/60 Hz hum — all measured from the decoded audio), then pick the cleanup steps and run the voice chain (highpass 80 Hz + EQ + 3.5:1 compressor + gain to target LUFS + -1 dBFS limiter) exactly once, at the end, in float. Output is a 48 kHz mono float WAV on the input's video clock. The plan's steps are declip (more than 20 clipped runs), dehum (hum more than 12 dB over its neighbours), clearvoice (echo tail above -24 dB or SNR below 50 dB) and sr (bandwidth below 15 kHz); clearvoice/sr need the ClearVoice engine (PyTorch + ~1.7 GB checkpoints), which is not installed — a run that needs them refuses loudly instead of cleaning without them, so pass steps=['declip','dehum'] or steps=['none'] to clean with the ffmpeg-native steps only. diagnose_only=true only measures and returns the plan and writes nothing; ab=true writes a 12 s speech window through every runnable candidate chain (0.8 s gaps, order in the .ab.txt) so a new mic or room can be heard before committing. A report is written to <output>.report.json with the diagnosis, the plan and the measured output. Refuses inputs over 600 s (trim a section first) and non-.wav outputs.",
    schema: {
    input: pathSchema.describe("Audio or video file with a speech track"),
    output: pathSchema.optional().describe("Output WAV file path, must end in .wav (not needed with diagnose_only=true)"),
    target_lufs: z.number().min(-70).max(0).default(-14).describe("Target integrated loudness for the cleaned voice (default -14)"),
    steps: z.array(z.string()).optional().describe("Override the diagnosed plan, e.g. ['declip','dehum'] or ['none'] for chain only — unknown names fail loudly; a plan that needs clearvoice/sr refuses the run unless the override drops them"),
    diagnose_only: z.boolean().default(false).describe("Only measure the recording and return the diagnosis + plan; write no file"),
    ab: z.boolean().default(false).describe("Also write <output>.ab.wav: the densest 12 s of speech through every runnable candidate chain, back to back with 0.8 s gaps, with the order in <output>.ab.txt"),
    window: z.string().optional().describe("Seconds of the input to use for --ab, 'start,end' — default is the densest 12 s of speech"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg commands and write no file (the threshold/gain are measured from the uncleaned input, so they differ from the real run when pre-steps apply)"),
  },
    handler: async (a) => safe(() => core.cleanVoice({
    input: a.input,
    output: a.output ?? null,
    targetLufs: a.target_lufs ?? -14,
    steps: a.steps ?? null,
    diagnose: a.diagnose_only ?? false,
    ab: a.ab ?? false,
    window: a.window ?? null,
    dryRun: a.dry_run ?? false,
  })),
  },


  // Search-first editing (burningion/video-editing-mcp's
  // search-first idea, idea only — no code copied): find WHERE a
  // phrase is said in the transcript, then cut from the result.
  // The words file is the same one cut_words cuts by, so a match's
  // padded window is a trim waiting to happen — and cut_list merges
  // the windows into the ready-to-cut list. Matching is on
  // normalized words (case-insensitive, punctuation ignored —
  // "Hello," matches "hello"), contiguous only: a phrase split by
  // another word is not a match, and ASR mis-hearings are not
  // fuzzy-matched. Probe-only, writes no file — also a batch
  // operation (one words file per clip, the cut_words convention)
  // and a manifest probe-only step (the step that records WHY the
  // next trim cuts where it does).
  {
    name: "search_words",
    tier: "READ",
    description: "Find a phrase in a transcript and return where it is said (probe-only, writes no file): give a words file (the JSON transcribe --word-timestamps prints — save its stdout — or a hand-written {words:[{start,end,word}]}), the same file cut_words cuts by, and a query phrase. Matching is on normalized words (case-insensitive, punctuation ignored — 'Hello,' matches 'hello'), contiguous only: a phrase split by another word is not a match, and ASR mis-hearings are not fuzzy-matched — a missed phrase means the transcript says something else. Every match returns its word indices, start/end/duration, the matched text with context_before/context_after (default 5 words each side), and a padded cut window (default 0.5s each side); cut_list merges the windows into the ready-to-cut list (overlapping windows become one cut). Use it before trim: search the phrase, then cut the window it returns — never guess timestamps. max_matches caps the returned matches (default 10); when more exist, truncated=true and match_count is the true total.",
    schema: {
    words_file: pathSchema.describe("Transcript JSON with a words array — the stdout of `transcribe --word-timestamps` saved to a file, or a hand-written {words:[{start,end,word}]}"),
    query: z.string().min(1).describe("Phrase to find, e.g. 'welcome back' (case-insensitive, punctuation ignored)"),
    pad_before: z.number().min(0).max(5).default(0.5).describe("Seconds before each match's first word in its cut window (default 0.5, clamped at 0)"),
    pad_after: z.number().min(0).max(5).default(0.5).describe("Seconds after each match's last word in its cut window (default 0.5)"),
    max_matches: z.number().int().min(1).max(100).default(10).describe("Max matches to return (default 10); match_count is the true total even when truncated"),
    context_words: z.number().int().min(0).max(20).default(5).describe("Words of context on each side of the match, for reading the hit in place (default 5)"),
  },
    handler: async (a) => safe(() => core.searchWords({
    wordsFile: a.words_file,
    query: a.query,
    padBefore: a.pad_before ?? 0.5,
    padAfter: a.pad_after ?? 0.5,
    maxMatches: a.max_matches ?? 10,
    contextWords: a.context_words ?? 5,
  })),
  },


  {
    name: "find",
    tier: "READ",
    description: "Find media files by filename, recursively under a directory (case-insensitive substring match). Returns each match with probe info (duration, dimensions, codecs) so the agent can pick the right file without guessing paths. Skips .git, node_modules and hidden folders; does not follow symlinked directories.",
    schema: {
    directory: pathSchema.describe("Directory to search under (recursive)"),
    name: z.string().min(1).describe("Substring to match in the filename (case-insensitive)"),
    extensions: z.string().optional().describe("Comma-separated extensions to include, e.g. 'mp4,mov' (default: common video/audio/image/caption extensions)"),
    max_results: z.number().int().min(1).max(100).default(20).describe("Max matches to return with probe info; the result still reports total_matches"),
  },
    handler: async (a) => safe(() => core.findMedia({
    directory: a.directory, name: a.name,
    extensions: a.extensions ?? null, maxResults: a.max_results,
  })),
  },


  {
    name: "svg_animate",
    tier: "WRITE",
    description: "Animate an SVG file into an MP4, code-driven: Node interpolates keyframed translate/scale/rotate/opacity on elements (by id) per frame and ffmpeg's librsvg rasterizes each frame — no browser, no SMIL (ffmpeg cannot play SVG animation). Give animations as a list with target id, property, from/to, start/end seconds and easing. A target id that does not exist in the SVG is reported in missing_targets, not fatal.",
    schema: {
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
    handler: async (a) => safe(() => core.svgAnimate({
    svg: a.svg,
    animations: a.animations,
    output: a.output,
    duration: a.duration,
    fps: a.fps,
    width: a.width ?? null,
    height: a.height ?? null,
    background: a.background,
  })),
  },


  {
    name: "mix",
    tier: "WRITE",
    description: "Mix voice over a music bed with sidechain ducking: the bed drops by duck_db whenever the voice speaks (attack/release in ms), the voice is levelled to voice_lufs first, the music loops to the voice length, and the mix is mastered to target_lufs with two-pass loudnorm (render unmastered, measure it, then normalise with the measured values — single-pass undershoots on quiet voices with long gaps under a bed). Returns the ducking actually measured (ducking_measured_db, speech vs silence window on the ducked bed) and a warning when the mix is peak-limited and cannot reach the target. sfx drops short sounds at exact timestamps (each {file, at_seconds, volume 0-1}, max 16) — they are mixed in after the ducking, so a sting punches through; a timestamp past the voice end is refused. If the voice file is a video, its video stream is copied through. Set dry_run=true to print the exact ffmpeg commands that would run (render + master) and write no file (probes and the loudnorm measurement still run, read-only, to compute the voice gain).",
    schema: {
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
    handler: async (a) => safe(() => core.mix({
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
  },


  {
    name: "overlay",
    tier: "WRITE",
    description: "Overlay a logo/watermark image on a video. Named position (top-right, top-left, bottom-left, bottom-right, center) plus a margin from the edge; the overlay is scaled to width keeping its aspect ratio, opacity 0-1, and start/end (seconds) show it only during that window. Position and fit are measured on the display frame — a phone clip stored 1280x720 with rotation 90 is 720x1280 to the filter, so top-right lands at 576,24 there, not 1136,24. Audio is copied through. Set dry_run=true to print the exact ffmpeg command and write no file (x/y/overlay_size are computed from the display probe, so they are exact; duration/size report null — measured on the real output).",
    schema: {
    input: pathSchema,
    overlay: pathSchema.describe("Overlay image file (PNG with transparency recommended)"),
    output: pathSchema,
    position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"]).default("top-right").describe("Corner/center placement"),
    margin: z.number().int().min(0).default(24).describe("Margin from the edge in pixels"),
    width: z.number().int().min(2).optional().describe("Overlay width in pixels (keeps aspect; default = native size)"),
    opacity: z.number().min(0).max(1).default(1).describe("Overlay opacity (0-1)"),
    start: z.number().min(0).optional().describe("Show the overlay from this time in seconds"),
    end: z.number().min(0).optional().describe("Hide the overlay after this time in seconds"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.overlayImage({
    input: a.input,
    overlay: a.overlay,
    output: a.output,
    position: a.position,
    margin: a.margin,
    width: a.width ?? null,
    opacity: a.opacity,
    start: a.start ?? null,
    end: a.end ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "pip",
    tier: "WRITE",
    description: "Picture-in-picture: place a second video over the main one. 9 named positions (corners, edges, center), size by width in pixels or by scale fraction of the main width (default 0.25), opacity 0-1, and start/end (seconds) show it only during that window — the PiP clip loops so it never runs out. Geometry is measured on display frames: a rotated main clip is 720 wide (not 1280 stored), and a rotated PiP clip keeps its portrait aspect instead of being squashed to the stored one. Audio: main (default, PiP audio dropped), pip (PiP audio only), or mix (both mixed, levels kept). Set dry_run=true to print the exact ffmpeg command and write no file (x/y/pip_size are computed from the display probes, so they are exact; duration/size report null — measured on the real output).",
    schema: {
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
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.pictureInPicture({
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
    dryRun: a.dry_run,
  })),
  },


  {
    name: "broll",
    tier: "WRITE",
    description: "Insert B-roll clips into a main video at timestamps (misbahsy/video-audio-mcp's add_b_roll idea, one filter graph instead of their temp-file two-pass). The main timeline is never cut: each clip is trimmed to its window, scaled, and overlaid with enable=between(t,at,end), so the output duration is exactly the main duration. position fullscreen covers the whole frame (the main video underneath is hidden); the 9 PiP positions place it as a corner/edge/center overlay sized by width or scale (default 0.5 of the main width). fade dissolves the clip in/out over the main video (true alpha dissolve, not a dip to black). A window longer than its clip loops the clip. Clips must not overlap; a window running past the end of the main clip is clamped and reported. Audio: main (default, main audio copied untouched), broll (main audio muted inside each window, B-roll audio takes over — a window whose clip has no audio goes silent), mix (main + delayed B-roll audio, levels kept).",
    schema: {
    input: pathSchema,
    clips: z.array(z.object({
      file: pathSchema.describe("B-roll video file"),
      at: z.number().min(0).describe("Insert at this time in the main video, seconds"),
      duration: z.number().min(0).optional().describe("Window length in seconds (default: the clip's own duration, clamped to the end of the main video)"),
      position: z.enum(["fullscreen", "top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right"]).default("fullscreen").describe("fullscreen covers the frame; the 9 others place it as a PiP overlay"),
      scale: z.number().min(0.05).max(0.9).optional().describe("PiP width as a fraction of the main video width (default 0.5; ignored for fullscreen)"),
      width: z.number().int().min(2).optional().describe("PiP width in pixels (keeps aspect; overrides scale; ignored for fullscreen)"),
      margin: z.number().int().min(0).default(24).describe("PiP margin from the edge in pixels"),
      fade: z.number().min(0).max(2).default(0).describe("Dissolve in/out at both edges of the window, seconds (at most half the window)"),
    })).min(1).max(8).describe("1-8 B-roll clips, in any order (sorted by at); windows must not overlap"),
    output: pathSchema,
    audio: z.enum(["main", "broll", "mix"]).default("main").describe("Which audio to keep: main (default), broll (B-roll audio replaces the main track inside each window), or mix (both)"),
  },
    handler: async (a) => safe(() => core.insertBroll({
    input: a.input,
    clips: a.clips,
    output: a.output,
    audio: a.audio,
  })),
  },


  {
    name: "scenes",
    tier: "READ",
    description: "Detect scene changes / hard cuts in a video (probe-only, writes no file). Returns the cut timestamps plus the segments between them — trim on these boundaries instead of guessing. detector ffmpeg (default) is ffmpeg's scene metric; detector content scores each frame change in hue/sat/luma separately (PySceneDetect ContentDetector idea) and catches hue-only cuts the ffmpeg metric misses, with min_scene_len merging too-short scenes and a flash filter dropping 1-frame blips. fades=true adds fade in/out detection (dark core + measured ramp). Lower threshold = more sensitive; defaults differ per detector (ffmpeg 0.3, content 0.05).",
    schema: {
    input: pathSchema,
    threshold: z.number().min(0).max(1).optional().describe("Scene sensitivity (0-1, lower = more sensitive). Default 0.3 for detector ffmpeg, 0.05 for detector content"),
    detector: z.enum(["ffmpeg", "content"]).default("ffmpeg").describe("ffmpeg = ffmpeg select scene metric; content = hue/sat/luma split scoring (catches hue-only cuts)"),
    min_scene_len: z.number().int().min(1).default(15).describe("Content detector only: drop a cut when the scene it would open is shorter than this many frames (default 15)"),
    flash_frames: z.number().int().min(0).default(5).describe("Content detector only: a cut followed within this many frames by a cut back to the same content is a flash blip, not a scene (default 5)"),
    fades: z.boolean().default(false).describe("Also detect fade in/out (dark core + measured ramp) from mean luma"),
    fade_threshold: z.number().min(0).max(255).default(20).describe("Mean luma at/below this is the dark core of a fade (limited-range black is 16; default 20)"),
    min_fade_frames: z.number().int().min(1).default(2).describe("A dark run shorter than this many frames is not a fade (default 2)"),
  },
    handler: async (a) => safe(() => core.detectScenes({
      input: a.input,
      threshold: a.threshold ?? null,
      detector: a.detector,
      minSceneLen: a.min_scene_len,
      flashFrames: a.flash_frames,
      fades: a.fades,
      fadeThreshold: a.fade_threshold,
      minFadeFrames: a.min_fade_frames,
    })),
  },


  {
    name: "measure_pace",
    tier: "READ",
    description: "Measure a reference video's cutting pace (marvtub/takes-public measure_pace idea): count its hard cuts with the scenes content detector, then report {seconds, cuts, cuts_per_min, avg_shot_s, longest_hold_s, longest_at}. With style_file, keep those numbers as that style's pace in the style.json (created or updated, other keys preserved) — diagnose then scores every film in the project against them (cuts within 2x of the style, longest hold over style x1.5 and +2s warns). Without style_file nothing is written. A file under 15s still measures, but the result says it is too short to compare a style against. Also available as a probe-only batch operation and manifest step (measure only — the style-file write is not exposed there).",
    schema: {
    input: pathSchema,
    detector: z.enum(["ffmpeg", "content"]).default("content").describe("Cut detector (default content — the hue/sat/luma split scoring, which catches hue-only cuts the ffmpeg metric misses)"),
    threshold: z.number().min(0).max(1).optional().describe("Scene sensitivity (0-1, lower = more sensitive). Default 0.05 for detector content, 0.3 for detector ffmpeg"),
    style_file: pathSchema.optional().describe("Style file to keep the measured pace in (created if missing, pace block replaced, other keys kept) — omit to measure without writing"),
    style_name: z.string().min(1).max(64).optional().describe("Name stored in the style file (default: the style file's name without .json)"),
  },
    handler: async (a) => safe(() => core.measurePace({
      input: a.input,
      detector: a.detector,
      threshold: a.threshold ?? null,
      styleFile: a.style_file ?? null,
      styleName: a.style_name ?? null,
    })),
  },


  {
    name: "highlights",
    tier: "READ",
    description: "Find a clip's visual beats with perceptual hashes (EncodeX highlight.ts idea, re-implemented from the blockhash-js block-mean-value paper): sample frames at 2 fps, hash each one as an 8x8 average hash (one bit per cell against the frame mean, +/-8 dead zone so encoder noise on a flat frame cannot flip bits, flat-frame tie-break mean > 127.5 -> 1), and call a frame a scene boundary when its hash jumps from the previous frame by >= threshold (normalized Hamming distance, default 0.15). A highlight is the span between two boundaries — spans shorter than min_span_seconds merge into a neighbour, so the timeline never shatters into slivers — and its score is the mean jump inside the span (how much the picture keeps changing there); top_highlights ranks them by score, then duration. Thumbnails are the greedy farthest-point frames (seed = biggest jump, then each pick maximizes its minimum Hamming distance to the picked set) — the most visually distinct moments, for a poster frame or a hook still. Probe-only, writes no file — also available as a probe-only batch operation and manifest step. Long files sample slower instead of refusing (frame cap 1200; below 0.5 fps the file is refused as too long).",
    schema: {
    input: pathSchema,
    fps: z.number().min(0.5).max(5).default(2).describe("Sample rate in frames per second (0.5-5, default 2; long files sample slower automatically, down to 0.5)"),
    threshold: z.number().min(0).max(1).default(0.15).describe("Boundary threshold on the normalized Hamming jump 0-1 (default 0.15 — the EncodeX boundary; lower = more boundaries)"),
    min_span_seconds: z.number().min(0).max(30).default(2).describe("Spans shorter than this merge into a neighbour (0-30, default 2)"),
    top: z.number().int().min(1).max(20).default(5).describe("How many top highlights to rank (1-20, default 5)"),
    thumbnail_count: z.number().int().min(0).max(10).default(3).describe("How many farthest-point thumbnail candidates to return (0-10, default 3; 0 = none)"),
  },
    handler: async (a) => safe(() => core.findHighlights({
      input: a.input,
      fps: a.fps,
      threshold: a.threshold,
      minSpanSeconds: a.min_span_seconds,
      top: a.top,
      thumbnailCount: a.thumbnail_count,
    })),
  },


  {
    name: "keyframes",
    tier: "READ",
    description: "List the keyframe (I-frame) timestamps of a video (probe-only, writes no file), plus GOP min/max/avg interval. Check this before a stream-copy trim — cutting between keyframes silently shifts the cut. Pair with trim snap_to_keyframe=true to snap the cut onto keyframes. Set nearest (seconds) to also get the keyframe nearest one cut point: before (largest keyframe <= t), after (smallest >= t), closest, distance_seconds and direction (before/after/exact) — the snap target for a single cut without scanning the whole list.",
    schema: {
      input: pathSchema,
      nearest: z.number().nonnegative().optional().describe("Time in seconds: also report the keyframe nearest this cut point (before/after/closest + distance). Must be within the clip"),
    },
    handler: async (a) => safe(() => core.listKeyframes({ input: a.input, nearest: a.nearest })),
  },


  {
    name: "audio_levels",
    tier: "READ",
    description: "Loudness curve + loudest moments of an audio stream (WyattBlue/auto-editor's `levels` idea: one value per timebase chunk, no threshold — the curve IS the data; bariswha/losslesscut-mcp's audio_levels adds buckets + pickPeaks). One decode pass: per-frame astats Peak + RMS bucketed into bucket_seconds windows (default 1s), RMS averaged in the linear domain so each bucket's rms_db is the true energy mean. Returns every bucket {start, end, rms_db, peak_db} (a bucket of true digital silence reports nulls, never a fake -inf), a summary (max_peak_db, energy-mean mean_rms_db, min/max bucket RMS, dynamic_range_db, silent_buckets, loudest_bucket) and the top N peaks (default 5) ranked by peak_db and kept at least min_gap_seconds apart (default 2s — a 3s shout does not fill the whole list with its own neighbours; near-equal peaks tie at 0.1 dB and the earliest wins). The summary also carries `dynamics` (dziksu/synkinema's analyze_audio idea, same decode, no extra cost): quiet_p10_db / loud_p90_db as nearest-rank percentiles over the finite bucket RMS values, separation_db = p90 - p10 with a verdict (flat <6 dB, narrow <12, dynamic <24, wide beyond), and bed_fills_speech_gaps — gap buckets are true digital silence or >=20 dB below the loud p90, and the flag is true when those gaps still carry finite energy above -60 dBFS (a bed / room tone fills them) instead of digital silence; gap_bed_db is their energy-mean RMS. Probe-only, writes no file — also available as a probe-only batch operation and manifest step. Cap: at most 3600 buckets (raise bucket_seconds for long files).",
    schema: {
      input: pathSchema,
      bucket_seconds: z.number().min(0.1).max(60).default(1).describe("Bucket width in seconds (0.1-60, default 1). At most 3600 buckets — a long file needs a wider bucket"),
      top_n: z.number().int().min(0).max(50).default(5).describe("How many loudest moments to return (0-50, default 5; 0 = curve only, no peaks)"),
      min_gap_seconds: z.number().min(0).max(3600).default(2).describe("Minimum gap between two returned peaks in seconds (default 2; 0 keeps adjacent buckets)"),
    },
    handler: async (a) => safe(() => core.audioLevels({
      input: a.input,
      bucketSeconds: a.bucket_seconds ?? 1,
      topN: a.top_n ?? 5,
      minGapSeconds: a.min_gap_seconds ?? 2,
    })),
  },


  {
    name: "fit",
    tier: "WRITE",
    description: "Fit a media file to an exact target duration in seconds. method speed (default) speeds it up/down with setpts + chained atempo (factor must stay in 0.25-4x); trim cuts a longer source down; loop repeats a shorter source until it reaches the target. max_fps caps the output frame rate (e.g. 15 for a smaller file) — it only ever lowers the fps, never raises it by duplicating frames. Returns the output duration and fps actually measured with ffprobe, plus duration_error_seconds. Set dry_run=true to print the exact ffmpeg command and write no file (speed_factor/loops/fps_capped are computed from the probe, so they are exact; duration_actual/duration_error/fps/size report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema,
    duration: z.number().positive().describe("Target duration in seconds"),
    method: z.enum(["speed", "trim", "loop"]).default("speed").describe("speed = change playback speed (keeps the whole clip), trim = cut a longer source, loop = repeat a shorter source"),
    max_fps: z.number().int().min(1).max(120).optional().describe("Cap the output frame rate (1-120). Only lowers fps — a 30fps source with max_fps 60 keeps 30fps; video only, ignored for audio-only input"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no file"),
  },
    handler: async (a) => safe(() => core.fitDuration({
    input: a.input,
    output: a.output,
    duration: a.duration,
    method: a.method,
    maxFps: a.max_fps ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "export_gif",
    tier: "WRITE",
    description: "Export a clip (or segment) as an animated GIF with a two-pass palette (palettegen + paletteuse from the actual frames). Fits under max_size_mb (default 10 MB, the GitHub README limit; Slack only auto-plays GIFs under ~2 MB) by stepping down fps, then width, then palette colours — each attempt is measured on disk, and size_budget_met says honestly whether the budget was met. Set dry_run=true to print the first ladder step's command and write no file (the ladder plan is listed; later steps only run when the budget needs them; size/duration/frames report null — measured on the real output).",
    schema: {
    input: pathSchema,
    output: pathSchema.describe("Output file path, must end in .gif"),
    start: z.number().min(0).optional().describe("Segment start in seconds (default 0)"),
    end: z.number().positive().optional().describe("Segment end in seconds (default: end of file)"),
    fps: z.number().int().min(1).max(30).optional().describe("Frames per second (default 15; stepped down if the size budget needs it)"),
    width: z.number().int().min(16).max(4096).optional().describe("GIF width in pixels (default 640; stepped down if the size budget needs it)"),
    max_size_mb: z.number().min(0.01).max(10000).default(10).describe("Size budget in decimal MB (default 10)"),
    dry_run: z.boolean().default(false).describe("Print the first ladder step's command and write no file"),
  },
    handler: async (a) => safe(() => core.exportGif({
    input: a.input,
    output: a.output,
    start: a.start ?? null,
    end: a.end ?? null,
    fps: a.fps ?? null,
    width: a.width ?? null,
    maxSizeMb: a.max_size_mb,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "doctor",
    tier: "READ",
    description: "Read-only environment preflight: ffmpeg/ffprobe versions, which filters and encoders this build has, and which mediakit tools that enables. An unavailable tool also reports a one-sentence fix telling you how to repair the ffmpeg install. Also reports the async job store dir (jobs_dir: path + exists + writable — it is auto-created on the first job) and the Kokoro voice venv (voice_venv, env MEDIAKIT_VOICE_VENV — optional, like the ASR engine). Run first on a new machine — a tool that reports available=false will fail at runtime. With smoke:true, also runs a real end-to-end render (generate → trim → loudness → verify) and reports whether this machine can actually render — a failed smoke fails ok.",
    schema: {
    smoke: z.boolean().default(false).describe("Also run a real end-to-end render chain (generate → trim → loudness → verify) after the static checks; a failed smoke fails ok"),
    },
    handler: async (a) => safe(() => core.doctor({ smoke: a?.smoke === true })),
  },


  {
    name: "titlecard",
    tier: "WRITE",
    description: "Render a title card PNG: a big bold hook (3-6 words) on a coloured box, on a transparent canvas so it overlays onto any frame. Text wraps to short lines; the block sits centred in the safe zone (~55% down the frame). Default: yellow text on an orange box, ~120px type at 1080 wide. Pass style: clean-bold | minimal-line | warm-story to use that style's locked palette from skills/shorts-video/styles.json instead; pass brand: amber-teal | warm-story | minimal-line to paint it in the channel look from skills/shorts-video/brands.json (primary = box, on_primary = text, same registry as assemble; set MEDIAKIT_BRANDS to a JSON file of your own to add more brand ids); an explicit text_color/box_color/font_size overrides just that one locked value for this call. Resolution: explicit > brand > style > default; the brand never sets the font size. Set dry_run=true to print the exact ffmpeg command and write no output file (the drawtext text file is written next to the output and kept, so the printed command runs as-is; font_size/colors are computed, so they are exact; size reports null).",
    schema: {
    text: z.string().min(1).describe("The hook text, 3-6 words (e.g. 'The Moon Is Leaving Us')"),
    output: pathSchema,
    width: z.number().int().min(2).default(1080).describe("Canvas width in pixels (must be even)"),
    height: z.number().int().min(2).default(1920).describe("Canvas height in pixels (must be even)"),
    font_size: z.number().int().min(16).max(400).optional().describe("Font size in px; default scales with canvas width (~120px at 1080 wide); with style, the style's locked size"),
    text_color: z.string().optional().describe("Text color: name or hex, default FFD60A (yellow); with style, the style's locked text color; with brand, the brand's on_primary"),
    box_color: z.string().optional().describe("Box color: name or hex, default F97316 (orange); with style, the style's locked box color; with brand, the brand's primary"),
    style: z.string().optional().describe("Named style id (clean-bold | minimal-line | warm-story): use that style's locked text/box/font palette"),
    brand: z.string().optional().describe("Brand id (amber-teal | warm-story | minimal-line): paint the card in the channel look — primary is the box, on_primary the text"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no output file"),
  },
    handler: async (a) => safe(() => core.titlecard({
    text: a.text,
    output: a.output,
    width: a.width,
    height: a.height,
    fontSize: a.font_size ?? null,
    textColor: a.text_color ?? null,
    boxColor: a.box_color ?? null,
    style: a.style ?? null,
    brand: a.brand ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "intro",
    tier: "WRITE",
    description: "Render a short intro clip: a title on a solid-colour background that fades in and out. Silent video (no audio); use it as the opening card, then concat it in front of the main clip. Text wraps to short lines, centred on the frame. Pass style: clean-bold | minimal-line | warm-story to use that style's locked palette (its box colour becomes the background, its text colour the text) from skills/shorts-video/styles.json; pass brand: amber-teal | warm-story | minimal-line to paint it in the channel look from skills/shorts-video/brands.json (background = background, text = text, same registry as assemble; set MEDIAKIT_BRANDS to a JSON file of your own to add more brand ids); an explicit bg_color/text_color/font_size overrides just that one locked value for this call. Resolution: explicit > brand > style > default; the brand never sets the font size. Set dry_run=true to print the exact ffmpeg command and write no output file (the drawtext text file is written next to the output and kept, so the printed command runs as-is; font_size/colors are computed, so they are exact; size/duration report null — measured on the real output).",
    schema: {
    text: z.string().min(1).describe("The intro title, e.g. 'Welcome Back'"),
    output: pathSchema,
    width: z.number().int().min(2).default(1280).describe("Canvas width in pixels (must be even)"),
    height: z.number().int().min(2).default(720).describe("Canvas height in pixels (must be even)"),
    duration: z.number().min(0.5).max(30).default(3).describe("Clip length in seconds"),
    bg_color: z.string().optional().describe("Background color: name or hex, default 0F172A (dark navy); with style, the style's locked box color; with brand, the brand's background"),
    text_color: z.string().optional().describe("Text color: name or hex, default FFFFFF (white); with style, the style's locked text color; with brand, the brand's text"),
    font_size: z.number().int().min(16).max(400).optional().describe("Font size in px; default scales with canvas width (~100px at 1280 wide); with style, the style's locked size"),
    fade_in: z.number().min(0).max(30).default(0.5).describe("Text fade-in length in seconds (0 = no fade-in)"),
    fade_out: z.number().min(0).max(30).default(0.5).describe("Text fade-out length in seconds (0 = no fade-out)"),
    style: z.string().optional().describe("Named style id (clean-bold | minimal-line | warm-story): use that style's locked palette"),
    brand: z.string().optional().describe("Brand id (amber-teal | warm-story | minimal-line): paint the intro in the channel look — background is the background, text the text"),
    dry_run: z.boolean().default(false).describe("Print the exact ffmpeg command and write no output file"),
  },
    handler: async (a) => safe(() => core.intro({
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
    brand: a.brand ?? null,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "social",
    tier: "WRITE",
    description: "Export one video to several platform specs in a single call: reframes each platform's size (blur keeps the whole frame by default), trims clips longer than the platform's max duration (Shorts 180s, Story 60s), normalizes loudness to target_lufs, then checks each output against that platform's spec. Writes <base>-<platform>.mp4 per platform plus manifest.json (receipt with dimensions, duration, LUFS and check results) into the output directory. A platform whose check fails still writes its file — the result says so instead of hiding it.",
    schema: {
    input: pathSchema,
    output_dir: pathSchema.describe("Directory to write the platform files + manifest.json into (created if needed)"),
    platforms: z.array(z.enum(["tiktok", "reels", "shorts", "instagram-feed", "instagram-story", "linkedin", "youtube"])).min(1).default(["tiktok", "reels", "shorts"]).describe("Platforms to export (default: tiktok, reels, shorts)"),
    strategy: z.enum(["crop", "pad", "blur"]).default("blur").describe("How to fit the source frame into each platform size: crop cuts the aspect out, pad letterboxes, blur fills with a blurred copy (default)"),
    target_lufs: z.number().min(-70).max(0).default(-14).describe("Normalize audio to this LUFS"),
    trim_to_max: z.boolean().default(true).describe("Trim clips longer than the platform's max duration (false keeps the full length; check will then fail the duration rule)"),
  },
    handler: async (a) => safe(() => core.social({
    input: a.input,
    outputDir: a.output_dir,
    platforms: a.platforms,
    strategy: a.strategy,
    targetLufs: a.target_lufs,
    trimToMax: a.trim_to_max,
  })),
  },


  {
    name: "mux",
    tier: "WRITE",
    description: "Replace a video's audio track with an external audio file, stream-copying both (no re-encode: fast and lossless). The video's original audio is dropped, not mixed in — mix first if you want both. audio_offset_seconds shifts the new audio against the video (positive = audio starts later, negative = video starts later). shortest stops the output at the shorter stream. dry_run prints the exact ffmpeg argv and writes no file.",
    schema: {
    video: pathSchema.describe("Video file (must have a video stream)"),
    audio: pathSchema.describe("Audio file (must have an audio stream; a video file's audio track works too)"),
    output: pathSchema.describe("Output file path"),
    audio_offset_seconds: z.number().min(-3600).max(3600).default(0).describe("Shift the new audio in seconds: positive delays the audio, negative delays the video"),
    shortest: z.boolean().default(false).describe("Stop at the shorter of the two streams"),
    dry_run: z.boolean().default(false).describe("Return the ffmpeg command without writing a file"),
  },
    handler: async (a) => safe(() => core.mux({
    video: a.video,
    audio: a.audio,
    output: a.output,
    audioOffsetSeconds: a.audio_offset_seconds,
    shortest: a.shortest,
    dryRun: a.dry_run,
  })),
  },


  {
    name: "batch",
    tier: "WRITE",
    description: "Apply ONE operation to many files matching a glob under a folder, in one call: loudness, resize, reframe, compress, convert, normalize, extract_audio, reverse, rotate, boomerang, make_loopable, freeze, grade, fit, trim, silence, chroma_key, cut_words, remove_retakes, smart_cut, clean_voice, slideshow, hook, bpm, beat_grid, tempo_drift, audio_levels, search_words, measure_pace or highlights — the same args for every file. Outputs are named <stem>-<operation>.<ext> under the output directory, mirroring the input tree. Returns one row per file (input order) with status ok/error/cached/skipped plus counts, so a failure in one file never hides the rest. Unchanged files are skipped via a content-hash cache (.mediakit-batch-cache.json in the output dir, verified against the output's size + sha256); jobs runs up to 8 files at once under one shared timeout_seconds budget; dry_run lists the planned outputs and writes nothing. cut_words, remove_retakes, smart_cut and search_words find each clip's words file by convention (<words_dir>/<stem>.words.json, default the input's own folder) — a clip with no words file fails its own row only. clean_voice writes .wav always (48 kHz mono float), whatever the input was, and a take whose plan needs clearvoice/sr fails its own row (pass steps without them to clean anyway). slideshow is the exception: a SET operation — the whole matched set of images (2-32) becomes ONE slideshow video (output_name, default slideshow.mp4) instead of one output per file, and the per-file cache does not apply. hook, bpm, beat_grid, tempo_drift, audio_levels, search_words, measure_pace and highlights are the probe-only exceptions: they write no file (output is null, output_suffix is null) — the measurement comes back in each row's result, and the cache stores that result instead of a file. Exit codes follow harken's scheme: the summary carries exit_code — 0 when every row is done/cached/skipped, 1 when any row failed — and the CLI exits with that code (2 for input errors: unknown operation, bad pattern/args, no matches), printing 'batch complete: X done, Y cached, Z skipped, W failed (of N)' to stderr. batch-manifest.jsonl streams one JSON line per finished row (completion order, index = the row's position in input order) as rows complete, so a batch killed mid-run still leaves a partial record; it is fresh-truncated each run so it always matches that run's batch-manifest.json.",
    schema: {
    operation: z.enum(["loudness", "resize", "reframe", "compress", "convert", "normalize", "extract_audio", "reverse", "rotate", "boomerang", "make_loopable", "freeze", "grade", "fit", "trim", "silence", "chroma_key", "cut_words", "remove_retakes", "smart_cut", "clean_voice", "slideshow", "hook", "bpm", "beat_grid", "tempo_drift", "audio_levels", "search_words", "measure_pace", "highlights"]).describe("The operation to apply to every matched file"),
    pattern: z.string().min(1).describe("Glob matched against paths under input_dir: **/*.mp4 for every mp4 at any depth, sub/*.mp4 for one folder, or a bare *.mp4 (matches the basename at any depth)"),
    input_dir: pathSchema.describe("Folder to search under (recursive; hidden dirs, .git, node_modules and .next are skipped)"),
    output_dir: pathSchema.describe("Directory to write outputs + batch-manifest.json + batch-manifest.jsonl into (created if needed; files under it are never treated as inputs)"),
    args: z.record(z.unknown()).default({}).describe("Operation arguments, same for every file (snake_case, e.g. {target_lufs: -14} for loudness, {preset: '720p'} for resize, {duration: 30, method: 'trim'} for fit). Unknown keys are refused, never silently ignored"),
    jobs: z.number().int().min(1).max(8).default(1).describe("Files processed at once (default 1 = sequential; capped at min(jobs, cpu count, 8))"),
    output_suffix: z.string().max(32).optional().describe("Output filename suffix (default -<operation>). Empty string only with an output_dir different from the input dir"),
    cache: z.boolean().default(true).describe("Skip files whose input bytes + operation + args already produced the cached output (verified by output size + sha256)"),
    stop_on_error: z.boolean().default(false).describe("Stop starting new files after the first failure (in-flight files still finish; the rest are reported skipped)"),
    timeout_seconds: z.number().min(1).max(86400).default(1800).describe("Shared time budget for the whole batch in seconds (default 1800); files not started before it expires are reported skipped"),
    max_files: z.number().int().min(1).max(1000).default(200).describe("Cap on matched files (extra matches are reported via truncated)"),
    dry_run: z.boolean().default(false).describe("List matched files + planned outputs without running anything or writing any file"),
  },
    handler: async (a) => safe(() => core.batch({
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
  },


  {
    name: "manifest",
    tier: "WRITE",
    description: "Run a whole edit pipeline from ONE declarative JSON manifest file: {version: 1, input, output, steps: [{tool, args}], qa?} — paths in the manifest are relative to the manifest file. Steps run in order, each feeding the next (slideshow as step 1 only — it builds a video from images in args, so the manifest input should be the first slide image; download as step 1 only — it fetches from a URL in args, and when it is step 1 the manifest input may be omitted entirely; then trim, resize, reframe, compress, convert, normalize, extract_audio, reverse, rotate, boomerang, make_loopable, freeze, grade, fit, silence, denoise, interpolate, burn_captions, overlay, chroma_key, cut_words, remove_retakes, smart_cut; hook, bpm, beat_grid, tempo_drift, audio_levels, search_words, measure_pace and highlights are the probe-only steps — they analyze the chain file at that point and pass it through unchanged, so their results record WHY the next trim cuts where it does); the whole plan is validated before anything renders, so a typo fails in seconds. Each step is cached by content hash (input bytes + tool + args + sidecar-file bytes, verified against the cached output's size + sha256; a probe-only step stores only its result, there is no file to verify) — re-running an unchanged manifest re-encodes nothing, and editing step 3 only re-runs from step 3. Set qa to a platform (or 'any') to run qa_report on the final file. dry_run prints the plan and writes nothing — the approve-before-render gate. A step failure aborts the run and keeps the intermediates for inspection.",
    schema: {
    manifest_path: pathSchema.describe("Path to the manifest JSON file"),
    output: pathSchema.optional().describe("Output file path (overrides the manifest's output; the extension is adjusted to the step chain's final format when needed)"),
    dry_run: z.boolean().default(false).describe("Validate the manifest and list the planned steps without running anything or writing any file"),
    cache: z.boolean().default(true).describe("Skip steps whose input bytes + tool + args already produced the cached intermediate (verified by size + sha256)"),
    keep_intermediates: z.boolean().default(false).describe("Keep the per-step intermediate files under the output dir (deleted on success by default; always kept when a step fails)"),
  },
    handler: async (a) => safe(() => core.manifest({
    manifestPath: a.manifest_path,
    output: a.output ?? null,
    cache: a.cache,
    dryRun: a.dry_run,
    keepIntermediates: a.keep_intermediates,
  })),
  },


  {
    name: "patch_manifest",
    tier: "DESTRUCTIVE",
    description: "Edit a manifest JSON file under a revision guard (AH64-dll/OpenEdit's revision-guard idea: a write against a stale revision is refused instead of silently overwriting newer work). A manifest carries an optional top-level `revision` (absent = 0); the call requires `expected_revision` to match the file's current revision, applies 1-100 ops, proves the patched manifest still lints and plans (a real manifest --dry-run on a temp copy), then writes atomically (.partial + rename) with revision + 1 — and first copies the pre-patch bytes to `<manifest>.bak` (bariswha/losslesscut-mcp's set_segments idea), so .bak is always the revision just before the current one. A revision mismatch, a bad op, or a patched manifest that no longer validates all refuse with an error code (REVISION_MISMATCH / INVALID_ARG) and leave the file byte-identical — nothing is written. With dry_run (dziksu/synkinema's apply_operations dry_run + ChatCut's validateOnly: the approve-before-apply gate) the same guard + validation run, but nothing is written at all — no .bak, no revision bump — and the exact candidate document (with revision + 1, the bytes a real run would write) comes back in `candidate`, so the caller inspects it and re-issues the same call without dry_run to commit; a dry-run against a stale revision is still refused. Ops: set {path: input|output|qa|steps.N.tool|steps.N.args.KEY, value: scalar} (version/revision are managed, not settable); add_step {step: {tool, args?}, index?} (append, or insert at index); remove_step {index} (never the last step); replace_step {index, step: {tool, args?}}. Ops apply in order — each op addresses the step list as the previous ops left it (JSON Patch semantics). Returns revision_before/after, the backup path, a human-readable changes list, and the dry-run validation (steps + planned output).",
    schema: {
    manifest_path: pathSchema.describe("Path to the manifest JSON file to patch"),
    expected_revision: z.number().int().min(0).describe("The revision the caller last read from the file (absent = 0). Must match the file's current revision or the call is refused with REVISION_MISMATCH and nothing is written"),
    dry_run: z.boolean().default(false).describe("Preview only: run the revision guard + op checks + manifest validation and return the exact candidate document (with revision + 1) in `candidate`, writing nothing — no .bak, no revision bump. Re-issue without dry_run to commit"),
    patch: z.array(z.union([
      z.object({ op: z.literal("set"), path: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
      z.object({ op: z.literal("add_step"), step: z.object({ tool: z.string().min(1), args: z.record(z.any()).optional() }).passthrough(), index: z.number().int().min(0).optional() }).strict(),
      z.object({ op: z.literal("remove_step"), index: z.number().int().min(0) }).strict(),
      z.object({ op: z.literal("replace_step"), index: z.number().int().min(0), step: z.object({ tool: z.string().min(1), args: z.record(z.any()).optional() }).passthrough() }).strict(),
      // Catch-all so an unknown op name reaches core instead of dying
      // in zod with a bare "Invalid input" — core names the op
      // (unknown op "move_step") and the supported list.
      z.object({ op: z.string() }).passthrough(),
    ])).min(1).max(100).describe("1-100 patch operations, applied in order — each op addresses the list as the previous ops left it"),
  },
    handler: async (a) => safe(() => core.patchManifest({
    manifestPath: a.manifest_path,
    patch: a.patch,
    expectedRevision: a.expected_revision,
    dryRun: a.dry_run === true,
  })),
  },


  {
    name: "determinism",
    tier: "PLAN",
    description: "Check whether a linear pipeline manifest reproduces byte-identically (heristop/leclap's verify --rerender idea, for the manifest tool — assemble already has verify --rerender; the manifest cache only verifies size + sha256 of an output it already stored, it never proves a fresh run reproduces the same bytes). Runs the same manifest N times (default 2, max 5) with the cache OFF — a cache hit would prove nothing — then compares byte sha256, decoded-frame digest (framemd5, moviepy's test pattern: compare decoded frames, never bytes), and measured properties (duration/frames/dimensions) across runs. Verdict byte_identical means the pipeline reproduces exactly (on this machine two identical libx264 encodes are byte-identical); content_identical means the frames match but container bytes differ, with the differing format tags named (usually creation_time); differs means the pipeline itself is nondeterministic, with the first differing run pair named. A download-first manifest re-fetches its URL on every run, unless the download step sets cache:true (then the verified per-URL cache serves it). keep_outputs keeps the per-run outputs under .mediakit-determinism-<pid> next to the manifest (removed by default).",
    schema: {
    manifest_path: pathSchema.describe("Path to the manifest JSON file to re-run"),
    runs: z.number().int().min(2).max(5).default(2).describe("How many fresh renders to compare (2-5, default 2)"),
    keep_outputs: z.boolean().default(false).describe("Keep the per-run output files under .mediakit-determinism-<pid> next to the manifest (removed by default; always kept when a run fails)"),
  },
    handler: async (a) => safe(() => core.checkManifestDeterminism({
    manifestPath: a.manifest_path,
    runs: a.runs,
    keepOutputs: a.keep_outputs,
  })),
  },


  {
    name: "assemble",
    tier: "WRITE",
    description: "Film assembler (Autopilot-style): build a finished video from ONE declarative film manifest — shots on a voice-led timeline, mixed audio, burned captions, QA and a receipt. The voice is the master clock: total = lead + measured voice duration + tail, and shot durations must cover that total EXACTLY in frames (no silent trim/pad/speed change). Modes: validate (no writes), plan (the director's storyboard disclosure: the resolved timeline — every shot with film-time start/end in seconds and frames, every transition with its blend offset, the voice/music/SFX audio timeline, chapters with ends — no writes and no approval; preview + approve are still required before render), preview (first N seconds at half size — show it to the user), approve (records the fingerprint of the previewed files; a human must have seen the preview), render (needs a matching approval, unless force:true). Shot segments are cached by content hash, so a re-render rebuilds only changed shots. v1: plain cuts, no per-shot text layers, one aspect per manifest. async:true (render only) returns a job_id immediately and renders in the background — poll the job tool. chapters [{title, at}] in the manifest become MP4 chapters in final.mp4. `preset` in the manifest (vertical/horizontal/square/cinematic/vertical-60) picks width/height/fps/style for the whole film; explicit fields win and are reported in preset_overrides, preset-filled fields in preset_applied. `brand` in the manifest (amber-teal/warm-story/minimal-line, see skills/shorts-video/brands.json — or your own ids from a MEDIAKIT_BRANDS file) paints the whole film in one channel look — palette fills template colors and text-layer color/size, its style fills the caption style when no preset or explicit style sets one; explicit values win and are reported in brand_overrides, brand-filled fields in brand_applied. NOT the manifest tool (that runs a linear edit pipeline). Shot roles (hook/context/core/payoff) and a film-level hook {shot, start?, end?} pin the opening segment — diagnose checks the arc (hook first, payoff last). A shot may carry variants — alternate takes A/B/C of the same kind, each with its own source fields and an optional hook label naming which hook it opens with — with selected (index or label, default 0) picking the one that renders; unselected takes are still probed, hashed and listed in the receipt, so switching the pick re-renders only that shot.",
    schema: {
    manifest_path: pathSchema.describe("Path to the film manifest JSON file (see skills/shorts-video/references/assemble-manifest.md for the schema)"),
    mode: z.enum(["validate", "plan", "preview", "approve", "render"]).default("validate").describe("validate: check the timeline math and files, write nothing. plan: the director's storyboard disclosure — the resolved timeline (every shot with film-time start/end, joins, the audio timeline, chapters with ends), write nothing, no approval. preview: render the first preview_seconds at half size. approve: record approval for the previewed files. render: full-resolution film (needs approval unless force)."),
    output_dir: pathSchema.optional().describe("Output directory (required for preview/approve/render): preview.mp4 + preview.json, or final.mp4 + assemble-receipt.json"),
    preview_seconds: z.number().min(1).max(60).default(20).describe("Preview length in seconds (preview mode only, default 20)"),
    force: z.boolean().default(false).describe("Render without approval (render mode only; recorded as approval:'forced' in the receipt — use only when the user explicitly says so)"),
    async: z.boolean().default(false).describe("Render in the background (render mode only): validate + approval are checked now, then the call returns a job_id immediately and the render runs in a detached worker — poll the job tool for progress and the terminal result. Chapters [{title, at}] in the manifest become MP4 chapters in final.mp4."),
  },
    handler: async (a) => safe(async () => {
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
  },


  // Director scaffold (wilwaldon/Claude-Code-Video-Toolkit project
  // lifecycle idea, lượt 93): start a video project the way assemble
  // expects to finish it — a film.json that already validates, a
  // placeholder voice so the timeline math is real, placeholder
  // captions, an assets/ layout and a CLAUDE.md with the lifecycle.
  {
    name: "init_project",
    tier: "WRITE",
    description: "Scaffold a new assemble video project in a directory: a film.json that already validates (preset vertical by default, two template shots, 4s total), a placeholder voice (440 Hz tone WAV, 3s — replace it with the real narration before delivery), placeholder captions, an assets/ layout (shots/, music/) and a CLAUDE.md with the project lifecycle (validate → diagnose → preview → approve → render → verify → verify-cuts). The starter film renders a real preview out of the box, so the project is edited, not debugged into existence. Refuses when film.json or CLAUDE.md already exists unless force:true. Use this before writing a film manifest by hand.",
    schema: {
    dir: pathSchema.describe("Project directory to create (relative to the workspace, or absolute)"),
    title: z.string().optional().describe("Film title (default: the directory name)"),
    preset: z.enum(["vertical", "horizontal", "square", "cinematic", "vertical-60"]).default("vertical").describe("Preset for the whole film (default vertical: 1080x1920, 30fps, clean-bold captions)"),
    brand: z.string().optional().describe("Brand id (amber-teal | warm-story | minimal-line, or a custom id from MEDIAKIT_BRANDS) — paints the whole film; omit for no brand"),
    force: z.boolean().default(false).describe("Overwrite an existing film.json / CLAUDE.md in the directory (default false: refuse)"),
  },
    handler: async (a) => safe(() => core.initProject({
    dir: a.dir,
    title: a.title ?? null,
    preset: a.preset,
    brand: a.brand ?? null,
    force: a.force,
  })),
  },


// Durable render jobs (idea: AH64-dll/OpenEdit's get_render_job /
// cancel_render_job): assemble --async returns a job_id; this tool
// polls it. status shows progress + the terminal result/error, list
// shows all jobs newest-first, cancel stops a queued/running job
// (kills the worker's whole process group, ffmpeg children included).
  {
    name: "job",
    tier: "PLAN",
    description: "Inspect a durable async render job (started by assemble async:true): status shows progress (stage + percent) and the terminal result or error, plus estimate_remaining_seconds — a rough upper-bound ETA in whole seconds while the job runs (null when it is too early to tell, or the job is queued/terminal) — and estimate_basis naming how it was derived (progress-rate from the rate over the most recent 30s of the job's own percent history when that window holds at least 2 points, else the whole-run average rate, elapsed-progress from time since start, complete/not-started/terminal/too-early); treat the number as a rough guide, never a promise. list shows all jobs newest-first; cancel stops a queued or running job. Status also carries progress_history — every distinct percent the worker reported, so in-stage movement is provable without polling luck (list omits it). admission reports the render-job admission gate (max 2 active jobs / 10 starts per minute by default, env MEDIAKIT_MAX_JOBS / MEDIAKIT_MAX_JOB_STARTS_PER_MINUTE) — check it before starting a render so a refused start does not surprise you. Jobs live under MEDIAKIT_JOBS_DIR or <workdir>/.mediakit-jobs.",
    schema: {
    job_id: z.string().optional().describe("Job id (e.g. job-20261114-005800-a1b2c3d4) — required for status/cancel"),
    action: z.enum(["status", "list", "cancel", "admission"]).default("status").describe("status: read one job; list: all jobs; cancel: stop a queued/running job; admission: the job-start gate (no job_id needed)"),
  },
    handler: async (a) => safe(async () => {
    if (a.action === "list") return core.listJobs({});
    if (a.action === "admission") return core.getJobAdmission();
    if (!a.job_id) throw new core.MediaKitError("job needs a job_id for status/cancel", "INVALID_ARG");
    return a.action === "cancel" ? core.cancelJob(a.job_id) : core.getJob(a.job_id);
  }),
  },


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
  {
    name: "download",
    tier: "WRITE",
    description: "Download a media file from an http(s) URL into the workspace — stock footage, a reference clip, a music bed. Typed and guarded: http/https only (no credentials in the URL), size cap enforced while streaming for direct files (default 500 MB, refused upfront when Content-Length already exceeds it), 5 redirects max, 300s timeout per attempt, written atomically via <output>.partial and renamed only on success, then probed — a file that is not media is deleted and reported, never left as a success. HLS (.m3u8) / DASH (.mpd) playlists are fetched with ffmpeg -c copy (re-mux, never re-encode) under a protocol whitelist, and the size cap is enforced after the fetch. The output extension is either given (must be a media extension) or derived from the Content-Type / URL path. Transient failures (HTTP 429/5xx, network errors) are retried with exponential backoff 1s/2s/4s honouring Retry-After (default 3 retries; timeouts and deterministic refusals are never retried). cache:true reuses a verified per-URL disk cache (size + sha256 checked, corrupt entries re-fetched; playlists are never cached). rate_limit_rps paces downloads in this process with a token bucket (0 = unlimited). License: pass license to declare the source's license (e.g. CC0, CC-BY, Public Domain — recorded in <output>.provenance.json, never guessed); a license policy file (MEDIAKIT_LICENSE_POLICY env, or license_policy_file per call: {allow?, deny?, require_license?}) gates the download BEFORE any fetch — a declared license outside the allow list, inside the deny list, or missing when required is refused with LICENSE_DENIED and costs zero bytes. Without a policy file the gate is off and the license is only recorded. Returns the output path, size, content-type, redirect count, attempts/retries, cache hit status, the declared license + policy verdict, and the probe summary (duration, dimensions, codecs).",
    schema: {
    url: z.string().url().describe("http(s) URL of a direct media file (video/audio/image) or an HLS (.m3u8) / DASH (.mpd) playlist"),
    output: pathSchema.describe("Output file path — with a media extension, or without one (the extension is then derived from the Content-Type / URL path)"),
    max_size_mb: z.number().min(0.01).max(2000).default(500).describe("Maximum download size in MB (default 500); refused upfront when Content-Length exceeds it, aborted mid-stream otherwise"),
    timeout_seconds: z.number().int().min(1).max(3600).default(300).describe("Per-attempt timeout in seconds (default 300); each retry gets a fresh budget"),
    cache: z.boolean().default(false).describe("Reuse a verified per-URL disk cache (default off; lives under MEDIAKIT_DOWNLOAD_CACHE_DIR or ~/.cache/mediakit/downloads, keyed by URL, verified by size + sha256; playlists are never cached)"),
    cache_dir: z.string().optional().describe("Cache directory override (default: MEDIAKIT_DOWNLOAD_CACHE_DIR env, else ~/.cache/mediakit/downloads)"),
    max_retries: z.number().int().min(0).max(5).default(3).describe("Retries for transient failures — HTTP 429/5xx and network errors (default 3; 0 = no retry; timeouts and deterministic refusals are never retried)"),
    rate_limit_rps: z.number().min(0).max(1000).default(0).describe("Token-bucket rate limit in requests/second for this process (default 0 = unlimited; the bucket starts full, so a single download is never delayed)"),
    license: z.string().optional().describe("License of the source as declared by the caller (e.g. CC0, CC-BY, Public Domain; aliases collapse to one spelling, anything else is kept verbatim) — recorded in the provenance file; with a license policy configured it is checked before any fetch, and a failing license is refused with LICENSE_DENIED"),
    license_policy_file: z.string().optional().describe("Path to a license policy JSON file {allow?, deny?, require_license?} — overrides MEDIAKIT_LICENSE_POLICY for this call; without a policy file the gate is off and the license is only recorded"),
  },
    handler: async (a) => safe(() => core.downloadMedia({
    url: a.url,
    output: a.output,
    maxSizeMb: a.max_size_mb,
    timeoutSeconds: a.timeout_seconds,
    cache: a.cache,
    cacheDir: a.cache_dir ?? null,
    maxRetries: a.max_retries,
    rateLimitRps: a.rate_limit_rps,
    license: a.license ?? null,
    licensePolicyFile: a.license_policy_file ?? null,
  })),
  },

  // Audit log / operation envelope (idea: Mnehmos/ffmpeg-llm's
  // src/audit.ts, turn 54; verify shape from heristop/leclap's
  // `leclap verify`, turn 55): every tool call on every transport
  // appends one JSONL line — tool, arguments hash + redacted copy,
  // input/output files with size + SHA-256, duration, status. This
  // tool reads the log back; verify:true re-hashes the recorded
  // files and reports matched/missing/changed per file, so the log
  // is a claim and the disk is the evidence. The log lives at
  // <workdir>/.mediakit-audit.jsonl (MEDIAKIT_AUDIT_PATH overrides,
  // MEDIAKIT_AUDIT=0 disables recording); `doctor` reports its state.
  {
    name: "audit",
    tier: "READ",
    description: "Read the audit log: every tool call this workspace has recorded (newest first), with its arguments hash, input/output files + SHA-256, duration and status. Filter by tool, status, or since a date; verify:true re-hashes the recorded files on disk and reports matched/missing/changed per file, so a stale or tampered output is caught instead of trusted.",
    schema: {
    limit: z.number().int().min(1).max(200).default(20).describe("How many entries to return, newest first (default 20, max 200)"),
    tool: z.string().optional().describe("Only entries for this tool name (e.g. trim, assemble)"),
    status: z.enum(["ok", "error"]).optional().describe("Only entries with this status"),
    since: z.string().optional().describe("Only entries at or after this date (YYYY-MM-DD or ISO timestamp)"),
    verify: z.boolean().default(false).describe("Re-hash every recorded file on disk and report matched/missing/changed per entry"),
  },
    handler: async (a) => safe(() => queryAudit({
    limit: a.limit,
    tool: a.tool ?? null,
    status: a.status ?? null,
    since: a.since ?? null,
    verify: a.verify === true,
  })),
  },


  {
    name: "motion",
    tier: "READ",
    description: "Measure real movement in a video (probe-only, writes no file): per-second curve of the fraction of pixels that changed between adjacent frames, plus still intervals and a verdict (moving / mostly-static / static). Use it as the director's motion gate — a shot that looks alive in the timeline but scores 0.0000 is a still wearing a video's clothes. A static title card measures 0.0000-0.0001, a bouncing ball 0.003-0.009, testsrc 0.06; the default still threshold 0.001 splits movement from encoder noise with a wide margin. Pass adaptive:true to calibrate the threshold to the clip instead: the threshold becomes min(max(threshold, p25-of-curve * adaptive_factor), max(adaptive_cap, threshold)) (defaults factor 2.0, cap 0.005), so light grain on a static shot (0.0007-0.0013) reads still while a bouncing ball (slowest second 0.007) still reads moving — the cap sits in the measured gap between grain and the slowest real motion. Pass lag_seconds to catch motion too slow for one frame step: the curve then compares frames N seconds apart (value at second k = change between second k and second k+N), so a 10s fade-in from black reads 0.00043 adjacent (static) but ~1.0 at lag 2. Still intervals in lag mode are corrected to clip time (end + lag, clamped to the duration); a still shorter than lag+1s, or one in the final lag seconds, is not reported — use lag 1 for short freezes.",
    schema: {
    input: pathSchema,
    threshold: z.number().min(0).max(0.5).default(0.001).describe("Still threshold on the moved-pixel fraction (0-0.5, default 0.001 = 0.1% of pixels; a window below it counts as still)"),
    min_still_seconds: z.number().min(0.5).max(60).default(2).describe("A still interval must last at least this long to be reported (default 2s; shorter still blips are ignored)"),
    window_seconds: z.number().min(0.25).max(5).default(1).describe("Curve window in seconds (default 1)"),
    lag_seconds: z.number().int().min(0).max(30).default(0).describe("Compare frames this many whole seconds apart instead of adjacent frames (default 0 = adjacent). Catches motion too slow for one frame step — a slow fade, a creeping zoom — at the cost of 1-second curve resolution; still intervals are corrected to clip time"),
    adaptive: z.boolean().default(false).describe("Calibrate the still threshold to this clip's own quiet quarter instead of using the fixed threshold (default false)"),
    adaptive_factor: z.number().min(1).max(10).default(2).describe("Adaptive mode: multiply the clip's 25th-percentile motion by this (default 2.0)"),
    adaptive_cap: z.number().min(0.0005).max(0.05).default(0.005).describe("Adaptive mode: the calibrated threshold never exceeds this (default 0.005 — sits between light grain and the slowest real motion)"),
  },
    handler: async (a) => safe(() => core.measureMotion({
    input: a.input,
    threshold: a.threshold,
    minStillSeconds: a.min_still_seconds,
    windowSeconds: a.window_seconds,
    adaptive: a.adaptive,
    adaptiveFactor: a.adaptive_factor,
    adaptiveCap: a.adaptive_cap,
    lagSeconds: a.lag_seconds,
  })),
  },


  // Find the best hook window in a clip (sonic-match-mcp's
  // hook_window idea, measured from the footage instead of a script):
  // a sliding window scored on audio energy (astats RMS per frame),
  // speech coverage (silencedetect) and scene cuts (a window that
  // opens on a cut scores higher). The director's opening-shot
  // picker — run it on raw footage before cutting the first 15
  // seconds of a Short.
  {
    name: "hook",
    tier: "READ",
    description: "Find the best hook window in a clip (probe-only, writes no file): slide a window of duration seconds across the file and score each candidate on five measured signals — mean audio energy (astats RMS per frame, binned and normalized against the file's own loudest bin), speech coverage (silencedetect complement), scene cuts (a window opening on a cut, plus cuts inside it, reads as a new beat), real motion (per-frame pixel-diff fraction, binned on the same step grid, normalized against a fixed 0.06 reference — testsrc-level motion is 1.0 — with a 0.001 noise floor and a 0.005 file-level gate so a static clip never scores motion from encoder noise), and visual beats (the highlights perceptual-hash boundaries inside the window — 2+ beats is fully active, 1 beat is half; a boundary at the window start counts, the window opens on it). Score is 0.3*energy + 0.2*speech + 0.2*cut + 0.2*motion + 0.1*visual (audio 0.5 / video 0.5), fixed weights so two runs rank the same way; the top windows are greedy non-overlapping, so they are alternatives, not the same window shifted by one step. Returns the ranked candidates with the score breakdown (each carries visual + visual_beats), the highlight_boundaries, the per-step energy curve (each bin also carries motion + motion_fraction), pacing from real cuts (slow/medium/fast-cut), a trim object, and a suggested_trim command. The trim end snaps to the nearest quiet moment (shorts-maker-gpu's smart end point): within the last snap_window_seconds (default 5) the quietest bin — quiet is (energy + motion) / 2 — wins when it is at most half as busy as the window's own mean, earliest wins a tie so the cut lands where the quiet starts, and the snap never shortens the hook below max(4s, half the window); a uniformly loud window or a whole-file hook keeps its raw end (trim.snapped false + reason). Video-only input scores on cuts+motion; audio-only on energy+speech. Files over 20 minutes are refused (the astats log would exceed the capture buffer). Clip history: pass history_file (a JSON file {version: 1, records: [{source_sha256, start, end, score, recorded_at}]}) to check every candidate against moments already cut — a candidate is duplicate when it comes from the same source file (sha256) and overlaps a recorded window by >= history_overlap (default 0.5) of the shorter window, reported as duplicate + duplicate_of on the candidate; history reports records_checked/duplicates_found/recorded. With record: true the winning window is appended to the history file (atomic write, only the winner — the alternatives were never cut, so they stay eligible); record without history_file is refused. A missing history file is an empty history; a corrupt one fails loudly.",
    schema: {
    input: pathSchema,
    duration: z.number().min(4).max(20).default(15).describe("Hook window length in seconds, 4-20 (default 15 — the sonic-match 12-20s hook range)"),
    step: z.number().min(0.25).max(2).default(0.5).describe("Slide step in seconds (default 0.5)"),
    top: z.number().int().min(1).max(5).default(3).describe("How many ranked windows to return (default 3)"),
    threshold_db: z.number().min(-90).max(0).default(-40).describe("Silence threshold in dB for speech coverage (default -40)"),
    history_file: z.string().optional().describe("JSON clip-history file to check candidates against (see description); a missing file is an empty history"),
    record: z.boolean().default(false).describe("Append the winning window to history_file after the run (needs history_file; only the winner is recorded)"),
    history_overlap: z.number().min(0.05).max(1).default(0.5).describe("Overlap fraction of the shorter window that marks a duplicate (default 0.5)"),
    snap_window_seconds: z.number().min(1).max(10).default(5).describe("How many seconds back from the window end to search for a quiet moment to snap the trim to (default 5)"),
    snap_quiet: z.boolean().default(true).describe("Snap the suggested trim end to the nearest quiet moment (default true; false keeps the raw window end)"),
  },
    handler: async (a) => safe(() => core.findHook({
    input: a.input,
    duration: a.duration,
    step: a.step,
    top: a.top,
    thresholdDb: a.threshold_db,
    historyFile: a.history_file ?? null,
    record: a.record ?? false,
    historyOverlap: a.history_overlap ?? 0.5,
    snapQuiet: a.snap_quiet ?? true,
    snapWindowSeconds: a.snap_window_seconds ?? 5,
  })),
  },


  // Measure the musical tempo of a clip (probe-only, writes no file):
  // spectral-flux onset function -> autocorrelation + comb filterbank
  // period search (aubio's tempo pipeline, re-implemented in pure
  // Node), with a 120 BPM prior and an onset-recall tie-break so a
  // drum pattern reads as its musical beat, not its subdivision. The
  // missing piece before beat-grid cut snapping: the returned beat
  // grid (first 16 beat times) is what a cut snaps to. A steady tone
  // or speech reports reliable: false instead of a confident wrong
  // number — never snap cuts to an unreliable grid.
  {
    name: "bpm",
    tier: "READ",
    description: "Measure the musical tempo of a clip in BPM (probe-only, writes no file): decode to mono PCM, build a spectral-flux onset function, find the period by autocorrelation + comb filterbank with a 120 BPM prior and an onset-recall tie-break (aubio tempo, re-implemented in pure Node). Returns bpm (1 decimal), beat_period_seconds, confidence 0-1, reliable flag, onset_recall, onsets_detected, first_beat_seconds and the first 16 beat times. A steady tone has no onsets and speech has no steady beat — both report reliable: false with low confidence instead of a confident wrong number; do not snap cuts to an unreliable grid. Files over 10 minutes or under 4s are refused.",
    schema: {
    input: pathSchema,
    min_bpm: z.number().min(20).max(300).default(40).describe("Lowest tempo to consider in BPM (default 40)"),
    max_bpm: z.number().min(20).max(300).default(240).describe("Highest tempo to consider in BPM (default 240)"),
  },
    handler: async (a) => safe(() => core.detectBpm({
    input: a.input,
    minBpm: a.min_bpm,
    maxBpm: a.max_bpm,
  })),
  },


  // The full beat grid for a clip (probe-only, writes no file): the
  // same measurement as bpm, but every beat across the file instead
  // of the first 16 — the cut points trim --snap-beat snaps to, and
  // what a director hands to an editor. A steady tone or speech
  // still returns its grid with reliable: false — never snap cuts to
  // an unreliable grid (trim --snap-beat refuses it). The grid is
  // rigid by default: one tempo + one phase for the whole file, so a
  // clip whose tempo drifts will drift off it — method "dp" runs the
  // DP beat tracker instead (librosa's beat_track, Ellis 2007,
  // re-implemented in pure Node): it picks real onset peaks near the
  // grid, so the beats stay on the music while the tempo moves, and
  // reports tempo_drift_seconds — how far the DP beats sit from the
  // rigid grid at worst (0.373s on a 120->132 drift take, 0.026s on
  // a steady 120 click track).
  {
    name: "beat_grid",
    tier: "READ",
    description: "Return the full beat grid of a clip (probe-only, writes no file): the same spectral-flux + autocorrelation/comb measurement as bpm, expanded to every beat across the file instead of the first 16. Returns bpm, beat_period_seconds, confidence, a reliable flag, onset_recall, onsets_detected, first_beat_seconds, beats (all of them, 3 decimals), beat_count and last_beat_seconds. A steady tone or speech reports reliable: false with a warning — do not snap cuts to an unreliable grid (trim snap_to_beat refuses it). The grid is rigid by default: one steady tempo for the whole file, so a clip whose tempo drifts will drift off it. Set method=\"dp\" to run the DP beat tracker instead (librosa beat_track, re-implemented in pure Node): it picks real onset peaks near the grid, so the beats stay on the music while the tempo moves, and reports tempo_drift_seconds (worst distance from the rigid grid) and tempo_drift_cv (interval variation). Files over 10 minutes or under 4s are refused.",
    schema: {
    input: pathSchema,
    min_bpm: z.number().min(20).max(300).default(40).describe("Lowest tempo to consider in BPM (default 40)"),
    max_bpm: z.number().min(20).max(300).default(240).describe("Highest tempo to consider in BPM (default 240)"),
    method: z.enum(["grid", "dp"]).default("grid").describe("grid: one steady tempo + phase for the whole file (default); dp: DP beat tracker that follows real onset peaks, for takes whose tempo drifts"),
  },
    handler: async (a) => safe(() => core.detectBeatGrid({
    input: a.input,
    minBpm: a.min_bpm,
    maxBpm: a.max_bpm,
    method: a.method ?? "grid",
  })),
  },


  // Local tempo over time (probe-only, writes no file): sliding
  // windows of the spectral-flux onset envelope, each measured by the
  // same aubio pipeline `bpm` uses (the local-tempo idea of librosa's
  // `plp`; a tempogram peak was tried first and read 239.1 on the
  // kick+hat drum — see localTempoCurve), aggregated to a 1-second
  // tempo_curve. Answers the director's question "does this take
  // speed up or slow down, and where" — bpm gives one number for the
  // whole file, this gives the curve. Returns start_bpm / end_bpm
  // (median of the first/last 20% of reliable bins), delta_bpm,
  // max_deviation_bpm, direction (speeding_up / slowing_down /
  // steady) and verdict (steady / drifting / variable / unreliable).
  // A steady tone or speech reports verdict unreliable instead of a
  // confident wrong curve. Files over 10 minutes or under 8s are
  // refused (the analysis window alone is ~4-9s).
  {
    name: "tempo_drift",
    tier: "READ",
    description: "Measure the local tempo of a clip over time (probe-only, writes no file): sliding-window tempo estimation — the aubio pipeline (spectral-flux + autocorrelation/comb + 120 BPM prior + onset-recall tie-break) run on overlapping windows of the onset envelope, aggregated to a 1-second tempo_curve (the local-tempo idea of librosa's plp). Returns bpm (global), confidence, a reliable flag, tempo_curve (1s bins with bpm + confidence + reliable), start_bpm / end_bpm (median of the first/last 20% of reliable bins), delta_bpm, max_deviation_bpm, direction (speeding_up / slowing_down / steady) and verdict (steady / drifting / variable / unreliable). Use it before snapping cuts to a beat grid: a drifting take (120->132 over 12s reads delta +6.5) needs beat_grid --method dp, not the rigid grid. A steady tone or speech reports verdict unreliable. Files over 10 minutes or under 8s are refused.",
    schema: {
    input: pathSchema,
    min_bpm: z.number().min(20).max(300).default(40).describe("Lowest tempo to consider in BPM (default 40)"),
    max_bpm: z.number().min(20).max(300).default(240).describe("Highest tempo to consider in BPM (default 240)"),
  },
    handler: async (a) => safe(() => core.detectTempoDrift({
    input: a.input,
    minBpm: a.min_bpm,
    maxBpm: a.max_bpm,
  })),
  },


  // Verify an assemble render against its receipt (heristop/leclap's
  // `verify` idea, turn 63): the receipt (assemble-receipt.json, written
  // next to final.mp4 by every full render) records per-input digests,
  // the combined fingerprint, the output sha256 and measured properties.
  // Check mode re-hashes everything on disk and names the first thing
  // that moved (edited voice, swapped clip, deleted output); rerender
  // mode re-runs assemble from the recorded manifest (force) and
  // compares the new receipt against the old one — on this machine
  // renders are byte-identical, so it is a real reproducibility proof.
  // Across machines only the measured properties are comparable.
  {
    name: "verify",
    tier: "READ",
    description: "Verify an assemble render against its receipt (assemble-receipt.json from a full render): re-hash every input (manifest, voice, music, captions, sfx, shot assets) and the output file, re-measure duration/frames/dimensions/LUFS, and report matched/changed/missing per item with a pass/fail verdict and the first difference. With rerender:true, re-run assemble from the recorded manifest (force) into a temp directory and compare the new receipt against the old one — a byte-identical output plus matching inputs proves the render reproduces. Use it after any render you must trust (report videos, deliveries) and whenever a file has been edited since the render.",
    schema: {
    receipt: pathSchema.describe("Path to assemble-receipt.json (written next to final.mp4 by a full assemble render)"),
    rerender: z.boolean().default(false).describe("Re-run assemble from the recorded manifest and compare the new receipt against the old one (default false = check the files on disk against the receipt only)"),
    output_dir: pathSchema.optional().describe("Where the rerender goes (rerender mode only). Default: a temp directory next to the receipt, removed after the comparison — pass a directory to keep the rerendered film."),
  },
    handler: async (a) => safe(() => core.verifyRender({
    receipt: a.receipt,
    rerender: a.rerender === true,
    outputDir: a.output_dir ?? null,
  })),
  },

  // Cut verification for an assemble render (metiutek/editorvideo-ai's
  // `review.verify` idea, turn 112): verify proves the files did not
  // move since the render; verify_cuts proves the RENDER cuts where
  // the manifest promised. It downscales the delivered file to a 270p
  // draft, measures the real hard cuts with the content scene
  // detector, and compares them against the manifest's shot
  // boundaries: a hard cut must land within tolerance (default 0.25s)
  // of its promised time, a transition must show a real visual change
  // across its blend window (a 0.4s fade fires no scene cut at all,
  // so the frames just outside the window are diffed instead), and
  // any cut the detector finds that no boundary explains is reported
  // as unexpected. Duration is checked against the voice timeline.
  // Probe-only: the only file written is the temp draft, removed
  // afterwards unless keep_draft. Run it after every render you must
  // trust, next to verify.
  {
    name: "verify_cuts",
    tier: "PLAN",
    description: "Verify an assemble render cuts where its film manifest promises: downscale the delivered video to a 270p draft, measure the real hard cuts with the content scene detector, and compare them against the manifest's shot boundaries — a hard cut must land within tolerance (default 0.25s) of its promised time, a transition must show a real visual change across its blend window (measured as a frame diff, since a fade fires no scene cut), and any extra cut is reported as unexpected. Duration is checked against the voice timeline (±0.2s). Returns ok plus one entry per boundary (confirmed/missing/invisible_transition/unmeasured) and the list of unexpected cuts. Probe-only: writes nothing except a temp draft, removed afterwards unless keep_draft. With strips:true it also writes one 4-tile review strip per boundary (frames at cut-0.5/-0.1/+0.1/+0.5s, captured from the delivered video and labelled with offset + timestamp) into <video-stem>.cut-strips/ next to the video, or into strips_dir when given — the eye-check the numbers cannot give: open the strip and look at both sides of each seam. With audio:true it also measures the SOUND at every hard cut (transitions are not measured — their blend is continuous by design): the RMS energy 0.06s each side of the seam and the largest sample-to-sample jump ±40ms around it; RMS above -30 dBFS on either side flags suspect_word (the cut may land mid-word), a jump above 0.35 flags click (butt-splice click) — either flag warns and fails ok. Peak per side is reported too, but the verdict uses RMS: a single lossy-codec pre-echo sample can trip a peak test inside true silence (measured: -24.4 dBFS peak in one 10ms sliver of a silent window, RMS -51.8 dBFS). Opt-in because a canvas_scene film mixes one continuous voice across every visual cut by design, so with audio on every hard cut there flags suspect_word; the check is for dialogue edits, where cuts belong in silence. A video with no audio stream skips the audio check with a note, never a fake pass.",
    schema: {
    manifest_path: pathSchema.describe("Path to the film manifest JSON file (same schema as assemble)"),
    video: pathSchema.describe("Path to the rendered video to check (final.mp4 from a full assemble render)"),
    tolerance: z.number().min(0).max(5).default(0.25).describe("How far a measured cut may drift from its promised time, in seconds (default 0.25)"),
    threshold: z.number().min(0).max(1).optional().describe("Content scene-detector threshold (default 0.05 — the calibrated content-detector default; raise it only if smooth animation inside a shot is reported as a cut)"),
    draft_height: z.number().int().min(16).max(4320).default(270).describe("Draft height in px for the scene-detection pass (default 270 — detection is resolution-insensitive; raise it only if a cut is missed on the draft)"),
    keep_draft: z.boolean().default(false).describe("Keep the temp draft render and report its path (default false = removed afterwards)"),
    strips: z.boolean().default(false).describe("Also write one 4-tile review strip per boundary (frames at cut-0.5/-0.1/+0.1/+0.5s from the delivered video, labelled with offset + timestamp) — default false, the verify stays probe-only"),
    strips_dir: pathSchema.optional().describe("Directory for the review strips (default <video-stem>.cut-strips/ next to the video; ignored unless strips is true)"),
    audio: z.boolean().default(false).describe("Also measure the SOUND at every hard cut: RMS energy 0.06s each side of the seam (above -30 dBFS flags suspect_word — the cut may land mid-word; peak per side is reported too, but the verdict uses RMS because a single lossy-codec pre-echo sample can trip a peak test inside true silence) and the largest sample jump ±40ms around it (above 0.35 flags click) — either flag warns and fails ok. Default false: a canvas_scene film mixes one continuous voice across every visual cut by design, so this check is for dialogue edits, where cuts belong in silence"),
  },
    handler: async (a) => safe(() => core.verifyAssembleCuts({
    manifestPath: a.manifest_path,
    video: a.video,
    tolerance: a.tolerance,
    threshold: a.threshold ?? null,
    draftHeight: a.draft_height,
    keepDraft: a.keep_draft === true,
    strips: a.strips === true,
    stripsDir: a.strips_dir ?? null,
    audio: a.audio === true,
  })),
  },

  // Director preflight for a film manifest (heristop/leclap's
  // `diagnose` idea, turn 64): validate is the format gate (it
  // throws on the first hard error); diagnose is the judgement
  // gate — it runs validate, then measures what validate cannot:
  // real motion inside each video shot's exact window, source
  // geometry vs the film frame (upscale / fps), the visual seam
  // across each transition, caption coverage, music loops, sfx
  // tails, chapter alignment and text-layer collisions. Probe-only,
  // nothing is written. A broken manifest comes back as verdict
  // "fail" with format_error instead of throwing, so an agent can
  // fix the manifest and re-run diagnose in a loop. Run it after
  // writing a film.json and before approve/render; run verify after
  // the render.
  {
    name: "diagnose",
    tier: "READ",
    description: "Director preflight for an assemble film manifest: validate the manifest, then measure what validation cannot — real motion inside each video shot's exact window (a frozen video is an error), source geometry vs the film frame (upscale over 2x or a low fps warns), the visual seam across each transition (near-identical frames warn), voice loudness, caption coverage and gaps, music loop count, sfx tails past the film end, chapter alignment to cuts, text layers that are too tall or sit in the burned-caption band, and style pace (cuts per minute + longest hold scored against the style.json — an explicit style_file, or the style.json sitting next to the film; films under 15s are too short to compare), and per-shot pacing (a run of 3+ same-look shots, a shot under 1s or over 15s, dialogue denser than 15 chars/s). Probe-only, writes nothing. Returns a pass/warn/fail verdict with one check per finding and the first issue. A broken manifest returns verdict fail with format_error instead of throwing. With stamp=true it also writes a QC stamp sidecar <film>.mediakit-diagnose.json keyed on the film fingerprint (manifest + voice + music + sfx + captions + assets + brand) plus the style file hash and the ffmpeg/ffprobe versions; with use_stamp=true it reuses the stamp instead of re-running the preflight when the film, the style and the toolchain all still match, and reports stamp.used=false with the stale reason (no_stamp/film_changed/environment_mismatch/stamp_invalid) when they do not — a stamp never overrides a fresh run.",
    schema: {
    manifest_path: pathSchema.describe("Path to the film manifest JSON file (same schema as assemble)"),
    style_file: pathSchema.optional().describe("Style file to score the film's pace against (default: style.json next to the film manifest, when it exists)"),
    stamp: z.boolean().default(false).describe("Write a QC stamp sidecar <film>.mediakit-diagnose.json keyed on the film fingerprint + style file hash + toolchain versions (written atomically)"),
    use_stamp: z.boolean().default(false).describe("Reuse the QC stamp instead of re-running the preflight when the film, the style and the toolchain all still match; reports stamp.used=false with the stale reason when they do not"),
  },
    handler: async (a) => safe(() => core.diagnoseFilm({
    manifestPath: a.manifest_path,
    styleFile: a.style_file ?? null,
    stamp: a.stamp,
    useStamp: a.use_stamp,
  })),
  },

  // Voice-to-shot alignment (idea: Yuuhann1999/agent-storyboard
  // `timing.mjs` estimateTiming/applyTiming — the director's "the
  // voice is the master clock" made automatic): split the voice
  // across the shots that speak, in proportion to each shot's
  // dialogue characters, then snap each interior boundary to the
  // middle of the nearest pause (within 600ms) so a cut never clips
  // a word. Plan mode writes nothing; --apply writes an aligned
  // film (never over the input) and embeds the dialogue, so a later
  // re-align reproduces the same dialogue_key. --expected-key locks
  // the apply: a changed line or reordered shot refuses with
  // DIALOGUE_CHANGED instead of silently aligning the wrong script.
  {
    name: "align_voice",
    tier: "READ",
    description: "Align an assemble film's shot durations to its voice: split the voice across the shots that speak, in proportion to each shot's dialogue characters (whitespace-free count, like agent-storyboard's estimateTiming), then snap each interior boundary to the middle of the nearest pause within snap_window_ms (default 600) so a cut never clips a word. Dialogue comes from each shot's `dialogue` field, overridden per shot by a --lines file [{shot, dialogue}]; shots with no dialogue keep their durations. Durations are whole frames at the film fps and each spoken run's frame sum is preserved, so the aligned film still tiles lead + voice + tail exactly. Plan mode (default) writes nothing and reports the dialogue_key (sha256 over [[shot id, dialogue]] in film order), per-shot durations/deltas/snap info, and violations (motion-gate, text layer past the new duration, transition too long, hook past the shot). Apply mode (--apply + --output) writes the aligned film — never over the input — embeds the dialogue it aligned from, re-validates the written file, and refuses when there are violations or when --expected-key differs from the computed key (dialogue changed or shots reordered — re-run without it to re-align).",
    schema: {
    film_path: pathSchema.describe("Path to the assemble film manifest JSON file (same schema as assemble; each shot may carry a `dialogue` string)"),
    lines_path: pathSchema.optional().describe("Optional JSON file [{shot, dialogue}] — overrides the film's `dialogue` field for the shots it names"),
    threshold_db: z.number().min(-90).max(0).default(-40).describe("Silence threshold in dBFS for pause detection (default -40, same as the silence tool)"),
    min_silence_seconds: z.number().min(0.05).max(60).default(0.25).describe("Shortest pause that counts as a snap target, in seconds (default 0.25 — shorter than the silence tool's 0.5, so natural speech pauses count)"),
    snap_window_ms: z.number().int().min(0).max(5000).default(600).describe("Snap window in milliseconds: a pause midpoint within this far of the proportional boundary is used (default 600, agent-storyboard's window)"),
    apply: z.boolean().default(false).describe("Write the aligned film (needs output_path); without this, only the plan is returned and nothing is written"),
    output_path: pathSchema.optional().describe("Where to write the aligned film JSON (required with apply=true; never the input film)"),
    expected_key: z.string().optional().describe("Dialogue lock: refuse the apply unless the computed dialogue_key equals this value (dialogue changed or shots reordered)"),
  },
    handler: async (a) => safe(() => core.alignVoice({
      filmPath: a.film_path,
      linesPath: a.lines_path ?? null,
      thresholdDb: a.threshold_db ?? -40,
      minSilenceSeconds: a.min_silence_seconds ?? 0.25,
      snapWindowMs: a.snap_window_ms ?? 600,
      apply: a.apply ?? false,
      outputPath: a.output_path ?? null,
      expectedKey: a.expected_key ?? null,
    })),
  },

  // Auto-chapters for a long talk / film (op7418/Youtube-clipper idea,
  // turn 64): split a transcript on long pauses, or split audio on
  // silence, and name each chapter from the first words spoken in it.
  // The first chapter is always at 0 (YouTube requires it); over 32
  // chapters the closest neighbours merge first. Output is the
  // assemble manifest shape {title, at}, so it drops straight into
  // film.json's "chapters".
  {
    name: "chapters",
    tier: "READ",
    description: "Generate chapter markers for a long talk or film from measured pauses, not guesses. Two modes, exactly one: words_file (a transcribe --word-timestamps JSON) splits the transcript wherever the gap between two words reaches min_gap (default 2s) and titles each chapter from the first words spoken in it; input (a media file with audio) runs silencedetect and starts a chapter at each speech segment that follows a silence of at least min_gap, titled Part 1..N. The first chapter is always at 0 (YouTube requires the first chapter at 0:00) — when the first word/speech starts later the chapter is clamped to 0 and reported. Over max_chapters (default 32, the assemble cap) the closest neighbours merge first. Returns chapters in the assemble manifest shape {title, at}; pass output to also write that JSON to a file.",
    schema: {
    words_file: pathSchema.optional().describe("Transcript words JSON from transcribe --word-timestamps ({words:[{start,end,word}]}) — one of words_file / input"),
    input: pathSchema.optional().describe("Media file with an audio stream — one of words_file / input; chapters start at speech after a silence"),
    min_gap: z.number().min(0.1).max(3600).default(2).describe("Pause length in seconds that starts a new chapter (default 2)"),
    title_words: z.number().int().min(1).max(8).default(4).describe("Words taken from the start of each segment for its title (words mode only, default 4)"),
    max_chapters: z.number().int().min(1).max(32).default(32).describe("Chapter cap (default 32, the assemble cap); over it the closest neighbours merge first"),
    threshold_db: z.number().min(-90).max(0).default(-40).describe("Silence threshold in dBFS (input mode only, default -40)"),
    min_duration: z.number().min(0.05).max(60).default(0.5).describe("Shortest silence that counts, in seconds (input mode only, default 0.5)"),
    output: pathSchema.optional().describe("Optional .json file to write {chapters:[{title, at}]} into (assemble manifest shape)"),
  },
    handler: async (a) => safe(() => core.autoChapters({
    wordsFile: a.words_file ?? null,
    input: a.input ?? null,
    minGap: a.min_gap ?? 2,
    titleWords: a.title_words ?? 4,
    maxChapters: a.max_chapters ?? 32,
    thresholdDb: a.threshold_db ?? -40,
    minDuration: a.min_duration ?? 0.5,
    output: a.output ?? null,
  })),
  },

  // The transition catalog (probe-only, writes no file): the grouped
  // list `concat` / `slideshow` / `assemble` accept — read this
  // before picking a transition name, instead of guessing one and
  // hitting "unknown transition". `category` narrows to one family
  // (fade, wipe, slide, smooth, shape, diagonal, slice, wind,
  // cover, reveal, other); without it the whole catalog comes back.
  {
    name: "transitions",
    tier: "READ",
    description: "List the xfade transition catalog (probe-only, writes no file): every transition name concat / slideshow / assemble accept, grouped by family — fade (cross-dissolve), wipe (hard edge sweep), slide (push off frame), smooth (eased slide), shape (geometric mask), diagonal, slice (strips peel away), wind (strips blow across), cover (curtain in), reveal (outgoing slides away), other (pixelize, radial, blur, zoom, squeeze). Returns total (58 on ffmpeg 8.1.2) plus per-category names and one-line descriptions. Pass category to narrow to one family; an unknown category is refused with the valid list.",
    schema: {
    category: z.string().optional().describe("One category name (fade, wipe, slide, smooth, shape, diagonal, slice, wind, cover, reveal, other) — omit for the full catalog"),
  },
    handler: async (a) => safe(() => core.listTransitions({
    category: a.category ?? null,
  })),
  },


  {
    name: "export_timeline",
    tier: "WRITE",
    description: "Export an assemble film manifest to an OpenTimelineIO timeline (.otio) — the director's EDL for a real editor (DaVinci / Premiere / any OTIO adapter): the same cuts, transitions, chapters and audio the ffmpeg render produces, with media linked by absolute file:// URL. One Video track (a Clip per image/video shot, a Gap per color/canvas_scene shot — generated frames have no file, so the gap is honest — with a Transition between joined shots), plus Audio tracks for Voice (lead gap + voice + tail gap), Music (looped to the film length) and SFX (each at its timestamp). Chapters become Marker.2 markers on the video track (OTIO 0.18 cannot read Marker.1). Transitions map the xfade join exactly: in_offset/out_offset are the split of the transition frames (in = ceil half, out = floor half), so the OTIO dissolve starts where the ffmpeg blend starts; fade-family xfade names become SMPTE_Dissolve, the rest Custom_Transition with the xfade name in metadata. Frame math is rational, never float seconds: every boundary is a whole number of frames at the film fps, and frame_math reports the snap error per shot (a 26.575s shot at 30fps is 797 frames with a -0.25-frame snap, never 797.25 frames). A file that passed validation and then vanished is linked with available_range null and listed in media.missing instead of failing the export. The writer self-checks the document (every track sums to exactly total_frames) and refuses to write a bad one. Returns the timeline summary, frame_math, media.missing, warnings and the self-check.",
    schema: {
    manifest_path: pathSchema.describe("Path to the assemble film manifest (film.json) to export"),
    output: pathSchema.describe("Output .otio path (must end in .otio)"),
  },
    handler: async (a) => safe(() => core.exportTimeline({
    manifestPath: a.manifest_path,
    output: a.output,
  })),
  },

  // Safety tiers (EncodeX's safety.ts idea, lượt 141): every tool
  // carries one of READ / PLAN / WRITE / DESTRUCTIVE — see `safety`
  // below and the Safety tiers section of the README. The tier is a
  // property of the tool, not of its arguments: a WRITE tool with
  // dry_run=true still reports WRITE (it writes by default).
  {
    name: "safety",
    tier: "READ",
    description: "Safety tiers for every MediaKit tool (EncodeX's safety-tier idea): READ tools only probe and write nothing (probe, check, hook, diagnose); PLAN tools answer a question by transient work and leave no artifact (determinism renders to a hidden work dir that is removed, verify_cuts renders a draft to temp — plus caller-requested review strips when strips:true, estimate_conversion sample-encodes to temp, job only reads/cancels job state); WRITE tools produce a file the caller asked for and never overwrite their own input (prepareOutput refuses that); DESTRUCTIVE tools replace or remove a user artifact in place — only patch_manifest, and it is guarded by expected_revision plus a .bak backup. Returns the tier table with every tool named, the counts, and the rules. Read this before letting an agent loose on a workspace.",
    schema: {},
    handler: async () => safe(() => listSafetyTiers()),
  },

  // Estimate a convert's size + time before running it (EncodeX's
  // estimate_conversion idea, lượt 141): measured, not a bitrate
  // table — video-only sample encodes at two lengths per window
  // position (steady rate + one keyframe, GOP 250), audio copied
  // (the convert default) or measured from one audio-only sample.
  // A short file is encoded whole, so the answer is exact.
  {
    name: "estimate_conversion",
    tier: "PLAN",
    description: "Estimate a convert's output size and time BEFORE running it (EncodeX's estimate_conversion idea): measured, not a bitrate table. At 2 window positions (25%/75% of the file) it encodes the same start twice, video-only, at a short length (default 2s) and a long length (default 6s) with accurate seek — both start with one keyframe, so steady_rate = (long_bytes - short_bytes) / (long - short) and iframe_bytes = short_bytes - steady_rate x short; full video = steady_rate x duration + iframe_bytes x one keyframe per 250 frames (the x264/x265 default GOP). Audio is copied by default (the convert default), so its cost is the probed source audio bitrate x duration; pass audio_bitrate_kbps to re-encode audio, measured from one audio-only sample encode. Time is a rough ETA (duration / measured encode speed + one measured startup); size is the precise part — on the fixtures it lands within 10% (hook-source -6.1%, source +4.2% at crf 23; source.mp4 takes the full-encode path and is exact). A file shorter than the sample budget is encoded whole, so the answer is exact instead of estimated. Leaves no artifact: samples go to a temp dir that is removed afterwards. Only libx264/libx265 (vp9/av1 use different quality knobs, so a crf estimate would not match convert).",
    schema: {
    input: pathSchema,
    video_codec: z.enum(["libx264", "libx265"]).default("libx264").describe("Target video codec (default libx264); only these two — vp9/av1 use different quality knobs"),
    crf: z.number().int().min(0).max(51).default(23).describe("Constant rate factor 0-51 (default 23, same as convert)"),
    preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]).default("medium").describe("x264/x265 preset (default medium, same as convert)"),
    width: z.number().int().min(2).optional().describe("Target width in pixels (omit = source display width; the other dimension follows aspect when only one is given)"),
    height: z.number().int().min(2).optional().describe("Target height in pixels (omit = source display height)"),
    fps: z.number().positive().optional().describe("Target frame rate (omit = source fps)"),
    audio_bitrate_kbps: z.number().int().min(8).max(320).optional().describe("Re-encode audio to this bitrate in kbps; omit to copy the source audio (the convert default)"),
    positions: z.number().int().min(1).max(3).default(2).describe("How many window positions to sample (1-3, default 2: 25% and 75% of the file)"),
    short_seconds: z.number().min(1).max(3).default(2).describe("Short sample length in seconds (default 2)"),
    long_seconds: z.number().min(4).max(10).default(6).describe("Long sample length in seconds (default 6, must be longer than short_seconds)"),
  },
    handler: async (a) => safe(() => core.estimateConversion({
    input: a.input,
    videoCodec: a.video_codec ?? "libx264",
    crf: a.crf ?? 23,
    preset: a.preset ?? "medium",
    width: a.width ?? null,
    height: a.height ?? null,
    fps: a.fps ?? null,
    audioBitrateKbps: a.audio_bitrate_kbps ?? null,
    positions: a.positions ?? 2,
    shortSeconds: a.short_seconds ?? 2,
    longSeconds: a.long_seconds ?? 6,
  })),
  },

  // Release checkpoint (KyaniteLabs/kinocut's `release-checkpoint`
  // idea, lượt 145): one QC gate that runs the pieces already
  // measured — verify against the assemble receipt, the platform
  // check, full loudness, clipping, cut positions against the film
  // manifest — plus a contact sheet at the inspection points
  // (shot midpoints + transition midpoints from the manifest,
  // evenly spaced without one), and writes one JSON verdict next
  // to the clip. A check with nothing to measure reports skipped,
  // never a fake pass. Loudness: pass |LUFS+14| <= 1.0 and true
  // peak <= -1.0 dBTP, warn |LUFS+14| <= 2.0 and TP <= -0.5, else
  // fail. Clipping fails on any peak >= 0 dBFS. Cuts fail on any
  // missing boundary or unexpected cut. The receipt must be for
  // this input. The checkpoint JSON is written atomically
  // (.partial + rename); the sheet is <stem>.checkpoint-sheet.jpg
  // next to it. Not in batch/manifest in v1.
  {
    name: "release_checkpoint",
    tier: "WRITE",
    description: "Release checkpoint — one QC gate for a finished clip (KyaniteLabs/kinocut's release-checkpoint idea): verify against the assemble receipt (pass only when 0 changed/missing, and the receipt must be for this input), the platform check (default tiktok), full loudness (pass |LUFS+14| <= 1.0 and true peak <= -1.0 dBTP, warn |LUFS+14| <= 2.0 and TP <= -0.5), clipping (fail on any peak >= 0 dBFS), cut positions against the film manifest (fail on any missing boundary or unexpected cut), plus a contact sheet at the inspection points — shot midpoints + transition midpoints from the manifest, evenly spaced without one. A check with nothing to measure reports skipped, never a fake pass (no receipt, no manifest, no audio stream, --no-sheet). Writes <stem>.checkpoint.json (atomic .partial + rename) with the per-check list, the verdict, warnings, sha256, probe summary and version, and <stem>.checkpoint-sheet.jpg next to it. Run it on every deliverable before calling it done.",
    schema: {
    input: pathSchema,
    manifest_path: pathSchema.optional().describe("Path to the film manifest JSON file (assemble film.json) to verify cuts against and to take contact-sheet timestamps from; omit to skip the cuts check and space the sheet evenly"),
    receipt: pathSchema.optional().describe("Assemble receipt (assemble-receipt.json from a full render) to verify the clip against; omit to skip the receipt check — the receipt must be for this input"),
    platform: z.enum(["tiktok", "reels", "shorts", "youtube", "instagram-feed", "instagram-story", "linkedin"]).default("tiktok").describe("Destination platform for the dimensions/codec gate (default tiktok)"),
    output: pathSchema.optional().describe("Checkpoint JSON path (default <input-stem>.checkpoint.json next to the input; the sheet goes next to the JSON)"),
    sheet: z.boolean().default(true).describe("Write the contact sheet (default true; false skips it and reports contact_sheet skipped)"),
    sheet_frames: z.number().int().min(1).max(64).default(9).describe("How many frames in the contact sheet (default 9; with a manifest the sheet uses at most this many inspection points)"),
  },
    handler: async (a) => safe(() => core.releaseCheckpoint({
    input: a.input,
    manifest: a.manifest_path ?? null,
    receipt: a.receipt ?? null,
    platform: a.platform ?? "tiktok",
    output: a.output ?? null,
    sheet: a.sheet ?? true,
    sheetFrames: a.sheet_frames ?? 9,
  })),
  },


  {
    name: "list_operations",
    tier: "READ",
    description: "Browse the tool catalog without paying for every input schema: one compact line per tool (name, family, safety tier, one-sentence summary) — the progressive-discovery entry point (KyaniteLabs/kinocut's list_operations idea). tools/list dumps the full JSON schema of all 89 tools every turn; call this first instead, then describe_operation for the full schema of only the tools you actually need. Pass family to narrow to one family (inspect, edit, text, image, assemble, meta). Always lists the FULL catalog, even when MEDIAKIT_TOOL_PROFILE=hot hides tools from tools/list.",
    schema: {
    family: z.enum(["inspect", "edit", "text", "image", "assemble", "meta"]).optional().describe("Narrow to one family; omit for the whole catalog"),
  },
    handler: async (a) => safe(() => listOperations({ family: a.family ?? null })),
  },


  {
    name: "describe_operation",
    tier: "READ",
    description: "Full detail for ONE tool by name: family, safety tier, the complete description and the full JSON input schema — the second half of progressive discovery (KyaniteLabs/kinocut's describe_operation idea). Call list_operations first to find the name, then this for the schema of only the tool you are about to call. Unknown names fail with INVALID_ARG and a hint to browse list_operations.",
    schema: {
    name: z.string().min(1).describe("Tool name, e.g. trim (see list_operations for the catalog)"),
  },
    handler: async (a) => safe(() => describeOperation({ name: a.name })),
  },
];

// ---------------------------------------------------------------- safety tiers
// One source of truth for the tier of every tool: the `tier` field on
// each TOOL_DEFS entry. The MCP annotations are the standard coarse
// mapping of that tier (readOnlyHint / destructiveHint /
// idempotentHint / openWorldHint); `download` is the only tool that
// touches the network, so it alone gets openWorldHint: true.
export const SAFETY_TIERS = ["READ", "PLAN", "WRITE", "DESTRUCTIVE"];

export const TIER_ANNOTATIONS = {
  READ: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  PLAN: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  WRITE: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  DESTRUCTIVE: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

export function toolAnnotations(tool) {
  const a = { ...TIER_ANNOTATIONS[tool.tier ?? "WRITE"] };
  if (tool.name === "download") a.openWorldHint = true;
  return a;
}

const TIER_DESCRIPTIONS = {
  READ: "Probe-only: reads media and returns measurements, writes nothing.",
  PLAN: "Answers a question by transient work (a draft render, sample encodes, a job lookup) and leaves no artifact behind.",
  WRITE: "Produces a file the caller asked for; never overwrites its own input (prepareOutput refuses that).",
  DESTRUCTIVE: "Replaces or removes a user artifact in place — needs a human-checked guard (patch_manifest: expected_revision + .bak backup).",
};

export function listSafetyTiers() {
  const tiers = {};
  for (const tier of SAFETY_TIERS) tiers[tier] = { description: TIER_DESCRIPTIONS[tier], tools: [] };
  for (const tool of TOOL_DEFS) {
    if (!tiers[tool.tier]) throw new Error(`tool "${tool.name}" has unknown tier "${tool.tier}"`);
    tiers[tool.tier].tools.push(tool.name);
  }
  const counts = Object.fromEntries(SAFETY_TIERS.map((t) => [t, tiers[t].tools.length]));
  return {
    tiers,
    counts,
    total_tools: TOOL_DEFS.length,
    rules: [
      "READ tools never write a file, including temp files outside the OS temp dir.",
      "PLAN tools may render to a temp or hidden work dir, but remove it afterwards; they leave no artifact the caller asked for.",
      "WRITE tools write exactly the output the caller named, and refuse to overwrite their own input file.",
      "DESTRUCTIVE tools replace a user artifact in place and must carry a human-checked guard (revision, backup, or explicit confirm).",
      "A tool's tier is a property of the tool, not its arguments: a WRITE tool with dry_run=true still reports WRITE.",
    ],
  };
}

// ---------------------------------------------------------------- progressive discovery
// The catalog is 89 tools and tools/list dumps the full JSON schema
// of every one on every turn — kinocut's answer is progressive
// discovery: a compact list first, full schema only for the tools
// actually used (lượt 147, idea: KyaniteLabs/kinocut
// list_operations / describe_operation, KINOCUT_TOOLS profiles).
// Families group the catalog by job, not by ship order; the map
// below must cover every TOOL_DEFS entry exactly once (asserted in
// test/mcp-test.mjs — a tool without a family breaks the discovery
// list instead of silently landing in "other").
// MEDIAKIT_TOOL_PROFILE=hot makes tools/list (both transports)
// return only the 18 hot-path tools + the two discovery tools
// (20 total); default "full" keeps today's behaviour — every tool
// listed, so existing clients never lose a tool they already call.
// list_operations always reports the FULL catalog either way: its
// job is to find the tools the hot list hides.
export const TOOL_FAMILY_DESCRIPTIONS = {
  inspect: "Measure a file and answer a question — probe, QC, tempo, hooks, chapters.",
  edit: "Change one clip: cut, transform, grade, mix or convert it.",
  text: "Words on screen and in audio: captions, titles, transcription.",
  image: "Stills and frame sequences: sample, export or build from images.",
  assemble: "Director workflow: film, manifest, jobs and release.",
  meta: "The catalog itself: browse and describe tools.",
};

export const TOOL_FAMILY_OF = {
  // inspect (27)
  probe: "inspect", check: "inspect", cropdetect: "inspect", scenes: "inspect",
  keyframes: "inspect", audio_levels: "inspect", motion: "inspect", bpm: "inspect",
  beat_grid: "inspect", tempo_drift: "inspect", hook: "inspect", highlights: "inspect",
  chapters: "inspect", measure_pace: "inspect", search_words: "inspect", find: "inspect",
  determinism: "inspect", verify: "inspect", verify_cuts: "inspect", diagnose: "inspect",
  transitions: "inspect", estimate_conversion: "inspect", doctor: "inspect",
  qa_report: "inspect", audit: "inspect", safety: "inspect", receipt: "inspect",
  // edit (36)
  trim: "edit", crop: "edit", resize: "edit", extract_audio: "edit", extract_frame: "edit",
  loudness: "edit", concat: "edit", grade: "edit", make_loopable: "edit", freeze: "edit",
  fastforward: "edit", reverse: "edit", rotate: "edit", boomerang: "edit",
  chroma_key: "edit", zoom_pan: "edit", interpolate: "edit", denoise: "edit",
  segment: "edit", convert: "edit", normalize: "edit", compress: "edit", silence: "edit",
  cut_words: "edit", remove_retakes: "edit", smart_cut: "edit", clean_voice: "edit",
  mix: "edit", overlay: "edit", pip: "edit", broll: "edit", fit: "edit",
  reframe: "edit", mux: "edit", burn_captions: "edit", download: "edit",
  // text (6)
  transcribe: "text", convert_captions: "text", generate_srt: "text",
  titlecard: "text", intro: "text", align_voice: "text",
  // image (7)
  thumbnail: "image", frames: "image", extract_frames: "image", image_to_video: "image",
  slideshow: "image", export_gif: "image", svg_animate: "image",
  // assemble (11)
  assemble: "assemble", manifest: "assemble", patch_manifest: "assemble",
  init_project: "assemble", export_timeline: "assemble", job: "assemble",
  release_checkpoint: "assemble", package: "assemble", publish_kit: "assemble",
  social: "assemble", batch: "assemble",
  // meta (2)
  list_operations: "meta", describe_operation: "meta",
};

// The 18 tools a director reaches for first (kinocut's hot-path
// idea, 8 hot + 8 family → MediaKit's 18 + 2 discovery = 20 in hot
// mode): probe the source, check the gate, cut, join, assemble the
// film, mix the sound, transcribe the words, find the hook.
export const HOT_TOOLS = [
  "probe", "check", "trim", "concat", "assemble", "manifest",
  "loudness", "mix", "transcribe", "hook", "frames", "thumbnail",
  "download", "convert", "diagnose", "verify", "init_project",
  "release_checkpoint",
];

export function toolProfile() {
  const p = (process.env.MEDIAKIT_TOOL_PROFILE ?? "full").trim().toLowerCase();
  return p === "hot" ? "hot" : "full";
}

export function visibleTools() {
  if (toolProfile() === "full") return TOOL_DEFS;
  const hot = new Set([...HOT_TOOLS, "list_operations", "describe_operation"]);
  return TOOL_DEFS.filter((t) => hot.has(t.name));
}

export function toolSummary(tool) {
  // First sentence of the description — split on ". " but rejoin
  // across "e.g." / "i.e." / "etc." / "vs." (they end with a period
  // but are not sentence ends; "Reframe ... (e.g. 16:9 ...)" must
  // not summarise as "... (e.g."). A first sentence over 160 chars
  // is cut at a word boundary with an ellipsis, so a summary stays
  // one line in the compact catalog.
  const parts = tool.description.split(". ");
  let first = parts[0] ?? "";
  for (let i = 1; i < parts.length && /(e\.g|i\.e|etc|vs)$/i.test(first); i++) {
    first += `. ${parts[i]}`;
  }
  if (!first.endsWith(".")) first += ".";
  if (first.length > 160) {
    const cut = first.lastIndexOf(" ", 160);
    first = `${first.slice(0, cut > 40 ? cut : 160)}…`;
  }
  return first;
}

export function listOperations({ family = null } = {}) {
  if (family !== null && family !== undefined && !TOOL_FAMILY_DESCRIPTIONS[family]) {
    throw new core.MediaKitError(`unknown family "${family}" (families: ${Object.keys(TOOL_FAMILY_DESCRIPTIONS).join(", ")})`, "INVALID_ARG");
  }
  const tools = TOOL_DEFS
    .filter((t) => family == null || TOOL_FAMILY_OF[t.name] === family)
    .map((t) => ({ name: t.name, family: TOOL_FAMILY_OF[t.name], tier: t.tier, summary: toolSummary(t) }));
  return {
    profile: toolProfile(),
    total_tools: TOOL_DEFS.length,
    visible_tools: visibleTools().length,
    families: Object.entries(TOOL_FAMILY_DESCRIPTIONS).map(([name, description]) => ({
      name, description, count: TOOL_DEFS.filter((t) => TOOL_FAMILY_OF[t.name] === name).length,
    })),
    tools,
  };
}

export function describeOperation({ name }) {
  const tool = TOOL_DEFS.find((t) => t.name === name);
  if (!tool) {
    throw new core.MediaKitError(`unknown operation "${name}" — use list_operations to browse the catalog`, "INVALID_ARG");
  }
  return {
    name: tool.name,
    family: TOOL_FAMILY_OF[tool.name],
    tier: tool.tier,
    description: tool.description,
    inputSchema: zodToJsonSchema(z.object(tool.schema), { target: "jsonSchema7" }),
  };
}
