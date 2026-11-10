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
    usage: "mediakit trim <input> --start <s> (--duration <s> | --end <s>) -o <output> [--stream-copy]",
    desc: "Cut a clip. Re-encodes by default (frame-accurate); --stream-copy is fast but keyframe-only.",
    args: [{ name: "input", required: true }],
    options: [
      ["--start", "Start time in seconds (default 0)"],
      ["--duration", "Clip length in seconds"],
      ["--end", "End time in seconds (alternative to --duration)"],
      ["--stream-copy", "Copy streams without re-encoding"],
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
    usage: "mediakit resize <input> [--width <px>] [--height <px>] [--no-keep-aspect] -o <output>",
    desc: "Resize a video. With --keep-aspect (default) the missing dimension follows the aspect ratio.",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Target width in pixels"],
      ["--height", "Target height in pixels"],
      ["--no-keep-aspect", "Stretch to exact dimensions (needs both --width and --height)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  "extract-audio": {
    usage: "mediakit extract-audio <input> -o <output.mp3|aac|wav|ogg|opus|flac> [--format <fmt>]",
    desc: "Extract the audio track.",
    args: [{ name: "input", required: true }],
    options: [
      ["--format", "Audio format (overrides output extension)"],
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
    usage: "mediakit thumbnail <input> -o <output.png|jpg> [--frames <n>] [--columns <n>] [--width <px>]",
    desc: "Build a contact sheet of N evenly spaced frames.",
    args: [{ name: "input", required: true }],
    options: [
      ["--frames", "Number of frames (default 6)"],
      ["--columns", "Grid columns (default 3)"],
      ["--width", "Width of each tile in pixels (default 320)"],
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
    usage: "mediakit concat <input1> <input2> [input3...] -o <output> [--video-codec <c>] [--audio-codec <c>] [--transition fade|wipeleft|dissolve|...] [--transition-duration <s>]",
    desc: "Join 2+ media files into one (re-encodes, so mixed codecs are fine). --transition crossfades between clips instead of a hard cut.",
    args: [{ name: "inputs", required: true, variadic: true }],
    options: [
      ["--video-codec", "Video codec (default libx264)"],
      ["--audio-codec", "Audio codec (default aac)"],
      ["--transition", "xfade transition between clips: fade, wipeleft, dissolve, circlecrop, ..."],
      ["--transition-duration", "Transition length in seconds (default 1, must be shorter than the shortest clip)"],
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
  "burn-captions": {
    usage: "mediakit burn-captions <input> --captions <file.srt|ass|vtt> -o <output> [--font-size <n>]",
    desc: "Burn subtitles into the video (hardcoded, always visible).",
    args: [{ name: "input", required: true }],
    options: [
      ["--captions", "Subtitle file .srt/.ass/.vtt (required)"],
      ["--font-size", "Font size in px (default 24)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  reframe: {
    usage: "mediakit reframe <input> -o <output> [--width 1080] [--height 1920] [--mode crop|pad|blur] [--x <px>] [--y <px>] [--blur <n>]",
    desc: "Reframe to a target aspect/size in one step (e.g. 16:9 -> 9:16 vertical).",
    args: [{ name: "input", required: true }],
    options: [
      ["--width", "Target width in pixels (default 1080, must be even)"],
      ["--height", "Target height in pixels (default 1920, must be even)"],
      ["--mode", "crop (default) | pad (black bars) | blur (blurred fill)"],
      ["--x", "Crop anchor: left offset (crop mode only)"],
      ["--y", "Crop anchor: top offset (crop mode only)"],
      ["--blur", "Blur strength for blur mode (default 20)"],
      ["-o, --output", "Output file (required)"],
    ],
  },
  check: {
    usage: "mediakit check <input> [--platform tiktok|reels|shorts|youtube]",
    desc: "Verify a file against a platform delivery spec (dimensions, codecs, duration, loudness).",
    args: [{ name: "input", required: true }],
    options: [
      ["--platform", "Delivery platform (default tiktok)"],
    ],
  },
  convert: {
    usage: "mediakit convert <input> -o <output> [--video-codec <c>] [--audio-codec <c>] [--crf <n>] [--preset <p>]",
    desc: "Change container or codec. Omit a codec to stream-copy that stream.",
    args: [{ name: "input", required: true }],
    options: [
      ["--video-codec", "libx264 | libx265 | vp9 | av1 | mpeg4 | copy"],
      ["--audio-codec", "e.g. aac, libmp3lame, copy"],
      ["--crf", "Quality 0-51, lower is better (default 23)"],
      ["--preset", "Encoding preset (default medium)"],
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
    usage: "mediakit package <input> -o <output.zip> [--captions <file.srt|ass|vtt>] [--platform tiktok|reels|shorts|youtube]",
    desc: "Bundle a finished file for delivery: media + spec.json receipt + checksums.sha256 (+ captions).",
    args: [{ name: "input", required: true }],
    options: [
      ["--captions", "Subtitle file .srt/.ass/.vtt to include"],
      ["--platform", "Run check for this platform and record it in spec.json"],
      ["-o, --output", "Output .zip file (required)"],
    ],
  },
  mix: {
    usage: "mediakit mix <voice> --music <file> -o <output> [--music-volume 0.3] [--duck-db 12] [--attack-ms 100] [--release-ms 400] [--voice-lufs -16] [--target-lufs -14] [--no-master]",
    desc: "Mix voice over a music bed with sidechain ducking (bed drops under speech), then master to target LUFS.",
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
  scenes: {
    usage: "mediakit scenes <input> [--threshold 0.3]",
    desc: "Detect scene changes / hard cuts; returns cut timestamps + the segments between them. Probe-only, writes no file.",
    args: [{ name: "input", required: true }],
    options: [
      ["--threshold", "Scene sensitivity 0-1, lower = more sensitive (default 0.3)"],
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

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

/** Minimal flag parser: --key value, --key=value, --flag, -o value. */
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { opts.help = true; continue; }
    if (a.startsWith("--no-")) { opts[a.slice(5).replace(/-/g, "_")] = false; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) { opts[a.slice(2, eq).replace(/-/g, "_")] = a.slice(eq + 1); continue; }
      const key = a.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      // A value may be a negative number (e.g. --target-lufs -14):
      // it starts with "-" but is not a flag.
      const nextIsNegativeNumber = next !== undefined && /^-\d/.test(next);
      if (next === undefined || (next.startsWith("-") && !nextIsNegativeNumber)) { opts[key] = true; }
      else { opts[key] = next; i++; }
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
          start: numOpt(opts, "start") ?? 0,
          duration: numOpt(opts, "duration") ?? null,
          end: numOpt(opts, "end") ?? null,
          streamCopy: opts.stream_copy === true,
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
        });
        break;
      case "extract-audio":
        result = await core.extractAudio({
          input: needInput(), output: needOutput(opts), format: opts.format ?? null,
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
      case "burn-captions": {
        if (!opts.captions) fail("missing required option: --captions <file.srt|ass|vtt>");
        result = await core.burnCaptions({
          input: needInput(), output: needOutput(opts),
          captions: opts.captions, fontSize: numOpt(opts, "font_size") ?? 24,
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
          blur: numOpt(opts, "blur") ?? 20,
        });
        break;
      case "check":
        result = await core.check({
          input: needInput(), platform: opts.platform ?? "tiktok",
        });
        break;
      case "convert":
        result = await core.convert({
          input: needInput(), output: needOutput(opts),
          videoCodec: opts.video_codec ?? null,
          audioCodec: opts.audio_codec ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          preset: opts.preset ?? "medium",
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
      case "scenes":
        result = await core.detectScenes({
          input: needInput(),
          threshold: numOpt(opts, "threshold") ?? 0.3,
        });
        break;
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
