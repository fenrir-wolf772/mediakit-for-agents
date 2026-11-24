# MediaKit — agent skill

You have professional media tools. Use them instead of guessing about a
video or audio file, and instead of writing one-off ffmpeg shell commands.

## When to use MediaKit

- **Before describing or editing media**: `probe` first. Never guess a
  duration, resolution, or codec from a filename.
- **User asks for a cut, a clip, a shorter version**: `trim`.
- **User asks for vertical / square / a different size**: `reframe`
  (one step; `crop` + `resize` only when you need an exact pixel rectangle).
- **User asks for the audio, a voiceover, or a soundtrack**: `extract_audio`.
- **User asks "what does it look like at 0:12?"**: `extract_frame`, then
  read the image. For an overview of the whole clip: `frames` (separate
  images with timestamps — read several) or `thumbnail` (one contact sheet).
  To scrub a shot frame by frame (a fast move, a blink, a lip-sync slip):
  `extract_frames` (the full sequence, `frame-0001.png` … — `--fps` to
  thin it out; refuses over 5000 frames; `--dedup 0.5` drops only
  truly frozen frames, `--dedup 2` is reel-relay's ruthless summary
  default and collapses slow motion).
- **Audio is too quiet/loud or inconsistent**: `loudness` (default −14 LUFS).
- **User asks to join clips**: `concat`. For a smooth join instead of a
  hard cut: `concat` with `transition` (`fade`, `wipeleft`, `dissolve`,
  `circlecrop`, …) and `transition_duration` (seconds, shorter than the
  shortest clip) — clips are normalized to the first clip's size/fps first.
- **User asks for captions/subtitles on the video**: `burn_captions`.
- **User asks for a different format**: `convert`.
- **Speech has dead air / long pauses**: `silence` — first run it with
  `detect_only: true` and read the silence/kept segments; only then cut.
  The 0.2s margin keeps words from being clipped.
- **A voice recording sounds bad (room echo, mains hum, clipping, thin
  phone audio)**: `clean_voice` — first run it with `diagnose_only: true`
  and read the diagnosis + plan; it measures peak, clipped runs, noise
  floor, SNR, echo tail, bandwidth and 50/60 Hz hum, then picks the steps
  (`declip`, `dehum`, `clearvoice`, `sr`) and runs the EQ + 3.5:1
  compressor + limiter chain once in float to −14 LUFS. Output is a
  48 kHz mono float WAV — cut it afterwards with the take's times.
  `clearvoice`/`sr` need the ClearVoice engine, which is not installed:
  a plan that needs them refuses the run, so pass `steps: ["declip",
  "dehum"]` (or `["none"]` for chain only) to clean without them. On a
  new mic or room, run with `ab: true` and listen to the 12 s window
  through every candidate chain before committing.
- **Before publishing to TikTok / Reels / Shorts / YouTube**: `check`
  — verifies dimensions, codecs, duration limit and measured loudness
  against the platform spec, with a fix hint per failed rule.
- **Source may have black bars**: `cropdetect` — measures the
  letterbox/pillarbox and returns the exact crop rectangle plus a
  ready-to-run `crop` command. Run it before `crop`/`reframe`.
- **Delivering a finished file**: `package` — a ZIP with the media,
  a `spec.json` receipt (measured probe + loudness + platform check),
  `checksums.sha256`, and the captions sidecar when given.
- **Voice over music**: `mix` — levels the voice to `voice_lufs`
  (−16), ducks the music bed under the voice (`duck_db` 12, attack
  100 ms, release 400 ms), loops the bed to the voice length, masters
  to `target_lufs` (−14). Read `ducking_measured_db` in the result —
  the ducking actually measured — before claiming the bed sits right.
- **First run on a new machine, or a tool fails oddly**: `doctor` —
  read-only preflight; a tool listed `available: false` will fail at
  runtime because its ffmpeg filter/encoder is missing.

## How to call the tools

Prefer the MCP tools (`probe`, `trim`, `crop`, …) when they are available.
The CLI mirrors them one-to-one if you are in a shell:

```bash
mediakit probe clip.mp4
mediakit trim clip.mp4 --start 2 --duration 8 -o clip-short.mp4
mediakit extract-frame clip.mp4 --timestamp 3.5 -o frame.png
```

Every call returns JSON with the output path, size, and verified
duration/dimensions. If a call fails, read the error — it usually tells you
exactly what was wrong (missing file, crop out of bounds, bad format).
The CLI refuses an option a command does not declare (exit 2, e.g.
`unknown option --transitions for command 'concat' (did you mean
--transition?)`) instead of silently ignoring it — a mistyped flag can
never quietly change what a command does. `mediakit <command> --help`
lists exactly the options that command accepts.

## Rules that save you rework

### 1. Probe before you transform
Always `probe` first. A crop of 720×1280 fails on a 640×360 source; a trim
past the end of the file fails too. The probe result is the ground truth.

### 2. Re-encode vs stream copy (trim)
- **Default trim re-encodes**: frame-accurate cuts at any timestamp.
  Slower, slight quality loss (one generation).
- **`stream_copy: true`**: near-instant and lossless, but cuts only land
  on keyframes — the actual cut point can be up to a few seconds off.
  Use it for rough cuts, previews, or splitting long files; use the
  default for publish-ready clips.

### 3. Reframe in one step — don't crop then resize by hand
To turn 16:9 into 9:16: `reframe --mode crop` (default 1080×1920).
`--mode blur` fills the sides with a blurred copy of the frame (the
Shorts look); `--mode pad` uses black bars. Use `--anchor left|right|
top|bottom|...` (or `--x`/`--y`) to pin the crop window when the
subject isn't centered — a subject at the frame edge gets cut by a
centre crop. Crop mode reports `crop_kept_percent` and warns below
40% kept (the result is upscaled and may look soft); prefer `pad` or
`blur` then. `crop` + `resize` remain for exact pixel rectangles only.

### 4. Check before you publish
After the last edit, run `check --platform tiktok` (or `reels`,
`shorts`, `youtube`). It measures the real file — never trust the
tool that produced it. `pass: false` means fix the listed issues
(each carries a hint) and check again; never report "ready" with a
failing check. Add `--content` (`content: true` over MCP) for the final
pass: one decode pass scans for black frames, frozen frames and
silence. Position matters — a 1s black stretch at the very start warns
(likely a fade in), a 3s black stretch mid-file or at the end fails;
3s of mid-file silence warns (run `silence` to remove it), 5s+ fails.
A stream that does not exist reports `unavailable`, never zero.
When the source itself already has defects, pass a `--baseline`
(`baseline` over MCP) — the JSON of an earlier `check --content` run
on the source, or a plain `{black, freeze, silence, peaks}` span list:
spans it covers are reported as `pre_existing` and do not fail the
gate, so only NEW spans fail. A detected interval counts as
pre-existing when it overlaps a baseline span of the same kind by
>= 50% of its own duration.
QC policy tiers (`--policy`, `policy` over MCP, env
`MEDIAKIT_QC_POLICY` as the default): `full` (default) runs every
detector you asked for; `light` runs probe-based rules only and
refuses `--content`/`--baseline`/`--palette` — use it for a fast
pre-flight on a proxy render, and read `complete: false` +
`skipped: ["content", "palette"]` for what it did NOT verify (a light
pass is not a full verification); `skip` runs nothing at all (no
probe, no decode) and returns `pass: true, complete: false` with the
skipped list — the stamp for a cache-hit proxy render, not a check.
Add `--decoded-work` (`decoded_work: true` over MCP) before running a
heavy tool on a big input: it estimates the decode load from the probe
(video pixel-frames + audio sample-channels) and warns when it is over
the ceiling — 250B pixel-frames / 6B sample-channels, plus per-stream
limits (3600s, 8192px, 120fps, 8ch, 192kHz). A 4K60 hour is 1.79T
pixel-frames and will warn; re-encode smaller/shorter first, or split
the job, instead of OOMing mid-render. `doctor` reports the ceilings.
A QC stamp (`--stamp`, `stamp: true` over MCP) writes a sidecar
`<input>.mediakit-check.json` next to the file — the verdict, the exact
args, the media sha256/size, and the ffmpeg/ffprobe versions, written
atomically. `--use-stamp` (`use_stamp: true` over MCP) reuses it
instead of re-running the check when the media, the args and the
toolchain all still match, and reports `stamp.used=false` with the
stale reason (`no_stamp`/`media_changed`/`args_mismatch`/
`environment_mismatch`/`stamp_invalid`) when they do not — a stamp
never overrides a fresh run, it only skips a re-check of an unchanged
file. Both flags are refused under `--policy skip` (a skip measures
nothing, so there is nothing to stamp or reuse). Do not confuse the QC
stamp file with the policy=skip result above, which the docs also call
"the stamp" for a cache-hit proxy render — the QC stamp is a sidecar
file that records a real measurement.

### 5. Even dimensions
H.264 (yuv420p) needs even width/height. `resize` with `keep_aspect`
rounds to even automatically. If you `crop` by hand, use even numbers.

### 6. Detect silence before you cut it
`silence` with `detect_only: true` costs one fast analysis pass and
returns the exact silence intervals plus the kept segments and
`removed_seconds`. Read those numbers first: if `removed_seconds` is
near zero, nothing was worth cutting (the tool then just stream-copies).
If the threshold is wrong (music counted as silence, or room tone kept),
adjust `threshold_db` (−50 is stricter, −30 looser) and re-detect — never
re-cut blind. A cut never clicks: every kept segment gets a 12ms fade out
+ 15ms fade in at the join (`silence` and `cut_words` share the graph),
so a cut mid-word or mid-tone is smooth — verify it on samples, not by ear
alone, when the join matters.

### 6. Loudness: −14 LUFS is the default for a reason
YouTube, Spotify, and TikTok all normalize to around −14 LUFS. Normalizing
to −14 means your audio sounds the same loudness as everything else on the
platform. Use −16 LUFS for podcasts, −23 LUFS only for broadcast (EBU R128).
Two-pass loudnorm (what this tool does): pass 1 measures the input,
pass 2 applies the exact linear gain, then the tool re-measures the
output and reports the real `output_lufs`. It hits the target on
voice and normal mixed audio. On peak-limited input (sub-bass-heavy
music, crest ~20 dB) the true-peak ceiling caps the gain — the tool
gets as close as it can and warns instead of pretending it hit −14;
high-pass the sub-bass or compress first, then normalize again. It is
not sample-exact broadcast mastering. For quiet, high-crest speech
(Kokoro voice at −25.5 LUFS stalls at −15.2 on two-pass alone),
pass `compressor: true` — a gentle compressor (threshold −24 dB,
ratio 4, 1 ms attack) runs before the loudnorm pass and the
compressed signal is measured before the gain is computed, so the
target becomes reachable (−14.3 on wav/m4a, −14.6 on mp3). The 1 ms
attack is the point: speech peaks are plosive transients, and
ffmpeg's 20 ms default lets them straight through. The result
reports `compressor` (settings) and `compressed_lufs`.

### 7. Captions must exist before you burn them
`burn_captions` needs a real `.srt`, `.ass`, or `.vtt` file. If the user
only has raw text, write the SRT yourself first (format below), then burn.
Hardcoded captions cannot be turned off later — keep an uncaptioned master.

### 8. Mutation smoke + ratchet (for contributors, not for callers)
`npm run mutation-smoke` proves the test suite can fail: 4 hand-written
mutants in `src/core.js`, each tied to one named suite assertion. A
survivor fails the run. `npm run mutation-ratchet` gates that run
against the committed baseline `scripts/mutation-baseline.json` — it
fails if the killed count drops below the floor, which is how a mutant
quietly deleted from the registry gets caught. Record a new baseline
only from a fully green run (`--generate-baseline`), then commit it.
Hardcoded captions cannot be turned off later — keep an uncaptioned master.

SRT format (timestamps `HH:MM:SS,mmm`):
```
1
00:00:00,000 --> 00:00:02,500
First line of caption

2
00:00:02,500 --> 00:00:05,000
Second line of caption
```

Keep lines short (≤ 42 chars), max 2 lines per cue, and never let a cue
span a sentence break awkwardly. Font size and position default to the
safe zone and scale with frame height (~60px type on 1080x1920, sitting
~500px above the bottom edge so TikTok/Shorts UI never covers the
text) — pass `--font-size` / `--margin-v` only to override. If a cue
runs long, pass `--max-lines 2` instead of hand-shrinking the font:
the tool measures the real text width (Liberation Sans, the font
libass draws) and shrinks the whole track until every cue fits in 2
lines, never below the readability floor (~31px at 1920 high); a cue
that still overflows burns at the floor and reports `fit.fits=false`,
so split that cue instead of shrinking further. Pass `--platform
tiktok` (or reels/shorts/youtube/...) and the default margin becomes
that platform's own bottom UI depth (tiktok 520px at 1920 high) with
the fit width narrowed to its text-safe rect — explicit `--margin-v`
still wins. `.ass` files carry their own styles, so `--max-lines` and
`--platform` are ignored there (reported in `fit_note`). Style with
`--style`: `background` (default — white text on a semi-transparent
black box, the YouTube look), `outline` (black outline, no box),
`shadow` (thin outline + drop shadow), `glow` (thick halo in the text's
own colour — the one that still reads on bright footage). Pick the style
for the footage, not from habit: white text with no box vanishes on a
bright sky, and the box is what makes the default safe. `.ass` files
carry their own styles, so `--style` is ignored there — edit the `.ass`
directly instead.

### 8. Concat re-encodes — that's a feature
`concat` re-encodes all parts to one codec, so clips with different
resolutions, codecs, or frame rates join cleanly. It is slower than a
stream-copy concat, but it doesn't fail on mismatched inputs.
With `transition`, the join is an `xfade` + `acrossfade` instead of a
hard cut: clips are normalized to the first clip's size/fps, the
transition starts `transition_duration` before the end of each clip,
and the output lasts sum(durations) − (n−1) × transition. The
transition must be shorter than the shortest clip, and every clip needs
a video stream. Verify a transition by pulling frames on both sides of
it (`frames` or `extract_frame`) — never trust the duration alone.

### 9. Convert: copy what you don't need to change
`convert` with no codec arguments stream-copies both streams (a fast
re-mux). Pass `--video-codec libx264` only when you actually need to change
the codec. CRF 23 is a good default for H.264; 18–20 for near-lossless,
28+ for small files. `--encoder auto` uses a working hardware encoder
(nvenc/qsv/vaapi/videotoolbox/amf) when the machine has one and falls
back to software otherwise — the result says which one ran
(`encoder_used`, `encoder_fallback`); a named encoder that cannot
probe-encode fails instead of silently falling back.

### 10. Measure bars before you crop; package last
`cropdetect` samples frames across the whole file (not just the start,
where a fade-in would bias the crop too tight) and reports the most
common rectangle. If `distinct_values` shows several different rects,
the aspect changes mid-clip — crop per segment instead of once.
`package` is the final step after `check` passes: the ZIP's `spec.json`
records the measured probe, loudness, and platform check, so the bundle
itself proves what was delivered. Verify with `sha256sum -c` after
unzipping; never re-zip by hand (the checksums would no longer match).

