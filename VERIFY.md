# MediaKit for Agents — verification log

Date: 2026-11-08. Environment: Node v24.22.1, npm 10.9.4, ffmpeg/ffprobe 8.1.2.
Package name check: `npm view mediakit-for-agents` → **404 (name free, not taken)**.

## Setup
- `npm install` — clean, 95 packages, no errors.
- `node --check` on `src/core.js`, `src/server.js`, `bin/mediakit.js` — all pass.
- SDK installed: `@modelcontextprotocol/sdk@1.32.2`, `zod@3.25.0`.

## Test media
Generated with ffmpeg (no downloads):
- `test/source.mp4` — 1280×720, 30fps, h264 + aac, 10.0s (testsrc + 440Hz sine)
- `test/source2.mp4` — 640×360, 6.0s (second concat input, unused in final run — concat used two trims instead)
- `test/captions.srt`, `test/demo-captions.srt` — hand-written SRT files

## CLI verification (every command run against test media)

| # | Command | Output | Verified properties | Result |
|---|---|---|---|---|
| 1 | `probe test/source.mp4` | JSON metadata | 10.0s, 1280×720, h264/aac, 30fps | ✅ PASS |
| 2 | `trim --start 2 --duration 5` | `outputs/trim.mp4` | duration_actual 5.0s, 123.1 KB | ✅ PASS |
| 3 | `trim --start 1 --duration 3 --stream-copy` | `outputs/trim-copy.mp4` | 3.167s (keyframe boundary — expected for stream copy) | ✅ PASS |
| 4 | `crop --width 640 --height 360 --x 320 --y 180` | `outputs/crop.mp4` | 640×360 confirmed by probe | ✅ PASS |
| 5 | `resize --width 640` | `outputs/resize.mp4` | 640×360, aspect kept | ✅ PASS |
| 6 | `extract-audio -o audio.mp3` | `outputs/audio.mp3` | mp3, 10.008s | ✅ PASS |
| 7 | `extract-frame --timestamp 3` | `outputs/frame.png` | 1280×720 PNG | ✅ PASS |
| 8 | `thumbnail --frames 6` | `outputs/sheet.jpg` | 960×360 (3 cols × 320, 2 rows) | ✅ PASS |
| 9 | `loudness -o loud.mp3` | `outputs/loud.mp3` | measured −14.43 LUFS integrated (target −14, within 0.5 LU) | ✅ PASS |
| 10 | `concat trim.mp4 trim-copy.mp4` | `outputs/joined.mp4` | 8.1s ≈ 5.0 + 3.167 (container rounding) | ✅ PASS |
| 11 | `convert --video-codec vp9 --audio-codec libvorbis` | `outputs/converted.webm` | VP9/Vorbis, 10.011s, 1280×720 | ✅ PASS |
| 12 | `burn-captions --captions captions.srt --font-size 32` | `outputs/captioned.mp4` | 10s; frame at 1.5s inspected by eye — "MediaKit gives agents" visible in black box | ✅ PASS |
| 13 | `--help` / `trim --help` / `--version` | help text + `mediakit 0.1.0` | all commands listed with usage | ✅ PASS |
| 14 | Error cases: missing input, crop out of bounds | stderr + exit code 2 | `INPUT_NOT_FOUND`, `INVALID_ARG` with clear messages | ✅ PASS |

## MCP server verification (stdio)
Test script: `test/mcp-test.mjs` (SDK client: initialize → tools/list → call probe + trim).
- `tools/list` returned all **11 tools**: probe, trim, crop, resize, extract_audio, extract_frame, thumbnail, loudness, concat, burn_captions, convert.
- `tools/call probe` → full metadata JSON for `test/source.mp4`.
- `tools/call trim` (start 1, duration 2) → `outputs/mcp-trim.mp4`, ffprobe confirms **2.000s, h264 1280×720**.
- `mediakit mcp` CLI entry point: piped JSON-RPC `initialize` → valid response with `serverInfo: mediakit-for-agents 0.1.0`.

