# MediaKit for Agents

Give your coding agent eyes and ears for media. MediaKit is a small MCP
server + CLI that wraps **ffmpeg** — trim, crop, resize, captions, loudness,
thumbnails, frame grabs, audio extraction, concat with transitions,
conversion, silence removal, black-bar measurement, delivery packaging,
provenance receipts, file compression with named quality presets,
voice/music mixing with sidechain ducking, logo overlays, scene-cut
detection, color grading, and an environment preflight — so an
agent can actually *work* with video and audio instead of guessing.

> Coding agents are blind and deaf to media. They can read a 10,000-line
> codebase but can't tell you how long a clip is, pull a frame from it, or
> make it vertical. MediaKit fixes that with one install.

## Quickstart

```bash
npx mediakit-for-agents probe clip.mp4
```

Or install it globally:

```bash
npm install -g mediakit-for-agents
mediakit trim clip.mp4 --start 2 --duration 8 -o clip-short.mp4
```

### Use it from Claude Code / Cursor / Codex (MCP)

Add to your MCP config (`.mcp.json` or your client's settings):

```json
{
  "mcpServers": {
    "mediakit": {
      "command": "npx",
      "args": ["-y", "mediakit-for-agents", "mcp"]
    }
  }
}
```

Then ask your agent things like:

- *"How long is this video, and what's its resolution?"*
- *"Make this clip vertical 1080×1920 and burn the captions in."*
- *"Normalize the voiceover to -14 LUFS and pull out the audio as MP3."*

**Requirements:** `ffmpeg` and `ffprobe` on your PATH
([ffmpeg.org/download](https://ffmpeg.org/download.html)). Node 18+.

## Tools

| Tool | What it does | CLI |
|---|---|---|
| `probe` | Duration, dimensions, codecs, streams (ffprobe) | `mediakit probe in.mp4` |
| `trim` | Cut a clip by start + duration/end (times accept seconds or `MM:SS`) | `mediakit trim in.mp4 --start 2 --duration 5 -o out.mp4` |
| `fit` | Fit a file to an exact target duration: `speed` (up/down, factor 0.25–4x), `trim` (cut longer), `loop` (repeat shorter) — reports the duration actually measured. `--max-fps` caps the output frame rate (only ever lowers it) | `mediakit fit in.mp4 --duration 0:30 -o out.mp4` |
| `crop` | Crop to a rectangle (w, h, x, y) | `mediakit crop in.mp4 --width 720 --height 1280 -o out.mp4` |
| `resize` | Resize, keeping aspect ratio by default; `--preset 360p|480p|720p|1080p|2160p` fits the frame inside that box and never upscales | `mediakit resize in.mp4 --preset 720p -o out.mp4` |
| `extract_audio` | Pull the audio track out (mp3/aac/wav/ogg/opus/flac); `--whisper` forces the Whisper ASR preset — 16 kHz mono WAV, output renamed to .wav when needed; `--channel <n>` (0-based) picks one channel out of a multi-channel input and returns it as mono | `mediakit extract-audio in.mp4 -o out.mp3` |
| `extract_frame` | Grab one frame at a timestamp | `mediakit extract-frame in.mp4 --timestamp 3.5 -o frame.png` |
| `thumbnail` | Contact sheet of N evenly spaced frames — each tile is labelled with its own timestamp in seconds by default (`--no-timestamps` for a clean sheet), so the sheet shows WHEN each frame is, not just what it shows | `mediakit thumbnail in.mp4 --frames 6 -o sheet.jpg` |
| `frames` | Extract N evenly spaced frames as separate images, each with its timestamp — so an agent can look at a video before cutting it. For screen recordings or text-heavy footage use png (default) or webp, not jpg — JPEG chroma subsampling smears 1px text and thin borders | `mediakit frames in.mp4 -o frames/ --count 6` |
| `loudness` | Normalize to a loudness target (default −14 LUFS) — two-pass: measures first, applies the exact gain, re-measures the output and reports the real `output_lufs`; warns when the input is peak-limited and the target cannot be reached | `mediakit loudness in.mp3 -o out.mp3` |
| `concat` | Join 2+ files into one; auto-detects identical clips and stream-copies them (fast, lossless), otherwise re-encodes; `--transition fade` crossfades between clips with xfade + acrossfade; per-clip trim with `path@start-end` (seconds or MM:SS) or `{file, start, end}` — trims always re-encode with exact cuts | `mediakit concat a.mp4 b.mp4 -o joined.mp4` |
| `burn_captions` | Burn .srt/.ass/.vtt subtitles into the video — font size and position default to the safe zone and scale with frame height (~60px type on 1080x1920, ~500px above the bottom edge so platform UI never covers the text); `--style background|outline|shadow|glow` (background = white text on a semi-transparent black box, the default; glow = halo in the text colour, reads on bright footage; .ass files carry their own styles) | `mediakit burn-captions in.mp4 --captions subs.srt -o out.mp4 --style outline` |
| `convert_captions` | Convert a subtitle file between SRT and VTT (cue text carried verbatim; VTT cue settings are dropped and counted) | `mediakit convert-captions subs.srt -o subs.vtt` |
| `generate_srt` | Build a deterministic .srt from a cue list [{start, end, text}] — pure text, no ffmpeg; times in seconds or MM:SS; cues must be in order and must not overlap. Or from word timings [{start, end, word}] with `--words-file`: words are grouped into semantic cues (max 8 words, 3.5s, 84 chars / 2 lines of 42; split on pauses >0.4s and sentence ends; a cue never ends on a stranded word) and the grouping report is returned | `mediakit generate-srt --cues-file cues.json -o subs.srt` or `mediakit generate-srt --words-file words.json -o subs.srt` |
| `publish_kit` | Thumbnail & Publishing Kit: from a finished video + a 1280x720 16:9 thumbnail + copy (exactly 5 titles, description, tags, pinned comment, optional chapters) in a kit JSON, write `metadata.md` + `publishing.json` and report a pre-publish checklist — thumbnail size, titles and chapter times are verified against the measured duration; mobile readability, title/cover fidelity and licences are marked human-review, never passed. Publishes nothing | `mediakit publish-kit out.mp4 --thumbnail thumb.png --kit-file kit.json -o publishing/ --style clean-bold` |
| `transcribe` | Transcribe speech to a .srt with a LOCAL engine (no cloud, audio never uploaded) — faster-whisper by default, whisper.cpp with `--engine whisper` (`MEDIAKIT_WHISPER_CPP_BIN` / `MEDIAKIT_WHISPER_MODEL` point at the CLI binary + ggml model; auto prefers faster-whisper, then whisper.cpp); writes the .srt and returns the segments with timestamps, detected language and full text — the direct input for `burn_captions`. The engine is optional: with no engine installed the call fails with install lines (`MEDIAKIT_ASR_PYTHON` picks the python that has faster-whisper, `MEDIAKIT_ASR_MODEL` the default model, tiny). Silence transcribes to 0 segments and an empty .srt. `--chunk-seconds 300` splits long files into 300s chunks (2s overlap, segments re-offset onto the full timeline) so hour-long recordings transcribe without one giant ASR run; a phrase at a boundary may repeat, and a file shorter than one chunk runs as a single chunk. `--word-timestamps` also returns per-word timings in the printed JSON (words: [{index, start, end, word}]) — the input `cut_words` cuts by; save the printed JSON to a file and pass it as `--words-file` | `mediakit transcribe speech.mp3 -o subs.srt --model tiny` |
| `reframe` | Reframe to a target aspect/size in one step (crop, pad, or blurred fill) — crop mode takes a named `--anchor` (left/right/top/bottom/...) to keep an edge subject in frame, and reports `crop_kept_percent` + a warning below 40% kept | `mediakit reframe in.mp4 --mode crop -o vertical.mp4` |
| `check` | Verify a file against a platform spec (tiktok/reels/shorts/youtube/instagram-feed/instagram-story/linkedin) — video bitrate is a warning, not a gate; overall pass ignores warnings. `--content` also scans for black/frozen frames, silence and audio peaks in one decode pass, with position-aware rules (short black at the very start/end warns as a likely fade; the same stretch mid-file fails) — a peak ≥ 0 dBFS fails as clipping, a peak above `--peak-threshold` (default −1 dBFS) warns; `--start`/`--end` scan only that time range, on the file's own timeline | `mediakit check out.mp4 --platform tiktok --content` |
| `qa_report` | One-call delivery gate for a finished file: even dimensions, yuv420p pixel format, frame rate, aspect ratio and length for the target, measured loudness in −16..−12 LUFS and true peak, black/frozen frames and dead air (silence over 2s), pacing (average shot length from real scene cuts), and an optional `--expected-duration`. Probe-only — writes no file. Returns one verdict (pass/warn/fail) plus a per-check list. Run this, plus `thumbnail`, on every deliverable before calling it done | `mediakit qa-report out.mp4 --target tiktok --expected-duration 60` |
| `grade` | Color-grade a video with a named preset — `warm` (red up, blue down), `cool` (the opposite), `cinematic` (contrast up, saturation down, slight teal), `noir` (black and white), `vintage` (faded, desaturated) — or one custom filter chain with `--filter`, or an ASC CDL grade with `--cdl-slope/--cdl-offset/--cdl-power r,g,b --cdl-saturation N` (mutually exclusive with preset/filter; per-channel LUT, near realtime); reports the mean R/G/B before and after, measured on the middle frame | `mediakit grade in.mp4 --preset warm -o out.mp4` |
| `reverse` | Play a clip backwards: video frames reversed, audio reversed too by default (`--no-audio` keeps the audio playing forward); works on audio-only input as well. The `reverse` filter buffers every frame, so very long inputs cost memory | `mediakit reverse in.mp4 -o backwards.mp4` |
| `interpolate` | Raise the frame rate with motion interpolation (`minterpolate`): 30fps to 60fps for smoother playback or slow motion. Modes: `blend` (fast default, cross-fades neighbours), `mci` (true motion compensation, best quality but much slower — ~9x realtime on CPU), `dup` (repeats frames). Only raises the frame rate; use `fit --max-fps` to lower it. Reports fps and frame counts measured on the output file | `mediakit interpolate in.mp4 --fps 60 -o smooth.mp4` |
| `denoise` | Reduce sensor noise: `hqdn3d` (fast default) or `nlmeans` (better on fine detail, much slower). Strength 0–1 maps to hqdn3d 0–30 (0.5 is 15, the level that gained +2.9 dB PSNR on sigma-10 noise in testing) or nlmeans `s` 0–10. Reports high-frequency noise energy before and after, measured on disk | `mediakit denoise noisy.mp4 --strength 0.5 -o clean.mp4` |
| `chroma_key` | Remove a green/blue screen: keys out one hex color (`--color 00FF00`, `--similarity` 0–1, `--blend` 0–1). Without `--background` the output keeps transparency and must be `.mov` (ProRes 4444 — `.mp4` has no alpha, and this ffmpeg build drops VP9 alpha in `.webm`). With `--background <image\|hex-color>` the subject is composited onto it and the output is a flat `.mp4`/`.webm`. Reports the alpha measured on disk (middle frame): full-frame mean, corner (~0 for a full-screen key) and center (~255 on the subject) | `mediakit chroma-key greenscreen.mp4 -o keyed.mov` |
| `zoom_pan` | Ken Burns effect: turn a still image into a moving clip. Zooms linearly from `--zoom-from` to `--zoom-to` while the focus point moves from (`--focus-x`, `--focus-y`) to (`--focus-end-x`, `--focus-end-y`), 0–1 fractions of the frame. The input is pre-scaled 1.25x before zooming to avoid zoompan's integer-crop jitter. Input must be a still image, not a video. Reports frame count measured on the output file | `mediakit zoom-pan photo.png --duration 5 --zoom-to 1.5 -o kenburns.mp4` |
| `image_to_video` | Turn one still image into a fixed-duration video that holds still (no motion — use `zoom_pan` for Ken Burns). Dimensions default to the image itself; `--width`/`--height` fit the image inside the box and pad black to the exact size. `--audio` loops an audio file to the same duration (a short bed loops, a long one is trimmed). Output `.mp4` (H.264) or `.webm` (VP9). Reports frame count measured on the output file — exactly round(duration×fps) | `mediakit image-to-video cover.png --duration 5 --audio song.mp3 -o still.mp4` |
| `slideshow` | Turn 2–32 still images into one video with an xfade transition between every pair (one transition type for all pairs in v1 — any of the 49 names `concat` accepts, `fade` by default). Each image is visible for its own duration (`--duration`, `--durations 3,5,2`, or `{file, duration}` per image), so the total is exactly the sum of the durations — the transition eats a handle, not slide time. Images are rendered to clips in parallel first, then joined with the `concat` xfade chain. `--audio` loops a bed under the whole slideshow. Output `.mp4` only in v1; the output always carries an audio track (silent unless `--audio` is given, because the xfade join needs one for `acrossfade`). Reports frame count measured on the output file | `mediakit slideshow a.png b.png c.png -o show.mp4 --durations 3,5,2 --transition wipeleft` |
| `cut_words` | Cut words out of a talking-head clip by transcript: filler words (um/uh), false starts and restarts, using word timings from `transcribe --word-timestamps` (save its printed JSON and pass it as `--words-file`). Select by word text (`--remove um,uh`), the built-in filler set (`--fillers`: um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh), or 0-based word-index ranges (`--indices 0-5,96-98`); `--keep` rescues indices even when matched. Keep runs are padded 0.06s before / 0.12s after, clamped so a cut never keeps a fragment of the word it removed, and kept words that end up mostly cut out are reported in `cut_check.swallowed`. `--dry-run` prints the plan and writes nothing; no match stream-copies the input unchanged. "like" / "you know" are not fillers — cut them only via `--remove` | `mediakit cut-words take.mp4 --words-file words.json --fillers -o clean.mp4` |
| `segment` | Cut a video into an HLS VOD playlist (`index.m3u8` + `.ts` segments) in a directory, ready to serve statically. Stream-copy by default (fast, lossless) — but segments can only start on keyframes, so actual lengths follow the source GOP; `--reencode` re-encodes to libx264/aac with forced keyframes for exact segment boundaries. Reports the segment count and durations parsed back from the playlist on disk | `mediakit segment in.mp4 --segment-time 6 -o hls/` |
| `batch` | Apply one operation to every file matching a glob under a folder — `loudness`, `resize`, `reframe`, `compress`, `convert`, `extract_audio`, `reverse`, `grade`, `fit`, `trim`, `silence`, `chroma_key` or `cut_words`, same args for all. Outputs are `<stem>-<operation>.<ext>` under the output dir, mirroring the input tree; `batch-manifest.json` records one row per file (`ok`/`error`/`cached`/`skipped`, in input order). Unchanged files are skipped via a content-hash cache (verified against the cached output's size + sha256); `--jobs N` runs files in parallel under one shared `--timeout`; `--dry-run` lists the planned outputs and writes nothing. `cut_words` finds each clip's words file by convention — `<words_dir>/<stem>.words.json`, default the input's own folder — and a clip with no words file fails its own row only | `mediakit batch loudness --pattern '**/*.mp4' --input-dir clips/ -o out/ --args-json '{"target_lufs": -14}'` |
| `manifest` | Run a whole edit pipeline from one declarative JSON manifest: `{version: 1, input, output, steps: [{tool, args}], qa?}` — paths relative to the manifest file. Steps run in order (`trim`, `resize`, `reframe`, `compress`, `convert`, `extract_audio`, `reverse`, `grade`, `fit`, `silence`, `denoise`, `interpolate`, `burn_captions`, `overlay`, `chroma_key`, `cut_words`), each feeding the next; the whole plan is validated before anything renders, so a typo fails in seconds, not after step 3 of 5. Each step is cached by content hash (verified against the cached output's size + sha256) — re-running an unchanged manifest re-encodes nothing, and editing step 3 only re-runs from step 3. Sidecar files (`captions`, `overlay`, `words_file`, and a `chroma_key` image `background` — a hex background is a color, not a file) resolve relative to the manifest and are hashed into the step cache, so editing the background image re-runs the key step. `--dry-run` lists the planned steps and writes nothing; `qa` runs `qa_report` on the final file | `mediakit manifest recipe.json -o final.mp4` |
| `assemble` | Film assembler (Autopilot-style): build a finished video from one declarative film manifest — shots on a voice-led timeline, mixed audio, burned captions, QA + receipt. The voice is the master clock: total = lead + measured voice duration + tail, and shot durations must cover it exactly in frames. Four modes: `validate` (no writes), `preview` (first N seconds at half size — show it to the user), `approve` (records the fingerprint of the previewed files), `render` (needs a matching approval unless `--force`, recorded as `approval:'forced'`). Shot kinds: `image` (with `zoom` → `zoom_pan`, without → a still hold, motion gate 2.5s), `video` (trimmed + reframed), `color` (solid card, motion gate 2.5s). A shot after the first may carry `transition: {type, duration}` — one of the 49 xfade names `concat` accepts, centered on the cut, video-only (the audio timeline is untouched); video shots need the handle footage to exist in their source. Segments are cached by content hash, so a re-render rebuilds only changed shots. NOT the `manifest` tool (linear edit pipeline) | `mediakit assemble film.json --mode validate` then `--mode preview -o out/` → `--mode approve -o out/` → `--mode render -o out/` |
| `silence` | Remove silent stretches, keeping a margin around speech | `mediakit silence in.mp4 -o tight.mp4` |
| `cropdetect` | Measure letterbox/pillarbox bars; returns the crop rect + a ready crop command | `mediakit cropdetect in.mp4` |
| `package` | Bundle a finished file for delivery: media + spec.json receipt + checksums.sha256 (+ captions) | `mediakit package out.mp4 -o delivery.zip --platform tiktok` |
| `receipt` | Write a provenance receipt (JSON sidecar) for a finished file: probe, SHA-256, size, measured loudness, optional platform check, ffmpeg versions — re-run `sha256sum` against it any time to prove the media has not changed | `mediakit receipt out.mp4 -o out.receipt.json --platform tiktok` |
| `mux` | Replace a video's audio track with an external audio file, stream-copying both (no re-encode: fast, lossless); `--audio-offset` shifts the new audio against the video (positive = audio later, negative = video later); `--shortest` stops at the shorter stream; `--dry-run` prints the ffmpeg command and writes no file | `mediakit mux video.mp4 voice.mp3 -o out.mp4 --audio-offset 0.5` |
| `mix` | Mix voice over a music bed with sidechain ducking (bed drops under speech), then master to target LUFS; reports the ducking actually measured. `--sfx <file>@<s>` drops a short sound at an exact timestamp (repeatable, mixed after ducking). `--dry-run` prints the exact ffmpeg command and writes no file | `mediakit mix voice.mp3 --music bed.mp3 -o mixed.mp3 --sfx ding.mp3@3` |
| `overlay` | Overlay a logo/watermark image (named position, margin, scale, opacity, optional timing) | `mediakit overlay in.mp4 --image logo.png -o out.mp4 --position top-right` |
| `pip` | Picture-in-picture: a second video over the main one (9 positions, size by width or scale, opacity, optional timing, audio main/pip/mix) | `mediakit pip main.mp4 --pip facecam.mp4 -o out.mp4 --position bottom-right` |
| `titlecard` | Render a title card PNG: big bold hook (3-6 words) on a coloured box, transparent canvas — overlay it onto frame 1 or use it as the opening card. `--style clean-bold\|minimal-line\|warm-story` uses that style's locked palette from `skills/shorts-video/styles.json` (text/box/font); an explicit colour/font overrides just that one locked value and is reported in `style_overrides` | `mediakit titlecard "The Moon Is Leaving Us" -o title.png --style clean-bold` |
| `intro` | Render a short intro clip: title on a solid-colour background, fading in and out (silent video) — concat it in front of the main clip. `--style` reuses the same locked palette (box colour becomes the background) | `mediakit intro "Welcome Back" -o intro.mp4 --duration 3 --style clean-bold` |
| `social` | Export one video to several platform specs in one call: reframe + trim to max duration + loudness + check each, writing `<base>-<platform>.mp4` + `manifest.json` | `mediakit social in.mp4 -o out/ --platforms tiktok,reels,shorts` |
| `scenes` | Detect scene changes / hard cuts; returns cut timestamps + segments (probe-only) | `mediakit scenes in.mp4` |
| `keyframes` | List keyframe (I-frame) timestamps + GOP min/max/avg interval (probe-only) — check before a stream-copy trim | `mediakit keyframes in.mp4` |
| `find` | Find media files by name, recursively under a directory (case-insensitive substring); each match comes back with probe info (duration, dimensions, codecs) so you pick the right file without guessing paths | `mediakit find clips/ --name moon` |
| `svg_animate` | Animate an SVG into a video, code-driven (no browser): keyframed translate/scale/rotate/opacity on elements by id, rendered frame by frame via librsvg — slide-ins, fades, bounces, spinning shapes | `mediakit svg-animate in.svg --anim anim.json -o out.mp4 --duration 4` |
| `doctor` | Read-only preflight: ffmpeg version, filters/encoders, tool availability, the `MEDIAKIT_WORKDIR` sandbox state when set, and a `gpu` section — hardware encoders present in the build plus which one (if any) actually passed a tiny probe encode, so "listed" is never mistaken for "usable". An unavailable tool also reports a one-sentence `fix` telling you how to repair the ffmpeg install | `mediakit doctor` |
| `convert` | Change container/codec (omit a codec to stream-copy). `--gop <frames>` / `--gop-seconds <s>` sets an exact keyframe interval on re-encode (scene-cut keyframes disabled for libx264/libx265/mpeg4) — the spacing is measured on the output file | `mediakit convert in.mov -o out.mp4 --video-codec libx264 --gop-seconds 2` |
| `compress` | Shrink a file with one named quality preset — low (CRF 32), medium (CRF 26), high (CRF 20), or `email-25mb` (targets 18 MB so the file still fits a 25 MB email attachment after base64 inflation) — each with its own x264 preset and audio bitrate; optional `--max-width` scales down first. `--target-size <MB>` encodes to an exact size instead (two-pass ABR, e.g. 10 for a Discord upload, 10% safety margin) and reports `target_met` measured on disk. In target-size mode a resolution ladder steps the frame down (1080→720→480→360→240) when the bitrate buys less than 0.045 bits per pixel per frame, so a starved encode stays watchable instead of mush; `--no-resolution-ladder` keeps the source frame. Reports the size before/after and the reduction actually measured on disk | `mediakit compress in.mp4 -o small.mp4 --quality low` |
| `export_gif` | Export a clip (or segment) as an animated GIF with a two-pass palette (palettegen + paletteuse from the actual frames). Fits under `--max-size-mb` (default 10 MB, the GitHub README limit; Slack auto-plays only under ~2 MB) by stepping down fps, then width, then palette colours; reports `size_budget_met` measured on disk, with a warning when the budget cannot be met | `mediakit export-gif in.mp4 -o demo.gif --max-size-mb 2` |

Every tool returns a concise JSON result: output path, size, and the
verified duration/dimensions of what it produced.

## MCP Resources (`videos://...`)

Besides tools, the server exposes three workspace-scoped resources so
a client can look around before calling a tool — no guessing paths:

| Resource | What it returns |
|---|---|
| `videos://list` | Every media file under the workspace root (recursive, sorted, capped at 200) with relative path, size and extension |
| `videos://{filename}/metadata` | `probe` output for one file by relative path, e.g. `videos://test/source.mp4/metadata` — nested paths work (`test/nested/deep-clip.mp4`) |
| `videos://workspace/info` | Workspace root, ffmpeg/ffprobe versions, tool availability, media file count, GPU state |

The root is `MEDIAKIT_WORKDIR` when set, otherwise the process working
directory. Resources are always confined to that root: `..`, absolute
paths and symlinks pointing outside are refused — even with the sandbox
off. A resource can never address a file outside the workspace.

## Demo: 16:9 clip → vertical captioned Short

<p align="center"><img src="demo.gif" alt="MediaKit turning a 16:9 clip into a vertical 1080×1920 Short with burned-in captions" width="270"></p>

```bash
# 1. Inspect the source
mediakit probe input.mp4

# 2. Reframe 16:9 -> 9:16 vertical in one step (crop | pad | blur)
mediakit reframe input.mp4 --mode crop -o vertical.mp4

# 3. Burn captions on
mediakit burn-captions vertical.mp4 --captions captions.srt -o short.mp4

# 4. Normalize loudness, then verify against the TikTok delivery spec
mediakit loudness short.mp4 -o short-loud.mp4 --target-lufs -14
mediakit check short-loud.mp4 --platform tiktok   # pass: true when ready

# 5. Bundle it for delivery: media + spec.json receipt + checksums + captions
mediakit package short-loud.mp4 -o delivery.zip --captions captions.srt --platform tiktok
# Verify the bundle anywhere: unzip -l delivery.zip, then sha256sum -c checksums.sha256 inside
```

`reframe --mode blur` fills the empty area with a blurred copy of the
frame (the classic Shorts look); `--mode pad` uses black bars instead.
`--x`/`--y` anchor the crop window when the subject isn't centered.
`check` measures the real file — dimensions, codecs, fps, duration limit,
audio channels and integrated LUFS — and reports pass/fail per rule with
a fix hint. It also checks video bitrate against the platform's
recommended ladder (YouTube's published figures: 1080p 8 Mbps @30fps /
12 @60fps, 720p 5 / 7.5 — TikTok/Reels publish no bitrate, so the same
ladder is the working figure) as a **warning only**: a low or oversized
bitrate never fails the check, it is listed under `warnings`. TikTok also
gets a file-size rule (<= 287 MB, the mobile-app upload limit). The
result reports the platform's text-safe zone — keep captions inside that
rect, clear of the UI chrome. Platforms: `tiktok`, `reels`, `shorts`,
`youtube`. `fit` makes a clip exactly N seconds long: `--method speed`
(default) plays it faster/slower (`setpts` + chained `atempo`, factor
0.25–4x), `trim` cuts a longer source, `loop` repeats a shorter one —
the result reports the duration measured on disk (`duration_error_seconds`
is usually 0.00s). `--max-fps` caps the output frame rate (1–120) —
it only ever lowers fps, never raises it by duplicating frames, and it
is measured against the *effective* fps: a 2x speed-up turns a 30fps
source into 60fps, so `--max-fps 30` still caps it. Times everywhere accept seconds or `MM:SS`
(`--duration 0:30`, `trim --start 1:30`).
`silence` cuts dead air out of speech/video (detects with `silencedetect`,
keeps a 0.2s margin around speech so words are never clipped);
`--detect-only` reports the silence/kept segments without writing a file,
so probe before you cut. `cropdetect` measures the black bars on a source
before you crop or reframe it — it samples frames across the whole file
(the first frames are often a dark fade-in) and returns the most common
crop rectangle plus a ready-to-run `crop` command. `package` is the last
step: a ZIP with the finished media, a `spec.json` receipt (measured probe
+ loudness + the platform check result), `checksums.sha256`, and the
captions sidecar when given — the bundle proves what was delivered, and
`sha256sum -c` verifies it on any machine. `mix` lays a voice track over a
music bed: the voice is levelled to `--voice-lufs` (−16) first, the bed is
ducked under the voice with `sidechaincompress` (`--duck-db` 12,
`--attack-ms` 100, `--release-ms` 400), the music loops to the voice
length, and the mix is mastered to `--target-lufs` (−14) — if the voice
file is a video its video stream is copied through. It reports the
ducking it actually achieved (`ducking_measured_db`, measured on the
ducked bed alone in a speech window vs a silence window), so tune
`--duck-db` from a measured number, not a guess. `concat --transition
fade|wipeleft|dissolve|...` joins clips with a real crossfade instead of
a hard cut: every clip is normalized to the first clip's size/fps first
(in one filter graph, no intermediate files), then chained with `xfade`
+ `acrossfade` — output duration is sum(durations) minus (n−1) ×
transition length, and a clip without audio gets a silent bed so the
audio crossfade still works. `frames` pulls N evenly spaced frames out
as separate `frame-001.png` files with timestamps, so an agent can look
at what's actually in a clip before deciding where to cut — use it
instead of guessing from `probe` alone. `overlay` puts a logo or
watermark on a video: named position (`top-right` default, `top-left`,
`bottom-left`, `bottom-right`, `center`), `--margin`, `--width` (keeps
aspect), `--opacity`, and `--start`/`--end` to show it only in a time
window — x/y are computed from the probed frame size, never typed as
filter expressions. `pip` is the same idea for video-on-video
(facecam/reaction): 9 positions, size by `--width` or `--scale`
(fraction of the main width, default 0.25), `--opacity`, `--start`/`--end`,
and `--audio main|pip|mix` — the PiP clip loops so it never runs out
inside its window, and the output is capped at the main video's length.
`concat` probes the clips first: when they are identical (codec, size,
fps, pixel format, audio) it stream-copies them — fast and lossless —
and otherwise re-encodes, naming every mismatch in `fast_skipped`;
`--fast` requires the copy path (errors with the mismatch instead of
falling back) and `--no-fast` always re-encodes. Per-clip trim: give an
input as `path@start-end` on the CLI or `{file, start, end}` over MCP
(times in seconds or MM:SS, either side may be empty) — each clip is
cut with `trim`/`atrim` in one filter graph and joined with the `concat`
filter, so the cuts are frame-accurate; that path always re-encodes, and
`--fast` refuses a trim outright. Do NOT implement trims with the concat
demuxer's `inpoint`/`outpoint`: measured 2026-11-12, trimming 2–5s +
1–4s stream-copied 8.09s instead of 6s (8.13s re-encoded through the
demuxer) — the demuxer does not cut accurately on this ffmpeg. Trims
also work with `--transition`: the fade is computed on the trimmed
timeline (output is sum of trimmed durations minus (n−1) × transition). `scenes` is probe-only: it lists hard cuts and the
segments between them so you trim on real boundaries; the default
threshold 0.3 catches real cuts, and a hard cut between flat colours
scores ~0.4, so keep the threshold at or below 0.4. `keyframes` is
probe-only: it lists every I-frame timestamp plus the GOP interval, so
you know where a lossless cut can land — `trim --stream-copy --snap`
snaps the requested start down and end up to the nearest keyframes and
reports both the requested and the actual range. `check --content`
adds one decode pass that scans for black frames, frozen frames,
silence and audio peaks and folds them into the same pass/fail list — a short black
stretch at the very start/end is a warning (likely a fade in/out), the
same stretch mid-file fails, and a missing stream reports "unavailable"
instead of a fake zero. Audio peaks are measured in 0.1s windows above
`--peak-threshold` (default −1 dBFS): a window at or above 0 dBFS fails
as digital clipping, anything above the threshold warns. `--start` /
`--end` (seconds or `MM:SS`) scan only that time range — useful on a
long file — and every interval is still reported on the file's own
timeline. `grade` applies a colour look in one call: five named presets
(`warm`, `cool`, `cinematic`, `noir`, `vintage`) or one custom filter
chain with `--filter` (mutually exclusive with `--preset`); the result
reports the mean R/G/B of the middle frame before and after, so the
look is verified on pixels. `--cdl-*` applies an ASC CDL grade instead
(slope/offset/power per channel + saturation, via a per-channel LUT —
near realtime, unlike `geq`, which took 7.7x realtime in testing);
slope 1.5 on red moves a flat-gray frame's R mean 128→~192, measured. Note for `colorbalance`: set all three
ranges (shadows/midtones/highlights) — the shadow-only form barely
moves the frame mean. `reverse` plays a clip backwards (video frames
via the `reverse` filter, audio via `areverse`, on by default;
`--no-audio` keeps the audio forward) — a rewind effect, or reversed
`--no-audio` keeps the audio forward) — a rewind effect, or reversed
audio for a sound-design trick; on audio-only input it reverses the
audio alone. `interpolate` raises the frame rate with motion
interpolation (`minterpolate`): `--fps 60` turns 30fps into 60fps for
smoother playback or slow motion — `blend` (the default) cross-fades
neighbouring frames and is fast, `mci` computes true motion-compensated
frames and looks best but runs about 9x realtime on CPU, `dup` just
repeats frames. It only raises the frame rate (lowering it is `fit
--max-fps`); the result counts frames on the output file, so the fps
is measured, not assumed. `denoise` reduces sensor noise: `hqdn3d`
(fast default) or `nlmeans` (better on fine detail, much slower —
minutes for a few seconds of 720p). Strength 0–1 maps to hqdn3d 0–30:
0.5 is 15, the level that gained +2.9 dB PSNR on sigma-10 noise in
testing — note the 0–10 scale some other servers use is too weak for
real noise (hqdn3d=8 gained only +0.24 dB on the same fixture). The
result measures high-frequency noise energy before and after, so the
reduction is measured on disk. `chroma_key` removes a green or blue
screen in one call: without `--background` it keys the color out and
keeps the transparency, so the output must be `.mov` (ProRes 4444) —
`.mp4`/H.264 has no alpha channel at all, and this ffmpeg build drops
VP9 alpha in `.webm` (measured 2026-11-13, even with `-auto-alt-ref
0`). With `--background` (an image file or a hex color) the subject is
composited onto it in the same call and the output is a flat
`.mp4`/`.webm`. The result measures the alpha on disk at the middle
frame: a full-screen green key reads corner alpha 0, subject alpha
255, and a frame mean equal to the subject's share of the frame.
`zoom_pan` is the Ken Burns effect for stills: it zooms from
`--zoom-from` to `--zoom-to` while the focus point travels from
(`--focus-x`, `--focus-y`) to (`--focus-end-x`, `--focus-end-y`),
0–1 fractions of the frame, 0.5 is center. The input is pre-scaled
1.25x before `zoompan` runs — the filter's crop math is integer
pixels, so a slow move over a 1:1 image jitters. Frame 0 is exactly
the full image and the last frame exactly the zoomed window, so a
zoom is verifiable by comparing frames against crops computed by
hand. Input must be a still image: a video input would be stretched
by `d` frames per input frame, so the tool refuses one.
`image_to_video` is the still counterpart: one image held for a fixed
duration, no motion — a podcast still, a song cover, a title card over
audio. The frame count is exactly round(duration×fps) and the first
frame is the source image itself; `--width`/`--height` fit the image
inside the box and pad black to the exact size, and `--audio` loops a
bed to the same duration. `slideshow` is the multi-image version: 2–32
stills joined with one xfade transition type between every pair
(`fade` by default, any of the 49 names `concat` accepts). Each image
is visible for its own duration — `--duration`, `--durations 3,5,2`,
or `{file, duration}` per image in MCP — so the total is exactly the
sum of the durations: internally each clip is duration + transition
(except the last), so the transition eats a handle, not slide time.
The output always carries an audio track, silent unless `--audio`
loops a bed under the whole show (the xfade join needs an audio
stream for `acrossfade`). Output is `.mp4` only in v1. `segment` cuts a video into an HLS
VOD playlist (`index.m3u8` + `.ts` segments) in a directory, ready
to serve statically. Stream-copy is the default — fast and lossless
— but segments can only start on keyframes, so the actual lengths
follow the source GOP: a clip with keyframes every 8s gives 8s
segments no matter what `--segment-time` you ask for. `--reencode`
re-encodes to libx264/aac with forced keyframes every segment, so
the segments land exactly on the requested grid. The result parses
the playlist back from disk, so the count and durations are measured,
not assumed. `batch` runs one operation over a whole folder: give it a
glob (`**/*.mp4`, or a bare `*.mp4` for every match at any depth) and the
same args for every file, and it returns one row per file in input order
— `ok` with the operation's own measured result, `error` with the
message, `cached` when the content-hash cache already holds that exact
input + operation + args (the cached output is only trusted if it still
exists with the recorded size and sha256), or `skipped` when the run
stopped or the shared timeout expired before the file started. A second
identical run re-encodes nothing. Point the output dir outside the input
tree when you can; files under it are never treated as inputs. For
`cut_words`, one words file belongs to one clip, so batch finds it by
convention — `<words_dir>/<stem>.words.json`, default the input's own
folder (`--words-dir` points at a shared folder of per-clip files);
a clip with no words file fails its own row only, the rest still run.
In a manifest, `cut_words` is a normal step with a single `words_file`
instead, resolved relative to the manifest like `captions`/`overlay`.
`find clips/ --name moon` searches a folder
tree for media files by name and returns each match with its probe
info, so you stop guessing paths. `doctor` is a read-only preflight — run it first
on a new machine to confirm ffmpeg/ffprobe and every filter/encoder the
tools need are actually present; a tool that reports `available: false`
also carries a one-sentence `fix` with the install command that repairs
the ffmpeg build (apt/brew/static build), so a missing capability is a
fixable machine problem, not a dead end. `doctor` also probes the GPU:
hardware encoders are only listed as `available` when a tiny test
encode with one actually succeeded — a build that merely lists nvenc /
vaapi / qsv without a working device reports them under `gpu.encoders`
but `gpu.available: false`, so no tool ever assumes a hardware encoder
it cannot use.

See [`skills/shorts-video/SKILL.md`](skills/shorts-video/SKILL.md) for the
full script → captioned vertical-video workflow.

## Safety

- No shell is ever involved: every ffmpeg call uses `execFile` with an
  argument array, so filenames and user input can't inject commands.
- Outputs are never allowed to overwrite their inputs.
- Inputs are validated (must exist and be readable) before ffmpeg runs.

## Skills included

- [`skills/mediakit/SKILL.md`](skills/mediakit/SKILL.md) — agent-facing
  guide: when to use each tool, re-encode vs stream copy, loudness targets.
- [`skills/shorts-video/SKILL.md`](skills/shorts-video/SKILL.md) — the
  short-form vertical-video workflow (script → 1080×1920 captioned clip).

## License

MIT — see [LICENSE](LICENSE).