### 11. Mix voice over music: duck, don't just turn the bed down
A flat `music_volume` buries the voice or leaves the bed inaudible in
gaps. `mix` ducks instead: the bed sits at `music_volume` in gaps and
drops by `duck_db` under speech. Trust `ducking_measured_db`, not the
parameter — the compressor's real reduction depends on the voice level,
so if the measured depth is far from `duck_db`, raise/lower `duck_db`
and re-run. If the voice is much quieter than the bed, level it first
(`loudness` on the voice alone, or `mix`'s own `voice_lufs` levelling).
If the voice file is a video, its video stream is copied through, so
`mix` can be the last audio step before `check`/`package`.

### 12. Look at the video before you cut it
`probe` tells you numbers, not content. `frames` extracts N evenly
spaced frames as separate images with timestamps — read 3–6 of them to
see what's actually in the clip (scene changes, framing, captions
rendering) before choosing trim points or a reframe anchor. `thumbnail`
is the cheaper one-image overview when you only need the gist. Two
refinements: `--sharpest` (both tools) picks the sharpest frame in
each interval/window instead of the interval start — Laplacian mean
measured on disk, each frame reports its score — use it when the
sheet must show the cleanest frame, e.g. a cover frame out of a shaky
pan (flat-colour footage scores ~0 everywhere and keeps the first
candidate, which is correct when nothing is sharper). `thumbnail
--timestamps-list 1,6,0:30` names every tile time explicitly instead
of even spacing (sets the tile count; cannot combine with the delay
percents) — use it when you already know the moments that matter, e.g.
one frame per scene cut. Format tip: for screen recordings or any
text-heavy footage use png (the default) or webp, not jpg — JPEG
chroma subsampling smears 1px text and thin borders, so a jpg frame
can look broken when the video itself is fine.

### 13. Logos go on with `overlay`, not by hand-built filter graphs
`overlay` takes a PNG (transparency recommended), a named position
(`top-right` default, `top-left`, `bottom-left`, `bottom-right`,
`center`), a margin, a width, and an opacity — the x/y are computed
from the probed frame size, so you never spell `W-w-10` and never risk
a filter-expression injection. Use `--start`/`--end` to show the logo
only in a window (e.g. an end-card bug), and `--opacity 0.5`–`0.8` for
a watermark that doesn't fight the picture. The overlay must fit inside
the frame with its margin — if it doesn't, shrink `--width`, don't
force it. Always `extract_frame` afterwards and look at the logo
corner: a logo placed but never seen is the most common silent failure.

### 14. Cut on scene boundaries, not round numbers
`scenes` (probe-only, writes nothing) lists the hard cuts and the
segments between them — trim on those timestamps. The default
threshold 0.3 catches real cuts; a hard cut between flat colours
scores ~0.4, so a threshold above ~0.4 will miss genuine cuts — if
`scenes` returns nothing on a clip you know has cuts, lower the
threshold to 0.2 before concluding there are none. A continuous shot
(testsrc, a static camera) correctly returns zero cuts; zero is a
real answer, not a failure. When the cut changes colour but not
brightness (a hue-only cut), the ffmpeg metric sees nothing at all —
use `--detector content` instead: it scores hue, saturation and luma
separately and catches it (red → dark green, same luma: 0.183 vs the
0.05 default). A 1-frame flash is not a scene: the content detector's
flash filter drops both cuts of the blip. Add `--fades` when the film
opens or closes on black — it reports the fade type, the full ramp
(measured, ±1 frame) and the dark core separately.

### 15. Stream-copy cuts must land on keyframes
A lossless `--stream-copy` trim can only start/end on keyframes — ask
for 1s–3s on a clip whose keyframes are at 0s and 8.33s and ffmpeg
silently widens the cut. Run `keyframes` first (probe-only: timestamps
+ GOP interval) — for a single cut point, `keyframes --nearest <t>`
reports the keyframe before/after that point plus the closest one and
its distance, so you can pick the snap target without scanning the
whole list. Then `trim --stream-copy --snap` to move the start
down and the end up to the nearest keyframes; the result reports the
requested range and the actual range — read both, don't assume. If the
snapped range is wider than you can accept, re-encode instead
(`trim` without `--stream-copy` is frame-accurate). `--snap` without
`--stream-copy` is refused: there is nothing to snap. `--smart-cut`
is the third option (with `--stream-copy` only, refuses `--snap`):
it keeps the exact start by re-encoding just the head up to the next
keyframe at source bitrate ×1.2 and stream-copying the rest — the
result reports `mode` (`smart-cut` / `keyframe-exact` /
`full-reencode`), `next_keyframe` and `head_reencoded_seconds`.
`--snap-beat` is the musical cousin (see §57): it snaps to beats
instead of keyframes, works with or without `--stream-copy`, and
refuses `--snap` and `--smart-cut`.
`--edge-buffer` (0–1s, default 0, Outtake's 0.1s clip-edge buffer)
widens the requested window by that much on both sides, clamped to
the file edges, so a cut never lands exactly on a word or action
onset — the kept clip carries handles instead. It runs before snap,
so a snapped cut snaps the buffered window, and it refuses
`--smart-cut` (which lands the start exactly). The result reports
`requested_start`/`requested_end` plus `edge_buffer_applied` per
side, so you can see how much each edge actually grew (less at the
file edges). A buffer-only trim still verifies: the check compares
against the buffered start, because that IS the requested cut.
Verify it by frame count (exactly round(duration×fps)) and by pixel:
the head frame must match the source at the same content time
(PSNR > 30 dB), the tail frame must be bit-identical. Supported video
codecs: h264, hevc, vp9, av1, mpeg4 — anything else is refused by name.

### 16. Fit the duration before you publish — and read the measured one
A clip that must be exactly N seconds (a 30s ad slot, a 60s Short) gets
`fit --duration N`, not a guessed `trim` or a speed change by hand.
`--method speed` (default) keeps the whole clip and plays it faster or
slower — factor must stay in 0.25–4x, outside that the tool refuses and
tells you to use `trim` (longer source) or `loop` (shorter source)
instead. The result reports `duration_actual` and
`duration_error_seconds` measured with ffprobe — read them; the fit is
only done when the measured error is ~0. Times accept `MM:SS` as well as
seconds (`--duration 0:30`, `trim --start 1:30 --duration 0:05`).
`check` treats video bitrate as a warning, not a gate: a low or oversized
bitrate lands in `warnings` and never fails the check — the platforms
re-encode everything, so bitrate is a quality hint, not an upload
requirement. The check result also reports the platform's text-safe
zone: keep captions inside that rect, clear of the UI chrome.

### 17. Join identical clips with a copy, facecam with pip
`concat` probes the clips first and stream-copies when they match
(codec, size, fps, pixel format, audio) — fast and lossless; when they
differ it re-encodes and tells you why in `fast_skipped`. Read `mode`
in the result: `fast` means no generation lost, `reencode` means the
clips differed. Use `--fast` when the copy is required (it errors with
the exact mismatch instead of silently re-encoding) and `--no-fast`
when you want a fresh encode regardless. `--transition` always
re-encodes and cannot combine with `--fast`. `pip` puts a second video
over the main one (facecam, reaction, before/after): 9 positions,
`--scale` (default 0.25 of the main width) or `--width`, `--opacity`,
`--start`/`--end` for the window, and `--audio main|pip|mix`. The PiP
clip loops inside its window, so a 6s facecam covers a 10s main clip.
Verify a pip with `extract_frame` inside the PiP rect — the pixels
there must match the PiP source at the same timestamp, not the main
clip.

### 18. Open with a title card, not a bare first frame
`titlecard "THE MOON IS LEAVING US"` renders a PNG: big bold hook
(3-6 words, wrapped to short lines) in yellow on an orange box, on a
transparent canvas, sitting in the safe zone. Overlay it onto the first
2.5s with `overlay --image title.png --position center --start 0
--end 2.5`, or use it as the opening card. Default type is ~120px at
1080 wide; pass `--font-size` / `--text-color` / `--box-color` to
match the channel brand.

### 19. One source, every platform: `social`; open with `intro`
`social in.mp4 -o out/` exports the clip to several platform specs in
one call — tiktok, reels, shorts by default (add `instagram-feed`,
`instagram-story`, `linkedin`, `youtube` with `--platforms`): each
output is reframed to that platform's size (`--strategy blur` keeps
the whole frame, default), trimmed to the platform's max duration
(Shorts 180s, Story 60s — `--no-trim-to-max` keeps the full length and
the check then fails duration honestly), normalized to −14 LUFS, and
checked against that platform's spec. Files are named
`<base>-<platform>.mp4` and `manifest.json` records dimensions,
duration, LUFS and check results per platform — read it instead of
re-probing every file. A platform whose check fails still writes its
file; `all_pass` is false and `issues` says why. `intro "Welcome
Back"` renders a 3s opening clip — title on a solid background, fading
in and out (`--duration`, `--bg-color`, `--fade-in`/`--fade-out`);
concat it in front of the main clip. Silent video, no audio track.

### 20. Convert captions, don't retype them; dry-run a mix before you render it
`convert_captions subs.srt -o subs.vtt` (or the reverse) converts
between SRT and VTT — cue text is carried verbatim, never rewritten;
VTT cue settings (`line:`/`position:`/`align:`) are dropped on the way
to SRT and counted in `settings_dropped`. Converting a file to its own
format is refused. `mix ... --dry-run` prints both ffmpeg commands
that would run (render the unmastered mix, then master it with the
measured values — the master command is shown without `measured_*`
values, which the real run fills in after measuring) and writes no
file — read the commands before a long render, then run the same call
without `--dry-run`. The probe and loudnorm measurement still run in
dry-run mode, but they are read-only. Mastering is two-pass: a
single-pass loudnorm chained onto the mix graph undershoots on quiet
voices with long gaps under a bed, so `mix` renders unmastered, measures
the render, and normalises with the measured values; if the result is
still off-target by more than 0.5 LUFS it warns that the mix is
peak-limited instead of pretending the target was hit. The voice is
compressed before levelling (threshold −18 dB, ratio 4:1, attack 1 ms,
peak detection): real speech has ~19 dB crest, so an uncompressed
voice gained to −16 LUFS peaks at +3 dBTP and the master cannot reach
−14 under the −1.5 dBTP cap — it lands ~0.5 LU short. A 20 ms attack
lets plosive transients slip through, so the attack must stay at 1 ms.

### 21. Find the file before you probe it; content-check the final render
Don't guess paths: `find clips/ --name moon` searches a folder tree
(case-insensitive substring, skips `.git`/`node_modules`/hidden dirs)
and returns each match with probe info (duration, dimensions, codecs)
— pick from that list instead of typing a path from memory.
`--extensions mp4,mov` narrows the search; `--max-results` caps the
returned list while `total_matches` still reports the full count.
For the final render, `check --content` (rule 4) catches what the
spec checks cannot see: black holes, frozen video and dead air — all
three from one decode pass, judged by where they sit in the timeline.

### 22. Animate SVGs in code, not in the browser
`svg_animate` turns an SVG into a video with no browser: give it
`animations` — a list of `{target, property, from, to, start, end,
easing, center?}` where `target` is an element `id` and `property` is
`translate` (`[x, y]`), `scale` (number or `[sx, sy]`), `rotate`
(degrees, about `center` `[cx, cy]`, default 0,0) or `opacity` (0–1).
ffmpeg cannot play SVG animation (librsvg renders one static frame),
so Node interpolates every frame and muxes the sequence — the tool
needs the `librsvg` decoder (`doctor` reports it). Semantics that
matter: before a window opens the element sits at the first
animation's `from` value (a slide-in starts off-screen, a fade-in
starts invisible); the last started window governs and holds at `to`
after it ends; adjacent windows on one element+property chain (down
then up = a bounce) when the boundary values match. A missing target
id is reported in `missing_targets`, never fatal. SVG `<text>` renders
with the system font (DejaVu Sans) — keep it short. Size comes from
the SVG's own width/height/viewBox unless `--width/--height` override
it; `background` (default white) paints an opaque rect first because
video has no alpha.

### 23. Compress by name, receipt the finished file
`compress` shrinks a file with one named preset instead of a guessed
CRF: `low` (CRF 32, veryfast, 96k audio), `medium` (CRF 26, medium,
128k), `high` (CRF 20, slow, 192k). `--crf` / `--preset` override the
preset's values when you need them. `--max-width` scales the video
down first (only when the source is wider). Read `reduction_percent`
in the result — it is measured on disk and can go negative: a source
already encoded at a very low bitrate can come out bigger at medium
or high, and the tool says so instead of pretending it shrank.
Audio-only input is re-encoded at the preset's audio bitrate.
When a platform caps the size (Discord 10/25 MB, GitHub PR 10 MB),
use `--target-size <MB>` instead of a preset: two-pass ABR encoding
from the size + duration budget, with a 10% safety margin, and the
result reports `target_met` measured on disk. It ignores `--quality`
and refuses `--crf` outright (the bitrate comes from the size, not a
CRF). A target below the floor (100 kbps video + 128 kbps audio) is
refused with the minimum size spelled out — raise the target or
`--max-width` the video down first. The margin is 10% because
two-pass ABR overshoots on hard content: downscaled testsrc ran
+6.5–8.4% over its video bitrate at 480p while 720p landed within
0.2% (measured 2026-11-13) — a 2% margin let the 1 MB case land
over target. `--quality email-25mb` is shorthand for a target of
18 MB (25 MB Gmail limit ÷ ~1.37 base64 inflation), for files that
will be emailed as attachments. Target-size mode also returns a
`quality_proof`: SSIM measured against the source at 3 sample points
(10% / 50% / 90% of duration) plus PSNR-Y mid-clip, and a verdict in
words — `indistinguishable` (SSIM ≥0.99), `looks_the_same` (≥0.97),
`slight_softening` (≥0.95), `visible_loss` (≥0.90),
`clearly_degraded` (below). VMAF is not in this ffmpeg build (no
libvmaf — `doctor` reports it), so SSIM is the measured proxy and the
proof says so. The proof rates encode fidelity at the delivered
resolution: the source is scaled to the output size before comparing,
so it does NOT penalize the resolution ladder — a smaller frame is
easier to encode, and on hard content a 426x240 encode can score
higher than the same bitrate at 720p (measured 2026-11-17). Compare
`dimensions` + `bpp_after` across targets for the resolution
tradeoff, not SSIM alone. `--no-quality-proof` skips the measurement
(audio-only input has no frames to compare, so its proof is null
with a note).
`extract_audio --whisper` is the Whisper ASR preset: 16 kHz mono WAV
(the output is renamed to .wav when needed, and the real path is
reported) — the direct input for a transcribe step.
`receipt` writes a provenance JSON sidecar for a finished file:
probe, SHA-256, size, measured loudness, optional `--platform` check
result, and the exact ffmpeg/ffprobe versions. Keep the receipt next
to the file; `sha256sum` against it proves the media has not changed
since it was written. `package` already embeds the same receipt
inside its ZIP — use `receipt` when the file is delivered on its own.

### 24. Swap the audio track with `mux`, don't re-encode the video
`mux` replaces a video's audio track with an external audio file and
stream-copies both streams — no re-encode, so it is fast and the
picture is bit-identical. The video's original audio is dropped, not
mixed in: run `mix` first if you want voice over the original sound.
`--audio-offset` shifts the new audio against the video (positive =
audio starts later, negative = video starts later; the result reports
the offset, and the stream `start_time` on disk proves it). Use
`--shortest` when the replacement audio is shorter than the video and
you want the output to end with it. `--dry-run` prints the exact
ffmpeg command and writes no file — inspect it before you render.

