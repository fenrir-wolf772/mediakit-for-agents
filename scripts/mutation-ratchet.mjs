// Mutation ratchet — the floor under `scripts/mutation-smoke.mjs`.
//
// Idea learned from Sandeepv68/EncodeX (`mutation-ratchet.yml` +
// `scripts/mutation-delta.mjs`, lượt 135): a mutation run is only
// useful over time if its result is compared against a committed
// baseline. EncodeX runs full Stryker, computes a score, and fails
// the job when the score drops more than a delta below the committed
// baseline; only a green run may write a new (higher) baseline, via
// a PR. MediaKit's smoke is 4 hand-written mutants, not Stryker, so
// the ratchet is adapted to that scale:
//
//   - The baseline is a committed JSON file, one status per mutant id
//     (`scripts/mutation-baseline.json`), plus the killed count.
//   - The gate has TWO rules, either one fails the run:
//       (1) killed count below the baseline killed count (the floor);
//       (2) any mutant that was KILLED in the baseline now SURVIVED
//           or ERRORED (a regression on a named behaviour — even if a
//           new mutant being killed keeps the count level).
//   - A missing baseline never fails ("record first, arm next run",
//     same as EncodeX's delta gate): the run reports `armed: false`
//     and the operator records one with `--generate-baseline`.
//   - A mutant id that is new (not in the baseline) never fails the
//     gate — it is new coverage; the baseline is refreshed with
//     `--generate-baseline`, which refuses unless the run is fully
//     green (all mutants KILLED), mirroring EncodeX's "only a green
//     run moves the baseline up".
//   - A mutant id that disappeared from the registry is listed, not
//     failed on its own: the killed-count rule already covers it
//     (the floor still counts it until a green run re-baselines).
//
// This module is pure: no process exit, no ffmpeg, no git. The CLI
// wiring lives in `mutation-smoke.mjs`; the unit tests import from
// here directly.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const BASELINE_VERSION = 1;
export const BASELINE_FILENAME = "mutation-baseline.json";

// Statuses a mutant run can report. Keep the exact words the smoke
// script already prints, so baseline files stay readable.
export const STATUS_KILLED = "KILLED";
export const STATUS_SURVIVED = "SURVIVED";
export const STATUS_ERROR = "ERROR";

/**
 * Compare one smoke run against the committed baseline.
 *
 * @param {Array<{id: string, status: string}>} results - One entry
 *   per mutant in this run.
 * @param {object|null} baseline - Parsed `mutation-baseline.json`,
 *   or null when no baseline file exists yet.
 * @returns {{
 *   failed: boolean, armed: boolean,
 *   killed: number, total: number, floor: number|null,
 *   regressions: string[], newMutants: string[], removedMutants: string[],
 *   reason: string
 * }}
 */
export function evaluateRatchet(results, baseline) {
  const killed = results.filter((r) => r.status === STATUS_KILLED).length;
  const total = results.length;
  if (!baseline || typeof baseline !== "object" || !baseline.mutants || typeof baseline.mutants !== "object") {
    return {
      failed: false,
      armed: false,
      killed,
      total,
      floor: null,
      regressions: [],
      newMutants: results.map((r) => r.id),
      removedMutants: [],
      reason: "no baseline recorded yet — gate unarmed (run --generate-baseline after a green run)",
    };
  }
  const baselineMutants = baseline.mutants;
  const baselineKilled = typeof baseline.killed === "number"
    ? baseline.killed
    : Object.values(baselineMutants).filter((s) => s === STATUS_KILLED).length;
  const regressions = [];
  const newMutants = [];
  for (const r of results) {
    if (!(r.id in baselineMutants)) {
      newMutants.push(r.id);
    } else if (baselineMutants[r.id] === STATUS_KILLED && r.status !== STATUS_KILLED) {
      regressions.push(r.id);
    }
  }
  const removedMutants = Object.keys(baselineMutants).filter(
    (id) => !results.some((r) => r.id === id),
  );
  const failed = killed < baselineKilled || regressions.length > 0;
  const reason = failed
    ? regressions.length > 0
      ? `regression: ${regressions.join(", ")} killed in baseline, not killed now`
      : `killed ${killed} below baseline floor ${baselineKilled}`
    : `killed ${killed}/${total}, floor ${baselineKilled} held`;
  return {
    failed,
    armed: true,
    killed,
    total,
    floor: baselineKilled,
    regressions,
    newMutants,
    removedMutants,
    reason,
  };
}

/**
 * Read the committed baseline next to this script. Returns null when
 * the file does not exist; throws on malformed JSON (a corrupt
 * baseline must fail loudly, never silently disarm the gate).
 */
export async function loadBaseline(scriptsDir) {
  const file = path.join(scriptsDir, BASELINE_FILENAME);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new Error(`mutation-ratchet: baseline ${file} is unreadable: ${String(e).split("\n")[0]}`);
  }
}

/**
 * Build the baseline document for a run. Callers must only call this
 * after a fully green run (all KILLED) — the smoke script enforces
 * that; this function does not second-guess it.
 */
export function buildBaseline(results, { commit = null } = {}) {
  const mutants = {};
  for (const r of results) mutants[r.id] = r.status;
  return {
    version: BASELINE_VERSION,
    generated_at: new Date().toISOString(),
    commit,
    mutants,
    killed: results.filter((r) => r.status === STATUS_KILLED).length,
    total: results.length,
  };
}

/** Write the baseline document (atomic: temp file + rename). */
export async function writeBaseline(scriptsDir, doc) {
  const file = path.join(scriptsDir, BASELINE_FILENAME);
  const tmp = `${file}.partial`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return file;
}

/** One-line human summary of a gate evaluation, for logs and CI. */
export function formatRatchetReport(ev) {
  const lines = [
    `mutation-ratchet: ${ev.failed ? "FAILED" : "PASSED"} — ${ev.reason} (killed ${ev.killed}/${ev.total}${ev.floor === null ? "" : `, floor ${ev.floor}`})`,
  ];
  if (ev.regressions.length > 0) lines.push(`  regressions: ${ev.regressions.join(", ")}`);
  if (ev.newMutants.length > 0) lines.push(`  new mutants (not in baseline): ${ev.newMutants.join(", ")} — re-baseline with --generate-baseline after a green run`);
  if (ev.removedMutants.length > 0) lines.push(`  removed mutants (in baseline, not run): ${ev.removedMutants.join(", ")}`);
  if (!ev.armed) lines.push(`  gate unarmed — no baseline file yet`);
  return lines.join("\n");
}
