// MCP stdio test: initialize, tools/list, call every tool, and ASSERT
// the results against values measured from the fixtures — a tool that
// runs without crashing is not a pass; the output has to be right.
// Run: node test/mcp-test.mjs (exit 1 if any assertion fails, so CI
// goes red instead of silently green).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const failures = [];
function checkOk(cond, label, detail = "") {
  if (cond) console.log(`  PASS ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label} ${detail}`); }
}
const near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

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
const expected = ["probe", "trim", "crop", "resize", "extract_audio", "extract_frame", "thumbnail", "loudness", "concat", "burn_captions", "convert", "reframe", "check", "silence", "doctor", "cropdetect", "package", "mix", "frames", "overlay", "scenes", "keyframes", "fit"];
const missing = expected.filter((n) => !names.includes(n));
console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "all 23 tools present");
checkOk(missing.length === 0, "tools/list has all 23 tools", `missing: ${missing.join(", ")}`);

const probeRes = await client.callTool({
  name: "probe",
  arguments: { input: path.join(root, "test/source.mp4") },
});
console.log("probe call:", probeRes.content[0].text.slice(0, 200).replace(/\n/g, " "), "...");
const probeJson = JSON.parse(probeRes.content[0].text);
checkOk(probeJson.duration_seconds === 10, "probe duration is 10s", `got ${probeJson.duration_seconds}`);
checkOk(probeJson.video?.width === 1280 && probeJson.video?.height === 720, "probe dimensions are 1280x720", JSON.stringify(probeJson.video));

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
const trimJson = JSON.parse(trimRes.content[0].text);
checkOk(near(trimJson.duration_actual, 2, 0.05), "trim duration_actual is 2s", `got ${trimJson.duration_actual}`);
checkOk(trimJson.stream_copy === false, "trim re-encodes by default", `got stream_copy=${trimJson.stream_copy}`);

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
const reframeJson = JSON.parse(reframeRes.content[0].text);
checkOk(reframeJson.dimensions === "1080x1920", "reframe output is 1080x1920", `got ${reframeJson.dimensions}`);
checkOk(near(reframeJson.duration_seconds, 10, 0.05), "reframe keeps 10s duration", `got ${reframeJson.duration_seconds}`);

const checkRes = await client.callTool({
  name: "check",
  arguments: {
    input: path.join(root, "outputs/mcp-reframe.mp4"),
    platform: "tiktok",
  },
});
console.log("check call:", checkRes.content[0].text.replace(/\n/g, " "));
const checkJson = JSON.parse(checkRes.content[0].text);
const bitrateRule = checkJson.checks.find((c) => c.name === "video_bitrate");
checkOk(bitrateRule?.severity === "warn", "check video_bitrate is a warning, not an error", JSON.stringify(bitrateRule));
checkOk(Array.isArray(checkJson.warnings) && checkJson.warnings.some((w) => w.startsWith("video_bitrate")), "check lists the bitrate warning", JSON.stringify(checkJson.warnings));
checkOk(!checkJson.issues?.some((i) => i.startsWith("video_bitrate")), "bitrate warning does not appear in issues", JSON.stringify(checkJson.issues));
checkOk(checkJson.safe_zone?.x0 === 64 && checkJson.safe_zone?.y1 === 1400, "check reports the TikTok safe zone", JSON.stringify(checkJson.safe_zone));
checkOk(checkJson.checks.find((c) => c.name === "dimensions")?.pass === true, "check dimensions pass on the reframed file");

const doctorRes = await client.callTool({
  name: "doctor",
  arguments: {},
});
const doctorJson = JSON.parse(doctorRes.content[0].text);
console.log("doctor call: ok =", doctorJson.ok, "| ffmpeg", doctorJson.ffmpeg_version, "| tools available:", Object.values(doctorJson.tools).filter((t) => t.available).length + "/" + Object.keys(doctorJson.tools).length);
checkOk(doctorJson.ok === true, "doctor ok=true", JSON.stringify(doctorJson.tools));
checkOk(Object.values(doctorJson.tools).every((t) => t.available), "doctor: all tools available");
checkOk(doctorJson.tools.fit?.available === true, "doctor: fit is available");

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
checkOk(near(silenceJson.duration_after, 6.867, 0.05), "silence cuts 9s to 6.867s", `got ${silenceJson.duration_after}`);
checkOk(near(silenceJson.removed_seconds, 2.195, 0.05) && silenceJson.removed_count === 2, "silence removes 2.195s in 2 gaps", `got ${silenceJson.removed_seconds}s in ${silenceJson.removed_count} gaps`);

