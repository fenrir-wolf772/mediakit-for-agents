// Mutation smoke test — Stryker-style, MediaKit-scale.
//
// A test suite that never fails is a test suite that never checks
// anything. This script proves the suite can fail: it takes a small
// registry of hand-written mutants (each one flips a single literal
// or operator, the way Stryker's BooleanLiteral / EqualityOperator /
// ArithmeticOperator mutators do), applies one at a time to
// src/core.js, and runs a fast probe for the exact behaviour the
// suite asserts. A mutant is KILLED when the probe reports the
// behaviour wrong; it SURVIVED when the probe still passes — a
// survivor means the suite's assertion does not actually cover that
// behaviour, and the run exits 1 listing the survivors.
//
// Why not full Stryker: the suite is 1100+ ffmpeg assertions that
// take ~30 minutes and lean on real fixtures; instrumenting all of
// src/core.js through babel and re-running the whole suite per
// mutant would take hours. Each mutant here is tied to one named
// suite assertion (see `suite`), and its probe is the same check
// the suite makes, run through the CLI in seconds.
//
// Safety: the mutated file is src/core.js only, and the script
// refuses to run while that file has uncommitted changes —
// restoring after a mutant must never clobber real work. The
// original bytes are kept in memory and written back in a finally
// block; a hash check after restore proves the file is byte-identical
// to before. If the process is hard-killed mid-mutant, the mutation
// stays visible in `git diff` and the last log line names it.
//
// Run: node scripts/mutation-smoke.mjs  (also `npm run mutation-smoke`,
// and CI runs it after the syntax check)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_TIMEOUT_MS = 180000;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Run the CLI and parse its JSON stdout. Throws on a non-zero exit
// or unparseable output — the probe wrappers decide what that means.
async function runCli(args, env = {}) {
  const { stdout } = await execFileAsync("node", ["bin/mediakit.js", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// Probes return true when the behaviour is CORRECT (the value the
// suite asserts). A probe that throws is treated as "not correct"
// after mutation (the tool crashed instead of answering), but as a
// hard error on the clean baseline — a probe that cannot even run
// clean proves nothing.
const MUTANTS = [
  {
    id: "titlecard-default-font",
    file: "src/core.js",
    from: "Math.round(w * 0.11)",
    to: "Math.round(w * 0.10)",
    suite: "titlecard default font is 119px at 1080 wide",
    probe: async (tmp) => {
      const j = await runCli(["titlecard", "The Moon Is Leaving Us", "-o", path.join(tmp, "mut-tc.png")]);
      return j.font_size === 119;
    },
  },
  {
    id: "displaydims-ignores-rotation",
    file: "src/core.js",
    from: "    width: v.display_width ?? v.width,\n    height: v.display_height ?? v.height,",
    to: "    width: v.width,\n    height: v.height,",
    suite: "burn_captions default font is 60px on rotated-vertical 1080x1920 (lượt 78)",
    probe: async (tmp) => {
      const j = await runCli([
        "burn-captions", "test/rotated-vertical.mp4", "--captions", "test/captions.srt",
        "-o", path.join(tmp, "mut-bc.mp4"),
      ]);
      return j.font_size === 60;
    },
  },
  {
    id: "loudness-default-target",
    file: "src/core.js",
    from: "export async function loudness({ input, output, targetLufs = -14, format = null, compressor = null, dryRun = false }) {",
    to: "export async function loudness({ input, output, targetLufs = -16, format = null, compressor = null, dryRun = false }) {",
    suite: "loudness defaults to -14 LUFS (CLI passes -14 explicitly, so this probes the core default directly)",
    probe: async (tmp) => {
      // The CLI passes --target-lufs explicitly, so the core default
      // is only reachable by calling the function: run it in a fresh
      // node process and read the measured output LUFS.
      const out = path.join(tmp, "mut-loud.mp4");
      const code = `import("./src/core.js").then(async (m) => { const r = await m.loudness({ input: "test/source.mp4", output: process.env.MUT_OUT }); console.log(JSON.stringify({ output_lufs: r.output_lufs })); }).catch((e) => { console.error(String(e)); process.exit(2); });`;
      const { stdout } = await execFileAsync("node", ["--input-type=module", "-e", code], {
        cwd: root,
        env: { ...process.env, MUT_OUT: out },
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      const j = JSON.parse(stdout);
      return typeof j.output_lufs === "number" && Math.abs(j.output_lufs - (-14)) <= 0.5;
    },
  },
  {
    id: "denoise-strength-scale",
    file: "src/core.js",
    from: "const value = filter === \"hqdn3d\" ? +(s * 30).toFixed(2) : +(s * 10).toFixed(2);",
    to: "const value = filter === \"hqdn3d\" ? +(s * 28).toFixed(2) : +(s * 10).toFixed(2);",
    suite: "denoise strength 0.5 maps to hqdn3d=15",
    probe: async (tmp) => {
      const j = await runCli(["denoise", "test/noisy.mp4", "--strength", "0.5", "-o", path.join(tmp, "mut-denoise.mp4")]);
      return j.filter === "hqdn3d" && j.filter_value === 15;
    },
  },
];

const tmp = await mkdtemp(path.join(tmpdir(), "mediakit-mutation-"));
let failures = 0;
try {
  // Guard: never mutate a file with uncommitted changes.
  const { stdout: dirty } = await execFileAsync("git", ["status", "--porcelain", "--", "src/core.js"], { cwd: root }).catch((e) => {
    console.error("mutation-smoke: could not check git status for src/core.js:", String(e).split("\n")[0]);
    process.exit(2);
  });
  if (dirty.trim()) {
    console.error("mutation-smoke: refusing to run — src/core.js has uncommitted changes; commit first so restore is safe.");
    process.exit(2);
  }

  for (const m of MUTANTS) {
    const filePath = path.join(root, m.file);
    const original = await readFile(filePath, "utf8");
    const originalHash = sha256(original);
    const occurrences = original.split(m.from).length - 1;
    if (occurrences !== 1) {
      console.error(`MUTANT ${m.id}: 'from' occurs ${occurrences}x in ${m.file} (need exactly 1) — update the registry.`);
      failures++;
      continue;
    }
    // Baseline: the probe must pass on the clean tree, or it proves
    // nothing (a broken probe reports every mutant killed).
    let baseline;
    try {
      baseline = await m.probe(tmp);
    } catch (e) {
      console.error(`MUTANT ${m.id}: probe ERRORED on the clean tree — fix the probe, not the code: ${String(e).split("\n")[0]}`);
      failures++;
      continue;
    }
    if (!baseline) {
      console.error(`MUTANT ${m.id}: probe FAILED on the clean tree — the suite assertion it mirrors ("${m.suite}") is already failing. Fix that first.`);
      failures++;
      continue;
    }
    // Apply, probe, restore — restore always runs, even on probe error.
    let killed = false;
    try {
      await writeFile(filePath, original.replace(m.from, m.to), "utf8");
      try {
        killed = !(await m.probe(tmp));
      } catch {
        killed = true; // crashed instead of answering: the suite would fail too
      }
    } finally {
      await writeFile(filePath, original, "utf8");
      const restored = await readFile(filePath, "utf8");
      if (sha256(restored) !== originalHash) {
        console.error(`MUTANT ${m.id}: RESTORE FAILED — ${m.file} differs from before; the mutation is still applied. Restore it by hand (git diff shows it).`);
        process.exit(2);
      }
    }
    console.log(`MUTANT ${m.id}: ${killed ? "KILLED" : "SURVIVED"} (suite: "${m.suite}")`);
    if (!killed) failures++;
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`mutation-smoke: ${failures} mutant(s) SURVIVED or errored — the suite does not cover that behaviour. Add an assertion, then re-run.`);
  process.exit(1);
}
console.log(`mutation-smoke: all ${MUTANTS.length} mutants KILLED — the suite really checks what it claims to.`);
