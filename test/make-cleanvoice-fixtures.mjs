// Generate the clean_voice fixtures: synthetic speech-like takes
// with known defects, so the diagnose assertions measure real
// numbers instead of guessing them. Run: node test/make-cleanvoice-fixtures.mjs
// All fixtures are 12 s, 48 kHz mono s16 WAV. Each "word" is a
// 0.8 s burst (harmonic stack + breath noise, so the spectrum
// reaches past 15 kHz) separated by 0.7 s of near-silence, so the
// envelope, echo tail and pause spectrum are all measurable.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 48000;
const DUR = 12;
const N = SR * DUR;

function writeWav(file, samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples.length * 2, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return writeFile(file, data);
}

// Deterministic pseudo-random (mulberry32) so the fixtures are
// byte-identical on every regeneration.
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bursts({ hum = 0, echo = null, clipGain = 1, gain = 1 } = {}) {
  const out = new Float64Array(N);
  const rand = rng(131);
  // 5 words of 0.6 s, 1.8 s gaps: a 341 ms hum-FFT segment starting
  // anywhere in the first 1.4 s of a gap stays inside the gap, so the
  // pause spectrum is not contaminated by word energy (measured:
  // 0.7 s gaps let segments cross into the next word and the hum
  // line drowned in the neighbours).
  const words = 5;
  for (let w = 0; w < words; w++) {
    const start = Math.round((0.5 + w * 2.4) * SR);
    const len = Math.round(0.6 * SR);
    const f0 = 105 + w * 7;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env = Math.min(1, i / (0.05 * SR)) * (1 - (i / len) * 0.3);
      let s = 0;
      for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * f0 * h * t + h) / h;
      s = (s / 3) * 0.5 + (rand() * 2 - 1) * 0.18; // harmonics + breath noise
      out[start + i] += s * env * 0.55 * gain;
    }
  }
  if (hum > 0) {
    for (let i = 0; i < N; i++) out[i] += Math.sin(2 * Math.PI * 50 * (i / SR)) * hum;
  }
  if (echo) {
    // Feedback comb (short delay, high decay): a real room tail —
    // the envelope keeps ringing 30-150 ms after each word, which
    // is exactly what the echo-tail measurement reads. A single
    // 0.3 s slapback does NOT work here: it arrives after the
    // measurement window and fills the gaps, so no word offset is
    // ever detected (measured: echo null, words 0).
    const [delay, decay] = echo;
    const d = Math.round(delay * SR);
    for (let i = d; i < N; i++) out[i] += out[i - d] * decay;
  }
  if (clipGain !== 1) {
    for (let i = 0; i < N; i++) out[i] = Math.max(-0.999, Math.min(0.999, out[i] * clipGain));
  }
  return out;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
await writeWav(path.join(root, "cleanvoice-clean.wav"), bursts());
await writeWav(path.join(root, "cleanvoice-hum.wav"), bursts({ hum: 0.0008, gain: 2 }));
await writeWav(path.join(root, "cleanvoice-clipped.wav"), bursts({ clipGain: 8 }));
await writeWav(path.join(root, "cleanvoice-echo.wav"), bursts({ echo: [0.08, 0.7] }));
console.log("wrote 4 clean_voice fixtures");