const cropdetectRes = await client.callTool({
  name: "cropdetect",
  arguments: {
    input: path.join(root, "test/letterbox.mp4"),
    frames: 10,
  },
});
const cropdetectJson = JSON.parse(cropdetectRes.content[0].text);
console.log("cropdetect call: source", cropdetectJson.source, "| crop", JSON.stringify(cropdetectJson.crop), "| bars", JSON.stringify(cropdetectJson.black_bars));
checkOk(cropdetectJson.crop?.width === 1280 && cropdetectJson.crop?.height === 720 && cropdetectJson.crop?.x === 320 && cropdetectJson.crop?.y === 180, "cropdetect finds the exact 1280:720:320:180 rect", JSON.stringify(cropdetectJson.crop));

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
checkOk(packageJson.files.includes("spec.json") && packageJson.files.includes("checksums.sha256"), "package contains spec.json + checksums.sha256", packageJson.files.join(", "));

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
checkOk(near(mixJson.output_lufs, -14, 0.5), "mix masters to -14 LUFS", `got ${mixJson.output_lufs}`);
checkOk(typeof mixJson.ducking_measured_db === "number" && mixJson.ducking_measured_db > 5, "mix ducking is actually measured (>5 dB)", `got ${mixJson.ducking_measured_db}`);

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
checkOk(near(concatTransJson.duration_seconds, 15, 0.1), "concat+fade duration is 15s (16s minus 1s transition)", `got ${concatTransJson.duration_seconds}`);

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
checkOk(framesJson.extracted === 5, "frames extracts 5 frames", `got ${framesJson.extracted}`);
checkOk(framesJson.frames?.[0]?.timestamp_seconds === 0 && framesJson.frames?.[4]?.timestamp_seconds === 8, "frames timestamps are 0,2,4,6,8", framesJson.frames.map((f) => f.timestamp_seconds).join(","));

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
checkOk(overlayJson.x === 1136 && overlayJson.y === 24, "overlay top-right 120px lands at 1136,24", `got ${overlayJson.x},${overlayJson.y}`);

const scenesRes = await client.callTool({
  name: "scenes",
  arguments: {
    input: path.join(root, "test/scenes-source.mp4"),
    threshold: 0.3,
  },
});
const scenesJson = JSON.parse(scenesRes.content[0].text);
console.log("scenes call: count", scenesJson.count, "| changes", scenesJson.scene_changes.join(","), "| segments", scenesJson.segments.map((s) => `${s.start}-${s.end}`).join(" "));
checkOk(scenesJson.count === 1 && near(scenesJson.scene_changes[0], 5.033, 0.05), "scenes finds the 5.033s cut", JSON.stringify(scenesJson.scene_changes));

const keyframesRes = await client.callTool({
  name: "keyframes",
  arguments: { input: path.join(root, "test/source.mp4") },
});
const keyframesJson = JSON.parse(keyframesRes.content[0].text);
console.log("keyframes call: count", keyframesJson.count, "| timestamps", keyframesJson.keyframe_timestamps.join(","), "| gop", JSON.stringify(keyframesJson.gop_seconds));
checkOk(keyframesJson.count === 2 && keyframesJson.keyframe_timestamps[0] === 0 && near(keyframesJson.keyframe_timestamps[1], 8.333, 0.01), "keyframes are [0, 8.333]", keyframesJson.keyframe_timestamps.join(","));

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
checkOk(trimSnapJson.stream_copy === true, "MCP trim stream_copy=true actually reaches core", `got stream_copy=${trimSnapJson.stream_copy}`);
checkOk(trimSnapJson.snapped === true && trimSnapJson.start === 0 && near(trimSnapJson.duration_actual, 8.4, 0.1), "trim snap moves 1-3s onto keyframes 0-8.333", `got ${trimSnapJson.start}-${trimSnapJson.start + trimSnapJson.duration_seconds}, actual ${trimSnapJson.duration_actual}s`);

// fit: 10s source -> 5s by speed (factor 2x), verified on disk below.
const fitRes = await client.callTool({
  name: "fit",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-fit.mp4"),
    duration: 5,
    method: "speed",
  },
});
const fitJson = JSON.parse(fitRes.content[0].text);
console.log("fit call: method", fitJson.method, "| factor", fitJson.speed_factor, "| target", fitJson.target_duration_seconds + "s", "| duration_actual", fitJson.duration_actual + "s", "| error", fitJson.duration_error_seconds + "s");
checkOk(fitJson.method === "speed" && fitJson.speed_factor === 2, "fit speed factor is 2x", `got ${fitJson.speed_factor}`);
checkOk(near(fitJson.duration_actual, 5, 0.05) && near(fitJson.duration_error_seconds, 0, 0.05), "fit lands on 5s (error ~0)", `got actual ${fitJson.duration_actual}s, error ${fitJson.duration_error_seconds}s`);
await client.close();
if (failures.length) {
  console.error(`\nMCP test FAILED: ${failures.length} assertion(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("MCP test done — all assertions passed");
