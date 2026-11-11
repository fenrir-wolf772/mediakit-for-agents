# MediaKit for Agents

Give your coding agent eyes and ears for media. MediaKit is a small MCP
server + CLI that wraps **ffmpeg** — trim, crop, resize, captions, loudness,
thumbnails, frame grabs, audio extraction, concat with transitions,
conversion, silence removal, black-bar measurement, delivery packaging,
provenance receipts, file compression with named quality presets,
voice/music mixing with sidechain ducking, logo overlays, scene-cut
detection, and an environment preflight — so an
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
| `resize` | Resize, keeping aspect ratio by default | `mediakit resize in.mp4 --width 1080 -o out.mp4` |
| `extract_audio` | Pull the audio track out (mp3/aac/wav/ogg/opus/flac); `--whisper` forces the Whisper ASR preset — 16 kHz mono WAV, output renamed to .wav when needed | `mediakit extract-audio in.mp4 -o out.mp3` |
| `extract_frame` | Grab one frame at a timestamp | `mediakit extract-frame in.mp4 --timestamp 3.5 -o frame.png` |
| `thumbnail` | Contact sheet of N evenly spaced frames | `mediakit thumbnail in.mp4 --frames 6 -o sheet.jpg` |
| `frames` | Extract N evenly spaced frames as separate images, each with its timestamp — so an agent can look at a video before cutting it. For screen recordings or text-heavy footage use png (default) or webp, not jpg — JPEG chroma subsampling smears 1px text and thin borders | `mediakit frames in.mp4 -o frames/ --count 6` |
| `loudness` | Normalize to a loudness target (default −14 LUFS) — two-pass: measures first, applies the exact gain, re-measures the output and reports the real `output_lufs`; warns when the input is peak-limited and the target cannot be reached | `mediakit loudness in.mp3 -o out.mp3` |
| `concat` | Join 2+ files into one; auto-detects identical clips and stream-copies them (fast, lossless), otherwise re-encodes; `--transition fade` crossfades between clips with xfade + acrossfade | `mediakit concat a.mp4 b.mp4 -o joined.mp4` |
| `burn_captions` | Burn .srt/.ass/.vtt subtitles into the video — font size and position default to the safe zone and scale with frame height (~60px type on 1080x1920, ~500px above the bottom edge so platform UI never covers the text); `--style background|outline|shadow|glow` (background = white text on a semi-transparent black box, the default; glow = halo in the text colour, reads on bright footage; .ass files carry their own styles) | `mediakit burn-captions in.mp4 --captions subs.srt -o out.mp4 --style outline` |
| `convert_captions` | Convert a subtitle file between SRT and VTT (cue text carried verbatim; VTT cue settings are dropped and counted) | `mediakit convert-captions subs.srt -o subs.vtt` |
| `generate_srt` | Build a deterministic .srt from a cue list [{start, end, text}] — pure text, no ffmpeg; times in seconds or MM:SS; cues must be in order and must not overlap | `mediakit generate-srt --cues-file cues.json -o subs.srt` |
| `reframe` | Reframe to a target aspect/size in one step (crop, pad, or blurred fill) — crop mode takes a named `--anchor` (left/right/top/bottom/...) to keep an edge subject in frame, and reports `crop_kept_percent` + a warning below 40% kept | `mediakit reframe in.mp4 --mode crop -o vertical.mp4` |
| `check` | Verify a file against a platform spec (tiktok/reels/shorts/youtube/instagram-feed/instagram-story/linkedin) — video bitrate is a warning, not a gate; overall pass ignores warnings. `--content` also scans for black/frozen frames and silence in one decode pass, with position-aware rules (short black at the very start/end warns as a likely fade; the same stretch mid-file fails) | `mediakit check out.mp4 --platform tiktok --content` |
| `silence` | Remove silent stretches, keeping a margin around speech | `mediakit silence in.mp4 -o tight.mp4` |
| `cropdetect` | Measure letterbox/pillarbox bars; returns the crop rect + a ready crop command | `mediakit cropdetect in.mp4` |
| `package` | Bundle a finished file for delivery: media + spec.json receipt + checksums.sha256 (+ captions) | `mediakit package out.mp4 -o delivery.zip --platform tiktok` |
| `receipt` | Write a provenance receipt (JSON sidecar) for a finished file: probe, SHA-256, size, measured loudness, optional platform check, ffmpeg versions — re-run `sha256sum` against it any time to prove the media has not changed | `mediakit receipt out.mp4 -o out.receipt.json --platform tiktok` |
| `mux` | Replace a video's audio track with an external audio file, stream-copying both (no re-encode: fast, lossless); `--audio-offset` shifts the new audio against the video (positive = audio later, negative = video later); `--shortest` stops at the shorter stream; `--dry-run` prints the ffmpeg command and writes no file | `mediakit mux video.mp4 voice.mp3 -o out.mp4 --audio-offset 0.5` |
| `mix` | Mix voice over a music bed with sidechain ducking (bed drops under speech), then master to target LUFS; reports the ducking actually measured. `--dry-run` prints the exact ffmpeg command and writes no file | `mediakit mix voice.mp3 --music bed.mp3 -o mixed.mp3` |
| `overlay` | Overlay a logo/watermark image (named position, margin, scale, opacity, optional timing) | `mediakit overlay in.mp4 --image logo.png -o out.mp4 --position top-right` |
| `pip` | Picture-in-picture: a second video over the main one (9 positions, size by width or scale, opacity, optional timing, audio main/pip/mix) | `mediakit pip main.mp4 --pip facecam.mp4 -o out.mp4 --position bottom-right` |
| `titlecard` | Render a title card PNG: big bold hook (3-6 words) on a coloured box, transparent canvas — overlay it onto frame 1 or use it as the opening card | `mediakit titlecard "The Moon Is Leaving Us" -o title.png` |
| `intro` | Render a short intro clip: title on a solid-colour background, fading in and out (silent video) — concat it in front of the main clip | `mediakit intro "Welcome Back" -o intro.mp4 --duration 3` |
| `social` | Export one video to several platform specs in one call: reframe + trim to max duration + loudness + check each, writing `<base>-<platform>.mp4` + `manifest.json` | `mediakit social in.mp4 -o out/ --platforms tiktok,reels,shorts` |
| `scenes` | Detect scene changes / hard cuts; returns cut timestamps + segments (probe-only) | `mediakit scenes in.mp4` |
| `keyframes` | List keyframe (I-frame) timestamps + GOP min/max/avg interval (probe-only) — check before a stream-copy trim | `mediakit keyframes in.mp4` |
| `find` | Find media files by name, recursively under a directory (case-insensitive substring); each match comes back with probe info (duration, dimensions, codecs) so you pick the right file without guessing paths | `mediakit find clips/ --name moon` |
| `svg_animate` | Animate an SVG into a video, code-driven (no browser): keyframed translate/scale/rotate/opacity on elements by id, rendered frame by frame via librsvg — slide-ins, fades, bounces, spinning shapes | `mediakit svg-animate in.svg --anim anim.json -o out.mp4 --duration 4` |
| `doctor` | Read-only preflight: ffmpeg version, filters/encoders, tool availability, and the `MEDIAKIT_WORKDIR` sandbox state when set. An unavailable tool also reports a one-sentence `fix` telling you how to repair the ffmpeg install | `mediakit doctor` |
| `convert` | Change container/codec (omit a codec to stream-copy) | `mediakit convert in.mov -o out.mp4 --video-codec libx264` |
| `compress` | Shrink a file with one named quality preset — low (CRF 32), medium (CRF 26), high (CRF 20) — each with its own x264 preset and audio bitrate; optional `--max-width` scales down first. `--target-size <MB>` encodes to an exact size instead (two-pass ABR, e.g. 10 for a Discord upload) and reports `target_met` measured on disk. Reports the size before/after and the reduction actually measured on disk | `mediakit compress in.mp4 -o small.mp4 --quality low` |
| `export_gif` | Export a clip (or segment) as an animated GIF with a two-pass palette (palettegen + paletteuse from the actual frames). Fits under `--max-size-mb` (default 10 MB, the GitHub README limit; Slack auto-plays only under ~2 MB) by stepping down fps, then width, then palette colours; reports `size_budget_met` measured on disk, with a warning when the budget cannot be met | `mediakit export-gif in.mp4 -o demo.gif --max-size-mb 2` |

