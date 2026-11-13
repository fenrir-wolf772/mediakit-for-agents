#!/usr/bin/env node
/**
 * mediakit — CLI front-end for the ffmpeg core.
 * Usage: mediakit <command> [args] [options]
 *        mediakit mcp            start the MCP server on stdio
 */
import * as core from "../src/core.js";

const VERSION = "0.1.0";

const COMMANDS = {
  probe: {
    usage: "mediakit probe <input>",
    desc: "Inspect a media file (duration, dimensions, codecs, streams).",
    args: [{ name: "input", required: true }],
    options: [],
  },
  trim: {
    usage: "mediakit trim <input> --start <s|MM:SS> (--duration <s|MM:SS> | --end <s|MM:SS>) -o <output> [--stream-copy] [--snap]",
    desc: "Cut a clip. Re-encodes by default (frame-accurate); --stream-copy is fast but keyframe-only. --snap (with --stream-copy) moves start/end onto the nearest keyframes. Times accept seconds or MM:SS.",
    args: [{ name: "input", required: true }],
    options: [
      ["--start", "Start time in seconds or MM:SS (default 0)"],
      ["--duration", "Clip length in seconds or MM:SS"],
      ["--end", "End time in seconds or MM:SS (alternative to --duration)"],
      ["--stream-copy", "Copy streams without re-encoding"],
      ["--snap", "Snap start/end to the nearest keyframes (needs --stream-copy)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  fit: {
    usage: "mediakit fit <input> --duration <s|MM:SS> -o <output> [--method speed|trim|loop] [--max-fps <n>]",
    desc: "Fit a file to an exact target duration. speed (default) speeds it up/down (factor 0.25-4x); trim cuts a longer source; loop repeats a shorter source. --max-fps caps the output frame rate (only ever lowers it). Times accept seconds or MM:SS.",
    args: [{ name: "input", required: true }],
    options: [
      ["--duration", "Target duration in seconds or MM:SS (required)"],
      ["--method", "speed (default) | trim | loop"],
      ["--max-fps", "Cap the output frame rate, 1-120 (only lowers fps, never raises it)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  crop: {
    usage: "mediakit crop <input> --width <px> --height <px> [--x <px>] [--y <px>] -o <output>",
    desc: "Crop a video to a rectangle.",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Crop width in pixels (required)"],
      ["--height", "Crop height in pixels (required)"],
      ["--x", "Left offset (default 0)"],
      ["--y", "Top offset (default 0)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  resize: {
    usage: "mediakit resize <input> [--width <px>] [--height <px>] [--preset 360p|480p|720p|1080p|2160p] [--no-keep-aspect] -o <output>",
    desc: "Resize a video. With --keep-aspect (default) the missing dimension follows the aspect ratio. --preset fits the frame inside a named box (e.g. 720p = 1280x720) and never upscales; it cannot be combined with --width/--height.",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Target width in pixels"],
      ["--height", "Target height in pixels"],
      ["--preset", "Named preset: 360p (640x360), 480p (854x480), 720p (1280x720), 1080p (1920x1080), 2160p (3840x2160)"],
      ["--no-keep-aspect", "Stretch to exact dimensions (needs both --width and --height)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "extract-audio": {
    usage: "mediakit extract-audio <input> -o <output.mp3|aac|wav|ogg|opus|flac> [--format <fmt>] [--whisper] [--channel <n>]",
    desc: "Extract the audio track. --whisper forces the Whisper ASR preset (16 kHz mono WAV) and renames the output to .wav when needed. --channel <n> (0-based) picks one channel out of a multi-channel input and returns it as mono.",
    args: [{ name: "input", required: true }],
    options: [
      ["--format", "Audio format (overrides output extension; ignored with --whisper)"],
      ["--whisper", "Whisper preset: 16 kHz mono WAV, the direct input for transcription"],
      ["--channel", "Channel index (0-based) to extract as mono from a multi-channel input"],
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
    usage: "mediakit thumbnail <input> -o <output.png|jpg> [--frames <n>] [--columns <n>] [--width <px>] [--no-timestamps]",
    desc: "Build a contact sheet of N evenly spaced frames. Each tile is labelled with its own timestamp in seconds by default — look at it before cutting or publishing.",
    args: [{ name: "input", required: true }],
    options: [
      ["--frames", "Number of frames (default 6)"],
      ["--columns", "Grid columns (default 3)"],
      ["--width", "Width of each tile in pixels (default 320)"],
      ["--no-timestamps", "Do not label tiles with timestamps"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  loudness: {
    usage: "mediakit loudness <input> -o <output> [--target-lufs <n>] [--format <fmt>]",
    desc: "Normalize loudness (default -14 LUFS, YouTube/Spotify standard).",
    args: [{ name: "input", required: true }],
    options: [
      ["--target-lufs", "Target loudness in LUFS (default -14)"],
      ["--format", "Audio format (overrides output extension)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  concat: {
    usage: "mediakit concat <input1> <input2> [input3...] -o <output> [--video-codec <c>] [--audio-codec <c>] [--transition fade|wipeleft|dissolve|...] [--transition-duration <s>] [--fast] [--no-fast]",
    desc: "Join 2+ media files into one. Auto-detects: identical clips are stream-copied (fast, lossless), differing clips are re-encoded. --fast requires identical clips (errors otherwise), --no-fast always re-encodes. --transition crossfades between clips instead of a hard cut. Per-clip trim: write an input as path@start-end (seconds or MM:SS, either side may be empty) — trims always re-encode, and --fast refuses them.",
    args: [{ name: "inputs", required: true, variadic: true }],
    options: [
      ["--video-codec", "Video codec (default libx264)"],
      ["--audio-codec", "Audio codec (default aac)"],
      ["--transition", "xfade transition between clips: fade, wipeleft, dissolve, circlecrop, ..."],
      ["--transition-duration", "Transition length in seconds (default 1, must be shorter than the shortest clip)"],
      ["--fast", "Require stream-copy: error if the clips differ (default is auto-detect)"],
      ["--no-fast", "Always re-encode, never stream-copy"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  frames: {
    usage: "mediakit frames <input> -o <directory> [--count <n>] [--format png|jpg|webp] [--width <px>]",
    desc: "Extract N evenly spaced frames as separate images (frame-001.png, ...) so you can look at a video before cutting it.",
    args: [{ name: "input", required: true }],
    options: [
      ["--count", "Number of frames (default 6)"],
      ["--format", "Image format png (default) | jpg | webp"],
      ["--width", "Scale frames to this width (keeps aspect)"],
      ["-o, --output", "Output directory (required, created if needed)"],
    ],
  },
  "export-gif": {
    usage: "mediakit export-gif <input> -o <output.gif> [--start <s|MM:SS>] [--end <s|MM:SS>] [--fps 15] [--width 640] [--max-size-mb 10]",
    desc: "Export a clip (or segment) as an animated GIF with a two-pass palette. Fits under --max-size-mb (default 10 MB, the GitHub README limit; Slack auto-plays only under ~2 MB) by stepping down fps, then width, then palette colours; reports size_budget_met measured on disk.",
    args: [{ name: "input", required: true }],
    options: [
      ["--start", "Segment start in seconds or MM:SS (default 0)"],
      ["--end", "Segment end in seconds or MM:SS (default end of file)"],
      ["--fps", "Frames per second (default 15)"],
      ["--width", "GIF width in pixels (default 640)"],
      ["--max-size-mb", "Size budget in decimal MB (default 10)"],
      ["-o, --output", "Output .gif file (required)"],
    ],
  },
  "burn-captions": {
    usage: "mediakit burn-captions <input> --captions <file.srt|ass|vtt> -o <output> [--font-size <n>] [--margin-v <n>] [--style background|outline|shadow|glow] [--outline-color <name|hex>]",
    desc: "Burn subtitles into the video (hardcoded, always visible).",
    args: [{ name: "input", required: true }],
    options: [
      ["--captions", "Subtitle file .srt/.ass/.vtt (required)"],
      ["--font-size", "Font size in px (default: scales with frame height, ~60px at 1920 high)"],
      ["--margin-v", "Distance from bottom edge in px (default: 26% of frame height, above platform UI)"],
      ["--style", "Caption style: background (default, white text on a semi-transparent black box) | outline | shadow | glow (halo in the text colour). Ignored for .ass files, which carry their own styles"],
      ["--outline-color", "Outline colour for outline/shadow styles: name or RRGGBB hex (default black)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  reframe: {
    usage: "mediakit reframe <input> -o <output> [--width 1080] [--height 1920] [--mode crop|pad|blur] [--x <px>] [--y <px>] [--anchor <name>] [--blur <n>]",
    desc: "Reframe to a target aspect/size in one step (e.g. 16:9 -> 9:16 vertical).",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Target width in pixels (default 1080, must be even)"],
      ["--height", "Target height in pixels (default 1920, must be even)"],
      ["--mode", "crop (default) | pad (black bars) | blur (blurred fill)"],
      ["--x", "Crop anchor: left offset (crop mode only)"],
      ["--y", "Crop anchor: top offset (crop mode only)"],
      ["--anchor", "Named crop anchor: center | left | right | top | bottom | top-left | top-right | bottom-left | bottom-right (crop mode only; explicit --x/--y win)"],
      ["--blur", "Blur strength for blur mode (default 20)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  titlecard: {
    usage: "mediakit titlecard \"<hook text>\" -o <output.png> [--width 1080] [--height 1920] [--font-size <n>] [--text-color <hex>] [--box-color <hex>] [--style clean-bold|minimal-line|warm-story]",
    desc: "Render a title card PNG: big bold hook on a coloured box, transparent background (overlay it with the overlay tool). --style picks a named locked palette from skills/shorts-video/styles.json; an explicit colour/font overrides just that one locked value.",
    args: [{ name: "text", required: true }],
    options: [
      ["--width", "Canvas width in pixels (default 1080, must be even)"],
      ["--height", "Canvas height in pixels (default 1920, must be even)"],
      ["--font-size", "Font size in px (default: ~120px at 1080 wide; with --style, the style's locked size)"],
      ["--text-color", "Text color name or hex (default FFD60A yellow; with --style, the style's locked text color)"],
      ["--box-color", "Box color name or hex (default F97316 orange; with --style, the style's locked box color)"],
      ["--style", "Named style id: clean-bold | minimal-line | warm-story (locked palette from skills/shorts-video/styles.json)"],
      ["-o, --output", "Output PNG file (required)"],
    ],
  },
  intro: {
    usage: "mediakit intro \"<title>\" -o <output.mp4> [--width 1280] [--height 720] [--duration 3] [--bg-color 0F172A] [--text-color FFFFFF] [--font-size <n>] [--fade-in 0.5] [--fade-out 0.5] [--style clean-bold|minimal-line|warm-story]",
    desc: "Render a short intro clip: a title on a solid-colour background, fading in and out (silent video). --style picks a named locked palette (box colour becomes the background); an explicit colour/font overrides just that one locked value.",
    args: [{ name: "text", required: true }],
    options: [
      ["--width", "Canvas width in pixels (default 1280, must be even)"],
      ["--height", "Canvas height in pixels (default 720, must be even)"],
      ["--duration", "Clip length in seconds (default 3)"],
      ["--bg-color", "Background color name or hex (default 0F172A dark navy; with --style, the style's locked box color)"],
      ["--text-color", "Text color name or hex (default FFFFFF white; with --style, the style's locked text color)"],
      ["--font-size", "Font size in px (default: ~100px at 1280 wide; with --style, the style's locked size)"],
      ["--fade-in", "Text fade-in in seconds (default 0.5, 0 = none)"],
      ["--fade-out", "Text fade-out in seconds (default 0.5, 0 = none)"],
      ["--style", "Named style id: clean-bold | minimal-line | warm-story (locked palette from skills/shorts-video/styles.json)"],
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
    usage: "mediakit check <input> [--platform tiktok|reels|shorts|youtube|instagram-feed|instagram-story|linkedin] [--content] [--start <s|MM:SS>] [--end <s|MM:SS>] [--peak-threshold <dB>]",
    desc: "Verify a file against a platform delivery spec (dimensions, codecs, duration, loudness). --content also scans for black/frozen frames, silence and audio peaks; --start/--end scan only that time range.",
    args: [{ name: "input", required: true }],
    options: [
      ["--platform", "Delivery platform (default tiktok)"],
      ["--content", "Also scan content: black/frozen frames, silence and audio peaks (one decode pass)"],
      ["--start", "Scan only from this time, seconds or MM:SS (needs --content)"],
      ["--end", "Scan only up to this time, seconds or MM:SS (needs --content)"],
      ["--peak-threshold", "Audio peak threshold in dBFS for the peaks rule (default -1; >= 0 dBFS is clipping; needs --content)"],
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
    usage: "mediakit grade <input> -o <output> [--preset warm|cool|cinematic|noir|vintage] [--filter <vf-chain>] [--cdl-slope 1.2,1,0.8 --cdl-offset 0,0,0 --cdl-power 1,1,1 --cdl-saturation 1] [--crf 23]",
    desc: "Color-grade a video with a named preset, one custom filter chain, or an ASC CDL (--cdl-slope/--cdl-offset/--cdl-power as r,g,b triples + --cdl-saturation; any one of them selects CDL mode, mutually exclusive with --preset/--filter). Reports the mean R/G/B before and after, measured on the middle frame.",
    args: [{ name: "input", required: true }],
    options: [
      ["--preset", "warm (default) | cool | cinematic | noir | vintage — fixed filter chains"],
      ["--filter", "One custom video filter chain, e.g. 'eq=saturation=0.5' (mutually exclusive with --preset)"],
      ["--cdl-slope", "ASC CDL slope as r,g,b (0-4, e.g. 1.2,1,0.8); any --cdl-* option selects CDL mode"],
      ["--cdl-offset", "ASC CDL offset as r,g,b (-1 to 1, e.g. 0.02,0,0)"],
      ["--cdl-power", "ASC CDL power (gamma) as r,g,b (0.1-4, e.g. 1,1,1.1)"],
      ["--cdl-saturation", "ASC CDL saturation (0-4, 0 = grayscale, 1 = unchanged)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  reverse: {
    usage: "mediakit reverse <input> -o <output> [--no-audio] [--crf 23]",
    desc: "Play a clip backwards: video frames reversed, audio reversed too by default. Reports whether each stream was actually reversed. Works on audio-only input as well.",
    args: [{ name: "input", required: true }],
    options: [
      ["--no-audio", "Keep the audio playing forward under the reversed video (reverses nothing on audio-only input)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "chroma-key": {
    usage: "mediakit chroma-key <input> -o <output.mov> [--color 00FF00] [--similarity 0.1] [--blend 0] [--background <image|hex>] [--crf 23]",
    desc: "Remove a green/blue screen. Without --background the output keeps transparency and MUST be .mov (ProRes 4444) — .mp4 has no alpha, and this ffmpeg build drops VP9 alpha in .webm. With --background (an image file or a hex color) the subject is composited onto it and the output is a flat .mp4/.webm. Reports the alpha measured on disk (middle frame): full-frame mean, corner (~0 for a full-screen key) and center (~255 on the subject).",
    args: [{ name: "input", required: true }],
    options: [
      ["--color", "Key color as 6-digit hex (default 00FF00 green; 0000FF for blue)"],
      ["--similarity", "Color tolerance 0-1 (default 0.1; too high eats the subject)"],
      ["--blend", "Edge blend 0-1 (default 0)"],
      ["--background", "Image file or hex color to composite onto (e.g. bg.jpg or 1E40AF); without it the output keeps transparency and must be .mov"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "zoom-pan": {
    usage: "mediakit zoom-pan <image> -o <output.mp4> [--duration 5] [--fps 30] [--zoom-from 1] [--zoom-to 1.5] [--focus-x 0.5] [--focus-y 0.5] [--focus-end-x 0.5] [--focus-end-y 0.5] [--width 1280] [--height 720] [--crf 23]",
    desc: "Ken Burns effect: turn a still image into a moving clip. Zooms linearly from --zoom-from to --zoom-to while the focus point moves from (--focus-x, --focus-y) to (--focus-end-x, --focus-end-y), 0-1 fractions of the frame (0.5 is center). The input is pre-scaled 1.25x before zooming to avoid zoompan's integer-crop jitter. Input must be a still image, not a video.",
    args: [{ name: "input", required: true }],
    options: [
      ["--duration", "Clip length in seconds (default 5)"],
      ["--fps", "Output frame rate (default 30)"],
      ["--zoom-from", "Zoom at the first frame, 1 = full image (default 1)"],
      ["--zoom-to", "Zoom at the last frame (default 1.5)"],
      ["--focus-x", "Focus point x at the first frame, 0-1 (default 0.5)"],
      ["--focus-y", "Focus point y at the first frame, 0-1 (default 0.5)"],
      ["--focus-end-x", "Focus point x at the last frame (default = --focus-x)"],
      ["--focus-end-y", "Focus point y at the last frame (default = --focus-y)"],
      ["--width", "Output width in pixels, even (default 1280)"],
      ["--height", "Output height in pixels, even (default 720)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "image-to-video": {
    usage: "mediakit image-to-video <image> -o <output.mp4> [--duration 5] [--fps 30] [--width 1280] [--height 720] [--audio <file>] [--crf 23]",
    desc: "Turn one still image into a fixed-duration video that holds still (no motion — use zoom-pan for Ken Burns). Dimensions default to the image itself; --width/--height fit the image inside the box and pad black to the exact size (widths are rounded down to even). --audio loops an audio file to the same duration (a short bed loops, a long one is trimmed). Output .mp4 (H.264) or .webm (VP9). Reports frame count measured on the output file — exactly round(duration*fps).",
    args: [{ name: "input", required: true }],
    options: [
      ["--duration", "Clip length in seconds (default 5)"],
      ["--fps", "Output frame rate (default 30)"],
      ["--width", "Output width in pixels, rounded down to even (default = image width)"],
      ["--height", "Output height in pixels, rounded down to even (default = image height)"],
      ["--audio", "Audio file to loop under the still (optional)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["-o, --output", "Output file, .mp4 or .webm (required)"],
    ],
  },
  slideshow: {
    usage: "mediakit slideshow <img1> <img2> [img3...] -o <output.mp4> [--duration 3] [--durations 3,5,2] [--transition fade] [--transition-duration 1] [--transitions fade,wipeleft] [--transition-durations 1,0.5] [--fps 30] [--width 1280] [--height 720] [--audio <file>] [--crf 23]",
    desc: "Turn 2-32 still images into one video with an xfade transition between every pair. Each image is visible for its own duration (total = sum of durations); the transition eats a handle, not slide time. --transitions/--transition-durations give a different transition per join (n-1 comma entries); otherwise one type applies to all pairs. --audio loops a bed under the whole slideshow. Output .mp4 only in v1.",
    args: [{ name: "images", required: true, variadic: true }],
    options: [
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
      ["-o, --output", "Output file, .mp4 (required)"],
    ],
  },
  interpolate: {
    usage: "mediakit interpolate <input> -o <output> --fps 60 [--mode mci|blend|dup] [--crf 23]",
    desc: "Raise the frame rate with motion interpolation (minterpolate). blend is the fast default; mci is true motion compensation but much slower (~9x realtime on CPU). Reports fps and frame counts measured on the output file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--fps", "Target frame rate, must be above the source fps (required)"],
      ["--mode", "mci | blend (default) | dup"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  denoise: {
    usage: "mediakit denoise <input> -o <output> [--filter hqdn3d|nlmeans] [--strength 0-1] [--crf 23]",
    desc: "Reduce sensor noise: hqdn3d is the fast default (strength 0.5 = 15, the level that gained +2.9 dB PSNR on sigma-10 noise in testing); nlmeans is better on fine detail but much slower. Reports high-frequency noise energy before and after, measured on disk.",
    args: [{ name: "input", required: true }],
    options: [
      ["--filter", "hqdn3d (default) | nlmeans"],
      ["--strength", "Noise-reduction strength 0-1 (default 0.5)"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  segment: {
    usage: "mediakit segment <input> -o <directory> [--segment-time 6] [--playlist index.m3u8] [--segment-prefix seg] [--reencode] [--crf 23]",
    desc: "Cut a video into an HLS VOD playlist (index.m3u8 + .ts segments) in a directory. Stream-copy by default (fast, lossless) — but segments can only start on keyframes, so actual lengths follow the source GOP; --reencode re-encodes to libx264/aac with forced keyframes for exact segment boundaries. Reports the segment count and durations parsed back from the playlist on disk.",
    args: [{ name: "input", required: true }],
    options: [
      ["--segment-time", "Target segment length in seconds, 1-60 (default 6)"],
      ["--playlist", "Playlist filename, must end .m3u8 (default index.m3u8)"],
      ["--segment-prefix", "Segment filename stem (default seg -> seg000.ts, ...)"],
      ["--reencode", "Re-encode to libx264/aac with forced keyframes (exact segment grid)"],
      ["--crf", "Quality 0-51, lower is better (default 23, reencode only)"],
      ["-o, --output", "Output directory (required, created if needed)"],
    ],
  },
  convert: {
    usage: "mediakit convert <input> -o <output> [--video-codec <c>] [--audio-codec <c>] [--crf <n>] [--preset <p>] [--gop <frames>] [--gop-seconds <s>]",
    desc: "Change container or codec. Omit a codec to stream-copy that stream. --gop / --gop-seconds sets an exact keyframe interval on re-encode (measured on the output file).",
    args: [{ name: "input", required: true }],
    options: [
      ["--video-codec", "libx264 | libx265 | vp9 | av1 | mpeg4 | copy"],
      ["--audio-codec", "e.g. aac, libmp3lame, copy"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--preset", "Encoding preset (default medium)"],
      ["--gop", "Keyframe interval in frames (needs --video-codec re-encode)"],
      ["--gop-seconds", "Keyframe interval in seconds (from source fps; needs --video-codec re-encode)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  silence: {
    usage: "mediakit silence <input> -o <output> [--threshold-db <n>] [--min-duration <s>] [--margin <s>] [--detect-only]",
    desc: "Remove silent stretches, keeping a margin of silence around speech. --detect-only reports segments without writing.",
    args: [{ name: "input", required: true }],
    options: [
      ["--threshold-db", "Silence threshold in dB (default -40, more negative = stricter)"],
      ["--min-duration", "Minimum silence length to cut, seconds (default 0.5)"],
      ["--margin", "Silence kept around each speech segment, seconds (default 0.2)"],
      ["--detect-only", "Report silence/kept segments, write no file"],
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
    usage: "mediakit compress <input> -o <output> [--quality low|medium|high|email-25mb] [--max-width <px>] [--crf <n>] [--preset <p>] [--target-size <MB>] [--no-resolution-ladder]",
    desc: "Shrink a file with one named quality preset (low/medium/high, or email-25mb = target 18 MB so it still fits a 25 MB email attachment after base64). Reports the size before/after and the reduction actually achieved. --target-size <MB> encodes to fit under an exact size instead (two-pass ABR, e.g. 10 for Discord); it ignores --quality and cannot combine with --crf. In target-size mode a resolution ladder steps the frame down when the bitrate buys less than 0.045 bits per pixel per frame, so a starved encode stays watchable instead of mush; --no-resolution-ladder keeps the source frame.",
    args: [{ name: "input", required: true }],
    options: [
      ["--quality", "low | medium | high | email-25mb (default medium; ignored with --target-size)"],
      ["--max-width", "Scale video down to this width first (only when wider)"],
      ["--crf", "Override the preset's CRF (0-51; cannot combine with --target-size)"],
      ["--preset", "Override the preset's x264 preset (ultrafast..veryslow)"],
      ["--target-size", "Target size in decimal MB (1 MB = 1,000,000 bytes); two-pass encode to fit under it"],
      ["--no-resolution-ladder", "In target-size mode, keep the source frame even when the bitrate is starved"],
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
    usage: "mediakit cut-words <input> --words-file <words.json> -o <output> [--remove um,uh | --fillers | --indices 0-5,96-98] [--keep 3,7-9] [--pad-before 0.06] [--pad-after 0.12] [--min-keep 0.2] [--dry-run]",
    desc: "Cut words out of a talking-head clip by transcript: filler words (um/uh), false starts and restarts, using word timings from transcribe --word-timestamps (save its printed JSON and pass it as --words-file). Select by word text (--remove 'um,uh'), the built-in filler set (--fillers: um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh), or 0-based word-index ranges (--indices '0-5,96-98'); --keep rescues indices even when matched. Keep runs are padded 0.06s before / 0.12s after, clamped so a cut never keeps a fragment of the word it removed; kept words that end up mostly cut out are reported in cut_check.swallowed. --dry-run prints the plan and writes nothing. No match copies the input unchanged.",
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
      ["--dry-run", "Print the cut plan (removed words, keep segments, cut_check) and write no file"],
      ["-o, --output", "Output file (required unless --dry-run)"],
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
    usage: "mediakit overlay <input> --image <logo.png> -o <output> [--position top-right|top-left|bottom-left|bottom-right|center] [--margin 24] [--width <px>] [--opacity 0.8] [--start <s>] [--end <s>]",
    desc: "Overlay a logo/watermark image on a video, with position, scale, opacity and optional timing.",
    args: [{ name: "input", required: true }],
    options: [
      ["--image", "Overlay image file (PNG with transparency recommended, required)"],
      ["--position", "top-right (default) | top-left | bottom-left | bottom-right | center"],
      ["--margin", "Margin from the edge in pixels (default 24)"],
      ["--width", "Overlay width in pixels (keeps aspect; default = native size)"],
      ["--opacity", "Overlay opacity 0-1 (default 1)"],
      ["--start", "Show the overlay from this time in seconds"],
      ["--end", "Hide the overlay after this time in seconds"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  pip: {
    usage: "mediakit pip <input> --pip <video> -o <output> [--position bottom-right|top-left|top-center|top-right|center-left|center|center-right|bottom-left|bottom-center] [--margin 24] [--width <px>] [--scale 0.25] [--opacity 1] [--start <s>] [--end <s>] [--audio main|pip|mix]",
    desc: "Picture-in-picture: place a second video over the main one, with position, size, opacity, timing and audio choice.",
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
      ["-o, --output", "Output file (required)"],
    ],
  },
  scenes: {
    usage: "mediakit scenes <input> [--threshold 0.3]",
    desc: "Detect scene changes / hard cuts; returns cut timestamps + the segments between them. Probe-only, writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--threshold", "Scene sensitivity 0-1, lower = more sensitive (default 0.3)"],
    ],
  },
  keyframes: {
    usage: "mediakit keyframes <input>",
    desc: "List keyframe (I-frame) timestamps + GOP intervals. Probe-only, writes no file. Check before a stream-copy trim.",
    args: [{ name: "input", required: true }],
    options: [],
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
    desc: "Apply one operation (loudness|resize|reframe|compress|convert|extract-audio|reverse|grade|fit|trim|silence|chroma-key|cut-words) to every file matching a glob under a folder, with the same args for all. Outputs are <stem>-<operation>.<ext> under the output dir, mirroring the input tree; a batch-manifest.json records every file's result. Unchanged files are skipped via a content-hash cache; --dry-run lists the planned outputs and writes nothing. cut-words finds each clip's words file as <words-dir>/<stem>.words.json (default: the input's own folder) — a clip with no words file fails its own row only.",
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
    ],
  },
  assemble: {
    usage: "mediakit assemble <film.json> --mode validate|preview|approve|render [-o <output-dir>] [--preview-seconds 20] [--force]",
    desc: "Film assembler: build a finished video from one declarative film manifest (shots on a voice-led timeline, mixed audio, burned captions, QA + receipt). The voice is the master clock — total = lead + measured voice + tail, and shots must cover it exactly in frames. validate checks the math and writes nothing; preview renders the first N seconds at half size; approve records the fingerprint of the previewed files (a human must have seen the preview); render needs a matching approval unless --force. Shot segments are cached by content hash. Schema: skills/shorts-video/references/assemble-manifest.md.",
    args: [{ name: "manifest", required: true }],
    options: [
      ["--mode", "validate (default) | preview | approve | render"],
      ["--preview-seconds", "Preview length in seconds, 1-60 (default 20, preview mode only)"],
      ["--force", "Render without approval (recorded as approval:'forced' in the receipt)"],
      ["-o, --output", "Output directory (required for preview/approve/render)"],
    ],
  },
  manifest: {
    usage: "mediakit manifest <manifest.json> [-o <output.mp4>] [--dry-run] [--no-cache] [--keep-intermediates]",
    desc: "Run a whole edit pipeline from one declarative JSON manifest: {version: 1, input, output, steps: [{tool, args}], qa?} — paths relative to the manifest file. Steps run in order (trim|resize|reframe|compress|convert|extract-audio|reverse|grade|fit|silence|denoise|interpolate|burn-captions|overlay|chroma-key|cut-words), each feeding the next; the whole plan is validated before anything renders. Each step is cached by content hash — re-running an unchanged manifest re-encodes nothing. --dry-run lists the planned steps and writes nothing; --qa in the manifest runs qa_report on the final file.",
    args: [{ name: "manifest", required: true }],
    options: [
      ["--dry-run", "Validate the manifest and list the planned steps without running anything"],
      ["--no-cache", "Do not use the content-hash cache — re-encode every step"],
      ["--keep-intermediates", "Keep the per-step intermediate files under the output dir (deleted on success by default; always kept when a step fails)"],
      ["-o, --output", "Output file (overrides the manifest's output; extension is adjusted to the step chain's final format when needed)"],
    ],
  },
  doctor: {
    usage: "mediakit doctor",
    desc: "Read-only preflight: ffmpeg/ffprobe versions, available filters/encoders, and which tools that enables.",
    args: [],
    options: [],
  },
  mcp: {
    usage: "mediakit mcp",
    desc: "Start the MCP server on stdio (for Claude Code / Cursor / Codex).",
    args: [],
    options: [],
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
        });
        break;
      }
      case "crop":
        result = await core.crop({
          input: needInput(), output: needOutput(opts),
          width: numOpt(opts, "width"), height: numOpt(opts, "height"),
          x: numOpt(opts, "x") ?? 0, y: numOpt(opts, "y") ?? 0,
        });
        break;
      case "resize":
        result = await core.resize({
          input: needInput(), output: needOutput(opts),
          width: numOpt(opts, "width") ?? null, height: numOpt(opts, "height") ?? null,
          keepAspect: opts.keep_aspect !== false,
          preset: opts.preset ?? null,
        });
        break;
      case "extract-audio":
        result = await core.extractAudio({
          input: needInput(), output: needOutput(opts), format: opts.format ?? null,
          whisper: opts.whisper === true,
          channel: numOpt(opts, "channel") ?? null,
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
        });
        break;
      case "loudness":
        result = await core.loudness({
          input: needInput(), output: needOutput(opts),
          targetLufs: numOpt(opts, "target_lufs") ?? -14,
          format: opts.format ?? null,
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
        });
        break;
      case "frames":
        result = await core.extractFrames({
          input: needInput(), outputDir: needOutput(opts),
          count: numOpt(opts, "count") ?? 6,
          format: opts.format ?? "png",
          width: numOpt(opts, "width") ?? null,
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
        });
        break;
      case "burn-captions": {
        if (!opts.captions) fail("missing required option: --captions <file.srt|ass|vtt>");
        result = await core.burnCaptions({
          input: needInput(), output: needOutput(opts),
          captions: opts.captions, fontSize: numOpt(opts, "font_size") ?? null,
          marginV: numOpt(opts, "margin_v") ?? null,
          style: opts.style ?? null, outlineColor: opts.outline_color ?? "black",
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
        result = await core.check({
          input: needInput(), platform: opts.platform ?? "tiktok",
          content: wantContent,
          contentStart: opts.start ?? null,
          contentEnd: opts.end ?? null,
          peakThresholdDb: numOpt(opts, "peak_threshold") ?? -1,
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
        });
        break;
      }
      case "reverse":
        result = await core.reverseClip({
          input: needInput(), output: needOutput(opts),
          audio: opts.audio !== false,
          crf: numOpt(opts, "crf") ?? 23,
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
        });
        break;
      case "slideshow": {
        if (positional.length < 2) fail("slideshow needs at least 2 image files");
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
          images: positional, output: needOutput(opts),
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
        });
        break;
      }
      case "interpolate":
        result = await core.interpolate({
          input: needInput(), output: needOutput(opts),
          fps: numOpt(opts, "fps"),
          mode: opts.mode ?? "blend",
          crf: numOpt(opts, "crf") ?? 23,
        });
        break;
      case "denoise":
        result = await core.denoise({
          input: needInput(), output: needOutput(opts),
          filter: opts.filter ?? "hqdn3d",
          strength: numOpt(opts, "strength") ?? 0.5,
          crf: numOpt(opts, "crf") ?? 23,
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
          dryRun: opts.dry_run === true,
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
          threshold: numOpt(opts, "threshold") ?? 0.3,
        });
        break;
      case "keyframes":
        result = await core.listKeyframes({ input: needInput() });
        break;
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
        if (!positional[0]) fail("missing operation: loudness|resize|reframe|compress|convert|extract-audio|reverse|grade|fit|trim|silence|chroma-key");
        if (!opts.pattern) fail("missing required option: --pattern <glob>");
        if (!opts.input_dir) fail("missing required option: --input-dir <dir>");
        const opName = positional[0].replace(/-/g, "_");
        let batchArgs = {};
        if (opts.args_json !== undefined) {
          try {
            batchArgs = JSON.parse(String(opts.args_json));
          } catch (e) {
            fail(`bad --args-json: ${e.message}`);
          }
          if (batchArgs === null || typeof batchArgs !== "object" || Array.isArray(batchArgs)) {
            fail("--args-json must be a JSON object");
          }
        }
        result = await core.batch({
          operation: opName,
          pattern: opts.pattern,
          inputDir: opts.input_dir,
          outputDir: opts.output ?? opts.output_dir ?? fail("missing required option: -o <output-dir>"),
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
        if (!positional[0]) fail("missing manifest file: mediakit assemble <film.json> --mode validate|preview|approve|render [-o <output-dir>]");
        result = await core.assemble({
          manifestPath: positional[0],
          mode: opts.mode ?? "validate",
          outputDir: opts.output ?? null,
          previewSeconds: numOpt(opts, "preview_seconds") ?? 20,
          force: opts.force === true,
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
      case "doctor":
        result = await core.doctor();
        break;
      case "mcp": {
        // Hand off to the MCP server process (same stdio).
        const { spawn } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");
        const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
        const child = spawn(process.execPath, [serverPath], { stdio: "inherit" });
        child.on("exit", (code) => process.exit(code ?? 0));
        return;
      }
      default:
        fail(`unhandled command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof core.MediaKitError) fail(`${err.message} [${err.code}]`, 2);
    fail(err.message, 2);
  }
  console.log(JSON.stringify(result, null, 2));
}

main();
