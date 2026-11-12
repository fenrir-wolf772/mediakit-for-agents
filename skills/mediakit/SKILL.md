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
not a broken folder. Keep the output dir outside the input tree when
you can (files under it are never treated as inputs), and use
`--dry-run` first when the glob is new, so you see the planned outputs
before anything encodes.

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
thumbnail sheet labels each tile with its own timestamp in seconds
(`%{pts}` — measured: `%{pts:hms}` renders literally on ffmpeg
8.1.2, so plain seconds are used), so read the times off the sheet
when you decide where to cut.

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
(`trim`/`resize`/`reframe`/`compress`/`convert`/`extract_audio`/
`reverse`/`grade`/`fit`/`silence`/`denoise`/`interpolate`/
`burn_captions`/`overlay`/`chroma_key`); multi-input work (`concat`, `mix`,
`mux`, `pip`) stays a separate call before or after the manifest.

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
extract a frame first. Verify a zoom the same way the test suite
does: frame 0 against the full image scaled, the last frame against
the zoomed window cropped by hand — both must match within a few dB
of PSNR, and the last frame must be clearly closer to the zoomed
crop than to the full image.

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