Every tool returns a concise JSON result: output path, size, and the
verified duration/dimensions of what it produced.

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
falling back) and `--no-fast` always re-encodes. `scenes` is probe-only: it lists hard cuts and the
segments between them so you trim on real boundaries; the default
threshold 0.3 catches real cuts, and a hard cut between flat colours
scores ~0.4, so keep the threshold at or below 0.4. `keyframes` is
probe-only: it lists every I-frame timestamp plus the GOP interval, so
you know where a lossless cut can land — `trim --stream-copy --snap`
snaps the requested start down and end up to the nearest keyframes and
reports both the requested and the actual range. `check --content`
adds one decode pass that scans for black frames, frozen frames and
silence and folds them into the same pass/fail list — a short black
stretch at the very start/end is a warning (likely a fade in/out), the
same stretch mid-file fails, and a missing stream reports "unavailable"
instead of a fake zero. `find clips/ --name moon` searches a folder
tree for media files by name and returns each match with its probe
info, so you stop guessing paths. `doctor` is a read-only preflight — run it first
on a new machine to confirm ffmpeg/ffprobe and every filter/encoder the
tools need are actually present; a tool that reports `available: false`
also carries a one-sentence `fix` with the install command that repairs
the ffmpeg build (apt/brew/static build), so a missing capability is a
fixable machine problem, not a dead end.

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