## Demo: 9:16 vertical captioned clip
Commands (all via the tool itself):
```
crop test/source.mp4 --width 406 --height 720 --x 437 --y 0 -o outputs/demo-cropped.mp4
resize outputs/demo-cropped.mp4 --width 1080 --height 1920 --no-keep-aspect -o outputs/demo-vertical.mp4
burn-captions outputs/demo-vertical.mp4 --captions test/demo-captions.srt --font-size 48 -o outputs/demo-vertical-captioned.mp4
```
Result: **`outputs/demo-vertical-captioned.mp4`** — ffprobe: 1080×1920, h264, 10.0s, aac audio.
Frames inspected by eye at 1.5s ("Your agent can / finally see video.") and 8s ("MediaKit / for Agents.") — captions legible, correctly placed at the bottom.

## Bug found and fixed during verification
**Caption font-size scaling (real bug, fixed).** First demo burn rendered
captions ~6× too large — one word per line, text running off the top of the
frame. Cause: ffmpeg's `subtitles` filter converts SRT→ASS with a default
PlayRes of 384×288, and libass scales FontSize against it, so FontSize=48
on a 1080×1920 frame rendered as ~320px type. Fix in `src/core.js`:
`burnCaptions` now probes the video and pins `PlayResX/PlayResY` in
`force_style` to the real dimensions, so `--font-size` means actual pixels.
Re-verified after the fix on both 1080×1920 (font 48) and 1280×720 (font 32);
both frames inspected by eye and correct. The landscape `burn-captions` test
was re-run after the fix.

## Notes / caveats
- Stream-copy trim is keyframe-accurate only (3.167s vs requested 3.0s) — documented in README + SKILL.md, not a bug.
- Loudness uses single-pass loudnorm; measured −14.43 LUFS vs −14 target. Good for speech/creator audio, not sample-exact broadcast mastering — documented.
- `concat` re-encodes (slower but safe across mixed codecs) — documented.
- Nothing was pushed to GitHub or published to npm. No accounts created.

---

## Unreleased (main, after 0.1.0) — verified 2026-11-10

Environment: ffmpeg 8.1.2. Source: `test/source.mp4` — 1280×720, h264,
30 fps, aac mono, 10.0 s, 243,932 bytes.

### reframe (new tool)

| Mode | Output | Dimensions | Duration | Size |
|---|---|---|---|---|
| crop | `outputs/reframe-crop.mp4` | 1080×1920 | 10.0 s | 409.0 KB |
| pad | `outputs/reframe-pad.mp4` | 1080×1920 | 10.0 s | 227.6 KB |
| blur | `outputs/reframe-blur.mp4` | 1080×1920 | 10.0 s | 554.6 KB |

- Crop window computed from aspect: 404×720 at x=438 (centre) — even
  dimensions, no overflow. `--x 0` anchors left (crop 404×720+0+0).
- `--x 9999` correctly rejected: `x must be <= 876` (exit 2).

### check (new tool)

- `check reframe-crop.mp4 --platform tiktok`: 6/7 rules pass;
  loudness fails honestly at **−21.8 LUFS** (quiet test tone).
- `check source.mp4 --platform tiktok`: dimensions fail (1280×720 vs
  1080×1920) + loudness fail — as expected.
- Full loop `reframe crop → loudness -14 → check tiktok`: **pass: true**,
  all 7 rules OK, measured **−14 LUFS**, 1080×1920, 30 fps, 10.1 s.
- `check --platform shorts` / `youtube` also verified (fail correctly
  on the un-normalized source).

### Fixes found by testing this run

- CLI parser rejected negative option values (`--target-lufs -14` was
  read as a flag, `target_lufs must be <= 0, got: 1`). Fixed: a token
  matching `-\d` after a `--flag` is now taken as its value.
- `loudness` rejected video outputs (`.mp4` not in the audio format
  list). Fixed: `.mp4/.mov/.m4v/.mkv` write AAC audio + copy video,
  `.webm` writes Opus + copy video. Audio-only outputs unchanged
  (verified `loudness … -o loud.mp3` still works).

### Tests

- `npm run check`: `node --check` clean on `src/core.js`,
  `src/server.js`, `bin/mediakit.js`, `test/mcp-test.mjs`.
- `npm test` (`test/mcp-test.mjs`): **all 13 tools present** in
  `tools/list`; probe, trim, reframe, check calls succeed over MCP.
- CI: `.github/workflows/ci.yml` (Node 20, ffmpeg from apt, `npm ci`,
  syntax check, CLI smoke incl. `check … | grep '"pass": true'`,
  MCP test). Not yet observed green on GitHub — first push will show it.
