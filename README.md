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

### MCP over HTTP — same tools, curl instead of a client

`mediakit mcp --http [--port 3000] [--host 127.0.0.1]` serves the
exact same 77 tools over HTTP (REST + JSON-RPC 2.0), for hand-testing
and for agents that can only speak HTTP. It binds `127.0.0.1` by
default — there is no auth, so only bind elsewhere on a network you
trust. Request bodies are capped at 1 MB.

```bash
curl http://127.0.0.1:3000/mcp                        # server metadata
curl http://127.0.0.1:3000/mcp/tools                 # every tool + JSON input schema
curl -X POST http://127.0.0.1:3000/mcp/tools/probe/invoke \
  -H 'content-type: application/json' \
  -d '{"arguments": {"input": "clip.mp4"}}'
curl http://127.0.0.1:3000/mcp/jobs                 # async render jobs, newest first
curl http://127.0.0.1:3000/mcp/jobs/<job_id>        # one job: status + stage/percent progress
curl -N http://127.0.0.1:3000/mcp/jobs/<job_id>/events   # live progress as SSE (see below)
curl -X POST http://127.0.0.1:3000/mcp/jobs/<job_id>/cancel
```
curl -X POST http://127.0.0.1:3000/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
       "params": {"name": "trim", "arguments": {"input": "clip.mp4", "output": "cut.mp4", "start": 2, "duration": 5}}}'
