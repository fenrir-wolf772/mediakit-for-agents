// Generate the hook robust-z fixture with ffmpeg (deterministic
// lavfi sources, ground truth known by construction, not by guess).
// Run once: node test/make-hook-robustz-fixture.mjs (fixture is
// committed; re-run only if the generator changes).
//
// hook-robustz-source.mp4 (30s, 640x360, video-only): static blue
// [0,24), then the last 6s carry a SMALL moving window — testsrc2
// 240x135 centered on the same blue, hard cut at 24s. Measured
// 2026-11-28 (ffmpeg 8.1.2, motion window 0.5s): the burst bins
// read motion_fraction 0.0226-0.0279 (energy 0.0254), so the ABSOLUTE
// scale (fixed 0.06 reference) scores them only ~0.41, while the
// per-video robust-z (median 0 over 48 quiet bins, MAD 0, scale
// floored at 0.005) scores them 1.0 — the lift the robust-z channel
// exists to provide. The hard cut at 24s hands windows starting at
// 24s a cut bonus, so the test asserts on the CURVE bins (not the
// winner alone): burst bins must show motion_relative ~1.0 while
// motion_fraction stays ~0.025.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const run = (args, name) => {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "inherit" });
  console.log(name, "done");
};

run([
  "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=24",
  "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=6",
  "-f", "lavfi", "-i", "testsrc2=s=240x135:r=30:d=6",
  "-filter_complex",
  "[1:v][2:v]overlay=(W-w)/2:(H-h)/2[m];[0:v][m]concat=n=2:v=1:a=0[v]",
  "-map", "[v]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-t", "30",
  path.join(root, "hook-robustz-source.mp4"),
], "hook-robustz-source.mp4");
