// Generate the bpm fixtures: deterministic 16-bit mono WAV click/drum
// tracks at known tempos, so `bpm` is measured against ground truth
// instead of a guess. Run once: node test/make-bpm-fixtures.mjs
// (fixtures are committed; re-run only if the generator changes).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 22050;
const SECONDS = 12;
const root = path.dirname(fileURLToPath(import.meta.url));

function writeWav(name, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  writeFileSync(path.join(root, name), buf);
  console.log(name, n, "samples");
}

// 1 kHz sine pip, 30ms, fast decay — one sharp onset per beat.
function clickTrack(bpm) {
  const n = Math.floor(SECONDS * SR);
  const s = new Float32Array(n);
  const period = 60 / bpm;
  for (let b = 0; ; b++) {
    const t0 = b * period;
    if (t0 >= SECONDS) break;
    const start = Math.floor(t0 * SR);
    for (let i = 0; i < Math.floor(0.03 * SR); i++) {
      const t = i / SR;
      s[start + i] += Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t * 180) * 0.9;
    }
  }
  return s;
}

// Kick (60 Hz sine decay) on beats + noise hat on the off-beat — the
// pattern a naive detector reads as 240 BPM (subdivision), so the
// fixture proves the tempo prior picks the musical beat (120).
function drumTrack(bpm) {
  const n = Math.floor(SECONDS * SR);
  const s = new Float32Array(n);
  const period = 60 / bpm;
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let b = 0; ; b++) {
    const t0 = b * period;
    if (t0 >= SECONDS) break;
    const start = Math.floor(t0 * SR);
    for (let i = 0; i < Math.floor(0.15 * SR); i++) {
      const t = i / SR;
      s[start + i] += Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 25) * 0.9;
    }
    const hatAt = t0 + period / 2;
    if (hatAt < SECONDS) {
      const hs = Math.floor(hatAt * SR);
      for (let i = 0; i < Math.floor(0.04 * SR); i++) {
        const t = i / SR;
        s[hs + i] += (rand() * 2 - 1) * Math.exp(-t * 120) * 0.25;
      }
    }
  }
  return s;
}

writeWav("bpm-click-90.wav", clickTrack(90));
writeWav("bpm-click-120.wav", clickTrack(120));
writeWav("bpm-click-150.wav", clickTrack(150));
writeWav("bpm-click-180.wav", clickTrack(180));
writeWav("bpm-drum-120.wav", drumTrack(120));
