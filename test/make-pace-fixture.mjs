// Generate the measure_pace fixture with ffmpeg (deterministic lavfi
// sources, ground truth known by construction, not by guess).
// Run once: node test/make-pace-fixture.mjs (fixture is committed;
// re-run only if the generator changes).
//
// pace-source.mp4 (20s, 320x240): four 5s flat colour blocks —
// red [0,5), blue [5,10), green [10,15), yellow [15,20) — joined
// by hard concat, so the content detector must find exactly 3 cuts
// at 5/10/15s: cuts_per_min 9.0, avg_shot_s 5.0, longest_hold_s 5.0
// at 0.0s. The colours alternate hue strongly (red->blue is the
// hue-only case the ffmpeg detector misses, the content detector
// catches), so the fixture also proves measure_pace defaults to the
// content detector, not the ffmpeg one.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const run = (args, name) => {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "inherit" });
  console.log(name, "done");
};

run([
  "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=5",
  "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=30:d=5",
  "-f", "lavfi", "-i", "color=c=green:s=320x240:r=30:d=5",
  "-f", "lavfi", "-i", "color=c=yellow:s=320x240:r=30:d=5",
  "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]",
  "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
  "-t", "20",
  path.join(root, "pace-source.mp4"),
], "pace-source.mp4");
