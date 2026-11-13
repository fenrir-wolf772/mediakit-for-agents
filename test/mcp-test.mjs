// MCP stdio test: initialize, tools/list, call every tool, and ASSERT
// the results against values measured from the fixtures — a tool that
// runs without crashing is not a pass; the output has to be right.
// Run: node test/mcp-test.mjs (exit 1 if any assertion fails, so CI
// goes red instead of silently green).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixForMissing, groupWords, SHORTS_STYLE_IDS } from "../src/core.js";

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
const expected = ["probe", "trim", "crop", "resize", "extract_audio", "extract_frame", "thumbnail", "loudness", "concat", "burn_captions", "convert", "reframe", "check", "silence", "doctor", "cropdetect", "package", "mix", "frames", "overlay", "scenes", "keyframes", "fit", "pip", "titlecard", "intro", "social", "convert_captions", "generate_srt", "find", "svg_animate", "compress", "receipt", "mux", "export_gif", "transcribe", "grade", "reverse", "batch", "interpolate", "denoise", "segment", "publish_kit", "qa_report", "manifest", "chroma_key", "zoom_pan", "image_to_video", "cut_words", "assemble", "slideshow"];
const missing = expected.filter((n) => !names.includes(n));
console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "all 51 tools present");
checkOk(missing.length === 0, "tools/list has all 51 tools", `missing: ${missing.join(", ")}`);

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
});
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
checkOk(doctorJson.tools.grade?.available === true, "doctor: grade is available (eq/hue/colorbalance/lutrgb present)");
checkOk(doctorJson.tools.check?.available === true, "doctor: check is available (astats/ametadata present for the peaks scan)");
checkOk(doctorJson.tools.reverse?.available === true, "doctor: reverse is available (reverse/areverse filters present)");
checkOk(doctorJson.tools.interpolate?.available === true, "doctor: interpolate is available (minterpolate filter present)");
checkOk(doctorJson.tools.denoise?.available === true, "doctor: denoise is available (hqdn3d/nlmeans filters present)");
checkOk(doctorJson.tools.segment?.available === true, "doctor: segment is available (HLS muxer is built-in)");
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

// mix --dry-run: plan mode must print the exact ffmpeg command
// (sidechaincompress + loudnorm, real measured voice gain) and write
// no file.
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
checkOk(Array.isArray(mixDryJson.commands) && mixDryJson.commands.length === 1 && mixDryJson.commands[0].includes("sidechaincompress") && mixDryJson.commands[0].includes("loudnorm"), "mix dry-run prints the exact ffmpeg command (sidechain + loudnorm)", JSON.stringify(mixDryJson.commands));
checkOk(typeof mixDryJson.voice_gain_db === "number" && mixDryJson.voice_gain_db !== 0, "mix dry-run computes a real voice gain from measurement", `got ${mixDryJson.voice_gain_db}`);
checkOk(existsSync(mixDryPath) === false, "mix dry-run writes no file", mixDryPath);

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
checkOk(findSourceJson.total_matches === 5, "find 'source' matches 5 files (source, source2, silence-source, scenes-source, quiet-source)", `got ${findSourceJson.total_matches}`);

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
const gifTightRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo-tight.gif"), max_size_mb: 0.5 },
});
const gifTightJson = JSON.parse(gifTightRes.content[0].text);
console.log("export_gif tight ladder:", JSON.stringify(gifTightJson.attempts));
checkOk(gifTightJson.size_budget_met === true && gifTightJson.size_bytes <= 500_000, "export_gif fits the 0.5 MB budget", JSON.stringify({ size: gifTightJson.size_bytes, attempts: gifTightJson.attempts_tried }));
checkOk(gifTightJson.attempts_tried >= 4 && gifTightJson.width === 320 && gifTightJson.fps === 8, "export_gif steps the ladder down (fps, then width) to meet a tight budget", JSON.stringify(gifTightJson.attempts));
checkOk(gifTightJson.attempts.every((a, i) => i === 0 || a.size_bytes <= gifTightJson.attempts[i - 1].size_bytes), "export_gif attempts shrink the file as the ladder steps down", JSON.stringify(gifTightJson.attempts.map((a) => a.size_bytes)));
// Impossible budget (0.02 MB): all 8 ladder steps, met=false, warning.
const gifImpossRes = await client.callTool({
  name: "export_gif",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-demo-imposs.gif"), max_size_mb: 0.02 },
});
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
checkOk(sbDoctor.code === 0 && sbDoctorJson?.sandbox?.enabled === true && sbDoctorJson?.sandbox?.workdir === sandboxDir, "sandbox: doctor reports enabled + the real workdir path", sbDoctor.out.slice(0, 200));
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
checkOk(infoJson.root === root && infoJson.tools_total === 51 && infoJson.tools_available >= 48 && typeof infoJson.ffmpeg_version === "string" && infoJson.media_files === listJson.total_files, "videos://workspace/info reports root, 51 tools, ffmpeg version, media count matching the list", JSON.stringify(infoJson).slice(0, 300));
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
checkOk(batchJson.results.every((r) => r.status === "ok" && r.result?.output_lufs === -16), "batch loudness reports -16 LUFS per file", JSON.stringify(batchJson.results.map((r) => r.result?.output_lufs)));
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

// qa_report + thumbnail timestamps (lượt 31; idea: github774/claude-video-studio
// contact_sheet + qa_report — run the gate, plus a contact sheet, on
// every deliverable before calling it done).
const qaOf = (j, name) => j.checks.find((c) => c.check === name);

// thumbnail timestamps: on by default. The sheet is 960x360 (6 tiles
// of 320px, 3 columns) and reports the nominal tile times. The labels
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
async function regionYmax(file, crop) {
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-i", file, "-vf", `crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YMAX`, "-frames:v", "1", "-f", "null", "-"]);
    const m = stderr.match(/lavfi\.signalstats\.YMAX=([0-9.]+)/);
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
checkOk(manRunJson.qa_result?.verdict === "warn" && qaOf(manRunJson.qa_result, "loudness")?.status === "pass" && qaOf(manRunJson.qa_result, "pacing")?.status === "warn", "manifest qa gate: warn on pacing only, loudness passes", JSON.stringify(manRunJson.qa_result?.checks.map((c) => `${c.check}:${c.status}`)));
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
  const dir = path.join(root, `outputs/mcp-assemble-stage-${process.pid}-${name.replace(/\.json$/, "")}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const doc = JSON.parse(await readFile(path.join(root, "test", name), "utf8"));
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(root, "test", p));
  if (doc.voice) doc.voice.path = abs(doc.voice.path);
  if (doc.music) doc.music.path = abs(doc.music.path);
  if (doc.sfx) doc.sfx = doc.sfx.map((s) => ({ ...s, file: abs(s.file) }));
  if (doc.captions) doc.captions = abs(doc.captions);
  if (doc.shots) doc.shots = doc.shots.map((s) => (s.source ? { ...s, source: abs(s.source) } : s));
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
const assembleRender2Res = await client.callTool({ name: "assemble", arguments: { manifest_path: assembleStage.manifestPath, mode: "render", output_dir: assembleOut } }, undefined, { timeout: 300000 });
const assembleRender2Json = JSON.parse(assembleRender2Res.content[0].text);
checkOk(assembleRender2Json.cache_hits === 4, "assemble second render reuses all 4 shot segments from the cache", `cache_hits=${assembleRender2Json.cache_hits}`);
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

await client.close();
if (failures.length) {
  console.error(`\nMCP test FAILED: ${failures.length} assertion(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("MCP test done — all assertions passed");