```

Errors are JSON (`{error, code, retryable, retry_after_seconds?, retry}`) with an HTTP status that
matches the failure — `400` for bad arguments, `404` for an unknown
tool or job, `429` for a refused job start (`JOB_ADMISSION_LIMIT` — the render-job gate: 2 active jobs / 10 starts per minute by default), `500` for a failed run — and `retry: {tool, arguments}` on
every tool error, so a caller can re-issue the identical call.
`retryable` is always present: `true` means the identical call has a
real chance of succeeding (a transient failure — HTTP 429/5xx or a
timeout on download, the admission gate), `false` means it cannot
help (bad arguments, a missing file, a bad filter, a corrupt input —
fix the call instead of repeating it). When the failure named a wait,
`retry_after_seconds` carries it (the server's `Retry-After`, or the
admission gate's computed wait); the CLI prints the same guidance
(`(retryable: true — retry in ~7s)`) on its error line. The same
fields ride the HTTP error body and the JSON-RPC `isError` result.
JSON-RPC errors use the standard codes (`-32700` parse error,
`-32601` unknown method, `-32602` unknown tool / bad params); a tool
that runs and fails reports `isError: true` in the result, exactly
as over stdio.

Async renders are the one thing curl cannot get pushed progress for,
so they poll instead: start one with `assemble` invoked with
`"async": true` (it returns a `job_id` at once), then poll
`GET /mcp/jobs/<job_id>` — the record carries `status`
(`queued`/`running`/`done`/`failed`/`cancelled`) plus `progress`
(`stage` + `percent`) and, when finished, the terminal `result` or
`error`. While a job runs, the record also carries
`estimate_remaining_seconds` — a rough upper-bound ETA in whole
seconds, plus `estimate_basis` (`progress-rate` from the job's own
percent history, `elapsed-progress` from time since start); it is
null while the job is under 5% or has no usable timestamps, and a
guide, never a promise. The percent moves continuously inside the long stages, not
just at stage boundaries: each shot encode, the xfade join, the
voice pad and the caption burn report ffmpeg's `-progress`
(`out_time` / total), and `progress.detail` names what is happening
(`s2 · frame 123/300 · 2.4x`, `voice · 3.1x`). The mux is a stream
copy and the QA is probes, so those two stages still report only
their boundaries. `POST /mcp/jobs/<job_id>/cancel` stops a queued or running
job. Same job store and `job_id` format as the `job` tool over stdio.

Or skip the polling loop: `GET /mcp/jobs/<job_id>/events` streams
the same record as Server-Sent Events — one `event: job` per change
(the first arrives immediately, so a finished job still sends exactly
one event and the stream closes), a `: heartbeat` comment every 15 s,
and the stream closes itself when the job reaches a terminal status.
`?timeout_s=` caps how long the stream stays open (default 600,
clamp 1–3600); on timeout the last event is `event: timeout` with the
latest record. An unknown id fails as JSON 404 before any SSE header.
The worker is a separate process, so the stream watches the durable
`job.json` on disk and pushes only when the record actually changed —
what you see is the record, not a guess at it.

## Tools

| Tool | What it does | CLI |
|---|---|---|
| `probe` | Duration, dimensions, codecs, streams (ffprobe) — plus `rotation` (clockwise degrees from the display matrix or `rotate` tag, null when absent), `display_width`/`display_height` (what a player shows — a phone clip coded 1920x1080 with rotation 90 displays 1080x1920), and `time_base` (what `concat --fast` compares) | `mediakit probe in.mp4` |
| `trim` | Cut a clip by start + duration/end (times accept seconds or `MM:SS`); re-encodes by default (frame-accurate), `--stream-copy` is fast but keyframe-only — `--snap` moves the cut onto keyframes, `--snap-beat` moves it onto the nearest beats of the music (start down, end up; refuses `--snap`/`--smart-cut` and an unreliable grid; `--snap-beat-method dp` snaps to the DP tracker's beats, which follow real onsets when the tempo drifts, instead of the one-tempo grid), `--smart-cut` keeps the exact start by re-encoding only the head up to the next keyframe (source bitrate ×1.2). Every video trim verifies the cut by default: 3 output frames vs the source at the requested times, `cut_verified` + `mean_abs_diff` per frame (`--no-check-frames` skips it). `--dry-run` prints the exact ffmpeg command(s) that would run (three for `--smart-cut`) and writes no file | `mediakit trim in.mp4 --start 2 --duration 5 -o out.mp4` |
| `fit` | Fit a file to an exact target duration: `speed` (up/down, factor 0.25–4x), `trim` (cut longer), `loop` (repeat shorter) — reports the duration actually measured. `--max-fps` caps the output frame rate (only ever lowers it). `--dry-run` prints the exact ffmpeg command and writes no file | `mediakit fit in.mp4 --duration 0:30 -o out.mp4` |
| `crop` | Crop to a rectangle (w, h, x, y) in **display** coordinates — on a rotated phone clip the rect is checked against the frame the viewer sees (720x1280), not the stored pixels (1280x720); reports `source_dimensions` + `source_rotation`. `--dry-run` prints the exact ffmpeg command and writes no file | `mediakit crop in.mp4 --width 720 --height 1280 -o out.mp4` |
| `resize` | Resize, keeping aspect ratio by default; `--preset 360p|480p|720p|1080p|2160p` fits the **display** frame inside that box and never upscales (a rotated 720x1280 clip fits 720p as 406x720, not a stretched 1280x720). `--dry-run` prints the exact ffmpeg command and writes no file | `mediakit resize in.mp4 --preset 720p -o out.mp4` |
| `extract_audio` | Pull the audio track out (mp3/aac/wav/ogg/opus/flac); `--whisper` forces the Whisper ASR preset — 16 kHz mono WAV, output renamed to .wav when needed; `--channel <n>` (0-based) picks one channel out of a multi-channel input and returns it as mono. The probed output codec is verified against the format the extension asked for (`output_codec` + `codec_verified: true`) — a file that claims .wav but contains MP3 fails loudly instead of shipping mislabelled. `--dry-run` prints the exact ffmpeg command and writes no file (duration/size/output_codec report null — measured on the real output; with `--whisper` the sample rate/channels are forced by the command, so they are exact) | `mediakit extract-audio in.mp4 -o out.mp3` |
| `extract_frame` | Grab one frame at a timestamp — frame-accurate (two-stage seek lands on the frame at t, not the keyframe before it); refuses a timestamp at/past the end | `mediakit extract-frame in.mp4 --timestamp 3.5 -o frame.png` |
| `thumbnail` | Contact sheet of N evenly spaced frames — each tile is captured at its own exact timestamp and labelled with it in `MM:SS.d` by default (`--no-timestamps` for a clean sheet), so the sheet shows WHEN each frame is, not just what it shows. `--start-delay-percent` / `--end-delay-percent` skip the first/last slice of the file (intros, credits) before spacing the tiles; a partial last row is padded black so the grid is always complete. `--header` adds a metadata band on top (filename, measured duration, resolution, fps, codecs, size, grid) so a forwarded sheet still says which file it came from. `--timestamps-list 1,6,0:30` names every tile time explicitly (seconds or `MM:SS`; sets the tile count, cannot combine with the delay percents). `--sharpest` picks the sharpest frame in each tile's window instead of the window start (Laplacian mean, measured on disk; each tile reports its `sharpness`) | `mediakit thumbnail in.mp4 --frames 6 -o sheet.jpg` |
| `frames` | Extract N evenly spaced frames as separate images, each with its timestamp — so an agent can look at a video before cutting it. Each frame is captured at its exact timestamp (two-stage seek), so the reported time is the frame's real time, not the `fps` filter's rounding. `--sharpest` picks the sharpest frame in each interval instead of the interval start (Laplacian mean, measured on disk; each entry reports `sharpness` and its window; `--sharpest-samples` sets the candidates per interval, default 5). For screen recordings or text-heavy footage use png (default) or webp, not jpg — JPEG chroma subsampling smears 1px text and thin borders | `mediakit frames in.mp4 -o frames/ --count 6` |
| `extract_frames` | Export EVERY frame of a clip (or a time range) as a sequence of images (`frame-0001.png` …) — the full sequence, not N samples like `frames`. Scrub a shot frame by frame: a fast move, a blink, a lip-sync slip that a 6-frame sample hides. `--fps` defaults to the source frame rate (every frame); set it lower for a sparser sequence. Frame i lands at `start + i/fps`, and the count is verified on disk against `round((end-start) * fps)`. PNG is written rgba (keeps alpha, e.g. ProRes 4444 sources). `--quality` only for jpg/webp (jpg maps 1–100 onto `q:v` 31–2, webp uses libwebp's own `quality`, default 75); webp is forced through the image2 muxer + libwebp — the plain `.webp` extension picks the animated-webp muxer and writes one corrupt file. Refuses over 5000 frames — lower `--fps` or shorten the range. `--dry-run` prints the exact ffmpeg command and writes no file | `mediakit extract-frames in.mp4 -o frames/ --fps 2` |
| `loudness` | Normalize to a loudness target (default −14 LUFS) — two-pass: measures first, applies the exact gain, re-measures the output and reports the real `output_lufs`; warns when the input is peak-limited and the target cannot be reached. `compressor: true` runs a gentle compressor (threshold −24 dB, ratio 4, 1 ms attack) before the loudnorm pass, for quiet high-crest speech that two-pass alone cannot lift to target. `--dry-run` prints the exact ffmpeg command(s) and writes no file (with a compressor the loudnorm `measured_*` values come from the uncompressed input — the real run re-measures the compressed temp first) | `mediakit loudness in.mp3 -o out.mp3 --compressor` |
| `concat` | Join 2+ files into one; auto-detects identical clips and stream-copies them (fast, lossless), otherwise re-encodes; `--transition fade` crossfades between clips with xfade + acrossfade; per-clip trim with `path@start-end` (seconds or MM:SS) or `{file, start, end}` — trims always re-encode with exact cuts. "Identical" includes the video `time_base`: the concat demuxer copies timestamps verbatim, so a time_base mismatch stretches the join (measured 10s+10s with 1/15360 vs 1/90000 → 116.9s) — auto re-encodes those joins through the filter graph instead (exactly 20s), and `--fast` refuses them naming the mismatch. Size is compared on **display** dimensions: a clip stored 1280x720 with rotation 90 displays 720x1280, so joining it with an upright 1280x720 clip is a size mismatch — auto re-encodes through the filter graph (normalized to the first clip's display size, second half upright), `--fast` refuses it, and two clips with the same display size but different stored orientation also refuse `--fast` (stream copy cannot re-orient) and also go through the filter graph — the demuxer re-encode applies the first clip's rotation to every clip, so an upright second clip came out rotated 90° and stretched (PSNR 3.1 dB vs the correct picture). `--dry-run` prints the exact ffmpeg command and writes no file (demuxer path: also returns `list_file` + `list_content` — write the content to that path first, then run the printed command as-is; transition/trim paths print one exact filter-graph command) | `mediakit concat a.mp4 b.mp4 -o joined.mp4` |
| `burn_captions` | Burn .srt/.ass/.vtt subtitles into the video — font size and position default to the safe zone and scale with the displayed frame height (~60px type on 1080x1920, ~500px above the bottom edge so platform UI never covers the text; on a rotated phone clip the display size is used, not the coded size); `--style background|outline|shadow|glow` (background = white text on a semi-transparent black box, the default; glow = halo in the text colour, reads on bright footage; .ass files carry their own styles); `--max-lines N` shrinks the type (measured with Liberation Sans, the font libass actually draws) until every cue wraps to at most N lines, never below a readability floor (~31px at 1920 high) — a cue that still overflows burns at the floor and reports `fit.fits=false`; `--platform tiktok|reels|shorts|youtube|...` sets the default margin from that platform's own bottom UI depth (tiktok 520px at 1920 high, youtube 100px at 1080 high) and narrows the fit width to its text-safe rect; explicit `--margin-v` wins; `.ass` ignores max_lines/platform (reported, not dropped). `--dry-run` prints the exact ffmpeg command and writes no file (font/margin/style/fit are computed from the input, so they are exact) | `mediakit burn-captions in.mp4 --captions subs.srt -o out.mp4 --style outline --max-lines 2 --platform tiktok` |
| `convert_captions` | Convert a subtitle file between SRT and VTT (cue text carried verbatim; VTT cue settings are dropped and counted) | `mediakit convert-captions subs.srt -o subs.vtt` |
| `generate_srt` | Build a deterministic .srt from a cue list [{start, end, text}] — pure text, no ffmpeg; times in seconds or MM:SS; cues must be in order and must not overlap. Or from word timings [{start, end, word}] with `--words-file`: words are grouped into semantic cues (max 8 words, 3.5s, 84 chars / 2 lines of 42; split on pauses >0.4s and sentence ends; a cue never ends on a stranded word) and the grouping report is returned | `mediakit generate-srt --cues-file cues.json -o subs.srt` or `mediakit generate-srt --words-file words.json -o subs.srt` |
| `publish_kit` | Thumbnail & Publishing Kit: from a finished video + a 1280x720 16:9 thumbnail + copy (exactly 5 titles, description, tags, pinned comment, optional chapters) in a kit JSON, write `metadata.md` + `publishing.json` and report a pre-publish checklist — thumbnail size, titles and chapter times are verified against the measured duration; mobile readability, title/cover fidelity and licences are marked human-review, never passed. Publishes nothing | `mediakit publish-kit out.mp4 --thumbnail thumb.png --kit-file kit.json -o publishing/ --style clean-bold` |
| `transcribe` | Transcribe speech to a .srt with a LOCAL engine (no cloud, audio never uploaded) — faster-whisper by default, whisper.cpp with `--engine whisper` (`MEDIAKIT_WHISPER_CPP_BIN` / `MEDIAKIT_WHISPER_MODEL` point at the CLI binary + ggml model; auto prefers faster-whisper, then whisper.cpp); writes the .srt and returns the segments with timestamps, detected language and full text — the direct input for `burn_captions`. The engine is optional: with no engine installed the call fails with install lines (`MEDIAKIT_ASR_PYTHON` picks the python that has faster-whisper, `MEDIAKIT_ASR_MODEL` the default model, tiny). Silence transcribes to 0 segments and an empty .srt. `--chunk-seconds 300` splits long files into 300s chunks (2s overlap, segments re-offset onto the full timeline) so hour-long recordings transcribe without one giant ASR run; a phrase at a boundary may repeat, and a file shorter than one chunk runs as a single chunk. `--word-timestamps` also returns per-word timings in the printed JSON (words: [{index, start, end, word}]) — the input `cut_words` cuts by; save the printed JSON to a file and pass it as `--words-file` | `mediakit transcribe speech.mp3 -o subs.srt --model tiny` |
| `reframe` | Reframe to a target aspect/size in one step (crop, pad, or blurred fill) — crop mode takes a named `--anchor` (left/right/top/bottom/...) to keep an edge subject in frame, and reports `crop_kept_percent` + a warning below 40% kept. Geometry is measured on the **display** frame: a rotated 720x1280 phone clip reframed to 1080x1920 keeps 100% of its pixels, and `--x`/`--y` are bounded by the display window. `--dry-run` prints the exact ffmpeg command and writes no file (crop/kept-percent are computed from the input geometry, so they are exact) | `mediakit reframe in.mp4 --mode crop -o vertical.mp4` |
| `check` | Verify a file against a platform spec (tiktok/reels/shorts/youtube/instagram-feed/instagram-story/linkedin) — video bitrate is a warning, not a gate; overall pass ignores warnings. Dimensions are judged as displayed, not as coded: a phone clip stored 1920x1080 with rotation 90 is a 1080x1920 vertical video and passes the TikTok dimensions rule as one. `--expected-duration` fails the check when the measured duration is more than 0.5s off the brief (same tolerance as `qa_report`). `--content` also scans for black/frozen frames, silence and audio peaks in one decode pass, with position-aware rules (short black at the very start/end warns as a likely fade; the same stretch mid-file fails) — a peak ≥ 0 dBFS fails as clipping, a peak above `--peak-threshold` (default −1 dBFS) warns; `--start`/`--end` scan only that time range, on the file's own timeline. `--faststart` also checks MP4 faststart (moov before mdat, measured by a pure-Node box walk) — fails on a non-MP4 file or a moov that sits after mdat; re-mux with `-movflags +faststart` to fix. `--decoded-work` also estimates the decoded work from the probe (video pixel-frames + audio sample-channels) and warns when it is over the ceiling — 250B pixel-frames / 6B sample-channels, plus per-stream limits (3600s, 8192px, 120fps, 8ch, 192kHz); a 4K60 hour measures 1.79T pixel-frames. `doctor` reports the ceilings | `mediakit check out.mp4 --platform tiktok --content` |
| `qa_report` | One-call delivery gate for a finished file: even dimensions, yuv420p pixel format, frame rate, aspect ratio and length for the target, measured loudness in −16..−12 LUFS and true peak, black/frozen frames and dead air (silence over 2s), pacing (average shot length from real scene cuts), and an optional `--expected-duration`. Probe-only — writes no file. Returns one verdict (pass/warn/fail) plus a per-check list. Run this, plus `thumbnail`, on every deliverable before calling it done | `mediakit qa-report out.mp4 --target tiktok --expected-duration 60` |
| `grade` | Color-grade a video with a named preset — `warm` (red up, blue down), `cool` (the opposite), `cinematic` (contrast up, saturation down, slight teal), `noir` (black and white), `vintage` (faded, desaturated) — or one custom filter chain with `--filter`, or an ASC CDL grade with `--cdl-slope/--cdl-offset/--cdl-power r,g,b --cdl-saturation N` (mutually exclusive with preset/filter; per-channel LUT, near realtime); reports the mean R/G/B before and after, measured on the middle frame. `--dry-run` prints the exact ffmpeg command and writes no file (`color_before` is still measured on the input; `color_after` reports null) | `mediakit grade in.mp4 --preset warm -o out.mp4` |
| `reverse` | Play a clip backwards: video frames reversed, audio reversed too by default (`--no-audio` keeps the audio playing forward); works on audio-only input as well. The `reverse` filter buffers every frame, so very long inputs cost memory. `--dry-run` prints the exact ffmpeg command and writes no file | `mediakit reverse in.mp4 -o backwards.mp4` |
| `make_loopable` | Make a clip loop seamlessly: crossfade the tail into the head (moviepy `MakeLoopable` idea), so the end flows back into the start with no visible jump or audio click. Output is the overlap shorter (10s + 0.5s overlap = 9.5s). Default overlap 0.5s (0.3–0.5s for slow motion, 1s for very different start/end poses; must stay under half the clip, and past ~a quarter it ghosts the picture). Reports `seam_before` vs `seam_after` (mean abs gray difference between last and first frames) plus `normal_step` (two neighbouring mid frames) as the baseline — a good seam lands at the normal step. Works on audio-only input too `--dry-run` prints the exact ffmpeg command and writes no file (seam_before is measured on the input, so it is exact; seam_after/normal_step/duration report null) | `mediakit make-loopable in.mp4 -o loop.mp4 --overlap 1` |
| `freeze` | Hold one frame still for N seconds (moviepy `Freeze` idea): insert a frozen-frame segment at time `--at` (default the end of the clip — hold the last frame, the end-card use), so the clip grows by exactly the hold and the tail keeps its place in the timeline. The frozen frame is picked by index, never by a time window (real PTS sits ~0.3ms off nominal boundaries and a time trim can silently yield zero frames). Audio in the hold is silence — the original audio continuing would leave the video longer than the audio. Reports `frozen_frame_diff` (input frame vs output frame mid-hold, ~0 when truly frozen) and `post_frame_diff` (tail kept its place; null when the hold sits on the last frame) `--dry-run` prints the exact ffmpeg command and writes no file (frame_index/frame_seconds are computed from the input's frame count, so they are exact; the diffs and the duration report null) | `mediakit freeze in.mp4 -o out.mp4 --at 5 --hold 2` |
| `fastforward` | Speed up marked spans of a clip and burn a badge on them (khang-nyb/demo-recorder's `render()` idea: their demo tool fast-forwards dead backend waits and stamps `">> tua nhanh x8"` on the sped footage). `--span <start>-<end>@<speed>` is repeatable (1–16 spans, speed 1.1–16); spans are clamped to the clip, sorted, and overlaps collapse onto the previous span's end. The output is shorter by exactly the saved time and everything after a span keeps its place; video speeds up with `setpts`, audio keeps its pitch with chained `atempo`. The badge is a dark box + `">> fast-forward xN"` bottom-right, sized from the display frame height (`--no-badge` skips it, `--label` changes the word). Reports `duration_expected` vs `duration_seconds`, `timing_check_mapped` vs `timing_check_unmapped` (input frame mid-span vs the output frame it should land on, ~0 when the mapping is right), and the frame count. `--dry-run` prints the exact ffmpeg command and writes no file (duration/timing/frames report null — measured on the real output; badge label files are written to a deterministic temp dir and kept, so the printed command runs as-is). Also a `manifest` step | `mediakit fastforward in.mp4 --span 5-9@4 -o out.mp4` |
| `rotate` | Rotate a clip 90/180/270° clockwise, or flip it horizontally/vertically (exactly one of `--angle`/`--flip`). The angle applies to the frame the viewer sees — a phone clip coded 1280×720 with rotation 90 rotates from its 720×1280 display size — and the output carries no rotation metadata, so no player double-rotates it. `--metadata-only` rewrites only the display-matrix metadata (stream copy, no re-encode — instant, lossless, coded video packets verified identical on disk); the angle adds to the input's existing rotation (90 on a rotation-90 clip gives 180; 270 on it strips the matrix). mp4/mov/mkv only, angle only, no flip. Reports `input_rotation` vs `output_rotation` measured on disk. `--dry-run` prints the exact ffmpeg command and writes no file (`dimensions` is the expected display size after the rotation) | `mediakit rotate in.mp4 -o out.mp4 --angle 90 --metadata-only` |
| `boomerang` | Play a clip forward then backwards — the ping-pong loop (moviepy `TimeSymmetrize`/`TimeMirror` idea): the clip followed by its own reverse, so a bounce, swing or wave returns to where it started with no cut. The peak frame is NOT played twice — the reversed half drops its first frame (moviepy v2.2.1's TimeMirror clipping fix) and the reversed audio drops one video-frame of audio at the same point, so the output is 2D − 1/fps (audio-only input has no video frame to pivot on, so it plays forward + reversed whole, 2D). Reports `seam_diff` vs `normal_step` measured on disk; the frame count (2N−1) is the honest proof the pivot frame was dropped `--dry-run` prints the exact ffmpeg command and writes no file (pivot/expected duration are computed from the input, so they are exact; seam scores report null) | `mediakit boomerang in.mp4 -o out.mp4` |
| `interpolate` | Raise the frame rate with motion interpolation (`minterpolate`): 30fps to 60fps for smoother playback or slow motion. Modes: `blend` (fast default, cross-fades neighbours), `mci` (true motion compensation, best quality but much slower — ~9x realtime on CPU), `dup` (repeats frames). Only raises the frame rate; use `fit --max-fps` to lower it. Reports fps and frame counts measured on the output file. `--dry-run` prints the exact ffmpeg command and writes no file (`frames_before` is counted on the input, so it is exact; `fps_after`/`frames_after` report null — measured on the real output) | `mediakit interpolate in.mp4 --fps 60 -o smooth.mp4` |
| `denoise` | Reduce sensor noise: `hqdn3d` (fast default) or `nlmeans` (better on fine detail, much slower). Strength 0–1 maps to hqdn3d 0–30 (0.5 is 15, the level that gained +2.9 dB PSNR on sigma-10 noise in testing) or nlmeans `s` 0–10. Reports high-frequency noise energy before and after, measured on disk. `--dry-run` prints the exact ffmpeg command and writes no file (`noise_before` is measured on the input, so it is exact; `noise_after` reports null — measured on the real output) | `mediakit denoise noisy.mp4 --strength 0.5 -o clean.mp4` |
| `chroma_key` | Remove a green/blue screen: keys out one hex color (`--color 00FF00`, `--similarity` 0–1, `--blend` 0–1). Without `--background` the output keeps transparency and must be `.mov` (ProRes 4444 — `.mp4` has no alpha, and this ffmpeg build drops VP9 alpha in `.webm`). With `--background <image\|hex-color>` the subject is composited onto it and the output is a flat `.mp4`/`.webm`. Reports the alpha measured on disk (middle frame): full-frame mean, corner (~0 for a full-screen key) and center (~255 on the subject). `--dry-run` prints the exact ffmpeg command and writes no file (mode/background are decided before the run; pixel_format/alpha/duration/dimensions/size report null) | `mediakit chroma-key greenscreen.mp4 -o keyed.mov` |
| `zoom_pan` | Ken Burns effect: turn a still image into a moving clip. Zooms linearly from `--zoom-from` to `--zoom-to` while the focus point moves from (`--focus-x`, `--focus-y`) to (`--focus-end-x`, `--focus-end-y`), 0–1 fractions of the frame. The input is pre-scaled 1.25x before zooming to avoid zoompan's integer-crop jitter. Input must be a still image, not a video. Reports frame count measured on the output file `--dry-run` prints the exact ffmpeg command and writes no file (zoom/focus expressions are computed from the arguments, so they are exact; duration/frames report null) | `mediakit zoom-pan photo.png --duration 5 --zoom-to 1.5 -o kenburns.mp4` |
| `image_to_video` | Turn one still image into a fixed-duration video that holds still (no motion — use `zoom_pan` for Ken Burns). Dimensions default to the image itself; `--width`/`--height` fit the image inside the box and pad black to the exact size. `--audio` loops an audio file to the same duration (a short bed loops, a long one is trimmed). Output `.mp4` (H.264) or `.webm` (VP9). Reports frame count measured on the output file — exactly round(duration×fps) `--dry-run` prints the exact ffmpeg command and writes no file (dimensions/fps/duration are computed from the arguments, so they are exact; frames report null) | `mediakit image-to-video cover.png --duration 5 --audio song.mp3 -o still.mp4` |
| `slideshow` | Turn 2–32 still images into one video with an xfade transition between every pair (one transition type for all pairs, or a different one per join with `--transitions fade,wipeleft` + `--transition-durations 1,0.5` — one entry per join, each duration shorter than both slides it joins). Each image is visible for its own duration (`--duration`, `--durations 3,5,2`, or `{file, duration}` per image), so the total is exactly the sum of the durations — the transition eats a handle, not slide time. Images are rendered to clips in parallel first, then joined with the `concat` xfade chain. `--audio` loops a bed under the whole slideshow. Output `.mp4` only in v1; the output always carries an audio track (silent unless `--audio` is given, because the xfade join needs one for `acrossfade`). Reports frame count measured on the output file `--dry-run` prints the exact commands for all three stages and writes no file (one exact command per slide clip, the exact xfade join command — built by the same builder `concat --transition` runs — and the exact audio command when a bed is given; run them in order to reproduce the real output; duration/frames report null) | `mediakit slideshow a.png b.png c.png -o show.mp4 --durations 3,5,2 --transition wipeleft` |
| `cut_words` | Cut words out of a talking-head clip by transcript: filler words (um/uh), false starts and restarts, using word timings from `transcribe --word-timestamps` (save its printed JSON and pass it as `--words-file`). Select by word text (`--remove um,uh`), the built-in filler set (`--fillers`: um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh), or 0-based word-index ranges (`--indices 0-5,96-98`); `--keep` rescues indices even when matched. Keep runs are padded 0.06s before / 0.12s after, clamped so a cut never keeps a fragment of the word it removed, and kept words that end up mostly cut out are reported in `cut_check.swallowed`. Every kept segment gets a 12ms fade out + 15ms fade in at the join, so a cut mid-word has no click. `--dry-run` prints the plan and writes nothing; no match stream-copies the input unchanged. "like" / "you know" are not fillers — cut them only via `--remove` | `mediakit cut-words take.mp4 --words-file words.json --fillers -o clean.mp4` |
| `remove_retakes` | Cut repeated takes out of a talking-head clip, on word timings from `transcribe --word-timestamps` (save its printed JSON and pass it as `--words-file`): the speaker says a sentence, restarts, and says it again — the earlier take plus the restart junk ("okay, again", a filler) is cut and the fluent take is kept whole. A repeat is `--min-words` (default 3) identical words with at most `--max-gap-words` (default 8) words and `--max-gap-seconds` (default 5) between the takes; a 2-word abandoned start ("the quick" — "um" — "the quick brown fox") is also cut. `--keep last` (default) keeps the later take, `--keep first` the earlier one. Returns the clusters found (kept take + removed indices + text) so the cut can be reviewed; `--detect-only` returns the plan and writes no file. No retake stream-copies the input unchanged. Deterministic, not a judge: an intentional repetition looks like a retake to this detector — read the clusters before cutting | `mediakit remove-retakes take.mp4 --words-file words.json -o clean.mp4` |
| `segment` | Cut a video into an HLS VOD playlist (`index.m3u8` + `.ts` segments) in a directory, ready to serve statically. Stream-copy by default (fast, lossless) — but segments can only start on keyframes, so actual lengths follow the source GOP; `--reencode` re-encodes to libx264/aac with forced keyframes for exact segment boundaries. Reports the segment count and durations parsed back from the playlist on disk. `--dry-run` prints the exact ffmpeg command and writes no file — no directory is created and no stale segments are deleted (`segment_count`/durations report null — measured on the real output) | `mediakit segment in.mp4 --segment-time 6 -o hls/` |
| `batch` | Apply one operation to every file matching a glob under a folder — `loudness`, `resize`, `reframe`, `compress`, `convert`, `extract_audio`, `reverse`, `rotate`, `boomerang`, `make_loopable`, `freeze`, `grade`, `fit`, `trim`, `silence`, `chroma_key`, `cut_words`, `remove_retakes`, `slideshow`, `hook`, `bpm`, `beat_grid` or `tempo_drift`, same args for all. Outputs are `<stem>-<operation>.<ext>` under the output dir, mirroring the input tree; `batch-manifest.json` records one row per file (`ok`/`error`/`cached`/`skipped`, in input order). Unchanged files are skipped via a content-hash cache (verified against the cached output's size + sha256); `--jobs N` runs files in parallel under one shared `--timeout`; `--dry-run` lists the planned outputs and writes nothing. `--output-dir` is an alias for `-o <output-dir>`. `cut_words` and `remove_retakes` find each clip's words file by convention — `<words_dir>/<stem>.words.json`, default the input's own folder — and a clip with no words file fails its own row only. `slideshow` is the exception: a set operation — the whole matched set of images (2–32) becomes ONE slideshow video (`output_name`, default `slideshow.mp4`), and the per-file cache does not apply. `hook`, `bpm`, `beat_grid` and `tempo_drift` are the probe-only exceptions: they write no file (`output` null, `output_suffix` null) — the measurement comes back in each row's `result`, and the cache stores that result instead of a file | `mediakit batch loudness --pattern '**/*.mp4' --input-dir clips/ -o out/ --args-json '{"target_lufs": -14}'` |
| `manifest` | Run a whole edit pipeline from one declarative JSON manifest: `{version: 1, input, output, steps: [{tool, args}], qa?}` — paths relative to the manifest file. A manifest may carry an optional top-level `revision` (absent = 0, managed by `patch_manifest`); a non-integer revision fails lint. Steps run in order (`slideshow` as step 1 only — it builds a video from images in args, so the manifest input should be the first slide image; `download` as step 1 only — it fetches from a URL in args, and when it is step 1 the manifest `input` may be omitted entirely; then `trim`, `resize`, `reframe`, `compress`, `convert`, `extract_audio`, `reverse`, `rotate`, `boomerang`, `make_loopable`, `freeze`, `fastforward`, `broll`, `grade`, `fit`, `silence`, `denoise`, `interpolate`, `burn_captions`, `overlay`, `chroma_key`, `cut_words`, `remove_retakes`; `hook`, `bpm`, `beat_grid`, `tempo_drift` and `audio_levels` are the probe-only steps — they analyze the chain file at that point and pass it through unchanged, so their results record WHY the next trim cuts where it does), each feeding the next; the whole plan is validated before anything renders, so a typo fails in seconds, not after step 3 of 5. Each step is cached by content hash (verified against the cached output's size + sha256; a probe-only step stores only its result, there is no file to verify) — re-running an unchanged manifest re-encodes nothing, and editing step 3 only re-runs from step 3. Sidecar files (`captions`, `overlay`, `words_file`, `history_file`, and a `chroma_key` image `background` — a hex background is a color, not a file) resolve relative to the manifest and are hashed into the step cache, so editing the background image re-runs the key step. `--dry-run` lists the planned steps and writes nothing; `qa` runs `qa_report` on the final file | `mediakit manifest recipe.json -o final.mp4` |
| `patch_manifest` | Edit a manifest JSON file under a revision guard (OpenEdit's revision-guard idea): the call is refused when `expected_revision` does not match the file's current revision (absent = 0), so a stale edit never overwrites newer work. Ops (1–32, applied in order — each op addresses the list as the previous ops left it): `set` a scalar at `input`/`output`/`qa`/`steps.N.tool`/`steps.N.args.KEY` (`version`/`revision` are managed, not settable); `add_step` (append, or insert at `index`); `remove_step` (never the last step); `replace_step`. The patched manifest is validated with a real `manifest --dry-run` before anything is written, then the pre-patch bytes are copied to `<manifest>.bak` (always the revision just before the current one) and the new file is written atomically (`.partial` + rename) with `revision` + 1. A mismatch (`REVISION_MISMATCH`), a bad op, or a patched manifest that no longer validates all refuse and leave the file byte-identical | `mediakit patch-manifest recipe.json --expected-revision 0 --patch-file patch.json` |
| `determinism` | Check whether a linear pipeline manifest reproduces byte-identically: run the same manifest N times (default 2, max 5) with the cache OFF — a cache hit would prove nothing — then compare byte sha256, decoded-frame digest (`framemd5`, moviepy's test pattern: compare decoded frames, never bytes), and measured properties (duration/frames/dimensions) across runs. Verdict `byte_identical` means the pipeline reproduces exactly (measured: two identical libx264 encodes on this machine are byte-identical); `content_identical` means the frames match but container bytes differ, with the differing format tags named (usually `creation_time`); `differs` means the pipeline itself is nondeterministic, with the first differing run pair named. A download-first manifest re-fetches its URL on every run (unless the download step sets `cache:true`, which serves the verified per-URL cache instead). `doctor` reports the `framemd5` muxer | `mediakit determinism recipe.json` / `mediakit determinism recipe.json --runs 3` |
| `assemble` | Film assembler (Autopilot-style): build a finished video from one declarative film manifest — shots on a voice-led timeline, mixed audio, burned captions, QA + receipt. The voice is the master clock: total = lead + measured voice duration + tail, and shot durations must cover it exactly in frames. Four modes: `validate` (no writes), `preview` (first N seconds at half size — show it to the user), `approve` (records the fingerprint of the previewed files), `render` (needs a matching approval unless `--force`, recorded as `approval:'forced'`). `--async` (render only) returns a `job_id` immediately and renders in the background — poll with the `job` tool; the manifest + approval are validated before the job is created, so a bad manifest fails the call, not the poll. Async starts are gated (max 2 active render jobs / 10 starts per minute by default, see the `job` tool) — a refused start creates no job. `chapters: [{title, at}]` in the manifest becomes real MP4 chapters in `final.mp4` (render only, strictly increasing, inside the film). `preset` in the manifest (`vertical`/`horizontal`/`square`/`cinematic`/`vertical-60`, see `skills/shorts-video/assemble-presets.json`) picks `width`/`height`/`fps`/`style` for the whole film — explicit fields win and are reported in `preset_overrides`, preset-filled fields in `preset_applied`; without a preset, `width`/`height` stay required. Shot kinds: `image` (with `zoom` → `zoom_pan`, without → a still hold, motion gate 2.5s), `video` (trimmed + reframed), `color` (solid card, motion gate 2.5s), `canvas_scene` (a JS module that draws every frame in code with Canvas 2D — smooth 30fps animation, no AI video account; scene contract in `references/assemble-manifest.md`). A `canvas_scene` shot can name a built-in template instead (`"template": "bounce"` + `params`, registry `skills/shorts-video/scene-templates.json`: `title-card`/`bounce`/`slide-in`/`rings`, params merge over defaults) — write a scene file only when no template fits. The `bounce` template takes an `apex` param (ball height as a fraction of frame height, default 0.12, max 0.5); raise it when the shot carries a top text layer, or `diagnose` warns that the ball crosses the title band. `brand` in the manifest (`amber-teal`/`warm-story`/`minimal-line`, registry `skills/shorts-video/brands.json` — or your own ids from a `MEDIAKIT_BRANDS` file, see below) paints the whole film in one channel look — palette fills template colors and text-layer color/size, its style fills the caption style when no preset or explicit style sets one; explicit values win and are reported in `brand_overrides`, brand-filled fields in `brand_applied`; the resolved brand is part of the fingerprint, so editing `brands.json` (or your `MEDIAKIT_BRANDS` file) re-approves the film. Any shot may carry `text` — one or up to 4 text layers `{text, position?, size?, color?, box?, start?, end?}` (drawtext lower-thirds/titles timed inside the shot; `top` by default, clear of the burned captions). A shot after the first may carry `transition: {type, duration}` — one of the 58 xfade names `concat` accepts, centered on the cut, video-only (the audio timeline is untouched); video shots need the handle footage to exist in their source. Segments are cached by content hash, so a re-render rebuilds only changed shots. NOT the `manifest` tool (linear edit pipeline) | `mediakit assemble film.json --mode validate` then `--mode preview -o out/` → `--mode approve -o out/` → `--mode render -o out/` (or `--mode render --async` + `mediakit job <id>`) |
| `init_project` | Scaffold a new assemble video project in a directory: a `film.json` that already validates (preset `vertical` by default, two template shots, 4s total), a placeholder voice (440 Hz tone WAV, 3s — replace it with the real narration before delivery), placeholder captions, an `assets/` layout (`shots/`, `music/`) and a `CLAUDE.md` with the project lifecycle (`validate` → `diagnose` → `preview` → `approve` → `render` → `verify`). The starter film renders a real preview out of the box, so the project is edited, not debugged into existence. Refuses when `film.json` or `CLAUDE.md` already exists unless `--force` | `mediakit init my-film --title "Why the Moon Is Leaving" --brand amber-teal` |
| `job` | Inspect a durable async render job (started by `assemble --async` / `--mode render --async`): `status` (default) shows progress (`stage` + `percent`) and the terminal result (output, duration, frames, LUFS, SHA-256, QA verdict) or the error; `status` also carries `progress_history` — every distinct percent the worker reported, so in-stage movement is provable without polling luck; `list` shows all jobs, newest first (history omitted there); `cancel` stops a queued or running job (kills the worker's whole process group, ffmpeg children included — a job cancelled while queued is never rendered). Status and list rows also carry `estimate_remaining_seconds` — a rough upper-bound ETA in whole seconds while the job runs, plus `estimate_basis` (`progress-rate` from the job's own percent history, `elapsed-progress` from time since start, `complete`/`not-started`/`terminal`/`too-early`); the number is a guide, never a promise — it is null while the job is under 5% or has no usable timestamps. Jobs live under `MEDIAKIT_JOBS_DIR`, else `<workdir>/.mediakit-jobs`, one directory per job (`job.json` + `worker.log`). `admission` reports the render-job gate before you start one: at most 2 jobs queued-or-running and at most 10 job starts per minute by default (env `MEDIAKIT_MAX_JOBS` 1–8 / `MEDIAKIT_MAX_JOB_STARTS_PER_MINUTE` 1–60) — a start past the gate is refused with `JOB_ADMISSION_LIMIT` (HTTP 429) and creates no job; `doctor` reports the limits | `mediakit assemble film.json --mode render --force --async` → `mediakit job job-20261114-005800-a1b2c3d4` (or `mediakit job --list` / `mediakit job --cancel <id>`) |
| `silence` | Remove silent stretches, keeping a margin around speech; every kept segment gets a 12ms fade out + 15ms fade in at the join, so a cut mid-tone has no click. `--dry-run` prints the exact ffmpeg command and writes no file (needs `-o`; with nothing worth cutting the command is a stream-copy) | `mediakit silence in.mp4 -o tight.mp4` |
| `cropdetect` | Measure letterbox/pillarbox bars; returns the crop rect + a ready crop command | `mediakit cropdetect in.mp4` |
| `package` | Bundle a finished file for delivery: media + spec.json receipt + checksums.sha256 (+ captions) | `mediakit package out.mp4 -o delivery.zip --platform tiktok` |
| `receipt` | Write a provenance receipt (JSON sidecar) for a finished file: probe, SHA-256, size, measured loudness, optional platform check, ffmpeg versions — re-run `sha256sum` against it any time to prove the media has not changed | `mediakit receipt out.mp4 -o out.receipt.json --platform tiktok` |
| `mux` | Replace a video's audio track with an external audio file, stream-copying both (no re-encode: fast, lossless); `--audio-offset` shifts the new audio against the video (positive = audio later, negative = video later); `--shortest` stops at the shorter stream; `--dry-run` prints the ffmpeg command and writes no file | `mediakit mux video.mp4 voice.mp3 -o out.mp4 --audio-offset 0.5` |
| `mix` | Mix voice over a music bed with sidechain ducking (bed drops under speech), then master to target LUFS with two-pass loudnorm (render unmastered, measure, normalise with measured values); reports the ducking actually measured and warns when peak-limited. `--sfx <file>@<s>` drops a short sound at an exact timestamp (repeatable, mixed after ducking). `--dry-run` prints both ffmpeg commands (render + master) and writes no file | `mediakit mix voice.mp3 --music bed.mp3 -o mixed.mp3 --sfx ding.mp3@3` |
| `overlay` | Overlay a logo/watermark image (named position, margin, scale, opacity, optional timing). Position and fit are measured on the **display** frame — on a phone clip stored 1280x720 with rotation 90, top-right 120px lands at 576,24 on the 720x1280 frame the viewer sees; reports `source_dimensions` + `source_rotation`. `--dry-run` prints the exact ffmpeg command and writes no file (x/y/overlay_size are computed from the display probe, so they are exact) | `mediakit overlay in.mp4 --image logo.png -o out.mp4 --position top-right` |
| `pip` | Picture-in-picture: a second video over the main one (9 positions, size by width or scale, opacity, optional timing, audio main/pip/mix). Geometry is measured on **display** frames — a rotated main clip is 720 wide (not 1280 stored) and a rotated PiP clip keeps its portrait aspect (320x568, not 320x180 squashed); reports `source_dimensions` + `source_rotation` + `pip_source_dimensions`. `--dry-run` prints the exact ffmpeg command and writes no file (x/y/pip_size are computed from the display probes, so they are exact) | `mediakit pip main.mp4 --pip facecam.mp4 -o out.mp4 --position bottom-right` |
| `broll` | Insert B-roll clips into the main video at timestamps (1–8 clips, fullscreen cover or 9 PiP positions, optional dissolve `--fade`, audio main/broll/mix). One filter graph, no intermediate files: the main timeline is never cut, so the output duration is exactly the main duration; a window longer than its clip loops it; a window past the end is clamped and reported; overlapping windows are refused. `--audio broll` mutes the main track inside each window (a window whose clip has no audio goes silent, reported in `audio_notes`); `--audio mix` keeps the main track under the B-roll audio. Also a `manifest` step (clip files hash into the cache key) | `mediakit broll main.mp4 --clip cutaway.mp4@12@3 -o out.mp4 --audio broll` |
| `titlecard` | Render a title card PNG: big bold hook (3-6 words) on a coloured box, transparent canvas — overlay it onto frame 1 or use it as the opening card. `--style clean-bold\|minimal-line\|warm-story` uses that style's locked palette from `skills/shorts-video/styles.json` (text/box/font); `--brand amber-teal\|warm-story\|minimal-line` paints it in the channel look from `skills/shorts-video/brands.json` (primary = box, on_primary = text, same registry as `assemble`; set `MEDIAKIT_BRANDS` to a JSON file of your own to add more brand ids); an explicit colour/font overrides just that one locked value and is reported in `style_overrides` / `brand_overrides`. Resolution: explicit > brand > style > default; the brand never sets the font size `--dry-run` prints the exact ffmpeg command and writes no output file (the drawtext text file is written next to the output and kept, so the printed command runs as-is; font_size/colors are computed, so they are exact; size reports null) | `mediakit titlecard "The Moon Is Leaving Us" -o title.png --brand warm-story` |
| `intro` | Render a short intro clip: title on a solid-colour background, fading in and out (silent video) — concat it in front of the main clip. `--style` reuses the same locked palette (box colour becomes the background); `--brand` paints it in the channel look (background = background, text = text; `MEDIAKIT_BRANDS` adds your own ids) `--dry-run` prints the exact ffmpeg command and writes no output file (the drawtext text file is written next to the output and kept, so the printed command runs as-is; font_size/colors are computed, so they are exact; size/duration report null) | `mediakit intro "Welcome Back" -o intro.mp4 --duration 3 --brand warm-story` |
| `social` | Export one video to several platform specs in one call: reframe + trim to max duration + loudness + check each, writing `<base>-<platform>.mp4` + `manifest.json` | `mediakit social in.mp4 -o out/ --platforms tiktok,reels,shorts` |
| `scenes` | Detect scene changes / hard cuts; returns cut timestamps + segments (probe-only). `--detector content` scores hue/sat/luma separately (catches hue-only cuts); `--fades` adds fade in/out | `mediakit scenes in.mp4 --detector content --fades` |
| `motion` | Measure real movement (probe-only): per-second curve of the fraction of pixels that changed between adjacent frames, still intervals (runs ≥ `--min-still-seconds`, default 2s), and a verdict `moving` / `mostly-static` / `static`. Scale measured on disk: static title card 0.0000–0.0001, bouncing ball 0.003–0.009, testsrc 0.06, frozen stretch exactly 0.0000 — default still threshold 0.001 (0.1% of pixels). `--adaptive` calibrates the threshold to the clip instead (floor = 25th percentile of the curve × `--adaptive-factor` 2.0, capped at `--adaptive-cap` 0.005): light grain on a static shot (0.0007–0.0013) reads still instead of flickering across the fixed threshold, while a bouncing ball still reads moving. `--lag-seconds N` compares frames N whole seconds apart instead of adjacent frames, catching motion too slow for one frame step — a 10s fade-in reads static adjacent (energy 0.00043) but moving at lag 2 (energy ~1.0); a creeping zoom is amplified 11x. Still intervals in lag mode are corrected to clip time (end + lag, clamped); a still shorter than lag+1s or in the final lag seconds is not reported. The director's motion gate: run it on every shot before calling a film done | `mediakit motion shot.mp4` / `mediakit motion grainy.mp4 --adaptive` / `mediakit motion fade.mp4 --lag-seconds 2` |
| `hook` | Find the best hook window in a clip (probe-only, writes no file): slide a window of `--duration` seconds (4–20, default 15) across the file and score each candidate on four measured signals — mean audio energy (astats RMS, normalized against the file's own loudest bin), speech coverage (silencedetect complement), scene cuts (a window opening on a cut scores higher) and real motion (per-frame pixel-diff, binned on the same step grid, normalized against a fixed 0.06 reference — testsrc-level motion is 1.0 — with a 0.001 noise floor and a 0.005 file-level gate so a static clip never scores motion from encoder noise). Score is 0.35×energy + 0.25×speech + 0.2×cut + 0.2×motion (audio 0.6 / video 0.4, the shorts-maker-gpu split) with fixed weights; the top windows are greedy non-overlapping, so they are alternatives, not the same window shifted one step. Returns ranked candidates with the score breakdown, the per-step energy curve (each bin also carries `motion` + `motion_fraction`), pacing from real cuts (slow/medium/fast-cut), a `trim` object and a `suggested_trim` command. The trim end snaps to the nearest quiet moment in the window's last `--snap-window` seconds (default 5): quiet is (energy + motion) / 2 per bin, a bin only qualifies at most half as busy as the window mean, earliest wins a tie so the cut lands where the quiet starts, and the snap never shortens the hook below max(4s, half the window); `--no-snap-quiet` keeps the raw window end. Video-only input scores on cuts+motion; audio-only on energy+speech; files over 20 minutes are refused. The director's opening-shot picker: run it on raw footage before cutting the first 15 seconds of a Short. Clip history: `--history-file hooks.json` checks every candidate against moments already cut (JSON `{version: 1, records: [{source_sha256, start, end, score, recorded_at}]}`) — same source sha256 + overlap >= `--history-overlap` (default 0.5) of the shorter window flags `duplicate` + `duplicate_of`; `--record` appends only the winning window (a missing file is an empty history, a corrupt one fails loudly; the history file is part of the batch/manifest cache key) | `mediakit hook raw.mp4 --duration 10 --history-file hooks.json --record` |
| `bpm` | Measure the musical tempo of a clip in BPM (probe-only, writes no file): spectral-flux onset function, then autocorrelation + comb-filterbank period search with a 120 BPM prior and an onset-recall tie-break (aubio's tempo pipeline, re-implemented in pure Node). Returns `bpm` (1 decimal), `beat_period_seconds`, `confidence` 0–1, a `reliable` flag, `onset_recall`, `onsets_detected`, `first_beat_seconds` and the first 16 `beats` — the grid a beat-snapping cut snaps to. A steady tone has no onsets and speech has no steady beat: both report `reliable: false` with low confidence instead of a confident wrong number — never snap cuts to an unreliable grid. Files over 10 minutes or under 4s are refused | `mediakit bpm music.mp3` |
| `beat_grid` | Return the full beat grid of a clip (probe-only, writes no file): the same measurement as `bpm`, expanded to every beat across the file instead of the first 16 — the cut points `trim --snap-beat` snaps to, and what a director hands to an editor. Returns `bpm`, `beat_period_seconds`, `confidence`, a `reliable` flag, `onset_recall`, `onsets_detected`, `first_beat_seconds`, `beats` (all of them), `beat_count` and `last_beat_seconds`. An unreliable grid is still returned with `reliable: false` and a warning — never snap cuts to it. The grid is rigid by default (one steady tempo for the whole file); `--method dp` runs the DP beat tracker instead (librosa's `beat_track`, re-implemented in pure Node): it picks real onset peaks near the grid, so the beats stay on the music while the tempo moves, and reports `grid_method`, `tempo_drift_seconds` (worst distance from the rigid grid — 0.373s on a 120→132 drift take, 0.026s on a steady 120 click track) and `tempo_drift_cv`. Files over 10 minutes or under 4s are refused | `mediakit beat_grid music.mp3` |
| `tempo_drift` | Measure the local tempo of a clip over time (probe-only, writes no file): sliding-window tempo estimation — the aubio pipeline (spectral-flux + autocorrelation/comb + 120 BPM prior + onset-recall tie-break) run on overlapping windows of the onset envelope, aggregated to a 1-second `tempo_curve` (the local-tempo idea of librosa's `plp`). Returns `bpm` (global), `confidence`, a `reliable` flag, `tempo_curve` (1s bins with `bpm` + `confidence` + `reliable`), `start_bpm` / `end_bpm`, `delta_bpm`, `max_deviation_bpm`, `direction` (`speeding_up` / `slowing_down` / `steady`) and `verdict` (`steady` / `drifting` / `variable` / `unreliable`). Use it before snapping cuts to a beat grid: a drifting take (120→132 over 12s reads 122.7 → 129.2, delta +6.5) needs `beat_grid --method dp`, not the rigid grid. A steady tone or speech reports `verdict: unreliable`. Files over 10 minutes or under 8s are refused | `mediakit tempo_drift music.mp3` |
| `verify` | Verify an assemble render against its receipt (`assemble-receipt.json`, written next to `final.mp4` by every full render): re-hash every input (manifest, voice, music, captions, sfx, shot assets) and the output file, re-measure duration/frames/dimensions/LUFS, and report `matched`/`changed`/`missing` per item with a `pass`/`fail` verdict and the first difference. `--rerender` re-runs assemble from the recorded manifest (`force`) and compares the new receipt against the old one — on the same machine renders are byte-identical (measured: two renders of the same film, same sha256), so it is a real reproducibility proof; across machines only the measured properties are comparable. The rerender reuses the content-addressed shot cache (segments verified by size + sha256 on read), so it proves join/audio/mux determinism + cache integrity — delete `.mediakit-assemble-cache` next to the manifest to force fresh shot builds | `mediakit verify out/assemble-receipt.json` / `mediakit verify out/assemble-receipt.json --rerender` |
| `verify_cuts` | Verify an assemble render cuts where its film manifest promises: downscale the delivered video to a 270p draft, measure the real hard cuts with the content scene detector, and compare them against the manifest's shot boundaries — a hard cut must land within tolerance (default 0.25s) of its promised time, a transition must show a real visual change across its blend window (a fade fires no scene cut, so the frames just outside the window are diffed instead — floor 1.0 on the 0–255 scale: identical static frames measure 0.00, the weakest real change measured is 2.95), and any extra cut is reported as unexpected. Duration is checked against the voice timeline (±0.2s). Returns `ok` plus one entry per boundary (`confirmed`/`missing`/`invisible_transition`/`unmeasured`) and the list of unexpected cuts. Probe-only: writes nothing except a temp draft, removed afterwards unless `--keep-draft`. Use it after every render you must trust, next to `verify` (which proves the files did not move — this proves the render cuts where promised) | `mediakit verify-cuts film.json out/final.mp4` / `mediakit verify-cuts film.json out/final.mp4 --tolerance 0.5` |
| `diagnose` | Director preflight for an assemble film manifest (probe-only, writes nothing): run it after writing a `film.json` and before `approve`/`render` — `verify` is the post-render check, this is the pre-render one. Validates the manifest, then measures what validation cannot: real motion inside each video shot's exact window (a frozen video is an error), source geometry vs the film frame (upscale over 2x or a source fps below the film fps warns), the visual seam across each transition (near-identical frames warn — a cut would do), voice loudness (warns below −30 or above −8 LUFS), caption coverage and gaps, music loop count (over 3x warns), sfx tails past the film end, chapter alignment to cuts, and text layers that wrap past 4 lines or sit at the bottom in the burned-caption band. A `bounce` shot with a top text layer is checked too: the ball top at the apex (default 0.12H → 0.075H) must clear the title band, or diagnose warns with the numbers — raise the shot's `apex` param to fix it. Returns a `pass`/`warn`/`fail` verdict with one check per finding and the first issue; a broken manifest returns `fail` with `format_error` instead of throwing | `mediakit diagnose film.json` |
| `chapters` | Generate chapter markers for a long talk or film from measured pauses, not guesses. Two modes, exactly one: `--words-file` (a transcribe `--word-timestamps` JSON) splits the transcript wherever the gap between two words reaches `--min-gap` (default 2s) and titles each chapter from the first words spoken in it; `<input>` (a media file with audio) runs silencedetect and starts a chapter at each speech segment that follows a silence of at least `--min-gap`, titled Part 1..N. The first chapter is always at 0 (YouTube requires the first chapter at 0:00) — when the first word/speech starts later the chapter is clamped to 0 and reported. Over `--max-chapters` (default 32, the assemble cap) the closest neighbours merge first. Returns chapters in the assemble manifest shape `{title, at}`, so the result drops straight into `film.json`'s `chapters`; `-o` also writes that JSON to a file. Probe-only unless `-o` is given | `mediakit chapters --words-file talk.words.json` or `mediakit chapters talk.mp3 --min-gap 1` |
| `transitions` | List the xfade transition catalog, grouped by family (probe-only, writes no file): every name `concat` / `slideshow` / `assemble` accept, with a one-line description per family. `mediakit transitions` returns the full catalog (58 names on ffmpeg 8.1.2); `--category wipe` narrows to one family. Read this before picking a transition name, instead of guessing one and hitting "unknown transition" | `mediakit transitions` or `mediakit transitions --category reveal` |
| `export_timeline` | Export an assemble film manifest to an OpenTimelineIO timeline (`.otio`) — the director's EDL for a real editor (DaVinci / Premiere / any OTIO adapter): the same cuts, transitions, chapters and audio the ffmpeg render produces, with media linked by absolute `file://` URL. One Video track (a Clip per image/video shot, a Gap per color/`canvas_scene` shot — generated frames have no file, so the gap is honest — with a Transition between joined shots), plus Audio tracks for Voice (lead gap + voice + tail gap), Music (looped to the film length) and SFX (each at its timestamp); chapters become `Marker.2` markers on the video track (OTIO 0.18 cannot read `Marker.1`). Transitions map the xfade join exactly: `in_offset`/`out_offset` split the transition frames, so the OTIO dissolve starts where the ffmpeg blend starts; fade-family names become `SMPTE_Dissolve`, the rest `Custom_Transition` with the xfade name in metadata. Frame math is rational, never float seconds: every boundary is a whole number of frames at the film fps, and `frame_math` reports the snap error per shot (a 26.575s shot at 30fps is 797 frames with a −0.25-frame snap, never 797.25 frames). A file that vanished after validation is linked with `available_range` null and listed in `media.missing` instead of failing the export. The writer self-checks the document (every track sums to exactly `total_frames`) and refuses to write a bad one | `mediakit export-timeline film.json -o film.otio` |
| `keyframes` | List keyframe (I-frame) timestamps + GOP min/max/avg interval (probe-only) — check before a stream-copy trim. `--nearest <t>` (seconds or `MM:SS`) also reports the keyframe nearest one cut point: `before` (largest ≤ t), `after` (smallest ≥ t), `closest`, `distance_seconds`, `direction` (`before`/`after`/`exact`) — the snap target for a single cut without scanning the whole list | `mediakit keyframes in.mp4 --nearest 3.5` |
| `audio_levels` | Loudness curve + loudest moments of an audio stream (probe-only): one decode pass, per-frame astats Peak + RMS bucketed into `--bucket` windows (default 1s), RMS averaged in the linear domain. Returns every bucket `{start, end, rms_db, peak_db}` (true digital silence reports nulls, never a fake -inf), a summary (max peak, energy-mean RMS, min/max bucket RMS, dynamic range, silent buckets, loudest bucket) and the `--top` loudest moments (default 5) kept at least `--min-gap` apart (default 2s — a 3s shout does not fill the list with its own neighbours). Also a probe-only batch operation and manifest step. Cap: 3600 buckets | `mediakit audio-levels in.mp4 --bucket 1 --top 5` |
| `find` | Find media files by name, recursively under a directory (case-insensitive substring); each match comes back with probe info (duration, dimensions, codecs) so you pick the right file without guessing paths | `mediakit find clips/ --name moon` |
| `download` | Download a media file from an http(s) URL into the workspace — stock footage, a reference clip, a music bed. Typed and guarded (unlike a bare `ffmpeg -i <url> -c copy`): http/https only, no credentials in the URL, size cap enforced while streaming (default 500 MB, refused upfront when Content-Length already exceeds it), 5 redirects max, 300s timeout per attempt, written atomically via `<output>.partial` and renamed only on success, then probed — a file that is not media is deleted and reported, never left as a success. HLS (`.m3u8`) / DASH (`.mpd`) playlists are fetched with ffmpeg `-c copy` under a protocol whitelist (no `file://` segments) and the size cap is enforced after the fetch, since a playlist's size is unknowable until the last segment arrives; the output must be a video/audio container. Transient failures (HTTP 429/5xx, network errors) are retried with exponential backoff 1s/2s/4s honouring `Retry-After` (default 3 retries; timeouts and deterministic refusals are never retried). `--cache` reuses a verified per-URL disk cache (`MEDIAKIT_DOWNLOAD_CACHE_DIR` or `~/.cache/mediakit/downloads`, keyed by URL, verified by size + sha256; corrupt entries are re-fetched, playlists are never cached). `--rate-limit-rps` paces downloads in this process with a token bucket (0 = unlimited). The output extension is either given (must be a media extension) or derived from the Content-Type / URL path. Every successful download also writes a provenance record next to the file (`<output>.provenance.json`: source URL, final URL, redirects, content-type, SHA-256, sizes, versions) — the license is the caller's `--license` declaration (e.g. `CC0`, `CC-BY`, `Public Domain`), or `unknown` when none was given, never guessed. A policy file (`MEDIAKIT_LICENSE_POLICY` env, or `--license-policy-file`: `{allow?, deny?, require_license?}`) gates the download BEFORE any fetch — a declared license outside the allow list, inside the deny list, or missing when required is refused with `LICENSE_DENIED` and costs zero bytes (the gate runs before the cache too). Without a policy file the gate is off and the license is only recorded; `doctor` reports the policy state | `mediakit download https://example.com/clip.mp4 -o clips/clip.mp4` |
| `audit` | Read the audit log: every tool call on every transport (CLI, MCP stdio, MCP HTTP) is recorded as one JSONL line in `<workdir>/.mediakit-audit.jsonl` — tool, arguments hash + redacted copy, input/output files with size + SHA-256, duration, status. `--verify` re-hashes the recorded files on disk and reports matched/missing/changed per entry, so a stale or tampered output is caught instead of trusted. `MEDIAKIT_AUDIT_PATH` overrides the log location; `MEDIAKIT_AUDIT=0` disables recording; `doctor` reports the log's state | `mediakit audit --tool trim --status ok --verify` |
| `svg_animate` | Animate an SVG into a video, code-driven (no browser): keyframed translate/scale/rotate/opacity on elements by id, rendered frame by frame via librsvg — slide-ins, fades, bounces, spinning shapes | `mediakit svg-animate in.svg --anim anim.json -o out.mp4 --duration 4` |
| `doctor` | Read-only preflight: ffmpeg version, filters/encoders, tool availability, the `MEDIAKIT_WORKDIR` sandbox state when set, the `MEDIAKIT_BRANDS` file state (`brands_file`) when set, and a `gpu` section — hardware encoders present in the build plus which one (if any) actually passed a tiny probe encode, so "listed" is never mistaken for "usable". It also reports the job admission limits (`job_admission_limits`) and the effective ffmpeg timeout in ms (`ffmpeg_timeout_ms`, default 300000, env `MEDIAKIT_FFMPEG_TIMEOUT_MS` 60000–3600000 — raise it when a long render runs on a busy machine, as a 1080x1920 caption burn did in turn 98). An unavailable tool also reports a one-sentence `fix` telling you how to repair the ffmpeg install. `--smoke` runs a real end-to-end render after the static checks (generate a 2s clip → trim → loudness → verify on disk: duration, dimensions, LUFS) and fails `ok` when the render fails — static "available" is not proof a machine can render | `mediakit doctor` / `mediakit doctor --smoke` |
| `convert` | Change container/codec (omit a codec to stream-copy). `--gop <frames>` / `--gop-seconds <s>` sets an exact keyframe interval on re-encode (scene-cut keyframes disabled for libx264/libx265/mpeg4) — the spacing is measured on the output file. `--encoder auto` probes for the first working hardware encoder of the codec family (nvenc/qsv/vaapi/videotoolbox/amf) and falls back to software when none works — the fallback is reported in `encoder_fallback`, never silent; a named encoder must probe-usable or the call fails. The result reports `encoder_used` and verifies the output codec on disk (`codec_verified`). `--dry-run` prints the exact ffmpeg command and writes no file | `mediakit convert in.mov -o out.mp4 --video-codec libx264 --gop-seconds 2` |
| `compress` | Shrink a file with one named quality preset — low (CRF 32), medium (CRF 26), high (CRF 20), or `email-25mb` (targets 18 MB so the file still fits a 25 MB email attachment after base64 inflation) — each with its own x264 preset and audio bitrate; optional `--max-width` scales down first. `--target-size <MB>` encodes to an exact size instead (two-pass ABR, e.g. 10 for a Discord upload, 10% safety margin) and reports `target_met` measured on disk. In target-size mode a resolution ladder steps the frame down (1080→720→480→360→240) when the bitrate buys less than 0.045 bits per pixel per frame, so a starved encode stays watchable instead of mush; `--no-resolution-ladder` keeps the source frame. Target-size mode also returns a `quality_proof` — SSIM against the source at 3 sample points + PSNR mid-clip and a verdict in words (`indistinguishable` / `looks_the_same` / `slight_softening` / `visible_loss` / `clearly_degraded`); VMAF is measured at the mid point when the ffmpeg build has libvmaf (default vmaf_v0.6.1 model); otherwise SSIM is the measured proxy and the proof says so, and the proof rates encode fidelity at the delivered resolution (it does not penalize the ladder's resolution drop — compare `dimensions` + `bpp_after` for that tradeoff). `--no-quality-proof` skips the measurement. Reports the size before/after and the reduction actually measured on disk `--dry-run` prints the exact ffmpeg command(s) — two passes in target-size video mode — and writes no file (bitrate/ladder are computed from the input, so they are exact; size_after/target_met/reduction/quality_proof report null) | `mediakit compress in.mp4 -o small.mp4 --quality low` |
| `export_gif` | Export a clip (or segment) as an animated GIF with a two-pass palette (palettegen + paletteuse from the actual frames). Fits under `--max-size-mb` (default 10 MB, the GitHub README limit; Slack auto-plays only under ~2 MB) by stepping down fps, then width, then palette colours; reports `size_budget_met` measured on disk, with a warning when the budget cannot be met `--dry-run` prints the first ladder step's command and writes no file (the ladder plan is listed; later steps only run when the budget needs them; size/duration/frames report null) | `mediakit export-gif in.mp4 -o demo.gif --max-size-mb 2` |

Every tool returns a concise JSON result: output path, size, and the
verified duration/dimensions of what it produced.

### Custom brands (`MEDIAKIT_BRANDS`)

The three built-in brands (`amber-teal`, `warm-story`, `minimal-line`) live in `skills/shorts-video/brands.json` and are locked. To add your own channel look, point `MEDIAKIT_BRANDS` at a JSON file shaped the same way:

```json
{"brands": [{"id": "ink-paper", "name": "Ink Paper",
  "palette": {"background": "0B1220", "primary": "22D3EE", "accent": "F472B6", "text": "F8FAFC", "on_primary": "082F49"},
  "style": "clean-bold", "text_size": 60}]}
```

Rules: every palette needs all five keys as 6-digit hex, `text_size` 8–400, `style` (optional) must be a known style id. Your ids add to the built-ins — redefining a built-in id is refused, so a stray file can never shadow a locked look. Editing the file takes effect on the next call, and the resolved palette is part of the assemble fingerprint, so a palette edit re-approves the film. `doctor` reports the file under `brands_file` (`set`, `path`, `brands`, `custom`); a set but broken file makes `doctor` report `ok: false`.

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
length, and the mix is mastered to `--target-lufs` (−14) with two-pass
loudnorm — the mix is rendered unmastered first (to a
`<output>.unmastered<ext>` temp file, deleted afterwards), measured,
then normalised with the measured values, because a single-pass
loudnorm chained onto the graph undershoots on quiet voices with long
gaps under a bed (measured −14.7/−14.8 LUFS vs −14 target; two-pass
lands at −14.0 on m4a, −14.2 on mp3) — if the voice
file is a video its video stream is copied through. It reports the
ducking it actually achieved (`ducking_measured_db`, measured on the
ducked bed alone in a speech window vs a silence window), so tune
`--duck-db` from a measured number, not a guess, and warns when the
mix is peak-limited and cannot reach the target. MP3 masters are
encoded at 192k (ffmpeg's 64k default loses ~0.5 LU in the re-measured
output). `concat --transition
fade|wipeleft|dissolve|...` joins clips with a real crossfade instead of
a hard cut: every clip is normalized to the first clip's size/fps first
(in one filter graph, no intermediate files), then chained with `xfade`
+ `acrossfade` — output duration is sum(durations) minus (n−1) ×
transition length, and a clip without audio gets a silent bed so the
audio crossfade still works. The full catalog lives in the `transitions` tool
(`mediakit transitions`) and in `TRANSITION_CATEGORIES` in `src/core.js`
(one source of truth — the validator derives its list from the same
categories, so the count cannot drift from the docs again):

| Family | What it looks like | Names |
|---|---|---|
| **fade** | Cross-dissolve: one shot melts into the next, optionally through black, white, grey, or faster/slower | `fade`, `fadeblack`, `fadewhite`, `fadegrays`, `fadefast`, `fadeslow`, `dissolve`, `distance` |
| **wipe** | A hard edge sweeps across the frame, from a side or a corner | `wipeleft`, `wiperight`, `wipeup`, `wipedown`, `wipetl`, `wipetr`, `wipebl`, `wipebr` |
| **slide** | The incoming shot pushes the outgoing one off the frame | `slideleft`, `slideright`, `slideup`, `slidedown` |
| **smooth** | A slide with a soft, eased edge instead of a hard one | `smoothleft`, `smoothright`, `smoothup`, `smoothdown` |
| **shape** | The new shot opens (or closes) through a geometric mask | `circlecrop`, `rectcrop`, `circleclose`, `circleopen`, `horzclose`, `horzopen`, `vertclose`, `vertopen` |
| **diagonal** | A diagonal edge sweeps from one corner to the opposite | `diagbl`, `diagbr`, `diagtl`, `diagtr` |
| **slice** | The frame splits into strips that peel away | `hlslice`, `hrslice`, `vuslice`, `vdslice` |
| **wind** | Strips blow across the frame like wind | `hlwind`, `hrwind`, `vuwind`, `vdwind` |
| **cover** | The incoming shot covers the outgoing one like a curtain | `coverleft`, `coverright`, `coverup`, `coverdown` |
| **reveal** | The outgoing shot slides away, revealing the incoming one | `revealleft`, `revealright`, `revealup`, `revealdown` |
| **other** | No direction family: pixel dissolve, radial spin, blur, zoom, squeeze | `pixelize`, `radial`, `hblur`, `zoomin`, `squeezev`, `squeezeh` |

58 names in total — the complete `xfade` set on ffmpeg 8.1.2 except
`custom` (which needs a custom expression, not a bare name). Every tool that re-encodes AAC or MP3
pins the audio bitrate to 192k: ffmpeg's low AAC default let true
peak overshoot by ~1.4 dB on a loudness-normalised master (measured
turn 53). `compress`/`loudness` keep their preset bitrates, and
`image_to_video`, `slideshow` and `segment` keep their deliberate
128k. `frames` pulls N evenly spaced frames out
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
scores ~0.4, so keep the threshold at or below 0.4. `--detector content`
scores each frame change in hue, saturation and luma separately (the
PySceneDetect ContentDetector idea, measured with ffmpeg's signalstats —
no OpenCV): it catches a hue-only cut the ffmpeg metric misses entirely
(red → dark green, same luma: content 0.183, ffmpeg no cut at all).
Default content threshold is 0.05, calibrated on fixtures: weakest
measured flat cut 0.171, continuous testsrc2 never above 0.005. The
content detector also drops cuts that would open a scene shorter than
`--min-scene-len` frames (default 15) and drops 1-frame flashes: a cut
followed within `--flash-frames` (default 5) by a cut back to the same
content is a blip, not a scene (a 1-frame white flash reports 0 cuts,
`filtered.flash: 2`). `--fades` adds fade detection from mean luma: a
dark core (luma ≤ `--fade-threshold`, default 20 — limited-range black
is 16) with the ramp measured outward, so a 1s fade-in reports 0–1.03s
(±1 frame), not just its 3-frame dark core; type is `in`/`out`/`black`.
Content detection and fades refuse files over 20 minutes (the per-frame
stats JSON would approach the 16 MB capture buffer — trim a section
first). `keyframes` is
probe-only: it lists every I-frame timestamp plus the GOP interval, so
you know where a lossless cut can land — `trim --stream-copy --snap`
snaps the requested start down and end up to the nearest keyframes and
reports both the requested and the actual range. `trim --stream-copy
--smart-cut` keeps the exact start instead: it re-encodes only the head
up to the next keyframe (source bitrate ×1.2, like LosslessCut) and
stream-copies the rest — a start on a keyframe copies with no
re-encode at all, and a request wholly inside one GOP re-encodes the
whole clip. The tail end is capped by exact frame count, so the
duration lands within ~0.03s (the rest is AAC frame granularity).
Every video trim verifies the cut by default: `check_frames` compares
3 output frames (head/middle/tail) against the source at the requested
times and reports `cut_verified` plus `mean_abs_diff` per frame
(threshold max(5, `normal_step`)); re-encode noise measures 0.05–0.54
while a 3.5s slip measures 10.9+, and a snap that moved the cut fails
0/3. On ffmpeg 8.1.2 a plain stream-copy keeps the keyframe at
negative pts, so its content lands exactly and verifies with diff 0 —
the old "stream-copy slides to the keyframe" story does not hold
there. Limit: on frozen/static content every frame matches even a
slipped cut (`normal_step` ~ 0) — run `motion` first if the source may
be frozen. `--no-check-frames` (MCP `check_frames: false`) skips the
verification; audio-only inputs have nothing to check. `check --content`
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
stills joined with an xfade transition between every pair (`fade` by
default, any of the 58 names `concat` accepts) — one type for all
pairs, or a different one per join with `--transitions fade,wipeleft`
and `--transition-durations 1,0.5` (one entry per join; each duration
must be shorter than both slides it joins). Each image
is visible for its own duration — `--duration`, `--durations 3,5,2`,
or `{file, duration}` per image in MCP — so the total is exactly the
sum of the durations: internally each clip is duration + its outgoing
transition
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
`cut_words` and `remove_retakes`, one words file belongs to one clip, so batch finds it by
convention — `<words_dir>/<stem>.words.json`, default the input's own
folder (`--words-dir` points at a shared folder of per-clip files);
a clip with no words file fails its own row only, the rest still run.
In a manifest, `cut_words` and `remove_retakes` are normal steps with a single `words_file`
instead, resolved relative to the manifest like `captions`/`overlay`.
`slideshow` is the exception in both: in a batch it is a set operation —
the whole matched set of images (2–32) becomes ONE slideshow video
(`--args-json '{"output_name": "reel.mp4"}'`, default `slideshow.mp4`)
instead of one output per file, and the per-file cache does not apply;
in a manifest it may only be step 1 (it builds from images in args, so
the manifest input should be the first slide image) — a later step then
trims, reframes or grades the slideshow like any clip, and editing a
slide image re-runs the step because the image bytes are in the cache key.
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
but `gpu.available: false`. `convert --encoder auto` is the one tool
that acts on that probe: it uses the first working hardware encoder
of the codec family when one exists, and falls back to software with
`encoder_fallback: true` when none does. Presence in the build is not
proof of usability — static builds (e.g. BtbN's GPL builds) ship the
nvenc/qsv/vaapi/amf headers in every build, but each encoder still
needs its driver and GPU at runtime, so the probe encode is the only
honest test.

See [`skills/shorts-video/SKILL.md`](skills/shorts-video/SKILL.md) for the
full script → captioned vertical-video workflow.

## Safety

- No shell is ever involved: every ffmpeg call uses `execFile` with an
  argument array, so filenames and user input can't inject commands.
- Outputs are never allowed to overwrite their inputs.
- Inputs are validated (must exist and be readable) before ffmpeg runs.
- The CLI refuses an option a command does not declare (exit 2, with a
  `did you mean …?` hint for near-misses) instead of silently ignoring
  it — a mistyped flag can never quietly change what a command does.
  `mediakit <command> --help` lists exactly the options that command
  accepts.

## Skills included

- [`skills/mediakit/SKILL.md`](skills/mediakit/SKILL.md) — agent-facing
  guide: when to use each tool, re-encode vs stream copy, loudness targets.
- [`skills/shorts-video/SKILL.md`](skills/shorts-video/SKILL.md) — the
  short-form vertical-video workflow (script → 1080×1920 captioned clip).

## License

MIT — see [LICENSE](LICENSE).
