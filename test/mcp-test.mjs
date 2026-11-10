// MCP stdio smoke test: initialize, tools/list, call probe + trim.
// Run: node test/mcp-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
});
const client = new Client({ name: "mediakit-test", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log("tools/list:", names.join(", "));
const expected = ["probe", "trim", "crop", "resize", "extract_audio", "extract_frame", "thumbnail", "loudness", "concat", "burn_captions", "convert", "reframe", "check", "silence", "doctor", "cropdetect", "package", "mix", "frames", "overlay", "scenes", "keyframes"];
const missing = expected.filter((n) => !names.includes(n));
console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "all 22 tools present");

const probeRes = await client.callTool({
  name: "probe",
  arguments: { input: path.join(root, "test/source.mp4") },
});
console.log("probe call:", probeRes.content[0].text.slice(0, 200).replace(/\n/g, " "), "...");

const trimRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-trim.mp4"),
    start: 1,
    duration: 2,
  },
});
console.log("trim call:", trimRes.content[0].text.replace(/\n/g, " "));

const reframeRes = await client.callTool({
  name: "reframe",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-reframe.mp4"),
    width: 1080,
    height: 1920,
    mode: "crop",
  },
});
console.log("reframe call:", reframeRes.content[0].text.replace(/\n/g, " "));

const checkRes = await client.callTool({
  name: "check",
  arguments: {
    input: path.join(root, "outputs/mcp-reframe.mp4"),
    platform: "tiktok",
  },
});
console.log("check call:", checkRes.content[0].text.replace(/\n/g, " "));

const doctorRes = await client.callTool({
  name: "doctor",
  arguments: {},
});
const doctorJson = JSON.parse(doctorRes.content[0].text);
console.log("doctor call: ok =", doctorJson.ok, "| ffmpeg", doctorJson.ffmpeg_version, "| tools available:", Object.values(doctorJson.tools).filter((t) => t.available).length + "/" + Object.keys(doctorJson.tools).length);

const silenceRes = await client.callTool({
  name: "silence",
  arguments: {
    input: path.join(root, "test/silence-source.mp4"),
    output: path.join(root, "outputs/mcp-silence.mp4"),
    threshold_db: -40,
    min_duration: 0.5,
    margin: 0.2,
  },
});
const silenceJson = JSON.parse(silenceRes.content[0].text);
console.log("silence call: duration", silenceJson.duration_before, "->", silenceJson.duration_after, "| removed", silenceJson.removed_seconds, "s in", silenceJson.removed_count, "gaps");

const cropdetectRes = await client.callTool({
  name: "cropdetect",
  arguments: {
    input: path.join(root, "test/letterbox.mp4"),
    frames: 10,
  },
});
const cropdetectJson = JSON.parse(cropdetectRes.content[0].text);
console.log("cropdetect call: source", cropdetectJson.source, "| crop", JSON.stringify(cropdetectJson.crop), "| bars", JSON.stringify(cropdetectJson.black_bars));

const packageRes = await client.callTool({
  name: "package",
  arguments: {
    input: path.join(root, "outputs/mcp-reframe.mp4"),
    output: path.join(root, "outputs/mcp-package.zip"),
    captions: path.join(root, "test/captions.srt"),
    platform: "tiktok",
  },
});
const packageJson = JSON.parse(packageRes.content[0].text);
console.log("package call: files", packageJson.files.join(", "), "| platform_pass", packageJson.platform_pass, "| size", packageJson.size_human);

const mixRes = await client.callTool({
  name: "mix",
  arguments: {
    voice: path.join(root, "test/mix-voice.mp3"),
    music: path.join(root, "test/mix-music.mp3"),
    output: path.join(root, "outputs/mcp-mix.mp3"),
    music_volume: 0.5,
    duck_db: 12,
  },
});
const mixJson = JSON.parse(mixRes.content[0].text);
console.log("mix call: duration", mixJson.duration_seconds, "| output LUFS", mixJson.output_lufs, "| voice gain", mixJson.voice_gain_db, "dB | ducking measured", mixJson.ducking_measured_db, "dB");

const concatTransRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source2.mp4")],
    output: path.join(root, "outputs/mcp-concat-fade.mp4"),
    transition: "fade",
    transition_duration: 1,
  },
});
const concatTransJson = JSON.parse(concatTransRes.content[0].text);
console.log("concat+fade call: duration", concatTransJson.duration_seconds, "| expected", concatTransJson.expected_duration_seconds, "|", concatTransJson.dimensions);

const framesRes = await client.callTool({
  name: "frames",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output_dir: path.join(root, "outputs/mcp-frames"),
    count: 5,
    format: "png",
    width: 320,
  },
});
const framesJson = JSON.parse(framesRes.content[0].text);
console.log("frames call: extracted", framesJson.extracted, "| timestamps", framesJson.frames.map((f) => f.timestamp_seconds).join(","));

const overlayRes = await client.callTool({
  name: "overlay",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    overlay: path.join(root, "test/logo.png"),
    output: path.join(root, "outputs/mcp-overlay.mp4"),
    position: "top-right",
    width: 120,
    opacity: 1,
  },
});
const overlayJson = JSON.parse(overlayRes.content[0].text);
console.log("overlay call:", overlayJson.position, overlayJson.x + "," + overlayJson.y, "|", overlayJson.overlay_size, "|", overlayJson.dimensions, "|", overlayJson.duration_seconds + "s");

const scenesRes = await client.callTool({
  name: "scenes",
  arguments: {
    input: path.join(root, "test/scenes-source.mp4"),
    threshold: 0.3,
  },
});
const scenesJson = JSON.parse(scenesRes.content[0].text);
console.log("scenes call: count", scenesJson.count, "| changes", scenesJson.scene_changes.join(","), "| segments", scenesJson.segments.map((s) => `${s.start}-${s.end}`).join(" "));

const keyframesRes = await client.callTool({
  name: "keyframes",
  arguments: { input: path.join(root, "test/source.mp4") },
});
const keyframesJson = JSON.parse(keyframesRes.content[0].text);
console.log("keyframes call: count", keyframesJson.count, "| timestamps", keyframesJson.keyframe_timestamps.join(","), "| gop", JSON.stringify(keyframesJson.gop_seconds));

// Regression: MCP snake_case params must reach core (round 7 bug fix).
// stream_copy=true must actually stream-copy, and snap_to_keyframe must
// move 1s..3s onto keyframes 0..8.333 (source GOP is 250 frames).
const trimSnapRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-trim-snap.mp4"),
    start: 1, duration: 2, stream_copy: true, snap_to_keyframe: true,
  },
});
const trimSnapJson = JSON.parse(trimSnapRes.content[0].text);
console.log("trim snap call: stream_copy", trimSnapJson.stream_copy, "| requested", trimSnapJson.requested_start + "-" + trimSnapJson.requested_end, "| snapped", trimSnapJson.snapped, "| actual", trimSnapJson.start + "-" + (trimSnapJson.start + trimSnapJson.duration_seconds), "| duration_actual", trimSnapJson.duration_actual + "s");
await client.close();
console.log("MCP test done");
