#!/usr/bin/env node
/**
 * mediakit — CLI front-end for the ffmpeg core.
 * Usage: mediakit <command> [args] [options]
 *        mediakit mcp            start the MCP server on stdio
 *        mediakit mcp --http     same tools over HTTP (REST + JSON-RPC)
 */
import * as core from "../src/core.js";
import { queryAudit, recordToolCall } from "../src/audit.js";
import { listSafetyTiers } from "../src/tools.js";

const VERSION = "0.1.0";

const COMMANDS = {
  probe: {
    usage: "mediakit probe <input>",
    desc: "Inspect a media file (duration, dimensions, codecs, streams).",
    args: [{ name: "input", required: true }],
    options: [],
  },
  trim: {
    usage: "mediakit trim <input> --start <s|MM:SS> (--duration <s|MM:SS> | --end <s|MM:SS>) -o <output> [--stream-copy] [--snap] [--snap-beat [--snap-beat-method grid|dp]] [--smart-cut] [--edge-buffer 0.1] [--no-check-frames] [--dry-run]",
    desc: "Cut a clip. Re-encodes by default (frame-accurate); --stream-copy is fast but keyframe-only. --snap (with --stream-copy) moves start/end onto the nearest keyframes. --snap-beat moves start/end onto the nearest beats of the music instead (start down, end up; refuses --snap and --smart-cut, and refuses when the measured beat grid is unreliable — see beat_grid). --snap-beat-method dp snaps to the DP tracker's beats, which follow real onsets when the tempo drifts; grid (default) snaps to the one-tempo grid. --smart-cut (with --stream-copy) keeps the exact start: only the head up to the next keyframe is re-encoded, the rest is copied. --edge-buffer (0-1s, default 0) widens the requested window by that much on both sides, clamped to the file edges — Outtake's 0.1s clip-edge buffer, so a cut never lands exactly on a word or action onset; composes with --snap/--snap-beat (buffer first, then snap) and refuses --smart-cut. Every video trim verifies the cut by default: 3 output frames (head/middle/tail) are compared against the source at the requested times and the result reports cut_verified plus mean_abs_diff per frame; --no-check-frames skips the verification (audio-only inputs have nothing to check). --dry-run prints the exact ffmpeg command(s) that would run (three for --smart-cut) and writes no file. Times accept seconds or MM:SS.",
    args: [{ name: "input", required: true }],
    options: [
      ["--start", "Start time in seconds or MM:SS (default 0)"],
      ["--duration", "Clip length in seconds or MM:SS"],
      ["--end", "End time in seconds or MM:SS (alternative to --duration)"],
      ["--stream-copy", "Copy streams without re-encoding"],
      ["--snap", "Snap start/end to the nearest keyframes (needs --stream-copy)"],
      ["--snap-beat", "Snap start/end to the nearest beats of the music (start down, end up; refuses --snap and --smart-cut)"],
      ["--snap-beat-method", "Which beat grid --snap-beat snaps to: grid (default, one steady tempo) or dp (DP tracker, follows real onsets when the tempo drifts)"],
      ["--smart-cut", "Exact start with stream copy: re-encode only the head up to the next keyframe (needs --stream-copy, refuses --snap)"],
      ["--edge-buffer", "Seconds of handle kept past each edge of the requested window (0-1, default 0) — widens the cut, clamped to the file edges; composes with --snap/--snap-beat, refuses --smart-cut"],
      ["--no-check-frames", "Skip the 3-frame cut verification"],
      ["--dry-run", "Print the exact ffmpeg command(s) and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  fit: {
    usage: "mediakit fit <input> --duration <s|MM:SS> -o <output> [--method speed|trim|loop] [--max-fps <n>] [--dry-run]",
    desc: "Fit a file to an exact target duration. speed (default) speeds it up/down (factor 0.25-4x); trim cuts a longer source; loop repeats a shorter source. --max-fps caps the output frame rate (only ever lowers it). Times accept seconds or MM:SS. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--duration", "Target duration in seconds or MM:SS (required)"],
      ["--method", "speed (default) | trim | loop"],
      ["--max-fps", "Cap the output frame rate, 1-120 (only lowers fps, never raises it)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  crop: {
    usage: "mediakit crop <input> --width <px> --height <px> [--x <px>] [--y <px>] -o <output> [--dry-run]",
    desc: "Crop a video to a rectangle. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Crop width in pixels (required)"],
      ["--height", "Crop height in pixels (required)"],
      ["--x", "Left offset (default 0)"],
      ["--y", "Top offset (default 0)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  resize: {
    usage: "mediakit resize <input> [--width <px>] [--height <px>] [--preset 360p|480p|720p|1080p|2160p] [--no-keep-aspect] -o <output> [--dry-run]",
    desc: "Resize a video. With --keep-aspect (default) the missing dimension follows the aspect ratio. --preset fits the frame inside a named box (e.g. 720p = 1280x720) and never upscales; it cannot be combined with --width/--height. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Target width in pixels"],
      ["--height", "Target height in pixels"],
      ["--preset", "Named preset: 360p (640x360), 480p (854x480), 720p (1280x720), 1080p (1920x1080), 2160p (3840x2160)"],
      ["--no-keep-aspect", "Stretch to exact dimensions (needs both --width and --height)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "extract-audio": {
    usage: "mediakit extract-audio <input> -o <output.mp3|aac|wav|ogg|opus|flac> [--format <fmt>] [--whisper] [--channel <n>] [--dry-run]",
    desc: "Extract the audio track. --whisper forces the Whisper ASR preset (16 kHz mono WAV) and renames the output to .wav when needed. --channel <n> (0-based) picks one channel out of a multi-channel input and returns it as mono. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--format", "Audio format (overrides output extension; ignored with --whisper)"],
      ["--whisper", "Whisper preset: 16 kHz mono WAV, the direct input for transcription"],
      ["--channel", "Channel index (0-based) to extract as mono from a multi-channel input"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "extract-frame": {
    usage: "mediakit extract-frame <input> --timestamp <s> -o <output.png|jpg|webp>",
    desc: "Grab a single frame at a timestamp.",
    args: [{ name: "input", required: true }],
    options: [
      ["--timestamp", "Timestamp in seconds (default 0)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  thumbnail: {
    usage: "mediakit thumbnail <input> -o <output.png|jpg> [--frames <n>] [--columns <n>] [--width <px>] [--no-timestamps] [--header] [--start-delay-percent <n>] [--end-delay-percent <n>] [--timestamps-list <s,s,...>] [--sharpest] [--sharpest-samples <n>]",
    desc: "Build a contact sheet of N evenly spaced frames. Each tile is captured at its exact timestamp and labelled with it by default — look at it before cutting or publishing. --start-delay-percent / --end-delay-percent skip the first/last slice of the file (intros, credits) before spacing the tiles. --header adds a metadata band on top (filename, duration, resolution, fps, codecs, size, grid). --timestamps-list names every tile time explicitly (seconds or MM:SS, comma-separated; sets the tile count, cannot combine with the delay percents). --sharpest picks the sharpest frame in each tile's window instead of the window start (Laplacian mean, measured on disk).",
    args: [{ name: "input", required: true }],
    options: [
      ["--frames", "Number of frames (default 6)"],
      ["--columns", "Grid columns (default 3)"],
      ["--width", "Width of each tile in pixels (default 320)"],
      ["--no-timestamps", "Do not label tiles with timestamps"],
      ["--header", "Add a metadata band on top: filename, duration, resolution, fps, codecs, size, grid"],
      ["--start-delay-percent", "Skip this percent at the start before spacing tiles (default 0)"],
      ["--end-delay-percent", "Skip this percent at the end before spacing tiles (default 0)"],
      ["--timestamps-list", "Explicit tile times, comma-separated seconds or MM:SS (e.g. 1,6,0:30); sets the tile count"],
      ["--sharpest", "Pick the sharpest frame in each tile's window instead of the window start"],
      ["--sharpest-samples", "Candidate frames sampled per window when --sharpest (default 5, 2-16)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  loudness: {
    usage: "mediakit loudness <input> -o <output> [--target-lufs <n>] [--format <fmt>] [--compressor] [--compressor-threshold <dB>] [--compressor-ratio <n>] [--dry-run]",
    desc: "Normalize loudness (default -14 LUFS, YouTube/Spotify standard). --compressor runs a gentle compressor (threshold -24 dB, ratio 4) before the loudnorm pass, for quiet high-crest speech. --dry-run prints the exact ffmpeg command(s) that would run and writes no file (with --compressor the loudnorm measured_* values come from the uncompressed input — the real run re-measures the compressed temp first).",
    args: [{ name: "input", required: true }],
    options: [
      ["--target-lufs", "Target loudness in LUFS (default -14)"],
      ["--format", "Audio format (overrides output extension)"],
      ["--compressor", "Compress before normalizing (threshold -24 dB, ratio 4)"],
      ["--compressor-threshold", "Compressor threshold in dB (default -24, only with --compressor)"],
      ["--compressor-ratio", "Compressor ratio (default 4, only with --compressor)"],
      ["--dry-run", "Print the exact ffmpeg command(s) and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  concat: {
    usage: "mediakit concat <input1> <input2> [input3...] -o <output> [--video-codec <c>] [--audio-codec <c>] [--transition fade|wipeleft|dissolve|...] [--transition-duration <s>] [--fast] [--no-fast] [--dry-run]",
    desc: "Join 2+ media files into one. Auto-detects: identical clips are stream-copied (fast, lossless), differing clips are re-encoded. --fast requires identical clips (errors otherwise), --no-fast always re-encodes. --transition crossfades between clips instead of a hard cut. Per-clip trim: write an input as path@start-end (seconds or MM:SS, either side may be empty) — trims always re-encode, and --fast refuses them. --dry-run prints the exact ffmpeg command and writes no file (demuxer path: also prints the list-file path + content — write the content there first, then run the command as-is).",
    args: [{ name: "inputs", required: true, variadic: true }],
    options: [
      ["--video-codec", "Video codec (default libx264)"],
      ["--audio-codec", "Audio codec (default aac)"],
      ["--transition", "xfade transition between clips: fade, wipeleft, dissolve, circlecrop, ..."],
      ["--transition-duration", "Transition length in seconds (default 1, must be shorter than the shortest clip)"],
      ["--fast", "Require stream-copy: error if the clips differ (default is auto-detect)"],
      ["--no-fast", "Always re-encode, never stream-copy"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  frames: {
    usage: "mediakit frames <input> -o <directory> [--count <n>] [--format png|jpg|webp] [--width <px>] [--sharpest] [--sharpest-samples <n>]",
    desc: "Extract N evenly spaced frames as separate images (frame-001.png, ...) so you can look at a video before cutting it. --sharpest picks the sharpest frame in each interval instead of the interval start (Laplacian mean, measured on disk; each entry reports its sharpness and window).",
    args: [{ name: "input", required: true }],
    options: [
      ["--count", "Number of frames (default 6)"],
      ["--format", "Image format png (default) | jpg | webp"],
      ["--width", "Scale frames to this width (keeps aspect)"],
      ["--sharpest", "Pick the sharpest frame in each interval instead of the interval start"],
      ["--sharpest-samples", "Candidate frames sampled per interval when --sharpest (default 5, 2-16)"],
      ["-o, --output", "Output directory (required, created if needed)"],
    ],
  },
  "extract-frames": {
    usage: "mediakit extract-frames <input> -o <directory> [--format png|jpg|webp] [--fps <n>] [--start <s|MM:SS>] [--end <s|MM:SS>] [--width <px>] [--quality <n>] [--dedup <0-10>] [--dry-run]",
    desc: "Export EVERY frame of a clip (or a time range) as a sequence of images (frame-0001.png, ...) into a directory — the full sequence, not N samples like frames. fps defaults to the source frame rate (every frame); set it lower for a sparser sequence. Frame i lands at start + i/fps, and the count is verified on disk against round((end-start) * fps). PNG is written rgba (keeps alpha). Refuses over 5000 frames — lower fps or shorten the range. --dedup <0-10> drops near-duplicate frames after extraction (16x16 gray thumbs; 2.0 is reel-relay's summary default but collapses slow motion, 0.5-1 only drops frozen frames). --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--format", "Image format png (default) | jpg | webp"],
      ["--fps", "Frames per second to extract (default: source frame rate, i.e. every frame)"],
      ["--start", "Range start in seconds or MM:SS (default 0)"],
      ["--end", "Range end in seconds or MM:SS (default end of file)"],
      ["--width", "Scale frames to this width (keeps aspect)"],
      ["--quality", "jpg/webp quality 1-100 (default jpg q 2, webp libwebp 75); refused for png"],
      ["--dedup", "Drop near-duplicate frames after extraction: mean abs diff on 16x16 gray thumbs, 0-10 (2.0 = reel-relay summary default, collapses slow motion; 0.5-1 only drops frozen frames)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output directory (required, created if needed)"],
    ],
  },
  "export-gif": {
    usage: "mediakit export-gif <input> -o <output.gif> [--start <s|MM:SS>] [--end <s|MM:SS>] [--fps 15] [--width 640] [--max-size-mb 10] [--dry-run]",
    desc: "Export a clip (or segment) as an animated GIF with a two-pass palette. Fits under --max-size-mb (default 10 MB, the GitHub README limit; Slack auto-plays only under ~2 MB) by stepping down fps, then width, then palette colours; reports size_budget_met measured on disk. --dry-run prints the first ladder step's command and writes no file (the ladder plan is listed; later steps only run when the budget needs them).",
    args: [{ name: "input", required: true }],
    options: [
      ["--start", "Segment start in seconds or MM:SS (default 0)"],
      ["--end", "Segment end in seconds or MM:SS (default end of file)"],
      ["--fps", "Frames per second (default 15)"],
      ["--width", "GIF width in pixels (default 640)"],
      ["--max-size-mb", "Size budget in decimal MB (default 10)"],
      ["--dry-run", "Print the first ladder step's command and write no file"],
      ["-o, --output", "Output .gif file (required)"],
    ],
  },
  "burn-captions": {
    usage: "mediakit burn-captions <input> --captions <file.srt|ass|vtt> -o <output> [--font-size <n>] [--margin-v <n>] [--style background|outline|shadow|glow] [--outline-color <name|hex>] [--max-lines <n>] [--platform tiktok|reels|shorts|youtube|instagram-feed|instagram-story|linkedin] [--dry-run]  |  mediakit burn-captions <input> --words-file <words.json> -o <output> [...]",
    desc: "Burn subtitles into the video (hardcoded, always visible). --words-file chunks word timings first with the locked TikTok defaults (max 6 words/cue) into a temp .srt, burns it, and removes the temp file. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--captions", "Subtitle file .srt/.ass/.vtt (required unless --words-file)"],
      ["--words-file", "Transcript JSON with a words array (alternative to --captions): chunked with the TikTok defaults into a temp .srt first"],
      ["--font-size", "Font size in px (default: scales with frame height, ~60px at 1920 high)"],
      ["--margin-v", "Distance from bottom edge in px (default: 26% of frame height, above platform UI; or the platform's bottom UI depth with --platform)"],
      ["--style", "Caption style: background (default, white text on a semi-transparent black box) | outline | shadow | glow (halo in the text colour). Ignored for .ass files, which carry their own styles"],
      ["--outline-color", "Outline colour for outline/shadow styles: name or RRGGBB hex (default black)"],
      ["--max-lines", "Fit-to-width: shrink the font until every cue wraps to at most N lines (1-4), never below the readability floor (~31px at 1920 high). Ignored for .ass files"],
      ["--platform", "Destination platform: default margin becomes that platform's bottom UI depth, and the fit width narrows to its text-safe rect. Explicit --margin-v wins"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  reframe: {
    usage: "mediakit reframe <input> -o <output> [--width 1080] [--height 1920] [--mode crop|pad|blur] [--x <px>] [--y <px>] [--anchor <name>] [--blur <n>] [--dry-run]",
    desc: "Reframe to a target aspect/size in one step (e.g. 16:9 -> 9:16 vertical). --dry-run prints the exact ffmpeg command and writes no file (crop/kept-percent are computed from the input geometry, so they are exact).",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Target width in pixels (default 1080, must be even)"],
      ["--height", "Target height in pixels (default 1920, must be even)"],
      ["--mode", "crop (default) | pad (black bars) | blur (blurred fill)"],
      ["--x", "Crop anchor: left offset (crop mode only)"],
      ["--y", "Crop anchor: top offset (crop mode only)"],
      ["--anchor", "Named crop anchor: center | left | right | top | bottom | top-left | top-right | bottom-left | bottom-right (crop mode only; explicit --x/--y win)"],
      ["--blur", "Blur strength for blur mode (default 20)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  titlecard: {
    usage: "mediakit titlecard \"<hook text>\" -o <output.png> [--width 1080] [--height 1920] [--font-size <n>] [--text-color <hex>] [--box-color <hex>] [--style clean-bold|minimal-line|warm-story] [--brand amber-teal|warm-story|minimal-line] [--dry-run]",
    desc: "Render a title card PNG: big bold hook on a coloured box, transparent background (overlay it with the overlay tool). --style picks a named locked palette from skills/shorts-video/styles.json; --brand paints it in the channel look (primary = box, on_primary = text) from skills/shorts-video/brands.json; an explicit colour/font overrides just that one locked value. Resolution: explicit > brand > style > default. --dry-run prints the exact ffmpeg command and writes no output file (the drawtext text file is written next to the output and kept, so the printed command runs as-is).",
    args: [{ name: "text", required: true }],
    options: [
      ["--width", "Canvas width in pixels (default 1080, must be even)"],
      ["--height", "Canvas height in pixels (default 1920, must be even)"],
      ["--font-size", "Font size in px (default: ~120px at 1080 wide; with --style, the style's locked size)"],
      ["--text-color", "Text color name or hex (default FFD60A yellow; with --style, the style's locked text color; with --brand, the brand's on_primary)"],
      ["--box-color", "Box color name or hex (default F97316 orange; with --style, the style's locked box color; with --brand, the brand's primary)"],
      ["--style", "Named style id: clean-bold | minimal-line | warm-story (locked palette from skills/shorts-video/styles.json)"],
      ["--brand", "Brand id: amber-teal | warm-story | minimal-line (palette from skills/shorts-video/brands.json; same registry as assemble)"],
      ["--dry-run", "Print the exact ffmpeg command and write no output file"],
      ["-o, --output", "Output PNG file (required)"],
    ],
  },
  intro: {
    usage: "mediakit intro \"<title>\" -o <output.mp4> [--width 1280] [--height 720] [--duration 3] [--bg-color 0F172A] [--text-color FFFFFF] [--font-size <n>] [--fade-in 0.5] [--fade-out 0.5] [--style clean-bold|minimal-line|warm-story] [--brand amber-teal|warm-story|minimal-line] [--dry-run]",
    desc: "Render a short intro clip: a title on a solid-colour background, fading in and out (silent video). --style picks a named locked palette (box colour becomes the background); --brand paints it in the channel look (background = background, text = text); an explicit colour/font overrides just that one locked value. Resolution: explicit > brand > style > default. --dry-run prints the exact ffmpeg command and writes no output file (the drawtext text file is written next to the output and kept, so the printed command runs as-is).",
    args: [{ name: "text", required: true }],
    options: [
      ["--width", "Canvas width in pixels (default 1280, must be even)"],
      ["--height", "Canvas height in pixels (default 720, must be even)"],
      ["--duration", "Clip length in seconds (default 3)"],
      ["--bg-color", "Background color name or hex (default 0F172A dark navy; with --style, the style's locked box color; with --brand, the brand's background)"],
      ["--text-color", "Text color name or hex (default FFFFFF white; with --style, the style's locked text color; with --brand, the brand's text)"],
      ["--font-size", "Font size in px (default: ~100px at 1280 wide; with --style, the style's locked size)"],
      ["--fade-in", "Text fade-in in seconds (default 0.5, 0 = none)"],
      ["--fade-out", "Text fade-out in seconds (default 0.5, 0 = none)"],
      ["--style", "Named style id: clean-bold | minimal-line | warm-story (locked palette from skills/shorts-video/styles.json)"],
      ["--brand", "Brand id: amber-teal | warm-story | minimal-line (palette from skills/shorts-video/brands.json; same registry as assemble)"],
      ["--dry-run", "Print the exact ffmpeg command and write no output file"],
      ["-o, --output", "Output MP4 file (required)"],
    ],
  },
  social: {
    usage: "mediakit social <input> -o <output-dir> [--platforms tiktok,reels,shorts] [--strategy blur] [--target-lufs -14] [--no-trim-to-max]",
    desc: "Export one video to several platform specs in one call (reframe + trim to max duration + loudness + check each), writing <base>-<platform>.mp4 + manifest.json.",
    args: [{ name: "input", required: true }],
    options: [
      ["--platforms", "Comma-separated platforms (default tiktok,reels,shorts): tiktok | reels | shorts | instagram-feed | instagram-story | linkedin | youtube"],
      ["--strategy", "blur (default) | crop | pad — how to fit the frame into each platform size"],
      ["--target-lufs", "Normalize audio to this LUFS (default -14)"],
      ["--no-trim-to-max", "Keep full length even past the platform max duration (check will then fail duration)"],
      ["-o, --output", "Output directory (required, created if needed)"],
    ],
  },
  check: {
    usage: "mediakit check <input> [--platform tiktok|reels|shorts|youtube|instagram-feed|instagram-story|linkedin] [--expected-duration <s|MM:SS>] [--content] [--start <s|MM:SS>] [--end <s|MM:SS>] [--peak-threshold <dB>] [--baseline <file.json>] [--faststart] [--decoded-work] [--palette \"#hex,#hex,#hex\"] [--palette-brand amber-teal|warm-story|minimal-line] [--policy skip|light|full] [--stamp] [--use-stamp]",
    desc: "Verify a file against a platform delivery spec (dimensions, codecs, duration, loudness). --expected-duration fails when the measured duration is more than 0.5s off the brief. --content also scans for black/frozen frames, silence and audio peaks; --start/--end scan only that time range. --baseline <file.json> (needs --content) forgives spans already in the source: a previous check --content result (or a plain {black,freeze,silence,peaks} span list) — spans it covers are reported as pre-existing and do not fail the gate, so only NEW spans fail. --decoded-work also estimates the decode load and warns when it is over the ceiling. Video and audio stream durations must agree within ±0.2s (audio_sync, always checked when both durations are measurable). --palette (2-6 hex colors) or --palette-brand measures frames at 2 fps against a locked look: per-color shares, off-palette share, mean luma, crushed/blown share, luma swing — crushed or blown past 2% fails. --policy sets the QC tier (idea: OpenEdit qc/policy.py): full (default) runs every requested detector; light runs probe-based rules only and refuses --content/--baseline/--palette (decode-heavy detectors are skipped, reported in `skipped` with complete:false — a light pass is not a full verification); skip runs nothing at all (no probe, no decode) and returns pass:true, complete:false with the skipped list. Env MEDIAKIT_QC_POLICY is the default when --policy is absent. --stamp writes a QC stamp sidecar <input>.mediakit-check.json (the verdict + the exact args + the media sha256/size + the ffmpeg/ffprobe versions, written atomically); --use-stamp reuses it instead of re-running the check when the media, the args and the toolchain all still match, and reports stamp.used=false with the stale reason (no_stamp/media_changed/args_mismatch/environment_mismatch/stamp_invalid) when they do not — a stamp never overrides a fresh run. --stamp/--use-stamp are refused under --policy skip (a skip measures nothing, so there is nothing to stamp or reuse).",
    args: [{ name: "input", required: true }],
    options: [
      ["--platform", "Delivery platform (default tiktok)"],
      ["--expected-duration", "Expected duration, seconds or MM:SS (fail when measured duration is more than 0.5s off)"],
      ["--content", "Also scan content: black/frozen frames, silence and audio peaks (one decode pass)"],
      ["--start", "Scan only from this time, seconds or MM:SS (needs --content)"],
      ["--end", "Scan only up to this time, seconds or MM:SS (needs --content)"],
      ["--peak-threshold", "Audio peak threshold in dBFS for the peaks rule (default -1; >= 0 dBFS is clipping; needs --content)"],
      ["--baseline", "Baseline JSON (a previous check --content result, or a plain {black,freeze,silence,peaks} span list): spans it covers are pre-existing and do not fail the gate — only NEW spans fail (needs --content)"],
      ["--faststart", "Also check MP4 faststart (moov before mdat) — fails when the file is not an MP4 or its moov box comes after mdat"],
      ["--decoded-work", "Also estimate the decoded work (video pixel-frames + audio sample-channels) and warn when it is over the ceiling (250B pixel-frames / 6B sample-channels, plus 3600s, 8192px, 120fps, 8ch, 192kHz)"],
      ["--palette", "Locked look as 2-6 comma-separated hex colors, e.g. \"#DCC0A0,#A02D19,#1B2740\" (mutually exclusive with --palette-brand)"],
      ["--palette-brand", "Locked look as a brand id: amber-teal | warm-story | minimal-line (same registry as assemble; mutually exclusive with --palette)"],
      ["--policy", "QC policy tier: full (default, every requested detector runs), light (probe-based rules only — refuses --content/--baseline/--palette, reports skipped + complete:false), skip (no probe or decode — pass:true, complete:false, skipped list; env MEDIAKIT_QC_POLICY is the default when --policy is absent)"],
      ["--stamp", "Write a QC stamp sidecar <input>.mediakit-check.json (the verdict + the exact args + the media sha256/size + the ffmpeg/ffprobe versions, written atomically)"],
      ["--use-stamp", "Reuse the QC stamp instead of re-running the check when the media, the args and the toolchain all still match; reports stamp.used=false with the stale reason (no_stamp/media_changed/args_mismatch/environment_mismatch/stamp_invalid) when they do not — a stamp never overrides a fresh run; refused under --policy skip"],
    ],
  },
  "qa-report": {
    usage: "mediakit qa-report <input> [--target tiktok|reels|shorts|youtube|instagram-feed|instagram-story|linkedin|any] [--expected-duration <s|MM:SS>]",
    desc: "One-call delivery gate for a finished file: even dimensions, pixel format, frame rate, aspect and length for the target, measured loudness and true peak, black/frozen frames, dead air, pacing from real scene cuts, and an optional expected duration. Probe-only — writes no file. Verdict pass/warn/fail plus a per-check list.",
    args: [{ name: "input", required: true }],
    options: [
      ["--target", "Delivery target (default any — skips aspect ratio and platform length)"],
      ["--expected-duration", "Expected duration, seconds or MM:SS (fail when measured duration is more than 0.5s off)"],
    ],
  },
  grade: {
    usage: "mediakit grade <input> -o <output> [--preset warm|cool|cinematic|noir|vintage] [--filter <vf-chain>] [--cdl-slope 1.2,1,0.8 --cdl-offset 0,0,0 --cdl-power 1,1,1 --cdl-saturation 1] [--crf 23] [--dry-run]",
    desc: "Color-grade a video with a named preset, one custom filter chain, or an ASC CDL (--cdl-slope/--cdl-offset/--cdl-power as r,g,b triples + --cdl-saturation; any one of them selects CDL mode, mutually exclusive with --preset/--filter). Reports the mean R/G/B before and after, measured on the middle frame. --dry-run prints the exact ffmpeg command and writes no file (color_before is still measured on the input; color_after reports null).",
    args: [{ name: "input", required: true }],
    options: [
      ["--preset", "warm (default) | cool | cinematic | noir | vintage — fixed filter chains"],
      ["--filter", "One custom video filter chain, e.g. 'eq=saturation=0.5' (mutually exclusive with --preset)"],
      ["--cdl-slope", "ASC CDL slope as r,g,b (0-4, e.g. 1.2,1,0.8); any --cdl-* option selects CDL mode"],
      ["--cdl-offset", "ASC CDL offset as r,g,b (-1 to 1, e.g. 0.02,0,0)"],
      ["--cdl-power", "ASC CDL power (gamma) as r,g,b (0.1-4, e.g. 1,1,1.1)"],
      ["--cdl-saturation", "ASC CDL saturation (0-4, 0 = grayscale, 1 = unchanged)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "make-loopable": {
    usage: "mediakit make-loopable <input> -o <output> [--overlap 0.5] [--crf 23] [--dry-run]",
    desc: "Make a clip loop seamlessly: crossfade the tail into the head, so the end flows back into the start with no jump or audio click. Output is the overlap shorter (10s + 0.5s overlap = 9.5s). Reports seam_before vs seam_after (mean abs gray difference between last and first frames) plus normal_step as the baseline. Works on audio-only input too. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--overlap", "Crossfade length in seconds (default 0.5; 0.3-0.5s for slow motion, 1s for very different start/end poses; must be under half the clip)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  freeze: {
    usage: "mediakit freeze <input> -o <output> [--at 5] [--hold 2] [--crf 23] [--dry-run]",
    desc: "Hold one frame still for N seconds: insert a frozen-frame segment at time --at (default the end of the clip — hold the last frame). The clip grows by exactly the hold and the tail keeps its place; audio in the hold is silence. Reports frozen_frame_diff (input frame vs output frame mid-hold, ~0 when truly frozen) and post_frame_diff (tail kept its place). --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--at", "Time to freeze, seconds or MM:SS (default: end of clip, hold the last frame)"],
      ["--hold", "Hold length in seconds (default 2; 0.1-30)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  fastforward: {
    usage: "mediakit fastforward <input> -o <output> --span 5-9@4 [--span ...] [--no-badge] [--label ...] [--crf 23] [--dry-run]",
    desc: "Speed up or slow down marked spans of a clip and burn a badge on them: --span <start>-<end>@<speed> is repeatable (max 16), times in seconds or MM:SS, speed 0.25-16 (below 1 slows down, 1 is refused as a no-op). The output is shorter (or longer, for slow spans) by exactly the saved time and everything after a span keeps its place; audio keeps its pitch (chained atempo). Spans are clamped to the clip and overlaps collapse onto the previous span's end. The badge reads \">> fast-forward xN\" on sped spans and \"<< <label> xN\" on slowed ones — pass --label slow-motion for a slow span (use --no-badge to skip it, --label to change the word). Reports duration_expected vs duration_seconds plus timing_check_mapped vs timing_check_unmapped. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--span", "Span to speed up or slow down: <start>-<end>@<speed>, repeatable, max 16 (times in seconds or MM:SS, speed 0.25-16; below 1 slows down, 1 is refused)"],
      ["--no-badge", "Skip the speed badge on changed spans (\">> fast-forward xN\" / \"<< <label> xN\")"],
      ["--label", "Badge word (default \"fast-forward\")"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  reverse: {
    usage: "mediakit reverse <input> -o <output> [--no-audio] [--crf 23] [--dry-run]",
    desc: "Play a clip backwards: video frames reversed, audio reversed too by default. Reports whether each stream was actually reversed. Works on audio-only input as well. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--no-audio", "Keep the audio playing forward under the reversed video (reverses nothing on audio-only input)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  rotate: {
    usage: "mediakit rotate <input> -o <output> [--angle 90|180|270 | --flip horizontal|vertical] [--crf 23] [--metadata-only] [--dry-run]",
    desc: "Rotate a clip 90/180/270 degrees clockwise, or flip it horizontally/vertically. The angle applies to the frame the viewer sees (a phone clip coded 1280x720 with rotation 90 rotates from its 720x1280 display size); the output carries no rotation metadata, so no player double-rotates it. --metadata-only rewrites only the display-matrix metadata (stream copy, no re-encode — instant, lossless, coded video packets verified identical on disk); the angle adds to the input's existing rotation (90 on a rotation-90 clip gives 180; 270 on it strips the matrix). mp4/mov/mkv only, angle only, no flip. Reports input_rotation vs output_rotation measured on disk. --dry-run prints the exact ffmpeg command and writes no file (dimensions is the expected display size after the rotation).",
    options: [
      ["--angle", "Clockwise degrees: 90, 180 or 270 (exactly one of --angle/--flip)"],
      ["--flip", "Flip: horizontal or vertical (use instead of --angle)"],
      ["--crf", "CRF quality 0-51 (default 23)"],
      ["--metadata-only", "Rewrite only the display-matrix metadata (stream copy, no re-encode): instant and lossless. mp4/mov/mkv only, angle only"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file path"],
    ],
  },
  boomerang: {
    usage: "mediakit boomerang <input> -o <output> [--no-audio] [--crf 23] [--dry-run]",
    desc: "Play a clip forward then backwards — the ping-pong loop. The peak frame is not played twice: the reversed half drops its first frame (moviepy TimeMirror fix) and the reversed audio drops one video-frame of audio, so the output is 2D - 1/fps (audio-only input plays forward + reversed whole, 2D). Reports seam_diff vs normal_step measured on disk. Works on audio-only input too. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--no-audio", "Keep the audio playing forward under the ping-pong video (reverses nothing on audio-only input)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "chroma-key": {
    usage: "mediakit chroma-key <input> -o <output.mov> [--color 00FF00] [--similarity 0.1] [--blend 0] [--background <image|hex>] [--crf 23] [--dry-run]",
    desc: "Remove a green/blue screen. Without --background the output keeps transparency and MUST be .mov (ProRes 4444) — .mp4 has no alpha, and this ffmpeg build drops VP9 alpha in .webm. With --background (an image file or a hex color) the subject is composited onto it and the output is a flat .mp4/.webm. Reports the alpha measured on disk (middle frame): full-frame mean, corner (~0 for a full-screen key) and center (~255 on the subject). --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--color", "Key color as 6-digit hex (default 00FF00 green; 0000FF for blue)"],
      ["--similarity", "Color tolerance 0-1 (default 0.1; too high eats the subject)"],
      ["--blend", "Edge blend 0-1 (default 0)"],
      ["--background", "Image file or hex color to composite onto (e.g. bg.jpg or 1E40AF); without it the output keeps transparency and must be .mov"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "zoom-pan": {
    usage: "mediakit zoom-pan <image> -o <output.mp4> [--duration 5] [--fps 30] [--zoom-from 1] [--zoom-to 1.5] [--focus-x 0.5] [--focus-y 0.5] [--focus-end-x 0.5] [--focus-end-y 0.5] [--width 1280] [--height 720] [--crf 23] [--dry-run] | mediakit zoom-pan <video> --events-file events.json -o <output.mp4> [--zoom 2] [--chain-gap 2.5] [--transition 0.3] [--pre-lead 0.2] [--pan 0.25] [--hold 0.8] [--crf 23] [--dry-run]",
    desc: "Ken Burns effect: turn a still image into a moving clip. Zooms linearly from --zoom-from to --zoom-to while the focus point moves from (--focus-x, --focus-y) to (--focus-end-x, --focus-end-y), 0-1 fractions of the frame (0.5 is center). The input is pre-scaled 1.25x before zooming to avoid zoompan's integer-crop jitter. Input must be a still image, not a video — unless --events-file is set: chain mode takes a video and drives the camera from a JSON event timeline [{time, x, y, hold?}], grouping close events into zoom chains that pan between targets and zooming out to the full frame between chains (--zoom/--chain-gap/--transition/--pre-lead/--pan/--hold tune the chains; output keeps the input's dimensions, fps and duration). --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--duration", "Clip length in seconds, image mode only (default 5)"],
      ["--fps", "Output frame rate, image mode only (default 30)"],
      ["--zoom-from", "Zoom at the first frame, 1 = full image (default 1)"],
      ["--zoom-to", "Zoom at the last frame (default 1.5)"],
      ["--focus-x", "Focus point x at the first frame, 0-1 (default 0.5)"],
      ["--focus-y", "Focus point y at the first frame, 0-1 (default 0.5)"],
      ["--focus-end-x", "Focus point x at the last frame (default = --focus-x)"],
      ["--focus-end-y", "Focus point y at the last frame (default = --focus-y)"],
      ["--width", "Output width in pixels, even, image mode only (default 1280)"],
      ["--height", "Output height in pixels, even, image mode only (default 720)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["--events-file", "Chain mode: JSON file of camera events [{time, x, y, hold?}] — switches the input to video"],
      ["--zoom", "Chain mode: zoom level while zoomed in (default 2)"],
      ["--chain-gap", "Chain mode: gap in seconds above which a new chain starts (default 2.5)"],
      ["--transition", "Chain mode: seconds to zoom in/out (default 0.3)"],
      ["--pre-lead", "Chain mode: seconds before the first event to start zooming in (default 0.2)"],
      ["--pan", "Chain mode: seconds before the next event to start panning to it (default 0.25)"],
      ["--hold", "Chain mode: seconds to hold the last target past its event time (default 0.8)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  download: {
    usage: "mediakit download <url> -o <output.mp4> [--max-size-mb 500] [--timeout-seconds 300] [--cache] [--cache-dir <dir>] [--max-retries 3] [--rate-limit-rps 0] [--license <label>] [--license-policy-file <path>]",
    desc: "Download a media file from an http(s) URL into the workspace. Typed and guarded: http/https only (no credentials in the URL), size cap enforced while streaming (default 500 MB), 5 redirects max, 300s timeout per attempt, written atomically via <output>.partial and renamed only on success, then probed — a file that is not media is deleted and reported. The output extension is either given (must be a media extension) or derived from the Content-Type / URL path. Transient failures (HTTP 429/5xx, network errors) are retried with exponential backoff honouring Retry-After (default 3 retries; timeouts and deterministic refusals are never retried). --cache reuses a verified per-URL disk cache (size + sha256 checked; playlists are never cached). --rate-limit-rps paces downloads in this process with a token bucket (0 = unlimited). License: --license declares the source's license (recorded in <output>.provenance.json, never guessed); a policy file (MEDIAKIT_LICENSE_POLICY env, or --license-policy-file: {allow?, deny?, require_license?}) gates the download BEFORE any fetch — a failing license is refused with LICENSE_DENIED and costs zero bytes. Without a policy file the gate is off and the license is only recorded.",
    args: [{ name: "url", required: true }],
    options: [
      ["--max-size-mb", "Maximum download size in MB (default 500)"],
      ["--timeout-seconds", "Per-attempt timeout in seconds (default 300)"],
      ["--cache", "Reuse a verified per-URL disk cache (default off; MEDIAKIT_DOWNLOAD_CACHE_DIR or ~/.cache/mediakit/downloads)"],
      ["--cache-dir", "Cache directory override"],
      ["--max-retries", "Retries for transient failures, 0-5 (default 3)"],
      ["--rate-limit-rps", "Token-bucket rate limit in requests/second for this process (default 0 = unlimited; MEDIAKIT_DOWNLOAD_RPS env when the flag is absent)"],
      ["--license", "License of the source as declared by the caller (e.g. CC0, CC-BY, Public Domain) — recorded in the provenance file; checked against the policy file when one is configured"],
      ["--license-policy-file", "Path to a license policy JSON file {allow?, deny?, require_license?} — overrides MEDIAKIT_LICENSE_POLICY for this call"],
      ["-o, --output", "Output file (required) — with a media extension, or without one (derived from Content-Type / URL path)"],
    ],
  },
  "image-to-video": {
    usage: "mediakit image-to-video <image> -o <output.mp4> [--duration 5] [--fps 30] [--width 1280] [--height 720] [--audio <file>] [--crf 23] [--dry-run]",
    desc: "Turn one still image into a fixed-duration video that holds still (no motion — use zoom-pan for Ken Burns). Dimensions default to the image itself; --width/--height fit the image inside the box and pad black to the exact size (widths are rounded down to even). --audio loops an audio file to the same duration (a short bed loops, a long one is trimmed). Output .mp4 (H.264) or .webm (VP9). Reports frame count measured on the output file — exactly round(duration*fps). --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--duration", "Clip length in seconds (default 5)"],
      ["--fps", "Output frame rate (default 30)"],
      ["--width", "Output width in pixels, rounded down to even (default = image width)"],
      ["--height", "Output height in pixels, rounded down to even (default = image height)"],
      ["--audio", "Audio file to loop under the still (optional)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file, .mp4 or .webm (required)"],
    ],
  },
  slideshow: {
    usage: "mediakit slideshow <img1> <img2> [img3...] -o <output.mp4> [--duration 3] [--durations 3,5,2] [--transition fade] [--transition-duration 1] [--transitions fade,wipeleft] [--transition-durations 1,0.5] [--fps 30] [--width 1280] [--height 720] [--audio <file>] [--crf 23] [--dry-run]  OR  mediakit slideshow --images-glob 'slides/*.png' -o <output.mp4> [same options]",
    desc: "Turn 2-32 still images into one video with an xfade transition between every pair. Each image is visible for its own duration (total = sum of durations); the transition eats a handle, not slide time. --transitions/--transition-durations give a different transition per join (n-1 comma entries); otherwise one type applies to all pairs. --audio loops a bed under the whole slideshow. Output .mp4 only in v1. --images-glob takes the slides from a pattern instead of a file list ('slides/*.png', '**/*.jpg') — matched images are used in natural sort order (shot-2 before shot-10), 2-32 images, only still-image files count; pass either files or --images-glob, not both. --dry-run prints the exact commands for all three stages and writes no file (one exact command per slide clip, the exact xfade join command, and the exact audio command when a bed is given — run them in order to reproduce the real output).",
    args: [{ name: "images", required: false, variadic: true }],
    options: [
      ["--images-glob", "Glob pattern for the slides instead of listing files, e.g. 'slides/*.png' — natural sort order, 2-32 images"],
      ["--duration", "Visible seconds per image (default 3)"],
      ["--durations", "Comma list, one visible duration per image, in order (overrides --duration)"],
      ["--transition", "xfade transition between every pair: fade (default), wipeleft, dissolve, circlecrop, ..."],
      ["--transition-duration", "Transition length in seconds (default 1, must be shorter than the shortest slide)"],
      ["--transitions", "Comma list, one xfade transition per join, in order (n-1 entries; overrides --transition)"],
      ["--transition-durations", "Comma list, one transition length per join, in order (n-1 entries; each shorter than both slides it joins; overrides --transition-duration)"],
      ["--fps", "Output frame rate (default 30)"],
      ["--width", "Output width in pixels (default 1280)"],
      ["--height", "Output height in pixels (default 720)"],
      ["--audio", "Audio file to loop under the slideshow (optional)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the plan and write no file"],
      ["-o, --output", "Output file, .mp4 (required)"],
    ],
  },
  interpolate: {
    usage: "mediakit interpolate <input> -o <output> --fps 60 [--mode mci|blend|dup] [--crf 23] [--dry-run]",
    desc: "Raise the frame rate with motion interpolation (minterpolate). blend is the fast default; mci is true motion compensation but much slower (~9x realtime on CPU). Reports fps and frame counts measured on the output file. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--fps", "Target frame rate, must be above the source fps (required)"],
      ["--mode", "mci | blend (default) | dup"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  denoise: {
    usage: "mediakit denoise <input> -o <output> [--filter hqdn3d|nlmeans] [--strength 0-1] [--crf 23] [--dry-run]",
    desc: "Reduce sensor noise: hqdn3d is the fast default (strength 0.5 = 15, the level that gained +2.9 dB PSNR on sigma-10 noise in testing); nlmeans is better on fine detail but much slower. Reports high-frequency noise energy before and after, measured on disk. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--filter", "hqdn3d (default) | nlmeans"],
      ["--strength", "Noise-reduction strength 0-1 (default 0.5)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  segment: {
    usage: "mediakit segment <input> -o <directory> [--segment-time 6] [--playlist index.m3u8] [--segment-prefix seg] [--reencode] [--crf 23] [--dry-run]",
    desc: "Cut a video into an HLS VOD playlist (index.m3u8 + .ts segments) in a directory. Stream-copy by default (fast, lossless) — but segments can only start on keyframes, so actual lengths follow the source GOP; --reencode re-encodes to libx264/aac with forced keyframes for exact segment boundaries. Reports the segment count and durations parsed back from the playlist on disk. --dry-run prints the exact ffmpeg command and writes no file (no directory is created).",
    args: [{ name: "input", required: true }],
    options: [
      ["--segment-time", "Target segment length in seconds, 1-60 (default 6)"],
      ["--playlist", "Playlist filename, must end .m3u8 (default index.m3u8)"],
      ["--segment-prefix", "Segment filename stem (default seg -> seg000.ts, ...)"],
      ["--reencode", "Re-encode to libx264/aac with forced keyframes (exact segment grid)"],
      ["--crf", "Quality 0-51, lower is better (default 23, reencode only)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file (no directory created)"],
      ["-o, --output", "Output directory (required, created if needed)"],
    ],
  },
  convert: {
    usage: "mediakit convert <input> -o <output> [--video-codec <c>] [--audio-codec <c>] [--crf <n>] [--preset <p>] [--gop <frames>] [--gop-seconds <s>] [--encoder <auto|name>] [--width <n>] [--height <n>] [--fps <n>] [--video-bitrate-kbps <n>] [--audio-bitrate-kbps <n>] [--audio-sample-rate <n>] [--audio-channels <n>] [--dry-run]",
    desc: "Change container or codec. Omit a codec to stream-copy that stream. --gop / --gop-seconds sets an exact keyframe interval on re-encode (measured on the output file). --encoder auto probes for the first working hardware encoder of the codec family and falls back to software when none works (the fallback is reported, never silent); a named hardware encoder (h264_nvenc, hevc_qsv, h264_vaapi, ...) must probe-usable or the call fails. Multi-attribute: --width/--height/--fps/--video-bitrate-kbps/--audio-bitrate-kbps/--audio-sample-rate/--audio-channels set several properties in one call (each applies only when given; video properties need a video re-encode, audio properties an audio re-encode; --video-bitrate-kbps runs ABR and replaces --crf). --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--video-codec", "libx264 | libx265 | vp9 | av1 | mpeg4 | copy"],
      ["--audio-codec", "e.g. aac, libmp3lame, copy"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--preset", "Encoding preset (default medium)"],
      ["--gop", "Keyframe interval in frames (needs --video-codec re-encode)"],
      ["--gop-seconds", "Keyframe interval in seconds (from source fps; needs --video-codec re-encode)"],
      ["--encoder", "Hardware encoder: auto (probe + reported software fallback) or h264_nvenc | hevc_nvenc | av1_nvenc | h264_qsv | hevc_qsv | av1_qsv | h264_vaapi | hevc_vaapi | vp9_vaapi | av1_vaapi | h264_videotoolbox | hevc_videotoolbox | h264_amf | hevc_amf | av1_amf"],
      ["--width", "Resize to this width in px (exact; missing side keeps aspect, must be even; needs --video-codec re-encode)"],
      ["--height", "Resize to this height in px (exact; missing side keeps aspect, must be even; needs --video-codec re-encode)"],
      ["--fps", "Cap the frame rate, constant frame rate (1-120; needs --video-codec re-encode)"],
      ["--video-bitrate-kbps", "Video bitrate in kbps (ABR mode, replaces --crf; needs --video-codec re-encode; does not combine with --encoder)"],
      ["--audio-bitrate-kbps", "Audio bitrate in kbps (needs an audio re-encode; codec defaults to the container's unless --audio-codec is given)"],
      ["--audio-sample-rate", "Audio sample rate in Hz (needs an audio re-encode)"],
      ["--audio-channels", "Audio channel count (needs an audio re-encode)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  normalize: {
    usage: "mediakit normalize <input> -o <output.mp4> [--width <n>] [--height <n>] [--fps <n>] [--crf <n>] [--preset <p>] [--target-lufs <n>] [--dry-run]",
    desc: "Bring a clip to the canonical pipeline profile in one call: libx264 + yuv420p + even dims + CFR (source fps or --fps), AAC 192k at 48 kHz, +faststart for MP4; --width/--height fits inside that box (aspect kept, must be even); --target-lufs also normalizes loudness (two-pass loudnorm). Video inputs must write .mp4/.mov/.m4v. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Fit inside this width, aspect kept (must be even)"],
      ["--height", "Fit inside this height, aspect kept (must be even)"],
      ["--fps", "Cap the frame rate, constant frame rate (1-120)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--preset", "Encoding preset (default medium)"],
      ["--target-lufs", "Also normalize loudness to this target (two-pass loudnorm)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  silence: {
    usage: "mediakit silence <input> -o <output> [--threshold-db <n>] [--min-duration <s>] [--margin <s>] [--detect-only] [--dry-run]",
    desc: "Remove silent stretches, keeping a margin of silence around speech. --detect-only reports segments without writing. --dry-run prints the exact ffmpeg command and writes no file (needs -o, like a real run; with nothing worth cutting the command is a stream-copy).",
    args: [{ name: "input", required: true }],
    options: [
      ["--threshold-db", "Silence threshold in dB (default -40, more negative = stricter)"],
      ["--min-duration", "Minimum silence length to cut, seconds (default 0.5)"],
      ["--margin", "Silence kept around each speech segment, seconds (default 0.2)"],
      ["--detect-only", "Report silence/kept segments, write no file"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required unless --detect-only)"],
    ],
  },
  cropdetect: {
    usage: "mediakit cropdetect <input> [--frames <n>] [--limit <n>]",
    desc: "Measure letterbox/pillarbox black bars; returns the crop rectangle + a ready crop command.",
    args: [{ name: "input", required: true }],
    options: [
      ["--frames", "Frames to sample (default 30)"],
      ["--limit", "Black threshold 0-255 (default 24)"],
    ],
  },
  package: {
    usage: "mediakit package <input> -o <output.zip> [--captions <file.srt|ass|vtt>] [--platform tiktok|reels|shorts|youtube|instagram-feed|instagram-story|linkedin]",
    desc: "Bundle a finished file for delivery: media + spec.json receipt + checksums.sha256 (+ captions).",
    args: [{ name: "input", required: true }],
    options: [
      ["--captions", "Subtitle file .srt/.ass/.vtt to include"],
      ["--platform", "Run check for this platform and record it in spec.json"],
      ["-o, --output", "Output .zip file (required)"],
    ],
  },
  compress: {
    usage: "mediakit compress <input> -o <output> [--quality low|medium|high|email-25mb] [--max-width <px>] [--crf <n>] [--preset <p>] [--target-size <MB>] [--no-resolution-ladder] [--no-quality-proof] [--dry-run]",
    desc: "Shrink a file with one named quality preset (low/medium/high, or email-25mb = target 18 MB so it still fits a 25 MB email attachment after base64). Reports the size before/after and the reduction actually achieved. --target-size <MB> encodes to fit under an exact size instead (two-pass ABR, e.g. 10 for Discord); it ignores --quality and cannot combine with --crf. In target-size mode a resolution ladder steps the frame down when the bitrate buys less than 0.045 bits per pixel per frame, so a starved encode stays watchable instead of mush; --no-resolution-ladder keeps the source frame. Target-size mode also prints a quality proof: SSIM against the source at 3 sample points + PSNR mid-clip and a verdict in words (VMAF is measured at the mid point when the ffmpeg build has libvmaf; otherwise SSIM is the measured proxy and the proof says so); --no-quality-proof skips the measurement. --dry-run prints the exact ffmpeg command(s) — two passes in target-size video mode — and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--quality", "low | medium | high | email-25mb (default medium; ignored with --target-size)"],
      ["--max-width", "Scale video down to this width first (only when wider)"],
      ["--crf", "Override the preset's CRF (0-51; cannot combine with --target-size)"],
      ["--preset", "Override the preset's x264 preset (ultrafast..veryslow)"],
      ["--target-size", "Target size in decimal MB (1 MB = 1,000,000 bytes); two-pass encode to fit under it"],
      ["--no-resolution-ladder", "In target-size mode, keep the source frame even when the bitrate is starved"],
      ["--no-quality-proof", "In target-size mode, skip the SSIM quality proof"],
      ["--dry-run", "Print the exact ffmpeg command(s) and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  receipt: {
    usage: "mediakit receipt <input> -o <output.json> [--platform tiktok|reels|shorts|youtube|instagram-feed|instagram-story|linkedin]",
    desc: "Write a provenance receipt (JSON sidecar): probe, SHA-256, size, measured loudness, optional platform check, ffmpeg versions.",
    args: [{ name: "input", required: true }],
    options: [
      ["--platform", "Run check for this platform and record it in the receipt"],
      ["-o, --output", "Output .json file (required)"],
    ],
  },
  "convert-captions": {
    usage: "mediakit convert-captions <input.srt|vtt> -o <output.vtt|srt>",
    desc: "Convert a subtitle file between SRT and VTT (cue text carried verbatim; VTT cue settings are dropped and counted). Format is inferred from the output extension.",
    args: [{ name: "input", required: true }],
    options: [
      ["-o, --output", "Output file .srt or .vtt (required, must differ from the input format)"],
    ],
  },
  "generate-srt": {
    usage: "mediakit generate-srt --cues-file <cues.json> -o <output.srt>  |  mediakit generate-srt --words-file <words.json> -o <output.srt>",
    desc: "Build a .srt from a JSON cue list [{start, end, text}] (times in seconds or MM:SS; cues must be in order, non-overlapping). Or from word timings [{start, end, word}] with --words-file: words are grouped into semantic cues (max 8 words, 3.5s, 84 chars / 2 lines of 42; split on pauses >0.4s and sentence ends; a cue never ends on a stranded word). Pure text, no ffmpeg.",
    args: [],
    options: [
      ["--cues-file", "JSON file with the cue array (may also be {\"cues\": [...]})"],
      ["--words-file", "JSON file with the word array (may also be {\"words\": [...]}); alternative to --cues-file"],
      ["-o, --output", "Output .srt file (required)"],
    ],
  },
  "chunk-captions": {
    usage: "mediakit chunk-captions --words-file <words.json> -o <output.json> [--max-words 6] [--max-chars 84] [--max-seconds 3.5] [--pause-seconds 0.4] [--no-split-on-punctuation]",
    desc: "Chunk word timings into subtitle cues: words from transcribe --word-timestamps become cues [{start, end, text}] in a .json file, ready for generate-srt (or for burn-captions via --words-file). Defaults are the locked TikTok standard: at most 6 words per cue, 84 chars (2 lines), split on pauses over 0.4s, on sentence ends, and after a comma/semicolon/colon once the cue holds 3 words. Pure text, no ffmpeg.",
    args: [],
    options: [
      ["--words-file", "JSON file with the word array (may also be {\"words\": [...]}) (required)"],
      ["--max-words", "Max words per cue (default 6)"],
      ["--max-chars", "Max characters per cue (default 84 = 2 lines of 42)"],
      ["--max-seconds", "Max cue duration in seconds (default 3.5)"],
      ["--pause-seconds", "Split on a pause longer than this, in seconds (default 0.4)"],
      ["--no-split-on-punctuation", "Do not split after a comma/semicolon/colon (sentence ends still split)"],
      ["-o, --output", "Output .json file with cues + stats (required)"],
    ],
  },
  "publish-kit": {
    usage: "mediakit publish-kit <input> --thumbnail <thumb.png> --kit-file <kit.json> -o <output-dir> [--style clean-bold|minimal-line|warm-story]",
    desc: "Thumbnail & Publishing Kit: from a finished video + 1280x720 16:9 thumbnail + copy in kit.json {titles (exactly 5), description, tags, pinned_comment, chapters?}, write metadata.md + publishing.json and report a pre-publish checklist. Verifies thumbnail size, titles and chapter times; mobile readability, fidelity and licences are marked human-review, never passed. Publishes nothing.",
    args: [{ name: "input", required: true }],
    options: [
      ["--thumbnail", "Thumbnail image, 16:9 and at least 1280px wide (required)"],
      ["--kit-file", "JSON file with titles/description/tags/pinned_comment/chapters (required)"],
      ["--style", "Shorts style lock id from skills/shorts-video/styles.json (optional, recorded in the kit)"],
      ["-o, --output", "Output directory for metadata.md + publishing.json (required)"],
    ],
  },
  transcribe: {
    usage: "mediakit transcribe <input> -o <output.srt> [--model tiny] [--language auto|en|vi|...] [--engine auto|faster-whisper|whisper] [--chunk-seconds 300] [--word-timestamps]",
    desc: "Transcribe speech to a .srt with a LOCAL engine (no cloud, audio never uploaded): faster-whisper by default, whisper.cpp with --engine whisper. Needs an engine installed (see doctor); without one the call fails with install lines. Env: MEDIAKIT_ASR_PYTHON picks the python with faster-whisper, MEDIAKIT_ASR_MODEL the default model; MEDIAKIT_WHISPER_CPP_BIN / MEDIAKIT_WHISPER_MODEL point at a whisper.cpp binary + ggml model. --chunk-seconds splits long files into chunks (5–1800s, 2s overlap, segments re-offset onto the full timeline) so hour-long recordings transcribe without one giant ASR run; a file shorter than one chunk runs as a single chunk. --word-timestamps also returns per-word timings in the printed JSON (words: [{index, start, end, word}]) — the input cut_words cuts by; save the printed JSON to a file and pass it as --words-file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--model", "Whisper model: tiny (default, fast), base, small, medium, large-v3, large-v3-turbo, ..."],
      ["--language", "Language: auto (default, detect) or ISO 639-1 code, e.g. en, vi"],
      ["--engine", "ASR engine: auto (default, faster-whisper then whisper.cpp), faster-whisper, or whisper (whisper.cpp CLI)"],
      ["--chunk-seconds", "Split the audio into N-second chunks (5–1800, default: whole file in one run)"],
      ["--word-timestamps", "Also return per-word timings in the printed JSON (words: [{index, start, end, word}]) for cut_words"],
      ["-o, --output", "Output .srt file (required)"],
    ],
  },
  "cut-words": {
    usage: "mediakit cut-words <input> --words-file <words.json> -o <output> [--remove um,uh | --fillers | --indices 0-5,96-98] [--keep 3,7-9] [--pad-before 0.06] [--pad-after 0.12] [--min-keep 0.2] [--edge-buffer 0.1] [--snap-to-pause] [--dry-run]",
    desc: "Cut words out of a talking-head clip by transcript: filler words (um/uh), false starts and restarts, using word timings from transcribe --word-timestamps (save its printed JSON and pass it as --words-file). Select by word text (--remove 'um,uh'), the built-in filler set (--fillers: um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh), or 0-based word-index ranges (--indices '0-5,96-98'); --keep rescues indices even when matched. Keep runs are padded 0.06s before / 0.12s after, clamped so a cut never keeps a fragment of the word it removed; kept words that end up mostly cut out are reported in cut_check.swallowed. --edge-buffer (0-1s, default 0) widens every keep segment past its pads, clamped only to the file edges — Outtake's 0.1s clip-edge buffer, so a cut never lands exactly on a kept word's onset; it deliberately keeps up to that much of the neighbouring removed word's edge, and a buffer wider than the gap between two kept runs merges them. --snap-to-pause moves each keep edge into the real pause the transcript points at (measured from the take's own audio at 10 ms frames, threshold from the take's own levels, 0.1s of room tone kept each side) instead of the fixed pads — Whisper's word edges run late at sentence ends, so a transcript-only cut keeps the start of the next sentence; an edge with no pause, an ambiguous one, or a snap that would cross a kept word keeps its padded value, with the reason in snap. Refuses files over 1200s. --dry-run prints the plan and writes nothing. No match copies the input unchanged.",
    args: [{ name: "input", required: true }],
    options: [
      ["--words-file", "Transcript JSON with a words array (required) — the stdout of `transcribe --word-timestamps` saved to a file"],
      ["--remove", "Comma-separated words to cut by text, e.g. 'um,uh' (case-insensitive, punctuation ignored)"],
      ["--fillers", "Also cut the built-in filler set (um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh)"],
      ["--indices", "0-based word-index ranges to cut, e.g. '0-5,96-98' (indices as printed by transcribe)"],
      ["--keep", "0-based word-index ranges to keep even when matched, e.g. '3,7-9'"],
      ["--pad-before", "Seconds kept before each kept-word run (default 0.06)"],
      ["--pad-after", "Seconds kept after each kept-word run (default 0.12)"],
      ["--min-keep", "Drop keep segments shorter than this many seconds (default 0.2)"],
      ["--edge-buffer", "Seconds of handle kept past each edge of every keep segment (0-1, default 0), clamped only to the file edges — a buffer wider than the gap between two kept runs merges them"],
      ["--snap-to-pause", "Snap each keep edge into the real pause the transcript points at (measured levels, 0.1s room tone each side) instead of the fixed pads; an edge with no pause or an ambiguous one keeps its padded value"],
      ["--dry-run", "Print the cut plan (removed words, keep segments, cut_check) and write no file"],
      ["-o, --output", "Output file (required unless --dry-run)"],
    ],
  },
  "remove-retakes": {
    usage: "mediakit remove-retakes <input> --words-file <words.json> -o <output> [--min-words 3] [--max-gap-words 8] [--max-gap-seconds 5] [--keep last|first] [--pad-before 0.06] [--pad-after 0.12] [--min-keep 0.2] [--snap-to-pause] [--detect-only]",
    desc: "Cut repeated takes out of a talking-head clip, on word timings from transcribe --word-timestamps (save its printed JSON and pass it as --words-file): when the speaker says a sentence, restarts, and says it again, the earlier take plus the restart junk ('okay, again', a filler) is cut and the fluent take is kept whole. A repeat is --min-words identical words (default 3) with at most --max-gap-words words (default 8) and --max-gap-seconds (default 5) between the takes; a 2-word abandoned start ('the quick' — 'um' — 'the quick brown fox') is also cut. --keep last (default) keeps the later take, --keep first the earlier one. --snap-to-pause moves each keep edge into the real pause the transcript points at (measured from the take's own audio, 0.1s of room tone kept each side) instead of the fixed pads — Whisper's word edges run late at sentence ends; an edge with no pause, an ambiguous one, or a snap that would cross a kept word keeps its padded value, with the reason in snap. --detect-only reports the clusters and the cut plan and writes no file. No retake copies the input unchanged. Deterministic, not a judge: an intentional repetition looks like a retake to this detector — read the clusters (or run --detect-only) before cutting.",
    args: [{ name: "input", required: true }],
    options: [
      ["--words-file", "Transcript JSON with a words array (required) — the stdout of `transcribe --word-timestamps` saved to a file"],
      ["--min-words", "Minimum repeated-phrase length in words (default 3)"],
      ["--max-gap-words", "Max words allowed between the two takes (default 8)"],
      ["--max-gap-seconds", "Max seconds between the takes (default 5)"],
      ["--keep", "Which take to keep: last (default) or first"],
      ["--pad-before", "Seconds kept before each kept-word run (default 0.06)"],
      ["--pad-after", "Seconds kept after each kept-word run (default 0.12)"],
      ["--min-keep", "Drop keep segments shorter than this many seconds (default 0.2)"],
      ["--snap-to-pause", "Snap each keep edge into the real pause the transcript points at (measured levels, 0.1s room tone each side) instead of the fixed pads; an edge with no pause or an ambiguous one keeps its padded value"],
      ["--detect-only", "Report the clusters and the cut plan and write no file"],
      ["-o, --output", "Output file (required unless --detect-only)"],
    ],
  },
  "smart-cut": {
    usage: "mediakit smart-cut <input> --words-file <words.json> -o <output> [--min-gap 0.45] [--aggressiveness 0.5] [--fillers um,uh,\"you know\"] [--min-keep 0.2] [--no-contextual-gate] [--min-segment 0] [--snap-to-pause] [--detect-only] [--dry-run]",
    desc: "Tighten a talking-head clip on word timings from transcribe --word-timestamps (save its printed JSON and pass it as --words-file): cut the hesitation out of a take in one pass — long pauses between words, long filler words, and words held so long they became a stall. A filler only counts when held long (>= 0.35s - 0.15*aggressiveness), so a quick 0.1s 'um' survives and a stretched 'ummm' does not; that duration gate is what makes 'like'/'you know' safe in the default list. Since lượt 130 the contextual fillers 'like'/'you know'/'basically'/'actually' ALSO need the context gate (on by default): a long one is only cut when flanked by >= 0.15s pauses on both sides or at the very start/end of the take — a 0.6s 'like' inside 'I like this' survives and is listed in gated_fillers; --no-contextual-gate restores the old duration-only behaviour. --min-segment (default 0 = off) merges removals separated by less than that many seconds of kept speech, so a sub-2s keep fragment between two cuts is cut with them (2.0 follows OpenEdit's silence_cutter default — but it can swallow real words on a dense take, so it stays off unless asked). --snap-to-pause moves each keep edge into the real pause the transcript points at (measured from the take's own audio, 0.1s of room tone kept each side) instead of the fixed pads — Whisper's word edges run late at sentence ends, so a transcript-only cut keeps the start of the next sentence; an edge with no pause, an ambiguous one, or a snap that would cross a kept word keeps its padded value, with the reason in snap. One --aggressiveness knob (0-1, default 0.5) scales all three cut thresholds at once. --detect-only reports the removed intervals and the cut plan and writes no file; --dry-run prints the exact ffmpeg command. Nothing to cut copies the input unchanged. Deterministic, not a judge: a dramatic pause looks like a hesitation to this detector — read the removed list (or run --detect-only) before cutting.",
    args: [{ name: "input", required: true }],
    options: [
      ["--words-file", "Transcript JSON with a words array (required) — the stdout of `transcribe --word-timestamps` saved to a file"],
      ["--min-gap", "Gap between two words, in seconds, that counts as a hesitation pause before aggressiveness scaling (default 0.45)"],
      ["--aggressiveness", "One knob 0-1 scaling all three cut thresholds (default 0.5): 0 gentle, 1 tight"],
      ["--fillers", "Comma-separated filler phrases to cut when held long, e.g. \"um,uh,you know\" — omit for the default list"],
      ["--min-keep", "Drop keep segments shorter than this many seconds (default 0.2)"],
      ["--no-contextual-gate", "Disable the context gate: cut 'like'/'you know'/'basically'/'actually' on duration alone, as before lượt 130"],
      ["--min-segment", "Merge removals separated by less than this many seconds of kept speech (default 0 = off; 2.0 is OpenEdit's default)"],
      ["--snap-to-pause", "Snap each keep edge into the real pause the transcript points at (measured levels, 0.1s room tone each side) instead of the fixed pads; an edge with no pause or an ambiguous one keeps its padded value"],
      ["--detect-only", "Report the removed intervals and the cut plan and write no file"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required unless --detect-only)"],
    ],
  },
  "clean-voice": {
    usage: "mediakit clean-voice <input> -o <output.wav> [--target-lufs -14] [--steps declip,dehum] [--diagnose] [--ab [--window 10,22]] [--dry-run]",
    desc: "Clean a recorded voice for a video: diagnose the recording first (peak, clipped runs, noise floor, SNR, echo tail, bandwidth, 50/60 Hz hum — all measured from the decoded audio), then pick the cleanup steps and run the voice chain (highpass 80 Hz + EQ + 3.5:1 compressor + gain to target LUFS + -1 dBFS limiter) exactly once, at the end, in float. Output is a 48 kHz mono float WAV on the input's video clock, so cut it afterwards with the take's times. The plan's steps are declip (>20 clipped runs), dehum (hum >12 dB over its neighbours), clearvoice (echo tail >-24 dB or SNR <50 dB) and sr (bandwidth <15 kHz); clearvoice/sr need the ClearVoice engine (PyTorch + ~1.7 GB checkpoints), which is not installed — a run that needs them refuses loudly instead of cleaning without them, so pass --steps with only the ffmpeg-native steps (e.g. --steps declip,dehum, or --steps none for chain only) to clean anyway. --diagnose only measures and prints the plan and writes nothing; --ab writes a 12 s speech window through every runnable candidate chain (0.8 s gaps, order in OUT.ab.txt) so a new mic or room can be heard before committing; --window 'start,end' picks the window instead of the densest 12 s of speech. A report is written to OUT.report.json. Refuses inputs over 600 s (trim a section first) and non-.wav outputs.",
    args: [{ name: "input", required: true }],
    options: [
      ["--target-lufs", "Target integrated loudness for the cleaned voice (default -14)"],
      ["--steps", "Comma-separated step override, e.g. \"declip,dehum\" or \"none\" for chain only — unknown names fail loudly"],
      ["--diagnose", "Only measure the recording and print the diagnosis + plan; write no file"],
      ["--ab", "Also write OUT.ab.wav: the densest 12 s of speech through every runnable candidate chain, with the order in OUT.ab.txt"],
      ["--window", "Seconds of the input to use for --ab, 'start,end' (default: densest 12 s of speech)"],
      ["--dry-run", "Print the exact ffmpeg commands and write no file"],
      ["-o, --output", "Output WAV file, must end in .wav (required unless --diagnose)"],
    ],
  },
  "search-words": {
    usage: "mediakit search-words --words-file <words.json> --query \"<phrase>\" [--pad-before 0.5] [--pad-after 0.5] [--max-matches 10] [--context-words 5]",
    desc: "Find a phrase in a transcript and return where it is said (probe-only, writes no file): give a words file (the JSON transcribe --word-timestamps prints — save its stdout — or a hand-written {words:[{start,end,word}]}), the same file cut-words cuts by, and a --query phrase. Matching is on normalized words (case-insensitive, punctuation ignored — 'Hello,' matches 'hello'), contiguous only: a phrase split by another word is not a match, and ASR mis-hearings are not fuzzy-matched. Every match returns its word indices, start/end/duration, the matched text with context words on each side, and a padded cut window (default 0.5s each side); cut_list merges the windows into the ready-to-cut list. Search the phrase, then cut the window it returns — never guess timestamps. Also a batch operation (one words file per clip, the cut-words convention) and a manifest probe-only step.",
    args: [],
    options: [
      ["--words-file", "Transcript JSON with a words array (required) — the stdout of `transcribe --word-timestamps` saved to a file"],
      ["--query", "Phrase to find, e.g. 'welcome back' (required; case-insensitive, punctuation ignored)"],
      ["--pad-before", "Seconds before each match's first word in its cut window (default 0.5)"],
      ["--pad-after", "Seconds after each match's last word in its cut window (default 0.5)"],
      ["--max-matches", "Max matches to return, 1-100 (default 10); match_count is the true total even when truncated"],
      ["--context-words", "Words of context on each side of the match (default 5)"],
    ],
  },
  mix: {
    usage: "mediakit mix <voice> --music <file> -o <output> [--music-volume 0.3] [--duck-db 12] [--attack-ms 100] [--release-ms 400] [--voice-lufs -16] [--target-lufs -14] [--no-master] [--dry-run] [--sfx <file>@<s|MM:SS>[@<volume>]]",
    desc: "Mix voice over a music bed with sidechain ducking (bed drops under speech), then master to target LUFS. --sfx drops a short sound at an exact timestamp (repeatable, mixed after ducking). --dry-run prints the exact ffmpeg command and writes nothing.",
    args: [{ name: "voice", required: true }],
    options: [
      ["--music", "Music bed audio file (required, looped to voice length)"],
      ["--music-volume", "Bed level when voice is silent, 0-1 (default 0.3)"],
      ["--duck-db", "How far the bed drops under speech, dB (default 12, 0 = no ducking)"],
      ["--attack-ms", "Ducking attack in ms (default 100)"],
      ["--release-ms", "Ducking release in ms (default 400)"],
      ["--voice-lufs", "Voice level target before mixing (default -16)"],
      ["--target-lufs", "Master the mix to this LUFS (default -14)"],
      ["--no-master", "Skip mastering, leave raw mix levels"],
      ["--dry-run", "Print the exact ffmpeg command that would run, write no file"],
      ["--sfx", "Short sound at a timestamp: <file>@<seconds|MM:SS>[@<volume 0-1>] — repeatable, max 16"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  overlay: {
    usage: "mediakit overlay <input> --image <logo.png> -o <output> [--position top-right|top-left|bottom-left|bottom-right|center] [--margin 24] [--width <px>] [--opacity 0.8] [--start <s>] [--end <s>] [--dry-run]",
    desc: "Overlay a logo/watermark image on a video, with position, scale, opacity and optional timing. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--image", "Overlay image file (PNG with transparency recommended, required)"],
      ["--position", "top-right (default) | top-left | bottom-left | bottom-right | center"],
      ["--margin", "Margin from the edge in pixels (default 24)"],
      ["--width", "Overlay width in pixels (keeps aspect; default = native size)"],
      ["--opacity", "Overlay opacity 0-1 (default 1)"],
      ["--start", "Show the overlay from this time in seconds"],
      ["--end", "Hide the overlay after this time in seconds"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  pip: {
    usage: "mediakit pip <input> --pip <video> -o <output> [--position bottom-right|top-left|top-center|top-right|center-left|center|center-right|bottom-left|bottom-center] [--margin 24] [--width <px>] [--scale 0.25] [--opacity 1] [--start <s>] [--end <s>] [--audio main|pip|mix] [--dry-run]",
    desc: "Picture-in-picture: place a second video over the main one, with position, size, opacity, timing and audio choice. --dry-run prints the exact ffmpeg command and writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--pip", "Video to place on top (required)"],
      ["--position", "bottom-right (default) | 8 other corners/edges/center"],
      ["--margin", "Margin from the edge in pixels (default 24)"],
      ["--width", "PiP width in pixels (keeps aspect; overrides --scale)"],
      ["--scale", "PiP width as a fraction of the main width (default 0.25)"],
      ["--opacity", "PiP opacity 0-1 (default 1)"],
      ["--start", "Show the PiP from this time in seconds"],
      ["--end", "Hide the PiP after this time in seconds"],
      ["--audio", "main (default) | pip | mix (both)"],
      ["--dry-run", "Print the exact ffmpeg command and write no file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  broll: {
    usage: "mediakit broll <input> --clip <file>@<at>[@<duration>] [--clip ...] -o <output> [--position fullscreen|top-left|top-center|top-right|center-left|center|center-right|bottom-left|bottom-center|bottom-right] [--scale 0.5] [--width <px>] [--margin 24] [--fade <s>] [--audio main|broll|mix]",
    desc: "Insert B-roll clips into the main video at timestamps. --clip is repeatable (max 8): <file>@<seconds|MM:SS>[@<duration>] — the clip covers the whole frame (fullscreen, default) or sits as a PiP at --position, dissolving in/out over --fade seconds. Windows must not overlap; a window running past the end of the main video is clamped. The output duration is exactly the main duration. --audio broll swaps the main audio for B-roll audio inside each window, mix keeps both.",
    args: [{ name: "input", required: true }],
    options: [
      ["--clip", "B-roll clip: <file>@<seconds|MM:SS>[@<duration>] — repeatable, max 8"],
      ["--position", "fullscreen (default) | 9 PiP positions: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right"],
      ["--margin", "PiP margin from the edge in pixels (default 24)"],
      ["--width", "PiP width in pixels (keeps aspect; overrides --scale)"],
      ["--scale", "PiP width as a fraction of the main width (default 0.5)"],
      ["--fade", "Dissolve in/out at both edges, seconds (default 0, at most half the window)"],
      ["--audio", "main (default) | broll | mix"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  scenes: {
    usage: "mediakit scenes <input> [--threshold 0.3] [--detector ffmpeg|content] [--min-scene-len 15] [--flash-frames 5] [--fades] [--fade-threshold 20] [--min-fade-frames 2]",
    desc: "Detect scene changes / hard cuts; returns cut timestamps + the segments between them. Probe-only, writes no file. --detector content scores hue/sat/luma separately and catches hue-only cuts the ffmpeg metric misses (default threshold 0.05 for content, 0.3 for ffmpeg); --min-scene-len merges too-short scenes and --flash-frames drops 1-frame blips (content only). --fades also reports fade in/out (dark core + measured ramp).",
    args: [{ name: "input", required: true }],
    options: [
      ["--threshold", "Scene sensitivity 0-1, lower = more sensitive (default 0.3 ffmpeg / 0.05 content)"],
      ["--detector", "ffmpeg (default) or content (hue/sat/luma split scoring)"],
      ["--min-scene-len", "Content only: drop a cut when the scene it would open is shorter than this many frames (default 15)"],
      ["--flash-frames", "Content only: a cut followed within this many frames by a cut back to the same content is a flash blip (default 5)"],
      ["--fades", "Also detect fade in/out (dark core + measured ramp)"],
      ["--fade-threshold", "Mean luma at/below this is the dark core of a fade (default 20)"],
      ["--min-fade-frames", "A dark run shorter than this many frames is not a fade (default 2)"],
    ],
  },
  "measure-pace": {
    usage: "mediakit measure-pace <input> [--detector content|ffmpeg] [--threshold 0.05] [--style-file <style.json>] [--style-name <name>]",
    desc: "Measure a reference video's cutting pace: count its hard cuts with the scenes detector, then report {seconds, cuts, cuts_per_min, avg_shot_s, longest_hold_s, longest_at}. Detector defaults to content (hue/sat/luma split scoring, catches hue-only cuts the ffmpeg metric misses). With --style-file, keep the measured pace in that style's style.json (created if missing, pace block replaced, other keys kept) so diagnose scores every film in the project against it; --style-name sets the name stored (default: the style file's name without .json). Without --style-file nothing is written. A file under 15s still measures, but the result says it is too short to compare a style against.",
    args: [{ name: "input", required: true }],
    options: [
      ["--detector", "content (default) or ffmpeg"],
      ["--threshold", "Scene sensitivity 0-1, lower = more sensitive (default 0.05 content / 0.3 ffmpeg)"],
      ["--style-file", "Style file to keep the measured pace in (created if missing) — omit to measure without writing"],
      ["--style-name", "Name stored in the style file (default: the style file's name without .json)"],
    ],
  },
  keyframes: {
    usage: "mediakit keyframes <input> [--nearest <seconds|MM:SS>]",
    desc: "List keyframe (I-frame) timestamps + GOP intervals. Probe-only, writes no file. Check before a stream-copy trim. --nearest <t> also reports the keyframe nearest one cut point: before/after/closest + distance + direction (before/after/exact).",
    args: [{ name: "input", required: true }],
    options: [
      ["--nearest", "Time (seconds or MM:SS): report the keyframe nearest this cut point — before (largest <= t), after (smallest >= t), closest, distance, direction"],
    ],
  },
  highlights: {
    usage: "mediakit highlights <input> [--fps 2] [--threshold 0.15] [--min-span 2] [--top 5] [--thumbnails 3]",
    desc: "Find a clip's visual beats with perceptual hashes: sample frames at --fps (default 2), hash each one as an 8x8 average hash, and call a frame a scene boundary when its hash jumps from the previous frame by >= --threshold (normalized Hamming distance, default 0.15). A highlight is the span between two boundaries — spans shorter than --min-span seconds (default 2) merge into a neighbour — and its score is the mean jump inside the span; --top ranks the best spans. --thumbnails returns that many greedy farthest-point frames (the most visually distinct moments, for a poster frame or a hook still). Probe-only, writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--fps", "Sample rate in frames per second, 0.5-5 (default 2; long files sample slower automatically, down to 0.5)"],
      ["--threshold", "Boundary threshold on the normalized Hamming jump 0-1 (default 0.15; lower = more boundaries)"],
      ["--min-span", "Spans shorter than this merge into a neighbour, in seconds 0-30 (default 2)"],
      ["--top", "How many top highlights to rank, 1-20 (default 5)"],
      ["--thumbnails", "How many farthest-point thumbnail candidates to return, 0-10 (default 3; 0 = none)"],
    ],
  },
  "audio-levels": {
    usage: "mediakit audio-levels <input> [--bucket 1] [--top 5] [--min-gap 2]",
    desc: "Loudness curve + loudest moments of an audio stream. One decode pass: per-frame astats Peak + RMS bucketed into --bucket windows (default 1s), RMS averaged in the linear domain. Returns every bucket {start, end, rms_db, peak_db} (true digital silence reports nulls), a summary (max peak, energy-mean RMS, min/max bucket RMS, dynamic range, silent buckets, loudest bucket) and the --top loudest moments kept at least --min-gap apart (default 2s). The summary also carries dynamics: quiet_p10 / loud_p90 percentiles, separation_db with a flat/narrow/dynamic/wide verdict, and bed_fills_speech_gaps (true when the gaps between loud moments still carry audible energy above -60 dBFS instead of digital silence). Probe-only, writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--bucket", "Bucket width in seconds, 0.1-60 (default 1; at most 3600 buckets)"],
      ["--top", "How many loudest moments to return, 0-50 (default 5; 0 = curve only)"],
      ["--min-gap", "Minimum gap between two returned peaks in seconds (default 2; 0 keeps adjacent buckets)"],
    ],
  },
  motion: {
    usage: "mediakit motion <input> [--threshold 0.001] [--min-still-seconds 2] [--window 1] [--lag-seconds 0] [--adaptive [--adaptive-factor 2] [--adaptive-cap 0.005]]",
    desc: "Measure real movement: per-second curve of the fraction of pixels that changed between adjacent frames, still intervals, and a verdict (moving / mostly-static / static). --lag-seconds N compares frames N seconds apart instead, catching motion too slow for one frame step (a slow fade, a creeping zoom). --adaptive calibrates the still threshold to the clip instead of the fixed 0.001 (floor = 25th percentile of the curve × --adaptive-factor, capped at --adaptive-cap). Probe-only, writes no file. The director's motion gate for a shot.",
    args: [{ name: "input", required: true }],
    options: [
      ["--threshold", "Still threshold on the moved-pixel fraction 0-0.5 (default 0.001 = 0.1% of pixels)"],
      ["--min-still-seconds", "A still interval must last at least this long to be reported (default 2)"],
      ["--window", "Curve window in seconds (default 1)"],
      ["--lag-seconds", "Compare frames this many whole seconds apart instead of adjacent frames (default 0). Still intervals are corrected to clip time"],
      ["--adaptive", "Calibrate the still threshold to the clip: floor = 25th percentile of the motion curve × --adaptive-factor, capped at --adaptive-cap (light grain on a static shot reads still instead of flickering across the fixed threshold)"],
      ["--adaptive-factor", "Multiplier for the adaptive floor (default 2, 1-10; only with --adaptive)"],
      ["--adaptive-cap", "Cap for the adaptive threshold (default 0.005, 0.0005-0.05; only with --adaptive)"],
    ],
  },
  hook: {
    usage: "mediakit hook <input> [--duration 15] [--step 0.5] [--top 3] [--threshold-db -40] [--history-file <path>] [--record] [--history-overlap 0.5] [--snap-window 5] [--no-snap-quiet]",
    desc: "Find the best hook window in a clip: slide a --duration window across the file and score each candidate on measured audio energy (astats RMS), speech coverage (silencedetect), scene cuts (a window opening on a cut scores higher), real motion (per-frame pixel-diff, same step grid) and visual beats (the highlights perceptual-hash boundaries inside the window — 2+ beats is fully active, 1 beat is half). Score is 0.3*energy + 0.2*speech + 0.2*cut + 0.2*motion + 0.1*visual (audio 0.5 / video 0.5). Returns the ranked top windows with the score breakdown (each carries visual + visual_beats), the highlight_boundaries, the per-step energy curve (each bin also carries motion), pacing from real cuts, a trim object, and a suggested trim command for the winner. The trim end snaps to the nearest quiet moment in the last --snap-window seconds (default 5) — quiet is (energy + motion) / 2, a bin only qualifies at most half as busy as the window mean, and the snap never shortens the hook below max(4s, half the window); --no-snap-quiet keeps the raw window end. Probe-only, writes no file. The director's opening-shot picker. Clip history: --history-file <path> checks every candidate against moments already cut (JSON {version: 1, records: [{source_sha256, start, end, score, recorded_at}]}); a candidate from the same source file overlapping a recorded window by >= --history-overlap (default 0.5) of the shorter window is flagged duplicate with duplicate_of. --record appends the winning window to the history file (only the winner — the alternatives were never cut); a missing history file is an empty history, a corrupt one fails loudly.",
    args: [{ name: "input", required: true }],
    options: [
      ["--duration", "Hook window length in seconds, 4-20 (default 15)"],
      ["--step", "Slide step in seconds, 0.25-2 (default 0.5)"],
      ["--top", "How many ranked windows to return, 1-5 (default 3)"],
      ["--threshold-db", "Silence threshold in dB for speech coverage (default -40)"],
      ["--history-file", "JSON clip-history file to check candidates against (missing = empty history)"],
      ["--record", "Append the winning window to --history-file after the run (needs --history-file)"],
      ["--history-overlap", "Overlap fraction of the shorter window that marks a duplicate, 0.05-1 (default 0.5)"],
      ["--snap-window", "Seconds back from the window end to search for a quiet moment to snap the trim to, 1-10 (default 5)"],
      ["--no-snap-quiet", "Keep the raw window end instead of snapping the trim to the nearest quiet moment"],
    ],
  },
  bpm: {
    usage: "mediakit bpm <input> [--min-bpm 40] [--max-bpm 240]",
    desc: "Measure the musical tempo of a clip in BPM: spectral-flux onset function, autocorrelation + comb period search with a 120 BPM prior and an onset-recall tie-break (aubio tempo, re-implemented in pure Node). Returns bpm, beat period, confidence, a reliable flag, onset recall and the first 16 beat times — the grid a beat-snapping cut snaps to. A tone or speech reports reliable: false instead of a confident wrong number. Probe-only, writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--min-bpm", "Lowest tempo to consider in BPM (default 40)"],
      ["--max-bpm", "Highest tempo to consider in BPM (default 240)"],
    ],
  },
  beat_grid: {
    usage: "mediakit beat_grid <input> [--min-bpm 40] [--max-bpm 240] [--method grid|dp]",
    desc: "Return the full beat grid of a clip: the same measurement as bpm, expanded to every beat across the file instead of the first 16. Returns bpm, beat period, confidence, a reliable flag, onset recall, first_beat_seconds, beats (all of them), beat_count and last_beat_seconds. The cut points trim --snap-beat snaps to. A tone or speech reports reliable: false — do not snap cuts to an unreliable grid. The grid is rigid by default (one steady tempo for the whole file); --method dp runs the DP beat tracker instead, which follows real onset peaks when the tempo drifts, and reports tempo_drift_seconds + tempo_drift_cv. Probe-only, writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--min-bpm", "Lowest tempo to consider in BPM (default 40)"],
      ["--max-bpm", "Highest tempo to consider in BPM (default 240)"],
      ["--method", "grid (default, one steady tempo) or dp (DP tracker, follows real onsets when the tempo drifts)"],
    ],
  },
  tempo_drift: {
    usage: "mediakit tempo_drift <input> [--min-bpm 40] [--max-bpm 240]",
    desc: "Measure the local tempo of a clip over time: sliding-window tempo estimation — the aubio pipeline (spectral-flux + autocorrelation/comb + 120 BPM prior + onset-recall tie-break) run on overlapping windows of the onset envelope, aggregated to a 1-second tempo_curve (the local-tempo idea of librosa's plp). Returns bpm (global), confidence, a reliable flag, tempo_curve, start_bpm / end_bpm, delta_bpm, max_deviation_bpm, direction (speeding_up / slowing_down / steady) and verdict (steady / drifting / variable / unreliable). Use it before snapping cuts to a beat grid: a drifting take needs beat_grid --method dp, not the rigid grid. A tone or speech reports verdict unreliable. Probe-only, writes no file. Files over 10 minutes or under 8s are refused.",
    args: [{ name: "input", required: true }],
    options: [
      ["--min-bpm", "Lowest tempo to consider in BPM (default 40)"],
      ["--max-bpm", "Highest tempo to consider in BPM (default 240)"],
    ],
  },
  mux: {
    usage: "mediakit mux <video> <audio> -o <output> [--audio-offset <s>] [--shortest] [--dry-run]",
    desc: "Replace a video's audio track with an external audio file, stream-copying both (no re-encode). --audio-offset shifts the new audio (positive = audio later, negative = video later). --dry-run prints the ffmpeg command and writes no file.",
    args: [{ name: "video", required: true }, { name: "audio", required: true }],
    options: [
      ["--audio-offset", "Shift the new audio in seconds (default 0; positive delays audio, negative delays video)"],
      ["--shortest", "Stop at the shorter of the two streams"],
      ["--dry-run", "Print the ffmpeg command without writing a file"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  find: {
    usage: "mediakit find <directory> --name <text> [--extensions mp4,mov] [--max-results 20]",
    desc: "Find media files by name, recursively. Returns each match with probe info (duration, dimensions). Probe-only, writes no file.",
    args: [{ name: "directory", required: true }],
    options: [
      ["--name", "Substring to match in the filename (case-insensitive, required)"],
      ["--extensions", "Comma-separated extensions to include (default: common video/audio/image/caption)"],
      ["--max-results", "Max matches to return with probe info (default 20)"],
    ],
  },
  "svg-animate": {
    usage: "mediakit svg-animate <svg> --anim <animations.json> -o <output.mp4> [--duration 3] [--fps 30] [--width 1080] [--height 1920] [--background FFFFFF]",
    desc: "Animate an SVG into a video, code-driven (no browser): keyframed translate/scale/rotate/opacity on elements by id, rendered frame by frame. --anim is a JSON file: {\"animations\": [{target, property, from, to, start, end, easing, center?}]}.",
    args: [{ name: "svg", required: true }],
    options: [
      ["--anim", "JSON file with the animations list (required)"],
      ["--duration", "Clip duration in seconds (default 3)"],
      ["--fps", "Frames per second (default 30)"],
      ["--width", "Output width in pixels (default: the SVG's own size)"],
      ["--height", "Output height in pixels"],
      ["--background", "Background hex color (default FFFFFF) or 'transparent'"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  batch: {
    usage: "mediakit batch <operation> --pattern <glob> --input-dir <dir> -o <output-dir> [--args-json '{\"target_lufs\": -14}'] [--jobs 1] [--suffix -loudness] [--no-cache] [--stop-on-error] [--timeout 1800] [--max-files 200] [--dry-run]",
    desc: "Apply one operation (loudness|resize|reframe|compress|convert|extract-audio|reverse|rotate|boomerang|make-loopable|freeze|grade|fit|trim|silence|chroma-key|cut-words|remove-retakes|smart-cut|clean-voice|slideshow|hook|audio-levels|search-words|highlights) to every file matching a glob under a folder, with the same args for all. Outputs are <stem>-<operation>.<ext> under the output dir, mirroring the input tree; a batch-manifest.json records every file's result, and batch-manifest.jsonl streams one JSON line per finished row. Exit code: 0 = every row done/cached/skipped, 1 = any row failed, 2 = input error (unknown operation, bad pattern/args, no matches). Unchanged files are skipped via a content-hash cache; --dry-run lists the planned outputs and writes nothing. cut-words, remove-retakes, smart-cut and search-words find each clip's words file as <words-dir>/<stem>.words.json (default: the input's own folder) — a clip with no words file fails its own row only. clean-voice writes .wav always (48 kHz mono float), whatever the input was, and a take whose plan needs clearvoice/sr fails its own row (pass --args-json '{\"steps\": \"declip,dehum\"}' to clean anyway). slideshow is a set operation: the whole matched set of images (2-32) becomes ONE slideshow video (--args-json '{\"output_name\": \"reel.mp4\"}'), and the per-file cache does not apply. hook, audio-levels, search-words and highlights are probe-only: they write no file (output null in each row) — the measurement comes back in the row's result, and the cache stores that result.",
    args: [{ name: "operation", required: true }],
    options: [
      ["--pattern", "Glob under --input-dir: **/*.mp4 (any depth), sub/*.mp4 (one folder), or bare *.mp4 (basename at any depth) (required)"],
      ["--input-dir", "Folder to search under, recursively (required)"],
      ["--args-json", "Operation arguments as JSON, same for every file (e.g. '{\"target_lufs\": -14}' for loudness, '{\"preset\": \"720p\"}' for resize)"],
      ["--jobs", "Files processed at once, 1-8 (default 1 = sequential; capped at min(jobs, cpu count, 8))"],
      ["--suffix", "Output filename suffix (default -<operation>)"],
      ["--no-cache", "Do not use the content-hash cache — re-encode every matched file"],
      ["--stop-on-error", "Stop starting new files after the first failure (the rest are reported skipped)"],
      ["--timeout", "Shared time budget for the whole batch in seconds (default 1800)"],
      ["--max-files", "Cap on matched files (default 200; extra matches reported via truncated)"],
      ["--dry-run", "List matched files + planned outputs without running anything"],
      ["-o, --output", "Output directory (required, created if needed)"],
      ["--output-dir", "Alias for -o <output-dir>"],
    ],
  },
  assemble: {
    usage: "mediakit assemble <film.json> --mode validate|plan|preview|approve|render|status [-o <output-dir>] [--preview-seconds 20] [--force] [--async] [--plan-file <path>] [--from-plan <path>] [--checkpoint-file <path>]",
    desc: "Film assembler: build a finished video from one declarative film manifest (shots on a voice-led timeline, mixed audio, burned captions, QA + receipt). The voice is the master clock — total = lead + measured voice + tail, and shots must cover it exactly in frames. validate checks the math and writes nothing; plan discloses the resolved timeline (every shot with film-time start/end, joins, the voice/music/SFX audio timeline, chapters with ends) — also writes nothing and does NOT approve the film; preview renders the first N seconds at half size; approve records the fingerprint of the previewed files (a human must have seen the preview); render needs a matching approval unless --force. --plan-file <path> (plan mode only) writes the plan to a file — timeline + fingerprint + exportable/blockers, written atomically; --from-plan <path> (preview/approve/render) refuses a stale plan (changed inputs named) and refuses a non-exportable plan at approve/render. --checkpoint-file <path> (preview/render) writes a per-shot checkpoint ledger after every shot (cache key + segment digest, atomic) — --mode status with the same file then reports each shot as done/stale/missing/pending plus resumable, without rendering anything; one file holds one mode (preview or render), handing a render a preview checkpoint starts a fresh ledger and says so. --async (render mode only) returns a job_id immediately and renders in the background — poll with `mediakit job <id>`. Chapters [{title, at}] in the manifest become MP4 chapters in final.mp4. Shot segments are cached by content hash. Schema: skills/shorts-video/references/assemble-manifest.md.",
    args: [{ name: "manifest", required: true }],
    options: [
      ["--mode", "validate (default) | plan | preview | approve | render | status"],
      ["--preview-seconds", "Preview length in seconds, 1-60 (default 20, preview mode only)"],
      ["--force", "Render without approval (recorded as approval:'forced' in the receipt)"],
      ["--plan-file", "Write the plan to this JSON file (plan mode only)"],
      ["--from-plan", "Refuse a stale or non-exportable plan file (preview/approve/render)"],
      ["--checkpoint-file", "Per-shot checkpoint ledger (preview/render write it, status reads it)"],
      ["--async", "Render in the background (render mode only): validate + approval are checked now, then return a job_id immediately; poll with `mediakit job <id>`"],
      ["--job-id", "Internal: worker job id (used by the async render worker)"],
      ["--job-dir", "Internal: worker job directory (used by the async render worker)"],
      ["-o, --output", "Output directory (required for preview/approve/render)"],
    ],
  },
  "export-timeline": {
    usage: "mediakit export-timeline <film.json> -o <film.otio>",
    desc: "Export an assemble film manifest to an OpenTimelineIO timeline (.otio) — the director's EDL for a real editor (DaVinci / Premiere / any OTIO adapter): the same cuts, transitions, chapters and audio the ffmpeg render produces, with media linked by absolute file:// URL. One Video track (a Clip per image/video shot, a Gap per color/canvas_scene shot), plus Audio tracks for Voice (lead + voice + tail), Music (looped to the film length) and SFX (each at its timestamp); chapters become Marker.2 markers on the video track. Transitions map the xfade join exactly (in_offset/out_offset split the transition frames); fade-family names become SMPTE_Dissolve, the rest Custom_Transition. Frame math is rational — every boundary is a whole number of frames at the film fps, with the snap error reported per shot. A file that vanished after validation is linked with available_range null and listed in media.missing instead of failing the export. The writer self-checks the document (every track sums to exactly total_frames) and refuses to write a bad one.",
    args: [{ name: "manifest", required: true }],
    options: [
      ["-o, --output", "Output .otio path (required)"],
    ],
  },
  init: {
    usage: "mediakit init <dir> [--title <name>] [--preset vertical|horizontal|square|cinematic|vertical-60] [--brand <id>] [--force]",
    desc: "Scaffold a new assemble video project: a film.json that already validates (preset vertical by default, two template shots, 4s total), a style.json with the starter channel pace (10 cuts/min, longest hold 12s — diagnose scores the film against it), a placeholder voice (440 Hz tone WAV, 3s — replace it with the real narration before delivery), placeholder captions, an assets/ layout (shots/, music/) and a CLAUDE.md with the project lifecycle (validate → diagnose → preview → approve → render → verify). Refuses when film.json, CLAUDE.md or style.json already exists unless --force.",
    args: [{ name: "dir", required: true }],
    options: [
      ["--title", "Film title (default: the directory name)"],
      ["--preset", "Preset for the whole film (default vertical: 1080x1920, 30fps, clean-bold captions)"],
      ["--brand", "Brand id (amber-teal | warm-story | minimal-line, or a custom id from MEDIAKIT_BRANDS)"],
      ["--force", "Overwrite an existing film.json / CLAUDE.md in the directory"],
    ],
  },
  job: {
    usage: "mediakit job <job-id> | mediakit job --list | mediakit job --cancel <job-id> | mediakit job --admission",
    desc: "Inspect a durable async render job (started by `assemble --async`): status (default) shows progress + the terminal result or error; --list shows all jobs, newest first; --cancel stops a queued or running job (kills the worker's whole process group). --admission reports the render-job gate (max 2 active jobs / 10 starts per minute by default, env MEDIAKIT_MAX_JOBS / MEDIAKIT_MAX_JOB_STARTS_PER_MINUTE) — a start past the gate is refused with JOB_ADMISSION_LIMIT and creates no job. Jobs live under MEDIAKIT_JOBS_DIR or <workdir>/.mediakit-jobs.",
    args: [{ name: "job-id", required: false }],
    options: [
      ["--list", "List jobs (newest first)"],
      ["--cancel", "Cancel a queued or running job (give the job id)"],
      ["--admission", "Report the job-start admission gate (active jobs, starts in the last minute, limits)"],
    ],
  },
  verify: {
    usage: "mediakit verify <assemble-receipt.json> [--rerender] [-o <output-dir>]",
    desc: "Verify an assemble render against its receipt (assemble-receipt.json, written next to final.mp4 by a full render): re-hash every input (manifest, voice, music, captions, sfx, shot assets) and the output file, re-measure duration/frames/dimensions/LUFS, and report matched/changed/missing per item with a pass/fail verdict and the first difference. --rerender re-runs assemble from the recorded manifest (force) and compares the new receipt against the old one — on this machine renders are byte-identical, so it proves the render reproduces. Without -o the rerender goes to a temp directory next to the receipt and is removed after the comparison.",
    args: [{ name: "receipt", required: true }],
    options: [
      ["--rerender", "Re-run assemble from the recorded manifest and compare receipts"],
      ["-o, --output", "Output directory for the rerender (kept; without it the rerender is compared then removed)"],
    ],
  },
  "verify-cuts": {
    usage: "mediakit verify-cuts <film.json> <video.mp4> [--tolerance 0.25] [--threshold 0.05] [--draft-height 270] [--keep-draft] [--strips] [--strips-dir <dir>] [--audio] [--cut-sheet] [--cut-sheet-path <path>]",
    desc: "Verify an assemble render cuts where its film manifest promises: downscale the video to a 270p draft, measure the real hard cuts with the content scene detector, and compare them against the manifest's shot boundaries — a hard cut must land within --tolerance (default 0.25s) of its promised time, a transition must show a real visual change across its blend window (a fade fires no scene cut, so the frames just outside the window are diffed instead), and any extra cut is reported as unexpected. Duration is checked against the voice timeline (±0.2s). Probe-only: writes nothing except a temp draft, removed afterwards unless --keep-draft. With --strips it also writes one 4-tile review strip per boundary (frames at cut-0.5/-0.1/+0.1/+0.5s from the delivered video) into <video-stem>.cut-strips/ next to the video, or into --strips-dir when given. With --cut-sheet it writes ONE overview image (<video-stem>.cut-sheet.png, or --cut-sheet-path when given): one row per boundary (max 12), two columns — the last frame of the outgoing clip (cut-0.1s) and the first frame of the incoming clip (cut+0.1s) — read it before opening individual strips. With --audio it also measures the SOUND at every hard cut (RMS energy 0.06s each side, above -30 dBFS flags suspect_word; largest sample jump ±40ms around the seam, above 0.35 flags click) — either flag warns and fails the check, and each suspect seam carries a suggested_fix (a click gets a 25ms crossfade, a cut through loud audio gets move_cut_to_silence); opt-in because a canvas_scene film mixes one continuous voice across every visual cut by design, so this is for dialogue edits, where cuts belong in silence.",
    args: [{ name: "manifest", required: true }, { name: "video", required: true }],
    options: [
      ["--tolerance", "How far a measured cut may drift from its promised time, in seconds (default 0.25)"],
      ["--threshold", "Content scene-detector threshold (default 0.05)"],
      ["--draft-height", "Draft height in px for the scene-detection pass (default 270)"],
      ["--keep-draft", "Keep the temp draft render and report its path"],
      ["--strips", "Also write one 4-tile review strip per boundary (frames at cut-0.5/-0.1/+0.1/+0.5s from the delivered video)"],
      ["--strips-dir", "Directory for the review strips (default <video-stem>.cut-strips/ next to the video; ignored unless --strips)"],
      ["--audio", "Also measure the SOUND at every hard cut: peak 0.06s each side (above -30 dBFS flags suspect_word) and the largest sample jump ±40ms around the seam (above 0.35 flags click) — for dialogue edits, where cuts belong in silence"],
      ["--cut-sheet", "Also write ONE overview image (<video-stem>.cut-sheet.png): one row per boundary (max 12), two columns — the last frame of the outgoing clip (cut-0.1s) and the first frame of the incoming clip (cut+0.1s)"],
      ["--cut-sheet-path", "Path for the cut-sheet overview image (default <video-stem>.cut-sheet.png next to the video; ignored unless --cut-sheet)"],
    ],
  },
  diagnose: {
    usage: "mediakit diagnose <film.json> [--style-file <style.json>] [--stamp] [--use-stamp]",
    desc: "Director preflight for an assemble film manifest: validate the manifest, then measure what validation cannot — real motion inside each video shot's exact window (a frozen video is an error), source geometry vs the film frame (upscale over 2x or a low fps warns), the visual seam across each transition, voice loudness, caption coverage and gaps, music loop count, sfx tails past the film end, chapter alignment to cuts, text layers that are too tall or sit in the burned-caption band, and style pace (cuts per minute + longest hold scored against the style.json — an explicit --style-file, or the style.json sitting next to the film; films under 15s are too short to compare), and per-shot pacing (a run of 3+ same-look shots, a shot under 1s or over 15s, dialogue denser than 15 chars/s). Probe-only, writes nothing. A broken manifest reports verdict fail with format_error instead of exiting 2. Run it after writing a film.json and before approve/render; run verify after the render. --stamp writes a QC stamp sidecar <film>.mediakit-diagnose.json keyed on the film fingerprint (manifest + voice + music + sfx + captions + assets + brand) plus the style file hash and the ffmpeg/ffprobe versions; --use-stamp reuses it instead of re-running the preflight when the film, the style and the toolchain all still match, and reports stamp.used=false with the stale reason (no_stamp/film_changed/environment_mismatch/stamp_invalid) when they do not — a stamp never overrides a fresh run.",
    args: [{ name: "manifest", required: true }],
    options: [
      ["--style-file", "Style file to score the film's pace against (default: style.json next to the film manifest, when it exists)"],
      ["--stamp", "Write a QC stamp sidecar <film>.mediakit-diagnose.json keyed on the film fingerprint + style file hash + toolchain versions (written atomically)"],
      ["--use-stamp", "Reuse the QC stamp instead of re-running the preflight when the film, the style and the toolchain all still match; reports stamp.used=false with the stale reason when they do not"],
    ],
  },
  "list-templates": {
    usage: "mediakit list-templates [--category title|motion|card|ambient] [--face-safe | --no-face-safe] [--timing-hint hook|core|payoff|any] [--tag <tag>] [--template <id>] [--readiness ready|preview|draft|all]",
    desc: "Browse the assemble scene-template catalog without rendering anything — the director's shelf for canvas_scene shots. One compact card per template (id, name, category, motion_type, recommended duration_seconds, tags, face_safe, timing_hint, readiness, description); filters combine. Only ready templates show by default — pass --readiness all to see the whole shelf, or preview|draft for one level. --template <id> prints the full detail of one template: every param spec, a directing prompt (what to change, what to keep), plus a ready-to-paste example_shot (kind canvas_scene, duration = the midpoint of the recommended range, params = the defaults). Call this before writing a film.json instead of guessing template names.",
    args: [],
    options: [
      ["--category", "Narrow to one category: title, motion, card, ambient"],
      ["--face-safe", "Only templates that keep the frame center clear"],
      ["--no-face-safe", "Only templates that cover the frame center"],
      ["--timing-hint", "Narrow to one slot: hook, core, payoff, any"],
      ["--tag", "Narrow to templates carrying this tag (e.g. physics, text, calm)"],
      ["--template", "Full detail for ONE template by id, e.g. rings"],
      ["--readiness", "Readiness level to show: ready (default), preview, draft, or all"],
    ],
  },
  "validate-template-package": {
    usage: "mediakit validate-template-package <dir>",
    desc: "Validate an external scene-template package before assemble is ever asked to trust it — a directory holding template.json (ONE template entry, the same schema as one registry entry) + the .cjs scene module it names + any extra files. Three layers, each reported separately: magic_bytes (content, not extension — JSON must parse, a .cjs must be valid UTF-8 text that parses as JavaScript without executing it, images must carry their format's magic bytes), traversal (the manifest's file must be a bare .cjs filename; every symlink must resolve inside the package root), completeness (template.json at the root, the entry passes the same validation as a built-in template, the scene module exists, is non-empty and statically exports draw). Probe-only, writes nothing; a bad package returns valid:false with the issues listed instead of throwing — only a missing package directory throws.",
    args: [{ name: "package", required: true }],
    options: [],
  },
  "validate-shot-spec": {
    usage: "mediakit validate-shot-spec <spec.json> [--base-dir <dir>]",
    desc: "Validate one shot-spec before it is pasted into a film (the director's ingest gate): a standalone JSON file {kind, inputs, params, z} for ONE shot. Each kind declares the inputs it requires — image/video need inputs.source (probed: a still image / a video with measurable duration), color needs params.color (hex, no files), canvas_scene needs exactly one of inputs.scene (a .js/.cjs/.mjs module that parses without executing) or params.template (a built-in template id, with its params checked against the registry) plus optional inputs.assets {name: path} still images. Unknown input roles fail; z must be a finite layer number, duration a positive number of seconds. Relative input paths resolve against --base-dir (default: the spec file's directory). Probe-only, writes nothing; a bad spec returns valid:false with the issues listed instead of throwing — only a missing/unreadable spec file throws.",
    args: [{ name: "spec", required: true }],
    options: [
      ["--base-dir", "Base directory for relative input paths (default: the spec file's directory)"],
    ],
  },
  "align-voice": {
    usage: "mediakit align-voice <film.json> [--lines <lines.json>] [--threshold-db -40] [--min-silence 0.25] [--snap-window-ms 600] [--apply -o <aligned-film.json>] [--expected-key <hex>]",
    desc: "Align an assemble film's shot durations to its voice: split the voice across the shots that speak, in proportion to each shot's dialogue characters, then snap each interior boundary to the middle of the nearest pause within --snap-window-ms (default 600) so a cut never clips a word. Dialogue comes from each shot's `dialogue` field, overridden per shot by --lines [{shot, dialogue}]; shots with no dialogue keep their durations. Plan mode (default) writes nothing and reports the dialogue_key, per-shot durations/deltas/snap info, and violations. --apply writes the aligned film (never over the input) and embeds the dialogue it aligned from; it refuses when there are violations or when --expected-key differs from the computed key.",
    args: [{ name: "manifest", required: true }],
    options: [
      ["--lines", "JSON file [{shot, dialogue}] — overrides the film's `dialogue` field for the shots it names"],
      ["--threshold-db", "Silence threshold in dBFS for pause detection (default -40)"],
      ["--min-silence", "Shortest pause that counts as a snap target, in seconds (default 0.25)"],
      ["--snap-window-ms", "Snap window in milliseconds (default 600)"],
      ["--apply", "Write the aligned film (needs -o); without this, only the plan is printed"],
      ["-o, --output", "Where to write the aligned film JSON (required with --apply; never the input film)"],
      ["--expected-key", "Dialogue lock: refuse the apply unless the computed dialogue_key equals this value"],
    ],
  },
  chapters: {
    usage: "mediakit chapters [--words-file <words.json> | <input>] [--min-gap 2] [--title-words 4] [--max-chapters 32] [-o <chapters.json>]",
    desc: "Generate chapter markers from measured pauses, not guesses. --words-file (a transcribe --word-timestamps JSON) splits the transcript wherever the gap between two words reaches --min-gap (default 2s) and titles each chapter from the first words spoken in it; <input> (a media file with audio) runs silencedetect and starts a chapter at each speech segment that follows a silence of at least --min-gap, titled Part 1..N. The first chapter is always at 0 (YouTube requires it). Over --max-chapters (default 32, the assemble cap) the closest neighbours merge first. Returns chapters in the assemble manifest shape {title, at}; -o also writes that JSON to a file. Probe-only unless -o is given.",
    args: [{ name: "input", required: false }],
    options: [
      ["--words-file", "Transcript words JSON from transcribe --word-timestamps (alternative to <input>)"],
      ["--min-gap", "Pause length in seconds that starts a new chapter (default 2)"],
      ["--title-words", "Words taken from the start of each segment for its title, words mode only (default 4)"],
      ["--max-chapters", "Chapter cap 1-32 (default 32); over it the closest neighbours merge first"],
      ["--threshold-db", "Silence threshold in dBFS, input mode only (default -40)"],
      ["--min-duration", "Shortest silence that counts in seconds, input mode only (default 0.5)"],
      ["-o, --output", "Optional .json file to write {chapters:[{title, at}]} into"],
    ],
  },
  transitions: {
    usage: "mediakit transitions [--category <name>]",
    desc: "List the xfade transition catalog, grouped by family (fade, wipe, slide, smooth, shape, diagonal, slice, wind, cover, reveal, other) — every name concat / slideshow / assemble accept. Read this before picking a transition name. --category narrows to one family. Probe-only, writes nothing.",
    args: [],
    options: [
      ["--category", "One category name (fade, wipe, slide, smooth, shape, diagonal, slice, wind, cover, reveal, other) — omit for the full catalog"],
    ],
  },
  safety: {
    usage: "mediakit safety",
    desc: "Safety tiers for every MediaKit tool (EncodeX's safety-tier idea): READ tools only probe and write nothing; PLAN tools answer a question by transient work and leave no artifact; WRITE tools produce a file the caller asked for and never overwrite their own input; DESTRUCTIVE tools replace a user artifact in place — only patch_manifest, guarded by expected_revision plus a .bak backup. The same tiers ride on the MCP tools/list as standard annotations (readOnlyHint / destructiveHint / idempotentHint / openWorldHint); download alone has openWorldHint because it alone touches the network. Probe-only, writes nothing.",
    args: [],
    options: [],
  },
  "estimate-conversion": {
    usage: "mediakit estimate-conversion <input> [--video-codec libx264] [--crf 23] [--preset medium] [--width <px>] [--height <px>] [--fps <n>] [--audio-bitrate-kbps <n>] [--positions 2] [--short-seconds 2] [--long-seconds 6]",
    desc: "Estimate a convert's output size and time BEFORE running it (EncodeX's estimate_conversion idea): measured, not a bitrate table. At 2 window positions (25%/75% of the file) it encodes the same start twice, video-only, at a short length (default 2s) and a long length (default 6s) with accurate seek — both start with one keyframe, so steady_rate = (long_bytes - short_bytes) / (long - short) and iframe_bytes = short_bytes - steady_rate x short; full video = steady_rate x duration + iframe_bytes x one keyframe per 250 frames. Audio is copied by default (the convert default), so its cost is the probed source audio bitrate x duration; --audio-bitrate-kbps re-encodes audio, measured from one audio-only sample encode. Time is a rough ETA (duration / measured encode speed + one measured startup); size is the precise part — on the fixtures it lands within 10% (hook-source -6.1%, source +4.2% at crf 23; short files take the full-encode path and are exact). Leaves no artifact: samples go to a temp dir that is removed afterwards. Only libx264/libx265.",
    args: [{ name: "input", required: true }],
    options: [
      ["--video-codec", "Target video codec: libx264 or libx265 (default libx264)"],
      ["--crf", "Constant rate factor 0-51 (default 23, same as convert)"],
      ["--preset", "x264/x265 preset: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow (default medium)"],
      ["--width", "Target width in pixels (omit = source display width)"],
      ["--height", "Target height in pixels (omit = source display height)"],
      ["--fps", "Target frame rate (omit = source fps)"],
      ["--audio-bitrate-kbps", "Re-encode audio to this bitrate in kbps; omit to copy the source audio (the convert default)"],
      ["--positions", "How many window positions to sample, 1-3 (default 2: 25% and 75% of the file)"],
      ["--short-seconds", "Short sample length in seconds, 1-3 (default 2)"],
      ["--long-seconds", "Long sample length in seconds, 4-10 (default 6, must be longer than --short-seconds)"],
    ],
  },
  "release-checkpoint": {
    usage: "mediakit release-checkpoint <input> [--manifest film.json] [--receipt assemble-receipt.json] [--platform tiktok] [-o <checkpoint.json>] [--sheet-frames 9] [--no-sheet]",
    desc: "Release checkpoint — one QC gate for a finished clip (KyaniteLabs/kinocut's release-checkpoint idea): verify against the assemble receipt (pass only when 0 changed/missing, and the receipt must be for this input), the platform check (default tiktok), full loudness (pass |LUFS+14| <= 1.0 and true peak <= -1.0 dBTP, warn |LUFS+14| <= 2.0 and TP <= -0.5), clipping (fail on any peak >= 0 dBFS), cut positions against the film manifest (fail on any missing boundary or unexpected cut), plus a contact sheet at the inspection points — shot midpoints + transition midpoints from the manifest, evenly spaced without one. A check with nothing to measure reports skipped, never a fake pass (no receipt, no manifest, no audio stream, --no-sheet). Writes <stem>.checkpoint.json (atomic .partial + rename) with the per-check list, the verdict, warnings, sha256, probe summary and version, and <stem>.checkpoint-sheet.jpg next to it. Exit 0 on pass, 1 on fail.",
    args: [{ name: "input", required: true }],
    options: [
      ["--manifest", "Film manifest (assemble film.json) to verify cuts against and to take contact-sheet timestamps from"],
      ["--receipt", "Assemble receipt (assemble-receipt.json from a full render) to verify the clip against — must be for this input"],
      ["--platform", "Destination platform for the dimensions/codec gate (default tiktok)"],
      ["-o, --output", "Checkpoint JSON path (default <input-stem>.checkpoint.json next to the input; the sheet goes next to the JSON)"],
      ["--sheet-frames", "How many frames in the contact sheet, 1-64 (default 9; with a manifest the sheet uses at most this many inspection points)"],
      ["--no-sheet", "Skip the contact sheet"],
    ],
  },
  manifest: {
    usage: "mediakit manifest <manifest.json> [-o <output.mp4>] [--dry-run] [--no-cache] [--keep-intermediates]",
    desc: "Run a whole edit pipeline from one declarative JSON manifest: {version: 1, input, output, steps: [{tool, args}], qa?} — paths relative to the manifest file. Steps run in order (slideshow as step 1 only — it builds from images in args, so input should be the first slide image; then trim|resize|reframe|compress|convert|extract-audio|reverse|rotate|boomerang|make-loopable|freeze|fastforward|broll|grade|fit|silence|denoise|interpolate|burn-captions|overlay|chroma-key|cut-words|remove-retakes|smart-cut|clean-voice; hook|audio-levels|search-words|highlights are the probe-only steps — they analyze the chain file at that point and pass it through unchanged), each feeding the next; the whole plan is validated before anything renders. Each step is cached by content hash — re-running an unchanged manifest re-encodes nothing. --dry-run lists the planned steps and writes nothing; --qa in the manifest runs qa_report on the final file. clean-voice writes .wav only, so a manifest step using it needs a .wav chain (a voice-only pipeline, or clean-voice as the step before a .wav output).",
    args: [{ name: "manifest", required: true }],
    options: [
      ["--dry-run", "Validate the manifest and list the planned steps without running anything"],
      ["--no-cache", "Do not use the content-hash cache — re-encode every step"],
      ["--keep-intermediates", "Keep the per-step intermediate files under the output dir (deleted on success by default; always kept when a step fails)"],
      ["-o, --output", "Output file (overrides the manifest's output; extension is adjusted to the step chain's final format when needed)"],
    ],
  },
  "patch-manifest": {
    usage: "mediakit patch-manifest <manifest.json> --expected-revision <n> --patch-file <patch.json> [--dry-run] [--lease-id <id>]",
    desc: "Edit a manifest JSON file under a revision guard (OpenEdit's revision-guard idea): the call is refused when --expected-revision does not match the file's current revision (absent = 0), so a stale edit never overwrites newer work. --patch-file holds a JSON array of 1-100 ops: {op: 'set', path: 'output'|'input'|'qa'|'steps.N.tool'|'steps.N.args.KEY', value} / {op: 'add_step', step: {tool, args?}, index?} / {op: 'remove_step', index} / {op: 'replace_step', index, step: {tool, args?}}. Ops apply in order — each op addresses the step list as the previous ops left it. The patched manifest is validated with a real manifest --dry-run before anything is written, then written atomically (.partial + rename) with revision + 1. A mismatch, a bad op, or a patched manifest that no longer validates all refuse and leave the file byte-identical. While another holder's edit lease is active on the manifest (see `mediakit lease`), a patch without that lease's --lease-id is refused with LEASE_HELD. --dry-run previews the exact candidate document (with revision + 1) and writes nothing — no .bak, no revision bump — the approve-before-apply gate: inspect the candidate, then re-run without --dry-run with the same --expected-revision to commit.",
    args: [{ name: "manifest", required: true }],
    options: [
      ["--expected-revision", "The revision last read from the file (required; absent = 0) — must match the file's current revision"],
      ["--patch-file", "JSON file holding the patch operations array (required)"],
      ["--dry-run", "Preview only: print the candidate manifest and write nothing"],
      ["--lease-id", "Edit-lease id from `lease acquire` — required to write while your own lease is active; a patch without it is refused with LEASE_HELD while any lease is held"],
    ],
  },
  lease: {
    usage: "mediakit lease <acquire|release|renew|status> <manifest.json> [--holder <id>] [--lease-id <id>] [--ttl <seconds>]",
    desc: "Hold a cooperative edit lease on a manifest (CutVoke's edit_lock idea: a TTL write lock for multi-step edits). The patch-manifest revision guard only checks at the single moment of a write — two writers can both read revision 5 and the second one's patch silently wins — so a director editing across several calls acquires a lease first: while it is active, patch-manifest refuses every write that does not present the matching --lease-id (LEASE_HELD, naming the holder and the seconds left). acquire needs --holder (a name for who holds it) and returns a lease_id — keep it, only the holder can renew or release; --ttl clamps to 120-300s (default 180) and both the requested and applied TTL are reported; re-acquiring with the same holder renews the same lease_id. renew extends the expiry by --ttl; release deletes the lease file; status reports state none/active/expired with holder, expiry and seconds left. The lease is one JSON sidecar <manifest>.lease.json written atomically; an expired lease stops blocking, a corrupt lease file is treated as no lease, and the LEASE_HELD error never names the lease_id. A lease is cooperative, not security.",
    args: [{ name: "action", required: true }, { name: "manifest", required: true }],
    options: [
      ["--holder", "Who holds the lease (acquire only, required) — a name such as an agent id, shown in LEASE_HELD errors"],
      ["--lease-id", "Lease id from acquire (release/renew only, required)"],
      ["--ttl", "Lease lifetime in seconds (acquire/renew only) — clamped to 120-300, default 180"],
    ],
  },
  determinism: {
    usage: "mediakit determinism <manifest.json> [--runs 2] [--keep-outputs]",
    desc: "Check whether a linear pipeline manifest reproduces byte-identically: run the same manifest N times (default 2, max 5) with the cache OFF, then compare byte sha256, decoded-frame digest (framemd5), and measured properties (duration/frames/dimensions) across runs. Verdict byte_identical means the pipeline reproduces exactly; content_identical means the frames match but container bytes differ, with the differing format tags named; differs means the pipeline itself is nondeterministic, with the first differing run pair named. A download-first manifest re-fetches its URL on every run. --keep-outputs keeps the per-run outputs under .mediakit-determinism-<pid> next to the manifest (removed by default; always kept when a run fails).",
    args: [{ name: "manifest", required: true }],
    options: [
      ["--runs", "How many fresh renders to compare (2-5, default 2)"],
      ["--keep-outputs", "Keep the per-run output files under .mediakit-determinism-<pid> next to the manifest"],
    ],
  },
  doctor: {
    usage: "mediakit doctor [--smoke]",
    desc: "Read-only preflight: ffmpeg/ffprobe versions, available filters/encoders, and which tools that enables. --smoke also runs a real end-to-end render (generate → trim → loudness → verify) and reports whether this machine can actually render, not just which filters exist — plus a path-guard matrix (space/unicode/`..`-inside/nested paths render; output-overwrites-input and workdir escapes are refused, sandbox cases skipped when no workdir is set).",
    args: [],
    options: [
      ["--smoke", "Run a real end-to-end render chain (generate → trim → loudness → verify) after the static checks, plus a path-guard matrix; a failed smoke fails doctor"],
    ],
  },
  audit: {
    usage: "mediakit audit [--limit <n>] [--tool <name>] [--status ok|error] [--since <YYYY-MM-DD>] [--verify]",
    desc: "Read the audit log: every tool call this workspace has recorded (newest first), with arguments hash, input/output files + SHA-256, duration and status. --verify re-hashes the recorded files on disk and reports matched/missing/changed per entry. The log lives at <workdir>/.mediakit-audit.jsonl (MEDIAKIT_AUDIT_PATH overrides, MEDIAKIT_AUDIT=0 disables recording).",
    args: [],
    options: [
      ["--limit", "How many entries to return, newest first (default 20, max 200)"],
      ["--tool", "Only entries for this tool name (e.g. trim, assemble)"],
      ["--status", "Only entries with this status (ok | error)"],
      ["--since", "Only entries at or after this date (YYYY-MM-DD or ISO timestamp)"],
      ["--verify", "Re-hash every recorded file on disk and report matched/missing/changed"],
    ],
  },
  mcp: {
    usage: "mediakit mcp [--http [--port <n>] [--host <ip>]]",
    desc: "Start the MCP server on stdio (for Claude Code / Cursor / Codex), or with --http the same 79 tools over HTTP (REST + JSON-RPC on 127.0.0.1:3000 by default, for curl testing).",
    args: [],
    options: [
      ["--http", "Serve MCP over HTTP instead of stdio"],
      ["--port", "HTTP port (default 3000)"],
      ["--host", "HTTP bind address (default 127.0.0.1; no auth, so only bind elsewhere on a trusted network)"],
    ],
  },
};

function printHelp(cmd) {
  if (cmd && COMMANDS[cmd]) {
    const c = COMMANDS[cmd];
    console.log(`mediakit ${cmd} — ${c.desc}\n\nUsage:\n  ${c.usage}\n`);
    if (c.options.length) {
      console.log("Options:");
      for (const [flag, desc] of c.options) console.log(`  ${flag.padEnd(22)} ${desc}`);
      console.log("");
    }
    return;
  }
  console.log(`mediakit v${VERSION} — professional media tools for coding agents (ffmpeg).\n`);
  console.log("Usage: mediakit <command> [args] [options]\n");
  console.log("Commands:");
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(16)} ${c.desc}`);
  }
  console.log("\nRun `mediakit <command> --help` for details on a command.");
  console.log("Requires ffmpeg + ffprobe on PATH.");
}

function shellQuote(s) {
  // Quote an argv token for re-pasting into a shell (kinocut's
  // eyes-free law: an error ends with the exact command to retry).
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  console.error(`Retry: mediakit ${process.argv.slice(2).map(shellQuote).join(" ")}`);
  process.exit(code);
}

// Edit distance between two flag spellings (for "did you mean").
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// The CLI allowlist is the command's declared options in COMMANDS:
// every --flag a case reads must be listed there. --help/-h and
// -o/--output are always allowed. A `--no-x` entry allows the key x;
// a positive `--x` entry allows the same key (so --no-dry-run is
// accepted wherever --dry-run is declared).
function allowedOptKeys(cmd) {
  const keys = new Set(["help", "output"]);
  for (const [flag] of COMMANDS[cmd].options) {
    for (const part of flag.split(",")) {
      const f = part.trim();
      if (!f) continue;
      keys.add(f.startsWith("--no-") ? f.slice(5).replace(/-/g, "_") : f.replace(/^--?/, "").replace(/-/g, "_"));
    }
  }
  return keys;
}

function declaredLongFlags(cmd) {
  const flags = [];
  for (const [flag] of COMMANDS[cmd].options) {
    for (const part of flag.split(",")) {
      const f = part.trim();
      if (f.startsWith("--")) flags.push(f);
    }
  }
  return flags;
}

// Refuse an option the command does not declare, instead of silently
// ignoring it (lượt 91: `concat --transitions fade` ran a plain
// 20s concat — the plural flag was swallowed and the output looked
// right until the duration was checked). Exit 2, like every other
// CLI usage error. A near-miss (edit distance <= 2) names the flag
// the user probably meant; anything further gets no guess.
function validateOpts(cmd, opts, argv) {
  const allowed = allowedOptKeys(cmd);
  for (const key of Object.keys(opts)) {
    if (allowed.has(key)) continue;
    const dashKey = key.replace(/_/g, "-");
    const token = argv.find((a) => a === `--${dashKey}` || a.startsWith(`--${dashKey}=`) || a === `--no-${dashKey}` || a.startsWith(`--no-${dashKey}=`)) ?? `--${dashKey}`;
    let best = null, bestD = Infinity;
    for (const cand of declaredLongFlags(cmd)) {
      const d = levenshtein(token, cand);
      if (d < bestD) { bestD = d; best = cand; }
    }
    const suggestion = bestD <= 2 ? ` (did you mean ${best}?)` : "";
    fail(`unknown option ${token} for command '${cmd}'${suggestion}\nRun 'mediakit ${cmd} --help' to list options.`, 2);
  }
}

/** Minimal flag parser: --key value, --key=value, --flag, -o value. */
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  // A repeated flag accumulates into an array (e.g. --sfx twice);
  // a flag given once stays a plain scalar, so existing commands
  // are unaffected. Repeating a scalar-only flag still fails loudly
  // downstream (Number([...]) is NaN -> validation error).
  const setOpt = (key, value) => {
    if (opts[key] === undefined) opts[key] = value;
    // A repeated boolean flag stays true (don't turn --dry-run twice
    // into [true, true], which `opts.dry_run === true` would miss).
    else if (value === true && opts[key] === true) { /* keep true */ }
    else if (Array.isArray(opts[key])) opts[key].push(value);
    else opts[key] = [opts[key], value];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { opts.help = true; continue; }
    if (a.startsWith("--no-")) { opts[a.slice(5).replace(/-/g, "_")] = false; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) { setOpt(a.slice(2, eq).replace(/-/g, "_"), a.slice(eq + 1)); continue; }
      const key = a.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      // A value may be a negative number (e.g. --target-lufs -14):
      // it starts with "-" but is not a flag.
      const nextIsNegativeNumber = next !== undefined && /^-\d/.test(next);
      if (next === undefined || (next.startsWith("-") && !nextIsNegativeNumber)) { setOpt(key, true); }
      else { setOpt(key, next); i++; }
      continue;
    }
    if (a === "-o") {
      const next = argv[i + 1];
      if (next === undefined) fail("-o needs a value");
      opts.output = next; i++; continue;
    }
    positional.push(a);
  }
  return { positional, opts };
}

const numOpt = (opts, key) => (opts[key] === undefined ? undefined : Number(opts[key]));

// Parse a --cdl-slope/--cdl-offset/--cdl-power triple "r,g,b" into
// [r, g, b]; the core validates the ranges. Returns undefined when the
// option was not given.
const tripleOpt = (opts, key) => {
  if (opts[key] === undefined) return undefined;
  const parts = String(opts[key]).split(",").map((s) => s.trim());
  if (parts.length !== 3) fail(`--${key.replace(/_/g, "-")} must be three numbers "r,g,b", got "${opts[key]}"`);
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) fail(`--${key.replace(/_/g, "-")} must be three numbers "r,g,b", got "${opts[key]}"`);
  return nums;
};

// Parse --sfx specs: <file>@<seconds|MM:SS>[@<volume 0-1>]. Split from
// the right, so a file path may itself contain "@". Volume defaults
// to 1; the time is left as a string for core.parseTime (MM:SS works).
function parseSfxSpecs(raw) {
  if (raw === undefined) return [];
  const specs = Array.isArray(raw) ? raw : [raw];
  return specs.map((spec) => {
    if (typeof spec !== "string") fail(`bad --sfx value: ${spec}`);
    const parts = spec.split("@");
    if (parts.length < 2) fail(`bad --sfx value (want <file>@<seconds>[@<volume>]): ${spec}`);
    let volume = 1;
    if (parts.length >= 3) {
      volume = Number(parts.pop());
      if (!Number.isFinite(volume)) fail(`bad --sfx volume in: ${spec}`);
    }
    const at = parts.pop();
    const file = parts.join("@");
    if (!file || !at) fail(`bad --sfx value (want <file>@<seconds>[@<volume>]): ${spec}`);
    return { file, at, volume };
  });
}

// Parse --clip specs: <file>@<seconds|MM:SS>[@<duration>]. Split from
// the right, so a file path may itself contain "@". The time strings
// are left as-is for core.parseTime (MM:SS works); duration defaults
// to the clip's own length (clamped to the main video in core).
function parseBrollClipSpecs(raw) {
  if (raw === undefined) return [];
  const specs = Array.isArray(raw) ? raw : [raw];
  return specs.map((spec) => {
    if (typeof spec !== "string") fail(`bad --clip value: ${spec}`);
    const parts = spec.split("@");
    if (parts.length < 2) fail(`bad --clip value (want <file>@<seconds>[@<duration>]): ${spec}`);
    let duration = null;
    if (parts.length >= 3) duration = parts.pop();
    const at = parts.pop();
    const file = parts.join("@");
    if (!file || !at) fail(`bad --clip value (want <file>@<seconds>[@<duration>]): ${spec}`);
    return { file, at, duration };
  });
}

// Parse --span specs: <start>-<end>@<speed>, times in seconds or
// MM:SS. Split speed from the right on "@", then split the range on
// "-" (MM:SS uses ":", so "-" is unambiguous here).
function parseFastForwardSpanSpecs(raw) {
  if (raw === undefined) return [];
  const specs = Array.isArray(raw) ? raw : [raw];
  return specs.map((spec) => {
    if (typeof spec !== "string") fail(`bad --span value: ${spec}`);
    const atIdx = spec.lastIndexOf("@");
    if (atIdx < 0) fail(`bad --span value (want <start>-<end>@<speed>): ${spec}`);
    const speed = spec.slice(atIdx + 1).trim();
    const range = spec.slice(0, atIdx);
    const dashIdx = range.indexOf("-");
    if (dashIdx < 0) fail(`bad --span value (want <start>-<end>@<speed>): ${spec}`);
    const start = range.slice(0, dashIdx).trim();
    const end = range.slice(dashIdx + 1).trim();
    if (!start || !end || !speed) fail(`bad --span value (want <start>-<end>@<speed>): ${spec}`);
    return { start, end, speed: Number(speed) };
  });
}

function needOutput(opts) {
  if (!opts.output) fail("missing required option: -o <output>");
  return opts.output;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") { printHelp(); return; }
  if (cmd === "--version" || cmd === "-v") { console.log(`mediakit ${VERSION}`); return; }
  if (!COMMANDS[cmd]) fail(`unknown command: ${cmd}\nRun 'mediakit --help' to list commands.`);

  const { positional, opts } = parseArgs(rest);
  if (opts.help) { printHelp(cmd); return; }
  validateOpts(cmd, opts, rest);
  // Audit hook: every dispatched CLI tool call is recorded (tool,
  // args hash + redacted copy, input/output files + SHA-256,
  // duration, status) — the CLI side of the operation envelope.
  // Usage errors that fail() inside the switch exit the process
  // directly and are NOT recorded: only calls that actually ran are
  // audited. `mcp` returns early below (the server records its own
  // calls), and --help/--version never reach here.
  const cliStartedAt = Date.now();
  const cliArgs = { input: positional[0] ?? null, options: opts };

  const input = positional[0];
  const needInput = (label = "input") => {
    if (!input) fail(`missing ${label} file`);
    return input;
  };

  let result;
  try {
    switch (cmd) {
      case "probe":
        result = await core.probe(needInput());
        break;
      case "trim": {
        result = await core.trim({
          input: needInput(), output: needOutput(opts),
          start: opts.start ?? 0,
          duration: opts.duration ?? null,
          end: opts.end ?? null,
          streamCopy: opts.stream_copy === true,
          snapToKeyframe: opts.snap === true,
          snapToBeat: opts.snap_beat === true,
          snapBeatMethod: opts.snap_beat_method ?? "grid",
          smartCut: opts.smart_cut === true,
          edgeBuffer: numOpt(opts, "edge_buffer") ?? 0,
          checkFrames: opts.check_frames !== false,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "fit": {
        if (opts.duration === undefined) fail("missing required option: --duration <s|MM:SS>");
        result = await core.fitDuration({
          input: needInput(), output: needOutput(opts),
          duration: opts.duration,
          method: opts.method ?? "speed",
          maxFps: numOpt(opts, "max_fps") ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "crop":
        result = await core.crop({
          input: needInput(), output: needOutput(opts),
          width: numOpt(opts, "width"), height: numOpt(opts, "height"),
          x: numOpt(opts, "x") ?? 0, y: numOpt(opts, "y") ?? 0,
          dryRun: opts.dry_run === true,
        });
        break;
      case "resize":
        result = await core.resize({
          input: needInput(), output: needOutput(opts),
          width: numOpt(opts, "width") ?? null, height: numOpt(opts, "height") ?? null,
          keepAspect: opts.keep_aspect !== false,
          preset: opts.preset ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      case "extract-audio":
        result = await core.extractAudio({
          input: needInput(), output: needOutput(opts), format: opts.format ?? null,
          whisper: opts.whisper === true,
          channel: numOpt(opts, "channel") ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      case "extract-frame":
        result = await core.extractFrame({
          input: needInput(), output: needOutput(opts),
          timestamp: numOpt(opts, "timestamp") ?? 0,
        });
        break;
      case "thumbnail":
        result = await core.thumbnail({
          input: needInput(), output: needOutput(opts),
          frames: numOpt(opts, "frames") ?? 6,
          columns: numOpt(opts, "columns") ?? 3,
          width: numOpt(opts, "width") ?? 320,
          timestamps: opts.timestamps ?? true,
          header: opts.header === true,
          startDelayPercent: numOpt(opts, "start_delay_percent") ?? 0,
          endDelayPercent: numOpt(opts, "end_delay_percent") ?? 0,
          timestampsList: opts.timestamps_list === undefined ? null : String(opts.timestamps_list).split(",").map((s) => s.trim()).filter(Boolean),
          sharpest: opts.sharpest === true,
          sharpestSamples: numOpt(opts, "sharpest_samples") ?? 5,
        });
        break;
      case "loudness":
        result = await core.loudness({
          input: needInput(), output: needOutput(opts),
          targetLufs: numOpt(opts, "target_lufs") ?? -14,
          format: opts.format ?? null,
          compressor: opts.compressor === true ? { threshold_db: numOpt(opts, "compressor_threshold") ?? -24, ratio: numOpt(opts, "compressor_ratio") ?? 4 } : null,
          dryRun: opts.dry_run === true,
        });
        break;
      case "concat":
        if (positional.length < 2) fail("concat needs at least 2 input files");
        result = await core.concat({
          inputs: positional, output: needOutput(opts),
          videoCodec: opts.video_codec ?? "libx264",
          audioCodec: opts.audio_codec ?? "aac",
          transition: opts.transition ?? null,
          transitionDuration: numOpt(opts, "transition_duration") ?? 1,
          fast: opts.fast === true ? true : opts.fast === false ? false : null,
          dryRun: opts.dry_run === true,
        });
        break;
      case "frames":
        result = await core.extractFrames({
          input: needInput(), outputDir: needOutput(opts),
          count: numOpt(opts, "count") ?? 6,
          format: opts.format ?? "png",
          width: numOpt(opts, "width") ?? null,
          sharpest: opts.sharpest === true,
          sharpestSamples: numOpt(opts, "sharpest_samples") ?? 5,
        });
        break;
      case "extract-frames":
        result = await core.extractFramesSequence({
          input: needInput(), outputDir: needOutput(opts),
          format: opts.format ?? "png",
          fps: numOpt(opts, "fps") ?? null,
          start: opts.start ?? null,
          end: opts.end ?? null,
          width: numOpt(opts, "width") ?? null,
          quality: numOpt(opts, "quality") ?? null,
          dedup: numOpt(opts, "dedup") ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      case "export-gif":
        result = await core.exportGif({
          input: needInput(), output: needOutput(opts),
          start: opts.start ?? null,
          end: opts.end ?? null,
          fps: numOpt(opts, "fps") ?? null,
          width: numOpt(opts, "width") ?? null,
          maxSizeMb: numOpt(opts, "max_size_mb") ?? 10,
          dryRun: opts.dry_run === true,
        });
        break;
      case "burn-captions": {
        if (opts.captions && opts.words_file) fail("burn-captions takes --captions or --words-file, not both");
        if (!opts.captions && !opts.words_file) fail("missing required option: --captions <file.srt|ass|vtt> or --words-file <words.json>");
        result = await core.burnCaptions({
          input: needInput(), output: needOutput(opts),
          captions: opts.captions ?? null, wordsFile: opts.words_file ?? null, fontSize: numOpt(opts, "font_size") ?? null,
          marginV: numOpt(opts, "margin_v") ?? null,
          style: opts.style ?? null, outlineColor: opts.outline_color ?? "black",
          maxLines: numOpt(opts, "max_lines") ?? null,
          platform: opts.platform ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "reframe":
        result = await core.reframe({
          input: needInput(), output: needOutput(opts),
          width: numOpt(opts, "width") ?? 1080,
          height: numOpt(opts, "height") ?? 1920,
          mode: opts.mode ?? "crop",
          x: numOpt(opts, "x") ?? null,
          y: numOpt(opts, "y") ?? null,
          anchor: opts.anchor ?? null,
          blur: numOpt(opts, "blur") ?? 20,
          dryRun: opts.dry_run === true,
        });
        break;
      case "qa-report":
        result = await core.qaReport({
          input: needInput(), target: opts.target ?? "any",
          expectedDuration: opts.expected_duration ?? null,
        });
        break;
      case "check": {
        const wantContent = opts.content === true;
        const hasRange = opts.start !== undefined || opts.end !== undefined || opts.peak_threshold !== undefined;
        if (hasRange && !wantContent) fail("--start/--end/--peak-threshold need --content (they only affect the content scan)");
        if (opts.baseline !== undefined && !wantContent) fail("--baseline needs --content (it only forgives spans the content scan found)");
        if (opts.palette !== undefined && opts.palette_brand !== undefined) fail("--palette and --palette-brand are mutually exclusive");
        result = await core.check({
          input: needInput(), platform: opts.platform ?? "tiktok",
          expectedDuration: opts.expected_duration ?? null,
          content: wantContent,
          contentStart: opts.start ?? null,
          contentEnd: opts.end ?? null,
          peakThresholdDb: numOpt(opts, "peak_threshold") ?? -1,
          baseline: opts.baseline ?? null,
          faststart: opts.faststart === true,
          decodedWork: opts.decoded_work === true,
          palette: opts.palette ?? null,
          paletteBrand: opts.palette_brand ?? null,
          policy: opts.policy ?? null,
          stamp: opts.stamp === true,
          useStamp: opts.use_stamp === true,
        });
        break;
      }
      case "convert":
        result = await core.convert({
          input: needInput(), output: needOutput(opts),
          videoCodec: opts.video_codec ?? null,
          audioCodec: opts.audio_codec ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          preset: opts.preset ?? "medium",
          gop: numOpt(opts, "gop") ?? null,
          gopSeconds: numOpt(opts, "gop_seconds") ?? null,
          dryRun: opts.dry_run === true,
          encoder: opts.encoder ?? null,
          width: numOpt(opts, "width") ?? null,
          height: numOpt(opts, "height") ?? null,
          fps: numOpt(opts, "fps") ?? null,
          videoBitrateKbps: numOpt(opts, "video_bitrate_kbps") ?? null,
          audioBitrateKbps: numOpt(opts, "audio_bitrate_kbps") ?? null,
          audioSampleRate: numOpt(opts, "audio_sample_rate") ?? null,
          audioChannels: numOpt(opts, "audio_channels") ?? null,
        });
        break;
      case "normalize":
        result = await core.normalize({
          input: needInput(), output: needOutput(opts),
          width: numOpt(opts, "width") ?? null,
          height: numOpt(opts, "height") ?? null,
          fps: numOpt(opts, "fps") ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          preset: opts.preset ?? "medium",
          targetLufs: numOpt(opts, "target_lufs") ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      case "grade": {
        const cdlSlope = tripleOpt(opts, "cdl_slope");
        const cdlOffset = tripleOpt(opts, "cdl_offset");
        const cdlPower = tripleOpt(opts, "cdl_power");
        const cdlSaturation = numOpt(opts, "cdl_saturation");
        const cdl = (cdlSlope !== undefined || cdlOffset !== undefined || cdlPower !== undefined || cdlSaturation !== undefined)
          ? { slope: cdlSlope, offset: cdlOffset, power: cdlPower, saturation: cdlSaturation }
          : null;
        result = await core.grade({
          input: needInput(), output: needOutput(opts),
          preset: opts.preset ?? null,
          filter: opts.filter ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          cdl,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "make-loopable":
        result = await core.makeLoopable({
          input: needInput(), output: needOutput(opts),
          overlap: numOpt(opts, "overlap") ?? 0.5,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "freeze":
        result = await core.freezeFrame({
          input: needInput(), output: needOutput(opts),
          at: opts.at ?? null,
          hold: numOpt(opts, "hold") ?? 2,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "fastforward": {
        const spanSpecs = parseFastForwardSpanSpecs(opts.span);
        if (!spanSpecs.length) fail("missing required option: --span <start>-<end>@<speed> (repeatable)");
        result = await core.fastForwardClip({
          input: needInput(), output: needOutput(opts),
          segments: spanSpecs,
          badge: opts.badge !== false,
          label: opts.label ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "reverse":
        result = await core.reverseClip({
          input: needInput(), output: needOutput(opts),
          audio: opts.audio !== false,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "rotate":
        result = await core.rotateClip({
          input: needInput(), output: needOutput(opts),
          angle: numOpt(opts, "angle") ?? null,
          flip: opts.flip ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
          metadataOnly: opts.metadata_only === true,
        });
        break;
      case "boomerang":
        result = await core.boomerangClip({
          input: needInput(), output: needOutput(opts),
          audio: opts.audio !== false,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "chroma-key":
        result = await core.chromaKey({
          input: needInput(), output: needOutput(opts),
          color: opts.color ?? "00FF00",
          similarity: numOpt(opts, "similarity") ?? 0.1,
          blend: numOpt(opts, "blend") ?? 0.0,
          background: opts.background ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "zoom-pan":
        result = await core.zoomPan({
          input: needInput(), output: needOutput(opts),
          duration: numOpt(opts, "duration") ?? 5,
          fps: numOpt(opts, "fps") ?? 30,
          zoomFrom: numOpt(opts, "zoom_from") ?? 1,
          zoomTo: numOpt(opts, "zoom_to") ?? 1.5,
          focusX: numOpt(opts, "focus_x") ?? 0.5,
          focusY: numOpt(opts, "focus_y") ?? 0.5,
          focusEndX: numOpt(opts, "focus_end_x") ?? null,
          focusEndY: numOpt(opts, "focus_end_y") ?? null,
          width: numOpt(opts, "width") ?? 1280,
          height: numOpt(opts, "height") ?? 720,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
          eventsFile: opts.events_file ?? null,
          zoom: numOpt(opts, "zoom") ?? 2,
          chainGapSeconds: numOpt(opts, "chain_gap") ?? 2.5,
          transitionSeconds: numOpt(opts, "transition") ?? 0.3,
          preLeadSeconds: numOpt(opts, "pre_lead") ?? 0.2,
          panSeconds: numOpt(opts, "pan") ?? 0.25,
          holdSeconds: numOpt(opts, "hold") ?? 0.8,
        });
        break;
      case "download":
        result = await core.downloadMedia({
          url: needInput("URL"),
          output: needOutput(opts),
          maxSizeMb: numOpt(opts, "max_size_mb") ?? 500,
          timeoutSeconds: numOpt(opts, "timeout_seconds") ?? 300,
          cache: opts.cache === true,
          cacheDir: opts.cache_dir ?? null,
          maxRetries: numOpt(opts, "max_retries") ?? 3,
          rateLimitRps: numOpt(opts, "rate_limit_rps") ?? null,
          license: opts.license ?? null,
          licensePolicyFile: opts.license_policy_file ?? null,
        });
        break;
      case "image-to-video":
        result = await core.imageToVideo({
          input: needInput(), output: needOutput(opts),
          duration: numOpt(opts, "duration") ?? 5,
          fps: numOpt(opts, "fps") ?? 30,
          width: numOpt(opts, "width") ?? null,
          height: numOpt(opts, "height") ?? null,
          audio: opts.audio ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "slideshow": {
        const hasGlob = !!opts.images_glob;
        if (hasGlob && positional.length) fail("slideshow takes either image files or --images-glob, not both");
        if (!hasGlob && positional.length < 2) fail("slideshow needs at least 2 image files");
        const durations = opts.durations ? String(opts.durations).split(",").map((s) => {
          const n = Number(s.trim());
          if (!Number.isFinite(n)) fail(`--durations has a non-number entry: ${s}`);
          return n;
        }) : null;
        const transitions = opts.transitions ? String(opts.transitions).split(",").map((s) => {
          const name = s.trim();
          if (!name) fail("--transitions has an empty entry");
          return name;
        }) : null;
        const transitionDurations = opts.transition_durations ? String(opts.transition_durations).split(",").map((s) => {
          const n = Number(s.trim());
          if (!Number.isFinite(n)) fail(`--transition-durations has a non-number entry: ${s}`);
          return n;
        }) : null;
        result = await core.slideshow({
          images: hasGlob ? null : positional, imagesGlob: hasGlob ? String(opts.images_glob) : null, output: needOutput(opts),
          duration: numOpt(opts, "duration") ?? 3,
          durations,
          transition: opts.transition ?? "fade",
          transitionDuration: numOpt(opts, "transition_duration") ?? 1,
          transitions,
          transitionDurations,
          fps: numOpt(opts, "fps") ?? 30,
          width: numOpt(opts, "width") ?? 1280,
          height: numOpt(opts, "height") ?? 720,
          audio: opts.audio ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "interpolate":
        result = await core.interpolate({
          input: needInput(), output: needOutput(opts),
          fps: numOpt(opts, "fps"),
          mode: opts.mode ?? "blend",
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "denoise":
        result = await core.denoise({
          input: needInput(), output: needOutput(opts),
          filter: opts.filter ?? "hqdn3d",
          strength: numOpt(opts, "strength") ?? 0.5,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "segment":
        result = await core.segment({
          input: needInput(), outputDir: needOutput(opts),
          segmentTime: numOpt(opts, "segment_time") ?? 6,
          playlist: opts.playlist ?? "index.m3u8",
          segmentPrefix: opts.segment_prefix ?? "seg",
          reencode: opts.reencode === true,
          crf: numOpt(opts, "crf") ?? 23,
          dryRun: opts.dry_run === true,
        });
        break;
      case "silence": {
        const detectOnly = opts.detect_only === true;
        result = await core.silence({
          input: needInput(),
          output: detectOnly ? null : needOutput(opts),
          thresholdDb: numOpt(opts, "threshold_db") ?? -40,
          minDuration: numOpt(opts, "min_duration") ?? 0.5,
          margin: numOpt(opts, "margin") ?? 0.2,
          detectOnly,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "cropdetect":
        result = await core.cropdetect({
          input: needInput(),
          frames: numOpt(opts, "frames") ?? 30,
          limit: numOpt(opts, "limit") ?? 24,
        });
        break;
      case "package":
        result = await core.packageDelivery({
          input: needInput(), output: needOutput(opts),
          captions: opts.captions ?? null,
          platform: opts.platform ?? null,
        });
        break;
      case "compress":
        result = await core.compress({
          input: needInput(), output: needOutput(opts),
          quality: opts.quality ?? "medium",
          maxWidth: numOpt(opts, "max_width") ?? null,
          crf: numOpt(opts, "crf") ?? null,
          preset: opts.preset ?? null,
          targetSizeMb: numOpt(opts, "target_size") ?? null,
          resolutionLadder: opts.resolution_ladder === false ? false : true,
          qualityProof: opts.quality_proof === false ? false : true,
          dryRun: opts.dry_run === true,
        });
        break;
      case "receipt":
        result = await core.receipt({
          input: needInput(), output: needOutput(opts),
          platform: opts.platform ?? null,
        });
        break;
      case "convert-captions":
        result = await core.convertCaptions({
          input: needInput(), output: needOutput(opts),
        });
        break;
      case "generate-srt": {
        if (opts.cues_file && opts.words_file) fail("generate-srt takes --cues-file or --words-file, not both");
        if (!opts.cues_file && !opts.words_file) fail("missing required option: --cues-file <cues.json> or --words-file <words.json>");
        const { readFile } = await import("node:fs/promises");
        const file = opts.cues_file ?? opts.words_file;
        let parsed;
        try {
          parsed = JSON.parse(await readFile(file, "utf8"));
        } catch (e) {
          fail(`could not read JSON ${file}: ${e.message}`);
        }
        if (opts.cues_file) {
          const cues = Array.isArray(parsed) ? parsed : parsed.cues;
          result = await core.generateSrt({ cues, output: needOutput(opts) });
        } else {
          const words = Array.isArray(parsed) ? parsed : parsed.words;
          result = await core.generateSrt({ words, output: needOutput(opts) });
        }
        break;
      }
      case "chunk-captions": {
        if (!opts.words_file) fail("missing required option: --words-file <words.json>");
        const { readFile } = await import("node:fs/promises");
        let parsed;
        try {
          parsed = JSON.parse(await readFile(opts.words_file, "utf8"));
        } catch (e) {
          fail(`could not read JSON ${opts.words_file}: ${e.message}`);
        }
        const words = Array.isArray(parsed) ? parsed : parsed.words;
        result = await core.chunkCaptionsFile({
          words, output: needOutput(opts),
          maxWords: numOpt(opts, "max_words") ?? 6,
          maxChars: numOpt(opts, "max_chars") ?? 84,
          maxSeconds: numOpt(opts, "max_seconds") ?? 3.5,
          pauseSeconds: numOpt(opts, "pause_seconds") ?? 0.4,
          splitOnPunctuation: opts.split_on_punctuation !== false,
        });
        break;
      }
      case "publish-kit": {
        if (!opts.thumbnail) fail("missing required option: --thumbnail <thumb.png>");
        if (!opts.kit_file) fail("missing required option: --kit-file <kit.json>");
        const { readFile } = await import("node:fs/promises");
        let kit;
        try {
          kit = JSON.parse(await readFile(opts.kit_file, "utf8"));
        } catch (e) {
          fail(`could not read kit JSON ${opts.kit_file}: ${e.message}`);
        }
        result = await core.publishKit({
          input: needInput(),
          thumbnail: opts.thumbnail,
          outputDir: needOutput(opts),
          style: opts.style ?? null,
          titles: kit.titles,
          description: kit.description,
          tags: kit.tags,
          pinnedComment: kit.pinned_comment ?? kit.pinnedComment,
          chapters: kit.chapters ?? null,
        });
        break;
      }
      case "transcribe":
        result = await core.transcribe({
          input: needInput(), output: needOutput(opts),
          model: opts.model ?? null,
          language: opts.language ?? "auto",
          engine: opts.engine ?? "auto",
          chunk_seconds: numOpt(opts, "chunk_seconds") ?? null,
          word_timestamps: opts.word_timestamps === true,
        });
        break;
      case "cut-words": {
        if (!opts.words_file) fail("missing required option: --words-file <words.json>");
        result = await core.cutWords({
          input: needInput(), output: opts.dry_run === true ? null : needOutput(opts),
          wordsFile: opts.words_file,
          remove: opts.remove ?? null,
          fillers: opts.fillers === true,
          indices: opts.indices ?? null,
          keep: opts.keep ?? null,
          padBefore: numOpt(opts, "pad_before") ?? 0.06,
          padAfter: numOpt(opts, "pad_after") ?? 0.12,
          minKeep: numOpt(opts, "min_keep") ?? 0.2,
          edgeBuffer: numOpt(opts, "edge_buffer") ?? 0,
          snapToPause: opts.snap_to_pause === true,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "remove-retakes": {
        if (!opts.words_file) fail("missing required option: --words-file <words.json>");
        if (opts.keep !== undefined && opts.keep !== "first" && opts.keep !== "last") fail(`--keep must be "first" or "last", got: ${opts.keep}`);
        result = await core.removeRetakes({
          input: needInput(), output: opts.detect_only === true ? null : needOutput(opts),
          wordsFile: opts.words_file,
          minWords: numOpt(opts, "min_words") ?? 3,
          maxGapWords: numOpt(opts, "max_gap_words") ?? 8,
          maxGapSeconds: numOpt(opts, "max_gap_seconds") ?? 5,
          keep: opts.keep ?? "last",
          padBefore: numOpt(opts, "pad_before") ?? 0.06,
          padAfter: numOpt(opts, "pad_after") ?? 0.12,
          minKeep: numOpt(opts, "min_keep") ?? 0.2,
          snapToPause: opts.snap_to_pause === true,
          detectOnly: opts.detect_only === true,
        });
        break;
      }
      case "smart-cut": {
        if (!opts.words_file) fail("missing required option: --words-file <words.json>");
        result = await core.smartCut({
          input: needInput(), output: opts.detect_only === true ? null : needOutput(opts),
          wordsFile: opts.words_file,
          minGap: numOpt(opts, "min_gap") ?? 0.45,
          aggressiveness: numOpt(opts, "aggressiveness") ?? 0.5,
          fillers: opts.fillers ?? null,
          minKeep: numOpt(opts, "min_keep") ?? 0.2,
          contextualGate: opts.contextual_gate !== false,
          minSegment: numOpt(opts, "min_segment") ?? 0,
          snapToPause: opts.snap_to_pause === true,
          detectOnly: opts.detect_only === true,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "clean-voice": {
        result = await core.cleanVoice({
          input: needInput(), output: opts.diagnose === true ? null : needOutput(opts),
          targetLufs: numOpt(opts, "target_lufs") ?? -14,
          steps: opts.steps ?? null,
          diagnose: opts.diagnose === true,
          ab: opts.ab === true,
          window: opts.window ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "search-words": {
        if (!opts.words_file) fail("missing required option: --words-file <words.json>");
        if (!opts.query) fail("missing required option: --query \"<phrase>\"");
        result = await core.searchWords({
          wordsFile: opts.words_file,
          query: opts.query,
          padBefore: numOpt(opts, "pad_before") ?? 0.5,
          padAfter: numOpt(opts, "pad_after") ?? 0.5,
          maxMatches: numOpt(opts, "max_matches") ?? 10,
          contextWords: numOpt(opts, "context_words") ?? 5,
        });
        break;
      }
      case "mix": {
        if (!opts.music) fail("missing required option: --music <file>");
        result = await core.mix({
          voice: needInput(), music: opts.music, output: needOutput(opts),
          musicVolume: numOpt(opts, "music_volume") ?? 0.3,
          duckDb: numOpt(opts, "duck_db") ?? 12,
          attackMs: numOpt(opts, "attack_ms") ?? 100,
          releaseMs: numOpt(opts, "release_ms") ?? 400,
          voiceLufs: numOpt(opts, "voice_lufs") ?? -16,
          targetLufs: numOpt(opts, "target_lufs") ?? -14,
          master: opts.master !== false,
          dryRun: opts.dry_run === true,
          sfx: parseSfxSpecs(opts.sfx),
        });
        break;
      }
      case "overlay": {
        if (!opts.image) fail("missing required option: --image <logo.png>");
        result = await core.overlayImage({
          input: needInput(), overlay: opts.image, output: needOutput(opts),
          position: opts.position ?? "top-right",
          margin: numOpt(opts, "margin") ?? 24,
          width: numOpt(opts, "width") ?? null,
          opacity: numOpt(opts, "opacity") ?? 1,
          start: numOpt(opts, "start") ?? null,
          end: numOpt(opts, "end") ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "pip": {
        if (!opts.pip) fail("missing required option: --pip <video>");
        result = await core.pictureInPicture({
          input: needInput(), pip: opts.pip, output: needOutput(opts),
          position: opts.position ?? "bottom-right",
          margin: numOpt(opts, "margin") ?? 24,
          width: numOpt(opts, "width") ?? null,
          scale: numOpt(opts, "scale") ?? 0.25,
          opacity: numOpt(opts, "opacity") ?? 1,
          start: opts.start ?? null,
          end: opts.end ?? null,
          audio: opts.audio ?? "main",
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "broll": {
        const clipSpecs = parseBrollClipSpecs(opts.clip);
        if (!clipSpecs.length) fail("missing required option: --clip <file>@<seconds>[@<duration>] (repeatable)");
        const position = opts.position ?? "fullscreen";
        result = await core.insertBroll({
          input: needInput(), output: needOutput(opts),
          clips: clipSpecs.map((s) => ({
            file: s.file, at: s.at,
            duration: s.duration ?? null,
            position,
            scale: position === "fullscreen" ? null : (numOpt(opts, "scale") ?? 0.5),
            width: position === "fullscreen" ? null : (numOpt(opts, "width") ?? null),
            margin: numOpt(opts, "margin") ?? 24,
            fade: numOpt(opts, "fade") ?? 0,
          })),
          audio: opts.audio ?? "main",
        });
        break;
      }
      case "titlecard":
        result = await core.titlecard({
          text: needInput("text"), output: needOutput(opts),
          width: numOpt(opts, "width") ?? 1080,
          height: numOpt(opts, "height") ?? 1920,
          fontSize: numOpt(opts, "font_size") ?? null,
          textColor: opts.text_color ?? null,
          boxColor: opts.box_color ?? null,
          style: opts.style ?? null,
          brand: opts.brand ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      case "intro":
        result = await core.intro({
          text: needInput("text"), output: needOutput(opts),
          width: numOpt(opts, "width") ?? 1280,
          height: numOpt(opts, "height") ?? 720,
          duration: numOpt(opts, "duration") ?? 3,
          bgColor: opts.bg_color ?? null,
          textColor: opts.text_color ?? null,
          fontSize: numOpt(opts, "font_size") ?? null,
          fadeIn: numOpt(opts, "fade_in") ?? 0.5,
          fadeOut: numOpt(opts, "fade_out") ?? 0.5,
          style: opts.style ?? null,
          brand: opts.brand ?? null,
          dryRun: opts.dry_run === true,
        });
        break;
      case "social": {
        const platforms = opts.platforms
          ? String(opts.platforms).split(",").map((s) => s.trim()).filter(Boolean)
          : ["tiktok", "reels", "shorts"];
        result = await core.social({
          input: needInput(), outputDir: needOutput(opts),
          platforms,
          strategy: opts.strategy ?? "blur",
          targetLufs: numOpt(opts, "target_lufs") ?? -14,
          trimToMax: opts.trim_to_max !== false,
        });
        break;
      }
      case "scenes":
        result = await core.detectScenes({
          input: needInput(),
          threshold: numOpt(opts, "threshold") ?? null,
          detector: opts.detector ?? "ffmpeg",
          minSceneLen: numOpt(opts, "min_scene_len") ?? 15,
          flashFrames: numOpt(opts, "flash_frames") ?? 5,
          fades: opts.fades === true,
          fadeThreshold: numOpt(opts, "fade_threshold") ?? 20,
          minFadeFrames: numOpt(opts, "min_fade_frames") ?? 2,
        });
        break;
      case "measure-pace":
        result = await core.measurePace({
          input: needInput(),
          detector: opts.detector ?? "content",
          threshold: numOpt(opts, "threshold") ?? null,
          styleFile: opts.style_file ?? null,
          styleName: opts.style_name ?? null,
        });
        break;
      case "highlights":
        result = await core.findHighlights({
          input: needInput(),
          fps: numOpt(opts, "fps") ?? 2,
          threshold: numOpt(opts, "threshold") ?? 0.15,
          minSpanSeconds: numOpt(opts, "min_span") ?? 2,
          top: numOpt(opts, "top") ?? 5,
          thumbnailCount: numOpt(opts, "thumbnails") ?? 3,
        });
        break;
      case "keyframes":
        result = await core.listKeyframes({ input: needInput(), nearest: opts.nearest });
        break;
      case "audio-levels":
        result = await core.audioLevels({
          input: needInput(),
          bucketSeconds: numOpt(opts, "bucket") ?? 1,
          topN: numOpt(opts, "top") ?? 5,
          minGapSeconds: numOpt(opts, "min_gap") ?? 2,
        });
        break;
      case "motion":
        result = await core.measureMotion({
          input: needInput(),
          threshold: numOpt(opts, "threshold") ?? 0.001,
          minStillSeconds: numOpt(opts, "min_still_seconds") ?? 2,
          windowSeconds: numOpt(opts, "window") ?? 1,
          adaptive: opts.adaptive === true,
          adaptiveFactor: numOpt(opts, "adaptive_factor") ?? 2,
          adaptiveCap: numOpt(opts, "adaptive_cap") ?? 0.005,
          lagSeconds: numOpt(opts, "lag_seconds") ?? 0,
        });
        break;
      case "hook":
        result = await core.findHook({
          input: needInput(),
          duration: numOpt(opts, "duration") ?? 15,
          step: numOpt(opts, "step") ?? 0.5,
          top: numOpt(opts, "top") ?? 3,
          thresholdDb: numOpt(opts, "threshold_db") ?? -40,
          historyFile: opts.history_file ?? null,
          record: opts.record === true,
          historyOverlap: numOpt(opts, "history_overlap") ?? 0.5,
          snapQuiet: opts.snap_quiet !== false,
          snapWindowSeconds: numOpt(opts, "snap_window") ?? 5,
        });
        break;
      case "bpm":
        result = await core.detectBpm({
          input: needInput(),
          minBpm: numOpt(opts, "min_bpm") ?? 40,
          maxBpm: numOpt(opts, "max_bpm") ?? 240,
        });
        break;
      case "beat_grid":
        result = await core.detectBeatGrid({
          input: needInput(),
          minBpm: numOpt(opts, "min_bpm") ?? 40,
          maxBpm: numOpt(opts, "max_bpm") ?? 240,
          method: opts.method ?? "grid",
        });
        break;
      case "tempo_drift":
        result = await core.detectTempoDrift({
          input: needInput(),
          minBpm: numOpt(opts, "min_bpm") ?? 40,
          maxBpm: numOpt(opts, "max_bpm") ?? 240,
        });
        break;
      case "transitions":
        result = core.listTransitions({
          category: opts.category ?? null,
        });
        break;
      case "safety":
        result = listSafetyTiers();
        break;
      case "estimate-conversion":
        result = await core.estimateConversion({
          input: needInput(),
          videoCodec: opts.video_codec ?? "libx264",
          crf: numOpt(opts, "crf") ?? 23,
          preset: opts.preset ?? "medium",
          width: numOpt(opts, "width") ?? null,
          height: numOpt(opts, "height") ?? null,
          fps: numOpt(opts, "fps") ?? null,
          audioBitrateKbps: numOpt(opts, "audio_bitrate_kbps") ?? null,
          positions: numOpt(opts, "positions") ?? 2,
          shortSeconds: numOpt(opts, "short_seconds") ?? 2,
          longSeconds: numOpt(opts, "long_seconds") ?? 6,
        });
        break;
      case "release-checkpoint": {
        if (!positional[0]) fail("missing input: mediakit release-checkpoint <input> [--manifest film.json] [--receipt assemble-receipt.json]");
        result = await core.releaseCheckpoint({
          input: positional[0],
          manifest: opts.manifest ?? null,
          receipt: opts.receipt ?? null,
          platform: opts.platform ?? "tiktok",
          output: opts.output ?? null,
          sheet: opts.sheet !== false,
          sheetFrames: numOpt(opts, "sheet_frames") ?? 9,
        });
        break;
      }
      case "mux": {
        if (!positional[1]) fail("missing audio file");
        result = await core.mux({
          video: needInput("video"), audio: positional[1], output: needOutput(opts),
          audioOffsetSeconds: numOpt(opts, "audio_offset") ?? 0,
          shortest: opts.shortest === true,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "find": {
        if (opts.name === undefined) fail("missing required option: --name <text>");
        result = await core.findMedia({
          directory: needInput("directory"), name: opts.name,
          extensions: opts.extensions ?? null,
          maxResults: numOpt(opts, "max_results") ?? 20,
        });
        break;
      }
      case "svg-animate": {
        if (!opts.anim) fail("missing required option: --anim <animations.json>");
        const { readFile } = await import("node:fs/promises");
        let animJson;
        try {
          animJson = JSON.parse(await readFile(opts.anim, "utf8"));
        } catch (e) {
          fail(`could not read animations JSON ${opts.anim}: ${e.message}`);
        }
        const animations = Array.isArray(animJson) ? animJson : animJson.animations;
        result = await core.svgAnimate({
          svg: needInput("svg"), animations, output: needOutput(opts),
          duration: numOpt(opts, "duration") ?? 3,
          fps: numOpt(opts, "fps") ?? 30,
          width: numOpt(opts, "width") ?? null,
          height: numOpt(opts, "height") ?? null,
          background: opts.background ?? "FFFFFF",
        });
        break;
      }
      case "batch": {
        if (!positional[0]) fail("missing operation: loudness|resize|reframe|compress|convert|extract-audio|reverse|rotate|boomerang|make-loopable|freeze|grade|fit|trim|silence|chroma-key|cut-words|remove-retakes|smart-cut|clean-voice|slideshow|hook|audio-levels|search-words|highlights", 2);
        if (!opts.pattern) fail("missing required option: --pattern <glob>", 2);
        if (!opts.input_dir) fail("missing required option: --input-dir <dir>", 2);
        const opName = positional[0].replace(/-/g, "_");
        let batchArgs = {};
        if (opts.args_json !== undefined) {
          try {
            batchArgs = JSON.parse(String(opts.args_json));
          } catch (e) {
            fail(`bad --args-json: ${e.message}`, 2);
          }
          if (batchArgs === null || typeof batchArgs !== "object" || Array.isArray(batchArgs)) {
            fail("--args-json must be a JSON object", 2);
          }
        }
        result = await core.batch({
          operation: opName,
          pattern: opts.pattern,
          inputDir: opts.input_dir,
          outputDir: opts.output ?? opts.output_dir ?? fail("missing required option: -o <output-dir>", 2),
          args: batchArgs,
          jobs: numOpt(opts, "jobs") ?? 1,
          outputSuffix: opts.suffix ?? null,
          cache: opts.cache !== false,
          stopOnError: opts.stop_on_error === true,
          timeoutSeconds: numOpt(opts, "timeout") ?? 1800,
          maxFiles: numOpt(opts, "max_files") ?? 200,
          dryRun: opts.dry_run === true,
        });
        break;
      }
      case "assemble": {
        if (!positional[0]) fail("missing manifest file: mediakit assemble <film.json> --mode validate|plan|preview|approve|render [-o <output-dir>]");
        if (opts.async === true) {
          if ((opts.mode ?? "validate") !== "render") fail("assemble --async needs --mode render (validate/plan/preview/approve are already fast)");
          result = await core.startAssembleJob({
            manifestPath: positional[0],
            outputDir: opts.output ?? null,
            force: opts.force === true,
            fromPlan: typeof opts.from_plan === "string" ? opts.from_plan : null,
            checkpointFile: typeof opts.checkpoint_file === "string" ? opts.checkpoint_file : null,
          });
          break;
        }
        const jobId = typeof opts.job_id === "string" ? opts.job_id : null;
        const jobDir = typeof opts.job_dir === "string" ? opts.job_dir : null;
        if ((jobId && !jobDir) || (!jobId && jobDir)) fail("--job-id and --job-dir must be given together (internal worker flags)");
        result = await core.assemble({
          manifestPath: positional[0],
          mode: opts.mode ?? "validate",
          outputDir: opts.output ?? null,
          previewSeconds: numOpt(opts, "preview_seconds") ?? 20,
          force: opts.force === true,
          onProgress: jobId ? async (p) => { await core.updateJobProgress(jobId, jobDir, p); } : null,
          jobId,
          jobDir,
          planFile: typeof opts.plan_file === "string" ? opts.plan_file : null,
          fromPlan: typeof opts.from_plan === "string" ? opts.from_plan : null,
          checkpointFile: typeof opts.checkpoint_file === "string" ? opts.checkpoint_file : null,
        });
        break;
      }
      case "export-timeline": {
        if (!positional[0]) fail("missing manifest file: mediakit export-timeline <film.json> -o <film.otio>");
        if (!opts.output) fail("missing required option: -o <film.otio> (output .otio path)");
        result = await core.exportTimeline({
          manifestPath: positional[0],
          output: opts.output,
        });
        break;
      }
      case "init": {
        if (!positional[0]) fail("missing project directory: mediakit init <dir> [--title <name>] [--preset vertical|horizontal|square|cinematic|vertical-60] [--brand <id>] [--force]");
        result = await core.initProject({
          dir: positional[0],
          title: opts.title ?? null,
          preset: opts.preset ?? "vertical",
          brand: opts.brand ?? null,
          force: opts.force === true,
        });
        break;
      }
      case "job": {
        if (opts.list === true) { result = await core.listJobs({}); break; }
        if (opts.admission === true) { result = await core.getJobAdmission(); break; }
        if (typeof opts.cancel === "string") { result = await core.cancelJob(opts.cancel); break; }
        if (!positional[0]) fail("missing job id: mediakit job <job-id> [--list] [--cancel <job-id>]");
        result = await core.getJob(positional[0]);
        break;
      }
      case "verify": {
        if (!positional[0]) fail("missing receipt file: mediakit verify <assemble-receipt.json> [--rerender] [-o <output-dir>]");
        result = await core.verifyRender({
          receipt: positional[0],
          rerender: opts.rerender === true,
          outputDir: opts.output ?? null,
        });
        break;
      }
      case "verify-cuts": {
        if (!positional[0] || !positional[1]) fail("missing manifest/video: mediakit verify-cuts <film.json> <video.mp4> [--tolerance 0.25]");
        result = await core.verifyAssembleCuts({
          manifestPath: positional[0],
          video: positional[1],
          tolerance: numOpt(opts, "tolerance") ?? 0.25,
          threshold: numOpt(opts, "threshold") ?? null,
          draftHeight: numOpt(opts, "draft_height") ?? 270,
          keepDraft: opts.keep_draft === true,
          strips: opts.strips === true,
          stripsDir: opts.strips_dir ?? null,
          audio: opts.audio === true,
          cutSheet: opts.cut_sheet === true,
          cutSheetPath: opts.cut_sheet_path ?? null,
        });
        break;
      }
      case "diagnose": {
        if (!positional[0]) fail("missing manifest file: mediakit diagnose <film.json>");
        result = await core.diagnoseFilm({
          manifestPath: positional[0],
          styleFile: opts.style_file ?? null,
          stamp: opts.stamp === true,
          useStamp: opts.use_stamp === true,
        });
        break;
      }
      case "list-templates":
        result = await core.listSceneTemplates({
          category: opts.category ?? null,
          faceSafe: opts.face_safe === undefined ? null : opts.face_safe === true,
          timingHint: opts.timing_hint ?? null,
          tag: opts.tag ?? null,
          template: opts.template ?? null,
          readiness: opts.readiness ?? null,
        });
        break;
      case "validate-template-package":
        if (!positional[0]) fail("missing package directory: mediakit validate-template-package <dir>");
        result = await core.validateTemplatePackage({ packagePath: positional[0] });
        break;
      case "validate-shot-spec":
        if (!positional[0]) fail("missing shot-spec file: mediakit validate-shot-spec <spec.json>");
        result = await core.validateShotSpecFile({ specFile: positional[0], baseDir: opts.base_dir ?? null });
        break;
      case "align-voice": {
        if (!positional[0]) fail("missing manifest file: mediakit align-voice <film.json>");
        result = await core.alignVoice({
          filmPath: positional[0],
          linesPath: opts.lines ?? null,
          thresholdDb: numOpt(opts, "threshold_db") ?? -40,
          minSilenceSeconds: numOpt(opts, "min_silence") ?? 0.25,
          snapWindowMs: numOpt(opts, "snap_window_ms") ?? 600,
          apply: opts.apply === true,
          outputPath: opts.output ?? null,
          expectedKey: opts.expected_key ?? null,
        });
        break;
      }
      case "chapters": {
        if (opts.words_file && positional[0]) fail("chapters takes exactly one source: --words-file <words.json> OR <input>, not both");
        if (!opts.words_file && !positional[0]) fail("chapters needs a source: mediakit chapters --words-file <words.json> OR mediakit chapters <input>");
        result = await core.autoChapters({
          wordsFile: opts.words_file ?? null,
          input: positional[0] ?? null,
          minGap: numOpt(opts, "min_gap") ?? 2,
          titleWords: numOpt(opts, "title_words") ?? 4,
          maxChapters: numOpt(opts, "max_chapters") ?? 32,
          thresholdDb: numOpt(opts, "threshold_db") ?? -40,
          minDuration: numOpt(opts, "min_duration") ?? 0.5,
          output: opts.output ?? null,
        });
        break;
      }
      case "manifest": {
        if (!positional[0]) fail("missing manifest file: mediakit manifest <manifest.json> [-o <output.mp4>]");
        result = await core.manifest({
          manifestPath: positional[0],
          output: opts.output ?? null,
          cache: opts.cache !== false,
          dryRun: opts.dry_run === true,
          keepIntermediates: opts.keep_intermediates === true,
        });
        break;
      }
      case "patch-manifest": {
        if (!positional[0]) fail("missing manifest file: mediakit patch-manifest <manifest.json> --expected-revision <n> --patch-file <patch.json>");
        if (opts.expected_revision === undefined) fail("missing required option: --expected-revision <n> (the revision last read from the file; absent = 0)");
        if (!opts.patch_file) fail("missing required option: --patch-file <patch.json> (JSON array of patch operations)");
        const { readFile } = await import("node:fs/promises");
        let patch;
        try {
          patch = JSON.parse(await readFile(opts.patch_file, "utf8"));
        } catch (e) {
          fail(`could not read patch JSON ${opts.patch_file}: ${e.message}`);
        }
        result = await core.patchManifest({
          manifestPath: positional[0],
          patch,
          expectedRevision: numOpt(opts, "expected_revision"),
          dryRun: opts.dry_run === true,
          leaseId: opts.lease_id ?? null,
        });
        break;
      }
      case "lease": {
        const action = positional[0];
        if (!["acquire", "release", "renew", "status"].includes(action)) fail("lease action must be acquire, release, renew or status: mediakit lease <action> <manifest.json> [--holder <id>] [--lease-id <id>] [--ttl <seconds>]");
        if (!positional[1]) fail(`missing manifest file: mediakit lease ${action} <manifest.json>`);
        if (action === "acquire") {
          if (!opts.holder) fail("missing required option: --holder <id> (who holds the lease)");
          result = await core.acquireEditLease({ manifestPath: positional[1], holder: opts.holder, ttlSeconds: numOpt(opts, "ttl") ?? null });
        } else if (action === "release") {
          if (!opts.lease_id) fail("missing required option: --lease-id <id> (the lease id from acquire)");
          result = await core.releaseEditLease({ manifestPath: positional[1], leaseId: opts.lease_id });
        } else if (action === "renew") {
          if (!opts.lease_id) fail("missing required option: --lease-id <id> (the lease id from acquire)");
          result = await core.renewEditLease({ manifestPath: positional[1], leaseId: opts.lease_id, ttlSeconds: numOpt(opts, "ttl") ?? null });
        } else {
          result = await core.editLeaseStatus({ manifestPath: positional[1] });
        }
        break;
      }
      case "determinism": {
        if (!positional[0]) fail("missing manifest file: mediakit determinism <manifest.json> [--runs 2]");
        result = await core.checkManifestDeterminism({
          manifestPath: positional[0],
          runs: numOpt(opts, "runs") ?? 2,
          keepOutputs: opts.keep_outputs === true,
        });
        break;
      }
      case "doctor":
        result = await core.doctor({ smoke: opts.smoke === true });
        break;
      case "audit": {
        if (opts.status !== undefined && opts.status !== "ok" && opts.status !== "error") fail(`--status must be "ok" or "error", got: ${opts.status}`);
        result = await queryAudit({
          limit: numOpt(opts, "limit") ?? 20,
          tool: opts.tool ?? null,
          status: opts.status ?? null,
          since: opts.since ?? null,
          verify: opts.verify === true,
        });
        break;
      }
      case "mcp": {
        // Hand off to the MCP server process (same stdio), or with
        // --http to the HTTP transport (same tools, REST + JSON-RPC).
        // The child is the server: forward termination signals to it
        // so killing this wrapper never orphans a server (an orphaned
        // HTTP server would keep holding its port).
        const { spawn } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");
        const spawnServer = (args) => {
          const child = spawn(process.execPath, args, { stdio: "inherit" });
          const stop = (signal) => { try { child.kill(signal); } catch { /* already gone */ } };
          process.on("SIGINT", () => stop("SIGINT"));
          process.on("SIGTERM", () => stop("SIGTERM"));
          child.on("exit", (code) => process.exit(code ?? 0));
          return child;
        };
        if (opts.http === true) {
          const port = numOpt(opts, "port") ?? 3000;
          const host = opts.host ?? "127.0.0.1";
          if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port must be 1-65535, got "${opts.port}"`);
          if (typeof host !== "string" || !host) fail(`--host must be an address, got "${opts.host}"`);
          const httpPath = fileURLToPath(new URL("../src/http.js", import.meta.url));
          spawnServer([httpPath, "--port", String(port), "--host", host]);
          return;
        }
        const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
        spawnServer([serverPath]);
        return;
      }
      default:
        fail(`unhandled command: ${cmd}`);
    }
  } catch (err) {
    await recordToolCall({
      tool: cmd, via: "cli", args: cliArgs, result: null,
      status: "error", errorCode: err.code ?? "ERROR",
      durationMs: Date.now() - cliStartedAt,
    });
    if (err instanceof core.MediaKitError) {
      // Same retry guidance as the MCP/HTTP envelope: whether the
      // identical call can help, and how long to wait when known.
      const info = core.errorRetryInfo(err);
      const wait = info.retry_after_seconds != null ? ` — retry in ~${info.retry_after_seconds}s` : "";
      // Same structured fixes as the envelope (lượt 140): one line
      // per fix, so a human reading stderr sees what to do instead
      // of just what failed. The retry fix carries the failed call
      // (cmd + cliArgs) so it can be re-issued verbatim.
      const explain = core.explainError(err, { tool: cmd, args: cliArgs });
      const fixesText = explain.fixes.map((f) => `\n  Fix (${f.kind}): ${f.label}`).join("");
      fail(`${err.message} [${err.code}] (retryable: ${info.retryable}${wait})${fixesText}`, 2);
    }
    fail(err.message, 2);
  }
  // The CLI is short-lived, so the record is awaited here (unlike
  // the MCP transports, which fire-and-forget into a long-lived
  // process) — otherwise the process could exit before the line lands.
  await recordToolCall({
    tool: cmd, via: "cli", args: cliArgs, result,
    status: "ok", durationMs: Date.now() - cliStartedAt,
  });
  // harken's batch summary line (stderr, so stdout stays pure JSON):
  // "batch complete: X done, Y cached, Z skipped, W failed (of N)".
  // A dry-run has no counts, so it prints nothing here.
  if (cmd === "batch" && result && result.dry_run !== true && typeof result.succeeded === "number") {
    console.error(`batch complete: ${result.succeeded} done, ${result.cached ?? 0} cached, ${result.skipped ?? 0} skipped, ${result.failed ?? 0} failed (of ${result.files_matched ?? result.results?.length ?? 0})`);
  }
  console.log(JSON.stringify(result, null, 2));
  // harken exit codes for batch: the summary's exit_code (0 = every
  // row done/cached/skipped, 1 = any row failed). Set exitCode rather
  // than process.exit() so the JSON above is flushed first. Input
  // errors already exited 2 via fail() / the catch below.
  if (cmd === "batch" && result && typeof result.exit_code === "number") process.exitCode = result.exit_code;
  // Same convention for the release checkpoint: a failed gate exits
  // 1, so a script can stop a delivery on it; a pass exits 0.
  if (cmd === "release-checkpoint" && result && result.verdict === "fail") process.exitCode = 1;
}

main();
