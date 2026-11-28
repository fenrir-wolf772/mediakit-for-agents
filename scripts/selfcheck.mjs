// selfcheck.mjs — one-command end-to-end smoke for the whole director
// pipeline: doctor -> init_project -> diagnose -> plan -> preflight
// -> preview -> approve -> render -> verify -> verify-cuts -> check.
//
// doctor --smoke proves single tools can render; selfcheck proves the
// full lifecycle a real project walks (the CLAUDE.md lifecycle in a
// scaffolded project) produces a deliverable final.mp4 on this machine.
// Every step is measured on disk (probe duration/dims/frames/LUFS,
// verify receipt, platform check) — a step that cannot be measured
// fails instead of passing on trust.
//
// Usage:
//   node scripts/selfcheck.mjs [--dir <dir>] [--keep] [--json]
//   npm run selfcheck
// Exit 0 when every step passes, 1 otherwise. The work dir is a fresh
// mkdtemp under os.tmpdir() (or under MEDIAKIT_WORKDIR when the sandbox
// is on, so the check itself obeys the sandbox); it is removed on
// success unless --keep, and kept on failure so the broken state can
// be inspected — the path is always printed.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MEDIAKIT_VERSION,
  assemble,
  check,
  diagnoseFilm,
  doctor,
  initProject,
  probe,
  verifyAssembleCuts,
  verifyRender,
} from "../src/core.js";

const usage = `usage: node scripts/selfcheck.mjs [--dir <dir>] [--keep] [--json]
  --dir <dir>  work in <dir> instead of a fresh temp dir (created if missing)
  --keep       keep the work dir on success (default: removed on success)
  --json       print only the JSON summary (default: human table + JSON path)`;

function parseArgs(argv) {
  const opts = { dir: null, keep: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { console.log(usage); process.exit(0); }
    else if (a === "--keep") opts.keep = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--dir") { opts.dir = argv[++i] ?? null; if (!opts.dir) fail("missing value for --dir"); }
    else fail(`unknown argument: ${a}\n${usage}`);
  }
  return opts;
}

function fail(msg) { console.error(msg); process.exit(2); }

