// Generate the stabilize fixtures: a textured still scene rendered as
// (a) a stable 10s clip and (b) the same scene with seeded random-walk
// handheld shake (translation only, ±16px). The scene is dense high-
// contrast texture (grid + circles + text + color blocks) so vidstab's
// block matching has features to track — the lượt 29 failure was flat
// testsrc-style content where block matching finds nothing.
// Usage: node test/make-shaky-fixture.mjs  (writes test/shaky-stable.mp4
// and test/shaky-source.mp4, 640x360 30fps 10s, with a 440Hz tone so
// audio copy through stabilize is verifiable)
import { createCanvas } from "canvas";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const W = 640, H = 360, FPS = 30, SECONDS = 10, FRAMES = FPS * SECONDS;

// mulberry32 — deterministic, so the fixture is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawScene(ctx) {
  // Base: warm paper + big color blocks.
  ctx.fillStyle = "#f5e6c8"; ctx.fillRect(0, 0, W + 64, H + 64);
  const blocks = [
    [0, 0, 220, 140, "#c0392b"], [220, 0, 220, 140, "#2980b9"],
    [440, 0, 264, 140, "#27ae60"], [0, 140, 160, 140, "#8e44ad"],
    [160, 140, 200, 140, "#f39c12"], [360, 140, 180, 140, "#16a085"],
    [540, 140, 164, 140, "#d35400"], [0, 280, 704, 144, "#2c3e50"],
  ];
  for (const [x, y, w, h, c] of blocks) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
  // Dense grid (contrast for block matching).
  ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 2;
  for (let x = 0; x <= W + 64; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H + 64); ctx.stroke(); }
  for (let y = 0; y <= H + 64; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W + 64, y); ctx.stroke(); }
  // Circles + diagonals.
  const rand = rng(42);
  for (let i = 0; i < 24; i++) {
    ctx.fillStyle = ["#fff", "#000", "#ff0", "#0ff"][i % 4];
    ctx.beginPath(); ctx.arc(40 + rand() * (W - 40), 40 + rand() * (H - 40), 8 + rand() * 18, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = "#111"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(0, H + 64); ctx.lineTo(W + 64, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W + 64, H + 64); ctx.stroke();
  // Text — readable landmarks for the eye check.
  ctx.fillStyle = "#fff"; ctx.font = "bold 44px sans-serif";
  ctx.fillText("STABILIZE TEST", 28, 70);
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("0123456789 ABCDEFG", 28, 330);
  ctx.fillStyle = "#000"; ctx.font = "bold 22px sans-serif";
  ctx.fillText("GRID 32px — CIRCLES — TEXT", 28, 180);
}

function renderFrames(shake) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mediakit-shaky-"));
  const scene = createCanvas(W + 64, H + 64);
  drawScene(scene.getContext("2d"));
  const rand = rng(1337);
  let dx = 0, dy = 0;
  for (let i = 0; i < FRAMES; i++) {
    const cv = createCanvas(W, H);
    const ctx = cv.getContext("2d");
    if (shake) {
      // Zero-mean HIGH-frequency jitter: two sines (2.5 Hz + 6.1 Hz,
      // the handheld tremor band) plus small per-frame noise. This is
      // what vidstab's low-pass smoothing is built to remove. A random
      // WALK is the wrong fixture: its energy is low-frequency drift,
      // which smoothing preserves by design as "intentional camera
      // movement" (the lượt 29 lesson: "rung chậm bị smoothing nuốt").
      const t = i / FPS;
      dx = 8 * Math.sin(2 * Math.PI * 2.5 * t + 0.7)
        + 5 * Math.sin(2 * Math.PI * 6.1 * t + 2.1)
        + (rand() * 4 - 2);
      dy = 7 * Math.sin(2 * Math.PI * 3.1 * t + 1.3)
        + 4 * Math.sin(2 * Math.PI * 5.3 * t + 0.4)
        + (rand() * 4 - 2);
    }
    ctx.drawImage(scene, -32 + dx, -32 + dy);
    fs.writeFileSync(path.join(tmp, `f-${String(i).padStart(3, "0")}.png`), cv.toBuffer("image/png"));
  }
  return tmp;
}

function encode(framesDir, out) {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", String(FPS), "-i", path.join(framesDir, "f-%03d.png"),
    "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-shortest", out,
  ], { stdio: "inherit" });
}

const stableDir = renderFrames(false);
encode(stableDir, path.join(root, "test", "shaky-stable.mp4"));
fs.rmSync(stableDir, { recursive: true, force: true });
const shakyDir = renderFrames(true);
encode(shakyDir, path.join(root, "test", "shaky-source.mp4"));
fs.rmSync(shakyDir, { recursive: true, force: true });
console.log("wrote test/shaky-stable.mp4 + test/shaky-source.mp4");
