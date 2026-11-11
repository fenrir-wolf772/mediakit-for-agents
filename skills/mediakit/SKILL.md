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
re-cut blind.

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
not sample-exact broadcast mastering.

### 7. Captions must exist before you burn them
`burn_captions` needs a real `.srt`, `.ass`, or `.vtt` file. If the user
only has raw text, write the SRT yourself first (format below), then burn.
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
text) — pass `--font-size` / `--margin-v` only to override. Style with
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
28+ for small files.

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
is the cheaper one-image overview when you only need the gist. Format
tip: for screen recordings or any text-heavy footage use png (the
default) or webp, not jpg — JPEG chroma subsampling smears 1px text and
thin borders, so a jpg frame can look broken when the video itself is
fine.

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
real answer, not a failure.

### 15. Stream-copy cuts must land on keyframes
A lossless `--stream-copy` trim can only start/end on keyframes — ask
for 1s–3s on a clip whose keyframes are at 0s and 8.33s and ffmpeg
silently widens the cut. Run `keyframes` first (probe-only: timestamps
+ GOP interval), then `trim --stream-copy --snap` to move the start
down and the end up to the nearest keyframes; the result reports the
requested range and the actual range — read both, don't assume. If the
snapped range is wider than you can accept, re-encode instead
(`trim` without `--stream-copy` is frame-accurate). `--snap` without
`--stream-copy` is refused: there is nothing to snap.

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
format is refused. `mix ... --dry-run` prints the exact ffmpeg command
that would run (with the real voice gain measured from the files) and
writes no file — read the command before a long render, then run the
same call without `--dry-run`. The probe and loudnorm measurement still
run in dry-run mode, but they are read-only.

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
from the size + duration budget, with a 2% safety margin, and the
result reports `target_met` measured on disk. It ignores `--quality`
and refuses `--crf` outright (the bitrate comes from the size, not a
CRF). A target below the floor (100 kbps video + 128 kbps audio) is
refused with the minimum size spelled out — raise the target or
`--max-width` the video down first.
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
reconstructing the command from memory.

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

## Workflow: vertical captioned clip from a landscape source

1. `probe` the source.
2. `cropdetect` — if it reports black bars, `crop` to the suggested rectangle first.
3. `reframe --mode crop` to 1080×1920 (or `--mode blur` for the blurred-fill look).
4. Write an SRT from the script/voiceover with `generate_srt`.
5. `burn_captions` with a large font size.
6. `loudness` to −14 LUFS.
7. `check --platform tiktok` — all rules must pass.
8. `extract_frame` at a mid timestamp to verify the captions actually render.
9. `overlay` the channel logo (`--position top-right --opacity 0.8`) when the clip is branded — verify with another `extract_frame` at the logo corner.
10. `package` the finished file with `--platform tiktok` and the captions — the delivery ZIP. When the file goes out on its own (no ZIP), write a `receipt` instead — same provenance, standalone JSON.

See `skills/shorts-video/SKILL.md` for the full scripted workflow.