// One step of the check: timed, and the first failure stops the run —
// the same rule as doctor --smoke, so a red step is never followed by
// green steps that ran on its broken output.
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const steps = [];
  let workDir = opts.dir;
  let createdDir = false;
  let ok = true;
  let finalInfo = null;

  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, seconds: +((Date.now() - t0) / 1000).toFixed(2), ...(detail !== undefined ? { detail } : {}) });
      return true;
    } catch (err) {
      steps.push({ name, ok: false, seconds: +((Date.now() - t0) / 1000).toFixed(2), error: err?.message ?? String(err) });
      return false;
    }
  };

  // doctor first: its sandbox verdict decides where the temp dir may
  // live, and a broken toolchain must fail before any render is tried.
  let doc = null;
  ok = await step("doctor", async () => {
    doc = await doctor({});
    if (!doc.ok) {
      const bad = Object.entries(doc.tools ?? {}).filter(([, t]) => !t.available).map(([n]) => n);
      throw new Error(`doctor ok=false${bad.length ? ` (unavailable: ${bad.join(", ")})` : ""}`);
    }
    return `ffmpeg ${doc.ffmpeg_version}, ${Object.keys(doc.tools ?? {}).length} tools available`;
  });
  if (!ok) return finish();

  if (!workDir) {
    const base = doc.sandbox?.enabled && doc.sandbox.workdir ? doc.sandbox.workdir : os.tmpdir();
    workDir = await mkdtemp(path.join(base, "mediakit-selfcheck-"));
    createdDir = true;
  }
  const projectDir = path.join(workDir, "project");
  const filmPath = path.join(projectDir, "film.json");
  const previewDir = path.join(projectDir, "outputs", "preview");
  const outputsDir = path.join(projectDir, "outputs");
  const finalPath = path.join(outputsDir, "final.mp4");
  const receiptPath = path.join(outputsDir, "assemble-receipt.json");

  let totalSeconds = null;
  let initRes = null;
  ok = await step("init_project", async () => {
    initRes = await initProject({ dir: projectDir, preset: "vertical" });
    totalSeconds = initRes.total_seconds;
    if (Math.abs(totalSeconds - 4) > 0.01) throw new Error(`scaffold total is ${totalSeconds}s, expected 4s`);
    return `${totalSeconds}s, ${initRes.shots.length} shots, voice ${initRes.voice_seconds}s`;
  });
  if (!ok) return finish();

  ok = await step("diagnose", async () => {
    const d = await diagnoseFilm({ manifestPath: filmPath });
    if (d.verdict === "fail") throw new Error(`diagnose verdict=fail: ${d.first_issue ?? "see checks"}`);
    return `verdict=${d.verdict}, ${d.errors ?? 0} errors, ${d.warnings ?? 0} warnings`;
  });
  if (!ok) return finish();

  ok = await step("plan", async () => {
    const p = await assemble({ manifestPath: filmPath, mode: "plan" });
    if (!p.exportable) throw new Error(`plan not exportable: ${(p.blockers ?? []).join("; ")}`);
    return `${p.total_seconds ?? totalSeconds}s, ${p.timeline?.length ?? "?"} shots, no blockers`;
  });
  if (!ok) return finish();

  // Lượt 197 addition: the preflight gate runs between plan and
  // preview — the render must not die mid-way on a missing font,
  // a broken encoder or an SFX tail past the film end.
  ok = await step("preflight", async () => {
    const p = await assemble({ manifestPath: filmPath, mode: "preflight", outputDir: outputsDir });
    if (!p.ready_to_render) throw new Error(`preflight not ready: ${(p.errors ?? []).join("; ")}`);
    return `${p.checks?.length ?? "?"} checks, ${p.warnings?.length ?? "?"} warnings`;
  });
  if (!ok) return finish();

  ok = await step("preview", async () => {
    const p = await assemble({ manifestPath: filmPath, mode: "preview", outputDir: previewDir });
    const m = await probe(path.join(previewDir, "preview.mp4"));
    if (!m.video || Math.abs(m.duration_seconds - totalSeconds) > 0.25) {
      throw new Error(`preview is ${m.duration_seconds}s, expected ${totalSeconds}s`);
    }
    return `${m.duration_seconds}s ${m.video.width}x${m.video.height} (half-size preview)`;
  });
  if (!ok) return finish();

  ok = await step("approve", async () => {
    const a = await assemble({ manifestPath: filmPath, mode: "approve", outputDir: previewDir });
    if (!a.approval_file) throw new Error("approve returned no approval_file");
    return path.basename(a.approval_file);
  });
  if (!ok) return finish();

  ok = await step("render", async () => {
    const r = await assemble({ manifestPath: filmPath, mode: "render", outputDir: outputsDir });
    const m = await probe(finalPath);
    if (!m.video || Math.abs(m.duration_seconds - totalSeconds) > 0.2) {
      throw new Error(`final is ${m.duration_seconds}s, expected ${totalSeconds}s`);
    }
    if (m.video.width !== 1080 || m.video.height !== 1920) {
      throw new Error(`final is ${m.video.width}x${m.video.height}, expected 1080x1920`);
    }
    finalInfo = {
      duration_seconds: m.duration_seconds,
      dimensions: `${m.video.width}x${m.video.height}`,
      frames: r.final?.frames ?? null,
      loudness_lufs: r.final?.loudness_lufs ?? null,
      sha256: r.final?.sha256 ?? null,
    };
    return `${finalInfo.duration_seconds}s ${finalInfo.dimensions}, ${finalInfo.frames} frames, ${finalInfo.loudness_lufs} LUFS`;
  });
  if (!ok) return finish();

  ok = await step("verify", async () => {
    const v = await verifyRender({ receipt: receiptPath });
    if (v.verdict !== "pass" || v.changed !== 0) {
      throw new Error(`verify ${v.verdict}: ${v.changed} of ${v.total} items differ, first: ${v.first_difference ?? "?"}`);
    }
    return `${v.changed} changed of ${v.total} items`;
  });
  if (!ok) return finish();

  ok = await step("verify-cuts", async () => {
    const v = await verifyAssembleCuts({ manifestPath: filmPath, video: finalPath });
    // verifyAssembleCuts reports a boolean `ok`, not a `verdict`
    // (unlike verify/release_checkpoint) — read the field it has.
    if (!v.ok) throw new Error(`verify-cuts not ok: ${v.summary ?? "see checks"}`);
    return v.summary ?? "all boundaries confirmed";
  });
  if (!ok) return finish();

  ok = await step("check", async () => {
    const c = await check({ input: finalPath, platform: "tiktok" });
    if (!c.pass) throw new Error(`check tiktok failed: ${(c.issues ?? []).join("; ")}`);
    return `tiktok pass, ${c.checks?.length ?? "?"} checks, complete=${c.complete}`;
  });
  if (!ok) return finish();

  async function finish() {
    const seconds = +((Date.now() - started) / 1000).toFixed(2);
    const kept = ok ? opts.keep : true;
    // A failed run keeps its dir so the broken state can be inspected;
    // a passed run removes the temp dir it created unless --keep.
    if (!kept && createdDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    const result = {
      operation: "selfcheck",
      ok,
      seconds,
      mediakit_version: MEDIAKIT_VERSION,
      dir: workDir,
      kept,
      steps,
      ...(finalInfo ? { final: finalInfo } : {}),
      ...(ok ? {} : { failed_step: steps.find((s) => !s.ok)?.name ?? null }),
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const s of steps) {
        console.log(`${s.ok ? "PASS" : "FAIL"} ${s.name} (${s.seconds}s)${s.detail ? ` — ${s.detail}` : ""}${s.error ? ` — ${s.error}` : ""}`);
      }
      console.log(ok ? `selfcheck PASS in ${seconds}s (work dir ${kept ? `kept at ${workDir}` : "removed"})` : `selfcheck FAIL at ${result.failed_step} — work dir kept at ${workDir}`);
    }
    process.exit(ok ? 0 : 1);
  }

  await finish();
}

main().catch((err) => { console.error(`selfcheck crashed: ${err?.message ?? err}`); process.exit(1); });
