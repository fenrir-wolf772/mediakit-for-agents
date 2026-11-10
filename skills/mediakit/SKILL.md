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
  read the image. For an overview of the whole clip: `thumbnail`.
- **Audio is too quiet/loud or inconsistent**: `loudness` (default −14 LUFS).
- **User asks to join clips**: `concat`.
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
Shorts look); `--mode pad` uses black bars. Use `--x`/`--y` to anchor
the crop window when the subject isn't centered. `crop` + `resize`
remain for exact pixel rectangles only.

### 4. Check before you publish
After the last edit, run `check --platform tiktok` (or `reels`,
`shorts`, `youtube`). It measures the real file — never trust the
tool that produced it. `pass: false` means fix the listed issues
(each carries a hint) and check again; never report "ready" with a
failing check.

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
Single-pass loudnorm (what this tool does) is fast and good for speech and
creator audio; it is not sample-exact broadcast mastering.

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
span a sentence break awkwardly. For vertical video use `--font-size 48`
or larger — 24px is for 720p landscape.

### 8. Concat re-encodes — that's a feature
`concat` re-encodes all parts to one codec, so clips with different
resolutions, codecs, or frame rates join cleanly. It is slower than a
stream-copy concat, but it doesn't fail on mismatched inputs.

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

## Workflow: vertical captioned clip from a landscape source

1. `probe` the source.
2. `cropdetect` — if it reports black bars, `crop` to the suggested rectangle first.
3. `reframe --mode crop` to 1080×1920 (or `--mode blur` for the blurred-fill look).
4. Write an SRT from the script/voiceover.
5. `burn_captions` with a large font size.
6. `loudness` to −14 LUFS.
7. `check --platform tiktok` — all rules must pass.
8. `extract_frame` at a mid timestamp to verify the captions actually render.
9. `package` the finished file with `--platform tiktok` and the captions — the delivery ZIP.

See `skills/shorts-video/SKILL.md` for the full scripted workflow.
