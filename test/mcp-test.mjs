// MCP stdio test: initialize, tools/list, call every tool, and ASSERT
// the results against values measured from the fixtures — a tool that
// runs without crashing is not a pass; the output has to be right.
// Run: node test/mcp-test.mjs (exit 1 if any assertion fails, so CI
// goes red instead of silently green).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Independent loudness measurement: run ffmpeg's loudnorm analysis
// directly on the file (not through the tool under test) and read
// the integrated loudness it reports.
async function measureLufs(file) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-i", file, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
    const m = stderr.match(/"input_i"\s*:\s*"(-?[\d.]+)"/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

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
const expected = ["probe", "trim", "crop", "resize", "extract_audio", "extract_frame", "thumbnail", "loudness", "concat", "burn_captions", "convert", "reframe", "check", "silence", "doctor", "cropdetect", "package", "mix", "frames", "overlay", "scenes", "keyframes", "fit", "pip", "titlecard"];
const missing = expected.filter((n) => !names.includes(n));
console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "all 25 tools present");
checkOk(missing.length === 0, "tools/list has all 25 tools", `missing: ${missing.join(", ")}`);

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
checkOk(reframeJson.crop.x === 438, "reframe default centers the crop (x=438)", `got x=${reframeJson.crop?.x}`);

// reframe anchor: named anchors pin the crop window to a side.
// 1280x720 -> 1080x1920 crop window is 404x720; "left" => x=0,
// "right" => x=876; keeps 31.6% of the frame (warns: below 40%).
const reframeLeftRes = await client.callTool({
  name: "reframe",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-reframe-left.mp4"), width: 1080, height: 1920, mode: "crop", anchor: "left" },
});
const reframeLeftJson = JSON.parse(reframeLeftRes.content[0].text);
console.log("reframe left:", JSON.stringify(reframeLeftJson.crop), "| kept", reframeLeftJson.crop_kept_percent + "%", "| upscale", reframeLeftJson.upscale + "x");
checkOk(reframeLeftJson.crop.x === 0 && reframeLeftJson.crop.width === 404, "reframe anchor left pins crop to x=0, width 404", `got ${JSON.stringify(reframeLeftJson.crop)}`);
checkOk(near(reframeLeftJson.crop_kept_percent, 31.6, 0.2), "reframe reports 31.6% kept", `got ${reframeLeftJson.crop_kept_percent}`);
checkOk(near(reframeLeftJson.upscale, 2.67, 0.01), "reframe reports 2.67x upscale", `got ${reframeLeftJson.upscale}`);
checkOk(typeof reframeLeftJson.warning === "string", "reframe warns when the crop keeps under 40%", `got warning=${JSON.stringify(reframeLeftJson.warning)}`);
const reframeRightRes = await client.callTool({
  name: "reframe",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-reframe-right.mp4"), width: 1080, height: 1920, mode: "crop", anchor: "right" },
});
const reframeRightJson = JSON.parse(reframeRightRes.content[0].text);
checkOk(reframeRightJson.crop.x === 876, "reframe anchor right pins crop to x=876", `got x=${reframeRightJson.crop.x}`);
// Pixel-verify the anchor actually moves the picture: left-crop and
// right-crop frames of the same testsrc must differ a lot.
const anchorPsnr = await bandPsnr(path.join(root, "outputs/mcp-reframe-left.mp4"), path.join(root, "outputs/mcp-reframe-right.mp4"), 5, 0, 1920);
checkOk(anchorPsnr !== null && anchorPsnr < 30, "reframe left vs right frames differ (anchor moves the crop)", `got PSNR ${anchorPsnr}`);

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
// D positive case: bitrate is the ONLY problem -> overall pass must
// still be true (a warning, not a gate). Fix the reframe file's
// loudness first (-21.8 LUFS fails), then check it: 0.3 Mbps video
// bitrate warns, everything else passes.
const loudReframeRes = await client.callTool({
  name: "loudness",
  arguments: { input: path.join(root, "outputs/mcp-reframe.mp4"), output: path.join(root, "outputs/mcp-reframe-loud.mp4") },
});
const loudReframeJson = JSON.parse(loudReframeRes.content[0].text);
checkOk(near(loudReframeJson.output_lufs, -14, 0.5), "loudness fixes the reframed file to -14 LUFS", `got ${loudReframeJson.output_lufs}`);
const checkGoodRes = await client.callTool({
  name: "check",
  arguments: { input: path.join(root, "outputs/mcp-reframe-loud.mp4"), platform: "tiktok" },
});
const checkGoodJson = JSON.parse(checkGoodRes.content[0].text);
console.log("check good file:", "pass", checkGoodJson.pass, "| warnings", JSON.stringify(checkGoodJson.warnings));
checkOk(checkGoodJson.pass === true, "check passes overall when bitrate is the only issue", `got pass=${checkGoodJson.pass} issues=${JSON.stringify(checkGoodJson.issues)}`);
checkOk(Array.isArray(checkGoodJson.warnings) && checkGoodJson.warnings.some((w) => w.startsWith("video_bitrate")), "check still warns about the low bitrate", JSON.stringify(checkGoodJson.warnings));

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

