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
  MCP test). **Update 2026-11-10 07:56**: `gh auth refresh -s workflow`
  xong (device flow), commit 1c5e874 đã push; GitHub Actions run
  #42732152380 **success, 48s** — CI xanh lần đầu trên GitHub.

---

## Lượt 2 — 2026-11-10 (silence + doctor, 15 tools)

Environment: ffmpeg/ffprobe 8.1.2, Node v24.22.1. Test fixture mới:
`test/silence-source.mp4` — 640×360, 30 fps, h264 + aac mono, 9.0 s,
tone 440 Hz chỉ ở [0,2), [4,6), [7,9); lặng ở [2,4), [6,7)
(tạo bằng `aevalsrc` + `testsrc`, không download).

### silence (new tool)

| Case | Command | Result |
|---|---|---|
| detect-only | `silence test/silence-source.mp4 --detect-only` | Tìm đúng 2 khoảng lặng đã cắm: [2.002, 4.000] (1.998 s) và [6.003, 7.000] (0.997 s); kept segments [0, 2.202], [3.8, 6.203], [6.8, 9.0] (margin 0.2 s hai đầu); `removed_seconds: 2.195` |
| video cut | `silence … -o outputs/silence-cut.mp4` | 9.0 s → **6.867 s** (ffprobe 6.866667), 640×360, 108.0 KB; detect lại trên file đã cắt: **0 khoảng lặng ≥ 0.5 s** |
| audio-only | `silence test/silence-audio.mp3 -o outputs/silence-audio.mp3` | 9.009 s → **6.814 s**, 53.8 KB, mp3 |
| no silence | `silence test/source.mp4 -o outputs/silence-nosilence.mp4` | `removed_seconds: 0`, stream-copy nguyên file (243,932 bytes, 10.0 s) |

### doctor (new tool)

- `mediakit doctor`: `ok: true`, ffmpeg 8.1.2 / ffprobe 8.1.2,
  Node v24.22.1, linux-x64; 16/16 filters và 11/11 encoders có mặt;
  **15/15 tools available**.
- Lỗi parse fixture lúc đầu: dấu phẩy trong `lt(t,2)` của `aevalsrc`
  bị hiểu là tách filter — fix bằng cách bọc expression trong single
  quotes. Không phải bug của tool.

### Tests

- `npm run check`: `node --check` sạch trên `src/core.js`,
  `src/server.js`, `bin/mediakit.js`, `test/mcp-test.mjs`.
- `npm test`: **all 15 tools present**; probe/trim/reframe/check như
  trước; `doctor` qua MCP: ok=true, 15/15; `silence` qua MCP:
  9 → 6.867 s, removed 2.195 s trong 2 gaps.
- README (bảng 15 tools + đoạn silence/doctor), SKILL.md (rule 6
  "detect silence before you cut it" + mục doctor) đã cập nhật.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 3 — 2026-11-10 (cropdetect + package, 17 tools)

Environment: ffmpeg/ffprobe 8.1.2, Node v24.22.1. Fixture mới:
`test/letterbox.mp4` — 1920×1080, 30 fps, h264 + aac, 10.0 s:
`test/source.mp4` (1280×720) pad đen thành 1920×1080, nội dung thật
ở 1280×720+320+180.

### cropdetect (new tool)

| Case | Command | Result |
|---|---|---|
| letterbox | `cropdetect test/letterbox.mp4 --frames 10` | **Chính xác tuyệt đối: crop 1280:720:320:180**, bars top/bottom 180, left/right 320; 8/10 frames đồng thuận; suggested command `mediakit crop letterbox.mp4 --width 1280 --height 720 --x 320 --y 180 -o cropped.mp4` |
| full-frame | `cropdetect test/source.mp4 --frames 10` | crop 1280:720:0:0, `has_black_bars: false` |
| audio-only | `cropdetect test/silence-audio.mp3` | Từ chối đúng: `cropdetect needs a video input` (exit 2) |

- Suggested crop command đã chạy thử: `crop … -o outputs/cropped.mp4`
  → probe xác nhận **1280×720, 10.0 s**.
- Bug bắt được khi test: lần đầu tool chỉ sample N frame đầu file —
  source có fade-in tối nên mode ra 1224:720:376:180 (sai, không ổn
  định: 9 giá trị khác nhau trên 10 frame). Fix: sample đều khắp file
  bằng `select='not(mod(n\,step))'` trước `cropdetect`; sau fix mode
  1280:720:320:180 trên 51/60 frame khi sample 60.

### package (new tool)

ZIP writer thuần Node (stored entries, CRC32 tự viết — không thêm
dependency, không cần binary `zip` ngoài). Bundle gồm media +
`spec.json` (probe đo thật + LUFS + kết quả check platform) +
`checksums.sha256` + captions khi có.