### 25. Write captions from data with `generate_srt`, and sandbox paths with `MEDIAKIT_WORKDIR`
`generate_srt` builds a deterministic .srt from a cue list
`[{start, end, text}]` — pure text, no ffmpeg, the counterpart of
`convert_captions` and the input `burn_captions` wants. Times accept
seconds or `MM:SS`; cues must be in timeline order and must not
overlap (touching is fine); text may span lines with `\n`. On the CLI
the cues come from a JSON file (`--cues-file cues.json`, array or
`{"cues": [...]}`); over MCP they are passed directly.

Prefer word timings when you have them: pass `words`
`[{start, end, word}]` (CLI: `--words-file words.json`) instead of
cues, and `generate_srt` groups them into semantic cues — max 8
words, 3.5s, 84 characters per cue (2 lines of 42); splits on pauses
over 0.4s and on sentence ends; a cue never ends on a stranded word
like "the" or "of". The result returns the grouping report
(`words_in`, `cues_out`, `split_reasons` per cue), so you can see why
each cue split instead of trusting a silent regroup. Pass cues or
words, never both. This is the stickman-video-director grouping rule,
adapted to Shorts line lengths.

When `MEDIAKIT_WORKDIR` is set, every user-supplied input/output path
must stay inside that directory — `..` traversal and symlink escapes
are refused with `SANDBOX_ESCAPE`, and `doctor` reports the sandbox
state (`enabled`, `workdir`, or an `error` when the directory is
missing). Unset, there is no restriction (the default). Internal
scratch (ffmpeg passlogs, svg temp frames) is exempt; only paths the
caller supplies are checked.

### 26. GIFs for READMEs: `export_gif`, and read the retry line on errors
`export_gif` turns a clip (or a `--start`/`--end` segment) into an
animated GIF with a two-pass palette — the palette is built from the
actual frames, so colours stay true at a much smaller size than a
single-pass GIF. It fits under `--max-size-mb` (default 10 MB, the
GitHub README limit; Slack only auto-plays GIFs under ~2 MB) by
stepping down fps, then width, then palette colours; each attempt is
measured on disk and the result reports `size_budget_met` honestly —
when the budget cannot be met even at 320px/8fps/64 colours, the
result says so with a `warning` instead of silently shipping an
oversize file. Defaults are 15fps at 640px wide.

When a call fails, the error ends with the exact retry command: the
CLI prints `Retry: mediakit <the command you ran>` on stderr, and an
MCP error carries `retry: {tool, arguments}` with the identical call.
Re-issue that call (after fixing the flagged argument) instead of
reconstructing the command from memory. But first read `retryable`:
every error carries it — `true` means the identical call has a real
chance of succeeding (a transient failure: HTTP 429/5xx or a timeout
on download, the render-job gate), `false` means repeating the call
unchanged cannot help (bad arguments, a missing file, a bad filter, a
corrupt input — fix the call instead). When the failure named a wait,
`retry_after_seconds` carries it (the server's `Retry-After`, or the
admission gate's computed wait); the CLI prints it as
`(retryable: true — retry in ~7s)`.

### 27. Cap fps with `fit --max-fps`, and read `doctor`'s fix line
Speeding a clip up also raises its frame rate — a 2x speed-up turns
30fps into 60fps, because the same frames now play in half the time.
`fit --max-fps <n>` caps the *output* frame rate (1–120) by dropping
frames, and it is measured against that effective fps, not the source
fps. It only ever lowers fps: asking for 60 on a 30fps source (or on a
2x speed-up that already runs at 60fps) applies no filter and reports
`fps_capped: false`, instead of duplicating frames up to the cap. The
result reports `fps` measured on disk, so verify the cap landed.
When `doctor` reports a tool `available: false`, read its `fix` field —
one sentence with the install command for a full ffmpeg build — instead
of working around the missing capability.

### 28. Resize by preset name, and never upscale by accident
When the target is a standard size, say it by name: `resize --preset
720p` (360p=640×360, 480p=854×480, 720p=1280×720, 1080p=1920×1080,
2160p=3840×2160). The preset fits the frame inside that box preserving
aspect ratio, and it never upscales — a 1280×720 source asked for 1080p
stays 1280×720 and reports `scaled_down: false`, instead of blowing up
to 1920×1080 with no new detail. Use `--width`/`--height` only when you
need exact pixels, and never combine them with `--preset`.

### 29. Set the GOP when you convert, and drop SFX at timestamps in `mix`
A stream-copy cut can only land on a keyframe, so a file with a 250-frame
GOP is nearly uncuttable — set the interval at convert time: `convert
--video-codec libx264 --gop-seconds 2` (or `--gop 60` in frames) puts a
keyframe every 2 seconds, exactly (scene-cut keyframes are disabled for
libx264/libx265/mpeg4), and the result reports the measured gap stats —
verify them before you trust a snap. `--gop` needs a re-encode; with
stream-copy it is refused. For sound design, `mix --sfx <file>@<s>`
(repeatable, max 16, optional `[@<volume>]`) drops a short sound at an
exact timestamp — a sting, whoosh or ding — mixed in *after* the ducking,
so it punches through instead of being ducked with the bed. A timestamp
past the voice end is refused rather than silently cut; the mix still
masters to target LUFS and still reports the measured ducking.

### 30. Transcribe locally — never upload speech to get captions
When the words already exist as recorded speech, don't type them:
`transcribe speech.mp3 -o subs.srt` runs a local ASR engine on this
machine (no cloud, audio never uploaded) and writes the .srt — the
direct input for `burn_captions`. `tiny` is fast and fine for clear
speech; `base` / `small` are more accurate; `large-v3-turbo` is the
slow, accurate end. Two engines: faster-whisper (default, pip install
in a venv, point `MEDIAKIT_ASR_PYTHON` at that python) and whisper.cpp
(`--engine whisper`: the whisper-cli binary + a ggml model, via
`MEDIAKIT_WHISPER_CPP_BIN` / `MEDIAKIT_WHISPER_MODEL`, or the default
`~/.local/share/mediakit/whisper.cpp/` install); `auto` prefers
faster-whisper, then whisper.cpp. The engine is optional: on a machine
with no engine the call fails with install lines instead of guessing.
`doctor` reports the engine state, but a missing engine never fails
`doctor` — everything else still works. Silence transcribes to 0
segments and an empty .srt: that is a correct result, not a failure,
so don't re-run it hoping for words. For long recordings add
`--chunk-seconds 300` (5–1800s): the audio is split into chunks with a
2s overlap and the segments are re-offset onto the full timeline, so an
hour-long file transcribes without one giant ASR run — a file shorter
than one chunk runs as a single chunk. A phrase straddling a boundary
may repeat (the overlap is heard twice, kept once per owned window),
so chunked text is not word-exact against an unchunked run; use it for
long files, not for a 30-second clip.

### 31. Trim clips inside concat — never trust the demuxer's inpoint
To join only part of each clip, write the input as `path@start-end`
(CLI) or `{file, start, end}` (MCP) — times in seconds or MM:SS, either
side may be empty (`a.mp4@2-` keeps from 2s to the end). Trims are cut
with `trim`/`atrim` in one filter graph and joined with the `concat`
filter, so they are frame-accurate — and they always re-encode: the
concat demuxer's `inpoint`/`outpoint` does NOT cut accurately (measured
2026-11-12: 2–5s + 1–4s stream-copied 8.09s instead of 6s), so `--fast`
refuses a trim outright instead of silently snapping to keyframes.
Trims also work with `--transition`: the fade is computed on the trimmed
timeline. To pull one channel out of a stereo (or multi-channel) file,
use `extract_audio --channel <n>` (0-based) — it returns that channel as
mono through `pan`; the index is validated against the probed channel
count, so `--channel 2` on a stereo file is refused instead of guessing.

### 32. Grade by name, and let `check --content` catch clipping
`grade in.mp4 --preset warm -o out.mp4` applies a fixed look — `warm`
(red up, blue down), `cool` (the opposite), `cinematic` (contrast up,
saturation down, slight teal), `noir` (black and white), `vintage`
(faded, desaturated) — or one custom filter chain with `--filter`
(mutually exclusive with `--preset`). The result reports the mean R/G/B
of the middle frame before and after: read those numbers, don't assume
the look landed — a preset that barely moves the frame mean is a broken
preset, not a subtle one. When the look is numeric (a colourist's CDL,
a matched grade), use `--cdl-slope` / `--cdl-offset` / `--cdl-power`
`r,g,b` + `--cdl-saturation N` instead of guessing a filter chain:
slope 0–4, offset −1–1, power 0.1–4, saturation 0–4 (0 = grayscale),
mutually exclusive with `--preset`/`--filter`. It runs through a
per-channel LUT (near realtime); `geq` does the same math at 7.7x
realtime, so it is not used. Verify on the before/after means — slope
1.5 on red moves a flat-gray frame's R mean 128→~192. `check --content` now also scans audio peaks
in 0.1s windows above `--peak-threshold` (default −1 dBFS): a window at
or above 0 dBFS fails as digital clipping, anything above the threshold
warns — lower the level (or re-record the clipped stretch) instead of
shipping it. On a long file, `--start`/`--end` scan only the suspect
range; intervals are still reported on the file's own timeline, and an
interval that ends at the scan boundary is flagged as such — it is only
known to last that long.

### 33. Reverse is a real effect, not a trick — and the GPU list is not a promise
`reverse in.mp4 -o backwards.mp4` plays the clip backwards: video frames
reversed, audio reversed too by default (`--no-audio` keeps the audio
playing forward under reversed video). It also works on audio-only
input (reverses the audio alone) — handy for a rewind sting or reversed
audio in sound design. The `reverse` filter buffers every frame, so keep
it to short clips; an hour-long file will eat memory. `doctor` now also
reports a `gpu` section: hardware encoders present in the ffmpeg build
(nvenc / vaapi / qsv / videotoolbox / amf) plus which one, if any, passed
a tiny probe encode. A build that merely *lists* `h264_nvenc` without a
working device reports `gpu.available: false` — listed is not usable, so
never pick a hardware encoder from the list alone; pick it from
`working_encoder`, or stay on libx264.

### 33b. A loop is a crossfade, not a copy — and the seam gets a number
`make-loopable in.mp4 -o loop.mp4 --overlap 1` makes a clip repeat
without a jump: it splits the clip into head/mid/tail, then lays the
head fading in over the tail (alpha fade + overlay — `xfade` refuses
trimmed branches because they lose constant-frame-rate metadata), and
puts that seam after the mid. The output ends on the head's last frame,
exactly where the mid begins, so the player jumping back to the start
flows into the next frame of the original motion. Audio gets the same
treatment with `acrossfade`, so the beat does not click. The cost is
length: the output is the overlap shorter (10s + 1s overlap = 9s).
Default overlap is 0.5s; 0.3–0.5s is enough for slow motion, 1s helps
when the start and end poses differ a lot, and past about a quarter of
the clip the crossfade ghosts the picture. The tool measures the loop
instead of asking you to eyeball it: `seam_before` vs `seam_after`
(mean abs gray difference between the last and first frames) with
`normal_step` (two neighbouring mid frames) as the baseline — a good
seam lands at the normal step. Two measurement traps, both caught the
hard way: `blend=all_mode=difference` on YUV inputs does NOT return
the gray difference (red-vs-blue reads 28 there, 47 is the true
number), so both branches are converted to rgb24 first; and two-input
`-ss` seeking is non-deterministic (same command returned 76 once and
nothing the next time), so the seam is measured with trim branches in
one graph. Works on audio-only input too (acrossfade only, seam scores
null); in `batch` and `manifest` like any other op.

### 33c. A freeze is an insert, not a still image — and the frame is picked by index
`freeze in.mp4 -o out.mp4 --at 5 --hold 2` holds one frame still for
2 seconds: the output is pre [0,at] + hold + post [at,end], so the clip
grows by exactly the hold and the tail keeps its place. `--at` defaults
to the end of the clip (hold the last frame — the end-card use). Audio
in the hold is silence, by decision: audio "keep" would leave the video
D+hold long against D seconds of audio and force trailing silence to
fill the gap. The silence is built from the input's own audio (a 10ms
slice at volume 0, `apad` to the hold) so sample rate and channel layout
always match the concat. The tool measures the freeze instead of asking
you to eyeball it: `frozen_frame_diff` (input frame vs output frame
mid-hold, ~0 when truly frozen) and `post_frame_diff` (the frame after
the freeze point in the input vs the same frame in the output tail, ~0
when the tail kept its place; null when the hold sits on the last
frame). Two traps, both caught the hard way: real PTS sits ~0.3ms off
nominal frame boundaries, so a time-window trim can silently yield zero
frames (the output kept the right duration only because the audio
carried it — `ffprobe -count_frames` is the honest check), so the frozen
frame is picked by index with `select='eq(n,299)'`; and inside that
quoted expression the comma needs NO backslash — `eq(n\\,299)` makes the
expression parser see one escaped comma and fails.

