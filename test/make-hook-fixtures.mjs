// Generate the hook motion/snap fixtures with ffmpeg (deterministic
// lavfi sources, ground truth known by construction, not by guess).
// Run once: node test/make-hook-fixtures.mjs (fixtures are committed;
// re-run only if the generator changes).
//
// hook-motion-source.mp4 (30s, 640x360): LOUD + static red [0,15),
// QUIETER + moving testsrc2 [15,30). The two halves join with a 1s
// crossfade (xfade), NOT a hard cut — a hard cut at 15s hands every
// window starting at 14.5-15 a cut bonus of 0.6-0.73, which decides
// the ranking by itself and hides the motion term entirely (measured
// with the hard-cut build: [14.5,24.5) won under BOTH weight sets).
// With the fade, cut_score is ~0 everywhere and the ranking is
// decided by energy/speech/motion alone. The quiet tone is vol 0.35
// (RMS ~-30 dB): above the -40 dB silence threshold (vol 0.05
// measured -47 dB and read as silence, speech 0), close enough in
// energy to the loud half (0.91) that motion — not loudness — flips
// the winner from the static half to the moving half.
//
// hook-snap-source.mp4 (30s, 640x360): quiet red [0,15), loud blue
// [15,22), SILENT blue [22,30), cut at 15s. The winning 10s window
// is [15,25), but its tail [22,25) is dead air — the quiet snap must
// move the suggested trim end 25 -> 22.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const run = (args, name) => {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "inherit" });
  console.log(name, "done");
};

// Loud static half + quieter moving half, joined by a 1s crossfade
// at 14.5s (segments 15.5s each, xfade offset 14.5) so no scene cut
// fires at the join. Audio joins hard at 15s (audio cuts don't
// trigger the scene detector).
run([
  "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=15.5",
  "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=15.5",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=15",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=15",
  "-filter_complex",
  "[0:v][1:v]xfade=transition=fade:duration=1:offset=14.5[v];[2:a]volume=0.5[a0];[3:a]volume=0.35[a1];[a0][a1]concat=n=2:v=0:a=1[a]",
  "-map", "[v]", "-map", "[a]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "128k", "-t", "30",
  path.join(root, "hook-motion-source.mp4"),
], "hook-motion-source.mp4");

// Loud blue [15,22) then silence [22,30) on a static blue frame.
run([
  "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=15",
  "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=7",
  "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=8",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=15",
  "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:d=7",
  "-f", "lavfi", "-i", "aevalsrc=0:sample_rate=44100:d=8",
  "-filter_complex",
  "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]volume=0.05[a0];[4:a]volume=0.5[a1];[a0][a1][5:a]concat=n=3:v=0:a=1[a]",
  "-map", "[v]", "-map", "[a]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "128k", "-t", "30",
  path.join(root, "hook-snap-source.mp4"),
], "hook-snap-source.mp4");

// hook-visual-source.mp4 (30s, 640x360): LOUD + static red [0,15),
// QUIETER + colour blocks [15,30) joined by 1s crossfades (xfade),
// NOT hard cuts — a hard cut fires the scene detector and hands the
// window a cut bonus, which would decide the ranking by itself and
// hide the visual term (same trap as the motion fixture). With
// xfades, cut_score is ~0 everywhere: the fade still flips the
// average hash (measured: one boundary near each fade) while the
// scene detector stays quiet, and motion is only the fade frames
// (~0.05 over the window). Audio: vol 0.5 vs 0.1 (quiet energy ~0.72,
// speech 1.0 both halves — -23 dB is above the -40 dB silence
// threshold). Under the OLD weights the loud static window [0,10)
// wins (0.6 vs ~0.51); under the NEW weights the visual half wins
// ([15,25) ~0.53 vs 0.5) — the flip is the visual term, not motion
// and not cuts. Segments are 15.5/5.5/5.5/6.5s so the three xfades
// (offsets 14.5/20/25, duration 1) tile exactly 30s. The blocks
// are lime, not green: ffmpeg "green" is (0,127,0), grey 74.5 — below
// the hash tie-break 127.5, so it hashes identically to red and blue
// and no boundary ever fires (measured). "lime" is (0,254,0), grey
// 149.1, hash-bit 1, so every fade flips the hash. Segment lengths
// are NOT arbitrary: each xfade needs its first input to last until
// offset+duration, or the fade is cut short and the last blended
// frame jumps to the pure second input — a hard cut (measured: the
// first build had the second fade end 0.5s early and `scenes` fired
// at 20.0). So red 15.5 / lime 6.5 / blue 6 / lime 5: AB = 21.0
// (>= 20+1), ABC = 26.0 (>= 25+1), total 30.0.
run([
  "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=15.5",
  "-f", "lavfi", "-i", "color=c=lime:s=640x360:r=30:d=6.5",
  "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=6",
  "-f", "lavfi", "-i", "color=c=lime:s=640x360:r=30:d=5",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=15",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=15",
  "-filter_complex",
  "[0:v][1:v]xfade=transition=fade:duration=1:offset=14.5[v01];[v01][2:v]xfade=transition=fade:duration=1:offset=20[v012];[v012][3:v]xfade=transition=fade:duration=1:offset=25[v];[4:a]volume=0.5[a0];[5:a]volume=0.1[a1];[a0][a1]concat=n=2:v=0:a=1[a]",
  "-map", "[v]", "-map", "[a]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "128k", "-t", "30",
  path.join(root, "hook-visual-source.mp4"),
], "hook-visual-source.mp4");