| Case | Command | Result |
|---|---|---|
| audio + captions + platform | `package outputs/source-loud.mp3 -o outputs/delivery.zip --captions test/captions.srt --platform tiktok` | ZIP 81.0 KB, 4 files; LUFS đo thật **−14.4**; `platform_pass: false` — đúng, vì mp3 không có video stream (spec.json ghi rõ từng rule fail) |
| video happy path | `reframe crop → loudness -14 → package outputs/vert-loud.mp4 -o outputs/vert-delivery.zip --captions … --platform tiktok` | ZIP **412.2 KB**, 4 files; LUFS **−14.0**; **`platform_pass: true`** |
| verify độc lập | `unzip` + `sha256sum -c checksums.sha256` trong /tmp | **3/3 OK** (media, captions.srt, spec.json); hash media trong ZIP khớp file gốc `4c33f4ff…` |
| error cases | `package … -o bad.txt` | Từ chối đúng: `package output must end in .zip` (exit 2) |

### Tests

- `npm run check`: `node --check` sạch trên `src/core.js`,
  `src/server.js`, `bin/mediakit.js`, `test/mcp-test.mjs`.
- `npm test`: **all 17 tools present**; `cropdetect` qua MCP trả đúng
  1280:720:320:180; `package` qua MCP: 4 files, platform_pass false
  (đúng — file mcp-reframe chưa normalize loudness, −21.8 LUFS);
  `doctor` qua MCP: ok=true, **17/17 tools available** (cropdetect
  filter có mặt).
- README (bảng 17 tools + demo bước 5 package + đoạn cropdetect/
  package), SKILL.md (mục cropdetect/package + rule 10 + workflow
  9 bước) đã cập nhật.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 4 — 2026-11-10 (mix, 18 tools)

### mix (new tool)
Voice + music bed với sidechain ducking, theo ý học từ
user-github-me/soniccraft (ducking params attack/release, level giọng
trước khi trộn, master R128, đo kết quả thật). Implement bằng ffmpeg,
không copy code của họ: `sidechaincompress` + `amix` + `loudnorm`.

Fixture mới: `test/mix-voice.mp3` (9s, tone 660Hz theo nhịp
[0,2),[4,6),[7,9) — giống nhịp silence-source), `test/mix-music.mp3`
(9s, tone 220Hz liên tục, volume 0.8), `test/mix-music-short.mp3`
(2s, để test loop).

| Case | Command | Result |
|---|---|---|
| audio happy path | `mix test/mix-voice.mp3 --music test/mix-music.mp3 -o outputs/mix-test.mp3 --music-volume 0.5 --duck-db 12` | 9.0s, 70.7 KB; voice −22.1 LUFS → gain **+6.1 dB** (target −16); output LUFS đo thật **−14.1** (target −14); **ducking đo thật 9.9 dB** (target 12 — compressor thật, không phải số đặt vào) |
| duck sâu hơn | `--duck-db 18` | Đo thật **14.9 dB** (ratio 10) — độ sâu scale đúng theo tham số |
| không duck | `--duck-db 0` | ratio 1, `ducking_measured_db: null` (không đo khi không duck), LUFS −14.1 |
| nhạc ngắn hơn giọng | music 2s, voice 9s | Output vẫn **9.0s** — nhạc loop đúng (`-stream_loop -1`) |
| voice là video | `mix test/source.mp4 --music … -o outputs/mix-video.mp4` | 10.0s, video **1280×720 h264 copy nguyên**, LUFS −14.0; `ducking_measured_db: null` — đúng, vì audio source.mp4 liên tục không có khoảng lặng ≥1.1s để đo |
| error cases | music = captions.srt (không có audio) | Từ chối đúng: `mix needs an audio stream in the music file` (exit 2) |
| error cases | thiếu `--music` | `missing required option: --music <file>` (exit 1, theo chuẩn CLI) |
| error cases | `--duck-db 30` | `duck_db must be <= 24` (exit 2) |

- Bug bắt được khi test: `sidechaincompress` nhận threshold **tuyến
  tính 0–1**, không phải dB — `threshold=-30` bị ffmpeg từ chối
  (`out of range [0.000976563 - 1]`). Fix: threshold = 0.0316
  (= −30 dB tuyến tính), ratio suy từ duckDb theo công thức
  ratio = 20/(20−duckDb), clamp [1.2, 20]; comment trong code ghi rõ.
- Đo ducking: tool tự chạy lại graph ducked-bed-only và đo
  `volumedetect` trong cửa sổ giọng (0.1–0.5s trong đoạn nói) vs cửa
  sổ lặng (0.6–1.0s trong khoảng lặng, qua release 400ms); nếu không
  tìm được cặp cửa sổ thì trả null (best-effort, mix vẫn thành công).

### Tests

- `npm run check`: `node --check` sạch trên `src/core.js`,
  `src/server.js`, `bin/mediakit.js`.
- `npm test`: **all 18 tools present**; `mix` qua MCP: duration 9,
  output LUFS −14.1, voice gain 6.1 dB, ducking measured 9.9 dB;
  `doctor` qua MCP: ok=true, **18/18 tools available**
  (sidechaincompress/amix/aresample có mặt).
- README (bảng 18 tools + đoạn mix), SKILL.md (mục mix + rule 11) đã
  cập nhật. Fixture mix-voice/mix-music đã commit vào test/.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 5 — 2026-11-10 (concat --transition + frames, 19 tools)