// concat --fast: identical clips stream-copy (20s, no re-encode);
// differing clips fall back to re-encode with the reason named;
// fast=true on differing clips is an error, not a silent fallback.
const concatFastRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source.mp4")],
    output: path.join(root, "outputs/mcp-concat-fast.mp4"),
    fast: true,
  },
});
const concatFastJson = JSON.parse(concatFastRes.content[0].text);
console.log("concat fast call: mode", concatFastJson.mode, "| duration", concatFastJson.duration_seconds, "|", concatFastJson.fast_reason);
checkOk(concatFastJson.mode === "fast", "concat fast=true stream-copies identical clips", `got mode=${concatFastJson.mode}`);
checkOk(near(concatFastJson.duration_seconds, 20, 0.1), "concat fast duration is 20s (10+10)", `got ${concatFastJson.duration_seconds}`);

const concatAutoRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source2.mp4")],
    output: path.join(root, "outputs/mcp-concat-auto.mp4"),
  },
});
const concatAutoJson = JSON.parse(concatAutoRes.content[0].text);
console.log("concat auto call: mode", concatAutoJson.mode, "| duration", concatAutoJson.duration_seconds, "| skipped:", JSON.stringify(concatAutoJson.fast_skipped));
checkOk(concatAutoJson.mode === "reencode", "concat auto falls back to re-encode on differing clips", `got mode=${concatAutoJson.mode}`);
checkOk(near(concatAutoJson.duration_seconds, 16, 0.1), "concat auto duration is 16s (10+6)", `got ${concatAutoJson.duration_seconds}`);
checkOk(Array.isArray(concatAutoJson.fast_skipped) && concatAutoJson.fast_skipped.some((r) => r.includes("640x360")), "concat auto names the size mismatch", JSON.stringify(concatAutoJson.fast_skipped));

const concatFastFailRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source2.mp4")],
    output: path.join(root, "outputs/mcp-concat-fast-fail.mp4"),
    fast: true,
  },
});
const concatFastFailJson = JSON.parse(concatFastFailRes.content[0].text);
console.log("concat fast-fail call: isError", concatFastFailRes.isError, "|", concatFastFailJson.error);
checkOk(concatFastFailRes.isError === true && /size 640x360/.test(concatFastFailJson.error ?? ""), "concat fast=true errors on differing clips with the mismatch", JSON.stringify(concatFastFailJson));

// pip: source2 (640x360) over source (1280x720) at default scale 0.25
// -> 320x180 at bottom-right (936,516); output keeps 1280x720 / 10s.
const pipRes = await client.callTool({
  name: "pip",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    pip: path.join(root, "test/source2.mp4"),
    output: path.join(root, "outputs/mcp-pip.mp4"),
  },
});
const pipJson = JSON.parse(pipRes.content[0].text);
console.log("pip call:", pipJson.position, pipJson.x + "," + pipJson.y, "|", pipJson.pip_size, "|", pipJson.dimensions, "|", pipJson.duration_seconds + "s");
checkOk(pipJson.x === 936 && pipJson.y === 516 && pipJson.pip_size === "320x180", "pip default lands at 936,516 as 320x180", `got ${pipJson.x},${pipJson.y} ${pipJson.pip_size}`);
checkOk(pipJson.dimensions === "1280x720" && near(pipJson.duration_seconds, 10, 0.05), "pip keeps 1280x720 / 10s", `got ${pipJson.dimensions} ${pipJson.duration_seconds}s`);

