// MCP stdio test: initialize, tools/list, call every tool, and ASSERT
// the results against values measured from the fixtures — a tool that
// runs without crashing is not a pass; the output has to be right.
// Run: node test/mcp-test.mjs (exit 1 if any assertion fails, so CI
// goes red instead of silently green).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createCanvas } from "canvas";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyContentBaseline, compareDeterminismRuns, countClippedRuns, diagnoseVoice, estimateDecodedWork, estimateJobRemaining, estimateTempo, findDensestSpeechWindow, findPhraseMatches, findQuietSnap, fixForMissing, groupWords, hookDuplicateOf, hookOverlapSeconds, localTempoCurve, paceNumbers, parseCleanVoiceSteps, parseContentBaseline, parseFfmpegProgress, parseSmartCutFillers, parseStyleFile, planCleanVoice, planSmartCuts, resolveQcPolicy, runFfmpegWithProgress, scoreStylePace, secondsToFrames, spectralFluxOnset, trackBeatsDP, validateOtioTimeline, voiceEnvelopeDb, voiceSyncMs, SHORTS_STYLE_IDS } from "../src/core.js";
import { createHttpServer } from "../src/http.js";
import bounceTpl from "../src/canvas-scene-lib/templates/bounce.cjs";
import slideInTpl from "../src/canvas-scene-lib/templates/slide-in.cjs";
import springInTpl from "../src/canvas-scene-lib/templates/spring-in.cjs";
import fxLib from "../src/canvas-scene-lib/fx.cjs";
import camLib from "../src/canvas-scene-lib/camera.cjs";

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

// Independent true-peak measurement: the same loudnorm analysis
// pass as measureLufs, but reading input_tp — the delivery ceiling
// is -0.3 dBTP, and an encoder can move it after the LUFS is right.
async function measureTp(file) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-i", file, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
    const m = stderr.match(/"input_tp"\s*:\s*"(-?[\d.]+)"/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

// Independent chapter list: ffprobe -show_chapters on disk (not the
// tool's own report) — a chapter with the wrong time or title is a
// wrong file, whatever the receipt says.
async function probeChapters(file) {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_chapters", "-of", "json", file]);
    return JSON.parse(stdout).chapters ?? [];
  } catch {
    return null;
  }
}

async function probeStreams(file) {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,start_time,duration", "-show_entries", "format=duration", "-of", "json", file]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// Independent frame count: ffprobe -count_frames on disk (not the
// tool's own report) — a film that is a frame short has shifted
// every shot after the gap, so the count is the assertion.
async function countFrames(file) {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]);
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Independent mean-volume helper: ffmpeg volumedetect on a window
// (not through the tool under test), so an SFX claim is measured
// from the file on disk, not from the tool's own report.
async function meanVolume(file, start, duration) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-ss", String(start), "-t", String(duration), "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

// Independent luma PSNR helper: ffmpeg's psnr filter between a clean
// reference and a file (not through the tool under test). Returns the
// Y-channel PSNR in dB, or null on failure. Identical frames print
// "PSNR y:inf" — that is a perfect match, not a failure, so it maps
// to 999 dB (caught 2026-11-13: image_to_video's first and last
// frames are bit-identical, and the old regex returned null for them).
async function psnrY(ref, file) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-i", ref, "-i", file, "-filter_complex", "psnr", "-f", "null", "-"]);
    const m = stderr.match(/PSNR y:(inf|[0-9.]+)/);
    return m ? (m[1] === "inf" ? 999 : parseFloat(m[1])) : null;
  } catch {
    return null;
  }
}

// Independent audio samples: decode a file to raw f32 mono 44.1kHz
// (not through the tool under test) so a fade or a click can be
// measured sample by sample instead of believed from a log line.
async function pcmSamples(file) {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    // Copy into a fresh ArrayBuffer first: a Buffer's pooled backing
    // store is not guaranteed 4-byte aligned for Float32Array.
    const bytes = Buffer.from(stdout);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Float32Array(ab);
  } catch {
    return null;
  }
}
function windowRmsDb(x, t0, t1, sr = 44100) {
  const a = Math.floor(t0 * sr), b = Math.min(x.length, Math.floor(t1 * sr));
  if (b <= a) return null;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  const rms = Math.sqrt(s / (b - a));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}
function maxSampleJump(x, t0, t1, sr = 44100) {
  const a = Math.floor(t0 * sr), b = Math.min(x.length, Math.floor(t1 * sr));
  let m = 0;
  for (let i = a + 1; i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

const failures = [];
function checkOk(cond, label, detail = "") {
  if (cond) console.log(`  PASS ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label} ${detail}`); }
}
const near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

// A call that fails MCP schema validation (bad enum etc.) throws on the
// client instead of returning a tool result — capture the message either
// way (same inline try/catch pattern as the social enum test below).
async function callExpectThrow(name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    return res.content?.[0]?.text ?? "";
  } catch (e) {
    return e.message ?? String(e);
  }
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Hermetic jobs root for the async-job tests: one fresh directory per
// suite run, so smoke-test jobs from the shell never leak into the
// suite's `job --list` assertions. The server child inherits this env
// (transport env is process.env), and the worker inherits it from the
// server, so all three agree on the same root.
process.env.MEDIAKIT_JOBS_DIR = path.join(root, `outputs/mcp-jobs-${process.pid}`);
// Hermetic audit log for the suite (same idea as the jobs dir): the
// server child inherits this env, so its per-call records land in a
// per-run file instead of the repo's real .mediakit-audit.jsonl.
process.env.MEDIAKIT_AUDIT_PATH = path.join(root, `outputs/mcp-audit-${process.pid}.jsonl`);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
  // The SDK does NOT inherit process.env by default: without this,
  // MEDIAKIT_ASR_PYTHON / MEDIAKIT_TEST_ASR never reach the server
  // and the gated transcribe block tests a no-engine server.
  env: process.env,
});
const client = new Client({ name: "mediakit-test", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log("tools/list:", names.join(", "));
const expected = ["probe", "trim", "crop", "resize", "extract_audio", "extract_frame", "thumbnail", "loudness", "concat", "burn_captions", "convert", "reframe", "check", "silence", "doctor", "cropdetect", "package", "mix", "frames", "overlay", "scenes", "keyframes", "fit", "pip", "broll", "titlecard", "intro", "social", "convert_captions", "generate_srt", "find", "svg_animate", "compress", "receipt", "mux", "export_gif", "transcribe", "grade", "reverse", "rotate", "make_loopable", "freeze", "fastforward", "boomerang", "batch", "interpolate", "denoise", "segment", "publish_kit", "qa_report", "manifest", "determinism", "chroma_key", "zoom_pan", "image_to_video", "cut_words", "assemble", "slideshow", "remove_retakes", "job", "download", "audit", "motion", "verify", "verify_cuts", "diagnose", "chapters", "hook", "bpm", "beat_grid", "tempo_drift", "transitions", "init_project", "patch_manifest", "export_timeline", "extract_frames", "audio_levels", "search_words", "smart_cut", "clean_voice", "measure_pace"];
const missing = expected.filter((n) => !names.includes(n));
console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "all 81 tools present");
checkOk(missing.length === 0, "tools/list has all 81 tools", `missing: ${missing.join(", ")}`);

const probeRes = await client.callTool({
  name: "probe",
  arguments: { input: path.join(root, "test/source.mp4") },
});
console.log("probe call:", probeRes.content[0].text.slice(0, 200).replace(/\n/g, " "), "...");
const probeJson = JSON.parse(probeRes.content[0].text);
checkOk(probeJson.duration_seconds === 10, "probe duration is 10s", `got ${probeJson.duration_seconds}`);
checkOk(probeJson.video?.width === 1280 && probeJson.video?.height === 720, "probe dimensions are 1280x720", JSON.stringify(probeJson.video));
// Rotation-aware probe (lượt 73): a phone clip coded 1280x720 with a
// 90-degree display matrix reports rotation 90 and display 720x1280;
// an unrotated file reports rotation null and display == coded.
// time_base is exposed for the concat --fast compat check.
checkOk(probeJson.video?.rotation === null && probeJson.video?.display_width === 1280 && probeJson.video?.display_height === 720, "probe on an unrotated file reports rotation null and display == coded", JSON.stringify(probeJson.video));
checkOk(probeJson.video?.time_base === "1/15360", "probe reports video time_base 1/15360 on source", `got ${probeJson.video?.time_base}`);
const probeRotRes = await client.callTool({
  name: "probe",
  arguments: { input: path.join(root, "test/rotated.mp4") },
});
const probeRotJson = JSON.parse(probeRotRes.content[0].text);
console.log("probe rotated call:", JSON.stringify(probeRotJson.video));
checkOk(probeRotJson.video?.width === 1280 && probeRotJson.video?.height === 720, "probe rotated keeps coded size 1280x720", JSON.stringify(probeRotJson.video));
checkOk(probeRotJson.video?.rotation === 90, "probe rotated reports rotation 90 (display matrix, clockwise)", `got ${probeRotJson.video?.rotation}`);
checkOk(probeRotJson.video?.display_width === 720 && probeRotJson.video?.display_height === 1280, "probe rotated reports display size 720x1280 (axes swapped)", JSON.stringify(probeRotJson.video));
const probeTbRes = await client.callTool({
  name: "probe",
  arguments: { input: path.join(root, "test/timescale-90k.mp4") },
});
const probeTbJson = JSON.parse(probeTbRes.content[0].text);
checkOk(probeTbJson.video?.time_base === "1/90000", "probe reports video time_base 1/90000 on the timescale fixture", `got ${probeTbJson.video?.time_base}`);
// Per-stream durations (lượt 127): probe exposes each stream's own
// length, so check's audio_sync rule can compare video vs audio.
const probeSyncOkRes = await client.callTool({
  name: "probe",
  arguments: { input: path.join(root, "test/avsync-ok.mp4") },
});
const probeSyncOkJson = JSON.parse(probeSyncOkRes.content[0].text);
checkOk(probeSyncOkJson.video?.duration_seconds === 5 && probeSyncOkJson.audio?.duration_seconds === 5, "probe reports per-stream durations 5s/5s on the in-sync fixture", JSON.stringify({ v: probeSyncOkJson.video?.duration_seconds, a: probeSyncOkJson.audio?.duration_seconds }));
const probeSyncDriftRes = await client.callTool({
  name: "probe",
  arguments: { input: path.join(root, "test/avsync-drift.mp4") },
});
const probeSyncDriftJson = JSON.parse(probeSyncDriftRes.content[0].text);
checkOk(probeSyncDriftJson.video?.duration_seconds === 5 && probeSyncDriftJson.audio?.duration_seconds === 4.4, "probe reports per-stream durations 5s/4.4s on the drift fixture", JSON.stringify({ v: probeSyncDriftJson.video?.duration_seconds, a: probeSyncDriftJson.audio?.duration_seconds }));
// check judges dimensions as displayed: the vertical fixture is coded
// 1920x1080 but displays 1080x1920, so its dimensions rule passes
// TikTok; the 720x1280 rotated file reports its display size, not
// the coded 1280x720.
const checkVertRes = await client.callTool({
  name: "check",
  arguments: { input: path.join(root, "test/rotated-vertical.mp4"), platform: "tiktok" },
});
const checkVertJson = JSON.parse(checkVertRes.content[0].text);
const checkVertDims = checkVertJson.checks?.find((c) => c.name === "dimensions");
console.log("check rotated-vertical dims:", JSON.stringify(checkVertDims));
checkOk(checkVertDims?.pass === true && checkVertDims?.actual === "1080x1920", "check passes dimensions on a rotated vertical file (display 1080x1920, coded 1920x1080)", JSON.stringify(checkVertDims));
const checkRotRes = await client.callTool({
  name: "check",
  arguments: { input: path.join(root, "test/rotated.mp4"), platform: "tiktok" },
});
const checkRotJson = JSON.parse(checkRotRes.content[0].text);
const checkRotDims = checkRotJson.checks?.find((c) => c.name === "dimensions");
checkOk(checkRotDims?.pass === false && checkRotDims?.actual === "720x1280", "check reports display size 720x1280 (not coded 1280x720) on a rotated file", JSON.stringify(checkRotDims));

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
// --edge-buffer (Outtake's 0.1s clip-edge buffer): the requested
// window 2-6s widens to 1.9-6.1s, reported against the request.
const trimEbRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-trim-edge.mp4"),
    start: 2,
    duration: 4,
    edge_buffer: 0.1,
  },
});
const trimEbJson = JSON.parse(trimEbRes.content[0].text);
checkOk(trimEbRes.isError !== true && trimEbJson.start === 1.9 && near(trimEbJson.duration_seconds, 4.2, 0.001) && near(trimEbJson.duration_actual, 4.2, 0.05) && trimEbJson.requested_start === 2 && trimEbJson.requested_end === 6 && trimEbJson.edge_buffer === 0.1 && trimEbJson.edge_buffer_applied?.start === 0.1 && trimEbJson.edge_buffer_applied?.end === 0.1, "trim --edge-buffer 0.1 widens 2-6s to 1.9-6.1s (4.2s) and reports requested vs applied", JSON.stringify({ start: trimEbJson.start, dur: trimEbJson.duration_seconds, req: [trimEbJson.requested_start, trimEbJson.requested_end], applied: trimEbJson.edge_buffer_applied }));
checkOk(trimEbJson.cut_verified === true, "trim --edge-buffer verifies (the buffered start IS the requested cut, so frames align)", JSON.stringify(trimEbJson.check_frames));
// The buffer clamps to the file edges: start 0.05s only grows 0.05s.
const trimEbClampRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-trim-edge-clamp.mp4"),
    start: 0.05,
    duration: 2,
    edge_buffer: 0.1,
  },
});
const trimEbClampJson = JSON.parse(trimEbClampRes.content[0].text);
checkOk(trimEbClampRes.isError !== true && trimEbClampJson.start === 0 && near(trimEbClampJson.duration_actual, 2.15, 0.05) && trimEbClampJson.edge_buffer_applied?.start === 0.05 && trimEbClampJson.edge_buffer_applied?.end === 0.1, "trim --edge-buffer clamps at the file start (applied start 0.05, end 0.1, 2.15s)", JSON.stringify(trimEbClampJson.edge_buffer_applied));
// Buffer + snap composes (dry-run): the buffered window 1.9-6.1s
// snaps to the keyframes 0-8.333s; the request stays 2-6s.
const trimEbSnapRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-trim-edge-snap.mp4"),
    start: 2,
    duration: 4,
    edge_buffer: 0.1,
    stream_copy: true,
    snap_to_keyframe: true,
    dry_run: true,
  },
});
const trimEbSnapJson = JSON.parse(trimEbSnapRes.content[0].text);
checkOk(trimEbSnapRes.isError !== true && trimEbSnapJson.dry_run === true && trimEbSnapJson.start === 0 && near(trimEbSnapJson.duration_seconds, 8.333, 0.01) && trimEbSnapJson.snapped === true && trimEbSnapJson.requested_start === 2 && trimEbSnapJson.requested_end === 6 && trimEbSnapJson.edge_buffer === 0.1, "trim --edge-buffer + --snap snaps the buffered window (1.9-6.1s -> keyframes 0-8.333s)", JSON.stringify({ start: trimEbSnapJson.start, dur: trimEbSnapJson.duration_seconds, snapped: trimEbSnapJson.snapped }));
// Buffer refuses smart_cut (exact start) and > 1s.
const trimEbScRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-trim-edge-sc.mp4"),
    start: 2,
    duration: 4,
    edge_buffer: 0.1,
    stream_copy: true,
    smart_cut: true,
  },
});
const trimEbScJson = JSON.parse(trimEbScRes.content[0].text);
checkOk(trimEbScRes.isError === true && /edge_buffer.*smart_cut|smart_cut.*edge_buffer/.test(trimEbScJson.error ?? ""), "trim --edge-buffer refuses --smart-cut", JSON.stringify(trimEbScJson));
const trimEbBigRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-trim-edge-big.mp4"),
    start: 2,
    duration: 4,
    edge_buffer: 2,
  },
});
const trimEbBigText = trimEbBigRes.content[0].text;
// Zod rejects edge_buffer > 1 before the handler runs, so the
// result is a plain-text MCP validation error, not JSON — parse it
// as text (the same trap as the mux offset-9999 assert, lượt 16).
checkOk(trimEbBigRes.isError === true && /edge_buffer/.test(trimEbBigText), "trim --edge-buffer 2 (over the 1s cap) refuses", trimEbBigText.slice(0, 200));

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

// reframe --dry-run (lượt 108): crop geometry is computed from the
// probe, so it is exact without rendering.
const reframeDryRes = await client.callTool({
  name: "reframe",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-reframe-dry.mp4"), width: 1080, height: 1920, mode: "crop", dry_run: true },
});
const reframeDryJson = JSON.parse(reframeDryRes.content[0].text);
console.log("reframe dry-run:", JSON.stringify({ crop: reframeDryJson.crop, kept: reframeDryJson.crop_kept_percent }));
checkOk(reframeDryJson.dry_run === true && reframeDryJson.crop?.x === 438 && near(reframeDryJson.crop_kept_percent, 31.6, 0.2) && typeof reframeDryJson.warning === "string", "reframe dry-run reports the exact crop (x=438, 31.6% kept) + warning", JSON.stringify(reframeDryJson.crop));
checkOk(reframeDryJson.commands?.length === 1 && reframeDryJson.commands[0].includes("crop=404:720:438:0,scale=1080:1920"), "reframe dry-run prints the exact crop command", reframeDryJson.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-reframe-dry.mp4")), "reframe dry-run writes no file", "outputs/mcp-reframe-dry.mp4");

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
// loudness --dry-run (lượt 105): the measurement pass is read-only,
// so the two-pass command is exact; with a compressor the loudnorm
// measured_* values come from the uncompressed input (the real run
// re-measures the compressed temp first) and the note says so.
const loudDryRes = await client.callTool({
  name: "loudness",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-loud-dry.mp3"), dry_run: true },
});
const loudDry = JSON.parse(loudDryRes.content[0].text);
console.log("loudness dry-run:", JSON.stringify({ dry_run: loudDry.dry_run, two_pass: loudDry.two_pass, input_lufs: loudDry.input_lufs, commands: loudDry.commands }));
checkOk(loudDry.dry_run === true && loudDry.two_pass === true && near(loudDry.input_lufs, -22.1, 1), "loudness dry-run reports dry_run + two_pass + measured input LUFS", JSON.stringify(loudDry));
checkOk(loudDry.commands?.length === 1 && loudDry.commands[0].includes("loudnorm=I=-14") && loudDry.commands[0].includes("measured_I="), "loudness dry-run prints the exact two-pass loudnorm command", loudDry.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-loud-dry.mp3")), "loudness dry-run writes no file", "outputs/mcp-loud-dry.mp3");
const loudCompDryRes = await client.callTool({
  name: "loudness",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-loud-comp-dry.mp3"), compressor: true, dry_run: true },
});
const loudCompDry = JSON.parse(loudCompDryRes.content[0].text);
console.log("loudness compressor dry-run:", JSON.stringify({ commands: loudCompDry.commands?.length, compressed_lufs: loudCompDry.compressed_lufs, note: loudCompDry.note }));
checkOk(loudCompDry.commands?.length === 2 && loudCompDry.commands[0].includes("acompressor") && loudCompDry.commands[0].includes("pcm_s16le"), "loudness dry-run with compressor prints the compressor render first", loudCompDry.commands?.[0] ?? "");
checkOk(loudCompDry.commands?.[1]?.includes("-map") && loudCompDry.commands[1].includes("1:a") && loudCompDry.compressed_lufs === null && /re-measures/.test(loudCompDry.note ?? ""), "loudness compressor dry-run: second command takes audio from the temp, note says the real run re-measures", loudCompDry.note ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-loud-comp-dry.mp3")), "loudness compressor dry-run writes no file", "outputs/mcp-loud-comp-dry.mp3");
const loudCliDryJson = await runCliJson(["loudness", path.join(root, "test/mix-voice.mp3"), "-o", path.join(root, "outputs/mcp-loud-cli-dry.mp3"), "--dry-run"]);
checkOk(loudCliDryJson.dry_run === true && loudCliDryJson.commands?.[0]?.includes("loudnorm=I=-14") && !existsSync(path.join(root, "outputs/mcp-loud-cli-dry.mp3")), "CLI loudness --dry-run prints the command and writes no file", JSON.stringify(loudCliDryJson.commands));
// The overwrite guard (reel-ffmpeg-mcp study, lượt 105): prepareOutput
// refuses output == input even in dry-run mode.
let loudGuardCliCode = null, loudGuardCliOut = "";
try { await execFileAsync(process.execPath, [path.join(root, "bin/mediakit.js"), "loudness", path.join(root, "test/mix-voice.mp3"), "-o", path.join(root, "test/mix-voice.mp3"), "--dry-run"], { env: { ...process.env } }); } catch (e) { loudGuardCliCode = e.code; loudGuardCliOut = (e.stdout ?? "") + (e.stderr ?? ""); }
checkOk(loudGuardCliCode === 2 && /OUTPUT_OVERWRITES_INPUT/.test(loudGuardCliOut), "loudness dry-run still refuses output == input (exit 2, OUTPUT_OVERWRITES_INPUT)", `code=${loudGuardCliCode} ${loudGuardCliOut.slice(0, 200)}`);
const checkGoodRes = await client.callTool({
  name: "check",
  arguments: { input: path.join(root, "outputs/mcp-reframe-loud.mp4"), platform: "tiktok" },
});
const checkGoodJson = JSON.parse(checkGoodRes.content[0].text);
console.log("check good file:", "pass", checkGoodJson.pass, "| warnings", JSON.stringify(checkGoodJson.warnings));
checkOk(checkGoodJson.pass === true, "check passes overall when bitrate is the only issue", `got pass=${checkGoodJson.pass} issues=${JSON.stringify(checkGoodJson.issues)}`);
checkOk(Array.isArray(checkGoodJson.warnings) && checkGoodJson.warnings.some((w) => w.startsWith("video_bitrate")), "check still warns about the low bitrate", JSON.stringify(checkGoodJson.warnings));

// check --expected-duration (lượt 71; qa_report had it since lượt 31,
// check did not): same ±0.5s tolerance — a file of the wrong length
// must fail the gate instead of passing a wrong-length deliverable.
// Boundary values are computed from the duration the tool itself
// reports, so a 10.00 vs 10.02 probe difference cannot flip them.
const checkExpRes = await client.callTool({
  name: "check",
  arguments: { input: path.join(root, "outputs/mcp-reframe-loud.mp4"), platform: "tiktok", expected_duration: 10 },
});
const checkExpJson = JSON.parse(checkExpRes.content[0].text);
const expRule = checkExpJson.checks.find((c) => c.name === "expected_duration");
const expDur = parseFloat(expRule?.actual ?? "NaN");
checkOk(expRule?.pass === true && checkExpJson.pass === true, "check expected_duration 10s passes on the 10s file (overall pass stays true)", JSON.stringify(expRule));
const checkExpOffRes = await client.callTool({
  name: "check",
  arguments: { input: path.join(root, "outputs/mcp-reframe-loud.mp4"), platform: "tiktok", expected_duration: 5 },
});
const checkExpOffJson = JSON.parse(checkExpOffRes.content[0].text);
checkOk(checkExpOffJson.checks.find((c) => c.name === "expected_duration")?.pass === false && checkExpOffJson.pass === false, "check expected_duration 5s fails the 10s file", JSON.stringify(checkExpOffJson.checks.find((c) => c.name === "expected_duration")));
checkOk(checkExpOffJson.issues?.some((i) => i.startsWith("expected_duration")), "expected_duration failure appears in top-level issues", JSON.stringify(checkExpOffJson.issues));
const checkExpEdgeRes = await client.callTool({
  name: "check",
  arguments: { input: path.join(root, "outputs/mcp-reframe-loud.mp4"), platform: "tiktok", expected_duration: +(expDur + 0.5).toFixed(3) },
});
const checkExpEdgeJson = JSON.parse(checkExpEdgeRes.content[0].text);
checkOk(checkExpEdgeJson.checks.find((c) => c.name === "expected_duration")?.pass === true, "check expected_duration exactly 0.5s off still passes (tolerance is inclusive)", JSON.stringify(checkExpEdgeJson.checks.find((c) => c.name === "expected_duration")));
const checkExpOverRes = await client.callTool({
  name: "check",
  arguments: { input: path.join(root, "outputs/mcp-reframe-loud.mp4"), platform: "tiktok", expected_duration: +(expDur + 0.51).toFixed(3) },
});
const checkExpOverJson = JSON.parse(checkExpOverRes.content[0].text);
checkOk(checkExpOverJson.checks.find((c) => c.name === "expected_duration")?.pass === false, "check expected_duration 0.51s off fails", JSON.stringify(checkExpOverJson.checks.find((c) => c.name === "expected_duration")));
const checkExpCliJson = await runCliJson(["check", path.join(root, "outputs/mcp-reframe-loud.mp4"), "--platform", "tiktok", "--expected-duration", "0:10"], {});
checkOk(checkExpCliJson.checks.find((c) => c.name === "expected_duration")?.pass === true, "CLI check --expected-duration accepts MM:SS (0:10 passes on the 10s file)", JSON.stringify(checkExpCliJson.checks.find((c) => c.name === "expected_duration")));

// check --content: black/frozen/silence fixtures, one decode pass.
async function checkContent(file, platform = "tiktok", extra = {}) {
  const r = await client.callTool({ name: "check", arguments: { input: path.join(root, file), platform, content: true, ...extra } });
  return JSON.parse(r.content[0].text);
}
const contentBlack = await checkContent("test/content-black.mp4");
console.log("check content black file: black", JSON.stringify(contentBlack.content.black.intervals), "| freeze", JSON.stringify(contentBlack.content.freeze.intervals));
checkOk(near(contentBlack.content.black.intervals[0]?.start, 3, 0.05) && near(contentBlack.content.black.intervals[0]?.end, 6, 0.05), "content finds the planted black stretch 3-6s", JSON.stringify(contentBlack.content.black.intervals));
checkOk(contentBlack.content.black.intervals[0]?.severity === "error", "black mid-file is an error, not a warning", JSON.stringify(contentBlack.content.black.intervals));
checkOk(near(contentBlack.content.freeze.intervals[0]?.start, 3, 0.05) && near(contentBlack.content.freeze.intervals[0]?.end, 6, 0.05), "black stretch is also reported frozen (frames do not change)", JSON.stringify(contentBlack.content.freeze.intervals));
checkOk(contentBlack.content.silence.total_intervals === 0, "content finds no silence in the continuous-tone file", JSON.stringify(contentBlack.content.silence));
checkOk(contentBlack.checks.find((c) => c.name === "content_black")?.pass === false, "content_black rule fails the check", JSON.stringify(contentBlack.checks));
checkOk(contentBlack.issues?.some((i) => i.startsWith("content_black")), "content_black appears in top-level issues", JSON.stringify(contentBlack.issues));

const contentFreeze = await checkContent("test/content-freeze.mp4");
console.log("check content freeze file: freeze", JSON.stringify(contentFreeze.content.freeze.intervals), "| black", JSON.stringify(contentFreeze.content.black.intervals));
checkOk(near(contentFreeze.content.freeze.intervals[0]?.start, 4, 0.05) && near(contentFreeze.content.freeze.intervals[0]?.end, 7, 0.05), "content finds the planted freeze 4-7s", JSON.stringify(contentFreeze.content.freeze.intervals));
checkOk(contentFreeze.content.black.total_intervals === 0, "content finds no black in the freeze fixture", JSON.stringify(contentFreeze.content.black));
checkOk(contentFreeze.checks.find((c) => c.name === "content_freeze")?.pass === false, "content_freeze rule fails the check");

const contentSilence = await checkContent("test/content-silence.mp4");
console.log("check content silence file: silence", JSON.stringify(contentSilence.content.silence.intervals));
checkOk(near(contentSilence.content.silence.intervals[0]?.start, 3, 0.05) && near(contentSilence.content.silence.intervals[0]?.end, 6, 0.05), "content finds the planted silence 3-6s", JSON.stringify(contentSilence.content.silence.intervals));
checkOk(contentSilence.content.silence.intervals[0]?.severity === "warn", "3s mid-file silence warns instead of failing", JSON.stringify(contentSilence.content.silence.intervals));
checkOk(contentSilence.content.pass === true, "content itself passes when the only finding is a warning", JSON.stringify(contentSilence.content));
checkOk(contentSilence.warnings?.some((w) => w.startsWith("content_silence")), "content_silence appears in top-level warnings", JSON.stringify(contentSilence.warnings));
checkOk(!contentSilence.issues?.some((i) => i.startsWith("content_silence")), "content_silence warning does not appear in issues", JSON.stringify(contentSilence.issues));

const contentLead = await checkContent("test/content-lead-black.mp4");
checkOk(contentLead.content.black.intervals[0]?.severity === "warn", "1s black at the very start warns (likely a fade in)", JSON.stringify(contentLead.content.black.intervals));
checkOk(contentLead.warnings?.some((w) => w.startsWith("content_black")), "leading-black warning appears in top-level warnings", JSON.stringify(contentLead.warnings));

const contentTrail = await checkContent("test/content-trail-black.mp4");
checkOk(contentTrail.content.black.intervals[0]?.severity === "error", "3s black at the end fails (too long for a fade out)", JSON.stringify(contentTrail.content.black.intervals));

const contentClean = await checkContent("test/source.mp4");
checkOk(contentClean.content.black.total_intervals === 0 && contentClean.content.freeze.total_intervals === 0 && contentClean.content.silence.total_intervals === 0, "content finds nothing in the clean source file", JSON.stringify(contentClean.content));
checkOk(contentClean.content.pass === true, "content passes on the clean file");

const contentAudioOnly = await checkContent("test/silence-audio.mp3");
checkOk(contentAudioOnly.content.black.status === "unavailable" && contentAudioOnly.content.freeze.status === "unavailable", "audio-only file reports black/freeze unavailable, not zero", JSON.stringify(contentAudioOnly.content));
checkOk(contentAudioOnly.content.silence.total_intervals === 2, "audio-only file still scans silence (2 gaps)", JSON.stringify(contentAudioOnly.content.silence));

const contentVideoOnly = await checkContent("test/content-video-only.mp4");
checkOk(contentVideoOnly.content.silence.status === "unavailable", "video-only file reports silence unavailable, not zero", JSON.stringify(contentVideoOnly.content));
checkOk(!contentVideoOnly.checks.some((c) => c.name === "content_silence"), "no content_silence rule when there is no audio stream", JSON.stringify(contentVideoOnly.checks));

// check --content: audio peaks (0.1s windows above -1 dBFS; the
// loud-peak fixture is quiet except a 1s burst at [1,2) that clips).
const contentLoudPeak = await checkContent("test/loud-peak.wav");
console.log("check content peaks loud file:", JSON.stringify(contentLoudPeak.content.peaks.intervals), "| max", contentLoudPeak.content.peaks.max_peak_db);
checkOk(contentLoudPeak.content.peaks.status === "complete", "peaks scan completes on an audio file", JSON.stringify(contentLoudPeak.content.peaks));
checkOk(contentLoudPeak.content.peaks.total_intervals === 1, "peaks finds exactly 1 hot interval in the burst file", JSON.stringify(contentLoudPeak.content.peaks.intervals));
checkOk(near(contentLoudPeak.content.peaks.intervals[0]?.start, 1, 0.05) && near(contentLoudPeak.content.peaks.intervals[0]?.end, 2, 0.05), "peaks interval covers the planted burst 1-2s", JSON.stringify(contentLoudPeak.content.peaks.intervals));
checkOk(near(contentLoudPeak.content.peaks.intervals[0]?.peak_db, 3.52, 0.3), "peaks reports the burst at +3.5 dBFS (digital clipping)", JSON.stringify(contentLoudPeak.content.peaks.intervals));
checkOk(contentLoudPeak.content.peaks.intervals[0]?.severity === "error", "a peak >= 0 dBFS is an error (clipping), not a warning", JSON.stringify(contentLoudPeak.content.peaks.intervals));
checkOk(near(contentLoudPeak.content.peaks.max_peak_db, 3.52, 0.3), "peaks max_peak_db matches the burst", JSON.stringify(contentLoudPeak.content.peaks));
checkOk(contentLoudPeak.content.pass === false, "content fails when audio clips", JSON.stringify(contentLoudPeak.content));
checkOk(contentLoudPeak.checks.find((c) => c.name === "content_peaks")?.pass === false, "content_peaks rule fails the check", JSON.stringify(contentLoudPeak.checks));
checkOk(contentLoudPeak.issues?.some((i) => i.startsWith("content_peaks")), "content_peaks appears in top-level issues", JSON.stringify(contentLoudPeak.issues));

const contentQuietPeak = await checkContent("test/quiet-peak.wav");
checkOk(contentQuietPeak.content.peaks.total_intervals === 0, "peaks finds nothing in the quiet file", JSON.stringify(contentQuietPeak.content.peaks));
checkOk(near(contentQuietPeak.content.peaks.max_peak_db, -18.06, 0.5), "peaks max on the quiet file is the sine level (-18 dBFS)", JSON.stringify(contentQuietPeak.content.peaks));
checkOk(contentQuietPeak.content.pass === true, "content passes on the quiet file");

const contentPeaksHighThreshold = await checkContent("test/loud-peak.wav", "tiktok", { peak_threshold_db: 5 });
checkOk(contentPeaksHighThreshold.content.peaks.total_intervals === 0, "a threshold above the burst peak (5 dBFS) reports nothing", JSON.stringify(contentPeaksHighThreshold.content.peaks));

// check --content: time range — the black stretch [3,6] is only
// found when the scanned range covers it; intervals stay on the
// file's own timeline.
const contentRangeBefore = await checkContent("test/content-black.mp4", "tiktok", { content_start: 0, content_end: 2 });
checkOk(contentRangeBefore.content.black.total_intervals === 0, "scanning 0-2s finds no black (the stretch starts at 3s)", JSON.stringify(contentRangeBefore.content.black));
checkOk(contentRangeBefore.content.time_range?.start_seconds === 0 && contentRangeBefore.content.time_range?.end_seconds === 2, "content reports the scanned time_range", JSON.stringify(contentRangeBefore.content.time_range));
const contentRangeCover = await checkContent("test/content-black.mp4", "tiktok", { content_start: 2, content_end: 8 });
checkOk(near(contentRangeCover.content.black.intervals[0]?.start, 3, 0.05) && near(contentRangeCover.content.black.intervals[0]?.end, 6, 0.05), "scanning 2-8s still finds the black stretch at 3-6s on the file timeline", JSON.stringify(contentRangeCover.content.black.intervals));
checkOk(contentRangeCover.content.black.intervals[0]?.severity === "error", "the stretch is still an error inside the scanned range", JSON.stringify(contentRangeCover.content.black.intervals));
const contentRangeBad = await callExpectThrow("check", { input: path.join(root, "test/content-black.mp4"), platform: "tiktok", content: true, content_start: 8, content_end: 2 });
checkOk(/after start/.test(contentRangeBad), "content end <= start is refused", contentRangeBad.slice(0, 200));
const contentRangeCli = await runCli(["check", path.join(root, "test/content-black.mp4"), "--content", "--start", "2"], {});
checkOk(contentRangeCli.code === 0, "CLI check --content --start works", contentRangeCli.out.slice(0, 200));
const contentRangeNoContent = await runCli(["check", path.join(root, "test/content-black.mp4"), "--start", "2"], {});
checkOk(contentRangeNoContent.code !== 0 && /need --content/.test(contentRangeNoContent.out), "CLI --start without --content is refused", contentRangeNoContent.out.slice(0, 200));

// check --content --baseline (lượt 128, idea: OpenEdit qc/gate.py):
// only NEW spans fail the gate — spans already in the source's own
// baseline snapshot are pre-existing, not render defects.
const baselinePlain = parseContentBaseline({ black: [{ start: 3, end: 6 }], freeze: [{ start: 3, end: 6 }] });
checkOk(baselinePlain.black.length === 1 && baselinePlain.freeze.length === 1 && baselinePlain.silence.length === 0 && baselinePlain.peaks.length === 0, "parseContentBaseline accepts a plain span list (missing kinds default to [])", JSON.stringify(baselinePlain));
const baselineFromCheck = parseContentBaseline(contentBlack);
checkOk(baselineFromCheck.black.length === 1 && near(baselineFromCheck.black[0].start, 3, 0.05) && near(baselineFromCheck.black[0].end, 6, 0.05), "parseContentBaseline accepts a full check result ({content: {...}})", JSON.stringify(baselineFromCheck.black));
const baselineFromContent = parseContentBaseline(contentBlack.content);
checkOk(baselineFromContent.freeze.length === 1 && near(baselineFromContent.freeze[0].start, 3, 0.05), "parseContentBaseline accepts a raw content result ({black: {intervals}, ...})", JSON.stringify(baselineFromContent.freeze));
let baselineBad = null;
try { parseContentBaseline({ black: [{ start: 6, end: 3 }] }); } catch (e) { baselineBad = e.message; }
checkOk(/invalid span/.test(baselineBad ?? ""), "parseContentBaseline refuses an end<=start span", baselineBad ?? "");
let baselineBadShape = null;
try { parseContentBaseline([1, 2]); } catch (e) { baselineBadShape = e.message; }
checkOk(/JSON object/.test(baselineBadShape ?? ""), "parseContentBaseline refuses a non-object baseline", baselineBadShape ?? "");
// Pure matching: 50% overlap is the boundary — 1.5s of a 3s interval
// counts as pre-existing, 1.4s does not; a black baseline never
// forgives a freeze interval; the input object is not mutated.
const matchContent = {
  operation: "content", duration_seconds: 10, pass: false,
  issues: ["black: black mid-file 3s–6s (3s) — broken render or missing footage"],
  black: { status: "complete", total_intervals: 1, total_duration_seconds: 3, intervals_truncated: false, intervals: [{ start: 3, end: 6, duration: 3, severity: "error", reason: "black mid-file 3s–6s (3s) — broken render or missing footage" }] },
  freeze: { status: "complete", total_intervals: 0, total_duration_seconds: 0, intervals_truncated: false, intervals: [] },
  silence: { status: "complete", total_intervals: 0, total_duration_seconds: 0, intervals_truncated: false, intervals: [] },
  peaks: { status: "complete", total_intervals: 0, total_duration_seconds: 0, intervals_truncated: false, intervals: [] },
};
const matchHalf = applyContentBaseline(matchContent, { black: [{ start: 3, end: 4.5 }], freeze: [], silence: [], peaks: [] });
checkOk(matchHalf.black.intervals[0]?.pre_existing === true && matchHalf.black.intervals[0]?.baseline_overlap_seconds === 1.5 && matchHalf.pass === true && !matchHalf.issues && matchHalf.warnings?.length === 1, "applyContentBaseline: 50% overlap (1.5s of 3s) is pre-existing, demotes the error to a warning, content passes", JSON.stringify(matchHalf.baseline));
const matchUnder = applyContentBaseline(matchContent, { black: [{ start: 3, end: 4.4 }], freeze: [], silence: [], peaks: [] });
checkOk(matchUnder.black.intervals[0]?.pre_existing !== true && matchUnder.pass === false && matchUnder.issues?.length === 1, "applyContentBaseline: 1.4s of 3s (<50%) is a NEW span, still fails", JSON.stringify(matchUnder.baseline));
const matchWrongKind = applyContentBaseline(matchContent, { black: [], freeze: [{ start: 3, end: 6 }], silence: [], peaks: [] });
checkOk(matchWrongKind.black.intervals[0]?.pre_existing !== true && matchWrongKind.baseline.matched === 0, "applyContentBaseline: a freeze baseline span does not forgive a black interval", JSON.stringify(matchWrongKind.baseline));
checkOk(matchContent.black.intervals[0]?.pre_existing === undefined && matchContent.pass === false, "applyContentBaseline does not mutate its input", JSON.stringify(matchContent.black.intervals[0]));
// MCP end to end on the real fixture: the planted black/freeze 3-6s
// is forgiven by the matching baseline and still fails against a
// baseline that covers a different stretch.
const contentBaselineMatch = await checkContent("test/content-black.mp4", "tiktok", { baseline: path.join(root, "test/content-baseline-black.json") });
console.log("check content baseline match:", JSON.stringify(contentBaselineMatch.baseline), "| black rule:", JSON.stringify(contentBaselineMatch.checks.find((c) => c.name === "content_black")));
checkOk(contentBaselineMatch.content.pass === true, "check --content --baseline passes the content gate when every error span is pre-existing", JSON.stringify(contentBaselineMatch.content));
checkOk(contentBaselineMatch.content.black.intervals[0]?.pre_existing === true && contentBaselineMatch.content.black.intervals[0]?.baseline_overlap_seconds === 3, "the black interval is flagged pre_existing with its 3s overlap", JSON.stringify(contentBaselineMatch.content.black.intervals));
checkOk(contentBaselineMatch.baseline?.matched === 2 && contentBaselineMatch.baseline?.new_spans === 0 && contentBaselineMatch.baseline?.spans === 2, "baseline summary reports 2 spans, 2 matched, 0 new", JSON.stringify(contentBaselineMatch.baseline));
checkOk(contentBaselineMatch.checks.find((c) => c.name === "content_black")?.severity === "warn" && /1 pre-existing/.test(contentBaselineMatch.checks.find((c) => c.name === "content_black")?.actual ?? ""), "content_black rule is demoted to warn and names the pre-existing span", JSON.stringify(contentBaselineMatch.checks.find((c) => c.name === "content_black")));
checkOk(!contentBaselineMatch.issues?.some((i) => i.startsWith("content_black")) && !contentBaselineMatch.issues?.some((i) => i.startsWith("content_freeze")), "pre-existing spans leave the top-level issues list", JSON.stringify(contentBaselineMatch.issues));
checkOk(contentBaselineMatch.warnings?.some((w) => w.startsWith("content_black")), "pre-existing spans still show in top-level warnings", JSON.stringify(contentBaselineMatch.warnings));
const contentBaselineWrong = await checkContent("test/content-black.mp4", "tiktok", { baseline: path.join(root, "test/content-baseline-wrong.json") });
checkOk(contentBaselineWrong.content.pass === false && contentBaselineWrong.baseline?.matched === 0 && contentBaselineWrong.baseline?.new_spans === 2, "a baseline covering 0-1s forgives nothing: 0 matched, 2 new", JSON.stringify(contentBaselineWrong.baseline));
checkOk(contentBaselineWrong.checks.find((c) => c.name === "content_black")?.severity !== "warn" && contentBaselineWrong.issues?.some((i) => i.startsWith("content_black")), "content_black still fails as an error against the wrong baseline", JSON.stringify(contentBaselineWrong.checks.find((c) => c.name === "content_black")));
checkOk(contentBaselineWrong.content.black.intervals[0]?.pre_existing === undefined, "no pre_existing flag against the wrong baseline", JSON.stringify(contentBaselineWrong.content.black.intervals));
// Dogfood: the check result itself is a valid baseline (shape 1).
await writeFile(path.join(root, "outputs/mcp-baseline-dogfood.json"), JSON.stringify(contentBlack));
const contentBaselineDogfood = await checkContent("test/content-black.mp4", "tiktok", { baseline: path.join(root, "outputs/mcp-baseline-dogfood.json") });
checkOk(contentBaselineDogfood.content.pass === true && contentBaselineDogfood.baseline?.matched === 2, "a previous check --content result fed back as baseline forgives its own spans", JSON.stringify(contentBaselineDogfood.baseline));
const baselineMissing = await callExpectThrow("check", { input: path.join(root, "test/content-black.mp4"), platform: "tiktok", content: true, baseline: path.join(root, "test/no-such-baseline.json") });
checkOk(/baseline not found/.test(baselineMissing), "a missing baseline file fails loudly instead of silently passing", baselineMissing.slice(0, 200));
const baselineNoContent = await callExpectThrow("check", { input: path.join(root, "test/content-black.mp4"), platform: "tiktok", baseline: path.join(root, "test/content-baseline-black.json") });
checkOk(/needs --content/.test(baselineNoContent), "MCP baseline without content=true is refused", baselineNoContent.slice(0, 200));
const contentBaselineCli = await runCli(["check", path.join(root, "test/content-black.mp4"), "--content", "--baseline", path.join(root, "test/content-baseline-black.json")], {});
checkOk(contentBaselineCli.code === 0 && /pre-existing/.test(contentBaselineCli.out), "CLI check --content --baseline works and reports pre-existing spans", contentBaselineCli.out.slice(0, 300));

// Style pace (lượt 133, idea: marvtub/takes-public measure_pace /
// check_edit): pure numbers first — paceNumbers is Takes'
// pace_numbers, same shape and rounding; scoreStylePace is their
// chk_style_pace with the PACE_OFF tolerances kept verbatim (cuts
// within 2x either way, longest hold over style x1.5 AND +2s).
const paceNums = paceNumbers([5, 10, 15], 20);
checkOk(paceNums.seconds === 20 && paceNums.cuts === 3 && paceNums.cuts_per_min === 9 && paceNums.avg_shot_s === 5 && paceNums.longest_hold_s === 5 && paceNums.longest_at === 0, "paceNumbers([5,10,15], 20) is 3 cuts, 9/min, avg 5s, longest 5s at 0s", JSON.stringify(paceNums));
const paceOneShot = paceNumbers([], 20);
checkOk(paceOneShot.cuts === 0 && paceOneShot.cuts_per_min === 0 && paceOneShot.avg_shot_s === 20 && paceOneShot.longest_hold_s === 20 && paceOneShot.longest_at === 0, "paceNumbers with no cuts is one 20s hold", JSON.stringify(paceOneShot));
const paceLongestMid = paceNumbers([5, 15], 20);
checkOk(paceLongestMid.longest_hold_s === 10 && paceLongestMid.longest_at === 5 && paceLongestMid.cuts_per_min === 6, "paceNumbers finds the longest hold mid-film (10s from 5s) and 6 cuts/min", JSON.stringify(paceLongestMid));
const scoreSlow = scoreStylePace({ cuts_per_min: 3, longest_hold_s: 10, longest_at: 0 }, { cuts_per_min: 12, longest_hold_s: 8 }, "warm-story");
checkOk(scoreSlow.length === 2 && scoreSlow[0].severity === "warn" && /cuts 3 times a minute; warm-story cuts 12/.test(scoreSlow[0].message) && /Fewer cuts/.test(scoreSlow[0].fix ?? "") && scoreSlow[1].severity === "pass", "scoreStylePace warns on 3 cuts/min vs a 12/min style (hold 10s inside the 12s limit passes)", JSON.stringify(scoreSlow));
const scoreFast = scoreStylePace({ cuts_per_min: 30, longest_hold_s: 2, longest_at: 0 }, { cuts_per_min: 12, longest_hold_s: 8 }, "warm-story");
checkOk(scoreFast[0].severity === "warn" && /More cuts/.test(scoreFast[0].fix ?? ""), "scoreStylePace warns on 30 cuts/min vs a 12/min style (over the 2x ceiling)", JSON.stringify(scoreFast));
const scoreHold = scoreStylePace({ cuts_per_min: 6, longest_hold_s: 10, longest_at: 5 }, { cuts_per_min: 12, longest_hold_s: 4 }, "tight");
checkOk(scoreHold.length === 2 && scoreHold[0].severity === "pass" && scoreHold[1].severity === "warn" && /holds 10 s from 5 s; tight holds at most 4 s/.test(scoreHold[1].message) && /Cut a pause/.test(scoreHold[1].fix ?? ""), "scoreStylePace warns when the 10s hold beats the 6s limit (max(4x1.5, 4+2)) while 6 cuts/min passes at the 2x floor", JSON.stringify(scoreHold));
const scoreBoundary = scoreStylePace({ cuts_per_min: 6, longest_hold_s: 12, longest_at: 0 }, { cuts_per_min: 12, longest_hold_s: 8 }, "warm-story");
checkOk(scoreBoundary.every((f) => f.severity === "pass"), "scoreStylePace passes exactly at both boundaries (6 = 12/2, hold 12 = max(8x1.5, 8+2))", JSON.stringify(scoreBoundary));
const scorePartial = scoreStylePace({ cuts_per_min: 3, longest_hold_s: 10, longest_at: 0 }, { cuts_per_min: 12 }, "warm-story");
checkOk(scorePartial.length === 1 && scorePartial[0].metric === "cuts_per_min", "scoreStylePace scores only the metrics the style carries (no longest_hold_s = no hold finding)", JSON.stringify(scorePartial));
const styleParsed = parseStyleFile({ version: 1, name: "warm-story", pace: { cuts_per_min: 12, longest_hold_s: 8 }, notes: "keep me" });
checkOk(styleParsed.name === "warm-story" && styleParsed.pace.cuts_per_min === 12 && styleParsed.pace.longest_hold_s === 8, "parseStyleFile accepts a full style file", JSON.stringify(styleParsed));
checkOk(parseStyleFile({ version: 1, name: "no-pace" }).pace === null, "parseStyleFile accepts a style with no pace block (pace null)", JSON.stringify(parseStyleFile({ version: 1, name: "no-pace" })));
let styleBadVersion = null;
try { parseStyleFile({ version: 2, pace: { cuts_per_min: 12 } }); } catch (e) { styleBadVersion = e.message; }
checkOk(/version must be 1/.test(styleBadVersion ?? ""), "parseStyleFile refuses a version other than 1", styleBadVersion ?? "");
let styleBadCpm = null;
try { parseStyleFile({ pace: { cuts_per_min: 0 } }); } catch (e) { styleBadCpm = e.message; }
checkOk(/cuts_per_min.*over 0/.test(styleBadCpm ?? ""), "parseStyleFile refuses cuts_per_min 0", styleBadCpm ?? "");
let styleEmptyPace = null;
try { parseStyleFile({ pace: {} }); } catch (e) { styleEmptyPace = e.message; }
checkOk(/at least one of/.test(styleEmptyPace ?? ""), "parseStyleFile refuses a pace block with neither metric", styleEmptyPace ?? "");
let styleBadShape = null;
try { parseStyleFile([1, 2]); } catch (e) { styleBadShape = e.message; }
checkOk(/JSON object/.test(styleBadShape ?? ""), "parseStyleFile refuses a non-object style file", styleBadShape ?? "");
const contentBaselineCliNoContent = await runCli(["check", path.join(root, "test/content-black.mp4"), "--baseline", path.join(root, "test/content-baseline-black.json")], {});
checkOk(contentBaselineCliNoContent.code !== 0 && /needs --content/.test(contentBaselineCliNoContent.out), "CLI --baseline without --content is refused", contentBaselineCliNoContent.out.slice(0, 200));

// check audio_sync (lượt 127, idea: OpenEdit qc/gate.py): video and
// audio stream durations must agree within ±0.2s.
async function checkSync(file) {
  const r = await client.callTool({ name: "check", arguments: { input: path.join(root, file), platform: "youtube" } });
  return JSON.parse(r.content[0].text);
}
const syncOk = await checkSync("test/avsync-ok.mp4");
checkOk(syncOk.checks.find((c) => c.name === "audio_sync")?.pass === true, "audio_sync passes when video and audio are both 5s", JSON.stringify(syncOk.checks.find((c) => c.name === "audio_sync")));
const syncDrift = await checkSync("test/avsync-drift.mp4");
const syncDriftRule = syncDrift.checks.find((c) => c.name === "audio_sync");
console.log("check audio_sync drift:", JSON.stringify(syncDriftRule));
checkOk(syncDriftRule?.pass === false && /-0\.6s/.test(syncDriftRule?.actual ?? ""), "audio_sync fails on 5s video vs 4.4s audio (Δ -0.6s)", JSON.stringify(syncDriftRule));
checkOk(syncDrift.issues?.some((i) => i.startsWith("audio_sync")), "audio_sync appears in top-level issues", JSON.stringify(syncDrift.issues));
const syncVideoOnly = await checkSync("test/content-video-only.mp4");
checkOk(!syncVideoOnly.checks.some((c) => c.name === "audio_sync"), "no audio_sync rule on a video-only file (unmeasurable, not failed)", JSON.stringify(syncVideoOnly.checks.map((c) => c.name)));

// check --palette (lượt 127, idea: cardstock-diorama-myth qc.py):
// frames sampled at 2 fps, measured against a locked look.
async function checkPalette(file, extra) {
  const r = await client.callTool({ name: "check", arguments: { input: path.join(root, file), platform: "youtube", ...extra } });
  return JSON.parse(r.content[0].text);
}
const paletteGrey = await checkPalette("test/palette-grey.mp4", { palette: "#808080,#FFFFFF,#000000" });
console.log("check palette grey:", JSON.stringify(paletteGrey.palette));
checkOk(paletteGrey.palette?.colors?.find((c) => c.hex === "#808080")?.share_pct === 100, "palette: solid grey is 100% grey", JSON.stringify(paletteGrey.palette));
checkOk(paletteGrey.palette?.off_palette_pct === 0 && paletteGrey.palette?.frames_sampled === 6, "palette: 0% off-palette, 6 frames sampled at 2 fps over 3s", JSON.stringify(paletteGrey.palette));
checkOk(near(paletteGrey.palette?.mean_luma, 126, 3), "palette: mean luma of grey 128 is ~126 (yuv rounding)", `got ${paletteGrey.palette?.mean_luma}`);
checkOk(paletteGrey.checks.find((c) => c.name === "content_palette")?.pass === true, "content_palette passes on the matching grey palette", JSON.stringify(paletteGrey.checks.find((c) => c.name === "content_palette")));
const paletteWhite = await checkPalette("test/palette-white.mp4", { palette: "#808080,#FFFFFF,#000000" });
checkOk(paletteWhite.palette?.blown_pct === 100, "palette: solid white is 100% blown", JSON.stringify(paletteWhite.palette));
checkOk(paletteWhite.checks.find((c) => c.name === "content_palette")?.pass === false && !paletteWhite.checks.find((c) => c.name === "content_palette")?.severity, "content_palette fails (error) when blown past 2%", JSON.stringify(paletteWhite.checks.find((c) => c.name === "content_palette")));
checkOk(paletteWhite.issues?.some((i) => i.startsWith("content_palette")), "content_palette appears in top-level issues", JSON.stringify(paletteWhite.issues));
const paletteRed = await checkPalette("test/palette-red.mp4", { palette: "#808080,#FFFFFF,#000000" });
console.log("check palette red:", JSON.stringify(paletteRed.palette));
checkOk(paletteRed.palette?.off_palette_pct === 100, "palette: solid red is 100% off a grey/white/black palette", JSON.stringify(paletteRed.palette));
checkOk(paletteRed.checks.find((c) => c.name === "content_palette")?.pass === false && paletteRed.checks.find((c) => c.name === "content_palette")?.severity === "warn", "content_palette only warns (mean luma 75 < 95, all off-palette) instead of failing", JSON.stringify(paletteRed.checks.find((c) => c.name === "content_palette")));
checkOk(paletteRed.warnings?.some((w) => w.startsWith("content_palette")), "content_palette warning appears in top-level warnings", JSON.stringify(paletteRed.warnings));
const paletteBrand = await checkPalette("test/palette-grey.mp4", { palette_brand: "warm-story" });
checkOk(paletteBrand.palette?.brand === "warm-story" && paletteBrand.palette?.colors?.length === 4, "palette_brand warm-story resolves to 4 distinct brand colors (text == on_primary deduped)", JSON.stringify(paletteBrand.palette));
checkOk(paletteBrand.palette?.off_palette_pct === 100, "palette_brand: grey is 100% off the warm-story palette", JSON.stringify(paletteBrand.palette));
const paletteBad = await callExpectThrow("check", { input: path.join(root, "test/palette-grey.mp4"), platform: "youtube", palette: "#808080" });
checkOk(/2-6 colors/.test(paletteBad), "a 1-color palette is refused", paletteBad.slice(0, 200));
const paletteBadHex = await callExpectThrow("check", { input: path.join(root, "test/palette-grey.mp4"), platform: "youtube", palette: "#GGGGGG,#FFFFFF" });
checkOk(/6-digit hex/.test(paletteBadHex), "a non-hex palette color is refused", paletteBadHex.slice(0, 200));
const paletteBoth = await callExpectThrow("check", { input: path.join(root, "test/palette-grey.mp4"), platform: "youtube", palette: "#808080,#FFFFFF", palette_brand: "warm-story" });
checkOk(/mutually exclusive/.test(paletteBoth), "palette + palette_brand together are refused", paletteBoth.slice(0, 200));
const paletteBadBrand = await callExpectThrow("check", { input: path.join(root, "test/palette-grey.mp4"), platform: "youtube", palette_brand: "nope" });
checkOk(/palette brand must be one of/.test(paletteBadBrand), "an unknown palette brand is refused", paletteBadBrand.slice(0, 200));
const paletteCli = await runCli(["check", path.join(root, "test/palette-grey.mp4"), "--platform", "youtube", "--palette", "#808080,#FFFFFF,#000000"], {});
checkOk(paletteCli.code === 0, "CLI check --palette works", paletteCli.out.slice(0, 200));
const paletteCliBoth = await runCli(["check", path.join(root, "test/palette-grey.mp4"), "--palette", "#808080,#FFFFFF", "--palette-brand", "warm-story"], {});
checkOk(paletteCliBoth.code !== 0 && /mutually exclusive/.test(paletteCliBoth.out), "CLI --palette + --palette-brand together are refused", paletteCliBoth.out.slice(0, 200));

// check --policy (lượt 129, idea: OpenEdit qc/policy.py): skip/light/
// full tiers — a light pass is an honest partial gate (complete:false
// + skipped list), never a silent partial pass; skip runs nothing.
const savedQcEnv = process.env.MEDIAKIT_QC_POLICY;
delete process.env.MEDIAKIT_QC_POLICY;
checkOk(resolveQcPolicy(null) === "full", "resolveQcPolicy defaults to full with no flag and no env", `got ${resolveQcPolicy(null)}`);
checkOk(resolveQcPolicy("light") === "light" && resolveQcPolicy("SKIP") === "skip", "resolveQcPolicy accepts light/skip (case-insensitive)", "light/SKIP");
let qcBadArg = null;
try { resolveQcPolicy("bogus"); } catch (e) { qcBadArg = e.message; }
checkOk(/unknown QC policy/.test(qcBadArg ?? ""), "resolveQcPolicy refuses an unknown tier", qcBadArg ?? "");
process.env.MEDIAKIT_QC_POLICY = "light";
checkOk(resolveQcPolicy(null) === "light", "MEDIAKIT_QC_POLICY sets the default when the flag is absent", `got ${resolveQcPolicy(null)}`);
checkOk(resolveQcPolicy("full") === "full", "an explicit --policy wins over MEDIAKIT_QC_POLICY", `got ${resolveQcPolicy("full")}`);
let qcBadEnv = null;
try { process.env.MEDIAKIT_QC_POLICY = "bogus"; resolveQcPolicy(null); } catch (e) { qcBadEnv = e.message; }
checkOk(/unknown QC policy/.test(qcBadEnv ?? ""), "an invalid MEDIAKIT_QC_POLICY fails loudly instead of silently defaulting", qcBadEnv ?? "");
if (savedQcEnv === undefined) delete process.env.MEDIAKIT_QC_POLICY; else process.env.MEDIAKIT_QC_POLICY = savedQcEnv;
async function checkPolicy(file, extra) {
  const r = await client.callTool({ name: "check", arguments: { input: path.join(root, file), platform: "youtube", ...extra } });
  return JSON.parse(r.content[0].text);
}
const policyFull = await checkPolicy("test/content-black.mp4", {});
checkOk(policyFull.policy === "full" && policyFull.complete === true, "default check reports policy full, complete true", JSON.stringify({ policy: policyFull.policy, complete: policyFull.complete }));
const policyLight = await checkPolicy("test/content-black.mp4", { policy: "light" });
console.log("check policy light:", JSON.stringify({ policy: policyLight.policy, complete: policyLight.complete, skipped: policyLight.skipped, pass: policyLight.pass, rules: policyLight.checks.map((c) => c.name) }));
checkOk(policyLight.policy === "light" && policyLight.complete === false, "light reports policy light, complete false", JSON.stringify({ policy: policyLight.policy, complete: policyLight.complete }));
checkOk(JSON.stringify(policyLight.skipped) === JSON.stringify(["content", "palette"]) && /decode-heavy/.test(policyLight.reason ?? ""), "light lists the skipped decode-heavy detectors and says so in reason", JSON.stringify(policyLight.skipped));
checkOk(!policyLight.checks.some((c) => c.name.startsWith("content_")) && policyLight.checks.some((c) => c.name === "dimensions") && policyLight.checks.some((c) => c.name === "loudness") && policyLight.checks.some((c) => c.name === "audio_sync"), "light runs probe-based rules (dimensions, loudness, audio_sync) and no content_* rule", JSON.stringify(policyLight.checks.map((c) => c.name)));
checkOk(policyLight.pass === false && policyLight.issues?.some((i) => i.startsWith("dimensions")), "light still fails honestly on a probe rule (1280x720 vs youtube 1920x1080)", JSON.stringify(policyLight.issues));
checkOk(!("content" in policyLight) && !("palette" in policyLight), "light carries no content/palette section (nothing was measured)", Object.keys(policyLight).join(","));
const policySkip = await checkPolicy("test/content-black.mp4", { policy: "skip" });
checkOk(policySkip.policy === "skip" && policySkip.pass === true && policySkip.complete === false && policySkip.checks.length === 0, "skip returns pass:true, complete:false, no rules at all", JSON.stringify({ policy: policySkip.policy, pass: policySkip.pass, complete: policySkip.complete, checks: policySkip.checks }));
checkOk(JSON.stringify(policySkip.skipped) === JSON.stringify(["probe", "loudness", "audio_sync", "content", "palette"]) && /policy=skip/.test(policySkip.reason ?? ""), "skip lists every skipped group and names the policy in reason", JSON.stringify(policySkip.skipped));
const policyLightContent = await callExpectThrow("check", { input: path.join(root, "test/content-black.mp4"), platform: "youtube", policy: "light", content: true });
checkOk(/policy light/.test(policyLightContent), "light + content=true is refused instead of silently dropping the scan", policyLightContent.slice(0, 200));
const policyLightPalette = await callExpectThrow("check", { input: path.join(root, "test/content-black.mp4"), platform: "youtube", policy: "light", palette: "#808080,#FFFFFF" });
checkOk(/policy light/.test(policyLightPalette), "light + palette is refused", policyLightPalette.slice(0, 200));
const policyLightBaseline = await callExpectThrow("check", { input: path.join(root, "test/content-black.mp4"), platform: "youtube", policy: "light", content: true, baseline: path.join(root, "test/content-baseline-black.json") });
checkOk(/policy light/.test(policyLightBaseline), "light + baseline is refused", policyLightBaseline.slice(0, 200));
const policyBad = await callExpectThrow("check", { input: path.join(root, "test/content-black.mp4"), platform: "youtube", policy: "bogus" });
checkOk(/Invalid enum value|unknown QC policy/.test(policyBad), "an unknown policy tier is refused (zod enum)", policyBad.slice(0, 200));
const policyLightCli = await runCli(["check", path.join(root, "test/content-black.mp4"), "--platform", "youtube", "--policy", "light"], {});
checkOk(policyLightCli.code === 0 && /"policy": "light"/.test(policyLightCli.out) && /"complete": false/.test(policyLightCli.out), "CLI check --policy light works and reports light + complete:false", policyLightCli.out.slice(0, 300));
const policySkipCli = await runCli(["check", path.join(root, "test/content-black.mp4"), "--policy", "skip"], {});
checkOk(policySkipCli.code === 0 && /"policy": "skip"/.test(policySkipCli.out) && /"complete": false/.test(policySkipCli.out), "CLI check --policy skip works", policySkipCli.out.slice(0, 300));
const policyBogusCli = await runCli(["check", path.join(root, "test/content-black.mp4"), "--policy", "bogus"], {});
checkOk(policyBogusCli.code !== 0 && /unknown QC policy/.test(policyBogusCli.out), "CLI --policy bogus is refused", policyBogusCli.out.slice(0, 200));
const policyLightContentCli = await runCli(["check", path.join(root, "test/content-black.mp4"), "--policy", "light", "--content"], {});
checkOk(policyLightContentCli.code !== 0 && /policy light/.test(policyLightContentCli.out), "CLI --policy light --content is refused", policyLightContentCli.out.slice(0, 200));
const policyEnvCli = await runCli(["check", path.join(root, "test/content-black.mp4"), "--platform", "youtube"], { MEDIAKIT_QC_POLICY: "skip" });
checkOk(policyEnvCli.code === 0 && /"policy": "skip"/.test(policyEnvCli.out), "CLI honors MEDIAKIT_QC_POLICY=skip when --policy is absent", policyEnvCli.out.slice(0, 300));

// grade: named presets + custom filter, verified on pixels.
// Source mid-frame is near-neutral (R 122, G 128, B 127).
const gradeWarmRes = await client.callTool({
  name: "grade",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-warm.mp4"), preset: "warm" },
});
const gradeWarm = JSON.parse(gradeWarmRes.content[0].text);
console.log("grade warm:", JSON.stringify(gradeWarm.color_before), "->", JSON.stringify(gradeWarm.color_after), "|", gradeWarm.dimensions, gradeWarm.duration_seconds);
checkOk(gradeWarm.preset === "warm" && gradeWarm.filter?.includes("colorbalance"), "grade warm reports the preset and its filter chain", JSON.stringify(gradeWarm));
checkOk(typeof gradeWarm.size_bytes === "number" && gradeWarm.size_bytes > 0, "grade reports size_bytes measured on disk (fileInfo regression: info.size was undefined)", `size_bytes=${gradeWarm.size_bytes}`);
checkOk(gradeWarm.dimensions === "1280x720" && near(gradeWarm.duration_seconds, 10, 0.05), "grade keeps dimensions and duration", `${gradeWarm.dimensions} ${gradeWarm.duration_seconds}s`);
checkOk(typeof gradeWarm.color_before?.r === "number" && typeof gradeWarm.color_after?.r === "number", "grade measures channel means before and after", JSON.stringify(gradeWarm));
checkOk((gradeWarm.color_after.r - gradeWarm.color_after.b) - (gradeWarm.color_before.r - gradeWarm.color_before.b) > 10, "warm pushes red over blue by >10 (R-B grows)", `${JSON.stringify(gradeWarm.color_before)} -> ${JSON.stringify(gradeWarm.color_after)}`);
// Independent pixel check (same planeMean helper as the titlecard
// tests, frame 0 of each file): warm must move R-B the same way.
const warmInR = await planeMean(path.join(root, "test/source.mp4"), "1280:720:0:0", "r");
const warmInB = await planeMean(path.join(root, "test/source.mp4"), "1280:720:0:0", "b");
const warmOutR = await planeMean(path.join(root, "outputs/mcp-grade-warm.mp4"), "1280:720:0:0", "r");
const warmOutB = await planeMean(path.join(root, "outputs/mcp-grade-warm.mp4"), "1280:720:0:0", "b");
checkOk(warmInR !== null && warmOutR !== null && (warmOutR - warmOutB) - (warmInR - warmInB) > 5, "independent pixel check: warm raises R-B on the output file", `in ${warmInR}/${warmInB} out ${warmOutR}/${warmOutB}`);

const gradeNoirRes = await client.callTool({
  name: "grade",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-noir.mp4"), preset: "noir" },
});
const gradeNoir = JSON.parse(gradeNoirRes.content[0].text);
checkOk(Math.abs(gradeNoir.color_after.r - gradeNoir.color_after.g) < 3 && Math.abs(gradeNoir.color_after.g - gradeNoir.color_after.b) < 3, "noir equalizes R=G=B (black and white)", JSON.stringify(gradeNoir.color_after));

const gradeCustomRes = await client.callTool({
  name: "grade",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-custom.mp4"), filter: "eq=saturation=0" },
});
const gradeCustom = JSON.parse(gradeCustomRes.content[0].text);
checkOk(gradeCustom.preset === null && gradeCustom.filter === "eq=saturation=0", "custom filter is reported verbatim, preset null", JSON.stringify(gradeCustom));
checkOk(Math.abs(gradeCustom.color_after.r - gradeCustom.color_after.g) < 3 && Math.abs(gradeCustom.color_after.g - gradeCustom.color_after.b) < 3, "custom eq=saturation=0 also grayscales", JSON.stringify(gradeCustom.color_after));

// grade --cdl: ASC CDL on a flat gray fixture — each channel must move
// by its own slope (R 128*1.5≈192, G unchanged, B 128*0.7≈89),
// measured on the tool's own before/after means.
const gradeCdlRes = await client.callTool({
  name: "grade",
  arguments: { input: path.join(root, "test/flat-gray.mp4"), output: path.join(root, "outputs/mcp-grade-cdl.mp4"), cdl: { slope: [1.5, 1, 0.7] } },
});
const gradeCdl = JSON.parse(gradeCdlRes.content[0].text);
console.log("grade cdl:", JSON.stringify(gradeCdl.color_before), "->", JSON.stringify(gradeCdl.color_after));
checkOk(gradeCdl.preset === null && gradeCdl.cdl?.slope?.[0] === 1.5 && gradeCdl.filter?.includes("lutrgb"), "grade --cdl reports preset null, the CDL values and a lutrgb chain", JSON.stringify(gradeCdl).slice(0, 300));
checkOk(near(gradeCdl.color_after.r, 192, 8) && near(gradeCdl.color_after.g, 128, 5) && near(gradeCdl.color_after.b, 89, 8), "grade --cdl slope moves R 128->~192 and B 128->~89 on a flat gray frame", JSON.stringify(gradeCdl.color_after));
checkOk(near(gradeCdl.color_before.r, 128, 5) && gradeCdl.dimensions === "320x180" && near(gradeCdl.duration_seconds, 2, 0.05), "grade --cdl keeps dimensions and duration", `${gradeCdl.dimensions} ${gradeCdl.duration_seconds}s`);
const gradeCdlSatRes = await client.callTool({
  name: "grade",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-cdl-sat.mp4"), cdl: { saturation: 0 } },
});
const gradeCdlSat = JSON.parse(gradeCdlSatRes.content[0].text);
checkOk(Math.abs(gradeCdlSat.color_after.r - gradeCdlSat.color_after.g) < 3 && Math.abs(gradeCdlSat.color_after.g - gradeCdlSat.color_after.b) < 3, "grade --cdl saturation 0 grayscales", JSON.stringify(gradeCdlSat.color_after));
const gradeCdlBoth = await callExpectThrow("grade", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-cdl-both.mp4"), preset: "warm", cdl: { slope: [1.2, 1, 1] } });
checkOk(/mutually exclusive/.test(gradeCdlBoth), "grade refuses preset + cdl together", gradeCdlBoth.slice(0, 200));
const gradeCdlBad = await callExpectThrow("grade", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-cdl-bad.mp4"), cdl: { slope: [1.2, 1] } });
checkOk(/cdl\.slope/.test(gradeCdlBad), "grade refuses a 2-value cdl slope", gradeCdlBad.slice(0, 200));

const gradeBadPreset = await callExpectThrow("grade", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-bad.mp4"), preset: "neon" });
checkOk(/preset|Invalid enum/i.test(gradeBadPreset), "grade rejects an unknown preset", gradeBadPreset.slice(0, 200));
const gradeBoth = await callExpectThrow("grade", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-both.mp4"), preset: "warm", filter: "eq=saturation=0" });
checkOk(/mutually exclusive/.test(gradeBoth), "grade refuses preset + filter together", gradeBoth.slice(0, 200));
const gradeAudioOnly = await callExpectThrow("grade", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-grade-audio.mp4"), preset: "warm" });
checkOk(/needs a video input/.test(gradeAudioOnly), "grade refuses an audio-only input", gradeAudioOnly.slice(0, 200));
// grade --dry-run (lượt 105): color_before is measured on the input
// (read-only), color_after is measured on the output file, so null.
const gradeDryRes = await client.callTool({
  name: "grade",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-dry.mp4"), preset: "warm", dry_run: true },
});
const gradeDry = JSON.parse(gradeDryRes.content[0].text);
console.log("grade dry-run:", JSON.stringify({ preset: gradeDry.preset, color_before: gradeDry.color_before, color_after: gradeDry.color_after }));
checkOk(gradeDry.dry_run === true && gradeDry.preset === "warm" && gradeDry.filter?.includes("colorbalance") && typeof gradeDry.color_before?.r === "number" && gradeDry.color_after === null, "grade dry-run reports the preset + real color_before, color_after null", JSON.stringify(gradeDry));
checkOk(gradeDry.commands?.length === 1 && gradeDry.commands[0].includes("colorbalance"), "grade dry-run prints the exact grade command", gradeDry.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-grade-dry.mp4")), "grade dry-run writes no file", "outputs/mcp-grade-dry.mp4");
const gradeDryBad = await callExpectThrow("grade", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-dry-bad.mp4"), preset: "neon", dry_run: true });
checkOk(/preset|Invalid enum/i.test(gradeDryBad), "grade dry-run still validates the preset before returning", gradeDryBad.slice(0, 200));

// reverse: video + audio backwards, verified on pixels and on the
// silence gaps. scenes-source is red [0,5) then blue [5,10); the
// reversed clip must be blue first, red last. mix-voice has tone
// [0,2),[4,6),[7,9) and silence [2,4),[6,7); reversed audio (9s)
// must have silence [2,3) and [5,7) instead.
const reverseRes = await client.callTool({
  name: "reverse",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-reverse.mp4") },
});
const reverseJson = JSON.parse(reverseRes.content[0].text);
console.log("reverse call:", JSON.stringify(reverseJson));
checkOk(reverseJson.video_reversed === true && reverseJson.audio_reversed === true, "reverse reports video + audio reversed", JSON.stringify(reverseJson));
checkOk(typeof reverseJson.size_bytes === "number" && reverseJson.size_bytes > 0, "reverse reports size_bytes measured on disk (fileInfo regression: info.size was undefined)", `size_bytes=${reverseJson.size_bytes}`);
checkOk(reverseJson.dimensions === "640x360" && near(reverseJson.duration_seconds, 10.05, 0.1), "reverse keeps dimensions and duration", `${reverseJson.dimensions} ${reverseJson.duration_seconds}s`);
const revFirstR = await planeMean(path.join(root, "outputs/mcp-reverse.mp4"), "640:360:0:0", "r", 1);
const revFirstB = await planeMean(path.join(root, "outputs/mcp-reverse.mp4"), "640:360:0:0", "b", 1);
const revLastR = await planeMean(path.join(root, "outputs/mcp-reverse.mp4"), "640:360:0:0", "r", 9);
const revLastB = await planeMean(path.join(root, "outputs/mcp-reverse.mp4"), "640:360:0:0", "b", 9);
console.log("reverse pixels: t=1 R/B =", revFirstR, revFirstB, "| t=9 R/B =", revLastR, revLastB);
checkOk(revFirstB > 200 && revFirstR < 10, "reversed video starts blue (was red)", `t=1 R=${revFirstR} B=${revFirstB}`);
checkOk(revLastR > 200 && revLastB < 10, "reversed video ends red (was blue)", `t=9 R=${revLastR} B=${revLastB}`);
const reverseAudioRes = await client.callTool({
  name: "reverse",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-reverse-audio.mp3") },
});
const reverseAudioJson = JSON.parse(reverseAudioRes.content[0].text);
checkOk(reverseAudioJson.video_reversed === false && reverseAudioJson.audio_reversed === true && near(reverseAudioJson.duration_seconds, 9, 0.1), "reverse on audio-only input reverses audio only", JSON.stringify(reverseAudioJson));
const { stderr: revSdErr } = await execFileAsync("ffmpeg", ["-v", "info", "-i", path.join(root, "outputs/mcp-reverse-audio.mp3"), "-af", "silencedetect=noise=-40dB:d=0.5", "-f", "null", "-"]);
const revSdStarts = [...revSdErr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
console.log("reverse audio silence starts:", revSdStarts.join(", "));
checkOk(revSdStarts.some((t) => near(t, 2, 0.15)) && revSdStarts.some((t) => near(t, 5, 0.15)), "reversed audio silence gaps moved to [2,3) and [5,7)", `starts at ${revSdStarts.join(", ")}`);
const reverseNoAudioRes = await client.callTool({
  name: "reverse",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-reverse-noaudio.mp4"), audio: false },
});
const reverseNoAudioJson = JSON.parse(reverseNoAudioRes.content[0].text);
checkOk(reverseNoAudioJson.video_reversed === true && reverseNoAudioJson.audio_reversed === false && reverseNoAudioJson.audio_codec === "copy", "reverse audio=false reverses the video but copies the audio forward", JSON.stringify(reverseNoAudioJson));
const noAudioFirstB = await planeMean(path.join(root, "outputs/mcp-reverse-noaudio.mp4"), "640:360:0:0", "b", 1);
checkOk(noAudioFirstB > 200, "audio=false still reverses the video (starts blue)", `t=1 B=${noAudioFirstB}`);
const noAudioMean = await meanVolume(path.join(root, "outputs/mcp-reverse-noaudio.mp4"), 0, 9);
checkOk(near(noAudioMean, -21.1, 1.5), "audio=false keeps the original audio level (continuous tone, not re-encoded)", `mean ${noAudioMean} dB`);
const reverseVideoOnlyRes = await client.callTool({
  name: "reverse",
  arguments: { input: path.join(root, "test/content-video-only.mp4"), output: path.join(root, "outputs/mcp-reverse-video-only.mp4") },
});
const reverseVideoOnlyJson = JSON.parse(reverseVideoOnlyRes.content[0].text);
checkOk(reverseVideoOnlyJson.video_reversed === true && reverseVideoOnlyJson.audio_reversed === false && near(reverseVideoOnlyJson.duration_seconds, 10, 0.1), "reverse on video-only input reverses video, no audio to reverse", JSON.stringify(reverseVideoOnlyJson));
const reverseNoop = await callExpectThrow("reverse", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-reverse-noop.mp3"), audio: false });
checkOk(/reverses nothing/.test(reverseNoop), "reverse audio-only + audio=false is refused (nothing to reverse)", reverseNoop.slice(0, 200));

// reverse --dry-run (lượt 108): prints the exact command, writes no file.
const reverseDryRes = await client.callTool({
  name: "reverse",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-reverse-dry.mp4"), dry_run: true },
});
const reverseDryJson = JSON.parse(reverseDryRes.content[0].text);
console.log("reverse dry-run:", JSON.stringify({ commands: reverseDryJson.commands?.length, video_reversed: reverseDryJson.video_reversed }));
checkOk(reverseDryJson.dry_run === true && reverseDryJson.video_reversed === true && reverseDryJson.audio_reversed === true && reverseDryJson.duration_seconds === null, "reverse dry-run reports reversed streams, duration null", JSON.stringify(reverseDryJson));
checkOk(reverseDryJson.commands?.length === 1 && reverseDryJson.commands[0].includes("-vf reverse") && reverseDryJson.commands[0].includes("-af areverse"), "reverse dry-run prints the exact reverse command", reverseDryJson.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-reverse-dry.mp4")), "reverse dry-run writes no file", "outputs/mcp-reverse-dry.mp4");
const reverseDryCli = await runCliJson(["reverse", path.join(root, "test/scenes-source.mp4"), "-o", path.join(root, "outputs/mcp-reverse-cli-dry.mp4"), "--dry-run"]);
checkOk(reverseDryCli.dry_run === true && reverseDryCli.commands?.[0]?.includes("-vf reverse") && !existsSync(path.join(root, "outputs/mcp-reverse-cli-dry.mp4")), "CLI reverse --dry-run prints the command and writes no file", JSON.stringify(reverseDryCli.commands));

// make_loopable: tail-to-head crossfade so a clip loops with no
// jump. Fixture test/scenes-source.mp4 is red 5s + blue 5s, so the
// raw loop point is a hard red/blue cut: seam_before must be large
// (measured 47 by hand) and seam_after must land near the normal
// frame step (measured 4 vs step 0). Duration must be exactly D-F.
const loopRes = await client.callTool({
  name: "make_loopable",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-loopable.mp4"), overlap: 1 },
});
const loopJson = JSON.parse(loopRes.content[0].text);
console.log("make_loopable call:", JSON.stringify(loopJson));
checkOk(near(loopJson.duration_seconds, 9.039, 0.05) && near(loopJson.duration_error_seconds, 0, 0.05) && loopJson.expected_duration_seconds === 9.039, "make_loopable output is D-overlap (10.039-1 = 9.039s)", JSON.stringify(loopJson.duration_seconds));
checkOk(loopJson.seam_before !== null && loopJson.seam_before > 30, "make_loopable seam_before is large on the hard red/blue cut", `seam_before=${loopJson.seam_before}`);
checkOk(loopJson.seam_after !== null && loopJson.seam_after <= 8 && loopJson.seam_after < loopJson.seam_before / 4, "make_loopable seam_after collapses to near the normal step", `seam_after=${loopJson.seam_after} vs before=${loopJson.seam_before}`);
checkOk(loopJson.normal_step !== null && loopJson.normal_step <= 2, "make_loopable normal_step baseline is ~0 on the flat-color clip", `normal_step=${loopJson.normal_step}`);
checkOk(loopJson.has_audio === true && loopJson.dimensions === "640x360" && loopJson.size_bytes > 0, "make_loopable keeps audio + dimensions and writes real bytes", JSON.stringify(loopJson));
// Audio-only: acrossfade only, no video, seam scores null.
const loopAudioRes = await client.callTool({
  name: "make_loopable",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-loopable-audio.mp3"), overlap: 0.5 },
});
const loopAudioJson = JSON.parse(loopAudioRes.content[0].text);
checkOk(near(loopAudioJson.duration_seconds, 8.5, 0.05) && loopAudioJson.seam_before === null && loopAudioJson.seam_after === null && loopAudioJson.has_audio === true, "make_loopable on audio-only input shortens by the overlap, seam scores null", JSON.stringify(loopAudioJson));
// Video-only moving content: the ball's seam must land at or below
// the normal frame step (measured by hand: before 2.92, after 1.26,
// normal step 1.92).
const loopBallRes = await client.callTool({
  name: "make_loopable",
  arguments: { input: path.join(root, "test/motion-ball.mp4"), output: path.join(root, "outputs/mcp-loopable-ball.mp4"), overlap: 0.5 },
});
const loopBallJson = JSON.parse(loopBallRes.content[0].text);
checkOk(near(loopBallJson.duration_seconds, 5.5, 0.05) && loopBallJson.has_audio === false, "make_loopable on video-only input shortens by the overlap, no audio", JSON.stringify(loopBallJson));
checkOk(loopBallJson.seam_after !== null && loopBallJson.normal_step !== null && loopBallJson.seam_after <= loopBallJson.normal_step + 1 && loopBallJson.seam_after < loopBallJson.seam_before, "make_loopable on moving content lands the seam at the normal step", `seam ${loopBallJson.seam_before} -> ${loopBallJson.seam_after}, step ${loopBallJson.normal_step}`);
const loopBigText = await callExpectThrow("make_loopable", { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-loopable-bad.mp4"), overlap: 6 });
checkOk(/must be under half/.test(loopBigText), "make_loopable refuses overlap >= half the clip", loopBigText.slice(0, 200));
const loopZeroText = await callExpectThrow("make_loopable", { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-loopable-bad2.mp4"), overlap: 0 });
checkOk(/overlap/.test(loopZeroText), "make_loopable refuses overlap below 0.1s", loopZeroText.slice(0, 200));
// make_loopable dry-run (lượt 116, batch 5): exact command, seam_before
// measured on the input, seam_after/duration null, no file written.
const loopDryRes = await client.callTool({
  name: "make_loopable",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-loopable-dry.mp4"), overlap: 1, dry_run: true },
});
const loopDryJson = JSON.parse(loopDryRes.content[0].text);
checkOk(loopDryJson.dry_run === true && loopDryJson.overlap_seconds === 1 && near(loopDryJson.expected_duration_seconds, 9.039, 0.05) && loopDryJson.duration_seconds === null && loopDryJson.seam_before !== null && loopDryJson.seam_before > 30 && loopDryJson.seam_after === null && loopDryJson.normal_step === null && !existsSync(path.join(root, "outputs/mcp-loopable-dry.mp4")), "make_loopable dry-run reports overlap 1 + expected 9.039s + measured seam_before, nulls after, writes nothing", JSON.stringify({ seam_before: loopDryJson.seam_before, expected: loopDryJson.expected_duration_seconds }));
checkOk(loopDryJson.commands?.length === 1 && loopDryJson.commands[0].includes("acrossfade=d=1") && loopDryJson.commands[0].includes("fade=t=in:st=0:d=1:alpha=1"), "make_loopable dry-run command carries the 1s tail-to-head crossfade (video fade + audio acrossfade)", loopDryJson.commands?.[0] ?? "");
// Batch + manifest pass-through: make_loopable is a per-file batch
// op and a manifest step like trim/reverse.
await rm(path.join(root, "outputs/mcp-batch-loop-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-loop-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-loop-in"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-loop-in/source.mp4"));
await copyFile(path.join(root, "test/source2.mp4"), path.join(root, "outputs/mcp-batch-loop-in/source2.mp4"));
const loopBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "make_loopable", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-loop-in"), output_dir: path.join(root, "outputs/mcp-batch-loop-out"), args: { overlap: 0.5 }, jobs: 2 },
});
const loopBatchJson = JSON.parse(loopBatchRes.content[0].text);
checkOk(loopBatchJson.succeeded === 2 && loopBatchJson.failed === 0 && loopBatchJson.results.every((r) => r.status === "ok" && near(r.result?.duration_error_seconds, 0, 0.05)), "batch make_loopable succeeds on both files with exact D-overlap durations", JSON.stringify(loopBatchJson.results.map((r) => r.result?.duration_seconds)));
await rm(path.join(root, "outputs/mcp-manifest-loopable.mp4"), { force: true });
// A stale manifest-cache entry would serve this step as "cached"
// (steps_run 0) instead of running it — wipe the cache first so the
// assert below measures a fresh run (caught 2026-11-15: the step
// output was byte-correct at 9.039s but the assert failed on the
// cached status).
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const loopManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-loopable.json") },
});
const loopManifestJson = JSON.parse(loopManifestRes.content[0].text);
checkOk(loopManifestJson.steps_run === 1 && loopManifestJson.steps.every((s) => s.status === "ok") && near(loopManifestJson.final.duration_seconds, 9.039, 0.05), "manifest make_loopable step runs and final is 9.039s", JSON.stringify(loopManifestJson.final?.duration_seconds));

// freeze: hold one frame still. Fixture test/scenes-source.mp4 is
// red 5s + blue 5s (10.039s, 300 frames at 30fps, last PTS
// 9.999674 — NOT 10.0, so a time-window trim would silently yield
// zero frames; the tool picks the frame by index). at=5 freezes the
// last red frame (index 150): duration must be exactly D+hold,
// frozen_frame_diff ~0 (the hold is truly frozen) and
// post_frame_diff ~0 (the tail kept its place). Default --at holds
// the last frame (index 299) and post_frame_diff is null — there is
// no frame after it to compare.
const freezeRes = await client.callTool({
  name: "freeze",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-freeze.mp4"), at: 5, hold: 2 },
});
const freezeJson = JSON.parse(freezeRes.content[0].text);
console.log("freeze call:", JSON.stringify(freezeJson));
checkOk(near(freezeJson.duration_seconds, 12.039, 0.05) && near(freezeJson.duration_error_seconds, 0, 0.05) && freezeJson.expected_duration_seconds === 12.039, "freeze output is D+hold (10.039+2 = 12.039s)", JSON.stringify(freezeJson.duration_seconds));
checkOk(freezeJson.frame_index === 150 && freezeJson.frame_seconds === 5, "freeze picks frame index 150 at 5s", JSON.stringify(freezeJson.frame_index));
checkOk(freezeJson.frozen_frame_diff !== null && freezeJson.frozen_frame_diff <= 2, "freeze hold is truly frozen (input frame vs mid-hold frame diff ~0)", `frozen_frame_diff=${freezeJson.frozen_frame_diff}`);
checkOk(freezeJson.post_frame_diff !== null && freezeJson.post_frame_diff <= 2, "freeze tail kept its place (post frame diff ~0)", `post_frame_diff=${freezeJson.post_frame_diff}`);
checkOk(freezeJson.hold_audio === "silence" && freezeJson.has_audio === true && freezeJson.dimensions === "640x360" && freezeJson.size_bytes > 0, "freeze mutes audio in the hold and keeps dimensions/bytes", JSON.stringify(freezeJson));
// Independent: ffprobe counts 360 frames (300 + 60 hold) — the hold
// is real frames, not audio carrying the duration.
const { stdout: freezeFramesOut } = await execFileAsync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path.join(root, "outputs/mcp-freeze.mp4")]);
checkOk(parseInt(freezeFramesOut.trim(), 10) === 360, "ffprobe independently counts 360 frames on the frozen file (300 + 60 hold)", freezeFramesOut.trim());
// Default at: hold the last frame; video-only input works too.
const freezeEndRes = await client.callTool({
  name: "freeze",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-freeze-end.mp4"), hold: 2 },
});
const freezeEndJson = JSON.parse(freezeEndRes.content[0].text);
checkOk(freezeEndJson.frame_index === 299 && near(freezeEndJson.duration_seconds, 12.039, 0.05) && freezeEndJson.frozen_frame_diff !== null && freezeEndJson.frozen_frame_diff <= 2 && freezeEndJson.post_frame_diff === null, "freeze with no --at holds the last frame (index 299), post diff null", JSON.stringify(freezeEndJson));
const freezeVonlyRes = await client.callTool({
  name: "freeze",
  arguments: { input: path.join(root, "test/content-video-only.mp4"), output: path.join(root, "outputs/mcp-freeze-vonly.mp4"), at: 5, hold: 1 },
});
const freezeVonlyJson = JSON.parse(freezeVonlyRes.content[0].text);
checkOk(near(freezeVonlyJson.duration_seconds, 11, 0.05) && freezeVonlyJson.has_audio === false && freezeVonlyJson.hold_audio === null && freezeVonlyJson.frozen_frame_diff !== null && freezeVonlyJson.frozen_frame_diff <= 2, "freeze on video-only input works, no audio to mute", JSON.stringify(freezeVonlyJson));
// Refusals: audio-only has no frame; at past the end; hold below 0.1.
const freezeAudioText = await callExpectThrow("freeze", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-freeze-bad.mp3"), at: 2, hold: 1 });
checkOk(/needs a video input/.test(freezeAudioText), "freeze refuses audio-only input (no frame to hold)", freezeAudioText.slice(0, 200));
const freezePastText = await callExpectThrow("freeze", { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-freeze-bad2.mp4"), at: 99, hold: 1 });
checkOk(/past the end/.test(freezePastText), "freeze refuses --at past the end of the clip", freezePastText.slice(0, 200));
const freezeZeroText = await callExpectThrow("freeze", { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-freeze-bad3.mp4"), at: 5, hold: 0 });
checkOk(/hold/.test(freezeZeroText), "freeze refuses hold below 0.1s", freezeZeroText.slice(0, 200));
// Batch + manifest pass-through: freeze is a per-file batch op and
// a manifest step like make_loopable.
await rm(path.join(root, "outputs/mcp-batch-freeze-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-freeze-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-freeze-in"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-freeze-in/source.mp4"));
await copyFile(path.join(root, "test/source2.mp4"), path.join(root, "outputs/mcp-batch-freeze-in/source2.mp4"));
const freezeBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "freeze", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-freeze-in"), output_dir: path.join(root, "outputs/mcp-batch-freeze-out"), args: { hold: 1 }, jobs: 2 },
});
const freezeBatchJson = JSON.parse(freezeBatchRes.content[0].text);
checkOk(freezeBatchJson.succeeded === 2 && freezeBatchJson.failed === 0 && freezeBatchJson.results.every((r) => r.status === "ok" && near(r.result?.duration_error_seconds, 0, 0.05)), "batch freeze succeeds on both files with exact D+hold durations", JSON.stringify(freezeBatchJson.results.map((r) => r.result?.duration_seconds)));
await rm(path.join(root, "outputs/mcp-manifest-freeze.mp4"), { force: true });
// Same cache wipe as the loopable manifest test above: a stale
// entry would serve the step as "cached" (steps_run 0) and fail the
// assert even though the output is correct.
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const freezeManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-freeze.json") },
});
const freezeManifestJson = JSON.parse(freezeManifestRes.content[0].text);
checkOk(freezeManifestJson.steps_run === 1 && freezeManifestJson.steps.every((s) => s.status === "ok") && near(freezeManifestJson.final.duration_seconds, 12.039, 0.05), "manifest freeze step runs and final is 12.039s", JSON.stringify(freezeManifestJson.final?.duration_seconds));
// freeze dry-run (lượt 116, batch 5): frame picked by index, exact.
const freezeDryRes = await client.callTool({
  name: "freeze",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-freeze-dry.mp4"), at: 5, hold: 2, dry_run: true },
});
const freezeDryJson = JSON.parse(freezeDryRes.content[0].text);
checkOk(freezeDryJson.dry_run === true && freezeDryJson.frame_index === 150 && freezeDryJson.frame_seconds === 5 && near(freezeDryJson.expected_duration_seconds, 12.039, 0.05) && freezeDryJson.duration_seconds === null && freezeDryJson.frozen_frame_diff === null && freezeDryJson.post_frame_diff === null && !existsSync(path.join(root, "outputs/mcp-freeze-dry.mp4")), "freeze dry-run picks frame 150 at 5s, expects 12.039s, diffs null, writes nothing", JSON.stringify({ frame: freezeDryJson.frame_index, expected: freezeDryJson.expected_duration_seconds }));
checkOk(freezeDryJson.commands?.length === 1 && freezeDryJson.commands[0].includes("eq(n,150)") && freezeDryJson.commands[0].includes("loop=loop=59"), "freeze dry-run command selects frame 150 and loops it 60 frames (2s at 30fps)", freezeDryJson.commands?.[0] ?? "");
const freezeDryCli = await runCliJson(["freeze", path.join(root, "test/scenes-source.mp4"), "-o", path.join(root, "outputs/mcp-freeze-cli-dry.mp4"), "--at", "5", "--hold", "2", "--dry-run"]);
checkOk(freezeDryCli.dry_run === true && freezeDryCli.frame_index === 150 && freezeDryCli.commands?.[0]?.includes("eq(n,150)") && !existsSync(path.join(root, "outputs/mcp-freeze-cli-dry.mp4")), "CLI freeze --dry-run prints the command and writes no file", JSON.stringify(freezeDryCli.commands));

// fastforward (lượt 96): speed up marked spans with a badge
// (khang-nyb/demo-recorder's render() idea — their tool
// fast-forwards dead waits in a screen recording and stamps
// ">> tua nhanh x8" on the sped footage). Fixture
// test/scenes-source.mp4 is red 0-5s + blue 5-10s (10.039s, 300
// frames at 30fps): span [2,6)@2 saves 2s, so the output is
// 8.039s — red at t=1 and t=3 (inside the span, source 4s), blue
// at t=4.5 (after the span, source 6.5s). The badge is a dark box
// bottom-right only inside sped spans.
const ffRes = await client.callTool({
  name: "fastforward",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), segments: [{ start: 2, end: 6, speed: 2 }], output: path.join(root, "outputs/mcp-fastforward.mp4") },
});
const ffJson = JSON.parse(ffRes.content[0].text);
console.log("fastforward call:", JSON.stringify(ffJson.segments), "|", ffJson.duration_seconds + "s", "| mapped", ffJson.timing_check_mapped, "unmapped", ffJson.timing_check_unmapped, "| frames", ffJson.frames);
checkOk(near(ffJson.duration_seconds, 8.039, 0.05) && near(ffJson.duration_error_seconds, 0, 0.05) && ffJson.duration_expected_seconds === 8.039, "fastforward output is D - saved time (10.039 - 2 = 8.039s)", JSON.stringify(ffJson.duration_seconds));
checkOk(ffJson.segments?.length === 1 && ffJson.segments[0].start_seconds === 2 && ffJson.segments[0].end_seconds === 6 && ffJson.segments[0].speed === 2 && ffJson.segments[0].out_start_seconds === 2 && ffJson.segments[0].out_end_seconds === 4 && ffJson.segments[0].clamped === false, "fastforward echoes the span: 2-6s @2x lands at out 2-4s, not clamped", JSON.stringify(ffJson.segments));
checkOk(ffJson.timing_check_mapped !== null && ffJson.timing_check_mapped <= 2 && ffJson.timing_check_unmapped !== null && ffJson.timing_check_unmapped > 20, "fastforward timing check: mapped frame ~0, unshifted frame far off (the shift is real)", `mapped=${ffJson.timing_check_mapped} unmapped=${ffJson.timing_check_unmapped}`);
checkOk(ffJson.frames === 240 && Math.abs(ffJson.frames - ffJson.frames_expected) <= 2, "fastforward frame count is 240 (60 + 60 sped + 120), within 1 of the duration estimate", `frames=${ffJson.frames} expected~${ffJson.frames_expected}`);
checkOk(ffJson.badge?.label === "fast-forward" && ffJson.badge?.fontsize === 10 && ffJson.badge?.anchor === "bottom-right" && ffJson.has_audio === true && ffJson.dimensions === "640x360", "fastforward echoes badge geometry (10px at 360 high, bottom-right) and keeps audio/dimensions", JSON.stringify(ffJson.badge));
const ffT1R = await planeMean(path.join(root, "outputs/mcp-fastforward.mp4"), "320:180:160:90", "r", 1);
const ffT1B = await planeMean(path.join(root, "outputs/mcp-fastforward.mp4"), "320:180:160:90", "b", 1);
const ffT3R = await planeMean(path.join(root, "outputs/mcp-fastforward.mp4"), "320:180:160:90", "r", 3);
const ffT3B = await planeMean(path.join(root, "outputs/mcp-fastforward.mp4"), "320:180:160:90", "b", 3);
const ffT45R = await planeMean(path.join(root, "outputs/mcp-fastforward.mp4"), "320:180:160:90", "r", 4.5);
const ffT45B = await planeMean(path.join(root, "outputs/mcp-fastforward.mp4"), "320:180:160:90", "b", 4.5);
console.log("fastforward pixels: t=1 R/B =", ffT1R, ffT1B, "| t=3 R/B =", ffT3R, ffT3B, "| t=4.5 R/B =", ffT45R, ffT45B);
checkOk(ffT1R > 200 && ffT1B < 20 && ffT3R > 200 && ffT3B < 20, "fastforward stays red before and inside the span (t=3 is source 4s, still red)", `t1 R=${ffT1R} B=${ffT1B} | t3 R=${ffT3R} B=${ffT3B}`);
checkOk(ffT45R < 20 && ffT45B > 200, "fastforward is blue after the span (t=4.5 is source 6.5s, past the cut)", `t4.5 R=${ffT45R} B=${ffT45B}`);
// Badge: the bottom-right corner darkens inside a sped span and
// nowhere else; --no-badge leaves it untouched.
const ffNoBadgeRes = await client.callTool({
  name: "fastforward",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), segments: [{ start: 2, end: 6, speed: 2 }], output: path.join(root, "outputs/mcp-fastforward-nobadge.mp4"), badge: false },
});
const ffNoBadgeJson = JSON.parse(ffNoBadgeRes.content[0].text);
checkOk(ffNoBadgeJson.badge === null && near(ffNoBadgeJson.duration_seconds, 8.039, 0.05), "fastforward badge:false reports badge null and the same 8.039s", JSON.stringify(ffNoBadgeJson.badge));
const ffBadgeR = await planeMean(path.join(root, "outputs/mcp-fastforward.mp4"), "120:30:520:330", "r", 3);
const ffNoBadgeR = await planeMean(path.join(root, "outputs/mcp-fastforward-nobadge.mp4"), "120:30:520:330", "r", 3);
const ffBadgeOffR = await planeMean(path.join(root, "outputs/mcp-fastforward.mp4"), "120:30:520:330", "r", 1);
console.log("fastforward badge corner R: in-span =", ffBadgeR, "| no-badge =", ffNoBadgeR, "| outside span =", ffBadgeOffR);
checkOk(ffBadgeR !== null && ffBadgeR < 200 && ffNoBadgeR !== null && ffNoBadgeR > 240, "badge darkens the bottom-right corner inside a sped span (dark box over red)", `badge R=${ffBadgeR} no-badge R=${ffNoBadgeR}`);
checkOk(ffBadgeOffR !== null && ffBadgeOffR > 240, "no badge outside sped spans (corner stays full red at t=1)", `R=${ffBadgeOffR}`);
// Audio follows the same map: silence-source.mp4 is tone [0,2),
// [4,6), [7,9) with silence [2,4), [6,7); span [3,7)@2 moves the
// gaps to [2,3.5) and [4.5,5) and the output is 7s.
const ffAudioRes = await client.callTool({
  name: "fastforward",
  arguments: { input: path.join(root, "test/silence-source.mp4"), segments: [{ start: 3, end: 7, speed: 2 }], output: path.join(root, "outputs/mcp-fastforward-audio.mp4") },
});
const ffAudioJson = JSON.parse(ffAudioRes.content[0].text);
checkOk(near(ffAudioJson.duration_seconds, 7, 0.05) && near(ffAudioJson.duration_error_seconds, 0, 0.05), "fastforward audio timing: 9s - 2s saved = 7s", JSON.stringify(ffAudioJson.duration_seconds));
const { stderr: ffSdErr } = await execFileAsync("ffmpeg", ["-v", "info", "-i", path.join(root, "outputs/mcp-fastforward-audio.mp4"), "-map", "0:a", "-af", "silencedetect=noise=-40dB:d=0.3", "-f", "null", "-"]);
const ffSdStarts = [...ffSdErr.matchAll(/silence_start: ([0-9.]+)/g)].map((m) => parseFloat(m[1]));
checkOk(ffSdStarts.some((t) => near(t, 2, 0.15)) && ffSdStarts.some((t) => near(t, 4.5, 0.15)), "silencedetect finds the tone gaps shifted to [2,3.5) and [4.5,5)", `gaps at ${ffSdStarts.join(", ")}`);
// Audio-only input: no video chain, no badge, duration still exact.
const ffMp3Res = await client.callTool({
  name: "fastforward",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), segments: [{ start: 2, end: 5, speed: 2 }], output: path.join(root, "outputs/mcp-fastforward-mp3.mp3") },
});
const ffMp3Json = JSON.parse(ffMp3Res.content[0].text);
checkOk(near(ffMp3Json.duration_seconds, 7.5, 0.05) && ffMp3Json.badge === null && ffMp3Json.dimensions === null && ffMp3Json.has_audio === true, "fastforward on audio-only input: 9s - 1.5s saved = 7.5s, no badge, no dimensions", JSON.stringify(ffMp3Json.duration_seconds));
// Overlap + clamp: a span starting inside the previous one starts
// where the previous ended; a span past the end clamps to the clip.
const ffOverlapRes = await client.callTool({
  name: "fastforward",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), segments: [{ start: 2, end: 6, speed: 2 }, { start: 5, end: 8, speed: 2 }], output: path.join(root, "outputs/mcp-fastforward-overlap.mp4") },
});
const ffOverlapJson = JSON.parse(ffOverlapRes.content[0].text);
checkOk(ffOverlapJson.segments[1].start_seconds === 6 && ffOverlapJson.segments[1].clamped === true && near(ffOverlapJson.duration_seconds, 7.039, 0.05), "overlapping span collapses onto the previous span's end (5-8 -> 6-8, clamped) and duration follows", JSON.stringify(ffOverlapJson.segments));
const ffClampRes = await client.callTool({
  name: "fastforward",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), segments: [{ start: 8, end: 20, speed: 2 }], output: path.join(root, "outputs/mcp-fastforward-clamp.mp4") },
});
const ffClampJson = JSON.parse(ffClampRes.content[0].text);
checkOk(ffClampJson.segments[0].clamped === true && ffClampJson.segments[0].end_seconds === 10.039 && near(ffClampJson.duration_seconds, 9.02, 0.05), "span past the end clamps to the clip end (8-20 -> 8-10.039) and reports it", JSON.stringify(ffClampJson.segments));
// Refusals: speed 1 (zod floor 1.1), end before start, empty list.
const ffSpeed1Text = await callExpectThrow("fastforward", { input: path.join(root, "test/scenes-source.mp4"), segments: [{ start: 2, end: 6, speed: 1 }], output: path.join(root, "outputs/mcp-fastforward-bad.mp4") });
checkOk(/1\.1/.test(ffSpeed1Text), "fastforward refuses speed 1 (must be over 1.1)", ffSpeed1Text.slice(0, 200));
const ffBackwardsText = await callExpectThrow("fastforward", { input: path.join(root, "test/scenes-source.mp4"), segments: [{ start: 6, end: 2, speed: 2 }], output: path.join(root, "outputs/mcp-fastforward-bad2.mp4") });
checkOk(/end > start/.test(ffBackwardsText), "fastforward refuses end before start", ffBackwardsText.slice(0, 200));
const ffEmptyText = await callExpectThrow("fastforward", { input: path.join(root, "test/scenes-source.mp4"), segments: [], output: path.join(root, "outputs/mcp-fastforward-bad3.mp4") });
checkOk(/at least 1/.test(ffEmptyText), "fastforward refuses an empty segments list", ffEmptyText.slice(0, 200));
// CLI: --span start-end@speed renders; missing --span exits 2.
const ffCli = await runCli(["fastforward", path.join(root, "test/scenes-source.mp4"), "--span", "2-6@2", "-o", path.join(root, "outputs/mcp-fastforward-cli.mp4")]);
let ffCliJson = null;
try { ffCliJson = JSON.parse(ffCli.out); } catch { /* not JSON */ }
checkOk(ffCli.code === 0 && near(ffCliJson?.duration_seconds, 8.039, 0.05) && ffCliJson?.segments?.[0]?.speed === 2, "CLI fastforward --span 2-6@2 renders 8.039s", ffCli.out.slice(0, 200));
const ffCliNoSpanErr = await runCliExpectError(["fastforward", path.join(root, "test/scenes-source.mp4"), "-o", path.join(root, "outputs/mcp-fastforward-nospan.mp4")]);
checkOk(ffCliNoSpanErr !== null && /--span/.test(ffCliNoSpanErr), "CLI fastforward without --span exits 2 naming --span", (ffCliNoSpanErr ?? "").slice(0, 160));
// Manifest: fastforward as a pipeline step (segments array, like
// broll clips), plus a bad-segments refusal.
const ffManifestPath = path.join(root, "outputs/mcp-manifest-fastforward.json");
await writeFile(ffManifestPath, JSON.stringify({ version: 1, input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-manifest-fastforward.mp4"), steps: [{ tool: "fastforward", args: { segments: [{ start: 2, end: 6, speed: 2 }] } }] }), "utf8");
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const ffManifestRes = await client.callTool({ name: "manifest", arguments: { manifest_path: ffManifestPath } });
const ffManifestJson = JSON.parse(ffManifestRes.content[0].text);
checkOk(ffManifestJson.steps?.[0]?.status === "ok" && near(ffManifestJson.final?.duration_seconds, 8.039, 0.05), "manifest fastforward step runs ok, final 8.039s", JSON.stringify(ffManifestJson.steps?.map((s) => s.status)));
const ffManifestBadPath = path.join(root, "outputs/mcp-manifest-fastforward-bad.json");
await writeFile(ffManifestBadPath, JSON.stringify({ version: 1, input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-manifest-fastforward-bad.mp4"), steps: [{ tool: "fastforward", args: { segments: [{ start: 2, end: 6 }] } }] }), "utf8");
const ffManifestBadText = await callExpectThrow("manifest", { manifest_path: ffManifestBadPath });
checkOk(/segments\[0\]\.speed/.test(ffManifestBadText), "manifest refuses a fastforward step whose segment has no speed, before rendering", ffManifestBadText.slice(0, 200));

// patch_manifest (lượt 97): revision-guarded manifest patch
// (AH64-dll/OpenEdit's revision-guard idea). The scratch manifest
// is written into outputs/ with an absolute input path (the dry-run
// validation inside patch_manifest must find the input file) —
// patching the repo's own test/manifest.json would mutate a shared
// fixture.
const pmPath = path.join(root, "outputs/mcp-manifest-patch.json");
const pmOriginal = JSON.stringify({ version: 1, input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-manifest-patch-out.mp4"), steps: [{ tool: "trim", args: { start: 2, end: 8 } }, { tool: "reframe", args: { mode: "blur", width: 1080, height: 1920 } }, { tool: "loudness", args: { target_lufs: -14 } }], qa: "tiktok" }, null, 2);
await writeFile(pmPath, pmOriginal, "utf8");
const pmRes = await client.callTool({ name: "patch_manifest", arguments: { manifest_path: pmPath, expected_revision: 0, patch: [{ op: "set", path: "steps.2.args.target_lufs", value: -16 }, { op: "add_step", step: { tool: "trim", args: { start: 0, end: 2 } } }] } });
const pmJson = JSON.parse(pmRes.content[0].text);
checkOk(pmJson.revision_before === 0 && pmJson.revision_after === 1 && pmJson.ops_applied === 2 && pmJson.validated?.dry_run === true && pmJson.validated?.steps === 4, "patch_manifest applies set + add_step, revision 0 -> 1, dry-run validates 4 steps", JSON.stringify(pmJson));
// .bak backup (lượt 119, idea: bariswha/losslesscut-mcp
// set_segments): the pre-patch bytes are copied to <manifest>.bak
// before the atomic rename, so .bak is always the revision just
// before the current one.
checkOk(pmJson.backup === `${pmPath}.bak` && (await readFile(`${pmPath}.bak`, "utf8")) === pmOriginal, "patch_manifest writes the pre-patch bytes to <manifest>.bak and reports the backup path", pmJson.backup ?? "");
const pmDoc = JSON.parse(await readFile(pmPath, "utf8"));
checkOk(pmDoc.revision === 1 && pmDoc.steps.length === 4 && pmDoc.steps[2].args.target_lufs === -16 && pmDoc.steps[3].tool === "trim", "patched file on disk carries revision 1, the new loudness target and the appended trim step", JSON.stringify(pmDoc.steps.map((s) => s.tool)));
// The patched manifest still plans: a dry-run lists 4 steps.
const pmRunRes = await client.callTool({ name: "manifest", arguments: { manifest_path: pmPath, dry_run: true } });
const pmRunJson = JSON.parse(pmRunRes.content[0].text);
checkOk(pmRunJson.dry_run === true && pmRunJson.steps.length === 4, "patched manifest dry-runs 4 steps", JSON.stringify(pmRunJson.steps?.length));
// Revision mismatch: refused, file byte-identical.
const pmBefore = await readFile(pmPath, "utf8");
const pmMismatchText = await callExpectThrow("patch_manifest", { manifest_path: pmPath, expected_revision: 0, patch: [{ op: "set", path: "output", value: "x.mp4" }] });
checkOk(/REVISION_MISMATCH/.test(pmMismatchText) && /revision is 1, expected 0/.test(pmMismatchText), "patch_manifest refuses a stale expected_revision with REVISION_MISMATCH", pmMismatchText.slice(0, 200));
checkOk((await readFile(pmPath, "utf8")) === pmBefore, "stale revision leaves the file byte-identical", "");
checkOk((await readFile(`${pmPath}.bak`, "utf8")) === pmOriginal, "stale revision also leaves the .bak backup untouched (still the pre-patch bytes)", "");
// Bad patch (unknown tool in replace_step): the dry-run validation
// fails, file byte-identical, revision still 1.
const pmBadText = await callExpectThrow("patch_manifest", { manifest_path: pmPath, expected_revision: 1, patch: [{ op: "replace_step", index: 0, step: { tool: "nope", args: {} } }] });
checkOk(/unknown tool \\?"nope\\?"/.test(pmBadText), "patch_manifest refuses a patch that would leave an unknown tool, naming it", pmBadText.slice(0, 200));
checkOk((await readFile(pmPath, "utf8")) === pmBefore, "rejected patch leaves the file byte-identical", "");
// Batch: remove + replace + set in one call — indices address the
// list as read (rev 1 -> 2, 4 steps -> 3).
const pmBatchRes = await client.callTool({ name: "patch_manifest", arguments: { manifest_path: pmPath, expected_revision: 1, patch: [{ op: "remove_step", index: 3 }, { op: "replace_step", index: 0, step: { tool: "trim", args: { start: 0, end: 5 } } }, { op: "set", path: "output", value: path.join(root, "outputs/mcp-manifest-patch-out2.mp4") }] } });
const pmBatchJson = JSON.parse(pmBatchRes.content[0].text);
checkOk(pmBatchJson.revision_after === 2 && pmBatchJson.ops_applied === 3 && pmBatchJson.validated?.steps === 3, "patch_manifest batch remove + replace + set: revision 1 -> 2, 3 steps left", JSON.stringify(pmBatchJson));
checkOk((await readFile(`${pmPath}.bak`, "utf8")) === pmBefore, "second patch overwrites .bak with the revision-1 bytes (the revision just before the current one)", "");
const pmDoc2 = JSON.parse(await readFile(pmPath, "utf8"));
checkOk(pmDoc2.steps.length === 3 && pmDoc2.steps[0].tool === "trim" && pmDoc2.steps[0].args.end === 5 && pmDoc2.output.endsWith("mcp-manifest-patch-out2.mp4"), "batch patch on disk: first step replaced, appended trim removed, output set", JSON.stringify(pmDoc2.steps.map((s) => s.tool)));
// Refusals: set revision directly, unknown op, remove the last step.
const pmVerText = await callExpectThrow("patch_manifest", { manifest_path: pmPath, expected_revision: 2, patch: [{ op: "set", path: "revision", value: 99 }] });
checkOk(/cannot set \\?"revision\\?"/.test(pmVerText), "patch_manifest refuses to set revision directly (it is managed)", pmVerText.slice(0, 200));
const pmOpText = await callExpectThrow("patch_manifest", { manifest_path: pmPath, expected_revision: 2, patch: [{ op: "move_step", index: 0 }] });
checkOk(/unknown op \\?"move_step\\?"/.test(pmOpText), "patch_manifest refuses an unknown op name", pmOpText.slice(0, 200));
const pmOnePath = path.join(root, "outputs/mcp-manifest-patch-one.json");
await writeFile(pmOnePath, JSON.stringify({ version: 1, input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-manifest-patch-one-out.mp4"), steps: [{ tool: "trim", args: { start: 2, end: 8 } }] }, null, 2), "utf8");
const pmLastText = await callExpectThrow("patch_manifest", { manifest_path: pmOnePath, expected_revision: 0, patch: [{ op: "remove_step", index: 0 }] });
checkOk(/cannot remove the last remaining step/.test(pmLastText), "patch_manifest refuses removing the last remaining step", pmLastText.slice(0, 200));
checkOk(JSON.parse(await readFile(pmOnePath, "utf8")).steps.length === 1, "refused remove leaves the one-step manifest untouched", "");
// CLI: patch-manifest with --patch-file; stale revision exits 2.
const pmCliPatch = path.join(root, "outputs/mcp-manifest-patch-cli.json");
await writeFile(pmCliPatch, JSON.stringify([{ op: "set", path: "qa", value: "any" }]), "utf8");
const pmCli = await runCli(["patch-manifest", pmPath, "--expected-revision", "2", "--patch-file", pmCliPatch]);
let pmCliJson = null;
try { pmCliJson = JSON.parse(pmCli.out); } catch { /* not JSON */ }
checkOk(pmCli.code === 0 && pmCliJson?.revision_after === 3 && JSON.parse(await readFile(pmPath, "utf8")).qa === "any", "CLI patch-manifest applies the patch file, revision 2 -> 3", pmCli.out.slice(0, 200));
const pmCliStaleErr = await runCliExpectError(["patch-manifest", pmPath, "--expected-revision", "2", "--patch-file", pmCliPatch]);
checkOk(pmCliStaleErr !== null && /REVISION_MISMATCH/.test(pmCliStaleErr), "CLI patch-manifest with a stale revision exits 2 naming REVISION_MISMATCH", (pmCliStaleErr ?? "").slice(0, 200));

// boomerang: forward + reverse ping-pong. Fixture
// test/scenes-source.mp4 is red 5s + blue 5s (10.039s, 300 frames
// at 30fps): the output must be 2D - 1/fps = 20.045s with 599
// frames (2x300 - 1 pivot frame dropped, not 600), red at t=1,
// blue 1s into the reversed half (t=11), red again near the end
// (t=19). seam_diff must land at the normal step, not at 0 (a
// duplicated pivot frame would read 0 on flat color AND on moving
// content the seam would be a repeated frame, not a neighbour).
const boomRes = await client.callTool({
  name: "boomerang",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-boomerang.mp4") },
});
const boomJson = JSON.parse(boomRes.content[0].text);
console.log("boomerang call:", JSON.stringify(boomJson));
checkOk(near(boomJson.duration_seconds, 20.045, 0.05) && near(boomJson.duration_error_seconds, 0, 0.05) && boomJson.expected_duration_seconds === 20.045, "boomerang output is 2D - 1/fps (2x10.039 - 0.033 = 20.045s)", JSON.stringify(boomJson.duration_seconds));
checkOk(near(boomJson.pivot_seconds, 0.0333, 0.001), "boomerang reports the 1-frame pivot (1/30s)", JSON.stringify(boomJson.pivot_seconds));
checkOk(boomJson.seam_diff !== null && boomJson.seam_diff <= 2 && boomJson.normal_step !== null && boomJson.normal_step <= 2, "boomerang seam lands at the normal step on the flat-color clip", `seam=${boomJson.seam_diff} step=${boomJson.normal_step}`);
checkOk(boomJson.video_reversed === true && boomJson.audio_reversed === true && boomJson.has_audio === true && boomJson.dimensions === "640x360" && boomJson.size_bytes > 0, "boomerang reverses video + audio and keeps dimensions/bytes", JSON.stringify(boomJson));
// Independent: ffprobe counts 599 frames (2x300 - 1 pivot), and the
// pixels prove the direction: red, blue, red.
const { stdout: boomFramesOut } = await execFileAsync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path.join(root, "outputs/mcp-boomerang.mp4")]);
checkOk(parseInt(boomFramesOut.trim(), 10) === 599, "ffprobe independently counts 599 frames on the boomerang file (2x300 - 1 pivot)", boomFramesOut.trim());
const boomFirstR = await planeMean(path.join(root, "outputs/mcp-boomerang.mp4"), "640:360:0:0", "r", 1);
const boomFirstB = await planeMean(path.join(root, "outputs/mcp-boomerang.mp4"), "640:360:0:0", "b", 1);
const boomMidR = await planeMean(path.join(root, "outputs/mcp-boomerang.mp4"), "640:360:0:0", "r", 11);
const boomMidB = await planeMean(path.join(root, "outputs/mcp-boomerang.mp4"), "640:360:0:0", "b", 11);
const boomLastR = await planeMean(path.join(root, "outputs/mcp-boomerang.mp4"), "640:360:0:0", "r", 19);
const boomLastB = await planeMean(path.join(root, "outputs/mcp-boomerang.mp4"), "640:360:0:0", "b", 19);
console.log("boomerang pixels: t=1 R/B =", boomFirstR, boomFirstB, "| t=11 R/B =", boomMidR, boomMidB, "| t=19 R/B =", boomLastR, boomLastB);
checkOk(boomFirstR > 200 && boomFirstB < 10, "boomerang starts red (forward half)", `t=1 R=${boomFirstR} B=${boomFirstB}`);
checkOk(boomMidB > 200 && boomMidR < 10, "boomerang reversed half starts blue (was red at the end of forward)", `t=11 R=${boomMidR} B=${boomMidB}`);
checkOk(boomLastR > 200 && boomLastB < 10, "boomerang ends red (reversed half returns to the start)", `t=19 R=${boomLastR} B=${boomLastB}`);
// Audio-only: no video frame to pivot on, so forward + reversed
// whole (2D = 18s); the reversed half's silence gaps must mirror:
// original [2,4),[6,7) -> reversed [14,16),[11,12).
const boomAudioRes = await client.callTool({
  name: "boomerang",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-boomerang-audio.mp3") },
});
const boomAudioJson = JSON.parse(boomAudioRes.content[0].text);
checkOk(near(boomAudioJson.duration_seconds, 18, 0.1) && boomAudioJson.pivot_seconds === 0 && boomAudioJson.seam_diff === null && boomAudioJson.normal_step === null && boomAudioJson.has_audio === true, "boomerang on audio-only input is 2D whole, no pivot, seam scores null", JSON.stringify(boomAudioJson));
const { stderr: boomSdErr } = await execFileAsync("ffmpeg", ["-v", "info", "-i", path.join(root, "outputs/mcp-boomerang-audio.mp3"), "-af", "silencedetect=noise=-40dB:d=0.5", "-f", "null", "-"]);
const boomSdStarts = [...boomSdErr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
console.log("boomerang audio silence starts:", boomSdStarts.join(", "));
checkOk(boomSdStarts.some((t) => near(t, 11, 0.15)) && boomSdStarts.some((t) => near(t, 14, 0.15)), "boomerang audio silence gaps mirror into the reversed half ([11,12) and [14,16))", `starts at ${boomSdStarts.join(", ")}`);
// Video-only moving content: the ball's seam must land at the
// normal frame step (measured by hand: seam 2.91, step 2.92).
const boomBallRes = await client.callTool({
  name: "boomerang",
  arguments: { input: path.join(root, "test/motion-ball.mp4"), output: path.join(root, "outputs/mcp-boomerang-ball.mp4") },
});
const boomBallJson = JSON.parse(boomBallRes.content[0].text);
checkOk(near(boomBallJson.duration_seconds, 11.967, 0.05) && boomBallJson.has_audio === false, "boomerang on video-only input is 2D - 1/fps, no audio", JSON.stringify(boomBallJson.duration_seconds));
checkOk(boomBallJson.seam_diff !== null && boomBallJson.normal_step !== null && boomBallJson.seam_diff <= boomBallJson.normal_step + 1, "boomerang on moving content lands the seam at the normal step", `seam ${boomBallJson.seam_diff}, step ${boomBallJson.normal_step}`);
const boomNoop = await callExpectThrow("boomerang", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-boomerang-noop.mp3"), audio: false });
checkOk(/reverses nothing/.test(boomNoop), "boomerang audio-only + audio=false is refused (nothing to reverse)", boomNoop.slice(0, 200));
// Batch + manifest pass-through: boomerang is a per-file batch op
// and a manifest step like reverse.
await rm(path.join(root, "outputs/mcp-batch-boom-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-boom-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-boom-in"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-boom-in/source.mp4"));
await copyFile(path.join(root, "test/source2.mp4"), path.join(root, "outputs/mcp-batch-boom-in/source2.mp4"));
const boomBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "boomerang", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-boom-in"), output_dir: path.join(root, "outputs/mcp-batch-boom-out"), args: {}, jobs: 2 },
});
const boomBatchJson = JSON.parse(boomBatchRes.content[0].text);
checkOk(boomBatchJson.succeeded === 2 && boomBatchJson.failed === 0 && boomBatchJson.results.every((r) => r.status === "ok" && near(r.result?.duration_error_seconds, 0, 0.05)), "batch boomerang succeeds on both files with exact 2D - 1/fps durations", JSON.stringify(boomBatchJson.results.map((r) => r.result?.duration_seconds)));
await rm(path.join(root, "outputs/mcp-manifest-boomerang.mp4"), { force: true });
// Same cache wipe as the loopable/freeze manifest tests above.
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const boomManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-boomerang.json") },
});
const boomManifestJson = JSON.parse(boomManifestRes.content[0].text);
checkOk(boomManifestJson.steps_run === 1 && boomManifestJson.steps.every((s) => s.status === "ok") && near(boomManifestJson.final.duration_seconds, 20.045, 0.05), "manifest boomerang step runs and final is 20.045s", JSON.stringify(boomManifestJson.final?.duration_seconds));
// boomerang dry-run (lượt 116, batch 5): pivot + expected duration exact,
// seam scores null, no file written.
const boomDryRes = await client.callTool({
  name: "boomerang",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-boomerang-dry.mp4"), dry_run: true },
});
const boomDryJson = JSON.parse(boomDryRes.content[0].text);
checkOk(boomDryJson.dry_run === true && near(boomDryJson.expected_duration_seconds, 20.045, 0.05) && near(boomDryJson.pivot_seconds, 0.0333, 0.001) && boomDryJson.duration_seconds === null && boomDryJson.seam_diff === null && boomDryJson.normal_step === null && !existsSync(path.join(root, "outputs/mcp-boomerang-dry.mp4")), "boomerang dry-run reports pivot 0.0333 + expected 20.045s, seam scores null, writes nothing", JSON.stringify({ pivot: boomDryJson.pivot_seconds, expected: boomDryJson.expected_duration_seconds }));
checkOk(boomDryJson.commands?.length === 1 && boomDryJson.commands[0].includes("reverse,trim=start_frame=1") && boomDryJson.commands[0].includes("concat=n=2:v=1:a=0"), "boomerang dry-run command reverses then drops the pivot frame and concats forward + reverse", boomDryJson.commands?.[0] ?? "");

// rotate: turn or mirror a clip. Fixture test/rotate-source.mp4 is
// 640x360, 5s, left half red / right half blue (spatial halves, so a
// rotation shows up in the pixels, not just the dimensions).
// transpose=1 is 90 CW: the old left half becomes the TOP half.
// transpose=2 is 270 CW: the old left half becomes the BOTTOM half.
// 180 and flip-horizontal both swap left/right; flip-vertical swaps
// top/bottom (invisible on this vertically-uniform fixture, so only
// dims + rotation are asserted there). A rotated phone clip
// (test/rotated.mp4, display 720x1280, rotation 90) proves the angle
// applies to the DISPLAYED frame and the matrix is stripped: rotate
// 90 gives display 1280x720, rotate 180 keeps 720x1280, both with
// output_rotation null.
const rot90Res = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-90.mp4"), angle: 90 },
});
const rot90Json = JSON.parse(rot90Res.content[0].text);
console.log("rotate 90 call:", JSON.stringify(rot90Json));
checkOk(rot90Json.dimensions === "360x640" && rot90Json.output_rotation === null && rot90Json.input_rotation === null && rot90Json.input_dimensions === "640x360" && rot90Json.filter === "transpose=1" && near(rot90Json.duration_seconds, 5, 0.1), "rotate 90 swaps display axes to 360x640, no rotation metadata in or out", JSON.stringify(rot90Json));
const rot90TopR = await planeMean(path.join(root, "outputs/mcp-rotate-90.mp4"), "360:320:0:0", "r", 1);
const rot90TopB = await planeMean(path.join(root, "outputs/mcp-rotate-90.mp4"), "360:320:0:0", "b", 1);
const rot90BotR = await planeMean(path.join(root, "outputs/mcp-rotate-90.mp4"), "360:320:0:320", "r", 1);
const rot90BotB = await planeMean(path.join(root, "outputs/mcp-rotate-90.mp4"), "360:320:0:320", "b", 1);
console.log("rotate 90 pixels: top R/B =", rot90TopR, rot90TopB, "| bottom R/B =", rot90BotR, rot90BotB);
checkOk(rot90TopR > 200 && rot90TopB < 10, "rotate 90 CW puts the old left (red) half on top", `top R=${rot90TopR} B=${rot90TopB}`);
checkOk(rot90BotB > 200 && rot90BotR < 10, "rotate 90 CW puts the old right (blue) half at the bottom", `bottom R=${rot90BotR} B=${rot90BotB}`);
const rot270Res = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-270.mp4"), angle: 270 },
});
const rot270Json = JSON.parse(rot270Res.content[0].text);
checkOk(rot270Json.dimensions === "360x640" && rot270Json.output_rotation === null && rot270Json.filter === "transpose=2", "rotate 270 swaps axes to 360x640, no rotation left", JSON.stringify(rot270Json));
const rot270TopR = await planeMean(path.join(root, "outputs/mcp-rotate-270.mp4"), "360:320:0:0", "r", 1);
const rot270TopB = await planeMean(path.join(root, "outputs/mcp-rotate-270.mp4"), "360:320:0:0", "b", 1);
const rot270BotR = await planeMean(path.join(root, "outputs/mcp-rotate-270.mp4"), "360:320:0:320", "r", 1);
const rot270BotB = await planeMean(path.join(root, "outputs/mcp-rotate-270.mp4"), "360:320:0:320", "b", 1);
console.log("rotate 270 pixels: top R/B =", rot270TopR, rot270TopB, "| bottom R/B =", rot270BotR, rot270BotB);
checkOk(rot270TopB > 200 && rot270TopR < 10, "rotate 270 CW puts the old right (blue) half on top", `top R=${rot270TopR} B=${rot270TopB}`);
checkOk(rot270BotR > 200 && rot270BotB < 10, "rotate 270 CW puts the old left (red) half at the bottom", `bottom R=${rot270BotR} B=${rot270BotB}`);
const rot180Res = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-180.mp4"), angle: 180 },
});
const rot180Json = JSON.parse(rot180Res.content[0].text);
checkOk(rot180Json.dimensions === "640x360" && rot180Json.output_rotation === null && rot180Json.filter === "hflip,vflip", "rotate 180 keeps 640x360 via hflip+vflip, no rotation left", JSON.stringify(rot180Json));
const rot180LeftR = await planeMean(path.join(root, "outputs/mcp-rotate-180.mp4"), "320:360:0:0", "r", 1);
const rot180LeftB = await planeMean(path.join(root, "outputs/mcp-rotate-180.mp4"), "320:360:0:0", "b", 1);
const rot180RightR = await planeMean(path.join(root, "outputs/mcp-rotate-180.mp4"), "320:360:320:0", "r", 1);
const rot180RightB = await planeMean(path.join(root, "outputs/mcp-rotate-180.mp4"), "320:360:320:0", "b", 1);
console.log("rotate 180 pixels: left R/B =", rot180LeftR, rot180LeftB, "| right R/B =", rot180RightR, rot180RightB);
checkOk(rot180LeftB > 200 && rot180LeftR < 10 && rot180RightR > 200 && rot180RightB < 10, "rotate 180 swaps left/right (blue left, red right)", `left B=${rot180LeftB} right R=${rot180RightR}`);
const rotFlipHRes = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-fliph.mp4"), flip: "horizontal" },
});
const rotFlipHJson = JSON.parse(rotFlipHRes.content[0].text);
checkOk(rotFlipHJson.dimensions === "640x360" && rotFlipHJson.flip === "horizontal" && rotFlipHJson.angle === null && rotFlipHJson.filter === "hflip" && rotFlipHJson.output_rotation === null, "flip horizontal keeps 640x360 and reports flip (not angle)", JSON.stringify(rotFlipHJson));
const rotFlipHLeftB = await planeMean(path.join(root, "outputs/mcp-rotate-fliph.mp4"), "320:360:0:0", "b", 1);
const rotFlipHRightR = await planeMean(path.join(root, "outputs/mcp-rotate-fliph.mp4"), "320:360:320:0", "r", 1);
checkOk(rotFlipHLeftB > 200 && rotFlipHRightR > 200, "flip horizontal mirrors left/right (blue left, red right)", `left B=${rotFlipHLeftB} right R=${rotFlipHRightR}`);
const rotFlipVRes = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-flipv.mp4"), flip: "vertical" },
});
const rotFlipVJson = JSON.parse(rotFlipVRes.content[0].text);
checkOk(rotFlipVJson.dimensions === "640x360" && rotFlipVJson.flip === "vertical" && rotFlipVJson.filter === "vflip" && near(rotFlipVJson.duration_seconds, 5, 0.1), "flip vertical keeps 640x360 and duration", JSON.stringify(rotFlipVJson));
// The rotated phone clip: the angle applies to the DISPLAYED frame
// (720x1280), and the matrix must not survive the re-encode.
const rotPhone90Res = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-rotate-phone90.mp4"), angle: 90 },
});
const rotPhone90Json = JSON.parse(rotPhone90Res.content[0].text);
console.log("rotate phone 90 call:", JSON.stringify(rotPhone90Json));
checkOk(rotPhone90Json.input_rotation === 90 && rotPhone90Json.input_dimensions === "720x1280" && rotPhone90Json.dimensions === "1280x720" && rotPhone90Json.output_rotation === null, "rotate 90 on a rotation-90 phone clip gives display 1280x720 with the matrix stripped", JSON.stringify(rotPhone90Json));
const rotPhone180Res = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-rotate-phone180.mp4"), angle: 180 },
});
const rotPhone180Json = JSON.parse(rotPhone180Res.content[0].text);
checkOk(rotPhone180Json.input_rotation === 90 && rotPhone180Json.dimensions === "720x1280" && rotPhone180Json.output_rotation === null && near(rotPhone180Json.duration_seconds, 10, 0.1), "rotate 180 on a rotation-90 phone clip keeps display 720x1280 with the matrix stripped", JSON.stringify(rotPhone180Json));
const rotBadAngle = await callExpectThrow("rotate", { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-bad.mp4"), angle: 45 });
checkOk(/angle must be 90, 180 or 270/.test(rotBadAngle), "rotate refuses angle 45", rotBadAngle.slice(0, 200));
const rotBoth = await callExpectThrow("rotate", { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-bad2.mp4"), angle: 90, flip: "horizontal" });
checkOk(/exactly one of angle or flip/.test(rotBoth), "rotate refuses angle + flip together", rotBoth.slice(0, 200));
const rotNeither = await callExpectThrow("rotate", { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-bad3.mp4") });
checkOk(/exactly one of angle or flip/.test(rotNeither), "rotate refuses neither angle nor flip", rotNeither.slice(0, 200));
const rotAudioOnly = await callExpectThrow("rotate", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-rotate-bad4.mp4"), angle: 90 });
checkOk(/needs a video input/.test(rotAudioOnly), "rotate refuses audio-only input", rotAudioOnly.slice(0, 200));
// rotate --metadata-only (turn 120): rewrite only the display
// matrix, no re-encode. The angle ADDS to the input's existing
// rotation; 270 on a rotation-90 clip strips the matrix to null.
// video_identical is the frame-digest proof the copy was lossless,
// and the size must stay within 2 KB of the input (only tkhd bytes
// move — a re-encode would land far away from 6.5 KB).
const rotMeta90Res = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-meta90.mp4"), angle: 90, metadata_only: true },
});
const rotMeta90Json = JSON.parse(rotMeta90Res.content[0].text);
console.log("rotate metadata-only 90 call:", JSON.stringify(rotMeta90Json));
const rotMeta90InSize = statSync(path.join(root, "test/rotate-source.mp4")).size;
checkOk(rotMeta90Json.method === "metadata-only" && rotMeta90Json.metadata_only === true && rotMeta90Json.filter === null && rotMeta90Json.input_rotation === null && rotMeta90Json.output_rotation === 90 && rotMeta90Json.dimensions === "360x640" && rotMeta90Json.video_identical === true && near(rotMeta90Json.duration_seconds, 5, 0.1), "rotate --metadata-only 90 sets rotation 90, display 360x640, decoded frames identical", JSON.stringify(rotMeta90Json));
checkOk(Math.abs(rotMeta90Json.size_bytes - rotMeta90InSize) < 2048, "rotate --metadata-only 90 is a stream copy: output size within 2 KB of the input", `in=${rotMeta90InSize} out=${rotMeta90Json.size_bytes}`);
const rotMetaPhoneRes = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-rotate-meta-phone90.mp4"), angle: 90, metadata_only: true },
});
const rotMetaPhoneJson = JSON.parse(rotMetaPhoneRes.content[0].text);
checkOk(rotMetaPhoneJson.input_rotation === 90 && rotMetaPhoneJson.output_rotation === 180 && rotMetaPhoneJson.dimensions === "1280x720" && rotMetaPhoneJson.video_identical === true, "rotate --metadata-only 90 on a rotation-90 clip ADDS to 180 (not overwrite to 90); 180 keeps the stored axes, so display is 1280x720", JSON.stringify(rotMetaPhoneJson));
const rotMetaStripRes = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-rotate-meta-strip.mp4"), angle: 270, metadata_only: true },
});
const rotMetaStripJson = JSON.parse(rotMetaStripRes.content[0].text);
checkOk(rotMetaStripJson.input_rotation === 90 && rotMetaStripJson.output_rotation === null && rotMetaStripJson.dimensions === "1280x720" && rotMetaStripJson.video_identical === true, "rotate --metadata-only 270 on a rotation-90 clip strips the matrix (90+270=360), display 1280x720", JSON.stringify(rotMetaStripJson));
const rotMetaDryRes = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-meta-dry.mp4"), angle: 90, metadata_only: true, dry_run: true },
});
const rotMetaDryJson = JSON.parse(rotMetaDryRes.content[0].text);
checkOk(rotMetaDryJson.dry_run === true && rotMetaDryJson.method === "metadata-only" && rotMetaDryJson.output_rotation === 90 && rotMetaDryJson.dimensions === "360x640" && rotMetaDryJson.video_identical === null && rotMetaDryJson.commands[0].includes("-display_rotation") && rotMetaDryJson.commands[0].includes("-c copy") && !existsSync(path.join(root, "outputs/mcp-rotate-meta-dry.mp4")), "rotate --metadata-only dry-run prints the display_rotation stream-copy command and writes no file", JSON.stringify(rotMetaDryJson));
const rotMetaFlip = await callExpectThrow("rotate", { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-meta-bad.mp4"), flip: "horizontal", metadata_only: true });
checkOk(/cannot flip/.test(rotMetaFlip), "rotate --metadata-only refuses flip (no metadata for a mirror)", rotMetaFlip.slice(0, 200));
const rotMetaWebm = await callExpectThrow("rotate", { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-meta-bad.webm"), angle: 90, metadata_only: true });
checkOk(/only works on mp4\/mov\/mkv/.test(rotMetaWebm), "rotate --metadata-only refuses webm (no display matrix there)", rotMetaWebm.slice(0, 200));
// Batch + manifest pass-through: rotate is a per-file batch op and a
// manifest step like reverse.
await rm(path.join(root, "outputs/mcp-batch-rot-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-rot-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-rot-in"), { recursive: true });
await copyFile(path.join(root, "test/rotate-source.mp4"), path.join(root, "outputs/mcp-batch-rot-in/rotate-source.mp4"));
await copyFile(path.join(root, "test/scenes-source.mp4"), path.join(root, "outputs/mcp-batch-rot-in/scenes-source.mp4"));
const rotBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "rotate", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-rot-in"), output_dir: path.join(root, "outputs/mcp-batch-rot-out"), args: { angle: 90 }, jobs: 2 },
});
const rotBatchJson = JSON.parse(rotBatchRes.content[0].text);
checkOk(rotBatchJson.succeeded === 2 && rotBatchJson.failed === 0 && rotBatchJson.results.every((r) => r.status === "ok" && r.result?.dimensions === "360x640"), "batch rotate 90 succeeds on both files, both 360x640", JSON.stringify(rotBatchJson.results.map((r) => r.result?.dimensions)));
await rm(path.join(root, "outputs/mcp-manifest-rotate.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const rotManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-rotate.json") },
});
const rotManifestJson = JSON.parse(rotManifestRes.content[0].text);
checkOk(rotManifestJson.steps_run === 1 && rotManifestJson.steps.every((s) => s.status === "ok") && rotManifestJson.final.dimensions === "360x640", "manifest rotate step runs and final is 360x640", JSON.stringify(rotManifestJson.final?.dimensions));
// Manifest: a rotate step carries metadata_only through (turn 120)
// — the manifest run is a stream copy, not a re-encode.
await rm(path.join(root, "outputs/mcp-manifest-rotate-meta.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const rotMetaManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-rotate-meta.json") },
});
const rotMetaManifestJson = JSON.parse(rotMetaManifestRes.content[0].text);
const rotMetaManifestStep = rotMetaManifestJson.steps?.[0]?.result;
checkOk(rotMetaManifestJson.steps_run === 1 && rotMetaManifestJson.steps.every((s) => s.status === "ok") && rotMetaManifestStep?.method === "metadata-only" && rotMetaManifestStep?.video_identical === true && rotMetaManifestStep?.output_rotation === 90 && rotMetaManifestStep?.dimensions === "360x640" && rotMetaManifestJson.final.dimensions === "640x360", "manifest rotate metadata_only step runs as a stream copy (method metadata-only, frames identical, rotation 90, display 360x640; final.dimensions is the stored 640x360, not display)", JSON.stringify({ step: rotMetaManifestStep, final: rotMetaManifestJson.final }));
// Manifest: a burn_captions step carries max_lines + platform through
// (the narrower tiktok safe-rect budget 952px shrinks one px further
// than the plain 972px budget: 45px, not 46px; margin is tiktok's 520).
await rm(path.join(root, "outputs/mcp-manifest-burn-fit.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const burnFitManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-burn-fit.json") },
});
const burnFitManifestJson = JSON.parse(burnFitManifestRes.content[0].text);
const burnFitStep = burnFitManifestJson.steps?.[0]?.result;
checkOk(burnFitManifestJson.steps_run === 1 && burnFitStep?.font_size === 45 && burnFitStep?.margin_v === 520 && burnFitStep?.fit?.width_px === 952, "manifest burn_captions passes max_lines + platform through (font 45, margin 520, budget 952)", JSON.stringify(burnFitStep?.fit));
// Manifest: a compress target-size step carries the quality proof
// through in its step result.
await rm(path.join(root, "outputs/mcp-manifest-compress-proof.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const proofManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-compress-proof.json") },
});
const proofManifestJson = JSON.parse(proofManifestRes.content[0].text);
const proofManifestStep = proofManifestJson.steps?.[0]?.result;
checkOk(proofManifestJson.steps_run === 1 && proofManifestStep?.quality_proof?.available === true && proofManifestStep.quality_proof.verdict === "indistinguishable" && proofManifestStep.quality_proof.ssim_mean > 0.99, "manifest compress target-size step returns the quality proof (indistinguishable, SSIM >0.99)", JSON.stringify(proofManifestStep?.quality_proof));
// CLI: rotate --angle 180 keeps 640x360.
const rotCliJson = await runCliJson(["rotate", path.join(root, "test/rotate-source.mp4"), "-o", path.join(root, "outputs/mcp-rotate-cli.mp4"), "--angle", "180"]);
checkOk(rotCliJson.dimensions === "640x360" && rotCliJson.angle === 180 && rotCliJson.output_rotation === null, "CLI rotate --angle 180 keeps 640x360, no rotation left", JSON.stringify(rotCliJson));
// CLI: rotate --metadata-only --angle 90 is a stream copy (turn 120).
const rotMetaCliJson = await runCliJson(["rotate", path.join(root, "test/rotate-source.mp4"), "-o", path.join(root, "outputs/mcp-rotate-meta-cli.mp4"), "--angle", "90", "--metadata-only"]);
checkOk(rotMetaCliJson.method === "metadata-only" && rotMetaCliJson.output_rotation === 90 && rotMetaCliJson.dimensions === "360x640" && rotMetaCliJson.video_identical === true, "CLI rotate --metadata-only --angle 90 sets rotation 90, frames identical", JSON.stringify(rotMetaCliJson));
// rotate --dry-run (lượt 105): dimensions is the EXPECTED display
// size (90/270 swaps the axes, flip keeps them); output_rotation /
// duration / size are measured on the real output, so null.
const rotDryRes = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-dry.mp4"), angle: 90, dry_run: true },
});
const rotDry = JSON.parse(rotDryRes.content[0].text);
console.log("rotate dry-run:", JSON.stringify({ dimensions: rotDry.dimensions, filter: rotDry.filter, output_rotation: rotDry.output_rotation }));
checkOk(rotDry.dry_run === true && rotDry.dimensions === "360x640" && rotDry.input_dimensions === "640x360" && rotDry.filter === "transpose=1" && rotDry.output_rotation === null, "rotate 90 dry-run reports the swapped expected dimensions (360x640)", JSON.stringify(rotDry));
checkOk(rotDry.commands?.length === 1 && rotDry.commands[0].includes("transpose=1"), "rotate dry-run prints the exact transpose command", rotDry.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-rotate-dry.mp4")), "rotate dry-run writes no file", "outputs/mcp-rotate-dry.mp4");
const rotFlipDryRes = await client.callTool({
  name: "rotate",
  arguments: { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-flip-dry.mp4"), flip: "horizontal", dry_run: true },
});
const rotFlipDry = JSON.parse(rotFlipDryRes.content[0].text);
checkOk(rotFlipDry.dimensions === "640x360" && rotFlipDry.filter === "hflip", "rotate flip dry-run keeps the dimensions (no axis swap)", JSON.stringify(rotFlipDry));
const rotDryNeither = await callExpectThrow("rotate", { input: path.join(root, "test/rotate-source.mp4"), output: path.join(root, "outputs/mcp-rotate-neither-dry.mp4"), dry_run: true });
checkOk(/exactly one of angle or flip/.test(rotDryNeither), "rotate dry-run still requires exactly one of angle/flip", rotDryNeither.slice(0, 200));

// Display-dims geometry (lượt 75): crop/reframe/resize validate
// against the frame the viewer sees, not the stored pixels.
// test/rotated.mp4 is stored 1280x720 with rotation 90, so its
// display frame is 720x1280 — a full-frame crop rect is 720x1280,
// and 1280x720 is out of bounds even though it matches the stored
// size. No new fixture: the rotated pair already exists.
// MCP: crop the whole display frame of the rotated clip.
const dispCropRes = await client.callTool({
  name: "crop",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-crop-display.mp4"), width: 720, height: 1280 },
});
const dispCropJson = JSON.parse(dispCropRes.content[0].text);
checkOk(dispCropJson.dimensions === "720x1280" && dispCropJson.source_dimensions === "720x1280" && dispCropJson.source_rotation === 90, "crop on a rotated clip accepts the full display frame 720x1280 and reports display dims + rotation", JSON.stringify(dispCropJson));
// MCP: the stored-size rect is refused, with the display size named.
const dispCropBadRes = await client.callTool({
  name: "crop",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-crop-display-bad.mp4"), width: 1280, height: 720 },
});
const dispCropBadJson = JSON.parse(dispCropBadRes.content[0].text);
checkOk(dispCropBadRes.isError === true && /exceeds display 720x1280/.test(dispCropBadJson.error ?? "") && /stored 1280x720, rotation 90/.test(dispCropBadJson.error ?? ""), "crop on a rotated clip refuses the stored-size rect 1280x720, naming display + stored dims", JSON.stringify(dispCropBadJson));
// MCP: crop with an offset inside the display frame.
const dispCropOffRes = await client.callTool({
  name: "crop",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-crop-display-off.mp4"), width: 360, height: 640, x: 180, y: 320 },
});
const dispCropOffJson = JSON.parse(dispCropOffRes.content[0].text);
checkOk(dispCropOffJson.dimensions === "360x640", "crop with a display-space offset 360x640+180+320 on a rotated clip succeeds", JSON.stringify(dispCropOffJson));
// CLI: crop --dry-run reports display source dims without writing.
const dispCropDryJson = await runCliJson(["crop", path.join(root, "test/rotated.mp4"), "--width", "720", "--height", "1280", "-o", path.join(root, "outputs/mcp-crop-display-dry.mp4"), "--dry-run"]);
checkOk(dispCropDryJson.dry_run === true && dispCropDryJson.source_dimensions === "720x1280" && dispCropDryJson.source_rotation === 90 && !existsSync(path.join(root, "outputs/mcp-crop-display-dry.mp4")), "crop --dry-run on a rotated clip reports display source dims and writes nothing", JSON.stringify(dispCropDryJson));
// MCP: reframe a portrait display clip to portrait keeps ~all of it.
const dispReframeRes = await client.callTool({
  name: "reframe",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-reframe-display.mp4"), width: 1080, height: 1920, mode: "crop" },
});
const dispReframeJson = JSON.parse(dispReframeRes.content[0].text);
checkOk(dispReframeJson.dimensions === "1080x1920" && dispReframeJson.source === "720x1280" && dispReframeJson.source_rotation === 90 && dispReframeJson.crop_kept_percent === 100 && dispReframeJson.crop?.width === 720 && dispReframeJson.crop?.height === 1280 && !dispReframeJson.warning, "reframe crop 1080x1920 on a rotated clip keeps the whole 720x1280 display frame (100%, no softness warning)", JSON.stringify(dispReframeJson));
// MCP: reframe --x past the display-space window is refused (maxX 0:
// the 720-wide display frame is exactly the crop width).
const dispReframeBadRes = await client.callTool({
  name: "reframe",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-reframe-display-bad.mp4"), width: 1080, height: 1920, mode: "crop", x: 10 },
});
const dispReframeBadJson = JSON.parse(dispReframeBadRes.content[0].text);
checkOk(dispReframeBadRes.isError === true && /x must be <= 0/.test(dispReframeBadJson.error ?? ""), "reframe --x 10 on a rotated clip is refused: the display-space crop window has no slack", JSON.stringify(dispReframeBadJson));
// MCP: reframe pad mode reports display source dims too.
const dispReframePadRes = await client.callTool({
  name: "reframe",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-reframe-display-pad.mp4"), width: 1080, height: 1920, mode: "pad" },
});
const dispReframePadJson = JSON.parse(dispReframePadRes.content[0].text);
checkOk(dispReframePadJson.dimensions === "1080x1920" && dispReframePadJson.source === "720x1280" && dispReframePadJson.source_rotation === 90, "reframe pad on a rotated clip reports display source 720x1280", JSON.stringify(dispReframePadJson));
// MCP: resize --preset fits the DISPLAY frame in the box: 720x1280
// into 1280x720 scales to 406x720 (even-rounded), scaled_down true.
// Fitting coded 1280x720 instead would "fit" at 1280x720 and stretch
// the portrait frame to landscape.
const dispResizeRes = await client.callTool({
  name: "resize",
  arguments: { input: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-resize-display.mp4"), preset: "720p" },
});
const dispResizeJson = JSON.parse(dispResizeRes.content[0].text);
checkOk(dispResizeJson.dimensions === "406x720" && dispResizeJson.scaled_down === true && dispResizeJson.source_dimensions === "720x1280" && dispResizeJson.source_rotation === 90, "resize preset 720p on a rotated clip fits the display frame: 406x720, scaled_down", JSON.stringify(dispResizeJson));
// CLI: resize --preset --dry-run reports the same display fit.
const dispResizeDryJson = await runCliJson(["resize", path.join(root, "test/rotated.mp4"), "--preset", "720p", "-o", path.join(root, "outputs/mcp-resize-display-dry.mp4"), "--dry-run"]);
checkOk(dispResizeDryJson.dry_run === true && dispResizeDryJson.dimensions === "406x720" && dispResizeDryJson.source_dimensions === "720x1280" && !existsSync(path.join(root, "outputs/mcp-resize-display-dry.mp4")), "resize preset --dry-run on a rotated clip reports the 406x720 display fit and writes nothing", JSON.stringify(dispResizeDryJson));
// The taller rotated fixture: stored 1920x1080, display 1080x1920.
const dispResizeTallRes = await client.callTool({
  name: "resize",
  arguments: { input: path.join(root, "test/rotated-vertical.mp4"), output: path.join(root, "outputs/mcp-resize-display-tall.mp4"), preset: "720p" },
});
const dispResizeTallJson = JSON.parse(dispResizeTallRes.content[0].text);
checkOk(dispResizeTallJson.dimensions === "406x720" && dispResizeTallJson.source_dimensions === "1080x1920" && dispResizeTallJson.source_rotation === 90, "resize preset 720p on the 1080x1920 display fixture fits to 406x720", JSON.stringify(dispResizeTallJson));
// Regression: an unrotated clip still reports coded == display dims.
const dispReframePlainRes = await client.callTool({
  name: "reframe",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-reframe-plain.mp4"), width: 1080, height: 1920, mode: "crop" },
});
const dispReframePlainJson = JSON.parse(dispReframePlainRes.content[0].text);
checkOk(dispReframePlainJson.source === "1280x720" && dispReframePlainJson.source_rotation === null, "reframe on an unrotated clip still reports source 1280x720, rotation null", JSON.stringify(dispReframePlainJson));

// chroma_key: green screen out. Fixture test/greenscreen.mp4 is pure
// green 640x360 with a red 200x140 rect in the middle. Transparent
// mode must keep an alpha channel (.mov ProRes 4444); composite mode
// puts the subject on a color or an image background.
const chromaRes = await client.callTool({
  name: "chroma_key",
  arguments: { input: path.join(root, "test/greenscreen.mp4"), output: path.join(root, "outputs/mcp-chroma.mov") },
});
const chromaJson = JSON.parse(chromaRes.content[0].text);
console.log("chroma_key call:", JSON.stringify(chromaJson));
checkOk(chromaJson.mode === "transparent" && chromaJson.has_alpha === true && /yuva/.test(chromaJson.pixel_format ?? ""), "chroma_key transparent mode keeps an alpha channel (ProRes 4444 .mov)", JSON.stringify(chromaJson));
checkOk(chromaJson.alpha_corner_mean !== null && chromaJson.alpha_corner_mean < 20, "chroma_key keyed-out green corner is transparent (alpha ~0)", `corner alpha=${chromaJson.alpha_corner_mean}`);
checkOk(chromaJson.alpha_center_mean !== null && chromaJson.alpha_center_mean > 235, "chroma_key red subject stays opaque (alpha ~255)", `center alpha=${chromaJson.alpha_center_mean}`);
checkOk(near(chromaJson.alpha_mean, 31, 6), "chroma_key alpha mean matches the subject share of the frame (200x140 of 640x360)", `alpha_mean=${chromaJson.alpha_mean}`);
checkOk(chromaJson.dimensions === "640x360" && near(chromaJson.duration_seconds, 3, 0.1) && typeof chromaJson.size_bytes === "number" && chromaJson.size_bytes > 0, "chroma_key keeps dimensions/duration, real bytes", JSON.stringify(chromaJson));
// Independent: ffprobe (not the tool's report) sees the alpha pixel format.
const { stdout: chromaProbeOut } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", path.join(root, "outputs/mcp-chroma.mov")]);
checkOk(/yuva/.test(chromaProbeOut.trim()), "ffprobe independently reads a yuva pixel format on the keyed file", chromaProbeOut.trim());
const chromaBgRes = await client.callTool({
  name: "chroma_key",
  arguments: { input: path.join(root, "test/greenscreen.mp4"), output: path.join(root, "outputs/mcp-chroma-bg.mp4"), background: "1E40AF" },
});
const chromaBgJson = JSON.parse(chromaBgRes.content[0].text);
checkOk(chromaBgJson.mode === "composite" && chromaBgJson.has_alpha === false && chromaBgJson.pixel_format === "yuv420p", "chroma_key --background composites to a flat yuv420p mp4", JSON.stringify(chromaBgJson));
const chromaBgB = await planeMean(path.join(root, "outputs/mcp-chroma-bg.mp4"), "100:100:0:0", "b");
const chromaBgR = await planeMean(path.join(root, "outputs/mcp-chroma-bg.mp4"), "100:100:270:130", "r");
console.log("chroma composite pixels: corner B =", chromaBgB, "| center R =", chromaBgR);
checkOk(chromaBgB !== null && chromaBgB > 160, "chroma_key composite corner is the background blue (B~175)", `B=${chromaBgB}`);
checkOk(chromaBgR !== null && chromaBgR > 240, "chroma_key composite center is the red subject (R~253)", `R=${chromaBgR}`);
const chromaBgImgRes = await client.callTool({
  name: "chroma_key",
  arguments: { input: path.join(root, "test/greenscreen.mp4"), output: path.join(root, "outputs/mcp-chroma-bgimg.mp4"), background: path.join(root, "test/kenburns.png") },
});
const chromaBgImgJson = JSON.parse(chromaBgImgRes.content[0].text);
checkOk(chromaBgImgJson.mode === "composite" && typeof chromaBgImgJson.background === "string" && chromaBgImgJson.background.endsWith("kenburns.png"), "chroma_key --background accepts an image file", JSON.stringify(chromaBgImgJson));
const chromaBgImgB = await planeMean(path.join(root, "outputs/mcp-chroma-bgimg.mp4"), "100:100:0:0", "b");
checkOk(chromaBgImgB !== null && chromaBgImgB > 160, "chroma_key image background shows through the keyed corner", `B=${chromaBgImgB}`);
const chromaMp4 = await callExpectThrow("chroma_key", { input: path.join(root, "test/greenscreen.mp4"), output: path.join(root, "outputs/mcp-chroma-bad.mp4") });
checkOk(/must be \.mov/.test(chromaMp4), "chroma_key refuses .mp4 without a background (no alpha channel)", chromaMp4.slice(0, 200));
const chromaBadColor = await callExpectThrow("chroma_key", { input: path.join(root, "test/greenscreen.mp4"), output: path.join(root, "outputs/mcp-chroma-bad2.mov"), color: "ZZZZZZ" });
checkOk(/6-digit hex/.test(chromaBadColor), "chroma_key refuses a non-hex key color", chromaBadColor.slice(0, 200));
// chroma_key --dry-run (lượt 113, batch 4): both branches print
// the exact command and write no file; measured fields report null.
const chromaDryRes = await client.callTool({
  name: "chroma_key",
  arguments: { input: path.join(root, "test/greenscreen.mp4"), output: path.join(root, "outputs/mcp-chroma-dry.mov"), dry_run: true },
});
const chromaDryJson = JSON.parse(chromaDryRes.content[0].text);
checkOk(chromaDryJson.dry_run === true && chromaDryJson.mode === "transparent" && chromaDryJson.pixel_format === null && chromaDryJson.has_alpha === null && chromaDryJson.alpha_mean === null && chromaDryJson.duration_seconds === null && chromaDryJson.dimensions === null, "chroma_key transparent dry-run reports mode + null measured fields", JSON.stringify(chromaDryJson));
checkOk(chromaDryJson.commands?.length === 1 && chromaDryJson.commands[0].includes("chromakey=0x00FF00:0.1:0") && chromaDryJson.commands[0].includes("prores_ks"), "chroma_key transparent dry-run prints the exact ProRes key command", chromaDryJson.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-chroma-dry.mov")), "chroma_key transparent dry-run writes no file", "outputs/mcp-chroma-dry.mov");
const chromaBgDryRes = await client.callTool({
  name: "chroma_key",
  arguments: { input: path.join(root, "test/greenscreen.mp4"), output: path.join(root, "outputs/mcp-chroma-bg-dry.mp4"), background: "1E40AF", dry_run: true },
});
const chromaBgDryJson = JSON.parse(chromaBgDryRes.content[0].text);
checkOk(chromaBgDryJson.dry_run === true && chromaBgDryJson.mode === "composite" && chromaBgDryJson.background === "1E40AF" && chromaBgDryJson.commands?.[0]?.includes("color=c=0x1E40AF"), "chroma_key composite dry-run reports the background color + exact lavfi command", JSON.stringify(chromaBgDryJson));
checkOk(!existsSync(path.join(root, "outputs/mcp-chroma-bg-dry.mp4")), "chroma_key composite dry-run writes no file", "outputs/mcp-chroma-bg-dry.mp4");
const chromaBadSim = await callExpectThrow("chroma_key", { input: path.join(root, "test/greenscreen.mp4"), output: path.join(root, "outputs/mcp-chroma-bad3.mov"), similarity: 2 });
checkOk(/similarity/.test(chromaBadSim), "chroma_key refuses similarity above 1", chromaBadSim.slice(0, 200));

// zoom_pan: Ken Burns on test/kenburns.png (blue field, yellow rect
// center, red rect bottom-left). Frame 0 must be the full image, the
// last frame the 2x center window — both checked against crops
// computed independently with plain ffmpeg (frames extracted as mp4
// so psnrY sees YUV, not RGB).
async function frameMp4(input, frameNo, out) {
  await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", input, "-vf", `select='eq(n\\,${frameNo})'`, "-frames:v", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
}
const zoomRes = await client.callTool({
  name: "zoom_pan",
  arguments: { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-zoompan.mp4"), duration: 3, fps: 30, zoom_from: 1, zoom_to: 2, width: 640, height: 360 },
});
const zoomJson = JSON.parse(zoomRes.content[0].text);
console.log("zoom_pan call:", JSON.stringify(zoomJson));
checkOk(zoomJson.frames === 90 && near(zoomJson.duration_seconds, 3, 0.1) && zoomJson.dimensions === "640x360" && zoomJson.fps === 30, "zoom_pan makes a 3s 30fps 640x360 clip with 90 frames", JSON.stringify(zoomJson));
await frameMp4(path.join(root, "outputs/mcp-zoompan.mp4"), 0, path.join(root, "outputs/mcp-zoompan-f0.mp4"));
await frameMp4(path.join(root, "outputs/mcp-zoompan.mp4"), 89, path.join(root, "outputs/mcp-zoompan-f89.mp4"));
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(root, "test/kenburns.png"), "-vf", "scale=640:360", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "outputs/mcp-zoompan-exp-f0.mp4")]);
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(root, "test/kenburns.png"), "-vf", "crop=640:360:320:180,scale=640:360", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "outputs/mcp-zoompan-exp-f89.mp4")]);
const zoomF0Psnr = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-f0.mp4"), path.join(root, "outputs/mcp-zoompan-f0.mp4"));
const zoomF89Psnr = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-f89.mp4"), path.join(root, "outputs/mcp-zoompan-f89.mp4"));
const zoomF89VsFull = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-f0.mp4"), path.join(root, "outputs/mcp-zoompan-f89.mp4"));
console.log("zoom_pan PSNR: f0 vs full =", zoomF0Psnr, "| f89 vs center-crop =", zoomF89Psnr, "| f89 vs full =", zoomF89VsFull);
checkOk(zoomF0Psnr !== null && zoomF0Psnr > 40, "zoom_pan first frame is the full image", `PSNR ${zoomF0Psnr}`);
checkOk(zoomF89Psnr !== null && zoomF89Psnr > 25 && zoomF89VsFull !== null && zoomF89Psnr > zoomF89VsFull + 10, "zoom_pan last frame is the 2x center window (not the full image)", `center ${zoomF89Psnr} vs full ${zoomF89VsFull}`);
// Pan at fixed 2x zoom: focus 0.2 -> 0.8 moves the window left to
// right. End window in source pixels: x=704 (0.8*1280-320), y=180.
const zoomPanRes = await client.callTool({
  name: "zoom_pan",
  arguments: { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-zoompan-pan.mp4"), duration: 3, fps: 30, zoom_from: 2, zoom_to: 2, focus_x: 0.2, focus_end_x: 0.8, width: 640, height: 360 },
});
const zoomPanJson = JSON.parse(zoomPanRes.content[0].text);
checkOk(zoomPanJson.frames === 90 && zoomPanJson.focus_end[0] === 0.8, "zoom_pan pan case: fixed 2x zoom, focus moves 0.2 -> 0.8", JSON.stringify(zoomPanJson));
await frameMp4(path.join(root, "outputs/mcp-zoompan-pan.mp4"), 0, path.join(root, "outputs/mcp-zoompan-pan-f0.mp4"));
await frameMp4(path.join(root, "outputs/mcp-zoompan-pan.mp4"), 89, path.join(root, "outputs/mcp-zoompan-pan-f89.mp4"));
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(root, "test/kenburns.png"), "-vf", "crop=640:360:0:180,scale=640:360", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "outputs/mcp-zoompan-exp-pan-start.mp4")]);
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(root, "test/kenburns.png"), "-vf", "crop=640:360:704:180,scale=640:360", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "outputs/mcp-zoompan-exp-pan-end.mp4")]);
const panF0Psnr = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-pan-start.mp4"), path.join(root, "outputs/mcp-zoompan-pan-f0.mp4"));
const panF89EndPsnr = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-pan-end.mp4"), path.join(root, "outputs/mcp-zoompan-pan-f89.mp4"));
const panF89StartPsnr = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-pan-start.mp4"), path.join(root, "outputs/mcp-zoompan-pan-f89.mp4"));
console.log("zoom_pan pan PSNR: f0 vs left =", panF0Psnr, "| f89 vs right =", panF89EndPsnr, "| f89 vs left =", panF89StartPsnr);
checkOk(panF0Psnr !== null && panF0Psnr > 25, "zoom_pan pan starts at the left window", `PSNR ${panF0Psnr}`);
checkOk(panF89EndPsnr !== null && panF89EndPsnr > 25 && panF89StartPsnr !== null && panF89EndPsnr > panF89StartPsnr + 10, "zoom_pan pan ends at the right window (not the left one)", `right ${panF89EndPsnr} vs left ${panF89StartPsnr}`);
const zoomVideo = await callExpectThrow("zoom_pan", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-zoompan-bad.mp4") });
checkOk(/still image/.test(zoomVideo), "zoom_pan refuses a video input", zoomVideo.slice(0, 200));
// zoom_pan dry-run (lượt 116, batch 5): zoom/focus expressions exact,
// duration/frames null, no file written.
const zoomDryRes = await client.callTool({
  name: "zoom_pan",
  arguments: { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-zoompan-dry.mp4"), duration: 3, fps: 30, zoom_from: 1, zoom_to: 2, width: 640, height: 360, dry_run: true },
});
const zoomDryJson = JSON.parse(zoomDryRes.content[0].text);
checkOk(zoomDryJson.dry_run === true && zoomDryJson.dimensions === "640x360" && zoomDryJson.fps === 30 && zoomDryJson.frames === null && zoomDryJson.duration_seconds === null && zoomDryJson.expected_duration_seconds === 3 && zoomDryJson.zoom_from === 1 && zoomDryJson.zoom_to === 2 && !existsSync(path.join(root, "outputs/mcp-zoompan-dry.mp4")), "zoom_pan dry-run reports 640x360/30fps/expected 3s, frames/duration null, writes nothing", JSON.stringify(zoomDryJson));
checkOk(zoomDryJson.commands?.length === 1 && zoomDryJson.commands[0].includes("zoompan=z=") && zoomDryJson.commands[0].includes("d=90") && zoomDryJson.commands[0].includes("s=640x360"), "zoom_pan dry-run command carries the zoompan filter for 90 frames at 640x360", zoomDryJson.commands?.[0] ?? "");
const zoomBad = await callExpectThrow("zoom_pan", { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-zoompan-bad2.mp4"), zoom_to: 0 });
checkOk(/zoom_to/.test(zoomBad), "zoom_pan refuses zoom_to below 1", zoomBad.slice(0, 200));

// image_to_video: one still image -> fixed-duration video that holds
// still. Frame 0 must match the source scaled to 640x360 (PSNR > 40,
// same expected file the zoom_pan test built), and the last frame
// must match the first (static video, PSNR > 50).
const img2vidRes = await client.callTool({
  name: "image_to_video",
  arguments: { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-img2vid.mp4"), duration: 3, fps: 30, width: 640, height: 360 },
});
const img2vidJson = JSON.parse(img2vidRes.content[0].text);
console.log("image_to_video call:", JSON.stringify(img2vidJson));
checkOk(img2vidJson.frames === 90 && near(img2vidJson.duration_seconds, 3, 0.1) && img2vidJson.dimensions === "640x360" && img2vidJson.fps === 30, "image_to_video makes a 3s 30fps 640x360 clip with exactly 90 frames", JSON.stringify(img2vidJson));
await frameMp4(path.join(root, "outputs/mcp-img2vid.mp4"), 0, path.join(root, "outputs/mcp-img2vid-f0.mp4"));
await frameMp4(path.join(root, "outputs/mcp-img2vid.mp4"), 89, path.join(root, "outputs/mcp-img2vid-f89.mp4"));
const img2vidF0Psnr = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-f0.mp4"), path.join(root, "outputs/mcp-img2vid-f0.mp4"));
const img2vidStaticPsnr = await psnrY(path.join(root, "outputs/mcp-img2vid-f0.mp4"), path.join(root, "outputs/mcp-img2vid-f89.mp4"));
console.log("image_to_video PSNR: f0 vs source =", img2vidF0Psnr, "| f89 vs f0 =", img2vidStaticPsnr);
checkOk(img2vidF0Psnr !== null && img2vidF0Psnr > 40, "image_to_video first frame is the source image", `PSNR ${img2vidF0Psnr}`);
checkOk(img2vidStaticPsnr !== null && img2vidStaticPsnr > 50, "image_to_video holds still: last frame matches the first", `PSNR ${img2vidStaticPsnr}`);
// Default dimensions = the image itself (1280x720); width-only keeps
// the aspect (640 -> 640x360).
const img2vidDefRes = await client.callTool({
  name: "image_to_video",
  arguments: { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-img2vid-def.mp4"), duration: 2, fps: 24 },
});
const img2vidDefJson = JSON.parse(img2vidDefRes.content[0].text);
checkOk(img2vidDefJson.frames === 48 && img2vidDefJson.dimensions === "1280x720" && img2vidDefJson.fps === 24, "image_to_video defaults to the image size and fps given (2s 24fps = 48 frames)", JSON.stringify(img2vidDefJson));
const img2vidWRes = await client.callTool({
  name: "image_to_video",
  arguments: { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-img2vid-w.mp4"), duration: 1, fps: 30, width: 640 },
});
const img2vidWJson = JSON.parse(img2vidWRes.content[0].text);
checkOk(img2vidWJson.dimensions === "640x360" && img2vidWJson.frames === 30, "image_to_video width-only 640 keeps the 16:9 aspect (640x360)", JSON.stringify(img2vidWJson));
// Audio: the 9s voice bed loops under a 3s still; the clip stays 3s
// and carries a real audio stream (checked independently, not from
// the tool's own report).
const img2vidAudioRes = await client.callTool({
  name: "image_to_video",
  arguments: { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-img2vid-audio.mp4"), duration: 3, fps: 30, width: 640, height: 360, audio: path.join(root, "test/mix-voice.mp3") },
});
const img2vidAudioJson = JSON.parse(img2vidAudioRes.content[0].text);
checkOk(img2vidAudioJson.audio === true && near(img2vidAudioJson.duration_seconds, 3, 0.1), "image_to_video with audio reports audio=true and stays 3s", JSON.stringify(img2vidAudioJson));
const img2vidAudioProbe = await probeStreams(path.join(root, "outputs/mcp-img2vid-audio.mp4"));
const img2vidAudioTypes = img2vidAudioProbe?.streams?.map((s) => `${s.codec_type}:${s.codec_name}`) ?? [];
checkOk(img2vidAudioTypes.includes("video:h264") && img2vidAudioTypes.includes("audio:aac") && near(+img2vidAudioProbe.format.duration, 3, 0.1), "image_to_video audio file has h264 + aac streams at 3s (ffprobe, independent)", JSON.stringify(img2vidAudioTypes));
const img2vidVideo = await callExpectThrow("image_to_video", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-img2vid-bad.mp4") });
checkOk(/still image/.test(img2vidVideo), "image_to_video refuses a video input", img2vidVideo.slice(0, 200));
const img2vidDur = await callExpectThrow("image_to_video", { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-img2vid-bad2.mp4"), duration: 0 });
checkOk(/duration/.test(img2vidDur), "image_to_video refuses duration below 0.5s", img2vidDur.slice(0, 200));
const img2vidExt = await callExpectThrow("image_to_video", { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-img2vid-bad3.mov") });
checkOk(/webm/.test(img2vidExt), "image_to_video refuses a .mov output (mp4 or webm only)", img2vidExt.slice(0, 200));
const img2vidNoAudio = await callExpectThrow("image_to_video", { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-img2vid-bad4.mp4"), audio: path.join(root, "test/logo.png") });
checkOk(/no audio stream/.test(img2vidNoAudio), "image_to_video refuses an --audio file with no audio stream", img2vidNoAudio.slice(0, 200));
// image_to_video dry-run (lượt 116, batch 5): dimensions/fps/duration
// computed, frames null, no file written.
const img2vidDryRes = await client.callTool({
  name: "image_to_video",
  arguments: { input: path.join(root, "test/kenburns.png"), output: path.join(root, "outputs/mcp-img2vid-dry.mp4"), duration: 3, fps: 30, width: 640, height: 360, dry_run: true },
});
const img2vidDryJson = JSON.parse(img2vidDryRes.content[0].text);
checkOk(img2vidDryJson.dry_run === true && img2vidDryJson.dimensions === "640x360" && img2vidDryJson.fps === 30 && img2vidDryJson.frames === null && img2vidDryJson.duration_seconds === null && img2vidDryJson.expected_duration_seconds === 3 && !existsSync(path.join(root, "outputs/mcp-img2vid-dry.mp4")), "image_to_video dry-run reports 640x360/30fps/expected 3s, frames null, writes nothing", JSON.stringify(img2vidDryJson));
checkOk(img2vidDryJson.commands?.length === 1 && img2vidDryJson.commands[0].includes("-loop 1") && img2vidDryJson.commands[0].includes("scale=640:360") && img2vidDryJson.commands[0].includes("-t 3"), "image_to_video dry-run command loops the still at 30fps for 3s", img2vidDryJson.commands?.[0] ?? "");

// slideshow: 3 still images -> one 9s video, fade 1s between pairs.
// Each image is visible for its own 3s (total = 9s exactly), the
// transition eats a handle, not slide time. Frame 30 (t=1) must be
// slide 1, frame 135 (t=4.5) slide 2, frame 225 (t=7.5) slide 3, and
// frame 105 (t=3.5, mid-fade) must be a blend of slides 1 and 2 —
// neither pure slide.
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x00FF00:s=640x360:d=1", "-frames:v", "1", path.join(root, "outputs/mcp-slideshow-green.png")]);
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(root, "test/logo.png"), "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "outputs/mcp-slideshow-exp-logo.mp4")]);
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(root, "outputs/mcp-slideshow-green.png"), "-vf", "scale=640:360", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "outputs/mcp-slideshow-exp-green.mp4")]);
const slideRes = await client.callTool({
  name: "slideshow",
  arguments: { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow.mp4"), durations: [3, 3, 3], transition: "fade", transition_duration: 1, fps: 30, width: 640, height: 360 },
});
const slideJson = JSON.parse(slideRes.content[0].text);
console.log("slideshow call:", JSON.stringify(slideJson));
checkOk(slideJson.frames === 270 && near(slideJson.duration_seconds, 9, 0.1) && near(slideJson.expected_duration_seconds, 9, 0.01) && slideJson.dimensions === "640x360" && slideJson.fps === 30 && slideJson.transition === "fade", "slideshow makes a 9s 30fps 640x360 video from 3x3s slides (270 frames, total = sum of durations)", JSON.stringify(slideJson));
await frameMp4(path.join(root, "outputs/mcp-slideshow.mp4"), 30, path.join(root, "outputs/mcp-slideshow-f30.mp4"));
await frameMp4(path.join(root, "outputs/mcp-slideshow.mp4"), 105, path.join(root, "outputs/mcp-slideshow-f105.mp4"));
await frameMp4(path.join(root, "outputs/mcp-slideshow.mp4"), 135, path.join(root, "outputs/mcp-slideshow-f135.mp4"));
await frameMp4(path.join(root, "outputs/mcp-slideshow.mp4"), 225, path.join(root, "outputs/mcp-slideshow-f225.mp4"));
const slideF30Psnr = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-f0.mp4"), path.join(root, "outputs/mcp-slideshow-f30.mp4"));
const slideF135Psnr = await psnrY(path.join(root, "outputs/mcp-slideshow-exp-logo.mp4"), path.join(root, "outputs/mcp-slideshow-f135.mp4"));
const slideF225Psnr = await psnrY(path.join(root, "outputs/mcp-slideshow-exp-green.mp4"), path.join(root, "outputs/mcp-slideshow-f225.mp4"));
const slideMidVs1 = await psnrY(path.join(root, "outputs/mcp-zoompan-exp-f0.mp4"), path.join(root, "outputs/mcp-slideshow-f105.mp4"));
const slideMidVs2 = await psnrY(path.join(root, "outputs/mcp-slideshow-exp-logo.mp4"), path.join(root, "outputs/mcp-slideshow-f105.mp4"));
const slideF30Vs2 = await psnrY(path.join(root, "outputs/mcp-slideshow-exp-logo.mp4"), path.join(root, "outputs/mcp-slideshow-f30.mp4"));
console.log("slideshow PSNR: f30 vs slide1 =", slideF30Psnr, "| f135 vs slide2 =", slideF135Psnr, "| f225 vs slide3 =", slideF225Psnr, "| mid vs slide1 =", slideMidVs1, "| mid vs slide2 =", slideMidVs2, "| f30 vs slide2 =", slideF30Vs2);
checkOk(slideF30Psnr !== null && slideF30Psnr > 40, "slideshow frame at t=1s is slide 1 (kenburns)", `PSNR ${slideF30Psnr}`);
checkOk(slideF135Psnr !== null && slideF135Psnr > 40, "slideshow frame at t=4.5s is slide 2 (logo)", `PSNR ${slideF135Psnr}`);
checkOk(slideF225Psnr !== null && slideF225Psnr > 40, "slideshow frame at t=7.5s is slide 3 (green)", `PSNR ${slideF225Psnr}`);
checkOk(slideMidVs1 !== null && slideMidVs1 < 30 && slideMidVs2 !== null && slideMidVs2 < 30, "slideshow mid-transition frame is a blend of slides 1 and 2 (neither pure slide)", `vs slide1 ${slideMidVs1}, vs slide2 ${slideMidVs2}`);
checkOk(slideF30Vs2 !== null && slideF30Vs2 < 15, "slideshow slides play in order (t=1s is not slide 2)", `PSNR ${slideF30Vs2}`);
// Per-slide durations via the durations array: 2+4+2 = 8s, 240 frames.
const slideDurRes = await client.callTool({
  name: "slideshow",
  arguments: { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow-dur.mp4"), durations: [2, 4, 2], transition: "wipeleft", transition_duration: 1, fps: 30, width: 640, height: 360 },
});
const slideDurJson = JSON.parse(slideDurRes.content[0].text);
checkOk(slideDurJson.frames === 240 && near(slideDurJson.duration_seconds, 8, 0.1) && slideDurJson.slides.map((s) => s.duration_seconds).join(",") === "2,4,2", "slideshow durations array [2,4,2] gives an 8s video (240 frames) with per-slide durations reported", JSON.stringify(slideDurJson));
// Per-image object form: {file, duration} overrides the scalar.
const slideObjRes = await client.callTool({
  name: "slideshow",
  arguments: { images: [{ file: path.join(root, "test/kenburns.png"), duration: 2 }, { file: path.join(root, "test/logo.png"), duration: 2 }], output: path.join(root, "outputs/mcp-slideshow-obj.mp4"), width: 640, height: 360 },
});
const slideObjJson = JSON.parse(slideObjRes.content[0].text);
checkOk(slideObjJson.frames === 120 && near(slideObjJson.duration_seconds, 4, 0.1), "slideshow {file, duration} objects give a 4s video (120 frames)", JSON.stringify(slideObjJson));
// Audio: the 9s voice bed loops under the 9s slideshow.
const slideAudioRes = await client.callTool({
  name: "slideshow",
  arguments: { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow-audio.mp4"), duration: 3, transition_duration: 1, fps: 30, width: 640, height: 360, audio: path.join(root, "test/mix-voice.mp3") },
});
const slideAudioJson = JSON.parse(slideAudioRes.content[0].text);
checkOk(slideAudioJson.audio === true && near(slideAudioJson.duration_seconds, 9, 0.1), "slideshow with audio reports audio=true and stays 9s", JSON.stringify(slideAudioJson));
const slideAudioProbe = await probeStreams(path.join(root, "outputs/mcp-slideshow-audio.mp4"));
const slideAudioTypes = slideAudioProbe?.streams?.map((s) => `${s.codec_type}:${s.codec_name}`) ?? [];
checkOk(slideAudioTypes.includes("video:h264") && slideAudioTypes.includes("audio:aac") && near(+slideAudioProbe.format.duration, 9, 0.1), "slideshow audio file has h264 + aac streams at 9s (ffprobe, independent)", JSON.stringify(slideAudioTypes));
const slideOne = await callExpectThrow("slideshow", { images: [path.join(root, "test/kenburns.png")], output: path.join(root, "outputs/mcp-slideshow-bad.mp4") });
checkOk(/at least 2/.test(slideOne), "slideshow refuses a single image", slideOne.slice(0, 200));
const slideLong = await callExpectThrow("slideshow", { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png")], output: path.join(root, "outputs/mcp-slideshow-bad2.mp4"), durations: [2, 2], transition_duration: 3 });
checkOk(/shorter than the shortest slide/.test(slideLong), "slideshow refuses a transition longer than the shortest slide", slideLong.slice(0, 200));
const slideTrans = await callExpectThrow("slideshow", { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png")], output: path.join(root, "outputs/mcp-slideshow-bad3.mp4"), transition: "swirl" });
checkOk(/unknown transition/.test(slideTrans), "slideshow refuses an unknown transition", slideTrans.slice(0, 200));
const slideVideo = await callExpectThrow("slideshow", { images: [path.join(root, "test/source.mp4"), path.join(root, "test/logo.png")], output: path.join(root, "outputs/mcp-slideshow-bad4.mp4") });
checkOk(/still image/.test(slideVideo), "slideshow refuses a video as a slide", slideVideo.slice(0, 200));
const slideMov = await callExpectThrow("slideshow", { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png")], output: path.join(root, "outputs/mcp-slideshow-bad5.mov") });
checkOk(/mp4 only/.test(slideMov), "slideshow refuses a .mov output (mp4 only in v1)", slideMov.slice(0, 200));
// Per-pair transitions (lượt 44): fade 1s into slide 2, wipeleft 0.5s
// into slide 3. Join 1 spans [3,4], join 2 spans [6,6.5]; total stays
// 9s / 270 frames, and the result echoes the per-join lists.
const slidePairsRes = await client.callTool({
  name: "slideshow",
  arguments: { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow-pairs.mp4"), durations: [3, 3, 3], transitions: ["fade", "wipeleft"], transition_durations: [1, 0.5], fps: 30, width: 640, height: 360 },
});
const slidePairsJson = JSON.parse(slidePairsRes.content[0].text);
console.log("slideshow per-pair:", JSON.stringify(slidePairsJson.transitions), JSON.stringify(slidePairsJson.transition_durations), "| frames", slidePairsJson.frames, "| dur", slidePairsJson.duration_seconds);
checkOk(slidePairsJson.frames === 270 && near(slidePairsJson.duration_seconds, 9, 0.1) && JSON.stringify(slidePairsJson.transitions) === '["fade","wipeleft"]' && JSON.stringify(slidePairsJson.transition_durations) === "[1,0.5]" && slidePairsJson.transition === null && slidePairsJson.transition_duration === null, "slideshow per-pair transitions echo the per-join list (fade 1s, wipeleft 0.5s) and total 9s / 270 frames", JSON.stringify(slidePairsJson));
await frameMp4(path.join(root, "outputs/mcp-slideshow-pairs.mp4"), 187, path.join(root, "outputs/mcp-slideshow-pairs-f187.mp4"));
const pairsF187Vs2 = await psnrY(path.join(root, "outputs/mcp-slideshow-exp-logo.mp4"), path.join(root, "outputs/mcp-slideshow-pairs-f187.mp4"));
const pairsF187Vs3 = await psnrY(path.join(root, "outputs/mcp-slideshow-exp-green.mp4"), path.join(root, "outputs/mcp-slideshow-pairs-f187.mp4"));
console.log("slideshow pairs f187 (mid wipeleft) vs slide2 =", pairsF187Vs2, "| vs slide3 =", pairsF187Vs3);
checkOk(pairsF187Vs2 !== null && pairsF187Vs2 < 30 && pairsF187Vs3 !== null && pairsF187Vs3 < 30, "slideshow mid-wipeleft frame is a blend of slides 2 and 3 (neither pure slide)", `vs slide2 ${pairsF187Vs2}, vs slide3 ${pairsF187Vs3}`);
const slidePairsBadLen = await callExpectThrow("slideshow", { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow-bad6.mp4"), transitions: ["fade"] });
checkOk(/one entry per join/.test(slidePairsBadLen), "slideshow refuses a transitions list with the wrong length", slidePairsBadLen.slice(0, 200));
const slidePairsBadName = await callExpectThrow("slideshow", { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow-bad7.mp4"), transitions: ["fade", "swirl"] });
checkOk(/unknown transition/.test(slidePairsBadName), "slideshow refuses an unknown name inside transitions", slidePairsBadName.slice(0, 200));
const slidePairsBadDurLen = await callExpectThrow("slideshow", { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow-bad8.mp4"), transitions: ["fade", "wipeleft"], transition_durations: [1] });
checkOk(/one entry per join/.test(slidePairsBadDurLen), "slideshow refuses a transition_durations list with the wrong length", slidePairsBadDurLen.slice(0, 200));
const slidePairsBadDur = await callExpectThrow("slideshow", { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow-bad9.mp4"), transitions: ["fade", "wipeleft"], transition_durations: [1, 3] });
checkOk(/shorter than the slides it joins/.test(slidePairsBadDur), "slideshow refuses a per-join duration longer than its slides", slidePairsBadDur.slice(0, 200));
// slideshow dry-run (lượt 116, batch 5; lượt 117: the join is now an
// exact command too — built by the same builder concat --transition
// runs — not a plan): one exact command per slide clip, the exact
// xfade join, the audio command exact when a bed is given;
// duration/frames null, no file.
const slideDryRes = await client.callTool({
  name: "slideshow",
  arguments: { images: [path.join(root, "test/kenburns.png"), path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-slideshow-green.png")], output: path.join(root, "outputs/mcp-slideshow-dry.mp4"), durations: [3, 3, 3], transition: "fade", transition_duration: 1, fps: 30, width: 640, height: 360, audio: path.join(root, "test/mix-voice.mp3"), dry_run: true },
});
const slideDryJson = JSON.parse(slideDryRes.content[0].text);
checkOk(slideDryJson.dry_run === true && near(slideDryJson.expected_duration_seconds, 9, 0.01) && slideDryJson.duration_seconds === null && slideDryJson.frames === null && slideDryJson.audio === true && slideDryJson.stage_commands?.length === 3 && slideDryJson.join?.tool === "concat" && typeof slideDryJson.join?.command === "string" && /xfade=transition=fade:duration=1:offset=3/.test(slideDryJson.join.command) && /anullsrc/.test(slideDryJson.join.command) && near(slideDryJson.join?.expected_duration_seconds, 9, 0.01) && JSON.stringify(slideDryJson.join?.transitions) === '["fade","fade"]' && !existsSync(path.join(root, "outputs/mcp-slideshow-dry.mp4")), "slideshow dry-run prints 3 slide clips + the exact concat xfade join (offset 3, silent clips get anullsrc beds) + audio, duration/frames null, writes nothing", JSON.stringify({ stages: slideDryJson.stage_commands?.length, join: slideDryJson.join?.tool }));
checkOk(slideDryJson.stage_commands.every((c) => c.includes("-loop 1") && c.includes("scale=640:360")) && slideDryJson.stage_commands[0].includes("-t 4") && slideDryJson.stage_commands[2].includes("-t 3"), "slideshow dry-run stage commands are image_to_video clips (first two carry the 1s xfade handle, last is exactly 3s)", slideDryJson.stage_commands?.[0] ?? "");
checkOk(typeof slideDryJson.audio_command === "string" && slideDryJson.audio_command.includes("-stream_loop -1") && slideDryJson.audio_command.includes("-c:v copy") && slideDryJson.audio_command.includes("-t 9"), "slideshow dry-run audio command loops the bed under the 9s join", slideDryJson.audio_command ?? "");

// interpolate: 30fps -> 60fps with blend (fast mode). The frame count
// is asserted on the output file, not just r_frame_rate.
const interpRes = await client.callTool({
  name: "interpolate",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-interp.mp4"), fps: 60, mode: "blend" },
});
const interpJson = JSON.parse(interpRes.content[0].text);
console.log("interpolate call:", JSON.stringify(interpJson));
checkOk(interpJson.fps_before === 30 && interpJson.fps_after === 60, "interpolate 30fps -> 60fps", JSON.stringify(interpJson));
checkOk(interpJson.frames_before === 300 && interpJson.frames_after >= 590 && interpJson.frames_after <= 600, "interpolate counts ~600 frames on the output (was 300)", `frames ${interpJson.frames_before} -> ${interpJson.frames_after}`);
checkOk(near(interpJson.duration_seconds, 10, 0.15) && typeof interpJson.size_bytes === "number" && interpJson.size_bytes > 0, "interpolate keeps ~10s duration and reports size_bytes", `${interpJson.duration_seconds}s ${interpJson.size_bytes} B`);
// Independent fps check: ffprobe on the output file, not the tool's report.
const { stdout: interpProbeOut } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path.join(root, "outputs/mcp-interp.mp4")]);
checkOk(interpProbeOut.trim() === "60/1", "ffprobe independently reads 60fps on the interpolated file", interpProbeOut.trim());
const interpLow = await callExpectThrow("interpolate", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-interp-low.mp4"), fps: 15 });
checkOk(/not above source/.test(interpLow), "interpolate refuses a target fps below the source (use fit --max-fps)", interpLow.slice(0, 200));
const interpAudio = await callExpectThrow("interpolate", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-interp-audio.mp4"), fps: 60 });
checkOk(/needs a video/.test(interpAudio), "interpolate refuses an audio-only input", interpAudio.slice(0, 200));
// mci on a short clip (the full 10s takes ~90s on this CPU): trim 2s
// first, then interpolate — true motion compensation, not just blend.
const interpTrimRes = await client.callTool({
  name: "trim",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-interp-2s.mp4"), start: 0, end: 2 },
});
const interpTrimJson = JSON.parse(interpTrimRes.content[0].text);
checkOk(near(interpTrimJson.duration_seconds, 2, 0.1), "trim makes the 2s clip for the mci test", JSON.stringify(interpTrimJson));
const interpMciRes = await client.callTool({
  name: "interpolate",
  arguments: { input: path.join(root, "outputs/mcp-interp-2s.mp4"), output: path.join(root, "outputs/mcp-interp-mci.mp4"), fps: 60, mode: "mci" },
  // mci is ~9x realtime: the SDK's 60s default timeout kills the
  // call when the machine is busy even though the tool itself
  // finishes fine — same trap as the assemble renders (lượt 43),
  // same 300s override.
}, undefined, { timeout: 300000 });
const interpMciJson = JSON.parse(interpMciRes.content[0].text);
checkOk(interpMciJson.fps_after === 60 && interpMciJson.frames_after >= 115 && interpMciJson.frames_after <= 121, "interpolate mci gives ~120 frames for a 2s 60fps clip", `frames ${interpMciJson.frames_after}`);

// denoise: the fixture test/noisy.mp4 is a 5s loop of a photo with
// sigma-10 Gaussian noise; test/noisy-clean.mp4 is the same loop
// without noise, so PSNR against it is an independent measurement.
const denoiseRes = await client.callTool({
  name: "denoise",
  arguments: { input: path.join(root, "test/noisy.mp4"), output: path.join(root, "outputs/mcp-denoise.mp4"), strength: 0.5 },
});
const denoiseJson = JSON.parse(denoiseRes.content[0].text);
console.log("denoise call:", JSON.stringify(denoiseJson));
checkOk(denoiseJson.filter === "hqdn3d" && denoiseJson.filter_value === 15, "denoise strength 0.5 maps to hqdn3d=15", JSON.stringify(denoiseJson));
checkOk(typeof denoiseJson.noise_before === "number" && typeof denoiseJson.noise_after === "number" && denoiseJson.noise_after < denoiseJson.noise_before, "denoise lowers the measured high-frequency noise energy", `noise ${denoiseJson.noise_before} -> ${denoiseJson.noise_after}`);
checkOk(near(denoiseJson.duration_seconds, 5, 0.1) && denoiseJson.dimensions === "1400x800" && denoiseJson.size_bytes > 0, "denoise keeps duration/dimensions and reports size_bytes", `${denoiseJson.duration_seconds}s ${denoiseJson.dimensions} ${denoiseJson.size_bytes} B`);
// Independent PSNR vs the clean reference: the denoised file must be
// clearly closer to clean than the noisy input (measured 32.98 ->
// 38.63 dB Y on the fixtures; assert a >=2 dB gain to allow for
// encoder variance).
const psnrNoisy = await psnrY(path.join(root, "test/noisy-clean.mp4"), path.join(root, "test/noisy.mp4"));
const psnrDenoised = await psnrY(path.join(root, "test/noisy-clean.mp4"), path.join(root, "outputs/mcp-denoise.mp4"));
console.log("denoise PSNR-Y vs clean: noisy", psnrNoisy, "-> denoised", psnrDenoised);
checkOk(psnrNoisy !== null && psnrDenoised !== null && psnrDenoised >= psnrNoisy + 2, "denoise raises PSNR-Y vs the clean reference by >=2 dB", `noisy ${psnrNoisy} dB, denoised ${psnrDenoised} dB`);
const denoiseAudio = await callExpectThrow("denoise", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-denoise-audio.mp4") });
checkOk(/needs a video/.test(denoiseAudio), "denoise refuses an audio-only input", denoiseAudio.slice(0, 200));
const denoiseBadFilter = await callExpectThrow("denoise", { input: path.join(root, "test/noisy.mp4"), output: path.join(root, "outputs/mcp-denoise-bad.mp4"), filter: "bilateral" });
checkOk(/filter/.test(denoiseBadFilter), "denoise refuses an unknown filter (MCP enum validation)", denoiseBadFilter.slice(0, 200));
// nlmeans on a tiny clip (the full 720p 5s clip takes >120s): verify
// the second filter path actually runs and returns measurements.
await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", path.join(root, "test/noisy.mp4"), "-vf", "scale=320:180", "-t", "1", "-c:v", "libx264", "-crf", "23", path.join(root, "outputs/mcp-denoise-tiny.mp4")]);
const denoiseNlRes = await client.callTool({
  name: "denoise",
  arguments: { input: path.join(root, "outputs/mcp-denoise-tiny.mp4"), output: path.join(root, "outputs/mcp-denoise-nl.mp4"), filter: "nlmeans", strength: 0.5 },
});
const denoiseNlJson = JSON.parse(denoiseNlRes.content[0].text);
checkOk(denoiseNlJson.filter === "nlmeans" && denoiseNlJson.filter_value === 5 && near(denoiseNlJson.duration_seconds, 1, 0.1), "denoise nlmeans runs on a tiny clip (strength 0.5 -> s=5)", JSON.stringify(denoiseNlJson));

// segment: HLS VOD playlist + .ts segments. The fixture source.mp4
// has keyframes every 8.333s, so a copy with segment_time 2 gives 2
// keyframe-aligned segments (8.333 + 1.667), NOT 5 x 2s — the
// reencode path is what lands exactly on the grid.
await rm(path.join(root, "outputs/mcp-seg-copy"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-seg-re"), { recursive: true, force: true });
const segCopyRes = await client.callTool({
  name: "segment",
  arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-seg-copy"), segment_time: 2 },
});
const segCopyJson = JSON.parse(segCopyRes.content[0].text);
console.log("segment copy call:", JSON.stringify(segCopyJson));
checkOk(segCopyJson.mode === "copy" && segCopyJson.segment_count === 2, "segment copy: 2 keyframe-aligned segments on the sparse-GOP fixture", JSON.stringify(segCopyJson.segments));
checkOk(segCopyJson.segments[0].duration_seconds === 8.333 && segCopyJson.segments[1].duration_seconds === 1.667, "segment copy: durations follow the source keyframes (8.333 + 1.667)", JSON.stringify(segCopyJson.segments));
checkOk(near(segCopyJson.total_duration_seconds, 10, 0.05) && segCopyJson.duration_error_seconds === 0 && segCopyJson.dimensions === "1280x720" && segCopyJson.size_bytes > 0, "segment copy: total duration 10s, error 0, dimensions + size reported", `${segCopyJson.total_duration_seconds}s err ${segCopyJson.duration_error_seconds} ${segCopyJson.size_bytes} B`);
// Independent check: read the playlist back from disk and parse it
// ourselves — the tool's segment list must match the file on disk.
const playlistText = await readFile(path.join(root, "outputs/mcp-seg-copy/index.m3u8"), "utf8");
const extinf = [...playlistText.matchAll(/#EXTINF:([0-9.]+),/g)].map((m) => +parseFloat(m[1]).toFixed(3));
checkOk(playlistText.includes("#EXT-X-ENDLIST") && playlistText.includes("#EXT-X-PLAYLIST-TYPE:VOD"), "segment copy: playlist on disk is a VOD playlist with ENDLIST", playlistText.split("\n").slice(0, 6).join(" | "));
checkOk(JSON.stringify(extinf) === JSON.stringify(segCopyJson.segments.map((s) => s.duration_seconds)), "segment copy: playlist EXTINF durations match the tool's report", JSON.stringify(extinf));
const segProbe = await probeStreams(path.join(root, "outputs/mcp-seg-copy/seg000.ts"));
checkOk(segProbe?.streams?.[0]?.codec_name === "h264" && segProbe.streams[0].width === 1280, "segment copy: first .ts probes as h264 1280 wide", JSON.stringify(segProbe?.streams?.[0]));
const segReRes = await client.callTool({
  name: "segment",
  arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-seg-re"), segment_time: 2, reencode: true },
});
const segReJson = JSON.parse(segReRes.content[0].text);
checkOk(segReJson.mode === "reencode" && segReJson.segment_count === 5 && segReJson.segments.every((s) => s.duration_seconds === 2), "segment reencode: 5 x 2.000s segments on the exact grid", JSON.stringify(segReJson.segments));
checkOk(near(segReJson.total_duration_seconds, 10, 0.05) && segReJson.duration_error_seconds === 0, "segment reencode: total duration 10s, error 0", `${segReJson.total_duration_seconds}s`);
// Copy mode refuses a non-H.264 source up front (vp9 clip made
// in-test) instead of failing mid-mux; reencode accepts it.
await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", path.join(root, "test/source.mp4"), "-t", "2", "-c:v", "libvpx-vp9", "-b:v", "500k", "-c:a", "libopus", path.join(root, "outputs/mcp-seg-vp9.webm")]);
const segVp9 = await callExpectThrow("segment", { input: path.join(root, "outputs/mcp-seg-vp9.webm"), output_dir: path.join(root, "outputs/mcp-seg-vp9"), segment_time: 2 });
checkOk(/H\.264/.test(segVp9) && /reencode/.test(segVp9), "segment copy refuses a vp9 source and points at --reencode", segVp9.slice(0, 200));
const segVp9Re = await client.callTool({
  name: "segment",
  arguments: { input: path.join(root, "outputs/mcp-seg-vp9.webm"), output_dir: path.join(root, "outputs/mcp-seg-vp9-re"), segment_time: 2, reencode: true },
});
const segVp9ReJson = JSON.parse(segVp9Re.content[0].text);
checkOk(segVp9ReJson.mode === "reencode" && segVp9ReJson.segment_count === 1 && near(segVp9ReJson.total_duration_seconds, 2, 0.05), "segment reencode accepts the vp9 source (1 segment, ~2s)", JSON.stringify(segVp9ReJson.segments));
const segAudio = await callExpectThrow("segment", { input: path.join(root, "test/mix-voice.mp3"), output_dir: path.join(root, "outputs/mcp-seg-audio"), segment_time: 2 });
checkOk(/needs a video/.test(segAudio), "segment refuses an audio-only input", segAudio.slice(0, 200));
const segBadTime = await callExpectThrow("segment", { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-seg-bad"), segment_time: 0 });
checkOk(/segment_time/.test(segBadTime), "segment refuses segment_time 0 (MCP validation)", segBadTime.slice(0, 200));
const segBadPlaylist = await callExpectThrow("segment", { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-seg-bad2"), playlist: "index.txt" });
checkOk(/playlist/.test(segBadPlaylist), "segment refuses a playlist name that is not .m3u8", segBadPlaylist.slice(0, 200));

const doctorRes = await client.callTool({
  name: "doctor",
  arguments: {},
});
const doctorJson = JSON.parse(doctorRes.content[0].text);
console.log("doctor call: ok =", doctorJson.ok, "| ffmpeg", doctorJson.ffmpeg_version, "| tools available:", Object.values(doctorJson.tools).filter((t) => t.available).length + "/" + Object.keys(doctorJson.tools).length);
checkOk(doctorJson.ok === true, "doctor ok=true", JSON.stringify(doctorJson.tools));
// transcribe is optional (no engine on a fresh machine): every OTHER
// tool must be available, and transcribe reports its own engine state.
const { transcribe: doctorAsr, ...otherTools } = doctorJson.tools;
checkOk(Object.values(otherTools).every((t) => t.available), "doctor: all ffmpeg tools available");
checkOk(doctorAsr && typeof doctorAsr.available === "boolean" && ["faster-whisper", "whisper.cpp", "none"].includes(doctorAsr.engine), "doctor: transcribe reports an engine status", JSON.stringify(doctorAsr));
if (process.env.MEDIAKIT_TEST_ASR === "1") {
  checkOk(doctorAsr.available === true && doctorAsr.python === process.env.MEDIAKIT_ASR_PYTHON, "doctor: transcribe available with faster-whisper when the engine is installed", JSON.stringify(doctorAsr));
} else if (doctorAsr.available === false) {
  checkOk(/faster-whisper/.test(doctorAsr.fix ?? "") && /MEDIAKIT_ASR_PYTHON/.test(doctorAsr.fix ?? ""), "doctor: transcribe unavailable without an engine, with install hint", JSON.stringify(doctorAsr));
} else {
  // A machine with an engine installed (e.g. whisper.cpp in the
  // default dir) reports available — that is also a correct result.
  checkOk(["faster-whisper", "whisper.cpp"].includes(doctorAsr.engine), "doctor: transcribe available with an installed engine", JSON.stringify(doctorAsr));
}
checkOk(doctorJson.tools.fit?.available === true, "doctor: fit is available");
checkOk(doctorJson.tools.generate_srt?.available === true, "doctor: generate_srt is available (pure Node, no ffmpeg filter needed)");
checkOk(doctorJson.tools.export_gif?.available === true, "doctor: export_gif is available (palettegen/paletteuse present)");
checkOk(doctorJson.tools.extract_frames?.available === true, "doctor: extract_frames is available (fps/scale present)");
checkOk(doctorJson.tools.grade?.available === true, "doctor: grade is available (eq/hue/colorbalance/lutrgb present)");
checkOk(doctorJson.tools.check?.available === true, "doctor: check is available (astats/ametadata present for the peaks scan)");
checkOk(doctorJson.tools.reverse?.available === true, "doctor: reverse is available (reverse/areverse filters present)");
checkOk(doctorJson.tools.interpolate?.available === true, "doctor: interpolate is available (minterpolate filter present)");
checkOk(doctorJson.tools.denoise?.available === true, "doctor: denoise is available (hqdn3d/nlmeans filters present)");
checkOk(doctorJson.tools.segment?.available === true, "doctor: segment is available (HLS muxer is built-in)");
// libvmaf is build-dependent: the Ubuntu apt ffmpeg on CI ships
// it, the local 8.1.2 build does not (CI run 1 of lượt 101 failed
// here on `libvmaf === false`). Assert presence as a boolean and
// let the compress proof below follow the same branch — the proof
// must report a real VMAF score when the build has it, not claim
// VMAF is missing.
checkOk(doctorJson.filters?.ssim === true && doctorJson.filters?.psnr === true && typeof doctorJson.filters?.libvmaf === "boolean", "doctor: ssim/psnr filters present, libvmaf reported as a boolean (present on some ffmpeg builds, absent on others)", JSON.stringify({ ssim: doctorJson.filters?.ssim, psnr: doctorJson.filters?.psnr, libvmaf: doctorJson.filters?.libvmaf }));
const hasLibvmaf = doctorJson.filters?.libvmaf === true;
checkOk(typeof doctorJson.gpu?.available === "boolean" && Array.isArray(doctorJson.gpu?.encoders) && "working_encoder" in (doctorJson.gpu ?? {}), "doctor: gpu section reports available + listed encoders + working encoder", JSON.stringify(doctorJson.gpu));
checkOk(doctorJson.gpu.available === (doctorJson.gpu.working_encoder !== null), "doctor: gpu available is true exactly when a probe encode worked", JSON.stringify(doctorJson.gpu));
console.log("doctor gpu:", JSON.stringify(doctorJson.gpu));
// transcribe is the exception: it carries a fix hint whenever its
// optional engine is missing, even on a healthy ffmpeg install.
checkOk(Object.entries(doctorJson.tools).filter(([n]) => n !== "transcribe").every(([, t]) => !("fix" in t)), "doctor: no fix hint on ffmpeg tools when all are available", JSON.stringify(doctorJson.tools));
// fixForMissing is a pure function: a healthy machine has nothing
// missing, so the fix text is unit-tested directly instead of by
// breaking the local ffmpeg install.
checkOk(fixForMissing([]) === null && fixForMissing(null) === null, "doctor fix: empty/missing list returns null");
const fixFilter = fixForMissing(["filter:fps"]);
checkOk(typeof fixFilter === "string" && fixFilter.includes("fps") && fixFilter.includes("apt install ffmpeg"), "doctor fix: filter hint names the filter + the install command", fixFilter ?? "");
const fixEnc = fixForMissing(["encoder:libx264|aac"]);
checkOk(typeof fixEnc === "string" && fixEnc.includes("libx264|aac"), "doctor fix: encoder hint names the encoder group", fixEnc ?? "");
const fixMixed = fixForMissing(["filter:crop", "decoder:librsvg"]);
checkOk(typeof fixMixed === "string" && fixMixed.includes("filter:crop") && fixMixed.includes("decoder:librsvg"), "doctor fix: one hint covers all missing capabilities", fixMixed ?? "");
checkOk(doctorJson.sandbox?.enabled === false, "doctor: sandbox disabled when MEDIAKIT_WORKDIR is unset", JSON.stringify(doctorJson.sandbox));
// Turn 93: doctor --smoke runs a real render chain (generate ->
// trim -> loudness -> verify) and proves it on disk; without --smoke
// there is no smoke key at all.
checkOk(!("smoke" in doctorJson), "doctor without --smoke reports no smoke section", Object.keys(doctorJson).join(","));
const doctorSmokeRes = await client.callTool({ name: "doctor", arguments: { smoke: true } });
const doctorSmokeJson = JSON.parse(doctorSmokeRes.content[0].text);
const smokeSteps = doctorSmokeJson.smoke?.steps ?? [];
checkOk(doctorSmokeJson.ok === true && doctorSmokeJson.smoke?.ran === true && doctorSmokeJson.smoke?.ok === true, "doctor smoke:true runs the real chain and passes", JSON.stringify(doctorSmokeJson.smoke));
checkOk(smokeSteps.map((s) => s.name).join(",") === "generate,trim,loudness,verify" && smokeSteps.every((s) => s.ok === true && typeof s.seconds === "number" && s.seconds >= 0), "doctor smoke reports all 4 steps ok with timings", JSON.stringify(smokeSteps));
checkOk(/-14/.test(smokeSteps.find((s) => s.name === "loudness")?.detail ?? ""), "doctor smoke loudness step measured -14 LUFS", JSON.stringify(smokeSteps));
checkOk(typeof doctorSmokeJson.smoke?.seconds === "number" && doctorSmokeJson.smoke.seconds > 0, "doctor smoke reports total seconds", JSON.stringify(doctorSmokeJson.smoke));

// Audit log / operation envelope (lượt 55): every tool call above
// was recorded into the hermetic audit file — the log must prove it
// with hashes that match the files on disk, not just claim it.
// (sha256File is defined earlier in this file; reused here.)
async function runCliJson(args, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "bin/mediakit.js"), ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
// Turn 93: the same smoke through the CLI flag.
const doctorSmokeCli = await runCliJson(["doctor", "--smoke"]);
checkOk(doctorSmokeCli.ok === true && doctorSmokeCli.smoke?.ran === true && doctorSmokeCli.smoke?.ok === true && doctorSmokeCli.smoke.steps?.length === 4 && doctorSmokeCli.smoke.steps.every((s) => s.ok === true), "CLI doctor --smoke runs the real chain and passes", JSON.stringify(doctorSmokeCli.smoke));

// Turn 94: init_project scaffolds a runnable video project — a
// film.json that already validates, a measured 3s placeholder voice,
// captions, an assets/ layout and a CLAUDE.md with the lifecycle.
const initDir = path.join(root, "outputs/mcp-init-project");
await rm(initDir, { recursive: true, force: true });
const initRes = await client.callTool({ name: "init_project", arguments: { dir: initDir, title: "Init Test Film", brand: "amber-teal" } });
const initJson = JSON.parse(initRes.content[0].text);
checkOk(initJson.operation === "init_project" && initJson.preset === "vertical" && initJson.brand === "amber-teal" && initJson.title === "Init Test Film" && initJson.total_seconds === 4 && initJson.total_frames === 120, "init_project scaffolds a vertical 4s/120-frame project with the brand", JSON.stringify(initJson).slice(0, 300));
const initFilm = JSON.parse(await readFile(path.join(initDir, "film.json"), "utf8"));
checkOk(initFilm.version === 1 && initFilm.preset === "vertical" && initFilm.brand === "amber-teal" && initFilm.voice.path === "assets/voice.wav" && initFilm.voice.lead === 0.5 && initFilm.voice.tail === 0.5 && initFilm.shots.length === 2 && initFilm.shots[0].template === "title-card" && initFilm.shots[1].template === "rings" && initFilm.shots[0].duration === 2 && initFilm.shots[1].duration === 2, "init_project film.json has the preset, brand, placeholder voice and two 2s template shots", JSON.stringify(initFilm.shots));
// The scaffold's own voice measures exactly 3s on disk, and the
// scaffold validates through assemble — the timeline math is real,
// not assumed from the template.
const initVoiceProbe = await probeStreams(path.join(initDir, "assets/voice.wav"));
checkOk(near(parseFloat(initVoiceProbe.format?.duration), 3, 0.05) && initVoiceProbe.streams?.some((s) => s.codec_type === "audio"), "init_project placeholder voice is exactly 3s of audio on disk", JSON.stringify(initVoiceProbe.format));
const initValidate = await runCliJson(["assemble", path.join(initDir, "film.json"), "--mode", "validate"]);
checkOk(initValidate.mode === "validate" && initValidate.total_seconds === 4 && initValidate.total_frames === 120 && initValidate.voice?.duration_seconds === 3 && initValidate.captions?.cue_count === 2, "the scaffolded film validates through assemble (4s/120 frames, 3s voice, 2 caption cues)", JSON.stringify({ total_seconds: initValidate.total_seconds, voice: initValidate.voice, captions: initValidate.captions }));
const initClaude = await readFile(path.join(initDir, "CLAUDE.md"), "utf8");
checkOk(/PLACEHOLDER voice/.test(initClaude) && /validate → diagnose → preview → approve → render → verify → verify-cuts/.test(initClaude) && /Do not approve your own checks/.test(initClaude), "init_project CLAUDE.md names the placeholder voice and the full lifecycle", initClaude.split("\n").slice(0, 8).join(" | "));
// Turn 133: the scaffold also writes style.json — the starter
// channel pace (10 cuts/min, longest hold 12s) diagnose scores the
// film against — and CLAUDE.md says how to measure a real one.
const initStyle = JSON.parse(await readFile(path.join(initDir, "style.json"), "utf8"));
checkOk(initStyle.version === 1 && initStyle.name === "default" && initStyle.pace.cuts_per_min === 10 && initStyle.pace.longest_hold_s === 12 && initStyle.pace.source === "default" && initJson.style === path.join(initDir, "style.json") && initJson.created.length === 5, "init_project scaffolds style.json with the starter pace (10 cuts/min, hold 12s) and lists it in created", JSON.stringify(initStyle.pace));
checkOk(/style\.json/.test(initClaude) && /measure-pace/.test(initClaude), "init_project CLAUDE.md names style.json and how to measure a real pace into it", initClaude.split("\n").filter((l) => /style\.json/.test(l)).join(" | "));
// A second init refuses to clobber the project; force replaces it.
const initAgain = await callExpectThrow("init_project", { dir: initDir, title: "Second" });
checkOk(/refuses to overwrite/.test(initAgain) && /film\.json/.test(initAgain), "init_project refuses a second scaffold without force", initAgain.slice(0, 200));
const initForceRes = await client.callTool({ name: "init_project", arguments: { dir: initDir, title: "Forced Film", force: true } });
checkOk(JSON.parse(initForceRes.content[0].text).title === "Forced Film", "init_project force:true replaces the scaffold", initForceRes.content[0].text.slice(0, 200));
// Bad ids fail here with the same message assemble would give
// (brand is a plain string, so it reaches core; preset is a zod
// enum, so the MCP client rejects it first — both wordings count).
const initBadPreset = await callExpectThrow("init_project", { dir: path.join(root, "outputs/mcp-init-bad-preset"), preset: "nope" });
checkOk(/preset must be one of|Invalid enum/i.test(initBadPreset), "init_project refuses an unknown preset", initBadPreset.slice(0, 200));
const initBadPresetCli = await runCli(["init", path.join(root, "outputs/mcp-init-bad-preset"), "--preset", "nope"], {});
checkOk(initBadPresetCli.code !== 0 && /preset must be one of/.test(initBadPresetCli.out), "CLI init refuses an unknown preset with the core message", initBadPresetCli.out.slice(0, 200));
const initBadBrand = await callExpectThrow("init_project", { dir: path.join(root, "outputs/mcp-init-bad-brand"), brand: "nope" });
checkOk(/must be one of/.test(initBadBrand) && /amber-teal/.test(initBadBrand), "init_project refuses an unknown brand", initBadBrand.slice(0, 200));
// The same scaffold through the CLI.
const initCliDir = path.join(root, "outputs/mcp-init-cli");
await rm(initCliDir, { recursive: true, force: true });
const initCli = await runCliJson(["init", initCliDir, "--title", "CLI Film", "--preset", "square"]);
checkOk(initCli.operation === "init_project" && initCli.preset === "square" && initCli.title === "CLI Film" && existsSync(path.join(initCliDir, "film.json")) && existsSync(path.join(initCliDir, "CLAUDE.md")), "CLI init scaffolds the project (square preset)", JSON.stringify(initCli).slice(0, 200));
const initCliRefuse = await runCli(["init", initCliDir], {});
checkOk(initCliRefuse.code !== 0 && /refuses to overwrite/.test(initCliRefuse.out), "CLI init refuses a second scaffold without --force", initCliRefuse.out.slice(0, 200));

// Turn 94: check --faststart — moov before mdat, measured by a
// pure-Node box walk (no ffmpeg call).
await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", path.join(root, "test/silence-source.mp4"), "-c", "copy", "-movflags", "+faststart", path.join(root, "outputs/mcp-faststart.mp4")]);
const fsPassRes = await client.callTool({ name: "check", arguments: { input: path.join(root, "outputs/mcp-faststart.mp4"), platform: "tiktok", faststart: true } });
const fsPassJson = JSON.parse(fsPassRes.content[0].text);
const fsPassRule = fsPassJson.checks.find((c) => c.name === "faststart");
checkOk(fsPassRule?.pass === true && /moov at \d+ \(before mdat\)/.test(fsPassRule.actual), "check faststart:true passes on a +faststart file (moov before mdat)", JSON.stringify(fsPassRule));
const fsFailRes = await client.callTool({ name: "check", arguments: { input: path.join(root, "test/silence-source.mp4"), platform: "tiktok", faststart: true } });
const fsFailRule = JSON.parse(fsFailRes.content[0].text).checks.find((c) => c.name === "faststart");
checkOk(fsFailRule?.pass === false && /mdat at \d+ \(before moov\)/.test(fsFailRule.actual), "check faststart:true fails on a plain file (mdat before moov)", JSON.stringify(fsFailRule));
const fsMp3Res = await client.callTool({ name: "check", arguments: { input: path.join(root, "test/mix-voice.mp3"), platform: "tiktok", faststart: true } });
const fsMp3Rule = JSON.parse(fsMp3Res.content[0].text).checks.find((c) => c.name === "faststart");
checkOk(fsMp3Rule?.pass === false && /not an MP4/.test(fsMp3Rule.actual), "check faststart:true on an MP3 fails as not-an-MP4 instead of a misleading offset", JSON.stringify(fsMp3Rule));
const fsOffRes = await client.callTool({ name: "check", arguments: { input: path.join(root, "outputs/mcp-faststart.mp4"), platform: "tiktok" } });
checkOk(!JSON.parse(fsOffRes.content[0].text).checks.some((c) => c.name === "faststart"), "check without faststart adds no faststart rule", "");
const fsCli = await runCliJson(["check", path.join(root, "outputs/mcp-faststart.mp4"), "--platform", "tiktok", "--faststart"]);
checkOk(fsCli.checks.find((c) => c.name === "faststart")?.pass === true, "CLI check --faststart passes on the +faststart file", "");

// Turn 98: check --decoded-work — decoded-work ceiling (MADPANDA
// media_limits idea + EncodeX safety envelope: estimate the work
// before committing to it). Unit tests use synthetic probe-shaped
// metas — a real over-ceiling file (4K60 1h) cannot be a fixture.
const dwUnitOk = estimateDecodedWork({ duration_seconds: 10, video: { display_width: 1280, display_height: 720, width: 1280, height: 720, fps: 30 }, audio: { channels: 1, sample_rate: 44100 } });
checkOk(dwUnitOk.video_pixel_frames === 276480000 && dwUnitOk.audio_sample_channels === 441000 && dwUnitOk.over_ceiling === false && dwUnitOk.violations.length === 0, "estimateDecodedWork: 720p30 10s = 276.48M pixel-frames, no violations", JSON.stringify(dwUnitOk));
const dwUnitBig = estimateDecodedWork({ duration_seconds: 3600, video: { display_width: 3840, display_height: 2160, width: 3840, height: 2160, fps: 60 }, audio: { channels: 2, sample_rate: 48000 } });
checkOk(dwUnitBig.video_pixel_frames === 1791590400000 && dwUnitBig.over_ceiling === true && dwUnitBig.violations.length === 1 && /pixel-frames 1.79T exceeds 250.00B/.test(dwUnitBig.violations[0]), "estimateDecodedWork: 4K60 1h = 1.79T pixel-frames, over ceiling with one violation", JSON.stringify(dwUnitBig.violations));
const dwUnitLimits = estimateDecodedWork({ duration_seconds: 10, video: { display_width: 9000, display_height: 100, width: 9000, height: 100, fps: 240 }, audio: { channels: 16, sample_rate: 384000 } });
checkOk(dwUnitLimits.over_ceiling === true && dwUnitLimits.violations.length === 4 && dwUnitLimits.violations.some((v) => /geometry 9000x100/.test(v)) && dwUnitLimits.violations.some((v) => /fps 240/.test(v)) && dwUnitLimits.violations.some((v) => /channels 16/.test(v)) && dwUnitLimits.violations.some((v) => /sample rate 384000/.test(v)), "estimateDecodedWork: per-stream limits each report their own violation (geometry/fps/channels/sample-rate)", JSON.stringify(dwUnitLimits.violations));
const dwUnitDuration = estimateDecodedWork({ duration_seconds: 7200, video: { display_width: 1280, display_height: 720, width: 1280, height: 720, fps: 30 }, audio: { channels: 2, sample_rate: 48000 } });
checkOk(dwUnitDuration.over_ceiling === true && dwUnitDuration.violations.length === 1 && /duration 7200s exceeds 3600s/.test(dwUnitDuration.violations[0]), "estimateDecodedWork: a 2h clip violates only the duration limit (199B pixel-frames stays under)", JSON.stringify(dwUnitDuration.violations));
const dwUnitAudio = estimateDecodedWork({ duration_seconds: 10, video: null, audio: { channels: 2, sample_rate: 48000 } });
checkOk(dwUnitAudio.video_pixel_frames === null && dwUnitAudio.audio_sample_channels === 960000 && dwUnitAudio.over_ceiling === false, "estimateDecodedWork: audio-only file has null video work and 960K sample-channels", JSON.stringify(dwUnitAudio));
// MCP: the real fixture measures the same numbers as the unit case.
const dwMcpRes = await client.callTool({ name: "check", arguments: { input: path.join(root, "test/source.mp4"), platform: "tiktok", decoded_work: true } });
const dwMcpJson = JSON.parse(dwMcpRes.content[0].text);
const dwMcpRule = dwMcpJson.checks.find((c) => c.name === "decoded_work");
checkOk(dwMcpRule?.pass === true && dwMcpRule?.severity === "warn" && /276.48M pixel-frames/.test(dwMcpRule.actual) && dwMcpJson.decoded_work?.video_pixel_frames === 276480000 && dwMcpJson.decoded_work?.over_ceiling === false, "check decoded_work:true passes on the 720p30 fixture (276.48M pixel-frames, warn severity)", JSON.stringify(dwMcpRule));
checkOk(!dwMcpJson.warnings?.some((w) => w.startsWith("decoded_work")), "a passing decoded_work rule does not appear in warnings", JSON.stringify(dwMcpJson.warnings));
const dwOffRes = await client.callTool({ name: "check", arguments: { input: path.join(root, "test/source.mp4"), platform: "tiktok" } });
const dwOffJson = JSON.parse(dwOffRes.content[0].text);
checkOk(!dwOffJson.checks.some((c) => c.name === "decoded_work") && !("decoded_work" in dwOffJson), "check without decoded_work adds no rule and no detail", "");
const dwCli = await runCliJson(["check", path.join(root, "test/source.mp4"), "--platform", "tiktok", "--decoded-work"]);
checkOk(dwCli.checks.find((c) => c.name === "decoded_work")?.pass === true && dwCli.decoded_work?.audio_sample_channels === 441000, "CLI check --decoded-work passes on the fixture with the same numbers", "");
const dwDocRes = await client.callTool({ name: "doctor", arguments: {} });
const dwDocJson = JSON.parse(dwDocRes.content[0].text);
checkOk(dwDocJson.decoded_work_limits?.max_video_pixel_frames === 250000000000 && dwDocJson.decoded_work_limits?.max_audio_sample_channels === 6000000000 && dwDocJson.decoded_work_limits?.max_duration_seconds === 3600, "doctor reports the decoded-work ceilings", JSON.stringify(dwDocJson.decoded_work_limits));
// Lượt 99: admission gate + ffmpeg timeout are doctor-visible too
// (defaults 2 active / 10 starts per minute, 300000 ms — the suite
// sets neither env, so the defaults are what the asserts pin).
checkOk(dwDocJson.job_admission_limits?.max_active_jobs === 2 && dwDocJson.job_admission_limits?.max_starts_per_minute === 10 && dwDocJson.ffmpeg_timeout_ms === 300_000, "doctor reports the job admission limits + ffmpeg timeout", JSON.stringify({ job_admission_limits: dwDocJson.job_admission_limits, ffmpeg_timeout_ms: dwDocJson.ffmpeg_timeout_ms }));

// Turn 94: writability pre-check — /proc is read-only even for
// root, so a probe write there fails on any Linux box with /proc
// mounted. If the probe write unexpectedly succeeds here, skip
// instead of failing the suite on a machine without a read-only /proc.
const roProbe = path.join("/proc/1", `.mediakit-ro-test-${process.pid}`);
let roFsWritable = false;
try { await writeFile(roProbe, "x"); await rm(roProbe, { force: true }); roFsWritable = true; } catch { roFsWritable = false; }
if (!roFsWritable) {
  const roTrim = await runCli(["trim", path.join(root, "test/source.mp4"), "--start", "0", "--duration", "1", "-o", "/proc/1/mediakit-ro-out.mp4"], {});
  checkOk(roTrim.code !== 0 && /not writable/.test(roTrim.out), "trim into /proc fails fast with 'not writable' before ffmpeg runs", roTrim.out.slice(0, 200));
} else {
  console.log("SKIP writability-probe assert: /proc/1 is writable here");
}
const auditPath = process.env.MEDIAKIT_AUDIT_PATH;
checkOk(doctorJson.audit?.enabled === true && doctorJson.audit?.path === auditPath && doctorJson.audit?.entries > 0, "doctor: audit enabled, path is the hermetic test file, entries > 0", JSON.stringify(doctorJson.audit));
const auditAllRes = await client.callTool({ name: "audit", arguments: { limit: 200 } });
const auditAll = JSON.parse(auditAllRes.content[0].text);
checkOk(auditAll.audit_path === auditPath && auditAll.total >= 10 && Array.isArray(auditAll.entries) && auditAll.entries.length > 0, "audit: log reads back with path + total + newest-first entries", `total=${auditAll.total} entries=${auditAll.entries.length}`);
checkOk(auditAll.entries.every((e) => e.id && e.tool && e.via && typeof e.duration_ms === "number" && e.status && /^[0-9a-f]{64}$/.test(e.args_sha256 ?? "")), "audit: every entry has id/tool/via/duration/status + a 64-hex args hash", JSON.stringify(auditAll.entries[0]).slice(0, 300));
// The first trim is found through the --tool filter, not the newest-200
// window: the suite grows every round (lượt 127 added ~24 calls), so
// the unfiltered window eventually evicts the oldest entries and the
// lookup fails for a reason that has nothing to do with auditing.
const auditTrimRes = await client.callTool({ name: "audit", arguments: { tool: "trim", limit: 200 } });
const auditTrimAll = JSON.parse(auditTrimRes.content[0].text);
const auditTrim = auditTrimAll.entries.find((e) => e.tool === "trim" && e.status === "ok" && e.files?.some((f) => f.path.endsWith("outputs/mcp-trim.mp4")));
checkOk(!!auditTrim, "audit: the suite's first trim call is in the log with status ok", `found=${!!auditTrim}`);
if (auditTrim) {
  const trimIn = auditTrim.files.find((f) => f.role === "input");
  const trimOut = auditTrim.files.find((f) => f.role === "output");
  checkOk(trimIn?.sha256 === await sha256File(path.join(root, "test/source.mp4")), "audit: trim entry's input SHA-256 matches test/source.mp4 on disk", `recorded=${trimIn?.sha256?.slice(0, 12)}`);
  checkOk(trimOut?.sha256 === await sha256File(path.join(root, "outputs/mcp-trim.mp4")), "audit: trim entry's output SHA-256 matches outputs/mcp-trim.mp4 on disk", `recorded=${trimOut?.sha256?.slice(0, 12)}`);
}
// verify:true re-hashes on disk — untouched files match.
const auditVerifyRes = await client.callTool({ name: "audit", arguments: { tool: "trim", status: "ok", verify: true, limit: 3 } });
const auditVerify = JSON.parse(auditVerifyRes.content[0].text);
checkOk(auditVerify.entries.length > 0 && auditVerify.entries.every((e) => e.verified === true), "audit --verify: untouched recorded files all match", JSON.stringify(auditVerify.entries.map((e) => e.verified)));
const auditProbeRes = await client.callTool({ name: "audit", arguments: { tool: "probe", limit: 1 } });
const auditProbe = JSON.parse(auditProbeRes.content[0].text);
checkOk(auditProbe.entries.length === 1 && auditProbe.entries[0].tool === "probe", "audit: --tool probe returns only probe entries", `got ${auditProbe.entries.length} entries`);
// The CLI records too, and verify catches a tampered output (the
// LeClap verify idea: the log is a claim, the disk is the evidence).
const cliAuditEnv = { MEDIAKIT_AUDIT_PATH: auditPath };
const cliTrimOut = path.join(root, "outputs/mcp-audit-trim.mp4");
await runCliJson(["trim", path.join(root, "test/source.mp4"), "--start", "0", "--duration", "1", "-o", cliTrimOut], cliAuditEnv);
await writeFile(cliTrimOut, Buffer.from([0]), { flag: "a" });
const cliAuditVerify = await runCliJson(["audit", "--tool", "trim", "--status", "ok", "--verify", "--limit", "1"], cliAuditEnv);
const tampered = cliAuditVerify.entries[0];
checkOk(tampered?.verified === false && tampered.file_checks?.some((c) => c.state === "changed" && c.path === cliTrimOut), "audit --verify (CLI): a tampered output is reported changed, entry verified=false", JSON.stringify(tampered?.file_checks));
const cliAuditList = await runCliJson(["audit", "--limit", "3"], cliAuditEnv);
checkOk(Array.isArray(cliAuditList.entries) && cliAuditList.entries.length >= 1 && cliAuditList.audit_path === auditPath, "audit (CLI): --limit returns newest-first entries from the same log", `entries=${cliAuditList.entries.length}`);
// Opt-out: MEDIAKIT_AUDIT=0 records nothing.
const auditCountBefore = (await readFile(auditPath, "utf8")).split("\n").filter(Boolean).length;
await runCliJson(["probe", path.join(root, "test/source.mp4")], { MEDIAKIT_AUDIT_PATH: auditPath, MEDIAKIT_AUDIT: "0" });
const auditCountAfter = (await readFile(auditPath, "utf8")).split("\n").filter(Boolean).length;
checkOk(auditCountAfter === auditCountBefore, "audit: MEDIAKIT_AUDIT=0 records nothing", `before=${auditCountBefore} after=${auditCountAfter}`);

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
// Join fades (lượt 49): every kept segment gets a 12ms fade out +
// 15ms fade in at the join, so a cut mid-tone has no click. The
// default margin (0.2s) hides the join inside source silence, so
// this runs with margin 0 — the join lands exactly on the tone /
// silence boundary, where an unfaded cut jumps phase. Measured on
// raw samples, not from the tool's report: the 10ms windows next
// to the join must sit well below the steady tone, and the biggest
// sample-to-sample jump at the join must be far below a normal
// in-tone jump.
const silenceFadeRes = await client.callTool({
  name: "silence",
  arguments: {
    input: path.join(root, "test/silence-source.mp4"),
    output: path.join(root, "outputs/mcp-silence-fade.mp4"),
    threshold_db: -40,
    min_duration: 0.5,
    margin: 0,
  },
});
const silenceFadeJson = JSON.parse(silenceFadeRes.content[0].text);
checkOk(near(silenceFadeJson.duration_after, 6.067, 0.05), "silence margin 0 cuts 9s to 6.067s", `got ${silenceFadeJson.duration_after}`);
const fadeJoin = silenceFadeJson.kept_segments?.[0]?.duration;
const fadePcm = await pcmSamples(path.join(root, "outputs/mcp-silence-fade.mp4"));
checkOk(typeof fadeJoin === "number" && fadePcm !== null && fadePcm.length > 44100 * 6, "silence margin-0 join time + PCM decode available for the fade check", `join=${fadeJoin} samples=${fadePcm?.length}`);
if (typeof fadeJoin === "number" && fadePcm) {
  const steadyBefore = windowRmsDb(fadePcm, fadeJoin - 0.11, fadeJoin - 0.1);
  const steadyAfter = windowRmsDb(fadePcm, fadeJoin + 0.1, fadeJoin + 0.11);
  const last10 = windowRmsDb(fadePcm, fadeJoin - 0.01, fadeJoin);
  const first10 = windowRmsDb(fadePcm, fadeJoin, fadeJoin + 0.01);
  const jump = maxSampleJump(fadePcm, fadeJoin - 0.005, fadeJoin + 0.005);
  const toneJump = maxSampleJump(fadePcm, fadeJoin + 0.1, fadeJoin + 0.11);
  console.log(`join fade: last 10ms ${last10?.toFixed(1)} dBFS (steady ${steadyBefore?.toFixed(1)}), first 10ms ${first10?.toFixed(1)} dBFS (steady ${steadyAfter?.toFixed(1)}), max jump at join ${jump.toFixed(3)} vs in-tone ${toneJump.toFixed(3)}`);
  // The fade-out drop is build-sensitive: the AAC encoder's
  // windowing smears the 12ms fade differently per build — local
  // 8.1.2 measures 12.5 dB, the CI apt ffmpeg 6.7 dB (CI run 1 of
  // lượt 101 failed the old 8 dB line; a linear 12ms fade is ~6.4 dB
  // in theory, so 8 dB was above the floor a correct fade can give).
  // 4 dB still separates a real fade (≥6.4 in theory) from no fade
  // at all (~0 dB) and from a halved fade (~2 dB), so the assert
  // keeps its meaning while tolerating the encoder.
  checkOk(last10 !== null && steadyBefore !== null && last10 < steadyBefore - 4, "silence join: 12ms fade-out pulls the last 10ms >=4 dB under the steady tone", `last10=${last10} steady=${steadyBefore}`);
  checkOk(first10 !== null && steadyAfter !== null && first10 < steadyAfter - 4, "silence join: 15ms fade-in pulls the first 10ms >=4 dB under the steady tone", `first10=${first10} steady=${steadyAfter}`);
  // Same story for the jump cap: local 0.010, CI exactly 0.020 on
  // the old <0.02 line. 0.03 stays below half the in-tone jump, so
  // a real click (tone-scale) still fails both caps.
  checkOk(jump < 0.03 && jump < toneJump * 0.5, "silence join: max sample jump at the join is under 0.03 and under half the in-tone jump (no click)", `jump=${jump.toFixed(3)} tone=${toneJump.toFixed(3)}`);
}

// silence --dry-run (lượt 108): the silencedetect plan is read-only,
// so the printed command is the exact command the real run executes.
const silenceDryRes = await client.callTool({
  name: "silence",
  arguments: { input: path.join(root, "test/silence-source.mp4"), output: path.join(root, "outputs/mcp-silence-dry.mp4"), dry_run: true },
});
const silenceDryJson = JSON.parse(silenceDryRes.content[0].text);
console.log("silence dry-run:", JSON.stringify({ removed: silenceDryJson.removed_seconds, segments: silenceDryJson.kept_segments?.length }));
checkOk(silenceDryJson.dry_run === true && near(silenceDryJson.removed_seconds, 2.195, 0.05) && silenceDryJson.duration_after === null, "silence dry-run reports the same 2.195s plan, duration_after null", JSON.stringify({ removed: silenceDryJson.removed_seconds, after: silenceDryJson.duration_after }));
checkOk(silenceDryJson.commands?.length === 1 && silenceDryJson.commands[0].includes("trim=start=0:end=2.202") && silenceDryJson.commands[0].includes("concat=n=3"), "silence dry-run prints the exact trim+concat command", silenceDryJson.commands?.[0]?.slice(0, 200) ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-silence-dry.mp4")), "silence dry-run writes no file", "outputs/mcp-silence-dry.mp4");
const silenceDryCli = await runCliJson(["silence", path.join(root, "test/silence-source.mp4"), "-o", path.join(root, "outputs/mcp-silence-cli-dry.mp4"), "--dry-run"]);
checkOk(silenceDryCli.dry_run === true && silenceDryCli.commands?.[0]?.includes("trim=start=0:end=2.202") && !existsSync(path.join(root, "outputs/mcp-silence-cli-dry.mp4")), "CLI silence --dry-run prints the command and writes no file", JSON.stringify(silenceDryCli.commands));
// silence dry-run on a file with nothing to cut: the command is a
// stream-copy, same as the real run.
const silenceCopyDryRes = await client.callTool({
  name: "silence",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-silence-copy-dry.mp4"), dry_run: true },
});
const silenceCopyDryJson = JSON.parse(silenceCopyDryRes.content[0].text);
checkOk(silenceCopyDryJson.dry_run === true && silenceCopyDryJson.stream_copy === true && silenceCopyDryJson.commands?.[0]?.includes("-c copy"), "silence dry-run with nothing to cut prints the stream-copy command", JSON.stringify(silenceCopyDryJson.commands));
checkOk(!existsSync(path.join(root, "outputs/mcp-silence-copy-dry.mp4")), "silence copy dry-run writes no file", "outputs/mcp-silence-copy-dry.mp4");

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

// mix --sfx: a beep at 3s (the voice is silent there, [2,4)) must be
// audible in the mix, while the window just before it matches the
// no-sfx mix (no leak, no shift).
const mixSfxRes = await client.callTool({
  name: "mix",
  arguments: {
    voice: path.join(root, "test/mix-voice.mp3"),
    music: path.join(root, "test/mix-music.mp3"),
    output: path.join(root, "outputs/mcp-mix-sfx.mp3"),
    music_volume: 0.5,
    duck_db: 12,
    sfx: [{ file: path.join(root, "test/sfx-beep.mp3"), at_seconds: 3, volume: 1 }],
  },
});
const mixSfxJson = JSON.parse(mixSfxRes.content[0].text);
console.log("mix sfx call: sfx_count", mixSfxJson.sfx_count, "| LUFS", mixSfxJson.output_lufs, "| dur", mixSfxJson.duration_seconds);
checkOk(mixSfxJson.sfx_count === 1 && mixSfxJson.sfx?.[0]?.at_seconds === 3, "mix sfx echoes the placed sound", JSON.stringify(mixSfxJson.sfx));
checkOk(near(mixSfxJson.output_lufs, -14, 0.5), "mix with sfx still masters to -14 LUFS", `got ${mixSfxJson.output_lufs}`);
const sfxWin = await meanVolume(path.join(root, "outputs/mcp-mix-sfx.mp3"), 3, 0.5);
const noSfxWin = await meanVolume(path.join(root, "outputs/mcp-mix.mp3"), 3, 0.5);
const sfxCtl = await meanVolume(path.join(root, "outputs/mcp-mix-sfx.mp3"), 2.2, 0.5);
const noSfxCtl = await meanVolume(path.join(root, "outputs/mcp-mix.mp3"), 2.2, 0.5);
console.log("mix sfx window [3,3.5): with sfx", sfxWin, "dB | without", noSfxWin, "dB | control [2.2,2.7):", sfxCtl, "vs", noSfxCtl);
checkOk(typeof sfxWin === "number" && typeof noSfxWin === "number" && sfxWin - noSfxWin > 5, "mix sfx is actually audible (+5 dB in its window)", `with ${sfxWin} vs without ${noSfxWin}`);
checkOk(typeof sfxCtl === "number" && Math.abs(sfxCtl - noSfxCtl) < 2, "mix sfx does not leak into the window before it", `${sfxCtl} vs ${noSfxCtl}`);

const mixSfxBadRes = await client.callTool({
  name: "mix",
  arguments: {
    voice: path.join(root, "test/mix-voice.mp3"),
    music: path.join(root, "test/mix-music.mp3"),
    output: path.join(root, "outputs/mcp-mix-sfx-bad.mp3"),
    sfx: [{ file: path.join(root, "test/sfx-beep.mp3"), at_seconds: 99, volume: 1 }],
  },
});
const mixSfxBadJson = JSON.parse(mixSfxBadRes.content[0].text);
checkOk(mixSfxBadRes.isError === true && /past the voice end/.test(mixSfxBadJson.error ?? ""), "mix sfx past the voice end is refused", JSON.stringify(mixSfxBadJson));

// mix two-pass mastering (lượt 44): a quiet voice (-34.6 LUFS, long
// gaps) under a loud bed made single-pass loudnorm undershoot (-14.8
// LUFS vs -14 target). Two-pass must land on target — m4a hits it
// exactly, mp3 within tolerance — and report two_pass + no warning,
// with the unmastered temp file cleaned up.
const mixQuietM4a = path.join(root, "outputs/mcp-mix-quiet.m4a");
const mixQuietRes = await client.callTool({
  name: "mix",
  arguments: {
    voice: path.join(root, "test/quiet-voice.mp3"),
    music: path.join(root, "test/mix-music.mp3"),
    output: mixQuietM4a,
    music_volume: 1,
    duck_db: 18,
  },
});
const mixQuietJson = JSON.parse(mixQuietRes.content[0].text);
console.log("mix quiet voice: output LUFS", mixQuietJson.output_lufs, "| two_pass", mixQuietJson.two_pass, "| warning", mixQuietJson.warning ?? "(none)");
checkOk(mixQuietJson.two_pass === true, "mix masters two-pass (measured values applied)", JSON.stringify(mixQuietJson).slice(0, 200));
checkOk(near(mixQuietJson.output_lufs, -14, 0.5), "mix quiet voice + loud bed masters to -14 LUFS", `got ${mixQuietJson.output_lufs}`);
checkOk(mixQuietJson.warning === undefined, "mix quiet voice reports no off-target warning", JSON.stringify(mixQuietJson.warning));
checkOk(existsSync(path.join(root, "outputs/mcp-mix-quiet.unmastered.m4a")) === false, "mix deletes its unmastered temp file", "unmastered file left behind");
const mixQuietMp3Res = await client.callTool({
  name: "mix",
  arguments: {
    voice: path.join(root, "test/quiet-voice.mp3"),
    music: path.join(root, "test/mix-music.mp3"),
    output: path.join(root, "outputs/mcp-mix-quiet.mp3"),
    music_volume: 1,
    duck_db: 18,
  },
});
const mixQuietMp3Json = JSON.parse(mixQuietMp3Res.content[0].text);
console.log("mix quiet voice mp3: output LUFS", mixQuietMp3Json.output_lufs);
checkOk(near(mixQuietMp3Json.output_lufs, -14, 0.5), "mix quiet voice + loud bed masters to -14 LUFS as mp3", `got ${mixQuietMp3Json.output_lufs}`);

// mix real speech (lượt 44, label-reuse bug): Kokoro voice has ~19 dB
// crest (-25.6 LUFS, TP -6.28). The old graph reused the [voice]
// label for both the sidechain and the amix, so the amix branch
// silently got the UNGAINED voice and the mix measured -25.8 LUFS;
// the master then could not lift it to -14 under the true-peak cap
// (landed -15.0). A tone fixture cannot catch this — its tiny crest
// lets the master lift it anyway — so this real-speech fixture is
// the regression guard: with the bug it measures -15.0 (fail), fixed
// it lands -14.1.
const mixKokoroRes = await client.callTool({
  name: "mix",
  arguments: {
    voice: path.join(root, "test/kokoro-voice.wav"),
    music: path.join(root, "test/mix-music.mp3"),
    output: path.join(root, "outputs/mcp-mix-kokoro.m4a"),
    music_volume: 0.3,
    duck_db: 12,
  },
});
const mixKokoroJson = JSON.parse(mixKokoroRes.content[0].text);
console.log("mix kokoro voice: output LUFS", mixKokoroJson.output_lufs, "| two_pass", mixKokoroJson.two_pass, "| warning", mixKokoroJson.warning ?? "(none)");
checkOk(mixKokoroJson.two_pass === true, "mix kokoro voice masters two-pass", JSON.stringify(mixKokoroJson).slice(0, 200));
checkOk(near(mixKokoroJson.output_lufs, -14, 0.5), "mix real speech masters to -14 LUFS (label-reuse regression)", `got ${mixKokoroJson.output_lufs}`);
checkOk(mixKokoroJson.warning === undefined, "mix kokoro voice reports no off-target warning", JSON.stringify(mixKokoroJson.warning));

// convert --gop-seconds: 10s source at 30fps, GOP 2s -> keyframes at
// 0,2,4,6,8, measured twice (the tool's own report + the keyframes
// tool run independently on the output file).
const convertGopRes = await client.callTool({
  name: "convert",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-convert-gop.mp4"),
    video_codec: "libx264",
    gop_seconds: 2,
  },
});
const convertGopJson = JSON.parse(convertGopRes.content[0].text);
console.log("convert gop call: gop_frames", convertGopJson.gop_frames, "| keyframes", JSON.stringify(convertGopJson.keyframes));
checkOk(convertGopJson.gop_frames === 60 && convertGopJson.keyframes?.count === 5, "convert --gop-seconds 2 reports 60 frames / 5 keyframes", JSON.stringify(convertGopJson.keyframes));
checkOk(convertGopJson.keyframes?.min_gap_seconds === 2 && convertGopJson.keyframes?.max_gap_seconds === 2, "convert gop gaps are exactly 2s", JSON.stringify(convertGopJson.keyframes));
const gopKfRes = await client.callTool({
  name: "keyframes",
  arguments: { input: path.join(root, "outputs/mcp-convert-gop.mp4") },
});
const gopKfJson = JSON.parse(gopKfRes.content[0].text);
checkOk(gopKfJson.keyframe_timestamps.join(",") === "0,2,4,6,8", "keyframes tool confirms [0,2,4,6,8] on the gop output", gopKfJson.keyframe_timestamps.join(","));

const convertGopCopyRes = await client.callTool({
  name: "convert",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-convert-gop-copy.mp4"),
    gop_seconds: 2,
  },
});
const convertGopCopyJson = JSON.parse(convertGopCopyRes.content[0].text);
checkOk(convertGopCopyRes.isError === true && /needs a video re-encode/.test(convertGopCopyJson.error ?? ""), "convert --gop with stream-copy is refused", JSON.stringify(convertGopCopyJson));

const convertGopBothRes = await client.callTool({
  name: "convert",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-convert-gop-both.mp4"),
    video_codec: "libx264",
    gop: 60,
    gop_seconds: 2,
  },
});
const convertGopBothJson = JSON.parse(convertGopBothRes.content[0].text);
checkOk(convertGopBothRes.isError === true && /mutually exclusive/.test(convertGopBothJson.error ?? ""), "convert --gop + --gop-seconds is refused", JSON.stringify(convertGopBothJson));

// convert --encoder (lượt 104, podcli's hardware-encode-with-fallback
// idea — but the fallback is reported, never silent): this VM has no
// working GPU encoder, so auto must fall back to software libx264 AND
// say so, and the output codec must still verify as h264 on disk.
const convertEncAutoRes = await client.callTool({
  name: "convert",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-convert-enc-auto.mp4"),
    video_codec: "libx264",
    encoder: "auto",
  },
});
const convertEncAutoJson = JSON.parse(convertEncAutoRes.content[0].text);
console.log("convert encoder auto:", JSON.stringify({ requested: convertEncAutoJson.encoder_requested, used: convertEncAutoJson.encoder_used, fallback: convertEncAutoJson.encoder_fallback, verified: convertEncAutoJson.codec_verified }));
checkOk(convertEncAutoJson.encoder_requested === "auto" && convertEncAutoJson.encoder_used === "libx264" && convertEncAutoJson.encoder_fallback === true, "convert --encoder auto falls back to libx264 on a GPU-less machine and reports it", JSON.stringify(convertEncAutoJson).slice(0, 300));
checkOk(convertEncAutoJson.codec_verified === true && convertEncAutoJson.codec_name === "h264" && near(convertEncAutoJson.duration_seconds, 10, 0.15), "convert --encoder auto output verifies as h264 / 10s on disk", JSON.stringify(convertEncAutoJson).slice(0, 300));
checkOk(typeof convertEncAutoJson.encoder_fallback_reason === "string" && /no working hardware encoder/.test(convertEncAutoJson.encoder_fallback_reason), "convert --encoder auto names the fallback reason", convertEncAutoJson.encoder_fallback_reason ?? "");

// An explicitly requested hardware encoder must fail, not silently
// fall back to software — that is the rule from lượt 90/95.
const convertEncNvencRes = await client.callTool({
  name: "convert",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-convert-enc-nvenc.mp4"),
    video_codec: "libx264",
    encoder: "h264_nvenc",
  },
});
const convertEncNvencJson = JSON.parse(convertEncNvencRes.content[0].text);
checkOk(convertEncNvencRes.isError === true && /not usable/.test(convertEncNvencJson.error ?? ""), "convert --encoder h264_nvenc fails on a GPU-less machine instead of silently falling back", JSON.stringify(convertEncNvencJson));
checkOk(!existsSync(path.join(root, "outputs/mcp-convert-enc-nvenc.mp4")), "failed explicit-encoder convert writes no output file", "mcp-convert-enc-nvenc.mp4 exists");

const convertEncBadText = await callExpectThrow("convert", {
  input: path.join(root, "test/source.mp4"),
  output: path.join(root, "outputs/mcp-convert-enc-bad.mp4"),
  video_codec: "libx264",
  encoder: "h264_fakegpu",
});
checkOk(/Invalid enum value/.test(convertEncBadText) && /h264_fakegpu/.test(convertEncBadText), "convert --encoder with an unknown name is refused at schema validation (core also rejects it: CLI prints 'unsupported hardware encoder')", convertEncBadText.slice(0, 300));
const convertEncBadCli = await runCli(["convert", path.join(root, "test/source.mp4"), "-o", path.join(root, "outputs/mcp-convert-enc-bad-cli.mp4"), "--video-codec", "libx264", "--encoder", "h264_fakegpu"], {});
checkOk(convertEncBadCli.code !== 0 && /unsupported hardware encoder/.test(convertEncBadCli.out), "CLI convert --encoder with an unknown name prints the core message", convertEncBadCli.out.slice(0, 300));

const convertEncMismatchRes = await client.callTool({
  name: "convert",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-convert-enc-mismatch.mp4"),
    video_codec: "libx265",
    encoder: "h264_nvenc",
  },
});
const convertEncMismatchJson = JSON.parse(convertEncMismatchRes.content[0].text);
checkOk(convertEncMismatchRes.isError === true && /encodes h264, not hevc/.test(convertEncMismatchJson.error ?? ""), "convert --encoder refuses a family mismatch (h264 encoder, hevc codec)", JSON.stringify(convertEncMismatchJson));

const convertEncCopyRes = await client.callTool({
  name: "convert",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-convert-enc-copy.mp4"),
    encoder: "auto",
  },
});
const convertEncCopyJson = JSON.parse(convertEncCopyRes.content[0].text);
checkOk(convertEncCopyRes.isError === true && /needs a video re-encode/.test(convertEncCopyJson.error ?? ""), "convert --encoder with stream-copy is refused", JSON.stringify(convertEncCopyJson));

const convertEncMpeg4Res = await client.callTool({
  name: "convert",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-convert-enc-mpeg4.mp4"),
    video_codec: "mpeg4",
    encoder: "auto",
  },
});
const convertEncMpeg4Json = JSON.parse(convertEncMpeg4Res.content[0].text);
checkOk(convertEncMpeg4Res.isError === true && /no hardware encoder for codec mpeg4/.test(convertEncMpeg4Json.error ?? ""), "convert --encoder auto refuses mpeg4 (no hardware encoder for it)", JSON.stringify(convertEncMpeg4Json));

// CLI: the same auto fallback through the command line, plus a
// dry-run that shows the resolved software command.
const convertEncCliJson = await runCliJson(["convert", path.join(root, "test/source.mp4"), "-o", path.join(root, "outputs/mcp-convert-enc-cli.mp4"), "--video-codec", "libx264", "--encoder", "auto"]);
checkOk(convertEncCliJson.encoder_used === "libx264" && convertEncCliJson.encoder_fallback === true && convertEncCliJson.codec_verified === true, "CLI convert --encoder auto falls back and verifies", JSON.stringify(convertEncCliJson).slice(0, 300));
const convertEncDryJson = await runCliJson(["convert", path.join(root, "test/source.mp4"), "-o", path.join(root, "outputs/mcp-convert-enc-dry.mp4"), "--video-codec", "libx264", "--encoder", "auto", "--dry-run"]);
checkOk(convertEncDryJson.encoder_fallback === true && convertEncDryJson.commands[0].includes("-c:v libx264") && !existsSync(path.join(root, "outputs/mcp-convert-enc-dry.mp4")), "CLI convert --encoder auto --dry-run prints the fallback command and writes no file", convertEncDryJson.commands?.[0] ?? "");

// Batch + manifest pass-through: encoder rides the same args list as
// the other convert options, so both must see the fallback result.
await rm(path.join(root, "outputs/mcp-batch-enc-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-enc-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-enc-in"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-enc-in/source.mp4"));
const batchEncRes = await client.callTool({
  name: "batch",
  arguments: { operation: "convert", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-enc-in"), output_dir: path.join(root, "outputs/mcp-batch-enc-out"), args: { video_codec: "libx264", encoder: "auto" } },
});
const batchEncJson = JSON.parse(batchEncRes.content[0].text);
checkOk(batchEncJson.succeeded === 1 && batchEncJson.results[0].result?.encoder_fallback === true && batchEncJson.results[0].result?.codec_verified === true, "batch convert --encoder auto reports the fallback in its row result", JSON.stringify(batchEncJson.results.map((r) => r.result?.encoder_fallback)));
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const encManifestPath = path.join(root, "outputs/mcp-manifest-enc.json");
await writeFile(encManifestPath, JSON.stringify({ version: 1, input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-manifest-enc.mp4"), steps: [{ tool: "convert", args: { video_codec: "libx264", encoder: "auto" } }] }), "utf8");
const encManifestRes = await client.callTool({ name: "manifest", arguments: { manifest_path: encManifestPath } });
const encManifestJson = JSON.parse(encManifestRes.content[0].text);
checkOk(encManifestJson.steps_run === 1 && encManifestJson.steps[0].status === "ok" && encManifestJson.steps[0].result?.encoder_fallback === true && encManifestJson.steps[0].result?.codec_verified === true && near(encManifestJson.final.duration_seconds, 10, 0.15), "manifest convert step with encoder auto runs and reports the fallback (final 10s)", JSON.stringify(encManifestJson.steps.map((s) => s.result?.encoder_fallback)));

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

// extract_frames (turn 115): the full sequence, not N samples —
// herdiansah/ffmpeg-mcp-server's convert_video_to_images idea, but
// probe-first with the count verified on disk. test/source.mp4 is
// 10s at 30fps, so fps=2 writes exactly 20 files.
const seqRes = await client.callTool({
  name: "extract_frames",
  arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-extract-frames"), fps: 2, format: "png" },
});
const seqJson = JSON.parse(seqRes.content[0].text);
console.log("extract_frames call:", seqJson.frame_count, "/", seqJson.frame_count_expected, "| first", seqJson.first_timestamp_seconds, "| last", seqJson.last_timestamp_seconds);
checkOk(seqJson.frame_count === 20 && seqJson.frame_count_expected === 20 && seqJson.frames_verified === true && seqJson.count_diff === 0 && seqJson.first_timestamp_seconds === 0 && seqJson.last_timestamp_seconds === 9.5, "extract_frames fps=2 on a 10s clip writes exactly 20 frames, verified, timestamps 0..9.5", JSON.stringify({ frame_count: seqJson.frame_count, expected: seqJson.frame_count_expected, verified: seqJson.frames_verified }));
// Independent: the files on disk are really there, in order.
const seqFiles = (await readdir(path.join(root, "outputs/mcp-extract-frames"))).sort();
checkOk(seqFiles.length === 20 && seqFiles[0] === "frame-0001.png" && seqFiles[19] === "frame-0020.png", "extract_frames files on disk: frame-0001.png..frame-0020.png", seqFiles.join(","));
// Default fps is the source rate (30): range 2-3s writes 30 frames.
const seqRangeRes = await client.callTool({
  name: "extract_frames",
  arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-extract-frames-range"), start: 2, end: 3 },
});
const seqRangeJson = JSON.parse(seqRangeRes.content[0].text);
checkOk(seqRangeJson.fps === 30 && seqRangeJson.frame_count === 30 && seqRangeJson.frames_verified === true && seqRangeJson.first_timestamp_seconds === 2 && seqRangeJson.last_timestamp_seconds === 2.967, "extract_frames defaults to source fps (30) on range 2-3s: 30 frames, timestamps 2..2.967", JSON.stringify({ fps: seqRangeJson.fps, frame_count: seqRangeJson.frame_count, first: seqRangeJson.first_timestamp_seconds, last: seqRangeJson.last_timestamp_seconds }));
// jpg with quality, and webp with quality + width (the webp path
// needs the image2 muxer + libwebp or it writes one corrupt file).
const seqJpgRes = await client.callTool({
  name: "extract_frames",
  arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-extract-frames-jpg"), fps: 2, format: "jpg", quality: 80 },
});
const seqJpgJson = JSON.parse(seqJpgRes.content[0].text);
checkOk(seqJpgJson.frame_count === 20 && seqJpgJson.frames_verified === true && seqJpgJson.frames_sample?.[0]?.file === "frame-0001.jpg", "extract_frames jpg quality 80 writes 20 verified .jpg frames", JSON.stringify({ frame_count: seqJpgJson.frame_count, first: seqJpgJson.frames_sample?.[0]?.file }));
const seqWebpRes = await client.callTool({
  name: "extract_frames",
  arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-extract-frames-webp"), fps: 2, format: "webp", quality: 90, width: 320 },
});
const seqWebpJson = JSON.parse(seqWebpRes.content[0].text);
checkOk(seqWebpJson.frame_count === 20 && seqWebpJson.frames_verified === true, "extract_frames webp quality 90 width 320 writes 20 verified frames", JSON.stringify({ frame_count: seqWebpJson.frame_count, verified: seqWebpJson.frames_verified }));
const seqWebpDims = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv", path.join(root, "outputs/mcp-extract-frames-webp/frame-0001.webp")]);
checkOk(/320,180/.test(seqWebpDims.stdout), "extract_frames webp frame decodes 320x180 (image2 muxer, not animated-webp)", seqWebpDims.stdout.trim());
// dry-run prints the exact command and writes nothing; the printed
// command run by hand must produce a byte-identical first frame.
// Clear the dir first: the hand-run below creates it, so a re-run
// would otherwise see the leftover and fail the "writes nothing"
// half of this check.
await rm(path.join(root, "outputs/mcp-extract-frames-dry"), { recursive: true, force: true });
const seqDryRes = await client.callTool({
  name: "extract_frames",
  arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-extract-frames-dry"), fps: 2, dry_run: true },
});
const seqDryJson = JSON.parse(seqDryRes.content[0].text);
checkOk(seqDryJson.dry_run === true && seqDryJson.frames === null && seqDryJson.frame_count === null && /fps=2/.test(seqDryJson.command ?? "") && /frame-%04d\.png/.test(seqDryJson.command ?? "") && /rgba/.test(seqDryJson.command ?? "") && !existsSync(path.join(root, "outputs/mcp-extract-frames-dry")), "extract_frames dry-run prints the exact command (fps filter + rgba + pattern) and writes nothing", seqDryJson.command ?? "");
// ffmpeg's image2 muxer does not create the output directory — the
// real run does that via prepareOutputDir, so a hand-run needs the
// dir to exist first (same as running any printed ffmpeg command
// whose output folder is new).
await mkdir(path.join(root, "outputs/mcp-extract-frames-dry"), { recursive: true });
await execFileAsync("bash", ["-c", seqDryJson.command]);
const seqDrySha = await sha256File(path.join(root, "outputs/mcp-extract-frames-dry/frame-0001.png"));
const seqRealSha = await sha256File(path.join(root, "outputs/mcp-extract-frames/frame-0001.png"));
checkOk(seqDrySha === seqRealSha, "extract_frames dry-run command run by hand produces a byte-identical first frame", `${seqDrySha.slice(0, 12)} vs ${seqRealSha.slice(0, 12)}`);
// The 5000-frame ceiling: a 60s clip at 120fps would write 7200.
await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=60", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-y", path.join(root, "outputs/mcp-extract-frames-long60.mp4")]);
const seqCapRes = await client.callTool({
  name: "extract_frames",
  arguments: { input: path.join(root, "outputs/mcp-extract-frames-long60.mp4"), output_dir: path.join(root, "outputs/mcp-extract-frames-cap"), fps: 120 },
});
const seqCapJson = JSON.parse(seqCapRes.content[0].text);
checkOk(seqCapRes.isError === true && /7200 frames/.test(seqCapJson.error ?? "") && /limit 5000/.test(seqCapJson.error ?? "") && !existsSync(path.join(root, "outputs/mcp-extract-frames-cap")), "extract_frames refuses 7200 frames (60s at 120fps) over the 5000 cap before writing anything", JSON.stringify(seqCapJson));
// quality is refused for png, and audio-only input is refused.
const seqQRes = await client.callTool({
  name: "extract_frames",
  arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-extract-frames-q"), fps: 2, quality: 80 },
});
const seqQJson = JSON.parse(seqQRes.content[0].text);
checkOk(seqQRes.isError === true && /quality only applies to jpg\/webp/.test(seqQJson.error ?? ""), "extract_frames refuses quality with png (lossless)", JSON.stringify(seqQJson));
const seqAudioRes = await client.callTool({
  name: "extract_frames",
  arguments: { input: path.join(root, "test/silence-audio.mp3"), output_dir: path.join(root, "outputs/mcp-extract-frames-audio"), fps: 2 },
});
const seqAudioJson = JSON.parse(seqAudioRes.content[0].text);
checkOk(seqAudioRes.isError === true && /needs a video input/.test(seqAudioJson.error ?? ""), "extract_frames refuses an audio-only input", JSON.stringify(seqAudioJson));

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

// scenes --detector content: hue/sat/luma split scoring. Fixture
// test/scenes-hue.mp4 is red 5s -> dark green 5s (same luma): the
// ffmpeg metric sees nothing, the content detector scores 0.183.
// scenes-flash.mp4 is red with 1 white frame at 5s: both cuts of the
// blip must be dropped by the flash filter. scenes-rapid.mp4 cuts
// every 8 frames: min_scene_len 15 keeps every other cut (9), min 1
// keeps all 19. scenes-fade.mp4 fades in 0-1s and out 6-7s.
const scenesContentRes = await client.callTool({
  name: "scenes",
  arguments: { input: path.join(root, "test/scenes-hue.mp4"), detector: "content" },
});
const scenesContentJson = JSON.parse(scenesContentRes.content[0].text);
console.log("scenes content hue call: count", scenesContentJson.count, "| changes", scenesContentJson.scene_changes.join(","), "| candidates", scenesContentJson.candidates);
checkOk(scenesContentJson.detector === "content" && scenesContentJson.threshold === 0.05 && scenesContentJson.count === 1 && near(scenesContentJson.scene_changes[0], 5, 0.05) && scenesContentJson.candidates === 1, "scenes content finds the hue-only cut at 5s (default threshold 0.05)", JSON.stringify(scenesContentJson.scene_changes));
const scenesHueFfmpegRes = await client.callTool({
  name: "scenes",
  arguments: { input: path.join(root, "test/scenes-hue.mp4") },
});
const scenesHueFfmpegJson = JSON.parse(scenesHueFfmpegRes.content[0].text);
checkOk(scenesHueFfmpegJson.detector === "ffmpeg" && scenesHueFfmpegJson.threshold === 0.3 && scenesHueFfmpegJson.count === 0, "scenes ffmpeg misses the hue-only cut (luma-driven metric)", JSON.stringify(scenesHueFfmpegJson.scene_changes));

// measure_pace (lượt 133, idea: marvtub/takes-public measure_pace):
// the 20s fixture is 4x5s colour blocks by construction, so the
// measured pace is exact — 3 cuts, 9/min, avg 5s, longest 5s at 0s.
// With --style-file the numbers are kept in the style.json; a
// second run keeps the file's other keys and only replaces pace.
const paceRes = await client.callTool({
  name: "measure_pace",
  arguments: { input: path.join(root, "test/pace-source.mp4") },
});
const paceJson = JSON.parse(paceRes.content[0].text);
checkOk(paceJson.operation === "measure_pace" && paceJson.detector === "content" && paceJson.seconds === 20 && paceJson.cuts === 3 && paceJson.cuts_per_min === 9 && paceJson.avg_shot_s === 5 && paceJson.longest_hold_s === 5 && paceJson.longest_at === 0 && paceJson.too_short_to_compare === false && paceJson.style_written === undefined, "measure_pace on the 4x5s fixture is 3 cuts, 9/min, avg 5s, longest 5s at 0s (content detector by default), and writes nothing without --style-file", JSON.stringify(paceJson));
const paceStylePath = path.join(root, "outputs/mcp-pace-style.json");
await rm(paceStylePath, { force: true });
const paceStyleRes = await client.callTool({
  name: "measure_pace",
  arguments: { input: path.join(root, "test/pace-source.mp4"), style_file: paceStylePath, style_name: "warm-story" },
});
const paceStyleJson = JSON.parse(paceStyleRes.content[0].text);
checkOk(paceStyleJson.style_written === true && paceStyleJson.style_file === paceStylePath && paceStyleJson.style_name === "warm-story", "measure_pace --style-file reports the written style file and name", JSON.stringify({ style_written: paceStyleJson.style_written, style_file: paceStyleJson.style_file }));
const paceStyleDoc = JSON.parse(await readFile(paceStylePath, "utf8"));
checkOk(paceStyleDoc.version === 1 && paceStyleDoc.name === "warm-story" && paceStyleDoc.pace.cuts_per_min === 9 && paceStyleDoc.pace.longest_hold_s === 5 && paceStyleDoc.pace.avg_shot_s === 5 && paceStyleDoc.pace.source === "pace-source.mp4" && typeof paceStyleDoc.pace.measured === "string", "the written style.json keeps the measured pace (9/min, hold 5s) with source + measured stamp", JSON.stringify(paceStyleDoc.pace));
// Other keys survive a re-measure: the pace block is replaced,
// the rest of the file is kept.
paceStyleDoc.notes = "keep me";
await writeFile(paceStylePath, JSON.stringify(paceStyleDoc, null, 2), "utf8");
const paceStyleRes2 = await client.callTool({
  name: "measure_pace",
  arguments: { input: path.join(root, "test/pace-source.mp4"), style_file: paceStylePath },
});
const paceStyleDoc2 = JSON.parse(await readFile(paceStylePath, "utf8"));
checkOk(JSON.parse(paceStyleRes2.content[0].text).style_name === "mcp-pace-style" && paceStyleDoc2.notes === "keep me" && paceStyleDoc2.pace.cuts_per_min === 9, "re-measuring into the same style file keeps other keys and defaults the name to the file stem", JSON.stringify({ name: paceStyleDoc2.name, notes: paceStyleDoc2.notes }));
const paceShortRes = await client.callTool({
  name: "measure_pace",
  arguments: { input: path.join(root, "test/scenes-source.mp4") },
});
const paceShortJson = JSON.parse(paceShortRes.content[0].text);
checkOk(paceShortJson.cuts === 1 && paceShortJson.too_short_to_compare === true && /under 15s/.test(paceShortJson.note ?? ""), "measure_pace still measures a 10s file (1 cut) but says it is too short to compare a style against", JSON.stringify({ cuts: paceShortJson.cuts, too_short: paceShortJson.too_short_to_compare }));
const paceMissing = await callExpectThrow("measure_pace", { input: path.join(root, "test/no-such-video.mp4") });
checkOk(/not found|no such file/i.test(paceMissing), "measure_pace on a missing file fails loudly", paceMissing.slice(0, 200));
const paceCli = await runCliJson(["measure-pace", path.join(root, "test/pace-source.mp4")]);
checkOk(paceCli.cuts === 3 && paceCli.cuts_per_min === 9 && paceCli.longest_hold_s === 5, "CLI measure-pace reports the same 3 cuts / 9 per minute / 5s hold", JSON.stringify(paceCli));
const scenesFlashRes = await client.callTool({
  name: "scenes",
  arguments: { input: path.join(root, "test/scenes-flash.mp4"), detector: "content" },
});
const scenesFlashJson = JSON.parse(scenesFlashRes.content[0].text);
console.log("scenes content flash call: count", scenesFlashJson.count, "| filtered", JSON.stringify(scenesFlashJson.filtered));
checkOk(scenesFlashJson.count === 0 && scenesFlashJson.candidates === 2 && scenesFlashJson.filtered.flash === 2, "scenes content flash filter drops both cuts of a 1-frame white blip", JSON.stringify(scenesFlashJson));
const scenesRapidRes = await client.callTool({
  name: "scenes",
  arguments: { input: path.join(root, "test/scenes-rapid.mp4"), detector: "content" },
});
const scenesRapidJson = JSON.parse(scenesRapidRes.content[0].text);
console.log("scenes content rapid call: count", scenesRapidJson.count, "| filtered", JSON.stringify(scenesRapidJson.filtered));
checkOk(scenesRapidJson.count === 9 && scenesRapidJson.candidates === 19 && scenesRapidJson.filtered.min_scene_len === 10 && near(scenesRapidJson.scene_changes[0], 0.533, 0.05) && near(scenesRapidJson.scene_changes[8], 4.8, 0.05), "scenes content min_scene_len 15 keeps every other 8-frame cut (9 of 19)", JSON.stringify(scenesRapidJson.scene_changes));
const scenesRapid1Res = await client.callTool({
  name: "scenes",
  arguments: { input: path.join(root, "test/scenes-rapid.mp4"), detector: "content", min_scene_len: 1 },
});
const scenesRapid1Json = JSON.parse(scenesRapid1Res.content[0].text);
checkOk(scenesRapid1Json.count === 19 && scenesRapid1Json.filtered.min_scene_len === 0, "scenes content min_scene_len 1 keeps all 19 rapid cuts", `got ${scenesRapid1Json.count}`);
const scenesFadeRes = await client.callTool({
  name: "scenes",
  arguments: { input: path.join(root, "test/scenes-fade.mp4"), detector: "content", fades: true },
});
const scenesFadeJson = JSON.parse(scenesFadeRes.content[0].text);
console.log("scenes fades call:", JSON.stringify(scenesFadeJson.fades));
checkOk(scenesFadeJson.count === 0 && scenesFadeJson.fades.length === 2 && scenesFadeJson.fades[0].type === "in" && near(scenesFadeJson.fades[0].start, 0, 0.01) && near(scenesFadeJson.fades[0].end, 1.033, 0.05) && near(scenesFadeJson.fades[0].dark_end, 0.1, 0.05) && scenesFadeJson.fades[1].type === "out" && near(scenesFadeJson.fades[1].start, 6, 0.05) && near(scenesFadeJson.fades[1].end, 7, 0.01) && near(scenesFadeJson.fades[1].dark_start, 6.933, 0.05), "scenes fades finds fade-in 0-1.03s (dark core 0-0.1) and fade-out 6-7s (dark core 6.93-7)", JSON.stringify(scenesFadeJson.fades));
const scenesFadeFfmpegRes = await client.callTool({
  name: "scenes",
  arguments: { input: path.join(root, "test/scenes-fade.mp4"), fades: true },
});
const scenesFadeFfmpegJson = JSON.parse(scenesFadeFfmpegRes.content[0].text);
checkOk(scenesFadeFfmpegJson.detector === "ffmpeg" && scenesFadeFfmpegJson.fades.length === 2, "scenes fades also works with the ffmpeg detector", JSON.stringify(scenesFadeFfmpegJson.fades));
const scenesBadDetectorText = await callExpectThrow("scenes", { input: path.join(root, "test/scenes-source.mp4"), detector: "bogus" });
checkOk(scenesBadDetectorText.includes("Invalid enum value") && scenesBadDetectorText.includes("content"), "scenes rejects an unknown detector at schema validation (core also rejects it: CLI prints 'detector must be')", scenesBadDetectorText.slice(0, 160));

// motion: per-second changed-pixel fraction. testsrc moves steadily
// (~0.06), the frozen stretch of content-freeze is exactly 0.0000,
// a static clip is 0 everywhere — the verdict must tell them apart.
const motionRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/source.mp4") },
});
const motionJson = JSON.parse(motionRes.content[0].text);
console.log("motion call:", motionJson.verdict, "| energy", motionJson.motion_energy, "| curve", motionJson.motion_curve.map((w) => w.motion_fraction).join(","));
checkOk(motionJson.verdict === "moving" && motionJson.motion_energy > 0.05 && motionJson.motion_energy < 0.08 && motionJson.still_intervals.length === 0 && motionJson.motion_curve.length === 10 && motionJson.frames_analyzed === 299, "motion: testsrc is moving (energy ~0.06, 10 windows, no still)", `energy=${motionJson.motion_energy} verdict=${motionJson.verdict}`);
const motionFreezeRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/content-freeze.mp4") },
});
const motionFreezeJson = JSON.parse(motionFreezeRes.content[0].text);
console.log("motion freeze call:", motionFreezeJson.verdict, "| still", JSON.stringify(motionFreezeJson.still_intervals), "| moving_fraction", motionFreezeJson.moving_fraction);
checkOk(motionFreezeJson.verdict === "mostly-static" && motionFreezeJson.still_intervals.length === 1 && motionFreezeJson.still_intervals[0].start_seconds === 5 && motionFreezeJson.still_intervals[0].end_seconds === 7 && near(motionFreezeJson.motion_curve[5].motion_fraction, 0, 0.0001) && near(motionFreezeJson.motion_curve[6].motion_fraction, 0, 0.0001) && motionFreezeJson.moving_fraction === 0.8, "motion: frozen stretch [5,7] is one still interval, moving_fraction 0.8", JSON.stringify(motionFreezeJson.still_intervals));
const motionStaticRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/static-clip.mp4") },
});
const motionStaticJson = JSON.parse(motionStaticRes.content[0].text);
console.log("motion static call:", motionStaticJson.verdict, "| energy", motionStaticJson.motion_energy, "| still", JSON.stringify(motionStaticJson.still_intervals));
checkOk(motionStaticJson.verdict === "static" && motionStaticJson.motion_energy === 0 && motionStaticJson.still_intervals.length === 1 && motionStaticJson.still_intervals[0].duration_seconds === 3 && motionStaticJson.frames_analyzed === 89, "motion: static clip is static (energy 0, still [0,3])", `energy=${motionStaticJson.motion_energy} verdict=${motionStaticJson.verdict}`);
const motionHighThRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/source.mp4"), threshold: 0.1 },
});
const motionHighThJson = JSON.parse(motionHighThRes.content[0].text);
checkOk(motionHighThJson.verdict === "static" && motionHighThJson.still_intervals.length === 1 && motionHighThJson.still_intervals[0].duration_seconds === 10, "motion: threshold 0.1 turns testsrc static (threshold honored)", `verdict=${motionHighThJson.verdict}`);
const motionAudioOnly = await callExpectThrow("motion", { input: path.join(root, "test/mix-voice.mp3") });
checkOk(/needs a video input/.test(motionAudioOnly), "motion refuses audio-only input", motionAudioOnly.slice(0, 120));

// hook: best opening window from measured energy + speech + cuts +
// motion. Fixture test/hook-source.mp4 is 30s: quiet red [0,15) then
// loud blue [15,30) with the cut at 15s, so the 10s hook must open on
// the cut — [15,25) scores ~0.75 while a quiet window scores ~0.14.
// Score is 0.35*energy + 0.25*speech + 0.2*cut + 0.2*motion (audio
// 0.6 / video 0.4); the clip is static, so motion is only the
// one-frame cut spike (0.05 mean over the window). The energy curve
// must also show the step: loud bins ~20 dB above the quiet ones
// (checked independently with volumedetect below). The trim is NOT
// snapped on this fixture: the window is uniformly loud, so there is
// no quiet moment in its last 5s.
const hookRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/hook-source.mp4"), duration: 10, step: 0.5, top: 3 },
});
const hookJson = JSON.parse(hookRes.content[0].text);
console.log("hook call:", JSON.stringify(hookJson.hook), "| candidates", hookJson.candidates.map((c) => `${c.start}-${c.end}:${c.score}`).join(" "), "| pacing", hookJson.pacing);
checkOk(hookJson.hook.start === 15 && hookJson.hook.end === 25 && hookJson.hook.starts_near_cut === true && hookJson.hook.cuts_inside === 1 && near(hookJson.hook.score, 0.754, 0.01) && near(hookJson.hook.motion, 0.05, 0.01), "hook opens on the loud cut at 15s (score ~0.75, motion 0.05 = the cut-frame spike only)", JSON.stringify(hookJson.hook));
checkOk(hookJson.candidates.length === 3 && hookJson.candidates[0].score > hookJson.candidates[1].score && hookJson.candidates[1].score > hookJson.candidates[2].score && hookJson.candidates[2].score < 0.25, "hook ranks 3 non-overlapping windows, quiet last (<0.25)", JSON.stringify(hookJson.candidates.map((c) => c.score)));
checkOk(near(hookJson.speech_coverage, 0.5, 0.02) && hookJson.pacing === "slow" && hookJson.cuts_per_minute === 2 && hookJson.energy_curve.length === 61, "hook reports speech 0.5, pacing slow (2 cuts/min), 61 curve bins", `speech=${hookJson.speech_coverage} pacing=${hookJson.pacing} bins=${hookJson.energy_curve.length}`);
checkOk(hookJson.trim.start === 15 && hookJson.trim.end === 25 && hookJson.trim.snapped === false && /no quiet moment/.test(hookJson.trim.reason ?? ""), "hook keeps the raw end on a uniformly loud window (trim not snapped, reason recorded)", JSON.stringify(hookJson.trim));
checkOk(typeof hookJson.suggested_trim === "string" && hookJson.suggested_trim.includes("--start 15 --end 25"), "hook suggests a trim command for the winning window", hookJson.suggested_trim);
// Independent check of the energy step: the winning window really
// is ~20 dB louder than the quiet half (not just the tool's word).
const hookLoudVol = await meanVolume(path.join(root, "test/hook-source.mp4"), 15, 10);
const hookQuietVol = await meanVolume(path.join(root, "test/hook-source.mp4"), 0, 10);
checkOk(hookLoudVol !== null && hookQuietVol !== null && hookLoudVol - hookQuietVol > 15, "hook window is really louder: volumedetect gap >15 dB", `loud=${hookLoudVol} quiet=${hookQuietVol}`);
// Audio-only: mix-voice has tone [0,2),[4,6),[7,9) — the 4s hook
// must land on the densest stretch (start 4 or 4.5, 3s of tone).
const hookAudioRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), duration: 4, step: 0.5, top: 2 },
});
const hookAudioJson = JSON.parse(hookAudioRes.content[0].text);
console.log("hook audio-only:", JSON.stringify(hookAudioJson.hook), "| speech_cov", hookAudioJson.speech_coverage);
checkOk((hookAudioJson.hook.start === 4 || hookAudioJson.hook.start === 4.5) && hookAudioJson.hook.speech >= 0.7 && hookAudioJson.hook.score > 0.4 && near(hookAudioJson.speech_coverage, 0.667, 0.02) && hookAudioJson.pacing === null, "hook on audio-only lands on the densest 4s (start 4/4.5, speech 0.667)", JSON.stringify(hookAudioJson.hook));
checkOk(hookAudioJson.trim.snapped === false && /below 4s/.test(hookAudioJson.trim.reason ?? ""), "hook refuses to snap a 4s window below its 4s floor (the silence at 6-7s stays uncut)", JSON.stringify(hookAudioJson.trim));
// Video-only: no audio to score — cuts + motion only, warning says
// so. Fixture test/content-video-only.mp4 is moving testsrc, so the
// score is 0.2 * motion (~1.0) with energy/speech 0, not the old 0.
const hookVideoRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/content-video-only.mp4"), duration: 4 },
});
const hookVideoJson = JSON.parse(hookVideoRes.content[0].text);
checkOk(hookVideoJson.warnings.some((w) => /no audio stream/.test(w)) && near(hookVideoJson.hook.score, 0.2, 0.01) && hookVideoJson.hook.motion > 0.9 && hookVideoJson.energy_curve.every((b) => b.energy === 0), "hook on video-only scores on motion (0.2, motion ~1.0) and warns about no audio", JSON.stringify(hookVideoJson.warnings));
// Short file: duration longer than the file -> whole file, warning.
const hookShortRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), duration: 15, top: 1 },
});
const hookShortJson = JSON.parse(hookShortRes.content[0].text);
checkOk(hookShortJson.hook.start === 0 && hookShortJson.hook.end === 9 && hookShortJson.warnings.some((w) => /shorter than --duration/.test(w)), "hook on a file shorter than --duration returns the whole file + warning", JSON.stringify(hookShortJson.hook));
checkOk(hookShortJson.trim.start === 0 && hookShortJson.trim.end === 9 && hookShortJson.trim.snapped === false && /whole file is the hook/.test(hookShortJson.trim.reason ?? ""), "a whole-file hook is never snapped (trim keeps the full 9s)", JSON.stringify(hookShortJson.trim));
const hookBadText = await callExpectThrow("hook", { input: path.join(root, "test/mix-voice.mp3"), duration: 25 });
checkOk(/less than or equal to 20/.test(hookBadText), "hook refuses --duration over 20", hookBadText.slice(0, 120));
// hook clip history (podcli's clip-history idea): record the winner
// once, never re-suggest it. Pure helpers first (no ffmpeg).
checkOk(hookOverlapSeconds({ start: 15, end: 25 }, { start: 20, end: 30 }) === 5, "hookOverlapSeconds: [15,25) vs [20,30) overlaps 5s", "5");
checkOk(hookOverlapSeconds({ start: 0, end: 10 }, { start: 10, end: 20 }) === 0, "hookOverlapSeconds: touching windows overlap 0s", "0");
const hookDupRecs = [{ source_sha256: "x", start: 15, end: 25, score: 0.9, recorded_at: "2026-01-01T00:00:00.000Z" }];
const hookDupHit = hookDuplicateOf({ start: 20, end: 30 }, hookDupRecs, 0.5);
checkOk(hookDupHit !== null && hookDupHit.overlap_seconds === 5 && hookDupHit.start === 15 && hookDupHit.end === 25, "hookDuplicateOf: 5/10 = 0.5 meets the default threshold", JSON.stringify(hookDupHit));
checkOk(hookDuplicateOf({ start: 20, end: 30 }, hookDupRecs, 0.6) === null, "hookDuplicateOf: 5/10 = 0.5 is below a 0.6 threshold", "null");
checkOk(hookDuplicateOf({ start: 0, end: 10 }, hookDupRecs, 0.5) === null, "hookDuplicateOf: a merely touching window is not a duplicate", "null");
// No history file: history null, every candidate fresh (not "unknown").
checkOk(hookJson.history === null && hookJson.candidates.every((c) => c.duplicate === false && c.duplicate_of === null), "hook without history_file: history null, all candidates fresh", JSON.stringify(hookJson.history));
const hookHistPath = path.join(root, "outputs", "hook-history.json");
await rm(hookHistPath, { force: true });
// Record the winner into a fresh file.
const hookRecRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/hook-source.mp4"), duration: 10, step: 0.5, top: 3, history_file: hookHistPath, record: true },
});
const hookRecJson = JSON.parse(hookRecRes.content[0].text);
checkOk(hookRecJson.history.recorded === true && hookRecJson.history.records_checked === 0 && hookRecJson.history.records_total === 1 && hookRecJson.hook.duplicate === false, "hook --record creates the history file with the winner [15,25)", JSON.stringify(hookRecJson.history));
const hookHistDoc = JSON.parse(await readFile(hookHistPath, "utf8"));
const hookSrcSha = createHash("sha256").update(await readFile(path.join(root, "test/hook-source.mp4"))).digest("hex");
checkOk(hookHistDoc.version === 1 && hookHistDoc.records.length === 1 && hookHistDoc.records[0].source_sha256 === hookSrcSha && hookHistDoc.records[0].start === 15 && hookHistDoc.records[0].end === 25 && hookHistDoc.records[0].score === 0.754 && typeof hookHistDoc.records[0].recorded_at === "string", "history file on disk: version 1, one record, sha/start/end/score match the winner", JSON.stringify(hookHistDoc.records[0]));
// Same file again: the winner is a duplicate, and --record does not
// append it a second time.
const hookDupRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/hook-source.mp4"), duration: 10, step: 0.5, top: 3, history_file: hookHistPath, record: true },
});
const hookDupJson = JSON.parse(hookDupRes.content[0].text);
checkOk(hookDupJson.hook.duplicate === true && hookDupJson.hook.duplicate_of.start === 15 && hookDupJson.hook.duplicate_of.end === 25 && hookDupJson.hook.duplicate_of.overlap_seconds === 10 && hookDupJson.history.records_checked === 1 && hookDupJson.history.duplicates_found === 1 && hookDupJson.history.recorded === false, "hook re-run flags the winner a duplicate (overlap 10s) and does not re-record it", JSON.stringify(hookDupJson.hook));
const hookHistDoc2 = JSON.parse(await readFile(hookHistPath, "utf8"));
checkOk(hookHistDoc2.records.length === 1, "history file still has exactly 1 record after the duplicate re-run", `records=${hookHistDoc2.records.length}`);
// The threshold moves the line: candidate 2 [9.5,19.5) overlaps the
// recorded [15,25) by 4.5s = 0.45 of the shorter window — fresh at
// the default 0.5, a duplicate at 0.4.
const hookThRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/hook-source.mp4"), duration: 10, step: 0.5, top: 3, history_file: hookHistPath, history_overlap: 0.4 },
});
const hookThJson = JSON.parse(hookThRes.content[0].text);
checkOk(hookThJson.candidates[1].start === 9.5 && hookThJson.candidates[1].duplicate === true && hookThJson.candidates[1].duplicate_of.overlap_seconds === 4.5, "history_overlap 0.4 flags the 4.5s-overlap candidate a duplicate", JSON.stringify(hookThJson.candidates[1]));
const hookThDefRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/hook-source.mp4"), duration: 10, step: 0.5, top: 3, history_file: hookHistPath },
});
const hookThDefJson = JSON.parse(hookThDefRes.content[0].text);
checkOk(hookThDefJson.candidates[1].duplicate === false, "default history_overlap 0.5 leaves the 4.5s-overlap candidate fresh", JSON.stringify(hookThDefJson.candidates[1]));
// A different source is never a duplicate of this file's record.
const hookOtherRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), duration: 4, step: 0.5, top: 2, history_file: hookHistPath },
});
const hookOtherJson = JSON.parse(hookOtherRes.content[0].text);
checkOk(hookOtherJson.history.records_checked === 0 && hookOtherJson.history.duplicates_found === 0 && hookOtherJson.candidates.every((c) => c.duplicate === false), "hook history only matches the same source sha256", JSON.stringify(hookOtherJson.history));
// record without a history file is refused; a corrupt or wrong-shape
// history file fails loudly instead of being silently ignored.
const hookRecNoFile = await callExpectThrow("hook", { input: path.join(root, "test/mix-voice.mp3"), duration: 4, record: true });
checkOk(/needs --history-file/.test(hookRecNoFile), "hook --record without --history-file is refused", hookRecNoFile.slice(0, 120));
const hookHistBadPath = path.join(root, "outputs", "hook-history-bad.json");
await writeFile(hookHistBadPath, "{not json", "utf8");
const hookBadHist = await callExpectThrow("hook", { input: path.join(root, "test/mix-voice.mp3"), duration: 4, history_file: hookHistBadPath });
checkOk(/not valid JSON/.test(hookBadHist), "hook refuses a corrupt history file", hookBadHist.slice(0, 120));
await writeFile(hookHistBadPath, JSON.stringify({ version: 2, records: [] }), "utf8");
const hookBadShape = await callExpectThrow("hook", { input: path.join(root, "test/mix-voice.mp3"), duration: 4, history_file: hookHistBadPath });
checkOk(/wrong shape/.test(hookBadShape), "hook refuses a history file with the wrong shape", hookBadShape.slice(0, 120));


// findQuietSnap is pure (no ffmpeg): the snap rules, unit-tested
// directly — dip found, no dip, all-quiet, floor guard, window.
const snapBins = (quietByT) => Object.entries(quietByT).map(([t, quiet]) => ({ t: +t, quiet })).sort((a, b) => a.t - b.t);
const snapDipBins = snapBins({ 0: 0.5, 0.5: 0.5, 1: 0.5, 1.5: 0.5, 2: 0.5, 2.5: 0.5, 3: 0.5, 3.5: 0.5, 4: 0.5, 4.5: 0.5, 5: 0.5, 5.5: 0.5, 6: 0.5, 6.5: 0.5, 7: 0, 7.5: 0, 8: 0, 8.5: 0, 9: 0, 9.5: 0 });
const snapDip = findQuietSnap({ bins: snapDipBins, start: 0, end: 10, snapWindowSeconds: 5, minDurationSeconds: 5 });
checkOk(snapDip.snapped === true && snapDip.end === 7 && snapDip.quietScore === 0, "findQuietSnap: snaps to the START of the quiet run (7, not the end of the silence)", JSON.stringify(snapDip));
const snapFlat = findQuietSnap({ bins: snapBins({ 0: 0.5, 0.5: 0.5, 1: 0.5, 1.5: 0.5, 2: 0.5, 2.5: 0.5, 3: 0.5, 3.5: 0.5, 4: 0.5, 4.5: 0.5, 5: 0.5, 5.5: 0.5, 6: 0.5, 6.5: 0.5, 7: 0.5, 7.5: 0.5, 8: 0.5, 8.5: 0.5, 9: 0.5, 9.5: 0.5 }), start: 0, end: 10, snapWindowSeconds: 5, minDurationSeconds: 5 });
checkOk(snapFlat.snapped === false && snapFlat.end === 10 && /no quiet moment/.test(snapFlat.reason ?? ""), "findQuietSnap: a uniformly busy window keeps its raw end", JSON.stringify(snapFlat));
const snapAllQuiet = findQuietSnap({ bins: snapBins({ 0: 0, 0.5: 0, 1: 0, 1.5: 0, 2: 0, 2.5: 0, 3: 0, 3.5: 0, 4: 0, 4.5: 0, 5: 0, 5.5: 0, 6: 0, 6.5: 0, 7: 0, 7.5: 0, 8: 0, 8.5: 0, 9: 0, 9.5: 0 }), start: 0, end: 10, snapWindowSeconds: 5, minDurationSeconds: 5 });
checkOk(snapAllQuiet.snapped === false && /whole window is quiet/.test(snapAllQuiet.reason ?? ""), "findQuietSnap: an all-quiet window has no dip to snap to", JSON.stringify(snapAllQuiet));
const snapFloor = findQuietSnap({ bins: snapDipBins, start: 0, end: 10, snapWindowSeconds: 5, minDurationSeconds: 8 });
checkOk(snapFloor.snapped === false && /below 8s/.test(snapFloor.reason ?? ""), "findQuietSnap: refuses to shorten the hook below the duration floor", JSON.stringify(snapFloor));
const snapOutOfWindow = findQuietSnap({ bins: snapBins({ 0: 0, 0.5: 0, 1: 0, 1.5: 0, 2: 0.5, 2.5: 0.5, 3: 0.5, 3.5: 0.5, 4: 0.5, 4.5: 0.5, 5: 0.5, 5.5: 0.5, 6: 0.5, 6.5: 0.5, 7: 0.5, 7.5: 0.5, 8: 0.5, 8.5: 0.5, 9: 0.5, 9.5: 0.5 }), start: 0, end: 10, snapWindowSeconds: 5, minDurationSeconds: 5 });
checkOk(snapOutOfWindow.snapped === false && /no quiet moment/.test(snapOutOfWindow.reason ?? ""), "findQuietSnap: a dip outside the search window does not snap", JSON.stringify(snapOutOfWindow));

// hook motion (shorts-maker-gpu's combined audio/video scoring):
// fixture test/hook-motion-source.mp4 is 30s, loud + static red
// [0,15) then quieter + moving testsrc2 [15,30), joined by a 1s
// crossfade so no scene cut fires at the join. The loud half is only
// slightly louder (energy 0.91 vs 1.0), so under the old weights the
// static half wins — with motion the winner must move into the
// moving half, with motion ~1.0 on the curve there and 0 before it.
const hookMotionRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/hook-motion-source.mp4"), duration: 10, step: 0.5, top: 3 },
});
const hookMotionJson = JSON.parse(hookMotionRes.content[0].text);
console.log("hook motion fixture:", JSON.stringify(hookMotionJson.hook), "| candidates", hookMotionJson.candidates.map((c) => `${c.start}-${c.end}:${c.score}`).join(" "));
const hookMotionCurve = hookMotionJson.energy_curve;
const hookMotionStatic = hookMotionCurve.filter((b) => b.t < 13).reduce((a, b) => a + b.motion, 0) / hookMotionCurve.filter((b) => b.t < 13).length;
const hookMotionMoving = hookMotionCurve.filter((b) => b.t >= 16).reduce((a, b) => a + b.motion, 0) / hookMotionCurve.filter((b) => b.t >= 16).length;
checkOk(hookMotionJson.hook.start >= 13.5 && hookMotionJson.hook.start <= 15.5 && hookMotionJson.hook.motion > 0.5 && hookMotionJson.hook.score > 0.6, "hook with motion wins in the moving half (start 13.5-15.5, motion > 0.5)", JSON.stringify(hookMotionJson.hook));
checkOk(hookMotionStatic < 0.05 && hookMotionMoving > 0.9, "hook motion curve shows the step: static half ~0, moving half ~1.0", `static=${hookMotionStatic.toFixed(3)} moving=${hookMotionMoving.toFixed(3)}`);
// The same measured bins under the OLD weights (0.5*energy +
// 0.3*speech + 0.2*cut, no motion): the loud static window [0,10)
// scores 0.8, the moving winner scores ~0.75 — the flip is the
// motion term, not a re-measurement. No cuts in the file, so the cut
// term is 0 on both sides.
const hookMotionMeanOver = (key, a, b) => { const v = hookMotionCurve.filter((x) => x.t >= a && x.t < b); return v.reduce((s, x) => s + x[key], 0) / v.length; };
const hookMotionOldStatic = 0.5 * hookMotionMeanOver("energy", 0, 10) + 0.3 * hookMotionMeanOver("speech", 0, 10);
const hookMotionOldWinner = 0.5 * hookMotionJson.hook.energy + 0.3 * hookMotionJson.hook.speech;
checkOk(hookMotionJson.cuts_per_minute === 0 && hookMotionOldStatic > hookMotionOldWinner, "old weights on the same bins score the static window higher (0.8 vs ~0.75) — the flip is motion", `old static=${hookMotionOldStatic.toFixed(3)} old winner=${hookMotionOldWinner.toFixed(3)}`);
// hook quiet snap (shorts-maker-gpu's find_smart_end_point):
// fixture test/hook-snap-source.mp4 is 30s, loud blue [15,22) then
// silence [22,30). The winning window is [14.5,24.5) but its tail
// is dead air — the trim must end at 22, where the quiet starts.
const hookSnapRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/hook-snap-source.mp4"), duration: 10, step: 0.5, top: 3 },
});
const hookSnapJson = JSON.parse(hookSnapRes.content[0].text);
console.log("hook snap fixture:", JSON.stringify(hookSnapJson.hook), "| trim", JSON.stringify(hookSnapJson.trim));
checkOk(hookSnapJson.hook.start === 14.5 && hookSnapJson.hook.end === 24.5 && hookSnapJson.trim.start === 14.5 && hookSnapJson.trim.end === 22 && hookSnapJson.trim.snapped === true && hookSnapJson.trim.quiet_score_at_snap === 0, "hook snaps the trim end 24.5 -> 22, where the silence starts", JSON.stringify(hookSnapJson.trim));
checkOk(hookSnapJson.suggested_trim.includes("--start 14.5 --end 22"), "suggested_trim uses the snapped end", hookSnapJson.suggested_trim);
// --no-snap-quiet keeps the raw window end on the same fixture.
const hookNoSnapRes = await client.callTool({
  name: "hook",
  arguments: { input: path.join(root, "test/hook-snap-source.mp4"), duration: 10, step: 0.5, top: 1, snap_quiet: false },
});
const hookNoSnapJson = JSON.parse(hookNoSnapRes.content[0].text);
checkOk(hookNoSnapJson.trim.snapped === false && hookNoSnapJson.trim.end === 24.5 && /snap disabled/.test(hookNoSnapJson.trim.reason ?? ""), "hook snap_quiet:false keeps the raw window end (24.5)", JSON.stringify(hookNoSnapJson.trim));


// hook in batch + manifest (lượt 69): hook is the first probe-only
// operation — no file is written, so a batch row's output is null
// and the ranked windows come back in the row's result; a manifest
// hook step analyzes the chain file and passes it through unchanged,
// so the next trim can cut the window the step just found.
await rm(path.join(root, "outputs/mcp-batch-hook-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-hook-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-hook-in"), { recursive: true });
await copyFile(path.join(root, "test/hook-source.mp4"), path.join(root, "outputs/mcp-batch-hook-in/hook-source.mp4"));
await copyFile(path.join(root, "test/hook-snap-source.mp4"), path.join(root, "outputs/mcp-batch-hook-in/hook-snap-source.mp4"));
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-hook-in/source.mp4"));
const hookBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "hook", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-hook-in"), output_dir: path.join(root, "outputs/mcp-batch-hook-out"), args: { duration: 10 }, jobs: 2 },
});
const hookBatchJson = JSON.parse(hookBatchRes.content[0].text);
console.log("batch hook:", JSON.stringify(hookBatchJson.results.map((r) => ({ status: r.status, output: r.output, hook: r.result?.hook }))), "| suffix", hookBatchJson.output_suffix);
const hookBatchRow = (name) => hookBatchJson.results.find((r) => r.input.endsWith(`/${name}`));
checkOk(hookBatchJson.succeeded === 3 && hookBatchJson.failed === 0 && hookBatchJson.output_suffix === null && hookBatchJson.results.every((r) => r.status === "ok" && r.output === null), "batch hook succeeds on all three files with no output file (output null, suffix null)", JSON.stringify(hookBatchJson.results.map((r) => r.output)));
checkOk(hookBatchRow("hook-source.mp4").result.hook.start === 15 && near(hookBatchRow("hook-source.mp4").result.hook.score, 0.754, 0.01) && hookBatchRow("source.mp4").result.hook.start === 0 && hookBatchRow("source.mp4").result.hook.end === 10, "batch hook rows carry the ranked windows (hook-source 15-25 @0.75, source whole 10s file)", JSON.stringify(hookBatchJson.results.map((r) => r.result?.hook)));
checkOk(hookBatchRow("hook-snap-source.mp4").result.hook.start === 14.5 && hookBatchRow("hook-snap-source.mp4").result.trim.end === 22 && hookBatchRow("hook-snap-source.mp4").result.trim.snapped === true, "batch hook passes the snap through (snap fixture trims to 22)", JSON.stringify(hookBatchRow("hook-snap-source.mp4").result.trim));
const hookBatchCacheRes = await client.callTool({
  name: "batch",
  arguments: { operation: "hook", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-hook-in"), output_dir: path.join(root, "outputs/mcp-batch-hook-out"), args: { duration: 10 }, jobs: 2 },
});
const hookBatchCacheJson = JSON.parse(hookBatchCacheRes.content[0].text);
checkOk(hookBatchCacheJson.cached === 3 && hookBatchCacheJson.succeeded === 0 && hookBatchCacheJson.results.every((r) => r.status === "cached" && r.result.hook.start !== undefined), "batch hook second run serves all three rows from the result cache (no file to verify, key covers input bytes)", JSON.stringify(hookBatchCacheJson.results.map((r) => r.status)));
const hookBatchDryRes = await client.callTool({
  name: "batch",
  arguments: { operation: "hook", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-hook-in"), output_dir: path.join(root, "outputs/mcp-batch-hook-out"), args: { duration: 10 }, dry_run: true },
});
const hookBatchDryJson = JSON.parse(hookBatchDryRes.content[0].text);
checkOk(hookBatchDryJson.dry_run === true && hookBatchDryJson.results.every((r) => r.status === "planned" && r.output === null), "batch hook dry-run plans with null outputs and writes nothing", JSON.stringify(hookBatchDryJson.results.map((r) => r.output)));
await rm(path.join(root, "outputs/mcp-manifest-hook.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const hookManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-hook.json") },
});
const hookManifestJson = JSON.parse(hookManifestRes.content[0].text);
console.log("manifest hook:", JSON.stringify(hookManifestJson.steps.map((s) => ({ tool: s.tool, status: s.status, output: s.output, hook: s.result?.hook }))), "| final", hookManifestJson.final?.duration_seconds);
checkOk(hookManifestJson.steps_run === 2 && hookManifestJson.steps.every((s) => s.status === "ok") && hookManifestJson.steps[0].tool === "hook" && hookManifestJson.steps[0].result.hook.start === 15 && near(hookManifestJson.final.duration_seconds, 10, 0.05), "manifest hook step records the 15-25 window, then trim cuts it (final 10s)", JSON.stringify(hookManifestJson.steps.map((s) => s.result?.hook ?? s.result?.duration_seconds)));
checkOk(hookManifestJson.steps[0].output === hookManifestJson.input && hookManifestJson.steps[1].output !== hookManifestJson.steps[0].output, "manifest hook step passes the chain file through (its output is the input it analyzed)", hookManifestJson.steps[0].output);
const hookManifestCacheRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-hook.json") },
});
const hookManifestCacheJson = JSON.parse(hookManifestCacheRes.content[0].text);
checkOk(hookManifestCacheJson.cache_hits === 2 && hookManifestCacheJson.steps.every((s) => s.status === "cached") && hookManifestCacheJson.steps[0].result.hook.start === 15, "manifest hook re-run serves both steps from cache (hook result cached, trim file cached)", JSON.stringify(hookManifestCacheJson.steps.map((s) => s.status)));
const hookManifestDryRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-hook.json"), dry_run: true },
});
const hookManifestDryJson = JSON.parse(hookManifestDryRes.content[0].text);
checkOk(hookManifestDryJson.dry_run === true && hookManifestDryJson.steps[0].output === hookManifestDryJson.input && hookManifestDryJson.steps[1].input === hookManifestDryJson.input, "manifest hook dry-run plans the hook step as a pass-through (output = input)", JSON.stringify(hookManifestDryJson.steps.map((s) => s.output)));
// measure_pace in batch + manifest (lượt 133): probe-only like
// hook — no file is written, the pace numbers come back in the
// row's result / the step's result, and the cache stores that
// result. The style-file write is deliberately not exposed here.
await rm(path.join(root, "outputs/mcp-batch-pace-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-pace-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-pace-in"), { recursive: true });
await copyFile(path.join(root, "test/pace-source.mp4"), path.join(root, "outputs/mcp-batch-pace-in/pace-source.mp4"));
const paceBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "measure_pace", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-pace-in"), output_dir: path.join(root, "outputs/mcp-batch-pace-out") },
});
const paceBatchJson = JSON.parse(paceBatchRes.content[0].text);
checkOk(paceBatchJson.succeeded === 1 && paceBatchJson.failed === 0 && paceBatchJson.output_suffix === null && paceBatchJson.results[0].status === "ok" && paceBatchJson.results[0].output === null && paceBatchJson.results[0].result.cuts === 3 && paceBatchJson.results[0].result.cuts_per_min === 9, "batch measure_pace succeeds with no output file and the pace numbers in the row's result", JSON.stringify(paceBatchJson.results.map((r) => r.result)));
await rm(path.join(root, "outputs/mcp-manifest-pace.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const paceManifestPath = path.join(root, "outputs", "manifest-pace.json");
await writeFile(paceManifestPath, JSON.stringify({ version: 1, input: path.join(root, "test/pace-source.mp4"), output: path.join(root, "outputs/mcp-manifest-pace.mp4"), steps: [{ tool: "measure_pace" }, { tool: "trim", args: { start: 5, end: 10 } }] }), "utf8");
const paceManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: paceManifestPath },
});
const paceManifestJson = JSON.parse(paceManifestRes.content[0].text);
checkOk(paceManifestJson.steps_run === 2 && paceManifestJson.steps.every((s) => s.status === "ok") && paceManifestJson.steps[0].tool === "measure_pace" && paceManifestJson.steps[0].result.cuts === 3 && paceManifestJson.steps[0].result.cuts_per_min === 9 && paceManifestJson.steps[0].output === paceManifestJson.input && near(paceManifestJson.final.duration_seconds, 5, 0.05), "manifest measure_pace step records the 3-cut pace, passes the chain through, then trim cuts 5-10s (final 5s)", JSON.stringify(paceManifestJson.steps.map((s) => s.result?.cuts_per_min ?? s.result?.duration_seconds)));
// The manifest validator takes the new snap args too (same args
// list as batch): a dry-run manifest with snap_quiet:false validates
// without rendering anything.
const hookManifestSnapPath = path.join(root, "outputs", "manifest-hook-snap.json");
await writeFile(hookManifestSnapPath, JSON.stringify({ version: 1, input: path.join(root, "test/hook-snap-source.mp4"), output: path.join(root, "outputs/mcp-manifest-hook-snap.mp4"), steps: [{ tool: "hook", args: { duration: 10, snap_window_seconds: 5, snap_quiet: false } }] }), "utf8");
const hookManifestSnapDryRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: hookManifestSnapPath, dry_run: true },
});
const hookManifestSnapDryJson = JSON.parse(hookManifestSnapDryRes.content[0].text);
checkOk(hookManifestSnapDryJson.dry_run === true && hookManifestSnapDryJson.steps[0].tool === "hook" && hookManifestSnapDryJson.steps[0].status === "planned", "manifest dry-run accepts a hook step with snap_window_seconds + snap_quiet", JSON.stringify(hookManifestSnapDryJson.steps.map((s) => s.tool)));

// hook clip history in batch + manifest: the same history file is
// shared across files, the cache key hashes its bytes (so a recorded
// window invalidates the cached duplicate flags instead of serving
// stale ones), and parallel batch workers append under a lockdir.
const hookHistBatchPath = path.join(root, "outputs", "hook-history-batch.json");
await rm(hookHistBatchPath, { force: true });
const hookBatchHistRes = await client.callTool({
  name: "batch",
  arguments: { operation: "hook", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-hook-in"), output_dir: path.join(root, "outputs/mcp-batch-hook-out"), args: { duration: 10, history_file: hookHistBatchPath, record: true }, jobs: 2 },
});
const hookBatchHistJson = JSON.parse(hookBatchHistRes.content[0].text);
checkOk(hookBatchHistJson.succeeded === 3 && hookBatchHistJson.results.every((r) => r.status === "ok" && r.result.history.recorded === true && r.result.history.duplicates_found === 0), "batch hook --record records all three winners into one shared history file", JSON.stringify(hookBatchHistJson.results.map((r) => r.result?.history)));
const hookHistBatchDoc = JSON.parse(await readFile(hookHistBatchPath, "utf8"));
checkOk(hookHistBatchDoc.records.length === 3 && new Set(hookHistBatchDoc.records.map((r) => r.source_sha256)).size === 3, "batch history file has exactly 3 records, one per source (no lost update under jobs: 2)", JSON.stringify(hookHistBatchDoc.records.map((r) => `${r.source}:${r.start}-${r.end}`)));
const hookBatchHist2Res = await client.callTool({
  name: "batch",
  arguments: { operation: "hook", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-hook-in"), output_dir: path.join(root, "outputs/mcp-batch-hook-out"), args: { duration: 10, history_file: hookHistBatchPath, record: true }, jobs: 2 },
});
const hookBatchHist2Json = JSON.parse(hookBatchHist2Res.content[0].text);
checkOk(hookBatchHist2Json.succeeded === 3 && hookBatchHist2Json.cached === 0 && hookBatchHist2Json.results.every((r) => r.status === "ok" && r.result.history.duplicates_found === 1 && r.result.history.recorded === false), "batch hook second run re-runs (history bytes changed the cache key) and flags all three winners duplicates", JSON.stringify(hookBatchHist2Json.results.map((r) => r.result?.history)));
const hookBatchHist3Res = await client.callTool({
  name: "batch",
  arguments: { operation: "hook", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-hook-in"), output_dir: path.join(root, "outputs/mcp-batch-hook-out"), args: { duration: 10, history_file: hookHistBatchPath, record: true }, jobs: 2 },
});
const hookBatchHist3Json = JSON.parse(hookBatchHist3Res.content[0].text);
checkOk(hookBatchHist3Json.cached === 3 && hookBatchHist3Json.results.every((r) => r.status === "cached"), "batch hook third run serves all three rows from cache (history unchanged since run 2)", JSON.stringify(hookBatchHist3Json.results.map((r) => r.status)));
const hookHistBatchDoc3 = JSON.parse(await readFile(hookHistBatchPath, "utf8"));
checkOk(hookHistBatchDoc3.records.length === 3, "batch history file still has exactly 3 records after the duplicate runs", `records=${hookHistBatchDoc3.records.length}`);
// Manifest: the hook step records through the manifest-relative path,
// and the history file is hashed into the step cache key.
await rm(path.join(root, "outputs/mcp-manifest-hook-history.mp4"), { force: true });
await rm(path.join(root, "outputs/hook-history-manifest.json"), { force: true });
const hookManifestHistRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-hook-history.json") },
});
const hookManifestHistJson = JSON.parse(hookManifestHistRes.content[0].text);
checkOk(hookManifestHistJson.steps[0].status === "ok" && hookManifestHistJson.steps[0].result.history.recorded === true && (hookManifestHistJson.steps[1].status === "ok" || hookManifestHistJson.steps[1].status === "cached") && near(hookManifestHistJson.final.duration_seconds, 10, 0.05), "manifest hook step records the winner, then trim cuts it (final 10s; the trim may be cached from an identical earlier run — the hook step is the one under test here)", JSON.stringify(hookManifestHistJson.steps.map((s) => s.result?.history ?? s.status)));
const hookHistManifestDoc = JSON.parse(await readFile(path.join(root, "outputs/hook-history-manifest.json"), "utf8"));
checkOk(hookHistManifestDoc.records.length === 1 && hookHistManifestDoc.records[0].start === 15 && hookHistManifestDoc.records[0].end === 25, "manifest history file has the one recorded window [15,25)", JSON.stringify(hookHistManifestDoc.records));
const hookManifestHist2Res = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-hook-history.json") },
});
const hookManifestHist2Json = JSON.parse(hookManifestHist2Res.content[0].text);
checkOk(hookManifestHist2Json.cache_hits === 1 && hookManifestHist2Json.steps[0].status === "ok" && hookManifestHist2Json.steps[0].result.history.duplicates_found === 1 && hookManifestHist2Json.steps[0].result.history.recorded === false && hookManifestHist2Json.steps[1].status === "cached", "manifest hook re-run re-runs the hook step (history changed the key) and flags the duplicate, trim stays cached", JSON.stringify(hookManifestHist2Json.steps.map((s) => s.status)));
const hookManifestHist3Res = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-hook-history.json") },
});
const hookManifestHist3Json = JSON.parse(hookManifestHist3Res.content[0].text);
checkOk(hookManifestHist3Json.cache_hits === 2 && hookManifestHist3Json.steps.every((s) => s.status === "cached"), "manifest hook third run serves both steps from cache (history unchanged)", JSON.stringify(hookManifestHist3Json.steps.map((s) => s.status)));


// bpm: tempo from a spectral-flux onset function + autocorrelation /
// comb period search (aubio tempo, re-implemented in pure Node).
// Fixtures are 12s WAV click tracks at known tempos (generated by
// test/make-bpm-fixtures.mjs) plus a kick+off-beat-hat drum pattern
// at 120 BPM — the pattern a naive detector reads as 240, so it
// proves the 120 BPM prior + onset-recall tie-break pick the
// musical beat. A steady tone and speech must report reliable:
// false instead of a confident wrong number.
// Unit test first: the pure functions on a synthetic 120 BPM click
// train built in-test (no ffmpeg involved) — FFT + flux + estimation.
{
  const sr = 22050, seconds = 12, bpmTrue = 120;
  const clickTrain = new Float32Array(seconds * sr);
  for (let b = 0; ; b++) {
    const t0 = (b * 60) / bpmTrue;
    if (t0 >= seconds) break;
    const start = Math.floor(t0 * sr);
    for (let i = 0; i < Math.floor(0.03 * sr); i++) {
      const t = i / sr;
      clickTrain[start + i] += Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t * 180) * 0.9;
    }
  }
  const { flux, rawFlux, fps } = spectralFluxOnset(clickTrain, sr);
  const unitEst = estimateTempo(flux, fps, rawFlux);
  console.log("bpm unit (synthetic 120 click train):", JSON.stringify(unitEst));
  checkOk(near(unitEst.bpm, 120, 1) && unitEst.reliable === true && unitEst.confidence >= 0.7 && near(unitEst.onset_recall, 1, 0.05), "bpm unit: synthetic 120 BPM click train -> 120 +/-1, reliable, recall ~1", JSON.stringify(unitEst));
  checkOk(unitEst.beats.length === 16, "bpm unit: default beat list is capped at the first 16 beats", JSON.stringify(unitEst.beats.length));
  // beat_grid (lượt 87): the same estimation with maxBeats raised
  // expands the grid over the whole 12s train — 23 beats (the flux
  // span ends at 11.959s, so the 24th click at 11.991 has no flux
  // frame), first beat ~0.488 (one flux frame before the 0.5s click),
  // 0.5s apart. The grid is built from the refined lag at full
  // precision, never from the rounded bpm — stepping 60/120.0 would
  // drift the same amount here, but on a 150.7 BPM file it would not.
  const unitGrid = estimateTempo(flux, fps, rawFlux, 40, 240, 5000);
  console.log("beat_grid unit (synthetic 120 click train, maxBeats 5000):", JSON.stringify({ beats: unitGrid.beats.length, first: unitGrid.beats[0], last: unitGrid.beats[unitGrid.beats.length - 1] }));
  checkOk(unitGrid.beats.length === 23 && near(unitGrid.beats[0], 0.488, 0.03) && near(unitGrid.beats[1] - unitGrid.beats[0], 0.5, 0.02) && near(unitGrid.beats[unitGrid.beats.length - 1], 11.491, 0.03), "beat_grid unit: full grid is 23 beats, 0.488 first, 0.5s apart, 11.491 last", JSON.stringify(unitGrid.beats.slice(0, 3)));
}
// DP beat tracker unit (lượt 88, librosa beat_track re-implemented):
// a take whose tempo drifts 120 -> 132 BPM over 12s. The rigid grid
// is built from the mean period, so it drifts off the true clicks;
// the DP must stay on them. Ground truth is the same accumulation
// the fixture generator uses (period 60/bpm(t), bpm linear in time).
// The first click sits at t=0, where the flux window is truncated,
// so the DP is allowed to miss it (count within 1 of truth).
{
  const sr = 22050, seconds = 12;
  const driftTrain = new Float32Array(seconds * sr);
  const driftTruth = [];
  for (let t = 0; t < seconds;) {
    driftTruth.push(t);
    const start = Math.floor(t * sr);
    for (let i = 0; i < Math.floor(0.03 * sr); i++) {
      const u = i / sr;
      driftTrain[start + i] += Math.sin(2 * Math.PI * 1000 * u) * Math.exp(-u * 180) * 0.9;
    }
    t += 60 / (120 + (12 * t) / seconds);
  }
  const dFlux = spectralFluxOnset(driftTrain, sr);
  const dGrid = estimateTempo(dFlux.flux, dFlux.fps, dFlux.rawFlux, 40, 240, 5000);
  const dDp = trackBeatsDP(dFlux.flux, dFlux.fps, dGrid.lag);
  const dpErr = (beats, truth) => Math.max(...beats.map((b) => Math.min(...truth.map((t) => Math.abs(b - t)))));
  const gridVsDp = Math.max(...dDp.beats.map((b) => Math.min(...dGrid.beats.map((g) => Math.abs(b - g)))));
  console.log("dp unit (drift 120->132):", JSON.stringify({ gridBpm: dGrid.bpm, gridBeats: dGrid.beats.length, dpBeats: dDp.beat_count, dpMaxErr: +dpErr(dDp.beats, driftTruth).toFixed(3), gridVsDp: +gridVsDp.toFixed(3), cv: dDp.tempo_drift_cv }));
  checkOk(dDp.beat_count >= driftTruth.length - 1 && dDp.beat_count <= driftTruth.length && dpErr(dDp.beats, driftTruth) <= 0.05, "dp unit: drift take tracks the real clicks (count within 1 of truth, every beat within 0.05s of a true click)", JSON.stringify({ count: dDp.beat_count, truth: driftTruth.length, maxErr: +dpErr(dDp.beats, driftTruth).toFixed(3) }));
  checkOk(gridVsDp > 0.3, "dp unit: the rigid grid drifts off the DP track by >0.3s on a 120->132 take (the drift the DP exists to fix)", JSON.stringify({ gridVsDp: +gridVsDp.toFixed(3) }));
  // Same tracker on the steady 120 train: DP and grid must agree
  // within a flux frame (0.023s) — the DP changes nothing when
  // there is no drift to follow.
  const steadyTrain = new Float32Array(seconds * sr);
  for (let b = 0; ; b++) {
    const t0 = (b * 60) / 120;
    if (t0 >= seconds) break;
    const start = Math.floor(t0 * sr);
    for (let i = 0; i < Math.floor(0.03 * sr); i++) {
      const u = i / sr;
      steadyTrain[start + i] += Math.sin(2 * Math.PI * 1000 * u) * Math.exp(-u * 180) * 0.9;
    }
  }
  const sFlux = spectralFluxOnset(steadyTrain, sr);
  const sGrid = estimateTempo(sFlux.flux, sFlux.fps, sFlux.rawFlux, 40, 240, 5000);
  const sDp = trackBeatsDP(sFlux.flux, sFlux.fps, sGrid.lag);
  const steadyDev = Math.max(...sDp.beats.map((b) => Math.min(...sGrid.beats.map((g) => Math.abs(b - g)))));
  checkOk(sDp.beat_count === 23 && steadyDev <= 0.05 && sDp.tempo_drift_cv <= 0.05, "dp unit: steady 120 train — DP agrees with the rigid grid (23 beats, deviation <=0.05s, cv <=0.05)", JSON.stringify({ count: sDp.beat_count, dev: +steadyDev.toFixed(3), cv: sDp.tempo_drift_cv }));
  // The drum pattern (kick + off-beat hat) must NOT subdivide: the
  // DP keeps one beat per 0.5s. Tightness 1 failed this (29 beats);
  // tightness 2 prices a half-period detour above any onset's gain.
  const drumTrain = (() => {
    const s = new Float32Array(seconds * sr);
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let b = 0; ; b++) {
      const t0 = (b * 60) / 120;
      if (t0 >= seconds) break;
      const start = Math.floor(t0 * sr);
      for (let i = 0; i < Math.floor(0.15 * sr); i++) {
        const u = i / sr;
        s[start + i] += Math.sin(2 * Math.PI * 60 * u) * Math.exp(-u * 25) * 0.9;
      }
      const hatAt = t0 + 0.25;
      if (hatAt < seconds) {
        const hs = Math.floor(hatAt * sr);
        for (let i = 0; i < Math.floor(0.04 * sr); i++) {
          const u = i / sr;
          s[hs + i] += (rand() * 2 - 1) * Math.exp(-u * 120) * 0.25;
        }
      }
    }
    return s;
  })();
  const drumFlux = spectralFluxOnset(drumTrain, sr);
  const drumGrid = estimateTempo(drumFlux.flux, drumFlux.fps, drumFlux.rawFlux, 40, 240, 5000);
  const drumDp = trackBeatsDP(drumFlux.flux, drumFlux.fps, drumGrid.lag);
  const drumMinInterval = Math.min(...drumDp.intervals_seconds);
  checkOk(drumDp.beat_count === 24 && drumMinInterval >= 0.45 && drumDp.tempo_drift_cv <= 0.05, "dp unit: kick+hat drum pattern does not subdivide (24 beats, min interval >=0.45s, cv <=0.05)", JSON.stringify({ count: drumDp.beat_count, minInterval: drumMinInterval, cv: drumDp.tempo_drift_cv }));
}
// tempo_drift unit (lượt 89): the same aubio pipeline `bpm` uses,
  // run on sliding windows of the flux and aggregated to 1s bins.
  // (A Fourier tempogram peak was tried first and read 239.1 on the
  // drum — the kick+hat 2 Hz components cancel, so the peak lands on
  // the 240 subdivision; the windowed autocorrelation sees the
  // alternating strong/weak pattern and reads the musical 120.) Same synthetic trains as the bpm/dp
// units (12s, 22050 Hz). A steady 120 train must read 120 flat; a
// 120->132 drift must rise ~123 at t=2 to ~129 at t=9 (the window
// cannot centre on the first/last ~2.4s, so bins 0, 1, 10 are
// unreliable by construction); a kick+hat drum must stay on the
// musical 120, not the 240 subdivision; a steady 440 Hz tone has no
// onset energy, so every window is unusable and every bin unreliable
// — per-window confidence is a ratio, so a tone window can score
// "reliable" with a garbage bpm (171.9 in the probe), which is why
// the gate is onset energy, not confidence.
{
  const sr = 22050, seconds = 12;
  const click = (bpmFn) => {
    const s = new Float32Array(seconds * sr);
    for (let t = 0; t < seconds;) {
      const start = Math.floor(t * sr);
      for (let i = 0; i < Math.floor(0.03 * sr); i++) {
        const u = i / sr;
        s[start + i] += Math.sin(2 * Math.PI * 1000 * u) * Math.exp(-u * 180) * 0.9;
      }
      t += 60 / bpmFn(t);
    }
    return s;
  };
  const steady = click(() => 120);
  const sFlux = spectralFluxOnset(steady, sr);
  const sCurve = localTempoCurve(sFlux.flux, sFlux.rawFlux, sFlux.fps);
  const sBins = sCurve.bins.filter((b) => b.reliable);
  console.log("tempo_drift unit (steady 120):", JSON.stringify({ window: sCurve.window_frames, bins: sBins.map((b) => b.bpm) }));
  checkOk(sBins.length === 8 && sBins.every((b) => near(b.bpm, 120, 0.5)), "tempo_drift unit: steady 120 reads 120 +/-0.5 on all 8 reliable bins (t=2..9)", JSON.stringify(sBins.map((b) => b.bpm)));
  const drift = click((t) => 120 + t);
  const dFlux = spectralFluxOnset(drift, sr);
  const dCurve = localTempoCurve(dFlux.flux, dFlux.rawFlux, dFlux.fps);
  const dBins = dCurve.bins.filter((b) => b.reliable);
  const dBpms = dBins.map((b) => b.bpm);
  console.log("tempo_drift unit (drift 120->132):", JSON.stringify({ bins: dBpms }));
  checkOk(dBins.length === 8 && near(dBpms[0], 122.7, 1) && near(dBpms[dBpms.length - 1], 129.2, 1) && dBpms[dBpms.length - 1] - dBpms[0] >= 5 && dBpms.every((v, i) => i === 0 || v >= dBpms[i - 1] - 0.2), "tempo_drift unit: 120->132 take rises 122.7 -> 129.2 across the curve (delta >=5, never falls)", JSON.stringify(dBpms));
  const drum = (() => {
    const s = new Float32Array(seconds * sr);
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let b = 0; ; b++) {
      const t0 = (b * 60) / 120;
      if (t0 >= seconds) break;
      const start = Math.floor(t0 * sr);
      for (let i = 0; i < Math.floor(0.15 * sr); i++) {
        const u = i / sr;
        s[start + i] += Math.sin(2 * Math.PI * 60 * u) * Math.exp(-u * 25) * 0.9;
      }
      const hatAt = t0 + 0.25;
      if (hatAt < seconds) {
        const hs = Math.floor(hatAt * sr);
        for (let i = 0; i < Math.floor(0.04 * sr); i++) {
          const u = i / sr;
          s[hs + i] += (rand() * 2 - 1) * Math.exp(-u * 120) * 0.25;
        }
      }
    }
    return s;
  })();
  const drumFlux = spectralFluxOnset(drum, sr);
  const drumCurve = localTempoCurve(drumFlux.flux, drumFlux.rawFlux, drumFlux.fps);
  const drumBins = drumCurve.bins.filter((b) => b.reliable);
  checkOk(drumBins.length >= 6 && drumBins.every((b) => near(b.bpm, 120, 1)), "tempo_drift unit: kick+hat drum stays on the musical 120 (not 240) on every reliable bin", JSON.stringify(drumBins.map((b) => b.bpm)));
  const tone = new Float32Array(seconds * sr);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.5;
  const toneFlux = spectralFluxOnset(tone, sr);
  const toneCurve = localTempoCurve(toneFlux.flux, toneFlux.rawFlux, toneFlux.fps);
  checkOk(toneCurve.bins.every((b) => !b.reliable), "tempo_drift unit: steady tone has no usable frames — every bin unreliable (onset-energy gate, not per-window confidence)", JSON.stringify(toneCurve.bins.map((b) => b.frames)));
}
async function callBpm(input, extra = {}) {
  const res = await client.callTool({ name: "bpm", arguments: { input, ...extra } });
  return JSON.parse(res.content[0].text);
}
const bpm120 = await callBpm(path.join(root, "test/bpm-click-120.wav"));
console.log("bpm 120:", JSON.stringify({ bpm: bpm120.bpm, conf: bpm120.confidence, reliable: bpm120.reliable, recall: bpm120.onset_recall, beats: bpm120.beats.slice(0, 4) }));
checkOk(near(bpm120.bpm, 120, 1) && bpm120.confidence >= 0.7 && bpm120.reliable === true && near(bpm120.onset_recall, 1, 0.05) && bpm120.beats.length === 16 && near(bpm120.beats[1] - bpm120.beats[0], 0.5, 0.02) && near(bpm120.beat_period_seconds, 0.5, 0.01), "bpm reads the 120 click track as 120 +/-1 (conf >=0.7, recall ~1, 16 beats 0.5s apart)", JSON.stringify({ bpm: bpm120.bpm, conf: bpm120.confidence, beats: bpm120.beats.slice(0, 3) }));
const bpm90 = await callBpm(path.join(root, "test/bpm-click-90.wav"));
checkOk(near(bpm90.bpm, 90, 1) && bpm90.reliable === true && bpm90.confidence >= 0.7, "bpm reads the 90 click track as 90 +/-1", JSON.stringify({ bpm: bpm90.bpm, conf: bpm90.confidence }));
const bpm150 = await callBpm(path.join(root, "test/bpm-click-150.wav"));
checkOk(near(bpm150.bpm, 150, 1) && bpm150.reliable === true && bpm150.confidence >= 0.7, "bpm reads the 150 click track as 150 +/-1 (parabolic refinement, not 152)", JSON.stringify({ bpm: bpm150.bpm, conf: bpm150.confidence }));
const bpm180 = await callBpm(path.join(root, "test/bpm-click-180.wav"));
checkOk(near(bpm180.bpm, 180, 1) && bpm180.reliable === true && bpm180.confidence >= 0.7, "bpm reads the 180 click track as 180 +/-1 (not its 90 half-tempo)", JSON.stringify({ bpm: bpm180.bpm, conf: bpm180.confidence }));
const bpmDrum = await callBpm(path.join(root, "test/bpm-drum-120.wav"));
console.log("bpm drum120:", JSON.stringify({ bpm: bpmDrum.bpm, conf: bpmDrum.confidence, recall: bpmDrum.onset_recall }));
checkOk(near(bpmDrum.bpm, 120, 1) && bpmDrum.reliable === true && bpmDrum.confidence >= 0.7, "bpm reads the kick+hat drum pattern as its musical beat 120 +/-1, not the 240 subdivision", JSON.stringify({ bpm: bpmDrum.bpm, conf: bpmDrum.confidence, recall: bpmDrum.onset_recall }));
const bpmTone = await callBpm(path.join(root, "test/mix-music.mp3"));
checkOk(bpmTone.reliable === false && bpmTone.confidence < 0.35 && bpmTone.warnings.some((w) => /low confidence/.test(w)), "bpm on a steady tone reports reliable: false (confidence <0.35) instead of a confident number", JSON.stringify({ bpm: bpmTone.bpm, conf: bpmTone.confidence }));
const bpmSpeech = await callBpm(path.join(root, "test/kokoro-voice.wav"));
checkOk(bpmSpeech.reliable === false && bpmSpeech.confidence < 0.35, "bpm on speech reports reliable: false (confidence <0.35)", JSON.stringify({ bpm: bpmSpeech.bpm, conf: bpmSpeech.confidence }));
const bpmVideoOnly = await callExpectThrow("bpm", { input: path.join(root, "test/content-video-only.mp4") });
checkOk(/needs an audio stream/.test(bpmVideoOnly), "bpm refuses video-only input", bpmVideoOnly.slice(0, 120));
const bpmBadRange = await callExpectThrow("bpm", { input: path.join(root, "test/bpm-click-120.wav"), min_bpm: 200, max_bpm: 100 });
checkOk(/must be below/.test(bpmBadRange), "bpm refuses min_bpm above max_bpm", bpmBadRange.slice(0, 120));
const bpmNarrow = await callBpm(path.join(root, "test/bpm-click-120.wav"), { min_bpm: 100, max_bpm: 140 });
checkOk(near(bpmNarrow.bpm, 120, 1) && bpmNarrow.reliable === true, "bpm with a narrowed 100-140 range still reads 120", JSON.stringify({ bpm: bpmNarrow.bpm }));

// beat_grid (lượt 87): the full beat grid — every beat across the
// file, not just bpm's first 16. Fixture test/beat-trim-source.mp4
// is the same 120 BPM click track under a flat 1280x720 color
// (12s), so the grid and the trim snap below share ground truth.
async function callBeatGrid(input, extra = {}) {
  const res = await client.callTool({ name: "beat_grid", arguments: { input, ...extra } });
  return JSON.parse(res.content[0].text);
}
const grid120 = await callBeatGrid(path.join(root, "test/bpm-click-120.wav"));
console.log("beat_grid 120:", JSON.stringify({ bpm: grid120.bpm, beats: grid120.beats.length, first: grid120.first_beat_seconds, last: grid120.last_beat_seconds }));
checkOk(grid120.operation === "beat_grid" && near(grid120.bpm, 120, 1) && grid120.reliable === true && grid120.beat_count === 23 && grid120.beats.length === 23 && near(grid120.first_beat_seconds, 0.488, 0.03) && near(grid120.last_beat_seconds, 11.491, 0.03) && near(grid120.beats[1] - grid120.beats[0], 0.5, 0.02), "beat_grid returns all 23 beats of the 120 click track (0.488 first, 0.5s apart, 11.491 last)", JSON.stringify({ count: grid120.beat_count, first: grid120.first_beat_seconds, last: grid120.last_beat_seconds }));
const gridDrum = await callBeatGrid(path.join(root, "test/bpm-drum-120.wav"));
checkOk(near(gridDrum.bpm, 120, 1) && gridDrum.reliable === true && gridDrum.beat_count >= 20 && near(gridDrum.beats[1] - gridDrum.beats[0], 0.5, 0.02), "beat_grid on the drum pattern reads the musical 120 grid, not the 240 subdivision", JSON.stringify({ bpm: gridDrum.bpm, count: gridDrum.beat_count }));
const gridTone = await callBeatGrid(path.join(root, "test/mix-music.mp3"));
checkOk(gridTone.reliable === false && gridTone.confidence < 0.35 && gridTone.warnings.some((w) => /low confidence/.test(w)), "beat_grid on a steady tone reports reliable: false instead of a grid to snap to", JSON.stringify({ conf: gridTone.confidence, beats: gridTone.beats.length }));
const gridVideoOnly = await callExpectThrow("beat_grid", { input: path.join(root, "test/content-video-only.mp4") });
checkOk(/needs an audio stream/.test(gridVideoOnly), "beat_grid refuses video-only input", gridVideoOnly.slice(0, 120));

// beat_grid method "dp" (lượt 88): the DP tracker follows real
// onset peaks when the tempo drifts. Fixture
// test/bpm-drift-120-132.wav is a 120 -> 132 BPM click track over
// 12s; ground truth is the same period accumulation the generator
// uses. The rigid grid reports the mean tempo (125.9) and drifts
// off by 0.373s; the DP must land on the true clicks instead.
const driftTruth = [];
for (let t = 0; t < 12;) { driftTruth.push(t); t += 60 / (120 + (12 * t) / 12); }
const gridDp = await callBeatGrid(path.join(root, "test/bpm-drift-120-132.wav"), { method: "dp" });
console.log("beat_grid dp (drift 120->132):", JSON.stringify({ bpm: gridDp.bpm, count: gridDp.beat_count, drift: gridDp.tempo_drift_seconds, cv: gridDp.tempo_drift_cv, first: gridDp.first_beat_seconds, last: gridDp.last_beat_seconds }));
const dpMaxErr = Math.max(...gridDp.beats.map((b) => Math.min(...driftTruth.map((t) => Math.abs(b - t)))));
checkOk(gridDp.grid_method === "dp" && gridDp.beat_count >= driftTruth.length - 1 && gridDp.beat_count <= driftTruth.length && dpMaxErr <= 0.05 && near(gridDp.bpm, 125.9, 1) && gridDp.reliable === true && near(gridDp.tempo_drift_seconds, 0.373, 0.05) && near(gridDp.tempo_drift_cv, 0.034, 0.02), "beat_grid method dp tracks the drifting take (25 beats on the true clicks, mean tempo 125.9, drift 0.373s, cv 0.034)", JSON.stringify({ count: gridDp.beat_count, truth: driftTruth.length, maxErr: +dpMaxErr.toFixed(3), drift: gridDp.tempo_drift_seconds, cv: gridDp.tempo_drift_cv }));
const gridDefault = await callBeatGrid(path.join(root, "test/bpm-drift-120-132.wav"));
checkOk(gridDefault.grid_method === "grid" && gridDefault.tempo_drift_seconds === null && gridDefault.tempo_drift_cv === null && gridDefault.beat_count === 25, "beat_grid defaults to the rigid grid (grid_method grid, no drift fields)", JSON.stringify({ method: gridDefault.grid_method, drift: gridDefault.tempo_drift_seconds }));
const gridDpSteady = await callBeatGrid(path.join(root, "test/bpm-click-120.wav"), { method: "dp" });
checkOk(gridDpSteady.grid_method === "dp" && gridDpSteady.beat_count === 23 && gridDpSteady.tempo_drift_seconds <= 0.05 && gridDpSteady.tempo_drift_cv <= 0.05, "beat_grid method dp on a steady 120 track agrees with the rigid grid (23 beats, drift <=0.05s)", JSON.stringify({ count: gridDpSteady.beat_count, drift: gridDpSteady.tempo_drift_seconds, cv: gridDpSteady.tempo_drift_cv }));
const gridDpDrum = await callBeatGrid(path.join(root, "test/bpm-drum-120.wav"), { method: "dp" });
const drumDpIntervals = [];
for (let i = 1; i < gridDpDrum.beats.length; i++) drumDpIntervals.push(gridDpDrum.beats[i] - gridDpDrum.beats[i - 1]);
checkOk(gridDpDrum.beat_count === 24 && Math.min(...drumDpIntervals) >= 0.45, "beat_grid method dp does not subdivide the kick+hat drum pattern (24 beats, min interval >=0.45s)", JSON.stringify({ count: gridDpDrum.beat_count, minInterval: Math.min(...drumDpIntervals).toFixed(3) }));
const gridBadMethod = await callExpectThrow("beat_grid", { input: path.join(root, "test/bpm-click-120.wav"), method: "fft" });
checkOk(/method|Invalid enum/i.test(gridBadMethod), "beat_grid refuses an unknown method", gridBadMethod.slice(0, 160));

// trim --snap-beat (lượt 87): snap start down / end up onto the
// beat grid. Expected edges are computed from the measured grid
// itself (probe-first), not hardcoded: 1.13 falls between beats
// 0.988 and 1.488, 3.27 between 2.988 and 3.489.
const snapBeatGrid = grid120.beats;
const snapBeatStart = [...snapBeatGrid].reverse().find((t) => t <= 1.13) ?? 0;
const snapBeatEnd = snapBeatGrid.find((t) => t >= 3.27) ?? 12;
const snapBeatRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/beat-trim-source.mp4"),
    output: path.join(root, "outputs/mcp-trim-snapbeat.mp4"),
    start: 1.13, end: 3.27, snap_to_beat: true,
  },
});
const snapBeatJson = JSON.parse(snapBeatRes.content[0].text);
console.log("trim snap-beat:", JSON.stringify({ requested: `${snapBeatJson.requested_start}-${snapBeatJson.requested_end}`, actual: `${snapBeatJson.start}-${snapBeatJson.start + snapBeatJson.duration_seconds}`, bpm: snapBeatJson.bpm, duration_actual: snapBeatJson.duration_actual }));
checkOk(snapBeatJson.snapped === true && near(snapBeatJson.start, snapBeatStart, 0.001) && near(snapBeatJson.beat_start, snapBeatStart, 0.001) && near(snapBeatJson.beat_end, snapBeatEnd, 0.001) && snapBeatJson.bpm === 120 && snapBeatJson.beat_confidence >= 0.7 && near(snapBeatJson.duration_seconds, snapBeatEnd - snapBeatStart, 0.001) && near(snapBeatJson.duration_actual, snapBeatEnd - snapBeatStart, 0.1), "trim snap_to_beat moves 1.13-3.27 onto beats (start down, end up) at 120 BPM", JSON.stringify({ start: snapBeatJson.start, end: snapBeatJson.beat_end, bpm: snapBeatJson.bpm }));
checkOk(snapBeatJson.cut_verified === true, "trim snap-beat still verifies (flat fixture: all frames identical, so the moved cut matches)", JSON.stringify(snapBeatJson.check_frames_match));
// Stream-copy snap-beat: the grid still decides the window (the
// container may land a keyframe later, which duration_actual shows).
const snapBeatCopyRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/beat-trim-source.mp4"),
    output: path.join(root, "outputs/mcp-trim-snapbeat-copy.mp4"),
    start: 1.13, end: 3.27, stream_copy: true, snap_to_beat: true,
  },
});
const snapBeatCopyJson = JSON.parse(snapBeatCopyRes.content[0].text);
checkOk(snapBeatCopyJson.snapped === true && near(snapBeatCopyJson.start, snapBeatStart, 0.001) && near(snapBeatCopyJson.beat_end, snapBeatEnd, 0.001), "trim snap_to_beat works with stream_copy too (grid decides the window)", JSON.stringify({ start: snapBeatCopyJson.start, end: snapBeatCopyJson.beat_end }));
// Refusals: no steady beat, and two grids / an exact-start cut.
const snapBeatTone = await callExpectThrow("trim", { input: path.join(root, "test/mix-music.mp3"), output: path.join(root, "outputs/mcp-trim-snapbeat-tone.mp3"), start: 1, duration: 2, snap_to_beat: true });
checkOk(/needs a reliable beat grid/.test(snapBeatTone), "trim snap_to_beat refuses a tone (no steady beat to snap to)", snapBeatTone.slice(0, 140));
const snapBeatBoth = await callExpectThrow("trim", { input: path.join(root, "test/beat-trim-source.mp4"), output: path.join(root, "outputs/mcp-trim-snapbeat-both.mp4"), start: 1, duration: 2, stream_copy: true, snap_to_keyframe: true, snap_to_beat: true });
checkOk(/cannot be combined/.test(snapBeatBoth), "trim snap_to_beat + snap_to_keyframe is refused (pick one grid)", snapBeatBoth.slice(0, 120));
const snapBeatSmart = await callExpectThrow("trim", { input: path.join(root, "test/beat-trim-source.mp4"), output: path.join(root, "outputs/mcp-trim-snapbeat-smart.mp4"), start: 1, duration: 2, stream_copy: true, smart_cut: true, snap_to_beat: true });
checkOk(/cannot be combined/.test(snapBeatSmart), "trim snap_to_beat + smart_cut is refused", snapBeatSmart.slice(0, 120));
// Dry-run: the plan reports the snapped beats and writes no file.
const drySnapBeatPath = path.join(root, "outputs/mcp-dry-trim-snapbeat.mp4");
const drySnapBeatRes = await client.callTool({ name: "trim", arguments: { input: path.join(root, "test/beat-trim-source.mp4"), output: drySnapBeatPath, start: 1.13, end: 3.27, snap_to_beat: true, dry_run: true } });
const drySnapBeatJson = JSON.parse(drySnapBeatRes.content[0].text);
checkOk(drySnapBeatJson.dry_run === true && drySnapBeatJson.snapped === true && near(drySnapBeatJson.beat_start, snapBeatStart, 0.001) && near(drySnapBeatJson.beat_end, snapBeatEnd, 0.001) && drySnapBeatJson.bpm === 120 && drySnapBeatJson.commands?.[0]?.includes(`-ss ${snapBeatStart}`), "trim dry-run with snap_to_beat reports the snapped beats in the plan", JSON.stringify(drySnapBeatJson).slice(0, 220));
checkOk(!existsSync(drySnapBeatPath), "trim dry-run (snap-beat) writes no file", drySnapBeatPath);

// trim --snap-beat-method dp (lượt 88): the same 1.13-3.27 window
// on the drifting take (test/beat-drift-trim.mp4, flat video over
// the 120 -> 132 click track). Expected edges are computed from the
// DP grid measured on the mp4 itself (probe-first — AAC decode
// shifts the phase a little, like the 23->24 beat trap in lượt 87),
// and the DP cut must land on DIFFERENT beats than the rigid grid
// cut on the same window, or the method flag changed nothing.
const driftMp4GridDp = await callBeatGrid(path.join(root, "test/beat-drift-trim.mp4"), { method: "dp" });
const driftMp4Grid = await callBeatGrid(path.join(root, "test/beat-drift-trim.mp4"));
const dpSnapStart = [...driftMp4GridDp.beats].reverse().find((t) => t <= 1.13) ?? 0;
const dpSnapEnd = driftMp4GridDp.beats.find((t) => t >= 3.27) ?? 12;
const gridSnapStart = [...driftMp4Grid.beats].reverse().find((t) => t <= 1.13) ?? 0;
const gridSnapEnd = driftMp4Grid.beats.find((t) => t >= 3.27) ?? 12;
console.log("trim snap-beat dp vs grid on drift mp4:", JSON.stringify({ dp: `${dpSnapStart}-${dpSnapEnd}`, grid: `${gridSnapStart}-${gridSnapEnd}`, dpDrift: driftMp4GridDp.tempo_drift_seconds }));
const snapBeatDpRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/beat-drift-trim.mp4"),
    output: path.join(root, "outputs/mcp-trim-snapbeat-dp.mp4"),
    start: 1.13, end: 3.27, snap_to_beat: true, snap_beat_method: "dp",
  },
});
const snapBeatDpJson = JSON.parse(snapBeatDpRes.content[0].text);
checkOk(snapBeatDpJson.snapped === true && near(snapBeatDpJson.start, dpSnapStart, 0.001) && near(snapBeatDpJson.beat_start, dpSnapStart, 0.001) && near(snapBeatDpJson.beat_end, dpSnapEnd, 0.001) && snapBeatDpJson.beat_method === "dp" && near(snapBeatDpJson.duration_seconds, dpSnapEnd - dpSnapStart, 0.001) && near(snapBeatDpJson.duration_actual, dpSnapEnd - dpSnapStart, 0.1), "trim snap_to_beat + snap_beat_method dp cuts on the DP beats (start down, end up)", JSON.stringify({ start: snapBeatDpJson.start, end: snapBeatDpJson.beat_end, method: snapBeatDpJson.beat_method }));
checkOk(dpSnapStart !== gridSnapStart || dpSnapEnd !== gridSnapEnd, "trim snap-beat dp lands on different beats than the rigid grid on a drifting take (the method flag changes the cut)", JSON.stringify({ dp: `${dpSnapStart}-${dpSnapEnd}`, grid: `${gridSnapStart}-${gridSnapEnd}` }));
checkOk(snapBeatDpJson.cut_verified === true, "trim snap-beat dp still verifies (flat fixture: all frames identical, so the moved cut matches)", JSON.stringify(snapBeatDpJson.check_frames_match));
const drySnapBeatDpRes = await client.callTool({ name: "trim", arguments: { input: path.join(root, "test/beat-drift-trim.mp4"), output: path.join(root, "outputs/mcp-dry-trim-snapbeat-dp.mp4"), start: 1.13, end: 3.27, snap_to_beat: true, snap_beat_method: "dp", dry_run: true } });
const drySnapBeatDpJson = JSON.parse(drySnapBeatDpRes.content[0].text);
checkOk(drySnapBeatDpJson.dry_run === true && drySnapBeatDpJson.beat_method === "dp" && near(drySnapBeatDpJson.beat_start, dpSnapStart, 0.001) && near(drySnapBeatDpJson.beat_end, dpSnapEnd, 0.001) && !existsSync(path.join(root, "outputs/mcp-dry-trim-snapbeat-dp.mp4")), "trim dry-run with snap_beat_method dp reports the DP beats and writes no file", JSON.stringify({ method: drySnapBeatDpJson.beat_method, start: drySnapBeatDpJson.beat_start }));
const snapBeatBadMethod = await callExpectThrow("trim", { input: path.join(root, "test/beat-drift-trim.mp4"), output: path.join(root, "outputs/mcp-trim-snapbeat-badmethod.mp4"), start: 1, duration: 2, snap_to_beat: true, snap_beat_method: "fft" });
checkOk(/method|Invalid enum/i.test(snapBeatBadMethod), "trim snap_to_beat refuses an unknown snap_beat_method", snapBeatBadMethod.slice(0, 160));

// bpm + beat_grid in batch + manifest (lượt 87): probe-only like
// hook — no file written, the measurement comes back in the row /
// step result, and the cache stores that result.
await rm(path.join(root, "outputs/mcp-batch-beat-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-beat-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-beat-in"), { recursive: true });
await copyFile(path.join(root, "test/bpm-click-120.wav"), path.join(root, "outputs/mcp-batch-beat-in/bpm-click-120.wav"));
await copyFile(path.join(root, "test/bpm-drum-120.wav"), path.join(root, "outputs/mcp-batch-beat-in/bpm-drum-120.wav"));
const beatBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "bpm", pattern: "*.wav", input_dir: path.join(root, "outputs/mcp-batch-beat-in"), output_dir: path.join(root, "outputs/mcp-batch-beat-out"), args: {}, jobs: 2 },
});
const beatBatchJson = JSON.parse(beatBatchRes.content[0].text);
console.log("batch bpm:", JSON.stringify(beatBatchJson.results.map((r) => ({ status: r.status, output: r.output, bpm: r.result?.bpm }))), "| suffix", beatBatchJson.output_suffix);
checkOk(beatBatchJson.succeeded === 2 && beatBatchJson.failed === 0 && beatBatchJson.output_suffix === null && beatBatchJson.results.every((r) => r.status === "ok" && r.output === null && near(r.result?.bpm, 120, 1)), "batch bpm measures 120 on both click tracks with no output file (output null, suffix null)", JSON.stringify(beatBatchJson.results.map((r) => r.result?.bpm)));
const beatBatchCacheRes = await client.callTool({
  name: "batch",
  arguments: { operation: "bpm", pattern: "*.wav", input_dir: path.join(root, "outputs/mcp-batch-beat-in"), output_dir: path.join(root, "outputs/mcp-batch-beat-out"), args: {}, jobs: 2 },
});
const beatBatchCacheJson = JSON.parse(beatBatchCacheRes.content[0].text);
checkOk(beatBatchCacheJson.cached === 2 && beatBatchCacheJson.succeeded === 0 && beatBatchCacheJson.results.every((r) => r.status === "cached" && near(r.result?.bpm, 120, 1)), "batch bpm second run serves both rows from the result cache", JSON.stringify(beatBatchCacheJson.results.map((r) => r.status)));
const gridBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "beat_grid", pattern: "bpm-click-120.wav", input_dir: path.join(root, "outputs/mcp-batch-beat-in"), output_dir: path.join(root, "outputs/mcp-batch-beat-out"), args: {}, jobs: 1 },
});
const gridBatchJson = JSON.parse(gridBatchRes.content[0].text);
checkOk(gridBatchJson.succeeded === 1 && gridBatchJson.results[0].output === null && gridBatchJson.results[0].result?.beat_count === 23 && gridBatchJson.results[0].result?.beats?.length === 23, "batch beat_grid returns the full 23-beat grid in the row result", JSON.stringify({ count: gridBatchJson.results[0].result?.beat_count }));
await rm(path.join(root, "outputs/mcp-manifest-beatgrid.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const beatManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-beatgrid.json") },
});
const beatManifestJson = JSON.parse(beatManifestRes.content[0].text);
console.log("manifest beat_grid:", JSON.stringify(beatManifestJson.steps.map((s) => ({ tool: s.tool, status: s.status, output: s.output, count: s.result?.beat_count ?? s.result?.duration_seconds }))), "| final", beatManifestJson.final?.duration_seconds);
// The mp4 decodes 24 beats locally but 23 on the CI apt ffmpeg —
// the 24th beat sits at 11.991s, 9ms before the file end, so the
// AAC decode tail decides whether the last onset is detected (CI
// run 1 of lượt 101 failed the old `=== 24`). Assert the grid
// itself instead of the count: 23 or 24 beats, first beat on the
// 0.488s phase, 0.5s spacing — a broken detector fails all three.
const beatGridStep = beatManifestJson.steps[0].result;
checkOk(beatManifestJson.steps_run === 2 && beatManifestJson.steps.every((s) => s.status === "ok") && beatManifestJson.steps[0].tool === "beat_grid" && (beatGridStep.beat_count === 23 || beatGridStep.beat_count === 24) && beatGridStep.beats?.length === beatGridStep.beat_count && near(beatGridStep.first_beat_seconds, 0.488, 0.05) && near(beatGridStep.beats[1] - beatGridStep.beats[0], 0.5, 0.02) && near(beatManifestJson.final.duration_seconds, snapBeatEnd - snapBeatStart, 0.1), "manifest beat_grid step records the 23/24-beat grid (mp4 tail beat varies by build), then trim snap_to_beat cuts on it", JSON.stringify(beatManifestJson.steps.map((s) => s.result?.beat_count ?? s.result?.duration_seconds)));
checkOk(beatManifestJson.steps[0].output === beatManifestJson.input && beatManifestJson.steps[1].output !== beatManifestJson.steps[0].output, "manifest beat_grid step passes the chain file through (its output is the input it analyzed)", beatManifestJson.steps[0].output);
const beatManifestCacheRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-beatgrid.json") },
});
const beatManifestCacheJson = JSON.parse(beatManifestCacheRes.content[0].text);
checkOk(beatManifestCacheJson.cache_hits === 2 && beatManifestCacheJson.steps.every((s) => s.status === "cached") && (beatManifestCacheJson.steps[0].result.beat_count === 23 || beatManifestCacheJson.steps[0].result.beat_count === 24), "manifest beat_grid re-run serves both steps from cache (grid result cached, trim file cached)", JSON.stringify(beatManifestCacheJson.steps.map((s) => s.status)));

// batch + manifest with the DP method (lượt 88): the method arg
// flows through the shared BATCH_OPERATIONS table, so batch rows
// and manifest steps both report grid_method dp + the drift.
await copyFile(path.join(root, "test/bpm-drift-120-132.wav"), path.join(root, "outputs/mcp-batch-beat-in/bpm-drift-120-132.wav"));
const gridDpBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "beat_grid", pattern: "bpm-drift-120-132.wav", input_dir: path.join(root, "outputs/mcp-batch-beat-in"), output_dir: path.join(root, "outputs/mcp-batch-beat-out"), args: { method: "dp" }, jobs: 1 },
});
const gridDpBatchJson = JSON.parse(gridDpBatchRes.content[0].text);
checkOk(gridDpBatchJson.succeeded === 1 && gridDpBatchJson.results[0].output === null && gridDpBatchJson.results[0].result?.grid_method === "dp" && gridDpBatchJson.results[0].result?.tempo_drift_seconds > 0.3, "batch beat_grid with args {method: dp} reports the DP track (grid_method dp, drift >0.3s)", JSON.stringify({ method: gridDpBatchJson.results[0].result?.grid_method, drift: gridDpBatchJson.results[0].result?.tempo_drift_seconds }));
const beatDpManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-beatgrid-dp.json") },
});
const beatDpManifestJson = JSON.parse(beatDpManifestRes.content[0].text);
console.log("manifest beat_grid dp:", JSON.stringify(beatDpManifestJson.steps.map((s) => ({ tool: s.tool, status: s.status, method: s.result?.grid_method ?? s.result?.beat_method, drift: s.result?.tempo_drift_seconds }))), "| final", beatDpManifestJson.final?.duration_seconds);
const dpManifestBeats = beatDpManifestJson.steps[0].result?.beats ?? [];
const dpManifestStart = [...dpManifestBeats].reverse().find((t) => t <= 1.13) ?? 0;
const dpManifestEnd = dpManifestBeats.find((t) => t >= 3.27) ?? 12;
checkOk(beatDpManifestJson.steps_run === 2 && beatDpManifestJson.steps.every((s) => s.status === "ok") && beatDpManifestJson.steps[0].result.grid_method === "dp" && beatDpManifestJson.steps[0].result.tempo_drift_seconds > 0.3 && beatDpManifestJson.steps[1].result.beat_method === "dp" && near(beatDpManifestJson.final.duration_seconds, dpManifestEnd - dpManifestStart, 0.1), "manifest beat_grid {method: dp} + trim snap_beat_method dp cuts on the DP beats", JSON.stringify({ drift: beatDpManifestJson.steps[0].result.tempo_drift_seconds, final: beatDpManifestJson.final?.duration_seconds }));
const beatDpManifestCacheRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-beatgrid-dp.json") },
});
const beatDpManifestCacheJson = JSON.parse(beatDpManifestCacheRes.content[0].text);
checkOk(beatDpManifestCacheJson.cache_hits === 2 && beatDpManifestCacheJson.steps.every((s) => s.status === "cached") && beatDpManifestCacheJson.steps[0].result.grid_method === "dp", "manifest beat_grid dp re-run serves both steps from cache", JSON.stringify(beatDpManifestCacheJson.steps.map((s) => s.status)));

// tempo_drift (lượt 89): the local tempo curve — windowed
// estimateTempo, 1s bins. Numbers are the ones measured on disk
// (probe + CLI): the 120->132 take reads start 122.7 / end 129.2 /
// delta +6.5 (the window cannot centre on the first/last ~2.4s, so
// the curve covers t=2..9 and start/end are the medians of the
// outer bins, not 120/132 themselves); the 132->120 take mirrors
// it at 129.5 -> 123.0 / delta -6.5.
async function callTempoDrift(input, extra = {}) {
  const res = await client.callTool({ name: "tempo_drift", arguments: { input, ...extra } });
  return JSON.parse(res.content[0].text);
}
const driftUp = await callTempoDrift(path.join(root, "test/bpm-drift-120-132.wav"));
console.log("tempo_drift 120->132:", JSON.stringify({ verdict: driftUp.verdict, dir: driftUp.direction, start: driftUp.start_bpm, end: driftUp.end_bpm, delta: driftUp.delta_bpm, curve: driftUp.tempo_curve.filter((b) => b.reliable).map((b) => b.bpm) }));
checkOk(driftUp.operation === "tempo_drift" && driftUp.verdict === "drifting" && driftUp.direction === "speeding_up" && driftUp.reliable === true && near(driftUp.start_bpm, 122.7, 1) && near(driftUp.end_bpm, 129.2, 1) && near(driftUp.delta_bpm, 6.5, 0.5) && driftUp.tempo_curve.filter((b) => b.reliable).length === 8 && near(driftUp.bpm, 125.9, 1), "tempo_drift reads the 120->132 take as drifting / speeding_up (122.7 -> 129.2, delta +6.5, 8 reliable bins)", JSON.stringify({ start: driftUp.start_bpm, end: driftUp.end_bpm, delta: driftUp.delta_bpm }));
const driftDown = await callTempoDrift(path.join(root, "test/bpm-drift-132-120.wav"));
checkOk(driftDown.verdict === "drifting" && driftDown.direction === "slowing_down" && near(driftDown.start_bpm, 129.5, 1) && near(driftDown.end_bpm, 123, 1) && near(driftDown.delta_bpm, -6.5, 0.5), "tempo_drift reads the 132->120 take as drifting / slowing_down (129.5 -> 123.0, delta -6.5)", JSON.stringify({ start: driftDown.start_bpm, end: driftDown.end_bpm, delta: driftDown.delta_bpm }));
const driftSteady = await callTempoDrift(path.join(root, "test/bpm-click-120.wav"));
checkOk(driftSteady.verdict === "steady" && driftSteady.direction === "steady" && near(driftSteady.start_bpm, 120, 0.5) && near(driftSteady.end_bpm, 120, 0.5) && Math.abs(driftSteady.delta_bpm) < 0.5 && driftSteady.tempo_curve.filter((b) => b.reliable).every((b) => near(b.bpm, 120, 0.5)), "tempo_drift reads the steady 120 track as steady (120 -> 120, delta 0)", JSON.stringify({ start: driftSteady.start_bpm, end: driftSteady.end_bpm, delta: driftSteady.delta_bpm }));
const drift90 = await callTempoDrift(path.join(root, "test/bpm-click-90.wav"));
checkOk(drift90.verdict === "steady" && near(drift90.start_bpm, 90, 0.5) && near(drift90.end_bpm, 90, 0.5), "tempo_drift reads the steady 90 track as steady (90 -> 90)", JSON.stringify({ start: drift90.start_bpm, end: drift90.end_bpm }));
const driftTone = await callTempoDrift(path.join(root, "test/mix-music.mp3"));
checkOk(driftTone.verdict === "unreliable" && driftTone.reliable === false && driftTone.tempo_curve.every((b) => !b.reliable) && driftTone.warnings.some((w) => /low confidence/.test(w)), "tempo_drift on a steady tone reports verdict unreliable (no reliable bins) instead of a confident curve", JSON.stringify({ verdict: driftTone.verdict, warnings: driftTone.warnings }));
const driftVideoOnly = await callExpectThrow("tempo_drift", { input: path.join(root, "test/content-video-only.mp4") });
checkOk(/needs an audio stream/.test(driftVideoOnly), "tempo_drift refuses video-only input", driftVideoOnly.slice(0, 120));
const driftShort = await callExpectThrow("tempo_drift", { input: path.join(root, "test/mix-music-short.mp3") });
checkOk(/at least 8s/.test(driftShort), "tempo_drift refuses files under 8s (analysis window needs the length)", driftShort.slice(0, 140));
const driftBadRange = await callExpectThrow("tempo_drift", { input: path.join(root, "test/bpm-click-120.wav"), min_bpm: 200, max_bpm: 100 });
checkOk(/must be below/.test(driftBadRange), "tempo_drift refuses min_bpm above max_bpm", driftBadRange.slice(0, 120));
// tempo_drift in batch + manifest (probe-only like bpm/beat_grid):
// the curve comes back in the row / step result, no file written.
const driftBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "tempo_drift", pattern: "bpm-drift-120-132.wav", input_dir: path.join(root, "outputs/mcp-batch-beat-in"), output_dir: path.join(root, "outputs/mcp-batch-beat-out"), args: {}, jobs: 1 },
});
const driftBatchJson = JSON.parse(driftBatchRes.content[0].text);
checkOk(driftBatchJson.succeeded === 1 && driftBatchJson.results[0].output === null && driftBatchJson.results[0].result?.verdict === "drifting" && near(driftBatchJson.results[0].result?.delta_bpm, 6.5, 0.5), "batch tempo_drift returns the drifting verdict + delta in the row result (no file)", JSON.stringify({ verdict: driftBatchJson.results[0].result?.verdict, delta: driftBatchJson.results[0].result?.delta_bpm }));
await rm(path.join(root, "outputs/mcp-manifest-tempodrift.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const driftManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-tempodrift.json") },
});
const driftManifestJson = JSON.parse(driftManifestRes.content[0].text);
console.log("manifest tempo_drift:", JSON.stringify(driftManifestJson.steps.map((s) => ({ tool: s.tool, status: s.status, verdict: s.result?.verdict ?? s.result?.beat_method, delta: s.result?.delta_bpm }))), "| final", driftManifestJson.final?.duration_seconds);
const tempoManifestGrid = await callBeatGrid(path.join(root, "test/beat-drift-trim.mp4"));
const driftManifestStart = [...tempoManifestGrid.beats].reverse().find((t) => t <= 1.13) ?? 0;
const driftManifestEnd = tempoManifestGrid.beats.find((t) => t >= 3.27) ?? 12;
checkOk(driftManifestJson.steps_run === 2 && driftManifestJson.steps.every((s) => s.status === "ok") && driftManifestJson.steps[0].tool === "tempo_drift" && driftManifestJson.steps[0].result.verdict === "drifting" && driftManifestJson.steps[0].result.direction === "speeding_up" && near(driftManifestJson.final.duration_seconds, driftManifestEnd - driftManifestStart, 0.1), "manifest tempo_drift step records the drifting verdict, then trim snap_to_beat cuts on the rigid grid", JSON.stringify({ verdict: driftManifestJson.steps[0].result?.verdict, final: driftManifestJson.final?.duration_seconds }));
checkOk(driftManifestJson.steps[0].output === driftManifestJson.input && driftManifestJson.steps[1].output !== driftManifestJson.steps[0].output, "manifest tempo_drift step passes the chain file through (its output is the input it analyzed)", driftManifestJson.steps[0].output);
const driftManifestCacheRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-tempodrift.json") },
});
const driftManifestCacheJson = JSON.parse(driftManifestCacheRes.content[0].text);
checkOk(driftManifestCacheJson.cache_hits === 2 && driftManifestCacheJson.steps.every((s) => s.status === "cached") && driftManifestCacheJson.steps[0].result.verdict === "drifting", "manifest tempo_drift re-run serves both steps from cache", JSON.stringify(driftManifestCacheJson.steps.map((s) => s.status)));

// motion --adaptive: two-pass calibration to the clip's own quiet
// quarter (floor = p25 of the curve, threshold = min(max(fixed,
// floor * factor), max(cap, fixed))). Light grain on a static shot
// straddles the fixed 0.001 (fixed: mostly-static, still only
// [3,6]); adaptive lifts the threshold to 0.00164 and the whole
// 6s reads still. Steady motion must survive the calibration: the
// ball, the bounce template and testsrc all stay moving at the
// 0.005 cap, and a frozen stretch keeps its still interval.
const motionAdaptNoiseRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-noise-light.mp4"), adaptive: true },
});
const motionAdaptNoiseJson = JSON.parse(motionAdaptNoiseRes.content[0].text);
console.log("motion adaptive noise-light:", motionAdaptNoiseJson.verdict, "| thr", motionAdaptNoiseJson.threshold, "| adapt", JSON.stringify(motionAdaptNoiseJson.adaptive), "| still", JSON.stringify(motionAdaptNoiseJson.still_intervals));
checkOk(motionAdaptNoiseJson.verdict === "static" && motionAdaptNoiseJson.threshold_mode === "adaptive" && near(motionAdaptNoiseJson.threshold, 0.00164, 0.0002) && near(motionAdaptNoiseJson.adaptive.floor_p25, 0.00082, 0.0001) && motionAdaptNoiseJson.adaptive.factor === 2 && motionAdaptNoiseJson.adaptive.capped === false && motionAdaptNoiseJson.still_intervals.length === 1 && motionAdaptNoiseJson.still_intervals[0].duration_seconds === 6, "motion adaptive: grainy static reads static (threshold 0.00164 from p25 0.00082 x2, still [0,6])", JSON.stringify(motionAdaptNoiseJson.still_intervals));
const motionFixedNoiseRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-noise-light.mp4") },
});
const motionFixedNoiseJson = JSON.parse(motionFixedNoiseRes.content[0].text);
checkOk(motionFixedNoiseJson.verdict === "mostly-static" && motionFixedNoiseJson.threshold_mode === "fixed" && motionFixedNoiseJson.adaptive === null && motionFixedNoiseJson.still_intervals.length === 1 && motionFixedNoiseJson.still_intervals[0].start_seconds === 3, "motion fixed: same grainy static flickers to mostly-static (still only [3,6]) — adaptive changes the answer", JSON.stringify(motionFixedNoiseJson.still_intervals));
const motionAdaptBallRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-ball.mp4"), adaptive: true },
});
const motionAdaptBallJson = JSON.parse(motionAdaptBallRes.content[0].text);
console.log("motion adaptive ball:", motionAdaptBallJson.verdict, "| thr", motionAdaptBallJson.threshold, "| adapt", JSON.stringify(motionAdaptBallJson.adaptive));
checkOk(motionAdaptBallJson.verdict === "moving" && motionAdaptBallJson.threshold === 0.005 && motionAdaptBallJson.adaptive.capped === true && near(motionAdaptBallJson.adaptive.raw_threshold, 0.0253, 0.001) && motionAdaptBallJson.still_intervals.length === 0, "motion adaptive: smooth ball stays moving (raw 0.0253 capped to 0.005)", `verdict=${motionAdaptBallJson.verdict} thr=${motionAdaptBallJson.threshold}`);
const motionAdaptBounceRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-bounce.mp4"), adaptive: true },
});
const motionAdaptBounceJson = JSON.parse(motionAdaptBounceRes.content[0].text);
console.log("motion adaptive bounce:", motionAdaptBounceJson.verdict, "| thr", motionAdaptBounceJson.threshold, "| adapt", JSON.stringify(motionAdaptBounceJson.adaptive), "| curve", motionAdaptBounceJson.motion_curve.map((w) => w.motion_fraction).join(","));
checkOk(motionAdaptBounceJson.verdict === "moving" && motionAdaptBounceJson.threshold === 0.005 && motionAdaptBounceJson.adaptive.capped === true && near(motionAdaptBounceJson.adaptive.raw_threshold, 0.0228, 0.001) && motionAdaptBounceJson.still_intervals.length === 0, "motion adaptive: bounce template stays moving (cap 0.005 under its slowest second 0.011)", `verdict=${motionAdaptBounceJson.verdict} thr=${motionAdaptBounceJson.threshold}`);
const motionAdaptSrcRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/source.mp4"), adaptive: true },
});
const motionAdaptSrcJson = JSON.parse(motionAdaptSrcRes.content[0].text);
checkOk(motionAdaptSrcJson.verdict === "moving" && motionAdaptSrcJson.threshold === 0.005 && motionAdaptSrcJson.adaptive.capped === true && motionAdaptSrcJson.still_intervals.length === 0, "motion adaptive: testsrc stays moving (threshold capped at 0.005)", `verdict=${motionAdaptSrcJson.verdict}`);
const motionAdaptFreezeRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/content-freeze.mp4"), adaptive: true },
});
const motionAdaptFreezeJson = JSON.parse(motionAdaptFreezeRes.content[0].text);
checkOk(motionAdaptFreezeJson.verdict === "mostly-static" && motionAdaptFreezeJson.still_intervals.length === 1 && motionAdaptFreezeJson.still_intervals[0].start_seconds === 5 && motionAdaptFreezeJson.still_intervals[0].end_seconds === 7, "motion adaptive: frozen stretch [5,7] survives calibration", JSON.stringify(motionAdaptFreezeJson.still_intervals));
const motionAdaptStaticRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/static-clip.mp4"), adaptive: true },
});
const motionAdaptStaticJson = JSON.parse(motionAdaptStaticRes.content[0].text);
checkOk(motionAdaptStaticJson.verdict === "static" && motionAdaptStaticJson.threshold === 0.001 && motionAdaptStaticJson.adaptive.capped === false && motionAdaptStaticJson.still_intervals[0].duration_seconds === 3, "motion adaptive: clean static keeps threshold 0.001 (floor 0)", `thr=${motionAdaptStaticJson.threshold}`);
const motionAdaptFactorRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-noise-light.mp4"), adaptive: true, adaptive_factor: 3 },
});
const motionAdaptFactorJson = JSON.parse(motionAdaptFactorRes.content[0].text);
checkOk(motionAdaptFactorJson.verdict === "static" && near(motionAdaptFactorJson.threshold, 0.00246, 0.0002), "motion adaptive: factor 3 lifts the grainy-static threshold to 0.00246", `thr=${motionAdaptFactorJson.threshold}`);
const motionAdaptBadFactor = await callExpectThrow("motion", { input: path.join(root, "test/motion-noise-light.mp4"), adaptive: true, adaptive_factor: 0 });
checkOk(/greater than or equal to 1/.test(motionAdaptBadFactor), "motion adaptive refuses factor 0 (zod schema; CLI refuses with the core message)", motionAdaptBadFactor.slice(0, 120));
const motionAdaptBadCap = await callExpectThrow("motion", { input: path.join(root, "test/motion-noise-light.mp4"), adaptive: true, adaptive_cap: 0 });
checkOk(/greater than or equal to 0\.0005/.test(motionAdaptBadCap), "motion adaptive refuses cap 0 (zod schema; CLI refuses with the core message)", motionAdaptBadCap.slice(0, 120));

// motion --lag-seconds: compare frames N seconds apart instead of
// adjacent frames, so motion too slow for one frame step becomes
// visible. The headline fixture is a 10s fade-in from black: the
// per-frame level change (+0.85 levels) sits under the >2-level
// binarization, so adjacent mode calls it static (energy 0.00043);
// at lag 2 the accumulated change is 51 levels and every pixel
// flips (energy 1.0). A creeping zoom (zoompan 0.0001/frame) is
// amplified 11x by lag 2 (0.00211 -> 0.02321). Still intervals in
// lag mode are corrected to clip time (end + lag, clamped): the
// freeze fixture is really testsrc [0,4) + red static [4,7) +
// testsrc [7,10), and lag 1 reports the true [4,7] — adjacent mode
// reports [5,7] because window [4,5) holds the freeze-onset
// transient. A still in the final lag seconds, or shorter than
// lag+1s, is not reported in lag mode.
const motionFadeAdjRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-fade-slow.mp4") },
});
const motionFadeAdjJson = JSON.parse(motionFadeAdjRes.content[0].text);
console.log("motion fade adjacent:", motionFadeAdjJson.verdict, "| energy", motionFadeAdjJson.motion_energy);
checkOk(motionFadeAdjJson.verdict === "static" && motionFadeAdjJson.motion_energy < 0.001 && motionFadeAdjJson.lag_seconds === 0, "motion: slow 10s fade-in reads static adjacent (energy 0.00043 < 0.001)", `energy=${motionFadeAdjJson.motion_energy} verdict=${motionFadeAdjJson.verdict}`);
const motionFadeLagRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-fade-slow.mp4"), lag_seconds: 2 },
});
const motionFadeLagJson = JSON.parse(motionFadeLagRes.content[0].text);
console.log("motion fade lag2:", motionFadeLagJson.verdict, "| energy", motionFadeLagJson.motion_energy, "| frames", motionFadeLagJson.frames_analyzed, "| curve", motionFadeLagJson.motion_curve.map((w) => w.motion_fraction).join(","));
checkOk(motionFadeLagJson.verdict === "moving" && motionFadeLagJson.motion_energy > 0.9 && motionFadeLagJson.frames_analyzed === 8 && motionFadeLagJson.motion_curve.length === 8 && motionFadeLagJson.lag_seconds === 2 && motionFadeLagJson.still_intervals.length === 0, "motion lag: same fade reads moving at lag 2 (energy ~1.0, 8 lag pairs, no still)", `energy=${motionFadeLagJson.motion_energy} verdict=${motionFadeLagJson.verdict}`);
const motionZoomAdjRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-zoom-slow2.mp4") },
});
const motionZoomAdjJson = JSON.parse(motionZoomAdjRes.content[0].text);
const motionZoomLagRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/motion-zoom-slow2.mp4"), lag_seconds: 2 },
});
const motionZoomLagJson = JSON.parse(motionZoomLagRes.content[0].text);
console.log("motion zoom-slow adjacent vs lag2:", motionZoomAdjJson.motion_energy, "->", motionZoomLagJson.motion_energy);
checkOk(motionZoomLagJson.verdict === "moving" && motionZoomLagJson.motion_energy > 0.02 && motionZoomLagJson.motion_energy > 5 * motionZoomAdjJson.motion_energy, "motion lag: creeping zoom amplified 11x by lag 2 (0.00211 -> 0.02321)", `adjacent=${motionZoomAdjJson.motion_energy} lag2=${motionZoomLagJson.motion_energy}`);
const motionFreezeLagRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/content-freeze.mp4"), lag_seconds: 1 },
});
const motionFreezeLagJson = JSON.parse(motionFreezeLagRes.content[0].text);
console.log("motion freeze lag1:", motionFreezeLagJson.verdict, "| still", JSON.stringify(motionFreezeLagJson.still_intervals), "| moving_fraction", motionFreezeLagJson.moving_fraction);
checkOk(motionFreezeLagJson.verdict === "mostly-static" && motionFreezeLagJson.still_intervals.length === 1 && motionFreezeLagJson.still_intervals[0].start_seconds === 4 && motionFreezeLagJson.still_intervals[0].end_seconds === 7 && motionFreezeLagJson.still_intervals[0].duration_seconds === 3 && motionFreezeLagJson.moving_fraction === 0.7, "motion lag: freeze reports true [4,7] at lag 1 (end corrected +lag, not adjacent [5,7])", JSON.stringify(motionFreezeLagJson.still_intervals));
const motionStaticLagRes = await client.callTool({
  name: "motion",
  arguments: { input: path.join(root, "test/static-clip.mp4"), lag_seconds: 2 },
});
const motionStaticLagJson = JSON.parse(motionStaticLagRes.content[0].text);
checkOk(motionStaticLagJson.verdict === "static" && motionStaticLagJson.still_intervals.length === 1 && motionStaticLagJson.still_intervals[0].start_seconds === 0 && motionStaticLagJson.still_intervals[0].end_seconds === 3 && motionStaticLagJson.frames_analyzed === 1, "motion lag: static clip still [0,3] at lag 2 (corrected end clamped to duration, 1 lag pair)", JSON.stringify(motionStaticLagJson.still_intervals));
const motionLagTooLong = await callExpectThrow("motion", { input: path.join(root, "test/source.mp4"), lag_seconds: 10 });
checkOk(/must be less than the clip duration/.test(motionLagTooLong), "motion lag refuses lag >= duration", motionLagTooLong.slice(0, 120));
const motionLagFraction = await callExpectThrow("motion", { input: path.join(root, "test/source.mp4"), lag_seconds: 0.5 });
checkOk(/integer/i.test(motionLagFraction), "motion lag refuses fractional lag_seconds (zod int; CLI refuses with the core message)", motionLagFraction.slice(0, 120));

const keyframesRes = await client.callTool({
  name: "keyframes",
  arguments: { input: path.join(root, "test/source.mp4") },
});
const keyframesJson = JSON.parse(keyframesRes.content[0].text);
console.log("keyframes call: count", keyframesJson.count, "| timestamps", keyframesJson.keyframe_timestamps.join(","), "| gop", JSON.stringify(keyframesJson.gop_seconds));
checkOk(keyframesJson.count === 2 && keyframesJson.keyframe_timestamps[0] === 0 && near(keyframesJson.keyframe_timestamps[1], 8.333, 0.01), "keyframes are [0, 8.333]", keyframesJson.keyframe_timestamps.join(","));
checkOk(keyframesJson.nearest === null, "keyframes without nearest reports nearest null (backwards compatible)", JSON.stringify(keyframesJson.nearest));

// keyframes --nearest (lượt 118, idea: bariswha/losslesscut-mcp):
// the keyframe nearest one cut point, so a caller picks a snap
// target without scanning the whole list. Fixture source.mp4:
// keyframes [0, 8.333], duration 10s.
const kfNear35Res = await client.callTool({
  name: "keyframes",
  arguments: { input: path.join(root, "test/source.mp4"), nearest: 3.5 },
});
const kfNear35Json = JSON.parse(kfNear35Res.content[0].text);
console.log("keyframes nearest 3.5:", JSON.stringify(kfNear35Json.nearest));
checkOk(kfNear35Json.nearest?.before === 0 && near(kfNear35Json.nearest?.after, 8.333, 0.01) && kfNear35Json.nearest?.closest === 0 && kfNear35Json.nearest?.distance_seconds === 3.5 && kfNear35Json.nearest?.direction === "before", "keyframes nearest 3.5: before 0, after 8.333, closest 0, distance 3.5, direction before", JSON.stringify(kfNear35Json.nearest));
const kfNear5Res = await client.callTool({
  name: "keyframes",
  arguments: { input: path.join(root, "test/source.mp4"), nearest: 5 },
});
const kfNear5Json = JSON.parse(kfNear5Res.content[0].text);
checkOk(kfNear5Json.nearest?.before === 0 && near(kfNear5Json.nearest?.after, 8.333, 0.01) && near(kfNear5Json.nearest?.closest, 8.333, 0.01) && near(kfNear5Json.nearest?.distance_seconds, 3.333, 0.01) && kfNear5Json.nearest?.direction === "after", "keyframes nearest 5: closest is 8.333 (3.333 away vs 5 to 0), direction after", JSON.stringify(kfNear5Json.nearest));
const kfNearExactRes = await client.callTool({
  name: "keyframes",
  arguments: { input: path.join(root, "test/source.mp4"), nearest: 8.333 },
});
const kfNearExactJson = JSON.parse(kfNearExactRes.content[0].text);
checkOk(near(kfNearExactJson.nearest?.before, 8.333, 0.01) && near(kfNearExactJson.nearest?.after, 8.333, 0.01) && near(kfNearExactJson.nearest?.closest, 8.333, 0.01) && kfNearExactJson.nearest?.distance_seconds === 0 && kfNearExactJson.nearest?.direction === "exact", "keyframes nearest 8.333: exact hit on the keyframe, distance 0", JSON.stringify(kfNearExactJson.nearest));
const kfNearPastEnd = await callExpectThrow("keyframes", { input: path.join(root, "test/source.mp4"), nearest: 10.5 });
checkOk(/past the end/.test(kfNearPastEnd), "keyframes nearest past the end is refused", kfNearPastEnd.slice(0, 120));
const kfNearNegative = await callExpectThrow("keyframes", { input: path.join(root, "test/source.mp4"), nearest: -1 });
checkOk(/greater than or equal to 0/i.test(kfNearNegative), "keyframes nearest refuses a negative time", kfNearNegative.slice(0, 120));
// CLI wiring: --nearest is an accepted option (validateOpts would
// exit 2 on an unknown flag) and accepts MM:SS.
const kfCliNear = await execFileAsync("node", [path.join(root, "bin/mediakit.js"), "keyframes", path.join(root, "test/source.mp4"), "--nearest", "0:05"]);
const kfCliNearJson = JSON.parse(kfCliNear.stdout);
checkOk(near(kfCliNearJson.nearest?.closest, 8.333, 0.01) && kfCliNearJson.nearest?.direction === "after" && kfCliNearJson.nearest?.requested_seconds === 5, "CLI keyframes --nearest 0:05 parses MM:SS and reports closest 8.333", kfCliNear.stdout.slice(0, 200));

// audio_levels (lượt 119, ideas: WyattBlue/auto-editor `levels` +
// bariswha/losslesscut-mcp audio_levels): loudness curve per bucket
// + pickPeaks. Fixture levels-source.wav, 12s: quiet [0,3) / loud
// [3,6) / silent [6,9) / medium [9,12) — a 4096-sample frame
// straddles each switch, so bucket [2,3) is mixed (rms -34.42, peak
// already loud) and buckets [6,7)/[7,8)/[8,9) are true silence
// (astats -inf -> nulls). Values below are measured ground truth
// (volumedetect cross-check per second: -51.5 / -21.1 / -91 / -31.5).
const levelsRes = await client.callTool({
  name: "audio_levels",
  arguments: { input: path.join(root, "test/levels-source.wav"), top_n: 3 },
});
const levelsJson = JSON.parse(levelsRes.content[0].text);
console.log("audio_levels:", JSON.stringify(levelsJson.summary), "| peaks", JSON.stringify(levelsJson.peaks.map((p) => p.start)));
checkOk(levelsJson.bucket_count === 12 && levelsJson.duration_seconds === 12 && levelsJson.buckets.length === 12, "audio_levels returns 12 one-second buckets for the 12s fixture", JSON.stringify(levelsJson.buckets.length));
checkOk(near(levelsJson.buckets[0].rms_db, -51.53, 0.5) && near(levelsJson.buckets[0].peak_db, -48.51, 0.5), "audio_levels bucket 0 (quiet tone): rms -51.53, peak -48.51", JSON.stringify(levelsJson.buckets[0]));
checkOk(near(levelsJson.buckets[2].rms_db, -34.42, 2) && near(levelsJson.buckets[2].peak_db, -18.06, 0.5), "audio_levels bucket 2 (frame straddling the 3s switch): mixed rms -34.42, peak already loud -18.06", JSON.stringify(levelsJson.buckets[2]));
checkOk(near(levelsJson.buckets[3].rms_db, -21.07, 0.5) && near(levelsJson.buckets[9].rms_db, -31.53, 0.5), "audio_levels buckets 3 (loud) and 9 (medium): rms -21.07 / -31.53", JSON.stringify([levelsJson.buckets[3], levelsJson.buckets[9]]));
checkOk(levelsJson.buckets[6].rms_db === null && levelsJson.buckets[6].peak_db === null && levelsJson.buckets[7].rms_db === null && levelsJson.buckets[8].rms_db === null, "audio_levels silent buckets 6-8 report nulls, never a fake -inf", JSON.stringify(levelsJson.buckets.slice(6, 9)));
checkOk(near(levelsJson.summary.max_peak_db, -18.06, 0.5) && near(levelsJson.summary.mean_rms_db, -25.51, 1.5) && near(levelsJson.summary.dynamic_range_db, 30.46, 1.5) && levelsJson.summary.silent_buckets === 3 && levelsJson.summary.loudest_bucket?.start === 2, "audio_levels summary: max peak -18.06, mean rms -25.51, dynamic range 30.46, 3 silent buckets, loudest bucket starts at 2", JSON.stringify(levelsJson.summary));
checkOk(levelsJson.peaks.map((p) => p.start).join(",") === "2,4,9" && near(levelsJson.peaks[0].peak_db, -18.06, 0.5) && near(levelsJson.peaks[2].peak_db, -28.52, 0.5), "audio_levels peaks (top 3, min_gap 2): 2, 4, 9 — the loud run contributes 2 and 4, not 2, 3, 4", JSON.stringify(levelsJson.peaks));
// top_n 0: curve only, no peaks. Half-second buckets: 24 buckets.
const levelsTop0Res = await client.callTool({ name: "audio_levels", arguments: { input: path.join(root, "test/levels-source.wav"), top_n: 0 } });
const levelsTop0Json = JSON.parse(levelsTop0Res.content[0].text);
checkOk(levelsTop0Json.peaks.length === 0 && levelsTop0Json.buckets.length === 12, "audio_levels top_n 0 returns the curve with no peaks", JSON.stringify(levelsTop0Json.peaks));
const levelsHalfRes = await client.callTool({ name: "audio_levels", arguments: { input: path.join(root, "test/levels-source.wav"), bucket_seconds: 0.5 } });
const levelsHalfJson = JSON.parse(levelsHalfRes.content[0].text);
checkOk(levelsHalfJson.bucket_count === 24 && near(levelsHalfJson.buckets[6].rms_db, -21.07, 0.5) && levelsHalfJson.buckets[6].start === 3, "audio_levels bucket 0.5s: 24 buckets, bucket [3,3.5) rms -21.07", JSON.stringify(levelsHalfJson.buckets[6]));
// Refusals: no audio stream; bucket cap (400s file at 0.1s = 4000 buckets).
const levelsNoAudio = await callExpectThrow("audio_levels", { input: path.join(root, "test/broll-blue-noaudio.mp4") });
checkOk(/needs an audio stream/.test(levelsNoAudio), "audio_levels refuses an input with no audio stream", levelsNoAudio.slice(0, 120));
const levelsCap = await callExpectThrow("audio_levels", { input: path.join(root, "test/levels-long.mp3"), bucket_seconds: 0.1 });
checkOk(/cap 3600/.test(levelsCap), "audio_levels refuses a bucket grid over the 3600 cap (400s at 0.1s)", levelsCap.slice(0, 120));
// CLI wiring: kebab-case command, --bucket/--top/--min-gap options,
// min_gap 0 keeps adjacent buckets (peaks 2.5, 3).
const levelsCli = await execFileAsync("node", [path.join(root, "bin/mediakit.js"), "audio-levels", path.join(root, "test/levels-source.wav"), "--bucket", "0.5", "--top", "2", "--min-gap", "0"]);
const levelsCliJson = JSON.parse(levelsCli.stdout);
checkOk(levelsCliJson.bucket_count === 24 && levelsCliJson.peaks.map((p) => p.start).join(",") === "2.5,3", "CLI audio-levels --bucket 0.5 --top 2 --min-gap 0: peaks 2.5, 3 (adjacent buckets kept)", levelsCli.stdout.slice(0, 200));
// audio_levels in batch (lượt 119): probe-only like hook — no output
// file, the curve comes back in the row's result, and the cache
// stores that result.
await rm(path.join(root, "outputs/mcp-batch-levels-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-levels-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-levels-in"), { recursive: true });
await copyFile(path.join(root, "test/levels-source.wav"), path.join(root, "outputs/mcp-batch-levels-in/levels-source.wav"));
const levelsBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "audio_levels", pattern: "*.wav", input_dir: path.join(root, "outputs/mcp-batch-levels-in"), output_dir: path.join(root, "outputs/mcp-batch-levels-out"), args: { bucket_seconds: 1, top_n: 2 }, jobs: 1 },
});
const levelsBatchJson = JSON.parse(levelsBatchRes.content[0].text);
checkOk(levelsBatchJson.succeeded === 1 && levelsBatchJson.failed === 0 && levelsBatchJson.results[0].output === null && levelsBatchJson.results[0].result.peaks.map((p) => p.start).join(",") === "2,4", "batch audio_levels: one row, no output file, peaks 2, 4 in the row result", JSON.stringify(levelsBatchJson.results.map((r) => r.result?.peaks)));
const levelsBatchCacheRes = await client.callTool({
  name: "batch",
  arguments: { operation: "audio_levels", pattern: "*.wav", input_dir: path.join(root, "outputs/mcp-batch-levels-in"), output_dir: path.join(root, "outputs/mcp-batch-levels-out"), args: { bucket_seconds: 1, top_n: 2 }, jobs: 1 },
});
const levelsBatchCacheJson = JSON.parse(levelsBatchCacheRes.content[0].text);
checkOk(levelsBatchCacheJson.cached === 1 && levelsBatchCacheJson.results[0].status === "cached" && levelsBatchCacheJson.results[0].result.peaks.length === 2, "batch audio_levels second run serves the row from the result cache", JSON.stringify(levelsBatchCacheJson.results.map((r) => r.status)));
// audio_levels in manifest (lượt 119): probe-only step records the
// curve and passes the chain file through, then trim cuts the
// loudest bucket's window.
const levelsManifestPath = path.join(root, "outputs", "manifest-levels.json");
await writeFile(levelsManifestPath, JSON.stringify({ version: 1, input: path.join(root, "test/levels-source.wav"), output: path.join(root, "outputs/mcp-manifest-levels.wav"), steps: [{ tool: "audio_levels", args: { bucket_seconds: 1, top_n: 2 } }, { tool: "trim", args: { start: 2, end: 3 } }] }), "utf8");
await rm(path.join(root, "outputs/mcp-manifest-levels.wav"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const levelsManifestRes = await client.callTool({ name: "manifest", arguments: { manifest_path: levelsManifestPath } });
const levelsManifestJson = JSON.parse(levelsManifestRes.content[0].text);
checkOk(levelsManifestJson.steps_run === 2 && levelsManifestJson.steps.every((s) => s.status === "ok") && levelsManifestJson.steps[0].tool === "audio_levels" && levelsManifestJson.steps[0].output === levelsManifestJson.input && levelsManifestJson.steps[0].result.peaks.map((p) => p.start).join(",") === "2,4" && near(levelsManifestJson.final.duration_seconds, 1, 0.05), "manifest audio_levels step records peaks 2, 4 and passes the file through, then trim cuts 1s (final 1s)", JSON.stringify(levelsManifestJson.steps.map((s) => s.result?.peaks ?? s.result?.duration_seconds)));

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

// smart_cut (idea: LosslessCut): stream-copy trim with an exact
// start — only the head up to the next keyframe is re-encoded.
// Fixture test/gop1s.mp4 has a keyframe every 1s (10s, 30fps).
const smartRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/gop1s.mp4"),
    output: path.join(root, "outputs/mcp-trim-smartcut.mp4"),
    start: 2.5, duration: 4, stream_copy: true, smart_cut: true,
  },
});
const smartJson = JSON.parse(smartRes.content[0].text);
console.log("trim smart-cut call:", smartJson.mode, "| next kf", smartJson.next_keyframe, "| head", smartJson.head_reencoded_seconds + "s", "| bitrate", smartJson.head_bitrate_bps, "| duration_actual", smartJson.duration_actual + "s", "| error", smartJson.duration_error_seconds + "s");
checkOk(smartJson.mode === "smart-cut" && smartJson.next_keyframe === 3 && smartJson.head_reencoded_seconds === 0.5 && smartJson.head_bitrate_bps === 200803 && smartJson.stream_copy === true, "trim smart_cut re-encodes only the 0.5s head to keyframe 3 at source bitrate x1.2", JSON.stringify({ mode: smartJson.mode, next: smartJson.next_keyframe, head: smartJson.head_reencoded_seconds, br: smartJson.head_bitrate_bps }));
checkOk(near(smartJson.duration_actual, 4, 0.05) && near(smartJson.duration_error_seconds, 0, 0.05), "trim smart_cut lands on 4s (error ~0)", `got actual ${smartJson.duration_actual}s, error ${smartJson.duration_error_seconds}s`);
const smartFrames = await countFrames(path.join(root, "outputs/mcp-trim-smartcut.mp4"));
checkOk(smartFrames === 120, "trim smart_cut has exactly 120 frames (4s x 30fps, no B-frame overshoot)", `got ${smartFrames}`);
// Pixel-verify both halves with bandPsnrAt (full frame): the
// re-encoded head must show the same picture as the source at the
// same content time (PSNR > 30 dB), and the stream-copied tail
// must be bit-identical (PSNR inf).
const smartHeadPsnr = await bandPsnrAt(path.join(root, "outputs/mcp-trim-smartcut.mp4"), 0.1, path.join(root, "test/gop1s.mp4"), 2.6, 0, 720);
checkOk(smartHeadPsnr !== null && smartHeadPsnr > 30, "trim smart_cut head frame matches the source at 2.6s (PSNR > 30 dB)", `got PSNR ${smartHeadPsnr}`);
const smartTailPsnr = await bandPsnrAt(path.join(root, "outputs/mcp-trim-smartcut.mp4"), 1.0, path.join(root, "test/gop1s.mp4"), 3.5, 0, 720);
checkOk(smartTailPsnr === Infinity, "trim smart_cut tail frame is bit-identical to the source at 3.5s (stream-copied)", `got PSNR ${smartTailPsnr}`);
// Start exactly on a keyframe: no re-encode at all.
const smartExactRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/gop1s.mp4"),
    output: path.join(root, "outputs/mcp-trim-smartcut-exact.mp4"),
    start: 3, duration: 2, stream_copy: true, smart_cut: true,
  },
});
const smartExactJson = JSON.parse(smartExactRes.content[0].text);
checkOk(smartExactJson.mode === "keyframe-exact" && smartExactJson.head_reencoded_seconds === 0 && smartExactJson.next_keyframe === 3, "trim smart_cut on a keyframe copies with no re-encode", `got mode=${smartExactJson.mode}, head=${smartExactJson.head_reencoded_seconds}`);
// Whole request inside one GOP: full re-encode.
const smartFullRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/gop1s.mp4"),
    output: path.join(root, "outputs/mcp-trim-smartcut-full.mp4"),
    start: 2.5, duration: 0.4, stream_copy: true, smart_cut: true,
  },
});
const smartFullJson = JSON.parse(smartFullRes.content[0].text);
checkOk(smartFullJson.mode === "full-reencode" && near(smartFullJson.duration_actual, 0.4, 0.05), "trim smart_cut inside one GOP re-encodes the whole clip", `got mode=${smartFullJson.mode}, actual=${smartFullJson.duration_actual}`);
// Refusals: needs stream_copy, refuses snap, needs video.
const smartNoCopy = await callExpectThrow("trim", { input: path.join(root, "test/gop1s.mp4"), output: path.join(root, "outputs/mcp-trim-smartcut-nocopy.mp4"), start: 2.5, duration: 4, smart_cut: true });
checkOk(/needs stream_copy/.test(smartNoCopy), "trim smart_cut without stream_copy is refused", smartNoCopy.slice(0, 120));
const smartSnap = await callExpectThrow("trim", { input: path.join(root, "test/gop1s.mp4"), output: path.join(root, "outputs/mcp-trim-smartcut-snap.mp4"), start: 2.5, duration: 4, stream_copy: true, snap_to_keyframe: true, smart_cut: true });
checkOk(/cannot be combined/.test(smartSnap), "trim smart_cut + snap_to_keyframe is refused", smartSnap.slice(0, 120));
const smartAudio = await callExpectThrow("trim", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-trim-smartcut-audio.mp3"), start: 1, duration: 2, stream_copy: true, smart_cut: true });
checkOk(/needs a video input/.test(smartAudio), "trim smart_cut refuses audio-only input", smartAudio.slice(0, 120));

// clean_voice (idea: marvtub/takes-public clean_voice.py, lượt 131):
// diagnose first, then the chain once in float. Fixtures are
// synthetic speech-like takes with known defects (see
// test/make-cleanvoice-fixtures.mjs) — the assertions below use the
// numbers measured from those files, not guesses.
const cvCleanPath = path.join(root, "test/cleanvoice-clean.wav");
const cvHumPath = path.join(root, "test/cleanvoice-hum.wav");
const cvClipPath = path.join(root, "test/cleanvoice-clipped.wav");
const cvEchoPath = path.join(root, "test/cleanvoice-echo.wav");
async function callCleanVoice(input, extra = {}) {
  const res = await client.callTool({ name: "clean_voice", arguments: { input, ...extra } });
  return JSON.parse(res.content[0].text);
}
const cvDiagClean = await callCleanVoice(cvCleanPath, { diagnose_only: true });
checkOk(JSON.stringify(cvDiagClean.steps) === JSON.stringify([]) && cvDiagClean.diagnosis.bandwidth_hz === 24000 && cvDiagClean.diagnosis.echo_tail_db < -24 && cvDiagClean.diagnosis.clipped_runs === 0 && cvDiagClean.diagnosis.hum_db < 12, "clean_voice --diagnose on the clean fixture: chain only, bw 24000 Hz, echo below -24 dB, no clipping, no hum", JSON.stringify(cvDiagClean.diagnosis));
const cvDiagHum = await callCleanVoice(cvHumPath, { diagnose_only: true });
checkOk(JSON.stringify(cvDiagHum.steps) === JSON.stringify(["dehum"]) && cvDiagHum.diagnosis.hum_db > 12 && cvDiagHum.diagnosis.hum_hz === 50, "clean_voice --diagnose on the hum fixture: dehum only, 50 Hz hum above 12 dB", JSON.stringify(cvDiagHum.diagnosis));
const cvDiagEcho = await callCleanVoice(cvEchoPath, { diagnose_only: true });
checkOk(JSON.stringify(cvDiagEcho.steps) === JSON.stringify(["clearvoice"]) && cvDiagEcho.diagnosis.echo_tail_db > -24 && cvDiagEcho.unavailable.length === 1 && cvDiagEcho.unavailable[0].step === "clearvoice", "clean_voice --diagnose on the echo fixture: clearvoice only, echo tail above -24 dB, reported unavailable (no ClearVoice engine)", JSON.stringify(cvDiagEcho.diagnosis));
const cvDiagKokoro = await callCleanVoice(path.join(root, "test/kokoro-voice.wav"), { diagnose_only: true });
checkOk(JSON.stringify(cvDiagKokoro.steps) === JSON.stringify(["sr"]) && cvDiagKokoro.diagnosis.bandwidth_hz < 15000 && cvDiagKokoro.unavailable[0].step === "sr", "clean_voice --diagnose on 24 kHz Kokoro speech: sr only (bandwidth below 15 kHz), reported unavailable", JSON.stringify(cvDiagKokoro.diagnosis));
// Full run on the clean fixture: LUFS -14 on disk (independent
// loudnorm measurement, not the tool's own report), 48 kHz mono
// float WAV, no new clipping, echo still below -24 dB, sync within
// a few ms, report sidecar on disk.
const cvCleanOut = path.join(root, "outputs/mcp-clean-voice-clean.wav");
const cvClean = await callCleanVoice(cvCleanPath, { output: cvCleanOut });
const cvCleanLufs = await measureLufs(cvCleanOut);
const cvCleanProbe = JSON.parse((await client.callTool({ name: "probe", arguments: { input: cvCleanOut } })).content[0].text);
checkOk(near(cvCleanLufs, -14, 0.5) && near(cvClean.out.lufs, -14, 0.5) && cvCleanProbe.audio?.sample_rate === 48000 && cvCleanProbe.audio?.channels === 1 && cvCleanProbe.audio?.codec === "pcm_f32le" && near(cvCleanProbe.duration_seconds, 12, 0.05), "clean_voice run on the clean fixture: -14 LUFS on disk, 48 kHz mono float WAV, 12 s", `lufs=${cvCleanLufs} codec=${cvCleanProbe.audio?.codec} sr=${cvCleanProbe.audio?.sample_rate}`);
checkOk(cvClean.out.clipped_runs === 0 && cvClean.echo_after_db < -24 && Math.abs(cvClean.out.sync_ms ?? 99) <= 10 && near(cvClean.out.seconds, 12, 0.05), "clean_voice run: no clipping introduced, echo tail still below -24 dB, sync drift within 10 ms", JSON.stringify(cvClean.out));
const cvReport = JSON.parse(await readFile(cvCleanOut.slice(0, -4) + ".report.json", "utf8"));
checkOk(JSON.stringify(cvReport.steps) === JSON.stringify([]) && cvReport.diagnosis.peak_dbfs === cvClean.diagnosis.peak_dbfs && near(cvReport.out.lufs, -14, 0.5), "clean_voice writes OUT.report.json with the diagnosis, the plan and the measured output", JSON.stringify({ steps: cvReport.steps, lufs: cvReport.out.lufs }));
// Dehum run: the 50 Hz line is gone on disk (re-diagnose the
// output through the tool itself) and the file still hits -14.
const cvHumOut = path.join(root, "outputs/mcp-clean-voice-hum.wav");
const cvHum = await callCleanVoice(cvHumPath, { output: cvHumOut });
const cvHumAfter = await callCleanVoice(cvHumOut, { diagnose_only: true });
checkOk(JSON.stringify(cvHum.steps) === JSON.stringify(["dehum"]) && cvHumAfter.diagnosis.hum_db < 12 && cvHumAfter.diagnosis.noise_floor_db < cvDiagHum.diagnosis.noise_floor_db && near(await measureLufs(cvHumOut), -14, 0.5), "clean_voice run on the hum fixture: dehum step, hum below 12 dB afterwards, floor dropped, -14 LUFS", `hum_after=${cvHumAfter.diagnosis.hum_db} floor ${cvDiagHum.diagnosis.noise_floor_db} -> ${cvHumAfter.diagnosis.noise_floor_db}`);
// Declip run: 1351 clipped runs in, 0 out.
const cvClipOut = path.join(root, "outputs/mcp-clean-voice-clipped.wav");
const cvClip = await callCleanVoice(cvClipPath, { output: cvClipOut });
checkOk(JSON.stringify(cvClip.steps) === JSON.stringify(["declip"]) && cvClip.diagnosis.clipped_runs > 20 && cvClip.out.clipped_runs === 0 && near(await measureLufs(cvClipOut), -14, 0.5), "clean_voice run on the clipped fixture: declip step, clipped runs 1351 -> 0, -14 LUFS", `runs ${cvClip.diagnosis.clipped_runs} -> ${cvClip.out.clipped_runs}`);
// Refusals: a plan that needs clearvoice/sr refuses loudly, and
// the --steps override is the documented way around it.
const cvEchoRefuse = await callExpectThrow("clean_voice", { input: cvEchoPath, output: path.join(root, "outputs/mcp-clean-voice-echo.wav") });
checkOk(/needs clearvoice/.test(cvEchoRefuse) && /ClearVoice engine/.test(cvEchoRefuse), "clean_voice refuses an echoey take that needs clearvoice (names the engine, does not clean without it)", cvEchoRefuse.slice(0, 160));
const cvSrRefuse = await callExpectThrow("clean_voice", { input: path.join(root, "test/kokoro-voice.wav"), output: path.join(root, "outputs/mcp-clean-voice-kokoro.wav") });
checkOk(/needs sr/.test(cvSrRefuse) && /ClearVoice engine/.test(cvSrRefuse), "clean_voice refuses 24 kHz speech that needs sr (names the engine)", cvSrRefuse.slice(0, 160));
const cvKokoroSteps = await callCleanVoice(path.join(root, "test/kokoro-voice.wav"), { output: path.join(root, "outputs/mcp-clean-voice-kokoro-steps.wav"), steps: ["none"] });
checkOk(JSON.stringify(cvKokoroSteps.steps) === JSON.stringify([]) && near(await measureLufs(path.join(root, "outputs/mcp-clean-voice-kokoro-steps.wav")), -14, 0.5), "clean_voice --steps none runs chain-only on the Kokoro take and still hits -14 LUFS", `lufs=${await measureLufs(path.join(root, "outputs/mcp-clean-voice-kokoro-steps.wav"))}`);
const cvBadStepsMcp = await callExpectThrow("clean_voice", { input: cvCleanPath, output: path.join(root, "outputs/mcp-clean-voice-bad.wav"), steps: ["bogus"] });
checkOk(/unknown step/.test(cvBadStepsMcp) && /bogus/.test(cvBadStepsMcp), "clean_voice refuses an unknown --steps name instead of silently dropping it", cvBadStepsMcp.slice(0, 120));
const cvMp3 = await callExpectThrow("clean_voice", { input: cvCleanPath, output: path.join(root, "outputs/mcp-clean-voice-x.mp3") });
checkOk(/must end in \.wav/.test(cvMp3), "clean_voice refuses a non-.wav output (48 kHz float WAV only)", cvMp3.slice(0, 120));
// --ab: one candidate on the clean fixture (chain only), 12 s +
// 0.8 s gap = 12.8 s on disk, order file lists it.
const cvAbOut = path.join(root, "outputs/mcp-clean-voice-ab.wav");
const cvAb = await callCleanVoice(cvCleanPath, { output: cvAbOut, ab: true });
const cvAbProbe = JSON.parse((await client.callTool({ name: "probe", arguments: { input: cvAb.ab.file } })).content[0].text);
const cvAbTxt = await readFile(cvAb.ab.order_file, "utf8");
checkOk(cvAb.ab.order.length === 1 && /chain only/.test(cvAb.ab.order[0]) && near(cvAbProbe.duration_seconds, 12.8, 0.05) && /window 0\.0-12\.0 s/.test(cvAbTxt), "clean_voice --ab: 1 candidate (chain only), 12.8 s on disk (12 s + 0.8 s gap), order file lists it", `dur=${cvAbProbe.duration_seconds} order=${JSON.stringify(cvAb.ab.order)}`);
// --dry-run prints the exact commands and writes no file.
const cvDryOut = path.join(root, "outputs/mcp-clean-voice-dry.wav");
const cvDry = await callCleanVoice(cvHumPath, { output: cvDryOut, dry_run: true });
checkOk(cvDry.dry_run === true && cvDry.commands.length === 2 && /bandreject=f=50/.test(cvDry.commands[0]) && /acompressor/.test(cvDry.commands[1]) && !existsSync(cvDryOut), "clean_voice --dry-run: 2 commands (dehum + chain), first carries the 50 Hz bandreject, no file written", JSON.stringify(cvDry.commands.map((c) => c.slice(0, 60))));
// Batch: the 4 fixtures in one call — clean/hum/clipped clean,
// echo fails its own row (clearvoice unavailable), outputs .wav.
const cvBatchDir = path.join(root, `outputs/mcp-batch-cleanvoice-${process.pid}`);
const cvBatch = JSON.parse((await client.callTool({ name: "batch", arguments: { operation: "clean_voice", pattern: "cleanvoice-*.wav", input_dir: path.join(root, "test"), output_dir: cvBatchDir } })).content[0].text);
checkOk(cvBatch.succeeded === 3 && cvBatch.failed === 1 && cvBatch.results.find((r) => r.input.endsWith("cleanvoice-echo.wav"))?.status === "error", "batch clean_voice: 3 succeeded, echo failed its own row (clearvoice unavailable)", JSON.stringify({ s: cvBatch.succeeded, f: cvBatch.failed }));
const cvBatchOut = path.join(cvBatchDir, "cleanvoice-clean-clean_voice.wav");
checkOk(existsSync(cvBatchOut) && near(await measureLufs(cvBatchOut), -14, 0.5), "batch clean_voice writes a .wav at -14 LUFS", cvBatchOut);
// Manifest: clean_voice as a step in a voice-only pipeline ending in .wav.
const cvManifestPath = path.join(root, "outputs/mcp-cleanvoice-manifest.json");
await writeFile(cvManifestPath, JSON.stringify({ version: 1, input: cvClipPath, output: path.join(root, "outputs/mcp-cleanvoice-manifest-out.wav"), steps: [{ tool: "clean_voice", args: {} }] }, null, 2), "utf8");
const cvManifest = JSON.parse((await client.callTool({ name: "manifest", arguments: { manifest_path: cvManifestPath } })).content[0].text);
checkOk(cvManifest.output && existsSync(cvManifest.output) && near(await measureLufs(cvManifest.output), -14, 0.5), "manifest clean_voice step: pipeline ending in .wav runs and hits -14 LUFS", JSON.stringify({ out: cvManifest.output }));

// check_frames (idea: broll-mcp, lượt 65): every video trim verifies
// the cut — 3 output frames vs the source at the requested times.
// Fixture test/trim-check-source.mp4 is testsrc 10s/30fps with
// keyframes only at 0 and 8.333, so a cut at 3.5s is off-keyframe.
const checkSrc = path.join(root, "test/trim-check-source.mp4");
const checkReencRes = await client.callTool({
  name: "trim",
  arguments: { input: checkSrc, output: path.join(root, "outputs/mcp-trim-check-reenc.mp4"), start: 3.5, duration: 2 },
});
const checkReenc = JSON.parse(checkReencRes.content[0].text);
console.log("trim check-frames re-encode:", checkReenc.check_frames_match, "| verified", checkReenc.cut_verified, "| diffs", checkReenc.check_frames.map((f) => f.mean_abs_diff).join(","));
checkOk(checkReenc.cut_verified === true && checkReenc.check_frames_match === "3/3", "trim check-frames: re-encode cut at 3.5s verifies 3/3", JSON.stringify(checkReenc.check_frames));
checkOk(checkReenc.check_frames.every((f) => f.mean_abs_diff !== null && f.mean_abs_diff <= 2), "trim check-frames: re-encode diffs are re-encode noise (<= 2)", checkReenc.check_frames.map((f) => f.mean_abs_diff).join(","));
checkOk(checkReenc.check_frames.map((f) => f.position).join(",") === "head,middle,tail" && checkReenc.match_threshold === 5 && checkReenc.normal_step !== null && checkReenc.normal_step < 1, "trim check-frames: positions head/middle/tail, threshold 5, normal_step < 1 on testsrc", JSON.stringify({ pos: checkReenc.check_frames.map((f) => f.position), thr: checkReenc.match_threshold, ns: checkReenc.normal_step }));
// Stream copy on ffmpeg 8.1.2 keeps the keyframe at negative pts, so
// the content lands exactly — bit-identical frames, not a slide.
const checkCopyRes = await client.callTool({
  name: "trim",
  arguments: { input: checkSrc, output: path.join(root, "outputs/mcp-trim-check-copy.mp4"), start: 3.5, duration: 2, stream_copy: true },
});
const checkCopy = JSON.parse(checkCopyRes.content[0].text);
checkOk(checkCopy.cut_verified === true && checkCopy.check_frames.every((f) => f.mean_abs_diff === 0), "trim check-frames: stream-copy cut verifies 3/3 with bit-identical frames (diff 0)", JSON.stringify(checkCopy.check_frames));
// Smart cut lands exactly too (head re-encoded, tail copied).
const checkSmartRes = await client.callTool({
  name: "trim",
  arguments: { input: checkSrc, output: path.join(root, "outputs/mcp-trim-check-smart.mp4"), start: 3.5, duration: 2, stream_copy: true, smart_cut: true },
});
const checkSmart = JSON.parse(checkSmartRes.content[0].text);
checkOk(checkSmart.cut_verified === true && checkSmart.check_frames_match === "3/3" && checkSmart.check_frames.every((f) => f.mean_abs_diff !== null && f.mean_abs_diff <= 2), "trim check-frames: smart-cut verifies 3/3", JSON.stringify(checkSmart.check_frames));
// Negative control: a snap that moved the cut 3.5s must FAIL the
// check — head/middle/tail all mismatch the requested times.
const checkSnapRes = await client.callTool({
  name: "trim",
  arguments: { input: checkSrc, output: path.join(root, "outputs/mcp-trim-check-snap.mp4"), start: 3.5, duration: 2, stream_copy: true, snap_to_keyframe: true },
});
const checkSnap = JSON.parse(checkSnapRes.content[0].text);
console.log("trim check-frames snap (negative):", checkSnap.check_frames_match, "| verified", checkSnap.cut_verified, "| diffs", checkSnap.check_frames.map((f) => f.mean_abs_diff).join(","));
checkOk(checkSnap.cut_verified === false && checkSnap.check_frames_match === "0/3" && checkSnap.check_frames.every((f) => f.mean_abs_diff === null || f.mean_abs_diff > 5), "trim check-frames: snapped cut fails 0/3 (all frames mismatch the requested times)", JSON.stringify(checkSnap.check_frames));
// Audio-only has no video frames to check; check_frames=false opts out.
const checkAudioRes = await client.callTool({
  name: "trim",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-trim-check-audio.mp3"), start: 1, duration: 2 },
});
const checkAudio = JSON.parse(checkAudioRes.content[0].text);
checkOk(checkAudio.check_frames === null && /audio-only/.test(checkAudio.check_frames_note ?? ""), "trim check-frames: audio-only trim reports check_frames null", JSON.stringify({ cf: checkAudio.check_frames, note: checkAudio.check_frames_note }));
const checkOffRes = await client.callTool({
  name: "trim",
  arguments: { input: checkSrc, output: path.join(root, "outputs/mcp-trim-check-off.mp4"), start: 3.5, duration: 2, check_frames: false },
});
const checkOff = JSON.parse(checkOffRes.content[0].text);
checkOk(checkOff.check_frames === null && /skipped/.test(checkOff.check_frames_note ?? ""), "trim check-frames=false skips the verification", JSON.stringify({ cf: checkOff.check_frames, note: checkOff.check_frames_note }));
const checkCliOff = await runCliJson(["trim", checkSrc, "--start", "3.5", "--duration", "2", "--no-check-frames", "-o", path.join(root, "outputs/mcp-trim-check-cli-off.mp4")]);
checkOk(checkCliOff.check_frames === null, "CLI trim --no-check-frames skips the verification", JSON.stringify(checkCliOff.check_frames));

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
checkOk(fitJson.max_fps === null && fitJson.fps_capped === false && fitJson.fps === 60, "fit without max_fps: 2x speed-up really runs at 60fps (effective fps, not source fps)", `got max_fps ${fitJson.max_fps}, capped ${fitJson.fps_capped}, fps ${fitJson.fps}`);

// fit --max-fps: cap against the EFFECTIVE fps (source x factor for
// speed), never raise fps by duplicating frames.
const fitCapRes = await client.callTool({
  name: "fit",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-fit-cap15.mp4"),
    duration: 5,
    method: "speed",
    max_fps: 15,
  },
});
const fitCapJson = JSON.parse(fitCapRes.content[0].text);
console.log("fit cap call: max_fps", fitCapJson.max_fps, "| capped", fitCapJson.fps_capped, "| fps", fitCapJson.fps, "| duration_actual", fitCapJson.duration_actual + "s");
checkOk(fitCapJson.fps_capped === true && fitCapJson.fps === 15 && near(fitCapJson.duration_actual, 5, 0.05), "fit max_fps 15 on a 2x speed-up caps output to 15fps at 5s", JSON.stringify({ capped: fitCapJson.fps_capped, fps: fitCapJson.fps, actual: fitCapJson.duration_actual }));
const fitNoCapRes = await client.callTool({
  name: "fit",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-fit-cap60.mp4"),
    duration: 5,
    method: "speed",
    max_fps: 60,
  },
});
const fitNoCapJson = JSON.parse(fitNoCapRes.content[0].text);
checkOk(fitNoCapJson.fps_capped === false && fitNoCapJson.fps === 60, "fit max_fps 60 on a 2x speed-up (effective 60fps) applies no filter — never duplicates frames up", JSON.stringify({ capped: fitNoCapJson.fps_capped, fps: fitNoCapJson.fps }));
const fitTrimCapRes = await client.callTool({
  name: "fit",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-fit-trim-cap.mp4"),
    duration: 6,
    method: "trim",
    max_fps: 15,
  },
});
const fitTrimCapJson = JSON.parse(fitTrimCapRes.content[0].text);
checkOk(fitTrimCapJson.fps_capped === true && fitTrimCapJson.fps === 15 && near(fitTrimCapJson.duration_actual, 6, 0.05), "fit trim + max_fps 15 caps output to 15fps at 6s", JSON.stringify({ capped: fitTrimCapJson.fps_capped, fps: fitTrimCapJson.fps, actual: fitTrimCapJson.duration_actual }));
const fitBadFps = await runCli(["fit", path.join(root, "test/source.mp4"), "--duration", "5", "--max-fps", "0", "-o", path.join(root, "outputs/mcp-fit-bad.mp4")]);
checkOk(fitBadFps.code !== 0 && fitBadFps.out.includes("max_fps"), "CLI fit --max-fps 0 is rejected", fitBadFps.out.slice(0, 200));

// fit --dry-run (lượt 108): factor is computed from the probe, so it
// is exact without rendering.
const fitDryRes = await client.callTool({
  name: "fit",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-fit-dry.mp4"), duration: 5, method: "speed", dry_run: true },
});
const fitDryJson = JSON.parse(fitDryRes.content[0].text);
console.log("fit dry-run:", JSON.stringify({ factor: fitDryJson.speed_factor, commands: fitDryJson.commands?.length }));
checkOk(fitDryJson.dry_run === true && fitDryJson.speed_factor === 2 && fitDryJson.duration_actual === null && fitDryJson.fps === null, "fit dry-run reports the 2x factor, measured fields null", JSON.stringify({ factor: fitDryJson.speed_factor, actual: fitDryJson.duration_actual }));
checkOk(fitDryJson.commands?.length === 1 && fitDryJson.commands[0].includes("setpts=PTS/2") && fitDryJson.commands[0].includes("atempo=2"), "fit dry-run prints the exact speed command", fitDryJson.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-fit-dry.mp4")), "fit dry-run writes no file", "outputs/mcp-fit-dry.mp4");
const fitDryCli = await runCliJson(["fit", path.join(root, "test/source.mp4"), "--duration", "5", "-o", path.join(root, "outputs/mcp-fit-cli-dry.mp4"), "--dry-run"]);
checkOk(fitDryCli.dry_run === true && fitDryCli.commands?.[0]?.includes("setpts=PTS/2") && !existsSync(path.join(root, "outputs/mcp-fit-cli-dry.mp4")), "CLI fit --dry-run prints the command and writes no file", JSON.stringify(fitDryCli.commands));

// resize --preset: fit inside the named box, keep aspect, never
// upscale. Source is 1280x720, so 720p is already a fit (no scale),
// 360p downscales to 640x360, 1080p must NOT upscale to 1920x1080.
const resize720Res = await client.callTool({
  name: "resize",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-resize-720p.mp4"), preset: "720p" },
});
const resize720Json = JSON.parse(resize720Res.content[0].text);
console.log("resize 720p:", resize720Json.dimensions, "| scaled_down", resize720Json.scaled_down, "| box", resize720Json.preset_box);
checkOk(resize720Json.dimensions === "1280x720" && resize720Json.scaled_down === false && resize720Json.preset === "720p", "resize preset 720p on a 1280x720 source keeps 1280x720 (already fits)", JSON.stringify(resize720Json.dimensions));
const resize360Res = await client.callTool({
  name: "resize",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-resize-360p.mp4"), preset: "360p" },
});
const resize360Json = JSON.parse(resize360Res.content[0].text);
checkOk(resize360Json.dimensions === "640x360" && resize360Json.scaled_down === true, "resize preset 360p downscales 1280x720 to 640x360", JSON.stringify(resize360Json.dimensions));
const resize1080Res = await client.callTool({
  name: "resize",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-resize-1080p.mp4"), preset: "1080p" },
});
const resize1080Json = JSON.parse(resize1080Res.content[0].text);
checkOk(resize1080Json.dimensions === "1280x720" && resize1080Json.scaled_down === false, "resize preset 1080p does NOT upscale a 1280x720 source", JSON.stringify(resize1080Json.dimensions));
// Preset + width is a conflict; an unknown preset is rejected.
const resizeBadRes = await client.callTool({
  name: "resize",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-resize-bad.mp4"), preset: "720p", width: 640 },
});
const resizeBadText = resizeBadRes.content?.[0]?.text ?? "";
checkOk(/preset/.test(resizeBadText) && /width/.test(resizeBadText), "resize preset + width is rejected", resizeBadText.slice(0, 200));
const resizeBadPresetRes = await client.callTool({
  name: "resize",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-resize-bad2.mp4"), preset: "144p" },
});
const resizeBadPresetText = resizeBadPresetRes.content?.[0]?.text ?? "";
checkOk(/preset/.test(resizeBadPresetText) && /144p/.test(resizeBadPresetText), "resize rejects an unknown preset", resizeBadPresetText.slice(0, 200));
const resizeCliBad = await runCli(["resize", path.join(root, "test/source.mp4"), "--preset", "720p", "--width", "640", "-o", path.join(root, "outputs/mcp-resize-cli-bad.mp4")]);
checkOk(resizeCliBad.code !== 0 && resizeCliBad.out.includes("preset"), "CLI resize --preset + --width is rejected", resizeCliBad.out.slice(0, 200));

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

// concat --fast time_base (lượt 73): same codec/size/fps/audio but
// time_base 1/90000 vs 1/15360 — the demuxer copies timestamps
// verbatim, so stream-copy (and even demuxer re-encode) stretches
// 10s+10s to 116.9s. Auto must re-encode through the filter graph
// and land on exactly 20s; fast=true must refuse naming time_base.
const concatTbRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/timescale-90k.mp4")],
    output: path.join(root, "outputs/mcp-concat-timebase.mp4"),
  },
});
const concatTbJson = JSON.parse(concatTbRes.content[0].text);
console.log("concat time_base auto:", concatTbJson.mode, "| duration", concatTbJson.duration_seconds, "| skipped:", JSON.stringify(concatTbJson.fast_skipped));
checkOk(concatTbJson.mode === "reencode" && near(concatTbJson.duration_seconds, 20, 0.1), "concat auto on a time_base mismatch re-encodes to exactly 20s (not the demuxer's 116.9s)", JSON.stringify(concatTbJson));
checkOk(Array.isArray(concatTbJson.fast_skipped) && concatTbJson.fast_skipped.some((r) => r.includes("time_base 1/90000")), "concat auto names the time_base mismatch", JSON.stringify(concatTbJson.fast_skipped));
const concatTbFastRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/timescale-90k.mp4")],
    output: path.join(root, "outputs/mcp-concat-timebase-fast.mp4"),
    fast: true,
  },
});
const concatTbFastJson = JSON.parse(concatTbFastRes.content[0].text);
checkOk(concatTbFastRes.isError === true && /time_base 1\/90000/.test(concatTbFastJson.error ?? ""), "concat fast=true errors on a time_base mismatch", JSON.stringify(concatTbFastJson));

// concat dry-run (lượt 117 — closes the dry-run set): every route
// prints the exact command and writes nothing. The demuxer path also
// returns list_file + list_content — the printed command reads that
// list file, so the hand-run below writes it first, then runs the
// command, and must land byte-identical to the real run.
await rm(path.join(root, "outputs/mcp-concat-dry-fast.mp4"), { force: true });
const concatDryFastRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source.mp4")],
    output: path.join(root, "outputs/mcp-concat-dry-fast.mp4"),
    dry_run: true,
  },
});
const concatDryFastJson = JSON.parse(concatDryFastRes.content[0].text);
checkOk(concatDryFastJson.dry_run === true && concatDryFastJson.mode === "fast" && near(concatDryFastJson.expected_duration_seconds, 20, 0.01) && concatDryFastJson.duration_seconds === null && concatDryFastJson.size_bytes === null && concatDryFastJson.commands?.length === 1 && /-f concat/.test(concatDryFastJson.commands[0]) && /-c copy/.test(concatDryFastJson.commands[0]) && typeof concatDryFastJson.list_file === "string" && (concatDryFastJson.list_content ?? "").includes("test/source.mp4") && !existsSync(path.join(root, "outputs/mcp-concat-dry-fast.mp4")) && !existsSync(concatDryFastJson.list_file), "concat dry-run (fast) prints the stream-copy demuxer command + list file/content, mode/expected exact, writes nothing", JSON.stringify({ mode: concatDryFastJson.mode, list: concatDryFastJson.list_file }));
await writeFile(concatDryFastJson.list_file, concatDryFastJson.list_content, "utf8");
await execFileAsync("bash", ["-c", concatDryFastJson.commands[0]]);
const concatDryFastRealRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source.mp4")],
    output: path.join(root, "outputs/mcp-concat-dry-fast-real.mp4"),
  },
});
const concatDryFastRealJson = JSON.parse(concatDryFastRealRes.content[0].text);
checkOk(concatDryFastRealJson.mode === "fast" && near(concatDryFastRealJson.duration_seconds, 20, 0.1), "concat real run for the dry-run comparison stream-copies to 20s", JSON.stringify({ mode: concatDryFastRealJson.mode, dur: concatDryFastRealJson.duration_seconds }));
const concatDryHandSha = await sha256File(path.join(root, "outputs/mcp-concat-dry-fast.mp4"));
const concatDryRealSha = await sha256File(path.join(root, "outputs/mcp-concat-dry-fast-real.mp4"));
checkOk(concatDryHandSha === concatDryRealSha, "concat dry-run command (list file written first) run by hand is byte-identical to the real run", `${concatDryHandSha.slice(0, 12)} vs ${concatDryRealSha.slice(0, 12)}`);
await rm(concatDryFastJson.list_file, { force: true });
// Re-encode dry-run (auto on differing clips): one demuxer command
// with libx264, fast_skipped names the mismatch, no file written.
await rm(path.join(root, "outputs/mcp-concat-dry-reencode.mp4"), { force: true });
const concatDryReRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source2.mp4")],
    output: path.join(root, "outputs/mcp-concat-dry-reencode.mp4"),
    dry_run: true,
  },
});
const concatDryReJson = JSON.parse(concatDryReRes.content[0].text);
checkOk(concatDryReJson.dry_run === true && concatDryReJson.mode === "reencode" && near(concatDryReJson.expected_duration_seconds, 16, 0.01) && concatDryReJson.commands?.length === 1 && /-c:v libx264/.test(concatDryReJson.commands[0]) && Array.isArray(concatDryReJson.fast_skipped) && concatDryReJson.fast_skipped.some((r) => r.includes("640x360")) && !existsSync(path.join(root, "outputs/mcp-concat-dry-reencode.mp4")), "concat dry-run (auto, differing clips) prints the re-encode demuxer command and names the size mismatch, writes nothing", JSON.stringify({ mode: concatDryReJson.mode, skipped: concatDryReJson.fast_skipped }));
// Transition dry-run: one exact filter-graph command (xfade +
// acrossfade), expected = sum minus the transition, no file written.
await rm(path.join(root, "outputs/mcp-concat-dry-fade.mp4"), { force: true });
const concatDryFadeRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source2.mp4")],
    output: path.join(root, "outputs/mcp-concat-dry-fade.mp4"),
    transition: "fade", transition_duration: 1, dry_run: true,
  },
});
const concatDryFadeJson = JSON.parse(concatDryFadeRes.content[0].text);
checkOk(concatDryFadeJson.dry_run === true && concatDryFadeJson.transition === "fade" && near(concatDryFadeJson.expected_duration_seconds, 15, 0.01) && concatDryFadeJson.duration_seconds === null && concatDryFadeJson.commands?.length === 1 && /xfade=transition=fade:duration=1:offset=9/.test(concatDryFadeJson.commands[0]) && /acrossfade=d=1/.test(concatDryFadeJson.commands[0]) && !existsSync(path.join(root, "outputs/mcp-concat-dry-fade.mp4")), "concat dry-run (fade) prints the exact xfade join (offset 9 = 10-1) and expects 15s, writes nothing", concatDryFadeJson.commands?.[0]?.slice(0, 200) ?? "");
// Trim dry-run: per-clip trims go through the filter graph (trim +
// concat filter), expected = 3s + 6s, no file written.
await rm(path.join(root, "outputs/mcp-concat-dry-trim.mp4"), { force: true });
const concatDryTrimRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [{ file: path.join(root, "test/source.mp4"), start: 2, end: 5 }, path.join(root, "test/source2.mp4")],
    output: path.join(root, "outputs/mcp-concat-dry-trim.mp4"),
    dry_run: true,
  },
});
const concatDryTrimJson = JSON.parse(concatDryTrimRes.content[0].text);
checkOk(concatDryTrimJson.dry_run === true && concatDryTrimJson.mode === "trim" && near(concatDryTrimJson.expected_duration_seconds, 9, 0.01) && concatDryTrimJson.commands?.length === 1 && /trim=start=2:end=5/.test(concatDryTrimJson.commands[0]) && /concat=n=2:v=1:a=1/.test(concatDryTrimJson.commands[0]) && !existsSync(path.join(root, "outputs/mcp-concat-dry-trim.mp4")), "concat dry-run (trim) prints the exact trim+concat filter graph and expects 9s, writes nothing", concatDryTrimJson.commands?.[0]?.slice(0, 200) ?? "");
// A dry-run must surface the same refusals as a real run: fast=true
// on differing clips errors instead of printing a command.
const concatDryFastFailRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source2.mp4")],
    output: path.join(root, "outputs/mcp-concat-dry-fast-fail.mp4"),
    fast: true, dry_run: true,
  },
});
const concatDryFastFailJson = JSON.parse(concatDryFastFailRes.content[0].text);
checkOk(concatDryFastFailRes.isError === true && /size 640x360/.test(concatDryFastFailJson.error ?? ""), "concat dry-run + fast=true errors on differing clips with the mismatch (same refusal as the real run)", JSON.stringify(concatDryFastFailJson));
// CLI wiring: --dry-run is an accepted option (validateOpts would
// exit 2 on an unknown flag) and prints dry_run JSON.
const concatCliDry = await execFileAsync("node", [path.join(root, "bin/mediakit.js"), "concat", path.join(root, "test/source.mp4"), path.join(root, "test/source.mp4"), "-o", path.join(root, "outputs/mcp-concat-cli-dry.mp4"), "--dry-run"]);
const concatCliDryJson = JSON.parse(concatCliDry.stdout);
checkOk(concatCliDryJson.dry_run === true && concatCliDryJson.mode === "fast" && !existsSync(path.join(root, "outputs/mcp-concat-cli-dry.mp4")), "CLI concat --dry-run prints dry_run JSON and writes nothing", concatCliDry.stdout.slice(0, 120));

// concat/pip/overlay on rotated phone clips (lượt 77): geometry is
// measured on the DISPLAY frame, not the coded pixels. rotated.mp4
// is stored 1280x720 with rotation 90 (displays 720x1280);
// upright-720x1280.mp4 is the same picture coded upright (stored
// 720x1280, rotation null) — same display size, different stored
// orientation. Before the fix, concat auto stream-copied the pair
// (one half sideways), the transition path pillarboxed the portrait
// clip into 1280x720, and overlay/pip silently drew nothing (output
// byte-identical to the plain re-encode).
const concatDispRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/rotated.mp4"), path.join(root, "test/source.mp4")],
    output: path.join(root, "outputs/mcp-concat-display.mp4"),
  },
});
const concatDispJson = JSON.parse(concatDispRes.content[0].text);
console.log("concat display-mismatch auto:", concatDispJson.mode, "| duration", concatDispJson.duration_seconds, "|", concatDispJson.dimensions, "| normalize", concatDispJson.normalize_dimensions, "| skipped:", JSON.stringify(concatDispJson.fast_skipped));
checkOk(concatDispJson.mode === "reencode", "concat auto on a display-size mismatch re-encodes through the filter graph (not the demuxer)", `got mode=${concatDispJson.mode}`);
checkOk(near(concatDispJson.duration_seconds, 20, 0.1), "concat display-mismatch duration is 20s (10+10)", `got ${concatDispJson.duration_seconds}`);
checkOk(concatDispJson.dimensions === "720x1280", "concat display-mismatch output is 720x1280 (first clip's display size)", `got ${concatDispJson.dimensions}`);
checkOk(concatDispJson.normalize_dimensions === "720x1280", "concat display-mismatch normalizes to 720x1280", `got ${concatDispJson.normalize_dimensions}`);
checkOk(Array.isArray(concatDispJson.fast_skipped) && concatDispJson.fast_skipped.some((r) => r.includes("display size 1280x720")), "concat auto names the display-size mismatch", JSON.stringify(concatDispJson.fast_skipped));
// Second half must be the upright clip, upright: PSNR vs the source
// frame padded to 720x1280 is ~27.6 dB (calibrated: the same
// scale+pad+crf23 pipeline re-encoded on its own scores 27.63), while
// the sideways (transposed) variant scores ~3.2.
await extractPng(path.join(root, "outputs/mcp-concat-display.mp4"), 15, path.join(root, "outputs/mcp-concat-disp-t15.png"));
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-ss", "5", "-i", path.join(root, "test/source.mp4"), "-frames:v", "1", "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:-1:-1:black", "-y", path.join(root, "outputs/mcp-concat-disp-exp.png")]);
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-ss", "5", "-i", path.join(root, "test/source.mp4"), "-frames:v", "1", "-vf", "transpose=1", "-y", path.join(root, "outputs/mcp-concat-disp-sideways.png")]);
const concatDispPsnr = await framePsnr(path.join(root, "outputs/mcp-concat-disp-exp.png"), path.join(root, "outputs/mcp-concat-disp-t15.png"));
const concatDispSidePsnr = await framePsnr(path.join(root, "outputs/mcp-concat-disp-sideways.png"), path.join(root, "outputs/mcp-concat-disp-t15.png"));
console.log("concat display second-half PSNR: upright", concatDispPsnr, "| sideways", concatDispSidePsnr);
checkOk(concatDispPsnr !== null && concatDispPsnr > 25, "concat display-mismatch second half is upright (PSNR > 25 vs padded source frame)", `got ${concatDispPsnr}`);
checkOk(concatDispSidePsnr !== null && concatDispSidePsnr < 10, "concat display-mismatch second half is not sideways (PSNR < 10 vs transposed frame)", `got ${concatDispSidePsnr}`);
const concatDispFastRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/rotated.mp4"), path.join(root, "test/source.mp4")],
    output: path.join(root, "outputs/mcp-concat-display-fast.mp4"),
    fast: true,
  },
});
const concatDispFastJson = JSON.parse(concatDispFastRes.content[0].text);
checkOk(concatDispFastRes.isError === true && /display size 1280x720/.test(concatDispFastJson.error ?? ""), "concat fast=true errors on a display-size mismatch", JSON.stringify(concatDispFastJson));
// Transition path with a rotated first clip normalizes to its
// display size too (before: 1280x720 landscape with pillarbox).
const concatDispTransRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/rotated.mp4"), path.join(root, "test/source.mp4")],
    output: path.join(root, "outputs/mcp-concat-display-fade.mp4"),
    transition: "fade",
    transition_duration: 1,
  },
});
const concatDispTransJson = JSON.parse(concatDispTransRes.content[0].text);
console.log("concat display+fade:", concatDispTransJson.dimensions, "| duration", concatDispTransJson.duration_seconds, "| normalize", concatDispTransJson.normalize_dimensions);
checkOk(concatDispTransJson.dimensions === "720x1280", "concat transition on a rotated first clip outputs 720x1280", `got ${concatDispTransJson.dimensions}`);
checkOk(near(concatDispTransJson.duration_seconds, 19, 0.1), "concat transition on a rotated first clip is 19s (10+10-1)", `got ${concatDispTransJson.duration_seconds}`);
checkOk(concatDispTransJson.normalize_dimensions === "720x1280", "concat transition normalizes to the first clip's display size", `got ${concatDispTransJson.normalize_dimensions}`);
// Same display size, different stored orientation: fast must still
// refuse (stream copy cannot re-orient), but the demuxer re-encode
// is safe because both clips decode to 720x1280 frames.
const concatSameDispRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/rotated.mp4"), path.join(root, "test/upright-720x1280.mp4")],
    output: path.join(root, "outputs/mcp-concat-samedisplay.mp4"),
  },
});
const concatSameDispJson = JSON.parse(concatSameDispRes.content[0].text);
console.log("concat same-display auto:", concatSameDispJson.mode, "| duration", concatSameDispJson.duration_seconds, "|", concatSameDispJson.dimensions, "| skipped:", JSON.stringify(concatSameDispJson.fast_skipped));
checkOk(concatSameDispJson.mode === "reencode", "concat auto on same-display/different-stored clips re-encodes", `got mode=${concatSameDispJson.mode}`);
checkOk(near(concatSameDispJson.duration_seconds, 20, 0.1), "concat same-display duration is 20s (10+10)", `got ${concatSameDispJson.duration_seconds}`);
checkOk(concatSameDispJson.dimensions === "720x1280", "concat same-display output is 720x1280", `got ${concatSameDispJson.dimensions}`);
await extractPng(path.join(root, "outputs/mcp-concat-samedisplay.mp4"), 15, path.join(root, "outputs/mcp-concat-samedisp-t15.png"));
await extractPng(path.join(root, "test/upright-720x1280.mp4"), 5, path.join(root, "outputs/mcp-concat-samedisp-exp.png"));
const concatSameDispPsnr = await framePsnr(path.join(root, "outputs/mcp-concat-samedisp-exp.png"), path.join(root, "outputs/mcp-concat-samedisp-t15.png"));
console.log("concat same-display second-half PSNR:", concatSameDispPsnr);
checkOk(concatSameDispPsnr !== null && concatSameDispPsnr > 25, "concat same-display second half matches the upright clip (PSNR > 25)", `got ${concatSameDispPsnr}`);
const concatSameDispFastRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [path.join(root, "test/rotated.mp4"), path.join(root, "test/upright-720x1280.mp4")],
    output: path.join(root, "outputs/mcp-concat-samedisplay-fast.mp4"),
    fast: true,
  },
});
const concatSameDispFastJson = JSON.parse(concatSameDispFastRes.content[0].text);
checkOk(concatSameDispFastRes.isError === true && /stored orientation differs/.test(concatSameDispFastJson.error ?? ""), "concat fast=true errors on same-display/different-stored clips", JSON.stringify(concatSameDispFastJson));
// overlay on a rotated clip: top-right 120px lands at 576,24 on
// the 720-wide display frame (before: 1136,24 — outside the frame,
// logo silently absent). Pixel-verify the red logo is really there.
const overlayDispRes = await client.callTool({
  name: "overlay",
  arguments: {
    input: path.join(root, "test/rotated.mp4"),
    overlay: path.join(root, "test/logo.png"),
    output: path.join(root, "outputs/mcp-overlay-display.mp4"),
    position: "top-right",
    width: 120,
    opacity: 1,
  },
});
const overlayDispJson = JSON.parse(overlayDispRes.content[0].text);
console.log("overlay display:", overlayDispJson.position, overlayDispJson.x + "," + overlayDispJson.y, "|", overlayDispJson.overlay_size, "| src", overlayDispJson.source_dimensions, "rot", overlayDispJson.source_rotation);
checkOk(overlayDispJson.x === 576 && overlayDispJson.y === 24 && overlayDispJson.source_dimensions === "720x1280" && overlayDispJson.source_rotation === 90, "overlay on a rotated clip lands at 576,24 on the 720x1280 display frame", `got ${overlayDispJson.x},${overlayDispJson.y} ${overlayDispJson.source_dimensions} rot ${overlayDispJson.source_rotation}`);
const overlayDispR = await planeMean(path.join(root, "outputs/mcp-overlay-display.mp4"), "120:120:576:24", "r", 5);
const overlayDispB = await planeMean(path.join(root, "outputs/mcp-overlay-display.mp4"), "120:120:576:24", "b", 5);
console.log("overlay display pixels: logo R/B =", overlayDispR, overlayDispB);
checkOk(overlayDispR !== null && overlayDispR > 200, "overlay logo is really red on the rotated clip (R > 200)", `got R=${overlayDispR}`);
checkOk(overlayDispB !== null && overlayDispB < 20, "overlay logo has no blue on the rotated clip (B < 20)", `got B=${overlayDispB}`);
// pip on a rotated clip: rotate-source.mp4 is left-red/right-blue
// 640x360, so the 180x102 PiP at bottom-right (516,1154) must show
// red on its left half and blue on its right half.
const pipDispRes = await client.callTool({
  name: "pip",
  arguments: {
    input: path.join(root, "test/rotated.mp4"),
    pip: path.join(root, "test/rotate-source.mp4"),
    output: path.join(root, "outputs/mcp-pip-display.mp4"),
  },
});
const pipDispJson = JSON.parse(pipDispRes.content[0].text);
console.log("pip display:", pipDispJson.position, pipDispJson.x + "," + pipDispJson.y, "|", pipDispJson.pip_size, "| src", pipDispJson.source_dimensions);
checkOk(pipDispJson.x === 516 && pipDispJson.y === 1154 && pipDispJson.pip_size === "180x102" && pipDispJson.source_dimensions === "720x1280", "pip on a rotated clip lands at 516,1154 as 180x102 on the 720x1280 display frame", `got ${pipDispJson.x},${pipDispJson.y} ${pipDispJson.pip_size} ${pipDispJson.source_dimensions}`);
const pipDispLeftR = await planeMean(path.join(root, "outputs/mcp-pip-display.mp4"), "90:102:516:1154", "r", 5);
const pipDispLeftB = await planeMean(path.join(root, "outputs/mcp-pip-display.mp4"), "90:102:516:1154", "b", 5);
const pipDispRightB = await planeMean(path.join(root, "outputs/mcp-pip-display.mp4"), "90:102:606:1154", "b", 5);
const pipDispRightR = await planeMean(path.join(root, "outputs/mcp-pip-display.mp4"), "90:102:606:1154", "r", 5);
console.log("pip display pixels: left R/B =", pipDispLeftR, pipDispLeftB, "| right B/R =", pipDispRightB, pipDispRightR);
checkOk(pipDispLeftR !== null && pipDispLeftR > 200, "pip left half is red on the rotated clip (R > 200)", `got R=${pipDispLeftR}`);
checkOk(pipDispLeftB !== null && pipDispLeftB < 20, "pip left half has no blue (B < 20)", `got B=${pipDispLeftB}`);
checkOk(pipDispRightB !== null && pipDispRightB > 200, "pip right half is blue on the rotated clip (B > 200)", `got B=${pipDispRightB}`);
checkOk(pipDispRightR !== null && pipDispRightR < 20, "pip right half has no red (R < 20)", `got R=${pipDispRightR}`);
// A rotated PiP clip keeps its portrait aspect: 320 wide on a
// 1280-wide main is 320x568 from the display ratio (before: 320x180
// from the stored 1280x720 ratio — squashed flat).
const pipRotClipRes = await client.callTool({
  name: "pip",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    pip: path.join(root, "test/rotated.mp4"),
    output: path.join(root, "outputs/mcp-pip-rotclip.mp4"),
  },
});
const pipRotClipJson = JSON.parse(pipRotClipRes.content[0].text);
console.log("pip rotated clip:", pipRotClipJson.pip_size, "|", pipRotClipJson.x + "," + pipRotClipJson.y, "| pip src", pipRotClipJson.pip_source_dimensions);
checkOk(pipRotClipJson.pip_size === "320x568" && pipRotClipJson.x === 936 && pipRotClipJson.y === 128 && pipRotClipJson.pip_source_dimensions === "720x1280", "pip with a rotated clip is 320x568 at 936,128 (display aspect, not stored)", `got ${pipRotClipJson.pip_size} ${pipRotClipJson.x},${pipRotClipJson.y} ${pipRotClipJson.pip_source_dimensions}`);
// overlay + pip --dry-run (lượt 113, batch 4): print the exact
// command, write no file. Geometry is computed from the display
// probe, so the dry-run values are the real ones (576,24 / 936,128).
const overlayDryRes = await client.callTool({
  name: "overlay",
  arguments: { input: path.join(root, "test/rotated.mp4"), overlay: path.join(root, "test/logo.png"), output: path.join(root, "outputs/mcp-overlay-dry.mp4"), position: "top-right", width: 120, dry_run: true },
});
const overlayDryJson = JSON.parse(overlayDryRes.content[0].text);
checkOk(overlayDryJson.dry_run === true && overlayDryJson.x === 576 && overlayDryJson.y === 24 && overlayDryJson.overlay_size === "120x120" && overlayDryJson.dimensions === "720x1280" && overlayDryJson.duration_seconds === null, "overlay dry-run reports the exact display-frame geometry (576,24, 120x120), duration null", JSON.stringify(overlayDryJson));
checkOk(overlayDryJson.commands?.length === 1 && overlayDryJson.commands[0].includes("overlay=576:24") && overlayDryJson.commands[0].includes("scale=120:-2"), "overlay dry-run prints the exact overlay command", overlayDryJson.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-overlay-dry.mp4")), "overlay dry-run writes no file", "outputs/mcp-overlay-dry.mp4");
const overlayDryCli = await runCliJson(["overlay", path.join(root, "test/rotated.mp4"), "--image", path.join(root, "test/logo.png"), "--width", "120", "-o", path.join(root, "outputs/mcp-overlay-cli-dry.mp4"), "--dry-run"]);
checkOk(overlayDryCli.dry_run === true && overlayDryCli.commands?.[0]?.includes("overlay=576:24") && !existsSync(path.join(root, "outputs/mcp-overlay-cli-dry.mp4")), "CLI overlay --dry-run prints the command and writes no file", JSON.stringify(overlayDryCli.commands));
const pipDryRes = await client.callTool({
  name: "pip",
  arguments: { input: path.join(root, "test/source.mp4"), pip: path.join(root, "test/rotated.mp4"), output: path.join(root, "outputs/mcp-pip-dry.mp4"), audio: "mix", dry_run: true },
});
const pipDryJson = JSON.parse(pipDryRes.content[0].text);
checkOk(pipDryJson.dry_run === true && pipDryJson.pip_size === "320x568" && pipDryJson.x === 936 && pipDryJson.y === 128 && pipDryJson.audio === "mix" && pipDryJson.dimensions === "1280x720" && pipDryJson.duration_seconds === null, "pip dry-run reports the exact display-frame geometry (320x568 at 936,128, audio mix), duration null", JSON.stringify(pipDryJson));
checkOk(pipDryJson.commands?.length === 1 && pipDryJson.commands[0].includes("-stream_loop -1") && pipDryJson.commands[0].includes("amix=inputs=2") && pipDryJson.commands[0].includes("overlay=936:128"), "pip dry-run prints the exact loop + amix + overlay command", pipDryJson.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-pip-dry.mp4")), "pip dry-run writes no file", "outputs/mcp-pip-dry.mp4");
const pipDryCli = await runCliJson(["pip", path.join(root, "test/source.mp4"), "--pip", path.join(root, "test/rotated.mp4"), "-o", path.join(root, "outputs/mcp-pip-cli-dry.mp4"), "--audio", "mix", "--dry-run"]);
checkOk(pipDryCli.dry_run === true && pipDryCli.commands?.[0]?.includes("-stream_loop -1") && !existsSync(path.join(root, "outputs/mcp-pip-cli-dry.mp4")), "CLI pip --dry-run prints the command and writes no file", JSON.stringify(pipDryCli.commands));

// concat per-clip trim: {file, start, end} objects (MCP) and
// path@start-end (CLI). Trims re-encode through the filter graph —
// the concat demuxer's inpoint/outpoint was measured to NOT cut
// accurately (2–5s + 1–4s stream-copied 8.09s instead of 6s).
async function bandPsnrAt(fileA, tA, fileB, tB, y, h) {
  const aPng = path.join(root, "outputs/mcp-band-a.png");
  const bPng = path.join(root, "outputs/mcp-band-b.png");
  await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", String(tA), "-i", fileA, "-frames:v", "1", aPng]);
  await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", String(tB), "-i", fileB, "-frames:v", "1", bPng]);
  const { stderr } = await execFileAsync("ffmpeg", ["-i", aPng, "-i", bPng, "-filter_complex", `[0:v]crop=iw:${h}:0:${y}[a];[1:v]crop=iw:${h}:0:${y}[b];[a][b]psnr`, "-f", "null", "-"]);
  const m = stderr.match(/average:\s*(inf|[0-9.]+)/);
  if (!m) return null;
  return m[1] === "inf" ? Infinity : parseFloat(m[1]);
}
const concatTrimRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [
      { file: path.join(root, "test/source.mp4"), start: 2, end: 5 },
      { file: path.join(root, "test/source2.mp4"), start: "0:01", end: "0:04" },
    ],
    output: path.join(root, "outputs/mcp-concat-trim.mp4"),
  },
});
const concatTrimJson = JSON.parse(concatTrimRes.content[0].text);
console.log("concat trim call: mode", concatTrimJson.mode, "| duration", concatTrimJson.duration_seconds, "| expected", concatTrimJson.expected_duration_seconds, "| parts", JSON.stringify(concatTrimJson.parts));
checkOk(concatTrimJson.mode === "trim" && near(concatTrimJson.duration_seconds, 6, 0.1) && near(concatTrimJson.expected_duration_seconds, 6, 0.01), "concat per-clip trim gives 6s (3+3) in trim mode", JSON.stringify(concatTrimJson));
checkOk(concatTrimJson.parts?.[0]?.duration === 3 && concatTrimJson.parts?.[1]?.duration === 3 && concatTrimJson.parts?.[0]?.start === 2 && concatTrimJson.parts?.[1]?.end === 4, "concat trim reports per-clip ranges 2–5s and 1–4s (MM:SS parsed)", JSON.stringify(concatTrimJson.parts));
// Content check: the trimmed output at 0.5s must be the source at
// 2.5s (PSNR high), not the source at 0.5s (PSNR low) — the trim
// really moved the picture, the duration alone does not prove it.
const trimPsnrRight = await bandPsnrAt(path.join(root, "outputs/mcp-concat-trim.mp4"), 0.5, path.join(root, "test/source.mp4"), 2.5, 0, 360);
const trimPsnrWrong = await bandPsnrAt(path.join(root, "outputs/mcp-concat-trim.mp4"), 0.5, path.join(root, "test/source.mp4"), 0.5, 0, 360);
console.log("concat trim pixels: PSNR vs source@2.5s =", trimPsnrRight, "| vs source@0.5s =", trimPsnrWrong);
checkOk(trimPsnrRight !== null && trimPsnrRight > 30, "concat trim content matches source at 2.5s (PSNR high)", `got ${trimPsnrRight}`);
checkOk(trimPsnrWrong !== null && trimPsnrWrong < 30, "concat trim content differs from source at 0.5s (PSNR low)", `got ${trimPsnrWrong}`);
// Trim + transition: 5s + 4s minus 1s fade = 8s.
const concatTrimFadeRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [
      { file: path.join(root, "test/source.mp4"), start: 0, end: 5 },
      { file: path.join(root, "test/source2.mp4"), start: 0, end: 4 },
    ],
    output: path.join(root, "outputs/mcp-concat-trim-fade.mp4"),
    transition: "fade",
    transition_duration: 1,
  },
});
const concatTrimFadeJson = JSON.parse(concatTrimFadeRes.content[0].text);
console.log("concat trim+fade call: duration", concatTrimFadeJson.duration_seconds, "| expected", concatTrimFadeJson.expected_duration_seconds);
checkOk(near(concatTrimFadeJson.duration_seconds, 8, 0.1) && near(concatTrimFadeJson.expected_duration_seconds, 8, 0.01), "concat trim + fade gives 8s (5+4 minus 1s transition)", JSON.stringify(concatTrimFadeJson));
// Trim errors: end past duration, end <= start, and --fast + trim.
const concatTrimBadEnd = await callExpectThrow("concat", {
  inputs: [{ file: path.join(root, "test/source.mp4"), start: 0, end: 99 }, path.join(root, "test/source2.mp4")],
  output: path.join(root, "outputs/mcp-concat-trim-bad.mp4"),
});
checkOk(/past its duration/.test(concatTrimBadEnd), "concat trim end past duration is refused", concatTrimBadEnd.slice(0, 200));
const concatTrimBadOrder = await callExpectThrow("concat", {
  inputs: [{ file: path.join(root, "test/source.mp4"), start: 5, end: 2 }, path.join(root, "test/source2.mp4")],
  output: path.join(root, "outputs/mcp-concat-trim-bad2.mp4"),
});
checkOk(/must be after its start/.test(concatTrimBadOrder), "concat trim end <= start is refused", concatTrimBadOrder.slice(0, 200));
const concatTrimFast = await callExpectThrow("concat", {
  inputs: [{ file: path.join(root, "test/source.mp4"), start: 2, end: 5 }, path.join(root, "test/source.mp4")],
  output: path.join(root, "outputs/mcp-concat-trim-fast.mp4"),
  fast: true,
});
checkOk(/cannot trim clips/.test(concatTrimFast), "concat --fast + trim is refused with the keyframe reason", concatTrimFast.slice(0, 200));
// CLI path@start-end syntax: same 3+3 = 6s.
const concatCliTrim = await runCli(["concat", `${path.join(root, "test/source.mp4")}@2-5`, `${path.join(root, "test/source2.mp4")}@1-4`, "-o", path.join(root, "outputs/mcp-concat-cli-trim.mp4")]);
let concatCliTrimJson = null;
try { concatCliTrimJson = JSON.parse(concatCliTrim.out); } catch { /* not JSON */ }
checkOk(concatCliTrim.code === 0 && concatCliTrimJson?.mode === "trim" && near(concatCliTrimJson?.duration_seconds, 6, 0.1), "CLI concat path@start-end trims to 6s", concatCliTrim.out.slice(0, 200));

// extract_audio --channel: fixture test/stereo-lr.mp3 is stereo with a
// 440 Hz tone on the left and silence on the right. Channel 0 must
// come back mono with the tone (~-22 dB); channel 1 mono and silent
// (mean_volume -inf -> helper returns null, or below -60 dB);
// channel 2 is out of range.
const ch0Res = await client.callTool({
  name: "extract_audio",
  arguments: { input: path.join(root, "test/stereo-lr.mp3"), output: path.join(root, "outputs/mcp-ch0.mp3"), channel: 0 },
});
const ch0Json = JSON.parse(ch0Res.content[0].text);
console.log("extract_audio channel 0:", JSON.stringify(ch0Json));
checkOk(ch0Json.channels === 1 && ch0Json.channel === 0, "extract_audio --channel 0 returns mono and reports channel 0", JSON.stringify(ch0Json));
const ch0Vol = await meanVolume(path.join(root, "outputs/mcp-ch0.mp3"), 1, 2);
console.log("channel 0 mean volume:", ch0Vol);
checkOk(ch0Vol !== null && ch0Vol > -30 && ch0Vol < -10, "extract_audio channel 0 keeps the left tone (~-22 dB)", `got ${ch0Vol}`);
const ch1Res = await client.callTool({
  name: "extract_audio",
  arguments: { input: path.join(root, "test/stereo-lr.mp3"), output: path.join(root, "outputs/mcp-ch1.mp3"), channel: 1 },
});
const ch1Json = JSON.parse(ch1Res.content[0].text);
checkOk(ch1Json.channels === 1 && ch1Json.channel === 1, "extract_audio --channel 1 returns mono and reports channel 1", JSON.stringify(ch1Json));
const ch1Vol = await meanVolume(path.join(root, "outputs/mcp-ch1.mp3"), 1, 2);
console.log("channel 1 mean volume:", ch1Vol);
checkOk(ch1Vol === null || ch1Vol < -60, "extract_audio channel 1 is (near-)silent — the right channel really is silence", `got ${ch1Vol}`);
const ch2Text = await callExpectThrow("extract_audio", {
  input: path.join(root, "test/stereo-lr.mp3"),
  output: path.join(root, "outputs/mcp-ch2.mp3"),
  channel: 2,
});
checkOk(/out of range/.test(ch2Text) && /2 channel/.test(ch2Text), "extract_audio --channel 2 is refused (input has 2 channels)", ch2Text.slice(0, 200));
const chCli = await runCli(["extract-audio", path.join(root, "test/stereo-lr.mp3"), "--channel", "0", "-o", path.join(root, "outputs/mcp-ch0-cli.mp3")]);
let chCliJson = null;
try { chCliJson = JSON.parse(chCli.out); } catch { /* not JSON */ }
checkOk(chCli.code === 0 && chCliJson?.channels === 1 && chCliJson?.channel === 0, "CLI extract-audio --channel 0 returns mono", chCli.out.slice(0, 200));

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

// broll (turn 95): insert B-roll at timestamps — fullscreen cover or
// PiP, dissolve fades, audio swap/mix. Fixtures: broll-main.mp4 is a
// red 1280x720 10s clip with a 440 Hz tone; broll-blue.mp4 a blue
// 640x360 6s clip with an 880 Hz tone; broll-blue-noaudio.mp4 the
// same blue clip with no audio track.
const brollRes = await client.callTool({
  name: "broll",
  arguments: {
    input: path.join(root, "test/broll-main.mp4"),
    clips: [{ file: path.join(root, "test/broll-blue.mp4"), at: 2, duration: 3 }],
    output: path.join(root, "outputs/mcp-broll.mp4"),
  },
});
const brollJson = JSON.parse(brollRes.content[0].text);
console.log("broll call:", brollJson.dimensions, "|", brollJson.duration_seconds + "s", "|", JSON.stringify(brollJson.clips));
checkOk(brollJson.dimensions === "1280x720" && near(brollJson.duration_seconds, 10, 0.05), "broll keeps 1280x720 / 10s — the main timeline is never cut", `got ${brollJson.dimensions} ${brollJson.duration_seconds}s`);
checkOk(brollJson.clips?.length === 1 && brollJson.clips[0].at === 2 && brollJson.clips[0].duration_seconds === 3 && brollJson.clips[0].end_seconds === 5 && brollJson.clips[0].position === "fullscreen" && brollJson.clips[0].size === "1280x720" && brollJson.clips[0].clamped === false, "broll echoes the window: at 2, 3s, ends 5, fullscreen 1280x720, not clamped", JSON.stringify(brollJson.clips));
const brollBeforeR = await planeMean(path.join(root, "outputs/mcp-broll.mp4"), "640:360:320:180", "r", 1);
const brollBeforeB = await planeMean(path.join(root, "outputs/mcp-broll.mp4"), "640:360:320:180", "b", 1);
const brollInR = await planeMean(path.join(root, "outputs/mcp-broll.mp4"), "640:360:320:180", "r", 3);
const brollInB = await planeMean(path.join(root, "outputs/mcp-broll.mp4"), "640:360:320:180", "b", 3);
const brollAfterR = await planeMean(path.join(root, "outputs/mcp-broll.mp4"), "640:360:320:180", "r", 7);
const brollAfterB = await planeMean(path.join(root, "outputs/mcp-broll.mp4"), "640:360:320:180", "b", 7);
console.log("broll pixels: before R/B =", brollBeforeR, brollBeforeB, "| in R/B =", brollInR, brollInB, "| after R/B =", brollAfterR, brollAfterB);
checkOk(brollBeforeR > 200 && brollBeforeB < 20, "broll before the window is still the red main clip", `R=${brollBeforeR} B=${brollBeforeB}`);
checkOk(brollInR < 20 && brollInB > 200, "broll inside the window is the blue clip, fullscreen", `R=${brollInR} B=${brollInB}`);
checkOk(brollAfterR > 200 && brollAfterB < 20, "broll after the window is the red main clip again", `R=${brollAfterR} B=${brollAfterB}`);

// PiP: the same blue clip as a bottom-right overlay, scale 0.5 ->
// 640x360 at (616,336); the main clip shows through everywhere else.
const brollPipRes = await client.callTool({
  name: "broll",
  arguments: {
    input: path.join(root, "test/broll-main.mp4"),
    clips: [{ file: path.join(root, "test/broll-blue.mp4"), at: 2, duration: 3, position: "bottom-right", scale: 0.5 }],
    output: path.join(root, "outputs/mcp-broll-pip.mp4"),
  },
});
const brollPipJson = JSON.parse(brollPipRes.content[0].text);
checkOk(brollPipJson.clips[0].size === "640x360" && brollPipJson.clips[0].x === 616 && brollPipJson.clips[0].y === 336, "broll PiP bottom-right scale 0.5 lands at 616,336 as 640x360", JSON.stringify(brollPipJson.clips));
const brollPipCornerB = await planeMean(path.join(root, "outputs/mcp-broll-pip.mp4"), "200:100:700:400", "b", 3);
const brollPipCornerR = await planeMean(path.join(root, "outputs/mcp-broll-pip.mp4"), "200:100:700:400", "r", 3);
const brollPipTopR = await planeMean(path.join(root, "outputs/mcp-broll-pip.mp4"), "400:200:0:0", "r", 3);
checkOk(brollPipCornerB > 200 && brollPipCornerR < 20, "broll PiP corner is blue inside the window", `R=${brollPipCornerR} B=${brollPipCornerB}`);
checkOk(brollPipTopR > 200, "broll PiP leaves the top-left red (main shows through outside the PiP)", `R=${brollPipTopR}`);

// Fade: mid-dissolve the frame is a true red+blue blend, and the
// window settles to full blue once the dissolve finishes.
const brollFadeRes = await client.callTool({
  name: "broll",
  arguments: {
    input: path.join(root, "test/broll-main.mp4"),
    clips: [{ file: path.join(root, "test/broll-blue.mp4"), at: 2, duration: 4, fade: 1 }],
    output: path.join(root, "outputs/mcp-broll-fade.mp4"),
  },
});
const brollFadeJson = JSON.parse(brollFadeRes.content[0].text);
checkOk(brollFadeJson.clips[0].fade_seconds === 1, "broll echoes fade 1s", JSON.stringify(brollFadeJson.clips));
const brollFadeMidR = await planeMean(path.join(root, "outputs/mcp-broll-fade.mp4"), "640:360:320:180", "r", 2.5);
const brollFadeMidB = await planeMean(path.join(root, "outputs/mcp-broll-fade.mp4"), "640:360:320:180", "b", 2.5);
const brollFadeFullB = await planeMean(path.join(root, "outputs/mcp-broll-fade.mp4"), "640:360:320:180", "b", 4);
console.log("broll fade: mid R/B =", brollFadeMidR, brollFadeMidB, "| full B =", brollFadeFullB);
checkOk(brollFadeMidR > 80 && brollFadeMidR < 180 && brollFadeMidB > 80 && brollFadeMidB < 180, "broll fade mid-point is a true blend (red+blue, not a hard cut or black)", `R=${brollFadeMidR} B=${brollFadeMidB}`);
checkOk(brollFadeFullB > 200, "broll fade settles to full blue after the dissolve", `B=${brollFadeFullB}`);

// Content timing (the fade bug's root cause): the window must show
// the clip from ITS start, not from the insert time — scenes-source
// is red 0-5s then blue 5-10s, so a [2,6) window shows local [0,4),
// all red. Before the setpts fix the overlay consumed the clip from
// main t=0 and t=5.5 came out blue (local 3.5s too late).
const brollTimingRes = await client.callTool({
  name: "broll",
  arguments: {
    input: path.join(root, "test/broll-main.mp4"),
    clips: [{ file: path.join(root, "test/scenes-source.mp4"), at: 2, duration: 4 }],
    output: path.join(root, "outputs/mcp-broll-timing.mp4"),
  },
});
const brollTimingR = await planeMean(path.join(root, "outputs/mcp-broll-timing.mp4"), "640:360:320:180", "r", 5.5);
const brollTimingB = await planeMean(path.join(root, "outputs/mcp-broll-timing.mp4"), "640:360:320:180", "b", 5.5);
checkOk(brollTimingR > 200 && brollTimingB < 20, "broll window shows the clip from its own start (t=5.5 is still red, local 3.5s)", `R=${brollTimingR} B=${brollTimingB}`);

// Clamp + rejects: a window past the end is clamped and reported;
// overlapping windows and unknown positions are refused.
const brollClampRes = await client.callTool({
  name: "broll",
  arguments: {
    input: path.join(root, "test/broll-main.mp4"),
    clips: [{ file: path.join(root, "test/broll-blue.mp4"), at: 8, duration: 6 }],
    output: path.join(root, "outputs/mcp-broll-clamp.mp4"),
  },
});
const brollClampJson = JSON.parse(brollClampRes.content[0].text);
checkOk(brollClampJson.clips[0].clamped === true && brollClampJson.clips[0].duration_seconds === 2 && brollClampJson.clips[0].end_seconds === 10, "broll clamps a window past the end (8+6 -> 2s, ends 10) and reports it", JSON.stringify(brollClampJson.clips));
const brollOverlapText = await callExpectThrow("broll", {
  input: path.join(root, "test/broll-main.mp4"),
  clips: [
    { file: path.join(root, "test/broll-blue.mp4"), at: 2, duration: 3 },
    { file: path.join(root, "test/broll-blue.mp4"), at: 4, duration: 2 },
  ],
  output: path.join(root, "outputs/mcp-broll-overlap.mp4"),
});
checkOk(/overlap/.test(brollOverlapText), "broll refuses overlapping windows", brollOverlapText.slice(0, 160));
const brollBadPosText = await callExpectThrow("broll", {
  input: path.join(root, "test/broll-main.mp4"),
  clips: [{ file: path.join(root, "test/broll-blue.mp4"), at: 2, duration: 2, position: "middle" }],
  output: path.join(root, "outputs/mcp-broll-badpos.mp4"),
});
// MCP validates the enum before core runs, so the refusal is the
// zod error, not core's "position must be" — the core message is
// covered by the CLI assert below instead.
checkOk(/Invalid enum value/.test(brollBadPosText), "broll refuses an unknown position (MCP enum validation)", brollBadPosText.slice(0, 160));
const brollBadPosCliErr = await runCliExpectError(["broll", path.join(root, "test/broll-main.mp4"), "--clip", `${path.join(root, "test/broll-blue.mp4")}@2@2`, "--position", "middle", "-o", path.join(root, "outputs/mcp-broll-badpos-cli.mp4")]);
checkOk(brollBadPosCliErr !== null && /position must be/.test(brollBadPosCliErr), "CLI broll refuses an unknown position with core's message", (brollBadPosCliErr ?? "").slice(0, 160));

// Audio: audio=broll with a silent clip mutes the window (the main
// tone is gone inside, present outside) and says so; audio=mix
// keeps the main tone under the same silent clip.
const brollAudioRes = await client.callTool({
  name: "broll",
  arguments: {
    input: path.join(root, "test/broll-main.mp4"),
    clips: [{ file: path.join(root, "test/broll-blue-noaudio.mp4"), at: 2, duration: 3 }],
    output: path.join(root, "outputs/mcp-broll-audio.mp4"),
    audio: "broll",
  },
});
const brollAudioJson = JSON.parse(brollAudioRes.content[0].text);
const brollAudioInVol = await meanVolume(path.join(root, "outputs/mcp-broll-audio.mp4"), 2.5, 1);
const brollAudioOutVol = await meanVolume(path.join(root, "outputs/mcp-broll-audio.mp4"), 0.5, 1);
console.log("broll audio=broll: in-window vol =", brollAudioInVol, "| outside =", brollAudioOutVol, "| notes =", JSON.stringify(brollAudioJson.audio_notes));
checkOk((brollAudioInVol === null || brollAudioInVol < -60) && brollAudioOutVol !== null && brollAudioOutVol > -40, "broll audio=broll silences the window whose clip has no audio, main tone continues outside", `in=${brollAudioInVol} out=${brollAudioOutVol}`);
checkOk(Array.isArray(brollAudioJson.audio_notes) && /goes silent/.test(brollAudioJson.audio_notes.join(" ")), "broll reports the silent window in audio_notes", JSON.stringify(brollAudioJson.audio_notes));
const brollMixRes = await client.callTool({
  name: "broll",
  arguments: {
    input: path.join(root, "test/broll-main.mp4"),
    clips: [{ file: path.join(root, "test/broll-blue-noaudio.mp4"), at: 2, duration: 3 }],
    output: path.join(root, "outputs/mcp-broll-mix.mp4"),
    audio: "mix",
  },
});
const brollMixInVol = await meanVolume(path.join(root, "outputs/mcp-broll-mix.mp4"), 2.5, 1);
checkOk(brollMixInVol !== null && brollMixInVol > -40, "broll audio=mix keeps the main tone inside the window", `vol=${brollMixInVol}`);

// CLI: --clip file@at@duration renders; missing --clip exits 2.
const brollCli = await runCli(["broll", path.join(root, "test/broll-main.mp4"), "--clip", `${path.join(root, "test/broll-blue.mp4")}@2@3`, "-o", path.join(root, "outputs/mcp-broll-cli.mp4")]);
let brollCliJson = null;
try { brollCliJson = JSON.parse(brollCli.out); } catch { /* not JSON */ }
checkOk(brollCli.code === 0 && near(brollCliJson?.duration_seconds, 10, 0.05) && brollCliJson?.clips?.[0]?.at === 2, "CLI broll --clip file@at@duration renders 10s", brollCli.out.slice(0, 200));
const brollCliNoClipErr = await runCliExpectError(["broll", path.join(root, "test/broll-main.mp4"), "-o", path.join(root, "outputs/mcp-broll-noclip.mp4")]);
checkOk(brollCliNoClipErr !== null && /--clip/.test(brollCliNoClipErr), "CLI broll without --clip exits 2 naming --clip", (brollCliNoClipErr ?? "").slice(0, 160));

// Manifest: broll as a pipeline step (clip file hashed into the
// cache key like slideshow images), plus a bad-clips refusal.
const brollManifestPath = path.join(root, "outputs/mcp-manifest-broll.json");
await writeFile(brollManifestPath, JSON.stringify({ version: 1, input: path.join(root, "test/broll-main.mp4"), output: path.join(root, "outputs/mcp-manifest-broll.mp4"), steps: [{ tool: "broll", args: { clips: [{ file: path.join(root, "test/broll-blue.mp4"), at: 2, duration: 3 }], audio: "main" } }] }), "utf8");
const brollManifestRes = await client.callTool({ name: "manifest", arguments: { manifest_path: brollManifestPath } });
const brollManifestJson = JSON.parse(brollManifestRes.content[0].text);
checkOk(brollManifestJson.steps?.[0]?.status === "ok" && near(brollManifestJson.final?.duration_seconds, 10, 0.05), "manifest broll step runs ok, final 10s", JSON.stringify(brollManifestJson.steps?.map((s) => s.status)));
const brollManifestInB = await planeMean(path.join(root, "outputs/mcp-manifest-broll.mp4"), "640:360:320:180", "b", 3);
checkOk(brollManifestInB > 200, "manifest broll output is blue inside the window", `B=${brollManifestInB}`);
const brollManifestBadPath = path.join(root, "outputs/mcp-manifest-broll-bad.json");
await writeFile(brollManifestBadPath, JSON.stringify({ version: 1, input: path.join(root, "test/broll-main.mp4"), output: path.join(root, "outputs/mcp-manifest-broll-bad.mp4"), steps: [{ tool: "broll", args: { clips: [{ file: path.join(root, "test/broll-blue.mp4") }] } }] }), "utf8");
const brollManifestBadText = await callExpectThrow("manifest", { manifest_path: brollManifestBadPath });
checkOk(/clips\[0\]\.at/.test(brollManifestBadText), "manifest refuses a broll step whose clip has no at, before rendering", brollManifestBadText.slice(0, 200));

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
// PSNR between two still frames (same size), via the psnr filter:
// the printed "average" is the mean PSNR over the Y/U/V planes.
// A 50/50 crossfade blend of A and B has
// PSNR(blend, A) ≈ PSNR(blend, B) ≈ PSNR(A, B) + 6.02 dB.
async function framePsnr(fileA, fileB) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-nostdin", "-v", "info", "-i", fileA, "-i", fileB, "-lavfi", "psnr", "-f", "null", "-"]);
    const m = stderr.match(/average:([0-9.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}
async function extractPng(file, time, out) {
  await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-y", out]);
}

async function planeMean(file, crop, plane, time = null) {
  try {
    const vf = plane === "a"
      ? `format=rgba,crop=${crop},alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG`
      : `format=rgba,crop=${crop},extractplanes=${plane},signalstats,metadata=print:key=lavfi.signalstats.YAVG`;
    const args = time === null ? ["-i", file] : ["-ss", String(time), "-i", file];
    const { stderr } = await execFileAsync("ffmpeg", [...args, "-vf", vf, "-frames:v", "1", "-f", "null", "-"]);
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
// titlecard dry-run (lượt 116, batch 5): font/colors computed, exact
// command, no output file (the drawtext text file is kept by design).
const titleDryRes = await client.callTool({
  name: "titlecard",
  arguments: { text: "Dry Run Test", output: path.join(root, "outputs/mcp-titlecard-dry.png"), dry_run: true },
});
const titleDryJson = JSON.parse(titleDryRes.content[0].text);
checkOk(titleDryJson.dry_run === true && titleDryJson.font_size === 119 && titleDryJson.text_color === "FFD60A" && titleDryJson.box_color === "F97316" && titleDryJson.dimensions === "1080x1920" && titleDryJson.size_bytes === null && !existsSync(path.join(root, "outputs/mcp-titlecard-dry.png")), "titlecard dry-run reports 119px yellow-on-orange at 1080x1920, size null, writes no output file", JSON.stringify(titleDryJson));
checkOk(titleDryJson.commands?.length === 1 && titleDryJson.commands[0].includes("nullsrc=s=1080x1920") && titleDryJson.commands[0].includes("drawtext=") && titleDryJson.commands[0].includes("fontsize=119"), "titlecard dry-run command renders the card from a transparent nullsrc canvas", titleDryJson.commands?.[0] ?? "");

// titlecard --style: all three locked ids resolve to the styles.json
// palette (this also proves the loader's id cross-check passes), a
// scoped override wins for one key only and is reported, and an
// unknown id is refused. Pixel-verify minimal-line: near-black box
// (0x111111) with white text — the band is dark and grey (R=G=B),
// unlike the default orange card (R high, G mid, B low).
const styleExpected = {
  "clean-bold": { text_color: "FFD60A", box_color: "F97316", font_size: 120 },
  "minimal-line": { text_color: "FFFFFF", box_color: "111111", font_size: 120 },
  "warm-story": { text_color: "FFF7ED", box_color: "B45309", font_size: 120 },
};
for (const [id, want] of Object.entries(styleExpected)) {
  const r = await client.callTool({
    name: "titlecard",
    arguments: { text: "Style Check", output: path.join(root, `outputs/mcp-titlecard-${id}.png`), style: id },
  });
  const j = JSON.parse(r.content[0].text);
  checkOk(j.style === id && j.text_color === want.text_color && j.box_color === want.box_color && j.font_size === want.font_size,
    `titlecard --style ${id} resolves to the locked palette`, JSON.stringify({ style: j.style, text_color: j.text_color, box_color: j.box_color, font_size: j.font_size }));
  checkOk(Array.isArray(j.style_overrides) && j.style_overrides.length === 0, `titlecard --style ${id} reports no overrides`, JSON.stringify(j.style_overrides));
}
const titleOverrideRes = await client.callTool({
  name: "titlecard",
  arguments: { text: "Style Check", output: path.join(root, "outputs/mcp-titlecard-override.png"), style: "clean-bold", text_color: "FFFFFF" },
});
const titleOverrideJson = JSON.parse(titleOverrideRes.content[0].text);
checkOk(titleOverrideJson.text_color === "FFFFFF" && titleOverrideJson.box_color === "F97316" && titleOverrideJson.style === "clean-bold",
  "titlecard scoped override wins for text_color only", JSON.stringify({ text_color: titleOverrideJson.text_color, box_color: titleOverrideJson.box_color }));
checkOk(JSON.stringify(titleOverrideJson.style_overrides) === JSON.stringify(["text_color"]),
  "titlecard reports the scoped override", JSON.stringify(titleOverrideJson.style_overrides));
const titleBadStyleRes = await client.callTool({
  name: "titlecard",
  arguments: { text: "Hi", output: path.join(root, "outputs/mcp-titlecard-bad.png"), style: "neon" },
});
const titleBadStyleJson = JSON.parse(titleBadStyleRes.content[0].text);
checkOk(titleBadStyleRes.isError === true && /style must be one of/.test(titleBadStyleJson.error ?? ""),
  "titlecard rejects an unknown style id", JSON.stringify(titleBadStyleJson));
const minBandR = await planeMean(path.join(root, "outputs/mcp-titlecard-minimal-line.png"), "1080:500:0:800", "r");
const minBandG = await planeMean(path.join(root, "outputs/mcp-titlecard-minimal-line.png"), "1080:500:0:800", "g");
const minBandB = await planeMean(path.join(root, "outputs/mcp-titlecard-minimal-line.png"), "1080:500:0:800", "b");
const minBandA = await planeMean(path.join(root, "outputs/mcp-titlecard-minimal-line.png"), "1080:500:0:800", "a");
console.log("titlecard minimal-line pixels: band R/G/B/A =", minBandR, minBandG, minBandB, minBandA);
checkOk(minBandR !== null && minBandR < 45, "titlecard minimal-line band is dark (near-black box)", `got R=${minBandR}`);
checkOk(minBandR !== null && minBandG !== null && Math.abs(minBandR - minBandG) < 5 && minBandB !== null && Math.abs(minBandR - minBandB) < 5,
  "titlecard minimal-line band is grey, not warm (R=G=B)", `got R/G/B=${minBandR}/${minBandG}/${minBandB}`);
checkOk(minBandA !== null && minBandA > 50, "titlecard minimal-line band is opaque (the box is there)", `got A=${minBandA}`);

// titlecard --brand: the same registry as assemble paints the card
// (primary = box, on_primary = text). The brand never sets the font
// size — 119px is the card's own default, not the brand's 64px text
// size. Pixel-verify warm-story: the brown box (B45309) carries blue
// in the band (B ~30), unlike the default orange box (B ~8).
const titleBrandRes = await client.callTool({
  name: "titlecard",
  arguments: { text: "Warm Story Brand", output: path.join(root, "outputs/mcp-titlecard-brand.png"), brand: "warm-story" },
});
const titleBrandJson = JSON.parse(titleBrandRes.content[0].text);
checkOk(titleBrandJson.brand === "warm-story" && titleBrandJson.text_color === "FFF7ED" && titleBrandJson.box_color === "B45309" && titleBrandJson.font_size === 119,
  "titlecard --brand warm-story resolves to the brand palette, font stays the card default", JSON.stringify({ brand: titleBrandJson.brand, text_color: titleBrandJson.text_color, box_color: titleBrandJson.box_color, font_size: titleBrandJson.font_size }));
checkOk(JSON.stringify(titleBrandJson.brand_applied) === JSON.stringify(["text_color", "box_color"]) && JSON.stringify(titleBrandJson.brand_overrides) === JSON.stringify([]),
  "titlecard --brand reports both colours applied, none overridden", JSON.stringify({ applied: titleBrandJson.brand_applied, overrides: titleBrandJson.brand_overrides }));
const titleBrandB = await planeMean(path.join(root, "outputs/mcp-titlecard-brand.png"), "1080:500:0:800", "b");
console.log("titlecard warm-story pixels: band B =", titleBrandB);
checkOk(titleBrandB !== null && titleBrandB > 20, "titlecard warm-story band carries blue (brown box, not orange)", `got B=${titleBrandB}`);
const titleBrandOvRes = await client.callTool({
  name: "titlecard",
  arguments: { text: "Warm Story Brand", output: path.join(root, "outputs/mcp-titlecard-brand-ov.png"), brand: "warm-story", text_color: "FFFFFF" },
});
const titleBrandOvJson = JSON.parse(titleBrandOvRes.content[0].text);
checkOk(titleBrandOvJson.text_color === "FFFFFF" && titleBrandOvJson.box_color === "B45309" && JSON.stringify(titleBrandOvJson.brand_overrides) === JSON.stringify(["text_color"]) && JSON.stringify(titleBrandOvJson.brand_applied) === JSON.stringify(["box_color"]),
  "titlecard explicit text_color beats the brand, box stays brand", JSON.stringify({ text_color: titleBrandOvJson.text_color, box_color: titleBrandOvJson.box_color, applied: titleBrandOvJson.brand_applied, overrides: titleBrandOvJson.brand_overrides }));
const titleBrandBothRes = await client.callTool({
  name: "titlecard",
  arguments: { text: "Both", output: path.join(root, "outputs/mcp-titlecard-brand-style.png"), brand: "amber-teal", style: "warm-story" },
});
const titleBrandBothJson = JSON.parse(titleBrandBothRes.content[0].text);
checkOk(titleBrandBothJson.text_color === "111827" && titleBrandBothJson.box_color === "F59E0B" && titleBrandBothJson.font_size === 120,
  "titlecard brand colours beat style colours, style still sets the font size", JSON.stringify({ text_color: titleBrandBothJson.text_color, box_color: titleBrandBothJson.box_color, font_size: titleBrandBothJson.font_size }));
const titleBadBrandRes = await client.callTool({
  name: "titlecard",
  arguments: { text: "Hi", output: path.join(root, "outputs/mcp-titlecard-badbrand.png"), brand: "nope" },
});
const titleBadBrandJson = JSON.parse(titleBadBrandRes.content[0].text);
checkOk(titleBadBrandRes.isError === true && /brand must be one of/.test(titleBadBrandJson.error ?? ""),
  "titlecard rejects an unknown brand id", JSON.stringify(titleBadBrandJson));

// Custom brands from a MEDIAKIT_BRANDS file (lượt 81): a file of
// your own adds brand ids next to the three built-ins — the
// titlecard paints in the custom palette, built-ins still work,
// and without the env the custom id is unknown. A second MCP
// client carries the env (same pattern as the no-ASR client).
const customBrandsPath = path.join(root, "test/brands-custom.json");
const brandsTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
  env: { ...process.env, MEDIAKIT_BRANDS: customBrandsPath },
});
const brandsClient = new Client({ name: "mediakit-test-brands", version: "0.1.0" }, { capabilities: {} });
await brandsClient.connect(brandsTransport);
const titleCustomRes = await brandsClient.callTool({
  name: "titlecard",
  arguments: { text: "Ink Paper Test", output: path.join(root, "outputs/mcp-titlecard-brand-custom.png"), brand: "ink-paper" },
});
const titleCustomJson = JSON.parse(titleCustomRes.content[0].text);
checkOk(titleCustomJson.brand === "ink-paper" && titleCustomJson.text_color === "082F49" && titleCustomJson.box_color === "22D3EE" && titleCustomJson.font_size === 119,
  "titlecard --brand ink-paper (MEDIAKIT_BRANDS) resolves to the custom palette, font stays the card default", JSON.stringify({ brand: titleCustomJson.brand, text_color: titleCustomJson.text_color, box_color: titleCustomJson.box_color, font_size: titleCustomJson.font_size }));
checkOk(JSON.stringify(titleCustomJson.brand_applied) === JSON.stringify(["text_color", "box_color"]) && JSON.stringify(titleCustomJson.brand_overrides) === JSON.stringify([]),
  "titlecard custom brand reports both colours applied, none overridden", JSON.stringify({ applied: titleCustomJson.brand_applied, overrides: titleCustomJson.brand_overrides }));
// Pixel proof: the box is cyan 22D3EE (R34 G211 B238). Do NOT use
// the wide middle band here (the warm-story test does): the canvas
// outside the box is transparent, so a 500px band dilutes the box
// mean to G≈39 and no threshold separates cyan from brown. The
// box spans y 975–1125 for this text (measured on disk) and the
// text starts ~30px below its top edge, so a 16px strip at y 982
// is pure box: G 211, R 34, B 238, measured exactly.
const titleCustomG = await planeMean(path.join(root, "outputs/mcp-titlecard-brand-custom.png"), "1080:16:0:982", "g");
const titleCustomR = await planeMean(path.join(root, "outputs/mcp-titlecard-brand-custom.png"), "1080:16:0:982", "r");
console.log("titlecard ink-paper pixels: strip G =", titleCustomG, "R =", titleCustomR);
checkOk(titleCustomG !== null && titleCustomG > 180 && titleCustomR !== null && titleCustomR < 80, "titlecard custom brand box is really cyan on the pixels (green high, red low)", `got G=${titleCustomG} R=${titleCustomR}`);
// Built-ins still resolve through the same client, and the custom
// id is unknown without the env.
const titleBuiltInRes = await brandsClient.callTool({ name: "titlecard", arguments: { text: "Warm", output: path.join(root, "outputs/mcp-titlecard-brand-builtin.png"), brand: "warm-story" } });
const titleBuiltInJson = JSON.parse(titleBuiltInRes.content[0].text);
checkOk(titleBuiltInJson.brand === "warm-story" && titleBuiltInJson.box_color === "B45309", "titlecard built-in brand still resolves when MEDIAKIT_BRANDS is set", JSON.stringify({ brand: titleBuiltInJson.brand, box_color: titleBuiltInJson.box_color }));
const titleCustomNoEnvRes = await client.callTool({ name: "titlecard", arguments: { text: "Hi", output: path.join(root, "outputs/mcp-titlecard-brand-noenv.png"), brand: "ink-paper" } });
const titleCustomNoEnvJson = JSON.parse(titleCustomNoEnvRes.content[0].text);
checkOk(titleCustomNoEnvRes.isError === true && /must be one of amber-teal, warm-story, minimal-line/.test(titleCustomNoEnvJson.error ?? ""), "titlecard custom brand id is unknown without MEDIAKIT_BRANDS (error lists only the built-ins)", JSON.stringify(titleCustomNoEnvJson));
// intro paints from the same custom registry: background is the
// brand background, text is the brand text. Duration 2, not 1:
// the default fades are 0.5 + 0.5 and must stay shorter than the
// duration, so a 1s intro is refused before it renders.
const introCustomRes = await brandsClient.callTool({ name: "intro", arguments: { text: "Ink Paper", output: path.join(root, "outputs/mcp-intro-brand-custom.mp4"), duration: 2, brand: "ink-paper" } });
const introCustomJson = JSON.parse(introCustomRes.content[0].text);
checkOk(introCustomJson.bg_color === "0B1220" && introCustomJson.text_color === "F8FAFC", "intro --brand ink-paper (MEDIAKIT_BRANDS) takes the custom background + text", JSON.stringify({ bg_color: introCustomJson.bg_color, text_color: introCustomJson.text_color }));
// doctor reports the custom file: set, path, and the extra id in custom.
const brandsDoctorRes = await brandsClient.callTool({ name: "doctor", arguments: {} });
const brandsDoctorJson = JSON.parse(brandsDoctorRes.content[0].text);
checkOk(brandsDoctorJson.brands_file?.set === true && brandsDoctorJson.brands_file?.path === customBrandsPath && JSON.stringify(brandsDoctorJson.brands_file?.custom) === JSON.stringify(["ink-paper"]) && brandsDoctorJson.ok === true, "doctor reports the MEDIAKIT_BRANDS file with the custom id, ok stays true", JSON.stringify(brandsDoctorJson.brands_file));
// The same file must not redefine a built-in id, must exist, and
// must hold valid hex + valid JSON — all four fail through the CLI
// (env per call via runCliJson) with the file named in the error.
async function runCliExpectError(args, env = {}) {
  try {
    await execFileAsync(process.execPath, [path.join(root, "bin/mediakit.js"), ...args], { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
    return null;
  } catch (e) {
    return String(e.stderr ?? e.message ?? "");
  }
}
const brandsRedefine = JSON.parse(await readFile(customBrandsPath, "utf8"));
brandsRedefine.brands[0].id = "amber-teal";
const brandsRedefinePath = path.join(root, "outputs/mcp-brands-redefine.json");
await writeFile(brandsRedefinePath, JSON.stringify(brandsRedefine), "utf8");
const brandsRedefineErr = await runCliExpectError(["titlecard", "X", "-o", path.join(root, "outputs/mcp-titlecard-brand-redefine.png"), "--brand", "amber-teal"], { MEDIAKIT_BRANDS: brandsRedefinePath });
checkOk(brandsRedefineErr !== null && /redefines a built-in brand id/.test(brandsRedefineErr) && brandsRedefineErr.includes(brandsRedefinePath), "MEDIAKIT_BRANDS file redefining a built-in id is refused, naming the file", (brandsRedefineErr ?? "").slice(0, 200));
const brandsMissingErr = await runCliExpectError(["titlecard", "X", "-o", path.join(root, "outputs/mcp-titlecard-brand-missing.png"), "--brand", "ink-paper"], { MEDIAKIT_BRANDS: path.join(root, "outputs/does-not-exist-brands.json") });
checkOk(brandsMissingErr !== null && /MEDIAKIT_BRANDS file not found/.test(brandsMissingErr), "MEDIAKIT_BRANDS pointing at a missing file fails loudly", (brandsMissingErr ?? "").slice(0, 200));
const brandsBadHex = JSON.parse(await readFile(customBrandsPath, "utf8"));
brandsBadHex.brands[0].palette.primary = "ZZZZZZ";
const brandsBadHexPath = path.join(root, "outputs/mcp-brands-badhex.json");
await writeFile(brandsBadHexPath, JSON.stringify(brandsBadHex), "utf8");
const brandsBadHexErr = await runCliExpectError(["titlecard", "X", "-o", path.join(root, "outputs/mcp-titlecard-brand-badhex.png"), "--brand", "ink-paper"], { MEDIAKIT_BRANDS: brandsBadHexPath });
checkOk(brandsBadHexErr !== null && /palette\.primary must be a 6-digit hex color/.test(brandsBadHexErr), "MEDIAKIT_BRANDS file with a bad hex palette value is refused", (brandsBadHexErr ?? "").slice(0, 200));
const brandsBadJsonPath = path.join(root, "outputs/mcp-brands-badjson.json");
await writeFile(brandsBadJsonPath, "not json", "utf8");
const brandsBadJsonErr = await runCliExpectError(["titlecard", "X", "-o", path.join(root, "outputs/mcp-titlecard-brand-badjson.png"), "--brand", "ink-paper"], { MEDIAKIT_BRANDS: brandsBadJsonPath });
checkOk(brandsBadJsonErr !== null && /not valid JSON/.test(brandsBadJsonErr), "MEDIAKIT_BRANDS file with invalid JSON is refused", (brandsBadJsonErr ?? "").slice(0, 200));
await brandsClient.close();

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

// burn_captions --dry-run (lượt 113, batch 4): font/margin/style
// are computed from the input probe, so they are exact; the printed
// subtitles command is the real one.
const capsDryRes = await client.callTool({
  name: "burn_captions",
  arguments: { input: path.join(root, "test/source.mp4"), captions: path.join(root, "test/captions.srt"), output: path.join(root, "outputs/mcp-captions-dry.mp4"), dry_run: true },
});
const capsDryJson = JSON.parse(capsDryRes.content[0].text);
checkOk(capsDryJson.dry_run === true && capsDryJson.font_size === 22 && capsDryJson.margin_v === 187 && capsDryJson.style === "background" && capsDryJson.duration_seconds === null && capsDryJson.size_bytes === null, "burn_captions dry-run reports the exact computed font/margin/style (22/187/background), duration/size null", JSON.stringify(capsDryJson));
checkOk(capsDryJson.commands?.length === 1 && capsDryJson.commands[0].includes("subtitles=") && capsDryJson.commands[0].includes("FontSize=22") && capsDryJson.commands[0].includes("MarginV=187"), "burn_captions dry-run prints the exact subtitles command", capsDryJson.commands?.[0] ?? "");
checkOk(!existsSync(path.join(root, "outputs/mcp-captions-dry.mp4")), "burn_captions dry-run writes no file", "outputs/mcp-captions-dry.mp4");
const capsDryCli = await runCliJson(["burn-captions", path.join(root, "test/source.mp4"), "--captions", path.join(root, "test/captions.srt"), "-o", path.join(root, "outputs/mcp-captions-cli-dry.mp4"), "--style", "glow", "--dry-run"]);
checkOk(capsDryCli.dry_run === true && capsDryCli.commands?.[0]?.includes("subtitles=") && capsDryCli.commands?.[0]?.includes("Outline=4") && !existsSync(path.join(root, "outputs/mcp-captions-cli-dry.mp4")), "CLI burn-captions --dry-run prints the glow command and writes no file", JSON.stringify(capsDryCli.commands));

// burn_captions on a rotated clip: defaults scale with the DISPLAY
// frame (1080x1920), not the coded 1920x1080 — font 60px, margin
// 499px. Before the fix this reported 33px/281px and the text landed
// inside the platform UI zone at the bottom.
const capsRotRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/rotated-vertical.mp4"),
    captions: path.join(root, "test/captions.srt"),
    output: path.join(root, "outputs/mcp-captions-rotated.mp4"),
  },
});
const capsRotJson = JSON.parse(capsRotRes.content[0].text);
console.log("burn_captions rotated call:", "font_size", capsRotJson.font_size, "| margin_v", capsRotJson.margin_v);
checkOk(capsRotJson.font_size === 60, "burn_captions default font is 60px on a 1080x1920 display frame", `got ${capsRotJson.font_size}`);
checkOk(capsRotJson.margin_v === 499, "burn_captions default margin is 499px on a 1080x1920 display frame", `got ${capsRotJson.margin_v}`);
// Pixel-verify at t=3.5s (cue 2): the text baseline sits at
// 1920-499, so the band 1330-1400 differs a lot, while the bottom
// strip 1880-1920 (inside the platform UI zone) stays clean.
const capsRotBand = await bandPsnr(path.join(root, "test/rotated-vertical.mp4"), path.join(root, "outputs/mcp-captions-rotated.mp4"), 3.5, 1330, 70);
checkOk(capsRotBand !== null && capsRotBand < 30, "burn_captions text lands in the safe band on a rotated clip", `got PSNR ${capsRotBand}`);
const capsRotStrip = await bandPsnr(path.join(root, "test/rotated-vertical.mp4"), path.join(root, "outputs/mcp-captions-rotated.mp4"), 3.5, 1880, 40);
checkOk(capsRotStrip !== null && capsRotStrip > 40, "burn_captions text stays out of the bottom strip on a rotated clip", `got PSNR ${capsRotStrip}`);

// burn_captions --max-lines: fit-to-width. On a 1080x1920 display
// frame the longest cue of captions-fit.srt (92 chars) needs 3 lines
// at the 60px default, so max_lines=2 shrinks the whole track to
// 46px (measured with Liberation Sans, the font libass actually
// draws). Pixel-verify at t=4s (cue 3): the band where the 3rd line
// sat (y 1230-1280) is clean in the fitted render (PSNR > 30) but
// carries box+text without fit (PSNR < 30), while the shared line
// zone (y 1360-1400) has text in both (PSNR < 30).
const capsFitNoRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/rotated-vertical.mp4"),
    captions: path.join(root, "test/captions-fit.srt"),
    output: path.join(root, "outputs/mcp-captions-fit-nofit.mp4"),
  },
});
const capsFitNoJson = JSON.parse(capsFitNoRes.content[0].text);
checkOk(capsFitNoJson.font_size === 60, "burn_captions without max_lines keeps the 60px default", `got ${capsFitNoJson.font_size}`);
checkOk(capsFitNoJson.fit === null, "burn_captions without max_lines reports fit=null", JSON.stringify(capsFitNoJson.fit));
const capsFitRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/rotated-vertical.mp4"),
    captions: path.join(root, "test/captions-fit.srt"),
    output: path.join(root, "outputs/mcp-captions-fit.mp4"),
    max_lines: 2,
  },
});
const capsFitJson = JSON.parse(capsFitRes.content[0].text);
console.log("burn_captions fit call:", "font_size", capsFitJson.font_size, "| fit", JSON.stringify(capsFitJson.fit));
checkOk(capsFitJson.font_size === 46, "burn_captions max_lines=2 shrinks 60px to 46px for the 92-char cue", `got ${capsFitJson.font_size}`);
checkOk(capsFitJson.fit?.fits === true && capsFitJson.fit?.shrunk === 14 && capsFitJson.fit?.lines_at_size === 2, "burn_captions fit reports fits=true, shrunk=14, 2 lines", JSON.stringify(capsFitJson.fit));
checkOk(capsFitJson.fit?.width_px === 972, "burn_captions fit width budget is 90% of 1080", `got ${capsFitJson.fit?.width_px}`);
const fitThirdLine = await bandPsnr(path.join(root, "test/rotated-vertical.mp4"), path.join(root, "outputs/mcp-captions-fit.mp4"), 4, 1230, 50);
checkOk(fitThirdLine !== null && fitThirdLine > 30, "burn_captions fitted render has no 3rd line in y1230-1280 (high PSNR)", `got PSNR ${fitThirdLine}`);
const nofitThirdLine = await bandPsnr(path.join(root, "test/rotated-vertical.mp4"), path.join(root, "outputs/mcp-captions-fit-nofit.mp4"), 4, 1230, 50);
checkOk(nofitThirdLine !== null && nofitThirdLine < 30, "burn_captions unfitted render has the 3rd line in y1230-1280 (low PSNR)", `got PSNR ${nofitThirdLine}`);
const fitSharedLine = await bandPsnr(path.join(root, "test/rotated-vertical.mp4"), path.join(root, "outputs/mcp-captions-fit.mp4"), 4, 1360, 40);
checkOk(fitSharedLine !== null && fitSharedLine < 30, "burn_captions fitted render still has text in the shared line zone", `got PSNR ${fitSharedLine}`);

// burn_captions --max-lines floor: one line is impossible for the
// 92-char cue even at the 31px floor, so it burns at the floor and
// reports fits=false instead of shrinking to unreadable type.
const capsFloorRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/rotated-vertical.mp4"),
    captions: path.join(root, "test/captions-fit-floor.srt"),
    output: path.join(root, "outputs/mcp-captions-fit-floor.mp4"),
    max_lines: 1,
  },
});
const capsFloorJson = JSON.parse(capsFloorRes.content[0].text);
checkOk(capsFloorJson.font_size === 31, "burn_captions floor is 31px at 1920 high", `got ${capsFloorJson.font_size}`);
checkOk(capsFloorJson.fit?.fits === false && capsFloorJson.fit?.lines_at_size === 2, "burn_captions floor case reports fits=false with 2 lines at the floor", JSON.stringify(capsFloorJson.fit));

// burn_captions --max-lines with a short cue: nothing to shrink.
const capsShortRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/rotated-vertical.mp4"),
    captions: path.join(root, "test/captions-fit-short.srt"),
    output: path.join(root, "outputs/mcp-captions-fit-short.mp4"),
    max_lines: 2,
  },
});
const capsShortJson = JSON.parse(capsShortRes.content[0].text);
checkOk(capsShortJson.font_size === 60 && capsShortJson.fit?.shrunk === 0 && capsShortJson.fit?.fits === true, "burn_captions short cue keeps 60px with max_lines=2", JSON.stringify(capsShortJson.fit));

// burn_captions --platform: the default margin becomes the
// platform's own bottom UI depth — tiktok 520px at 1920 high,
// youtube 100px of 1080 scaled to 67px at 720 high. An explicit
// margin_v wins over the platform.
const capsTtRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/rotated-vertical.mp4"),
    captions: path.join(root, "test/captions.srt"),
    output: path.join(root, "outputs/mcp-captions-tiktok.mp4"),
    platform: "tiktok",
  },
});
const capsTtJson = JSON.parse(capsTtRes.content[0].text);
checkOk(capsTtJson.margin_v === 520, "burn_captions platform=tiktok margin is 520px at 1920 high", `got ${capsTtJson.margin_v}`);
checkOk(capsTtJson.platform === "tiktok", "burn_captions echoes its platform", `got ${capsTtJson.platform}`);
const capsYtRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    captions: path.join(root, "test/captions.srt"),
    output: path.join(root, "outputs/mcp-captions-youtube.mp4"),
    platform: "youtube",
  },
});
const capsYtJson = JSON.parse(capsYtRes.content[0].text);
checkOk(capsYtJson.margin_v === 67, "burn_captions platform=youtube margin is 67px at 720 high", `got ${capsYtJson.margin_v}`);
const capsTtMRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/rotated-vertical.mp4"),
    captions: path.join(root, "test/captions.srt"),
    output: path.join(root, "outputs/mcp-captions-tiktok-m100.mp4"),
    platform: "tiktok",
    margin_v: 100,
  },
});
const capsTtMJson = JSON.parse(capsTtMRes.content[0].text);
checkOk(capsTtMJson.margin_v === 100, "burn_captions explicit margin_v wins over platform", `got ${capsTtMJson.margin_v}`);
// An unknown platform is rejected by the MCP schema itself (enum
// validation) before the tool runs — the client throws the -32602
// error instead of returning a tool result. (The core-level
// "unknown platform" error is covered by the CLI probe: exit 2,
// INVALID_ARG.)
let capsBadPlatText = "";
try {
  const capsBadPlatRes = await client.callTool({
    name: "burn_captions",
    arguments: {
      input: path.join(root, "test/rotated-vertical.mp4"),
      captions: path.join(root, "test/captions.srt"),
      output: path.join(root, "outputs/mcp-captions-badplat.mp4"),
      platform: "nope",
    },
  });
  capsBadPlatText = capsBadPlatRes.content?.[0]?.text ?? "";
} catch (e) { capsBadPlatText = e.message; }
checkOk(/Invalid enum value/.test(capsBadPlatText) && /nope/.test(capsBadPlatText), "burn_captions unknown platform is refused (MCP enum validation)", capsBadPlatText.slice(0, 160));

// burn_captions on .ass: max_lines and the platform margin are
// ignored (the file carries its own styles) and reported, not
// silently dropped.
const capsAssRes = await client.callTool({
  name: "burn_captions",
  arguments: {
    input: path.join(root, "test/rotated-vertical.mp4"),
    captions: path.join(root, "test/captions-min.ass"),
    output: path.join(root, "outputs/mcp-captions-ass.mp4"),
    max_lines: 2,
    platform: "tiktok",
  },
});
const capsAssJson = JSON.parse(capsAssRes.content[0].text);
checkOk(capsAssJson.fit === null && /ignored for \.ass/.test(capsAssJson.fit_note ?? ""), "burn_captions .ass reports fit ignored", JSON.stringify(capsAssJson));
checkOk(capsAssJson.style_applied === false, "burn_captions .ass reports style_applied=false", `got ${capsAssJson.style_applied}`);

// burn_captions --style: all four styles render text in the safe band,
// echo their name, and render differently from each other. The
// background box is the regression trap: libass draws the BorderStyle 3
// box from the Outline width, so Outline=0 silently drops the whole
// box (white text on white footage becomes invisible). A solid-white
// clip catches it — only a real box darkens the band there, white
// glyphs alone are invisible on white.
for (const style of ["background", "outline", "shadow", "glow"]) {
  const res = await client.callTool({
    name: "burn_captions",
    arguments: {
      input: path.join(root, "test/source.mp4"),
      captions: path.join(root, "test/captions.srt"),
      output: path.join(root, `outputs/mcp-captions-${style}.mp4`),
      style,
    },
  });
  const j = JSON.parse(res.content[0].text);
  checkOk(j.style === style, `burn_captions style=${style} echoes its style`, `got ${j.style}`);
  checkOk(j.style_applied === true, `burn_captions style=${style} applies to .srt`, `got ${j.style_applied}`);
  const p = await bandPsnr(path.join(root, "test/source.mp4"), path.join(root, `outputs/mcp-captions-${style}.mp4`), 3.5, 480, 60);
  checkOk(p !== null && p < 30, `burn_captions style=${style} text lands in the safe band`, `got PSNR ${p}`);
}
const styleCross = await bandPsnr(path.join(root, "outputs/mcp-captions-background.mp4"), path.join(root, "outputs/mcp-captions-outline.mp4"), 3.5, 480, 60);
checkOk(styleCross !== null && styleCross < 30, "burn_captions background and outline render differently", `got PSNR ${styleCross}`);

// White-clip box regression: generate a solid-white 2s clip (lavfi,
// no fixture file) and burn two styles onto it. On white, white
// glyphs are invisible — only the semi-transparent black box (or the
// black outline) can darken the band. If the box ever stops rendering,
// the background PSNR goes to ~inf (re-encode noise only).
await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=white:1280x720:d=2", "-f", "lavfi", "-i", "sine=frequency=440:d=2", "-shortest", path.join(root, "outputs/mcp-white.mp4")]);
for (const style of ["background", "outline"]) {
  await client.callTool({
    name: "burn_captions",
    arguments: {
      input: path.join(root, "outputs/mcp-white.mp4"),
      captions: path.join(root, "test/captions.srt"),
      output: path.join(root, `outputs/mcp-white-${style}.mp4`),
      style,
    },
  });
  const p = await bandPsnr(path.join(root, "outputs/mcp-white.mp4"), path.join(root, `outputs/mcp-white-${style}.mp4`), 1, 500, 60);
  console.log(`burn_captions ${style} on white: band PSNR ${p}`);
  checkOk(p !== null && p < 30, `burn_captions ${style} is visible on a white clip (box/outline really renders)`, `got PSNR ${p}`);
}

// Bad style: the MCP layer rejects the enum value before the tool runs.
const capsBadRes = await client.callTool({
  name: "burn_captions",
  arguments: { input: path.join(root, "test/source.mp4"), captions: path.join(root, "test/captions.srt"), output: path.join(root, "outputs/mcp-captions-bad.mp4"), style: "neon" },
});
const capsBadText = capsBadRes.content?.[0]?.text ?? "";
checkOk(/style/.test(capsBadText) && /neon/.test(capsBadText), "burn_captions errors on an unknown style", capsBadText.slice(0, 200));

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

// loudness --compressor: quiet, high-crest Kokoro speech
// (test/kokoro-voice.wav, -25.6 LUFS in, crest ~19 dB) stalls at
// -15.2 with two-pass alone (true-peak ceiling). A gentle
// compressor first (threshold -24 dB, ratio 4, 1 ms attack — the
// attack is the point: 20 ms lets plosive transients straight
// through) pulls the true peak down ~9.5 dB while integrated only
// falls ~5.6 dB, so the target becomes reachable: -14.3 on wav,
// -14.6 on mp3 (the extra 0.3 is the known mp3 encode loss).
const loudKokoroNoCompRes = await client.callTool({
  name: "loudness",
  arguments: { input: path.join(root, "test/kokoro-voice.wav"), output: path.join(root, "outputs/mcp-loudness-kokoro-nocomp.mp3") },
});
const loudKokoroNoCompJson = JSON.parse(loudKokoroNoCompRes.content[0].text);
console.log("loudness kokoro no-comp:", "input", loudKokoroNoCompJson.input_lufs, "| output", loudKokoroNoCompJson.output_lufs, "| warning", loudKokoroNoCompJson.warning ?? "(none)");
checkOk(near(loudKokoroNoCompJson.output_lufs, -15.2, 0.5) && typeof loudKokoroNoCompJson.warning === "string", "loudness without compressor stalls below target on high-crest Kokoro voice (-15.2, warns)", `got ${loudKokoroNoCompJson.output_lufs}`);
const loudKokoroCompRes = await client.callTool({
  name: "loudness",
  arguments: { input: path.join(root, "test/kokoro-voice.wav"), output: path.join(root, "outputs/mcp-loudness-kokoro-comp.wav"), compressor: true },
});
const loudKokoroCompJson = JSON.parse(loudKokoroCompRes.content[0].text);
console.log("loudness kokoro +compressor:", "input", loudKokoroCompJson.input_lufs, "| compressed", loudKokoroCompJson.compressed_lufs, "| output", loudKokoroCompJson.output_lufs, "| warning", loudKokoroCompJson.warning ?? "(none)");
checkOk(loudKokoroCompJson.compressor?.threshold_db === -24 && loudKokoroCompJson.compressor?.ratio === 4 && typeof loudKokoroCompJson.compressed_lufs === "number" && loudKokoroCompJson.compressed_lufs < loudKokoroCompJson.input_lufs, "loudness compressor reports its settings and the compressed level (below input — no makeup gain)", JSON.stringify(loudKokoroCompJson.compressor));
checkOk(near(loudKokoroCompJson.output_lufs, -14, 0.5) && !loudKokoroCompJson.warning, "loudness with compressor hits -14 LUFS (±0.5) on Kokoro voice, no warning", `got ${loudKokoroCompJson.output_lufs}`);
const loudKokoroCompMeasured = await measureLufs(path.join(root, "outputs/mcp-loudness-kokoro-comp.wav"));
checkOk(near(loudKokoroCompMeasured, -14, 0.5), "loudness compressor output independently measures -14 LUFS (±0.5)", `got ${loudKokoroCompMeasured}`);
// loudness AAC bitrate (turn 53): ffmpeg's default AAC bitrate (~69k
// on mono) smeared inter-sample peaks — a voice mastered to TP -2.00
// measured +1.37 dBTP after the encode and failed qa true_peak, while
// the same loudnorm into WAV measured exactly -2.00 and into AAC 192k
// measured -1.98. loudness() now pins AAC to 192k (like mp3) and
// reports the true peak of the finished file, so a bad master cannot
// hide behind a clean LUFS. The Kokoro fixture itself only reached
// -1.37 dBTP at 69k (under the ceiling), so the bitrate assert below
// is the regression guard — the TP assert is the ceiling guard.
const loudKokoroAacRes = await client.callTool({
  name: "loudness",
  arguments: { input: path.join(root, "test/kokoro-voice.wav"), output: path.join(root, "outputs/mcp-loudness-kokoro.m4a"), compressor: true },
});
const loudKokoroAacJson = JSON.parse(loudKokoroAacRes.content[0].text);
const loudKokoroAacSize = statSync(path.join(root, "outputs/mcp-loudness-kokoro.m4a")).size;
const loudKokoroAacBitrate = (loudKokoroAacSize * 8) / (loudKokoroAacJson.duration_seconds ?? 21.8);
const loudKokoroAacTp = await measureTp(path.join(root, "outputs/mcp-loudness-kokoro.m4a"));
checkOk(typeof loudKokoroAacJson.output_true_peak_db === "number" && loudKokoroAacJson.output_true_peak_db <= -0.3 && !loudKokoroAacJson.warning, "loudness reports the true peak of the finished .m4a (<= -0.3 dBTP) next to the LUFS, no warning", `tp=${loudKokoroAacJson.output_true_peak_db} warning=${loudKokoroAacJson.warning ?? "(none)"}`);
checkOk(loudKokoroAacBitrate >= 128000, "loudness AAC output is encoded at >=128k, not ffmpeg's ~69k mono default (the bitrate that smeared true peaks)", `bitrate~${Math.round(loudKokoroAacBitrate)} bps from ${loudKokoroAacSize} bytes`);
checkOk(loudKokoroAacTp !== null && loudKokoroAacTp <= -0.3 && Math.abs(loudKokoroAacTp - loudKokoroAacJson.output_true_peak_db) <= 0.5, "the .m4a independently measures TP <= -0.3 dBTP and agrees with the tool's report (±0.5)", `independent=${loudKokoroAacTp} reported=${loudKokoroAacJson.output_true_peak_db}`);
const loudKokoroCompMp3Res = await client.callTool({
  name: "loudness",
  arguments: { input: path.join(root, "test/kokoro-voice.wav"), output: path.join(root, "outputs/mcp-loudness-kokoro-comp.mp3"), compressor: true },
});
const loudKokoroCompMp3Json = JSON.parse(loudKokoroCompMp3Res.content[0].text);
checkOk(loudKokoroCompMp3Json.output_lufs > loudKokoroNoCompJson.output_lufs, "loudness with compressor improves the mp3 master over no-compressor", `no-comp ${loudKokoroNoCompJson.output_lufs} -> comp ${loudKokoroCompMp3Json.output_lufs}`);
const loudCompBadText = await callExpectThrow("loudness", { input: path.join(root, "test/kokoro-voice.wav"), output: path.join(root, "outputs/mcp-loudness-bad.mp3"), compressor: true, compressor_ratio: 0 });
checkOk(/greater than or equal to 1/.test(loudCompBadText ?? ""), "loudness refuses compressor_ratio 0", loudCompBadText ?? "");

// intro: title on a dark background, fading in and out. Pixel-verify
// the fade on the centre band (text sits there): dim at t=0.05 and
// t=2.95, bright at t=1.5. Thresholds from direct measurement on the
// same fixture (R 21.8 -> 68.4 -> 18.4).
const introRes = await client.callTool({
  name: "intro",
  arguments: { text: "Welcome Back", output: path.join(root, "outputs/mcp-intro.mp4") },
});
const introJson = JSON.parse(introRes.content[0].text);
console.log("intro call:", introJson.dimensions, "| duration", introJson.duration_seconds, "| lines", JSON.stringify(introJson.lines), "| font", introJson.font_size);
checkOk(introJson.dimensions === "1280x720", "intro output is 1280x720", `got ${introJson.dimensions}`);
checkOk(near(introJson.duration_seconds, 3, 0.1), "intro duration is 3s", `got ${introJson.duration_seconds}`);
checkOk(JSON.stringify(introJson.lines) === JSON.stringify(["WELCOME BACK"]), "intro wraps to 1 line", `got ${JSON.stringify(introJson.lines)}`);
checkOk(introJson.font_size === 102, "intro default font is 102px at 1280 wide", `got ${introJson.font_size}`);
async function introBandR(t) {
  const png = path.join(root, `outputs/mcp-intro-${t}.png`);
  await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", path.join(root, "outputs/mcp-intro.mp4"), "-frames:v", "1", png]);
  return planeMean(png, "800:160:240:280", "r");
}
const introEarly = await introBandR(0.05);
const introMid = await introBandR(1.5);
const introLate = await introBandR(2.95);
console.log("intro pixels: centre-band R early/mid/late =", introEarly, introMid, introLate);
checkOk(introEarly !== null && introEarly < 30, "intro text is dim at fade-in (t=0.05)", `got R=${introEarly}`);
checkOk(introMid !== null && introMid > 50, "intro text is bright at full fade (t=1.5)", `got R=${introMid}`);
checkOk(introLate !== null && introLate < 30, "intro text is dim at fade-out (t=2.95)", `got R=${introLate}`);
checkOk(introMid !== null && introEarly !== null && introMid > introEarly + 20, "intro fades in (mid much brighter than early)", `early ${introEarly} -> mid ${introMid}`);
// intro rejects fade_in + fade_out >= duration.
const introBadRes = await client.callTool({
  name: "intro",
  arguments: { text: "Hi", output: path.join(root, "outputs/mcp-intro-bad.mp4"), duration: 1, fade_in: 0.6, fade_out: 0.6 },
});
const introBadJson = JSON.parse(introBadRes.content[0].text);
checkOk(introBadRes.isError === true && /fade_in \+ fade_out/.test(introBadJson.error ?? ""), "intro rejects fades longer than duration", JSON.stringify(introBadJson));

// intro --style: the locked titlecard palette maps onto the intro
// (box colour becomes the background). Pixel-verify clean-bold at
// full fade: the centre band is the orange background (R ~249, G
// ~115, B ~22) with yellow text — nothing like the default dark-navy
// intro (mid-band R 68.4).
const introStyleRes = await client.callTool({
  name: "intro",
  arguments: { text: "Welcome Back", output: path.join(root, "outputs/mcp-intro-style.mp4"), style: "clean-bold" },
});
const introStyleJson = JSON.parse(introStyleRes.content[0].text);
console.log("intro --style call:", "bg", introStyleJson.bg_color, "| text", introStyleJson.text_color, "| font", introStyleJson.font_size, "| style", introStyleJson.style);
checkOk(introStyleJson.style === "clean-bold" && introStyleJson.bg_color === "F97316" && introStyleJson.text_color === "FFD60A" && introStyleJson.font_size === 120,
  "intro --style clean-bold resolves to the locked palette", JSON.stringify({ style: introStyleJson.style, bg_color: introStyleJson.bg_color, text_color: introStyleJson.text_color, font_size: introStyleJson.font_size }));
checkOk(Array.isArray(introStyleJson.style_overrides) && introStyleJson.style_overrides.length === 0, "intro --style clean-bold reports no overrides", JSON.stringify(introStyleJson.style_overrides));
const introStyleMidPng = path.join(root, "outputs/mcp-intro-style-mid.png");
await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", "1.5", "-i", path.join(root, "outputs/mcp-intro-style.mp4"), "-frames:v", "1", introStyleMidPng]);
const introStyleR = await planeMean(introStyleMidPng, "800:160:240:280", "r");
const introStyleG = await planeMean(introStyleMidPng, "800:160:240:280", "g");
const introStyleB = await planeMean(introStyleMidPng, "800:160:240:280", "b");
console.log("intro --style pixels: centre-band R/G/B =", introStyleR, introStyleG, introStyleB);
checkOk(introStyleR !== null && introStyleR > 200, "intro --style clean-bold background is orange (R high)", `got R=${introStyleR}`);
checkOk(introStyleG !== null && introStyleG > 100 && introStyleG < 180, "intro --style clean-bold background is orange (G mid)", `got G=${introStyleG}`);
checkOk(introStyleB !== null && introStyleB < 40, "intro --style clean-bold background is orange (B low)", `got B=${introStyleB}`);
const introStyleBadRes = await client.callTool({
  name: "intro",
  arguments: { text: "Hi", output: path.join(root, "outputs/mcp-intro-badstyle.mp4"), style: "neon" },
});
const introStyleBadJson = JSON.parse(introStyleBadRes.content[0].text);
checkOk(introStyleBadRes.isError === true && /style must be one of/.test(introStyleBadJson.error ?? ""),
  "intro rejects an unknown style id", JSON.stringify(introStyleBadJson));

// intro --brand: background = brand background, text = brand text.
// Pixel-verify amber-teal at full fade: the top-left corner is the
// brand background 0F172A (15, 23, 42) — nowhere near the default
// intro, which happens to share the same navy by coincidence here,
// so the JSON fields (not the pixel) are the real assertion for
// amber-teal; warm-story below is the pixel discriminator (1C1917).
const introBrandRes = await client.callTool({
  name: "intro",
  arguments: { text: "Welcome Back", output: path.join(root, "outputs/mcp-intro-brand.mp4"), brand: "amber-teal" },
});
const introBrandJson = JSON.parse(introBrandRes.content[0].text);
checkOk(introBrandJson.brand === "amber-teal" && introBrandJson.bg_color === "0F172A" && introBrandJson.text_color === "FFFFFF" && introBrandJson.font_size === 102,
  "intro --brand amber-teal resolves to the brand palette, font stays the intro default", JSON.stringify({ brand: introBrandJson.brand, bg_color: introBrandJson.bg_color, text_color: introBrandJson.text_color, font_size: introBrandJson.font_size }));
checkOk(JSON.stringify(introBrandJson.brand_applied) === JSON.stringify(["bg_color", "text_color"]) && JSON.stringify(introBrandJson.brand_overrides) === JSON.stringify([]),
  "intro --brand reports both colours applied, none overridden", JSON.stringify({ applied: introBrandJson.brand_applied, overrides: introBrandJson.brand_overrides }));
const introBrandWarmRes = await client.callTool({
  name: "intro",
  arguments: { text: "Welcome Back", output: path.join(root, "outputs/mcp-intro-brand-warm.mp4"), brand: "warm-story" },
});
const introBrandWarmPng = path.join(root, "outputs/mcp-intro-brand-warm.png");
await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", "1.5", "-i", path.join(root, "outputs/mcp-intro-brand-warm.mp4"), "-frames:v", "1", introBrandWarmPng]);
const introBrandR = await planeMean(introBrandWarmPng, "100:100:0:0", "r");
const introBrandG = await planeMean(introBrandWarmPng, "100:100:0:0", "g");
const introBrandB = await planeMean(introBrandWarmPng, "100:100:0:0", "b");
console.log("intro warm-story pixels: corner R/G/B =", introBrandR, introBrandG, introBrandB);
checkOk(introBrandR !== null && near(introBrandR, 28, 5) && near(introBrandG, 25, 5) && near(introBrandB, 23, 5),
  "intro --brand warm-story background is 1C1917 in the corner (not default navy)", `got R/G/B=${introBrandR}/${introBrandG}/${introBrandB}`);
const introBrandOvRes = await client.callTool({
  name: "intro",
  arguments: { text: "Welcome Back", output: path.join(root, "outputs/mcp-intro-brand-ov.mp4"), brand: "warm-story", bg_color: "000000" },
});
const introBrandOvJson = JSON.parse(introBrandOvRes.content[0].text);
checkOk(introBrandOvJson.bg_color === "000000" && introBrandOvJson.text_color === "FFF7ED" && JSON.stringify(introBrandOvJson.brand_overrides) === JSON.stringify(["bg_color"]),
  "intro explicit bg_color beats the brand, text stays brand", JSON.stringify({ bg_color: introBrandOvJson.bg_color, text_color: introBrandOvJson.text_color, overrides: introBrandOvJson.brand_overrides }));
// intro dry-run (lượt 116, batch 5): font/colors computed, exact
// command, no output file (the drawtext text file is kept by design).
const introDryRes = await client.callTool({
  name: "intro",
  arguments: { text: "Hello World", output: path.join(root, "outputs/mcp-intro-dry.mp4"), dry_run: true },
});
const introDryJson = JSON.parse(introDryRes.content[0].text);
checkOk(introDryJson.dry_run === true && introDryJson.font_size === 102 && introDryJson.bg_color === "0F172A" && introDryJson.text_color === "FFFFFF" && introDryJson.dimensions === "1280x720" && introDryJson.duration_seconds === null && introDryJson.expected_duration_seconds === 3 && introDryJson.size_bytes === null && !existsSync(path.join(root, "outputs/mcp-intro-dry.mp4")), "intro dry-run reports 102px white-on-navy at 1280x720, expected 3s, duration/size null, writes no output file", JSON.stringify(introDryJson));
checkOk(introDryJson.commands?.length === 1 && introDryJson.commands[0].includes("color=c=0x0F172A:s=1280x720") && introDryJson.commands[0].includes("drawtext=") && introDryJson.commands[0].includes("fontsize=102"), "intro dry-run command renders the title on the navy color source", introDryJson.commands?.[0] ?? "");

// social: one call exports tiktok + shorts + instagram-feed from the
// 1280x720 10s source. Each output must be the platform size, ~10s,
// -14 LUFS measured, and check_pass true; manifest.json must list
// all three. Unknown platform must error, not silently skip.
const socialRes = await client.callTool({
  name: "social",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output_dir: path.join(root, "outputs/mcp-social"),
    platforms: ["tiktok", "shorts", "instagram-feed"],
    strategy: "blur",
  },
  // 3 platforms x (reframe blur + 2-pass loudness + check) costs ~93s
  // on this 1.5-CPU VM (measured 2026-11-13, CLI equivalent 1m32s) —
  // the SDK's 60s default timeout kills the call even though the tool
  // itself finishes fine (all_pass true). The timeout is the test
  // client's, not the tool's: keep the real work, raise the wait.
}, undefined, { timeout: 300000 });
const socialJson = JSON.parse(socialRes.content[0].text);
console.log("social call:", "all_pass", socialJson.all_pass, "|", socialJson.outputs.map((o) => `${o.platform} ${o.dimensions} ${o.duration_seconds}s LUFS ${o.lufs} pass=${o.check_pass}`).join(" | "));
checkOk(socialJson.all_pass === true, "social all platforms pass their check", JSON.stringify(socialJson.outputs.map((o) => ({ p: o.platform, pass: o.check_pass, issues: o.issues }))));
checkOk(socialJson.outputs.length === 3, "social returns 3 platform outputs", `got ${socialJson.outputs.length}`);
const socialByPlatform = Object.fromEntries(socialJson.outputs.map((o) => [o.platform, o]));
checkOk(socialByPlatform.tiktok?.dimensions === "1080x1920", "social tiktok is 1080x1920", `got ${socialByPlatform.tiktok?.dimensions}`);
checkOk(socialByPlatform.shorts?.dimensions === "1080x1920", "social shorts is 1080x1920", `got ${socialByPlatform.shorts?.dimensions}`);
checkOk(socialByPlatform["instagram-feed"]?.dimensions === "1080x1080", "social instagram-feed is 1080x1080", `got ${socialByPlatform["instagram-feed"]?.dimensions}`);
for (const o of socialJson.outputs) {
  checkOk(near(o.duration_seconds, 10, 0.2), `social ${o.platform} keeps ~10s duration`, `got ${o.duration_seconds}`);
  checkOk(typeof o.lufs === "number" && o.lufs >= -16 && o.lufs <= -12, `social ${o.platform} LUFS in platform window`, `got ${o.lufs}`);
  checkOk(o.trimmed === false, `social ${o.platform} did not trim a 10s source`, `got trimmed=${o.trimmed}`);
}
const manifestJson = JSON.parse(await readFile(path.join(root, "outputs/mcp-social/manifest.json"), "utf8"));
checkOk(manifestJson.outputs.length === 3 && manifestJson.strategy === "blur", "social manifest.json lists all 3 outputs + strategy", `got ${manifestJson.outputs?.length} outputs`);
// An unknown platform is rejected by the MCP schema itself (enum
// validation) before the tool runs — the client returns the -32602
// error as result text instead of a tool result.
let socialBadText = "";
try {
  const socialBadRes = await client.callTool({
    name: "social",
    arguments: { input: path.join(root, "test/source.mp4"), output_dir: path.join(root, "outputs/mcp-social-bad"), platforms: ["nosuch"] },
  });
  socialBadText = socialBadRes.content?.[0]?.text ?? "";
} catch (e) { socialBadText = e.message; }
checkOk(/Invalid enum value/.test(socialBadText) && /nosuch/.test(socialBadText), "social rejects an unknown platform (MCP enum validation)", socialBadText.slice(0, 120));

// convert_captions: SRT -> VTT (fixture has 3 cues, 0-8s), then back
// VTT -> SRT — the round trip must keep every cue and timestamp.
// A VTT with cue settings must report settings_dropped=1, and
// converting a file to its own format must be refused.
const capsConvRes = await client.callTool({
  name: "convert_captions",
  arguments: { input: path.join(root, "test/captions.srt"), output: path.join(root, "outputs/mcp-captions.vtt") },
});
const capsConvJson = JSON.parse(capsConvRes.content[0].text);
console.log("convert_captions srt->vtt:", capsConvJson.cue_count, "cues |", capsConvJson.first_start_seconds + "s ->", capsConvJson.last_end_seconds + "s |", capsConvJson.size_human);
checkOk(capsConvJson.cue_count === 3 && capsConvJson.from_format === "srt" && capsConvJson.to_format === "vtt", "convert_captions srt->vtt reports 3 cues", JSON.stringify(capsConvJson));
checkOk(capsConvJson.first_start_seconds === 0 && capsConvJson.last_end_seconds === 8, "convert_captions keeps 0s..8s span", `got ${capsConvJson.first_start_seconds}..${capsConvJson.last_end_seconds}`);
const vttText = await readFile(path.join(root, "outputs/mcp-captions.vtt"), "utf8");
checkOk(vttText.startsWith("WEBVTT") && vttText.includes("00:00:02.500 --> 00:00:05.000"), "convert_captions VTT has WEBVTT header + dot timestamps", vttText.slice(0, 80).replace(/\n/g, " "));
const capsBackRes = await client.callTool({
  name: "convert_captions",
  arguments: { input: path.join(root, "outputs/mcp-captions.vtt"), output: path.join(root, "outputs/mcp-captions-roundtrip.srt") },
});
const capsBackJson = JSON.parse(capsBackRes.content[0].text);
checkOk(capsBackJson.cue_count === 3 && capsBackJson.from_format === "vtt" && capsBackJson.to_format === "srt", "convert_captions round-trips VTT->SRT with 3 cues", JSON.stringify(capsBackJson));
const srtText = await readFile(path.join(root, "outputs/mcp-captions-roundtrip.srt"), "utf8");
checkOk(srtText.includes("00:00:00,000 --> 00:00:02,500") && srtText.includes("MediaKit gives agents"), "round-tripped SRT has comma timestamps + original text", srtText.slice(0, 80).replace(/\n/g, " "));
const capsSetRes = await client.callTool({
  name: "convert_captions",
  arguments: { input: path.join(root, "test/captions-settings.vtt"), output: path.join(root, "outputs/mcp-captions-settings.srt") },
});
const capsSetJson = JSON.parse(capsSetRes.content[0].text);
checkOk(capsSetJson.cue_count === 2 && capsSetJson.settings_dropped === 1, "convert_captions drops 1 VTT cue setting and counts it", JSON.stringify(capsSetJson));
const capsSameRes = await client.callTool({
  name: "convert_captions",
  arguments: { input: path.join(root, "test/captions.srt"), output: path.join(root, "outputs/mcp-captions-same.srt") },
});
const capsSameJson = JSON.parse(capsSameRes.content[0].text);
checkOk(capsSameRes.isError === true && /already srt/.test(capsSameJson.error ?? ""), "convert_captions refuses same-format conversion", JSON.stringify(capsSameJson));

// mix --dry-run: plan mode must print both ffmpeg commands (render
// with sidechaincompress, master with loudnorm on the unmastered
// render; real measured voice gain) and write no file.
const mixDryPath = path.join(root, "outputs/mcp-mix-dry.mp3");
const mixDryRes = await client.callTool({
  name: "mix",
  arguments: {
    voice: path.join(root, "test/mix-voice.mp3"),
    music: path.join(root, "test/mix-music.mp3"),
    output: mixDryPath,
    music_volume: 0.5,
    duck_db: 12,
    dry_run: true,
  },
});
const mixDryJson = JSON.parse(mixDryRes.content[0].text);
console.log("mix dry-run:", "gain", mixDryJson.voice_gain_db, "dB | ratio", mixDryJson.sidechain_ratio, "|", mixDryJson.commands?.[0]?.slice(0, 120), "...");
checkOk(mixDryJson.dry_run === true, "mix dry_run=true reports dry_run", JSON.stringify(mixDryJson).slice(0, 120));
checkOk(Array.isArray(mixDryJson.commands) && mixDryJson.commands.length === 2 && mixDryJson.commands[0].includes("sidechaincompress") && !mixDryJson.commands[0].includes("loudnorm") && mixDryJson.commands[1].includes("loudnorm") && mixDryJson.commands[1].includes(".unmastered."), "mix dry-run prints both passes (render sidechain, master loudnorm on the unmastered render)", JSON.stringify(mixDryJson.commands));
checkOk(mixDryJson.mastering === "two-pass", "mix dry-run reports two-pass mastering", JSON.stringify(mixDryJson.mastering));
checkOk(typeof mixDryJson.voice_gain_db === "number" && mixDryJson.voice_gain_db !== 0, "mix dry-run computes a real voice gain from measurement", `got ${mixDryJson.voice_gain_db}`);
checkOk(existsSync(mixDryPath) === false, "mix dry-run writes no file", mixDryPath);
checkOk(existsSync(path.join(root, "outputs/mcp-mix-dry.unmastered.mp3")) === false, "mix dry-run writes no unmastered temp file", "unmastered file exists");

// find: recursive substring search with probe info per match.
const findContentRes = await client.callTool({
  name: "find",
  arguments: { directory: path.join(root, "test"), name: "content" },
});
const findContentJson = JSON.parse(findContentRes.content[0].text);
console.log("find content:", findContentJson.total_matches, "matches |", findContentJson.matches.map((m) => path.basename(m.path)).join(", "));
checkOk(findContentJson.total_matches === 6 && findContentJson.returned_matches === 6 && findContentJson.truncated === false, "find 'content' returns all 6 content fixtures", `got total=${findContentJson.total_matches}`);
checkOk(findContentJson.matches.every((m) => m.duration_seconds === 10 && m.video_codec === "h264"), "find probes every match (10s, h264)", JSON.stringify(findContentJson.matches));
checkOk(findContentJson.matches.find((m) => m.path.endsWith("content-video-only.mp4"))?.audio_codec === null, "find reports video-only fixture with audio_codec null", JSON.stringify(findContentJson.matches));

const findNestedRes = await client.callTool({
  name: "find",
  arguments: { directory: path.join(root, "test"), name: "deep-clip" },
});
const findNestedJson = JSON.parse(findNestedRes.content[0].text);
checkOk(findNestedJson.total_matches === 1 && findNestedJson.matches[0]?.path.endsWith("test/nested/deep-clip.mp4"), "find recurses into subdirectories", JSON.stringify(findNestedJson.matches));

const findSourceRes = await client.callTool({
  name: "find",
  arguments: { directory: path.join(root, "test"), name: "source" },
});
const findSourceJson = JSON.parse(findSourceRes.content[0].text);
checkOk(findSourceJson.total_matches === 16, "find 'source' matches 16 files (source, source2, silence-source, scenes-source, quiet-source, rich-source, trim-check-source, hook-source, hook-motion-source, hook-snap-source, sharpness-source, rotate-source, noisy-source, beat-trim-source, levels-source, pace-source)", `got ${findSourceJson.total_matches}`);

const findMp3Res = await client.callTool({
  name: "find",
  arguments: { directory: path.join(root, "test"), name: "source", extensions: "mp3" },
});
const findMp3Json = JSON.parse(findMp3Res.content[0].text);
checkOk(findMp3Json.total_matches === 1 && findMp3Json.matches[0]?.path.endsWith("quiet-source.mp3"), "find --extensions mp3 narrows to the one mp3", JSON.stringify(findMp3Json.matches));

const findCapRes = await client.callTool({
  name: "find",
  arguments: { directory: path.join(root, "test"), name: "content", max_results: 2 },
});
const findCapJson = JSON.parse(findCapRes.content[0].text);
checkOk(findCapJson.returned_matches === 2 && findCapJson.total_matches === 6 && findCapJson.truncated === true, "find caps returned matches but still reports the total", `got returned=${findCapJson.returned_matches} total=${findCapJson.total_matches}`);

const findNoneRes = await client.callTool({
  name: "find",
  arguments: { directory: path.join(root, "test"), name: "zzz-no-such-file" },
});
const findNoneJson = JSON.parse(findNoneRes.content[0].text);
checkOk(findNoneJson.total_matches === 0 && findNoneJson.matches.length === 0, "find with no match returns an empty list, not an error", JSON.stringify(findNoneJson));

const findBadRes = await client.callTool({
  name: "find",
  arguments: { directory: path.join(root, "test/no-such-dir"), name: "x" },
});
const findBadJson = JSON.parse(findBadRes.content[0].text);
checkOk(findBadRes.isError === true && /not found/.test(findBadJson.error ?? ""), "find errors on a missing directory", JSON.stringify(findBadJson));

// svg_animate: code-driven SVG animation, no browser. Fixture has a
// ball (orange circle at 200,360), a box (teal rect at 900,280) and a
// dot (yellow circle at 640,120); background is dark navy 0F172A.
const svgRes = await client.callTool({
  name: "svg_animate",
  arguments: {
    svg: path.join(root, "test/svg-demo.svg"),
    animations: [
      { target: "ball", property: "translate", from: [0, 0], to: [600, 0], start: 0, end: 2, easing: "linear" },
      { target: "box", property: "opacity", from: 1, to: 0, start: 1, end: 2, easing: "linear" },
      { target: "dot", property: "scale", from: 1, to: 2, start: 0, end: 2, easing: "ease-in-out" },
    ],
    output: path.join(root, "outputs/mcp-svg-animate.mp4"),
    duration: 2,
    fps: 10,
    background: "0F172A",
  },
});
const svgJson = JSON.parse(svgRes.content[0].text);
console.log("svg_animate call:", JSON.stringify(svgJson));
checkOk(svgJson.dimensions === "1280x720", "svg_animate output is 1280x720", `got ${svgJson.dimensions}`);
checkOk(svgJson.frames === 20, "svg_animate renders 20 frames (2s x 10fps)", `got ${svgJson.frames}`);
checkOk(near(svgJson.duration_seconds, 2, 0.1), "svg_animate output is 2s long", `got ${svgJson.duration_seconds}`);
checkOk(svgJson.animations_applied === 3 && svgJson.missing_targets.length === 0, "svg_animate applies all 3 animations, no missing targets", JSON.stringify(svgJson.missing_targets));
// The picture really moves: extract the first and last frames and
// compare them, then check the ball's end position is orange only in
// the last frame, and the box has faded out by then.
const svgOut = path.join(root, "outputs/mcp-svg-animate.mp4");
const svgFirst = path.join(root, "outputs/mcp-svg-first.png");
const svgLast = path.join(root, "outputs/mcp-svg-last.png");
await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", "0", "-i", svgOut, "-frames:v", "1", svgFirst]);
await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", "1.9", "-i", svgOut, "-frames:v", "1", svgLast]);
const { stderr: svgPsnrErr } = await execFileAsync("ffmpeg", ["-i", svgFirst, "-i", svgLast, "-filter_complex", "psnr", "-f", "null", "-"]);
const svgPsnrM = svgPsnrErr.match(/average:\s*(inf|[0-9.]+)/);
const svgPsnr = svgPsnrM ? (svgPsnrM[1] === "inf" ? Infinity : parseFloat(svgPsnrM[1])) : null;
console.log("svg first vs last frame PSNR:", svgPsnr);
checkOk(svgPsnr !== null && svgPsnr < 30, "svg_animate first and last frames differ (the picture moves)", `got PSNR ${svgPsnr}`);
const ballEndLast = await planeMean(svgLast, "120:120:740:300", "r");
const ballEndFirst = await planeMean(svgFirst, "120:120:740:300", "r");
console.log("svg ball end-position R: first", ballEndFirst, "last", ballEndLast);
checkOk(ballEndLast !== null && ballEndLast > 150, "svg_animate ball arrives at the right end (orange at 800,360)", `got R=${ballEndLast}`);
checkOk(ballEndFirst !== null && ballEndFirst < 50, "svg_animate ball is not at the end position in the first frame", `got R=${ballEndFirst}`);
const boxFirst = await planeMean(svgFirst, "120:120:900:280", "g");
const boxLast = await planeMean(svgLast, "120:120:900:280", "g");
console.log("svg box region G: first", boxFirst, "last", boxLast);
checkOk(boxFirst !== null && boxFirst > 100, "svg_animate box is visible (teal) in the first frame", `got G=${boxFirst}`);
checkOk(boxLast !== null && boxLast < 60, "svg_animate box has faded out by the last frame", `got G=${boxLast}`);
// Missing target: reported, not fatal.
const svgGhostRes = await client.callTool({
  name: "svg_animate",
  arguments: {
    svg: path.join(root, "test/svg-demo.svg"),
    animations: [{ target: "ghost", property: "translate", from: [0, 0], to: [100, 0], start: 0, end: 1 }],
    output: path.join(root, "outputs/mcp-svg-ghost.mp4"),
    duration: 1,
    fps: 10,
    background: "0F172A",
  },
});
const svgGhostJson = JSON.parse(svgGhostRes.content[0].text);
checkOk(svgGhostJson.missing_targets.includes("ghost") && svgGhostJson.dimensions === "1280x720", "svg_animate reports a missing target id but still renders", JSON.stringify(svgGhostJson));
// Bad property: the MCP layer rejects the enum value before the tool
// runs, so the result is an error text, not JSON.
const svgBadRes = await client.callTool({
  name: "svg_animate",
  arguments: {
    svg: path.join(root, "test/svg-demo.svg"),
    animations: [{ target: "ball", property: "spin", from: 0, to: 90, start: 0, end: 1 }],
    output: path.join(root, "outputs/mcp-svg-bad.mp4"),
    duration: 1,
    fps: 10,
  },
});
const svgBadText = svgBadRes.content?.[0]?.text ?? "";
checkOk(/property/.test(svgBadText) && /spin/.test(svgBadText), "svg_animate errors on an unknown property", svgBadText.slice(0, 200));

// Chained animations on one element+property (right then back left):
// the second window must not overwrite the first before it starts,
// and the ball must return to its start by the end.
const svgChainRes = await client.callTool({
  name: "svg_animate",
  arguments: {
    svg: path.join(root, "test/svg-demo.svg"),
    animations: [
      { target: "ball", property: "translate", from: [0, 0], to: [600, 0], start: 0, end: 1, easing: "linear" },
      { target: "ball", property: "translate", from: [600, 0], to: [0, 0], start: 1, end: 2, easing: "linear" },
    ],
    output: path.join(root, "outputs/mcp-svg-chain.mp4"),
    duration: 2,
    fps: 10,
    background: "0F172A",
  },
});
const svgChainJson = JSON.parse(svgChainRes.content[0].text);
checkOk(svgChainJson.animations_applied === 2, "svg_animate chain applies both windows", JSON.stringify(svgChainJson));
const svgChainMid = path.join(root, "outputs/mcp-svg-chain-mid.png");
const svgChainEnd = path.join(root, "outputs/mcp-svg-chain-end.png");
const svgChainEarly = path.join(root, "outputs/mcp-svg-chain-early.png");
await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", "1.0", "-i", path.join(root, "outputs/mcp-svg-chain.mp4"), "-frames:v", "1", svgChainMid]);
await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", "1.9", "-i", path.join(root, "outputs/mcp-svg-chain.mp4"), "-frames:v", "1", svgChainEnd]);
await execFileAsync("ffmpeg", ["-v", "error", "-y", "-ss", "0.5", "-i", path.join(root, "outputs/mcp-svg-chain.mp4"), "-frames:v", "1", svgChainEarly]);
const chainMidR = await planeMean(svgChainMid, "120:120:740:300", "r");
const chainEndR = await planeMean(svgChainEnd, "120:120:740:300", "r");
// At t=0.5 the ball is halfway out (center ~500,360): the second
// window (which starts at 1.0) must not yank it to the end early.
const chainEarlyR = await planeMean(svgChainEarly, "120:120:440:300", "r");
console.log("svg chain ball R: early-mid", chainEarlyR, "mid", chainMidR, "end", chainEndR);
checkOk(chainMidR !== null && chainMidR > 150, "svg_animate chain reaches the end at the window boundary (t=1.0)", `got R=${chainMidR}`);
checkOk(chainEndR !== null && chainEndR < 50, "svg_animate chain returns the ball to the start (t=1.9)", `got R=${chainEndR}`);
checkOk(chainEarlyR !== null && chainEarlyR > 150, "svg_animate chain is halfway out before the second window starts (t=0.5)", `got R=${chainEarlyR}`);

// compress: named quality presets. The fixture source is already
// encoded at a very low bitrate (195 kbps), so medium/high can come
// out LARGER than the source — reduction_percent honestly goes
// negative there. What must hold is the ordering: higher quality
// always means a bigger file, and low must shrink the source.
const compressSizes = {};
let compressLowJson = null;
for (const q of ["low", "medium", "high"]) {
  const cRes = await client.callTool({
    name: "compress",
    arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, `outputs/mcp-compress-${q}.mp4`), quality: q },
  });
  const cJson = JSON.parse(cRes.content[0].text);
  console.log(`compress ${q}:`, JSON.stringify(cJson));
  compressSizes[q] = cJson.size_after_bytes;
  if (q === "low") compressLowJson = cJson;
  checkOk(cJson.size_before_bytes === 243932, `compress ${q} reports the true source size`, `got ${cJson.size_before_bytes}`);
  checkOk(near(cJson.duration_seconds, 10, 0.1), `compress ${q} keeps 10s`, `got ${cJson.duration_seconds}`);
  checkOk(cJson.dimensions === "1280x720", `compress ${q} keeps 1280x720`, `got ${cJson.dimensions}`);
  checkOk(cJson.crf === { low: 32, medium: 26, high: 20 }[q], `compress ${q} uses the preset CRF`, `got CRF ${cJson.crf}`);
}
checkOk(compressSizes.low < compressSizes.medium && compressSizes.medium < compressSizes.high, "compress sizes strictly increase low < medium < high", JSON.stringify(compressSizes));
checkOk(compressLowJson.reduction_percent > 0, "compress low actually shrinks the source", `got ${compressLowJson.reduction_percent}%`);
// max-width scales down first.
const compressWRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-w640.mp4"), quality: "medium", max_width: 640 },
});
const compressWJson = JSON.parse(compressWRes.content[0].text);
checkOk(compressWJson.dimensions === "640x360" && compressWJson.scaled_to === "640x360", "compress --max-width 640 scales to 640x360", JSON.stringify(compressWJson));
// Audio-only input: re-encodes the audio track, no video.
const compressARes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-compress-audio.m4a"), quality: "medium" },
});
const compressAJson = JSON.parse(compressARes.content[0].text);
checkOk(compressAJson.dimensions === null && near(compressAJson.duration_seconds, 9, 0.1), "compress works on audio-only input", JSON.stringify(compressAJson));
// Bad quality: the MCP layer rejects the enum value before the tool runs.
const compressBadRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-bad.mp4"), quality: "tiny" },
});
const compressBadText = compressBadRes.content?.[0]?.text ?? "";
checkOk(/quality/.test(compressBadText) && /tiny/.test(compressBadText), "compress errors on an unknown quality", compressBadText.slice(0, 200));
// compress dry-run (lượt 116, batch 5): quality mode prints one command,
// target-size mode prints both passes; measured fields null, no file.
const compressDryRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-dry.mp4"), quality: "medium", dry_run: true },
});
const compressDryJson = JSON.parse(compressDryRes.content[0].text);
checkOk(compressDryJson.dry_run === true && compressDryJson.mode === "quality" && compressDryJson.crf === 26 && compressDryJson.dimensions === "1280x720" && compressDryJson.size_before_bytes === 243932 && compressDryJson.size_after_bytes === null && compressDryJson.reduction_percent === null && !existsSync(path.join(root, "outputs/mcp-compress-dry.mp4")), "compress quality dry-run reports CRF 26 + source size/dims, size_after null, writes nothing", JSON.stringify(compressDryJson));
checkOk(compressDryJson.commands?.length === 1 && compressDryJson.commands[0].includes("-crf 26") && compressDryJson.commands[0].includes("-preset medium"), "compress quality dry-run command is the medium preset encode", compressDryJson.commands?.[0] ?? "");
const compressTDryRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-target-dry.mp4"), target_size_mb: 1, dry_run: true },
});
const compressTDryJson = JSON.parse(compressTDryRes.content[0].text);
checkOk(compressTDryJson.dry_run === true && compressTDryJson.mode === "target_size" && compressTDryJson.passes === 2 && compressTDryJson.video_bitrate_kbps === 592 && compressTDryJson.audio_bitrate_kbps === 128 && compressTDryJson.scaled_to === "854x480" && near(compressTDryJson.bpp_before, 0.0214, 0.001) && compressTDryJson.size_after_bytes === null && compressTDryJson.target_met === null && compressTDryJson.quality_proof === null && !existsSync(path.join(root, "outputs/mcp-compress-target-dry.mp4")), "compress target-size dry-run budgets 592k + ladder to 854x480, measured fields null, writes nothing", JSON.stringify(compressTDryJson));
checkOk(compressTDryJson.commands?.length === 2 && compressTDryJson.commands[0].includes("-pass 1") && compressTDryJson.commands[0].includes("-f null") && compressTDryJson.commands[1].includes("-pass 2") && compressTDryJson.commands[1].includes("-b:v 592k"), "compress target-size dry-run prints pass 1 (analyse to null) then pass 2 at 592k", compressTDryJson.commands?.[1] ?? "");
const compressTDryCli = await runCliJson(["compress", path.join(root, "test/source.mp4"), "-o", path.join(root, "outputs/mcp-compress-target-cli-dry.mp4"), "--target-size", "1", "--dry-run"]);
checkOk(compressTDryCli.dry_run === true && compressTDryCli.commands?.length === 2 && !existsSync(path.join(root, "outputs/mcp-compress-target-cli-dry.mp4")), "CLI compress --target-size --dry-run prints both passes and writes no file", JSON.stringify(compressTDryCli.commands?.length));

// compress --target-size: two-pass ABR to an exact size. The fixture
// source is only 243,932 bytes, so a 1 MB target makes the file
// BIGGER — reduction honestly goes negative; what must hold is the
// measured size landing under the target.
const compressTRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-target1.mp4"), target_size_mb: 1 },
});
const compressTJson = JSON.parse(compressTRes.content[0].text);
console.log("compress target-size 1MB:", JSON.stringify(compressTJson));
checkOk(compressTJson.mode === "target_size" && compressTJson.passes === 2, "compress target-size runs two passes in target_size mode", JSON.stringify(compressTJson));
checkOk(compressTJson.target_met === true && compressTJson.size_after_bytes <= 1000000, "compress target-size 1MB lands under the target", `got ${compressTJson.size_after_bytes} bytes`);
checkOk(near(compressTJson.duration_seconds, 10, 0.1) && compressTJson.dimensions === "854x480", "compress target-size 1MB steps the ladder down to 854x480 (592k buys only 0.0214 bpp at 720p)", JSON.stringify(compressTJson));
checkOk(compressTJson.video_bitrate_kbps === 592 && compressTJson.audio_bitrate_kbps === 128, "compress target-size budgets 592k video + 128k audio for 1MB/10s (10% safety margin)", JSON.stringify(compressTJson));
checkOk(compressTJson.resolution_ladder_applied === true && compressTJson.scaled_to === "854x480" && near(compressTJson.bpp_before, 0.0214, 0.001) && near(compressTJson.bpp_after, 0.0481, 0.001) && compressTJson.bpp_threshold === 0.045, "compress resolution ladder reports bpp 0.0214 -> 0.0481 across the 0.045 threshold", JSON.stringify(compressTJson));
// Tighter target still met — ladder falls all the way to 240p.
const compressT05Res = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-target05.mp4"), target_size_mb: 0.5 },
});
const compressT05Json = JSON.parse(compressT05Res.content[0].text);
checkOk(compressT05Json.target_met === true && compressT05Json.size_after_bytes <= 500000, "compress target-size 0.5MB lands under the target", `got ${compressT05Json.size_after_bytes} bytes`);
checkOk(compressT05Json.dimensions === "426x240" && compressT05Json.resolution_ladder_applied === true && near(compressT05Json.bpp_after, 0.0756, 0.001), "compress target-size 0.5MB ladders to 426x240 (bpp 0.0756)", JSON.stringify(compressT05Json));
// Audio-only target-size: single pass, all budget to audio.
const compressTARes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-compress-target-audio.m4a"), target_size_mb: 0.1 },
});
const compressTAJson = JSON.parse(compressTARes.content[0].text);
checkOk(compressTAJson.mode === "target_size" && compressTAJson.passes === 1 && compressTAJson.target_met === true && compressTAJson.size_after_bytes <= 100000, "compress target-size works on audio-only input (1 pass)", JSON.stringify(compressTAJson));
// Too small a target: refused with the minimum spelled out.
const compressTinyRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-tiny.mp4"), target_size_mb: 0.1 },
});
const compressTinyText = compressTinyRes.content?.[0]?.text ?? "";
checkOk(/too small/.test(compressTinyText) && /0\.32/.test(compressTinyText), "compress target-size 0.1MB is refused with the minimum size", compressTinyText.slice(0, 200));
// target-size + crf: mutually exclusive, not silently ignored.
const compressConflictRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-conflict.mp4"), target_size_mb: 1, crf: 28 },
});
const compressConflictText = compressConflictRes.content?.[0]?.text ?? "";
checkOk(/mutually exclusive/.test(compressConflictText), "compress target-size + crf is rejected as mutually exclusive", compressConflictText.slice(0, 200));
// Ladder off: same 1 MB budget, the frame stays 1280x720 and the bpp
// numbers show exactly what the ladder would have fixed.
const compressNoLadderRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-noladder.mp4"), target_size_mb: 1, resolution_ladder: false },
});
const compressNoLadderJson = JSON.parse(compressNoLadderRes.content[0].text);
checkOk(compressNoLadderJson.dimensions === "1280x720" && compressNoLadderJson.resolution_ladder_applied === false && near(compressNoLadderJson.bpp_before, 0.0214, 0.001) && compressNoLadderJson.bpp_after === compressNoLadderJson.bpp_before, "compress resolution_ladder=false keeps 1280x720 and reports the starved bpp", JSON.stringify(compressNoLadderJson));
// Generous target: 5 MB buys 0.1256 bpp at 720p, so the ladder does
// not trigger and the frame is untouched.
const compressT5Res = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-target5.mp4"), target_size_mb: 5 },
});
const compressT5Json = JSON.parse(compressT5Res.content[0].text);
checkOk(compressT5Json.dimensions === "1280x720" && compressT5Json.resolution_ladder_applied === false && near(compressT5Json.bpp_before, 0.1256, 0.001) && compressT5Json.target_met === true, "compress target-size 5MB does not trigger the ladder (bpp 0.1256)", JSON.stringify(compressT5Json));
// Quality proof (lượt 82): target-size mode measures the output
// against the source — SSIM at 3 sample points + PSNR mid-clip +
// a verdict in words. Smooth testsrc2 saturates near 1.0, so the
// shape + top band are asserted here; the noisy fixture below proves
// the verdict actually moves with the target.
const proofT1 = compressTJson.quality_proof;
checkOk(proofT1?.available === true && Array.isArray(proofT1.sample_points) && proofT1.sample_points.length === 3 && proofT1.sample_points.every((p) => typeof p.ssim_all === "number"), "compress target-size 1MB returns a quality proof with 3 SSIM sample points", JSON.stringify(proofT1?.sample_points));
checkOk(proofT1.ssim_mean > 0.99 && proofT1.ssim_min > 0.99 && proofT1.verdict === "indistinguishable" && typeof proofT1.psnr_y_db === "number" && proofT1.psnr_y_db > 50, "compress target-size 1MB proof: SSIM mean >0.99, verdict indistinguishable, PSNR-Y >50 dB on smooth content", JSON.stringify({ mean: proofT1.ssim_mean, psnr: proofT1.psnr_y_db, verdict: proofT1.verdict }));
// The proof follows the build (lượt 103): a libvmaf build measures
// a real VMAF score at the mid point, a build without it reports
// null + a note that says so. Either branch must be honest — the
// old assert demanded null on every build, which failed on CI.
if (hasLibvmaf) {
  checkOk(typeof proofT1.vmaf === "number" && proofT1.vmaf >= 0 && proofT1.vmaf <= 100 && proofT1.vmaf_model === "vmaf_v0.6.1", "compress quality proof measures a real VMAF score on this build (libvmaf present)", JSON.stringify({ vmaf: proofT1.vmaf, model: proofT1.vmaf_model }));
} else {
  checkOk(proofT1.vmaf === null && /libvmaf/.test(proofT1.vmaf_note ?? ""), "compress quality proof says VMAF is unavailable (no libvmaf in this ffmpeg build)", proofT1.vmaf_note ?? "");
}
// The proof discriminates on hard content: test/noisy-source.mp4
// (640x360, static noise — detail that actually costs bits).
// Measured 2026-11-17: 1 MB -> SSIM 0.970 (looks_the_same),
// 0.5 MB -> SSIM 0.884 (clearly_degraded).
const proofNz1Res = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/noisy-source.mp4"), output: path.join(root, "outputs/mcp-compress-proof-nz1.mp4"), target_size_mb: 1 },
});
const proofNz1 = JSON.parse(proofNz1Res.content[0].text).quality_proof;
checkOk(proofNz1?.available === true && near(proofNz1.ssim_mean, 0.970, 0.01) && proofNz1.verdict === "looks_the_same", "compress proof on noisy 1MB: SSIM ~0.970, verdict looks_the_same", JSON.stringify({ mean: proofNz1?.ssim_mean, verdict: proofNz1?.verdict }));
const proofNz05Res = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/noisy-source.mp4"), output: path.join(root, "outputs/mcp-compress-proof-nz05.mp4"), target_size_mb: 0.5 },
});
const proofNz05 = JSON.parse(proofNz05Res.content[0].text).quality_proof;
checkOk(proofNz05?.available === true && proofNz05.ssim_mean < 0.90 && proofNz05.verdict === "clearly_degraded" && near(proofNz05.psnr_y_db, 33.6, 1.5), "compress proof on noisy 0.5MB: SSIM <0.90, verdict clearly_degraded, PSNR-Y ~33.6 dB", JSON.stringify({ mean: proofNz05?.ssim_mean, psnr: proofNz05?.psnr_y_db, verdict: proofNz05?.verdict }));
// quality_proof=false skips the measurement; audio-only has no
// frames to compare, so the proof is null with a note.
const proofOffRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-proof-off.mp4"), target_size_mb: 1, quality_proof: false },
});
const proofOffJson = JSON.parse(proofOffRes.content[0].text);
checkOk(proofOffJson.quality_proof === null && proofOffJson.target_met === true, "compress quality_proof=false skips the measurement (null proof, target still met)", JSON.stringify(proofOffJson.quality_proof));
checkOk(compressTAJson.quality_proof === null && /audio-only/.test(compressTAJson.quality_proof_note ?? ""), "compress target-size on audio-only input: proof null with an audio-only note", compressTAJson.quality_proof_note ?? "");
// CLI: --no-quality-proof skips the measurement.
const proofCliJson = await runCliJson(["compress", path.join(root, "test/source.mp4"), "-o", path.join(root, "outputs/mcp-compress-proof-cli.mp4"), "--target-size", "1", "--no-quality-proof"]);
checkOk(proofCliJson.quality_proof === null && proofCliJson.target_met === true, "CLI compress --no-quality-proof skips the measurement", JSON.stringify(proofCliJson.quality_proof));
// Ladder + max-width: --max-width already shrinks the frame to
// 640x360, where 592k buys 0.0856 bpp — above the threshold, so the
// ladder leaves it alone.
const compressMWRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-target1-w640.mp4"), target_size_mb: 1, max_width: 640 },
});
const compressMWJson = JSON.parse(compressMWRes.content[0].text);
checkOk(compressMWJson.dimensions === "640x360" && compressMWJson.scaled_to === "640x360" && compressMWJson.resolution_ladder_applied === false && near(compressMWJson.bpp_before, 0.0856, 0.001), "compress target-size + max-width 640 does not ladder further (bpp 0.0856)", JSON.stringify(compressMWJson));
// email-25mb: shorthand for target-size 18 MB (25 MB Gmail limit ÷
// ~1.37 base64 inflation). The 10s testsrc saturates near 700 kbps,
// so the file lands far under 18 MB — the target is a cap, not a floor.
const compressEmailRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-email.mp4"), quality: "email-25mb" },
});
const compressEmailJson = JSON.parse(compressEmailRes.content[0].text);
checkOk(compressEmailJson.mode === "target_size" && compressEmailJson.quality === "email-25mb" && compressEmailJson.target_size_mb === 18 && compressEmailJson.target_met === true && compressEmailJson.size_after_bytes <= 18000000, "compress email-25mb targets 18 MB in target_size mode", JSON.stringify(compressEmailJson));
checkOk(compressEmailJson.dimensions === "1280x720" && compressEmailJson.resolution_ladder_applied === false, "compress email-25mb does not ladder (bpp 0.46 at 720p)", JSON.stringify(compressEmailJson));
const compressEmailBadRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-email-bad.mp4"), quality: "email-25mb", target_size_mb: 5 },
});
const compressEmailBadText = compressEmailBadRes.content?.[0]?.text ?? "";
checkOk(/mutually exclusive/.test(compressEmailBadText) && /email-25mb/.test(compressEmailBadText), "compress email-25mb + target-size is rejected as mutually exclusive", compressEmailBadText.slice(0, 200));
const compressEmailCrfRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-email-crf.mp4"), quality: "email-25mb", crf: 28 },
});
const compressEmailCrfText = compressEmailCrfRes.content?.[0]?.text ?? "";
checkOk(/mutually exclusive/.test(compressEmailCrfText), "compress email-25mb + crf is rejected as mutually exclusive", compressEmailCrfText.slice(0, 200));

// extract_audio --whisper: 16 kHz mono WAV, the direct input for a
// transcribe step. The output was requested as .mp3 — whisper renames
// it to .wav and reports the real path.
const whisperRes = await client.callTool({
  name: "extract_audio",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-whisper.mp3"), whisper: true },
});
const whisperJson = JSON.parse(whisperRes.content[0].text);
console.log("extract_audio whisper:", JSON.stringify(whisperJson));
checkOk(whisperJson.output.endsWith("mcp-whisper.wav") && whisperJson.format === "wav" && whisperJson.whisper_preset === true, "extract_audio --whisper renames output to .wav and reports it", JSON.stringify(whisperJson));
checkOk(whisperJson.sample_rate_hz === 16000 && whisperJson.channels === 1, "extract_audio --whisper is 16 kHz mono", JSON.stringify(whisperJson));
checkOk(whisperJson.output_codec === "pcm_s16le" && whisperJson.codec_verified === true, "extract_audio --whisper verifies the probed output codec is really pcm_s16le (not a mislabelled container)", JSON.stringify({ output_codec: whisperJson.output_codec, codec_verified: whisperJson.codec_verified }));
checkOk(near(whisperJson.duration_seconds, 10, 0.1), "extract_audio --whisper keeps 10s", `got ${whisperJson.duration_seconds}`);
// Independent check: ffprobe the file on disk, not just the tool's claim.
const { stdout: whisperProbeOut } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", path.join(root, "outputs/mcp-whisper.wav")]);
const whisperProbe = JSON.parse(whisperProbeOut).streams[0];
checkOk(whisperProbe.codec_name === "pcm_s16le" && Number(whisperProbe.sample_rate) === 16000 && whisperProbe.channels === 1, "ffprobe confirms the whisper file is pcm_s16le 16kHz mono", JSON.stringify(whisperProbe));
// whisper + format mp3: the preset wins, format is ignored (documented).
const whisperFmtRes = await client.callTool({
  name: "extract_audio",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-whisper-fmt.wav"), format: "mp3", whisper: true },
});
const whisperFmtJson = JSON.parse(whisperFmtRes.content[0].text);
checkOk(whisperFmtJson.format === "wav" && whisperFmtJson.codec === "pcm_s16le", "extract_audio --whisper overrides --format mp3", JSON.stringify(whisperFmtJson));

// receipt: provenance sidecar. The SHA-256 in the receipt must match
// an independent sha256sum of the same file — that is the whole point.
const receiptRes = await client.callTool({
  name: "receipt",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-receipt.json"), platform: "tiktok" },
});
const receiptJson = JSON.parse(receiptRes.content[0].text);
console.log("receipt call:", JSON.stringify(receiptJson));
const { stdout: shaOut } = await execFileAsync("sha256sum", [path.join(root, "test/source.mp4")]);
const realSha = shaOut.split(/\s+/)[0];
checkOk(receiptJson.sha256 === realSha, "receipt SHA-256 matches independent sha256sum", `receipt ${receiptJson.sha256} vs ${realSha}`);
checkOk(receiptJson.size_bytes === 243932, "receipt size is 243932 bytes", `got ${receiptJson.size_bytes}`);
checkOk(near(receiptJson.duration_seconds, 10, 0.01), "receipt duration is 10s", `got ${receiptJson.duration_seconds}`);
checkOk(typeof receiptJson.loudness_lufs === "number", "receipt measures loudness", `got ${receiptJson.loudness_lufs}`);
checkOk(receiptJson.platform_pass === false, "receipt records the TikTok check failing on 1280x720 source", `got ${receiptJson.platform_pass}`);
const receiptFile = JSON.parse(await readFile(path.join(root, "outputs/mcp-receipt.json"), "utf8"));
checkOk(receiptFile.sha256 === realSha, "receipt file on disk carries the same SHA-256", `got ${receiptFile.sha256}`);
// The runner's ffmpeg version differs from the dev machine's (8.0.1
// vs 8.1.2) — compare against the version measured here, not a
// hardcoded one, or CI goes red on a version bump that changes nothing.
const { stdout: ffVerOut } = await execFileAsync("ffmpeg", ["-version"]);
const ffVer = (ffVerOut.match(/ffmpeg version (\S+)/) || [])[1];
checkOk(receiptFile.environment?.ffmpeg_version === ffVer, "receipt file records the ffmpeg version", JSON.stringify(receiptFile.environment));
checkOk(receiptFile.platform_check?.pass === false && receiptFile.probe?.duration_seconds === 10, "receipt file embeds the platform check and probe", JSON.stringify(receiptFile.platform_check));
// No platform: no platform_check key in the file.
const receiptPlainRes = await client.callTool({
  name: "receipt",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-receipt-plain.json") },
});
const receiptPlainJson = JSON.parse(receiptPlainRes.content[0].text);
checkOk(receiptPlainJson.platform_pass === undefined, "receipt without platform has no platform_pass", JSON.stringify(receiptPlainJson));
const receiptPlainFile = JSON.parse(await readFile(path.join(root, "outputs/mcp-receipt-plain.json"), "utf8"));
checkOk(!("platform_check" in receiptPlainFile), "receipt file without platform has no platform_check key", Object.keys(receiptPlainFile).join(","));

// mux: replace a video's audio track, stream-copy, with offset.
// Fixtures: source.mp4 is 10s h264+aac; mix-voice.mp3 is 9s of tone
// bursts [0,2),[4,6),[7,9) (so its silences are [2,4),[6,7));
const muxRes = await client.callTool({
  name: "mux",
  arguments: { video: path.join(root, "test/source.mp4"), audio: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-mux.mp4") },
});
const muxJson = JSON.parse(muxRes.content[0].text);
console.log("mux call:", JSON.stringify(muxJson));
checkOk(muxJson.mode === "stream-copy", "mux reports stream-copy mode", JSON.stringify(muxJson));
checkOk(muxJson.video_codec === "h264" && muxJson.audio_codec === "mp3", "mux keeps h264 video and copies the mp3 audio (replacing the source aac)", JSON.stringify(muxJson));
checkOk(near(muxJson.duration_seconds, 10, 0.05), "mux output duration is 10s", `got ${muxJson.duration_seconds}`);
// Independent probe: the output really has 1 video + 1 audio stream.
const muxProbe = await probeStreams(path.join(root, "outputs/mcp-mux.mp4"));
checkOk(muxProbe?.streams?.length === 2 && muxProbe.streams.some((s) => s.codec_type === "video") && muxProbe.streams.some((s) => s.codec_type === "audio" && s.codec_name === "mp3"), "independent ffprobe sees h264 + mp3 in the mux output", JSON.stringify(muxProbe?.streams));
// +2s offset: audio stream start_time moves to ~2s (mp3 priming
// shifts it by ~26ms, so tolerance 0.1), and the tone gaps move with
// it: silencedetect must find the gap at [4,6), not the unshifted [2,4).
const muxOffRes = await client.callTool({
  name: "mux",
  arguments: { video: path.join(root, "test/source.mp4"), audio: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-mux-off2.mp4"), audio_offset_seconds: 2 },
});
const muxOffJson = JSON.parse(muxOffRes.content[0].text);
checkOk(near(muxOffJson.duration_seconds, 11, 0.05), "mux +2s offset stretches duration to 11s", `got ${muxOffJson.duration_seconds}`);
const muxOffProbe = await probeStreams(path.join(root, "outputs/mcp-mux-off2.mp4"));
const offAudioStart = parseFloat(muxOffProbe?.streams?.find((s) => s.codec_type === "audio")?.start_time ?? NaN);
checkOk(near(offAudioStart, 2, 0.1), "mux +2s offset: independent ffprobe audio start_time is ~2s", `got ${offAudioStart}`);
const { stderr: sdErr } = await execFileAsync("ffmpeg", ["-v", "info", "-i", path.join(root, "outputs/mcp-mux-off2.mp4"), "-map", "0:a", "-af", "silencedetect=noise=-40dB:d=0.5", "-f", "null", "-"]);
const sdStarts = [...sdErr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
checkOk(sdStarts.some((t) => near(t, 4, 0.1)) && sdStarts.some((t) => near(t, 8, 0.1)), "mux +2s offset: silencedetect finds the tone gaps shifted to [4,6) and [8,9)", `gaps at ${sdStarts.join(", ")}`);
// Negative offset delays the video instead.
const muxNegRes = await client.callTool({
  name: "mux",
  arguments: { video: path.join(root, "test/source.mp4"), audio: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-mux-offneg.mp4"), audio_offset_seconds: -1 },
});
const muxNegJson = JSON.parse(muxNegRes.content[0].text);
checkOk(near(muxNegJson.duration_seconds, 11, 0.05), "mux -1s offset stretches duration to 11s", `got ${muxNegJson.duration_seconds}`);
const muxNegProbe = await probeStreams(path.join(root, "outputs/mcp-mux-offneg.mp4"));
const negVideoStart = parseFloat(muxNegProbe?.streams?.find((s) => s.codec_type === "video")?.start_time ?? NaN);
checkOk(near(negVideoStart, 1, 0.05), "mux -1s offset: independent ffprobe video start_time is 1s", `got ${negVideoStart}`);
// --shortest stops at the 2s audio.
const muxShortRes = await client.callTool({
  name: "mux",
  arguments: { video: path.join(root, "test/source.mp4"), audio: path.join(root, "test/mix-music-short.mp3"), output: path.join(root, "outputs/mcp-mux-short.mp4"), shortest: true },
});
const muxShortJson = JSON.parse(muxShortRes.content[0].text);
checkOk(near(muxShortJson.duration_seconds, 2, 0.05), "mux --shortest stops at the 2s audio", `got ${muxShortJson.duration_seconds}`);
// dry-run writes no file.
const muxDryPath = path.join(root, "outputs/mcp-mux-dry.mp4");
const muxDryRes = await client.callTool({
  name: "mux",
  arguments: { video: path.join(root, "test/source.mp4"), audio: path.join(root, "test/mix-voice.mp3"), output: muxDryPath, dry_run: true },
});
const muxDryJson = JSON.parse(muxDryRes.content[0].text);
checkOk(muxDryJson.dry_run === true && Array.isArray(muxDryJson.command) && muxDryJson.command.includes("-itsoffset") === false, "mux dry-run returns the ffmpeg command", JSON.stringify(muxDryJson).slice(0, 200));
checkOk(!existsSync(muxDryPath), "mux dry-run writes no file", muxDryPath);
// dry-run on the single-encode tools (turn 63): trim, resize,
// convert, crop — each prints the exact ffmpeg command(s) and
// writes no file. The smart-cut plan lists three commands in order.
const dryTrimPath = path.join(root, "outputs/mcp-dry-trim.mp4");
const dryTrimRes = await client.callTool({ name: "trim", arguments: { input: path.join(root, "test/source.mp4"), output: dryTrimPath, start: 1, duration: 2, dry_run: true } });
const dryTrimJson = JSON.parse(dryTrimRes.content[0].text);
checkOk(dryTrimJson.dry_run === true && dryTrimJson.commands?.length === 1 && dryTrimJson.commands[0].includes("-ss 1") && dryTrimJson.commands[0].includes("-t 2") && dryTrimJson.start === 1 && dryTrimJson.duration_seconds === 2, "trim dry-run prints one command with the exact seek + length", JSON.stringify(dryTrimJson.commands));
checkOk(!existsSync(dryTrimPath), "trim dry-run writes no file", dryTrimPath);
const dryTrimSnapRes = await client.callTool({ name: "trim", arguments: { input: path.join(root, "test/source.mp4"), output: dryTrimPath, start: 1, duration: 3, stream_copy: true, snap_to_keyframe: true, dry_run: true } });
const dryTrimSnapJson = JSON.parse(dryTrimSnapRes.content[0].text);
checkOk(dryTrimSnapJson.dry_run === true && dryTrimSnapJson.snapped === true && dryTrimSnapJson.keyframe_start === 0 && dryTrimSnapJson.keyframe_end === 8.333 && dryTrimSnapJson.commands?.[0]?.includes("-ss 0"), "trim dry-run with --snap reports the snapped keyframes in the plan", JSON.stringify(dryTrimSnapJson).slice(0, 200));
const dryTrimSmartRes = await client.callTool({ name: "trim", arguments: { input: path.join(root, "test/source.mp4"), output: dryTrimPath, start: 1, duration: 9, stream_copy: true, smart_cut: true, dry_run: true } });
const dryTrimSmartJson = JSON.parse(dryTrimSmartRes.content[0].text);
checkOk(dryTrimSmartJson.dry_run === true && dryTrimSmartJson.mode === "smart-cut" && dryTrimSmartJson.commands?.length === 3 && dryTrimSmartJson.commands[0].includes("-b:v") && dryTrimSmartJson.commands[1].includes("-c copy") && dryTrimSmartJson.commands[2].includes("-f concat"), "trim dry-run with --smart-cut lists three commands (head re-encode, tail copy, concat)", JSON.stringify(dryTrimSmartJson.commands?.map((c) => c.slice(0, 80))));
checkOk(!existsSync(dryTrimPath), "trim dry-run (smart-cut) writes no file and leaves no temp dir", dryTrimPath);
// The overwrite guard (reel-ffmpeg-mcp study, lượt 105): prepareOutput
// refuses output == input — a trim must never eat its own source.
const guardTrim = await callExpectThrow("trim", { input: path.join(root, "test/source.mp4"), output: path.join(root, "test/source.mp4"), start: 1, duration: 2 });
checkOk(/OUTPUT_OVERWRITES_INPUT/.test(guardTrim), "trim refuses output == input (OUTPUT_OVERWRITES_INPUT)", guardTrim.slice(0, 200));
const dryResizePath = path.join(root, "outputs/mcp-dry-resize.mp4");
const dryResizeRes = await client.callTool({ name: "resize", arguments: { input: path.join(root, "test/source.mp4"), output: dryResizePath, preset: "720p", dry_run: true } });
const dryResizeJson = JSON.parse(dryResizeRes.content[0].text);
checkOk(dryResizeJson.dry_run === true && dryResizeJson.dimensions === "1280x720" && dryResizeJson.commands?.[0]?.includes("scale=1280:720"), "resize dry-run prints the scale command for the preset box", JSON.stringify(dryResizeJson.commands));
checkOk(!existsSync(dryResizePath), "resize dry-run writes no file", dryResizePath);
const dryConvertPath = path.join(root, "outputs/mcp-dry-convert.mp4");
const dryConvertRes = await client.callTool({ name: "convert", arguments: { input: path.join(root, "test/source.mp4"), output: dryConvertPath, video_codec: "libx264", gop: 60, dry_run: true } });
const dryConvertJson = JSON.parse(dryConvertRes.content[0].text);
checkOk(dryConvertJson.dry_run === true && dryConvertJson.gop_frames === 60 && dryConvertJson.keyframes === null && dryConvertJson.commands?.[0]?.includes("-g 60"), "convert dry-run prints the GOP command and reports keyframes null (measured on real output only)", JSON.stringify(dryConvertJson.commands));
checkOk(!existsSync(dryConvertPath), "convert dry-run writes no file", dryConvertPath);
const dryCropPath = path.join(root, "outputs/mcp-dry-crop.mp4");
const dryCropRes = await client.callTool({ name: "crop", arguments: { input: path.join(root, "test/source.mp4"), output: dryCropPath, width: 640, height: 360, dry_run: true } });
const dryCropJson = JSON.parse(dryCropRes.content[0].text);
checkOk(dryCropJson.dry_run === true && dryCropJson.dimensions === "640x360" && dryCropJson.commands?.[0]?.includes("crop=640:360:0:0"), "crop dry-run prints the crop filter command", JSON.stringify(dryCropJson.commands));
checkOk(!existsSync(dryCropPath), "crop dry-run writes no file", dryCropPath);
// CLI dry-run: trim through the real CLI prints the same plan.
const dryCliTrim = await runCli(["trim", path.join(root, "test/source.mp4"), "--start", "1", "--duration", "2", "-o", dryTrimPath, "--dry-run"]);
const dryCliTrimJson = JSON.parse(dryCliTrim.out);
checkOk(dryCliTrim.code === 0 && dryCliTrimJson.dry_run === true && dryCliTrimJson.commands?.length === 1 && !existsSync(dryTrimPath), "CLI trim --dry-run prints the plan and writes no file", dryCliTrim.out.slice(0, 150));
// Batch 3 of the dry-run backlog (lượt 109): extract_audio,
// interpolate, denoise, segment, fastforward. Same rule as batches
// 1-2: each tool builds its ffmpeg argv once and either prints it
// (dry-run) or runs it, so the printed command is the command the
// real run executes.
const dryExtractPath = path.join(root, "outputs/mcp-dry-extract.mp3");
const dryExtractRes = await client.callTool({ name: "extract_audio", arguments: { input: path.join(root, "test/source.mp4"), output: dryExtractPath, dry_run: true } });
const dryExtractJson = JSON.parse(dryExtractRes.content[0].text);
checkOk(dryExtractJson.dry_run === true && dryExtractJson.codec === "libmp3lame" && dryExtractJson.duration_seconds === null && dryExtractJson.codec_verified === null && dryExtractJson.commands?.[0]?.includes("-vn") && dryExtractJson.commands[0].includes("libmp3lame"), "extract_audio dry-run prints the extraction command, duration/codec_verified null (measured on real output only)", JSON.stringify(dryExtractJson.commands));
checkOk(!existsSync(dryExtractPath), "extract_audio dry-run writes no file", dryExtractPath);
const dryExtractWhisperRes = await client.callTool({ name: "extract_audio", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-dry-extract-whisper.mp3"), whisper: true, dry_run: true } });
const dryExtractWhisperJson = JSON.parse(dryExtractWhisperRes.content[0].text);
checkOk(dryExtractWhisperJson.dry_run === true && dryExtractWhisperJson.output.endsWith(".wav") && dryExtractWhisperJson.sample_rate_hz === 16000 && dryExtractWhisperJson.channels === 1 && dryExtractWhisperJson.commands?.[0]?.includes("-ar 16000"), "extract_audio dry-run --whisper renames to .wav and forces 16 kHz mono in the printed command", JSON.stringify(dryExtractWhisperJson).slice(0, 200));
checkOk(!existsSync(path.join(root, "outputs/mcp-dry-extract-whisper.wav")), "extract_audio dry-run --whisper writes no file", "mcp-dry-extract-whisper.wav");
const dryInterpPath = path.join(root, "outputs/mcp-dry-interp.mp4");
const dryInterpRes = await client.callTool({ name: "interpolate", arguments: { input: path.join(root, "test/source.mp4"), output: dryInterpPath, fps: 60, mode: "blend", dry_run: true } });
const dryInterpJson = JSON.parse(dryInterpRes.content[0].text);
checkOk(dryInterpJson.dry_run === true && dryInterpJson.fps_before === 30 && dryInterpJson.frames_before === 300 && dryInterpJson.fps_after === null && dryInterpJson.frames_after === null && dryInterpJson.commands?.[0]?.includes("minterpolate=fps=60:mi_mode=blend"), "interpolate dry-run prints the minterpolate command with the input's real 30fps/300 frames, fps_after/frames_after null", JSON.stringify(dryInterpJson.commands));
checkOk(!existsSync(dryInterpPath), "interpolate dry-run writes no file", dryInterpPath);
const dryDenoisePath = path.join(root, "outputs/mcp-dry-denoise.mp4");
const dryDenoiseRes = await client.callTool({ name: "denoise", arguments: { input: path.join(root, "test/source.mp4"), output: dryDenoisePath, filter: "hqdn3d", strength: 0.5, dry_run: true } });
const dryDenoiseJson = JSON.parse(dryDenoiseRes.content[0].text);
checkOk(dryDenoiseJson.dry_run === true && dryDenoiseJson.filter_value === 15 && typeof dryDenoiseJson.noise_before === "number" && dryDenoiseJson.noise_after === null && dryDenoiseJson.commands?.[0]?.includes("hqdn3d=15:15:15:15"), "denoise dry-run prints the hqdn3d command (strength 0.5 -> 15) with noise_before measured on the input, noise_after null", JSON.stringify(dryDenoiseJson.commands));
checkOk(!existsSync(dryDenoisePath), "denoise dry-run writes no file", dryDenoisePath);
const drySegDir = path.join(root, "outputs/mcp-dry-hls");
const drySegRes = await client.callTool({ name: "segment", arguments: { input: path.join(root, "test/source.mp4"), output_dir: drySegDir, segment_time: 2, dry_run: true } });
const drySegJson = JSON.parse(drySegRes.content[0].text);
checkOk(drySegJson.dry_run === true && drySegJson.mode === "copy" && drySegJson.segment_count === null && drySegJson.segments === null && near(drySegJson.source_duration_seconds, 10, 0.01) && drySegJson.commands?.[0]?.includes("-hls_time 2") && drySegJson.commands[0].includes("-f hls"), "segment dry-run prints the HLS command with the source duration, segment_count null (GOP-dependent in copy mode)", JSON.stringify(drySegJson.commands));
checkOk(!existsSync(drySegDir), "segment dry-run creates no directory and writes no file", drySegDir);
const dryFfPath = path.join(root, "outputs/mcp-dry-fastforward.mp4");
const dryFfRes = await client.callTool({ name: "fastforward", arguments: { input: path.join(root, "test/source.mp4"), output: dryFfPath, segments: [{ start: 2, end: 4, speed: 2 }], dry_run: true } });
const dryFfJson = JSON.parse(dryFfRes.content[0].text);
checkOk(dryFfJson.dry_run === true && dryFfJson.duration_expected_seconds === 9 && dryFfJson.duration_seconds === null && dryFfJson.timing_check_mapped === null && dryFfJson.commands?.[0]?.includes("setpts=(PTS-STARTPTS)/2") && dryFfJson.commands[0].includes("atempo") && dryFfJson.commands[0].includes("mediakit-fastforward-dryrun"), "fastforward dry-run prints the setpts/atempo command for a 2-4s@2x span (expected 9s) with badge files in the deterministic temp dir", JSON.stringify(dryFfJson.commands).slice(0, 300));
checkOk(!existsSync(dryFfPath), "fastforward dry-run writes no file", dryFfPath);
// CLI dry-run: segment through the real CLI creates no directory.
const dryCliSeg = await runCli(["segment", path.join(root, "test/source.mp4"), "--segment-time", "2", "-o", drySegDir, "--dry-run"]);
const dryCliSegJson = JSON.parse(dryCliSeg.out);
checkOk(dryCliSeg.code === 0 && dryCliSegJson.dry_run === true && !existsSync(drySegDir), "CLI segment --dry-run prints the plan and creates no directory", dryCliSeg.out.slice(0, 150));
// Errors: audio file as the video, video file as the audio, offset out of range.
const muxBadVideoRes = await client.callTool({
  name: "mux",
  arguments: { video: path.join(root, "test/mix-voice.mp3"), audio: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-mux-bad.mp4") },
});
const muxBadVideoJson = JSON.parse(muxBadVideoRes.content[0].text);
checkOk(muxBadVideoRes.isError === true && /video stream/.test(muxBadVideoJson.error ?? ""), "mux refuses an audio file as the video input", JSON.stringify(muxBadVideoJson));
const muxBadAudioRes = await client.callTool({
  name: "mux",
  arguments: { video: path.join(root, "test/source.mp4"), audio: path.join(root, "test/logo.png"), output: path.join(root, "outputs/mcp-mux-bad2.mp4") },
});
const muxBadAudioJson = JSON.parse(muxBadAudioRes.content[0].text);
checkOk(muxBadAudioRes.isError === true && /audio stream/.test(muxBadAudioJson.error ?? ""), "mux refuses an image (no audio stream) as the audio input", JSON.stringify(muxBadAudioJson));
const muxBadOffRes = await client.callTool({
  name: "mux",
  arguments: { video: path.join(root, "test/source.mp4"), audio: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-mux-bad3.mp4"), audio_offset_seconds: 9999 },
});
// Zod rejects out-of-range input at the MCP layer, so the result is
// an error string, not JSON — read the text (same pattern as the
// social bad-platform assertion), don't JSON.parse it.
const muxBadOffText = muxBadOffRes.content[0].text;
checkOk(/3600/.test(muxBadOffText) && /audio_offset_seconds/.test(muxBadOffText), "mux refuses an offset outside ±3600s (MCP schema validation)", muxBadOffText.slice(0, 200));

// export_gif: two-pass palette GIF that fits a size budget.
// Default: 10s source -> 640x360, 15fps, 150 frames, under 10 MB.
const gifRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo.gif") },
});
const gifJson = JSON.parse(gifRes.content[0].text);
console.log("export_gif call:", JSON.stringify(gifJson).slice(0, 400));
checkOk(gifJson.width === 640 && gifJson.height === 360, "export_gif default is 640x360", JSON.stringify({ w: gifJson.width, h: gifJson.height }));
checkOk(gifJson.fps === 15, "export_gif default fps is 15", `got ${gifJson.fps}`);
checkOk(near(gifJson.duration_seconds, 10, 0.05), "export_gif keeps 10s duration", `got ${gifJson.duration_seconds}`);
checkOk(gifJson.frames === 150, "export_gif counts 150 frames (10s x 15fps)", `got ${gifJson.frames}`);
checkOk(gifJson.size_budget_met === true && gifJson.attempts_tried === 1 && gifJson.size_bytes <= 10_000_000, "export_gif meets the 10 MB default budget on the first attempt", JSON.stringify({ size: gifJson.size_bytes, attempts: gifJson.attempts_tried }));
// Independent check: the file really is a GIF of the reported size.
const gifProbe = await probeStreams(path.join(root, "outputs/mcp-demo.gif"));
checkOk(gifProbe?.streams?.[0]?.codec_name === "gif" && gifProbe?.streams?.[0]?.width === 640, "independent ffprobe sees a 640-wide GIF", JSON.stringify(gifProbe?.streams));
checkOk(statSync(path.join(root, "outputs/mcp-demo.gif")).size === gifJson.size_bytes, "on-disk file size matches the reported size_bytes", `disk ${statSync(path.join(root, "outputs/mcp-demo.gif")).size} vs ${gifJson.size_bytes}`);
// Tight budget (0.5 MB): the ladder must step fps, then width, down.
// The tight ladder runs 4+ GIF encodes of a 10s clip — over the
// SDK's 60s default when the machine is busy (same trap as the mci
// interpolate and the impossible-budget call below, same 300s
// override). Lượt 96 caught it: the full suite crashed here with
// "Request timed out" (60s) while a GTA render + rembg job loaded
// the machine; the tool itself is fine.
const gifTightRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo-tight.gif"), max_size_mb: 0.5 },
}, undefined, { timeout: 300000 });
const gifTightJson = JSON.parse(gifTightRes.content[0].text);
console.log("export_gif tight ladder:", JSON.stringify(gifTightJson.attempts));
checkOk(gifTightJson.size_budget_met === true && gifTightJson.size_bytes <= 500_000, "export_gif fits the 0.5 MB budget", JSON.stringify({ size: gifTightJson.size_bytes, attempts: gifTightJson.attempts_tried }));
checkOk(gifTightJson.attempts_tried >= 4 && gifTightJson.width === 320 && gifTightJson.fps === 8, "export_gif steps the ladder down (fps, then width) to meet a tight budget", JSON.stringify(gifTightJson.attempts));
checkOk(gifTightJson.attempts.every((a, i) => i === 0 || a.size_bytes <= gifTightJson.attempts[i - 1].size_bytes), "export_gif attempts shrink the file as the ladder steps down", JSON.stringify(gifTightJson.attempts.map((a) => a.size_bytes)));
// Impossible budget (0.02 MB): all 8 ladder steps, met=false, warning.
const gifImpossRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo-imposs.gif"), max_size_mb: 0.02 },
  // 8 ladder steps on a 10s clip take ~65s on this VM (timed on the
  // CLI, lượt 56) — over the SDK's 60s default, same trap as the mci
  // interpolate above, same 300s override. The tool itself is fine.
}, undefined, { timeout: 300000 });
const gifImpossJson = JSON.parse(gifImpossRes.content[0].text);
checkOk(gifImpossJson.size_budget_met === false && gifImpossJson.attempts_tried === 8 && typeof gifImpossJson.warning === "string" && /could not be met/.test(gifImpossJson.warning), "export_gif reports honestly when the budget cannot be met (all 8 ladder steps + warning)", JSON.stringify({ met: gifImpossJson.size_budget_met, attempts: gifImpossJson.attempts_tried }));
// Segment 2-4s: 2s / 30 frames.
const gifSegRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo-seg.gif"), start: 2, end: 4 },
});
const gifSegJson = JSON.parse(gifSegRes.content[0].text);
checkOk(near(gifSegJson.duration_seconds, 2, 0.05) && gifSegJson.frames === 30 && gifSegJson.start_seconds === 2 && gifSegJson.end_seconds === 4, "export_gif segment 2-4s is 2s / 30 frames", JSON.stringify(gifSegJson));
// Errors: non-.gif output, audio-only input, end <= start.
const gifBadExtRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo.mp4") },
});
const gifBadExtJson = JSON.parse(gifBadExtRes.content[0].text);
checkOk(gifBadExtRes.isError === true && /\.gif/.test(gifBadExtJson.error ?? ""), "export_gif refuses a non-.gif output", JSON.stringify(gifBadExtJson));
const gifBadAudioRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-demo-audio.gif") },
});
const gifBadAudioJson = JSON.parse(gifBadAudioRes.content[0].text);
checkOk(gifBadAudioRes.isError === true && /video input/.test(gifBadAudioJson.error ?? ""), "export_gif refuses an audio-only input", JSON.stringify(gifBadAudioJson));
const gifBadRangeRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo-range.gif"), start: 8, end: 2 },
});
const gifBadRangeJson = JSON.parse(gifBadRangeRes.content[0].text);
checkOk(gifBadRangeRes.isError === true && /after start/.test(gifBadRangeJson.error ?? ""), "export_gif refuses end <= start", JSON.stringify(gifBadRangeJson));
// export_gif dry-run (lượt 116, batch 5): first ladder step only, the
// ladder plan listed, measured fields null, no file written.
const gifDryRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo-dry.gif"), dry_run: true },
});
const gifDryJson = JSON.parse(gifDryRes.content[0].text);
checkOk(gifDryJson.dry_run === true && gifDryJson.first_step?.fps === 15 && gifDryJson.first_step?.width === 640 && gifDryJson.first_step?.colors === 256 && gifDryJson.ladder?.length === 8 && gifDryJson.size_budget_met === null && gifDryJson.size_bytes === null && gifDryJson.frames === null && !existsSync(path.join(root, "outputs/mcp-demo-dry.gif")), "export_gif dry-run reports the first ladder step (15fps/640px/256 colors) + 8-step ladder, measured fields null, writes nothing", JSON.stringify({ first: gifDryJson.first_step, ladder: gifDryJson.ladder?.length }));
checkOk(gifDryJson.commands?.length === 1 && gifDryJson.commands[0].includes("fps=15") && gifDryJson.commands[0].includes("palettegen=max_colors=256") && gifDryJson.commands[0].includes("paletteuse"), "export_gif dry-run command is the first-step two-pass palette encode", gifDryJson.commands?.[0] ?? "");

// Errors carry the exact retry call (kinocut eyes-free law).
const retryRes = await client.callTool({
  name: "trim",
  arguments: { input: path.join(root, "test/no-such-file.mp4"), output: path.join(root, "outputs/mcp-retry.mp4"), start: 0, duration: 1 },
});
const retryJson = JSON.parse(retryRes.content[0].text);
checkOk(retryRes.isError === true && retryJson.retry?.tool === "trim" && retryJson.retry?.arguments?.input === path.join(root, "test/no-such-file.mp4"), "MCP errors carry retry {tool, arguments} for the exact failed call", JSON.stringify(retryJson.retry));
// CLI errors end with the exact command to retry (runCli is defined
// below in the sandbox section; function declarations hoist).
const cliRetry = await runCli(["trim", path.join(root, "test/source.mp4"), "--start", "99", "-o", path.join(root, "outputs/mcp-cli-retry.mp4")]);
checkOk(cliRetry.code !== 0 && /Retry: mediakit trim/.test(cliRetry.out) && /--start 99/.test(cliRetry.out), "CLI errors print the exact retry command", cliRetry.out.slice(0, 300));

// generate_srt: deterministic .srt from a cue list. Times mix seconds
// and "MM:SS"; the third cue touches the second's end (allowed).
const genSrtRes = await client.callTool({
  name: "generate_srt",
  arguments: {
    cues: [
      { start: 0, end: 2.5, text: "MediaKit gives agents" },
      { start: "0:03", end: 5, text: "real video tools\ntwo lines" },
      { start: 6, end: 8, text: "No shell, no guesswork." },
    ],
    output: path.join(root, "outputs/mcp-gen.srt"),
  },
});
const genSrtJson = JSON.parse(genSrtRes.content[0].text);
console.log("generate_srt call:", JSON.stringify(genSrtJson));
checkOk(genSrtJson.cue_count === 3 && genSrtJson.first_start_seconds === 0 && genSrtJson.last_end_seconds === 8, "generate_srt reports 3 cues spanning 0s..8s", JSON.stringify(genSrtJson));
const genSrtText = await readFile(path.join(root, "outputs/mcp-gen.srt"), "utf8");
checkOk(genSrtText.startsWith("1\n00:00:00,000 --> 00:00:02,500\nMediaKit gives agents") && genSrtText.includes("2\n00:00:03,000 --> 00:00:05,000\nreal video tools\ntwo lines") && genSrtText.includes("3\n00:00:06,000 --> 00:00:08,000\nNo shell, no guesswork."), "generate_srt file has numbered cues with comma timestamps (incl. MM:SS input + multi-line text)", genSrtText.slice(0, 120).replace(/\n/g, " "));
// Errors: overlapping cues, end <= start, empty text, non-.srt output.
const genOverlapRes = await client.callTool({
  name: "generate_srt",
  arguments: { cues: [{ start: 0, end: 3, text: "a" }, { start: 2, end: 4, text: "b" }], output: path.join(root, "outputs/mcp-gen-overlap.srt") },
});
const genOverlapJson = JSON.parse(genOverlapRes.content[0].text);
checkOk(genOverlapRes.isError === true && /must not overlap/.test(genOverlapJson.error ?? ""), "generate_srt refuses overlapping cues", JSON.stringify(genOverlapJson));
const genBadEndRes = await client.callTool({
  name: "generate_srt",
  arguments: { cues: [{ start: 5, end: 5, text: "a" }], output: path.join(root, "outputs/mcp-gen-badend.srt") },
});
const genBadEndJson = JSON.parse(genBadEndRes.content[0].text);
checkOk(genBadEndRes.isError === true && /must be after start/.test(genBadEndJson.error ?? ""), "generate_srt refuses end <= start", JSON.stringify(genBadEndJson));
const genBadTextRes = await client.callTool({
  name: "generate_srt",
  arguments: { cues: [{ start: 0, end: 2, text: "   " }], output: path.join(root, "outputs/mcp-gen-badtext.srt") },
});
const genBadTextJson = JSON.parse(genBadTextRes.content[0].text);
checkOk(genBadTextRes.isError === true && /non-empty/.test(genBadTextJson.error ?? ""), "generate_srt refuses blank cue text", JSON.stringify(genBadTextJson));
const genBadExtRes = await client.callTool({
  name: "generate_srt",
  arguments: { cues: [{ start: 0, end: 2, text: "a" }], output: path.join(root, "outputs/mcp-gen.txt") },
});
const genBadExtJson = JSON.parse(genBadExtRes.content[0].text);
checkOk(genBadExtRes.isError === true && /\.srt/.test(genBadExtJson.error ?? ""), "generate_srt refuses a non-.srt output", JSON.stringify(genBadExtJson));

// generate_srt words mode: semantic grouping. 11 words -> 2 cues:
// the 8-word cap splits after "see" (cue 1 ends 2.3s), the rest form
// cue 2. The grouping report names the split reason per cue.
const genWordsRes = await client.callTool({
  name: "generate_srt",
  arguments: {
    words: [
      { word: "Your", start: 0, end: 0.3 }, { word: "brain", start: 0.3, end: 0.6 },
      { word: "deletes", start: 0.6, end: 0.95 }, { word: "most", start: 0.95, end: 1.2 },
      { word: "of", start: 1.2, end: 1.45 }, { word: "what", start: 1.45, end: 1.7 },
      { word: "you", start: 1.7, end: 1.95 }, { word: "see", start: 1.95, end: 2.3 },
      { word: "every", start: 2.3, end: 2.6 }, { word: "single", start: 2.6, end: 2.95 },
      { word: "day", start: 2.95, end: 3.3 },
    ],
    output: path.join(root, "outputs/mcp-gen-words.srt"),
  },
});
const genWordsJson = JSON.parse(genWordsRes.content[0].text);
console.log("generate_srt words call:", JSON.stringify(genWordsJson.grouping));
checkOk(genWordsJson.cue_count === 2 && genWordsJson.grouping?.words_in === 11 && genWordsJson.grouping?.split_reasons?.[0] === "word-limit", "generate_srt words mode groups 11 words into 2 cues (8-word cap)", JSON.stringify(genWordsJson.grouping));
const genWordsText = await readFile(path.join(root, "outputs/mcp-gen-words.srt"), "utf8");
checkOk(genWordsText.includes("1\n00:00:00,000 --> 00:00:02,300\nYour brain deletes most of what you see") && genWordsText.includes("2\n00:00:02,300 --> 00:00:03,300\nevery single day"), "generate_srt words file has the 2 expected cues with exact times", genWordsText.replace(/\n/g, " "));
// groupWords directly: sentence end splits, a >0.4s pause splits, and
// a cue never ends on a stranded word ("the" moves to the next cue).
const gwSentence = groupWords([
  { word: "Go", start: 0, end: 0.2 }, { word: "home.", start: 0.2, end: 0.5 },
  { word: "Stay", start: 0.5, end: 0.8 }, { word: "safe.", start: 0.8, end: 1.1 },
  { word: "Hello", start: 2.0, end: 2.3 }, { word: "world", start: 2.3, end: 2.6 },
]);
checkOk(gwSentence.cues.map((c) => c.text).join(" | ") === "Go home. | Stay safe. | Hello world", "groupWords splits on sentence end and on a 0.9s pause", JSON.stringify(gwSentence.cues.map((c) => c.text)));
const gwStranded = groupWords(["One", "two", "three", "four", "five", "six", "seven", "the", "dog", "runs"].map((word, i) => ({ word, start: i * 0.2, end: i * 0.2 + 0.2 })));
checkOk(gwStranded.cues.map((c) => c.text).join(" | ") === "One two three four five six seven | the dog runs", "groupWords moves a stranded 'the' to the next cue", JSON.stringify(gwStranded.cues.map((c) => c.text)));
// Errors: cues + words together, and neither.
const genBothRes = await client.callTool({
  name: "generate_srt",
  arguments: { cues: [{ start: 0, end: 2, text: "a" }], words: [{ word: "a", start: 0, end: 0.2 }], output: path.join(root, "outputs/mcp-gen-both.srt") },
});
const genBothJson = JSON.parse(genBothRes.content[0].text);
checkOk(genBothRes.isError === true && /not both/.test(genBothJson.error ?? ""), "generate_srt refuses cues + words together", JSON.stringify(genBothJson));
const genNeitherText = await callExpectThrow("generate_srt", { output: path.join(root, "outputs/mcp-gen-neither.srt") });
checkOk(/needs cues/.test(genNeitherText ?? ""), "generate_srt refuses neither cues nor words", genNeitherText ?? "");

// publish_kit: thumbnail 1280x720 from the 10s fixture + 5 titles +
// chapters inside the measured duration -> metadata.md + publishing.json.
// A 640x360 frame is refused (under 1280px), 4 titles are refused
// (zod length), and a chapter past the duration is refused.
await client.callTool({
  name: "extract_frame",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-pub-thumb.png"), timestamp: 3 },
});
const pubKitRes = await client.callTool({
  name: "publish_kit",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    thumbnail: path.join(root, "outputs/mcp-pub-thumb.png"),
    output_dir: path.join(root, "outputs/mcp-publishing"),
    style: "clean-bold",
    titles: ["Your Brain Deletes Most of What You See", "Why You Forget Everything You Just Saw", "The Brain Trick Hiding in Plain Sight", "You See Less Than You Think", "What Your Brain Edits Out Every Second"],
    description: "A 10-second explainer about inattentional blindness, built with MediaKit.",
    tags: ["brain", "psychology", "shorts", "explainer"],
    pinned_comment: "What is something you stared straight at and still missed?",
    chapters: [{ time: 0, label: "The trick" }, { time: 5, label: "Why it happens" }],
  },
});
const pubKitJson = JSON.parse(pubKitRes.content[0].text);
console.log("publish_kit call:", JSON.stringify(pubKitJson.checklist));
checkOk(pubKitJson.operation === "publish_kit" && pubKitJson.style === "clean-bold" && pubKitJson.media?.duration_seconds === 10 && pubKitJson.thumbnail?.width === 1280, "publish_kit reports 10s media + 1280x720 thumbnail + clean-bold style", JSON.stringify(pubKitJson.media));
checkOk(pubKitJson.checklist?.filter((c) => c.status === "checked").length === 4 && pubKitJson.checklist?.filter((c) => c.status === "human-review").length === 3, "publish_kit checklist has 4 checked + 3 human-review items (never a false pass)", JSON.stringify(pubKitJson.checklist));
const pubMd = await readFile(path.join(root, "outputs/mcp-publishing/metadata.md"), "utf8");
checkOk(pubMd.includes("Your Brain Deletes Most of What You See") && pubMd.includes("HUMAN REVIEW") && pubMd.includes("- 00:05 Why it happens"), "publish_kit metadata.md has titles, chapters and HUMAN REVIEW items on disk", pubMd.slice(0, 200).replace(/\n/g, " "));
const pubDoc = JSON.parse(await readFile(path.join(root, "outputs/mcp-publishing/publishing.json"), "utf8"));
checkOk(pubDoc.media?.sha256?.length === 64 && pubDoc.titles?.length === 5 && pubDoc.style === "clean-bold", "publish_kit publishing.json records SHA-256, 5 titles and the style", JSON.stringify(pubDoc.titles));
const pubBadTitlesText = await callExpectThrow("publish_kit", {
  input: path.join(root, "test/source.mp4"), thumbnail: path.join(root, "outputs/mcp-pub-thumb.png"),
  output_dir: path.join(root, "outputs/mcp-publishing-bad"), titles: ["One", "Two", "Three", "Four"],
  description: "d", tags: ["x"], pinned_comment: "q?",
});
checkOk(/Array must contain exactly 5/.test(pubBadTitlesText ?? ""), "publish_kit refuses 4 titles (zod length)", pubBadTitlesText ?? "");
await client.callTool({
  name: "extract_frame",
  arguments: { input: path.join(root, "test/source2.mp4"), output: path.join(root, "outputs/mcp-pub-thumb-small.png"), timestamp: 1 },
});
const pubSmallRes = await client.callTool({
  name: "publish_kit",
  arguments: {
    input: path.join(root, "test/source.mp4"), thumbnail: path.join(root, "outputs/mcp-pub-thumb-small.png"),
    output_dir: path.join(root, "outputs/mcp-publishing-small"),
    titles: ["A", "B", "C", "D", "E"], description: "d", tags: ["x"], pinned_comment: "q?",
  },
});
const pubSmallJson = JSON.parse(pubSmallRes.content[0].text);
checkOk(pubSmallRes.isError === true && /at least 1280px/.test(pubSmallJson.error ?? ""), "publish_kit refuses a 640px-wide thumbnail", JSON.stringify(pubSmallJson));
const pubBadChapterRes = await client.callTool({
  name: "publish_kit",
  arguments: {
    input: path.join(root, "test/source.mp4"), thumbnail: path.join(root, "outputs/mcp-pub-thumb.png"),
    output_dir: path.join(root, "outputs/mcp-publishing-badch"),
    titles: ["A", "B", "C", "D", "E"], description: "d", tags: ["x"], pinned_comment: "q?",
    chapters: [{ time: 99, label: "Too late" }],
  },
});
const pubBadChapterJson = JSON.parse(pubBadChapterRes.content[0].text);
checkOk(pubBadChapterRes.isError === true && /outside the video/.test(pubBadChapterJson.error ?? ""), "publish_kit refuses a chapter past the measured duration", JSON.stringify(pubBadChapterJson));

// Style lock: skills/shorts-video/styles.json has exactly the three
// ids the code enforces, and every locked burn_captions value is
// inside the tool's accepted range.
const stylesDoc = JSON.parse(await readFile(path.join(root, "skills/shorts-video/styles.json"), "utf8"));
checkOk(JSON.stringify(stylesDoc.styles.map((s) => s.id)) === JSON.stringify(SHORTS_STYLE_IDS), "styles.json ids match SHORTS_STYLE_IDS in code", JSON.stringify(stylesDoc.styles.map((s) => s.id)));
checkOk(stylesDoc.styles.every((s) => ["background", "outline", "shadow", "glow"].includes(s.locked.burn_captions.style) && s.locked.burn_captions.font_size >= 8 && s.locked.burn_captions.font_size <= 200 && s.locked.loudness_target_lufs === -14), "every locked style has a valid caption style, font size and -14 LUFS target", JSON.stringify(stylesDoc.styles.map((s) => s.locked.burn_captions)));

// transcribe: validation errors need no engine (checked before the
// ASR engine is probed). The no-engine path is tested through a second
// server with both engines disabled (MEDIAKIT_ASR_PYTHON pointed at
// a python that cannot exist, MEDIAKIT_WHISPER_CPP_BIN at a binary
// that cannot exist), so the result is deterministic on any machine.
const trBadModelErr = await callExpectThrow("transcribe", { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-badmodel.srt"), model: "huge" });
checkOk(/huge/.test(trBadModelErr ?? ""), "transcribe refuses an unknown model (zod enum)", trBadModelErr ?? "");
const trBadExtRes = await client.callTool({
  name: "transcribe",
  arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk.txt") },
});
const trBadExtJson = JSON.parse(trBadExtRes.content[0].text);
checkOk(trBadExtRes.isError === true && /\.srt/.test(trBadExtJson.error ?? ""), "transcribe refuses a non-.srt output", JSON.stringify(trBadExtJson));
const trBadEngineErr = await callExpectThrow("transcribe", { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk.srt"), engine: "bogus" });
checkOk(/bogus/.test(trBadEngineErr ?? ""), "transcribe refuses an unknown engine (zod enum)", trBadEngineErr ?? "");
const noAsrTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
  // Both engines disabled: the python cannot exist AND the whisper.cpp
  // binary is explicitly pointed at a nonexistent path (an explicit
  // MEDIAKIT_WHISPER_CPP_BIN never falls back to the default install,
  // so this server deterministically has no engine on any machine).
  env: { ...process.env, MEDIAKIT_ASR_PYTHON: "/nonexistent/python3", MEDIAKIT_WHISPER_CPP_BIN: "/nonexistent/whisper-cli" },
});
const noAsrClient = new Client({ name: "mediakit-test-noasr", version: "0.1.0" }, { capabilities: {} });
await noAsrClient.connect(noAsrTransport);
const trNoEngRes = await noAsrClient.callTool({
  name: "transcribe",
  arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-noengine.srt") },
});
const trNoEngJson = JSON.parse(trNoEngRes.content[0].text);
checkOk(trNoEngRes.isError === true && trNoEngJson.code === "ASR_NOT_INSTALLED" && /faster-whisper/.test(trNoEngJson.error ?? "") && /MEDIAKIT_ASR_PYTHON/.test(trNoEngJson.error ?? ""), "transcribe without an engine refuses with install lines", JSON.stringify(trNoEngJson).slice(0, 200));
await noAsrClient.close();

// transcribe --engine whisper through a stub whisper-cli (the canned
// JFK JSON): exercises binary discovery, JSON parsing and .srt
// writing without a real binary or model. The real engine is covered
// by the MEDIAKIT_TEST_WHISPER_CPP gated block below.
const stubBin = path.join(root, "test/whisper-cli-stub.sh");
const stubModel = path.join(root, "test/whisper-stub-model.bin");
const stubTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
  env: { ...process.env, MEDIAKIT_ASR_PYTHON: "/nonexistent/python3", MEDIAKIT_WHISPER_CPP_BIN: stubBin, MEDIAKIT_WHISPER_MODEL: stubModel },
});
const stubClient = new Client({ name: "mediakit-test-whisper-stub", version: "0.1.0" }, { capabilities: {} });
await stubClient.connect(stubTransport);
const trStubRes = await stubClient.callTool({
  name: "transcribe",
  arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-whisper-stub.srt"), model: "tiny", language: "en", engine: "whisper" },
});
const trStubJson = JSON.parse(trStubRes.content[0].text);
checkOk(trStubRes.isError !== true && trStubJson.engine === "whisper.cpp" && trStubJson.segment_count === 1, "transcribe --engine whisper (stub) succeeds and reports the whisper.cpp engine", JSON.stringify(trStubJson).slice(0, 200));
checkOk(/fellow Americans/.test(trStubJson.text ?? "") && trStubJson.language === "en" && near(trStubJson.segments?.[0]?.end, 10.5, 0.05), "transcribe --engine whisper (stub) returns the JFK segment [0, 10.5] in English", JSON.stringify(trStubJson.segments?.[0]));
const trStubSrt = await readFile(path.join(root, "outputs/mcp-jfk-whisper-stub.srt"), "utf8");
checkOk(/^1\n00:00:00,000 --> 00:00:10,500\n/.test(trStubSrt) && /ask not what your country/.test(trStubSrt), "transcribe --engine whisper (stub) writes a valid .srt", trStubSrt.slice(0, 120).replace(/\n/g, " "));
const trStubDoctorRes = await stubClient.callTool({ name: "doctor", arguments: {} });
const trStubDoctorJson = JSON.parse(trStubDoctorRes.content[0].text);
checkOk(trStubDoctorJson.tools.transcribe?.available === true && trStubDoctorJson.tools.transcribe?.engine === "whisper.cpp" && trStubDoctorJson.tools.transcribe?.binary === stubBin, "doctor reports the whisper.cpp stub engine as available", JSON.stringify(trStubDoctorJson.tools.transcribe));

// transcribe --chunk-seconds through the same stub client: the stub
// returns one [0, 10.5] segment for every chunk wav, so the merge
// machinery is what the asserts pin down — 3 chunks over 11s at 5s
// each, segments re-offset to start at 0/5/10 and clamped to their
// chunk ends. (Real audio is covered by the gated whisper.cpp block.)
const trChunkRes = await stubClient.callTool({
  name: "transcribe",
  arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-chunk-stub.srt"), model: "tiny", language: "en", engine: "whisper", chunk_seconds: 5 },
});
const trChunkJson = JSON.parse(trChunkRes.content[0].text);
checkOk(trChunkRes.isError !== true && trChunkJson.chunks === 3 && trChunkJson.chunk_seconds === 5 && trChunkJson.chunk_overlap_seconds === 2, "transcribe --chunk-seconds 5 splits 11s into 3 chunks with 2s overlap", JSON.stringify(trChunkJson).slice(0, 300));
checkOk(trChunkJson.segment_count === 3 && near(trChunkJson.segments?.[0]?.start, 0, 0.01) && near(trChunkJson.segments?.[1]?.start, 5, 0.01) && near(trChunkJson.segments?.[2]?.start, 10, 0.01), "chunked segments are re-offset to start at 0/5/10", JSON.stringify(trChunkJson.segments));
checkOk(near(trChunkJson.segments?.[0]?.end, 7, 0.01) && near(trChunkJson.segments?.[1]?.end, 11, 0.01) && near(trChunkJson.segments?.[2]?.end, 11, 0.01), "chunked segments are clamped to their chunk ends", JSON.stringify(trChunkJson.segments));

// transcribe --word-timestamps through the same stub: the canned JSON
// now carries the real 28 tokens from whisper-cli b5454 + ggml-tiny,
// so the token -> word grouping is exercised ungated.
const trWordsRes = await stubClient.callTool({
  name: "transcribe",
  arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-words-stub.srt"), model: "tiny", language: "en", engine: "whisper", word_timestamps: true },
});
const trWordsJson = JSON.parse(trWordsRes.content[0].text);
checkOk(trWordsRes.isError !== true && trWordsJson.word_count === 22 && trWordsJson.words?.length === 22, "transcribe --word-timestamps (stub) returns 22 words", JSON.stringify(trWordsJson.words?.slice(0, 3)));
checkOk(trWordsJson.words?.[3]?.word === "fellow" && near(trWordsJson.words?.[3]?.start, 0.95, 0.01) && near(trWordsJson.words?.[3]?.end, 1.59, 0.01), "word #3 is 'fellow' [0.95, 1.59] from the token timings", JSON.stringify(trWordsJson.words?.[3]));
checkOk(trWordsJson.words?.[21]?.word === "country." && near(trWordsJson.words?.[21]?.end, 10.5, 0.01), "last word is 'country.' — the [_TT_525] timestamp token is skipped, not glued on", JSON.stringify(trWordsJson.words?.[21]));
checkOk(trWordsJson.words?.every((w, i, a) => i === 0 || w.start >= a[i - 1].start) && trWordsJson.words?.every((w, i) => w.end > w.start && w.index === i), "words are sorted, non-empty and 0-based indexed", JSON.stringify(trWordsJson.words?.slice(-2)));
checkOk(!("words" in trStubJson) && !("word_count" in trStubJson), "transcribe without --word-timestamps returns no words key", Object.keys(trStubJson).join(","));
// Chunked + word timestamps through the stub: 20 words (the stub
// repeats its canned words per chunk; ownership keeps each once per
// owned window, the boundary repeat lands in chunk 2 as 'fellow'
// [10.95, 11] — the same documented boundary behaviour as segments).
const trChunkWordsRes = await stubClient.callTool({
  name: "transcribe",
  arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-chunk-words-stub.srt"), model: "tiny", language: "en", engine: "whisper", chunk_seconds: 5, word_timestamps: true },
});
const trChunkWordsJson = JSON.parse(trChunkWordsRes.content[0].text);
checkOk(trChunkWordsRes.isError !== true && trChunkWordsJson.chunks === 3 && trChunkWordsJson.word_count === 20, "chunked transcribe --word-timestamps returns 20 words over 3 chunks", `chunks=${trChunkWordsJson.chunks} words=${trChunkWordsJson.word_count}`);
checkOk(trChunkWordsJson.words?.every((w, i, a) => i === 0 || w.start >= a[i - 1].start) && trChunkWordsJson.words?.every((w) => w.start >= 0 && w.end <= 11), "chunked words are sorted and inside the file", JSON.stringify(trChunkWordsJson.words?.slice(-2)));
await stubClient.close();

// cut_words: edit by transcript on a hand-written words file over
// test/source.mp4 (10s). Words: hello[0,1] um[2,3] world[4,5]
// uh[6,7] again[8,9]. Removing um+uh keeps [0,1.12]+[3.94,5.12]+
// [7.94,9.12] = 3.48s (pads 0.06/0.12 clamped to the 1s gaps).
const cwWords = path.join(root, "test/cut-words.json");
const cwRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords.mp4"), words_file: cwWords, remove: "um,uh" } });
const cwJson = JSON.parse(cwRes.content[0].text);
checkOk(cwRes.isError !== true && cwJson.removed_count === 2 && cwJson.removed_words.map((w) => w.word).join(",") === "um,uh", "cut_words --remove um,uh removes exactly those 2 words", JSON.stringify(cwJson.removed_words));
checkOk(near(cwJson.duration_after, 3.48, 0.05) && JSON.stringify(cwJson.keep_segments) === JSON.stringify([{ start: 0, end: 1.12, duration: 1.12 }, { start: 3.94, end: 5.12, duration: 1.18 }, { start: 7.94, end: 9.12, duration: 1.18 }]), "cut_words keep segments are [0,1.12]+[3.94,5.12]+[7.94,9.12] (3.48s)", JSON.stringify(cwJson.keep_segments));
checkOk(cwJson.cut_check?.swallowed?.length === 0, "cut_words cut check: no kept word swallowed", JSON.stringify(cwJson.cut_check));
// --fillers matches the same two words; --keep rescues one.
const cwFillRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords-fill.mp4"), words_file: cwWords, fillers: true, keep: "1" } });
const cwFillJson = JSON.parse(cwFillRes.content[0].text);
checkOk(cwFillRes.isError !== true && cwFillJson.removed_count === 1 && cwFillJson.removed_words[0].word === "uh" && near(cwFillJson.duration_after, 6.3, 0.05), "cut_words --fillers --keep 1 removes only 'uh' (um rescued)", JSON.stringify(cwFillJson.removed_words));
// --indices cuts by 0-based position, not text.
const cwIdxRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords-idx.mp4"), words_file: cwWords, indices: "2" } });
const cwIdxJson = JSON.parse(cwIdxRes.content[0].text);
checkOk(cwIdxRes.isError !== true && cwIdxJson.removed_count === 1 && cwIdxJson.removed_words[0].word === "world" && near(cwIdxJson.duration_after, 6.3, 0.05), "cut_words --indices 2 removes 'world' only", JSON.stringify(cwIdxJson.removed_words));
// Audio-only input takes the audio-codec branch (.mp3 out).
const cwAudioRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-cutwords-audio.mp3"), words_file: cwWords, remove: "um,uh" } });
const cwAudioJson = JSON.parse(cwAudioRes.content[0].text);
checkOk(cwAudioRes.isError !== true && cwAudioJson.removed_count === 2 && near(cwAudioJson.duration_after, 3.36, 0.05), "cut_words on audio-only input cuts to 3.36s", JSON.stringify(cwAudioJson).slice(0, 200));
// --dry-run plans without writing; no match stream-copies.
const cwDryRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), words_file: cwWords, remove: "um,uh", dry_run: true } });
const cwDryJson = JSON.parse(cwDryRes.content[0].text);
checkOk(cwDryRes.isError !== true && cwDryJson.dry_run === true && !("output" in cwDryJson) && cwDryJson.removed_count === 2, "cut_words --dry-run returns the plan with no output file", JSON.stringify(cwDryJson).slice(0, 200));
const cwNoRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords-nomatch.mp4"), words_file: cwWords, remove: "zzz" } });
const cwNoJson = JSON.parse(cwNoRes.content[0].text);
checkOk(cwNoRes.isError !== true && cwNoJson.stream_copy === true && near(cwNoJson.duration_after, 10, 0.05) && /no words matched/.test(cwNoJson.warning ?? ""), "cut_words with no match stream-copies unchanged", JSON.stringify(cwNoJson).slice(0, 200));
// --min-keep drops the short first run; its word is reported swallowed.
const cwMinRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords-minkeep.mp4"), words_file: cwWords, remove: "um,uh", min_keep: 1.15 } });
const cwMinJson = JSON.parse(cwMinRes.content[0].text);
checkOk(cwMinRes.isError !== true && near(cwMinJson.duration_after, 2.36, 0.05) && cwMinJson.cut_check?.swallowed?.length === 1 && cwMinJson.cut_check.swallowed[0].word === "hello", "cut_words --min-keep 1.15 drops the 1.12s run and reports 'hello' swallowed", JSON.stringify(cwMinJson.cut_check));
// Validation: no selector, out-of-range index, a JSON file with no
// words array (test/cues.json is a bare cues array).
const cwNoSelRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords-nosel.mp4"), words_file: cwWords } });
const cwNoSelJson = JSON.parse(cwNoSelRes.content[0].text);
checkOk(cwNoSelRes.isError === true && /selector/.test(cwNoSelJson.error ?? ""), "cut_words with no selector refuses", JSON.stringify(cwNoSelJson));
const cwBadIdxRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords-badidx.mp4"), words_file: cwWords, indices: "9" } });
const cwBadIdxJson = JSON.parse(cwBadIdxRes.content[0].text);
checkOk(cwBadIdxRes.isError === true && /out of range/.test(cwBadIdxJson.error ?? ""), "cut_words --indices 9 (only 5 words) refuses as out of range", JSON.stringify(cwBadIdxJson));
const cwBadFileRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords-badfile.mp4"), words_file: path.join(root, "test/cues.json"), remove: "um" } });
const cwBadFileJson = JSON.parse(cwBadFileRes.content[0].text);
checkOk(cwBadFileRes.isError === true && /words/.test(cwBadFileJson.error ?? ""), "cut_words refuses a JSON file with no words array", JSON.stringify(cwBadFileJson));
// cut_words through the CLI: --dry-run needs no -o; no selector refuses.
const cwCliDry = await runCli(["cut-words", path.join(root, "test/source.mp4"), "--words-file", path.join(root, "test/cut-words.json"), "--remove", "um,uh", "--dry-run"]);
checkOk(cwCliDry.code === 0 && /"dry_run": true/.test(cwCliDry.out), "CLI cut-words --dry-run needs no -o and prints the plan", cwCliDry.out.slice(0, 200));
const cwCliNoSel = await runCli(["cut-words", path.join(root, "test/source.mp4"), "--words-file", path.join(root, "test/cut-words.json"), "-o", path.join(root, "outputs/cli-cutwords-nosel.mp4")]);
checkOk(cwCliNoSel.code !== 0 && /selector/.test(cwCliNoSel.out), "CLI cut-words with no selector refuses", cwCliNoSel.out.slice(0, 200));
// --edge-buffer (Outtake's 0.1s clip-edge buffer): every keep segment
// grows 0.1s past its pads — [0,1.12] -> [0,1.22] (start clamped at
// the file edge), [3.94,5.12] -> [3.84,5.22], [7.94,9.12] ->
// [7.84,9.22] — 3.48s becomes 3.98s.
const cwEbRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-cutwords-edge.mp4"), words_file: cwWords, remove: "um,uh", edge_buffer: 0.1 } });
const cwEbJson = JSON.parse(cwEbRes.content[0].text);
checkOk(cwEbRes.isError !== true && cwEbJson.edge_buffer === 0.1 && near(cwEbJson.duration_after, 3.98, 0.05) && JSON.stringify(cwEbJson.keep_segments) === JSON.stringify([{ start: 0, end: 1.22, duration: 1.22 }, { start: 3.84, end: 5.22, duration: 1.38 }, { start: 7.84, end: 9.22, duration: 1.38 }]), "cut_words --edge-buffer 0.1 widens every keep segment 0.1s past its pads (3.98s)", JSON.stringify(cwEbJson.keep_segments));
// Merge: test/edge-buffer-words.json has 0.1s gaps between kept
// runs (a[0,1] um[1.1,1.5] b[1.6,2.6] uh[2.7,3.1] c[3.2,4.2]) — a
// 0.1s buffer keeps 3 segments, a 0.5s buffer bridges every gap and
// merges them into one [0,4.82] segment (the cuts disappear).
const ebWords = path.join(root, "test/edge-buffer-words.json");
const cwEbSmallRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), words_file: ebWords, remove: "um,uh", edge_buffer: 0.1, dry_run: true } });
const cwEbSmallJson = JSON.parse(cwEbSmallRes.content[0].text);
checkOk(cwEbSmallRes.isError !== true && cwEbSmallJson.keep_segments.length === 3 && JSON.stringify(cwEbSmallJson.keep_segments) === JSON.stringify([{ start: 0, end: 1.2, duration: 1.2 }, { start: 1.44, end: 2.8, duration: 1.36 }, { start: 3.04, end: 4.42, duration: 1.38 }]), "cut_words --edge-buffer 0.1 on tight gaps keeps 3 segments, none merged", JSON.stringify(cwEbSmallJson.keep_segments));
const cwEbMergeRes = await client.callTool({ name: "cut_words", arguments: { input: path.join(root, "test/source.mp4"), words_file: ebWords, remove: "um,uh", edge_buffer: 0.5, dry_run: true } });
const cwEbMergeJson = JSON.parse(cwEbMergeRes.content[0].text);
checkOk(cwEbMergeRes.isError !== true && cwEbMergeJson.keep_segments.length === 1 && JSON.stringify(cwEbMergeJson.keep_segments) === JSON.stringify([{ start: 0, end: 4.82, duration: 4.82 }]), "cut_words --edge-buffer 0.5 bridges the 0.1s gaps and merges all 3 runs into [0,4.82]", JSON.stringify(cwEbMergeJson.keep_segments));
const cwEbCli = await runCli(["cut-words", path.join(root, "test/source.mp4"), "--words-file", path.join(root, "test/cut-words.json"), "--remove", "um,uh", "--edge-buffer", "0.1", "--dry-run"]);
checkOk(cwEbCli.code === 0 && /"edge_buffer": 0.1/.test(cwEbCli.out) && /"end": 1.22/.test(cwEbCli.out), "CLI cut-words --edge-buffer 0.1 --dry-run reports the widened plan", cwEbCli.out.slice(0, 200));
// Batch + manifest pass-through: trim with edge_buffer runs through
// the batch table and the manifest step table like any other arg.
await rm(path.join(root, "outputs/mcp-batch-trim-edge-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-trim-edge-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-trim-edge-in"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-trim-edge-in/source.mp4"));
await copyFile(path.join(root, "test/source2.mp4"), path.join(root, "outputs/mcp-batch-trim-edge-in/source2.mp4"));
const ebBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "trim", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-trim-edge-in"), output_dir: path.join(root, "outputs/mcp-batch-trim-edge-out"), args: { start: 1, duration: 2, edge_buffer: 0.1 }, jobs: 2 },
});
const ebBatchJson = JSON.parse(ebBatchRes.content[0].text);
checkOk(ebBatchJson.succeeded === 2 && ebBatchJson.failed === 0 && ebBatchJson.results.every((r) => r.status === "ok" && near(r.result?.duration_actual, 2.2, 0.05) && r.result?.edge_buffer === 0.1), "batch trim --edge-buffer 0.1 widens both clips to 2.2s", JSON.stringify(ebBatchJson.results.map((r) => r.result?.duration_actual)));
const ebManifestPath = path.join(root, "outputs/mcp-manifest-edge-buffer.json");
await writeFile(ebManifestPath, JSON.stringify({ version: 1, input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-manifest-edge-buffer.mp4"), steps: [{ tool: "trim", args: { start: 2, duration: 4, edge_buffer: 0.1 } }] }), "utf8");
await rm(path.join(root, "outputs/mcp-manifest-edge-buffer.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const ebManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: ebManifestPath },
});
const ebManifestJson = JSON.parse(ebManifestRes.content[0].text);
checkOk(ebManifestJson.steps_run === 1 && ebManifestJson.steps.every((s) => s.status === "ok") && near(ebManifestJson.final.duration_seconds, 4.2, 0.05), "manifest trim step with edge_buffer 0.1 runs and final is 4.2s", JSON.stringify(ebManifestJson.final?.duration_seconds));

// remove_retakes: repeated takes on the word timings — fixture
// test/retakes-words.json plants a 5-word repeat ("we shipped in
// three weeks", restart junk "okay again") plus a 2-word abandoned
// start ("the quick" — "um" — "the quick brown fox") over
// test/source.mp4 (10s). keep=last cuts 10 words to 5.74s;
// keep=first cuts the later takes to 5.76s; a 3-take chain
// (test/retakes-3x-words.json) keeps only the last take (1.98s).
const rtWords = path.join(root, "test/retakes-words.json");
const rtDetectRes = await client.callTool({ name: "remove_retakes", arguments: { input: path.join(root, "test/source.mp4"), words_file: rtWords, detect_only: true } });
const rtDetectJson = JSON.parse(rtDetectRes.content[0].text);
checkOk(rtDetectRes.isError !== true && rtDetectJson.detect_only === true && !("output" in rtDetectJson) && rtDetectJson.clusters.length === 2 && rtDetectJson.removed_count === 10, "remove_retakes detect-only finds 2 clusters, 10 words to cut", JSON.stringify(rtDetectJson.clusters.map((c) => c.removed_text)));
checkOk(JSON.stringify(rtDetectJson.clusters[0].removed_indices) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]) && rtDetectJson.clusters[0].kept_start_index === 7 && rtDetectJson.clusters[0].kept_text === "we shipped in three weeks" && rtDetectJson.clusters[0].repeat_words === 5, "remove_retakes cluster 1: repeat 'we shipped in three weeks', kept take starts at word 7", JSON.stringify(rtDetectJson.clusters[0]));
checkOk(JSON.stringify(rtDetectJson.clusters[1].removed_indices) === JSON.stringify([16, 17, 18]) && rtDetectJson.clusters[1].kept_start_index === 19 && rtDetectJson.clusters[1].repeat_words === 2, "remove_retakes cluster 2: abandoned start 'the quick' + 'um', kept take starts at word 19", JSON.stringify(rtDetectJson.clusters[1]));
checkOk(near(rtDetectJson.removed_seconds, 4.26, 0.05) && JSON.stringify(rtDetectJson.keep_segments) === JSON.stringify([{ start: 2.94, end: 7, duration: 4.06 }, { start: 7.94, end: 9.62, duration: 1.68 }]), "remove_retakes detect-only plans 5.74s kept in 2 segments", JSON.stringify(rtDetectJson.keep_segments));
const rtRes = await client.callTool({ name: "remove_retakes", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-retakes.mp4"), words_file: rtWords } });
const rtJson = JSON.parse(rtRes.content[0].text);
checkOk(rtRes.isError !== true && rtJson.removed_count === 10 && near(rtJson.duration_after, 5.74, 0.05) && JSON.stringify(rtJson.keep_segments) === JSON.stringify([{ start: 2.94, end: 7, duration: 4.06 }, { start: 7.94, end: 9.62, duration: 1.68 }]), "remove_retakes keep=last cuts to 5.74s on disk", JSON.stringify({ removed: rtJson.removed_count, after: rtJson.duration_after }));
const rtFirstRes = await client.callTool({ name: "remove_retakes", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-retakes-first.mp4"), words_file: rtWords, keep: "first" } });
const rtFirstJson = JSON.parse(rtFirstRes.content[0].text);
checkOk(rtFirstRes.isError !== true && rtFirstJson.removed_count === 10 && near(rtFirstJson.duration_after, 5.76, 0.05) && JSON.stringify(rtFirstJson.keep_segments) === JSON.stringify([{ start: 0, end: 2.12, duration: 2.12 }, { start: 5.04, end: 7.7, duration: 2.66 }, { start: 8.64, end: 9.62, duration: 0.98 }]), "remove_retakes keep=first cuts the later takes to 5.76s in 3 segments", JSON.stringify(rtFirstJson.keep_segments));
const rt3xRes = await client.callTool({ name: "remove_retakes", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-retakes-3x.mp4"), words_file: path.join(root, "test/retakes-3x-words.json") } });
const rt3xJson = JSON.parse(rt3xRes.content[0].text);
checkOk(rt3xRes.isError !== true && rt3xJson.clusters.length === 2 && rt3xJson.removed_count === 8 && near(rt3xJson.duration_after, 1.98, 0.05), "remove_retakes 3-take chain keeps only the last take (1.98s)", JSON.stringify(rt3xJson.clusters.map((c) => c.removed_indices)));
const rtNoneRes = await client.callTool({ name: "remove_retakes", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-retakes-none.mp4"), words_file: cwWords } });
const rtNoneJson = JSON.parse(rtNoneRes.content[0].text);
checkOk(rtNoneRes.isError !== true && rtNoneJson.removed_count === 0 && rtNoneJson.stream_copy === true && near(rtNoneJson.duration_after, 10, 0.05), "remove_retakes with no repeat stream-copies unchanged", JSON.stringify(rtNoneJson).slice(0, 200));
const rtBadKeepRes = await client.callTool({ name: "remove_retakes", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-retakes-badkeep.mp4"), words_file: rtWords, keep: "middle" } });
checkOk(rtBadKeepRes.isError === true && /keep/.test(rtBadKeepRes.content[0].text), "remove_retakes refuses keep='middle'", rtBadKeepRes.content[0].text.slice(0, 200));
// remove_retakes through the CLI: --detect-only needs no -o.
const rtCliDetect = await runCli(["remove-retakes", path.join(root, "test/source.mp4"), "--words-file", path.join(root, "test/retakes-words.json"), "--detect-only"]);
checkOk(rtCliDetect.code === 0 && /"detect_only": true/.test(rtCliDetect.out) && /"removed_count": 10/.test(rtCliDetect.out), "CLI remove-retakes --detect-only needs no -o and reports 10 words", rtCliDetect.out.slice(0, 200));

// smart_cut: tighten a take on the transcript — fixture
// test/smartcut-words.json is 10 words (0-7.5s): a 0.9s gap, a
// 0.45s "um", a 1.1s stretched "so", a 0.8s gap, and a short 0.1s
// "um" that must survive. Defaults cut 3.05s, keep 6.95s.
const scWords = path.join(root, "test/smartcut-words.json");
const scDetectRes = await client.callTool({ name: "smart_cut", arguments: { input: path.join(root, "test/source.mp4"), words_file: scWords, detect_only: true } });
const scDetectJson = JSON.parse(scDetectRes.content[0].text);
console.log("smart_cut detect-only:", JSON.stringify(scDetectJson.removed.map((r) => `${r.reason}@${r.start}-${r.end}`)), "| keep", JSON.stringify(scDetectJson.keep_segments));
checkOk(scDetectRes.isError !== true && scDetectJson.detect_only === true && !("output" in scDetectJson) && scDetectJson.removed_count === 4 && near(scDetectJson.removed_seconds, 3.05, 0.01) && JSON.stringify(scDetectJson.removed.map((r) => r.reason)) === JSON.stringify(["gap", "filler", "stretched", "gap"]) && JSON.stringify(scDetectJson.thresholds) === JSON.stringify({ gap_threshold: 0.405, filler_min_duration: 0.275, stretch_min_duration: 0.75, contextual_pause_seconds: 0.15, contextual_gate: true, min_segment: 0 }) && JSON.stringify(scDetectJson.keep_segments) === JSON.stringify([{ start: 0, end: 0.45, duration: 0.45 }, { start: 1.75, end: 2.65, duration: 0.9 }, { start: 3.7, end: 5.25, duration: 1.55 }, { start: 5.95, end: 10, duration: 4.05 }]) && scDetectJson.cut_check.swallowed.length === 0, "smart_cut detect-only finds gap + long um + stretched so + gap (3.05s) and spares the 0.1s um", JSON.stringify(scDetectJson.removed.map((r) => `${r.reason}:${r.text}`)));
const scRes = await client.callTool({ name: "smart_cut", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-smartcut.mp4"), words_file: scWords } });
const scJson = JSON.parse(scRes.content[0].text);
checkOk(scRes.isError !== true && scJson.removed_count === 4 && near(scJson.duration_after, 6.95, 0.05) && JSON.stringify(scJson.keep_segments) === JSON.stringify([{ start: 0, end: 0.45, duration: 0.45 }, { start: 1.75, end: 2.65, duration: 0.9 }, { start: 3.7, end: 5.25, duration: 1.55 }, { start: 5.95, end: 10, duration: 4.05 }]), "smart_cut cuts to 6.95s on disk", JSON.stringify({ removed: scJson.removed_count, after: scJson.duration_after }));
const scGapRes = await client.callTool({ name: "smart_cut", arguments: { input: path.join(root, "test/source.mp4"), words_file: scWords, min_gap: 1, detect_only: true } });
const scGapJson = JSON.parse(scGapRes.content[0].text);
checkOk(scGapRes.isError !== true && scGapJson.removed_count === 3 && near(scGapJson.removed_seconds, 2.35, 0.01) && JSON.stringify(scGapJson.keep_segments) === JSON.stringify([{ start: 0, end: 0.45, duration: 0.45 }, { start: 1.75, end: 2.65, duration: 0.9 }, { start: 3.7, end: 10, duration: 6.3 }]), "smart_cut min_gap 1.0 keeps the 0.8s gap (7.65s kept)", JSON.stringify(scGapJson.keep_segments));
const scNoneRes = await client.callTool({ name: "smart_cut", arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-smartcut-none.mp4"), words_file: path.join(root, "test/smartcut-clean-words.json") } });
const scNoneJson = JSON.parse(scNoneRes.content[0].text);
checkOk(scNoneRes.isError !== true && scNoneJson.removed_count === 0 && scNoneJson.stream_copy === true && near(scNoneJson.duration_after, 10, 0.05), "smart_cut with nothing to cut stream-copies unchanged", JSON.stringify(scNoneJson).slice(0, 200));
const scBadAggRes = await client.callTool({ name: "smart_cut", arguments: { input: path.join(root, "test/source.mp4"), words_file: scWords, aggressiveness: 2 } });
checkOk(scBadAggRes.isError === true && /aggressiveness/.test(scBadAggRes.content[0].text), "smart_cut refuses aggressiveness above 1", scBadAggRes.content[0].text.slice(0, 200));
// smart_cut through the CLI: --detect-only needs no -o; --dry-run prints the command.
const scCliDetect = await runCli(["smart-cut", path.join(root, "test/source.mp4"), "--words-file", path.join(root, "test/smartcut-words.json"), "--detect-only"]);
checkOk(scCliDetect.code === 0 && /"detect_only": true/.test(scCliDetect.out) && /"removed_count": 4/.test(scCliDetect.out), "CLI smart-cut --detect-only needs no -o and reports 4 removals", scCliDetect.out.slice(0, 200));
const scCliDry = await runCli(["smart-cut", path.join(root, "test/source.mp4"), "--words-file", path.join(root, "test/smartcut-words.json"), "-o", path.join(root, "outputs/mcp-smartcut-dry.mp4"), "--dry-run"]);
checkOk(scCliDry.code === 0 && /"dry_run": true/.test(scCliDry.out) && /ffmpeg/.test(scCliDry.out), "CLI smart-cut --dry-run prints the ffmpeg command and writes no file", scCliDry.out.slice(0, 200));
// smart_cut with the new knobs (lượt 130): the context fixture
// cuts 3 with the gate on (2 gated survivors), 5 with the gate off;
// --min-segment 2 collapses the repo fixture to 1 removal.
const scCtxFile = path.join(root, "test/smartcut-context-words.json");
const scCtxRes = await client.callTool({ name: "smart_cut", arguments: { input: path.join(root, "test/source.mp4"), words_file: scCtxFile, detect_only: true } });
const scCtxJson = JSON.parse(scCtxRes.content[0].text);
checkOk(scCtxRes.isError !== true && scCtxJson.removed_count === 3 && scCtxJson.gated_fillers.length === 2 && JSON.stringify(scCtxJson.gated_fillers.map((g) => g.text)) === JSON.stringify(["like", "basically"]) && scCtxJson.thresholds.contextual_gate === true, "smart_cut detect-only on the context fixture cuts 3 and lists 2 gated survivors", JSON.stringify(scCtxJson.gated_fillers));
const scCtxOffRes = await client.callTool({ name: "smart_cut", arguments: { input: path.join(root, "test/source.mp4"), words_file: scCtxFile, contextual_gate: false, detect_only: true } });
const scCtxOffJson = JSON.parse(scCtxOffRes.content[0].text);
checkOk(scCtxOffRes.isError !== true && scCtxOffJson.removed_count === 5 && scCtxOffJson.gated_fillers.length === 0, "smart_cut contextual_gate false cuts all 5 long contextual fillers", JSON.stringify(scCtxOffJson.removed.map((r) => r.text)));
const scCliNoGate = await runCli(["smart-cut", path.join(root, "test/source.mp4"), "--words-file", scCtxFile, "--detect-only", "--no-contextual-gate"]);
checkOk(scCliNoGate.code === 0 && /"removed_count": 5/.test(scCliNoGate.out), "CLI smart-cut --no-contextual-gate reports 5 removals", scCliNoGate.out.slice(0, 200));
const scCliSeg = await runCli(["smart-cut", path.join(root, "test/source.mp4"), "--words-file", path.join(root, "test/smartcut-words.json"), "--detect-only", "--min-segment", "2"]);
checkOk(scCliSeg.code === 0 && /"removed_count": 1/.test(scCliSeg.out) && /"min_segment_merges": 3/.test(scCliSeg.out), "CLI smart-cut --min-segment 2 collapses the fixture to 1 removal (3 merges)", scCliSeg.out.slice(0, 200));

// search_words: search-first editing on the transcript — fixture
// test/search-words.json is 14 words: "the quick brown fox jumps
// over the lazy dog the quick brown fox again" (word times 0-7.4s).
// "quick brown fox" is said twice; "lazy dog" once.
const swWords = path.join(root, "test/search-words.json");
const swRes = await client.callTool({ name: "search_words", arguments: { words_file: swWords, query: "quick brown fox" } });
const swJson = JSON.parse(swRes.content[0].text);
console.log("search_words:", JSON.stringify(swJson.matches.map((m) => `${m.start}-${m.end}`)), "| cut_list", JSON.stringify(swJson.cut_list));
checkOk(swRes.isError !== true && swJson.match_count === 2 && swJson.returned_matches === 2 && swJson.truncated === false && swJson.phrase === "quick brown fox" && swJson.total_words === 14, "search_words finds 'quick brown fox' twice in 14 words", JSON.stringify({ match_count: swJson.match_count, phrase: swJson.phrase }));
checkOk(JSON.stringify(swJson.matches.map((m) => [m.word_start_index, m.word_end_index, m.start, m.end])) === JSON.stringify([[1, 3, 0.5, 1.8], [10, 12, 5.5, 6.8]]) && swJson.matches[0].text === "quick brown fox" && swJson.matches[0].context_before === "the" && swJson.matches[0].context_after === "jumps over the lazy dog" && swJson.matches[1].context_after === "again", "search_words matches carry word indices, times, text + 5-word context each side", JSON.stringify(swJson.matches.map((m) => m.context_after)));
checkOk(JSON.stringify(swJson.matches.map((m) => m.window)) === JSON.stringify([{ start: 0, end: 2.3, duration: 2.3 }, { start: 5, end: 7.3, duration: 2.3 }]) && JSON.stringify(swJson.cut_list) === JSON.stringify([{ start: 0, end: 2.3, duration: 2.3 }, { start: 5, end: 7.3, duration: 2.3 }]), "search_words cut windows are the match ±0.5s (clamped at 0) and cut_list is the same two windows", JSON.stringify(swJson.cut_list));
const swCaseRes = await client.callTool({ name: "search_words", arguments: { words_file: swWords, query: "QUICK, brown FOX" } });
const swCaseJson = JSON.parse(swCaseRes.content[0].text);
checkOk(swCaseRes.isError !== true && swCaseJson.match_count === 2 && JSON.stringify(swCaseJson.matches.map((m) => m.start)) === JSON.stringify([0.5, 5.5]), "search_words matching is case-insensitive and punctuation-ignored ('QUICK, brown FOX' = 'quick brown fox')", JSON.stringify(swCaseJson.matches.map((m) => m.start)));
const swPadRes = await client.callTool({ name: "search_words", arguments: { words_file: swWords, query: "lazy dog", pad_before: 1, pad_after: 1 } });
const swPadJson = JSON.parse(swPadRes.content[0].text);
checkOk(swPadRes.isError !== true && swPadJson.match_count === 1 && JSON.stringify(swPadJson.matches[0].window) === JSON.stringify({ start: 2.4, end: 5.1, duration: 2.7 }), "search_words --pad-before/after 1 widens the 'lazy dog' window to 2.4-5.1", JSON.stringify(swPadJson.matches[0].window));
const swNoneRes = await client.callTool({ name: "search_words", arguments: { words_file: swWords, query: "not here" } });
const swNoneJson = JSON.parse(swNoneRes.content[0].text);
checkOk(swNoneRes.isError !== true && swNoneJson.match_count === 0 && swNoneJson.returned_matches === 0 && swNoneJson.matches.length === 0 && swNoneJson.cut_list.length === 0, "search_words with no hit returns 0 matches and an empty cut_list (not an error)", JSON.stringify(swNoneJson));
const swCapRes = await client.callTool({ name: "search_words", arguments: { words_file: swWords, query: "quick brown fox", max_matches: 1 } });
const swCapJson = JSON.parse(swCapRes.content[0].text);
checkOk(swCapRes.isError !== true && swCapJson.match_count === 2 && swCapJson.returned_matches === 1 && swCapJson.truncated === true && swCapJson.matches[0].start === 0.5, "search_words --max-matches 1 returns the first hit, truncated=true, match_count still 2", JSON.stringify({ returned: swCapJson.returned_matches, truncated: swCapJson.truncated }));
// Overlapping windows merge in cut_list: "the" ×3 with 1s pads
// gives [0,1.4] + [2.0,4.3] + [4.0,6.4] → the last two merge.
const swMergeRes = await client.callTool({ name: "search_words", arguments: { words_file: swWords, query: "the", pad_before: 1, pad_after: 1 } });
const swMergeJson = JSON.parse(swMergeRes.content[0].text);
checkOk(swMergeRes.isError !== true && swMergeJson.match_count === 3 && JSON.stringify(swMergeJson.cut_list) === JSON.stringify([{ start: 0, end: 1.4, duration: 1.4 }, { start: 2, end: 6.4, duration: 4.4 }]), "search_words cut_list merges overlapping windows ([2.0,4.3]+[4.0,6.4] → [2.0,6.4])", JSON.stringify(swMergeJson.cut_list));
// findPhraseMatches is pure: a 2-word phrase inside "ha ha ha"
// matches once (non-overlapping scan), a 1-word phrase 3 times.
const haWords = [0, 1, 2].map((i) => ({ start: i, end: i + 0.5, word: "ha" }));
checkOk(JSON.stringify(findPhraseMatches(haWords, ["ha", "ha"])) === JSON.stringify([{ word_start_index: 0, word_end_index: 1 }]) && findPhraseMatches(haWords, ["ha"]).length === 3 && findPhraseMatches(haWords, ["ha", "ha", "ha", "ha"]).length === 0, "findPhraseMatches: 'ha ha' in 'ha ha ha' matches once at 0, 'ha' 3 times, 4-word phrase never", JSON.stringify(findPhraseMatches(haWords, ["ha", "ha"])));
// planSmartCuts is pure: thresholds + reasons on the smart_cut
// fixture words (same times as test/smartcut-words.json) — a 0.9s
// gap, a 0.45s "um", a 1.1s stretched "so", a 0.8s gap, and a short
// 0.1s "um" that must survive the duration gate.
const scUnitWords = [
  { start: 0, end: 0.4, word: "hello" }, { start: 1.3, end: 1.75, word: "um" },
  { start: 2, end: 2.4, word: "world" }, { start: 2.6, end: 3.7, word: "so" },
  { start: 4, end: 4.3, word: "we" }, { start: 4.4, end: 4.7, word: "are" },
  { start: 4.8, end: 5.2, word: "here" }, { start: 6, end: 6.4, word: "now" },
  { start: 6.6, end: 6.7, word: "um" }, { start: 7, end: 7.5, word: "done" },
];
const scPlan = planSmartCuts(scUnitWords, 10);
checkOk(JSON.stringify(scPlan.thresholds) === JSON.stringify({ gap_threshold: 0.405, filler_min_duration: 0.275, stretch_min_duration: 0.75, contextual_pause_seconds: 0.15, contextual_gate: true, min_segment: 0 }) && scPlan.removed_count === 4 && JSON.stringify(scPlan.removed.map((r) => r.reason)) === JSON.stringify(["gap", "filler", "stretched", "gap"]) && JSON.stringify(scPlan.removed) === JSON.stringify([{ start: 0.45, end: 1.25, duration: 0.8, reason: "gap", text: "" }, { start: 1.3, end: 1.75, duration: 0.45, reason: "filler", text: "um" }, { start: 2.65, end: 3.7, duration: 1.05, reason: "stretched", text: "so" }, { start: 5.25, end: 5.95, duration: 0.7, reason: "gap", text: "" }]) && JSON.stringify(scPlan.keep) === JSON.stringify([{ start: 0, end: 0.45, duration: 0.45 }, { start: 1.75, end: 2.65, duration: 0.9 }, { start: 3.7, end: 5.25, duration: 1.55 }, { start: 5.95, end: 10, duration: 4.05 }]) && scPlan.swallowed.length === 0, "planSmartCuts: 0.9s gap + 0.45s um + stretched so + 0.8s gap cut (3.05s), short 0.1s um survives, 6.95s kept in 4 segments", JSON.stringify(scPlan.removed.map((r) => r.reason)));
const scPlanAgg0 = planSmartCuts(scUnitWords, 10, { aggressiveness: 0 });
checkOk(JSON.stringify(scPlanAgg0.thresholds) === JSON.stringify({ gap_threshold: 0.54, filler_min_duration: 0.35, stretch_min_duration: 0.9, contextual_pause_seconds: 0.15, contextual_gate: true, min_segment: 0 }) && scPlanAgg0.removed_count === 4, "planSmartCuts aggressiveness 0 is gentle (gap x1.2, filler >= 0.35s, stretch >= 0.9s) and still cuts the same 4", JSON.stringify(scPlanAgg0.thresholds));
const scPlanAgg1 = planSmartCuts(scUnitWords, 10, { aggressiveness: 1 });
checkOk(JSON.stringify(scPlanAgg1.thresholds) === JSON.stringify({ gap_threshold: 0.27, filler_min_duration: 0.2, stretch_min_duration: 0.6, contextual_pause_seconds: 0.15, contextual_gate: true, min_segment: 0 }) && scPlanAgg1.removed_count === 6 && !scPlanAgg1.removed.some((r) => r.reason === "filler" && r.text === "um" && r.start === 6.6) && near(scPlanAgg1.keep.reduce((s, k) => s + k.duration, 0), 6.5, 0.01), "planSmartCuts aggressiveness 1 is tight (gap x0.6, filler >= 0.2s, stretch >= 0.6s): 6 removals (the two 0.3s gaps clear 0.27 too) but the 0.1s um is still spared as a filler — 6.5s kept", JSON.stringify(scPlanAgg1.removed.map((r) => `${r.reason}@${r.start}`)));
const scPlanGap = planSmartCuts(scUnitWords, 10, { minGap: 1 });
checkOk(scPlanGap.removed_count === 3 && near(scPlanGap.keep.reduce((s, k) => s + k.duration, 0), 7.65, 0.01) && JSON.stringify(scPlanGap.keep) === JSON.stringify([{ start: 0, end: 0.45, duration: 0.45 }, { start: 1.75, end: 2.65, duration: 0.9 }, { start: 3.7, end: 10, duration: 6.3 }]), "planSmartCuts min_gap 1.0 keeps the 0.8s gap (threshold 0.9) but still cuts the 0.9s one — 7.65s kept", JSON.stringify(scPlanGap.keep));
// Phrase matching really matches phrases: VidMCP lists "you know"
// but checks per single token, so it can never match — here the
// two tokens together are one 0.9s filler removal.
const scPhraseWords = [{ start: 0, end: 0.3, word: "you" }, { start: 0.3, end: 0.9, word: "know" }, { start: 1.2, end: 1.6, word: "ok" }];
const scPhrasePlan = planSmartCuts(scPhraseWords, 2);
checkOk(scPhrasePlan.removed_count === 1 && scPhrasePlan.removed[0].reason === "filler" && scPhrasePlan.removed[0].text === "you know" && JSON.stringify(scPhrasePlan.keep) === JSON.stringify([{ start: 0.9, end: 2, duration: 1.1 }]), "planSmartCuts matches the phrase 'you know' across two tokens as one filler removal", JSON.stringify(scPhrasePlan.removed));
// Contextual filler gate (lượt 130, OpenEdit's rule): a long
// "like"/"you know"/"basically"/"actually" is only cut when flanked
// by >= 0.15s pauses on both sides or at the transcript edge.
// Fixture: "well like this like you know ok basically like" — the
// first "like" (0.05s flanks) and "basically" (0.05s before) survive
// and are listed in gated_fillers; the flanked "like", the flanked
// "you know" and the last-word "like" are cut.
const scCtxWords = [
  { start: 0, end: 0.3, word: "well" }, { start: 0.35, end: 0.95, word: "like" },
  { start: 1.0, end: 1.3, word: "this" }, { start: 1.6, end: 2.2, word: "like" },
  { start: 2.5, end: 2.8, word: "you" }, { start: 2.8, end: 3.2, word: "know" },
  { start: 3.5, end: 3.9, word: "ok" }, { start: 3.95, end: 4.55, word: "basically" },
  { start: 4.85, end: 5.45, word: "like" },
];
const scCtxPlan = planSmartCuts(scCtxWords, 6);
checkOk(scCtxPlan.removed_count === 3 && JSON.stringify(scCtxPlan.removed.map((r) => `${r.reason}:${r.text}@${r.start}`)) === JSON.stringify(["filler:like@1.6", "filler:you know@2.5", "filler:like@4.85"]) && JSON.stringify(scCtxPlan.gated_fillers.map((g) => g.text)) === JSON.stringify(["like", "basically"]) && JSON.stringify(scCtxPlan.keep) === JSON.stringify([{ start: 0, end: 1.6, duration: 1.6 }, { start: 2.2, end: 2.5, duration: 0.3 }, { start: 3.2, end: 4.85, duration: 1.65 }, { start: 5.45, end: 6, duration: 0.55 }]), "planSmartCuts context gate: flanked 'like' + 'you know' + edge 'like' cut, unflanked 'like' and one-sided 'basically' survive in gated_fillers", JSON.stringify(scCtxPlan.removed.map((r) => r.text)));
const scCtxOffPlan = planSmartCuts(scCtxWords, 6, { contextualGate: false });
checkOk(scCtxOffPlan.removed_count === 5 && scCtxOffPlan.gated_fillers.length === 0 && scCtxOffPlan.thresholds.contextual_gate === false, "planSmartCuts contextual_gate false restores duration-only cutting (all 5 long contextual fillers cut)", JSON.stringify(scCtxOffPlan.removed.map((r) => r.text)));
// min_segment merge (lượt 130, OpenEdit's min_segment_s): removals
// separated by less than min_segment seconds of kept speech merge
// into one cut. On the repo fixture min_segment 2 collapses all
// four removals into one [0.45, 5.95] "mixed" cut — that is why the
// default stays 0 (off): it would delete "world we are here".
const scSegPlan = planSmartCuts(scUnitWords, 10, { minSegment: 2 });
checkOk(scSegPlan.removed_count === 1 && JSON.stringify(scSegPlan.removed) === JSON.stringify([{ start: 0.45, end: 5.95, duration: 5.5, reason: "mixed", text: "um so" }]) && scSegPlan.min_segment_merges === 3 && JSON.stringify(scSegPlan.keep) === JSON.stringify([{ start: 0, end: 0.45, duration: 0.45 }, { start: 5.95, end: 10, duration: 4.05 }]) && scSegPlan.thresholds.min_segment === 2, "planSmartCuts min_segment 2 merges the fixture's 4 removals into one [0.45,5.95] cut (3 merges) — the reason the default is off", JSON.stringify(scSegPlan.removed));
const scTwoGapWords = [
  { start: 0, end: 0.3, word: "one" }, { start: 1.2, end: 1.5, word: "two" },
  { start: 2.5, end: 2.8, word: "three" }, { start: 3.7, end: 4.0, word: "four" },
];
const scTwoGapPlan = planSmartCuts(scTwoGapWords, 5, { minSegment: 2 });
checkOk(scTwoGapPlan.removed_count === 1 && JSON.stringify(scTwoGapPlan.removed) === JSON.stringify([{ start: 0.35, end: 3.65, duration: 3.3, reason: "gap", text: "" }]) && scTwoGapPlan.min_segment_merges === 2, "planSmartCuts min_segment 2 merges three gaps separated by 0.3s words into one cut", JSON.stringify(scTwoGapPlan.removed));

// clean_voice pure functions (lượt 131, Takes' diagnose/plan
// ported to Node): clipped runs, the plan thresholds, the step
// parser, the densest window and the sync cross-correlation.
// Synthetic 3 s take: two 0.5 s 440 Hz bursts (amp 0.5) with 0.5 s
// gaps, plus deterministic white noise so the speech spectrum is
// flat (a pure tone breaks the bandwidth percentile: the 200-4000 Hz
// band is almost all empty bins, so p90 lands on the floor and every
// bin passes the ref-50 test — the same quirk Takes' code has).
const cvSamples = new Float32Array(48000 * 3);
const cvHash = (i) => { const v = Math.sin(i * 12.9898) * 43758.5453; return v - Math.floor(v); };
for (let w = 0; w < 2; w++) {
  const start = Math.round((0.5 + w * 1.5) * 48000);
  for (let i = 0; i < 24000; i++) cvSamples[start + i] = (Math.sin(2 * Math.PI * 440 * (i / 48000)) * 0.5 + (cvHash(start + i) - 0.5) * 0.3) * Math.min(1, i / 2400);
}
const cvDiag = diagnoseVoice(cvSamples);
checkOk(cvDiag.clipped_runs === 0 && cvDiag.speech_frames > 0 && cvDiag.echo_tail_db !== null && cvDiag.echo_tail_db < -24 && cvDiag.bandwidth_hz > 15000 && cvDiag.words_measured === 2, "diagnoseVoice on two noisy 440 Hz bursts: no clipping, speech found, echo tail below -24 dB, broadband bandwidth, 2 word offsets", JSON.stringify(cvDiag));
const cvPlanTone = planCleanVoice(cvDiag);
checkOk(JSON.stringify(cvPlanTone.steps) === JSON.stringify([]) && cvPlanTone.unavailable.length === 0 && JSON.stringify(cvPlanTone.runnable_steps) === JSON.stringify([]), "planCleanVoice on the clean synthetic take: chain only, nothing unavailable", JSON.stringify(cvPlanTone));
const cvBadDiag = { clipped_runs: 25, hum_db: 20, hum_hz: 50, echo_tail_db: -10, snr_db: 40, bandwidth_hz: 8000 };
const cvPlanBad = planCleanVoice(cvBadDiag);
checkOk(JSON.stringify(cvPlanBad.steps) === JSON.stringify(["declip", "dehum", "clearvoice", "sr"]) && JSON.stringify(cvPlanBad.unavailable.map((u) => u.step)) === JSON.stringify(["clearvoice", "sr"]) && JSON.stringify(cvPlanBad.runnable_steps) === JSON.stringify(["declip", "dehum"]), "planCleanVoice thresholds: 25 clipped runs + 20 dB hum + echo -10 dB + SNR 40 + bw 8 kHz plans all four steps in order, clearvoice/sr unavailable", JSON.stringify(cvPlanBad.steps));
const cvCleanDiag = { clipped_runs: 0, hum_db: 2, hum_hz: 50, echo_tail_db: -45, snr_db: 70, bandwidth_hz: 20000 };
checkOk(JSON.stringify(planCleanVoice(cvCleanDiag).steps) === JSON.stringify([]) && planCleanVoice(cvCleanDiag).why[0] === "clean recording: chain only", "planCleanVoice on a clean diagnosis plans chain only", JSON.stringify(planCleanVoice(cvCleanDiag)));
const cvPhoneDiag = { clipped_runs: 0, hum_db: null, hum_hz: 50, echo_tail_db: -45, snr_db: 70, bandwidth_hz: 4000 };
checkOk(JSON.stringify(planCleanVoice(cvPhoneDiag).steps) === JSON.stringify(["sr"]) && planCleanVoice(cvPhoneDiag).why.some((w) => /PHONE-BAND/.test(w)), "planCleanVoice: unmeasurable hum (null) skips dehum, phone-band bandwidth adds the warning", JSON.stringify(planCleanVoice(cvPhoneDiag).why));
checkOk(JSON.stringify(parseCleanVoiceSteps("declip,dehum")) === JSON.stringify(["declip", "dehum"]) && JSON.stringify(parseCleanVoiceSteps("none")) === JSON.stringify([]) && parseCleanVoiceSteps(null) === null, "parseCleanVoiceSteps: comma list, 'none' -> [], null passes through", "");
let cvBadSteps = "";
try { parseCleanVoiceSteps("declip,bogus"); } catch (e) { cvBadSteps = e.message; }
checkOk(/unknown step "bogus"/.test(cvBadSteps), "parseCleanVoiceSteps refuses an unknown step name instead of silently dropping it", cvBadSteps.slice(0, 120));
// Clipped runs are 3+ IDENTICAL samples at the file's peak — a
// limiter never makes those, so a flat top counts and a loud
// peak that never repeats does not.
const cvClipArr = new Float32Array([0.1, 0.5, 0.99, 0.99, 0.99, 0.2, 0.99, 0.1]);
checkOk(countClippedRuns(cvClipArr) === 1, "countClippedRuns: one run of 3 identical peak samples counts once", `got ${countClippedRuns(cvClipArr)}`);
const cvNoClipArr = new Float32Array([0.1, 0.5, 0.99, 0.98, 0.99, 0.2]);
checkOk(countClippedRuns(cvNoClipArr) === 0, "countClippedRuns: a loud peak that never repeats is not clipping", `got ${countClippedRuns(cvNoClipArr)}`);
// Densest window: 30 s envelope, speech only at 15-25 s — the
// 12 s window starting at 15 s holds the most speech.
const cvEnv = new Float64Array(3000).fill(-80);
for (let i = 1500; i < 2500; i++) cvEnv[i] = -10;
const cvWin = findDensestSpeechWindow(cvEnv);
checkOk(cvWin.start >= 13 && cvWin.start <= 15 && near(cvWin.end - cvWin.start, 12, 0.01), "findDensestSpeechWindow finds a 12 s window holding all the speech (15-25 s) — the first max starts at 13 s, any start in 13-15 s holds it all", JSON.stringify(cvWin));
// Sync: identical signals correlate at 0; a 10 ms delay reads
// as 10 ms of drift (sign follows Takes' convention).
const cvSyncA = new Float32Array(48000);
for (let i = 0; i < 48000; i++) cvSyncA[i] = Math.sin(2 * Math.PI * 220 * (i / 48000)) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * (i / 48000)));
const cvSyncB = new Float32Array(48000);
cvSyncB.set(cvSyncA.subarray(0, 48000 - 480), 480);
checkOk(voiceSyncMs(cvSyncA, cvSyncA) === 0 && Math.abs(voiceSyncMs(cvSyncA, cvSyncB)) === 10, "voiceSyncMs: identical signals sync 0 ms, a 480-sample (10 ms) delay reads 10 ms", `same=${voiceSyncMs(cvSyncA, cvSyncA)} delayed=${voiceSyncMs(cvSyncA, cvSyncB)}`);
checkOk(voiceEnvelopeDb(cvSamples).length === 300 && voiceEnvelopeDb(cvSamples)[25] < -100, "voiceEnvelopeDb: 3 s at 48 kHz is 300 10 ms frames, and a gap frame sits below -100 dB", `len=${voiceEnvelopeDb(cvSamples).length}`);
let scBadSeg = false;
try { planSmartCuts(scUnitWords, 10, { minSegment: 6 }); } catch { scBadSeg = true; }
checkOk(scBadSeg, "planSmartCuts refuses min_segment above 5", "no throw");
checkOk(JSON.stringify(parseSmartCutFillers("um,uh,you know")) === JSON.stringify([["um"], ["uh"], ["you", "know"]]) && JSON.stringify(parseSmartCutFillers(null).slice(0, 3)) === JSON.stringify([["um"], ["umm"], ["uh"]]), "parseSmartCutFillers splits a comma string into phrases and defaults to the built-in list", JSON.stringify(parseSmartCutFillers("um,uh,you know")));
let scBadAgg = false;
try { planSmartCuts(scUnitWords, 10, { aggressiveness: 1.5 }); } catch { scBadAgg = true; }
checkOk(scBadAgg, "planSmartCuts refuses aggressiveness above 1", "no throw");
// Validation: empty query, missing words file, a JSON file with no
// words array (test/cues.json is a bare cues array).
const swEmptyRes = await client.callTool({ name: "search_words", arguments: { words_file: swWords, query: "" } });
checkOk(swEmptyRes.isError === true, "search_words refuses an empty query", swEmptyRes.content[0].text.slice(0, 200));
const swMissingRes = await client.callTool({ name: "search_words", arguments: { words_file: path.join(root, "test/no-such-words.json"), query: "fox" } });
const swMissingJson = JSON.parse(swMissingRes.content[0].text);
checkOk(swMissingRes.isError === true && /words file not found/.test(swMissingJson.error ?? ""), "search_words refuses a missing words file", JSON.stringify(swMissingJson));
const swBadFileRes = await client.callTool({ name: "search_words", arguments: { words_file: path.join(root, "test/search-words-bad.json"), query: "fox" } });
const swBadFileJson = JSON.parse(swBadFileRes.content[0].text);
checkOk(swBadFileRes.isError === true && /search_words words file must be/.test(swBadFileJson.error ?? ""), "search_words refuses a JSON file with no words array, naming itself in the error", JSON.stringify(swBadFileJson));
// search_words through the CLI: no -o (probe-only); missing --query refuses.
const swCli = await runCli(["search-words", "--words-file", path.join(root, "test/search-words.json"), "--query", "quick brown fox"]);
checkOk(swCli.code === 0 && /"match_count": 2/.test(swCli.out), "CLI search-words needs no -o and reports 2 matches", swCli.out.slice(0, 200));
const swCliNoQuery = await runCli(["search-words", "--words-file", path.join(root, "test/search-words.json")]);
checkOk(swCliNoQuery.code !== 0 && /--query/.test(swCliNoQuery.out), "CLI search-words without --query refuses", swCliNoQuery.out.slice(0, 200));

// search_words in batch + manifest (lượt 123): probe-only like
// hook — no file is written, the matches + cut_list come back in
// the row's / step's result; a clip with no words file fails its
// own row only. The manifest step records WHY the next trim cuts
// where it does, then trim cuts the first window (0-2.3s).
await rm(path.join(root, "outputs/mcp-batch-sw-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-sw-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-sw-in"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-sw-in/source.mp4"));
await copyFile(path.join(root, "test/search-words.json"), path.join(root, "outputs/mcp-batch-sw-in/source.words.json"));
await copyFile(path.join(root, "test/hook-source.mp4"), path.join(root, "outputs/mcp-batch-sw-in/hook-source.mp4"));
const swBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "search_words", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-sw-in"), output_dir: path.join(root, "outputs/mcp-batch-sw-out"), args: { query: "quick brown fox" }, jobs: 2 },
});
const swBatchJson = JSON.parse(swBatchRes.content[0].text);
console.log("batch search_words:", JSON.stringify(swBatchJson.results.map((r) => ({ status: r.status, output: r.output, matches: r.result?.match_count }))), "| suffix", swBatchJson.output_suffix);
const swBatchRow = (name) => swBatchJson.results.find((r) => r.input.endsWith(`/${name}`));
checkOk(swBatchJson.succeeded === 1 && swBatchJson.failed === 1 && swBatchJson.output_suffix === null && swBatchRow("source.mp4").status === "ok" && swBatchRow("source.mp4").output === null && swBatchRow("source.mp4").result.match_count === 2 && swBatchRow("hook-source.mp4").status === "error", "batch search_words: 1 ok (2 matches, output null, suffix null) + 1 error row for the clip with no words file", JSON.stringify(swBatchJson.results.map((r) => r.status)));
const swBatchCacheRes = await client.callTool({
  name: "batch",
  arguments: { operation: "search_words", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-sw-in"), output_dir: path.join(root, "outputs/mcp-batch-sw-out"), args: { query: "quick brown fox" }, jobs: 2 },
});
const swBatchCacheJson = JSON.parse(swBatchCacheRes.content[0].text);
checkOk(swBatchCacheJson.cached === 1 && swBatchCacheJson.failed === 1 && swBatchCacheJson.succeeded === 0 && swBatchCacheJson.results.find((r) => r.input.endsWith("/source.mp4")).status === "cached", "batch search_words second run serves the ok row from the result cache (the failed row re-runs, it is not cached)", JSON.stringify(swBatchCacheJson.results.map((r) => r.status)));
const swBatchDryRes = await client.callTool({
  name: "batch",
  arguments: { operation: "search_words", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-sw-in"), output_dir: path.join(root, "outputs/mcp-batch-sw-out"), args: { query: "quick brown fox" }, dry_run: true },
});
const swBatchDryJson = JSON.parse(swBatchDryRes.content[0].text);
checkOk(swBatchDryJson.dry_run === true && swBatchDryJson.results.every((r) => r.status === "planned" && r.output === null), "batch search_words dry-run plans with null outputs and writes nothing", JSON.stringify(swBatchDryJson.results.map((r) => r.output)));
await rm(path.join(root, "outputs/mcp-manifest-search-words.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const swManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-search-words.json") },
});
const swManifestJson = JSON.parse(swManifestRes.content[0].text);
console.log("manifest search_words:", JSON.stringify(swManifestJson.steps.map((s) => ({ tool: s.tool, status: s.status, output: s.output, matches: s.result?.match_count }))), "| final", swManifestJson.final?.duration_seconds);
checkOk(swManifestJson.steps_run === 2 && swManifestJson.steps.every((s) => s.status === "ok") && swManifestJson.steps[0].tool === "search_words" && swManifestJson.steps[0].result.match_count === 2 && JSON.stringify(swManifestJson.steps[0].result.cut_list) === JSON.stringify([{ start: 0, end: 2.3, duration: 2.3 }, { start: 5, end: 7.3, duration: 2.3 }]) && near(swManifestJson.final.duration_seconds, 2.3, 0.05), "manifest search_words step records 2 matches + cut_list, then trim cuts the first window (final 2.3s)", JSON.stringify(swManifestJson.steps.map((s) => s.result?.match_count ?? s.result?.duration_seconds)));
checkOk(swManifestJson.steps[0].output === swManifestJson.input && swManifestJson.steps[1].output !== swManifestJson.steps[0].output, "manifest search_words step passes the chain file through (its output is the input it analyzed)", swManifestJson.steps[0].output);
const swManifestCacheRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-search-words.json") },
});
const swManifestCacheJson = JSON.parse(swManifestCacheRes.content[0].text);
checkOk(swManifestCacheJson.cache_hits === 2 && swManifestCacheJson.steps.every((s) => s.status === "cached") && swManifestCacheJson.steps[0].result.match_count === 2, "manifest search_words re-run serves both steps from cache (search result cached, trim file cached)", JSON.stringify(swManifestCacheJson.steps.map((s) => s.status)));
const swManifestDryRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-search-words.json"), dry_run: true },
});
const swManifestDryJson = JSON.parse(swManifestDryRes.content[0].text);
checkOk(swManifestDryJson.dry_run === true && swManifestDryJson.steps[0].output === swManifestDryJson.input && swManifestDryJson.steps[1].input === swManifestDryJson.input, "manifest search_words dry-run plans the search step as a pass-through (output = input)", JSON.stringify(swManifestDryJson.steps.map((s) => s.output)));

// smart_cut in batch + manifest: same words-file convention as
// cut_words (one words file per clip in batch, a single
// words_file in a manifest step). The batch input dir reuses the
// search_words layout (source.mp4 has words, hook-source.mp4 does
// not) with the smart_cut words file swapped in.
await rm(path.join(root, "outputs/mcp-batch-sc-in"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-sc-out"), { recursive: true, force: true });
await mkdir(path.join(root, "outputs/mcp-batch-sc-in"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-sc-in/source.mp4"));
await copyFile(path.join(root, "test/smartcut-words.json"), path.join(root, "outputs/mcp-batch-sc-in/source.words.json"));
await copyFile(path.join(root, "test/hook-source.mp4"), path.join(root, "outputs/mcp-batch-sc-in/hook-source.mp4"));
const scBatchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "smart_cut", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-sc-in"), output_dir: path.join(root, "outputs/mcp-batch-sc-out"), args: {}, jobs: 2 },
});
const scBatchJson = JSON.parse(scBatchRes.content[0].text);
console.log("batch smart_cut:", JSON.stringify(scBatchJson.results.map((r) => ({ status: r.status, output: r.output, removed: r.result?.removed_count }))), "| suffix", scBatchJson.output_suffix);
const scBatchRow = (name) => scBatchJson.results.find((r) => r.input.endsWith(`/${name}`));
checkOk(scBatchJson.succeeded === 1 && scBatchJson.failed === 1 && scBatchJson.output_suffix === "-smart_cut" && scBatchRow("source.mp4").status === "ok" && scBatchRow("source.mp4").result.removed_count === 4 && scBatchRow("hook-source.mp4").status === "error", "batch smart_cut: 1 ok (4 removals) + 1 error row for the clip with no words file", JSON.stringify(scBatchJson.results.map((r) => r.status)));
const { stdout: scBatchDurOut } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(root, "outputs/mcp-batch-sc-out/source-smart_cut.mp4")]);
checkOk(near(parseFloat(scBatchDurOut), 6.95, 0.05), "batch smart_cut output is 6.95s on disk", scBatchDurOut.trim());
await rm(path.join(root, "outputs/mcp-manifest-smartcut.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const scManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-smartcut.json") },
});
const scManifestJson = JSON.parse(scManifestRes.content[0].text);
console.log("manifest smart_cut:", JSON.stringify(scManifestJson.steps.map((s) => ({ tool: s.tool, status: s.status, removed: s.result?.removed_count }))), "| final", scManifestJson.final?.duration_seconds);
checkOk(scManifestJson.steps_run === 1 && scManifestJson.steps[0].tool === "smart_cut" && scManifestJson.steps[0].status === "ok" && scManifestJson.steps[0].result.removed_count === 4 && near(scManifestJson.final.duration_seconds, 6.95, 0.05), "manifest smart_cut step cuts 4 hesitations, final 6.95s", JSON.stringify(scManifestJson.steps.map((s) => s.result?.removed_count)));
// smart_cut batch + manifest with the new knobs (lượt 130):
// --min-segment 2 in batch collapses the clip to 1 removal (4.5s
// kept); the manifest gate fixture cuts 3 with 2 gated survivors.
await rm(path.join(root, "outputs/mcp-batch-sc2-out"), { recursive: true, force: true });
const scBatch2Res = await client.callTool({
  name: "batch",
  arguments: { operation: "smart_cut", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-sc-in"), output_dir: path.join(root, "outputs/mcp-batch-sc2-out"), args: { min_segment: 2 }, jobs: 2 },
});
const scBatch2Json = JSON.parse(scBatch2Res.content[0].text);
const scBatch2Row = (name) => scBatch2Json.results.find((r) => r.input.endsWith(`/${name}`));
checkOk(scBatch2Json.succeeded === 1 && scBatch2Row("source.mp4").status === "ok" && scBatch2Row("source.mp4").result.removed_count === 1 && scBatch2Row("source.mp4").result.min_segment_merges === 3, "batch smart_cut --min-segment 2 collapses to 1 removal (3 merges)", JSON.stringify(scBatch2Json.results.map((r) => r.result?.removed_count)));
const { stdout: scBatch2DurOut } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(root, "outputs/mcp-batch-sc2-out/source-smart_cut.mp4")]);
checkOk(near(parseFloat(scBatch2DurOut), 4.5, 0.05), "batch smart_cut --min-segment 2 output is 4.5s on disk", scBatch2DurOut.trim());
await rm(path.join(root, "outputs/mcp-manifest-smartcut-gate.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const scGateManifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-smartcut-gate.json") },
});
const scGateManifestJson = JSON.parse(scGateManifestRes.content[0].text);
checkOk(scGateManifestJson.steps_run === 1 && scGateManifestJson.steps[0].tool === "smart_cut" && scGateManifestJson.steps[0].status === "ok" && scGateManifestJson.steps[0].result.removed_count === 3 && scGateManifestJson.steps[0].result.gated_fillers.length === 2 && near(scGateManifestJson.final.duration_seconds, 8.1, 0.05), "manifest smart_cut gate fixture cuts 3 (2 gated), final 8.1s", JSON.stringify(scGateManifestJson.steps.map((s) => s.result?.removed_count)));
const scGateManifestCacheRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-smartcut-gate.json") },
});
const scGateManifestCacheJson = JSON.parse(scGateManifestCacheRes.content[0].text);
checkOk(scGateManifestCacheJson.cache_hits === 1 && scGateManifestCacheJson.steps[0].status === "cached", "manifest smart_cut gate re-run serves from cache", JSON.stringify(scGateManifestCacheJson.steps.map((s) => s.status)));

// No engine at all (both disabled): doctor must report engine
// "none" with a fix carrying BOTH install lines.
const noEngTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
  env: { ...process.env, MEDIAKIT_ASR_PYTHON: "/nonexistent/python3", MEDIAKIT_WHISPER_CPP_BIN: "/nonexistent/whisper-cli" },
});
const noEngClient = new Client({ name: "mediakit-test-noengine", version: "0.1.0" }, { capabilities: {} });
await noEngClient.connect(noEngTransport);
const noEngDoctorRes = await noEngClient.callTool({ name: "doctor", arguments: {} });
const noEngDoctorJson = JSON.parse(noEngDoctorRes.content[0].text);
checkOk(noEngDoctorJson.tools.transcribe?.available === false && noEngDoctorJson.tools.transcribe?.engine === "none" && /faster-whisper/.test(noEngDoctorJson.tools.transcribe?.fix ?? "") && /whisper\.cpp/.test(noEngDoctorJson.tools.transcribe?.fix ?? ""), "doctor with no engine reports none + both install hints", JSON.stringify(noEngDoctorJson.tools.transcribe));
await noEngClient.close();

// whisper.cpp error paths through the CLI (runCli is hoisted from
// the sandbox block below): a missing binary and a missing model
// are different failures with different fixes.
const trNoBin = await runCli(["transcribe", path.join(root, "test/speech-jfk.flac"), "-o", path.join(root, "outputs/mcp-whisper-nobin.srt"), "--engine", "whisper"], { MEDIAKIT_WHISPER_CPP_BIN: "/nonexistent/whisper-cli" });
checkOk(trNoBin.code !== 0 && /whisper\.cpp/.test(trNoBin.out) && /ASR_NOT_INSTALLED/.test(trNoBin.out), "transcribe --engine whisper with a missing binary refuses with the whisper.cpp install hint", trNoBin.out.slice(0, 200));
const trNoModel = await runCli(["transcribe", path.join(root, "test/speech-jfk.flac"), "-o", path.join(root, "outputs/mcp-whisper-nomodel.srt"), "--engine", "whisper"], { MEDIAKIT_WHISPER_CPP_BIN: stubBin, MEDIAKIT_WHISPER_MODEL: "/nonexistent/ggml-tiny.bin" });
checkOk(trNoModel.code !== 0 && /model file not found/.test(trNoModel.out) && /ASR_NOT_INSTALLED/.test(trNoModel.out), "transcribe --engine whisper with a missing model refuses with the model download hint", trNoModel.out.slice(0, 200));

// transcribe --chunk-seconds validation needs no engine (checked
// before the engine is probed), so the CLI asserts run ungated.
const trBadChunk = await runCli(["transcribe", path.join(root, "test/speech-jfk.flac"), "-o", path.join(root, "outputs/mcp-jfk-badchunk.srt"), "--chunk-seconds", "2"]);
checkOk(trBadChunk.code !== 0 && /chunk_seconds/.test(trBadChunk.out), "transcribe refuses --chunk-seconds below 5", trBadChunk.out.slice(0, 200));
const trBigChunk = await runCli(["transcribe", path.join(root, "test/speech-jfk.flac"), "-o", path.join(root, "outputs/mcp-jfk-bigchunk.srt"), "--chunk-seconds", "2000"]);
checkOk(trBigChunk.code !== 0 && /chunk_seconds/.test(trBigChunk.out), "transcribe refuses --chunk-seconds above 1800", trBigChunk.out.slice(0, 200));

// grade --cdl triple parsing through the CLI: a 2-value triple is
// refused before any encode starts.
const gradeBadTriple = await runCli(["grade", path.join(root, "test/source.mp4"), "-o", path.join(root, "outputs/mcp-grade-badtriple.mp4"), "--cdl-slope", "1.5,1"]);
checkOk(gradeBadTriple.code !== 0 && /cdl-slope/.test(gradeBadTriple.out), "grade refuses a 2-value --cdl-slope triple", gradeBadTriple.out.slice(0, 200));

// transcribe end-to-end needs a real engine + the tiny model (~75 MB
// from Hugging Face on first use): too heavy for CI, so this block
// only runs with MEDIAKIT_TEST_ASR=1 and MEDIAKIT_ASR_PYTHON pointing
// at a python with faster-whisper.
if (process.env.MEDIAKIT_TEST_ASR === "1") {
  const trRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk.srt"), model: "tiny", language: "en" },
  });
  const trJson = JSON.parse(trRes.content[0].text);
  console.log("transcribe JFK:", JSON.stringify(trJson.segments), "| lang", trJson.language);
  checkOk(trRes.isError !== true, "transcribe JFK with the tiny model succeeds", JSON.stringify(trJson).slice(0, 300));
  checkOk(trJson.language === "en" && trJson.segment_count >= 1, "transcribe detects English with >= 1 segment", `lang=${trJson.language} segments=${trJson.segment_count}`);
  checkOk(/fellow Americans/.test(trJson.text ?? ""), "transcribe JFK contains 'fellow Americans'", trJson.text ?? "");
  checkOk(near(trJson.segments?.[0]?.end, 11, 0.5), "transcribe JFK first segment ends near 11s", JSON.stringify(trJson.segments?.[0]));
  const trSrtText = await readFile(path.join(root, "outputs/mcp-jfk.srt"), "utf8");
  checkOk(/^1\n00:00:00,000 --> 00:00:11,000\n/.test(trSrtText) && /ask not what your country/.test(trSrtText), "transcribe writes a valid .srt with the JFK line", trSrtText.slice(0, 160).replace(/\n/g, " "));
  // A tone has no speech: 0 segments and an empty .srt is correct.
  const trToneRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-tone.srt") },
  });
  const trToneJson = JSON.parse(trToneRes.content[0].text);
  checkOk(trToneRes.isError !== true && trToneJson.segment_count === 0 && trToneJson.text === "" && trToneJson.size_bytes === 0, "transcribe of a tone (no speech) yields 0 segments and an empty .srt", JSON.stringify(trToneJson).slice(0, 200));
  // An image has no audio stream (reached only once the engine exists).
  const trNoAudioRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "test/logo.png"), output: path.join(root, "outputs/mcp-noaudio.srt") },
  });
  const trNoAudioJson = JSON.parse(trNoAudioRes.content[0].text);
  checkOk(trNoAudioRes.isError === true && /audio stream/.test(trNoAudioJson.error ?? ""), "transcribe refuses an image (no audio stream)", JSON.stringify(trNoAudioJson));
  // Full chain: transcribed cues burn onto the video.
  const trBurnRes = await client.callTool({
    name: "burn_captions",
    arguments: { input: path.join(root, "test/source.mp4"), captions: path.join(root, "outputs/mcp-jfk.srt"), output: path.join(root, "outputs/mcp-jfk-burned.mp4") },
  });
  const trBurnJson = JSON.parse(trBurnRes.content[0].text);
  checkOk(trBurnRes.isError !== true && near(trBurnJson.duration_seconds, 10, 0.05), "transcribe -> burn_captions chain renders a 10s captioned video", JSON.stringify(trBurnJson).slice(0, 200));
  // Word timestamps from the real faster-whisper engine, then a real
  // word cut: "fellow" out of the JFK line, re-transcribed to prove
  // it is gone (filler_cut's residual check).
  const trWordsRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-words.srt"), model: "tiny", language: "en", word_timestamps: true },
  });
  const trWordsJson = JSON.parse(trWordsRes.content[0].text);
  checkOk(trWordsRes.isError !== true && trWordsJson.word_count >= 10 && trWordsJson.words?.some((w) => String(w.word).toLowerCase().replace(/[^a-z']/g, "") === "fellow"), "transcribe --word-timestamps (faster-whisper) returns words incl. 'fellow'", JSON.stringify(trWordsJson.words?.slice(0, 5)));
  checkOk(trWordsJson.words?.every((w, i, a) => i === 0 || w.start >= a[i - 1].start) && trWordsJson.words?.every((w) => w.end > w.start), "faster-whisper words are sorted with end > start", JSON.stringify(trWordsJson.words?.slice(-3)));
  await writeFile(path.join(root, "outputs/mcp-jfk-words.json"), JSON.stringify(trWordsJson), "utf8");
  const cwJfkRes = await client.callTool({
    name: "cut_words",
    arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-cut.flac"), words_file: path.join(root, "outputs/mcp-jfk-words.json"), remove: "fellow" },
  });
  const cwJfkJson = JSON.parse(cwJfkRes.content[0].text);
  checkOk(cwJfkRes.isError !== true && cwJfkJson.removed_count === 1 && cwJfkJson.removed_words[0].word === "fellow" && cwJfkJson.duration_after < cwJfkJson.duration_before, "cut_words removes 'fellow' from the JFK recording", JSON.stringify(cwJfkJson.removed_words));
  const trCutRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "outputs/mcp-jfk-cut.flac"), output: path.join(root, "outputs/mcp-jfk-cut.srt"), model: "tiny", language: "en" },
  });
  const trCutJson = JSON.parse(trCutRes.content[0].text);
  checkOk(trCutRes.isError !== true && !/fellow/i.test(trCutJson.text ?? ""), "re-transcribing the cut proves 'fellow' is gone (residual check)", trCutJson.text ?? "");
}

// transcribe --engine whisper end-to-end with the REAL whisper.cpp
// binary + model: only runs with MEDIAKIT_TEST_WHISPER_CPP=1 and
// MEDIAKIT_WHISPER_CPP_BIN / MEDIAKIT_WHISPER_MODEL set (the server
// child inherits process.env, so they must be set before the suite
// starts). Too heavy for CI; the stub block above covers the path.
if (process.env.MEDIAKIT_TEST_WHISPER_CPP === "1") {
  const wRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-whisper.srt"), model: "tiny", language: "auto", engine: "whisper" },
  });
  const wJson = JSON.parse(wRes.content[0].text);
  console.log("transcribe whisper.cpp JFK:", JSON.stringify(wJson.segments), "| lang", wJson.language);
  checkOk(wRes.isError !== true && wJson.engine === "whisper.cpp", "transcribe --engine whisper (real binary) succeeds and reports whisper.cpp", JSON.stringify(wJson).slice(0, 200));
  checkOk(wJson.language === "en" && wJson.segment_count >= 1, "transcribe --engine whisper detects English with >= 1 segment", `lang=${wJson.language} segments=${wJson.segment_count}`);
  checkOk(/fellow Americans/.test(wJson.text ?? ""), "transcribe --engine whisper JFK contains 'fellow Americans'", wJson.text ?? "");
  checkOk(near(wJson.segments?.[0]?.end, 10.5, 0.5), "transcribe --engine whisper JFK first segment ends near 10.5s", JSON.stringify(wJson.segments?.[0]));
  // A tone has no speech under the real engine too: 0 segments.
  const wToneRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-tone-whisper.srt"), engine: "whisper" },
  });
  const wToneJson = JSON.parse(wToneRes.content[0].text);
  checkOk(wToneRes.isError !== true && wToneJson.segment_count === 0 && wToneJson.text === "" && wToneJson.size_bytes === 0, "transcribe --engine whisper of a tone (no speech) yields 0 segments and an empty .srt", JSON.stringify(wToneJson).slice(0, 200));
  // Word timestamps from the real whisper.cpp engine: same sentence,
  // same word count as the stub (the stub's tokens are this binary's
  // real output), with 'fellow' at [0.95, 1.59].
  const wWordsRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-whisper-words.srt"), model: "tiny", language: "en", engine: "whisper", word_timestamps: true },
  });
  const wWordsJson = JSON.parse(wWordsRes.content[0].text);
  checkOk(wWordsRes.isError !== true && wWordsJson.word_count >= 20 && wWordsJson.words?.some((w) => w.word === "fellow" && w.start >= 0.5 && w.start <= 1.5), "transcribe --engine whisper --word-timestamps returns >= 20 words incl. 'fellow' near 1s", JSON.stringify(wWordsJson.words?.slice(2, 5)));
  checkOk(wWordsJson.words?.every((w) => w.end > w.start && !/\[/.test(w.word)), "whisper.cpp words carry no bracketed special tokens", JSON.stringify(wWordsJson.words?.slice(-2)));
  // Chunked with the real engine: 11s at 5s a chunk -> 3 chunks,
  // segments re-offset onto the full timeline, the JFK line intact
  // (a phrase at a boundary may repeat — the overlap is heard twice
  // and kept once per owned window, it is not word-exact).
  const wChunkRes = await client.callTool({
    name: "transcribe",
    arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-whisper-chunk.srt"), model: "tiny", language: "en", engine: "whisper", chunk_seconds: 5 },
  });
  const wChunkJson = JSON.parse(wChunkRes.content[0].text);
  console.log("transcribe whisper.cpp JFK chunked:", JSON.stringify(wChunkJson.segments));
  checkOk(wChunkRes.isError !== true && wChunkJson.chunks === 3 && wChunkJson.segment_count >= 1, "transcribe --engine whisper --chunk-seconds 5 runs 3 chunks", JSON.stringify(wChunkJson).slice(0, 200));
  checkOk(/fellow Americans/.test(wChunkJson.text ?? "") && /ask what you can do for your country/.test(wChunkJson.text ?? ""), "chunked transcribe keeps the JFK line", wChunkJson.text ?? "");
  checkOk(wChunkJson.segments.every((s, i, a) => i === 0 || s.start >= a[i - 1].start) && wChunkJson.segments.every((s) => s.start >= 0 && s.end <= 11.5), "chunked segments are sorted and inside the file", JSON.stringify(wChunkJson.segments));
}

// Sandbox (MEDIAKIT_WORKDIR), tested through the CLI so the env var
// only reaches the spawned child — never process.env here, or the MCP
// server above would inherit it and every later call would fail.
// Workdir lives under outputs/ (writable, uncommitted); the symlink
// points at test/source.mp4, outside the workdir.
async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(root, "bin/mediakit.js"), ...args], { env: { ...process.env, ...env } });
    return { code: 0, out: `${stdout ?? ""}${stderr ?? ""}` };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
const sandboxDir = path.join(root, "outputs/sandbox-wd");
await rm(sandboxDir, { recursive: true, force: true });
await mkdir(sandboxDir, { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(sandboxDir, "source.mp4"));
await symlink(path.join(root, "test/source.mp4"), path.join(sandboxDir, "link.mp4"));
const sandboxEnv = { MEDIAKIT_WORKDIR: sandboxDir };
const sbIn = await runCli(["probe", path.join(sandboxDir, "source.mp4")], sandboxEnv);
checkOk(sbIn.code === 0, "sandbox: probe of a file inside the workdir succeeds", sbIn.out.slice(0, 200));
const sbOut = await runCli(["probe", path.join(root, "test/source.mp4")], sandboxEnv);
checkOk(sbOut.code !== 0 && /escapes MEDIAKIT_WORKDIR/.test(sbOut.out), "sandbox: probe of a file outside the workdir is refused", sbOut.out.slice(0, 200));
const sbLink = await runCli(["probe", path.join(sandboxDir, "link.mp4")], sandboxEnv);
checkOk(sbLink.code !== 0 && /escapes MEDIAKIT_WORKDIR/.test(sbLink.out), "sandbox: symlink inside the workdir pointing outside is refused", sbLink.out.slice(0, 200));
const sbTraversal = await runCli(["probe", `${sandboxDir}/../source.mp4`], sandboxEnv);
checkOk(sbTraversal.code !== 0 && /escapes MEDIAKIT_WORKDIR/.test(sbTraversal.out), "sandbox: '..' traversal out of the workdir is refused", sbTraversal.out.slice(0, 200));
const sbWrite = await runCli(["trim", path.join(sandboxDir, "source.mp4"), "--start", "1", "--duration", "2", "-o", path.join(root, "outputs/mcp-sandbox-out.mp4")], sandboxEnv);
checkOk(sbWrite.code !== 0 && /escapes MEDIAKIT_WORKDIR/.test(sbWrite.out) && !existsSync(path.join(root, "outputs/mcp-sandbox-out.mp4")), "sandbox: writing an output outside the workdir is refused (and writes nothing)", sbWrite.out.slice(0, 200));
const sbFrames = await runCli(["frames", path.join(sandboxDir, "source.mp4"), "-o", path.join(root, "outputs/sandbox-frames-out"), "--count", "2"], sandboxEnv);
checkOk(sbFrames.code !== 0 && /escapes MEDIAKIT_WORKDIR/.test(sbFrames.out), "sandbox: frames output directory outside the workdir is refused", sbFrames.out.slice(0, 200));
const sbGen = await runCli(["generate-srt", "--cues-file", path.join(root, "test/cues.json"), "-o", path.join(sandboxDir, "gen.srt")], sandboxEnv);
checkOk(sbGen.code === 0 && existsSync(path.join(sandboxDir, "gen.srt")), "sandbox: generate-srt inside the workdir succeeds (CLI path)", sbGen.out.slice(0, 200));
const sbDoctor = await runCli(["doctor"], sandboxEnv);
let sbDoctorJson = null;
try { sbDoctorJson = JSON.parse(sbDoctor.out); } catch { /* not JSON */ }
// doctor reports the REAL workdir path (workdirRoot realpaths the
// env value), so compare against realpath(sandboxDir) — the two
// differ when the workdir is reached through a symlinked component
// (e.g. an `outputs` dir symlinked to /tmp).
const sbRealDir = await realpath(sandboxDir);
checkOk(sbDoctor.code === 0 && sbDoctorJson?.sandbox?.enabled === true && sbDoctorJson?.sandbox?.workdir === sbRealDir, "sandbox: doctor reports enabled + the real workdir path", sbDoctor.out.slice(0, 200));
const sbDoctorOff = await runCli(["doctor"]);
let sbDoctorOffJson = null;
try { sbDoctorOffJson = JSON.parse(sbDoctorOff.out); } catch { /* not JSON */ }
checkOk(sbDoctorOff.code === 0 && sbDoctorOffJson?.sandbox?.enabled === false, "sandbox: doctor reports disabled when MEDIAKIT_WORKDIR is unset", sbDoctorOff.out.slice(0, 200));
const sbBadWd = await runCli(["probe", path.join(sandboxDir, "source.mp4")], { MEDIAKIT_WORKDIR: path.join(root, "outputs/no-such-workdir") });
checkOk(sbBadWd.code !== 0 && /MEDIAKIT_WORKDIR does not exist/.test(sbBadWd.out), "sandbox: a missing MEDIAKIT_WORKDIR fails loudly instead of silently disabling the sandbox", sbBadWd.out.slice(0, 200));

// MCP Resources (videos://...): list, per-file metadata, workspace
// info — plus a second, workdir-scoped server for the confinement
// checks. The repo root holds 200+ media files (outputs/ included),
// so videos://list may be truncated at the 200 cap here; the workdir
// server (root test/) is small enough to assert membership in.
console.log("resources");
async function readResourceExpectError(aClient, uri) {
  try {
    const res = await aClient.readResource({ uri });
    return res.contents?.[0]?.text ?? "";
  } catch (e) {
    return e.message ?? String(e);
  }
}
const resList = await client.listResources();
const resUris = (resList.resources ?? []).map((r) => r.uri);
checkOk(resUris.includes("videos://list") && resUris.includes("videos://workspace/info"), "resources/list advertises videos://list and videos://workspace/info", JSON.stringify(resUris));
// Templates live under a separate method (resources/templates/list),
// not in resources/list — the SDK only enumerates template instances
// there when a list callback exists.
const resTemplates = await client.listResourceTemplates();
const templateUris = (resTemplates.resourceTemplates ?? []).map((t) => t.uriTemplate);
checkOk(templateUris.includes("videos://{+filename}/metadata"), "resources/templates/list advertises the videos://{+filename}/metadata template", JSON.stringify(templateUris));
const listRes = await client.readResource({ uri: "videos://list" });
const listJson = JSON.parse(listRes.contents[0].text);
checkOk(listJson.root === root && listJson.sandbox_enabled === false && listJson.count === Math.min(200, listJson.total_files) && listJson.truncated === (listJson.total_files > 200) && listJson.total_files > 0, "videos://list is rooted at the repo with a consistent count/truncation", `root=${listJson.root} count=${listJson.count} total=${listJson.total_files} truncated=${listJson.truncated}`);
checkOk(listJson.files.every((f) => typeof f.path === "string" && typeof f.size_bytes === "number" && f.size_bytes >= 0 && typeof f.extension === "string") && listJson.files.map((f) => f.path).join("\n") === [...listJson.files.map((f) => f.path)].sort().join("\n"), "videos://list entries carry path/size/extension and are sorted", `first=${listJson.files[0]?.path}`);
const metaRes = await client.readResource({ uri: "videos://test/source.mp4/metadata" });
const metaJson = JSON.parse(metaRes.contents[0].text);
checkOk(metaJson.relative_path === "test/source.mp4" && near(metaJson.duration_seconds, 10, 0.05) && metaJson.video?.width === 1280 && metaJson.video?.height === 720, "videos://test/source.mp4/metadata probes 1280x720 / 10s", JSON.stringify(metaJson).slice(0, 200));
const metaNested = await client.readResource({ uri: "videos://test/nested/deep-clip.mp4/metadata" });
const metaNestedJson = JSON.parse(metaNested.contents[0].text);
checkOk(metaNestedJson.relative_path === "test/nested/deep-clip.mp4" && near(metaNestedJson.duration_seconds, 10, 0.05), "videos://{+filename}/metadata reaches a nested path (reserved expansion)", JSON.stringify(metaNestedJson).slice(0, 160));
const infoRes = await client.readResource({ uri: "videos://workspace/info" });
const infoJson = JSON.parse(infoRes.contents[0].text);
checkOk(infoJson.root === root && infoJson.tools_total === 81 && infoJson.tools_available >= 48 && typeof infoJson.ffmpeg_version === "string" && infoJson.media_files === listJson.total_files, "videos://workspace/info reports root, 81 tools, ffmpeg version, media count matching the list", JSON.stringify(infoJson).slice(0, 300));
const escText = await readResourceExpectError(client, "videos://../package.json/metadata");
checkOk(/escapes the workspace root/.test(escText), "videos://../package.json/metadata is refused as a workspace escape", escText.slice(0, 200));
const notMediaText = await readResourceExpectError(client, "videos://package.json/metadata");
checkOk(/not a media file/.test(notMediaText), "videos://package.json/metadata is refused (not a media file)", notMediaText.slice(0, 200));
const missingText = await readResourceExpectError(client, "videos://no-such-clip.mp4/metadata");
checkOk(/not found/.test(missingText), "videos://no-such-clip.mp4/metadata reports not found", missingText.slice(0, 200));

// Workdir-scoped server: root is test/, so the list is small and
// source.mp4 is a member; `..` out of test/ is refused.
const wdTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
  env: { ...process.env, MEDIAKIT_WORKDIR: path.join(root, "test") },
});
const wdClient = new Client({ name: "mediakit-test-wd", version: "0.1.0" }, { capabilities: {} });
await wdClient.connect(wdTransport);
const wdList = await wdClient.readResource({ uri: "videos://list" });
const wdJson = JSON.parse(wdList.contents[0].text);
checkOk(wdJson.root === path.join(root, "test") && wdJson.sandbox_enabled === true && wdJson.truncated === false && wdJson.files.some((f) => f.path === "source.mp4"), "workdir-scoped videos://list is rooted at test/ with the sandbox on", JSON.stringify(wdJson).slice(0, 200));
const wdMeta = await wdClient.readResource({ uri: "videos://source.mp4/metadata" });
const wdMetaJson = JSON.parse(wdMeta.contents[0].text);
checkOk(wdMetaJson.relative_path === "source.mp4" && near(wdMetaJson.duration_seconds, 10, 0.05), "workdir-scoped metadata reads source.mp4 by bare name", JSON.stringify(wdMetaJson).slice(0, 160));
const wdEsc = await readResourceExpectError(wdClient, "videos://../package.json/metadata");
checkOk(/escapes the workspace root/.test(wdEsc), "workdir-scoped metadata refuses '..' out of test/", wdEsc.slice(0, 200));
await wdClient.close();

// batch: one operation over many files matching a glob. Input tree:
// source.mp4 + source2.mp4 at the top, deep-clip.mp4 nested one
// level down — the outputs must mirror that tree with a
// -<operation> suffix, and a second identical run must hit the
// content-hash cache instead of re-encoding.
await mkdir(path.join(root, "outputs/mcp-batch-in/sub"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-in/source.mp4"));
await copyFile(path.join(root, "test/source2.mp4"), path.join(root, "outputs/mcp-batch-in/source2.mp4"));
await copyFile(path.join(root, "test/nested/deep-clip.mp4"), path.join(root, "outputs/mcp-batch-in/sub/deep-clip.mp4"));
// Hermetic batch runs: a previous test run leaves a content-hash
// cache in the output dir, so the "first" loudness run would come
// back cached instead of ok. Clear the output dirs the batch tests
// assert on; the cache-hit test below re-creates its own cache.
await rm(path.join(root, "outputs/mcp-batch-out"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-audio"), { recursive: true, force: true });
await rm(path.join(root, "outputs/mcp-batch-stop-out"), { recursive: true, force: true });
const batchDryRes = await client.callTool({
  name: "batch",
  arguments: { operation: "loudness", pattern: "**/*.mp4", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-dry"), args: { target_lufs: -16 }, dry_run: true },
});
const batchDryJson = JSON.parse(batchDryRes.content[0].text);
checkOk(batchDryJson.dry_run === true && batchDryJson.files_matched === 3 && batchDryJson.results.every((r) => r.status === "planned"), "batch dry-run plans 3 files, no run", JSON.stringify(batchDryJson.results.map((r) => r.status)));
checkOk(!existsSync(path.join(root, "outputs/mcp-batch-dry")), "batch dry-run writes no output directory", "outputs/mcp-batch-dry exists");
const batchRes = await client.callTool({
  name: "batch",
  arguments: { operation: "loudness", pattern: "**/*.mp4", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-out"), args: { target_lufs: -16 }, jobs: 2 },
});
const batchJson = JSON.parse(batchRes.content[0].text);
console.log("batch loudness:", batchJson.succeeded, "ok /", batchJson.failed, "failed /", batchJson.cached, "cached /", batchJson.elapsed_seconds + "s");
checkOk(batchJson.succeeded === 3 && batchJson.failed === 0 && batchJson.cached === 0, "batch loudness succeeds on all 3 files", JSON.stringify(batchJson.results.map((r) => r.status)));
// loudnorm single-pass lands within a few tenths of the target,
// and the exact tenth varies by build — CI reported -15.9 where
// local reports -16.0 (CI run 1 of lượt 101 failed the old
// `=== -16`). ±0.5 LUFS still catches a loudness that did not run
// (the input is -21.8 LUFS, far outside the band), and matches the
// ±0.5 the manifest loudness assert already uses.
checkOk(batchJson.results.every((r) => r.status === "ok" && near(r.result?.output_lufs, -16, 0.5)), "batch loudness reports -16 LUFS per file (±0.5 — loudnorm lands on a different tenth per ffmpeg build)", JSON.stringify(batchJson.results.map((r) => r.result?.output_lufs)));
checkOk(existsSync(path.join(root, "outputs/mcp-batch-out/sub/deep-clip-loudness.mp4")), "batch mirrors the nested input tree in the output dir", "sub/deep-clip-loudness.mp4 missing");
const batchLufs = await measureLufs(path.join(root, "outputs/mcp-batch-out/source-loudness.mp4"));
checkOk(near(batchLufs, -16, 1), "batch loudness output measures -16 LUFS independently", `got ${batchLufs}`);
const batchManifest = JSON.parse(await readFile(path.join(root, "outputs/mcp-batch-out/batch-manifest.json"), "utf8"));
checkOk(batchManifest.results.length === 3 && batchManifest.succeeded === 3, "batch writes batch-manifest.json with all 3 rows", `got ${batchManifest.results?.length} rows`);
const batchMtimeBefore = statSync(path.join(root, "outputs/mcp-batch-out/source-loudness.mp4")).mtimeMs;
await new Promise((r) => setTimeout(r, 1100));
const batchCachedRes = await client.callTool({
  name: "batch",
  arguments: { operation: "loudness", pattern: "**/*.mp4", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-out"), args: { target_lufs: -16 }, jobs: 2 },
});
const batchCachedJson = JSON.parse(batchCachedRes.content[0].text);
checkOk(batchCachedJson.cached === 3 && batchCachedJson.succeeded === 0, "batch second run serves all 3 files from the content-hash cache", `cached=${batchCachedJson.cached} succeeded=${batchCachedJson.succeeded}`);
checkOk(statSync(path.join(root, "outputs/mcp-batch-out/source-loudness.mp4")).mtimeMs === batchMtimeBefore, "batch cache hit does not touch the output file (mtime unchanged)", "mtime moved");
const batchBadArgText = await callExpectThrow("batch", { operation: "loudness", pattern: "**/*.mp4", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-badarg"), args: { bogus_key: 1 } });
checkOk(/does not take argument/.test(batchBadArgText) && /bogus_key/.test(batchBadArgText), "batch refuses an unknown operation argument by name", batchBadArgText.slice(0, 160));
const batchBadValRes = await client.callTool({
  name: "batch",
  arguments: { operation: "loudness", pattern: "**/*.mp4", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-badval"), args: { target_lufs: 999 } },
});
const batchBadValJson = JSON.parse(batchBadValRes.content[0].text);
checkOk(batchBadValJson.failed === 3 && batchBadValJson.succeeded === 0, "batch bad arg fails every file (no silent fallback)", `failed=${batchBadValJson.failed}`);
checkOk(/target_lufs/.test(batchBadValJson.results[0].error ?? ""), "batch bad arg reports the failing argument per file", (batchBadValJson.results[0].error ?? "").slice(0, 120));
const batchBadOpText = await callExpectThrow("batch", { operation: "nosuchop", pattern: "**/*.mp4", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-badop") });
checkOk(/Invalid enum value/.test(batchBadOpText) && /nosuchop/.test(batchBadOpText), "batch rejects an unknown operation (MCP enum validation)", batchBadOpText.slice(0, 160));
const batchNoMatchText = await callExpectThrow("batch", { operation: "loudness", pattern: "*.nomatch", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-nomatch") });
checkOk(/matched no files/.test(batchNoMatchText), "batch with no matches errors instead of reporting an empty success", batchNoMatchText.slice(0, 160));
// stop_on_error: the audio-only file fails grade first (alphabetical
// order), so the video after it must be reported skipped, not run.
await mkdir(path.join(root, "outputs/mcp-batch-stop"), { recursive: true });
await copyFile(path.join(root, "test/mix-voice.mp3"), path.join(root, "outputs/mcp-batch-stop/a-voice.mp3"));
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-stop/b-source.mp4"));
const batchStopRes = await client.callTool({
  name: "batch",
  arguments: { operation: "grade", pattern: "*.*", input_dir: path.join(root, "outputs/mcp-batch-stop"), output_dir: path.join(root, "outputs/mcp-batch-stop-out"), args: { preset: "noir" }, stop_on_error: true },
});
const batchStopJson = JSON.parse(batchStopRes.content[0].text);
checkOk(batchStopJson.failed === 1 && batchStopJson.skipped === 1 && batchStopJson.succeeded === 0, "batch stop_on_error fails the first file and skips the rest", `failed=${batchStopJson.failed} skipped=${batchStopJson.skipped}`);
checkOk(batchStopJson.results[1].status === "skipped", "batch stop_on_error marks the unstarted file skipped", JSON.stringify(batchStopJson.results[1]));
// extract_audio batch: a video input defaults to .mp3 output.
const batchAudioRes = await client.callTool({
  name: "batch",
  arguments: { operation: "extract_audio", pattern: "source*.mp4", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-audio") },
});
const batchAudioJson = JSON.parse(batchAudioRes.content[0].text);
checkOk(batchAudioJson.succeeded === 2 && batchAudioJson.results.every((r) => r.output.endsWith("-extract_audio.mp3")), "batch extract_audio writes .mp3 outputs for video inputs", JSON.stringify(batchAudioJson.results.map((r) => r.output)));
checkOk(existsSync(path.join(root, "outputs/mcp-batch-audio/source-extract_audio.mp3")), "batch extract_audio output file exists on disk", "source-extract_audio.mp3 missing");
// batch cut_words (lượt 38): per-file <stem>.words.json next to each
// input (words_dir defaults to the input's own folder). take-c has no
// words file, so its row fails while the rest still run. take-b's
// words file holds the same words in different bytes (compact JSON),
// so it must run fresh — not be served take-a's cut. take-d is
// take-a's exact twin (same clip bytes, same words bytes), so it is
// served from the cache — and the cache must still write take-d's
// own output file, not just point at take-a's.
await mkdir(path.join(root, "outputs/mcp-batch-cw-in"), { recursive: true });
for (const stem of ["take-a", "take-b", "take-c", "take-d"]) {
  await copyFile(path.join(root, "test/source.mp4"), path.join(root, `outputs/mcp-batch-cw-in/${stem}.mp4`));
}
const cwWordsRaw = await readFile(path.join(root, "test/cut-words.json"), "utf8");
await writeFile(path.join(root, "outputs/mcp-batch-cw-in/take-a.words.json"), cwWordsRaw, "utf8");
await writeFile(path.join(root, "outputs/mcp-batch-cw-in/take-b.words.json"), JSON.stringify(JSON.parse(cwWordsRaw)), "utf8");
await writeFile(path.join(root, "outputs/mcp-batch-cw-in/take-d.words.json"), cwWordsRaw, "utf8");
await rm(path.join(root, "outputs/mcp-batch-cw-out"), { recursive: true, force: true });
const batchCwRes = await client.callTool({
  name: "batch",
  arguments: { operation: "cut_words", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-cw-in"), output_dir: path.join(root, "outputs/mcp-batch-cw-out"), args: { remove: "um,uh" } },
});
const batchCwJson = JSON.parse(batchCwRes.content[0].text);
checkOk(batchCwJson.succeeded === 2 && batchCwJson.failed === 1 && batchCwJson.cached === 1, "batch cut_words cuts 2 files, caches the exact twin, fails the one with no words file", `succeeded=${batchCwJson.succeeded} cached=${batchCwJson.cached} failed=${batchCwJson.failed}`);
const batchCwRowA = batchCwJson.results.find((r) => r.input.endsWith("take-a.mp4"));
const batchCwRowB = batchCwJson.results.find((r) => r.input.endsWith("take-b.mp4"));
const batchCwRowC = batchCwJson.results.find((r) => r.input.endsWith("take-c.mp4"));
const batchCwRowD = batchCwJson.results.find((r) => r.input.endsWith("take-d.mp4"));
checkOk(batchCwRowA?.status === "ok" && batchCwRowA?.result?.removed_count === 2 && near(batchCwRowA?.result?.duration_after, 3.48, 0.05), "batch cut_words take-a: removes um+uh, 3.48s after", JSON.stringify(batchCwRowA?.result));
checkOk(batchCwRowB?.status === "ok" && near(batchCwRowB?.result?.duration_after, 3.48, 0.05), "batch cut_words take-b (same words, different bytes) runs fresh instead of serving take-a's cut", JSON.stringify(batchCwRowB));
checkOk(batchCwRowC?.status === "error" && /take-c\.words\.json/.test(batchCwRowC?.error ?? ""), "batch cut_words take-c: error names the missing words file, other rows unaffected", (batchCwRowC?.error ?? "").slice(0, 160));
checkOk(batchCwRowD?.status === "cached" && near(batchCwRowD?.result?.duration_after, 3.48, 0.05), "batch cut_words take-d (exact twin of take-a) is served from the cache", JSON.stringify(batchCwRowD));
checkOk(existsSync(path.join(root, "outputs/mcp-batch-cw-out/take-d-cut_words.mp4")), "batch cache hit still writes the twin's own output file", "take-d-cut_words.mp4 missing");
const { stdout: batchCwDurOut } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(root, "outputs/mcp-batch-cw-out/take-a-cut_words.mp4")]);
checkOk(near(parseFloat(batchCwDurOut.trim()), 3.48, 0.05), "batch cut_words output measures 3.48s independently (ffprobe)", `got ${batchCwDurOut.trim()}`);
const { stdout: batchCwDurDOut } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(root, "outputs/mcp-batch-cw-out/take-d-cut_words.mp4")]);
checkOk(near(parseFloat(batchCwDurDOut.trim()), 3.48, 0.05), "batch cached twin output measures 3.48s independently (ffprobe)", `got ${batchCwDurDOut.trim()}`);
// batch remove_retakes: same per-clip words-file convention as
// cut_words. take-a carries the retakes fixture (10 words cut,
// 5.74s after); take-b has no words file and fails its own row.
await mkdir(path.join(root, "outputs/mcp-batch-rt-in"), { recursive: true });
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-rt-in/take-a.mp4"));
await copyFile(path.join(root, "test/source.mp4"), path.join(root, "outputs/mcp-batch-rt-in/take-b.mp4"));
await copyFile(path.join(root, "test/retakes-words.json"), path.join(root, "outputs/mcp-batch-rt-in/take-a.words.json"));
await rm(path.join(root, "outputs/mcp-batch-rt-out"), { recursive: true, force: true });
const batchRtRes = await client.callTool({
  name: "batch",
  arguments: { operation: "remove_retakes", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-rt-in"), output_dir: path.join(root, "outputs/mcp-batch-rt-out"), args: {} },
});
const batchRtJson = JSON.parse(batchRtRes.content[0].text);
checkOk(batchRtJson.succeeded === 1 && batchRtJson.failed === 1, "batch remove_retakes cuts the clip with a words file, fails the one without", `succeeded=${batchRtJson.succeeded} failed=${batchRtJson.failed}`);
const batchRtRowA = batchRtJson.results.find((r) => r.input.endsWith("take-a.mp4"));
const batchRtRowB = batchRtJson.results.find((r) => r.input.endsWith("take-b.mp4"));
checkOk(batchRtRowA?.status === "ok" && batchRtRowA?.result?.removed_count === 10 && near(batchRtRowA?.result?.duration_after, 5.74, 0.05), "batch remove_retakes take-a: 10 words cut, 5.74s after", JSON.stringify(batchRtRowA?.result));
checkOk(batchRtRowB?.status === "error" && /take-b\.words\.json/.test(batchRtRowB?.error ?? ""), "batch remove_retakes take-b: error names the missing words file", (batchRtRowB?.error ?? "").slice(0, 160));
// batch chroma_key via MCP (enum regression, lượt 38): lượt 36 added
// chroma_key to BATCH_OPERATIONS but not the MCP batch enum, so MCP
// callers got "Invalid enum value" while the CLI worked. The
// check-docs batch-enum guard now fails CI on that drift.
await mkdir(path.join(root, "outputs/mcp-batch-chroma-in"), { recursive: true });
await copyFile(path.join(root, "test/greenscreen.mp4"), path.join(root, "outputs/mcp-batch-chroma-in/green.mp4"));
await rm(path.join(root, "outputs/mcp-batch-chroma-out"), { recursive: true, force: true });
const batchChromaRes = await client.callTool({
  name: "batch",
  arguments: { operation: "chroma_key", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-chroma-in"), output_dir: path.join(root, "outputs/mcp-batch-chroma-out"), args: {} },
});
const batchChromaJson = JSON.parse(batchChromaRes.content[0].text);
checkOk(batchChromaJson.succeeded === 1 && batchChromaJson.results[0].output.endsWith("-chroma_key.mov"), "batch chroma_key runs via MCP and writes a transparent .mov", JSON.stringify(batchChromaJson.results.map((r) => r.output)));
checkOk(existsSync(path.join(root, "outputs/mcp-batch-chroma-out/green-chroma_key.mov")), "batch chroma_key output file exists on disk", "green-chroma_key.mov missing");
// batch chroma_key with an image background: editing the background
// image must re-run the file, not serve the cached composite — the
// background's bytes (not just its path) are in the cache key.
await mkdir(path.join(root, "outputs/mcp-batch-chroma-bg"), { recursive: true });
await copyFile(path.join(root, "test/greenscreen.mp4"), path.join(root, "outputs/mcp-batch-chroma-bg/green.mp4"));
await copyFile(path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-batch-chroma-bg/bg.png"));
await rm(path.join(root, "outputs/mcp-batch-chroma-bg-out"), { recursive: true, force: true });
const batchChromaBg1 = JSON.parse((await client.callTool({
  name: "batch",
  arguments: { operation: "chroma_key", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-chroma-bg"), output_dir: path.join(root, "outputs/mcp-batch-chroma-bg-out"), args: { background: path.join(root, "outputs/mcp-batch-chroma-bg/bg.png") } },
})).content[0].text);
checkOk(batchChromaBg1.succeeded === 1, "batch chroma_key with image background succeeds", `succeeded=${batchChromaBg1.succeeded}`);
const chromaBgR1 = await planeMean(path.join(root, "outputs/mcp-batch-chroma-bg-out/green-chroma_key.mp4"), "100:100:0:0", "r");
checkOk(chromaBgR1 !== null && chromaBgR1 > 200, "batch chroma_key composite shows the red background first (corner R high)", `corner R=${chromaBgR1}`);
await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=200x200", "-frames:v", "1", path.join(root, "outputs/mcp-batch-chroma-bg/bg.png")]);
const batchChromaBg2 = JSON.parse((await client.callTool({
  name: "batch",
  arguments: { operation: "chroma_key", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-chroma-bg"), output_dir: path.join(root, "outputs/mcp-batch-chroma-bg-out"), args: { background: path.join(root, "outputs/mcp-batch-chroma-bg/bg.png") } },
})).content[0].text);
checkOk(batchChromaBg2.succeeded === 1 && batchChromaBg2.cached === 0, "batch chroma_key re-runs after the background image changes (no stale cache hit)", `succeeded=${batchChromaBg2.succeeded} cached=${batchChromaBg2.cached}`);
const chromaBgB2 = await planeMean(path.join(root, "outputs/mcp-batch-chroma-bg-out/green-chroma_key.mp4"), "100:100:0:0", "b");
checkOk(chromaBgB2 !== null && chromaBgB2 > 200, "batch chroma_key re-run composites the new blue background (corner B high)", `corner B=${chromaBgB2}`);
// batch slideshow (lượt 49): a SET operation — the whole matched
// set of images becomes ONE slideshow video (output_name), not one
// output per file, and the per-file cache does not apply.
await mkdir(path.join(root, "outputs/mcp-batch-slideshow-in"), { recursive: true });
await copyFile(path.join(root, "test/logo.png"), path.join(root, "outputs/mcp-batch-slideshow-in/a-logo.png"));
await copyFile(path.join(root, "test/kenburns.png"), path.join(root, "outputs/mcp-batch-slideshow-in/b-kenburns.png"));
await copyFile(path.join(root, "test/slide-blue.png"), path.join(root, "outputs/mcp-batch-slideshow-in/c-blue.png"));
await rm(path.join(root, "outputs/mcp-batch-slideshow-out"), { recursive: true, force: true });
const batchSlideDryRes = await client.callTool({
  name: "batch",
  arguments: { operation: "slideshow", pattern: "*.png", input_dir: path.join(root, "outputs/mcp-batch-slideshow-in"), output_dir: path.join(root, "outputs/mcp-batch-slideshow-out"), args: { duration: 2, transition_duration: 0.5 }, dry_run: true },
});
const batchSlideDryJson = JSON.parse(batchSlideDryRes.content[0].text);
checkOk(batchSlideDryJson.dry_run === true && batchSlideDryJson.files_matched === 3 && batchSlideDryJson.results.length === 1 && batchSlideDryJson.results[0].status === "planned" && batchSlideDryJson.results[0].output.endsWith("slideshow.mp4"), "batch slideshow dry-run plans ONE video from 3 images", JSON.stringify(batchSlideDryJson.results.map((r) => r.status)));
checkOk(!existsSync(path.join(root, "outputs/mcp-batch-slideshow-out")), "batch slideshow dry-run writes no output directory", "outputs/mcp-batch-slideshow-out exists");
const batchSlideRes = await client.callTool({
  name: "batch",
  arguments: { operation: "slideshow", pattern: "*.png", input_dir: path.join(root, "outputs/mcp-batch-slideshow-in"), output_dir: path.join(root, "outputs/mcp-batch-slideshow-out"), args: { duration: 2, transition_duration: 0.5 } },
});
const batchSlideJson = JSON.parse(batchSlideRes.content[0].text);
checkOk(batchSlideJson.succeeded === 1 && batchSlideJson.failed === 0 && batchSlideJson.cache === false && typeof batchSlideJson.cache_note === "string", "batch slideshow succeeds with one row and reports the cache does not apply", `succeeded=${batchSlideJson.succeeded} cache=${batchSlideJson.cache}`);
checkOk(batchSlideJson.results[0].result?.expected_duration_seconds === 6 && batchSlideJson.results[0].result?.slides?.length === 3, "batch slideshow result is 3 slides x 2s = 6s", JSON.stringify(batchSlideJson.results[0].result?.expected_duration_seconds));
const batchSlideFrames = await countFrames(path.join(root, "outputs/mcp-batch-slideshow-out/slideshow.mp4"));
checkOk(batchSlideFrames === 180, "batch slideshow output counts 180 frames on disk (6s @ 30fps)", `got ${batchSlideFrames}`);
const batchSlideManifest = JSON.parse(await readFile(path.join(root, "outputs/mcp-batch-slideshow-out/batch-manifest.json"), "utf8"));
checkOk(batchSlideManifest.results.length === 1 && batchSlideManifest.succeeded === 1, "batch slideshow writes batch-manifest.json with the single row", `got ${batchSlideManifest.results?.length} rows`);
const batchSlideOneText = await callExpectThrow("batch", { operation: "slideshow", pattern: "a-logo.png", input_dir: path.join(root, "outputs/mcp-batch-slideshow-in"), output_dir: path.join(root, "outputs/mcp-batch-slideshow-one") });
checkOk(/at least 2 images/.test(batchSlideOneText), "batch slideshow refuses a single matched image", batchSlideOneText.slice(0, 160));
const batchSlideNoImgText = await callExpectThrow("batch", { operation: "slideshow", pattern: "*.mp4", input_dir: path.join(root, "outputs/mcp-batch-in"), output_dir: path.join(root, "outputs/mcp-batch-slideshow-noimg") });
checkOk(/only 0 image/.test(batchSlideNoImgText), "batch slideshow refuses a pattern matching no images (and says how many files matched)", batchSlideNoImgText.slice(0, 160));

// qa_report + thumbnail timestamps (lượt 31; idea: github774/claude-video-studio
// contact_sheet + qa_report — run the gate, plus a contact sheet, on
// every deliverable before calling it done).
const qaOf = (j, name) => j.checks.find((c) => c.check === name);

// thumbnail timestamps: on by default. The sheet is 960x360 (6 tiles
// of 320px, 3 columns) and reports the actual capture times. The labels
// are proven on pixels, not assumed: the tile-1 label region differs
// from the no-timestamp sheet (PSNR 10.8 measured on the fixture) and
// holds near-white text (YMAX 235 vs 175 without labels).
const thumbTsRes = await client.callTool({
  name: "thumbnail",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-thumb-ts.png") },
});
const thumbTsJson = JSON.parse(thumbTsRes.content[0].text);
console.log("thumbnail timestamps call:", thumbTsJson.dimensions, "|", JSON.stringify(thumbTsJson.timestamps_seconds));
checkOk(thumbTsJson.dimensions === "960x360" && thumbTsJson.timestamps === true && JSON.stringify(thumbTsJson.timestamps_seconds) === JSON.stringify([0, 1.667, 3.333, 5, 6.667, 8.333]), "thumbnail defaults to timestamps: 960x360 sheet with tile times 0..8.333s", JSON.stringify(thumbTsJson.timestamps_seconds));
const thumbNoTsRes = await client.callTool({
  name: "thumbnail",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-thumb-nots.png"), timestamps: false },
});
const thumbNoTsJson = JSON.parse(thumbNoTsRes.content[0].text);
checkOk(thumbNoTsJson.timestamps === false && !("timestamps_seconds" in thumbNoTsJson) && thumbNoTsJson.dimensions === "960x360", "thumbnail timestamps=false: clean sheet, no tile times reported", JSON.stringify(thumbNoTsJson));
// PSNR between the same crop of two stills (Infinity when identical).
async function cropPsnr(a, b, crop) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-i", a, "-i", b, "-filter_complex", `[0:v]crop=${crop}[a];[1:v]crop=${crop}[b];[a][b]psnr`, "-f", "null", "-"]);
    const m = stderr.match(/average:\s*(inf|[0-9.]+)/);
    if (!m) return null;
    return m[1] === "inf" ? Infinity : parseFloat(m[1]);
  } catch {
    return null;
  }
}
// Same as cropPsnr but each input gets its own crop — for comparing a
// region that moved (e.g. tiles shifted down by a header band).
async function cropPsnrAsym(a, cropA, b, cropB) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-i", a, "-i", b, "-filter_complex", `[0:v]crop=${cropA}[a];[1:v]crop=${cropB}[b];[a][b]psnr`, "-f", "null", "-"]);
    const m = stderr.match(/average:\s*(inf|[0-9.]+)/);
    if (!m) return null;
    return m[1] === "inf" ? Infinity : parseFloat(m[1]);
  } catch {
    return null;
  }
}
async function regionYmax(file, crop) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-i", file, "-vf", `crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YMAX`, "-frames:v", "1", "-f", "null", "-"]);
    const m = stderr.match(/lavfi\.signalstats\.YMAX=([0-9.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}
// Mean luma of a crop (same signalstats path as regionYmax, YAVG
// instead of YMAX): proves a band is dark overall, not just that it
// contains one bright pixel.
async function regionYavg(file, crop) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-i", file, "-vf", `crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, "-frames:v", "1", "-f", "null", "-"]);
    const m = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}
const labelPsnr = await cropPsnr(path.join(root, "outputs/mcp-thumb-ts.png"), path.join(root, "outputs/mcp-thumb-nots.png"), "160:48:0:0");
checkOk(labelPsnr !== null && labelPsnr < 30, "thumbnail timestamps paint labels: tile-1 label region differs from the clean sheet", `PSNR ${labelPsnr}`);
const labelYmax = await regionYmax(path.join(root, "outputs/mcp-thumb-ts.png"), "160:48:0:0");
const cleanYmax = await regionYmax(path.join(root, "outputs/mcp-thumb-nots.png"), "160:48:0:0");
checkOk(labelYmax !== null && labelYmax >= 230 && cleanYmax !== null && cleanYmax < 200, "thumbnail label region holds white text (YMAX 235) vs content-only (175)", `ts ${labelYmax} / clean ${cleanYmax}`);

// Mean value of one colour plane of a still image (signalstats on
// the file itself — the same measurement core.js uses for grade).
async function imagePlaneMean(file, plane) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-nostdin", "-i", file, "-vf", `format=rgb24,extractplanes=${plane},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, "-frames:v", "1", "-f", "null", "-"]);
    const m = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}
// frames timestamps are now the frames' real times (lượt 69 probe:
// count 2 on a 25.878s film reported 12.939s for a shot-3 frame).
// scenes-source is red [0,5.033) then blue, so 6 frames at
// 0/1.673/3.346/5.019/6.693/8.366 must be red,red,red,blue,blue,blue:
// a capture is the first frame at-or-after its timestamp, and 5.019s
// falls between frame 150 (5.000s, red) and frame 151 (5.033s, blue),
// so blue is the correct answer there — not red.
const framesAccRes = await client.callTool({
  name: "frames",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output_dir: path.join(root, "outputs/mcp-frames-acc"), count: 6, format: "png", width: 320 },
});
const framesAccJson = JSON.parse(framesAccRes.content[0].text);
const accMeans = [];
for (const f of framesAccJson.frames) {
  accMeans.push({ r: await imagePlaneMean(f.path, "r"), b: await imagePlaneMean(f.path, "b") });
}
console.log("frames accuracy:", JSON.stringify(framesAccJson.frames.map((f) => f.timestamp_seconds)), "| R/B", JSON.stringify(accMeans));
checkOk(JSON.stringify(framesAccJson.frames.map((f) => f.timestamp_seconds)) === JSON.stringify([0, 1.673, 3.346, 5.019, 6.693, 8.366]) && framesAccJson.extracted === 6, "frames reports 6 timestamps 0..8.366 on scenes-source", JSON.stringify(framesAccJson.frames.map((f) => f.timestamp_seconds)));
checkOk(accMeans.every((m) => m.r !== null && m.b !== null) && accMeans.slice(0, 3).every((m) => m.r > 180 && m.b < 80) && accMeans.slice(3).every((m) => m.b > 180 && m.r < 80), "frames pixels match their timestamps: first 3 red, last 3 blue (5.019s falls between the red frame at 5.000s and the blue frame at 5.033s)", JSON.stringify(accMeans));
// extract_frame is frame-accurate too: t=5.5 on moving testsrc must
// be byte-identical to frame index 165 (5.5s at 30fps), not the
// keyframe at 5.033s (index 151) a bare input-seek would return.
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(root, "test/source.mp4"), "-vf", "select='eq(n\\,165)'", "-frames:v", "1", "-y", path.join(root, "outputs/mcp-ef-ref165.png")]);
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(root, "test/source.mp4"), "-vf", "select='eq(n\\,151)'", "-frames:v", "1", "-y", path.join(root, "outputs/mcp-ef-ref151.png")]);
await client.callTool({
  name: "extract_frame",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-ef-55.png"), timestamp: 5.5 },
});
const efPsnr165 = await cropPsnr(path.join(root, "outputs/mcp-ef-55.png"), path.join(root, "outputs/mcp-ef-ref165.png"), "1280:720:0:0");
const efPsnr151 = await cropPsnr(path.join(root, "outputs/mcp-ef-55.png"), path.join(root, "outputs/mcp-ef-ref151.png"), "1280:720:0:0");
checkOk(efPsnr165 === Infinity, "extract_frame t=5.5 is byte-identical to frame index 165", `PSNR vs 165: ${efPsnr165}`);
checkOk(efPsnr151 !== null && efPsnr151 < 30, "extract_frame t=5.5 is NOT the 5.033s keyframe (index 151)", `PSNR vs 151: ${efPsnr151}`);
const efPastText = await callExpectThrow("extract_frame", { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-ef-past.png"), timestamp: 99 });
checkOk(/at\/past the end/.test(efPastText ?? ""), "extract_frame refuses a timestamp past the end", efPastText ?? "");
// thumbnail start-delay: skip the first 50% of scenes-source and
// every tile lands in the blue half; the default sheet is mixed.
const thumbDelayRes = await client.callTool({
  name: "thumbnail",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-thumb-delay.png"), start_delay_percent: 50 },
});
const thumbDelayJson = JSON.parse(thumbDelayRes.content[0].text);
const delayR = await imagePlaneMean(path.join(root, "outputs/mcp-thumb-delay.png"), "r");
const delayB = await imagePlaneMean(path.join(root, "outputs/mcp-thumb-delay.png"), "b");
console.log("thumbnail delay:", JSON.stringify(thumbDelayJson.timestamps_seconds), "| sheet R/B", delayR, delayB);
checkOk(JSON.stringify(thumbDelayJson.timestamps_seconds) === JSON.stringify([5.019, 5.856, 6.693, 7.529, 8.366, 9.202]) && thumbDelayJson.window_seconds?.start === 5.019, "thumbnail start_delay 50%: window starts at 5.019s, all 6 tile times in the blue half", JSON.stringify(thumbDelayJson.timestamps_seconds));
checkOk(delayB !== null && delayB > 180 && delayR !== null && delayR < 60, "thumbnail delay sheet is blue (all tiles past the cut)", `R ${delayR} / B ${delayB}`);
const thumbMixRes = await client.callTool({
  name: "thumbnail",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-thumb-mix.png") },
});
const thumbMixJson = JSON.parse(thumbMixRes.content[0].text);
const mixR = await imagePlaneMean(path.join(root, "outputs/mcp-thumb-mix.png"), "r");
const mixB = await imagePlaneMean(path.join(root, "outputs/mcp-thumb-mix.png"), "b");
checkOk(thumbMixJson.timestamps_seconds?.[0] === 0 && mixR !== null && mixR > 120 && mixB !== null && mixB > 50, "thumbnail default on scenes-source is mixed red+blue (4 red tiles, 2 blue)", `R ${mixR} / B ${mixB}`);
const thumbDelayBadText = await callExpectThrow("thumbnail", { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-thumb-bad.png"), start_delay_percent: 60, end_delay_percent: 60 });
checkOk(/must leave a window/.test(thumbDelayBadText ?? ""), "thumbnail refuses start+end delays that leave no window", thumbDelayBadText ?? "");
// Partial grid: 5 frames in a 3x2 grid pads the last cell black
// instead of emitting nothing.
const thumbPartRes = await client.callTool({
  name: "thumbnail",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-thumb-part.png"), frames: 5, timestamps: false },
});
const thumbPartJson = JSON.parse(thumbPartRes.content[0].text);
checkOk(thumbPartJson.dimensions === "960x360" && thumbPartJson.rows === 2, "thumbnail 5 frames pads to a full 3x2 sheet (960x360)", JSON.stringify(thumbPartJson.dimensions));

// thumbnail --header (lượt 71; vcsi idea from lượt 70): a metadata
// band on top — filename, measured duration, resolution, fps, codecs,
// size, grid — so a forwarded sheet still says which file it came
// from. The sheet grows by exactly the 68px band; the tiles below
// must be byte-identical to the headerless sheet.
const thumbHdrRes = await client.callTool({
  name: "thumbnail",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-thumb-hdr.png"), header: true },
});
const thumbHdrJson = JSON.parse(thumbHdrRes.content[0].text);
console.log("thumbnail header:", thumbHdrJson.dimensions, "|", JSON.stringify(thumbHdrJson.header_lines));
checkOk(thumbHdrJson.dimensions === "960x428" && thumbHdrJson.header === true, "thumbnail header=true: sheet grows 960x360 -> 960x428 (68px band)", JSON.stringify(thumbHdrJson.dimensions));
checkOk(thumbHdrJson.header_lines?.[0] === "source.mp4 | 10s | 1280x720 | 30 fps" && thumbHdrJson.header_lines?.[1] === "video h264 | audio aac 1ch | 0.2 MB | 6 frames 3x2", "thumbnail header lines report filename, duration, resolution, fps, codecs, size, grid", JSON.stringify(thumbHdrJson.header_lines));
const hdrYmax = await regionYmax(path.join(root, "outputs/mcp-thumb-hdr.png"), "960:68:0:0");
const hdrYavg = await regionYavg(path.join(root, "outputs/mcp-thumb-hdr.png"), "960:68:0:0");
checkOk(hdrYmax !== null && hdrYmax >= 230, "thumbnail header band holds white text (YMAX >= 230)", `YMAX ${hdrYmax}`);
checkOk(hdrYavg !== null && hdrYavg < 60, "thumbnail header band is dark overall (YAVG < 60 on the #111111 strip)", `YAVG ${hdrYavg}`);
const hdrTilesPsnr = await cropPsnrAsym(path.join(root, "outputs/mcp-thumb-hdr.png"), "960:360:0:68", path.join(root, "outputs/mcp-thumb-ts.png"), "960:360:0:0");
checkOk(hdrTilesPsnr === Infinity, "thumbnail header leaves the tiles byte-identical (vstack only adds the band)", `PSNR tiles vs headerless: ${hdrTilesPsnr}`);
const thumbHdrCliJson = await runCliJson(["thumbnail", path.join(root, "test/source.mp4"), "-o", path.join(root, "outputs/mcp-thumb-hdr-cli.png"), "--header"], {});
checkOk(thumbHdrCliJson.dimensions === "960x428" && thumbHdrCliJson.header === true, "CLI thumbnail --header works", JSON.stringify(thumbHdrCliJson.dimensions));

// Manual timestamps + sharpest frames (lượt 72; vcsi `-m` +
// select_sharpest_images ideas from lượt 70). Fixture
// test/sharpness-source.mp4 is testsrc2, 10s: the first 5s sharp,
// the last 5s boxblur=10 — so the sharpest frame in window [0,5)
// must score several times the sharpest in [5,10).
const sharpFramesRes = await client.callTool({
  name: "frames",
  arguments: { input: path.join(root, "test/sharpness-source.mp4"), output_dir: path.join(root, "outputs/mcp-frames-sharp"), count: 2, sharpest: true },
});
const sharpFramesJson = JSON.parse(sharpFramesRes.content[0].text);
console.log("frames --sharpest:", JSON.stringify(sharpFramesJson.frames.map((f) => `${f.timestamp_seconds}s sharp=${f.sharpness}`)));
checkOk(sharpFramesJson.sharpest === true && sharpFramesJson.sharpest_samples === 5 && sharpFramesJson.frames.length === 2, "frames sharpest=true reports the flag and 2 frames", JSON.stringify(sharpFramesJson.sharpest));
checkOk(sharpFramesJson.frames[0].timestamp_seconds >= 0 && sharpFramesJson.frames[0].timestamp_seconds < 5 && sharpFramesJson.frames[1].timestamp_seconds >= 5 && sharpFramesJson.frames[1].timestamp_seconds < 10, "frames --sharpest picks one frame per window ([0,5) and [5,10))", JSON.stringify(sharpFramesJson.frames.map((f) => f.timestamp_seconds)));
checkOk(sharpFramesJson.frames[0].sharpness > 2 && sharpFramesJson.frames[1].sharpness < 1 && sharpFramesJson.frames[0].sharpness > 3 * sharpFramesJson.frames[1].sharpness, "frames --sharpest: sharp half scores >3x the blurred half (Laplacian mean, measured on disk)", JSON.stringify(sharpFramesJson.frames.map((f) => f.sharpness)));
checkOk(JSON.stringify(sharpFramesJson.frames[0].window_seconds) === JSON.stringify({ start: 0, end: 5 }) && JSON.stringify(sharpFramesJson.frames[1].window_seconds) === JSON.stringify({ start: 5, end: 10 }), "frames --sharpest reports each frame's window", JSON.stringify(sharpFramesJson.frames.map((f) => f.window_seconds)));
// Regression: without --sharpest the contract is unchanged —
const plainFramesRes = await client.callTool({
  name: "frames",
  arguments: { input: path.join(root, "test/sharpness-source.mp4"), output_dir: path.join(root, "outputs/mcp-frames-plain"), count: 2 },
});
const plainFramesJson = JSON.parse(plainFramesRes.content[0].text);
checkOk(plainFramesJson.sharpest === undefined && plainFramesJson.frames[0].timestamp_seconds === 0 && plainFramesJson.frames[1].timestamp_seconds === 5 && plainFramesJson.frames[0].sharpness === undefined, "frames without --sharpest keeps the old contract (window starts, no sharpness key)", JSON.stringify(plainFramesJson.frames.map((f) => f.timestamp_seconds)));
// thumbnail --timestamps-list: two exact times on scenes-source
// (red 5s + blue 5s) — tile 1 red, tile 2 blue, sheet 960x180.
const thumbManualRes = await client.callTool({
  name: "thumbnail",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-thumb-manual.png"), timestamps_list: [1, 6] },
});
const thumbManualJson = JSON.parse(thumbManualRes.content[0].text);
const manR = await imagePlaneMean(path.join(root, "outputs/mcp-thumb-manual.png"), "r");
const manB = await imagePlaneMean(path.join(root, "outputs/mcp-thumb-manual.png"), "b");
console.log("thumbnail manual:", JSON.stringify(thumbManualJson.timestamps_seconds), "| sheet R/B", manR, manB);
checkOk(JSON.stringify(thumbManualJson.timestamps_seconds) === JSON.stringify([1, 6]) && thumbManualJson.manual_timestamps === true && thumbManualJson.dimensions === "960x180" && !("window_seconds" in thumbManualJson), "thumbnail timestamps_list [1,6]: exact tile times, 2 tiles, no sampling window", JSON.stringify(thumbManualJson.timestamps_seconds));
checkOk(manR !== null && manR > 60 && manB !== null && manB > 60 && Math.abs(manR - manB) < 30, "thumbnail manual sheet is half red (t=1) half blue (t=6) — a third of the sheet is the black-padded empty cell, so each channel means ~83", `R ${manR} / B ${manB}`);
const thumbManualBad = await callExpectThrow("thumbnail", { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-thumb-manual-bad.png"), timestamps_list: [1, 99] });
checkOk(/at\/past the end/.test(thumbManualBad ?? ""), "thumbnail timestamps_list refuses a time past the end", thumbManualBad ?? "");
const thumbManualClash = await callExpectThrow("thumbnail", { input: path.join(root, "test/scenes-source.mp4"), output: path.join(root, "outputs/mcp-thumb-manual-clash.png"), timestamps_list: [1, 6], start_delay_percent: 10 });
checkOk(/cannot be combined/.test(thumbManualClash ?? ""), "thumbnail timestamps_list refuses the delay percents", thumbManualClash ?? "");
// thumbnail --sharpest: same fixture, 2 tiles — sharp tile first.
const thumbSharpRes = await client.callTool({
  name: "thumbnail",
  arguments: { input: path.join(root, "test/sharpness-source.mp4"), output: path.join(root, "outputs/mcp-thumb-sharp.png"), frames: 2, sharpest: true },
});
const thumbSharpJson = JSON.parse(thumbSharpRes.content[0].text);
console.log("thumbnail sharpest:", JSON.stringify(thumbSharpJson.timestamps_seconds), JSON.stringify(thumbSharpJson.sharpness));
checkOk(thumbSharpJson.sharpest === true && thumbSharpJson.timestamps_seconds[0] >= 0 && thumbSharpJson.timestamps_seconds[0] < 5 && thumbSharpJson.timestamps_seconds[1] >= 5 && thumbSharpJson.timestamps_seconds[1] < 10, "thumbnail --sharpest picks one tile per window", JSON.stringify(thumbSharpJson.timestamps_seconds));
checkOk(thumbSharpJson.sharpness[0] > 2 && thumbSharpJson.sharpness[1] < 1 && thumbSharpJson.sharpness[0] > 3 * thumbSharpJson.sharpness[1], "thumbnail --sharpest: sharp tile scores >3x the blurred tile", JSON.stringify(thumbSharpJson.sharpness));
const sharpSamplesBad = await callExpectThrow("frames", { input: path.join(root, "test/sharpness-source.mp4"), output_dir: path.join(root, "outputs/mcp-frames-sharp-bad"), count: 2, sharpest: true, sharpest_samples: 1 });
checkOk(/greater than or equal to 2/.test(sharpSamplesBad ?? ""), "frames rejects sharpest_samples below 2 (MCP validation)", sharpSamplesBad?.slice(0, 160) ?? "");
// CLI: frames --sharpest + thumbnail --timestamps-list with MM:SS.
const sharpCliJson = await runCliJson(["frames", path.join(root, "test/sharpness-source.mp4"), "-o", path.join(root, "outputs/mcp-frames-sharp-cli"), "--count", "2", "--sharpest"], {});
checkOk(sharpCliJson.sharpest === true && sharpCliJson.frames[0].sharpness > 3 * sharpCliJson.frames[1].sharpness, "CLI frames --sharpest works", JSON.stringify(sharpCliJson.frames.map((f) => f.sharpness)));
const manualCliJson = await runCliJson(["thumbnail", path.join(root, "test/scenes-source.mp4"), "-o", path.join(root, "outputs/mcp-thumb-manual-cli.png"), "--timestamps-list", "0:01,0:06"], {});
checkOk(JSON.stringify(manualCliJson.timestamps_seconds) === JSON.stringify([1, 6]) && manualCliJson.manual_timestamps === true, "CLI thumbnail --timestamps-list accepts MM:SS", JSON.stringify(manualCliJson.timestamps_seconds));

// qa_report on the raw 10s fixture, target any: loudness -21.8 LUFS
// fails the -16..-12 band, pacing warns (1 shot of 10s), content is
// clean, true peak passes.
const qaRawRes = await client.callTool({
  name: "qa_report",
  arguments: { input: path.join(root, "test/source.mp4"), target: "any" },
});
const qaRawJson = JSON.parse(qaRawRes.content[0].text);
console.log("qa_report raw/any:", qaRawJson.verdict, "|", qaRawJson.checks.map((c) => `${c.check}:${c.status}`).join(" "));
checkOk(qaRawJson.verdict === "fail" && qaOf(qaRawJson, "loudness")?.status === "fail" && qaOf(qaRawJson, "pacing")?.status === "warn" && qaOf(qaRawJson, "black_frames")?.status === "pass" && qaOf(qaRawJson, "frozen_frames")?.status === "pass" && qaOf(qaRawJson, "dead_air")?.status === "pass", "qa_report raw source: fail on loudness, warn on pacing, content clean", JSON.stringify(qaRawJson.checks));
checkOk(near(qaRawJson.file.loudness_lufs, -21.8, 0.2) && qaRawJson.file.dimensions === "1280x720" && qaRawJson.file.pixel_format === "yuv420p", "qa_report file summary: LUFS -21.8, 1280x720, yuv420p", JSON.stringify(qaRawJson.file));
// Expected duration + platform target: 5s expected on a 10s file
// fails; tiktok on the 1280x720 source fails dimensions + aspect.
const qaExpRes = await client.callTool({
  name: "qa_report",
  arguments: { input: path.join(root, "test/source.mp4"), target: "any", expected_duration: 5 },
});
const qaExpJson = JSON.parse(qaExpRes.content[0].text);
checkOk(qaExpJson.verdict === "fail" && qaOf(qaExpJson, "expected_duration")?.status === "fail", "qa_report expected_duration 5s fails on a 10s file", JSON.stringify(qaOf(qaExpJson, "expected_duration")));
const qaTikRes = await client.callTool({
  name: "qa_report",
  arguments: { input: path.join(root, "test/source.mp4"), target: "tiktok" },
});
const qaTikJson = JSON.parse(qaTikRes.content[0].text);
checkOk(qaTikJson.verdict === "fail" && qaOf(qaTikJson, "aspect_ratio")?.status === "fail" && qaOf(qaTikJson, "platform_length")?.status === "pass", "qa_report tiktok on 1280x720: aspect fails, length passes", JSON.stringify(qaTikJson.checks.map((c) => `${c.check}:${c.status}`)));
// Audio-only clipping file: no video + true peak over 0 dBFS -> fail.
const qaPeakRes = await client.callTool({
  name: "qa_report",
  arguments: { input: path.join(root, "test/loud-peak.wav"), target: "any" },
});
const qaPeakJson = JSON.parse(qaPeakRes.content[0].text);
checkOk(qaPeakJson.verdict === "fail" && qaOf(qaPeakJson, "has_video")?.status === "fail" && qaOf(qaPeakJson, "true_peak")?.status === "fail" && qaPeakJson.file.true_peak_db > 0, "qa_report loud-peak.wav: fail, no video, true peak over 0 dBTP (clipping)", JSON.stringify(qaPeakJson.file));
// Black mid-file fixture: black warns, frozen fails (black frames
// are frozen too), pacing passes on the 1-cut scenes fixture even
// though its solid colours warn as frozen.
const qaBlackRes = await client.callTool({
  name: "qa_report",
  arguments: { input: path.join(root, "test/content-black.mp4"), target: "any" },
});
const qaBlackJson = JSON.parse(qaBlackRes.content[0].text);
checkOk(qaOf(qaBlackJson, "black_frames")?.status === "warn" && qaOf(qaBlackJson, "frozen_frames")?.status === "fail", "qa_report content-black: black warns, frozen fails", JSON.stringify(qaBlackJson.checks.map((c) => `${c.check}:${c.status}`)));
const qaScenesRes = await client.callTool({
  name: "qa_report",
  arguments: { input: path.join(root, "test/scenes-source.mp4"), target: "any" },
});
const qaScenesJson = JSON.parse(qaScenesRes.content[0].text);
checkOk(qaOf(qaScenesJson, "pacing")?.status === "pass", "qa_report scenes-source: pacing passes (1 cut, avg shot ~5s)", JSON.stringify(qaOf(qaScenesJson, "pacing")));
const qaBadTarget = await callExpectThrow("qa_report", { input: path.join(root, "test/source.mp4"), target: "nosuch" });
checkOk(/Invalid enum value/.test(qaBadTarget) && /nosuch/.test(qaBadTarget), "qa_report rejects an unknown target (MCP enum validation)", qaBadTarget.slice(0, 160));
// Full pass: red 5s + testsrc 3s + blue 5s — the two hard cuts (at 5s
// and 8s, measured by scenes) give 3 shots averaging 4.3s — then
// loudness to -14, then the gate must be all pass. (source + source2
// do NOT work here: source2 is a downscale of the same testsrc, so
// its joins score below the scene threshold and pacing warns.)
const qaConcatRes = await client.callTool({
  name: "concat",
  arguments: {
    inputs: [
      { file: path.join(root, "test/scenes-source.mp4"), start: 0, end: 5 },
      { file: path.join(root, "test/source.mp4"), start: 0, end: 3 },
      { file: path.join(root, "test/scenes-source.mp4"), start: 5, end: 10 },
    ],
    output: path.join(root, "outputs/mcp-qa-concat.mp4"),
  },
});
const qaConcatJson = JSON.parse(qaConcatRes.content[0].text);
checkOk(near(qaConcatJson.duration_seconds, 13, 0.1), "qa_report pass-case: 3-shot concat is 13s", `got ${qaConcatJson.duration_seconds}s`);
const qaLoudRes = await client.callTool({
  name: "loudness",
  arguments: { input: path.join(root, "outputs/mcp-qa-concat.mp4"), output: path.join(root, "outputs/mcp-qa-loud.mp4"), target_lufs: -14 },
});
const qaLoudJson = JSON.parse(qaLoudRes.content[0].text);
checkOk(near(qaLoudJson.duration_seconds, 13, 0.1), "qa_report pass-case: loudness keeps 13s", `got ${qaLoudJson.duration_seconds}s`);
const qaPassRes = await client.callTool({
  name: "qa_report",
  arguments: { input: path.join(root, "outputs/mcp-qa-loud.mp4"), target: "any", expected_duration: 13 },
});
const qaPassJson = JSON.parse(qaPassRes.content[0].text);
console.log("qa_report pass-case:", qaPassJson.verdict, "|", qaPassJson.checks.map((c) => `${c.check}:${c.status}`).join(" "));
checkOk(qaPassJson.verdict === "pass" && qaPassJson.checks.every((c) => c.status === "pass"), "qa_report pass-case: 3-shot -14 LUFS clip passes every check", JSON.stringify(qaPassJson.checks));

// manifest: one JSON file drives a whole pipeline — trim 2-8s,
// reframe blur to 1080x1920, loudness -14 — then qa_report tiktok
// on the result (fixture test/manifest.json). A second identical
// run must serve every step from the content-hash cache; --dry-run
// plans without writing; a bad tool/arg/version fails up front,
// before step 1 renders.
async function sha256File(file) {
  const buf = await readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}
await rm(path.join(root, "outputs/mcp-manifest.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const manifestDryRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest.json"), dry_run: true },
});
const manifestDryJson = JSON.parse(manifestDryRes.content[0].text);
checkOk(manifestDryJson.dry_run === true && manifestDryJson.steps.length === 3 && manifestDryJson.steps.every((s) => s.status === "planned") && near(manifestDryJson.input_duration_seconds, 10, 0.01), "manifest dry-run plans 3 steps, no run", JSON.stringify(manifestDryJson.steps.map((s) => s.status)));
checkOk(!existsSync(path.join(root, "outputs/mcp-manifest.mp4")), "manifest dry-run writes no output file", "outputs/mcp-manifest.mp4 exists");
const manifestRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest.json") },
});
const manRunJson = JSON.parse(manifestRes.content[0].text);
console.log("manifest:", manRunJson.steps.map((s) => `${s.tool}:${s.status}`).join(" "), "| final", manRunJson.final.dimensions, manRunJson.final.duration_seconds + "s", "| qa", manRunJson.qa_result?.verdict);
checkOk(manRunJson.steps.every((s) => s.status === "ok") && manRunJson.cache_hits === 0 && manRunJson.steps_run === 3, "manifest runs all 3 steps (trim, reframe, loudness)", JSON.stringify(manRunJson.steps.map((s) => s.status)));
checkOk(near(manRunJson.final.duration_seconds, 6.1, 0.2) && manRunJson.final.dimensions === "1080x1920" && manRunJson.final.size_bytes > 0, "manifest final is 6.1s 1080x1920 with real bytes", JSON.stringify(manRunJson.final));
checkOk(manRunJson.steps[0].result?.duration_actual === 6, "manifest trim step reports 6s on disk", JSON.stringify(manRunJson.steps[0].result?.duration_actual));
const manifestLufs = await measureLufs(path.join(root, "outputs/mcp-manifest.mp4"));
checkOk(near(manifestLufs, -14, 0.5), "manifest loudness step measures -14 LUFS independently", `got ${manifestLufs}`);
// Pacing is a knife-edge here by construction: the manifest film
// is 6.1s in a single shot, and the rule warns when the average
// shot exceeds 6s — so one spurious scene cut on another build
// (the CI apt ffmpeg found one; local 8.1.2 finds none) flips the
// check from warn to pass, and the verdict with it (CI run 1 of
// lượt 101 failed the old `pacing === "warn"`). Assert the RULE,
// not the detector count: the pacing status must match the average
// shot length its own detail reports, loudness must pass, nothing
// may fail, and the verdict must be the worst check status.
const pacingCheck = qaOf(manRunJson.qa_result, "pacing");
const pacingDetail = /average shot ([0-9.]+)s over (\d+) shot/.exec(pacingCheck?.detail ?? "");
const pacingAvg = pacingDetail ? Number(pacingDetail[1]) : null;
checkOk(manRunJson.qa_result && ["warn", "pass"].includes(manRunJson.qa_result.verdict) && qaOf(manRunJson.qa_result, "loudness")?.status === "pass" && ["warn", "pass"].includes(pacingCheck?.status ?? "") && pacingAvg !== null && pacingCheck.status === (pacingAvg <= 6 ? "pass" : "warn") && manRunJson.qa_result.checks.every((c) => c.status !== "fail") && manRunJson.qa_result.verdict === (manRunJson.qa_result.checks.some((c) => c.status === "warn") ? "warn" : "pass"), "manifest qa gate: loudness passes, pacing status matches its measured average shot length, verdict is the worst check status", JSON.stringify(manRunJson.qa_result?.checks.map((c) => `${c.check}:${c.status}`)));
const manifestHashBefore = await sha256File(path.join(root, "outputs/mcp-manifest.mp4"));
const manifestCachedRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest.json") },
});
const manifestCachedJson = JSON.parse(manifestCachedRes.content[0].text);
checkOk(manifestCachedJson.cache_hits === 3 && manifestCachedJson.steps_run === 0 && manifestCachedJson.steps.every((s) => s.status === "cached"), "manifest second run serves all 3 steps from the content-hash cache", `cache_hits=${manifestCachedJson.cache_hits} steps_run=${manifestCachedJson.steps_run}`);
checkOk((await sha256File(path.join(root, "outputs/mcp-manifest.mp4"))) === manifestHashBefore, "manifest cache hit leaves the output bytes untouched", "sha256 moved");
const manifestNoCacheRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest.json"), cache: false },
});
const manifestNoCacheJson = JSON.parse(manifestNoCacheRes.content[0].text);
checkOk(manifestNoCacheJson.cache_hits === 0 && manifestNoCacheJson.steps_run === 3, "manifest cache=false re-runs every step", `cache_hits=${manifestNoCacheJson.cache_hits} steps_run=${manifestNoCacheJson.steps_run}`);
const manifestBadToolPath = path.join(root, "outputs/mcp-manifest-badtool.json");
await writeFile(manifestBadToolPath, JSON.stringify({ version: 1, input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-manifest-badtool.mp4"), steps: [{ tool: "nosuchtool", args: {} }] }), "utf8");
const manifestBadToolText = await callExpectThrow("manifest", { manifest_path: manifestBadToolPath });
checkOk(/unknown tool/.test(manifestBadToolText) && /nosuchtool/.test(manifestBadToolText), "manifest refuses an unknown step tool by name, before rendering", manifestBadToolText.slice(0, 160));
const manifestBadArgPath = path.join(root, "outputs/mcp-manifest-badarg.json");
await writeFile(manifestBadArgPath, JSON.stringify({ version: 1, input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-manifest-badarg.mp4"), steps: [{ tool: "trim", args: { bogus: 1 } }] }), "utf8");
const manifestBadArgText = await callExpectThrow("manifest", { manifest_path: manifestBadArgPath });
checkOk(/does not take argument/.test(manifestBadArgText) && /bogus/.test(manifestBadArgText), "manifest refuses an unknown step argument by name, before rendering", manifestBadArgText.slice(0, 160));
const manifestBadVersionPath = path.join(root, "outputs/mcp-manifest-badversion.json");
await writeFile(manifestBadVersionPath, JSON.stringify({ version: 2, input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-manifest-badversion.mp4"), steps: [{ tool: "trim", args: { start: 1 } }] }), "utf8");
const manifestBadVersionText = await callExpectThrow("manifest", { manifest_path: manifestBadVersionPath });
checkOk(/version must be 1/.test(manifestBadVersionText), "manifest refuses version 2", manifestBadVersionText.slice(0, 160));
const manifestMissingText = await callExpectThrow("manifest", { manifest_path: path.join(root, "test/no-such-manifest.json") });
checkOk(/not found/.test(manifestMissingText), "manifest with a missing file errors instead of planning", manifestMissingText.slice(0, 160));
// manifest cut_words step (lượt 38, fixture test/manifest-cutwords.json):
// cut um/uh first, then loudness — the words file resolves relative
// to the manifest, is hashed into the step cache, and a second run
// serves both steps from cache.
await rm(path.join(root, "outputs/mcp-manifest-cw.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const manifestCwRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-cutwords.json") },
});
const manifestCwJson = JSON.parse(manifestCwRes.content[0].text);
checkOk(manifestCwJson.steps.every((s) => s.status === "ok") && manifestCwJson.steps_run === 2 && manifestCwJson.steps[0].result?.removed_count === 2, "manifest cut_words step removes um+uh, loudness step follows", JSON.stringify(manifestCwJson.steps.map((s) => `${s.tool}:${s.status}`)));
checkOk(near(manifestCwJson.final.duration_seconds, 3.48, 0.05), "manifest cut_words final is 3.48s", JSON.stringify(manifestCwJson.final));
const manifestCwLufs = await measureLufs(path.join(root, "outputs/mcp-manifest-cw.mp4"));
checkOk(near(manifestCwLufs, -14, 0.5), "manifest cut_words + loudness final measures -14 LUFS independently", `got ${manifestCwLufs}`);
const manifestCwCachedRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-cutwords.json") },
});
const manifestCwCachedJson = JSON.parse(manifestCwCachedRes.content[0].text);
checkOk(manifestCwCachedJson.cache_hits === 2 && manifestCwCachedJson.steps_run === 0, "manifest cut_words second run serves both steps from cache", `cache_hits=${manifestCwCachedJson.cache_hits} steps_run=${manifestCwCachedJson.steps_run}`);
// manifest remove_retakes step (fixture test/manifest-retakes.json):
// cut the repeated takes first, then loudness — the words file
// resolves relative to the manifest and is hashed into the step
// cache, so a second run serves both steps from cache.
await rm(path.join(root, "outputs/mcp-manifest-rt.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const manifestRtRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-retakes.json") },
});
const manifestRtJson = JSON.parse(manifestRtRes.content[0].text);
checkOk(manifestRtJson.steps.every((s) => s.status === "ok") && manifestRtJson.steps_run === 2 && manifestRtJson.steps[0].result?.removed_count === 10, "manifest remove_retakes step cuts 10 words, loudness step follows", JSON.stringify(manifestRtJson.steps.map((s) => `${s.tool}:${s.status}`)));
checkOk(near(manifestRtJson.final.duration_seconds, 5.74, 0.05), "manifest remove_retakes final is 5.74s", JSON.stringify(manifestRtJson.final));
const manifestRtLufs = await measureLufs(path.join(root, "outputs/mcp-manifest-rt.mp4"));
checkOk(near(manifestRtLufs, -14, 0.5), "manifest remove_retakes + loudness final measures -14 LUFS independently", `got ${manifestRtLufs}`);
const manifestRtCachedRes = await client.callTool({
  name: "manifest",
  arguments: { manifest_path: path.join(root, "test/manifest-retakes.json") },
});
const manifestRtCachedJson = JSON.parse(manifestRtCachedRes.content[0].text);
checkOk(manifestRtCachedJson.cache_hits === 2 && manifestRtCachedJson.steps_run === 0, "manifest remove_retakes second run serves both steps from cache", `cache_hits=${manifestRtCachedJson.cache_hits} steps_run=${manifestRtCachedJson.steps_run}`);
// manifest chroma_key background (lượt 40): the background image is
// a sidecar file — its bytes belong in the step cache key, so
// editing the image re-runs the step (a hex background is already in
// args and must NOT be resolved as a file path). The corner of the
// composite is the background itself, so swapping red -> blue must
// move the corner B mean from ~0 to ~255.
const chromaDir = path.join(root, "outputs/mcp-manifest-chroma");
// Hermetic: the manifest cache lives under this dir and survives
// across suite runs — without the wipe, the first run is served
// from the previous run's cache and the "runs the step" assert
// fails (same trap as the batch cache fix in lượt 29).
await rm(chromaDir, { recursive: true, force: true });
await mkdir(chromaDir, { recursive: true });
const chromaManifestPath = path.join(chromaDir, "manifest.json");
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0xFF0000:s=1280x720", "-frames:v", "1", "-y", path.join(chromaDir, "bg.png")]);
await writeFile(chromaManifestPath, JSON.stringify({ version: 1, input: "../../test/greenscreen.mp4", output: "final.mp4", steps: [{ tool: "chroma_key", args: { background: "bg.png" } }] }), "utf8");
const manifestChromaRes = await client.callTool({ name: "manifest", arguments: { manifest_path: chromaManifestPath } });
const manifestChromaJson = JSON.parse(manifestChromaRes.content[0].text);
checkOk(manifestChromaJson.steps.every((s) => s.status === "ok") && manifestChromaJson.cache_hits === 0 && manifestChromaJson.steps_run === 1, "manifest chroma_key with an image background runs the step", JSON.stringify(manifestChromaJson.steps.map((s) => `${s.tool}:${s.status}`)));
const chromaCornerRed = await planeMean(path.join(chromaDir, "final.mp4"), "160:90:0:0", "b");
checkOk(chromaCornerRed !== null && chromaCornerRed < 20, "manifest chroma_key red background shows in the corner (B ~0)", `B=${chromaCornerRed}`);
const manifestChromaCachedRes = await client.callTool({ name: "manifest", arguments: { manifest_path: chromaManifestPath } });
const manifestChromaCachedJson = JSON.parse(manifestChromaCachedRes.content[0].text);
checkOk(manifestChromaCachedJson.cache_hits === 1 && manifestChromaCachedJson.steps_run === 0, "manifest chroma_key second run serves the step from cache", `cache_hits=${manifestChromaCachedJson.cache_hits} steps_run=${manifestChromaCachedJson.steps_run}`);
// Edit the background image (same path, new bytes): the cache key
// must change, so the step re-runs and the corner turns blue.
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x0000FF:s=1280x720", "-frames:v", "1", "-y", path.join(chromaDir, "bg.png")]);
const manifestChromaEditedRes = await client.callTool({ name: "manifest", arguments: { manifest_path: chromaManifestPath } });
const manifestChromaEditedJson = JSON.parse(manifestChromaEditedRes.content[0].text);
checkOk(manifestChromaEditedJson.cache_hits === 0 && manifestChromaEditedJson.steps_run === 1, "manifest chroma_key re-runs the step after the background image changes", `cache_hits=${manifestChromaEditedJson.cache_hits} steps_run=${manifestChromaEditedJson.steps_run}`);
const chromaCornerBlue = await planeMean(path.join(chromaDir, "final.mp4"), "160:90:0:0", "b");
checkOk(chromaCornerBlue !== null && chromaCornerBlue > 200, "manifest chroma_key edited background shows in the corner (B ~255)", `B=${chromaCornerBlue}`);
// Hex background: a color, not a file — it must not be resolved
// relative to the manifest, and a second run must hit the cache.
const chromaHexManifestPath = path.join(chromaDir, "manifest-hex.json");
await writeFile(chromaHexManifestPath, JSON.stringify({ version: 1, input: "../../test/greenscreen.mp4", output: "final-hex.mp4", steps: [{ tool: "chroma_key", args: { background: "1E40AF" } }] }), "utf8");
const manifestChromaHexRes = await client.callTool({ name: "manifest", arguments: { manifest_path: chromaHexManifestPath } });
const manifestChromaHexJson = JSON.parse(manifestChromaHexRes.content[0].text);
checkOk(manifestChromaHexJson.steps.every((s) => s.status === "ok") && manifestChromaHexJson.steps_run === 1, "manifest chroma_key with a hex background runs (color, not a file path)", JSON.stringify(manifestChromaHexJson.steps.map((s) => `${s.tool}:${s.status}`)));
const manifestChromaHexCachedRes = await client.callTool({ name: "manifest", arguments: { manifest_path: chromaHexManifestPath } });
const manifestChromaHexCachedJson = JSON.parse(manifestChromaHexCachedRes.content[0].text);
checkOk(manifestChromaHexCachedJson.cache_hits === 1 && manifestChromaHexCachedJson.steps_run === 0, "manifest chroma_key hex background second run hits the cache", `cache_hits=${manifestChromaHexCachedJson.cache_hits} steps_run=${manifestChromaHexCachedJson.steps_run}`);
// manifest slideshow (lượt 49, fixture test/manifest-slideshow.json):
// slideshow may only be step 1 — it builds from images in args,
// so the manifest input is the first slide image. Slideshow (3 x 2s
// = 6s) then trim to 4s. A second run serves both steps from cache;
// editing one slide re-runs the slideshow step (image bytes are in
// the cache key) and the trim after it.
await rm(path.join(root, "outputs/mcp-manifest-slideshow.mp4"), { force: true });
await rm(path.join(root, "outputs/.mediakit-manifest-cache"), { recursive: true, force: true });
const manifestSlideDryRes = await client.callTool({ name: "manifest", arguments: { manifest_path: path.join(root, "test/manifest-slideshow.json"), dry_run: true } });
const manifestSlideDryJson = JSON.parse(manifestSlideDryRes.content[0].text);
checkOk(manifestSlideDryJson.dry_run === true && manifestSlideDryJson.steps.length === 2 && manifestSlideDryJson.steps[0].tool === "slideshow" && manifestSlideDryJson.steps[0].output.endsWith(".mp4"), "manifest slideshow dry-run plans slideshow then trim", JSON.stringify(manifestSlideDryJson.steps.map((s) => s.tool)));
checkOk(!existsSync(path.join(root, "outputs/mcp-manifest-slideshow.mp4")), "manifest slideshow dry-run writes no output file", "outputs/mcp-manifest-slideshow.mp4 exists");
const manifestSlideRes = await client.callTool({ name: "manifest", arguments: { manifest_path: path.join(root, "test/manifest-slideshow.json") } });
const manifestSlideJson = JSON.parse(manifestSlideRes.content[0].text);
checkOk(manifestSlideJson.steps.every((s) => s.status === "ok") && manifestSlideJson.cache_hits === 0 && manifestSlideJson.steps_run === 2, "manifest slideshow runs slideshow + trim", JSON.stringify(manifestSlideJson.steps.map((s) => `${s.tool}:${s.status}`)));
checkOk(near(manifestSlideJson.final.duration_seconds, 4, 0.05) && manifestSlideJson.final.dimensions === "1280x720", "manifest slideshow final is 4s 1280x720", JSON.stringify(manifestSlideJson.final));
const manifestSlideCachedRes = await client.callTool({ name: "manifest", arguments: { manifest_path: path.join(root, "test/manifest-slideshow.json") } });
const manifestSlideCachedJson = JSON.parse(manifestSlideCachedRes.content[0].text);
checkOk(manifestSlideCachedJson.cache_hits === 2 && manifestSlideCachedJson.steps_run === 0, "manifest slideshow second run serves both steps from cache", `cache_hits=${manifestSlideCachedJson.cache_hits} steps_run=${manifestSlideCachedJson.steps_run}`);
// Edit one slide (same path, new bytes): the slideshow step must
// re-run. A blue slide's corner turns red in the final frame's
// top-left — the trim step's input changed too, so it re-runs.
const slideBluePath = path.join(root, "test/slide-blue.png");
const slideBlueBefore = await readFile(slideBluePath);
await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0xFF0000:s=640x360", "-frames:v", "1", "-y", slideBluePath]);
const manifestSlideEditedRes = await client.callTool({ name: "manifest", arguments: { manifest_path: path.join(root, "test/manifest-slideshow.json") } });
const manifestSlideEditedJson = JSON.parse(manifestSlideEditedRes.content[0].text);
checkOk(manifestSlideEditedJson.cache_hits === 0 && manifestSlideEditedJson.steps_run === 2, "manifest slideshow re-runs both steps after a slide image changes", `cache_hits=${manifestSlideEditedJson.cache_hits} steps_run=${manifestSlideEditedJson.steps_run}`);
await writeFile(slideBluePath, slideBlueBefore);
// slideshow as step 2 is refused at validation, before rendering.
const manifestSlideStep2Path = path.join(root, "outputs/mcp-manifest-slideshow-step2.json");
await writeFile(manifestSlideStep2Path, JSON.stringify({ version: 1, input: path.join(root, "test/logo.png"), output: path.join(root, "outputs/mcp-manifest-slideshow-step2.mp4"), steps: [{ tool: "trim", args: { start: 0, end: 1 } }, { tool: "slideshow", args: { images: [path.join(root, "test/logo.png"), path.join(root, "test/kenburns.png")], duration: 2 } }] }), "utf8");
const manifestSlideStep2Text = await callExpectThrow("manifest", { manifest_path: manifestSlideStep2Path });
checkOk(/must be the first step/.test(manifestSlideStep2Text), "manifest refuses slideshow as step 2", manifestSlideStep2Text.slice(0, 160));

// Stage a film manifest into a fresh per-run directory
// (pid-suffixed) with absolute asset paths, so two suite runs
// never share a cache dir, approval file, or output dir. The
// assemble cache lives next to the manifest, and the suite used
// to run straight off test/*.json — when my run and the 15:25
// cron run overlapped on 2026-11-13, each wiped the other's
// test/.mediakit-assemble-cache mid-suite and exactly one
// cache_hits assert failed in each run. Staging makes every run
// hermetic by construction.
async function stageAssembleManifest(name) {
  // Lượt 99: a per-call counter, so two stagings of the same fixture
  // never share a directory — the old name-only dir meant staging B
  // rm -rf'd A's manifest while A's async worker was still about to
  // read it, and the worker failed with "cannot read manifest".
  stageAssembleManifest.counter = (stageAssembleManifest.counter ?? 0) + 1;
  const dir = path.join(root, `outputs/mcp-assemble-stage-${process.pid}-${name.replace(/\.json$/, "")}-${stageAssembleManifest.counter}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const doc = JSON.parse(await readFile(path.join(root, "test", name), "utf8"));
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(root, "test", p));
  if (doc.voice) doc.voice.path = abs(doc.voice.path);
  if (doc.music) doc.music.path = abs(doc.music.path);
  if (doc.sfx) doc.sfx = doc.sfx.map((s) => ({ ...s, file: abs(s.file) }));
  if (doc.captions) doc.captions = abs(doc.captions);
  if (doc.shots) doc.shots = doc.shots.map((s) => {
    const out = { ...s };
    if (s.source) out.source = abs(s.source);
    if (s.scene) out.scene = abs(s.scene);
    if (s.assets) out.assets = Object.fromEntries(Object.entries(s.assets).map(([k, v]) => [k, abs(v)]));
    // Turn 132: variant takes carry their own source/scene/assets.
    if (s.variants) out.variants = s.variants.map((v) => {
      const vv = { ...v };
      if (v.source) vv.source = abs(v.source);
      if (v.scene) vv.scene = abs(v.scene);
      if (v.assets) vv.assets = Object.fromEntries(Object.entries(v.assets).map(([k, val]) => [k, abs(val)]));
      return vv;
    });
    return out;
  });
  const manifestPath = path.join(dir, name);
  await writeFile(manifestPath, JSON.stringify(doc), "utf8");
  return { manifestPath, dir };
}

// assemble: film manifest — validate/preview/approve/render.
// Fixture: test/assemble-film.json (voice 9s + lead/tail 0.5 = 10s,
// 300 frames @30fps; image zoom 4s + video 4s + image static 1s +
// color 1s; clean-bold captions). Staged per run (see above).
const assembleStage = await stageAssembleManifest("assemble-film.json");
const assembleOut = path.join(assembleStage.dir, "out");
const assembleApprovalPath = path.join(assembleStage.dir, "assemble-film.assemble-approval.json");
const assembleValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleStage.manifestPath, mode: "validate" } });
const assembleValidateJson = JSON.parse(assembleValidateRes.content[0].text);
checkOk(assembleValidateJson.total_seconds === 10 && assembleValidateJson.total_frames === 300 && assembleValidateJson.shots?.length === 4 && assembleValidateJson.voice?.duration_seconds === 9 && /^[0-9a-f]{64}$/.test(assembleValidateJson.fingerprint ?? ""), "assemble validate reports 10s / 300 frames / 4 shots / 9s voice + fingerprint", JSON.stringify(assembleValidateJson).slice(0, 200));
const assembleGapText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-gap.json"), mode: "validate" });
checkOk(/short by 15 frames/.test(assembleGapText ?? ""), "assemble validate refuses shots 15 frames short of the voice timeline", assembleGapText ?? "");
const assembleStaticText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-static.json"), mode: "validate" });
checkOk(/motion-gate/.test(assembleStaticText ?? ""), "assemble validate refuses a 4s still image without zoom (motion gate)", assembleStaticText ?? "");
const assembleStyleText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-style.json"), mode: "validate" });
checkOk(/must be one of clean-bold, minimal-line, warm-story/.test(assembleStyleText ?? ""), "assemble validate refuses an unknown style id", assembleStyleText ?? "");
const assembleMissingText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-missing.json"), mode: "validate" });
checkOk(/nope\.png/.test(assembleMissingText ?? ""), "assemble validate refuses a missing shot asset", assembleMissingText ?? "");
// Turn 132: shot variants + hook slot for assemble.
// Fixture test/assemble-variants.json: the same 10s film, s1 role
// hook + film hook {s1, 0-2s}, s2 role core with takes A (source.mp4
// start 1, hook "bold claim") / B (start 4, hook "mid-sentence cut"),
// selected B; s3 core, s4 payoff.
const variantsStage = await stageAssembleManifest("assemble-variants.json");
const variantsRes = await client.callTool({ name: "assemble", arguments: { manifest_path: variantsStage.manifestPath, mode: "validate" } });
const variantsJson = JSON.parse(variantsRes.content[0].text);
const variantsS2 = variantsJson.shots?.find((s) => s.id === "s2");
checkOk(variantsJson.hook?.shot === "s1" && variantsJson.hook?.start_seconds === 0 && variantsJson.hook?.end_seconds === 2 && variantsJson.hook?.film_start_seconds === 0 && variantsJson.hook?.film_end_seconds === 2 && variantsJson.warnings?.length === 0, "assemble validate echoes the hook slot: s1 0-2s at film 0-2s, no warnings", JSON.stringify(variantsJson.hook));
checkOk(JSON.stringify(variantsJson.shots?.map((s) => `${s.id}:${s.role}`)) === JSON.stringify(["s1:hook", "s2:core", "s3:core", "s4:payoff"]), "assemble validate echoes shot roles hook/core/core/payoff", JSON.stringify(variantsJson.shots?.map((s) => s.role)));
checkOk(variantsS2?.variants?.length === 2 && variantsS2?.selected_label === "B" && variantsS2?.variants?.[0]?.label === "A" && variantsS2?.variants?.[0]?.hook === "bold claim" && variantsS2?.variants?.[0]?.selected === false && variantsS2?.variants?.[1]?.label === "B" && variantsS2?.variants?.[1]?.hook === "mid-sentence cut" && variantsS2?.variants?.[1]?.selected === true, "assemble validate lists s2 takes A/B with B selected and their hook labels", JSON.stringify(variantsS2?.variants?.map((v) => `${v.label}:${v.hook}:${v.selected}`)));
checkOk(variantsS2?.variants?.[1]?.start === 4, "selected variant B resolves: s2 renders from start 4s", JSON.stringify(variantsS2?.variants?.[1]));
// No `selected` means the first take (A).
const variantsDefaultStage = await stageAssembleManifest("assemble-variants-default.json");
const variantsDefaultRes = await client.callTool({ name: "assemble", arguments: { manifest_path: variantsDefaultStage.manifestPath, mode: "validate" } });
const variantsDefaultJson = JSON.parse(variantsDefaultRes.content[0].text);
const variantsDefaultS2 = variantsDefaultJson.shots?.find((s) => s.id === "s2");
checkOk(variantsDefaultS2?.selected_label === "A" && variantsDefaultS2?.variants?.[0]?.start === 1 && variantsDefaultS2?.variants?.[0]?.selected === true, "no selected means take A (start 1s)", JSON.stringify(variantsDefaultS2?.variants?.map((v) => `${v.label}:${v.start}:${v.selected}`)));
// Bad films fail at validate, naming the fault.
const variantsBadCases = [
  ["assemble-bad-variant-selected.json", /out of range \(0\.\.1 for 2 variants\)/, "selected 5 out of range"],
  ["assemble-bad-variant-label.json", /duplicate variant label \\"A\\"/, "duplicate variant label"],
  ["assemble-bad-variant-top.json", /both variants and shot-level source/, "variants + shot-level source"],
  ["assemble-bad-hook-shot.json", /unknown shot \\"s9\\"/, "hook points at an unknown shot"],
  ["assemble-bad-hook-window.json", /hook\.end 9s must be after hook\.start/, "hook window past the shot"],
  ["assemble-bad-role.json", /role must be one of hook, context, core, payoff/, "unknown role"],
  ["assemble-bad-variant-source.json", /variant B source not found/, "missing variant source"],
];
for (const [file, re, label] of variantsBadCases) {
  const text = await callExpectThrow("assemble", { manifest_path: path.join(root, "test", file), mode: "validate" });
  checkOk(re.test(text ?? ""), `assemble validate refuses ${label}`, (text ?? "").slice(0, 160));
}
// Diagnose: the structure checks pass on the well-formed film.
const variantsDiagRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: variantsStage.manifestPath } });
const variantsDiagJson = JSON.parse(variantsDiagRes.content[0].text);
const variantsDiagById = Object.fromEntries((variantsDiagJson.checks ?? []).map((c) => [c.id, c]));
checkOk(variantsDiagById.structure_roles?.severity === "pass" && variantsDiagById.hook_slot?.severity === "pass", "diagnose passes structure_roles (hook opens on s1) and hook_slot (s1 0-2s)", JSON.stringify(variantsDiagJson.checks?.filter((c) => ["structure_roles", "hook_slot"].includes(c.id)).map((c) => `${c.id}:${c.severity}`)));
// Render proof: preview with take B vs take A renders different
// bytes — the pick really changes the film (same file, start 1 vs 4).
const variantsPreviewBDir = path.join(variantsStage.dir, "preview-b");
const variantsPreviewADir = path.join(variantsDefaultStage.dir, "preview-a");
await client.callTool({ name: "assemble", arguments: { manifest_path: variantsStage.manifestPath, mode: "preview", output_dir: variantsPreviewBDir, preview_seconds: 10 } });
await client.callTool({ name: "assemble", arguments: { manifest_path: variantsDefaultStage.manifestPath, mode: "preview", output_dir: variantsPreviewADir, preview_seconds: 10 } });
const variantsPreviewBHash = createHash("sha256").update(await readFile(path.join(variantsPreviewBDir, "preview.mp4"))).digest("hex");
const variantsPreviewAHash = createHash("sha256").update(await readFile(path.join(variantsPreviewADir, "preview.mp4"))).digest("hex");
checkOk(variantsPreviewBHash !== variantsPreviewAHash, "preview with take B selected renders different bytes than take A (start 4 vs 1)", `${variantsPreviewBHash.slice(0, 12)} vs ${variantsPreviewAHash.slice(0, 12)}`);
// Turn 107: export_timeline — film manifest -> OpenTimelineIO .otio.
// Fixture test/assemble-film-transitions.json (10s / 300 frames @30fps;
// image 4s + video 4s (start 2s) + image 1s + color 1s; transitions
// fade 1.0s into s2, dissolve 0.5s into s3, fade 0.5s into s4; voice
// 9s + lead/tail 0.5s; music 9s looped; one sfx at 2s, 0.5s).
const exportStage = await stageAssembleManifest("assemble-film-transitions.json");
const exportOut = path.join(exportStage.dir, "film.otio");
const exportRes = await client.callTool({ name: "export_timeline", arguments: { manifest_path: exportStage.manifestPath, output: exportOut } });
const exportJson = JSON.parse(exportRes.content[0].text);
checkOk(exportJson.operation === "export_timeline" && exportJson.timeline?.total_frames === 300 && exportJson.timeline?.rate === 30 && JSON.stringify(exportJson.timeline?.tracks) === JSON.stringify(["Video", "Voice", "Music", "SFX"]) && exportJson.timeline?.clips === 3 && exportJson.timeline?.gaps === 1 && exportJson.timeline?.transitions === 3 && exportJson.timeline?.markers === 0 && exportJson.frame_math?.frame_exact === true && exportJson.frame_math?.snap?.length === 0 && exportJson.self_check?.ok === true && exportJson.media?.missing?.length === 0 && existsSync(exportOut), "export_timeline exports the transitions film: 300 frames / 4 tracks / 3 clips + 1 gap + 3 transitions, frame-exact, self-check ok", JSON.stringify(exportJson.timeline));
// The .otio on disk, walked in-process: every track sums to exactly
// 300 frames (transitions add 0), transition offsets split the
// transition frames (fade 30f -> 15/15, dissolve 15f -> 8/7), and the
// video clip's source_range is the nominal window in its own rate.
const exportDoc = JSON.parse(await readFile(exportOut, "utf8"));
const videoTrack = exportDoc.tracks.children.find((t) => t.name === "Video");
const trackFrames = (track) => track.children.reduce((sum, c) => sum + (c.OTIO_SCHEMA === "Transition.1" ? 0 : (c.source_range.duration.value * 30) / c.source_range.duration.rate), 0);
checkOk(exportDoc.OTIO_SCHEMA === "Timeline.1" && exportDoc.global_start_time?.value === 0 && exportDoc.tracks.children.every((t) => trackFrames(t) === 300), "exported .otio: Timeline.1, global start 0, every track sums to exactly 300 frames", JSON.stringify(exportDoc.tracks.children.map((t) => `${t.name}:${trackFrames(t)}`)));
const exportTransitions = videoTrack.children.filter((c) => c.OTIO_SCHEMA === "Transition.1");
checkOk(exportTransitions.length === 3 && exportTransitions[0].in_offset.value === 15 && exportTransitions[0].out_offset.value === 15 && exportTransitions[0].transition_type === "SMPTE_Dissolve" && exportTransitions[1].in_offset.value === 8 && exportTransitions[1].out_offset.value === 7 && exportTransitions[2].in_offset.value === 8 && exportTransitions[2].out_offset.value === 7, "exported transitions split frames as hAfter/hBefore (15/15, 8/7, 8/7) and dissolve maps to SMPTE_Dissolve", JSON.stringify(exportTransitions.map((t) => `${t.in_offset.value}/${t.out_offset.value}`)));
// Transition ranges sit where the ffmpeg blend starts: cut - in_offset.
let exportCut = 0;
const transitionStarts = [];
for (const c of videoTrack.children) {
  if (c.OTIO_SCHEMA === "Transition.1") transitionStarts.push(exportCut - c.in_offset.value);
  else exportCut += (c.source_range.duration.value * 30) / c.source_range.duration.rate;
}
checkOk(JSON.stringify(transitionStarts) === JSON.stringify([105, 232, 262]), "exported transitions start at cut - in_offset (105, 232, 262) — where the ffmpeg xfade blend starts", JSON.stringify(transitionStarts));
const s2Clip = videoTrack.children.find((c) => c.name === "s2");
checkOk(s2Clip?.media_reference?.target_url?.startsWith("file://") && s2Clip?.media_reference?.target_url?.endsWith("source.mp4") && s2Clip?.source_range?.start_time?.value === 60 && s2Clip?.source_range?.duration?.value === 120 && s2Clip?.source_range?.start_time?.rate === 30 && s2Clip?.media_reference?.available_range?.duration?.value === 300 && s2Clip?.metadata?.mediakit?.ffmpeg_build?.start_seconds === 1.5 && s2Clip?.metadata?.mediakit?.ffmpeg_build?.handle_in_frames === 15 && s2Clip?.metadata?.mediakit?.ffmpeg_build?.handle_out_frames === 7, "video clip s2: file:// URL, source_range [60,120) frames at 30fps, build range + handles in metadata", JSON.stringify(s2Clip?.source_range));
const s1Clip = videoTrack.children.find((c) => c.name === "s1");
checkOk(s1Clip?.media_reference?.available_range?.duration?.value === 1 && s1Clip?.source_range?.duration?.value === 120 && s1Clip?.metadata?.mediakit?.still === true, "image clip s1: 1-frame available_range, 120-frame hold, still flagged", JSON.stringify(s1Clip?.source_range));
const voiceTrack = exportDoc.tracks.children.find((t) => t.name === "Voice");
checkOk(voiceTrack.children.length === 3 && voiceTrack.children[0].source_range.duration.value === 15 && voiceTrack.children[1].name === "voice" && voiceTrack.children[1].source_range.duration.value === 270 && voiceTrack.children[2].source_range.duration.value === 15, "voice track: 15-frame lead gap + 270-frame voice + 15-frame tail gap", JSON.stringify(voiceTrack.children.map((c) => `${c.name}:${c.source_range.duration.value}`)));
// Chapters become Marker.2 markers on the video track (Marker.1 does
// not decode under OTIO 0.18 — verified against the real library).
const chaptersStage = await stageAssembleManifest("assemble-chapters.json");
const chaptersOut = path.join(chaptersStage.dir, "film.otio");
const chaptersRes = await client.callTool({ name: "export_timeline", arguments: { manifest_path: chaptersStage.manifestPath, output: chaptersOut } });
const chaptersJson = JSON.parse(chaptersRes.content[0].text);
const chaptersDoc = JSON.parse(await readFile(chaptersOut, "utf8"));
const chapterMarkers = chaptersDoc.tracks.children.find((t) => t.name === "Video").markers;
checkOk(chaptersJson.timeline?.markers === 3 && chapterMarkers.length === 3 && chapterMarkers.every((m) => m.OTIO_SCHEMA === "Marker.2") && JSON.stringify(chapterMarkers.map((m) => m.name)) === JSON.stringify(["Intro", "The turn", "The payoff"]) && JSON.stringify(chapterMarkers.map((m) => m.marked_range.start_time.value)) === JSON.stringify([0, 105, 210]), "chapters export as 3 Marker.2 markers at frames 0/105/210 with the chapter titles", JSON.stringify(chapterMarkers.map((m) => `${m.name}@${m.marked_range.start_time.value}`)));
// CLI: the same film through `mediakit export-timeline`, plus the two
// refusals (no -o, non-.otio output).
const cliOut = path.join(chaptersStage.dir, "cli.otio");
const cliExport = await runCliJson(["export-timeline", chaptersStage.manifestPath, "-o", cliOut]);
checkOk(cliExport.operation === "export_timeline" && cliExport.timeline?.total_frames === 300 && existsSync(cliOut), "CLI export-timeline writes the .otio", JSON.stringify(cliExport.timeline));
const cliNoOut = await runCli(["export-timeline", chaptersStage.manifestPath], {});
checkOk(cliNoOut.code !== 0 && /-o <film\.otio>/.test(cliNoOut.out), "CLI export-timeline refuses without -o", cliNoOut.out.slice(0, 160));
const cliBadExt = await runCli(["export-timeline", chaptersStage.manifestPath, "-o", path.join(chaptersStage.dir, "film.txt")], {});
checkOk(cliBadExt.code !== 0 && /must end in \.otio/.test(cliBadExt.out), "CLI export-timeline refuses a non-.otio output", cliBadExt.out.slice(0, 160));
// A broken film fails export with the assemble error, nothing written.
const exportBadText = await callExpectThrow("export_timeline", { manifest_path: path.join(root, "test/assemble-bad-gap.json"), output: path.join(root, "outputs/mcp-export-bad.otio") });
checkOk(/short by 15 frames/.test(exportBadText ?? "") && !existsSync(path.join(root, "outputs/mcp-export-bad.otio")), "export_timeline refuses a film 15 frames short of the voice timeline and writes nothing", exportBadText ?? "");
// Pure frame math: 26.575s at 30fps snaps to 797 frames (-0.25), the
// 797.25-frame rounding case from the backlog — never 797.25 frames.
checkOk(secondsToFrames(26.575, 30).frames === 797 && secondsToFrames(26.575, 30).error_frames === -0.25 && secondsToFrames(21.35, 30).frames === 641 && secondsToFrames(21.35, 30).error_frames === 0.5 && secondsToFrames(4, 30).error_frames === 0, "secondsToFrames snaps to whole frames with the error reported (797.25 -> 797, -0.25)", JSON.stringify(secondsToFrames(26.575, 30)));
// The structural validator catches a tampered timeline: drop the last
// shot and the video track no longer sums to 300.
const tamperedDoc = JSON.parse(JSON.stringify(exportDoc));
tamperedDoc.tracks.children.find((t) => t.name === "Video").children.pop();
const tamperedCheck = validateOtioTimeline(tamperedDoc, { total_frames: 300, rate: 30 });
checkOk(tamperedCheck.ok === false && tamperedCheck.issues.some((i) => /sums to 270/.test(i)) && validateOtioTimeline(exportDoc, { total_frames: 300, rate: 30 }).ok === true, "validateOtioTimeline passes the real export and fails a tampered one (track sums to 270)", JSON.stringify(tamperedCheck.issues));
// assemble presets: one named id picks width/height/fps/style.
// Fixture test/assemble-preset.json is assemble-film.json with the
// four fields replaced by "preset": "vertical".
const presetStage = await stageAssembleManifest("assemble-preset.json");
const presetValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: presetStage.manifestPath, mode: "validate" } });
const presetValidateJson = JSON.parse(presetValidateRes.content[0].text);
checkOk(presetValidateJson.preset === "vertical" && presetValidateJson.width === 1080 && presetValidateJson.height === 1920 && presetValidateJson.fps === 30 && presetValidateJson.style === "clean-bold" && JSON.stringify(presetValidateJson.preset_applied) === JSON.stringify(["width", "height", "fps", "style"]) && presetValidateJson.preset_overrides.length === 0 && presetValidateJson.total_frames === 300, "assemble preset vertical resolves to 1080x1920/30fps/clean-bold with all four fields preset_applied", JSON.stringify({ preset: presetValidateJson.preset, w: presetValidateJson.width, h: presetValidateJson.height, fps: presetValidateJson.fps, style: presetValidateJson.style, applied: presetValidateJson.preset_applied }));
const presetOverrideStage = await stageAssembleManifest("assemble-preset-override.json");
const presetOverrideRes = await client.callTool({ name: "assemble", arguments: { manifest_path: presetOverrideStage.manifestPath, mode: "validate" } });
const presetOverrideJson = JSON.parse(presetOverrideRes.content[0].text);
checkOk(presetOverrideJson.preset === "vertical" && presetOverrideJson.width === 720 && presetOverrideJson.height === 1280 && presetOverrideJson.fps === 24 && presetOverrideJson.style === "warm-story" && presetOverrideJson.preset_applied.length === 0 && JSON.stringify(presetOverrideJson.preset_overrides) === JSON.stringify(["width", "height", "fps", "style"]), "assemble explicit fields win over the preset and are reported in preset_overrides", JSON.stringify({ w: presetOverrideJson.width, h: presetOverrideJson.height, fps: presetOverrideJson.fps, style: presetOverrideJson.style, overrides: presetOverrideJson.preset_overrides }));
const presetBadText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-preset.json"), mode: "validate" });
checkOk(/must be one of vertical, horizontal, square, cinematic, vertical-60/.test(presetBadText ?? ""), "assemble validate refuses an unknown preset id", presetBadText ?? "");
// The preset film renders at the preset geometry: force-render the
// staged preset manifest and measure final.mp4 on disk.
const presetOut = path.join(presetStage.dir, "out");
const presetRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: presetStage.manifestPath, mode: "render", output_dir: presetOut, force: true } }, undefined, { timeout: 300000 });
const presetRenderJson = JSON.parse(presetRenderRes.content[0].text);
const presetFinalProbe = await probeStreams(path.join(presetOut, "final.mp4"));
checkOk(presetRenderJson.final?.dimensions === "1080x1920" && presetRenderJson.preset === "vertical" && presetRenderJson.final?.frames === 300 && near(parseFloat(presetFinalProbe?.format?.duration), 10, 0.15), "assemble preset film renders 1080x1920 / 300 frames / 10s with preset echoed in the receipt", JSON.stringify(presetRenderJson.final));
const assembleApproveEarlyText = await callExpectThrow("assemble", { manifest_path: assembleStage.manifestPath, mode: "approve", output_dir: assembleOut });
checkOk(/needs a preview/.test(assembleApproveEarlyText ?? ""), "assemble approve refuses without a preview", assembleApproveEarlyText ?? "");
const assembleRenderEarlyText = await callExpectThrow("assemble", { manifest_path: assembleStage.manifestPath, mode: "render", output_dir: assembleOut });
checkOk(/needs approval/.test(assembleRenderEarlyText ?? ""), "assemble render refuses without approval", assembleRenderEarlyText ?? "");
const assemblePreviewRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleStage.manifestPath, mode: "preview", output_dir: assembleOut, preview_seconds: 3 } });
const assemblePreviewJson = JSON.parse(assemblePreviewRes.content[0].text);
const assemblePreviewPath = path.join(assembleOut, "preview.mp4");
const assemblePreviewProbe = await probeStreams(assemblePreviewPath);
checkOk(assemblePreviewJson.fingerprint === assembleValidateJson.fingerprint && assemblePreviewJson.preview_seconds === 3 && assemblePreviewJson.dimensions === "540x960" && near(parseFloat(assemblePreviewProbe?.format?.duration), 3, 0.15), "assemble preview renders 3s at 540x960 with the validate fingerprint", JSON.stringify(assemblePreviewJson).slice(0, 200));
const assemblePreviewFrames = await countFrames(assemblePreviewPath);
checkOk(assemblePreviewFrames === 90, "assemble preview has exactly 90 frames (3s x 30fps)", `frames=${assemblePreviewFrames}`);
const assemblePreviewDoc = JSON.parse(await readFile(path.join(assembleOut, "preview.json"), "utf8"));
checkOk(assemblePreviewDoc.fingerprint === assembleValidateJson.fingerprint, "assemble preview.json on disk carries the fingerprint", assemblePreviewDoc.fingerprint ?? "");
const assembleApproveRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleStage.manifestPath, mode: "approve", output_dir: assembleOut } });
const assembleApproveJson = JSON.parse(assembleApproveRes.content[0].text);
const assembleApprovalDoc = JSON.parse(await readFile(assembleApprovalPath, "utf8"));
checkOk(assembleApproveJson.fingerprint === assembleValidateJson.fingerprint && assembleApprovalDoc.fingerprint === assembleValidateJson.fingerprint, "assemble approve records the matching fingerprint on disk", assembleApproveJson.fingerprint ?? "");
// Full renders (segments + mix + burn) run 40-90s on this VM and
// cross the SDK's 60s default timeout when the machine is busy —
// same 300s override as the social call and the transitions renders.
const assembleRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleStage.manifestPath, mode: "render", output_dir: assembleOut } }, undefined, { timeout: 300000 });
const assembleRenderJson = JSON.parse(assembleRenderRes.content[0].text);
const assembleFinalPath = path.join(assembleOut, "final.mp4");
const assembleFinalProbe = await probeStreams(assembleFinalPath);
const assembleFinalFrames = await countFrames(assembleFinalPath);
const assembleFinalLufs = await measureLufs(assembleFinalPath);
checkOk(assembleRenderJson.approval === "approved" && assembleRenderJson.fingerprint === assembleValidateJson.fingerprint, "assemble render is approved with the matching fingerprint", JSON.stringify(assembleRenderJson.approval));
checkOk(assembleFinalProbe?.streams?.find((s) => s.codec_type === "video")?.width === 1080 && near(parseFloat(assembleFinalProbe?.format?.duration), 10, 0.15) && assembleFinalFrames === 300, "assemble final is 1080x1920, 10s, exactly 300 frames", `duration=${assembleFinalProbe?.format?.duration} frames=${assembleFinalFrames}`);
checkOk(assembleFinalLufs !== null && near(assembleFinalLufs, -14, 0.5), "assemble final measures -14 LUFS independently", `LUFS=${assembleFinalLufs}`);
const assembleReceipt = JSON.parse(await readFile(path.join(assembleOut, "assemble-receipt.json"), "utf8"));
checkOk(assembleReceipt.approval === "approved" && assembleReceipt.final?.sha256?.length === 64 && assembleReceipt.qa?.checks?.every((c) => c.status === "pass"), "assemble receipt records approval + SHA-256 + an all-pass qa_report", JSON.stringify(assembleReceipt.qa?.checks?.map((c) => `${c.check}:${c.status}`)));
checkOk(typeof assembleReceipt.fingerprint_parts?.manifest === "string" && assembleReceipt.fingerprint_parts.manifest.length === 64 && assembleReceipt.inputs?.voice?.endsWith("mix-voice.mp3") && assembleReceipt.inputs?.shots?.s1?.source?.endsWith("kenburns.png") && assembleReceipt.mediakit_version === "0.1.0" && assembleReceipt.ffmpeg_version === doctorJson.ffmpeg_version, "assemble receipt records fingerprint_parts + input paths + versions (verify evidence)", JSON.stringify({ parts: Object.keys(assembleReceipt.fingerprint_parts ?? {}), inputs: Object.keys(assembleReceipt.inputs ?? {}), ffmpeg_version: assembleReceipt.ffmpeg_version }));
// verify: check mode on the receipt just rendered — every input and
// the output must match, since nothing has moved since the render.
const verifyReceiptPath = path.join(assembleOut, "assemble-receipt.json");
const verifyCheckRes = await client.callTool({ name: "verify", arguments: { receipt: verifyReceiptPath } });
const verifyCheckJson = JSON.parse(verifyCheckRes.content[0].text);
checkOk(verifyCheckJson.verdict === "pass" && verifyCheckJson.mode === "check" && verifyCheckJson.changed === 0 && verifyCheckJson.first_difference === null && verifyCheckJson.items?.every((i) => i.status === "matched"), "verify check passes on a fresh render receipt (all inputs + output match)", JSON.stringify(verifyCheckJson.items?.map((i) => `${i.name}:${i.status}`)));
checkOk(verifyCheckJson.items?.some((i) => i.name === "voice" && i.status === "matched") && verifyCheckJson.items?.some((i) => i.name === "asset:s2" && i.status === "matched") && verifyCheckJson.items?.some((i) => i.name === "output_bytes" && i.status === "matched") && verifyCheckJson.items?.some((i) => i.name === "frames" && i.status === "matched"), "verify check names voice, shot assets, output bytes and frames as separate items", JSON.stringify(verifyCheckJson.items?.map((i) => i.name)));
// verify negatives: a receipt with a zeroed output hash must fail on
// output_bytes, and one pointing at a missing manifest must fail on
// the manifest — both without touching the real fixtures.
const verifyFakeShaPath = path.join(root, `outputs/mcp-verify-fake-sha-${process.pid}.json`);
const verifyFakeShaDoc = { ...assembleReceipt, final: { ...assembleReceipt.final, sha256: "0".repeat(64) } };
await writeFile(verifyFakeShaPath, JSON.stringify(verifyFakeShaDoc), "utf8");
const verifyFakeShaRes = await client.callTool({ name: "verify", arguments: { receipt: verifyFakeShaPath } });
const verifyFakeShaJson = JSON.parse(verifyFakeShaRes.content[0].text);
checkOk(verifyFakeShaJson.verdict === "fail" && verifyFakeShaJson.first_difference === "output_bytes" && verifyFakeShaJson.items?.find((i) => i.name === "output_bytes")?.status === "changed", "verify check fails on a zeroed output hash (first difference: output_bytes)", JSON.stringify(verifyFakeShaJson.first_difference));
const verifyFakeManifestPath = path.join(root, `outputs/mcp-verify-fake-manifest-${process.pid}.json`);
const verifyFakeManifestDoc = { ...assembleReceipt, manifest: "/tmp/no-such-film-xyz.json", inputs: { ...assembleReceipt.inputs, manifest: "/tmp/no-such-film-xyz.json" } };
await writeFile(verifyFakeManifestPath, JSON.stringify(verifyFakeManifestDoc), "utf8");
const verifyFakeManifestRes = await client.callTool({ name: "verify", arguments: { receipt: verifyFakeManifestPath } });
const verifyFakeManifestJson = JSON.parse(verifyFakeManifestRes.content[0].text);
checkOk(verifyFakeManifestJson.verdict === "fail" && verifyFakeManifestJson.first_difference === "manifest" && verifyFakeManifestJson.items?.find((i) => i.name === "manifest")?.status === "missing", "verify check fails on a missing manifest (first difference: manifest)", JSON.stringify(verifyFakeManifestJson.first_difference));
const verifyBadReceiptText = await callExpectThrow("verify", { receipt: path.join(root, "test/source.mp4") });
checkOk(/assemble receipt/.test(verifyBadReceiptText ?? ""), "verify refuses a file that is not an assemble receipt", (verifyBadReceiptText ?? "").slice(0, 160));
const assembleRender2Res = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleStage.manifestPath, mode: "render", output_dir: assembleOut } }, undefined, { timeout: 300000 });
const assembleRender2Json = JSON.parse(assembleRender2Res.content[0].text);
checkOk(assembleRender2Json.cache_hits === 4, "assemble second render reuses all 4 shot segments from the cache", `cache_hits=${assembleRender2Json.cache_hits}`);
// Per-shot audio_level (lượt 124, ideas: soniccraft per-track
// `volume` 0-1 + burningion/video-editing-mcp per-cut audio_level):
// fixture test/assemble-audio-levels.json is assemble-film.json
// with s2 at 0.25 and s4 at 0 — the whole mix (voice + music +
// SFX) is scaled inside each shot's nominal window, after the
// -14 LUFS master, so the ratios between windows are exact.
// Validate echoes the levels and warns on the mute; 1.5 and a
// non-number are refused. The render is measured A/B against the
// plain final above: s2 (0.25) must sit 20*log10(0.25) = -12.04 dB
// below the same window, s1 (level 1) must match within 1 dB, and
// s4 (0) must fall to the AAC silence floor (rms < -60 dB).
const levelsStage = await stageAssembleManifest("assemble-audio-levels.json");
const levelsValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: levelsStage.manifestPath, mode: "validate" } });
const levelsValidateJson = JSON.parse(levelsValidateRes.content[0].text);
checkOk(levelsValidateJson.shots?.[1]?.audio_level === 0.25 && levelsValidateJson.shots?.[3]?.audio_level === 0 && levelsValidateJson.shots?.[0]?.audio_level === undefined && levelsValidateJson.warnings?.some((w) => /s4.*mutes/.test(w)), "assemble validate echoes per-shot audio_level (s2 0.25, s4 0, s1 unset) and warns that s4 is muted", JSON.stringify(levelsValidateJson.shots?.map((s) => s.audio_level)));
const levelsBadDoc = JSON.parse(await readFile(levelsStage.manifestPath, "utf8"));
levelsBadDoc.shots[1].audio_level = 1.5;
const levelsBadPath = path.join(levelsStage.dir, "film-bad-level.json");
await writeFile(levelsBadPath, JSON.stringify(levelsBadDoc), "utf8");
const levelsBadText = await callExpectThrow("assemble", { manifest_path: levelsBadPath, mode: "validate" });
levelsBadDoc.shots[1].audio_level = "loud";
await writeFile(levelsBadPath, JSON.stringify(levelsBadDoc), "utf8");
const levelsBadText2 = await callExpectThrow("assemble", { manifest_path: levelsBadPath, mode: "validate" });
checkOk(/audio_level.*1\.5|at most 1|must be <= 1/.test(levelsBadText ?? "") && /audio_level/.test(levelsBadText2 ?? ""), "assemble validate refuses audio_level 1.5 and a non-number level", `${levelsBadText ?? ""} / ${levelsBadText2 ?? ""}`);
const levelsOut = path.join(levelsStage.dir, "out");
const levelsRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: levelsStage.manifestPath, mode: "render", output_dir: levelsOut, force: true } }, undefined, { timeout: 300000 });
const levelsRenderJson = JSON.parse(levelsRenderRes.content[0].text);
const levelsFinalPath = path.join(levelsOut, "final.mp4");
const levelsFinalFrames = await countFrames(levelsFinalPath);
checkOk(levelsRenderJson.final?.frames === 300 && levelsFinalFrames === 300 && JSON.stringify(levelsRenderJson.audio_levels) === JSON.stringify([{ shot: "s2", level: 0.25, start: 4, end: 8 }, { shot: "s4", level: 0, start: 9, end: 10 }]), "assemble leveled render: 300 frames, receipt records the two level windows (s2 0.25 [4,8), s4 0 [9,10))", JSON.stringify(levelsRenderJson.audio_levels));
const meanBucketDb = (buckets, lo, hi) => {
  const vals = buckets.filter((b) => b.start >= lo && b.end <= hi && typeof b.rms_db === "number").map((b) => 10 ** (b.rms_db / 10));
  return vals.length ? 10 * Math.log10(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
};
const levelsCurveRes = await client.callTool({ name: "audio_levels", arguments: { input: levelsFinalPath, top_n: 0 } });
const levelsCurveJson = JSON.parse(levelsCurveRes.content[0].text);
const plainCurveRes = await client.callTool({ name: "audio_levels", arguments: { input: path.join(assembleOut, "final.mp4"), top_n: 0 } });
const plainCurveJson = JSON.parse(plainCurveRes.content[0].text);
const s1Diff = meanBucketDb(levelsCurveJson.buckets, 0, 4) - meanBucketDb(plainCurveJson.buckets, 0, 4);
const s2Diff = meanBucketDb(levelsCurveJson.buckets, 4, 8) - meanBucketDb(plainCurveJson.buckets, 4, 8);
checkOk(near(s1Diff, 0, 1) && near(s2Diff, -12.04, 1.5), "per-shot audio_level measured A/B: untouched s1 window matches within 1 dB, s2 at 0.25 drops -12.04 dB (20*log10 0.25)", `s1 diff=${s1Diff?.toFixed(2)} dB, s2 diff=${s2Diff?.toFixed(2)} dB`);
checkOk(levelsCurveJson.buckets[9]?.rms_db !== null && levelsCurveJson.buckets[9].rms_db < -60, "per-shot audio_level 0: the muted s4 window [9,10) falls to the AAC silence floor (rms < -60 dB)", JSON.stringify(levelsCurveJson.buckets[9]));
// Fingerprint sensitivity + force: a copy with a different title
// (absolute paths, so it can live under outputs/) has a different
// fingerprint, renders without approval only with force:true, and
// the receipt says so.
const assembleEditDir = path.join(root, `outputs/mcp-assemble-edit-${process.pid}`);
await rm(assembleEditDir, { recursive: true, force: true });
await mkdir(assembleEditDir, { recursive: true });
const assembleEditDoc = JSON.parse(await readFile(path.join(root, "test/assemble-film.json"), "utf8"));
assembleEditDoc.title = "A different title";
for (const p of ["voice", "music"]) assembleEditDoc[p].path = path.join(root, "test", assembleEditDoc[p].path);
assembleEditDoc.sfx = assembleEditDoc.sfx.map((s) => ({ ...s, file: path.join(root, "test", s.file) }));
assembleEditDoc.captions = path.join(root, "test", assembleEditDoc.captions);
assembleEditDoc.shots = assembleEditDoc.shots.map((s) => (s.source ? { ...s, source: path.join(root, "test", s.source) } : s));
const assembleEditPath = path.join(assembleEditDir, "film.json");
await writeFile(assembleEditPath, JSON.stringify(assembleEditDoc), "utf8");
const assembleEditValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleEditPath, mode: "validate" } });
const assembleEditValidateJson = JSON.parse(assembleEditValidateRes.content[0].text);
checkOk(assembleEditValidateJson.fingerprint !== assembleValidateJson.fingerprint, "assemble fingerprint changes when the manifest changes (title only)", assembleEditValidateJson.fingerprint ?? "");
const assembleEditRenderText = await callExpectThrow("assemble", { manifest_path: assembleEditPath, mode: "render", output_dir: assembleEditDir });
checkOk(/needs approval/.test(assembleEditRenderText ?? ""), "assemble edited copy refuses render without approval", assembleEditRenderText ?? "");
const assembleEditForceRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleEditPath, mode: "render", output_dir: assembleEditDir, force: true } }, undefined, { timeout: 300000 });
const assembleEditForceJson = JSON.parse(assembleEditForceRes.content[0].text);
checkOk(assembleEditForceJson.approval === "forced" && existsSync(path.join(assembleEditDir, "final.mp4")), "assemble force render succeeds and records approval:'forced'", JSON.stringify(assembleEditForceJson.approval));
// No-music path: the same film without a bed must still render —
// the padded voice goes through loudness instead of mix. Preview
// only (3s) is enough to exercise the branch end to end.
const assembleNoMusicStage = await stageAssembleManifest("assemble-nomusic.json");
const assembleNoMusicOut = path.join(assembleNoMusicStage.dir, "out");
const assembleNoMusicRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleNoMusicStage.manifestPath, mode: "preview", output_dir: assembleNoMusicOut, preview_seconds: 3 } });
const assembleNoMusicJson = JSON.parse(assembleNoMusicRes.content[0].text);
const assembleNoMusicProbe = await probeStreams(path.join(assembleNoMusicOut, "preview.mp4"));
checkOk(assembleNoMusicJson.preview_seconds === 3 && assembleNoMusicProbe?.streams?.some((s) => s.codec_type === "audio") && near(parseFloat(assembleNoMusicProbe?.format?.duration), 3, 0.15), "assemble preview without music renders 3s with an audio track (loudness path)", JSON.stringify(assembleNoMusicJson).slice(0, 150));
// verify --rerender on a tiny film (3s, 1 rings shot, 540x960):
// render once, then re-render from the recorded manifest and
// compare — on this machine the output must be byte-identical
// (measured turn 63: two renders of the same film, same sha256).
const verifyTinyStage = await stageAssembleManifest("assemble-tiny.json");
const verifyTinyOut = path.join(verifyTinyStage.dir, "out");
const verifyTinyRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: verifyTinyStage.manifestPath, mode: "render", output_dir: verifyTinyOut, force: true } }, undefined, { timeout: 300000 });
const verifyTinyRenderJson = JSON.parse(verifyTinyRenderRes.content[0].text);
checkOk(verifyTinyRenderJson.final?.frames === 90 && verifyTinyRenderJson.final?.dimensions === "540x960" && near(parseFloat(verifyTinyRenderJson.final?.duration_seconds), 3, 0.05), "tiny film renders 3s / 90 frames / 540x960 (verify fixture)", JSON.stringify(verifyTinyRenderJson.final));
const verifyTinyReceiptPath = path.join(verifyTinyOut, "assemble-receipt.json");
const verifyTinyCheckRes = await client.callTool({ name: "verify", arguments: { receipt: verifyTinyReceiptPath } });
const verifyTinyCheckJson = JSON.parse(verifyTinyCheckRes.content[0].text);
checkOk(verifyTinyCheckJson.verdict === "pass" && verifyTinyCheckJson.items?.some((i) => i.name === "asset:rings" && i.status === "matched"), "verify check passes on the tiny film receipt (template shot asset matches)", JSON.stringify(verifyTinyCheckJson.items?.map((i) => `${i.name}:${i.status}`)));
const verifyRerenderRes = await client.callTool({ name: "verify", arguments: { receipt: verifyTinyReceiptPath, rerender: true } }, undefined, { timeout: 300000 });
const verifyRerenderJson = JSON.parse(verifyRerenderRes.content[0].text);
checkOk(verifyRerenderJson.verdict === "pass" && verifyRerenderJson.mode === "rerender" && verifyRerenderJson.rerender_removed === true && verifyRerenderJson.items?.find((i) => i.name === "output_bytes")?.status === "matched", "verify --rerender passes: the re-render is byte-identical and the temp dir is removed", JSON.stringify({ verdict: verifyRerenderJson.verdict, removed: verifyRerenderJson.rerender_removed, first: verifyRerenderJson.first_difference }));
checkOk(existsSync(path.join(verifyTinyOut, "final.mp4")) && readdirSync(verifyTinyOut).filter((n) => n.startsWith(".mediakit-verify-rerender-")).length === 0, "verify rerender keeps the original final.mp4 and leaves no rerender temp dir behind", readdirSync(verifyTinyOut).join(", "));

// verify_cuts (turn 112): the assemble render must cut where the
// film manifest promises. Fixture test/verify-cuts-film.json: 4
// template shots, 4s, brand warm-story, explicit bg per shot — 2
// hard cuts (1.0s, 3.0s) + 1 fade (2.0s, 0.4s). The mixed hard-cut
// + transition film is also the regression test for the join bug
// fixed this turn: before the fix, joinAssembleSegments assumed
// every boundary had a transition and dropped segments 3-4 (the
// render failed the frame-count check at 36 frames instead of 120).
const vcStage = await stageAssembleManifest("verify-cuts-film.json");
const vcOut = path.join(vcStage.dir, "out");
const vcValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: vcStage.manifestPath, mode: "validate" } });
const vcValidateJson = JSON.parse(vcValidateRes.content[0].text);
// Brand maps spring-in (turn 111 follow-up): card/fg come from the
// warm-story palette, the explicit bg wins over the brand bg.
checkOk(vcValidateJson.brand_applied?.includes("shot 4 (s4) template.spring-in.card") && vcValidateJson.brand_applied?.includes("shot 4 (s4) template.spring-in.fg") && vcValidateJson.brand_overrides?.includes("shot 4 (s4) template.spring-in.bg") && vcValidateJson.shots?.[3]?.params?.card === "#B45309" && vcValidateJson.shots?.[3]?.params?.fg === "#FFF7ED" && vcValidateJson.shots?.[3]?.params?.bg === "#1E3A5F", "brand warm-story paints spring-in card/fg (primary/on_primary) while the explicit bg wins", JSON.stringify(vcValidateJson.shots?.[3]?.params));
const vcRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: vcStage.manifestPath, mode: "render", output_dir: vcOut, force: true } }, undefined, { timeout: 300000 });
const vcRenderJson = JSON.parse(vcRenderRes.content[0].text);
checkOk(vcRenderJson.final?.frames === 120 && near(parseFloat(vcRenderJson.final?.duration_seconds), 4, 0.05), "mixed hard-cut + fade film renders 4s / 120 frames (join regression: was 36 frames before the fix)", JSON.stringify(vcRenderJson.final));
const vcFinalPath = path.join(vcOut, "final.mp4");
const vcRes = await client.callTool({ name: "verify_cuts", arguments: { manifest_path: vcStage.manifestPath, video: vcFinalPath } }, undefined, { timeout: 300000 });
const vcJson = JSON.parse(vcRes.content[0].text);
checkOk(vcJson.ok === true && vcJson.cuts?.length === 3 && vcJson.cuts?.[0]?.status === "confirmed" && vcJson.cuts?.[0]?.measured_seconds === 1 && vcJson.cuts?.[0]?.drift_seconds === 0 && vcJson.cuts?.[1]?.status === "confirmed" && vcJson.cuts?.[1]?.type === "transition" && vcJson.cuts?.[1]?.transition_diff > 1 && vcJson.cuts?.[2]?.status === "confirmed" && vcJson.cuts?.[2]?.measured_seconds === 3 && vcJson.unexpected_cuts?.length === 0 && vcJson.duration_ok === true, "verify_cuts passes on the mixed film: hard cuts at 1.0s/3.0s drift 0, fade confirmed by frame diff, no unexpected cuts", JSON.stringify(vcJson.cuts));
// Wrong timeline: the same render checked against a manifest that
// promises the first cut at 1.5s instead of 1.0s — the cut at 1.5s
// must be missing and the real cut at 1.0s unexpected, while the
// other two boundaries still confirm.
const vcWrongDoc = JSON.parse(await readFile(vcStage.manifestPath, "utf8"));
vcWrongDoc.shots[0].duration = 1.5;
vcWrongDoc.shots[1].duration = 0.5;
const vcWrongPath = path.join(vcStage.dir, "verify-cuts-wrong.json");
await writeFile(vcWrongPath, JSON.stringify(vcWrongDoc), "utf8");
const vcWrongRes = await client.callTool({ name: "verify_cuts", arguments: { manifest_path: vcWrongPath, video: vcFinalPath } }, undefined, { timeout: 300000 });
const vcWrongJson = JSON.parse(vcWrongRes.content[0].text);
checkOk(vcWrongJson.ok === false && vcWrongJson.cuts?.[0]?.status === "missing" && vcWrongJson.cuts?.[0]?.expected_seconds === 1.5 && vcWrongJson.unexpected_cuts?.includes(1) && vcWrongJson.cuts?.[1]?.status === "confirmed" && vcWrongJson.cuts?.[2]?.status === "confirmed", "verify_cuts fails on a wrong timeline: cut at 1.5s missing, real cut at 1.0s unexpected, other boundaries still confirmed", JSON.stringify(vcWrongJson.cuts));
// Same-color films: a hard cut between two identical color shots is
// invisible (missing), and a fade between them blends identical
// frames (invisible_transition, diff 0).
const vcSameStage = await stageAssembleManifest("verify-cuts-same.json");
const vcSameOut = path.join(vcSameStage.dir, "out");
await client.callTool({ name: "assemble", arguments: { manifest_path: vcSameStage.manifestPath, mode: "render", output_dir: vcSameOut, force: true } }, undefined, { timeout: 300000 });
const vcSameRes = await client.callTool({ name: "verify_cuts", arguments: { manifest_path: vcSameStage.manifestPath, video: path.join(vcSameOut, "final.mp4") } }, undefined, { timeout: 300000 });
const vcSameJson = JSON.parse(vcSameRes.content[0].text);
checkOk(vcSameJson.ok === false && vcSameJson.cuts?.length === 1 && vcSameJson.cuts?.[0]?.status === "missing" && vcSameJson.unexpected_cuts?.length === 0, "verify_cuts fails on a hard cut between identical color shots (missing, no unexpected)", JSON.stringify(vcSameJson.cuts));
const vcSameFadeStage = await stageAssembleManifest("verify-cuts-same-fade.json");
const vcSameFadeOut = path.join(vcSameFadeStage.dir, "out");
await client.callTool({ name: "assemble", arguments: { manifest_path: vcSameFadeStage.manifestPath, mode: "render", output_dir: vcSameFadeOut, force: true } }, undefined, { timeout: 300000 });
const vcSameFadeRes = await client.callTool({ name: "verify_cuts", arguments: { manifest_path: vcSameFadeStage.manifestPath, video: path.join(vcSameFadeOut, "final.mp4") } }, undefined, { timeout: 300000 });
const vcSameFadeJson = JSON.parse(vcSameFadeRes.content[0].text);
checkOk(vcSameFadeJson.ok === false && vcSameFadeJson.cuts?.length === 1 && vcSameFadeJson.cuts?.[0]?.status === "invisible_transition" && vcSameFadeJson.cuts?.[0]?.transition_diff === 0 && vcSameFadeJson.unexpected_cuts?.length === 0, "verify_cuts fails on a fade between identical color shots (invisible_transition, diff 0)", JSON.stringify(vcSameFadeJson.cuts));
// verify_cuts refuses a non-video input and a missing manifest.
const vcBadVideoText = await callExpectThrow("verify_cuts", { manifest_path: vcStage.manifestPath, video: path.join(root, "test/canvas-voice.mp3") });
checkOk(/needs a video input/.test(vcBadVideoText ?? ""), "verify_cuts refuses an audio-only video input", (vcBadVideoText ?? "").slice(0, 160));
const vcBadManifestText = await callExpectThrow("verify_cuts", { manifest_path: "/tmp/no-such-film-xyz.json", video: vcFinalPath });
checkOk(/not found|not readable/.test(vcBadManifestText ?? ""), "verify_cuts refuses a missing manifest", (vcBadManifestText ?? "").slice(0, 160));

// determinism (turn 83): the linear manifest tool must reproduce
// byte-identically across fresh renders (cache off — a cache hit
// would prove nothing). Fixture test/manifest-determinism.json
// (source.mp4, trim 2-8 + resize 640x360): measured on this machine,
// two identical libx264 encodes are byte-identical, so the verdict
// must be byte_identical with one sha256 + one framemd5 across runs.
// The pure comparator is unit-tested directly with fabricated rows
// (all three verdicts), so the MCP block only needs the real render.
const detRes = await client.callTool({ name: "determinism", arguments: { manifest_path: path.join(root, "test/manifest-determinism.json") } }, undefined, { timeout: 300000 });
const detJson = JSON.parse(detRes.content[0].text);
checkOk(detJson.verdict === "byte_identical" && detJson.deterministic === true && detJson.byte_identical === true && detJson.frames_identical === true && detJson.runs === 2 && detJson.runs_detail?.length === 2 && detJson.runs_detail[0].sha256 === detJson.runs_detail[1].sha256 && detJson.runs_detail[0].framemd5 === detJson.runs_detail[1].framemd5 && detJson.runs_detail[0].frames === 180 && detJson.runs_detail[0].dimensions === "640x360" && near(detJson.runs_detail[0].duration_seconds, 6, 0.05), "determinism on the trim+resize manifest: byte_identical, both runs one sha256 + one framemd5, 180 frames / 6s / 640x360", JSON.stringify(detJson.runs_detail?.map((r) => r.sha256.slice(0, 12))));
checkOk(readdirSync(path.join(root, "test")).filter((n) => n.startsWith(".mediakit-determinism-")).length === 0, "determinism removes its per-run temp dir by default", readdirSync(path.join(root, "test")).filter((n) => n.startsWith(".mediakit-")).join(", "));
const det3Res = await client.callTool({ name: "determinism", arguments: { manifest_path: path.join(root, "test/manifest-determinism.json"), runs: 3 } }, undefined, { timeout: 300000 });
const det3Json = JSON.parse(det3Res.content[0].text);
checkOk(det3Json.verdict === "byte_identical" && det3Json.runs === 3 && det3Json.runs_detail?.length === 3 && new Set(det3Json.runs_detail.map((r) => r.sha256)).size === 1, "determinism runs=3: three fresh renders, one sha256", JSON.stringify(det3Json.runs_detail?.map((r) => r.sha256.slice(0, 12))));
// Pure comparator, fabricated rows — every verdict branch without
// faking a nondeterministic render.
const detRow = (sha, frame, dur = 6, frames = 180, tags = {}) => ({ sha256: sha, framemd5: frame, duration_seconds: dur, frames, dimensions: "640x360", format_tags: tags });
checkOk(compareDeterminismRuns([detRow("a", "f"), detRow("a", "f")]).verdict === "byte_identical", "compareDeterminismRuns: equal bytes + frames -> byte_identical", JSON.stringify(compareDeterminismRuns([detRow("a", "f"), detRow("a", "f")]).verdict));
const detContent = compareDeterminismRuns([detRow("a", "f", 6, 180, { creation_time: "2026-11-17T06:00:00Z" }), detRow("b", "f", 6, 180, { creation_time: "2026-11-17T06:00:05Z" })]);
checkOk(detContent.verdict === "content_identical" && detContent.differing_format_tags?.includes("creation_time") && detContent.first_difference?.level === "bytes", "compareDeterminismRuns: same frames, different bytes + moved creation_time -> content_identical naming the tag", JSON.stringify(detContent));
const detDiff = compareDeterminismRuns([detRow("a", "f"), detRow("b", "g")]);
checkOk(detDiff.verdict === "differs" && detDiff.deterministic === false && detDiff.first_difference?.level === "frames" && JSON.stringify(detDiff.first_difference?.runs) === "[0,1]", "compareDeterminismRuns: different frames -> differs at the frames level with the run pair", JSON.stringify(detDiff.first_difference));
const detProps = compareDeterminismRuns([detRow("a", "f", 6, 180), detRow("a", "f", 6.5, 195)]);
checkOk(detProps.verdict === "differs" && detProps.frames_identical === true && detProps.first_difference?.level === "properties", "compareDeterminismRuns: same frames, moved duration -> differs at the properties level", JSON.stringify(detProps.first_difference));
// Error paths: runs below the schema minimum, and a missing manifest.
const detBadRuns = await callExpectThrow("determinism", { manifest_path: path.join(root, "test/manifest-determinism.json"), runs: 1 });
checkOk(/greater than or equal to 2/.test(detBadRuns), "determinism runs=1 is refused (zod schema, min 2)", detBadRuns.slice(0, 160));
const detMissingRes = await client.callTool({ name: "determinism", arguments: { manifest_path: path.join(root, "test/no-such-manifest.json") } });
const detMissingJson = JSON.parse(detMissingRes.content[0].text);
checkOk(detMissingRes.isError === true && /not found or not readable/.test(detMissingJson.error ?? ""), "determinism on a missing manifest errors instead of rendering", JSON.stringify(detMissingJson.error));

// ffmpeg -progress parsing (turn 84): pure — no ffmpeg spawn.
// Blocks end on their `progress=` line (no blank line between them);
// out_time_ms=N/A and speed=N/A parse to null, never NaN.
const progressMulti = parseFfmpegProgress("frame=0\nfps=0.00\nout_time_ms=N/A\nspeed=N/A\nprogress=continue\nframe=90\nfps=67.91\nout_time_us=2933333\nout_time_ms=2933333\nout_time=00:00:02.933333\nspeed=   6.34x\nprogress=end\n");
checkOk(progressMulti?.outTimeMs === 2933 && progressMulti?.frame === 90 && progressMulti?.speed === 6.34 && progressMulti?.done === true, "parseFfmpegProgress takes the LAST block of a multi-block chunk (out_time_ms 2933333us = 2933ms, frame 90, speed 6.34, done)", JSON.stringify(progressMulti));
const progressFirstBlock = parseFfmpegProgress("frame=0\nfps=0.00\nout_time_ms=N/A\nspeed=N/A\nprogress=continue\n");
checkOk(progressFirstBlock?.outTimeMs === null && progressFirstBlock?.frame === 0 && progressFirstBlock?.speed === null && progressFirstBlock?.done === false, "parseFfmpegProgress on the opening block: N/A times/speed become null, done=false", JSON.stringify(progressFirstBlock));
const progressTimeFallback = parseFfmpegProgress("frame=135\nout_time=00:00:04.500000\nprogress=continue\n");
checkOk(progressTimeFallback?.outTimeMs === 4500 && progressTimeFallback?.frame === 135 && progressTimeFallback?.done === false, "parseFfmpegProgress falls back to out_time HH:MM:SS.xx when out_time_ms is absent (4500ms)", JSON.stringify(progressTimeFallback));
const progressUsFallback = parseFfmpegProgress("frame=60\nout_time_us=2000000\nprogress=continue\n");
checkOk(progressUsFallback?.outTimeMs === 2000, "parseFfmpegProgress falls back to out_time_us / 1000 (2000000us = 2000ms)", JSON.stringify(progressUsFallback));
checkOk(parseFfmpegProgress("hello\nbitrate= 402.3kbits/s\n") === null && parseFfmpegProgress("") === null && parseFfmpegProgress("frame=12\n")?.frame === 12, "parseFfmpegProgress returns null on garbage/empty input, and still reads an unterminated block (frame 12)", "garbage->null, empty->null, unterminated->frame 12");
// runFfmpegWithProgress (turn 84): live encode, fractions must arrive
// DURING the encode (not only at the end), monotonic, ending at 1.
const progressOut = path.join(root, "outputs/mcp-progress.mp4");
const progressFractions = [];
await runFfmpegWithProgress(["-y", "-i", "test/source.mp4", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac", "-b:a", "192k", progressOut], {
  totalSeconds: 10, onProgress: (p) => progressFractions.push(+p.fraction.toFixed(3)),
});
const progressOutStreams = await probeStreams(progressOut);
const progressOutDuration = Number(progressOutStreams?.format?.duration);
checkOk(progressFractions.length >= 3 && progressFractions.every((v, i) => i === 0 || v >= progressFractions[i - 1]) && progressFractions.at(-1) === 1 && progressFractions.some((v) => v > 0 && v < 0.9) && near(progressOutDuration, 10, 0.2), "runFfmpegWithProgress streams fractions during a 10s medium encode (>=3 callbacks, monotonic, a mid value <0.9, final 1, output 10s)", `fractions=${JSON.stringify(progressFractions)} duration=${progressOutDuration}`);
await rm(progressOut, { force: true }).catch(() => {});

// diagnose (turn 64): director preflight — validate + measured
// judgement, probe-only. Fixtures: assemble-diagnose-pass.json (1
// moving video shot, 1280x720, no extras) must pass clean;
// assemble-diagnose-frozen.json (scenes-source: red 5s + blue 5s,
// static) must fail on shot motion; assemble-film.json must warn
// on the 2.67x upscale; the transitions film must measure real
// seams; a shots-sum mismatch must fail with format_error instead
// of throwing; a bottom text layer over burned captions must warn.
const diagPassStage = await stageAssembleManifest("assemble-diagnose-pass.json");
const diagPassRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagPassStage.manifestPath } });
const diagPassJson = JSON.parse(diagPassRes.content[0].text);
checkOk(diagPassJson.verdict === "pass" && diagPassJson.errors === 0 && diagPassJson.warnings === 0 && diagPassJson.total_seconds === 10 && diagPassJson.total_frames === 300, "diagnose passes a clean film (1 moving video shot, 1280x720, 10s/300f)", JSON.stringify({ verdict: diagPassJson.verdict, checks: diagPassJson.checks?.map((c) => `${c.id}:${c.severity}`) }));
checkOk(diagPassJson.checks?.find((c) => c.id === "shot_motion:s1")?.motion_verdict === "moving" && diagPassJson.checks?.find((c) => c.id === "shot_motion:s1")?.mean_motion > 0.01 && diagPassJson.checks?.find((c) => c.id === "voice_loudness")?.lufs === -22.14, "diagnose measures real motion (testsrc moving, mean > 0.01) and voice loudness (-22.14 LUFS) on the pass film", JSON.stringify(diagPassJson.checks?.filter((c) => c.id.startsWith("shot_motion") || c.id === "voice_loudness")));
const diagFrozenStage = await stageAssembleManifest("assemble-diagnose-frozen.json");
const diagFrozenRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagFrozenStage.manifestPath } });
const diagFrozenJson = JSON.parse(diagFrozenRes.content[0].text);
checkOk(diagFrozenJson.verdict === "fail" && diagFrozenJson.errors === 1 && diagFrozenJson.checks?.find((c) => c.id === "shot_motion:fs1")?.severity === "error" && diagFrozenJson.checks?.find((c) => c.id === "shot_motion:fs1")?.motion_verdict === "static", "diagnose fails a frozen video shot (scenes-source reads static) with an error, not a warning", JSON.stringify(diagFrozenJson.checks?.map((c) => `${c.id}:${c.severity}`)));
const diagFilmStage = await stageAssembleManifest("assemble-film.json");
const diagFilmRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagFilmStage.manifestPath } });
const diagFilmJson = JSON.parse(diagFilmRes.content[0].text);
checkOk(diagFilmJson.verdict === "warn" && diagFilmJson.warnings === 3 && diagFilmJson.checks?.filter((c) => c.id.startsWith("shot_geometry:") && c.severity === "warn").length === 3 && diagFilmJson.checks?.find((c) => c.id === "shot_geometry:s2")?.upscale === 2.67, "diagnose warns on the 2.67x upscale of all three image/video shots in the vertical film (verdict warn, 3 warnings)", JSON.stringify(diagFilmJson.checks?.map((c) => `${c.id}:${c.severity}`)));
checkOk(diagFilmJson.checks?.find((c) => c.id === "captions_coverage")?.coverage === 0.8 && diagFilmJson.checks?.find((c) => c.id === "music_loop")?.loops === 2 && diagFilmJson.checks?.find((c) => c.id === "shot_motion:s2")?.motion_verdict === "moving", "diagnose measures captions coverage 0.8, music loops 2 and moving video on the full film", JSON.stringify(diagFilmJson.checks?.filter((c) => ["captions_coverage", "music_loop", "shot_motion:s2"].includes(c.id))));
const diagTransStage = await stageAssembleManifest("assemble-film-transitions.json");
const diagTransRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagTransStage.manifestPath } });
const diagTransJson = JSON.parse(diagTransRes.content[0].text);
checkOk(diagTransJson.checks?.find((c) => c.id === "transition_seam:s2")?.severity === "pass" && diagTransJson.checks?.find((c) => c.id === "transition_seam:s2")?.seam > 50 && diagTransJson.checks?.find((c) => c.id === "transition_seam:s3")?.severity === "pass", "diagnose measures real transition seams (fade image→video and dissolve video→image both pass with seam > 50)", JSON.stringify(diagTransJson.checks?.filter((c) => c.id.startsWith("transition_seam"))));
// A format failure is a finding, not a throw: shots that do not
// sum to the voice timeline come back as verdict fail +
// format_error, so the caller can fix the manifest and re-run.
const diagBadStage = await stageAssembleManifest("assemble-film.json");
const diagBadDoc = JSON.parse(await readFile(diagBadStage.manifestPath, "utf8"));
diagBadDoc.shots[0].duration = 3;
await writeFile(diagBadStage.manifestPath, JSON.stringify(diagBadDoc), "utf8");
const diagBadRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagBadStage.manifestPath } });
const diagBadJson = JSON.parse(diagBadRes.content[0].text);
checkOk(diagBadJson.verdict === "fail" && /shots cover/.test(diagBadJson.format_error ?? "") && diagBadJson.checks?.[0]?.id === "format", "diagnose returns verdict fail with format_error (not a throw) when the shots do not sum to the voice timeline", JSON.stringify({ verdict: diagBadJson.verdict, format_error: diagBadJson.format_error }));
// A bottom text layer over burned captions warns.
const diagTextStage = await stageAssembleManifest("assemble-film.json");
const diagTextDoc = JSON.parse(await readFile(diagTextStage.manifestPath, "utf8"));
diagTextDoc.shots[0].text = [{ text: "Hello from the bottom", position: "bottom", size: 64 }];
await writeFile(diagTextStage.manifestPath, JSON.stringify(diagTextDoc), "utf8");
const diagTextRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagTextStage.manifestPath } });
const diagTextJson = JSON.parse(diagTextRes.content[0].text);
checkOk(diagTextJson.checks?.some((c) => c.id === "text_layer" && c.severity === "warn" && /caption band/.test(c.message)), "diagnose warns on a bottom text layer sitting in the burned-caption band", JSON.stringify(diagTextJson.checks?.filter((c) => c.id === "text_layer")));
checkOk(diagTextJson.verdict === "warn" && diagTextJson.warnings === 4, "the bottom-text film still warns overall (3 upscale + 1 text layer)", JSON.stringify({ verdict: diagTextJson.verdict, warnings: diagTextJson.warnings }));
// Bounce apex vs top text layer (turn 102): the default apex
// 0.12H puts the ball top at 0.075H, inside a 1-line top title
// band (drawtext y=0.08H, 90px → ends 0.127H) — diagnose warns
// with the numbers; apex 0.35 lifts the ball top to 0.305H, clear
// of the band, and the film passes.
const diagBounceStage = await stageAssembleManifest("assemble-template.json");
const diagBounceDoc = JSON.parse(await readFile(diagBounceStage.manifestPath, "utf8"));
diagBounceDoc.shots[0].text = [{ text: "BOUNCE TITLE", position: "top" }];
await writeFile(diagBounceStage.manifestPath, JSON.stringify(diagBounceDoc), "utf8");
const diagBounceRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagBounceStage.manifestPath } });
const diagBounceJson = JSON.parse(diagBounceRes.content[0].text);
checkOk(diagBounceJson.verdict === "warn" && diagBounceJson.warnings === 1 && diagBounceJson.checks?.some((c) => c.id === "text_layer" && c.severity === "warn" && /bounce apex 0.12 reaches 0.075H/.test(c.message) && /ends 0.127H/.test(c.message)), "diagnose warns when the default bounce apex reaches into a top text band (0.075H vs band ends 0.127H)", JSON.stringify(diagBounceJson.checks?.filter((c) => c.id === "text_layer")));
const diagBounceApexStage = await stageAssembleManifest("assemble-template.json");
const diagBounceApexDoc = JSON.parse(await readFile(diagBounceApexStage.manifestPath, "utf8"));
diagBounceApexDoc.shots[0].text = [{ text: "BOUNCE TITLE", position: "top" }];
diagBounceApexDoc.shots[0].params.apex = 0.35;
await writeFile(diagBounceApexStage.manifestPath, JSON.stringify(diagBounceApexDoc), "utf8");
const diagBounceApexRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagBounceApexStage.manifestPath } });
const diagBounceApexJson = JSON.parse(diagBounceApexRes.content[0].text);
checkOk(diagBounceApexJson.verdict === "pass" && diagBounceApexJson.warnings === 0 && !diagBounceApexJson.checks?.some((c) => c.id === "text_layer" && c.severity === "warn"), "diagnose passes the same film with bounce apex 0.35 (ball clears the top text band)", JSON.stringify({ verdict: diagBounceApexJson.verdict, warnings: diagBounceApexJson.warnings }));
// Style pace in diagnose (lượt 133, idea: Takes check_edit): the
// 20s style fixtures are 4 canvas shots (no source files, so no
// geometry/motion checks fire) — only the style_pace checks differ.
// Pass: 4x5s = 9 cuts/min vs style 12, longest hold 5s vs 8s.
const diagStylePassStage = await stageAssembleManifest("assemble-style-pass.json");
const diagStylePassRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagStylePassStage.manifestPath, style_file: path.join(root, "test/style-warm.json") } });
const diagStylePassJson = JSON.parse(diagStylePassRes.content[0].text);
checkOk(diagStylePassJson.verdict === "pass" && diagStylePassJson.warnings === 0 && diagStylePassJson.checks?.filter((c) => c.id === "style_pace").length === 2 && diagStylePassJson.checks?.filter((c) => c.id === "style_pace").every((c) => c.severity === "pass"), "diagnose scores the 4x5s film against the warm-story style: 9 cuts/min + 5s hold both pass, verdict pass", JSON.stringify(diagStylePassJson.checks?.filter((c) => c.id === "style_pace")));
// Slow: 2x10s = 3 cuts/min vs style 12 — under the 2x floor, warn
// with the Takes fix; the 10s hold is inside max(8x1.5, 8+2) = 12.
const diagStyleSlowStage = await stageAssembleManifest("assemble-style-slow.json");
const diagStyleSlowRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagStyleSlowStage.manifestPath, style_file: path.join(root, "test/style-warm.json") } });
const diagStyleSlowJson = JSON.parse(diagStyleSlowRes.content[0].text);
checkOk(diagStyleSlowJson.verdict === "warn" && diagStyleSlowJson.warnings === 1 && diagStyleSlowJson.checks?.some((c) => c.id === "style_pace" && c.severity === "warn" && /cuts 3 times a minute; warm-story cuts 12/.test(c.message) && /Fewer cuts/.test(c.fix ?? "")), "diagnose warns on the 2x10s film: 3 cuts/min is fewer than the style, with the fix attached", JSON.stringify(diagStyleSlowJson.checks?.filter((c) => c.id === "style_pace")));
// Hold: 5/10/5 = 6 cuts/min (in range) but the 10s hold beats the
// tight style's 6s limit — warn with the shot's start time.
const diagStyleHoldStage = await stageAssembleManifest("assemble-style-hold.json");
const diagStyleHoldRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagStyleHoldStage.manifestPath, style_file: path.join(root, "test/style-hold4.json") } });
const diagStyleHoldJson = JSON.parse(diagStyleHoldRes.content[0].text);
checkOk(diagStyleHoldJson.verdict === "warn" && diagStyleHoldJson.warnings === 1 && diagStyleHoldJson.checks?.some((c) => c.id === "style_pace" && c.severity === "warn" && c.metric === "longest_hold_s" && /holds 10 s from 5 s; tight holds at most 4 s/.test(c.message) && /Cut a pause/.test(c.fix ?? "")), "diagnose warns when the 10s hold beats the tight style's 6s limit, naming the shot start", JSON.stringify(diagStyleHoldJson.checks?.filter((c) => c.id === "style_pace")));
// Under 15s the film is too short to compare: info, not a score.
const diagStyleShortStage = await stageAssembleManifest("assemble-diagnose-pass.json");
const diagStyleShortRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagStyleShortStage.manifestPath, style_file: path.join(root, "test/style-warm.json") } });
const diagStyleShortJson = JSON.parse(diagStyleShortRes.content[0].text);
checkOk(diagStyleShortJson.checks?.some((c) => c.id === "style_pace" && c.severity === "info" && /too short to compare/.test(c.message)), "diagnose reports info (not a score) for a 10s film under the 15s pace minimum", JSON.stringify(diagStyleShortJson.checks?.filter((c) => c.id === "style_pace")));
// A broken style file is an error, not a silent skip; a style with
// no pace block is an info telling the director to measure one.
const diagStyleBadStage = await stageAssembleManifest("assemble-style-pass.json");
const diagStyleBadRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagStyleBadStage.manifestPath, style_file: path.join(root, "test/style-bad.json") } });
const diagStyleBadJson = JSON.parse(diagStyleBadRes.content[0].text);
checkOk(diagStyleBadJson.verdict === "fail" && diagStyleBadJson.errors === 1 && diagStyleBadJson.checks?.some((c) => c.id === "style_pace" && c.severity === "error" && /not usable/.test(c.message)), "diagnose fails when the style file is broken (cuts_per_min 0)", JSON.stringify(diagStyleBadJson.checks?.filter((c) => c.id === "style_pace")));
const diagStyleNoPaceStage = await stageAssembleManifest("assemble-style-pass.json");
const diagStyleNoPaceRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: diagStyleNoPaceStage.manifestPath, style_file: path.join(root, "test/style-nopace.json") } });
const diagStyleNoPaceJson = JSON.parse(diagStyleNoPaceRes.content[0].text);
checkOk(diagStyleNoPaceJson.checks?.some((c) => c.id === "style_pace" && c.severity === "info" && /has no pace block/.test(c.message)), "diagnose reports info when the style carries no pace block", JSON.stringify(diagStyleNoPaceJson.checks?.filter((c) => c.id === "style_pace")));
// Auto-load: a style.json sitting next to the film is used without
// a flag; without one, no style_pace check appears at all.
const diagStyleAutoDir = path.join(root, "outputs/mcp-style-auto");
await rm(diagStyleAutoDir, { recursive: true, force: true });
await mkdir(diagStyleAutoDir, { recursive: true });
await copyFile(path.join(root, "test/assemble-style-pass.json"), path.join(diagStyleAutoDir, "film.json"));
await copyFile(path.join(root, "test/style-warm.json"), path.join(diagStyleAutoDir, "style.json"));
await copyFile(path.join(root, "test/mix-voice.mp3"), path.join(diagStyleAutoDir, "mix-voice.mp3"));
const diagStyleAutoRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: path.join(diagStyleAutoDir, "film.json") } });
const diagStyleAutoJson = JSON.parse(diagStyleAutoRes.content[0].text);
checkOk(diagStyleAutoJson.verdict === "pass" && diagStyleAutoJson.checks?.filter((c) => c.id === "style_pace").length === 2 && diagStyleAutoJson.checks?.find((c) => c.id === "style_pace")?.style_source === "auto", "diagnose auto-loads the style.json next to the film (style_source auto, both metrics pass)", JSON.stringify(diagStyleAutoJson.checks?.filter((c) => c.id === "style_pace")));
const diagStyleNoneDir = path.join(root, "outputs/mcp-style-none");
await rm(diagStyleNoneDir, { recursive: true, force: true });
await mkdir(diagStyleNoneDir, { recursive: true });
await copyFile(path.join(root, "test/assemble-style-pass.json"), path.join(diagStyleNoneDir, "film.json"));
await copyFile(path.join(root, "test/mix-voice.mp3"), path.join(diagStyleNoneDir, "mix-voice.mp3"));
const diagStyleNoneRes = await client.callTool({ name: "diagnose", arguments: { manifest_path: path.join(diagStyleNoneDir, "film.json") } });
const diagStyleNoneJson = JSON.parse(diagStyleNoneRes.content[0].text);
checkOk(!diagStyleNoneJson.checks?.some((c) => c.id === "style_pace"), "diagnose adds no style_pace check when there is no style file anywhere", JSON.stringify(diagStyleNoneJson.checks?.map((c) => c.id)));
// The same pass film through the CLI with --style-file.
const diagStyleCli = await runCliJson(["diagnose", diagStylePassStage.manifestPath, "--style-file", path.join(root, "test/style-warm.json")]);
checkOk(diagStyleCli.verdict === "pass" && diagStyleCli.checks?.filter((c) => c.id === "style_pace").length === 2, "CLI diagnose --style-file scores the film the same way", JSON.stringify(diagStyleCli.checks?.filter((c) => c.id === "style_pace")));
const diagDoctorRes = await client.callTool({ name: "doctor", arguments: {} });
const diagDoctorJson = JSON.parse(diagDoctorRes.content[0].text);
checkOk(diagDoctorJson.tools?.diagnose?.available === true, "doctor reports diagnose as available", JSON.stringify(diagDoctorJson.tools?.diagnose));

// Chapters (turn 65): auto-chapters from measured pauses. The
// fixture has 3 word groups (gaps 3.0s and 4.2s) starting at 1.5s,
// so the first chapter clamps to 0 and titles come from the words.
const chapWordsRes = await client.callTool({ name: "chapters", arguments: { words_file: path.join(root, "test/chapters-words.json") } });
const chapWords = JSON.parse(chapWordsRes.content[0].text);
checkOk(chapWords.mode === "words" && chapWords.count === 3 && chapWords.chapters?.[0]?.title === "Welcome to the show" && chapWords.chapters[0].at === 0 && chapWords.chapters?.[1]?.title === "Today we build chapters" && chapWords.chapters[1].at === 6 && chapWords.chapters?.[2]?.title === "And now the finale" && chapWords.chapters[2].at === 12 && chapWords.first_chapter_clamped_to_zero === true && chapWords.first_segment_starts_at_seconds === 1.5 && chapWords.merged_segments === 0, "chapters from words: 3 chapters at 0/6/12 with titles from the first words, first clamped to 0", JSON.stringify(chapWords.chapters));
const chapMergeRes = await client.callTool({ name: "chapters", arguments: { words_file: path.join(root, "test/chapters-words.json"), max_chapters: 2 } });
const chapMerge = JSON.parse(chapMergeRes.content[0].text);
checkOk(chapMerge.count === 2 && chapMerge.merged_segments === 1 && chapMerge.segments_found === 3 && chapMerge.chapters?.[0]?.title === "Welcome to the show" && chapMerge.chapters?.[1]?.at === 12, "chapters merges the closest neighbours first over the cap (3 -> 2, smallest gap 3.0s merged)", JSON.stringify(chapMerge.chapters));
const chapTitleRes = await client.callTool({ name: "chapters", arguments: { words_file: path.join(root, "test/chapters-words.json"), title_words: 2 } });
const chapTitle = JSON.parse(chapTitleRes.content[0].text);
checkOk(chapTitle.chapters?.[0]?.title === "Welcome to" && chapTitle.chapters?.[1]?.title === "Today we", "chapters title_words=2 takes two words per title", JSON.stringify(chapTitle.chapters));
const chapOutPath = path.join(root, "outputs/mcp-chapters.json");
const chapOutRes = await client.callTool({ name: "chapters", arguments: { words_file: path.join(root, "test/chapters-words.json"), output: chapOutPath } });
const chapOut = JSON.parse(chapOutRes.content[0].text);
const chapOutFile = JSON.parse(await readFile(chapOutPath, "utf8"));
checkOk(chapOut.output === chapOutPath && Array.isArray(chapOutFile.chapters) && chapOutFile.chapters.length === 3 && chapOutFile.chapters[0].title === "Welcome to the show" && chapOutFile.chapters[0].at === 0, "chapters --output writes the assemble-shape {chapters:[{title, at}]} JSON to disk", JSON.stringify(chapOutFile).slice(0, 200));
// Silence mode: mix-voice has tone [0,2),[4,6),[7,9) — silences
// measure 1.997s and 0.998s, so min_gap 0.9 splits all three.
const chapSilRes = await client.callTool({ name: "chapters", arguments: { input: path.join(root, "test/mix-voice.mp3"), min_gap: 0.9 } });
const chapSil = JSON.parse(chapSilRes.content[0].text);
checkOk(chapSil.mode === "silence" && chapSil.count === 3 && chapSil.chapters?.[0]?.title === "Part 1" && chapSil.chapters[0].at === 0 && near(chapSil.chapters?.[1]?.at, 4.017, 0.01) && near(chapSil.chapters?.[2]?.at, 7.012, 0.01), "chapters from silence: 3 speech segments at 0/4.017/7.012 titled Part 1..3", JSON.stringify(chapSil.chapters));
const chapSilGapRes = await client.callTool({ name: "chapters", arguments: { input: path.join(root, "test/mix-voice.mp3"), min_gap: 1.9 } });
const chapSilGap = JSON.parse(chapSilGapRes.content[0].text);
checkOk(chapSilGap.count === 2 && chapSilGap.chapters?.[1]?.title === "Part 2", "chapters min_gap 1.9 keeps only the 1.997s pause as a boundary (the 0.998s pause does not split; min_gap 2 would keep neither — the pause measures 1.997s, not 2.000s)", JSON.stringify(chapSilGap.chapters));
const chapBothText = await callExpectThrow("chapters", { words_file: path.join(root, "test/chapters-words.json"), input: path.join(root, "test/mix-voice.mp3") });
checkOk(/exactly one source/.test(chapBothText ?? ""), "chapters refuses words_file + input together", chapBothText ?? "");
const chapNoneText = await callExpectThrow("chapters", {});
checkOk(/exactly one source/.test(chapNoneText ?? ""), "chapters refuses no source at all", chapNoneText ?? "");
const chapBadWordsPath = path.join(root, "outputs/mcp-chapters-bad.json");
await writeFile(chapBadWordsPath, "{\"words\": [{\"start\": 0}]}", "utf8");
const chapBadText = await callExpectThrow("chapters", { words_file: chapBadWordsPath });
checkOk(/chapters/.test(chapBadText ?? ""), "chapters refuses a malformed words file with its own name on the error", chapBadText ?? "");
const chapDoctorRes = await client.callTool({ name: "doctor", arguments: {} });
const chapDoctor = JSON.parse(chapDoctorRes.content[0].text);
checkOk(chapDoctor.tools?.chapters?.available === true, "doctor reports chapters as available", JSON.stringify(chapDoctor.tools?.chapters));

// Transition catalog (turn 91): the grouped list concat / slideshow /
// assemble accept — one source of truth in TRANSITION_CATEGORIES, so
// the docs count can never drift from the validator again (it did:
// cover* took the list to 52 while the docs kept saying 49).
const transRes = await client.callTool({ name: "transitions", arguments: {} });
const trans = JSON.parse(transRes.content[0].text);
const transNames = trans.categories.flatMap((c) => c.transitions);
checkOk(trans.operation === "transitions" && trans.total === 58 && trans.categories.length === 11 && transNames.length === 58, "transitions returns the full catalog: 58 names in 11 categories", `total=${trans.total} categories=${trans.categories.length}`);
checkOk(new Set(transNames).size === 58 && trans.categories.every((c) => c.count === c.transitions.length && c.transitions.length > 0 && typeof c.description === "string" && c.description.length > 10), "transitions: every name in exactly one category, counts match, every family has a description", JSON.stringify(trans.categories.map((c) => `${c.name}:${c.count}`)));
checkOk(transNames.includes("fadefast") && transNames.includes("fadeslow") && ["revealleft", "revealright", "revealup", "revealdown"].every((n) => transNames.includes(n)), "transitions includes the 6 names ffmpeg 8.1.2 adds over the old 52 (fadefast/fadeslow/reveal*)", "");
const transWipeRes = await client.callTool({ name: "transitions", arguments: { category: "wipe" } });
const transWipe = JSON.parse(transWipeRes.content[0].text);
checkOk(transWipe.total === 8 && transWipe.category === "wipe" && JSON.stringify(transWipe.categories[0].transitions) === JSON.stringify(["wipeleft", "wiperight", "wipeup", "wipedown", "wipetl", "wipetr", "wipebl", "wipebr"]), "transitions --category wipe narrows to the 8 wipes", JSON.stringify(transWipe.categories[0].transitions));
const transBadText = await callExpectThrow("transitions", { category: "nosuch" });
checkOk(/unknown transition category/.test(transBadText ?? "") && /fade, wipe/.test(transBadText ?? ""), "transitions refuses an unknown category with the valid list", (transBadText ?? "").slice(0, 200));
// The catalog IS the validator: concat's "unknown transition" error
// must list exactly the catalog's names — if a category is edited
// without the validator (or vice versa) this fails.
const transConcatBadText = await callExpectThrow("concat", { inputs: [path.join(root, "test/source.mp4"), path.join(root, "test/source.mp4")], output: path.join(root, "outputs/mcp-concat-bad-transition.mp4"), transition: "nosuch" });
const transMissing = transNames.filter((n) => !transConcatBadText.includes(n));
checkOk(/unknown transition/.test(transConcatBadText ?? "") && transMissing.length === 0, "concat's unknown-transition error lists exactly the catalog's 58 names (one source of truth)", `missing from error: ${transMissing.join(", ")}`);
// README catalog section must list every name too — the docs drift
// guard only checks tool names, so this pins the catalog table.
const readmeText = await readFile(path.join(root, "README.md"), "utf8");
const readmeCatalog = readmeText.slice(readmeText.indexOf("| Family |"), readmeText.indexOf("58 names in total"));
const readmeMissing = transNames.filter((n) => !readmeCatalog.includes(`\`${n}\``));
checkOk(readmeCatalog.length > 0 && readmeMissing.length === 0, "README transition catalog table lists all 58 names", `missing: ${readmeMissing.join(", ")}`);
// CLI: full catalog + one category + bad category exits 2.
const transCli = await runCliJson(["transitions"]);
checkOk(transCli.total === 58 && transCli.categories.length === 11, "CLI transitions returns the full catalog (58 / 11)", `total=${transCli.total}`);
const transCliReveal = await runCliJson(["transitions", "--category", "reveal"]);
checkOk(transCliReveal.total === 4 && JSON.stringify(transCliReveal.categories[0].transitions) === JSON.stringify(["revealleft", "revealright", "revealup", "revealdown"]), "CLI transitions --category reveal returns the 4 reveals", JSON.stringify(transCliReveal.categories[0].transitions));
let transCliBadCode = 0;
try { await execFileAsync(process.execPath, [path.join(root, "bin/mediakit.js"), "transitions", "--category", "nosuch"], { env: { ...process.env } }); } catch (e) { transCliBadCode = e.code; }
checkOk(transCliBadCode === 2, "CLI transitions --category nosuch exits 2", `code=${transCliBadCode}`);
// CLI unknown-option guard (lượt 92 — the lượt 91 trap: `concat
// --transitions fade` silently ran a plain 20s concat because
// parseArgs swallowed the plural flag). Every --flag a case reads
// must be declared in that command's COMMANDS options, or the CLI
// refuses it with exit 2 instead of running the wrong thing.
const guardTypo = await runCli(["concat", path.join(root, "test/source.mp4"), path.join(root, "test/source.mp4"), "--transitions", "fade", "-o", path.join(root, "outputs/mcp-concat-typo.mp4")]);
checkOk(guardTypo.code === 2 && /unknown option --transitions/.test(guardTypo.out) && /did you mean --transition\?/.test(guardTypo.out) && !existsSync(path.join(root, "outputs/mcp-concat-typo.mp4")), "CLI concat --transitions exits 2, names the flag, suggests --transition, and writes nothing", guardTypo.out.slice(0, 200));
const guardNearMiss = await runCli(["concat", path.join(root, "test/source.mp4"), path.join(root, "test/source.mp4"), "--transiton", "fade", "-o", path.join(root, "outputs/mcp-concat-typo2.mp4")]);
checkOk(guardNearMiss.code === 2 && /unknown option --transiton/.test(guardNearMiss.out) && /did you mean --transition\?/.test(guardNearMiss.out), "CLI concat --transiton (one letter off) also suggests --transition", guardNearMiss.out.slice(0, 200));
const guardCrossCmd = await runCli(["trim", path.join(root, "test/source.mp4"), "--start", "0", "--duration", "2", "--transition-duration", "1", "-o", path.join(root, "outputs/mcp-trim-typo.mp4")]);
checkOk(guardCrossCmd.code === 2 && /unknown option --transition-duration/.test(guardCrossCmd.out) && !/did you mean/.test(guardCrossCmd.out), "CLI trim --transition-duration exits 2: a concat-only flag is not accepted on trim (and no bogus suggestion, --transition is not a trim flag)", guardCrossCmd.out.slice(0, 200));
const guardNoFlag = await runCli(["trim", path.join(root, "test/source.mp4"), "--start", "0", "--duration", "2", "--no-foo", "-o", path.join(root, "outputs/mcp-trim-typo2.mp4")]);
checkOk(guardNoFlag.code === 2 && /unknown option --no-foo/.test(guardNoFlag.out) && !/did you mean/.test(guardNoFlag.out), "CLI trim --no-foo exits 2 and names the flag as typed (no far-fetched suggestion)", guardNoFlag.out.slice(0, 200));
const guardEqForm = await runCli(["trim", path.join(root, "test/source.mp4"), "--start=0", "--duration", "2", "--bogus=1", "-o", path.join(root, "outputs/mcp-trim-typo3.mp4")]);
checkOk(guardEqForm.code === 2 && /unknown option --bogus/.test(guardEqForm.out), "CLI --bogus=1 (equals form) is refused too", guardEqForm.out.slice(0, 200));
// The drift the guard exposed while it was built: rotate's COMMANDS
// entry spelled its list `opts:` instead of `options:`, so --help
// printed no options; motion's --adaptive trio and batch's
// --output-dir alias were read by their cases but never declared.
// All three must be accepted now that they are declared.
const guardRotateHelp = await runCli(["rotate", "--help"]);
checkOk(guardRotateHelp.code === 0 && /--flip/.test(guardRotateHelp.out) && /--angle/.test(guardRotateHelp.out), "CLI rotate --help lists --flip and --angle (the opts: typo is fixed)", guardRotateHelp.out.slice(0, 200));
const guardRotateFlip = await runCliJson(["rotate", path.join(root, "test/rotate-source.mp4"), "--flip", "horizontal", "-o", path.join(root, "outputs/mcp-rotate-flip.mp4")]);
checkOk(guardRotateFlip.dimensions === "640x360" && guardRotateFlip.flip === "horizontal" && guardRotateFlip.output_rotation === null, "CLI rotate --flip horizontal runs (declared now) and keeps 640x360 with no rotation left", JSON.stringify(guardRotateFlip));
const guardMotionAdaptive = await runCliJson(["motion", path.join(root, "test/motion-noise-light.mp4"), "--adaptive"]);
checkOk(guardMotionAdaptive.verdict === "static" && guardMotionAdaptive.threshold > 0.001, "CLI motion --adaptive runs (declared now) and calibrates the threshold above the fixed 0.001", `verdict=${guardMotionAdaptive.verdict} thr=${guardMotionAdaptive.threshold}`);
const guardBatchOutDir = await runCliJson(["batch", "bpm", "--pattern", "bpm-click-120.wav", "--input-dir", "test", "--output-dir", path.join(root, "outputs/mcp-batch-outdir"), "--dry-run"]);
checkOk(guardBatchOutDir.dry_run === true && guardBatchOutDir.files_total === 1 && guardBatchOutDir.output_dir === path.join(root, "outputs/mcp-batch-outdir"), "CLI batch --output-dir runs (declared alias now) and dry-runs 1 file into it", JSON.stringify(guardBatchOutDir).slice(0, 200));
// Static audit: the allowlist must stay true — parse bin/mediakit.js
// and assert every option a case reads (opts.x, numOpt(opts, "x"),
// tripleOpt(opts, "x")) is declared in that command's COMMANDS
// options, and no command entry misspells the list key as `opts:`.
// This pins the motion/batch/rotate drift class so it cannot recur.
const cliSrc = await readFile(path.join(root, "bin/mediakit.js"), "utf8");
const cliBlock = cliSrc.slice(cliSrc.indexOf("const COMMANDS"), cliSrc.indexOf("function printHelp"));
const cliCmdOpts = {};
for (const em of cliBlock.matchAll(/^  (?:"([^"]+)"|([\w-]+)): \{([\s\S]*?)^  \},$/gm)) {
  const name = em[1] || em[2];
  const om = em[3].match(/(?:options|opts): \[([\s\S]*?)\n    \],/);
  const keys = new Set(["help", "output"]);
  if (om) for (const line of om[1].split("\n")) {
    const fm = line.match(/\[("([^"]+)")/);
    if (!fm) continue;
    for (const part of fm[2].split(",")) {
      const f = part.trim();
      if (f) keys.add(f.startsWith("--no-") ? f.slice(5).replace(/-/g, "_") : f.replace(/^--?/, "").replace(/-/g, "_"));
    }
  }
  cliCmdOpts[name] = keys;
}
const cliSwitch = cliSrc.slice(cliSrc.indexOf("switch (cmd)"));
const cliCases = [...cliSwitch.matchAll(/case "([\w-]+)":/g)].map((m) => [m[1], m.index]);
cliCases.push(["__END__", cliSwitch.length]);
const cliDrift = [];
for (let i = 0; i < cliCases.length - 1; i++) {
  const [name, start] = cliCases[i];
  const body = cliSwitch.slice(start, cliCases[i + 1][1]);
  const used = new Set([
    ...[...body.matchAll(/opts\.([a-z_0-9]+)/g)].map((x) => x[1]),
    ...[...body.matchAll(/numOpt\(opts, "([a-z_0-9]+)"\)/g)].map((x) => x[1]),
    ...[...body.matchAll(/tripleOpt\(opts, "([a-z_0-9]+)"\)/g)].map((x) => x[1]),
  ]);
  const allowed = cliCmdOpts[name];
  if (!allowed) { cliDrift.push(`${name}: no COMMANDS entry`); continue; }
  for (const k of used) if (!allowed.has(k)) cliDrift.push(`${name}: reads undeclared --${k.replace(/_/g, "-")}`);
}
checkOk(cliDrift.length === 0, "static audit: every option a CLI case reads is declared in its COMMANDS options (no drift)", cliDrift.join("; "));
checkOk(!/^\s+opts: \[$/m.test(cliBlock), "static audit: no COMMANDS entry misspells its list key as opts: (rotate typo class)", "");
const transDoctorRes = await client.callTool({ name: "doctor", arguments: {} });
const transDoctor = JSON.parse(transDoctorRes.content[0].text);
checkOk(transDoctor.tools?.transitions?.available === true, "doctor reports transitions as available", JSON.stringify(transDoctor.tools?.transitions));
// Transitions: the same film with a fade into s2, a dissolve into
// s3 and a fade into s4. Total duration and frame count must stay
// exactly 10s / 300 frames — the transitions are centered on the
// cuts and consume handles, never the timeline. The blend is
// measured, not assumed: the frame at the center of the s1->s2
// fade must be a 50/50 mix of the two pure segment frames
// (PSNR(blend, A) ≈ PSNR(blend, B) ≈ PSNR(A, B) + 6 dB).
const assembleTransStage = await stageAssembleManifest("assemble-film-transitions.json");
const assembleTransOut = path.join(assembleTransStage.dir, "out");
const assembleTransValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTransStage.manifestPath, mode: "validate" } });
const assembleTransValidateJson = JSON.parse(assembleTransValidateRes.content[0].text);
checkOk(assembleTransValidateJson.total_seconds === 10 && assembleTransValidateJson.total_frames === 300 && assembleTransValidateJson.shots?.[1]?.transition?.type === "fade" && assembleTransValidateJson.shots?.[1]?.transition?.frames === 30 && assembleTransValidateJson.shots?.[2]?.transition?.type === "dissolve" && assembleTransValidateJson.shots?.[2]?.transition?.frames === 15 && assembleTransValidateJson.shots?.[3]?.transition?.type === "fade", "assemble validate reports the 3 transitions (fade 30f, dissolve 15f, fade 15f) with the timeline still 10s / 300 frames", JSON.stringify(assembleTransValidateJson.shots?.map((s) => s.transition)));
const assembleTransFirstText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-transition-first.json"), mode: "validate" });
checkOk(/the first shot cannot have a transition/.test(assembleTransFirstText ?? ""), "assemble validate refuses a transition on the first shot", assembleTransFirstText ?? "");
const assembleTransLongText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-transition-long.json"), mode: "validate" });
checkOk(/longer than the shorter adjacent shot/.test(assembleTransLongText ?? ""), "assemble validate refuses a transition longer than the shorter adjacent shot", assembleTransLongText ?? "");
const assembleTransHandleText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-transition-handle.json"), mode: "validate" });
checkOk(/needs 0\.500s of handle before the shot start/.test(assembleTransHandleText ?? ""), "assemble validate refuses a video shot without handle footage for its transition", assembleTransHandleText ?? "");
const assembleTransPreviewRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTransStage.manifestPath, mode: "preview", output_dir: assembleTransOut, preview_seconds: 5 } });
const assembleTransPreviewJson = JSON.parse(assembleTransPreviewRes.content[0].text);
const assembleTransPreviewPath = path.join(assembleTransOut, "preview.mp4");
const assembleTransPreviewFrames = await countFrames(assembleTransPreviewPath);
checkOk(assembleTransPreviewJson.preview_seconds === 5 && assembleTransPreviewJson.dimensions === "540x960" && assembleTransPreviewFrames === 150 && Array.isArray(assembleTransPreviewJson.transition_warnings) && assembleTransPreviewJson.transition_warnings.length === 0, "assemble preview 5s with a transition keeps 150 frames at 540x960 and drops no transition", JSON.stringify(assembleTransPreviewJson.transition_warnings));
// The transitions render re-encodes the whole join (xfade) plus the
// burn, so it is the slowest call in the suite — past the SDK's
// 60s default timeout when the machine is busy (the 2h cron fired
// mid-suite once). Same 300s override as the other long call.
const assembleTransRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTransStage.manifestPath, mode: "render", output_dir: assembleTransOut, force: true } }, undefined, { timeout: 300000 });
const assembleTransRenderJson = JSON.parse(assembleTransRenderRes.content[0].text);
const assembleTransFinalPath = path.join(assembleTransOut, "final.mp4");
const assembleTransFinalProbe = await probeStreams(assembleTransFinalPath);
const assembleTransFinalFrames = await countFrames(assembleTransFinalPath);
const assembleTransFinalLufs = await measureLufs(assembleTransFinalPath);
checkOk(assembleTransRenderJson.approval === "forced" && assembleTransRenderJson.joins?.length === 3 && assembleTransRenderJson.joins?.map((j) => j.type).join(",") === "fade,dissolve,fade" && near(assembleTransRenderJson.joins?.[0]?.offset_seconds, 3.5, 0.01) && near(assembleTransRenderJson.joins?.[1]?.offset_seconds, 7.7333, 0.01), "assemble force render records 3 joins (fade/dissolve/fade) at offsets 3.5s / 7.73s / 8.73s", JSON.stringify(assembleTransRenderJson.joins));
checkOk(assembleTransFinalProbe?.streams?.find((s) => s.codec_type === "video")?.width === 1080 && near(parseFloat(assembleTransFinalProbe?.format?.duration), 10, 0.15) && assembleTransFinalFrames === 300, "assemble final with transitions is still 1080x1920, 10s, exactly 300 frames", `duration=${assembleTransFinalProbe?.format?.duration} frames=${assembleTransFinalFrames}`);
checkOk(assembleTransFinalLufs !== null && near(assembleTransFinalLufs, -14, 0.5), "assemble final with transitions measures -14 LUFS independently (audio untouched by video transitions)", `LUFS=${assembleTransFinalLufs}`);
// Blend proof: find the two full-size cached segments by width +
// duration (s1 built 4.5s, s2 built 4.7333s), then compare the
// frame at the fade center (4.0s) against the pure frames.
const assembleTransCacheDir = path.join(assembleTransStage.dir, ".mediakit-assemble-cache");
const assembleTransCacheFiles = (await readdir(assembleTransCacheDir)).filter((f) => f.endsWith(".mp4"));
let assembleTransSegA = null;
let assembleTransSegB = null;
for (const f of assembleTransCacheFiles) {
  const p = await probeStreams(path.join(assembleTransCacheDir, f));
  const v = p?.streams?.find((s) => s.codec_type === "video");
  if (v?.width !== 1080) continue;
  const d = parseFloat(p?.format?.duration);
  if (near(d, 4.5, 0.05)) assembleTransSegA = path.join(assembleTransCacheDir, f);
  if (near(d, 4.7333, 0.05)) assembleTransSegB = path.join(assembleTransCacheDir, f);
}
const assembleTransBlendPng = path.join(assembleTransOut, "blend-4s.png");
const assembleTransAPng = path.join(assembleTransOut, "pure-a-4s.png");
const assembleTransBPng = path.join(assembleTransOut, "pure-b-0.5s.png");
await extractPng(assembleTransFinalPath, 4.0, assembleTransBlendPng);
await extractPng(assembleTransSegA, 4.0, assembleTransAPng);
await extractPng(assembleTransSegB, 0.5, assembleTransBPng);
const assembleTransPsnrAB = await framePsnr(assembleTransAPng, assembleTransBPng);
const assembleTransPsnrBlendA = await framePsnr(assembleTransBlendPng, assembleTransAPng);
const assembleTransPsnrBlendB = await framePsnr(assembleTransBlendPng, assembleTransBPng);
checkOk(assembleTransSegA && assembleTransSegB && assembleTransPsnrAB !== null && assembleTransPsnrBlendA !== null && assembleTransPsnrBlendB !== null && Math.abs(assembleTransPsnrBlendA - assembleTransPsnrBlendB) < 1.5 && Math.abs(assembleTransPsnrBlendA - (assembleTransPsnrAB + 6)) < 2, "assemble fade center is a true 50/50 blend (PSNR blend~A and blend~B both ≈ PSNR(A,B)+6dB)", `PSNR(A,B)=${assembleTransPsnrAB} blend~A=${assembleTransPsnrBlendA} blend~B=${assembleTransPsnrBlendB}`);
const assembleTransReceipt = JSON.parse(await readFile(path.join(assembleTransOut, "assemble-receipt.json"), "utf8"));
checkOk(assembleTransReceipt.approval === "forced" && assembleTransReceipt.joins?.length === 3 && assembleTransReceipt.qa?.checks?.every((c) => c.status !== "fail"), "assemble receipt records the 3 joins and a qa_report with no failing check", JSON.stringify(assembleTransReceipt.joins));
const assembleTransRender2Res = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTransStage.manifestPath, mode: "render", output_dir: assembleTransOut, force: true } }, undefined, { timeout: 300000 });
const assembleTransRender2Json = JSON.parse(assembleTransRender2Res.content[0].text);
checkOk(assembleTransRender2Json.cache_hits === 4, "assemble second transitions render reuses all 4 shot segments from the cache", `cache_hits=${assembleTransRender2Json.cache_hits}`);

// Per-shot text layers: shot.text is a drawtext lower-third /
// title timed inside the shot (top by default, clear of the burned
// captions). Fixture: test/assemble-text.json — 10s / 300 frames,
// no music or captions (keeps the render fast): t1 is a dark color
// card with "TITLE CARD" top, 0.5–1.5s; t2 a zooming image with
// "THE CHASE" center, yellow, 1–3s into the shot. The pixel check
// uses the solid card as its own control: the top band is exactly
// 0x11 (R=17) with no text, brighter with text, and back to 0x11
// after the layer's end — timing proved both ways, not assumed.
const assembleTextStage = await stageAssembleManifest("assemble-text.json");
const assembleTextOut = path.join(assembleTextStage.dir, "out");
const assembleTextValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTextStage.manifestPath, mode: "validate" } });
const assembleTextValidateJson = JSON.parse(assembleTextValidateRes.content[0].text);
checkOk(assembleTextValidateJson.total_seconds === 10 && assembleTextValidateJson.total_frames === 300 && assembleTextValidateJson.shots?.[0]?.text_layers?.[0]?.text === "TITLE CARD" && assembleTextValidateJson.shots?.[0]?.text_layers?.[0]?.position === "top" && assembleTextValidateJson.shots?.[0]?.text_layers?.[0]?.size === 90 && assembleTextValidateJson.shots?.[0]?.text_layers?.[0]?.start_seconds === 0.5 && assembleTextValidateJson.shots?.[0]?.text_layers?.[0]?.end_seconds === 1.5 && assembleTextValidateJson.shots?.[1]?.text_layers?.[0]?.color === "FFD60A" && assembleTextValidateJson.shots?.[1]?.text_layers?.[0]?.position === "center", "assemble validate echoes the parsed text layers (TITLE CARD top 90px 0.5-1.5s; THE CHASE center yellow)", JSON.stringify(assembleTextValidateJson.shots?.map((s) => s.text_layers)));
// Bad layers fail validate, not mid-render: mutate the staged
// manifest in place (same voice/shots, so only the layer is at
// fault) and check the error names the problem.
const assembleTextDoc = JSON.parse(await readFile(assembleTextStage.manifestPath, "utf8"));
const assembleTextBad = async (mutate, re) => {
  const doc = JSON.parse(JSON.stringify(assembleTextDoc));
  mutate(doc);
  const p = path.join(assembleTextStage.dir, `bad-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(p, JSON.stringify(doc), "utf8");
  const text = await callExpectThrow("assemble", { manifest_path: p, mode: "validate" });
  return re.test(text ?? "");
};
checkOk(await assembleTextBad((d) => { d.shots[0].text.position = "left"; }, /top, center or bottom/), "assemble validate refuses a text layer with position left", "");
checkOk(await assembleTextBad((d) => { d.shots[0].text.end = 5; }, /past the shot duration/), "assemble validate refuses a text layer ending past its shot", "");
checkOk(await assembleTextBad((d) => { d.shots[0].text.text = "  "; }, /non-empty text/), "assemble validate refuses an empty text layer", "");
checkOk(await assembleTextBad((d) => { d.shots[0].text.start = 1.5; d.shots[0].text.end = 0.5; }, /must be before end/), "assemble validate refuses a text layer with start after end", "");
// Regression (lượt 56): a long all-caps layer must wrap instead of
// overflowing the frame — 0.55 em/char underestimated DejaVu Sans
// Bold (measured 0.65-0.73 em/char on disk); the wrap constant is
// now 0.75, so a 24-char layer at 64px becomes 2 lines.
const assembleLongTextDoc = JSON.parse(JSON.stringify(assembleTextDoc));
assembleLongTextDoc.shots[0].text.text = "IT MEASURES REAL MOVEMENT";
assembleLongTextDoc.shots[0].text.size = 64;
const assembleLongTextPath = path.join(assembleTextStage.dir, "assemble-long-text.json");
await writeFile(assembleLongTextPath, JSON.stringify(assembleLongTextDoc), "utf8");
const assembleLongTextRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleLongTextPath, mode: "validate" } });
const assembleLongTextJson = JSON.parse(assembleLongTextRes.content[0].text);
checkOk(JSON.stringify(assembleLongTextJson.shots?.[0]?.text_layers?.[0]?.lines) === JSON.stringify(["IT MEASURES REAL", "MOVEMENT"]), "assemble validate wraps a 24-char 64px layer into 2 lines instead of overflowing 1080px", JSON.stringify(assembleLongTextJson.shots?.[0]?.text_layers?.[0]?.lines));
const assembleTextRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTextStage.manifestPath, mode: "render", output_dir: assembleTextOut, force: true } }, undefined, { timeout: 300000 });
const assembleTextRenderJson = JSON.parse(assembleTextRenderRes.content[0].text);
const assembleTextFinalPath = path.join(assembleTextOut, "final.mp4");
const assembleTextFinalProbe = await probeStreams(assembleTextFinalPath);
const assembleTextFinalFrames = await countFrames(assembleTextFinalPath);
checkOk(assembleTextRenderJson.approval === "forced" && assembleTextFinalProbe?.streams?.find((s) => s.codec_type === "video")?.width === 1080 && near(parseFloat(assembleTextFinalProbe?.format?.duration), 10, 0.15) && assembleTextFinalFrames === 300, "assemble force render with text layers is 1080x1920, 10s, exactly 300 frames", `duration=${assembleTextFinalProbe?.format?.duration} frames=${assembleTextFinalFrames}`);
const assembleTextBandOff1 = await planeMean(assembleTextFinalPath, "1080:300:0:150", "r", 0.25);
const assembleTextBandOn = await planeMean(assembleTextFinalPath, "1080:300:0:150", "r", 1.0);
const assembleTextBandOff2 = await planeMean(assembleTextFinalPath, "1080:300:0:150", "r", 1.75);
checkOk(assembleTextBandOff1 !== null && near(assembleTextBandOff1, 17, 3) && assembleTextBandOn !== null && assembleTextBandOn > assembleTextBandOff1 + 8 && assembleTextBandOff2 !== null && near(assembleTextBandOff2, 17, 3), "assemble text layer is visible only inside its window (top band R 17 -> brighter -> 17)", `R t=0.25:${assembleTextBandOff1} t=1.0:${assembleTextBandOn} t=1.75:${assembleTextBandOff2}`);
// The text is part of the segment cache key: changing only the
// layer text rebuilds that one segment (cache_hits 3, not 4).
const assembleTextEditDoc = JSON.parse(JSON.stringify(assembleTextDoc));
assembleTextEditDoc.shots[0].text.text = "OTHER TITLE";
const assembleTextEditPath = path.join(assembleTextStage.dir, "assemble-text-edit.json");
await writeFile(assembleTextEditPath, JSON.stringify(assembleTextEditDoc), "utf8");
const assembleTextEditRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTextEditPath, mode: "render", output_dir: path.join(assembleTextStage.dir, "out-edit"), force: true } }, undefined, { timeout: 300000 });
const assembleTextEditRenderJson = JSON.parse(assembleTextEditRenderRes.content[0].text);
checkOk(assembleTextEditRenderJson.cache_hits === 3, "assemble changing only the layer text rebuilds just that shot's segment (cache_hits 3)", `cache_hits=${assembleTextEditRenderJson.cache_hits}`);
// Preview renders at half size: the text layer must scale down and
// re-wrap for the render width instead of overflowing both sides
// (measured 2026-11-13: "MINUS 14 LUFS" clipped to "NUS 14 LU" in
// the preview before the fix — the layer was sized for 1080 and
// drawn unscaled on a 540-wide frame). The band as a whole must be
// bright (text present) while a 20px strip at the frame edge stays
// near the card background (no text touching the edge).
const assembleTextPreviewRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTextStage.manifestPath, mode: "preview", output_dir: path.join(assembleTextStage.dir, "out-preview"), preview_seconds: 3 } });
const assembleTextPreviewJson = JSON.parse(assembleTextPreviewRes.content[0].text);
const assembleTextPreviewBand = await planeMean(path.join(assembleTextStage.dir, "out-preview", "preview.mp4"), "540:150:0:75", "r", 1.0);
const assembleTextPreviewEdge = await planeMean(path.join(assembleTextStage.dir, "out-preview", "preview.mp4"), "20:150:0:75", "r", 1.0);
checkOk(assembleTextPreviewJson.dimensions === "540x960" && assembleTextPreviewBand !== null && assembleTextPreviewBand > 25 && assembleTextPreviewEdge !== null && assembleTextPreviewEdge < 22, "assemble preview scales text layers to half size (band bright, frame edge dark)", `dimensions=${assembleTextPreviewJson.dimensions} band=${assembleTextPreviewBand} edge=${assembleTextPreviewEdge}`);

// Canvas scenes: a shot drawn in code (Canvas 2D, node-canvas).
// Fixture: test/assemble-canvas.json (voice 3s + lead/tail 0.5 = 4s,
// 120 frames @30fps; one canvas_scene shot running the cat-mouse
// chase scene). The motion is measured, not assumed: two frames
// 2.4s apart must differ a lot (the runners cross half the frame),
// which a still image could never do.
const assembleCanvasStage = await stageAssembleManifest("assemble-canvas.json");
const assembleCanvasOut = path.join(assembleCanvasStage.dir, "out");
const assembleCanvasValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleCanvasStage.manifestPath, mode: "validate" } });
const assembleCanvasValidateJson = JSON.parse(assembleCanvasValidateRes.content[0].text);
checkOk(assembleCanvasValidateJson.total_seconds === 4 && assembleCanvasValidateJson.total_frames === 120 && assembleCanvasValidateJson.shots?.length === 1 && assembleCanvasValidateJson.shots?.[0]?.kind === "canvas_scene", "assemble validate reports the canvas_scene shot (4s / 120 frames)", JSON.stringify(assembleCanvasValidateJson.shots));
const assembleCanvasMissingText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-canvas-missing.json"), mode: "validate" });
checkOk(/cannot load scene module|no-such-scene/.test(assembleCanvasMissingText ?? ""), "assemble validate refuses a canvas_scene with a missing scene module", assembleCanvasMissingText ?? "");
const assembleCanvasNodrawText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-canvas-nodraw.json"), mode: "validate" });
checkOk(/must export draw/.test(assembleCanvasNodrawText ?? ""), "assemble validate refuses a scene module with no draw export", assembleCanvasNodrawText ?? "");
const assembleCanvasPreviewRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleCanvasStage.manifestPath, mode: "preview", output_dir: assembleCanvasOut, preview_seconds: 2 } });
const assembleCanvasPreviewJson = JSON.parse(assembleCanvasPreviewRes.content[0].text);
const assembleCanvasPreviewPath = path.join(assembleCanvasOut, "preview.mp4");
const assembleCanvasPreviewFrames = await countFrames(assembleCanvasPreviewPath);
checkOk(assembleCanvasPreviewJson.preview_seconds === 2 && assembleCanvasPreviewJson.dimensions === "540x960" && assembleCanvasPreviewFrames === 60, "assemble canvas preview renders 2s at 540x960 with exactly 60 frames", `frames=${assembleCanvasPreviewFrames}`);
const assembleCanvasRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleCanvasStage.manifestPath, mode: "render", output_dir: assembleCanvasOut, force: true } }, undefined, { timeout: 300000 });
const assembleCanvasRenderJson = JSON.parse(assembleCanvasRenderRes.content[0].text);
const assembleCanvasFinalPath = path.join(assembleCanvasOut, "final.mp4");
const assembleCanvasFinalProbe = await probeStreams(assembleCanvasFinalPath);
const assembleCanvasFinalFrames = await countFrames(assembleCanvasFinalPath);
const assembleCanvasFinalLufs = await measureLufs(assembleCanvasFinalPath);
checkOk(assembleCanvasRenderJson.approval === "forced" && assembleCanvasFinalProbe?.streams?.find((s) => s.codec_type === "video")?.width === 1080 && near(parseFloat(assembleCanvasFinalProbe?.format?.duration), 4, 0.15) && assembleCanvasFinalFrames === 120, "assemble canvas final is 1080x1920, 4s, exactly 120 frames", `duration=${assembleCanvasFinalProbe?.format?.duration} frames=${assembleCanvasFinalFrames}`);
checkOk(assembleCanvasFinalLufs !== null && near(assembleCanvasFinalLufs, -14, 0.5), "assemble canvas final measures -14 LUFS independently", `LUFS=${assembleCanvasFinalLufs}`);
// Motion proof: the frame at 0.6s (runners entering, right) vs the
// frame at 3.0s (runners left-center) must differ substantially —
// PSNR below 28 dB (measured 24.7-24.8 twice; a still shot would
// measure near-infinite).
const assembleCanvasEarlyPng = path.join(assembleCanvasOut, "canvas-0.6s.png");
const assembleCanvasLatePng = path.join(assembleCanvasOut, "canvas-3.0s.png");
await extractPng(assembleCanvasFinalPath, 0.6, assembleCanvasEarlyPng);
await extractPng(assembleCanvasFinalPath, 3.0, assembleCanvasLatePng);
const assembleCanvasMotionPsnr = await framePsnr(assembleCanvasEarlyPng, assembleCanvasLatePng);
checkOk(assembleCanvasMotionPsnr !== null && assembleCanvasMotionPsnr < 28, "assemble canvas_scene really moves: frames 2.4s apart differ (PSNR < 28 dB)", `PSNR=${assembleCanvasMotionPsnr}`);
const assembleCanvasRender2Res = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleCanvasStage.manifestPath, mode: "render", output_dir: assembleCanvasOut, force: true } }, undefined, { timeout: 300000 });
const assembleCanvasRender2Json = JSON.parse(assembleCanvasRender2Res.content[0].text);
checkOk(assembleCanvasRender2Json.cache_hits === 1, "assemble second canvas render reuses the shot segment from the cache", `cache_hits=${assembleCanvasRender2Json.cache_hits}`);

// Scene templates: reusable built-in canvas_scene shots — a shot
// says `"template": "bounce"` + params instead of a scene file.
// Fixture: test/assemble-template.json (4s film: bounce 2s with
// color + bounces overridden, title-card 2s with text overridden;
// preset vertical). Validate must echo the template id and the
// params merged with defaults (bounce has an `apex` param now —
// default 0.12H — and an out-of-range apex fails); bad ids /
// template+scene / unknown params fail; the render must show real
// motion (bounce frames 0.5s apart differ) and the title-card
// text band must be bright.
const assembleTemplateStage = await stageAssembleManifest("assemble-template.json");
const assembleTemplateOut = path.join(assembleTemplateStage.dir, "out");
const assembleTemplateValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTemplateStage.manifestPath, mode: "validate" } });
const assembleTemplateValidateJson = JSON.parse(assembleTemplateValidateRes.content[0].text);
checkOk(assembleTemplateValidateJson.total_seconds === 4 && assembleTemplateValidateJson.total_frames === 120 && assembleTemplateValidateJson.shots?.length === 2 && assembleTemplateValidateJson.shots[0]?.template === "bounce" && assembleTemplateValidateJson.shots[0]?.params?.color === "#EF4444" && assembleTemplateValidateJson.shots[0]?.params?.bounces === 2 && assembleTemplateValidateJson.shots[0]?.params?.bg === "#0F172A" && assembleTemplateValidateJson.shots[0]?.params?.radius === 0.08 && assembleTemplateValidateJson.shots[0]?.params?.apex === 0.12 && assembleTemplateValidateJson.shots[1]?.template === "title-card" && assembleTemplateValidateJson.shots[1]?.params?.text === "TEMPLATES" && assembleTemplateValidateJson.shots[1]?.params?.fg === "#FFFFFF", "assemble validate echoes template ids + params merged with defaults (bounce color/bounces overridden, bg/radius/apex defaulted)", JSON.stringify(assembleTemplateValidateJson.shots));
const assembleBadTemplateText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-template.json"), mode: "validate" });
checkOk(/must be one of title-card, bounce, slide-in, spring-in, rings/.test(assembleBadTemplateText ?? ""), "assemble validate refuses an unknown scene template id", assembleBadTemplateText ?? "");
const assembleBadTemplateSceneText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-template-scene.json"), mode: "validate" });
checkOk(/either scene or template, not both/.test(assembleBadTemplateSceneText ?? ""), "assemble validate refuses a canvas_scene shot with both scene and template", assembleBadTemplateSceneText ?? "");
const assembleBadTemplateParamText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-template-param.json"), mode: "validate" });
checkOk(/unknown param/.test(assembleBadTemplateParamText ?? "") && /allowed: apex, bg, bounces, color, radius/.test(assembleBadTemplateParamText ?? ""), "assemble validate refuses an unknown template param (with the allowed list)", assembleBadTemplateParamText ?? "");
const assembleBadApexText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-template-apex.json"), mode: "validate" });
checkOk(/apex/.test(assembleBadApexText ?? "") && /must be <= 0.5/.test(assembleBadApexText ?? ""), "assemble validate refuses bounce apex 0.6 (above max 0.5)", assembleBadApexText.slice(0, 200));
const assembleTemplateRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTemplateStage.manifestPath, mode: "render", output_dir: assembleTemplateOut, force: true } }, undefined, { timeout: 300000 });
const assembleTemplateRenderJson = JSON.parse(assembleTemplateRenderRes.content[0].text);
const assembleTemplateFinalPath = path.join(assembleTemplateOut, "final.mp4");
const assembleTemplateFinalProbe = await probeStreams(assembleTemplateFinalPath);
const assembleTemplateFinalFrames = await countFrames(assembleTemplateFinalPath);
const assembleTemplateFinalLufs = await measureLufs(assembleTemplateFinalPath);
checkOk(assembleTemplateRenderJson.approval === "forced" && near(parseFloat(assembleTemplateFinalProbe?.format?.duration), 4, 0.15) && assembleTemplateFinalFrames === 120, "assemble template film renders 4s with exactly 120 frames", `duration=${assembleTemplateFinalProbe?.format?.duration} frames=${assembleTemplateFinalFrames}`);
checkOk(assembleTemplateFinalLufs !== null && near(assembleTemplateFinalLufs, -14, 0.5), "assemble template final measures -14 LUFS independently", `LUFS=${assembleTemplateFinalLufs}`);
// Motion proof: bounce frames 0.5s apart differ (PSNR < 28, same
// bar as the chase scene); the title-card shot at 3.0s shows the
// white title in the middle band (R mean well above the navy bg).
const assembleTemplateEarlyPng = path.join(assembleTemplateOut, "template-0.5s.png");
const assembleTemplateMidPng = path.join(assembleTemplateOut, "template-1.0s.png");
const assembleTemplateTitlePng = path.join(assembleTemplateOut, "template-3.0s.png");
await extractPng(assembleTemplateFinalPath, 0.5, assembleTemplateEarlyPng);
await extractPng(assembleTemplateFinalPath, 1.0, assembleTemplateMidPng);
await extractPng(assembleTemplateFinalPath, 3.0, assembleTemplateTitlePng);
const assembleTemplateBouncePsnr = await framePsnr(assembleTemplateEarlyPng, assembleTemplateMidPng);
checkOk(assembleTemplateBouncePsnr !== null && assembleTemplateBouncePsnr < 28, "assemble bounce template really moves: frames 0.5s apart differ (PSNR < 28 dB)", `PSNR=${assembleTemplateBouncePsnr}`);
const assembleTemplateTitleBandR = await planeMean(assembleTemplateTitlePng, "1080:300:0:810", "r");
checkOk(assembleTemplateTitleBandR !== null && assembleTemplateTitleBandR > 35, "assemble title-card template draws the white title in the middle band", `band R=${assembleTemplateTitleBandR}`);
// Bounce apex (turn 102): render the template module directly on a
// 540x960 canvas at mid-bounce (t = cycle/2, ball at the apex) and
// scan the center column for the red ball — the topmost red row
// must sit at apex*H − radius. Default apex 0.12 → row 72; apex
// 0.35 → row 293; a big radius (0.4) + high apex (0.5) is clamped
// so the ball still rises instead of flattening onto the floor.
async function bounceTopRow(apex, radius) {
  const W = 540, H = 960;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  await bounceTpl.draw(ctx, 0.5, W, H, {}, { params: { bg: "#0F172A", color: "#EF4444", radius, bounces: 2, apex }, duration: 2 });
  const img = ctx.getImageData(0, 0, W, H).data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (img[i] > 200 && img[i + 1] < 100 && img[i + 2] < 100) return y;
    }
  }
  return null;
}
const bounceTopDefault = await bounceTopRow(0.12, 0.08);
const bounceTopHigh = await bounceTopRow(0.35, 0.08);
const bounceTopClamped = await bounceTopRow(0.5, 0.4);
console.log("bounce apex tops: default", bounceTopDefault, "| high", bounceTopHigh, "| clamped", bounceTopClamped);
checkOk(bounceTopDefault !== null && Math.abs(bounceTopDefault - 72) <= 3, "bounce apex 0.12 puts the ball top at row 72 (0.12H minus radius)", `got ${bounceTopDefault}`);
checkOk(bounceTopHigh !== null && Math.abs(bounceTopHigh - 293) <= 3, "bounce apex 0.35 puts the ball top at row 293", `got ${bounceTopHigh}`);
checkOk(bounceTopClamped !== null && Math.abs(bounceTopClamped - 109) <= 3, "bounce apex 0.5 + radius 0.4 clamps the apex so the ball still rises (top row 109)", `got ${bounceTopClamped}`);
// Easing + spring (turn 111): fx.ease is the full easings.net set
// (30 named curves + 5 legacy short names, all 0 -> 0 and 1 -> 1),
// fx.spring is a damped harmonic oscillator (mass/stiffness/damping).
// The slide-in template takes an `ease` param (default easeOutCubic,
// the old hard-coded curve); the spring-in template draws a card
// that springs in with a physical overshoot. Pinned values below
// are computed from the easings.net formulas by hand, not read off
// the code.
const easePins = [
  ["easeOutBounce", 0.5, 0.765625],
  ["easeInOutSine", 0.25, 0.146447],
  ["easeOutExpo", 0.5, 0.96875],
  ["easeInQuad", 0.5, 0.25],
  ["easeOutQuart", 0.5, 0.9375],
  ["easeOutQuint", 0.5, 0.96875],
  ["easeInCirc", 0.5, 0.133975],
  ["easeOutBack", 0.5, 1.087698],
  ["easeInElastic", 0.5, -0.015625],
];
checkOk(easePins.every(([name, k, want]) => near(fxLib.ease[name](k), want, 1e-6)), "fx.ease pins 9 hand-computed easings.net values (bounce/sine/expo/quad/quart/quint/circ/back/elastic)", JSON.stringify(easePins.map(([n, k]) => [n, fxLib.ease[n](k)])));
checkOk(Object.keys(fxLib.ease).length === 35 && Object.values(fxLib.ease).every((fn) => typeof fn === "function" && near(fn(0), 0, 1e-9) && near(fn(1), 1, 1e-9)), "fx.ease has 35 curves and every one maps 0 -> 0 and 1 -> 1", `keys=${Object.keys(fxLib.ease).length}`);
checkOk([0, 0.25, 0.5, 0.75, 1].every((k) => fxLib.ease.in(k) === fxLib.ease.easeInCubic(k) && fxLib.ease.out(k) === fxLib.ease.easeOutCubic(k) && fxLib.ease.inOut(k) === fxLib.ease.easeInOutQuad(k) && fxLib.ease.outBack(k) === fxLib.ease.easeOutBack(k)), "legacy ease names are exact aliases (in=easeInCubic, out=easeOutCubic, inOut=easeInOutQuad, outBack=easeOutBack)", "sampled k=0..1");
checkOk(fxLib.spring(-0.1, 0) === 0 && fxLib.spring(0, 0) === 0 && near(fxLib.spring(3, 0), 1, 0.005), "fx.spring is 0 before/at t0 and settled at 1 by 3s", `spring(3,0)=${fxLib.spring(3, 0)}`);
let springPeak = 0;
for (let i = 0; i <= 200; i++) { const v = fxLib.spring(i * 0.01, 0); if (v > springPeak) springPeak = v; }
checkOk(springPeak > 1.05 && springPeak < 1.2, "fx.spring with defaults overshoots past 1 (physical ring-down, peak ~1.13)", `peak=${springPeak}`);
let springOverMax = 0;
for (let i = 0; i <= 400; i++) { const v = fxLib.spring(i * 0.01, 0, { damping: 40 }); if (v > springOverMax) springOverMax = v; }
checkOk(springOverMax <= 1.000001, "overdamped fx.spring (damping 40) never overshoots past 1", `max=${springOverMax}`);
checkOk(fxLib.springPop(0.5, 0) === fxLib.spring(0.5, 0) && near(fxLib.springPop(3, 0), 1, 0.005), "fx.springPop is the same spring as a scale factor (settles at 1)", `springPop(3,0)=${fxLib.springPop(3, 0)}`);
let springThrowCount = 0;
for (const bad of [{ stiffness: 0 }, { mass: -1 }, { damping: -2 }]) { try { fxLib.spring(1, 0, bad); } catch { springThrowCount++; } }
checkOk(springThrowCount === 3, "fx.spring rejects non-positive mass/stiffness and negative damping", `threw ${springThrowCount}/3`);
// The slide-in `ease` enum in the registry must list exactly the
// fx.ease keys — a drift here means validate accepts a name the
// template cannot draw (or rejects one it can).
const sceneTemplatesDoc = JSON.parse(await readFile(path.join(root, "skills/shorts-video/scene-templates.json"), "utf8"));
const slideInEnum = sceneTemplatesDoc.templates.find((t) => t.id === "slide-in")?.params?.ease?.enum ?? [];
checkOk(slideInEnum.length === Object.keys(fxLib.ease).length && slideInEnum.every((n) => typeof fxLib.ease[n] === "function") && Object.keys(fxLib.ease).every((n) => slideInEnum.includes(n)), "slide-in ease enum lists exactly the 35 fx.ease names (registry and code cannot drift)", `enum=${slideInEnum.length} ease keys=${Object.keys(fxLib.ease).length}`);
// Camera shares fx.ease (turn 120): cam.shot({ease}) accepts every
// fx.ease name, not just the 4 legacy short names the camera used
// to keep in its own table. The legacy names are exact aliases in
// fx.ease (pinned above), so old scenes do not move; an unknown
// name still falls back to inOut. Values are hand-computed from
// the pinned easeOutBounce(0.5)=0.765625: a shot from cx 0.5 to 0.3
// with zoom 1->2 sits at cx 0.346875 / z 1.765625 mid-shot on
// easeOutBounce, and at 0.4 / 1.5 on linear or on the inOut
// fallback (easeInOutQuad(0.5)=0.5).
checkOk(Object.keys(camLib.EASE).length === Object.keys(fxLib.ease).length && Object.keys(camLib.EASE).every((n) => camLib.EASE[n] === fxLib.ease[n]), "camera EASE is exactly the fx.ease table (35 curves, same functions)", `keys=${Object.keys(camLib.EASE).length}`);
const camBounce = camLib.shot({ t0: 0, t1: 2, from: [0.5, 0.5], to: [0.3, 0.5], zoom: [1, 2], ease: "easeOutBounce" });
const camBounceTr = camLib.at([camBounce], 1);
checkOk(near(camBounceTr.cx, 0.346875, 1e-6) && near(camBounceTr.z, 1.765625, 1e-6), "cam.shot easeOutBounce moves the camera on the bounce curve (mid-shot cx 0.346875, z 1.765625)", JSON.stringify(camBounceTr));
const camLinear = camLib.shot({ t0: 0, t1: 2, from: [0.5, 0.5], to: [0.3, 0.5], zoom: [1, 2], ease: "linear" });
const camLinearTr = camLib.at([camLinear], 1);
checkOk(near(camLinearTr.cx, 0.4, 1e-9) && near(camLinearTr.z, 1.5, 1e-9), "cam.shot linear is the straight midpoint (cx 0.4, z 1.5)", JSON.stringify(camLinearTr));
const camUnknown = camLib.shot({ t0: 0, t1: 2, from: [0.5, 0.5], to: [0.3, 0.5], zoom: [1, 2], ease: "no-such-ease" });
const camUnknownTr = camLib.at([camUnknown], 1);
checkOk(near(camUnknownTr.cx, 0.4, 1e-9) && near(camUnknownTr.z, 1.5, 1e-9), "cam.shot with an unknown ease name falls back to inOut (midpoint, like the default)", JSON.stringify(camUnknownTr));
const camLegacy = camLib.shot({ t0: 0, t1: 2, from: [0.5, 0.5], to: [0.3, 0.5], zoom: [1, 2], ease: "in" });
const camLegacyTr = camLib.at([camLegacy], 1);
checkOk(near(camLegacyTr.cx, 0.475, 1e-9) && near(camLegacyTr.z, 1.125, 1e-9), "cam.shot legacy ease 'in' is still easeInCubic (mid-shot cx 0.475, z 1.125)", JSON.stringify(camLegacyTr));
// Pixel proof the templates move the way the curves say: on a
// 540x960 canvas the slide-in card at t=0.35 is 425px wide with the
// default easeOutCubic, 372px with easeOutBounce, 243px with linear;
// the spring-in card is 0px at t=0, ~487px at the t=0.34 overshoot
// peak (432 * 1.128) and exactly 432px once settled at t=2.5.
// The card is #F59E0B on a navy bg, so scan the middle row for it.
async function cardWidthPx(tpl, params, t, W = 540, H = 960) {
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  await tpl.draw(ctx, t, W, H, {}, { params, duration: 3, lib: { fx: fxLib } });
  const img = ctx.getImageData(0, 0, W, H).data;
  const y = Math.floor(H / 2);
  let minX = W, maxX = -1;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (Math.abs(img[i] - 245) < 12 && Math.abs(img[i + 1] - 158) < 12 && Math.abs(img[i + 2] - 11) < 12) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  }
  return maxX < 0 ? 0 : maxX - minX + 1;
}
const slideBase = { text: "HELLO", bg: "#0F172A", card: "#F59E0B", fg: "#111827" };
const slideWDefault = await cardWidthPx(slideInTpl, { ...slideBase, ease: "easeOutCubic" }, 0.35);
const slideWBounce = await cardWidthPx(slideInTpl, { ...slideBase, ease: "easeOutBounce" }, 0.35);
const slideWLinear = await cardWidthPx(slideInTpl, { ...slideBase, ease: "linear" }, 0.35);
checkOk(near(slideWDefault, 425, 4) && near(slideWBounce, 372, 4) && near(slideWLinear, 243, 4) && new Set([slideWDefault, slideWBounce, slideWLinear]).size === 3, "slide-in ease param changes the motion: t=0.35 card is 425px (easeOutCubic) vs 372px (easeOutBounce) vs 243px (linear)", `cubic=${slideWDefault} bounce=${slideWBounce} linear=${slideWLinear}`);
const springW0 = await cardWidthPx(springInTpl, { ...slideBase, stiffness: 120, damping: 12, mass: 1 }, 0);
const springWPeak = await cardWidthPx(springInTpl, { ...slideBase, stiffness: 120, damping: 12, mass: 1 }, 0.34);
const springWSettled = await cardWidthPx(springInTpl, { ...slideBase, stiffness: 120, damping: 12, mass: 1 }, 2.5);
checkOk(springW0 === 0 && near(springWPeak, 487, 4) && springWSettled === 432, "spring-in card is 0px at t=0, overshoots to ~487px at t=0.34, settles at exactly 432px", `t0=${springW0} peak=${springWPeak} settled=${springWSettled}`);
let slideBadEaseThrows = false;
try { await cardWidthPx(slideInTpl, { ...slideBase, ease: "nope" }, 0.35); } catch { slideBadEaseThrows = true; }
checkOk(slideBadEaseThrows, "slide-in draw throws on an unknown ease name instead of drawing garbage", "ease=nope");
// Spring-in + slide-in ease through assemble: validate echoes the
// merged params (spring-in physics defaults, slide-in ease override),
// an unknown ease fails with the enum, and the render shows real
// motion (mid-overshoot vs settled frames differ).
const assembleSpringinStage = await stageAssembleManifest("assemble-springin.json");
const assembleSpringinOut = path.join(assembleSpringinStage.dir, "out");
const assembleSpringinValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleSpringinStage.manifestPath, mode: "validate" } });
const assembleSpringinValidateJson = JSON.parse(assembleSpringinValidateRes.content[0].text);
checkOk(assembleSpringinValidateJson.total_seconds === 4 && assembleSpringinValidateJson.total_frames === 120 && assembleSpringinValidateJson.shots?.[0]?.template === "spring-in" && assembleSpringinValidateJson.shots[0]?.params?.text === "SPRING" && assembleSpringinValidateJson.shots[0]?.params?.stiffness === 120 && assembleSpringinValidateJson.shots[0]?.params?.damping === 12 && assembleSpringinValidateJson.shots[0]?.params?.mass === 1 && assembleSpringinValidateJson.shots?.[1]?.template === "slide-in" && assembleSpringinValidateJson.shots[1]?.params?.ease === "easeOutBounce", "assemble validate echoes spring-in params merged with defaults (stiffness/damping/mass) and the slide-in ease override", JSON.stringify(assembleSpringinValidateJson.shots));
const assembleBadEaseText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-template-ease.json"), mode: "validate" });
// NOTE: match /nope/ bare, not /"nope"/ — the MCP error text is a
// JSON-stringified body, so the quotes around the bad value come back
// backslash-escaped (\"nope\") and a literal-quote regex never matches.
checkOk(/ease/.test(assembleBadEaseText ?? "") && /must be one of/.test(assembleBadEaseText ?? "") && /easeOutBounce/.test(assembleBadEaseText ?? "") && /nope/.test(assembleBadEaseText ?? ""), "assemble validate refuses slide-in ease \"nope\" (enum error names an allowed ease)", (assembleBadEaseText ?? "").slice(0, 300));
const assembleSpringinRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleSpringinStage.manifestPath, mode: "render", output_dir: assembleSpringinOut, force: true } }, undefined, { timeout: 300000 });
const assembleSpringinRenderJson = JSON.parse(assembleSpringinRenderRes.content[0].text);
const assembleSpringinFinalPath = path.join(assembleSpringinOut, "final.mp4");
const assembleSpringinFinalProbe = await probeStreams(assembleSpringinFinalPath);
const assembleSpringinFinalFrames = await countFrames(assembleSpringinFinalPath);
checkOk(assembleSpringinRenderJson.approval === "forced" && near(parseFloat(assembleSpringinFinalProbe?.format?.duration), 4, 0.15) && assembleSpringinFinalFrames === 120, "assemble spring-in film renders 4s with exactly 120 frames", `duration=${assembleSpringinFinalProbe?.format?.duration} frames=${assembleSpringinFinalFrames}`);
const assembleSpringinEarlyPng = path.join(assembleSpringinOut, "springin-0.3s.png");
const assembleSpringinLatePng = path.join(assembleSpringinOut, "springin-1.5s.png");
await extractPng(assembleSpringinFinalPath, 0.3, assembleSpringinEarlyPng);
await extractPng(assembleSpringinFinalPath, 1.5, assembleSpringinLatePng);
const assembleSpringinPsnr = await framePsnr(assembleSpringinEarlyPng, assembleSpringinLatePng);
checkOk(assembleSpringinPsnr !== null && assembleSpringinPsnr < 28, "assemble spring-in template really moves: mid-overshoot vs settled frames differ (PSNR < 28 dB)", `PSNR=${assembleSpringinPsnr}`);
// Preview captions must scale too: the style's locked burn values
// (60px/500px, tuned for 1080x1920) were passed to burnCaptions
// unscaled, so on a 540x960 preview the subtitles rendered 2x too
// big and climbed to y=0-540, over the text layers (measured turn
// 54: R mean 42.9 in the 300-450 band that must stay dark). The
// title-card shot at 2.5s is a clean probe: dark navy background,
// caption cue active (0.5-3.5s), title text lives lower.
const assembleTemplatePreviewRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTemplateStage.manifestPath, mode: "preview", output_dir: path.join(assembleTemplateStage.dir, "out-preview"), preview_seconds: 3 } });
const assembleTemplatePreviewJson = JSON.parse(assembleTemplatePreviewRes.content[0].text);
const assembleTemplateCaptionBand = await planeMean(path.join(assembleTemplateStage.dir, "out-preview", "preview.mp4"), "540:150:0:300", "r", 2.5);
checkOk(assembleTemplatePreviewJson.dimensions === "540x960" && assembleTemplateCaptionBand !== null && assembleTemplateCaptionBand < 25, "assemble preview scales caption burn to half size (300-450 band stays dark navy, R < 25)", `dimensions=${assembleTemplatePreviewJson.dimensions} band R=${assembleTemplateCaptionBand}`);
const assembleTemplateRender2Res = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleTemplateStage.manifestPath, mode: "render", output_dir: assembleTemplateOut, force: true } }, undefined, { timeout: 300000 });
const assembleTemplateRender2Json = JSON.parse(assembleTemplateRender2Res.content[0].text);
checkOk(assembleTemplateRender2Json.cache_hits === 2, "assemble second template render reuses both template segments from the cache", `cache_hits=${assembleTemplateRender2Json.cache_hits}`);

// Brand profiles (turn 66): one `"brand"` id paints the whole
// film — palette fills template colors + text-layer color/size,
// its style fills the caption style when no preset or explicit
// style sets one. Fixture test/assemble-brand.json: preset
// vertical + brand warm-story, title-card 2s (text param only)
// + rings 2s (count only), text layers: one bare, one explicit
// red. The preset's clean-bold style wins over the brand's
// warm-story; the bare layer takes the brand's cream text at 56px.
const assembleBrandStage = await stageAssembleManifest("assemble-brand.json");
const assembleBrandOut = path.join(assembleBrandStage.dir, "out");
const assembleBrandValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleBrandStage.manifestPath, mode: "validate" } });
const assembleBrandValidateJson = JSON.parse(assembleBrandValidateRes.content[0].text);
checkOk(assembleBrandValidateJson.brand === "warm-story" && assembleBrandValidateJson.style === "clean-bold" && assembleBrandValidateJson.preset === "vertical" && assembleBrandValidateJson.brand_applied?.includes("shot 1 (s1) template.title-card.bg1") && assembleBrandValidateJson.brand_applied?.includes("shot 1 (s1) template.title-card.accent") && assembleBrandValidateJson.brand_applied?.includes("shot 1 (s1) template.title-card.fg") && assembleBrandValidateJson.brand_applied?.includes("shot 1 (s1) text[0].color") && assembleBrandValidateJson.brand_applied?.includes("shot 1 (s1) text[0].size") && assembleBrandValidateJson.brand_applied?.includes("shot 2 (s2) template.rings.bg") && assembleBrandValidateJson.brand_applied?.includes("shot 2 (s2) template.rings.color") && assembleBrandValidateJson.brand_overrides?.includes("style") && assembleBrandValidateJson.brand_overrides?.includes("shot 1 (s1) text[1].color"), "assemble brand warm-story fills template colors + text color/size and reports applied/overrides (preset style wins over the brand style)", JSON.stringify({ brand: assembleBrandValidateJson.brand, applied: assembleBrandValidateJson.brand_applied, overrides: assembleBrandValidateJson.brand_overrides }));
checkOk(assembleBrandValidateJson.shots?.[0]?.params?.bg1 === "#1C1917" && assembleBrandValidateJson.shots?.[0]?.params?.accent === "#B45309" && assembleBrandValidateJson.shots?.[0]?.params?.fg === "#FFF7ED" && assembleBrandValidateJson.shots?.[0]?.params?.bg2 === "#1E3A5F" && assembleBrandValidateJson.shots?.[1]?.params?.bg === "#1C1917" && assembleBrandValidateJson.shots?.[1]?.params?.color === "#D97706", "assemble brand palette lands in the template params (title-card bg1/accent/fg, rings bg/color) while bg2 keeps the template default", JSON.stringify(assembleBrandValidateJson.shots?.map((s) => s.params)));
checkOk(assembleBrandValidateJson.shots?.[0]?.text_layers?.[0]?.color === "FFF7ED" && assembleBrandValidateJson.shots?.[0]?.text_layers?.[0]?.size === 56 && assembleBrandValidateJson.shots?.[0]?.text_layers?.[1]?.color === "FF0000" && assembleBrandValidateJson.shots?.[0]?.text_layers?.[1]?.size === 56, "assemble brand text defaults: bare layer takes cream 56px, explicit red keeps its color but still takes the brand size", JSON.stringify(assembleBrandValidateJson.shots?.[0]?.text_layers));
// No preset: the brand's own style fills the caption style.
const assembleBrandStyleStage = await stageAssembleManifest("assemble-brand-style.json");
const assembleBrandStyleRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleBrandStyleStage.manifestPath, mode: "validate" } });
const assembleBrandStyleJson = JSON.parse(assembleBrandStyleRes.content[0].text);
checkOk(assembleBrandStyleJson.brand === "warm-story" && assembleBrandStyleJson.style === "warm-story" && assembleBrandStyleJson.brand_applied?.includes("style") && assembleBrandStyleJson.brand_overrides?.length === 0, "assemble brand style fills the caption style when no preset or explicit style sets one", JSON.stringify({ style: assembleBrandStyleJson.style, applied: assembleBrandStyleJson.brand_applied }));
const assembleBadBrandText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-brand.json"), mode: "validate" });
checkOk(/must be one of amber-teal, warm-story, minimal-line/.test(assembleBadBrandText ?? ""), "assemble validate refuses an unknown brand id", assembleBadBrandText ?? "");
// The fingerprint moves when only the brand changes: validate the
// same staged film twice, once per brand id.
const assembleBrandFpRes1 = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleBrandStage.manifestPath, mode: "validate" } });
const assembleBrandFp1 = JSON.parse(assembleBrandFpRes1.content[0].text).fingerprint;
const assembleBrandFpDoc = JSON.parse(await readFile(assembleBrandStage.manifestPath, "utf8"));
assembleBrandFpDoc.brand = "amber-teal";
await writeFile(assembleBrandStage.manifestPath, JSON.stringify(assembleBrandFpDoc), "utf8");
const assembleBrandFpRes2 = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleBrandStage.manifestPath, mode: "validate" } });
const assembleBrandFp2Json = JSON.parse(assembleBrandFpRes2.content[0].text);
checkOk(assembleBrandFp1 !== assembleBrandFp2Json.fingerprint && assembleBrandFp2Json.brand === "amber-teal", "assemble fingerprint changes when only the brand id changes (the resolved palette is in the fingerprint)", `${assembleBrandFp1?.slice(0, 12)} vs ${assembleBrandFp2Json.fingerprint?.slice(0, 12)}`);
// Render proof: the brand background is really on the frames —
// corner pixels of both the title-card shot (0.5s) and the rings
// shot (3.0s) measure warm-story's #1C1917 (28/25/23, ±5).
// (Restore the staged film to warm-story first: the fingerprint
// check above switched it to amber-teal.)
assembleBrandFpDoc.brand = "warm-story";
await writeFile(assembleBrandStage.manifestPath, JSON.stringify(assembleBrandFpDoc), "utf8");
const assembleBrandRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleBrandStage.manifestPath, mode: "render", output_dir: assembleBrandOut, force: true } }, undefined, { timeout: 300000 });
const assembleBrandRenderJson = JSON.parse(assembleBrandRenderRes.content[0].text);
const assembleBrandFinalPath = path.join(assembleBrandOut, "final.mp4");
const assembleBrandFinalProbe = await probeStreams(assembleBrandFinalPath);
const assembleBrandFinalFrames = await countFrames(assembleBrandFinalPath);
const assembleBrandFinalLufs = await measureLufs(assembleBrandFinalPath);
checkOk(assembleBrandRenderJson.brand === "warm-story" && assembleBrandRenderJson.approval === "forced" && near(parseFloat(assembleBrandFinalProbe?.format?.duration), 4, 0.15) && assembleBrandFinalFrames === 120, "assemble brand film renders 4s with exactly 120 frames and the brand echoed in the receipt", `duration=${assembleBrandFinalProbe?.format?.duration} frames=${assembleBrandFinalFrames}`);
checkOk(assembleBrandFinalLufs !== null && near(assembleBrandFinalLufs, -14, 0.5), "assemble brand final measures -14 LUFS independently", `LUFS=${assembleBrandFinalLufs}`);
const assembleBrandCornerR1 = await planeMean(assembleBrandFinalPath, "20:20:0:0", "r", 0.5);
const assembleBrandCornerG1 = await planeMean(assembleBrandFinalPath, "20:20:0:0", "g", 0.5);
const assembleBrandCornerB1 = await planeMean(assembleBrandFinalPath, "20:20:0:0", "b", 0.5);
const assembleBrandCornerR2 = await planeMean(assembleBrandFinalPath, "20:20:0:0", "r", 3.0);
const assembleBrandCornerG2 = await planeMean(assembleBrandFinalPath, "20:20:0:0", "g", 3.0);
const assembleBrandCornerB2 = await planeMean(assembleBrandFinalPath, "20:20:0:0", "b", 3.0);
checkOk(near(assembleBrandCornerR1, 28, 5) && near(assembleBrandCornerG1, 25, 5) && near(assembleBrandCornerB1, 23, 5) && near(assembleBrandCornerR2, 28, 5) && near(assembleBrandCornerG2, 25, 5) && near(assembleBrandCornerB2, 23, 5), "assemble brand background is really on the frames: corner pixels are warm-story #1C1917 in both shots", `s1 ${assembleBrandCornerR1}/${assembleBrandCornerG1}/${assembleBrandCornerB1} s2 ${assembleBrandCornerR2}/${assembleBrandCornerG2}/${assembleBrandCornerB2}`);
const assembleBrandVerifyRes = await client.callTool({ name: "verify", arguments: { receipt: path.join(assembleBrandOut, "assemble-receipt.json") } });
const assembleBrandVerifyJson = JSON.parse(assembleBrandVerifyRes.content[0].text);
checkOk(assembleBrandVerifyJson.verdict === "pass" && assembleBrandVerifyJson.items?.some((i) => i.name === "brand" && i.status === "matched"), "verify on the brand film receipt passes with the brand item matched", JSON.stringify(assembleBrandVerifyJson.items?.map((i) => `${i.name}:${i.status}`)));

// Custom brands in assemble (lượt 81): the same staged film with
// brand "ink-paper" paints from the MEDIAKIT_BRANDS file, and the
// fingerprint moves when only the file's palette changes (same id,
// different colours) — the cache key hashes the file content.
const assembleCustomStage = await stageAssembleManifest("assemble-brand.json");
const assembleCustomDoc = JSON.parse(await readFile(assembleCustomStage.manifestPath, "utf8"));
assembleCustomDoc.brand = "ink-paper";
await writeFile(assembleCustomStage.manifestPath, JSON.stringify(assembleCustomDoc), "utf8");
const assembleCustomTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
  env: { ...process.env, MEDIAKIT_BRANDS: customBrandsPath },
});
const assembleCustomClient = new Client({ name: "mediakit-test-brands-assemble", version: "0.1.0" }, { capabilities: {} });
await assembleCustomClient.connect(assembleCustomTransport);
const assembleCustomRes = await assembleCustomClient.callTool({ name: "assemble", arguments: { manifest_path: assembleCustomStage.manifestPath, mode: "validate" } });
const assembleCustomJson = JSON.parse(assembleCustomRes.content[0].text);
checkOk(assembleCustomJson.brand === "ink-paper" && assembleCustomJson.style === "clean-bold" && assembleCustomJson.brand_applied?.includes("shot 1 (s1) template.title-card.bg1") && assembleCustomJson.brand_applied?.includes("shot 1 (s1) text[0].color") && assembleCustomJson.brand_applied?.includes("shot 1 (s1) text[0].size") && assembleCustomJson.brand_applied?.includes("shot 2 (s2) template.rings.color"), "assemble brand ink-paper (MEDIAKIT_BRANDS) fills template colors + text color/size and reports applied", JSON.stringify({ brand: assembleCustomJson.brand, applied: assembleCustomJson.brand_applied }));
checkOk(assembleCustomJson.shots?.[0]?.params?.bg1 === "#0B1220" && assembleCustomJson.shots?.[0]?.params?.accent === "#22D3EE" && assembleCustomJson.shots?.[0]?.params?.fg === "#F8FAFC" && assembleCustomJson.shots?.[1]?.params?.color === "#F472B6" && assembleCustomJson.shots?.[0]?.text_layers?.[0]?.color === "F8FAFC" && assembleCustomJson.shots?.[0]?.text_layers?.[0]?.size === 60, "assemble custom brand palette lands in the template params + text layers (bg1 navy, accent cyan, rings pink, text 60px)", JSON.stringify(assembleCustomJson.shots?.map((s) => s.params)));
await assembleCustomClient.close();
// Same brand id, palette edited in the file: the fingerprint must
// move, or a re-render would silently reuse the old colours.
const brandsFpPath = path.join(root, "outputs/mcp-brands-fp.json");
await writeFile(brandsFpPath, await readFile(customBrandsPath, "utf8"), "utf8");
const assembleFp1 = await runCliJson(["assemble", assembleCustomStage.manifestPath, "--mode", "validate"], { MEDIAKIT_BRANDS: brandsFpPath });
const brandsFpDoc = JSON.parse(await readFile(brandsFpPath, "utf8"));
brandsFpDoc.brands[0].palette.primary = "FF0000";
await writeFile(brandsFpPath, JSON.stringify(brandsFpDoc), "utf8");
const assembleFp2 = await runCliJson(["assemble", assembleCustomStage.manifestPath, "--mode", "validate"], { MEDIAKIT_BRANDS: brandsFpPath });
checkOk(assembleFp1.fingerprint !== assembleFp2.fingerprint && assembleFp2.shots?.[0]?.params?.accent === "#FF0000", "assemble fingerprint changes when only the MEDIAKIT_BRANDS palette changes (same id, new colours)", `${assembleFp1.fingerprint?.slice(0, 12)} vs ${assembleFp2.fingerprint?.slice(0, 12)}`);

// Transition offsets must be full precision: a cut at 50 frames
// puts the second xfade offset at 44/30 = 1.4666...s, and rounding
// it to 4 decimals (1.4667) overshoots by 33us — enough for the
// trailing fps filter to emit one extra frame (measured 601
// instead of 600 on a 20s preview, 2026-11-14). Fixture:
// test/assemble-transitions-repeating.json (4s film, template
// shots + a color card, fade + dissolve).
const assembleRepeatStage = await stageAssembleManifest("assemble-transitions-repeating.json");
const assembleRepeatOut = path.join(assembleRepeatStage.dir, "out");
const assembleRepeatValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleRepeatStage.manifestPath, mode: "validate" } });
const assembleRepeatValidateJson = JSON.parse(assembleRepeatValidateRes.content[0].text);
checkOk(assembleRepeatValidateJson.total_seconds === 4 && assembleRepeatValidateJson.total_frames === 120, "assemble repeating-offset film validates at 4s / 120 frames", JSON.stringify({ total_seconds: assembleRepeatValidateJson.total_seconds, total_frames: assembleRepeatValidateJson.total_frames }));
const assembleRepeatRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleRepeatStage.manifestPath, mode: "render", output_dir: assembleRepeatOut, force: true } }, undefined, { timeout: 300000 });
const assembleRepeatRenderJson = JSON.parse(assembleRepeatRenderRes.content[0].text);
const assembleRepeatFinalPath = path.join(assembleRepeatOut, "final.mp4");
const assembleRepeatFinalProbe = await probeStreams(assembleRepeatFinalPath);
const assembleRepeatFinalFrames = await countFrames(assembleRepeatFinalPath);
checkOk(assembleRepeatRenderJson.approval === "forced" && near(parseFloat(assembleRepeatFinalProbe?.format?.duration), 4, 0.15) && assembleRepeatFinalFrames === 120, "assemble film with repeating-decimal transition offsets renders exactly 120 frames (no off-by-one)", `duration=${assembleRepeatFinalProbe?.format?.duration} frames=${assembleRepeatFinalFrames}`);

// Chapters: named markers on the film timeline become real MP4
// chapters on render (not preview). Fixture:
// test/assemble-chapters.json (the 10s film + Intro @0 / The turn
// @3.5s / The payoff @7s).
const assembleChaptersStage = await stageAssembleManifest("assemble-chapters.json");
const assembleChaptersOut = path.join(assembleChaptersStage.dir, "out");
const assembleChaptersValidateRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleChaptersStage.manifestPath, mode: "validate" } });
const assembleChaptersValidateJson = JSON.parse(assembleChaptersValidateRes.content[0].text);
checkOk(Array.isArray(assembleChaptersValidateJson.chapters) && assembleChaptersValidateJson.chapters.length === 3 && assembleChaptersValidateJson.chapters[1]?.title === "The turn" && assembleChaptersValidateJson.chapters[1]?.at_seconds === 3.5, "assemble validate echoes 3 chapters (Intro / The turn @3.5s / The payoff)", JSON.stringify(assembleChaptersValidateJson.chapters));
const assembleChaptersOrderText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-chapters-order.json"), mode: "validate" });
checkOk(/strictly increasing/.test(assembleChaptersOrderText ?? ""), "assemble validate refuses chapters out of order", assembleChaptersOrderText ?? "");
const assembleChaptersEndText = await callExpectThrow("assemble", { manifest_path: path.join(root, "test/assemble-bad-chapters-end.json"), mode: "validate" });
checkOk(/outside the film/.test(assembleChaptersEndText ?? ""), "assemble validate refuses a chapter past the film end", assembleChaptersEndText ?? "");
const assembleChaptersRenderRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleChaptersStage.manifestPath, mode: "render", output_dir: assembleChaptersOut, force: true } }, undefined, { timeout: 300000 });
const assembleChaptersRenderJson = JSON.parse(assembleChaptersRenderRes.content[0].text);
checkOk(assembleChaptersRenderJson.chapters?.length === 3 && assembleChaptersRenderJson.chapters[0]?.title === "Intro", "assemble render receipt echoes the chapters", JSON.stringify(assembleChaptersRenderJson.chapters));
const chaptersProbe = await probeChapters(path.join(assembleChaptersOut, "final.mp4"));
checkOk(Array.isArray(chaptersProbe) && chaptersProbe.length === 3 && chaptersProbe[0]?.start_time === "0.000000" && chaptersProbe[0]?.end_time === "3.500000" && chaptersProbe[0]?.tags?.title === "Intro" && chaptersProbe[1]?.tags?.title === "The turn" && chaptersProbe[2]?.start_time === "7.000000" && chaptersProbe[2]?.end_time === "10.000000", "assemble final.mp4 carries 3 MP4 chapters at 0 / 3.5s / 7s with the right titles", JSON.stringify(chaptersProbe));
const assembleChaptersPreviewRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleChaptersStage.manifestPath, mode: "preview", output_dir: assembleChaptersOut, preview_seconds: 3 } });
const chaptersPreviewProbe = await probeChapters(path.join(assembleChaptersOut, "preview.mp4"));
checkOk(Array.isArray(chaptersPreviewProbe) && chaptersPreviewProbe.length === 0, "assemble preview carries no chapters (clipped window)", JSON.stringify(chaptersPreviewProbe));

// Async render jobs: assemble async:true returns in milliseconds
// with a job_id; the render runs in a detached worker; `job` polls
// it. Fixture: test/assemble-async.json (4s film, no music/captions).
const assembleAsyncStage = await stageAssembleManifest("assemble-async.json");
const assembleAsyncOut = path.join(assembleAsyncStage.dir, "out");
// Fail fast: no approval exists for the staged copy, so the async
// call must refuse synchronously — no job is created.
const assembleAsyncNoApprovalText = await callExpectThrow("assemble", { manifest_path: assembleAsyncStage.manifestPath, mode: "render", output_dir: assembleAsyncOut, async: true });
checkOk(/needs approval/.test(assembleAsyncNoApprovalText ?? ""), "assemble async render refuses without approval (fail fast, no job created)", assembleAsyncNoApprovalText ?? "");
const assembleAsyncModeText = await callExpectThrow("assemble", { manifest_path: assembleAsyncStage.manifestPath, mode: "preview", output_dir: assembleAsyncOut, async: true });
checkOk(/needs mode render/.test(assembleAsyncModeText ?? ""), "assemble async:true refuses non-render modes", assembleAsyncModeText ?? "");
const asyncStart = Date.now();
const assembleAsyncRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleAsyncStage.manifestPath, mode: "render", output_dir: assembleAsyncOut, force: true, async: true } });
const assembleAsyncJson = JSON.parse(assembleAsyncRes.content[0].text);
const asyncElapsed = (Date.now() - asyncStart) / 1000;
const asyncJobId = assembleAsyncJson.job_id;
checkOk(typeof asyncJobId === "string" && /^job-\d{8}-\d{6}-[0-9a-f]{8}$/.test(asyncJobId) && assembleAsyncJson.status === "queued" && asyncElapsed < 10, "assemble async returns a job_id in under 10s (render runs in the background)", `job_id=${asyncJobId} elapsed=${asyncElapsed}s`);
// Poll the job until it finishes — the call above must NOT have
// waited for the render.
let assembleAsyncJob = null;
let assembleAsyncSawRunning = false;
// Turn 84: collect every polled percent — a 6-stage render can only
// show 0/17/33/50/67/83/100 at stage boundaries, so any other value
// proves the percent moved INSIDE a stage (ffmpeg -progress).
const assembleAsyncPercents = [];
for (let i = 0; i < 150; i++) {
  const jobRes = await client.callTool({ name: "job", arguments: { job_id: asyncJobId, action: "status" } });
  assembleAsyncJob = JSON.parse(jobRes.content[0].text);
  if (assembleAsyncJob.status === "running") assembleAsyncSawRunning = true;
  if (typeof assembleAsyncJob?.progress?.percent === "number") assembleAsyncPercents.push(assembleAsyncJob.progress.percent);
  if (assembleAsyncJob.status === "done" || assembleAsyncJob.status === "failed") break;
  await new Promise((r) => setTimeout(r, 2000));
}
checkOk(assembleAsyncSawRunning && assembleAsyncJob?.status === "done" && assembleAsyncJob?.progress?.percent === 100, "async job moves queued -> running -> done with progress reaching 100%", `status=${assembleAsyncJob?.status} progress=${JSON.stringify(assembleAsyncJob?.progress)}`);
checkOk(assembleAsyncPercents.every((v, i) => i === 0 || v >= assembleAsyncPercents[i - 1]), "async job polled percents never go backwards", `percents=${JSON.stringify(assembleAsyncPercents)}`);
// Turn 93: the history is written by the WORKER on every progress
// emit (250 ms throttle), so it proves the percent moved INSIDE a
// stage no matter how fast the render ran between two polls — turn
// 92's CI only ever polled [0, 17, 100] on a 4s film and failed the
// poll-based version of this check. A 6-stage render can only show
// 0/17/33/50/67/83/100 at stage boundaries, so any other value in the
// history proves frame-level progress (ffmpeg -progress) inside a
// stage, and the history itself is monotonic.
const assembleAsyncHistory = Array.isArray(assembleAsyncJob?.progress_history) ? assembleAsyncJob.progress_history.map((e) => e.percent) : [];
const assembleAsyncStageBounds = new Set([0, 17, 33, 50, 67, 83, 100]);
checkOk(assembleAsyncHistory.length >= 2 && assembleAsyncHistory.every((v, i) => i === 0 || v >= assembleAsyncHistory[i - 1]) && assembleAsyncHistory.some((v) => v > 0 && v < 100 && !assembleAsyncStageBounds.has(v)), "async job progress_history records a percent INSIDE a stage, not just at stage boundaries (worker-written, poll-independent)", `history=${JSON.stringify(assembleAsyncHistory)}`);
checkOk(assembleAsyncJob?.result?.output?.endsWith("final.mp4") && near(assembleAsyncJob?.result?.duration_seconds, 4, 0.15) && assembleAsyncJob?.result?.frames === 120 && near(assembleAsyncJob?.result?.loudness_lufs, -14, 0.5) && assembleAsyncJob?.result?.qa_verdict === "pass" && assembleAsyncJob?.result?.sha256?.length === 64, "async job result carries output + 4s/120 frames/-14 LUFS + qa pass + SHA-256", JSON.stringify(assembleAsyncJob?.result));
const assembleAsyncFinalFrames = await countFrames(path.join(assembleAsyncOut, "final.mp4"));
checkOk(assembleAsyncFinalFrames === 120, "async-rendered final.mp4 has exactly 120 frames on disk", `frames=${assembleAsyncFinalFrames}`);
// list shows the finished job; cancelling a terminal job is refused.
const jobListRes = await client.callTool({ name: "job", arguments: { action: "list" } });
const jobListJson = JSON.parse(jobListRes.content[0].text);
checkOk(jobListJson.jobs?.some((j) => j.job_id === asyncJobId && j.status === "done"), "job list contains the finished async job", `count=${jobListJson.count}`);
const assembleAsyncCancelDoneText = await callExpectThrow("job", { job_id: asyncJobId, action: "cancel" });
checkOk(/already done/.test(assembleAsyncCancelDoneText ?? ""), "job cancel refuses an already-done job", assembleAsyncCancelDoneText ?? "");
// Cancel: start a second async render and stop it mid-flight.
const assembleCancelStage = await stageAssembleManifest("assemble-async.json");
const assembleCancelOut = path.join(assembleCancelStage.dir, "out");
const assembleCancelRes = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleCancelStage.manifestPath, mode: "render", output_dir: assembleCancelOut, force: true, async: true } });
const assembleCancelJson = JSON.parse(assembleCancelRes.content[0].text);
const cancelJobId = assembleCancelJson.job_id;
const assembleCancelCallRes = await client.callTool({ name: "job", arguments: { job_id: cancelJobId, action: "cancel" } });
const assembleCancelCallJson = JSON.parse(assembleCancelCallRes.content[0].text);
checkOk(assembleCancelCallJson.status === "cancelled" && assembleCancelCallJson.error?.code === "JOB_CANCELLED", "job cancel stops a running render (status cancelled)", JSON.stringify(assembleCancelCallJson.status));
const assembleCancelPid = assembleCancelCallJson.pid;
let cancelWorkerAlive = null;
if (typeof assembleCancelPid === "number") {
  try { process.kill(assembleCancelPid, 0); cancelWorkerAlive = true; } catch { cancelWorkerAlive = false; }
}
checkOk(cancelWorkerAlive === false, "cancelled job's worker process is gone (process group killed)", `pid=${assembleCancelPid} alive=${cancelWorkerAlive}`);
// A second status read still says cancelled — the worker did not
// overwrite it with done/failed after the kill.
const assembleCancelRecheckRes = await client.callTool({ name: "job", arguments: { job_id: cancelJobId, action: "status" } });
const assembleCancelRecheckJson = JSON.parse(assembleCancelRecheckRes.content[0].text);
checkOk(assembleCancelRecheckJson.status === "cancelled" && !existsSync(path.join(assembleCancelOut, "final.mp4")), "cancelled job stays cancelled and wrote no final.mp4", assembleCancelRecheckJson.status);
// Unknown job id.
const jobUnknownText = await callExpectThrow("job", { job_id: "job-20000101-000000-deadbeef", action: "status" });
checkOk(/unknown job/.test(jobUnknownText ?? ""), "job status refuses an unknown job id", jobUnknownText ?? "");

// Lượt 99: job admission gate, end to end. The hermetic jobs dir
// holds only done/cancelled jobs at this point, so the gate starts
// open; two async renders started back-to-back are still queued or
// running when the third start is attempted (each start returns in
// <1s, each render takes tens of seconds), so the third must be
// refused with JOB_ADMISSION_LIMIT — and must leave no job behind.
// Cancelling both re-opens the gate: a fourth start is admitted.
const admRes = await client.callTool({ name: "job", arguments: { action: "admission" } });
const admJson = JSON.parse(admRes.content[0].text);
checkOk(admJson.admitted === true && typeof admJson.active_jobs === "number" && admJson.limits?.max_active_jobs === 2 && admJson.limits?.max_starts_per_minute === 10 && admJson.retry_after_seconds === null, "job admission reports the open gate (admitted, limits 2/10)", JSON.stringify(admJson));
const admStageA = await stageAssembleManifest("assemble-async.json");
const admStageB = await stageAssembleManifest("assemble-async.json");
const admJobA = JSON.parse((await client.callTool({ name: "assemble", arguments: { manifest_path: admStageA.manifestPath, mode: "render", output_dir: path.join(admStageA.dir, "out"), force: true, async: true } })).content[0].text);
const admJobB = JSON.parse((await client.callTool({ name: "assemble", arguments: { manifest_path: admStageB.manifestPath, mode: "render", output_dir: path.join(admStageB.dir, "out"), force: true, async: true } })).content[0].text);
checkOk(typeof admJobA.job_id === "string" && typeof admJobB.job_id === "string" && admJobA.job_id !== admJobB.job_id, "two async renders start while the gate is open", `${admJobA.job_id} / ${admJobB.job_id}`);
const admStageC = await stageAssembleManifest("assemble-async.json");
const admRefusedText = await callExpectThrow("assemble", { manifest_path: admStageC.manifestPath, mode: "render", output_dir: path.join(admStageC.dir, "out"), force: true, async: true });
checkOk(/job admission limit/.test(admRefusedText ?? "") && /max 2/.test(admRefusedText ?? "") && /retry in ~30s/.test(admRefusedText ?? ""), "third async render is refused at the admission gate (2 active, max 2)", admRefusedText ?? "");
const admAfterRefusal = JSON.parse((await client.callTool({ name: "job", arguments: { action: "list" } })).content[0].text);
checkOk(admAfterRefusal.jobs.filter((j) => j.status === "queued" || j.status === "running").length === 2 && !admAfterRefusal.jobs.some((j) => j.manifest === admStageC.manifestPath), "a refused start creates no job record (still 2 active, refused manifest absent)", `count=${admAfterRefusal.count}`);
const admCancel = async (id) => { try { await client.callTool({ name: "job", arguments: { job_id: id, action: "cancel" } }); } catch { /* already done — the gate still re-opens */ } };
await admCancel(admJobA.job_id);
await admCancel(admJobB.job_id);
const admJobD = JSON.parse((await client.callTool({ name: "assemble", arguments: { manifest_path: admStageC.manifestPath, mode: "render", output_dir: path.join(admStageC.dir, "out"), force: true, async: true } })).content[0].text);
checkOk(typeof admJobD.job_id === "string", "cancelling both jobs re-opens the gate (fourth start admitted)", admJobD.job_id ?? "");
await admCancel(admJobD.job_id);

// Lượt 122: estimate_remaining — pure estimator, deterministic
// (nowMs pinned, so no wall-clock flake). Terminal/queued shapes
// first, then the two live bases and their fallbacks.
const estNowMs = Date.parse("2026-11-20T10:00:00.000Z");
const estCreatedIso = "2026-11-20T09:59:00.000Z"; // 60s before estNowMs
const estBase = { status: "running", progress: { stage: "shots", percent: 50, detail: null }, created_at: estCreatedIso, progress_history: [] };
checkOk(JSON.stringify(estimateJobRemaining({ status: "done" }, estNowMs)) === JSON.stringify({ estimate_remaining_seconds: 0, estimate_basis: "complete" }), "estimate: done job has 0 remaining / complete", JSON.stringify(estimateJobRemaining({ status: "done" }, estNowMs)));
checkOk(JSON.stringify(estimateJobRemaining({ status: "failed" }, estNowMs)) === JSON.stringify({ estimate_remaining_seconds: null, estimate_basis: "terminal" }), "estimate: failed job is null / terminal", JSON.stringify(estimateJobRemaining({ status: "failed" }, estNowMs)));
checkOk(JSON.stringify(estimateJobRemaining({ status: "cancelled" }, estNowMs)) === JSON.stringify({ estimate_remaining_seconds: null, estimate_basis: "terminal" }), "estimate: cancelled job is null / terminal", JSON.stringify(estimateJobRemaining({ status: "cancelled" }, estNowMs)));
checkOk(JSON.stringify(estimateJobRemaining({ status: "queued", progress: { percent: 0 } }, estNowMs)) === JSON.stringify({ estimate_remaining_seconds: null, estimate_basis: "not-started" }), "estimate: queued job is null / not-started", JSON.stringify(estimateJobRemaining({ status: "queued" }, estNowMs)));
checkOk(JSON.stringify(estimateJobRemaining({ ...estBase, progress: { stage: "shots", percent: 0 } }, estNowMs)) === JSON.stringify({ estimate_remaining_seconds: null, estimate_basis: "too-early" }), "estimate: running at 0% is null / too-early", JSON.stringify(estimateJobRemaining({ ...estBase, progress: { percent: 0 } }, estNowMs)));
checkOk(JSON.stringify(estimateJobRemaining({ ...estBase, progress: { stage: "shots", percent: 3 } }, estNowMs)) === JSON.stringify({ estimate_remaining_seconds: null, estimate_basis: "too-early" }), "estimate: running at 3% is null / too-early", JSON.stringify(estimateJobRemaining({ ...estBase, progress: { percent: 3 } }, estNowMs)));
checkOk(JSON.stringify(estimateJobRemaining({ ...estBase, progress: { stage: "done", percent: 100 } }, estNowMs)) === JSON.stringify({ estimate_remaining_seconds: 0, estimate_basis: "complete" }), "estimate: running at 100% is 0 / complete", JSON.stringify(estimateJobRemaining({ ...estBase, progress: { percent: 100 } }, estNowMs)));
// progress-rate: history 10% -> 50% over 40s = 1%/s, 50 left -> 50s.
const estRate = estimateJobRemaining({ ...estBase, progress_history: [{ at: estCreatedIso, stage: "shots", percent: 10 }, { at: "2026-11-20T09:59:40.000Z", stage: "shots", percent: 50 }] }, estNowMs);
checkOk(estRate.estimate_remaining_seconds === 50 && estRate.estimate_basis === "progress-rate", "estimate: history 10->50% in 40s gives 50s / progress-rate", JSON.stringify(estRate));
// progress-rate, slow job: 80% -> 90% over 100s = 0.1%/s, 10 left -> 100s.
const estSlow = estimateJobRemaining({ ...estBase, progress: { stage: "shots", percent: 90 }, progress_history: [{ at: "2026-11-20T09:57:20.000Z", stage: "shots", percent: 80 }, { at: "2026-11-20T09:59:00.000Z", stage: "shots", percent: 90 }] }, estNowMs);
checkOk(estSlow.estimate_remaining_seconds === 100 && estSlow.estimate_basis === "progress-rate", "estimate: history 80->90% in 100s gives 100s / progress-rate", JSON.stringify(estSlow));
// elapsed-progress: no history, 50% in 60s -> 60s left.
const estElapsed = estimateJobRemaining(estBase, estNowMs);
checkOk(estElapsed.estimate_remaining_seconds === 60 && estElapsed.estimate_basis === "elapsed-progress", "estimate: no history, 50% in 60s gives 60s / elapsed-progress", JSON.stringify(estElapsed));
// Held percent falls back to elapsed: history 50% -> 50% over 40s
// (a long encode inside one stage) + created 120s ago -> 120s.
const estHeld = estimateJobRemaining({ ...estBase, created_at: "2026-11-20T09:58:00.000Z", progress_history: [{ at: "2026-11-20T09:59:00.000Z", stage: "shots", percent: 50 }, { at: "2026-11-20T09:59:40.000Z", stage: "shots", percent: 50 }] }, estNowMs);
checkOk(estHeld.estimate_remaining_seconds === 120 && estHeld.estimate_basis === "elapsed-progress", "estimate: held percent falls back to elapsed-progress (120s)", JSON.stringify(estHeld));
// History compressed under 1s falls back to elapsed too.
const estCompressed = estimateJobRemaining({ ...estBase, progress_history: [{ at: "2026-11-20T09:59:59.500Z", stage: "shots", percent: 10 }, { at: "2026-11-20T09:59:59.900Z", stage: "shots", percent: 50 }] }, estNowMs);
checkOk(estCompressed.estimate_remaining_seconds === 60 && estCompressed.estimate_basis === "elapsed-progress", "estimate: sub-second history falls back to elapsed-progress (60s)", JSON.stringify(estCompressed));
// No timestamps at all: no history, no created_at -> null / too-early.
const estNoTime = estimateJobRemaining({ status: "running", progress: { stage: "shots", percent: 50 } }, estNowMs);
checkOk(estNoTime.estimate_remaining_seconds === null && estNoTime.estimate_basis === "too-early", "estimate: no timestamps anywhere is null / too-early", JSON.stringify(estNoTime));
// Cap: 50% after 200000s elapsed would claim 200000s — capped at 24h.
const estCap = estimateJobRemaining({ ...estBase, created_at: "2026-11-18T02:26:40.000Z" }, estNowMs);
checkOk(estCap.estimate_remaining_seconds === 86400 && estCap.estimate_basis === "elapsed-progress", "estimate: absurd elapsed time caps at 86400s (24h)", JSON.stringify(estCap));

// download: a local HTTP server stands in for the internet, so the
// suite never depends on the network — every guard (redirect, size
// cap mid-stream, content-type, 404, timeout) is exercised against a
// server this test controls. Node fetch honours NO_PROXY for
// 127.0.0.1, so the sandbox proxy is bypassed for these calls.
const downloadFixture = await readFile(path.join(root, "test/source.mp4"));
// Hit counters for the retry/cache endpoints below (lượt 85).
const dlHits = { flaky: 0, always503: 0, always429: 0, cacheable: 0, counted: 0 };
// HLS/DASH fixtures, generated on the fly from the same source clip
// (stream copy, so the segments carry the source's own streams —
// no re-encode, and the suite stays network-free).
await mkdir(path.join(root, "outputs/hls-test"), { recursive: true });
await mkdir(path.join(root, "outputs/dash-test"), { recursive: true });
await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", path.join(root, "test/source.mp4"), "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", path.join(root, "outputs/hls-test/stream.m3u8")]);
await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", path.join(root, "test/source.mp4"), "-c", "copy", "-f", "dash", path.join(root, "outputs/dash-test/stream.mpd")]);
const downloadServer = createServer(async (req, res) => {
  if (req.url === "/source.mp4") {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": downloadFixture.length });
    res.end(downloadFixture);
  } else if (req.url === "/noext") {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": downloadFixture.length });
    res.end(downloadFixture);
  } else if (req.url === "/octet") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": downloadFixture.length });
    res.end(downloadFixture);
  } else if (req.url === "/redir") {
    res.writeHead(302, { location: "/source.mp4" });
    res.end();
  } else if (req.url === "/redir-loop") {
    res.writeHead(302, { location: "/redir-loop" });
    res.end();
  } else if (req.url === "/big") {
    // Declares 600 MB but sends nothing: the tool must refuse from
    // the header alone, before reading a body byte.
    res.writeHead(200, { "content-type": "video/mp4", "content-length": 600 * 1024 * 1024 });
    res.end();
  } else if (req.url === "/stream-big") {
    // Lies by omission: no Content-Length, chunked body ~3x the
    // fixture — the streaming cap (0.5 MB) must trip mid-body.
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(Buffer.concat([downloadFixture, downloadFixture, downloadFixture]));
  } else if (req.url === "/text") {
    res.writeHead(200, { "content-type": "text/html", "content-length": 13 });
    res.end("<html>hi</html>");
  } else if (req.url === "/fake-mp4") {
    // Right content-type, wrong bytes: probe must fail and the file
    // must be deleted, not reported as a success.
    const body = Buffer.from("this is not a video file at all, just text pretending to be one");
    res.writeHead(200, { "content-type": "video/mp4", "content-length": body.length });
    res.end(body);
  } else if (req.url === "/flaky") {
    // 503 twice, then the fixture: the retry path must recover.
    // Retry-After: 1 keeps the test fast (1s + 1s of backoff).
    dlHits.flaky++;
    if (dlHits.flaky <= 2) { res.writeHead(503, { "retry-after": "1" }); res.end(); }
    else { res.writeHead(200, { "content-type": "video/mp4", "content-length": downloadFixture.length }); res.end(downloadFixture); }
  } else if (req.url === "/always-503") {
    dlHits.always503++;
    res.writeHead(503); res.end();
  } else if (req.url === "/always-429") {
    // Always rate-limited, with a Retry-After the envelope must
    // surface: the error (not the retry loop) is the assertion.
    dlHits.always429++;
    res.writeHead(429, { "retry-after": "7" }); res.end();
  } else if (req.url === "/cacheable.mp4") {
    dlHits.cacheable++;
    res.writeHead(200, { "content-type": "video/mp4", "content-length": downloadFixture.length }); res.end(downloadFixture);
  } else if (req.url === "/counted.mp4") {
    // Counted endpoint for the license gate (lượt 90): a denied
    // download must not hit the server at all, so the counter proves
    // the fail-fast instead of trusting the code path.
    dlHits.counted++;
    res.writeHead(200, { "content-type": "video/mp4", "content-length": downloadFixture.length }); res.end(downloadFixture);
  } else if (req.url === "/slow") {
    // Never responds: the tool's timeout must fire, not the test's.
  } else if (req.url.startsWith("/hls/") || req.url.startsWith("/dash/")) {
    // A generated playlist fixture: the playlist, its segments and
    // init files, with the content-type a real CDN would send
    // (ffmpeg sniffs, but the types must be right). basename only —
    // the URL must never pick a file outside the fixture dir.
    const kind = req.url.startsWith("/hls/") ? "hls-test" : "dash-test";
    const file = path.join(root, "outputs", kind, path.basename(req.url));
    const ext = path.extname(file).slice(1).toLowerCase();
    const types = { m3u8: "application/vnd.apple.mpegurl", ts: "video/mp2t", mpd: "application/dash+xml", m4s: "video/iso.segment" };
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "content-length": body.length });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => downloadServer.listen(0, "127.0.0.1", resolve));
const dlBase = `http://127.0.0.1:${downloadServer.address().port}`;
const dlHappyRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/source.mp4`, output: path.join(root, "outputs/mcp-download.mp4") } });
const dlHappy = JSON.parse(dlHappyRes.content[0].text);
checkOk(dlHappy.size_bytes === downloadFixture.length && dlHappy.media?.duration_seconds === 10 && dlHappy.media?.video?.width === 1280 && dlHappy.redirects === 0 && dlHappy.content_type === "video/mp4", "download fetches the fixture: exact size + 10s + 1280 wide + 0 redirects", JSON.stringify(dlHappy).slice(0, 300));
checkOk(existsSync(path.join(root, "outputs/mcp-download.mp4")) && statSync(path.join(root, "outputs/mcp-download.mp4")).size === downloadFixture.length && !existsSync(path.join(root, "outputs/mcp-download.mp4.partial")), "downloaded file exists on disk with the fixture's exact size and no .partial left behind", `size=${existsSync(path.join(root, "outputs/mcp-download.mp4")) ? statSync(path.join(root, "outputs/mcp-download.mp4")).size : "missing"}`);
const dlNoextRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/noext`, output: path.join(root, "outputs/mcp-download-noext") } });
const dlNoext = JSON.parse(dlNoextRes.content[0].text);
checkOk(dlNoext.output.endsWith(".mp4") && dlNoext.size_bytes === downloadFixture.length, "download derives .mp4 from the Content-Type when the output has no extension", dlNoext.output);
const dlOctetRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/octet`, output: path.join(root, "outputs/mcp-download-octet.mp4") } });
const dlOctet = JSON.parse(dlOctetRes.content[0].text);
checkOk(dlOctet.size_bytes === downloadFixture.length && dlOctet.content_type === "application/octet-stream", "download accepts application/octet-stream when the output extension is media", JSON.stringify(dlOctet).slice(0, 200));
const dlRedirRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/redir`, output: path.join(root, "outputs/mcp-download-redir.mp4") } });
const dlRedir = JSON.parse(dlRedirRes.content[0].text);
checkOk(dlRedir.redirects === 1 && dlRedir.final_url.endsWith("/source.mp4") && dlRedir.size_bytes === downloadFixture.length, "download follows one redirect and reports it (redirects=1, final_url is the target)", JSON.stringify(dlRedir).slice(0, 200));
const dlLoopText = await callExpectThrow("download", { url: `${dlBase}/redir-loop`, output: path.join(root, "outputs/mcp-download-loop.mp4") });
checkOk(/too many redirects/.test(dlLoopText ?? ""), "download refuses a redirect loop after 5 hops", dlLoopText ?? "");
const dlBigText = await callExpectThrow("download", { url: `${dlBase}/big`, output: path.join(root, "outputs/mcp-download-big.mp4") });
checkOk(/exceeds max_size_mb/.test(dlBigText ?? "") && !existsSync(path.join(root, "outputs/mcp-download-big.mp4")), "download refuses a 600 MB Content-Length upfront, before reading the body", dlBigText ?? "");
const dlStreamBigText = await callExpectThrow("download", { url: `${dlBase}/stream-big`, output: path.join(root, "outputs/mcp-download-streambig.mp4"), max_size_mb: 0.5 });
checkOk(/exceeded max_size_mb.*while streaming/.test(dlStreamBigText ?? "") && !existsSync(path.join(root, "outputs/mcp-download-streambig.mp4")) && !existsSync(path.join(root, "outputs/mcp-download-streambig.mp4.partial")), "download aborts mid-stream when the body passes the cap with no Content-Length, and leaves no file or .partial", dlStreamBigText ?? "");
const dlTextText = await callExpectThrow("download", { url: `${dlBase}/text`, output: path.join(root, "outputs/mcp-download-text.mp4") });
checkOk(/not media/.test(dlTextText ?? "") && !existsSync(path.join(root, "outputs/mcp-download-text.mp4")), "download refuses a text/html content-type", dlTextText ?? "");
const dl404Text = await callExpectThrow("download", { url: `${dlBase}/missing.mp4`, output: path.join(root, "outputs/mcp-download-404.mp4") });
checkOk(/HTTP 404/.test(dl404Text ?? ""), "download reports HTTP 404 instead of writing a file", dl404Text ?? "");
const dlMismatchText = await callExpectThrow("download", { url: `${dlBase}/source.mp4`, output: path.join(root, "outputs/mcp-download-mismatch.mp3") });
checkOk(/refuses: content-type video\/mp4 is video but the output extension .mp3 is audio/.test(dlMismatchText ?? ""), "download refuses a video served as .mp3 (category mismatch)", dlMismatchText ?? "");
const dlFakeText = await callExpectThrow("download", { url: `${dlBase}/fake-mp4`, output: path.join(root, "outputs/mcp-download-fake.mp4") });
checkOk(/not media/.test(dlFakeText ?? "") && !existsSync(path.join(root, "outputs/mcp-download-fake.mp4")), "download deletes a file whose bytes fail the probe (right content-type, wrong bytes)", dlFakeText ?? "");
const dlFtpText = await callExpectThrow("download", { url: "ftp://example.com/clip.mp4", output: path.join(root, "outputs/mcp-download-ftp.mp4") });
checkOk(/http\(s\) URL/.test(dlFtpText ?? ""), "download refuses a non-http(s) URL", dlFtpText ?? "");
const dlHlsRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/hls/stream.m3u8`, output: path.join(root, "outputs/mcp-download-hls.mp4") } });
const dlHls = JSON.parse(dlHlsRes.content[0].text);
checkOk(dlHls.playlist === "m3u8" && dlHls.redirects === null && near(dlHls.media?.duration_seconds, 10, 0.1) && dlHls.media?.video?.width === 1280 && dlHls.media?.video?.codec === "h264", "download fetches an HLS playlist with ffmpeg -c copy: 10s, 1280 wide, h264, playlist=m3u8", JSON.stringify(dlHls).slice(0, 300));
checkOk(existsSync(path.join(root, "outputs/mcp-download-hls.mp4")) && !existsSync(path.join(root, "outputs/mcp-download-hls.mp4.partial")), "HLS download leaves the file and no .partial", `exists=${existsSync(path.join(root, "outputs/mcp-download-hls.mp4"))}`);
const dlDashRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/dash/stream.mpd`, output: path.join(root, "outputs/mcp-download-dash.mp4") } });
const dlDash = JSON.parse(dlDashRes.content[0].text);
checkOk(dlDash.playlist === "mpd" && near(dlDash.media?.duration_seconds, 10, 0.1) && dlDash.media?.video?.width === 1280, "download fetches a DASH playlist with ffmpeg -c copy: 10s, 1280 wide, playlist=mpd", JSON.stringify(dlDash).slice(0, 300));
const dlHlsCapText = await callExpectThrow("download", { url: `${dlBase}/hls/stream.m3u8`, output: path.join(root, "outputs/mcp-download-hls-cap.mp4"), max_size_mb: 0.01 });
checkOk(/exceeds max_size_mb/.test(dlHlsCapText ?? "") && !existsSync(path.join(root, "outputs/mcp-download-hls-cap.mp4")) && !existsSync(path.join(root, "outputs/mcp-download-hls-cap.mp4.partial")), "HLS download enforces the size cap after the fetch and deletes the over-cap file", dlHlsCapText ?? "");
const dlHlsPngText = await callExpectThrow("download", { url: `${dlBase}/hls/stream.m3u8`, output: path.join(root, "outputs/mcp-download-hls.png") });
checkOk(/video\/audio container/.test(dlHlsPngText ?? ""), "download refuses a playlist into an image extension (a stream needs a container)", dlHlsPngText ?? "");
const dlCredsText = await callExpectThrow("download", { url: "https://user:pass@example.com/clip.mp4", output: path.join(root, "outputs/mcp-download-creds.mp4") });
checkOk(/embedded credentials/.test(dlCredsText ?? ""), "download refuses a URL with embedded credentials", dlCredsText ?? "");
const dlBadExtText = await callExpectThrow("download", { url: `${dlBase}/source.mp4`, output: path.join(root, "outputs/mcp-download-bad.txt") });
checkOk(/writes a media file/.test(dlBadExtText ?? ""), "download refuses a non-media output extension", dlBadExtText ?? "");
const dlSlowText = await callExpectThrow("download", { url: `${dlBase}/slow`, output: path.join(root, "outputs/mcp-download-slow.mp4"), timeout_seconds: 1 });
checkOk(/timed out after 1s/.test(dlSlowText ?? ""), "download times out after timeout_seconds on a silent server", dlSlowText ?? "");
const dlDoctorRes = await client.callTool({ name: "doctor", arguments: {} });
const dlDoctor = JSON.parse(dlDoctorRes.content[0].text);
checkOk(dlDoctor.tools?.download?.available === true, "doctor reports download available (pure Node fetch + ffprobe, no ffmpeg filter needed)", JSON.stringify(dlDoctor.tools?.download));
// Download provenance (turn 65, broll-mcp idea): the happy-path
// download above must have left a record next to the file, with the
// file's real sha256 and an honestly-unknown license.
const dlProvPath = path.join(root, "outputs/mcp-download.mp4.provenance.json");
const dlProv = JSON.parse(await readFile(dlProvPath, "utf8"));
const dlProvSha = createHash("sha256").update(await readFile(path.join(root, "outputs/mcp-download.mp4"))).digest("hex");
checkOk(dlProv.schema === "mediakit-for-agents/provenance/1" && dlProv.sha256 === dlProvSha && dlProv.size_bytes === downloadFixture.length && dlProv.source?.url?.endsWith("/source.mp4") && dlProv.source?.redirects === 0 && dlProv.license?.label === "unknown" && dlProv.license?.commercial_use === "unknown" && dlProv.mediakit_version === "0.1.0" && typeof dlProv.ffmpeg_version === "string" && dlProv.media?.duration_seconds === 10, "download writes a provenance record next to the file: real sha256, source URL, unknown license (never guessed)", JSON.stringify(dlProv).slice(0, 300));
checkOk(dlHappy.provenance === dlProvPath, "download result reports the provenance path", dlHappy.provenance ?? "");
const dlHlsProv = JSON.parse(await readFile(path.join(root, "outputs/mcp-download-hls.mp4.provenance.json"), "utf8"));
checkOk(dlHlsProv.source?.playlist === "m3u8" && dlHlsProv.license?.label === "unknown" && typeof dlHlsProv.sha256 === "string", "an HLS download also writes provenance (playlist=m3u8, license unknown)", JSON.stringify(dlHlsProv.source));

// manifest download step: the URL in step 1 IS the input, so the
// manifest omits `input` entirely — download, then trim the fetched
// HLS clip to 5s. The manifest is written here because the URL
// carries this test's ephemeral local port.
const dlManifestPath = path.join(root, "outputs/mcp-manifest-download.json");
await writeFile(dlManifestPath, JSON.stringify({
  version: 1, output: "mcp-manifest-download.mp4",
  steps: [
    { tool: "download", args: { url: `${dlBase}/hls/stream.m3u8` } },
    { tool: "trim", args: { start: 0, end: 5 } },
  ],
}, null, 2));
const dlManDryRes = await client.callTool({ name: "manifest", arguments: { manifest_path: dlManifestPath, dry_run: true } });
const dlManDry = JSON.parse(dlManDryRes.content[0].text);
checkOk(dlManDry.input === null && dlManDry.input_duration_seconds === null && dlManDry.steps?.length === 2 && dlManDry.steps[0].tool === "download" && dlManDry.steps[0].output.endsWith(".mp4"), "manifest dry-run plans a download-first pipeline with no input file", JSON.stringify(dlManDry).slice(0, 300));
const dlManRes = await client.callTool({ name: "manifest", arguments: { manifest_path: dlManifestPath } });
const dlMan = JSON.parse(dlManRes.content[0].text);
checkOk(dlMan.steps_run === 2 && dlMan.cache_hits === 0 && dlMan.final?.duration_seconds === 5 && dlMan.final?.dimensions === "1280x720", "manifest download step fetches the HLS clip and trims it to 5s, 1280x720", JSON.stringify(dlMan.final));
const dlManAgainRes = await client.callTool({ name: "manifest", arguments: { manifest_path: dlManifestPath } });
const dlManAgain = JSON.parse(dlManAgainRes.content[0].text);
checkOk(dlManAgain.cache_hits === 2 && dlManAgain.steps_run === 0 && dlManAgain.final?.duration_seconds === 5, "re-running the download-first manifest serves both steps from cache and re-fetches nothing", JSON.stringify({ cache_hits: dlManAgain.cache_hits, steps_run: dlManAgain.steps_run }));
const dlManBadPath = path.join(root, "outputs/mcp-manifest-download-bad.json");
await writeFile(dlManBadPath, JSON.stringify({
  version: 1, input: "../test/source.mp4", output: "mcp-manifest-download-bad.mp4",
  steps: [
    { tool: "trim", args: { start: 0, end: 2 } },
    { tool: "download", args: { url: `${dlBase}/hls/stream.m3u8` } },
  ],
}, null, 2));
const dlManBadText = await callExpectThrow("manifest", { manifest_path: dlManBadPath });
checkOk(/must be the first step/.test(dlManBadText ?? ""), "manifest refuses download as step 2 at lint time", dlManBadText ?? "");
const dlManNoUrlPath = path.join(root, "outputs/mcp-manifest-download-nourl.json");
await writeFile(dlManNoUrlPath, JSON.stringify({
  version: 1, output: "mcp-manifest-download-nourl.mp4",
  steps: [{ tool: "download", args: {} }],
}, null, 2));
const dlManNoUrlText = await callExpectThrow("manifest", { manifest_path: dlManNoUrlPath });
checkOk(/needs a url/.test(dlManNoUrlText ?? ""), "manifest refuses a download step with no url at lint time", dlManNoUrlText ?? "");
// Download retry + cache + token bucket (lượt 85): the same local
// server, now with a flaky endpoint (503 twice, then 200) and a
// cacheable one with a hit counter.
const dlFlakyRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/flaky`, output: path.join(root, "outputs/mcp-download-flaky.mp4") } });
const dlFlaky = JSON.parse(dlFlakyRes.content[0].text);
checkOk(dlFlaky.attempts === 3 && dlFlaky.retries === 2 && dlFlaky.retry_wait_ms >= 1900 && dlFlaky.retry_wait_ms <= 5000 && dlFlaky.size_bytes === downloadFixture.length && dlFlaky.cached === false, "download retries a 503 twice and succeeds on attempt 3 (Retry-After 1s honoured: ~2s of backoff)", JSON.stringify({ attempts: dlFlaky.attempts, retries: dlFlaky.retries, retry_wait_ms: dlFlaky.retry_wait_ms }));
checkOk(dlHits.flaky === 3, "flaky endpoint was hit exactly 3 times (no extra requests)", `hits=${dlHits.flaky}`);
const dlA503Text = await callExpectThrow("download", { url: `${dlBase}/always-503`, output: path.join(root, "outputs/mcp-download-a503.mp4"), max_retries: 2 });
checkOk(/HTTP 503/.test(dlA503Text ?? "") && /after 3 attempts/.test(dlA503Text ?? "") && dlHits.always503 === 3, "download gives up after 1 + 2 retries on a permanent 503 and says so (after 3 attempts)", dlA503Text ?? "");
// Error envelope (lượt 121): every tool error carries retryable +
// retry_after_seconds (when the failure named a wait). A permanent
// 503 that exhausts retries stays retryable (the cause is
// transient) but names no wait — this server sent no Retry-After;
// a 429 with Retry-After 7 names exactly 7s, on the first attempt.
const dlA503Json = JSON.parse(dlA503Text ?? "{}");
checkOk(dlA503Json.code === "DOWNLOAD_FAILED" && dlA503Json.retryable === true && dlA503Json.retry_after_seconds === undefined && dlA503Json.retry?.tool === "download", "a permanent 503 that exhausts retries reports retryable=true with no retry_after_seconds (the server sent none)", dlA503Text ?? "");
const dlA429Text = await callExpectThrow("download", { url: `${dlBase}/always-429`, output: path.join(root, "outputs/mcp-download-a429.mp4"), max_retries: 0 });
const dlA429Json = JSON.parse(dlA429Text ?? "{}");
checkOk(dlA429Json.code === "DOWNLOAD_FAILED" && dlA429Json.retryable === true && dlA429Json.retry_after_seconds === 7 && dlHits.always429 === 1, "a 429 with Retry-After 7 reports retryable=true + retry_after_seconds=7 on the first attempt (max_retries 0)", dlA429Text ?? "");
const probeMissingText = await callExpectThrow("probe", { input: path.join(root, "test/no-such-file.mp4") });
const probeMissingJson = JSON.parse(probeMissingText ?? "{}");
checkOk(probeMissingJson.code === "INPUT_NOT_FOUND" && probeMissingJson.retryable === false && probeMissingJson.retry_after_seconds === undefined, "a missing input reports retryable=false and no retry_after_seconds (re-issuing the identical call cannot help)", probeMissingText ?? "");
const dlCacheDir = path.join(root, "outputs/dl-cache");
const dlCache1Res = await client.callTool({ name: "download", arguments: { url: `${dlBase}/cacheable.mp4`, output: path.join(root, "outputs/mcp-download-cache1.mp4"), cache: true, cache_dir: dlCacheDir } });
const dlCache1 = JSON.parse(dlCache1Res.content[0].text);
checkOk(dlCache1.cached === false && dlCache1.cache_stored === true && dlCache1.attempts === 1 && dlHits.cacheable === 1, "download --cache stores the first fetch (cached=false, cache_stored=true, 1 server hit)", JSON.stringify({ cached: dlCache1.cached, cache_stored: dlCache1.cache_stored }));
const dlCache2Res = await client.callTool({ name: "download", arguments: { url: `${dlBase}/cacheable.mp4`, output: path.join(root, "outputs/mcp-download-cache2.mp4"), cache: true, cache_dir: dlCacheDir } });
const dlCache2 = JSON.parse(dlCache2Res.content[0].text);
checkOk(dlCache2.cached === true && dlCache2.attempts === 0 && dlCache2.cache_age_seconds >= 0 && dlHits.cacheable === 1, "download --cache serves the second fetch from disk (cached=true, 0 attempts, server hit count unchanged)", JSON.stringify({ cached: dlCache2.cached, attempts: dlCache2.attempts, hits: dlHits.cacheable }));
const dlCacheSha = createHash("sha256").update(await readFile(path.join(root, "outputs/mcp-download-cache2.mp4"))).digest("hex");
const dlFixtureSha = createHash("sha256").update(downloadFixture).digest("hex");
checkOk(dlCacheSha === dlFixtureSha, "cache-served file is byte-identical to the fixture", dlCacheSha.slice(0, 16));
const dlCacheMeta = JSON.parse(await readFile(path.join(dlCacheDir, createHash("sha256").update(`${dlBase}/cacheable.mp4`).digest("hex"), "meta.json"), "utf8"));
checkOk(dlCacheMeta.url === `${dlBase}/cacheable.mp4` && dlCacheMeta.sha256 === dlFixtureSha && dlCacheMeta.size_bytes === downloadFixture.length && dlCacheMeta.ext === "mp4", "cache meta records the URL, sha256, size and extension", JSON.stringify(dlCacheMeta).slice(0, 200));
// A corrupt cache entry must be a miss, never served: flip a byte
// in the stored file and the next fetch re-downloads.
const dlCacheEntryDir = path.join(dlCacheDir, createHash("sha256").update(`${dlBase}/cacheable.mp4`).digest("hex"));
const dlCacheFile = await readFile(path.join(dlCacheEntryDir, "file"));
dlCacheFile[0] ^= 0xff;
await writeFile(path.join(dlCacheEntryDir, "file"), dlCacheFile);
const dlCache3Res = await client.callTool({ name: "download", arguments: { url: `${dlBase}/cacheable.mp4`, output: path.join(root, "outputs/mcp-download-cache3.mp4"), cache: true, cache_dir: dlCacheDir } });
const dlCache3 = JSON.parse(dlCache3Res.content[0].text);
checkOk(dlCache3.cached === false && dlCache3.cache_stored === true && dlHits.cacheable === 2, "a corrupt cache entry is re-fetched (not served) and re-stored", JSON.stringify({ cached: dlCache3.cached, hits: dlHits.cacheable }));
const dlCacheHlsText = await callExpectThrow("download", { url: `${dlBase}/hls/stream.m3u8`, output: path.join(root, "outputs/mcp-download-hls-cache.mp4"), cache: true });
checkOk(/does not cache playlists/.test(dlCacheHlsText ?? ""), "download refuses --cache on a playlist instead of silently ignoring it", dlCacheHlsText ?? "");
// Token bucket (lượt 85): two downloads at 1 req/s in one server
// process — the first takes a free token, the second waits. The wait
// is 1000ms MINUS the time the first download itself took (the
// bucket refills while it runs), so the bound on the second wait must
// tolerate a first download a few ms over 500ms — observed 497ms on
// 2026-11-19 (first download took 503ms). The hard proof the bucket
// throttled is the two calls together taking >=900ms wall-clock —
// without the bucket both would finish in ~300ms.
const dlRateT0 = Date.now();
const dlRate1Res = await client.callTool({ name: "download", arguments: { url: `${dlBase}/cacheable.mp4`, output: path.join(root, "outputs/mcp-download-rate1.mp4"), rate_limit_rps: 1 } });
const dlRate1 = JSON.parse(dlRate1Res.content[0].text);
const dlRate2Res = await client.callTool({ name: "download", arguments: { url: `${dlBase}/cacheable.mp4`, output: path.join(root, "outputs/mcp-download-rate2.mp4"), rate_limit_rps: 1 } });
const dlRate2 = JSON.parse(dlRate2Res.content[0].text);
const dlRateElapsedMs = Date.now() - dlRateT0;
checkOk(dlRate1.rate_limited_wait_ms === 0 && dlRate2.rate_limited_wait_ms >= 400 && dlRate2.rate_limited_wait_ms < 5000 && dlRateElapsedMs >= 900, "token bucket at 1 rps: first download waits 0ms, second waits most of the remaining second (1000ms minus the first download's own wall time), both calls take >=900ms wall-clock", JSON.stringify({ first: dlRate1.rate_limited_wait_ms, second: dlRate2.rate_limited_wait_ms, elapsed_ms: dlRateElapsedMs }));
// CLI flags for the same features (hermetic cache dir under outputs/).
const dlCliCache1 = await runCliJson(["download", `${dlBase}/cacheable.mp4`, "-o", path.join(root, "outputs/mcp-download-cli-cache1.mp4"), "--cache", "--cache-dir", path.join(root, "outputs/dl-cache-cli")]);
checkOk(dlCliCache1.cached === false && dlCliCache1.cache_stored === true, "CLI download --cache stores on first fetch", JSON.stringify({ cached: dlCliCache1.cached, cache_stored: dlCliCache1.cache_stored }));
const dlCliCache2 = await runCliJson(["download", `${dlBase}/cacheable.mp4`, "-o", path.join(root, "outputs/mcp-download-cli-cache2.mp4"), "--cache", "--cache-dir", path.join(root, "outputs/dl-cache-cli")]);
checkOk(dlCliCache2.cached === true && dlCliCache2.attempts === 0, "CLI download --cache serves the second fetch from disk", JSON.stringify({ cached: dlCliCache2.cached, attempts: dlCliCache2.attempts }));
// License policy gate (lượt 90, backlog lượt 68): --license declares
// the source's license, a policy file gates the download BEFORE any
// fetch. The /counted.mp4 endpoint proves the fail-fast: a denied
// download must not hit the server at all.
const dlPolicyAllowCc0 = path.join(root, "outputs/dl-policy-allow-cc0.json");
await writeFile(dlPolicyAllowCc0, JSON.stringify({ allow: ["CC0"] }));
const dlPolicyRequire = path.join(root, "outputs/dl-policy-require.json");
await writeFile(dlPolicyRequire, JSON.stringify({ require_license: true }));
const dlPolicyDenyArr = path.join(root, "outputs/dl-policy-deny-arr.json");
await writeFile(dlPolicyDenyArr, JSON.stringify({ deny: ["All Rights Reserved"] }));
const dlPolicyBad = path.join(root, "outputs/dl-policy-bad.json");
await writeFile(dlPolicyBad, "{not json");
const dlLicDenyText = await callExpectThrow("download", { url: `${dlBase}/counted.mp4`, output: path.join(root, "outputs/mcp-download-lic-deny.mp4"), license: "CC-BY", license_policy_file: dlPolicyAllowCc0 });
checkOk(/LICENSE_DENIED/.test(dlLicDenyText ?? "") && /not in the allow list/.test(dlLicDenyText ?? "") && dlHits.counted === 0 && !existsSync(path.join(root, "outputs/mcp-download-lic-deny.mp4")), "license gate: CC-BY vs allow [CC0] is refused with LICENSE_DENIED before any fetch (server hit count still 0, no file)", dlLicDenyText ?? "");
const dlLicOkRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/counted.mp4`, output: path.join(root, "outputs/mcp-download-lic-ok.mp4"), license: "cc0", license_policy_file: dlPolicyAllowCc0 } });
const dlLicOk = JSON.parse(dlLicOkRes.content[0].text);
checkOk(dlLicOk.license?.label === "CC0" && dlLicOk.license?.policy_source === `file:${dlPolicyAllowCc0}` && dlLicOk.license?.decision === "allowed" && dlHits.counted === 1, "license gate: lowercase alias 'cc0' canonicalizes to CC0 and passes the allow list (1 server hit)", JSON.stringify(dlLicOk.license));
const dlLicOkProv = JSON.parse(await readFile(path.join(root, "outputs/mcp-download-lic-ok.mp4.provenance.json"), "utf8"));
checkOk(dlLicOkProv.license?.label === "CC0" && dlLicOkProv.license?.commercial_use === "unknown" && dlLicOkProv.license_policy?.source === `file:${dlPolicyAllowCc0}` && JSON.stringify(dlLicOkProv.license_policy?.allow) === JSON.stringify(["CC0"]) && dlLicOkProv.license_policy?.decision === "allowed", "provenance records the declared CC0 license + the policy verdict (commercial_use stays unknown — the declaration is unverified)", JSON.stringify(dlLicOkProv.license_policy));
const dlLicReqText = await callExpectThrow("download", { url: `${dlBase}/counted.mp4`, output: path.join(root, "outputs/mcp-download-lic-req.mp4"), license_policy_file: dlPolicyRequire });
checkOk(/LICENSE_DENIED/.test(dlLicReqText ?? "") && /requires one/.test(dlLicReqText ?? "") && dlHits.counted === 1 && !existsSync(path.join(root, "outputs/mcp-download-lic-req.mp4")), "license gate: require_license refuses a download with no declared license, still 1 server hit", dlLicReqText ?? "");
const dlLicArrText = await callExpectThrow("download", { url: `${dlBase}/counted.mp4`, output: path.join(root, "outputs/mcp-download-lic-arr.mp4"), license: "all rights reserved", license_policy_file: dlPolicyDenyArr });
checkOk(/LICENSE_DENIED/.test(dlLicArrText ?? "") && /deny list/.test(dlLicArrText ?? "") && dlHits.counted === 1, "license gate: 'all rights reserved' canonicalizes into the deny list", dlLicArrText ?? "");
const dlLicFreeRes = await client.callTool({ name: "download", arguments: { url: `${dlBase}/counted.mp4`, output: path.join(root, "outputs/mcp-download-lic-free.mp4"), license: "CC-BY" } });
const dlLicFree = JSON.parse(dlLicFreeRes.content[0].text);
checkOk(dlLicFree.license?.label === "CC-BY" && dlLicFree.license?.policy_source === "default" && dlHits.counted === 2, "without a policy file the gate is off: CC-BY downloads and is only recorded", JSON.stringify(dlLicFree.license));
const dlLicFreeProv = JSON.parse(await readFile(path.join(root, "outputs/mcp-download-lic-free.mp4.provenance.json"), "utf8"));
checkOk(dlLicFreeProv.license?.label === "CC-BY" && dlLicFreeProv.license_policy?.source === "default", "provenance without a policy records CC-BY + policy source default", JSON.stringify(dlLicFreeProv.license_policy));
// The gate runs before the cache: a cached URL under a denying
// policy is refused, not served from disk.
const dlCacheableBefore = dlHits.cacheable;
const dlLicCacheText = await callExpectThrow("download", { url: `${dlBase}/cacheable.mp4`, output: path.join(root, "outputs/mcp-download-lic-cache.mp4"), cache: true, cache_dir: dlCacheDir, license: "CC-BY", license_policy_file: dlPolicyAllowCc0 });
checkOk(/LICENSE_DENIED/.test(dlLicCacheText ?? "") && dlHits.cacheable === dlCacheableBefore && !existsSync(path.join(root, "outputs/mcp-download-lic-cache.mp4")), "license gate precedes the cache: a cached URL under a denying policy is refused (cacheable hit count unchanged)", dlLicCacheText ?? "");
// A broken policy file fails the call, never fails open.
const dlLicBadText = await callExpectThrow("download", { url: `${dlBase}/counted.mp4`, output: path.join(root, "outputs/mcp-download-lic-bad.mp4"), license_policy_file: dlPolicyBad });
checkOk(/LICENSE_POLICY_ERROR/.test(dlLicBadText ?? "") && dlHits.counted === 2, "a malformed policy file fails with LICENSE_POLICY_ERROR before any fetch", dlLicBadText ?? "");
// doctor reports the policy state (off here — the server child has
// no MEDIAKIT_LICENSE_POLICY env).
checkOk(dlDoctor.license_policy?.set === false && dlDoctor.license_policy?.require_license === false, "doctor reports license_policy set=false when no policy file is configured", JSON.stringify(dlDoctor.license_policy));
// CLI: env policy + --license, and the env path in general.
const dlCliLicDeny = await runCliExpectError(["download", `${dlBase}/counted.mp4`, "-o", path.join(root, "outputs/mcp-download-cli-lic-deny.mp4"), "--license", "CC-BY"], { MEDIAKIT_LICENSE_POLICY: dlPolicyAllowCc0 });
checkOk(/LICENSE_DENIED/.test(dlCliLicDeny ?? "") && dlHits.counted === 2 && !existsSync(path.join(root, "outputs/mcp-download-cli-lic-deny.mp4")), "CLI: MEDIAKIT_LICENSE_POLICY env + --license CC-BY is refused before any fetch", dlCliLicDeny ?? "");
const dlCliLicOk = await runCliJson(["download", `${dlBase}/counted.mp4`, "-o", path.join(root, "outputs/mcp-download-cli-lic-ok.mp4"), "--license", "CC0"], { MEDIAKIT_LICENSE_POLICY: dlPolicyAllowCc0 });
checkOk(dlCliLicOk.license?.label === "CC0" && dlHits.counted === 3, "CLI: --license CC0 passes the env policy", JSON.stringify(dlCliLicOk.license));
// Manifest: the download step takes license, and the previously
// rejected cache:true now passes lint (lượt 90 fix — run() already
// read it, the args list just didn't allow it).
const dlManLicPath = path.join(root, "outputs/mcp-manifest-download-license.json");
await writeFile(dlManLicPath, JSON.stringify({
  version: 1, output: "mcp-manifest-download-license.mp4",
  steps: [{ tool: "download", args: { url: `${dlBase}/counted.mp4`, license: "CC0", cache: true } }],
}, null, 2));
const dlManLicRes = await client.callTool({ name: "manifest", arguments: { manifest_path: dlManLicPath } });
const dlManLic = JSON.parse(dlManLicRes.content[0].text);
checkOk(dlManLic.steps_run === 1 && dlManLic.final?.duration_seconds === 10 && dlHits.counted === 4, "manifest download step accepts license + cache:true (previously rejected at lint) and fetches once", JSON.stringify({ steps_run: dlManLic.steps_run, hits: dlHits.counted }));
downloadServer.closeAllConnections();
downloadServer.close();

// AAC 192k pin (turn 54): every tool that re-encodes AAC must carry
// -b:a 192k — ffmpeg's low default let true peak overshoot (+1.37
// dBTP on the turn-53 report video). Verified on
// test/rich-source.mp4 (pink noise + tones, silence gaps at
// [2,4)/[6,7)): the native AAC encoder is ABR, so a tone fixture
// undershoots any target and proves nothing — on this rich fixture
// the default encodes at 61.6k while -b:a 192k measures 139.2k
// (gaps pull the file average down; all-rich cuts land ~192k).
// The band 110k–210k separates the pin from the default (61.6k)
// with margin on both sides.
// (chroma_key transparent has no audio track to pin — greenscreen
// has no audio stream; its composite mode copies audio.)
async function audioBitrate(file) {
  const r = await client.callTool({ name: "probe", arguments: { input: file } });
  return JSON.parse(r.content[0].text).audio?.bit_rate ?? null;
}
async function checkBitrate(label, toolName, args, outFile) {
  const res = await client.callTool({ name: toolName, arguments: args });
  checkOk(res.isError !== true, `${label} runs for the bitrate check`, res.content?.[0]?.text?.slice(0, 200) ?? "");
  const br = await audioBitrate(outFile);
  checkOk(br !== null && br > 110000 && br < 210000, `${label} re-encodes AAC in the 110k-210k band (default would be ~62k; measured ${br})`, `file=${outFile} bit_rate=${br}`);
}
const richSrc = path.join(root, "test/rich-source.mp4");
await checkBitrate("fit speed", "fit", { input: richSrc, output: path.join(root, "outputs/mcp-bitrate-fit.mp4"), duration: 5, method: "speed" }, path.join(root, "outputs/mcp-bitrate-fit.mp4"));
await checkBitrate("silence re-encode", "silence", { input: richSrc, output: path.join(root, "outputs/mcp-bitrate-silence.mp4") }, path.join(root, "outputs/mcp-bitrate-silence.mp4"));
await checkBitrate("reverse", "reverse", { input: richSrc, output: path.join(root, "outputs/mcp-bitrate-reverse.mp4") }, path.join(root, "outputs/mcp-bitrate-reverse.mp4"));
await checkBitrate("concat fade", "concat", { inputs: [richSrc, richSrc], output: path.join(root, "outputs/mcp-bitrate-concat.mp4"), transition: "fade", transition_duration: 1 }, path.join(root, "outputs/mcp-bitrate-concat.mp4"));
await checkBitrate("cut_words", "cut_words", { input: richSrc, output: path.join(root, "outputs/mcp-bitrate-cutwords.mp4"), words_file: path.join(root, "test/cut-words.json"), remove: "um,uh" }, path.join(root, "outputs/mcp-bitrate-cutwords.mp4"));
await checkBitrate("extract_audio", "extract_audio", { input: richSrc, output: path.join(root, "outputs/mcp-bitrate-extract.m4a") }, path.join(root, "outputs/mcp-bitrate-extract.m4a"));
await checkBitrate("convert", "convert", { input: richSrc, output: path.join(root, "outputs/mcp-bitrate-convert.mp4"), video_codec: "libx264", audio_codec: "aac" }, path.join(root, "outputs/mcp-bitrate-convert.mp4"));
await checkBitrate("pip mix", "pip", { input: richSrc, pip: path.join(root, "test/source2.mp4"), output: path.join(root, "outputs/mcp-bitrate-pip.mp4"), audio: "mix" }, path.join(root, "outputs/mcp-bitrate-pip.mp4"));

// HTTP mode (turn 53): the same 81 tools over REST + JSON-RPC on an
// ephemeral loopback port — no network, no real server process. The
// probe call goes through the HTTP dispatch, not the stdio client,
// so a divergence between the two transports fails here.
const httpServer = createHttpServer();
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const httpBase = `http://127.0.0.1:${httpServer.address().port}`;
const httpCall = async (method, p, body) => {
  const res = await fetch(`${httpBase}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
};
const httpMeta = await httpCall("GET", "/mcp");
// SSE job events (turn 56): read a text/event-stream to completion,
// parsing `event: <name>` + `data: <json>` frames; `: ...` comment
// lines (heartbeats) are ignored. Returns the frames in order, plus
// whether the guard timeout fired instead of a clean stream end.
async function readSse(url, { maxMs = 120000 } = {}) {
  const res = await fetch(url);
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status !== 200 || !/text\/event-stream/.test(contentType)) {
    return { status: res.status, contentType, events: [], timedOut: false, text: await res.text() };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + maxMs;
  const events = [];
  let buffer = "";
  let timedOut = false;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { timedOut = true; try { await reader.cancel(); } catch {} break; }
    const got = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ timeout: true }), remaining)),
    ]);
    if (got.timeout) { timedOut = true; try { await reader.cancel(); } catch {} break; }
    if (got.done) break;
    buffer += decoder.decode(got.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let name = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) events.push({ event: name, data: JSON.parse(data) });
    }
  }
  return { status: res.status, contentType, events, timedOut };
}
checkOk(httpMeta.status === 200 && httpMeta.json?.name === "mediakit-for-agents" && httpMeta.json?.version === "0.1.0" && httpMeta.json?.transport === "http" && httpMeta.json?.tools === 81, "GET /mcp reports name/version/transport and 81 tools", JSON.stringify(httpMeta.json));
const httpRoot = await httpCall("GET", "/");
checkOk(httpRoot.status === 200 && httpRoot.json?.name === "mediakit-for-agents", "GET / returns the same metadata as GET /mcp", JSON.stringify(httpRoot.json));
const httpTools = await httpCall("GET", "/mcp/tools");
checkOk(httpTools.status === 200 && httpTools.json?.tools?.length === 81 && httpTools.json.tools.every((t) => t.inputSchema?.type === "object" && typeof t.description === "string"), "GET /mcp/tools lists 81 tools, each with a JSON inputSchema object", `count=${httpTools.json?.tools?.length}`);
const httpProbeSchema = httpTools.json?.tools?.find((t) => t.name === "probe");
checkOk(httpProbeSchema?.inputSchema?.properties?.input?.type === "string" && (httpProbeSchema.inputSchema.required ?? []).includes("input"), "probe's HTTP inputSchema requires a string input (zod -> JSON schema conversion is faithful)", JSON.stringify(httpProbeSchema?.inputSchema).slice(0, 200));
const httpProbe = await httpCall("POST", "/mcp/tools/probe/invoke", { arguments: { input: path.join(root, "test/source.mp4") } });
checkOk(httpProbe.status === 200 && near(httpProbe.json?.duration_seconds, 10, 0.1) && httpProbe.json?.video?.width === 1280, "POST /mcp/tools/probe/invoke probes test/source.mp4 through HTTP: 10s, 1280 wide", JSON.stringify(httpProbe.json).slice(0, 200));
// The HTTP transport records into the same audit log as stdio/CLI:
// the probe above is already in the log by the time this reads it
// (its record is fire-and-forget, but the probe's own encode-free
// record lands in milliseconds; the assertion only needs entries).
const httpAudit = await httpCall("POST", "/mcp/tools/audit/invoke", { arguments: { limit: 5 } });
checkOk(httpAudit.status === 200 && httpAudit.json?.total >= 1 && Array.isArray(httpAudit.json?.entries) && httpAudit.json.entries.length > 0 && httpAudit.json.audit_path === auditPath, "POST /mcp/tools/audit/invoke reads the same audit log over HTTP", `total=${httpAudit.json?.total}`);
const httpUnknown = await httpCall("POST", "/mcp/tools/nope/invoke", { arguments: {} });
checkOk(httpUnknown.status === 404 && /unknown tool/.test(httpUnknown.json?.error ?? ""), "POST invoke of an unknown tool is a 404, not a 500", JSON.stringify(httpUnknown.json));
const httpBadArgs = await httpCall("POST", "/mcp/tools/probe/invoke", { arguments: {} });
checkOk(httpBadArgs.status === 400 && httpBadArgs.json?.code === "INVALID_ARG" && httpBadArgs.json?.retry?.tool === "probe", "POST invoke with missing required args is a 400 with code INVALID_ARG and a retry", JSON.stringify(httpBadArgs.json));
const httpWrongType = await httpCall("POST", "/mcp/tools/probe/invoke", { arguments: { input: 123 } });
checkOk(httpWrongType.status === 400 && httpWrongType.json?.code === "INVALID_ARG", "POST invoke with a wrong-typed arg is a 400 (zod validates on the HTTP path too)", JSON.stringify(httpWrongType.json));
// Lượt 122: estimate_remaining on the read paths. A fake running
// job record is written straight into the hermetic jobs dir (the
// record a worker would have written): 50% done, history 10% ->
// 50% over 40s, so the progress-rate estimate is ceil(50/1) = 50s.
// MCP status, HTTP status and the HTTP list row must all carry it;
// cancelling the fake job then proves the terminal shape (null /
// "terminal") and leaves no active job behind for later assertions.
const estJobId = "job-20261120-165800-abcdef01";
const estJobsDir = process.env.MEDIAKIT_JOBS_DIR;
const estLiveNow = Date.now();
const estLiveCreated = new Date(estLiveNow - 120_000).toISOString();
await mkdir(path.join(estJobsDir, estJobId), { recursive: true });
await writeFile(path.join(estJobsDir, estJobId, "job.json"), JSON.stringify({
  job_id: estJobId, operation: "assemble", status: "running",
  manifest: "fake", output_dir: "fake", mode: "render", force: true,
  approval: "forced", title: "estimate fixture", total_seconds: 10, total_frames: 300,
  pid: null, progress: { stage: "shots", percent: 50, detail: null },
  progress_history: [
    { at: estLiveCreated, stage: "shots", percent: 10 },
    { at: new Date(estLiveNow - 80_000).toISOString(), stage: "shots", percent: 50 },
  ],
  created_at: estLiveCreated, updated_at: new Date().toISOString(), result: null, error: null,
}, null, 2));
const estStatusRes = await client.callTool({ name: "job", arguments: { job_id: estJobId, action: "status" } });
const estStatusJson = JSON.parse(estStatusRes.content[0].text);
checkOk(estStatusJson.estimate_remaining_seconds === 50 && estStatusJson.estimate_basis === "progress-rate" && estStatusJson.progress_history?.length === 2, "job status carries estimate_remaining_seconds 50 + progress-rate from the percent history", JSON.stringify({ estimate_remaining_seconds: estStatusJson.estimate_remaining_seconds, estimate_basis: estStatusJson.estimate_basis }));
const estHttp = await httpCall("GET", `/mcp/jobs/${estJobId}`);
checkOk(estHttp.status === 200 && estHttp.json?.estimate_remaining_seconds === 50 && estHttp.json?.estimate_basis === "progress-rate", "GET /mcp/jobs/<id> carries the same estimate", JSON.stringify({ estimate_remaining_seconds: estHttp.json?.estimate_remaining_seconds, estimate_basis: estHttp.json?.estimate_basis }));
const estList = await httpCall("GET", "/mcp/jobs?limit=200");
const estRow = estList.json?.jobs?.find((j) => j.job_id === estJobId);
checkOk(estRow?.estimate_remaining_seconds === 50 && estRow?.estimate_basis === "progress-rate" && !("progress_history" in estRow), "GET /mcp/jobs list row carries the estimate but still omits progress_history", JSON.stringify({ estimate_remaining_seconds: estRow?.estimate_remaining_seconds, estimate_basis: estRow?.estimate_basis }));
const estCancelRes = await client.callTool({ name: "job", arguments: { job_id: estJobId, action: "cancel" } });
const estCancelJson = JSON.parse(estCancelRes.content[0].text);
checkOk(estCancelJson.status === "cancelled" && estCancelJson.estimate_remaining_seconds === null && estCancelJson.estimate_basis === "terminal", "cancelling a job returns the terminal estimate shape (null / terminal)", JSON.stringify({ estimate_remaining_seconds: estCancelJson.estimate_remaining_seconds, estimate_basis: estCancelJson.estimate_basis }));
// The HTTP error body carries the same retry guidance as stdio:
// a 429 download names retryable=true + the server's Retry-After.
// (The download fixture server is already closed by this point in
// the file, so this check gets its own tiny 429 server — pointing
// it at the closed fixture port would only prove a refused
// connection, which is retryable but names no wait.)
const httpA429Server = createServer((req, res) => { res.writeHead(429, { "retry-after": "7" }); res.end(); });
await new Promise((r) => httpA429Server.listen(0, "127.0.0.1", r));
const httpA429Base = `http://127.0.0.1:${httpA429Server.address().port}`;
const httpA429 = await httpCall("POST", "/mcp/tools/download/invoke", { arguments: { url: `${httpA429Base}/always-429`, output: path.join(root, "outputs/mcp-download-a429-http.mp4"), max_retries: 0 } });
httpA429Server.closeAllConnections();
httpA429Server.close();
checkOk(httpA429.status === 500 && httpA429.json?.code === "DOWNLOAD_FAILED" && httpA429.json?.retryable === true && httpA429.json?.retry_after_seconds === 7 && httpA429.json?.retry?.tool === "download", "POST download/invoke on a 429 returns retryable=true + retry_after_seconds=7 in the HTTP error body", JSON.stringify(httpA429.json));
const httpGetInvoke = await httpCall("GET", "/mcp/tools/probe/invoke");
checkOk(httpGetInvoke.status === 405, "GET on an invoke endpoint is a 405 (invoke is POST-only)", `status=${httpGetInvoke.status}`);
const httpRpcInit = await httpCall("POST", "/", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
checkOk(httpRpcInit.status === 200 && typeof httpRpcInit.json?.result?.protocolVersion === "string" && httpRpcInit.json?.result?.serverInfo?.name === "mediakit-for-agents", "JSON-RPC initialize returns a protocol version and server info", JSON.stringify(httpRpcInit.json?.result));
const httpRpcPing = await httpCall("POST", "/", { jsonrpc: "2.0", id: 2, method: "ping" });
checkOk(httpRpcPing.status === 200 && JSON.stringify(httpRpcPing.json?.result) === "{}", "JSON-RPC ping returns an empty result", JSON.stringify(httpRpcPing.json));
const httpRpcList = await httpCall("POST", "/", { jsonrpc: "2.0", id: 3, method: "tools/list" });
checkOk(httpRpcList.status === 200 && httpRpcList.json?.result?.tools?.length === 81, "JSON-RPC tools/list returns the same 81 tools as stdio", `count=${httpRpcList.json?.result?.tools?.length}`);
const httpRpcCall = await httpCall("POST", "/", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "probe", arguments: { input: path.join(root, "test/source.mp4") } } });
const httpRpcCallBody = JSON.parse(httpRpcCall.json?.result?.content?.[0]?.text ?? "{}");
checkOk(httpRpcCall.status === 200 && near(httpRpcCallBody.duration_seconds, 10, 0.1) && httpRpcCallBody.video?.width === 1280, "JSON-RPC tools/call probe returns the same 10s/1280 result as stdio", JSON.stringify(httpRpcCallBody).slice(0, 200));
const httpRpcUnknownTool = await httpCall("POST", "/", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
checkOk(httpRpcUnknownTool.json?.error?.code === -32602, "JSON-RPC tools/call of an unknown tool fails -32602", JSON.stringify(httpRpcUnknownTool.json?.error));
const httpRpcUnknownMethod = await httpCall("POST", "/", { jsonrpc: "2.0", id: 6, method: "resources/list" });
checkOk(httpRpcUnknownMethod.json?.error?.code === -32601, "JSON-RPC unknown method fails -32601", JSON.stringify(httpRpcUnknownMethod.json?.error));
const httpRpcBadJson = await httpCall("POST", "/", "{not json");
checkOk(httpRpcBadJson.json?.error?.code === -32700, "JSON-RPC malformed JSON fails -32700 (parse error)", JSON.stringify(httpRpcBadJson.json?.error));
const httpRpcNotif = await httpCall("POST", "/", { jsonrpc: "2.0", method: "notifications/initialized" });
checkOk(httpRpcNotif.status === 204, "a JSON-RPC notification (no id) gets a 204 with no body", `status=${httpRpcNotif.status}`);
const httpRpcToolError = await httpCall("POST", "/", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "probe", arguments: {} } });
const httpRpcToolErrorBody = JSON.parse(httpRpcToolError.json?.result?.content?.[0]?.text ?? "{}");
checkOk(httpRpcToolError.json?.result?.isError === true && httpRpcToolErrorBody.code === "INVALID_ARG" && httpRpcToolErrorBody.retry?.tool === "probe", "JSON-RPC tools/call of a tool that fails reports isError with the retry attached (same as stdio)", JSON.stringify(httpRpcToolErrorBody).slice(0, 200));
const http404 = await httpCall("GET", "/nope");
checkOk(http404.status === 404, "an unknown path is a 404", `status=${http404.status}`);
// HTTP job endpoints (turn 54): the same durable job store as the
// `job` tool, over REST — poll GET /mcp/jobs/{id} for stage/percent.
// The stdio async test above already left one done job (asyncJobId)
// in this suite's hermetic jobs dir, so the list must contain it.
const httpJobs = await httpCall("GET", "/mcp/jobs");
checkOk(httpJobs.status === 200 && Array.isArray(httpJobs.json?.jobs) && typeof httpJobs.json?.jobs_root === "string" && httpJobs.json.jobs.some((j) => j.job_id === asyncJobId && j.status === "done"), "GET /mcp/jobs lists jobs newest-first and contains the stdio async job as done", `count=${httpJobs.json?.count}`);
const httpJobsLimit = await httpCall("GET", "/mcp/jobs?limit=1");
checkOk(httpJobsLimit.status === 200 && httpJobsLimit.json?.jobs?.length === 1, "GET /mcp/jobs?limit=1 returns exactly one job", `count=${httpJobsLimit.json?.jobs?.length}`);
const httpJobOne = await httpCall("GET", `/mcp/jobs/${asyncJobId}`);
checkOk(httpJobOne.status === 200 && httpJobOne.json?.job_id === asyncJobId && httpJobOne.json?.status === "done" && httpJobOne.json?.progress?.percent === 100, "GET /mcp/jobs/{id} returns the job with status done and progress 100%", JSON.stringify(httpJobOne.json?.progress));
const httpJobUnknown = await httpCall("GET", "/mcp/jobs/job-20000101-000000-deadbeef");
checkOk(httpJobUnknown.status === 404 && httpJobUnknown.json?.code === "JOB_NOT_FOUND", "GET /mcp/jobs/{unknown} is a 404 JOB_NOT_FOUND", JSON.stringify(httpJobUnknown.json));
const httpJobCancelDone = await httpCall("POST", `/mcp/jobs/${asyncJobId}/cancel`);
checkOk(httpJobCancelDone.status === 400, "POST /mcp/jobs/{done}/cancel is a 400 (terminal job)", `status=${httpJobCancelDone.status} ${JSON.stringify(httpJobCancelDone.json).slice(0, 150)}`);
const httpJobCancelGet = await httpCall("GET", `/mcp/jobs/${asyncJobId}/cancel`);
checkOk(httpJobCancelGet.status === 405, "GET on a cancel endpoint is a 405 (cancel is POST-only)", `status=${httpJobCancelGet.status}`);
// Dogfood: start an async assemble render over HTTP and poll the new
// endpoint until it finishes — the render itself runs in the worker,
// the polling here only reads the job record.
const httpAsyncStart = await httpCall("POST", "/mcp/tools/assemble/invoke", { arguments: { manifest_path: assembleAsyncStage.manifestPath, mode: "render", output_dir: assembleAsyncOut, force: true, async: true } });
const httpAsyncJobId = httpAsyncStart.json?.job_id;
checkOk(httpAsyncStart.status === 200 && typeof httpAsyncJobId === "string" && /^job-\d{8}-\d{6}-[0-9a-f]{8}$/.test(httpAsyncJobId), "POST assemble/invoke async:true over HTTP returns a job_id", `job_id=${httpAsyncJobId}`);
let httpAsyncJob = null;
for (let i = 0; i < 150; i++) {
  const r = await httpCall("GET", `/mcp/jobs/${httpAsyncJobId}`);
  httpAsyncJob = r.json;
  if (httpAsyncJob?.status === "done" || httpAsyncJob?.status === "failed") break;
  await new Promise((r2) => setTimeout(r2, 2000));
}
checkOk(httpAsyncJob?.status === "done" && httpAsyncJob?.progress?.percent === 100 && near(httpAsyncJob?.result?.duration_seconds, 4, 0.15), "HTTP-polled async job reaches done with progress 100% and a 4s result", `status=${httpAsyncJob?.status} progress=${JSON.stringify(httpAsyncJob?.progress)}`);
// SSE job events (turn 56): the same job store, pushed instead of
// polled. An unknown id fails as JSON 404 before any SSE header;
// a done job sends one `job` event and closes; a live job pushes
// progress as the worker writes it; ?timeout_s ends the stream.
const httpEventsUnknown = await httpCall("GET", "/mcp/jobs/job-20000101-000000-deadbeef/events");
checkOk(httpEventsUnknown.status === 404 && httpEventsUnknown.json?.code === "JOB_NOT_FOUND", "GET /mcp/jobs/{unknown}/events is a 404 JOB_NOT_FOUND (JSON, before any SSE header)", JSON.stringify(httpEventsUnknown.json));
const httpEventsPost = await httpCall("POST", `/mcp/jobs/${asyncJobId}/events`, {});
checkOk(httpEventsPost.status === 405, "POST on an events endpoint is a 405 (events are GET-only)", `status=${httpEventsPost.status}`);
const httpEventsDone = await readSse(`${httpBase}/mcp/jobs/${asyncJobId}/events`);
checkOk(httpEventsDone.status === 200 && /text\/event-stream/.test(httpEventsDone.contentType) && httpEventsDone.events.length === 1 && httpEventsDone.events[0].event === "job" && httpEventsDone.events[0].data?.status === "done" && httpEventsDone.events[0].data?.progress?.percent === 100 && !httpEventsDone.timedOut, "SSE on a done job sends exactly one `job` event (status done, 100%) and closes", `events=${httpEventsDone.events.length} timedOut=${httpEventsDone.timedOut}`);
const sseOut = path.join(root, "outputs/mcp-assemble-async-sse");
const sseStart = await httpCall("POST", "/mcp/tools/assemble/invoke", { arguments: { manifest_path: assembleAsyncStage.manifestPath, mode: "render", output_dir: sseOut, force: true, async: true } });
const sseJobId = sseStart.json?.job_id;
checkOk(typeof sseJobId === "string" && /^job-\d{8}-\d{6}-[0-9a-f]{8}$/.test(sseJobId), "second HTTP async assemble returns a job_id for the live SSE test", `job_id=${sseJobId}`);
const sseLive = await readSse(`${httpBase}/mcp/jobs/${sseJobId}/events`, { maxMs: 180000 });
const ssePercents = sseLive.events.filter((e) => e.event === "job").map((e) => e.data?.progress?.percent ?? -1);
const sseFinal = sseLive.events.filter((e) => e.event === "job").at(-1)?.data;
checkOk(!sseLive.timedOut && sseLive.events.length >= 2 && sseFinal?.status === "done" && sseFinal?.progress?.percent === 100 && new Set(ssePercents).size >= 2 && sseLive.events.every((e) => e.event !== "timeout"), "SSE on a live job pushes progress as it moves (>=2 distinct percents) and ends with done/100% (no timeout event: a missing ?timeout_s= must default to 600s, not 1s)", `events=${sseLive.events.length} percents=${[...new Set(ssePercents)].join(",")}`);
const sseTimeoutOut = path.join(root, "outputs/mcp-assemble-async-sse-timeout");
const sseTimeoutStart = await httpCall("POST", "/mcp/tools/assemble/invoke", { arguments: { manifest_path: assembleAsyncStage.manifestPath, mode: "render", output_dir: sseTimeoutOut, force: true, async: true } });
const sseTimeoutJobId = sseTimeoutStart.json?.job_id;
const sseTimeout = await readSse(`${httpBase}/mcp/jobs/${sseTimeoutJobId}/events?timeout_s=1`, { maxMs: 30000 });
const sseTimeoutLast = sseTimeout.events.at(-1);
checkOk(!sseTimeout.timedOut && sseTimeout.events.length >= 1 && sseTimeout.events[0]?.event === "job" && sseTimeoutLast?.event === "timeout", "SSE ?timeout_s=1 ends the stream with an `event: timeout` after ~1s (job still rendering)", `events=${sseTimeout.events.length} last=${sseTimeoutLast?.event}`);
// Tidy up: the timeout test's render is still running in its worker;
// cancel it so no stray ffmpeg keeps working after the suite ends.
await httpCall("POST", `/mcp/jobs/${sseTimeoutJobId}/cancel`);
const httpMetaJobs = await httpCall("GET", "/mcp");
checkOk(httpMetaJobs.json?.endpoints?.jobs === "GET /mcp/jobs" && httpMetaJobs.json?.endpoints?.job === "GET /mcp/jobs/{id}" && httpMetaJobs.json?.endpoints?.jobEvents === "GET /mcp/jobs/{id}/events" && httpMetaJobs.json?.endpoints?.jobCancel === "POST /mcp/jobs/{id}/cancel", "GET /mcp metadata advertises the job endpoints", JSON.stringify(httpMetaJobs.json?.endpoints));
const httpSecond = createHttpServer();
const httpSecondErr = await new Promise((resolve) => {
  httpSecond.on("error", resolve);
  httpSecond.listen(httpServer.address().port, "127.0.0.1", () => resolve(null));
});
checkOk(httpSecondErr?.code === "EADDRINUSE", "a second server on the same port fails with EADDRINUSE instead of silently sharing it", `code=${httpSecondErr?.code}`);
httpServer.closeAllConnections();
httpServer.close();

await client.close();
if (failures.length) {
  console.error(`\nMCP test FAILED: ${failures.length} assertion(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("MCP test done — all assertions passed");
process.exit(0);