### Học: yubraaj11/ffmpeg-mcp (12★, 12 tools, Python/FastMCP)
Đọc README + code thật (`crop_video.py`, `concat_clips_with_transition.py`,
`utils/validate_input_video_path.py`). Ý áp dụng được:
1. `concat_clips_with_transition` — nối clip bằng `xfade` + `acrossfade`,
   normalize trước (họ normalize ra file trung gian) → đã làm
   `concat --transition` (normalize trong cùng 1 filter graph, không file
   trung gian).
2. `extract_frames` — trích N frame đều nhau thành file riêng → đã làm
   tool `frames` mới.
3. Structured JSON errors (`status`/`error_type`/`message`/`time`) +
   validate input trước khi chạy (tồn tại, không rỗng, ffprobe đọc được) →
   MediaKit đã có sẵn `MediaKitError` + `requireInput`, không cần thêm.
4. `get_normalized_clips` — normalize song song trước khi concat → ý này
   nằm trong (1).
5. `overlay_image` (logo/watermark có timing + opacity) → chưa làm, backlog
   (cần cho workflow Shorts: chèn logo góc).
KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.

### concat --transition (mở rộng tool concat)
Normalize mọi clip về size/fps của clip đầu (scale + pad + setsar + fps)
trong 1 filter graph, rồi nối chuỗi `xfade` + `acrossfade` theo cặp.
Offset của transition thứ k = (tổng duration các clip trước) − k×t.
Clip không có audio được cấp bed câm bằng `anullsrc` đúng độ dài clip,
nên acrossfade luôn có 2 audio stream.

| Case | Command | Result |
|---|---|---|
| fade 2 clip khác size | `concat test/source.mp4 test/source2.mp4 --transition fade --transition-duration 1 -o outputs/concat-fade.mp4` | **15.022s** (kỳ vọng 10+6−1=15), **1280×720**, 510.7 KB; pixel-check (cùng độ phân giải, scale 640×360 gray): out@5 = source1@5 MAD **0.05**, out@11/12/14 = source2@2/3/5 MAD **0.67–0.71**, giữa fade out@9.5 MAD 6.58 vs source thuần (đúng — frame blend 50/50) |
| wipeleft 3 clip | `concat source.mp4 source2.mp4 source.mp4 --transition wipeleft --transition-duration 0.5 -o outputs/concat-wipe.mp4` | **25.029s** (kỳ vọng 10+6+10−2×0.5=25), 1280×720, 868.6 KB; pixel-check: out@16/20/24 = source1@1/5/9 MAD **0.05–0.06** (offset xfade thứ 2 = 15.0, tau = t−15) |
| plain concat (không transition) | `concat source.mp4 source2.mp4 -o outputs/concat-plain.mp4` | **16.037s** (10+6), 410.9 KB — đường cũ không đổi |
| error cases | `--transition nosuch` | Từ chối đúng: `unknown transition: nosuch` + danh sách 49 transition hợp lệ (exit 2) |
| error cases | `--transition-duration 7` (clip ngắn nhất 6s) | `transition_duration (7s) must be shorter than the shortest clip (6s)` (exit 2) |
| error cases | 1 input | `concat needs at least 2 input files` (exit 1) |

- Bẫy đo lường bắt được khi verify: so pixel RAW giữa 2 file khác độ
  phân giải (640×360 vs 1280×720) cho MAD ~97 vô nghĩa vì hàng pixel
  lệch nhau — tưởng transition hỏng, soi ảnh trực tiếp mới thấy frame
  đúng (digit "3" ở out@12 = source2@3). Fix phép đo: scale cả 2 về
  cùng 640×360 gray trước khi so. Sau khi sửa: MAD 0.05–0.71, khớp
  đúng tau = t − offset. Bài học: **verify pixel phải cùng độ phân
  giải; số MAD chỉ có nghĩa khi 2 frame cùng kích thước.**
- Audio: acrossfade chạy đúng — output có audio aac, duration khớp video
  (15.022s / 25.029s).

### frames (tool mới)
`fps=N/D` trích đúng N frame đều nhau thành `frame-001.png`… kèm
timestamp `i×D/N` mỗi file.

| Case | Command | Result |
|---|---|---|
| 5 frame, width 320 | `frames test/source.mp4 -o outputs/frames-test --count 5 --width 320` | **5 file** trên đĩa (11.2–11.9 KB mỗi file), timestamps **0, 2, 4, 6, 8** |
| qua MCP | `frames` count 5 | extracted 5, timestamps 0,2,4,6,8 |

### Tests

- `npm run check`: `node --check` sạch trên `src/core.js`,
  `src/server.js`, `bin/mediakit.js`.
- `npm test`: **all 19 tools present**; `concat` + fade qua MCP:
  duration 15.022, expected 15, 1280×720; `frames` qua MCP: extracted
  5; `doctor` qua MCP: ok=true, **19/19 tools available**
  (xfade/acrossfade/fps có mặt).
- README (bảng 19 tools + đoạn concat-transition/frames), SKILL.md
  (mục concat-transition + rule 12 "look before you cut") đã cập nhật.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).