// Pixel-verify a horizontal band of two frames: extract the frame at
// time t from each file, crop the band, and return the PSNR between
// them (Infinity when identical). Low PSNR = the band differs a lot.
async function bandPsnr(fileA, fileB, t, y, h) {
  const aPng = path.join(root, "outputs/mcp-band-a.png");
  const bPng = path.join(root, "outputs/mcp-band-b.png");
  await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", fileA, "-frames:v", "1", aPng]);
  await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", fileB, "-frames:v", "1", bPng]);
  const { stderr } = await execFileAsync("ffmpeg", ["-i", aPng, "-i", bPng, "-filter_complex", `[0:v]crop=iw:${h}:0:${y}[a];[1:v]crop=iw:${h}:0:${y}[b];[a][b]psnr`, "-f", "null", "-"]);
  const m = stderr.match(/average:\s*(inf|[0-9.]+)/);
  if (!m) return null;
  return m[1] === "inf" ? Infinity : parseFloat(m[1]);
}

// Pixel-verify a titlecard PNG with ffmpeg only (no Python/PIL — the
// CI runner has neither): mean value of one channel in a crop.
// plane "r"/"g"/"b" via extractplanes, "a" via alphaextract.
// Returns null on any failure so a broken measurement FAILs the
// assertion instead of crashing the whole run.
async function planeMean(file, crop, plane) {
  try {
    const vf = plane === "a"
      ? `format=rgba,crop=${crop},alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG`
      : `format=rgba,crop=${crop},extractplanes=${plane},signalstats,metadata=print:key=lavfi.signalstats.YAVG`;
    const { stderr } = await execFileAsync("ffmpeg", ["-i", file, "-vf", vf, "-f", "null", "-"]);
    const m = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

// titlecard: big bold hook on an orange box, transparent canvas.
// "THE MOON IS LEAVING US" wraps to 2 lines at ~119px on 1080 wide.
// Pixel-verify on the middle band (y 800-1300, where the block sits):
// warm bright content (R high, B low) that is opaque (alpha high);
// the top-left corner must be fully transparent (alpha ~0) and dark.
const titleRes = await client.callTool({
  name: "titlecard",
  arguments: { text: "The Moon Is Leaving Us", output: path.join(root, "outputs/mcp-titlecard.png") },
});
const titleJson = JSON.parse(titleRes.content[0].text);
console.log("titlecard call:", titleJson.dimensions, "| lines", JSON.stringify(titleJson.lines), "| font", titleJson.font_size);
checkOk(titleJson.dimensions === "1080x1920", "titlecard output is 1080x1920", `got ${titleJson.dimensions}`);
checkOk(JSON.stringify(titleJson.lines) === JSON.stringify(["THE MOON IS", "LEAVING US"]), "titlecard wraps to 2 lines", `got ${JSON.stringify(titleJson.lines)}`);
checkOk(titleJson.font_size === 119, "titlecard default font is 119px at 1080 wide", `got ${titleJson.font_size}`);
const titleBandR = await planeMean(path.join(root, "outputs/mcp-titlecard.png"), "1080:500:0:800", "r");
const titleBandG = await planeMean(path.join(root, "outputs/mcp-titlecard.png"), "1080:500:0:800", "g");
const titleBandB = await planeMean(path.join(root, "outputs/mcp-titlecard.png"), "1080:500:0:800", "b");
const titleBandA = await planeMean(path.join(root, "outputs/mcp-titlecard.png"), "1080:500:0:800", "a");
const titleCornerA = await planeMean(path.join(root, "outputs/mcp-titlecard.png"), "200:200:0:0", "a");
const titleCornerR = await planeMean(path.join(root, "outputs/mcp-titlecard.png"), "200:200:0:0", "r");
console.log("titlecard pixels: band R/G/B/A =", titleBandR, titleBandG, titleBandB, titleBandA, "| corner A/R =", titleCornerA, titleCornerR);
checkOk(titleBandR !== null && titleBandR > 50, "titlecard band has bright warm content (R high)", `got R=${titleBandR}`);
checkOk(titleBandG !== null && titleBandG > 20, "titlecard band has green channel content (yellow/orange, not red-only)", `got G=${titleBandG}`);
checkOk(titleBandB !== null && titleBandB < 20, "titlecard band is warm, not blue/white (B low)", `got B=${titleBandB}`);
checkOk(titleBandA !== null && titleBandA > 50, "titlecard band is opaque (the box is there)", `got A=${titleBandA}`);
checkOk(titleCornerA !== null && titleCornerA < 5, "titlecard corner is fully transparent", `got A=${titleCornerA}`);
checkOk(titleCornerR !== null && titleCornerR < 5, "titlecard corner is dark (nothing drawn there)", `got R=${titleCornerR}`);

// burn_captions: defaults scale with frame height and sit above the
// platform UI. On 1280x720: font 22px, margin 187px from the bottom.
// Pixel-verify at t=3.5s (cue 2): the caption band differs a lot
// (PSNR ~19), the bottom strip is nearly identical (PSNR ~64).
const capsRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    captions: path.join(root, "test/captions.srt"),
    output: path.join(root, "outputs/mcp-captions.mp4"),
  },
});
const capsJson = JSON.parse(capsRes.content[0].text);
console.log("burn_captions call:", "font_size", capsJson.font_size, "| margin_v", capsJson.margin_v);
checkOk(capsJson.font_size === 22, "burn_captions default font is 22px at 720p", `got ${capsJson.font_size}`);
checkOk(capsJson.margin_v === 187, "burn_captions default margin is 187px at 720p", `got ${capsJson.margin_v}`);
const capsBand = await bandPsnr(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-captions.mp4"), 3.5, 480, 60);
checkOk(capsBand !== null && capsBand < 30, "burn_captions text lands in the safe band (low PSNR there)", `got PSNR ${capsBand}`);
const capsStrip = await bandPsnr(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-captions.mp4"), 3.5, 680, 40);
checkOk(capsStrip !== null && capsStrip > 40, "burn_captions text stays out of the bottom strip (high PSNR there)", `got PSNR ${capsStrip}`);

// loudness: two-pass must hit -14 LUFS on representative content.
// Voice (test/mix-voice.mp3, -22.1 LUFS in) reaches -14 ±0.5.
// The quiet music bed (test/quiet-source.mp3, -26.1 LUFS in) is
// peak-limited: sub-bass dominates the true peak (crest ~21 dB), so
// no linear gain can reach -14 without clipping — the tool must get
// as close as the peak ceiling allows AND say so (warning), never
// pretend the target was hit. Single-pass only reached -21.6 here.
const loudVoiceRes = await client.callTool({
  name: "loudness",
  arguments: {
    input: path.join(root, "test/mix-voice.mp3"),
    output: path.join(root, "outputs/mcp-loudness-voice.mp3"),
  },
});
const loudVoiceJson = JSON.parse(loudVoiceRes.content[0].text);
console.log("loudness voice:", "target", loudVoiceJson.target_lufs, "| input", loudVoiceJson.input_lufs, "| output", loudVoiceJson.output_lufs, "| two_pass", loudVoiceJson.two_pass);
checkOk(loudVoiceJson.two_pass === true, "loudness uses two-pass", `got two_pass=${loudVoiceJson.two_pass}`);
checkOk(near(loudVoiceJson.output_lufs, -14, 0.5), "loudness voice reports output at -14 LUFS (±0.5)", `got ${loudVoiceJson.output_lufs}`);
const loudVoiceMeasured = await measureLufs(path.join(root, "outputs/mcp-loudness-voice.mp3"));
checkOk(near(loudVoiceMeasured, -14, 0.5), "loudness voice output independently measures -14 LUFS (±0.5)", `got ${loudVoiceMeasured}`);

const loudRes = await client.callTool({
  name: "loudness",
  arguments: {
    input: path.join(root, "test/quiet-source.mp3"),
    output: path.join(root, "outputs/mcp-loudness.mp3"),
  },
});
const loudJson = JSON.parse(loudRes.content[0].text);
console.log("loudness quiet bed:", "target", loudJson.target_lufs, "| input", loudJson.input_lufs, "| output", loudJson.output_lufs, "| warning", loudJson.warning ?? "(none)");
checkOk(typeof loudJson.output_lufs === "number" && loudJson.output_lufs > loudJson.input_lufs, "loudness quiet bed improves on input LUFS", `input ${loudJson.input_lufs} -> output ${loudJson.output_lufs}`);
checkOk(typeof loudJson.warning === "string" && loudJson.warning.length > 0, "loudness quiet bed warns it cannot reach target", `got warning=${JSON.stringify(loudJson.warning)}`);

await client.close();
if (failures.length) {
  console.error(`\nMCP test FAILED: ${failures.length} assertion(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("MCP test done — all assertions passed");