### 33d. A boomerang drops the pivot frame — or the peak plays twice
`boomerang in.mp4 -o out.mp4` plays a clip forward then backwards, so
a bounce, swing or wave returns to where it started with no cut. The
naive version ends the forward half on the last frame and starts the
reversed half on that same frame, so the peak frame plays twice and
the motion visibly stutters at the turn — moviepy v2.2.1 fixed
exactly this clipping in TimeMirror. The tool trims one frame at the
pivot: the reversed video branch drops its first frame
(`trim=start_frame=1`, the original's last frame) and the reversed
audio branch drops one video-frame of audio (`atrim=start=1/fps`) at
the same point, so the output is 2D − 1/fps. Audio-only input has no
video frame to pivot on, so it plays forward + reversed whole (2D).
The tool measures the seam instead of asking you to eyeball it:
`seam_diff` (output frame just before the seam vs just after it)
against `normal_step` (two neighbouring mid-forward frames) — a good
seam lands at the normal step, and the frame count (2N−1) is the
honest proof the pivot frame was dropped, since duration alone
cannot tell a duplicated frame from an adjacent one.

### 33d2. Rotate what the viewer sees, not the stored pixels — and strip the matrix
`rotate in.mp4 -o out.mp4 --angle 90` turns the clip 90° clockwise
(180/270 too), `--flip horizontal|vertical` mirrors it instead —
exactly one of `--angle`/`--flip`. The angle applies to the frame
the viewer sees: ffmpeg autorotates on decode, so a phone clip coded
1280×720 with rotation 90 rotates from its 720×1280 display size
(90° gives 1280×720, 180° keeps 720×1280). The trap is the second
rotation: transpose the stored pixels of a rotated file and the
display matrix survives, so the player rotates the already-rotated
picture again. The re-encode drops the matrix and any `rotate` tag,
so the output reports `rotation: null` — check `input_rotation` vs
`output_rotation` in the result instead of trusting the command
line. 180° is `hflip,vflip`, not two transposes. `--metadata-only`
rewrites only the display-matrix metadata instead (stream copy, no
re-encode — instant and lossless, coded video packets verified identical
on disk): the angle ADDS to the rotation the input already carries
(90° on a rotation-90 clip gives 180°; 270° on it strips the matrix
to null). mp4/mov/mkv only (webm has nowhere to store the matrix),
angle only, no flip. Works in `batch`
and `manifest` like any other op; audio-only input is refused
(nothing to rotate).

### 33d3. Crop, reframe, and resize preset measure the display frame
The same autorotation rule governs geometry: `crop`, `reframe`, and
`resize --preset` validate and compute against the display size
(`probe`'s `display_width`/`display_height`), never the coded size.
A phone clip stored 1280×720 with rotation 90 is a 720×1280 frame
to every filter — so `crop --width 720 --height 1280` is a legal
full-frame crop while `1280x720` is refused ("exceeds display
720x1280"), `reframe --mode crop` to 1080×1920 keeps 100% of it
instead of 31.6% with a false softness warning, and `resize --preset
720p` fits it to 406×720 instead of stretching it to 1280×720.
Results report `source_dimensions` (display) + `source_rotation`
(`reframe` reports `source` + `source_rotation`); on an unrotated
clip these equal the coded size and rotation is null.

### 33d4. Concat, PiP, and overlay measure the display frame too
The same rule, three more tools. `concat` compares clip sizes on
display dimensions: a stored-1280×720 clip with rotation 90 displays
720×1280, so joining it with an upright 1280×720 clip is a size
mismatch — auto re-encodes through the filter graph (normalized to
the first clip's display size, second half upright) and `--fast`
refuses it naming the display size. Two clips with the same display
size but different stored orientation also refuse `--fast` (stream
copy cannot re-orient a clip) — and they go through the filter graph
too, because the demuxer re-encode applies the first clip's rotation
to every clip: an upright second clip came out rotated 90° and
stretched (PSNR 3.1 dB vs the correct picture), even though both
clips decode to the same frame size. The
transition and trim paths normalize to the first clip's display
size — a rotated first clip no longer pillarboxes into landscape.
`overlay` and `pip` position and fit on the display frame: on that
rotated clip, top-right 120px lands at 576,24 (not 1136,24 — the old
stored-size math put the logo outside the 720-wide frame and ffmpeg
silently drew nothing, output byte-identical to a plain re-encode),
and a rotated PiP clip keeps its portrait aspect (320×568, not
320×180 squashed). All three report `source_dimensions` +
`source_rotation`; `concat` also reports `normalize_dimensions`.

### 33e. Verify a render against its receipt — and dry-run a cut before you render it
Every full `assemble` render writes `assemble-receipt.json` next to
`final.mp4`: per-input digests (manifest, voice, music, captions,
sfx, shot assets), the combined fingerprint, the output sha256 and
measured duration/frames/dimensions/LUFS. `verify <receipt>` re-hashes
everything on disk and reports `matched`/`changed`/`missing` per item
with a `pass`/`fail` verdict and the first difference — run it on any
render you must trust (report videos, deliveries) and whenever a file
has been edited since the render: a swapped voice fails on `voice`,
a zeroed hash fails on `output_bytes`. `verify --rerender` re-runs
assemble from the recorded manifest and compares the new receipt
against the old one — on this machine renders are byte-identical, so
it is a real reproducibility proof (across machines only the measured
properties are comparable). The rerender reuses the content-addressed
shot cache, so it proves join/audio/mux determinism + cache integrity;
delete `.mediakit-assemble-cache` next to the manifest to force fresh
shot builds. Before any cut, `trim`/`resize`/`convert`/`crop` all
take `--dry-run`: the exact ffmpeg command(s) that would run, no file
written — three commands for `trim --smart-cut` (head re-encode, tail
copy, concat), one for the rest. `loudness`/`grade`/`rotate` take it
too: `loudness` prints the two-pass loudnorm command (two commands
with a compressor — render the temp, then normalize; the loudnorm
`measured_*` values come from the uncompressed input, because the
real run re-measures the compressed temp first), `grade` prints its
filter chain with the input's real `color_before` (`color_after`
null — measured on the real output), `rotate` prints the transpose
with the expected display size (`360x640` for a 90° turn of a
640x360 clip). The same flag also works on `reverse`/`reframe`/
`fit`/`silence`/`extract_audio`/`fastforward`/`interpolate`/`denoise`/
`segment`/`mix`/`mux`/`overlay`/`pip`/`chroma_key`/`burn_captions`/`concat`:
`overlay`/`pip` print the exact display-frame geometry (576,24 on a
rotated clip), `chroma_key` prints the key/composite command with the
measured alpha fields null, `burn_captions` prints the subtitles
command with the exact computed font/margin. `cut_words --dry-run`
prints the cut plan instead of a command. The plan is computed from real probes
(the keyframe list for `--snap`, the GOP for `--gop`), so a dry-run
that prints the wrong cut is a bug, not a guess — read the command
before you run it. Batch 5 (lượt 116) completes the mutative set:
`make_loopable`/`freeze`/`boomerang`/`zoom_pan`/`image_to_video`/
`slideshow`/`compress`/`export_gif`/`titlecard`/`intro` all take it.
`make_loopable`/`freeze`/`boomerang` print one exact command each with
the overlap/pivot/frame-index computed from real probes (seam scores
after the cut stay null — they are measured on the real output).
`compress` prints one command in quality mode and both passes in
target-size video mode (pass 1 analyses to null, pass 2 encodes at
the computed bitrate — the passlog path it names is removed, because
a dry-run writes nothing). `export_gif` prints only the first ladder
step's command and lists the whole 8-step ladder — later steps only
run when the budget needs them. `slideshow` prints one exact command
per slide clip plus the exact xfade join command (built by the same
builder `concat --transition` runs) and the exact audio command when a
bed is given — run the three stages in order to reproduce the real
output. `concat` takes it too (lượt 117, closing the dry-run set):
the demuxer path prints one command plus `list_file`/`list_content`
(write the content to that path first, then run the command as-is),
the transition and trim paths print one exact filter-graph command.
`titlecard`/`intro` print the exact
command and keep the drawtext text file next to the output (so the
printed command runs as-is) but write no output file.

### 33f. Diagnose the film before you render it — validate is format, diagnose is judgement
`assemble --mode validate` is the format gate: it throws on the first
hard error and says nothing about quality. `diagnose <film.json>` is
the judgement gate — run it after writing the manifest and before
`approve`/`render` (and `verify` after the render). It measures what
validation cannot: real motion inside each video shot's exact window
(a frozen video is an error, not a warning — a still wearing a video's
clothes), source geometry vs the film frame (upscale over 2x softens,
a source fps below the film fps duplicates frames), the visual seam
across each transition (near-identical frames mean the transition
adds nothing — a cut would do), voice loudness (warns below −30 or
above −8 LUFS), caption coverage and gaps, music loop count (over 3x
the seam will be heard), sfx tails past the film end, chapters that
land mid-shot, and text layers that wrap past 4 lines or sit at the
bottom in the burned-caption band. It also scores style pace when a
`style.json` is present — cuts per minute + longest hold of the film's
planned shots, against the pace the style keeps (see §33h). And it
scores per-shot pacing (Yuuhann1999/agent-storyboard's
`inspectPacingDetailed`): a run of 3+ consecutive shots with the same
look (a canvas template, else the shot kind) warns — check the visual
variety is enough; a shot under 1s is too short to see clearly, over
15s the hold may be too long; dialogue denser than 15 chars/s warns —
listen to check the speed. A shot's dialogue is its caption text
inside the shot's film window, split proportionally when a cue spans a
cut. The 15 chars/s bar is calibrated, not copied: their 6 is for
Chinese dialogue (one character = one syllable), while Kokoro
af_heart speed 1.0 English narration measures 10.8–14.0 chars/s — 6
would warn on every normal English film. `.ass` captions are styled,
so density is not measured for them. Probe-only by default — it writes
nothing unless `--stamp` is given. A broken manifest returns verdict
`fail` with `format_error` instead of throwing, so fix the manifest and
re-run diagnose in a loop — a `warn` verdict is still renderable, a
`fail` is not. A QC stamp (`--stamp`, `stamp: true` over MCP) writes a
sidecar `<film>.mediakit-diagnose.json` keyed on the film fingerprint
(manifest + voice + music + sfx + captions + assets + brand) plus the
style file hash and the ffmpeg/ffprobe versions; `--use-stamp`
(`use_stamp: true` over MCP) reuses it instead of re-running the
preflight when the film, the style and the toolchain all still match,
and reports `stamp.used=false` with the stale reason (`no_stamp`/
`film_changed`/`environment_mismatch`/`stamp_invalid`) when they do
not — a stamp never overrides a fresh run.

### 33g. Chapters come from measured pauses — never guess a timecode
A chapter list is only useful when its times are measured, not
guessed. `chapters` builds one two ways, exactly one source per call:
`--words-file <talk.words.json>` (from `transcribe
--word-timestamps`) splits the transcript wherever the gap between two
words reaches `--min-gap` (default 2s) and titles each chapter from
the first `--title-words` words spoken in it (default 4, capitalised,
trailing punctuation stripped); `<input>` (a media file with audio)
runs `silencedetect` and starts a chapter at each speech segment that
follows a silence of at least `--min-gap`, titled `Part 1..N` (no
words to name from). The first chapter is always at 0 — YouTube
requires the first chapter at 0:00, so when the first word/speech
starts later the chapter is clamped to 0 and reported
(`first_chapter_clamped_to_zero`). Over `--max-chapters` (default 32,
the assemble cap) the closest neighbours merge first — the smallest
pause is the least likely boundary. The result is the assemble
manifest shape `{title, at}`, so it drops straight into `film.json`'s
`chapters`; `-o <chapters.json>` also writes that JSON to a file.
Probe-only unless `-o` is given. Measure the boundary you care
about first: a silence that measures 0.998s does not split at
`--min-gap 1` — check `silence --detect-only` when a chapter is
missing. And a download's provenance is the same idea for footage:
every `download` writes `<output>.provenance.json` next to the file
(source URL, final URL, redirects, content-type, SHA-256, versions) —
the license is the caller's `--license` declaration, or `unknown`
when none was given, never guessed from a filename or a domain;
check the source before publishing. The URL never supplies the
filename — only a validated extension is taken from it; a server's
`Content-Disposition` filename is ignored, so a hostile URL cannot
steer bytes outside the output the caller asked for.

### 33h. A style keeps its pace as numbers — measure it, then let diagnose score the edit
A channel's cutting rhythm is not a feeling: it is cuts per minute
and longest hold, measured from a video whose cutting the channel
already likes. `measure_pace <reference.mp4>` counts the reference's
hard cuts (content detector by default — the hue/sat/luma split, so
hue-only cuts count too) and reports `{seconds, cuts, cuts_per_min,
avg_shot_s, longest_hold_s, longest_at}`; `--style-file style.json`
keeps those numbers as that style's pace (created if missing, pace
block replaced, other keys kept). `diagnose` then scores the film's
*planned* pace — cuts per minute from the shot boundaries, longest
hold from the longest shot — against it: cuts within 2x of the style
either way, longest hold over style x1.5 *and* +2s, each a warning
with a fix ("Tighten the pauses, or cut to B-roll" / "Cut a pause in
it, or cut to B-roll for part of it"). The style file is found by an
explicit `--style-file`, or the `style.json` sitting next to the
film — `init_project` scaffolds one with starter defaults (10
cuts/min, longest hold 12s, the same bar as `qa_report`'s avg-shot
≤6s rule). Films under 15s are too short to compare — diagnose says
so instead of scoring noise — and a style with no pace block says so
instead of passing silently. A broken style file fails diagnose: a
style that cannot be read must not silently score nothing.
`measure_pace` is also a probe-only batch operation and manifest step
(measure only — the style-file write is not exposed there, so a batch
never last-wins one style file).

### 34. Resources are the map, tools are the hands — and the map never leaves the workspace
Before guessing a path, read `videos://list` (every media file under
the workspace root, sorted, capped at 200), then `videos://{file}/metadata`
for the probe of the one you picked — nested paths work
(`videos://test/nested/deep-clip.mp4/metadata`) because the template
uses `{+filename}` reserved expansion; a plain `{filename}` only
matches one path segment, so nested files would 404. `videos://workspace/info`
gives the root, versions, tool availability and media count in one
read. The root is `MEDIAKIT_WORKDIR` when set, otherwise the process
cwd — and resources are confined to it unconditionally: `..`, absolute
paths and symlink escapes are refused even with the sandbox off. A
resource URI is how a client *looks*; it is never a way to reach
outside the workspace.

### 35. Batch a folder with one call — and trust the rows, not the count
When the same operation belongs on many files, use `batch`, not a loop
of single calls: one glob (`**/*.mp4`, or a bare `*.mp4` for every match
at any depth), one args object for all files, outputs
`<stem>-<operation>.<ext>` under the output dir, mirroring the input
tree. Read the per-file rows, not just the summary counts: `ok` carries
the operation's own measured result, `error` names the file and the
reason, `cached` means the content-hash cache already held that exact
input + operation + args (verified against the cached output's size +
sha256, so a hand-edited output is re-run, never reported as done),
`skipped` means the run stopped or the shared timeout expired before
that file started. A second identical run re-encodes nothing — if it
does, something changed: the input bytes, the args, or the cached
output. A mistyped arg fails every file identically and aborts after
three leading failures in sequential mode — that is the guard working,
not a broken folder. `hook` is the probe-only operation: it writes no
file, so a row's `output` is null and the ranked windows come back in
the row's `result` — batch is how you find the best hook in every clip
in a folder in one call, and the cache stores the result (the key
already covers the input bytes) instead of a file. Keep the output dir outside the input tree when
you can (files under it are never treated as inputs), and use
`--dry-run` first when the glob is new, so you see the planned outputs
before anything encodes. `slideshow` is the exception: a set operation
— the whole matched set of images (2–32) becomes ONE slideshow video
(`output_name`, default `slideshow.mp4`), not one output per file, and
the per-file cache does not apply (the summary says `cache: false`).

### 36. Smooth motion and clean noise are measured effects, not flags
`interpolate` only raises the frame rate — 30fps to 60fps with
`minterpolate`. `blend` (the default) is fast and cross-fades
neighbours; `mci` is true motion compensation and looks best, but runs
about 9x realtime on CPU, so use it on short clips or accept the wait.
A target at or below the source fps is refused (lowering fps is `fit
--max-fps`). `denoise` takes a 0–1 strength: `hqdn3d` (fast default)
maps it to 0–30 — 0.5 is 15, the level that gained +2.9 dB PSNR on
sigma-10 noise in testing — while `nlmeans` maps it to `s` 0–10 and is
far slower (minutes for a few seconds of 720p); pick `nlmeans` only
for short clips or fine detail worth the wait. Both tools report a
measured effect on the output file (frame counts for `interpolate`,
high-frequency noise energy before/after for `denoise`) — read those
numbers, don't assume the filter worked.

### 37. HLS segments follow the keyframes, not the clock
`segment` writes a VOD playlist (`index.m3u8` + `.ts` segments) into
a directory. Stream-copy is the default and is fast and lossless,
but a segment can only start on a keyframe: with a sparse GOP the
segments are longer than `--segment-time` asks for (a fixture with
keyframes every 8.333s gives 8.333s + 1.667s segments for a requested
2s). That is correct HLS behaviour, not a bug — the tool reports the
measured durations parsed back from the playlist, so read
`segment_count` and `segments` instead of assuming the grid.
`--reencode` re-encodes to libx264/aac with forced keyframes every
segment, so the segments land exactly on the requested grid (5 x
2.000s for a 10s clip at `--segment-time 2`). Copy mode refuses a
non-H.264 video or non-AAC/MP3 audio up front — use `--reencode`
for those sources. Serve the output directory statically; any
player that speaks HLS plays `index.m3u8`.

### 38. Finish with a publishing kit, not just a file
After the final video is approved, `publish_kit` turns it into a
publishing pack: from the video + a 1280×720 16:9 thumbnail + copy
you write (exactly 5 distinct titles, description, 1–30 tags, one
pinned comment, optional chapters), it writes `metadata.md` +
`publishing.json` and reports a pre-publish checklist. It verifies
what it can — thumbnail size, title count/distinctness/length,
chapter times against the measured duration, SHA-256 of media and
thumbnail — and marks mobile readability, title/cover fidelity and
licences as human-review, never a pass. Hype phrasing in titles
("guaranteed", "100% viral") is flagged as a warning, not an error:
rewrite the title, don't argue with the flag. Offer the kit once,
after final approval; a declined offer is not re-offered. It
publishes and uploads nothing. For Shorts, record the locked style
id from `skills/shorts-video/styles.json` (`--style clean-bold` and
friends); an unknown id is refused. Full rules live in
`skills/shorts-video/references/publishing-kit.md`.

### 39. Gate every deliverable with qa_report + thumbnail
Before calling any finished file done, run `qa_report` on it and
look at a `thumbnail` contact sheet. `qa_report` is one call that
re-checks everything that matters — even dimensions, yuv420p,
frame rate, aspect + length for the target, measured loudness in
−16..−12 LUFS and true peak, black/frozen frames, dead air, pacing
(average shot length from real scene cuts), and an optional
`--expected-duration` — and returns one verdict (pass/warn/fail)
plus a per-check list. Fix the failing items and re-run it; don't
re-run five tools to find out what is left. `check` is still the
tool for platform-spec detail (bitrate warnings, safe zones,
`--content` time ranges); `qa_report` is the last gate. The
thumbnail sheet labels each tile with its own timestamp in `MM:SS.d`
(each tile is captured at that exact timestamp), so read the times
off the sheet when you decide where to cut. `--start-delay-percent`
/ `--end-delay-percent` skip the intro/credits before spacing the
tiles. `--header` adds a metadata band on top (filename, measured
duration, resolution, fps, codecs, size, grid) — use it when the
sheet will be forwarded or filed, so it still says which file it
came from. `check` also takes `--expected-duration` now, so a
platform check can fail a file of the wrong length without needing
the full `qa_report` gate.

### 40. One manifest, one finished clip — don't retype a pipeline
When the same chain of steps belongs on a clip (trim → reframe →
loudness, or any longer pipeline), write it once as a `manifest`
JSON file and run it with one call, instead of re-issuing five tool
calls and re-typing the same args. Paths in the manifest are
relative to the manifest file, so keep the recipe next to its
media. The whole plan is validated before anything renders — an
unknown tool or arg key fails in seconds, with the step number and
the name, not after step 3 of 5. `--dry-run` prints the planned
steps and writes nothing: read it before the real run, the way you
read a mix dry-run. A second identical run re-encodes nothing: each
step is cached by content hash (input bytes + tool + args +
sidecar-file bytes), so editing step 3 only re-runs from step 3 —
but a changed input file re-runs everything downstream, which is
correct, not a bug. Put `"qa": "tiktok"` (or any platform, or
`"any"`) in the manifest and the gate runs itself at the end; a
`warn` verdict still writes the file, so read the checks. A step
failure aborts the run and keeps the intermediates under the output
dir — the error names the directory, so inspect the broken step's
file instead of guessing. Only single-input steps chain
(`trim`/`resize`/`reframe`/`compress`/`convert`/`normalize`/`extract_audio`/
`reverse`/`grade`/`fit`/`silence`/`denoise`/`interpolate`/
`burn_captions`/`overlay`/`chroma_key`); multi-input work (`concat`, `mix`,
`mux`, `pip`) stays a separate call before or after the manifest.
`slideshow` is the one exception: it may only be step 1 — it builds a
video from images in args (or from an `images_glob` pattern — then the manifest `input` may be omitted entirely), so the manifest input should be the first
slide image when images are listed, and later steps then trim, reframe or grade the slideshow
like any clip. Editing a slide image re-runs the step: the image bytes
are in the cache key, the same as a `chroma_key` background.
`download` is the second exception: it may only be step 1 too — it
fetches from a URL in args, so when it is step 1 the manifest `input`
may be omitted entirely (the URL is the input). That is the whole
fetch-then-edit pipeline in one file: download a stock clip or an HLS
stream, then trim, reframe, grade it. A changed URL re-runs the step
(the URL is in the cache key); an unchanged manifest re-fetches
nothing. `download` is deliberately NOT a batch operation: batch maps
one operation over files matching a glob, and a download's input is a
URL, not a file. `hook` is the probe-only step: it analyzes the chain
file at that point and passes it through unchanged — put it before the
`trim` that cuts the winning window, and the step result records WHY
the cut lands where it does (ranked windows + scores) in the manifest
receipt. Its cache entry stores only the result; there is no file to
verify, and the key already covers the input bytes. HLS (`.m3u8`) / DASH (`.mpd`) downloads are re-muxed
with `-c copy`, never re-encoded; the size cap for a playlist is
enforced after the fetch, since its total size is unknowable until
the last segment arrives — so keep `max_size_mb` tight on playlists
you do not trust.

### 40a. A manifest that must reproduce: run determinism before you trust the receipt
A manifest cache hit proves the cached bytes are unchanged — it
never proves a fresh run would produce the same bytes. When a
delivery must reproduce (a report video, a client render), run
`determinism` on the manifest before you ship: it re-runs the same
manifest N times (default 2, max 5) with the cache OFF and compares
byte sha256, decoded-frame digest (`framemd5` — moviepy's test
pattern: compare decoded frames, never bytes), and measured
properties (duration/frames/dimensions) across runs. Verdict
`byte_identical` means the pipeline reproduces exactly (measured:
two identical libx264 encodes on this machine are byte-identical,
and ffmpeg 8.1.2 writes no `creation_time` into mp4 by default);
`content_identical` means the frames match but container bytes
differ, with the differing format tags named (usually
`creation_time`) — same pictures and sound, different container;
`differs` means the pipeline itself is nondeterministic, with the
first differing run pair named. A download-first manifest
re-fetches its URL on every run (unless the download step sets
`cache:true`, which serves the verified per-URL cache instead), so
a changed server file reports `differs` honestly. The per-run outputs live under
`.mediakit-determinism-<pid>` next to the manifest and are removed
by default (`--keep-outputs` keeps them; a failed run always keeps
them). This is the linear-manifest sibling of `verify --rerender`,
which does the same for an assemble film — use `verify` for films,
`determinism` for pipelines.

### 40b. Patch a manifest, never rewrite it blind — the revision guard
When a manifest needs a small change (a trim end, a loudness target,
one more step), patch it with `patch_manifest` instead of rewriting
the whole file by hand: a hand rewrite can silently drop a step or a
sidecar path, and two agents editing the same file can silently
overwrite each other. A manifest carries an optional top-level
`revision` (absent = 0); the patch call requires
`expected_revision` to match the file's current revision, or it is
refused with `REVISION_MISMATCH` and nothing is written — re-read
the file and retry with the current revision. Ops (1–100, applied in
order — each op addresses the list as the previous ops left it): `set` a scalar at
`input` / `output` / `qa` / `steps.N.tool` / `steps.N.args.KEY`
(`version`/`revision` are managed, not settable); `add_step`
(append, or insert at `index`); `remove_step` (never the last
step); `replace_step`. Before anything is written the patched
manifest is validated with a real `manifest --dry-run`, so a patch
that names an unknown tool or arg key fails and leaves the file
byte-identical; before the write, the pre-patch bytes are copied to
`<manifest>.bak` (always the revision just before the current one —
a bad patch you only notice later is one `cp` away from undo), and
the write itself is atomic (`.partial` + rename)
and bumps `revision` by 1. The result lists every change in words
(`set steps.2.args.target_lufs = -16 (was -14)`) plus the dry-run
validation — read it before running the manifest. Note the
validation runs the manifest's dry-run, so the manifest's input
file must exist (a download-first manifest has no input, so it
validates without one). **Preview before you commit:** `dry_run`
(MCP) / `--dry-run` (CLI) runs the same guard + validation and
returns the exact candidate document (with `revision` + 1) in
`candidate` while writing nothing — no `.bak`, no revision bump.
Inspect the candidate, then re-issue the same call without
`dry_run` and the same `expected_revision` to commit; a dry-run
against a stale revision is still refused, because a candidate
computed from a stale base is meaningless.

### 41. One style id for the whole video — don't retype hex values
Pick the style once (`clean-bold`, `minimal-line` or `warm-story`,
locked in `skills/shorts-video/styles.json`) and pass
`--style <id>` to `titlecard` and `intro`: both tools use the same
locked palette, so the intro card and the title card match without
retyping colours. `publish_kit` enforces the same three ids. An
explicit `--text-color` / `--box-color` / `--bg-color` /
`--font-size` on one call is a scoped override for that call only —
it wins over the locked value, is reported in `style_overrides`, and
never rewrites the library. Changing the style after captions are
burned means re-burning and re-verifying (same rule as the
style-lock): the old render is not the new style.
A `--brand <id>` (`amber-teal`, `warm-story` or `minimal-line`,
same registry as `assemble` in `skills/shorts-video/brands.json` —
or your own ids from a `MEDIAKIT_BRANDS` file, which add to the
built-ins and can never redefine one)
paints `titlecard` and `intro` in the channel look instead — primary
is the title-card box, on_primary its text; background is the intro
background, text its text — so the opening cards match the film
they open. Resolution is explicit > brand > style > default; the
brand never sets the font size (its `text_size` belongs to assemble
text layers). Brand-filled fields are reported in `brand_applied`,
explicit wins over the brand in `brand_overrides`.

### 42. Green screen out is a measured alpha, Ken Burns is a measured zoom
`chroma_key` keys one color out (`--color` hex, `--similarity`
tolerance, `--blend` edge softness) and either keeps the
transparency or composites onto a background in the same call.
Without `--background` the output MUST be `.mov` (ProRes 4444):
`.mp4`/H.264 has no alpha channel, and this ffmpeg build drops VP9
alpha in `.webm` (measured, even with `-auto-alt-ref 0`), so a
`.webm` that "worked" is a file with the alpha silently gone — the
tool refuses it instead of writing it. With `--background` (an
image file, or a hex color like `1E40AF`) the output is a flat
`.mp4`/`.webm`. Read the measured alpha in the result: on a
full-screen key the corner reads ~0 and the subject ~255, and the
frame mean equals the subject's share of the frame — if the corner
is not near 0, the similarity is too low or the screen is not the
color you named; if the subject is not near 255, the similarity is
too high and is eating it. `zoom_pan` turns a still image into a
Ken Burns clip: zoom `--zoom-from` → `--zoom-to` while the focus
point travels from (`--focus-x`, `--focus-y`) to (`--focus-end-x`,
`--focus-end-y`), 0–1 fractions of the frame. A video input is
refused (zoompan would stretch it by `d` frames per input frame) —
unless `--events-file` is set: chain mode takes a video and an
event timeline `[{time, x, y, hold?}]` (Pagecast's zoom-chain idea)
and drives the camera through it — close events group into one
chain that pans between targets, wide gaps split chains with a
zoom-out to the full frame in between (`--zoom`/`--chain-gap`/
`--transition`/`--pre-lead`/`--pan`/`--hold`; output keeps the
input's dimensions, fps and duration). Verify a zoom the same way
the test suite does: frame 0 against the full image scaled, the
last frame against the zoomed window cropped by hand — both must
match within a few dB of PSNR, and the last frame must be clearly
closer to the zoomed crop than to the full image.

### 43. Cut words by transcript, never by hand-typed times
`transcribe --word-timestamps` returns the words with 0-based
indices (`words: [{index, start, end, word}]`) — save that printed
JSON and pass it to `cut_words --words-file`. Select by word text
(`--remove um,uh`), the built-in filler set (`--fillers`: um, umm,
uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh), or word-index ranges
(`--indices 0-5,96-98`); `--keep` rescues indices even when
auto-flagged. Times always come from the transcript file — a
hand-typed timestamp is not a cut. "like" and "you know" are
deliberately NOT fillers: they are ambiguous in context, so they are
cut only when named in `--remove`. Keep runs are padded 0.06s
before / 0.12s after the kept words, clamped to the gap to the
neighbouring cut word, so a cut never keeps a fragment of the word
it removed. `--edge-buffer` (0–1s, default 0, Outtake's 0.1s
clip-edge buffer) widens every keep segment past its pads, clamped
only to the file edges — so a cut never lands exactly on a kept
word's onset. It deliberately keeps up to that much of the
neighbouring removed word's edge, and a buffer wider than the gap
between two kept runs merges them (the cut between them disappears).
`--snap-to-pause` moves each keep edge into the real pause the
transcript points at instead of the fixed pads: the audio is measured
at 10 ms frames, the quiet threshold is set from the take's own
levels (5th percentile + 10 dB, 95th percentile − 20 dB), and the cut
lands 0.1s into the pause (room tone on both sides). Whisper's word
edges run late at sentence ends, so a transcript-only cut keeps the
start of the next sentence — snap fixes that. An edge with no pause,
an ambiguous one (two pauses ≥ 0.12s in reach), or a snap that would
cross a kept word keeps its padded value, with the reason in `snap`.
Refuses files over 1200s. Read `cut_check.swallowed` before trusting the cut: a
kept word listed there ended up mostly outside the keep segments
(usually a `--min-keep` sliver) — play it, then pass `--keep` for
its index. `--dry-run` prints the plan first (removed words, keep
segments, cut check) and writes nothing; no match at all
stream-copies the input unchanged. After a real cut, re-transcribe
the output and check the removed word is gone — Whisper sometimes
hides a restart inside one long word on the first pass.

### 44. cut_words in batch and manifest: one words file per clip
Batch runs one operation over many files with the same args, but a
words file is per-clip — timings from one clip must never cut
another. So batch `cut_words` (and `remove_retakes`, rule 49) finds each clip's file by convention:
`<words_dir>/<stem>.words.json`, default the input's own folder
(`take.mp4` looks for `take.words.json` next to it; `--words-dir`
points at a shared folder of per-clip files). A clip with no words
file fails its own row only — the rest of the batch still runs, and
the error names the missing file. In a manifest the step is one clip,
so it takes a single `words_file` instead, resolved relative to the
manifest (like `captions`/`overlay`) and hashed into the step cache,
so editing the words file re-runs the cut step. A full talking-head
cleanup is one manifest: `cut_words` → `silence` → `loudness`.

### 45. A starved bitrate gets a smaller frame, not mush
In `--target-size` mode the bitrate budget is fixed, so a big frame
at a tiny bitrate smears detail into mush. The resolution ladder
steps the frame down instead: it measures bits per pixel per frame
(`video_kbps × 1000 ÷ (width × height × fps)`) and walks
1080 → 720 → 480 → 360 → 240 until the budget buys at least
0.045 bpp — if even 240p is starved it takes 240p anyway. It only
ever scales down, never up, and it starts from the `--max-width`
dimensions when one already shrank the frame (640 wide at 592k
buys 0.0856 bpp, so no further step). The result reports
`resolution_ladder_applied`, `bpp_before`/`bpp_after` and
`bpp_threshold: 0.045` — read those before trusting the output size:
a 1 MB target on 1280×720/30fps buys 0.0214 bpp, so the ladder
lands at 854×480 (0.0481 bpp). `--no-resolution-ladder`
(`resolution_ladder: false`) keeps the source frame when the mush
is acceptable or the platform needs the exact dimensions.

### 46. A still image holds still — and a manifest sidecar is a file, unless it is a color
`image_to_video` is the still half of `zoom_pan`: one image, one
fixed duration, zero motion — a podcast still, a song cover, a
title card held over audio. The frame count is exactly
round(duration×fps) (3s at 30fps is 90 frames, measured on disk),
and the first frame is the source image itself (PSNR > 40 dB
against the scaled source). Dimensions default to the image;
`--width`/`--height` fit inside the box and pad black to the exact
size, so asking a 1280×720 photo for 1080×1920 gives a padded
1080×1920, never a stretch. `--audio` loops the bed to the same
duration — a short bed loops, a long one is trimmed by `-t`. A
video input is refused (extract a frame first); motion is
`zoom_pan`'s job, not this tool's.

### 47. A slideshow shows each image for its own time — the transition eats a handle, not slide time
`slideshow` takes 2–32 stills and joins them with an xfade
transition between every pair (`fade` by default, any of the
49 names `concat` accepts). A different transition per join:
`--transitions fade,wipeleft` with `--transition-durations 1,0.5`
(one entry per join, in order; each duration shorter than both
slides it joins) — in MCP `transitions` / `transition_durations`
arrays. The duration you give an image is its
VISIBLE time: internally each clip is duration + its outgoing
transition
(except the last), so the total is exactly the sum of the
durations — a 3+3+3 show with 1s fades is 9s, 270 frames at 30fps,
measured on disk. Give durations with `--duration` (uniform),
`--durations 3,5,2` (one per image, in order), or `{file,
duration}` objects in MCP (which win over both). The transition
must be shorter than the shortest slide, or no slide is ever fully
visible — the tool refuses it. The output always carries an audio
track, silent unless `--audio` loops a bed under the whole show.
Verify a slideshow by its frames, not its log: the frame mid-slide
must match its image (PSNR > 40 dB) and the frame mid-transition
must match NEITHER neighbour (a blend).
`--images-glob 'slides/*.png'` (MCP `images_glob`) lists the slides
by pattern instead of by hand: matched images run in natural sort
order (shot-2 before shot-10), 2–32 images, only still-image files
count, `**` crosses directories, a bare `*.png` matches the basename
at any depth (same rule as `batch`). Pass either files or a glob,
never both. In a manifest the glob expands against the manifest dir
at lint time, so a pattern that matches nothing fails before anything
renders — and a glob-first manifest needs no `input`.
In a manifest, a `chroma_key` background is either an image file
or a hex color — and the cache treats them differently. An image
background resolves relative to the manifest and its bytes are
hashed into the step cache, so editing the image re-runs the key
step (the corner pixel moves with the new image). A hex background
is already in the args, so it is never resolved as a path and never
hashed. If a step mysteriously re-runs every time, check whether a
sidecar path moved; if a step mysteriously never re-runs, check
whether the sidecar bytes changed but the key did not.

### 48. Assemble a film from a manifest — voice first, preview, approve, render
`assemble` is the film builder: one declarative JSON manifest
(`skills/shorts-video/references/assemble-manifest.md` for the
schema) becomes a finished video. The voice is the master clock —
`total = lead + measured voice duration + tail`, and shot
durations are converted to frames and must cover the total
exactly; a gap or an overlap fails validation with the difference
in frames and seconds, never a silent trim or pad. Shot kinds:
`image` (with `zoom` → `zoom_pan`, without → a still hold),
`video` (trimmed + reframed to the manifest size), `color`
(a solid card), `canvas_scene` (a JS module that draws every
frame in code with Canvas 2D — real 30fps motion, the director's
animation path). A still image without zoom, and a color card, may
last at most 2.5s (the motion gate — split the shot or add a
zoom). Any shot may carry `text` — one text layer object or an
array of up to 4 `{text, position?, size?, color?, box?, start?,
end?}`: a drawtext lower-third/title timed inside the shot
(`top` by default, clear of the burned captions; `size` defaults
to min(width,height)/12; `color` is 6-digit hex; `box` draws the
black@0.6 box, default on; `start`/`end` are seconds inside the
nominal shot). Long lines wrap to fit the frame. Layers are part
of the segment cache key, so changing only the text rebuilds just
that shot. A shot after the first may carry `transition: {type,
duration}` — one of the 49 xfade names `concat` accepts, centered
on the cut: half the transition shows the tail of the previous
shot, half the head of this one. The total duration and the audio
do not change — transitions are video-only, and each shot segment
is built longer by its handles so the xfade chain consumes exactly
the handles. A transition must not be longer than the shorter
adjacent shot, and a `video` shot needs the handle footage to exist
in its source (start ≥ incoming handle, start + duration +
outgoing handle ≤ source end) — validate refuses otherwise.
In a preview, a transition whose next shot is clipped below its
handle is dropped (hard cut, recorded in `transition_warnings`). The four modes are a pipeline, in order: `validate`
(writes nothing), `preview` (first N seconds at half size —
show it to the user), `approve` (records the fingerprint of the
exact manifest + voice + assets + captions the preview showed),
`render` (needs a matching approval; `force:true` bypasses it
and is recorded as `approval:'forced'`). Any change to the
manifest, voice, assets or captions invalidates the approval,
and the render error names what changed. A manifest may also
carry `chapters: [{title, at}]` — up to 32 named markers,
strictly increasing, inside the film (`at` in seconds or
`MM:SS`); on render they become real MP4 chapters in
`final.mp4` (the last chapter runs to the film end; a preview
carries no chapters — it is a clipped window). Shot segments are
cached by content hash next to the manifest, so a re-render
rebuilds only changed shots; the receipt records the
fingerprint, the approval status, cache hits, the measured
final duration/dimensions/loudness, and the `qa_report` result.
Captions burn with the locked style's values from `styles.json`
(read from the file at render time, with embedded fallback
values if the file is missing). v1 limits, stated not hidden:
one aspect per manifest. This is not the `manifest` tool — that one
runs a linear edit pipeline (input → steps → output).

### 49. A retake is a repeated phrase, not a feeling — detect it, review it, then cut
`remove_retakes` finds repeated takes on the same words file
`cut_words` uses (rule 43): a phrase of `--min-words` (default 3)
identical words, then at most `--max-gap-words` (default 8) words
and `--max-gap-seconds` (default 5) of restart junk ("okay,
again", a filler), then the same phrase again — the earlier take
plus the junk is cut, the fluent take kept whole. A 2-word
abandoned start ("the quick" — "um" — "the quick brown fox") is
cut the same way. `--keep last` (default) keeps the later take —
people warm up, so the later take is usually the better one;
`--keep first` keeps the earlier one. The cut goes through
`cut_words`, so pads (0.06/0.12), `--min-keep` and
`cut_check.swallowed` behave identically. This is deterministic,
not a judge: an intentional repetition ("I like cats. I like
cats a lot.") looks exactly like a retake to the detector — the
gap bounds are the only guard. So always run `--detect-only`
first and read the `clusters` (kept take + removed indices +
text) before cutting; a cluster whose kept text is a sentence
you meant to say twice is a false positive, not a retake. In
batch and manifest it follows the same words-file convention as
`cut_words` (rule 44): `<words_dir>/<stem>.words.json` per clip,
a single `words_file` in a manifest step.

### 50. A long render runs in the background — poll the job, don't block on it
`assemble --async` (render mode only, MCP `async:true`) returns
in milliseconds with a `job_id` instead of waiting for the
render: the manifest + approval are validated synchronously
first, so a bad manifest or a missing/stale approval fails the
call itself — a job is never born dead. The render runs in a
detached worker process; poll it with the `job` tool (`status`
shows `stage` + `percent` + the live `pid`, then the terminal
`result` — output, duration, frames, LUFS, SHA-256, QA verdict —
or the `error`). The percent moves continuously inside the long
stages, not just at stage boundaries: each shot encode, the xfade
join, the voice pad and the caption burn report ffmpeg's `-progress`
(`out_time` / total), and `progress.detail` names what is happening
(`s2 · frame 123/300 · 2.4x`). The mux is a stream copy and the QA
is probes, so those two stages still report only their boundaries.
`job --list` shows all jobs, newest first;
`job --cancel <id>` stops a queued or running job and kills
the worker's whole process group, ffmpeg children included, so
nothing keeps encoding after the cancel — and a cancelled job
stays cancelled, the worker never overwrites it with
done/failed. Jobs live under `MEDIAKIT_JOBS_DIR`, else
`<workdir>/.mediakit-jobs`, one directory per job (`job.json` +
`worker.log`). Never poll in a tight loop: 2s between polls is
plenty — a render takes minutes, not seconds.

### 51. Pull media from the web with `download` — never with a bare ffmpeg URL input
`download <url> -o <file>` is the only way to fetch media from the
web: http(s) only, no credentials in the URL (use a signed URL with
query parameters). HLS (`.m3u8`) / DASH (`.mpd`) playlists are
fetched with ffmpeg `-c copy` under a protocol whitelist (no
`file://` segments) and the size cap is enforced after the fetch.
The size cap (default 500 MB, `--max-size-mb`) is enforced while
streaming, not just from Content-Length, so a server that lies about
the length still cannot fill the disk; a declared length over the
cap is refused before a body byte is read. Redirects are capped at
5 and a redirect off http(s) is refused. The file is written to
`<output>.partial` and renamed only on success, then probed — a
download that is not media is deleted and reported, so a 200 OK
with an HTML error page never becomes a "clip". The output
extension is either given (must be a media extension) or derived
from the Content-Type / URL path, and a video served as `.mp3` is
refused rather than mislabelled. Transient failures (HTTP 429/5xx,
network errors) are retried with exponential backoff 1s/2s/4s
honouring `Retry-After` (default `--max-retries 3`; timeouts and
deterministic refusals — 404, bad content-type, over the size cap —
are never retried, and the final error names the attempt count).
`--cache` reuses a verified per-URL disk cache
(`MEDIAKIT_DOWNLOAD_CACHE_DIR` or `~/.cache/mediakit/downloads`,
keyed by sha256(url), trusted only after size + sha256 still match
the meta; a corrupt entry is re-fetched, never served) — use it for
stock URLs a director fetches across runs; playlists are never
cached and `--cache` on one is refused, not silently ignored.
`--rate-limit-rps` paces downloads in this process with a token
bucket (0 = unlimited; `MEDIAKIT_DOWNLOAD_RPS` when the flag is
absent) — a manifest fetching several URLs in one process stays
polite to the CDN. License: `--license <label>` declares the
source's license (e.g. `CC0`, `CC-BY`, `Public Domain` — aliases
collapse to one spelling, anything else is kept verbatim) and is
recorded in `<output>.provenance.json` next to the file, together
with the policy verdict; without a declaration the license stays
`unknown`, never guessed. A policy file
(`MEDIAKIT_LICENSE_POLICY` env, or `--license-policy-file` per call:
`{allow?, deny?, require_license?}`) gates the download BEFORE
any fetch — a declared license outside the allow list, inside the
deny list, or missing when required is refused with
`LICENSE_DENIED` and costs zero bytes (the gate runs before the
cache too, so a cached URL under a denying policy is refused, not
served). Without a policy file the gate is off and the license is
only recorded — enforcement is opt-in so existing workflows don't
break. `doctor` reports the policy state (`license_policy.set`); a
set but malformed policy file fails `doctor`'s `ok`, like a broken
workdir. A manifest `download` step takes `license` (and
`cache`/`max_retries`/`rate_limit_rps`/`cache_dir` — those were
already read by the step runner but rejected at lint until lượt
90). Never `ffmpeg -i <url>` directly: that is
exactly the unguarded pattern brookcs3/m3u8-mcp-server's
`m3u8_download` uses (no validation, no cap, no timeout, no
verify) — MediaKit's `download` exists so the agent never has to.

### 52. Test a tool over HTTP before wiring up an MCP client — same tools, curl instead of stdio
`mediakit mcp --http [--port 3000]` serves the same 69 tools over
HTTP on `127.0.0.1`: `GET /mcp` (metadata), `GET /mcp/tools`
(every tool + JSON input schema), `POST /mcp/tools/{name}/invoke`
(`{"arguments": {...}}`), and `POST /` for JSON-RPC 2.0
(`initialize`, `ping`, `tools/list`, `tools/call`). The tool
registry (`src/tools.js`) is the single source of truth for both
transports — a tool cannot exist on one and differ on the other, and
`check-docs` fails CI if either transport stops importing it. HTTP
errors are JSON with a matching status (`400` bad arguments, `404`
unknown tool, `500` failed run) and the same `retry:
{tool, arguments}` the stdio server attaches, so a failed curl can
be re-issued verbatim. Never bind `--host 0.0.0.0` on an untrusted
network: there is no auth, and the tools read/write workspace files.

### 53. When a render is disputed, read the audit log — don't re-argue it
Every tool call on every transport is recorded in
`<workdir>/.mediakit-audit.jsonl` (one JSONL line per call: tool,
arguments hash, input/output files with size + SHA-256, duration,
status). `mediakit audit --tool <name> --status ok --verify` re-hashes
the recorded files on disk and reports matched/missing/changed per
entry — a log line is a claim, the disk is the evidence, so a
tampered output shows up as `verified: false` instead of being
trusted. Use it to answer "did this file really come from that
call?" after a render, and to find which call produced a file you
didn't expect. URL query strings are stripped from recorded
arguments (a download URL can carry a token); `MEDIAKIT_AUDIT=0`
disables recording; `doctor` reports whether the log is enabled and
how many entries it holds.

### 54. A shot that doesn't move is a still — measure it with `motion`, don't eyeball it
`motion <video>` returns a per-second curve of the fraction of
pixels that changed between adjacent frames, the still intervals
(runs of still windows lasting at least `--min-still-seconds`, 2s
by default), and a verdict: `moving`, `mostly-static`, or `static`.
The scale, measured on disk: a static title card scores 0.0000–
0.0001, a bouncing ball 0.003–0.009, testsrc 0.06, a frozen stretch
exactly 0.0000 — the default still threshold 0.001 (0.1% of pixels)
splits movement from encoder noise with a wide margin. Run it on
every shot before calling a film done: the report videos of lượt
52/54 failed `qa_report` on frozen frames because a title-card
shot sat still for 9–11 seconds under a voiceover, and `check
--content` only catches that at the very end. `motion` catches it
at the shot level, before the render. A transition spike in one
window is not motion — look at the curve, not a single number. Do
not use raw lavfi scene_score for this: testsrc scores 0.0006 while
a bounce scores 0.0005, indistinguishable on that scale.
If the footage is grainy, the fixed threshold flickers: light grain
on a static shot measures 0.0007–0.0013, straddling 0.001, so the
same shot reads `mostly-static` with a broken still interval. Pass
`--adaptive`: the threshold is calibrated to the clip's own quiet
quarter (25th percentile of the curve × 2.0, capped at 0.005), so
the grainy still reads `static` with one still interval while a
bouncing ball (slowest second 0.007) still reads `moving`. The cap
is the guard: steady motion above 0.005 can never be thresholded
away. Heavy grain (0.5 changed-fraction) still reads as moving in
both modes — no magnitude threshold can separate it from real
motion. Do not port PySceneDetect's adaptive *ratio* (score over a
rolling local average) to this verdict: it detects cuts, and a
smoothly moving ball scores ratio ~1.0 against its neighbours.
Some motion is too slow for one frame step: a 10s fade-in from
black reads `static` (energy 0.00043 — the per-frame level change
is under the >2-level binarization) and a creeping zoom reads
0.002. Pass `--lag-seconds N` (whole seconds, 1–30, less than the
clip duration): the curve then compares frames N seconds apart, so
the same fade reads `moving` with energy ~1.0 at lag 2 and the zoom
is amplified 11x. The value at second k is the change between
second k and second k+N; still intervals are corrected to clip time
(end + lag, clamped to the duration). Two blind spots to know: a
still shorter than lag+1s produces no pair fully inside it, and a
still in the final lag seconds has no later frame to compare
against — use lag 1 when you need short freezes. Lag energy is not
comparable with adjacent-frame energy of the same clip.

### 55. Pick the opening shot by measurement — `hook` finds where the clip gets loud
A Short lives or dies in its first seconds, and the loudest moment
is rarely at 0:00. `hook <clip> [--duration 15]` slides a window of
that length across the file and scores each candidate on five
measured signals — mean audio energy (astats RMS per frame, binned
and normalized against the clip's own loudest bin), speech coverage
(the silencedetect complement: a window full of talk beats one full
of dead air), scene cuts (a window that opens on a cut scores
higher, plus cuts inside it), real motion (the `motion` tool's
per-frame pixel-diff curve, binned on the same step grid, normalized
against a fixed 0.06 reference — testsrc-level motion is 1.0 — with
a 0.001 noise floor and a 0.005 file-level gate, so a static clip
never scores motion from encoder noise), and visual beats (the
`highlights` perceptual-hash boundaries inside the window — 2+ beats
is fully active, 1 beat is half; a boundary at the window start
counts, the window opens on it). The score is 0.3×energy +
0.2×speech + 0.2×cut + 0.2×motion + 0.1×visual — audio 0.5 / video
0.5 — with fixed weights, so two runs rank the same way, and the top
windows are greedy non-overlapping — alternatives, not the same
window shifted one step. The visual weight is 0.1 on purpose: a
nudge, not a takeover — scene cuts and hash boundaries are two
detectors of the same picture change and must not outvote the audio.
The result carries the ranked candidates with the score breakdown
(each carries `visual` + `visual_beats`), the
`highlight_boundaries`, the per-step
energy curve (each bin also carries `motion` + `motion_fraction`),
pacing from real cuts (slow/medium/fast-cut), a `trim` object, and a
`suggested_trim` command. The trim end snaps to the nearest quiet
moment in the window's last 5 seconds (`--snap-window N`, 1–10):
quiet is (energy + motion) / 2 per bin, a bin only qualifies when it
is at most half as busy as the window's own mean, earliest wins a
tie so the cut lands where the quiet starts, and the snap never
shortens the hook below max(4s, half the window); `--no-snap-quiet`
keeps the raw window end. A uniformly loud window has no dip to snap
to, and a whole-file hook is never snapped — both report
`trim.snapped: false` with a reason. Run it on raw footage before
cutting the opening of a Short, then trim the winner — the trim in
the result already ends on the quiet moment, so cut that, not the
raw window. Video-only input scores on cuts+motion+visual (energy/speech 0,
and the warnings say so); audio-only on energy+speech. Files over 20
minutes are refused: the astats log behind the curve would exceed
the capture buffer, so trim a section first.

Clip history — don't re-suggest a moment that already shipped.
`hook <clip> --history-file hooks.json --record` checks every
candidate against the JSON history file and appends the winning
window after the run, so the next run on the same footage skips it.
A candidate is a duplicate when it comes from the same source file
(sha256) and overlaps a recorded window by >= `--history-overlap`
(default 0.5) of the shorter window; duplicates are flagged
`duplicate` + `duplicate_of` (start/end/score/recorded_at/overlap)
on the candidate, and `history` reports
records_checked/duplicates_found/recorded. Only the winner is
recorded — the alternatives were never cut, so they stay eligible,
and a duplicate winner is never recorded twice. A missing history
file is an empty history (the first `--record` run creates it); a
corrupt or wrong-shape file fails loudly. The history file is part
of the batch/manifest cache key, so recording a window invalidates
the cached hook result instead of serving stale duplicate flags.
Keep one history file per series, not per clip: the sha256 is what
separates sources.

### 56. Measure the tempo before cutting on the beat — `bpm` finds the musical grid
A cut that lands on the beat feels intentional; a cut half a beat
off feels like a mistake. `bpm <clip>` measures the tempo in BPM
(probe-only, writes no file): spectral-flux onset function, then an
autocorrelation + comb-filterbank period search with a 120 BPM prior
and an onset-recall tie-break (aubio's tempo pipeline,
re-implemented in pure Node). It returns `bpm` (1 decimal),
`beat_period_seconds`, `confidence` 0–1, a `reliable` flag,
`onset_recall`, `onsets_detected`, `first_beat_seconds` and the
first 16 `beats` — the grid a beat-snapping cut snaps to.
Trust the number only when `reliable` is true: a steady tone has no
onsets (confidence ~0) and speech has no steady beat (confidence
~0.09), and both report `reliable: false` with a warning instead of
a confident wrong number — never snap cuts to an unreliable grid.
The prior is deliberate, not a bug: a kick + off-beat-hat drum
pattern scores identically at 60/120/240 on comb alone, and the
prior is what reads it as its musical beat (120), not its
subdivision (240). Files over 10 minutes or under 4s are refused.

### 57. Cut on the beat — `beat_grid` + `trim --snap-beat`
`bpm` only shows the first 16 beats; `beat_grid <clip>` returns
every beat across the file (`beats`, `beat_count`,
`last_beat_seconds`) — the cut points. Then
`trim --snap-beat --start 1.13 --end 3.27` moves the start DOWN to
the nearest beat at/before it and the end UP to the nearest beat
at/after it (the same widening convention as `--snap`, so a cut
never loses content at either edge), and reports `beat_start`,
`beat_end`, `bpm` and `beat_confidence` next to the requested
range — read both. Unlike `--snap` it works on re-encode cuts too
(the point is musical alignment, not keyframe alignment) and on
stream-copy; it refuses `--snap` and `--smart-cut` (pick one grid,
or one exact-start method). It refuses outright when the grid is
unreliable — a tone measured 43.2 BPM at confidence 0.004 is not a
grid, it is a guess, and the error says so; cut with plain `trim`
instead. Two honest limits: the grid is only as precise as one flux
frame (~23 ms), so a snap can sit ~12 ms off the true click —
inaudible for a cut point; and the rigid grid assumes one tempo for
the whole file. When the take drifts, use the DP tracker:
`beat_grid --method dp` runs librosa's `beat_track` (Ellis 2007,
re-implemented in pure Node) — dynamic programming over the flux
frames with a log-Gaussian transition cost around the measured
period (tightness 2, calibrated: 1 subdivides a kick+hat pattern
into 29 beats, 2 keeps it clean at 24) — and returns `grid_method:
"dp"` plus `tempo_drift_seconds` (worst distance from the rigid
grid: 0.373s on a 120→132 drift take, 0.026s on a steady 120 click
track) and `tempo_drift_cv`. `trim --snap-beat --snap-beat-method
dp` cuts on those beats instead (reported as `beat_method: "dp"`),
and `method`/`snap_beat_method` flow through `batch` and `manifest`
too. `bpm` and `beat_grid` are probe-only steps in `batch` and
`manifest` too: they analyze the chain file at that point and pass
it through unchanged, so a manifest can record the grid before the
`trim --snap-beat` step that cuts on it.

### 58. Check whether the tempo moves before trusting the grid — `tempo_drift`
`bpm` gives one number for the whole file and `beat_grid` assumes
it holds; a live take that speeds up breaks both. `tempo_drift
<clip>` measures the LOCAL tempo over time (probe-only, writes no
file): sliding-window tempo estimation — the aubio pipeline
(spectral-flux + autocorrelation/comb + 120 BPM prior +
onset-recall tie-break) run on overlapping windows of the onset
envelope, aggregated to a 1-second `tempo_curve` (the local-tempo
idea of librosa's `plp`).
It returns `start_bpm` / `end_bpm` (median of the first/last 20%
of reliable bins), `delta_bpm`, `max_deviation_bpm`, `direction`
(`speeding_up` / `slowing_down` / `steady`) and `verdict`
(`steady` / `drifting` / `variable` / `unreliable`). A 120→132
take over 12s reads 122.7 → 129.2, delta +6.5, verdict `drifting`
(the window cannot centre on the first/last ~2.4s, so the curve
covers t=2..9 and start/end are the outer bins, not 120/132
themselves); a steady 120 reads 120 → 120, verdict `steady`. When
the verdict is `drifting`, snap cuts to the DP grid (`beat_grid
--method dp` + `trim --snap-beat-method dp`), not the rigid one.
A steady tone or speech reports `verdict: unreliable` — the curve
is returned with its bins, but do not trust it. Files over 10
minutes or under 8s are refused (the analysis window alone is
~4–9s); use `bpm` for a single number on a short clip. Like the
other tempo tools it is a probe-only step in `batch` and
`manifest`.

### 58a. See the shape of the loudness before you cut — `audio_levels`
`check --content` tells you whether anything clips; it does not tell
you WHERE the clip gets loud. `audio_levels <clip>` draws the
loudness curve (probe-only, writes no file): one decode pass, per-frame
astats Peak + RMS bucketed into `--bucket` windows (default 1s),
RMS averaged in the linear domain so each bucket's `rms_db` is the
true energy mean. Every bucket comes back `{start, end, rms_db,
peak_db}` — a bucket of true digital silence reports nulls, never a
fake -inf — plus a summary (`max_peak_db`, energy-mean `mean_rms_db`,
`min/max_rms_db`, `dynamic_range_db`, `silent_buckets`,
`loudest_bucket`) and the `--top` loudest moments (default 5) kept at
least `--min-gap` apart (default 2s, so a 3s shout does not fill the
list with its own neighbours; near-equal peaks tie at 0.1 dB and the
earliest wins). The summary also carries `dynamics` (same decode, no
extra cost): `quiet_p10_db` / `loud_p90_db` are nearest-rank
percentiles over the finite bucket RMS values, `separation_db` is
p90 − p10 with a verdict — flat (<6 dB), narrow (<12), dynamic
(<24), wide (beyond) — and `bed_fills_speech_gaps` tells you
whether the gaps between loud moments still carry something
audible: a gap bucket is true digital silence or ≥20 dB below the
loud p90, and the flag is true when those gaps still average above
−60 dBFS (`gap_bed_db` is their energy-mean RMS). Use it to pick the
loudest moment to feature, to find the quietest stretch to cut on,
or to check a mix's dynamic range before publishing — a mix whose
gaps read digital silence has no bed under the pauses, a mix whose
`gap_bed_db` sits around −54 dB has one. A 12s fixture with a quiet
/ loud / silent / medium tone reads buckets -51.5 / -21.1 / null /
-31.5 dB RMS and peaks at 2s, 4s, 9s (the 2s bucket is the frame
straddling the 3s switch, so its peak already reads loud while its
RMS is still mixed), with dynamics p10 −51.5 / p90 −21.1 /
separation 30.5 dB (wide) and the gaps filled at −51.5 dB; the same
shape with true digital silence in the gaps reads
`bed_fills_speech_gaps: false` and `gap_bed_db: null`, and a
constant tone reads separation 0 dB (flat) with no gaps at all. Cap:
at most 3600 buckets — a long file needs a wider `--bucket`. Like
the other audio probes it is a probe-only step in `batch` and
`manifest`.

### 58b. Find the phrase before you cut — `search_words`
`cut_words` cuts by word, but it needs you to already know WHICH
words to cut. `search_words --words-file words.json --query "welcome
back"` answers that first (probe-only, writes no file): it searches
the same transcript `cut_words` cuts by and returns every place the
phrase is said — word indices, start/end/duration, the matched text
with `--context-words` (default 5) on each side so you can read the
hit in place, and a padded cut window (default 0.5s each side).
`cut_list` merges the windows into the ready-to-cut list, so the
next step is a `trim` on a window it returned — never a hand-typed
timestamp. Matching is on normalized words (case-insensitive,
punctuation ignored — "Hello," matches "hello"), contiguous only: a
phrase split by another word is not a match, and ASR mis-hearings
are not fuzzy-matched — a missed phrase means the transcript says
something else, so re-read the transcript instead of widening the
search. `--max-matches` (default 10) caps the returned matches;
`match_count` is the true total even when `truncated` is true. Like
`cut_words` it is a probe-only step in `batch` (one words file per
clip, `<words_dir>/<stem>.words.json`) and `manifest` (a single
`words_file` arg).

### 58c. Tighten a take with `smart_cut` — cut hesitation, not words
`smart_cut` cuts the hesitation out of a talking-head take on the
same words file `cut_words` uses (rule 43), in one pass: long
pauses between words, long filler words, and words held so long
they became a stall. The three cut rules, all scaled at once by
one `--aggressiveness` knob (0-1, default 0.5): a gap between two
words at or over `--min-gap` (default 0.45s) x (1.2 - 0.6 x
aggressiveness), kept with 0.05s on each side; a filler word held
at least 0.35s - 0.15 x aggressiveness (a quick 0.1s "um" survives,
a stretched "ummm" does not); a word in the filler set plus
"this"/"so"/"and" held at least 0.9s - 0.3 x aggressiveness, cut
from 0.05s in so its attack survives. That duration gate is what
makes "like" / "you know" / "basically" / "actually" safe in the
default filler list — `cut_words --fillers` cuts every filler and
deliberately excludes them, `smart_cut` includes them because a
0.1s "like" (verb) is below the gate while a 0.6s "liiiike"
(filler) is above it. Since lượt 130 a long contextual filler
ALSO has to pass the context gate (OpenEdit's rule): flanked by
>= 0.15s pauses on BOTH sides, or sitting at the very start/end
of the take — a 0.6s "like" inside "I like this" survives and is
listed in `gated_fillers` (read it in `--detect-only` to see WHY
it stayed); `--no-contextual-gate` restores the old duration-only
behaviour. `--min-segment` (default 0 = off) merges removals
separated by less than that many seconds of kept speech, so a
sub-2s keep fragment between two cuts is cut with them instead of
making a choppy clip (2.0 is OpenEdit's default — but it can
swallow real words on a dense take, so it stays off unless
asked). `--fillers "um,uh,you know"` overrides the
list; a phrase matches consecutive words. This is deterministic,
not a judge: a dramatic pause looks exactly like a hesitation to
the detector — always run `--detect-only` first and read the
`removed` list (reason filler/stretched/gap/mixed + text) before
cutting. Nothing to cut stream-copies the input unchanged. In
batch and manifest it follows the same words-file convention as
`cut_words` (rule 44). Not the same as `trim --smart-cut` — that
one is keyframe-exact stream-copy cutting, this one cuts on the
transcript.

### 58d. Find the visual beats before you cut — `highlights`
`hook` (rule 55) finds where a clip gets loud; `highlights` finds
where the PICTURE changes. It samples frames at 2 fps, hashes each
one as an 8x8 average hash (the blockhash-js block-mean-value idea:
one bit per cell against the frame mean, a ±8 dead zone so encoder
noise on a flat frame cannot flip bits, flat-frame tie-break mean >
127.5 → 1), and calls a frame a scene boundary when its hash jumps
from the previous frame by ≥ `--threshold` (normalized Hamming
distance, default 0.15 — the EncodeX boundary). A highlight is the
span between two boundaries; spans shorter than `--min-span`
(default 2s) merge into a neighbour, so the timeline never shatters
into slivers. Each span's `score` is the mean jump inside it — how
much the picture keeps changing there — and `top_highlights` ranks
them by score, then duration. `thumbnails` are the greedy
farthest-point frames (seed = biggest jump, then each pick
maximizes its minimum Hamming distance to the picked set): the most
visually distinct moments, for a poster frame or a hook still. Use
it to pick the cut points and the thumbnail BEFORE trimming: run
`highlights` on the raw take, cut on a boundary it reports, and
take the poster from a `thumbnails` timestamp — never guess either.
A static take reports one span and no boundaries; a take of solid
colour blocks reports a boundary at each colour change (measured:
red/green/blue 5s blocks → boundaries at 5.0s and 10.0s, jump
1.000). Long files sample slower instead of refusing (frame cap
1200; below 0.5 fps the file is refused as too long). Probe-only,
writes no file; also a probe-only batch operation and manifest step.
Follow-up DONE (lượt 139): the spans feed `hook` scoring through
their boundaries — each candidate carries `visual` + `visual_beats`
(0.1 weight), so the best audio window and the best visual beat are
ranked together. One measured limit stays: the average hash is blind
to flat-colour changes whose means sit on the same side of 127.5
(red→blue flat cut: no boundary), so `visual` is 0 on synthetic flat
colour blocks and only fires on real textured footage.

### 58e. Let the voice set the shot lengths — `align_voice`

Hand-typing shot durations to match a voiceover is guessing: the
voice is the master clock, so let it measure the cuts. `align_voice`
takes a film manifest and splits the voice across the shots that
speak, in proportion to each shot's `dialogue` characters
(whitespace-free count — one CJK character counts the same as one
Latin letter), then snaps each interior boundary to the middle of
the nearest pause within 600ms, so a cut never clips a word. This
is agent-storyboard's `timing.mjs` (`estimateTiming` /
`applyTiming` / `dialogueKey`), re-implemented for MediaKit's
frame-exact film math: durations are whole frames at the film fps,
and each spoken run's frame sum is preserved, so the aligned film
still tiles lead + voice + tail exactly and `assemble validate`
passes on it. Two deliberate differences from the original: the
snap target is the pause MIDPOINT, not the silence start (the exact
start of a detected silence wobbles with the threshold, the middle
of a pause is silence on both sides), and the snap window is
measured on pauses of at least 0.25s (default) rather than whatever
the log happened to record. Dialogue comes from each shot's
`dialogue` field (a film-manifest field, validated like `role`),
overridden per shot by a `--lines` file `[{shot, dialogue}]`; shots
with no dialogue keep their durations. Plan mode writes nothing and
reports the `dialogue_key` (sha256 over `[[shot id, dialogue]]` in
film order), per-shot durations/deltas/snap info, and violations:
a still image or color card pushed past the 2.5s motion gate, a
text layer ending past the new shot duration, a transition longer
than its shorter neighbour, a hook window past its shot. `--apply`
writes the aligned film — never over the input — embeds the
dialogue it aligned from, re-validates the written file, and
refuses on violations or when `--expected-key` differs from the
computed key: a changed line or a reordered shot refuses with
`DIALOGUE_CHANGED` instead of silently aligning the wrong script.
Measured on the fixture (9s voice, two ~2s pauses, three 10-char
lines): boundaries snap to 3.033s (+19ms) and 6.533s (+513ms),
frames 91/105/74 = 270 exactly.

### 58f. Know the blast radius before you act — safety tiers + `estimate_conversion`

An agent that cannot tell a probe from a write will eventually
overwrite something it only meant to look at. Every tool carries
one tier — `mediakit safety` lists them, and the MCP `tools/list`
carries the same tiers as standard annotations
(`readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint`), so a client can gate on them instead of trusting
prose. READ (24 tools) only probes and writes nothing; PLAN (4)
answers a question by transient work and leaves no artifact —
`determinism` renders to a hidden work dir that is removed,
`verify_cuts` renders a draft to temp (plus caller-requested
review strips when `strips: true`), `estimate_conversion`
sample-encodes to temp, `job` only reads/cancels job state; WRITE
(57) produces a file the caller asked for and never overwrites its
own input; DESTRUCTIVE (1 — `patch_manifest`, guarded by
`expected_revision` plus a `.bak` backup) replaces a user artifact
in place. The tier is a property of the tool, not its arguments: a
WRITE tool with `dry_run=true` still reports WRITE. `download`
alone has `openWorldHint` because it alone touches the network.
This is EncodeX's `safety.ts` (READ/PLAN/WRITE/DESTRUCTIVE), with
one deliberate difference: EncodeX's DESTRUCTIVE tier is a
permission a human grants per call, while MediaKit's single
DESTRUCTIVE tool carries its guard in the call itself (revision +
backup), so no separate approval step exists to forget.

`estimate_conversion` answers "how big / how long will this
convert be" before the convert runs — measured, never a bitrate
table. At 2 window positions (25%/75% of the file) it encodes the
same start twice, video-only, at a short length (default 2s) and a
long length (default 6s) with accurate seek (`-ss` after `-i`):
both start with one keyframe, so `steady_rate = (long_bytes −
short_bytes) / (long − short)` and `iframe_bytes = short_bytes −
steady_rate × short`; full video = `steady_rate × duration +
iframe_bytes × one keyframe per 250 frames` (the x264/x265 default
GOP). Audio is copied by default (the `convert` default), so its
cost is the probed source audio bitrate × duration;
`--audio-bitrate-kbps` re-encodes audio, measured from one
audio-only sample encode. Time is a rough ETA (duration / measured
encode speed + one measured startup); size is the precise part.
Measured on the fixtures at crf 23: `hook-source` −6.1%
(280,845 vs a real convert's 299,031 bytes), `source` +4.2% at one
position — and `source.mp4` itself takes the full-encode path
(10s ≤ 2 positions × 6s) and is exact. Two traps the first version
fell into, so you don't repeat them: sampling 2s windows and
extrapolating the mean overestimated size by +45–64%, because every
2s sample carries a full keyframe per 60 frames while the real
encode carries one per 250; and `-ss` before `-i` quantizes starts
to source keyframes, so a "start 20" window was really [15,20) on
a 250-frame GOP source. A file shorter than the sample budget is
encoded whole, so the answer is exact instead of estimated. Only
libx264/libx265 — vp9/av1 use different quality knobs, so a crf
estimate would not match `convert`.

### 58g. One gate before you call a clip done — `release_checkpoint`

`verify`, `check`, `loudness`, `audio_levels`, `verify_cuts` and
`thumbnail` are the pieces; `release_checkpoint` is the gate that
runs them together and writes the verdict down, so a delivery is
never "looked fine to me". One call on the finished clip, with the
film manifest and the assemble receipt when you have them:

```bash
mediakit release-checkpoint out.mp4 --manifest film.json --receipt assemble-receipt.json
```

Six checks, in order: `receipt` (`verify` on the receipt — pass
only when 0 changed/missing, and the receipt must be for *this*
input, not some other file's clean receipt), `platform` (`check`,
default tiktok), `loudness` (pass |LUFS+14| ≤ 1.0 and true peak ≤
−1.0 dBTP, warn |LUFS+14| ≤ 2.0 and TP ≤ −0.5), `clipping`
(fail on any peak ≥ 0 dBFS), `cuts` (fail on any missing boundary
or unexpected cut; an invisible transition or a duration drift
warns instead), `contact_sheet` (a sheet at the inspection points
— the midpoint of every shot plus the midpoint of every
transition blend window, from the manifest; evenly spaced without
one — pass when the file is on disk with the right frame count).
A check with nothing to measure reports `skipped`, never a fake
pass: no receipt, no manifest, no audio stream, `--no-sheet`.
The verdict is `pass` when no check fails; the JSON
(`<stem>.checkpoint.json`, written atomically) carries the
per-check list, warnings, SHA-256, a probe summary and the
version, and the sheet (`<stem>.checkpoint-sheet.jpg`) sits next
to it. The CLI exits 0 on pass, 1 on fail — stop a delivery
script on it. This is KyaniteLabs/kinocut's `release-checkpoint`
idea, with the sheet timestamps borrowed from Synkinema's
`get_inspection_points`. Not in `batch`/`manifest` in v1.

`verify_cuts --audio` is the same idea applied to the sound at
each hard cut: it decodes 0.06s each side of the promised seam to
raw PCM and reads it in pure Node — RMS energy above −30 dBFS on
either side flags `suspect_word` (the cut may land mid-word), the
largest sample-to-sample jump ±40ms around the seam above 0.35
flags `click` (butt-splice click); either flag warns and fails
`ok`. The verdict uses RMS, not peak: a single AAC pre-echo
sample can trip a peak test inside true silence (measured: a
−24.41 dBFS peak in one 10ms sliver of a silent window whose RMS
was −51.8 dBFS). Opt-in and off by default — a canvas_scene film
mixes one continuous voice across every visual cut by design, so
with `--audio` every hard cut there flags `suspect_word`; the
check is for dialogue edits, where cuts belong in silence.
Transitions are never measured (their blend is continuous by
design); a video with no audio stream skips the check with a
note. The 0.35 click threshold comes from
mrpaidsocial/video-editor-agent and is not yet calibrated on
MediaKit footage — treat a `click` flag as "listen to this seam".
A suspect seam also carries a `suggested_fix`, not just a flag:
a click gets `add_crossfade` 25ms at the seam (their
`splice_click` fix from the same file), a cut through loud audio
gets `move_cut_to_silence` — no timestamp is invented for the
move; find the nearest silence with `silence`/`hook` on the
source and re-place the cut there. When both flags are set the
crossfade wins (it removes the click; the warning still names
the mid-word risk).

`verify_cuts --cut-sheet` is the overview to read before
opening individual 4-tile strips: one image for the whole film
(`<video-stem>.cut-sheet.png`, or `--cut-sheet-path` when
given), one row per boundary (max 12, earliest first — a film
with more boundaries keeps the first 12 and reports
`capped: true`), two columns — the last frame of the outgoing
clip (cut−0.1s) and the first frame of the incoming clip
(cut+0.1s), each tile labelled with its cut + offset +
timestamp. A single-shot film has no boundaries, so the sheet
reports `file: null` + `skipped_reason` instead of failing.
Off by default; the verify stays probe-only without it.

### 58h. Browse the catalog before you dump it — progressive discovery

89 tools is too many schemas to pay for in every turn. Don't start
from `tools/list` — start from `list_operations`: one compact line
per tool (name, family, tier, one-sentence summary), optionally
narrowed with `family` (`inspect`, `edit`, `text`, `image`,
`assemble`, `meta`). Then `describe_operation` for the full
description + input schema of only the tool you are about to call.
`list_operations` always reports the full catalog. With
`MEDIAKIT_TOOL_PROFILE=hot`, `tools/list` itself returns only the
18 hot-path tools (`probe`, `check`, `trim`, `concat`, `assemble`,
`manifest`, `loudness`, `mix`, `transcribe`, `hook`, `frames`,
`thumbnail`, `download`, `convert`, `diagnose`, `verify`,
`init_project`, `release_checkpoint`) plus the two discovery tools
— 20 total; default `full` lists everything, and the profile never
changes what you can call. This is KyaniteLabs/kinocut's
`list_operations` / `describe_operation` pattern. For the same
catalog without a live server, read `SPEC.json` at the repo root
(spec_version 1: name, family, tier, summary, description and full
JSON input schema per tool, plus `spec_hash` — the SHA-256 of the
tools array, so one string tells you whether the contract changed).
It is generated from the same registry (`npm run spec`); never
hand-edit it — `npm run check` fails when the committed file is
stale.

### 58i. Scrub frozen footage without drowning in duplicates — `extract_frames --dedup`

`extract_frames` exports every frame, so a frozen shot at 30 fps
is 300 copies of the same picture. `dedup` (0–10) drops the
near-duplicates after extraction: one extra decode into 16×16
gray thumbs, and a frame whose thumb differs from the last kept
thumb by ≤ threshold (mean abs diff, 0–255 scale) is deleted
from disk — the survivors keep their original timestamps, so
nothing renumbers. This is siemd2/reel-relay's dedup rule, and
their 2.0 default is tuned for a "watch the reel" summary, not
for scrubbing: measured on this machine, 2.0 keeps 1/20 of a
frozen clip but only 8/20 of steadily moving testsrc — it
collapses slow motion. Use 0.5–1 to drop only truly frozen
frames, 2 for a ruthless summary pass. Off by default: scrubbing
must never silently lose frames.

### 58k. Normalize before you assemble — one call to the canonical profile

Raw clips arrive in every shape: yuv444p, odd dims, 50 fps VFR, mp3
audio at 64k, rotation metadata a player applies but a filter does
not. `assemble` and `concat` normalize internally, but only as far as
the join needs — a clip that passes through untouched keeps its quirks
into the render. Run `normalize` first when clips come from mixed
sources: one call makes video libx264 + yuv420p + even dims + CFR at
the source frame rate (or `--fps`), audio AAC 192k at 48 kHz, and
`+faststart` on MP4 — and reports `before`/`after` (probe-measured)
plus a `changes` list in words, so you can see what actually moved
instead of assuming it. `--width`/`--height` fits the frame inside
that box (aspect kept, must be even — odd values are refused, not
rounded silently); `--target-lufs` also normalizes loudness with the
same two-pass loudnorm `loudness` uses. Decode autorotates, so a phone
clip stored 1280x720 with rotation 90 comes out 720x1280 and the
rotation metadata is gone with the re-encode. It always re-encodes:
a normalize that sometimes stream-copied would leave the odd dims /
VFR timebase in the chain, which is exactly what the step exists to
remove. Video inputs must write .mp4/.mov/.m4v (use `convert` for
other containers); audio-only inputs write an audio format. Also a
batch operation and a manifest step — put it first in a manifest, so
every later step works on a known profile.

## Workflow: vertical captioned clip from a landscape source

1. `probe` the source.
2. `cropdetect` — if it reports black bars, `crop` to the suggested rectangle first.
3. `reframe --mode crop` to 1080×1920 (or `--mode blur` for the blurred-fill look).
4. Write an SRT from the script/voiceover with `generate_srt` — word
   timings when you have them (semantic grouping), hand-written cues
   only when you don't.
5. `burn_captions` with the locked style's values from
   `skills/shorts-video/styles.json` (`clean-bold`: background, 60px,
   margin 500).
6. `loudness` to −14 LUFS.
7. `qa_report --target tiktok` (plus `--expected-duration` when the length is fixed) — the delivery gate: all checks must pass. `check --platform tiktok` is for platform-spec detail when the gate fails.
8. `thumbnail` — look at the timestamped contact sheet to confirm the cut, captions and framing before publishing; `extract_frame` at a mid timestamp to verify the captions actually render.
9. `overlay` the channel logo (`--position top-right --opacity 0.8`) when the clip is branded — verify with another `extract_frame` at the logo corner.
10. `package` the finished file with `--platform tiktok` and the captions — the delivery ZIP. When the file goes out on its own (no ZIP), write a `receipt` instead — same provenance, standalone JSON.

See `skills/shorts-video/SKILL.md` for the full scripted workflow.
