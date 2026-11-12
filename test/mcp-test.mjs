// MCP stdio test: initialize, tools/list, call every tool, and ASSERT
// the results against values measured from the fixtures — a tool that
// runs without crashing is not a pass; the output has to be right.
// Run: node test/mcp-test.mjs (exit 1 if any assertion fails, so CI
// goes red instead of silently green).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixForMissing } from "../src/core.js";

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
const expected = ["probe", "trim", "crop", "resize", "extract_audio", "extract_frame", "thumbnail", "loudness", "concat", "burn_captions", "convert", "reframe", "check", "silence", "doctor", "cropdetect", "package", "mix", "frames", "overlay", "scenes", "keyframes", "fit", "pip", "titlecard", "intro", "social", "convert_captions", "generate_srt", "find", "svg_animate", "compress", "receipt", "mux", "export_gif", "transcribe", "grade"];
const missing = expected.filter((n) => !names.includes(n));
console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "all 37 tools present");
checkOk(missing.length === 0, "tools/list has all 37 tools", `missing: ${missing.join(", ")}`);

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

const gradeBadPreset = await callExpectThrow("grade", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-bad.mp4"), preset: "neon" });
checkOk(/preset|Invalid enum/i.test(gradeBadPreset), "grade rejects an unknown preset", gradeBadPreset.slice(0, 200));
const gradeBoth = await callExpectThrow("grade", { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-grade-both.mp4"), preset: "warm", filter: "eq=saturation=0" });
checkOk(/mutually exclusive/.test(gradeBoth), "grade refuses preset + filter together", gradeBoth.slice(0, 200));
const gradeAudioOnly = await callExpectThrow("grade", { input: path.join(root, "test/mix-voice.mp3"), output: path.join(root, "outputs/mcp-grade-audio.mp4"), preset: "warm" });
checkOk(/needs a video input/.test(gradeAudioOnly), "grade refuses an audio-only input", gradeAudioOnly.slice(0, 200));

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
checkOk(doctorAsr && typeof doctorAsr.available === "boolean" && doctorAsr.engine === "faster-whisper", "doctor: transcribe reports an engine status");
if (process.env.MEDIAKIT_TEST_ASR === "1") {
  checkOk(doctorAsr.available === true && doctorAsr.python === process.env.MEDIAKIT_ASR_PYTHON, "doctor: transcribe available with faster-whisper when the engine is installed", JSON.stringify(doctorAsr));
} else {
  checkOk(doctorAsr.available === false && /faster-whisper/.test(doctorAsr.fix ?? "") && /MEDIAKIT_ASR_PYTHON/.test(doctorAsr.fix ?? ""), "doctor: transcribe unavailable without an engine, with install hint", JSON.stringify(doctorAsr));
}
checkOk(doctorJson.tools.fit?.available === true, "doctor: fit is available");
checkOk(doctorJson.tools.generate_srt?.available === true, "doctor: generate_srt is available (pure Node, no ffmpeg filter needed)");
checkOk(doctorJson.tools.export_gif?.available === true, "doctor: export_gif is available (palettegen/paletteuse present)");
checkOk(doctorJson.tools.grade?.available === true, "doctor: grade is available (eq/hue/colorbalance present)");
checkOk(doctorJson.tools.check?.available === true, "doctor: check is available (astats/ametadata present for the peaks scan)");
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
});
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
checkOk(near(compressTJson.duration_seconds, 10, 0.1) && compressTJson.dimensions === "1280x720", "compress target-size keeps 10s and 1280x720", JSON.stringify(compressTJson));
checkOk(compressTJson.video_bitrate_kbps === 656 && compressTJson.audio_bitrate_kbps === 128, "compress target-size budgets 656k video + 128k audio for 1MB/10s", JSON.stringify(compressTJson));
// Tighter target still met.
const compressT05Res = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-target05.mp4"), target_size_mb: 0.5 },
});
const compressT05Json = JSON.parse(compressT05Res.content[0].text);
checkOk(compressT05Json.target_met === true && compressT05Json.size_after_bytes <= 500000, "compress target-size 0.5MB lands under the target", `got ${compressT05Json.size_after_bytes} bytes`);
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
checkOk(/too small/.test(compressTinyText) && /0\.29/.test(compressTinyText), "compress target-size 0.1MB is refused with the minimum size", compressTinyText.slice(0, 200));
// target-size + crf: mutually exclusive, not silently ignored.
const compressConflictRes = await client.callTool({
  name: "compress",
  arguments: { input: path.join(root, "test/source.mp4"), output: path.join(root, "outputs/mcp-compress-conflict.mp4"), target_size_mb: 1, crf: 28 },
});
const compressConflictText = compressConflictRes.content?.[0]?.text ?? "";
checkOk(/mutually exclusive/.test(compressConflictText), "compress target-size + crf is rejected as mutually exclusive", compressConflictText.slice(0, 200));

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

// transcribe: validation errors need no engine (checked before the
// ASR engine is probed). The no-engine path is tested through a second
// server with MEDIAKIT_ASR_PYTHON pointed at a python that cannot
// exist, so the result is deterministic on any machine.
const trBadModelErr = await callExpectThrow("transcribe", { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk-badmodel.srt"), model: "huge" });
checkOk(/huge/.test(trBadModelErr ?? ""), "transcribe refuses an unknown model (zod enum)", trBadModelErr ?? "");
const trBadExtRes = await client.callTool({
  name: "transcribe",
  arguments: { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk.txt") },
});
const trBadExtJson = JSON.parse(trBadExtRes.content[0].text);
checkOk(trBadExtRes.isError === true && /\.srt/.test(trBadExtJson.error ?? ""), "transcribe refuses a non-.srt output", JSON.stringify(trBadExtJson));
const trBadEngineErr = await callExpectThrow("transcribe", { input: path.join(root, "test/speech-jfk.flac"), output: path.join(root, "outputs/mcp-jfk.srt"), engine: "whisper" });
checkOk(/whisper/.test(trBadEngineErr ?? ""), "transcribe refuses the not-yet-implemented whisper.cpp engine (zod enum)", trBadEngineErr ?? "");
const noAsrTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
  env: { ...process.env, MEDIAKIT_ASR_PYTHON: "/nonexistent/python3" },
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

await client.close();
if (failures.length) {
  console.error(`\nMCP test FAILED: ${failures.length} assertion(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("MCP test done — all assertions passed");
