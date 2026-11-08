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
    usage: "mediakit concat <input1> <input2> [input3...] -o <output> [--video-codec <c>] [--audio-codec <c>]",
    desc: "Join 2+ media files into one (re-encodes, so mixed codecs are fine).",
    args: [{ name: "inputs", required: true, variadic: true }],
    options: [
      ["--video-codec", "Video codec (default libx264)"],
      ["--audio-codec", "Audio codec (default aac)"],
      ["-o, --output", "Output file (required)"],
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
      if (next === undefined || next.startsWith("-")) { opts[key] = true; }
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
      case "convert":
        result = await core.convert({
          input: needInput(), output: needOutput(opts),
          videoCodec: opts.video_codec ?? null,
          audioCodec: opts.audio_codec ?? null,
          crf: numOpt(opts, "crf") ?? 23,
          preset: opts.preset ?? "medium",
        });
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
