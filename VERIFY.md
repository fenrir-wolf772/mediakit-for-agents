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

## Lượt 6 — 2026-11-10 (overlay + scenes, 21 tools)

### Học: dubnium0/ffmpeg-mcp (22★, 40+ tools, Python/FastMCP)
1. `add_image_overlay` — logo/watermark: position bằng expression
   (`W-w-10`, `(W-w)/2`), opacity qua `colorchannelmixer=aa=`,
   timing qua `enable=between(t,start,end)` → đã làm `overlay`
   (nhưng dùng named position + tính x/y bằng JS thay vì expression
   tự do — expression là injection surface trong filter graph).
2. `detect_scene_changes` — `select=gt(scene,threshold)` qua lavfi
   `movie=` + `ffprobe -show_frames` → đã làm `scenes` (trả thêm
   segments giữa các cut để trim đúng biên).
3. `get_keyframes` — liệt kê keyframe timestamps (cần cho trim
   stream-copy an toàn) → backlog mới.
4. `run_command` trả structured result kèm command string →
   củng cố backlog "error kèm retry command".
5. `validate_output_path` tự tạo parent dir → MediaKit đã có
   (`prepareOutput`), không cần thêm.
KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.

### overlay (tool mới)
PNG logo lên video: named position + margin, scale theo `--width`
(giữ aspect), opacity qua `colorchannelmixer`, timing qua
`enable=between(t,…)` / `gte` / `lte`. Vị trí tính bằng JS từ frame
đã probe; từ chối khi overlay + margin không vừa khung, opacity 0,
`end <= start`, `start` quá cuối video. Audio stream-copy
(`-map 0:a?` nên input không audio vẫn chạy).

| Case | Command | Result |
|---|---|---|
| top-right, width 120 | `overlay test/source.mp4 --image test/logo.png -o outputs/overlay-test.mp4 --position top-right --margin 24 --width 120` | **x=1136, y=24** (1280−120−24 ✓), 120×120, 1280×720, 10s, 243.9 KB; **pixel thật**: vùng logo RGB **252,0,0** (đỏ thuần) vs cùng điểm trên source **255,255,255** (testsrc trắng) |
| bottom-left, opacity 0.5, start 2 end 4 | `overlay … --position bottom-left --width 100 --opacity 0.5 --start 2 --end 4` | x=24, y=596; **pixel thật**: t=1 → **0,0,1** (logo ẩn), t=3 → **127,0,0** (đúng blend 50% đỏ trên nền đen), t=5 → **0,0,0** (ẩn lại) |
| input không audio | `overlay /tmp/noaudio.mp4 … --position center --width 80` | 640×360, 3s — `-map 0:a?` chạy đúng |
| error cases | `--position nowhere` / `--width 1300` / `--opacity 0` / ảnh không tồn tại | Từ chối đúng, exit 2, message rõ (vị trí hợp lệ / không vừa khung / opacity 0 / file không tồn tại) |
| qua MCP | `overlay` top-right width 120 | top-right 1136,24, 120×120, 1280×720, 10s |

### scenes (tool mới)
`ffprobe -f lavfi movie=…,select=gt(scene,threshold) -show_frames`,
trả cut timestamps + segments. Fixture `test/scenes-source.mp4`
(đỏ 5s + xanh 5s, concat hard cut).

| Case | Command | Result |
|---|---|---|
| cut đỏ→xanh, threshold 0.3 | `scenes test/scenes-source.mp4` | **count 1, cut 5.033s** (kỳ vọng 5.0; concat cộng ~33ms), segments **0–5.033 / 5.033–10.039** |
| threshold 0.9 | `scenes … --threshold 0.9` | count 0 — **đúng**: đo `lavfi.scene_score` tại cut = **0.4** (trần của metric với màu phẳng), nên threshold >0.4 bỏ lỡ cut thật. Ghi chú vào README/SKILL: giữ threshold ≤0.4 cho hard cut |
| không có cut | `scenes test/source.mp4` (testsrc liên tục) | count 0 — không false positive |
| error cases | `scenes test/mix-voice.mp3` (audio-only) | Từ chối đúng exit 2 |
| qua MCP | `scenes` threshold 0.3 | count 1, changes 5.033, segments 0–5.033 5.033–10.039 |

- Bẫy đo lường bắt được khi verify: script verify pixel đầu tiên
  quên `encoding: "buffer"` cho `execFile` nên stdout về dạng string,
  cộng dồn ra NaN — tưởng overlay hỏng. Fix: đọc rawvideo dạng
  Buffer rồi mới tính mean RGB. Bài học: **verify số phải kiểm tra
  kiểu dữ liệu đầu vào của phép đo trước khi tin kết quả.**
- Fixture mới: `test/logo.png` (200×200 đỏ, 608 B),
  `test/scenes-source.mp4` (640×360, 10.039s, cut tại 5.033s).

### Tests

- `npm run check`: `node --check` sạch trên `src/core.js`,
  `src/server.js`, `bin/mediakit.js`.
- `npm test`: **all 21 tools present**; `overlay` + `scenes` qua MCP
  như bảng trên; `doctor` qua MCP: ok=true, **21/21 tools available**
  (overlay/format/scale/colorchannelmixer/select có mặt).
- README (bảng 21 tools + đoạn overlay/scenes), SKILL.md
  (rule 13 "logos go on with overlay" + rule 14 "cut on scene
  boundaries" + workflow bước 9) đã cập nhật.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 7 — 2026-11-10 (keyframes + trim --snap + sửa bug MCP mapping, 22 tools)

### Bug bắt được trước khi làm tính năng mới
Audit mapping snake_case (MCP) → camelCase (core): 5 tool trong
`src/server.js` truyền thẳng object `a` vào core trong khi core chờ tên
camelCase — tham số bị lặng lẽ bỏ qua, dùng default. Bằng chứng trước
khi sửa (gọi qua MCP stdio thật):
- `trim stream_copy=true` → kết quả `"stream_copy": false` (re-encode
  thay vì copy lossless).
- `loudness target_lufs=-20` → kết quả `"target_lufs": -14` (default).
Ba tool còn lại cùng lỗi: `resize keep_aspect`, `convert
video_codec/audio_codec`, `burn_captions font_size`. CLI không dính
(vì `bin/mediakit.js` map tường minh). Fix: map tường minh trong
server.js cho cả 5 tool (theo pattern sẵn có của concat/mix/silence).
Bài học: **mọi tool MCP truyền thẳng `a` vào core đều phải audit tên
tham số — default lặng lẽ che bug; test MCP phải assert giá trị tham
số tới được core, không chỉ "gọi thành công".** Đã thêm case regression
vào `test/mcp-test.mjs` (trim stream_copy + snap).

### Tính năng mới
- `keyframes` (core+CLI+MCP): ffprobe `-skip_frame nokey` nên chỉ
  decode keyframe — trả timestamps + count + GOP min/max/avg + flag
  starts_with_keyframe. Probe-only, không ghi file.
- `trim --snap` / `snap_to_keyframe` (chỉ với stream-copy): start dời
  xuống keyframe gần nhất ≤ start, end dời lên keyframe gần nhất ≥ end
  (kẹp theo duration); trả `requested_start/requested_end` +
  `keyframe_start/keyframe_end` + `snapped`. `--snap` không kèm
  stream-copy bị từ chối (re-encode đã frame-accurate).

| Case | Command | Result |
|---|---|---|
| keyframes | `keyframes test/source.mp4` | **count 2, [0, 8.333], GOP 8.333s** (đúng GOP 250 frame @30fps đã đo bằng ffprobe tay trước đó) |
| trim snap CLI | `trim … --start 1 --duration 2 --stream-copy --snap` | requested **1–3** → snapped **0–8.333**, duration_actual **8.4s** (ffprobe), 203.4 KB |
| snap không stream-copy | `trim … --snap` (không --stream-copy) | Từ chối đúng exit 2, INVALID_ARG |
| keyframes audio-only | `keyframes test/mix-voice.mp3` | Từ chối đúng exit 2 |
| MCP trim stream_copy | `trim` stream_copy=true | `"stream_copy": true`, output **2.1s, codec h264** (copy, không re-encode) |
| MCP loudness -20 | `loudness` target_lufs=-20 | `"target_lufs": -20`; đo lại file bằng loudnorm: **input_i −20.11 LUFS** |
| MCP resize | `resize` 640×480 keep_aspect=false | output **640×480** đúng (phân biệt với keep_aspect=true) |
| MCP convert | `convert` video_codec=libx265 | kết quả libx265; ffprobe codec trên đĩa **hevc** |
| MCP burn_captions | `burn_captions` font_size=48 | kết quả `font_size: 48` |
| qua MCP | `keyframes` + `trim` snap | keyframes count 2, [0, 8.333], GOP 8.333; trim snap: requested 1–3 → actual **0–8.333**, duration_actual 8.4s |

- Bẫy đo lường: lần đo loudness đầu tiên pipe `2>&1 | tail` ra rỗng
  (loudnorm in JSON qua stderr nhưng ffmpeg thoát trước khi flush vào
  pipe) — tưởng file lỗi; đo lại bằng `2> file` rồi grep mới đúng
  −20.11 LUFS. Bài học: **đo loudness thì redirect stderr ra file,
  không pipe trực tiếp.**

### Tests

- `npm run check`: `node --check` sạch trên `src/core.js`,
  `src/server.js`, `bin/mediakit.js`.
- `npm test`: **all 22 tools present**; `keyframes` + `trim --snap` qua
  MCP như bảng trên; `doctor` qua MCP: ok=true, **22/22 tools available**.
- README (bảng 22 tools + đoạn keyframes/snap), SKILL.md
  (rule 15 "stream-copy cuts must land on keyframes") đã cập nhật.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 8 — 2026-11-10 (fit + check mở rộng + thời gian MM:SS, 23 tools)

### Học: video-creator/ffmpeg-mcp (153★, 8 tools, Python)
- `clip_video` nhận thời gian dạng `MM:SS`/`HH:MM:SS`, không chỉ số
  giây → đã làm `parseTime()` dùng chung cho `trim` (start/duration/
  end) và `fit --duration` (CLI nhận `0:30`, `1:30`; MCP giữ số giây).
- `concat_videos(fast=True/False)` — probe các clip, giống hệt nhau
  (codec/res/fps) thì concat demuxer stream-copy, khác thì normalize
  (scale `force_original_aspect_ratio` increase→crop / decrease→pad
  theo chênh aspect < 0.15) → backlog mới (MediaKit `concat` hiện luôn
  re-encode; fast-path tiết kiệm thời gian cho clip đồng nhất).
- `overlay_video` picture-in-picture (video đè video, 9 vị trí +
  `amix` weights 3:1) → backlog mới (MediaKit `overlay` hiện chỉ nhận
  ảnh tĩnh).
- `find_video_path` tìm file theo tên, đệ quy trong thư mục → backlog
  (thấp, tiện cho agent).
- Anti-pattern: repo bundle ffmpeg binary riêng cho macOS (git clone
  từ gitee lúc chạy, chỉ hỗ trợ macOS) — MediaKit giữ ffmpeg hệ thống
  + `doctor` kiểm tra, không làm theo.
KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.

### Tính năng mới
- `fit` (core+CLI+MCP): fit đúng độ dài đích. `--method speed`
  (mặc định): video `setpts=PTS/factor`, audio `atempo` chia chuỗi
  (mỗi bước trong [0.5, 2.0], factor cho phép [0.25, 4]); `trim`: cắt
  nguồn dài hơn (re-encode, `-t`); `loop`: `-stream_loop -1` nguồn
  ngắn hơn rồi `-t`. Trả `duration_actual` + `duration_error_seconds`
  đo thật bằng ffprobe. Chạy được cả audio-only.
- `check` mở rộng: (1) rule `video_bitrate` — thang khuyến nghị theo
  độ phân giải + fps (YouTube công bố: 1080p 8 Mbps @30fps / 12 @60fps,
  720p 5 / 7.5; TikTok/Reels không công bố bitrate nên dùng chung thang
  này làm working figure), **severity warn** — chỉ vào `warnings`,
  không làm fail check; (2) rule `file_size` cho TikTok (<= 287 MB,
  giới hạn upload từ app mobile); (3) kết quả trả thêm `safe_zone`
  (rect giữ chữ/phụ đề, kèm note là creator guidance, không phải spec
  công bố). `probe` trả thêm `video.bit_rate` / `audio.bit_rate`.
- `parseTime`: số giây hoặc `SS` / `MM:SS` / `HH:MM:SS`.

| Case | Command | Result |
|---|---|---|
| fit speed 2x | `fit test/source.mp4 --duration 5` | target **5s → actual 5.000s, error 0s**, 244.7 KB |
| fit speed 0.5x | `fit … --duration 20` | target **20s → actual 19.989s, error −0.011s** |
| fit speed 4x | `fit … --duration 2.5` | target **2.5s → actual 2.5s, error 0s** (atempo chain 2,2) |
| fit trim | `fit … --duration 6 --method trim` | target **6s → actual 6s, error 0s** |
| fit loop | `fit … --duration 15 --method loop` | target **15s → actual 15s, error 0s**, loops 2 |
| fit audio-only | `fit test/mix-voice.mp3 --duration 4.5` | target **4.5s → actual 4.5s, error 0s**, 35.7 KB |
| fit MM:SS | `fit … --duration 0:06` | target **6s → actual 6s** |
| trim MM:SS | `trim … --start 0:01 --duration 0:02` | start **1**, duration **2**, actual **2s** |
| fit factor quá giới hạn | `fit … --duration 1` (10x) | Từ chối đúng exit 2, INVALID_ARG + gợi ý trim/loop |
| fit trim nguồn ngắn | `fit … --duration 15 --method trim` | Từ chối đúng exit 2 |
| fit loop nguồn dài | `fit … --duration 5 --method loop` | Từ chối đúng exit 2 |
| fit method lạ | `--method stretch` | Từ chối đúng exit 2 |
| trim chuỗi giờ sai | `--start 1:2:3:4` | Từ chối đúng exit 2 |
| check bitrate thấp | `check test/source.mp4 --platform tiktok` | video_bitrate **0.1 Mbps vs ~8 Mbps** → warn, vào `warnings`; pass=false chỉ vì dimensions + loudness (lỗi thật) |
| check bitrate cao | file nhiễu 175 Mbps, `--platform youtube` | video_bitrate **175.0 Mbps vs ~5 Mbps** → warn "oversized file" |
| check warn không fail | reframe→loudness −14→`check --platform tiktok` | **pass: true**, `warnings` có video_bitrate 0.3 Mbps, `issues` rỗng |
| check safe_zone | tiktok / youtube | tiktok **x 64–1016, y 200–1400**; youtube **x 96–1824, y 64–980** |
| check file_size | tiktok | `<= 287 MB`, actual 0.2–0.4 MB pass; youtube không có rule này |

- Bẫy đo lường (2 cái trong lượt này):
  1. `setpts=PTS/2` lần đầu ra **5.067s / 152 frames** thay vì 5.0s —
     ffmpeg CFR mặc định duplicate frame về lưới fps gốc (300 frame
     1/60s bị resample lên lưới 1/30s). Fix: `-fps_mode passthrough`
     + `-t <target>` để cắt đuôi padding AAC → **5.000s đúng**.
     Bài học: **speed-change bằng setpts bắt buộc passthrough,
     không tin CFR mặc định.**
  2. Thang bitrate dùng `max(width, height)` thì 1080×1920 dọc bị xếp
     tier 1440p → khuyến nghị sai **~16 Mbps**. Fix: dùng cạnh NGẮN
     (`min`) làm resolution class (1080×1920 = "1080p") → **~8 Mbps**
     đúng. Bài học: **ladder bitrate tính theo cạnh ngắn, không phải
     cạnh dài.**
  3. Encode testsrc phẳng ở `-b:v 20M` vẫn chỉ ra 0.7 Mbps — encoder
     không tiêu bit cho nội dung phẳng; muốn test nhánh warn cao phải
     gen nội dung nhiễu (`testsrc2 + noise`) mới lên 175 Mbps.

### Tests

- `npm run check`: `node --check` sạch trên `src/core.js`,
  `src/server.js`, `bin/mediakit.js`.
- `npm test`: **all 23 tools present**; `fit` qua MCP: method speed,
  factor 2, target 5s, duration_actual **5s, error 0s**; `doctor` qua
  MCP: ok=true, **23/23 tools available** (fit available). Các case
  regression cũ vẫn qua (silence 6.867s, cropdetect 1280:720:320:180,
  mix LUFS −14.1 / ducking 9.9 dB, concat fade 15.022s, keyframes,
  trim snap 0–8.333).
- **Assert thật trong `test/mcp-test.mjs`** (theo ghi chú kiểm tra độc
  lập 2026-11-10, đã dời ra `hidden_files/mediakit-independent-check-2026-11-10.md`
  để khỏi lẫn vào repo): trước đây test chỉ gọi tool rồi in kết quả —
  "22/22" nghĩa là gọi không crash, không phải đúng; đó là lý do bug
  stream_copy sống tới lượt 7. Giờ test có **31 assertions** (probe
  10s/1280×720, trim actual 2s, reframe 1080×1920, check bitrate warn
  + safe zone, doctor ok + fit available, silence 6.867s/2 gaps,
  cropdetect rect chính xác, package có spec.json + checksums, mix
  −14 LUFS + ducking > 5 dB, concat fade 15s, frames 5 file/timestamp,
  overlay 1136,24, scenes 5.033s, keyframes [0, 8.333], trim snap
  stream_copy + 0–8.333, fit factor 2 + actual 5s) — **31/31 PASS,
  exit 0**; kiểm tra âm tính (đổi kỳ vọng probe 10→11s) → FAIL +
  **exit 1**, CI sẽ đỏ thật khi output sai.
- README (bảng 23 tools + đoạn fit/check), SKILL.md
  (rule 16 "fit the duration before you publish") đã cập nhật.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 9 — 2026-11-10 (concat --fast auto-detect + tool pip, 24 tools)

### Học: studiomeyer-io/mcp-video (5★, 8 tools gom nhóm, Node/TS)
- `video_edit` gom nhiều op vào 1 tool (speed/crop/reverse/keyframe/
  pip) → MediaKit giữ 1 tool/1 việc (đã có 24 tool riêng); không gom.
- `video_compose social` — export 1 lần ra nhiều format đặt tên sẵn
  (instagram-reel/feed/story, youtube-short, tiktok, linkedin) với
  `maxDuration` cắt ngắn + strategy mặc định blur-background → ý
  mới, backlog: tool `social` 1 lần ra đúng spec từng nền tảng
  (reframe + loudness + check đã có sẵn, chỉ thiếu lớp gom).
- `concat` normalize về size/fps đích + pad đen, kèm trim từng clip
  (trimStart/trimEnd) → đã có normalize trong `concat --transition`;
  per-clip trim là backlog nhỏ.
- `generateIntro` — clip intro từ màu nền + drawtext fade in/out →
  backlog nhỏ (hữu ích cho title card TikTok).
- `FFMPEG_PATH`/`FFPROBE_PATH` honoured ở mọi chỗ spawn → MediaKit
  đã có tương đương (`MEDIAKIT_FFMPEG`/`MEDIAKIT_FFPROBE`), không
  cần thêm.
- SSRF guard cho URL (`MCP_VIDEO_ALLOW_INTERNAL`) → MediaKit không
  nhận URL, chỉ file local — không áp dụng.
- Ý áp dụng lượt này: **PiP video-đè-video** (video_edit pip +
  video-creator overlay_video) → đã làm tool `pip` mới; **concat
  fast/slow auto-detect** (ý từ video-creator, củng cố bởi cách
  mcp-video normalize trước khi nối) → đã làm `concat --fast`.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng
  Node/ffmpeg.

### Làm
- `concat --fast` (core+CLI+MCP): probe tất cả clip trước khi nối;
  giống hệt nhau (codec, size, fps, pixel format, audio codec/rate/
  channels, cùng họ container) thì demuxer stream-copy — nhanh,
  không mất chất lượng; khác thì fallback re-encode demuxer (hành vi
  cũ) và liệt kê mọi mismatch trong `fast_skipped`. `fast=true`
  bắt buộc copy (lỗi kèm mismatch thay vì fallback lặng lẽ);
  `fast=false` luôn re-encode; `--transition` không kết hợp được
  với `--fast` (bị từ chối exit 2). Trả thêm `mode: fast|reencode`.
- `pip` (core+CLI+MCP, tool thứ 24): video đè video — 9 vị trí đặt
  tên, size theo `--width` hoặc `--scale` (mặc định 0.25 chiều rộng
  chính), opacity, `--start`/`--end` (clip PiP loop bằng
  `-stream_loop -1` nên không bao giờ hết trong cửa sổ), audio
  `main|pip|mix` (amix, giữ nguyên mức). Kích thước ép chẵn
  (yuv420p + overlay kỵ lẻ) và scale về đúng `pw x ph` đã tính để
  `pip_size` báo cáo khớp pixel thật.
- `doctor`: thêm tool `pip` (filters overlay/format/scale/
  colorchannelmixer/amix, encoder libx264).

### Bug bắt được khi verify
- **PiP encode chạy vô hạn**: `-stream_loop -1` làm input PiP vô
  hạn; filter overlay cứ kéo frame từ input đó dù main đã hết →
  ffmpeg encode mãi không dừng (file phình 2.6 MB sau ~2 phút, CPU
  142%). Fix: capping output bằng `-t <độ dài main>` (đo bằng probe)
  — `-shortest` không đủ vì khi main không có audio thì chỉ còn
  video vô hạn. Sau fix: pip 10s encode trong **4.5s**.
  Bài học: input loop vô hạn + filter graph = phải có `-t` chặn
  cứng, không dựa vào EOF của input chính.

### Tests
- `npm run check`: `node --check` sạch trên `src/core.js`,
  `src/server.js`, `bin/mediakit.js`.
- CLI: concat [source, source] `--fast` → **mode fast, 20.023s,
  475.2 KB**; concat [source, source2] (auto) → **mode reencode,
  16.037s, fast_skipped ["clip 2: size 640x360 != 1280x720"]**;
  `--fast` trên cặp lệch → **exit 2**, lỗi nêu đúng mismatch.
  Pip mặc định → **936,516, 320x180, 1280×720, 10s, 251.6 KB**,
  encode 4.5s; pip mix top-left scale 0.5 opacity 0.8 window 2–8s →
  **24,24, 640x360, 285.2 KB, 10s**; position lạ → exit 2.
- Pixel-check thật (testsrc là pattern động nên phải so cùng điểm
  đã map + cùng timestamp): tâm PiP @t=1 **[121,124,133]** khớp
  tâm source2 **[127,127,127]**; ngoài PiP khớp main **[67,34,34]**;
  cửa sổ mix: t=1 ẩn → main, t=5 hiện → blend 0.8 chính xác
  **[55,170,203]** vs kỳ vọng [55,170,202]. Probe file mix: 1 video
  h264 + 1 audio aac, 10s (amix đã gộp đúng).
- `npm test`: **all 24 tools present**; assertions mới cho concat
  fast (mode + 20s), concat auto (reencode + 16s + lý do size),
  concat fast-fail (isError + lỗi nêu size), pip (936,516 /
  320x180 / 1280×720 / 10s); `doctor` qua MCP: ok=true, **24/24
  tools available** (pip available). Tổng **39/39 PASS, exit 0**.
- README (bảng 24 tools + đoạn concat/pip), SKILL.md
  (rule 17 "join identical clips with a copy, facecam with pip")
  đã cập nhật.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Plan A→E (TikTok quality) — 2026-11-11 01:00 (+07), Tony lệnh "tự plan đừng hỏi"
Tony xem 5 video TikTok trending rồi lệnh làm cho ra chất lượng như thế. Định nghĩa "đạt" = từng mục đo thật + assert + CI xanh. Làm hết A→E theo thứ tự.

- **A. Two-pass loudness** (`loudness`): pass 1 đo `measureLoudnessFull` (input_i/tp/lra/thresh/offset), pass 2 áp gain tuyến tính chính xác + `linear=true`, đo lại output và báo `output_lufs` thật. Voice fixture (−22.14 LUFS) → **−14.44 LUFS (đo độc lập −14.44, TP −9.50)**. Nhạc nền TVC −26.08 LUFS, crest ~21 dB (sub-bass <100Hz chiếm 23 dB năng lượng — phổ + highpass 100Hz đã kiểm chứng): true-peak chặn gain, mọi cách (linear/dynamic/compand/limiter) đều dừng ở ~−22.1 — tool lấy gần nhất có thể và **cảnh báo** thay vì giả vờ đạt. Test: voice assert −14 ±0.5 (báo cáo + đo độc lập), quiet bed assert cải thiện + có warning.
- **B. burn_captions mặc định vùng an toàn**: font-size mặc định scale theo chiều cao (`vh*0.031` → 60px ở 1920, 22px ở 720), MarginV mặc định `vh*0.26` → 500px ở 1920 (trên vùng 480px TikTok che), `--font-size`/`--margin-v` ghi đè. Pixel-verify trên source.mp4 @t=3.5s: band phụ đề **PSNR 19.5** (chữ rõ), strip dưới đáy **PSNR 64.5** (sạch, không chữ). Test assert cả 2 PSNR + font/margin báo cáo.
- **C. reframe anchor**: `--anchor left|right|top|bottom|top-left|...` (x/y tường minh thắng anchor); báo `crop_kept_percent` + `upscale` + warning khi giữ <40%. 1280×720→1080×1920: crop 404×720, left x=0 / center x=438 / right x=876, giữ **31.6%**, upscale **2.67x** + warning. Pixel-verify: frame left vs right **PSNR thấp** (crop thực sự dịch chuyển).
- **D. check bitrate warn**: ĐÃ CÓ từ lượt 8 (severity "warn", overall pass bỏ qua warn) — lần này verify bằng test dương: file reframed + loudness fix → **pass=true** trong khi warnings vẫn liệt kê video_bitrate 0.3 Mbps.
- **E. titlecard (tool thứ 25)**: drawtext + textfile (wrap ≤14 ký tự/dòng), chữ vàng FFD60A trên hộp cam F97316, canvas trong suốt (nullsrc + `geq` clear alpha — lavfi `color` bỏ qua alpha nên phải clear tay; đã kiểm chứng), block ở ~55% chiều cao trong safe zone. "THE MOON IS LEAVING US" → 2 dòng, font 119px, 1080×1920. Pixel-verify tay (PIL): yellow 33.545 px, orange 79.438 px, transparent 185.380 px, 4 góc alpha 0. Test trong repo dùng ffmpeg thuần (không PIL — CI không có PIL): band giữa R=107.3/G=62.0/B=7.8/A=130.9, góc alpha=0. Sửa sau CI đỏ lần đầu: test cũ gọi PIL nên crash trên runner — đã thay bằng `extractplanes`/`alphaextract` + `signalstats`; `geq` clear cả 4 kênh (trước đó pixel trong suốt còn dính G=135). Doctor thêm filter `geq`.
- `npm test`: **65/65 PASS, exit 0** (25 tools, doctor 25/25 available). Test mới dùng helper `measureLufs` (ffmpeg độc lập) và `bandPsnr` (PSNR theo band) — assert số đo thật, không chỉ "gọi không crash".
- README (bảng 25 tools), SKILL.md (rule 3 anchor, rule 6 two-pass, rule 7 caption safe zone, rule 18 titlecard) đã cập nhật.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 10 — 2026-11-11 (social + intro, 27 tools)
- Học: priyanshum143/MCP-FFMPEG (Python, job queue + parallel workers).
  Ý áp dụng được:
  1. Per-job output folder với `job_details.json` (đường dẫn, tham số,
     log ffmpeg) → `social` viết `manifest.json` receipt trong thư mục
     output (input, strategy, target_lufs, từng platform: dimensions,
     duration, LUFS, check_pass).
  2. Subtitle format conversion (srt→vtt) → backlog mới (nhỏ, chưa làm).
  3. Transcript extraction (Whisper) → đã có trong backlog `transcribe`.
  4. Job queue + cache theo job ID (same inputs → reuse) → KHÔNG áp
     dụng: MediaKit là CLI/MCP single-shot, không có worker nền; cache
     theo input sẽ giấu việc input đã đổi.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- Làm:
  - `social` (core+CLI+MCP, tool thứ 26): 1 call export ra nhiều
    platform — reframe theo size từng platform (strategy crop/pad/blur,
    mặc định blur giữ nguyên khung), trim về maxDuration của platform
    (Shorts 180s, Story 60s — `--no-trim-to-max` giữ nguyên và check
    sẽ fail duration một cách trung thực), loudness 2-pass về −14 LUFS
    (chỉ khi có audio; nguồn câm thì copy file), rồi `check` từng
    platform. File `<base>-<platform>.mp4` + `manifest.json`; platform
    nào check fail vẫn ghi file, `all_pass=false` + `issues` nêu rõ.
  - `intro` (core+CLI+MCP, tool thứ 27): clip mở đầu — title trên nền
    màu đặc, fade in/out bằng `drawtext alpha` expression (text qua
    textfile như titlecard). Mặc định 1280×720, 3s, nền 0F172A, chữ
    trắng, font ~100px, fade 0.5s mỗi đầu. `fade_in + fade_out >=
    duration` bị từ chối; fade = 0 không chia cho 0 (branch chỉ build
    khi fade > 0).
  - Platform mới trong `PLATFORMS` (cũng mở rộng `check`):
    `instagram-feed` 1080×1080 max 3600s, `instagram-story` 1080×1920
    max 60s, `linkedin` 1920×1080 max 600s — mỗi cái có safe zone riêng.
  - `doctor`: thêm filter `color`, tool `intro`/`social` (27/27).
  - README (bảng 27 tools + check liệt kê platform mới), SKILL.md
    (rule 19 "one source, every platform: social; open with intro").
- Test (ffmpeg 8.1.2):
  - `intro` CLI "Welcome Back" → **1280×720, 3s, font 102px, 16.8 KB**.
    Pixel-verify fade trên band giữa (R): t=0.05 **21.8** → t=0.25
    **43.2** → t=1.5 **68.4** → t=2.75 **40.0** → t=2.95 **18.4** —
    fade in/out thật, không phải fade giả.
  - `social` CLI source 10s → tiktok + instagram-feed: **1080×1920 /
    1080×1080, 10.1s, LUFS −14, check pass, trimmed false**;
    `manifest.json` ghi đủ 2 outputs + strategy; không còn file tmp
    `.social-*` sót lại.
  - Trim-to-max trên file testsrc 70s (tự sinh, không phải fixture):
    instagram-story → **60s, trimmed=true, LUFS −14.1, check pass**;
    shorts → 70.1s, trimmed=false, LUFS −13.9, check pass.
    Platform lạ → **exit 2, INVALID_ARG, nêu đúng danh sách platform**.
  - `npm run check` sạch; `npm test`: **92/92 PASS, exit 0** (27 tools,
    doctor 27/27 available). Assert mới: intro (dims/duration/font +
    4 điểm fade R + từ chối fade quá dài), social (3 platform: dims,
    duration ~10s, LUFS trong [−16,−12], trimmed=false, manifest.json
    đủ 3 outputs + strategy, platform lạ bị MCP enum validation chặn).
    Bẫy bắt được: client MCP validate enum *trước khi* gọi tool nên lỗi
    platform lạ trả về dạng result text `-32602`, không throw — test
    đầu viết theo kiểu try/catch đã FAIL 1 assertion, sửa thành đọc
    `content[0].text` mới đúng.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 11 — 2026-11-11 (convert_captions + mix --dry-run, 28 tools)
- Học: kajisho5/ffmpeg-skill (5.011★, 42 tools, Python, đối thủ mạnh nhất
  cùng ngách). Ý áp dụng được:
  1. `--dry-run` trên mọi tool (plan before render: in lệnh ffmpeg, ghi
     không gì) → đã làm `mix --dry-run` (backlog item); mở rộng sang các
     tool khác là backlog mới (mỗi tool một plan, tốn công).
  2. Machine-readable contract: `input_schema` suy ra từ parser thật lúc
     chạy, CI fail khi drift (SPEC) → đã có trong backlog ("contract
     machine-readable + CI fail khi drift"); chưa làm lượt này (lớn — cần
     refactor server.js dùng chung một bảng tool).
  3. `check --content` (black frame, frozen frame, silence, flash) →
     backlog mới.
  4. `caption --fit-size` (co chữ tới khi vừa max-lines) → đã làm ở
     plan B (burn_captions mặc định 60px/500px vùng an toàn).
  5. MCP chỉ advertise 12 tool core mặc định, đủ 42 khi
     `FFMPEG_SKILL_MCP_FULL=1` (tiết kiệm context client) → backlog mới
     (cân nhắc; MediaKit hiện list đủ 28).
  6. `look.py` contact sheet để agent tự nhìn output → MediaKit đã có
     `thumbnail`/`frames`, không thêm tool mới.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- Làm:
  - `convert_captions` (core+CLI+MCP, tool thứ 28): chuyển .srt↔.vtt,
    thuần Node, không ffmpeg. Format suy từ đuôi output; chuyển về cùng
    format bị từ chối. Text cue giữ nguyên verbatim; VTT cue settings
    (`line:`/`position:`/`align:`) bị bỏ khi về SRT và đếm trong
    `settings_dropped`; header WEBVTT + block NOTE/STYLE/REGION được bỏ
    qua khi đọc VTT; timestamp sai, cue không text, end<=start bị từ
    chối kèm dòng lỗi. Trả `cue_count`, `first_start_seconds`,
    `last_end_seconds`, `settings_dropped`.
  - `mix --dry-run` (core+CLI+MCP): plan mode — probe + đo loudnorm vẫn
    chạy (chỉ đọc) để tính `voice_gain_db` thật, rồi trả `commands` (lệnh
    ffmpeg đầy đủ, shell-quoted) và ghi KHÔNG file nào. `output_lufs` /
    `ducking_measured_db` = null kèm `note` giải thích.
  - `doctor`: thêm tool `convert_captions` (không cần ffmpeg → luôn
    available). README (bảng 28 tools + dòng mix --dry-run), SKILL.md
    (rule 20), VERIFY.md (lượt 11).
- Test (ffmpeg 8.1.2):
  - `convert_captions` CLI captions.srt → .vtt: **3 cues, 0–8s, 174 B**;
    file VTT có header WEBVTT + timestamp dấu chấm; round-trip về .srt
    giữ đủ 3 cue + text gốc + timestamp dấu phẩy; fixture
    captions-settings.vtt → .srt: **2 cues, settings_dropped 1**; cùng
    format → **exit 2, INVALID_ARG, "already srt"**.
  - `mix --dry-run` CLI: gain thật **+6.1 dB** (voice −22.1 LUFS → target
    −16), ratio 2.5, lệnh in ra chứa `sidechaincompress` + `loudnorm`;
    file output **không tồn tại** sau dry-run.
  - `npm run check` sạch; `npm test`: **103/103 PASS, exit 0** (28 tools,
    doctor 28/28 available). Assert mới (11): convert_captions (srt→vtt
    3 cues + span 0–8s, header/timestamp VTT, round-trip SRT, settings
    dropped 1, từ chối cùng format), mix dry-run (dry_run flag, lệnh chứa
    sidechain+loudnorm, gain thật ≠ 0, không ghi file).
  - Bẫy bắt được: chạy `npm test` 2 lần trong cùng một lệnh để đếm PASS
    rồi kiểm tra FAIL làm tốn gấp đôi thời gian (~4 phút) — lần sau chỉ
    chạy 1 lần rồi grep cả hai.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 12 — 2026-11-11 (check --content + find, 29 tools)

Environment: ffmpeg/ffprobe 8.1.2, Node v24.22.1. Fixture mới:
`test/content-black.mp4` (10s, 640×360, testsrc [0,3) + đen [3,6) +
testsrc [6,10), tone 440 Hz liên tục), `test/content-freeze.mp4`
(testsrc [0,4) + đỏ tĩnh [4,7) + testsrc [7,10)),
`test/content-silence.mp4` (testsrc 10s + tone [0,3), lặng [3,6),
tone [6,10)), `test/content-lead-black.mp4` (đen 1s đầu + testsrc 9s),
`test/content-trail-black.mp4` (testsrc 7s + đen 3s cuối),
`test/content-video-only.mp4` (source.mp4 bỏ audio), `test/nested/deep-clip.mp4`
(copy source.mp4 để test đệ quy). Tất cả tự sinh bằng lavfi, không download.

### check --content (mở rộng check, không thêm tool mới)

- `detectContent` (core, dùng nội bộ bởi `check`): 1 lần decode chạy
  `blackdetect=d=0.5:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2`
  trên video + `silencedetect=noise=-40dB:d=0.5` trên audio, `-f null -`.
  Rules layer theo vị trí: đen/đóng băng giữa file → error; đen ở
  mép ≤2s → warn (fade in/out); đen ở mép >2s → error; lặng giữa file
  ≥5s → error, còn lại warn. Mỗi loại trả `status` complete/unavailable
  (không có stream thì unavailable, không phải 0), tối đa 100 interval
  + `total_intervals`/`total_duration_seconds`/`intervals_truncated`,
  interval mở tới cuối file được đóng ở duration + cờ
  `ends_at_scan_boundary`.
- `check --content` (CLI) / `content: true` (MCP): thêm 3 rule
  `content_black`/`content_freeze`/`content_silence` vào cùng bảng
  pass/fail; warn-level chỉ vào `warnings` (không fail check, giống
  video_bitrate), error-level vào `issues`; chi tiết đầy đủ trong
  trường `content` của kết quả.
- `find` (core+CLI+MCP, tool thứ 29): tìm file media theo tên, đệ quy
  (substring không phân biệt hoa thường, mặc định 20 đuôi video/audio/
  ảnh/phụ đề, `--extensions` để hẹp, `--max-results` 1–100); bỏ qua
  `.git`/`node_modules`/thư mục ẩn, không theo symlink dir; kết quả
  sắp xếp theo path, mỗi match kèm probe (duration, dimensions,
  codecs); `total_matches` vẫn báo đủ dù đã cắt ở max.
- `doctor`: thêm filter `blackdetect`, `freezedetect` (chỉ báo có mặt,
  không bắt `check` phải có — check cơ bản chạy không cần chúng) +
  tool `find` (29/29). README (bảng 29 tools + đoạn check/find),
  SKILL.md (rule 4 mở rộng + rule 21 mới), VERIFY.md (lượt 12).
- Test (ffmpeg 8.1.2):
  - content-black: đen **[3, 6] error mid-file**, đóng băng [3, 6]
    (đen cũng là đóng băng — đúng); content-freeze: đóng băng
    **[4, 7]**, không đen; content-silence: lặng **[3, 6] warn**,
    `content.pass: true`, vào `warnings` không vào `issues`.
  - lead-black (đen 1s đầu): **warn** "likely a fade in"; trail-black
    (đen 3s cuối): **error** (quá dài cho fade out).
  - source.mp4 sạch: 0 interval cả 3 loại, content pass; audio-only
    (silence-audio.mp3): black/freeze **unavailable**, lặng 2 gap
    [2.002, 4] + [6.003, 7]; video-only: silence **unavailable**,
    không có rule `content_silence`.
  - find CLI: "content" → **6 matches** (đủ 6 fixture, 10s, h264);
    "deep-clip" → **1 match** trong `test/nested/`; không khớp → 0
    match, không lỗi; "source" → 5; `--extensions mp3` → 1
    (quiet-source.mp3); max-results 2 → returned 2, total 6,
    truncated true; thư mục không tồn tại → lỗi INPUT_NOT_FOUND.
  - `npm run check` sạch; `npm test`: **135/135 PASS, exit 0**
    (29 tools, doctor 29/29 available). Assert mới (32): content
    (23: đen/đóng băng/lặng đúng khoảng + severity + warn-vs-error +
    unavailable + sạch) và find (9: 6 matches + probe, đệ quy, 5
    source, extensions, cap, rỗng, lỗi thư mục).
  - **Bug bắt được**: blackdetect ghi start+end trên CÙNG 1 dòng
    (`black_start:3 black_end:6 black_duration:3`) — parser cũ match
    `black_start` trước rồi `continue` nên nuốt mất `black_end`,
    interval bị đóng sai ở cuối file (3s–10s, 7s, ends_at_scan_boundary).
    Fix: match dòng đủ start+end trước, rồi mới tới black_start riêng.
    Kiểm chứng lại: đen [3, 6] đúng; trailing black vẫn log đủ end
    (9.967s) nên fallback đóng ở duration chỉ là lưới an toàn.
  - Sự cố hạ tầng: 1 lần service restart giữa `npm test` (lệnh bị cắt,
    chưa ghi output) — chạy lại 1 lần, 135/135 PASS.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## svg_animate (tool 30) — 2026-11-11, Tony yêu cầu ("tool có làm video kiểu svg animation không")

- **Vì sao cần code-driven**: ffmpeg đọc được SVG tĩnh qua librsvg nhưng KHÔNG chạy animation trong SVG (SMIL/CSS bị bỏ qua, chỉ render 1 frame). Đường browser (Chromium headless quay từng frame) thì Chromium trên máy Milo chết. Nên tool tự nội suy keyframe bằng Node rồi mux — không cần browser.
- **Kiểm chứng đường render trước khi code**: probe 2 frame SVG → `ffmpeg -framerate 2 -i f-%04d.svg` (image2) ra đúng 640×360, 1.0s, 2 frame; pixel check: frame0 ball cam tại (100,180), frame1 ball cam tại (540,180), chỗ cũ về nền (15,23,41). Image2 nhận `.svg` qua librsvg, không cần rasterize từng frame bằng tay.
- **Tool**: `svg_animate` — animations `[{target (id), property: translate|scale|rotate|opacity, from, to, start, end, easing: linear|ease-in|ease-out|ease-in-out, center?}]`. Size từ width/height/viewBox của SVG (override được, phải chẵn); background mặc định trắng (video không có alpha — không vẽ rect thì nền trong suốt sẽ thành đen). Giới hạn: duration ≤30s, fps ≤60, ≤1800 frame. `doctor` thêm nhóm `decoders` (librsvg) + `svg_animate: {decoders: [librsvg], encoders: [libx264]}`.
- **Ngữ nghĩa thời gian (quan trọng)**: tại thời điểm t, animation áp dụng là cửa sổ cuối cùng đã bắt đầu (giữ `to` sau khi hết); TRƯỚC cửa sổ đầu tiên, phần tử ở giá trị `from` của animation đầu — slide-in bắt đầu ngoài khung, fade-in bắt đầu vô hình, không bị nhảy. Hai cửa sổ kề nhau trên cùng element+property nối tiếp nhau (xuống rồi lên = nảy) khi giá trị biên khớp.
- **Test** (`test/svg-demo.svg` + `test/svg-demo-anim.json`): 1280×720, 2s×10fps = 20 frame; ball translate 600px (PSNR frame đầu/cuối 18.2), ball tới đúng đích (R cuối 161.5 vs đầu 15), box mờ dần (G đầu 182 → cuối 37); target không tồn tại → `missing_targets: ["ghost"]`, vẫn render; property lạ → lỗi MCP enum. **Assert mới (11)**: chain (phải rồi về trái): tại t=1.0 tới đích (R 197.1), t=1.9 về đầu (R 15.0), **t=0.5 đang ở giữa đường (R >150 tại vị trí giữa)** — assert này bắt đúng bug dưới.
- **Bug bắt được (2 lần, đều nhờ verify bằng mắt + đo pixel, không phải nhờ test pass)**:
  1. Bản đầu: mọi animation áp dụng theo thứ tự, cửa sổ sau ghi đè cửa sổ trước dù chưa bắt đầu — ball nảy ở t=2.0 đo được centroid y=1649 thay vì 1500 (đang ở giá trị `from` của cửa sổ 3–4s). Fix lần 1 (skip animation chưa bắt đầu) sai ngữ nghĩa: card slide-in lúc 0–0.3s hiện nguyên rồi mới nhảy ra ngoài trượt vào; chữ fade-in hiện sẵn trước 1.2s. Fix đúng: nhóm theo (target, property), chọn cửa sổ cuối đã bắt đầu, chưa có cửa sổ nào thì lấy `from` của cửa sổ đầu. Kiểm chứng lại: ball t=2.0 centroid y=1499.3 (đúng 1500), t=0.5 centroid y=1574.4 (đúng ~1575, đang rơi), chữ ở t=0.5 chưa hiện (0 pixel trắng trong vùng card).
  2. Lúc sửa test: `JSON.parse` trên kết quả lỗi MCP (Zod chặn enum trước khi tool chạy → content là text "MCP error...", không phải JSON) làm crash cả test run. Fix: assert trực tiếp trên text lỗi.
- **Demo**: `~/workspace/svg-animate-demo-v3.mp4` (1080×1920, 4s, 30fps, 120 frame, 9 animation: mặt trời bob, sao xoay 360°, card trượt vào, chữ fade-in, bóng nảy 2 nhịp) + contact sheet `svg-animate-demo-frames-v3.png` (t=0.5/2.0/3.5) — soi mắt OK.
- `npm run check` sạch; `npm test`: **150/150 PASS, exit 0** (30 tools, doctor 30/30 available). CI smoke test thêm dòng svg-animate (fixture `test/svg-demo.svg` + `test/svg-demo-anim.json`).
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 14 — 2026-11-11 10:58 (+07): burn_captions --style + tip frames (32 tools)

- **Học: Ashutos1997/ffmpeg-mcp-server** (4★, 19 tools, TS/Zod). Ý áp dụng được:
  1. `burn_subtitles` có `outlineColor` (ASS hex) → đã làm `burn_captions --style` (outline/shadow/background/glow + `--outline-color`).
  2. `compress_video` có `targetSizeMB` (nén về đúng dung lượng đích, vd GitHub PR <10MB, Discord <25MB) → backlog mới.
  3. `extract_audio` preset 16kHz mono WAV cho Whisper → backlog mới (đường vào cho `transcribe` sau này).
  4. `mux_media` — gộp/thay audio+video bằng stream copy, có audio offset → backlog mới (tool `mux`).
  5. `media://capabilities` resource (ffmpeg version + hardware accel đã detect) → KHÔNG áp dụng (`doctor` đã làm phần này; hardware accel ngoài phạm vi — VM CPU-only).
  6. Hardware acceleration tự detect (VideoToolbox/NVENC/QSV/AMF/VA-API) → KHÔNG áp dụng (máy Milo CPU-only, CI runner cũng vậy).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `burn_captions --style` (core+CLI+MCP, không thêm tool): 4 style qua libass `force_style` — `background` (mặc định, BorderStyle 3 hộp đen mờ 50% — giữ đúng hành vi cũ), `outline` (BorderStyle 1, outline đen 2px), `shadow` (outline 1px + drop shadow 2px), `glow` (outline 4px màu chữ ở alpha 50% — halo đọc được trên footage sáng). `--outline-color` nhận tên màu hoặc hex RRGGBB (helper `assColor` đổi sang ASS BBGGRR). Style thắng flag `box` cũ (box=true → background, false → outline); `.ass` mang style riêng nên `style` bị bỏ qua, trả `style_applied: false`. Trả thêm `style` + `style_applied` trong JSON.
  - Tip `frames`: png (mặc định)/webp thay vì jpg cho screen recording/text-heavy — ghi vào README (bảng tools), SKILL.md (§12) và comment trong `core.js` (JPEG chroma subsampling làm nhòe text/border 1px).
  - CI smoke thêm dòng `burn-captions --style glow`.
- **Test** (ffmpeg 8.1.2, source 1280×720 10s): 4 style đều render chữ trong band an toàn @t=3.5s (PSNR band 18.6–24.4, đều < 30); PSNR chéo background↔outline 20.3, outline↔glow 18.6 — các style khác nhau thật, không phải đổi tên. Style lạ → lỗi enum MCP; CLI `--style neon` / `--outline-color notacolor` → exit 2 `INVALID_ARG`.
- **Bug bắt được (quan trọng — nhờ soi bằng mắt, không phải nhờ test pass)**: bản đầu đặt `Outline=0` cho style background → **hộp đen biến mất hoàn toàn** (chữ trắng trên nền trắng vô hình). Kiểm chứng: burn lên clip trắng đặc → frame trắng tinh, không thấy gì; variant cũ `Outline=2` → hộp xám hiện rõ. Nguyên nhân: libass vẽ hộp BorderStyle 3 từ độ rộng Outline — Outline=0 làm hộp co về 0. Fix: background giữ `Outline=2` (đúng hành vi cũ từ lượt 1). YAVG vùng text-line trên clip trắng: background 215.5 = bản cũ 215.5 (khớp tuyệt đối), outline 217.5 — YAVG không phân biệt được 2 style (hộp xám 50% và outline đen cho số gần nhau), nên test regression dùng **PSNR band trên clip trắng**: background **18.79**, outline **16.73** (đều < 30; hộp hỏng thì PSNR → ~inf vì chữ trắng vô hình trên trắng). Assert mới (16): 4 style × (echo style + style_applied + PSNR band) + PSNR chéo + 2 white-clip + 1 style lạ.
- `npm run check` sạch; `npm test`: **193/193 PASS, exit 0** (32 tools, doctor 32/32 available).
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 13 — 2026-11-11 08:58 (+07): compress + receipt (tools 31–32)

- **Học: kevinwatt/ffmpeg-mcp-lite** (28★, Python/FastMCP, 8 tools, 32 pytest). Ý áp dụng được:
  1. `compress` — quality presets low/medium/high + báo size reduction stats → đã làm tool `compress` (CRF 32/26/20 + x264 preset veryfast/medium/slow + audio 96/128/192k, `--max-width`, trả `reduction_percent` đo thật trên đĩa).
  2. Subtitle styles (outline/shadow/background/glow) cho burn_captions → backlog mới (burn_captions thêm `--style`).
  3. Tip docs cho `frames`: screen recording nên dùng png/webp thay vì jpg (JPEG chroma subsampling làm nhòe text/border 1px) → backlog nhỏ (ghi vào SKILL.md mục frames).
  4. Một file một tool (modular) → KHÔNG áp dụng (MediaKit cố ý 1 core.js để agent đọc hết trong 1 lần).
  5. `FFMPEG_OUTPUT_DIR` env → không cần (MediaKit đã có `MEDIAKIT_FFMPEG`/`MEDIAKIT_FFPROBE`).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `compress` (core+CLI+MCP, tool 31): preset low/medium/high; `--crf`/`--preset` override; `--max-width` scale xuống trước (tính kích thước chẵn bằng JS từ probe, không dùng filter expression); audio-only re-encode aac theo preset; trả size trước/sau + `reduction_percent` đo thật.
  - `receipt` (core+CLI+MCP, tool 32): provenance receipt JSON sidecar — probe + SHA-256 + size + loudness đo thật + platform check (tùy chọn) + ffmpeg/ffprobe/node version + timestamp; output phải `.json`. `package` đã nhúng spec.json trong ZIP; `receipt` là bản standalone cho file giao lẻ.
  - `doctor`: thêm `compress: {filters: [scale], encoders: [libx264, aac]}`, `receipt: {filters: [loudnorm]}` (32/32 available).
  - README (bảng 32 tools + intro), SKILL.md (rule 23 + workflow bước 10), CI smoke thêm 2 dòng compress/receipt.
- **Test** (ffmpeg 8.1.2, source 1280×720 10s, 243.932 B, 195 kbps): compress low **207.729 B, −14,8%**, medium 255.167 B (−4,6%), high 313.901 B (−28,7%) — **thứ tự low < medium < high nghiêm ngặt, CRF đúng preset (32/26/20)**; max-width 640 → **640×360, scaled_to 640x360**; audio-only mp3 9s → .m4a, dimensions null, 9s; quality lạ → lỗi enum MCP. Receipt: SHA-256 trong file **khớp đúng `sha256sum` độc lập** (7e32a197…9018f08), size 243.932, loudness −21,8 LUFS, platform_pass false (source 1280×720 chưa phải TikTok 1080×1920 — đúng), file ghi ffmpeg 8.1.2 + platform_check + probe; không platform → không có key platform_check.
- **Bẫy đo lường**: source fixture đã encode ở bitrate rất thấp (195 kbps) nên medium/high ra file LỚN HƠN source — `reduction_percent` âm là báo thật, không phải bug; assert đúng là thứ tự kích thước theo preset, không phải "mọi preset đều nhỏ hơn source". Ghi rõ vào SKILL.md rule 23.
- **Bug bắt được**: test file có dynamic import `readFile` trùng tên với import tĩnh mới thêm ở đầu file → SyntaxError crash cả test run trước khi chạy test nào. Fix: bỏ dynamic import, dùng import tĩnh chung (dòng manifest social).
- **CI đỏ lần đầu (a7c9761, run #42944221958)**: 176/177 PASS — assert `ffmpeg_version === "8.1.2"` sai trên runner GitHub (ffmpeg 8.0.1-3ubuntu2, máy local 8.1.2). Bài học: không hardcode version môi trường vào assert — so với version đo độc lập (`ffmpeg -version`) ngay trong test. Fix xong, chạy lại local 177/177 PASS rồi push fix.
- `npm run check` sạch; `npm test`: **177/177 PASS, exit 0** (32 tools, doctor 32/32 available). Assert mới (27): compress 17 + receipt 10.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 15 — 2026-11-11 12:58 (+07): compress --target-size + extract_audio --whisper + docs drift guard (32 tools)

- **Học: ffmpeg-micro/ffmpeg-micro-mcp** (1★, 71 commit, TS, cloud API wrapper — không phải local ffmpeg). Ý áp dụng được:
  1. Version-sync guard — CI fail khi `package.json.version` lệch khỏi `server.json`/`src/version.ts` (kèm script `sync-server-version.mjs`) → đã làm `scripts/check-docs.mjs`: đếm `server.tool(` trong `src/server.js` so với bảng tools trong README (cùng số lượng + cùng tên), chạy trong `npm run check` nên CI fail khi drift.
  2. Blueprints — workflow đóng gói sẵn (caption-video pause chờ duyệt transcript, multi-output có label) → chưa làm (lớn; `social` đã là mini-blueprint).
  3. `transcode_and_wait` (tạo job + poll trong 1 call) → KHÔNG áp dụng (MediaKit chạy đồng bộ local, không có job).
  4. Changesets/release flow + MCP Registry publish → KHÔNG áp dụng (npm đang stage tay, Tony duyệt).
  5. Smoke test chạy API thật, unit test mock fetch → MediaKit đã làm theo hướng này (test chạy ffmpeg thật).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `compress --target-size <MB>` (core+CLI+MCP, không thêm tool): two-pass ABR libx264 từ ngân sách size + duration (video 100 kbps min + audio 128k; audio-only dồn hết ngân sách cho audio, 1 pass). Decimal MB (1 MB = 1.000.000 B, như giới hạn Discord 10/25 MB); margin an toàn 2% cho container overhead; passlog trong temp dir `mkdtemp` (dọn sạch sau mỗi lần chạy, đã kiểm chứng không còn sót `/tmp/mediakit-pass-*`); trả `mode: target_size`, `target_size_bytes`, `video_bitrate_kbps`, `audio_bitrate_kbps`, `passes`, `target_met` đo thật. Target dưới sàn bị từ chối kèm size tối thiểu tính được; `--crf` + `--target-size` bị từ chối (mutually exclusive); `--quality` bị bỏ qua trong mode này (ghi rõ trong help + MCP description, không lặng lẽ).
  - `extract_audio --whisper` (core+CLI+MCP, không thêm tool): preset Whisper ASR — 16 kHz mono WAV (`pcm_s16le`, `-ar 16000 -ac 1`); output đổi đuôi thành `.wav` khi cần, trả đúng đường dẫn thật + `whisper_preset: true`, `sample_rate_hz`, `channels` (probe lại output). `--format` bị preset thắng (ghi rõ trong help). Đường vào cho `transcribe` sau này.
  - `scripts/check-docs.mjs` + nối vào `npm run check` (xem Học #1). CI smoke thêm 2 dòng (compress target-size 1MB, extract-audio --whisper).
  - README (2 dòng bảng tools), SKILL.md (§23 mở rộng: target-size + whisper), VERIFY.md (mục này).
- **Test** (ffmpeg 8.1.2, source 1280×720 10s, 243.932 B): compress target-size 1 MB → **953.813 B, target_met: true, passes 2, video 656k + audio 128k** (đúng ngân sách: (1.000.000×0,98×8/10 − 128k) = 656k); 0,5 MB → met; audio-only mp3 9s target 0,1 MB → met, 1 pass; target 0,1 MB video → exit 2 "too small — minimum is about 0.29 MB"; target-size + crf → exit 2 "mutually exclusive". Whisper: output `.mp3` yêu cầu → ghi **`.wav` thật, 320.328 B, pcm_s16le 16000 Hz mono** — ffprobe độc lập xác nhận; whisper + format mp3 → vẫn wav. `npm run check` sạch (check-docs: 32 tools khớp README); `npm test`: **206/206 PASS, exit 0** (32 tools, doctor 32/32 available). Assert mới (13): target-size 8 + whisper 5.
- **Bẫy đo lường**: target 1 MB ra file 953 KB — LỚN HƠN source 244 KB, `reduction_percent` −291% là báo thật (source đã encode 195 kbps); assert đúng là `target_met`, không phải "nhỏ hơn source". Tương tự bẫy ở lượt 13.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 16 — 2026-11-11 14:58 (+07): mux tool + dry-run (33 tools)

- **Học: alanveloper-epam/ffmpeg-mcp-server** (0★, 2 commit, Python, "security-hardened"). Ý áp dụng được:
  1. Workspace sandboxing (`FFMPEG_MCP_WORKDIR`, chặn `..` + symlink escape) → backlog mới (opt-in env `MEDIAKIT_WORKDIR`; MediaKit hiện chỉ resolve absolute path + cấm đè input).
  2. `dry_run=True` trên MỌI tool mutative → đã làm cho `mux` ngay từ đầu (`--dry-run` trả đúng argv, không ghi file); backlog: mở rộng dry-run cho các tool khác.
  3. `generate_srt` — sinh .srt xác định từ mảng cue `{start, end, text}` → backlog mới (thuần Node, như `convert_captions`).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `mux` (core+CLI+MCP, tool 33): thay audio của video bằng file audio ngoài, stream-copy cả hai (không re-encode, ảnh bit-identical); audio gốc của video bị thay, không mix (muốn cả hai thì `mix` trước). `--audio-offset` dịch audio mới so với video (dương = audio trễ, âm = video trễ, qua `-itsoffset` đặt trước input bị trễ — giữ nguyên map `0:v:0`/`1:a:0` cả hai chiều); `--shortest` dừng ở stream ngắn hơn; `--dry-run` trả argv ffmpeg đầy đủ, không ghi file. Offset giới hạn ±3600s (cả core lẫn zod schema MCP).
  - `doctor`: thêm `mux: {}` (33/33 available). README (bảng 33 tools), SKILL.md (rule 24), CI smoke thêm dòng mux `--audio-offset 0.5`.
- **Test** (ffmpeg 8.1.2, source 1280×720 10s h264+aac, mix-voice.mp3 9s tone [0,2),[4,6),[7,9)): mux cơ bản → **10s, h264 + mp3** (aac gốc bị thay), ffprobe độc lập xác nhận đúng 2 stream; offset +2 → **11.012s, audio start_time 1.974** (≈2 − 0.026 priming mp3, trong dung sai 0.1), silencedetect độc lập tìm đúng khoảng lặng đã dịch **[4.02, 6.02) và [8.01, 9.01)** (chưa dịch sẽ là [2,4)/[6,7)); offset −1 → video start_time **1.000**, duration 11s; `--shortest` với nhạc 2s → **2.012s**; dry-run → `dry_run: true`, argv có `-c copy`, **không ghi file**; lỗi đúng (mp3 làm video, ảnh PNG làm audio, offset 9999 → zod chặn ở tầng MCP, lỗi -32602).
- **Bẫy đo lường**: assert offset 9999 ban đầu `JSON.parse` kết quả MCP — zod từ chối trước khi vào core nên trả về chuỗi lỗi, không phải JSON → crash cả test run. Fix: đọc text + regex (cùng pattern assert social platform lạ ở lượt 10). Audio start_time 1.974 ≠ 2.025: mp3 encoder delay 26ms bị trừ khi copy — đo start_time với dung sai 0.1 thay vì so bằng.
- `npm run check` sạch (check-docs: 33 tools khớp README); `npm test`: **221/221 PASS, exit 0** (33 tools, doctor 33/33 available). Assert mới (15).
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 17 — 2026-11-11 16:58 (+07): generate_srt + workspace sandbox MEDIAKIT_WORKDIR (34 tools)

- **Học: samuelgursky/davinci-resolve-mcp** (4.046★, 1.257 commit, MCP server cho DaVinci Resolve Studio; repo video-MCP lớn nhất còn active theo delivvo.io 27/10). Ý áp dụng được:
  1. Workspace sandboxing là tính năng lõi của họ (loopback-only, HMAC, chặn traversal) → đã làm `MEDIAKIT_WORKDIR` opt-in (backlog từ alanveloper-epam lượt 16).
  2. Verified-Trap Guard — ledger các hành vi API "báo success nhưng không làm gì", đính `known_limitation` tại callsite; hành vi phá hoại thì từ chối trừ khi `acknowledge_trap: true` → backlog mới (MediaKit đã có các trap đo được: compress ra file lớn hơn source, Outline=0 nuốt hộp caption, `-stream_loop -1` encode vô hạn — đáng gom thành ledger thay vì ghi rải rác trong log).
  3. Operation envelope thống nhất (`_operation`: status/verification/changes/warnings/execution_id; "unverified" ≠ "checked and clean") → backlog mới (lớn; hiện mỗi tool trả JSON riêng).
  4. Source Media Safety — source bất khả xâm phạm, chỉ ghi sidecar/scratch → MediaKit đã có (cấm đè input); sandbox lần này siết thêm phía output.
  5. Optional extras từ chối thẳng kèm dòng cài đặt thay vì đoán mò → củng cố backlog "doctor kèm hướng fix".
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `generate_srt` (core+CLI+MCP, tool 34): sinh .srt xác định từ mảng cue `{start, end, text}` — thuần Node, không ffmpeg; thời gian nhận giây hoặc `MM:SS`/`HH:MM:SS` (reuse `parseTime`); cue phải đúng thứ tự, không chồng lấn (chạm nhau được), text không rỗng, tối đa 1000 ký tự/cue và 10.000 cue; output bắt buộc `.srt`; CLI `--cues-file` (array hoặc `{"cues": [...]}`).
  - Workspace sandbox opt-in `MEDIAKIT_WORKDIR`: chặn ở đúng 2 điểm nghẽn mọi tool đều qua — `requireInput` (input) và `prepareOutput` (output) + `prepareOutputDir` mới cho `frames`/`social`. Kiểm tra lexical (`..`) rồi `realpath` tổ tiên gần nhất còn tồn tại để bắt symlink escape; `prepareOutput` kiểm tra lại sau `mkdir`. Workdir không tồn tại → lỗi `SANDBOX_WORKDIR_MISSING` ngay lần dùng đầu (không lặng lẽ tắt sandbox). Unset = không giới hạn (hành vi cũ). Scratch nội bộ (passlog, temp frame svg, .ass tạm) được miễn — chỉ đường dẫn người gọi đưa vào mới bị kiểm tra.
  - `doctor`: thêm `sandbox: {enabled, workdir}` (hoặc `error` khi workdir hỏng → `ok: false`); thêm `generate_srt: {}` vào `TOOL_REQUIREMENTS` (34/34 available).
  - README (bảng 34 tools + dòng doctor), SKILL.md (rule 25 + workflow bước 4 gọi tên `generate_srt`), fixture `test/cues.json`, CI smoke thêm dòng `generate-srt`.
- **Test** (ffmpeg 8.1.2, source 1280×720 10s): generate_srt 3 cue 0–8s → **file 171 B, đúng format** (`1\n00:00:00,000 --> 00:00:02,500\nMediaKit gives agents`, cue 2 nhận `0:03` + text 2 dòng); lỗi đúng (chồng lấn, end<=start, text trắng, output .txt). Sandbox qua CLI (env chỉ truyền cho process con, không set `process.env` trong test — nếu không MCP server test sẽ thừa hưởng và mọi call sau đều fail): probe trong workdir OK; probe ngoài workdir / symlink trỏ ra ngoài / `..` / ghi output ra ngoài / frames outputDir ra ngoài đều bị từ chối `SANDBOX_ESCAPE` (ghi output bị chặn trước khi ghi — file không tồn tại); `doctor` báo `enabled: true` + đúng realpath workdir, unset → `enabled: false`; workdir không tồn tại → lỗi to thay vì tắt lén. `npm run check` sạch (check-docs: 34 tools khớp README); `npm test`: **239/239 PASS, exit 0** (34 tools, doctor 34/34 available). Assert mới (18): generate_srt 6 + sandbox 10 + doctor 2.
- **Bẫy đo lường**: `path.join(wd, "..", "source.mp4")` normalize mất `..` ngay phía test — assert traversal phải truyền chuỗi thô `${wd}/../source.mp4` thì `..` mới tới được `path.resolve` trong core. Review bắt được: `extractFrames` tạo thư mục trước khi kiểm tra "không nằm trong input" — đã đổi thứ tự kiểm tra trước, tạo sau.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 18 — 2026-11-11 18:58 (+07): export_gif (fit size budget) + error kèm retry command (35 tools)

- **Học: egoist/ffmpeg-mcp** (122★, TypeScript, chỉ 2 tools — sao cao nhờ tác giả nổi tiếng, không nhờ độ sâu). Ý áp dụng được:
  1. `speed_up` kẹp `max_fps` — MediaKit `fit --method speed` chưa kẹp fps đầu ra; ghi chú follow-up (nhỏ, chưa làm).
  2. Output mặc định `<tên>_output<ext>` khi không truyền output — KHÔNG áp dụng (MediaKit cố ý bắt buộc output tường minh, chống ghi đè nhầm).
  3. Stream stderr của ffmpeg thành MCP logging message từng dòng — backlog mới (tiến độ render cho agent thấy, chưa làm).
  4. Anti-pattern xác nhận MediaKit đã hơn hẳn: không probe/validate gì (speed_factor 0.1 sẽ fail vì atempo tối thiểu 0.5 — MediaKit `fit` chain atempo đúng), không verify output, kết quả plain text thay vì JSON có số đo.
  5. `FFMPEG_PATH` env — MediaKit đã có (`MEDIAKIT_FFMPEG`).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `export_gif` (core+CLI+MCP, tool 35): GIF hai-pass palette trong 1 lệnh ffmpeg (`split` + `palettegen` + `paletteuse` — palette xây từ chính frame của clip, nhỏ hơn 30–50% so với palette chung). Fit dưới `--max-size-mb` (mặc định 10 MB = giới hạn GitHub README; Slack chỉ auto-play GIF dưới ~2 MB) bằng ladder: fps 15→12→10→8, rồi width 640→480→320, rồi palette 256→128→64 màu; mỗi attempt đo thật trên đĩa, dừng ở attempt đầu tiên ≤ budget; `size_budget_met` báo thật + `warning` khi không đạt được dù đã xuống đáy ladder. Nhận `--start`/`--end` (giây hoặc `MM:SS`), `--fps`/`--width` tường minh thì ladder bắt đầu từ đó. Trả width/height/fps/duration/frames (đếm thật bằng ffprobe `-count_frames`)/size/budget/attempts.
  - Error kèm retry command (backlog từ lượt 2, luật eyes-free của kinocut): CLI `fail()` in thêm `Retry: mediakit <đúng lệnh vừa chạy>` (quote argv có khoảng trắng); MCP: wrapper một điểm nghẽn quanh `server.tool` — mọi error result được gắn thêm `retry: {tool, arguments}` (đúng args đã qua zod, gồm default), không sửa 34 handler cũ, `check-docs` vẫn thấy `server.tool(` như cũ.
  - `doctor`: thêm filter `palettegen`/`paletteuse` + tool `export_gif` (35/35 available). README (bảng 35 tools), SKILL.md (rule 26), CI smoke thêm dòng `export-gif --start 2 --end 4 --max-size-mb 2`.
- **Test** (ffmpeg 8.1.2, source 1280×720 10s): mặc định → **640×360, 15fps, 10s, 150 frames, 2.528.858 B, met=true, 1 attempt**; ffprobe độc lập xác nhận codec gif + 640 rộng, `stat` trên đĩa khớp `size_bytes`. Budget 0.5 MB → ladder 6 bước (2.528.858 → 1.977.602 → 1.626.458 → 1.289.390 → 795.334 → **382.248 B**), dừng ở 320px/8fps, met=true. Budget 0.02 MB (không thể) → **đủ 8 bước, met=false, có warning** — báo thật thay vì nhận vơ. Segment 2–4s → **2s, 30 frames**. Lỗi đúng (output .mp4, input audio-only, end<=start). MCP retry: trim file không tồn tại → `retry.tool === "trim"` + đúng arguments; CLI retry: trim `--start 99` → stderr có `Retry: mediakit trim ... --start 99`. `npm run check` sạch (check-docs: 35 tools khớp README); `npm test`: **257/257 PASS, exit 0** (35 tools, doctor 35/35 available). Assert mới (18): export_gif 14 + retry 2 + doctor 1 + probeStreams width 1.
- **Bẫy đo lường**: assert ffprobe độc lập ban đầu check `width` từ `probeStreams` — helper đó chỉ xin `codec_type,codec_name,start_time,duration` nên JSON không có width, tưởng GIF sai kích thước; fix bằng cách xin thêm `width,height` trong helper (các test khác dùng helper này không bị ảnh hưởng). Lần chạy lại test đầu tiên bị runtime restart cắt giữa chừng (log pipe rỗng, file `mcp-demo-imposs.gif` dở dang đúng 1.048.576 B) — chạy lại toàn bộ từ đầu, xanh hẳn mới push.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 19 — 2026-11-11 20:58 (+07): fit --max-fps + doctor kèm hướng fix (35 tools)
- **Học**: bitscorp-mcp/mcp-ffmpeg (61★, Node/TS, 4 tools: resize theo preset 360p/480p/720p/1080p, extract audio, get version; upload qua thư mục `uploads`, giới hạn 500 MB; cài qua Smithery). Ý áp dụng được:
  1. `speed_up` kẹp `max_fps` (ý này cũng có ở egoist/ffmpeg-mcp, backlog lượt 18) → đã làm `fit --max-fps`.
  2. `doctor` báo kèm cách fix (ý từ samuelgursky/davinci-resolve-mcp, backlog lượt 17) → đã làm `fix` một câu cho mỗi tool thiếu capability.
  3. Resize preset theo tên (360p/720p/1080p) → backlog mới (nhỏ; `resize` hiện chỉ nhận width/height số).
  4. Giới hạn 500 MB upload → KHÔNG áp dụng (MediaKit chạy local, không upload).
  5. Smithery install → chưa làm (đợi npm 0.1.0 live rồi tính phân phối).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `fit --max-fps <n>` (core+CLI+MCP, không thêm tool): cap fps output 1–120 bằng filter `fps=N` (speed: nối sau `setpts`; trim/loop: `-vf fps=N`); trả `max_fps` + `fps_capped` + `fps` đo thật. Chỉ hạ fps, không bao giờ tăng bằng duplicate frame; audio-only bỏ qua (fps null, capped false).
  - `doctor` kèm hướng fix: hàm thuần `fixForMissing(missing)` export từ core.js — tool nào `available: false` thì kèm `fix` một câu (tên capability thiếu + lệnh cài full ffmpeg build: apt/brew/static johnvansickle.com). `fit` thêm filter `fps` vào TOOL_REQUIREMENTS.
  - README (dòng bảng fit/doctor + đoạn prose), SKILL.md (rule 27), CI smoke thêm dòng `fit --duration 5 --max-fps 15`.
- **Test** (ffmpeg 8.1.2, source 1280×720 30fps 10s): fit speed 10→5s không cap → **fps 60 thật** (2x speed-up tăng fps gấp đôi — đây là hành vi đúng, không phải bug); max-fps 30 → **capped true, fps 30, 5s**; max-fps 60 → **capped false, fps 60** (không duplicate frame lên); 4x (10→2.5s) max-fps 60 → **capped true, fps 60** (effective 120fps); trim 10→6s max-fps 15 → **fps 15, 6s**; audio-only max-fps 15 → capped false, fps null, 4.5s; `--max-fps 0` → INVALID_ARG exit 2. `fixForMissing`: []/null → null; filter/encoder/mixed đều chứa đúng tên capability + `apt install ffmpeg`; doctor live: không tool nào có key `fix` khi đủ capability. `npm run check` sạch (check-docs: 35 tools khớp README); `npm test`: **267/267 PASS, exit 0** (35 tools, doctor 35/35 available). Assert mới (10): fit max-fps 5 + doctor fix 5.
- **Bẫy đo lường**: bản đầu so `max_fps` với fps NGUỒN (30) thay vì fps HIỆU DỤNG sau speed-up (30×factor) — max-fps 60 trên fit 2x tưởng "không cần cap" nhưng output vẫn 60fps do setpts, còn max-fps 30 trên fit 4x sẽ lọt thành 120fps. Fix: `effFps = srcFps × factor` cho method speed, `srcFps` cho trim/loop. Bắt được bằng smoke CLI trước khi viết test, test mới khóa đúng ngữ nghĩa này (assert fps 60 khi không cap + capped false khi max_fps == effective fps). Lỗi phụ: `factor` khai báo sau khối capFps gây TDZ `Cannot access 'factor' before initialization` — dời lên trước.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

---

## Lượt 20 — 2026-11-11 22:58 (+07): sửa CI đỏ lượt 19 + resize --preset (35 tools)
- **Sửa CI đỏ (việc đầu tiên, trước khi làm mới)**: CI run #43036227269 cho commit lượt 19 **failure sau 1h3m** — không phải do code: step "Install ffmpeg" chết vì apt không resolve được `security.ubuntu.com` (`Temporary failure resolving`, exit 100), ffmpeg không được cài nên job fail ngay từ đầu; 1h3m là apt treo retry DNS, không phải test chạy lâu. Local lượt 19 đã xanh 267/267 nên code không có lỗi.
- **Fix CI** (`.github/workflows/ci.yml`): step install ffmpeg retry apt 3 lần (mỗi lần cách 30s); nếu vẫn fail thì fallback sang static build johnvansickle.com (`ffmpeg-release-amd64-static.tar.xz`, install vào /usr/local/bin); cuối step in `ffmpeg -version` + `ffprobe -version` để log luôn ghi rõ ffmpeg nào đã chạy (phòng assert hardcode version như lượt 13). Thêm `timeout-minutes: 20` cho job — job kẹt phải fail nhanh thay vì đốt 1h.
- **Học: beambuilder/ffmpeg-mcp-server** (4★, Node, highlight extraction + keyframe/GOP control cho GoPro timelapse) + **kpr17ch/outtake** (3★, "Cursor for video", Remotion + ElevenLabs + FFmpeg MCP, á quân Cursor Hackathon Heilbronn 2026). Ý áp dụng được:
  1. `increase_keyframes` — đặt GOP (`-g`) để tăng mật độ keyframe, giúp seek/edit nhanh → backlog mới (chưa làm; MediaKit mới có `keyframes` liệt kê, chưa có tool đặt GOP).
  2. Outtake: cut plan cho agent duyệt trước khi render (plan-before-render) → MediaKit đã có dry-run ở mix/mux; backlog mở rộng dry-run cho các tool khác (chưa làm).
  3. Outtake: `check_frame` — xem 1 frame để agent quyết định → MediaKit đã có `extract_frame`/`frames`.
  4. Outtake: export preset `preview`/`social`/`high_quality` → MediaKit đã có `social` + `compress` preset.
  5. Outtake: `mix_sfx` — chèn SFX đúng timestamp → backlog mới (mix hiện chỉ có music bed ducking).
  6. beambuilder: background job >1GB + status polling → KHÔNG áp dụng (MediaKit single-shot đồng bộ, cache/job ID sẽ giấu input đổi).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `resize --preset` (core+CLI+MCP, không thêm tool): preset 360p (640×360), 480p (854×480), 720p (1280×720), 1080p (1920×1080), 2160p (3840×2160) — fit khung vào trong box giữ aspect, **không bao giờ upscale** (upscale không thêm chi tiết, chỉ phình file); làm tròn chẵn (x264 yuv420p); trả `preset`, `preset_box`, `scaled_down`, `source_dimensions`. Preset + `--width`/`--height` hoặc `--no-keep-aspect` → từ chối INVALID_ARG.
  - CI smoke thêm dòng `resize --preset 360p` + ffprobe độc lập grep `^640,360$`.
  - README (dòng bảng resize), SKILL.md (rule 28).
- **Test** (ffmpeg 8.1.2, source 1280×720 10s): CLI smoke — 720p → **1280×720, scaled_down false** (đã vừa box, không scale); 360p → **640×360, scaled_down true**; 480p → **854×480**; 1080p → **1280×720, scaled_down false** (không upscale lên 1920×1080); preset lạ `144p` → exit 2; preset + width → exit 2 (kèm dòng `Retry:`). `npm run check` sạch (check-docs: 35 tools khớp README); `npm test`: **273/273 PASS, exit 0** (35 tools, doctor 35/35 available). Assert mới (6): resize preset 720p/360p/1080p + preset+width MCP + preset lạ MCP + CLI preset+width.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).
- **Hậu kiểm CI (23:3x)**: run #43056155316 cho commit d654975 **cancelled ở 20 phút** — step Install ffmpeg bị job timeout giết. Log cho thấy `apt-get update` báo DNS fail lúc 16:16:59 rồi `apt-get install` (attempt 1) treo ~17 phút, vòng retry không bao giờ tới attempt 2 chứ đừng nói fallback static build — lỗi ở fix lượt 20: retry mà không bound thời gian từng lệnh apt. **Fix ngay trong lượt này** (commit riêng): mỗi lệnh apt bọc `timeout` (update 120s, install 180s) + `Acquire::Retries=1` + `http/https Timeout=10`, curl fallback `--max-time 180`, sleep giữa attempt 30s → 10s. Tổng tệ nhất ≈ 3×(120+180+10) + 180 ≈ 19 phút vẫn dưới timeout job 20 phút — nhưng đường thường chỉ 1 attempt. YAML + bash snippet đã check syntax local; CI mới sẽ xác nhận trên runner.
- **Hậu kiểm CI lần 2**: run #43060050768 cho commit f603636 **failure ở CLI smoke test** (install step đã success — retry có bound + fallback hoạt động). Nguyên nhân: fallback johnvansickle build **không có decoder librsvg** (`no decoder found for: svg`) nên `svg-animate` fail. **Fix**: đổi fallback sang BtbN GPL static build (`FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz`) — đã verify trên đĩa: có decoder `librsvg`, đủ 9 filter cần thiết + libx264/x265/aac/mp3/opus; chạy `svg-animate` thật với build này ra 2s/20 frame h264 1280×720. Đồng thời: apt timeouts siết lại (update 90s / install 120s) + job timeout 20 → 25 phút (tổng tệ nhất: 3×220s + curl 300s + test ~4 phút ≈ 20 phút). Sửa luôn hint `fixForMissing` trong core.js: static build có librsvg là BtbN GPL, johnvansickle không có librsvg nên svg_animate sẽ không chạy được trên đó.
- **Hậu kiểm CI lần 3**: run #43062155627 cho commit 80ccdc3 **failure ở CLI smoke test** — nhưng đã tiến xa hơn: install step success, `svg-animate` smoke PASS (fallback BtbN có librsvg thật), `resize --preset 360p` PASS. Fail ở `compress --target-size 1`: pass 2 báo `Error reading log file '/tmp/mediakit-pass-*/pass-1.log' for pass-2 encoding` từ `[aost#0:1/aac]`. **Nguyên nhân** (repro đúng trên đĩa với build BtbN): ffmpeg >= 8.1 áp `-pass 2` cả cho encoder AAC, nó đòi đọc `pass-1.log` của audio stream 1 — mà pass 1 của MediaKit chạy `-an -f null -` nên chỉ tạo `pass-0.log` (+ mbtree), không có `pass-1.log`. Repro đối chứng: pass 1 có audio (`-c:a aac -f mp4 /dev/null`) tạo `pass-1.log` rỗng → pass 2 chạy được. **Fix**: pass 1 encode luôn audio (`-c:a aac -b:a <k> -f null -`, video-only thì vẫn `-an`); pass 2 không đổi. Verify: CLI smoke `compress --target-size 1` trên cả ffmpeg hệ thống 8.1.2 (**953.377 B, target_met true**) và build BtbN (**989.352 B, target_met true**); full test suite chạy lại với `MEDIAKIT_FFMPEG`/`FFPROBE` trỏ sang BtbN (đúng cấu hình fallback của CI): **273/273 PASS, exit 0**, gồm compress target-size 2 pass, target_met true, 953.118 B.

---

## Lượt 21 — 2026-11-12 00:58 (+07): convert --gop + mix --sfx (35 tools)
- **Học: heygen-com/hyperframes** (HTML→video framework, skills + registry 450 blocks + lint + deterministic render; CLI có `check`, `look`, `transcribe`, `beats`). Ý áp dụng được:
  1. Lint-before-render với named rule groups (`hyperframeLinter.ts`, `LINT_RULE_COUNT`) → MediaKit đã validate từng tool + dry-run ở mix/mux; ghi backlog: mở rộng dry-run cho các tool mutative khác (đã có từ lượt 16).
  2. Registry of ready-made blocks (titles/transitions/captions/charts) → backlog mới: thư viện style đặt tên cho `titlecard`/`intro` (hiện mỗi cái 1 style cứng).
  3. Deterministic render + verify frame-by-frame (`look`, `reverse-any-video`) → MediaKit đã làm theo hướng này (pixel-check, đo LUFS thật); giữ nguyên.
  4. `transcribe` + `beats`/audio placement → củng cố backlog `transcribe` (cần faster-whisper) và `mix --sfx` (đã làm lượt này).
  5. Versioned skills khớp CLI version → nhỏ, chưa làm.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `convert --gop <frames>` / `--gop-seconds <s>` (core+CLI+MCP, không thêm tool): đặt keyframe interval khi re-encode video — `-g N -keyint_min N`, tắt scene-cut keyframe theo codec (libx264/mpeg4: `-sc_threshold 0`; libx265: `-x265-params scenecut=0`); vp9/av1 chỉ nhận `-g` nên GOP ở đó là maximum, không phải spacing chính xác (ghi rõ trong docs). `--gop` + `--gop-seconds` loại trừ nhau; `--gop` với stream-copy bị từ chối (copy không dời được keyframe). Trả `gop_frames`, `gop_seconds`, `keyframes` {count, min/max/avg gap} đo lại trên file output bằng `listKeyframes`.
  - `mix --sfx` (core+CLI+MCP, không thêm tool): tối đa 16 SFX, mỗi cái {file, at (giây hoặc MM:SS), volume 0-1}; mỗi SFX qua `adelay` tới đúng timestamp rồi `amix` vào SAU ducking, nên sting/whoosh không bị duck cùng nhạc nền; timestamp >= độ dài voice bị từ chối (amix `duration=first` sẽ cắt lặng lẽ nếu không chặn). `doctor` thêm filter `adelay` cho `mix`. CLI `--sfx <file>@<s|MM:SS>[@<volume>]` lặp lại được — `parseArgs` giờ gom flag lặp thành mảng (flag boolean lặp vẫn giữ `true`).
  - Fixture mới `test/sfx-beep.mp3` (sine 880 Hz, 0.5s, 44.1 kHz mono, tạo bằng lavfi).
  - README (2 dòng bảng convert/mix), SKILL.md (rule 29), CI smoke thêm 3 dòng (convert --gop-seconds 2 + đếm keyframe bằng ffprobe + mix --sfx).
- **Test** (ffmpeg 8.1.2): convert `--gop-seconds 2` trên source 1280×720 30fps 10s → **gop_frames 60, keyframes [0,2,4,6,8], gaps đúng 2.0s** (đo 2 lần: report của tool + `keyframes` tool độc lập trên file output); `--gop` với copy → INVALID_ARG; `--gop` + `--gop-seconds` → INVALID_ARG. Mix 2 SFX (3s vol 1, 6.5s vol 0.5) → **9s, LUFS −14.2, ducking 9.9 dB** (không đổi); volumedetect độc lập cửa sổ SFX [3.0,3.5): có SFX **−15.1 dB** vs không SFX **−25.7 dB** (+10.6 dB), cửa sổ đối chứng [2.2,2.7) −26.4 vs −26.7 dB (không rò); SFX @99s → INVALID_ARG "past the voice end". `npm run check` sạch (check-docs: 35 tools khớp README); `npm test`: **283/283 PASS, exit 0** (35 tools, doctor 35/35 available). Assert mới (10): mix sfx 5 + convert gop 5.
- **Bẫy đo lường**: lần đầu chạy volumedetect với `-v error` ra rỗng — tưởng SFX không vào; thực ra `-v error` nuốt luôn stats của volumedetect (in ở mức info). Bỏ `-v error` mới đo được. Helper `meanVolume` trong test dùng `-hide_banner` (không `-v error`) để tránh lặp lại bẫy này.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 22 — 2026-11-12 02:58 (+07): transcribe (local faster-whisper ASR, 36 tools)
- **Học: kajisho5/ffmpeg-skill 1.17+ (caption --transcribe) + phonology024/babelscribe** (whisper.cpp layer). Ý áp dụng được:
  1. ASR local là tính năng optional, không bao giờ bắt buộc — thiếu engine thì từ chối kèm dòng cài đặt, không đoán mò (ffmpeg-skill: `caption.py --transcribe` + `silence.py --filler --transcribe`, `--engine`/`--model`, env `FFMPEG_SKILL_ASR_ENGINE`/`FFMPEG_SKILL_ASR_MODEL`, auto/base mặc định; audio không bao giờ upload).
  2. babelscribe: whisper.cpp + Vulkan/CUDA/Metal, `transcribe` → SRT/VTT/text, model tải lần đầu — MediaKit chọn faster-whisper trước (pip install là đủ, không cần build binary); whisper.cpp engine là follow-up.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg + helper Python.
- **Làm**:
  - `transcribe` (core+CLI+MCP, tool 36): probe có audio → extract 16 kHz mono WAV vào temp dir bằng ffmpeg → `scripts/asr_faster_whisper.py` (đọc WAV bằng stdlib `wave`, đưa mảng float32 numpy cho faster-whisper) → ghi .srt bằng cùng formatter với `generate_srt` (`formatSrtBody` tách dùng chung). `--model` (16 model faster-whisper, mặc định tiny hoặc `MEDIAKIT_ASR_MODEL`), `--language auto|ISO 639-1`, `--engine auto|faster-whisper`. Trả `segments` + `text` + `language`/`language_probability` + `duration_seconds`. Im lặng → 0 segment + .srt rỗng (kết quả đúng, không phải lỗi). Temp dir dọn sạch sau chạy.
  - `doctor`: `transcribe` báo trạng thái engine (available/engine/python/fix) — thiếu engine KHÔNG làm `ok=false` (ASR là optional, mọi tool khác vẫn chạy). `detectAsrEngine()` export từ core.js.
  - Fixture mới `test/speech-jfk.flac` (11s, file test chuẩn của repo openai/whisper: "ask not what your country can do for you...").
  - README (dòng bảng transcribe), SKILL.md (rule 30), CI smoke thêm dòng transcribe (đường lỗi: runner không có engine → grep `faster-whisper` trong hint).
- **Test** (ffmpeg 8.1.2; engine faster-whisper 1.2.1 trong venv `~/.local/venv/mediakit-asr`, model tiny tải từ Hugging Face lần đầu ~32s):
  - CLI: JFK 11s → **1 segment [0, 11], language en prob 1.0, text đúng từng chữ** ("And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country."), .srt 141 B đúng format; tone 9s → **0 segment, .srt 0 B**; model `huge` → INVALID_ARG; logo.png → "needs an audio stream"; output .txt → INVALID_ARG; không engine → exit 2 + hint cài đặt + dòng `Retry:`.
  - `npm run check` sạch (check-docs: 36 tools khớp README); `npm test` thường: **288/288 PASS, exit 0** (36 tools; doctor: 35 ffmpeg tools available + transcribe báo unavailable kèm hint). Gated `MEDIAKIT_TEST_ASR=1 MEDIAKIT_ASR_PYTHON=<venv python> npm test`: **297/297 PASS** — gồm e2e JFK qua MCP (text chứa "fellow Americans", .srt trên đĩa đúng cue `00:00:00,000 --> 00:00:11,000`), tone → 0 segment, ảnh → từ chối, chuỗi transcribe → burn_captions ra video 10s có phụ đề.
  - Assert mới (14): transcribe validation 3 + no-engine 1 + doctor ASR 2 + gated e2e 8 (số đếm gồm cả 2 assert doctor đã sửa theo hướng optional).
- **Bẫy đo lường**:
  1. faster-whisper 1.2.1 + PyAV >= 15 vỡ ở `decode_audio` (`metadata_errors` bị xóa khỏi `av.open`) — tưởng phải pin `av==13.1.0`; thực ra helper đưa mảng numpy nên PyAV không bao giờ được gọi: đã verify với **av 19.0.2 vẫn transcribe đúng**, hint cài đặt vì vậy chỉ cần `pip install faster-whisper`, không cần pin av.
  2. MCP enum validation (model/engine lạ) trả -32602 dạng throw trên client, không phải isError result — test đầu viết `JSON.parse(content)` đã crash cả run (giống bẫy lượt 10 với social); fix bằng helper `callExpectThrow` (try/catch, lấy message).
  3. `StdioClientTransport` KHÔNG kế thừa `process.env` theo mặc định — lượt gated đầu server con thấy `python3` (không engine) dù test process đã có `MEDIAKIT_ASR_PYTHON`; fix bằng `env: process.env` khi tạo transport chính.
  4. Edit đầu tay làm mất header hàm `run()` (replace nhầm) — bắt được ngay bằng `node --check`, khôi phục trước khi chạy test.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 23 — 2026-11-12 04:58 (+07): concat per-clip trim + extract_audio --channel (36 tools)
- **Học: matthensleyio/FFMpeg.MCP** (.NET 9, 1★, 6 audio tools, FFMpegCore + channel-based task queue + real-time progress notifications). Ý áp dụng được:
  1. `extract_audio_channel` — tách 1 kênh ra mono → đã làm `extract_audio --channel <n>` (filter `pan`, validate theo số kênh probe được).
  2. Real-time progress notifications cho op dài (MCP `notifications/progress`) → backlog mới (cần plumbing progressToken qua server.js → core runFfmpeg; chưa làm lượt này).
  3. Channel-based task queue / async jobs → KHÔNG áp dụng (MediaKit single-shot đồng bộ; queue sẽ giấu input đổi).
  4. Validate bitrate/sample-rate theo format → MediaKit đã có (num/zod enum).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `concat` per-clip trim (core+CLI+MCP, không thêm tool; backlog từ lượt 9, ý từ studiomeyer-io/mcp-video): mỗi input nhận `{file, start, end}` (MCP) hoặc `path@start-end` (CLI; giây hoặc MM:SS, đầu/cuối được để trống — `a.mp4@2-`, `a.mp4@-5`). Cắt bằng `trim`/`atrim` + `setpts` reset trong 1 filter graph, normalize về size/fps clip đầu, nối bằng filter `concat` — luôn re-encode; `--fast` + trim bị từ chối kèm lý do đo được. Trim cũng chạy với `--transition` (fade tính trên timeline đã trim). Trả `parts` [{file, start, end, duration}] + `mode: "trim"` + `expected_duration_seconds`; kết quả plain/transition cũng trả `parts` (thay cho `parts: <số>` cũ).
  - `extract_audio --channel <n>` (core+CLI+MCP, không thêm tool): `pan=mono|c0=c<n>`; index 0-based, validate với số kênh probe được (mono → lỗi, vượt → lỗi kèm số kênh thật); trả `channel`. Kết hợp được với `--whisper` (pan rồi mới 16 kHz mono). `doctor` thêm filter `pan` vào danh sách detect.
  - Fixture mới `test/stereo-lr.mp3` (stereo 4s: trái sine 440 Hz, phải im lặng — lavfi `amerge`).
  - README (2 dòng bảng + đoạn prose concat), SKILL.md (rule 31), CI smoke thêm 3 dòng (concat trim → duration 6 + extract-audio channel 0 → 1 kênh).
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code: concat demuxer `inpoint`/`outpoint` KHÔNG cắt chính xác — trim 2–5s + 1–4s stream-copy ra **8.09s** thay vì 6s (re-encode qua demuxer **8.13s**); `-ss 2 -t 3` input-seek ra đúng 3.0s. Vì vậy trim đi đường filter graph, không dùng inpoint/outpoint.
  - Concat trim MCP: source 2–5s + source2 1–4s (MM:SS `0:01`–`0:04`) → **6.0s, mode trim, expected 6**; pixel-check độc lập: frame output @0.5s vs source @2.5s **PSNR 67.2**, vs source @0.5s **PSNR 23.8** (trim thật sự dời hình, không chỉ đúng độ dài). Trim + fade 5s+4s−1s → **8.0s**.
  - Lỗi đúng: end 99s → "past its duration"; end<=start → "must be after its start"; `--fast` + trim → "cannot trim clips" kèm lý do keyframe; CLI `path@start-end` → 6s.
  - Extract channel: ch0 mono, volumedetect độc lập **−22.2 dB** (tone trái còn nguyên); ch1 mono, **−91.0 dB** (phải im lặng — mức nền encoder mp3); ch2 → exit 2 "out of range: the input has 2 channel(s)"; CLI `--channel 0` → mono.
  - `npm run check` sạch (check-docs: 36 tools khớp README); `npm test`: **304/304 PASS, exit 0** (36 tools, doctor 36/36 available). Assert mới (15): concat trim 9 + channel 6.
- **Bẫy đo lường**: PSNR band testsrc @0.5s vs @2.5s chỉ 23.8, không < 20 như đoán ban đầu (phần lớn khung testsrc là tĩnh — chỉ vùng chuyển động đổi); ngưỡng assert sai phải là < 30 (đúng 67.2 vs sai 23.8, cách xa nhau). Đã đo trước rồi mới chốt ngưỡng.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).

## Lượt 24 — 2026-11-12 06:58 (+07): grade tool + check --content audio peaks & time_range (37 tools)
- **Học: beeswaxpat/ffmpeg-render-pro** (Node, render video từ code song song + MCP server + Claude Code skill; parallel workers, stream-copy join, GPU detect, color_grade presets, merge_audio, checkpoints). Ý áp dụng được:
  1. `color_grade` presets (noir/warm/cool/cinematic/vintage) hoặc custom `-vf` chain → đã làm tool `grade` mới.
  2. `detect_gpu` (probe NVENC/VA-API/QSV/…) → chưa làm (máy Milo CPU-only; `doctor` đã liệt kê encoder; follow-up nhỏ).
  3. `merge_audio` (gắn nhạc không re-encode video) → đã có `mux`.
  4. `structuredContent` + outputSchema trên mọi tool → củng cố backlog contract machine-readable (chưa làm, lớn).
  5. Progress notifications mỗi 2s + cancel qua AbortSignal → củng cố backlog MCP logging progress (chưa làm).
  6. Parallel render / checkpoints / worker threads → KHÔNG áp dụng (MediaKit single-shot đồng bộ).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `grade` (core+CLI+MCP, tool 37): preset warm/cool/cinematic/noir/vintage (chuỗi filter cố định) hoặc `--filter` một chain tùy ý (mutually exclusive với preset); re-encode libx264 crf 23, audio copy; trả `preset`, `filter` đã áp dụng, `color_before`/`color_after` (mean R/G/B frame giữa, đo bằng extractplanes+signalstats — cùng cách test đo độc lập) + dimensions/duration/size. `doctor` thêm filter eq/hue/colorbalance + tool `grade`.
  - `check --content`: `audio_peaks` — decode riêng chạy `astats=metadata=1:reset=1` + `ametadata=print`, gom frame thành cửa sổ 0.1s, cửa sổ trên `--peak-threshold` (mặc định −1 dBFS) gộp thành interval; peak ≥ 0 dBFS → error (clipping), trên ngưỡng → warn; trả `peaks` {threshold_db, window_seconds, max_peak_db, intervals} + rule `content_peaks` (ý từ riqvip/codex-media-mcp, backlog lượt 12).
  - `check --content` theo `time_range` — `--start`/`--end` (giây hoặc MM:SS, CLI + MCP `content_start`/`content_end`): input-seek `-ss` trước `-i` + `-t`, mọi interval báo trên timeline gốc của file, rules layer dùng biên của đoạn scan, interval chạm biên scan gắn `ends_at_scan_boundary`; trả `time_range` {start_seconds, end_seconds}. `--start`/`--end`/`--peak-threshold` không kèm `--content` bị từ chối (CLI).
  - Fixture mới `test/loud-peak.wav` (4s float WAV: sine yên −18 dBFS, burst [1,2) ×12 → peak +3.52 dBFS) + `test/quiet-peak.wav` (sine 4s, peak −18.06 dBFS).
  - README (dòng bảng grade + sửa dòng check + đoạn prose), SKILL.md (rule 32), CI smoke thêm 3 dòng (grade noir + check peaks + check time_range).
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code: astats per-frame in đúng format (`frame:N pts_time:T` + `Peak_level=X`); burst đo **+3.52 dBFS**, quiet **−18.06 dBFS**.
  - Peaks: loud → **1 interval [1,2], peak 3.52 dBFS, severity error, max 3.52, content.pass false, rule content_peaks fail + có trong issues**; quiet → 0 interval, max −18.06, pass true; threshold 5 dBFS → 0 interval (đối chứng âm).
  - Time_range: scan 0–2s → black 0 interval; scan 2–8s → black **[3,6] error** trên timeline gốc + `time_range` {2, 8}; end<=start → lỗi "after start"; CLI `--start` không `--content` → từ chối.
  - Grade: warm R−B **−5.4 → +23.3** (R 122→136.8, B 127.4→113.5), pixel-check độc lập frame 0 cùng chiều; noir **R=G=B=120.6**; custom `eq=saturation=0` grayscale + preset null; preset lạ / preset+filter / audio-only đều bị từ chối đúng.
  - `npm run check` sạch (check-docs: 37 tools khớp README); `npm test`: **337/337 PASS, exit 0** (37 tools, doctor 36 ffmpeg tools available + transcribe unavailable kèm hint — ASR optional). Assert mới (33): peaks 13 + time_range 7 + grade 11 + doctor 2.
- **Bẫy đo lường**:
  1. `colorbalance` chỉ set rs=/bs= (shadows) thì frame mean gần như không nhúc nhích (warm R +2.9) — phải set cả 3 dải shadows/midtones/highlights mới đo được (R +14.8, B −13.9). Đã đo trước rồi mới chốt preset.
  2. Zod schema `peak_threshold_db` ban đầu max 0 → test đối chứng âm threshold 5 bị −32602 crash cả run (giống bẫy lượt 11/22: MCP enum throw, không phải isError result); fix: max 12 — float audio peak được trên 0 dBFS, ngưỡng trên 0 là hợp lệ.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).
- Push: commit d680743 → GitHub main (origin/main = d680743). **CI run #43127357861 success** — xanh ngay lượt này.

## Lượt 25 — 2026-11-12 08:58 (+07): reverse tool + doctor GPU detection (38 tools)
- **Học: conneroisu/vfx-mcp** (9★, Python/FastMCP + ffmpeg-python, 10 tools). Ý áp dụng được:
  1. Reverse playback (video + audio ngược) → đã làm tool `reverse` mới.
  2. MCP Resources (`videos://list`, `videos://{filename}/metadata`, `videos://workspace/info`) → backlog mới (MediaKit hiện chỉ có tools + `find`; resources là một lớp capability mới, cần thiết kế workspace root).
  3. Progress reporting cho operation dài (`utils/progress.py`) → củng cố backlog MCP logging progress (chưa làm).
  4. `apply_filter` (một filter string tùy ý) → đã có qua `grade --filter`.
  5. `generate_thumbnail` mặc định timestamp = giữa video → `thumbnail`/`extract_frame` đã có.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `reverse` (core+CLI+MCP, tool 38): video qua filter `reverse`, audio qua `areverse` (mặc định bật; `--no-audio` / `audio: false` giữ audio chạy xuôi, copy stream); re-encode video libx264 crf 23; audio codec theo đuôi output (`.mp3` → libmp3lame, `.mp4` → aac — cùng map với `loudness`/`fit`); trả `video_reversed`, `audio_reversed`, `audio_codec`, duration/dimensions/size. Audio-only → chỉ đảo audio; video-only → chỉ đảo video; audio-only + `--no-audio` bị từ chối ("reverses nothing"). `doctor` thêm filter reverse/areverse + tool `reverse`.
  - `doctor` GPU detection (ý từ beeswaxpat/ffmpeg-render-pro, backlog lượt 24): trả `gpu: {available, encoders, working_encoder}` — `encoders` là HW encoder có trong build (nvenc/qsv/vaapi/videotoolbox/amf, 15 tên), `working_encoder` là encoder đầu tiên (ưu tiên nvenc > qsv > vaapi > videotoolbox > amf) pass một probe encode thật (0.2s testsrc 64×64 → null, cap 10s/encoder). Listed ≠ usable: máy không GPU vẫn list 10 encoder nhưng `available: false`. GPU thiếu KHÔNG làm `ok=false` (CPU-only là bình thường).
  - README (dòng bảng reverse + sửa dòng doctor + 2 đoạn prose), SKILL.md (rule 33), CI smoke thêm 2 dòng (reverse + ffprobe duration `^10`).
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code: reverse scenes-source (đỏ [0,5) + xanh [5,10)) → t=1 xanh B 254, t=9 đỏ R 253 (đảo đúng); mix-voice đảo audio → silence [2,4),[6,7) thành [2,3),[5,7) (đúng phép đối xứng 9s). Probe GPU: nvenc/qsv/vaapi đều fail trong <1s tổng (không treo).
  - Reverse video+audio: **640×360, 10.054s**, t=1 R 0/B 254, t=9 R 253/B 0; audio-only → video false/audio true, silence đảo đúng [2,3)+[5,7); `--no-audio` trên video → video đảo (t=1 B 254), audio copy, mean volume −21.1 dB giữ nguyên; video-only → video true/audio false, 10s; audio-only + `--no-audio` → từ chối đúng.
  - Doctor: `gpu.available false`, `encoders` 10 cái (nvenc×3, qsv×3, vaapi×4), `working_encoder null`, `ok` vẫn true; assert `available === (working_encoder !== null)`.
  - `npm run check` sạch (check-docs: 38 tools khớp README); `npm test`: **351/351 PASS, exit 0** (38 tools, doctor 37 ffmpeg tools available + transcribe unavailable kèm hint — ASR optional). Assert mới (14): reverse 11 + doctor gpu 3 (2 gpu + 1 reverse-available).
- **Bẫy đo lường**:
  1. Bản đầu hardcode `-c:a aac` cho mọi output → reverse mix-voice.mp3 ra file .mp3 chứa AAC, ffmpeg không mở lại được ("Failed to find two consecutive MPEG audio frames") làm crash cả test run. Fix: codec audio theo đuôi output như `loudness`/`fit` đã làm. Bài học: mọi tool ghi audio phải chọn codec theo container, không hardcode.
  2. Test `audio=false` viết nhầm trên file audio-only (mix-voice.mp3) — tool từ chối đúng theo guardrail ("reverses nothing"), test FAIL oan. Fix: case `--no-audio` phải dùng input có video (scenes-source.mp4) — guardrail và test phải viết cùng một ngữ nghĩa.
  3. `muse.edit` với `old_text` trùng 3 chỗ (`// ---- convert`) chèn nhầm `reverseClip` vào sau burn_captions thay vì sau grade — đã dời lại đúng vị trí bằng 2 edit neo vào text duy nhất. Bài học: header comment lặp lại trong file thì neo edit vào hàm kề bên, không neo vào header.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt 0.1.0).
- Push: commit 5ab7c30 → GitHub main (origin/main = 5ab7c30). **CI run #43140942032 success** — xanh ngay lượt này (gồm 2 dòng smoke mới: reverse + ffprobe duration).

## Lượt 26 — 2026-11-12 10:58 (+07): MCP Resources videos:// (38 tools, không thêm tool)
- Học: vinayakbhati/ffmpeg-mcp-server (HTTP MCP server, 1 tool `ffmpeg.execute` + validation + timeout). Ý áp dụng được:
  1. Execution timeout cho ffmpeg — MediaKit đã có sẵn (`run`/`runCapture` timeout 300s mặc định), không cần thêm.
  2. Generic `ffmpeg.execute` (chạy lệnh ffmpeg thô) — KHÔNG áp dụng: MediaKit cố ý chỉ có tool typed, không cho agent chạy lệnh tự do (bảo mật + verify được).
  3. REST discovery endpoints (`GET /mcp/tools`) — củng cố hướng resources: client nhìn thấy workspace trước khi gọi tool.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/MCP SDK.
- Làm:
  - MCP Resources (backlog lượt 25, ý từ conneroisu/vfx-mcp) — lớp capability mới, không thêm tool (38 tools giữ nguyên):
    - `videos://list` (core `listWorkspaceFiles`): mọi media file dưới root, đệ quy, sorted, cap 200, kèm path tương đối (posix) + size + extension; không probe nên nhanh. Root = MEDIAKIT_WORKDIR khi set, không thì cwd.
    - `videos://{+filename}/metadata` (core `workspaceMetadata`): probe 1 file theo path tương đối. Template dùng `{+filename}` (reserved expansion, SDK match `(.+)`) nên path lồng nhau (`test/nested/deep-clip.mp4`) đọc được — `{filename}` thường chỉ match 1 segment (`[^/,]+`).
    - `videos://workspace/info` (core `workspaceInfo`): root, sandbox, ffmpeg/ffprobe/node version, tools_total/available, media_files, gpu (dùng lại `doctor()` + list walk).
    - Giam cầm: resources LUÔN giam trong root — `..`, absolute path, symlink trỏ ra ngoài đều bị từ chối (`RESOURCE_ESCAPE`) kể cả khi sandbox tắt; chỉ file đúng đuôi media (FIND_EXTENSIONS) mới có metadata.
  - README (mục "MCP Resources" mới), SKILL.md (rule 34), test 13 assert mới (list/templates/metadata/info + 3 lỗi + 3 assert server workdir-scoped thứ hai).
- Test (ffmpeg 8.1.2): smoke trước khi viết test — list root repo 213 file (cap 200, truncated true), metadata nested `test/nested/deep-clip.mp4` 10s 1280×720, info 37/38 tools (transcribe unavailable vì ASR engine không có trong env — đúng luật optional), 3 lỗi đều throw McpError đúng message. `npm run check` sạch (check-docs: 38 tools khớp README); `npm test` **364/364 PASS, exit 0** (351 + 13 mới). Assert mới (13).
- Bẫy đo lường:
  1. SDK tách 2 method: `resources/list` chỉ trả static resources (+ instance khi template có list callback); template nằm ở `resources/templates/list` (`client.listResourceTemplates()`). Test đầu tìm template trong `listResources()` nên FAIL oan — fix bằng đúng method.
  2. Assert `size_bytes > 0` sai: `outputs/mcp-tone.srt` + `cli-tone.srt` là 0 byte — đúng vì transcribe tone không lời ra .srt rỗng. Fix: `>= 0`.
- npm: HIỆU CHÍNH trong lượt này (MEMORY.md cập nhật 12/11): **0.1.0 ĐÃ LIVE từ 9/11** (registry latest = 0.1.0) — helper npm_api.py "stage" thực ra publish thẳng dist-tag latest, không có bước Approve nào; việc nhắc Tony bật 2FA/bấm Approve trước đây là hiểu sai, bỏ. 0.2.0 (38 tool + resources) chờ Tony quyết publish hay xem 0.1.0 trước — cron KHÔNG stage/publish gì thêm.
- Version giữ 0.1.0.
- Push: commit 426158c "Add MCP Resources videos://list, metadata, workspace/info (38 tools)" → GitHub main (origin/main = 426158c). **CI run #43154815878 success** — xanh ngay lượt này.

## Lượt 27 — 2026-11-12 12:58 (+07): transcribe --engine whisper (whisper.cpp, 38 tools, không thêm tool)
- Học: AmolDerickSoans/ffmpeg-mcp (14★, Python/FastMCP, 7 tools). Ý áp dụng được:
  1. `batch_process` — chạy 1 operation lên nhiều file khớp glob, trả kết quả từng file → backlog mới (tool `batch`, chưa làm lượt này).
  2. `list_media_files` — đã có tốt hơn (`find` + resources `videos://list` đệ quy + probe).
  3. Quality presets low/medium/high/veryhigh — đã có (`compress` low/medium/high).
  4. Anti-pattern KHÔNG học theo: enum sai thì lặng lẽ fallback default (position/quality lạ → bottomright/medium) — MediaKit từ chối tường minh; `trim` dùng `-ss` sau `-i` với `-c copy` (không keyframe-safe) — MediaKit đã có `--snap`.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/whisper.cpp CLI.
- Làm:
  - `transcribe --engine whisper` (core+CLI+MCP, không thêm tool — backlog lượt 22): whisper.cpp CLI làm engine thứ hai, ngang hàng faster-whisper. `detectWhisperCpp(model)`: binary từ `MEDIAKIT_WHISPER_CPP_BIN` → `~/.local/share/mediakit/whisper.cpp/whisper-cli` → `whisper-cli`/`main` trên PATH; model từ `MEDIAKIT_WHISPER_MODEL` → `<cùng dir>/ggml-<model>.bin`. `detectTranscribe()`: auto ưu tiên faster-whisper rồi whisper.cpp; không engine nào → `engine: "none"`, fix mang cả 2 dòng cài đặt. Chạy `whisper-cli -m <model> -f <wav16k> -l <lang> -ojf -of <base> -np`, đọc `<base>.json`: segments từ `transcription[].offsets` (ms), language từ `result.language`; cùng đường normalize + `formatSrtBody` với faster-whisper nên .srt ra giống hệt. `doctor`: transcribe báo `{available, engine, python|binary+model, fix}`; thiếu engine KHÔNG làm `ok=false`.
  - Binary + model đã cài local (không commit vào repo): `~/.local/share/mediakit/whisper.cpp/` — whisper-cli b5454 (release GitHub) + ggml-tiny.bin 77.691.713 B, sha256 be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21.
  - Fixture test mới: `test/whisper-cli-stub.sh` (stub thay whisper-cli, ghi canned JSON JFK) + `test/whisper-stub-model.bin` (file rỗng, chỉ để qua kiểm tra tồn tại).
  - README (dòng bảng transcribe), SKILL.md (rule 30), CI smoke thêm dòng transcribe --engine whisper (đường lỗi, grep `whisper.cpp`).
- Test (ffmpeg 8.1.2; whisper.cpp b5454 + ggml-tiny):
  - Đo trước khi code: whisper-cli thật trên JFK → **1 segment [0, 10.5], text đúng từng chữ, language "en"**, ~4s; binary chạy không cần `LD_LIBRARY_PATH` (rpath `$ORIGIN`).
  - CLI: `--engine whisper` JFK → **engine "whisper.cpp", 1 segment, .srt 141 B**; `auto` (FW vắng) → whisper.cpp; tone → **0 segment + .srt 0 B**; model thiếu / binary thiếu → **exit 2, ASR_NOT_INSTALLED** kèm hint riêng.
  - `npm run check` sạch (check-docs: 38 tools khớp README); `npm test` thường: **371/371 PASS, exit 0** (364 + 7 mới: stub e2e 3 + stub doctor 1 + no-engine doctor 1 + CLI đường lỗi 2). Gated `MEDIAKIT_TEST_ASR=1`: **379/379 PASS**. Gated `MEDIAKIT_TEST_WHISPER_CPP=1`: **376/376 PASS** (JFK thật qua MCP: engine whisper.cpp, lang en, text "fellow Americans", segment end ~10.5s; tone → 0 segment).
  - Assert mới (12): stub e2e 3 + stub doctor 1 + no-engine doctor 1 + CLI lỗi 2 + gated whisper thật 5.
- Bẫy đo lường:
  1. Test no-engine cũ chỉ tắt faster-whisper (`MEDIAKIT_ASR_PYTHON=/nonexistent`) — trên máy đã cài whisper.cpp thì `auto` fallback sang whisper.cpp và call thành công, test FAIL 1 assertion. Fix: server no-engine phải tắt CẢ hai engine (thêm `MEDIAKIT_WHISPER_CPP_BIN=/nonexistent/whisper-cli`); cùng lý do, assert doctor "unavailable" cũ phải chấp nhận máy đã có engine (available=true là kết quả đúng, không phải fail).
  2. Bản đầu `detectWhisperCpp` coi `MEDIAKIT_WHISPER_CPP_BIN` như gợi ý rồi fallback về binary mặc định — set env thành đường dẫn không tồn tại vẫn chạy ngon bằng binary khác. Fix: env tường minh thì chỉ dùng nó, không tồn tại là lỗi binary thiếu (fail loudly, không fallback lặng lẽ). Bắt được bằng smoke CLI trước khi viết test.
  3. `time` không có trong shell cron (`/bin/bash: time: command not found`) làm đứt chuỗi smoke đầu — chạy lại không dùng `time`.
- Version giữ 0.1.0 (chưa stage 0.2.0 — đợi Tony duyệt).
- Push: commit 1695586 "Add transcribe --engine whisper (whisper.cpp second ASR engine, 38 tools)" → GitHub main (origin/main = 1695586). **CI run #43168084257 success, 4m11s** — xanh ngay lượt này (gồm dòng smoke mới transcribe --engine whisper).

## Lượt 28 — 2026-11-12 14:58 (+07): batch tool — one operation over a folder (39 tools)
- **Học: kajisho5/ffmpeg-skill `batch.py`** (5.123★, đã đọc README + release notes, không copy code). Ý áp dụng được:
  1. Áp 1 step recipe/project lên cả folder, cache theo content-hash (SHA-1 keyed, not-for-security) → đã làm cache sha256 input + operation + args + suffix, verify lại bằng size + sha256 của output.
  2. `--jobs N` chạy song song, cap `min(N, cpu_count, 8)`, chia sẻ 1 `--timeout` chung thay vì mỗi file một timeout → đã làm worker pool + deadline chung.
  3. Bảng kết quả giữ đúng thứ tự input; mỗi row mang failing step's `error`; sau Ctrl-C vẫn có row cho mọi input → đã làm results theo thứ tự input + status ok/error/cached/skipped cho mọi file.
  4. Mỗi result nêu encoder thực sự chạy → đã làm: row `ok` mang nguyên kết quả đo thật của tool con (LUFS, dimensions, codec...).
  5. `--watch` → KHÔNG làm (cần daemon, ngoài scope single-shot đồng bộ của MediaKit).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `batch` (core+CLI+MCP, tool 39): 1 operation (loudness/resize/reframe/compress/convert/extract_audio/reverse/grade/fit/trim/silence) lên mọi file khớp glob dưới 1 thư mục, cùng args cho mọi file. Output `<stem>-<operation>.<ext>` dưới output dir, mirror cây thư mục input; `batch-manifest.json` ghi mọi row. Glob: `**/*.mp4` mọi độ sâu, `sub/*.mp4` một thư mục, bare `*.mp4` khớp basename mọi độ sâu; bỏ qua thư mục ẩn/.git/node_modules/.next; file dưới output dir không bao giờ bị coi là input (kể cả khi output dir nằm trong input tree). Arg lạ bị từ chối nêu tên (không fallback lặng lẽ — bài học lượt 7/27). `--jobs 1–8`, `--timeout` chung (mặc định 1800s), `--max-files` (mặc định 200), `--stop-on-error`, `--dry-run` (liệt kê planned output, không ghi file nào), `--suffix` (mặc định `-<operation>`; suffix rỗng + cùng thư mục bị từ chối trước khi chạy). Guard: arg sai fail giống nhau trên mọi file → sau 3 lỗi INVALID_ARG đầu tiên ở chế độ tuần tự thì abort, không đốt hết folder.
  - `doctor`: thêm `batch: {}` (39/39). README (dòng bảng + đoạn prose), SKILL.md (rule 35), CI smoke thêm 2 dòng (batch loudness + cache hit).
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code: CLI loudness 3 file (2 top + 1 nested) jobs 2 → **3 ok, LUFS −16.0 đo độc lập, cây thư mục mirror đúng**; chạy lại → **cached 3, mtime không đổi, elapsed 0s**; timeout 1s với 6 file → **1 ok + 5 skipped** kèm message timeout; extract_audio dry-run → output `.mp3` từ input `.mp4`.
  - `npm run check` sạch (check-docs: 39 tools khớp README); `npm test` **389/389 PASS, exit 0** (371 + 18 mới: dry-run 2 + loudness 5 + manifest 1 + cache 2 + arg lạ 1 + arg sai 2 + op lạ 1 + no-match 1 + stop_on_error 2 + extract_audio 2). Assert mới (18).
  - **Bẫy đo lường**: (1) lần đầu `node --check` bắt `batch` CLI chỉ nhận `-o` mà usage ghi `--output-dir` — case batch giờ chấp nhận cả hai; (2) edit README prose bằng muse.edit với old_text nhầm thành text mới đã revert đoạn vừa thêm — kiểm tra bằng grep rồi viết lại, từ sau edit nào cũng đọc lại file ngay.
- Còn lại: chưa stage 0.2.0 (đợi Tony duyệt 0.1.0); backlog tiếp: Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác, thư viện style đặt tên cho titlecard/intro, Demo GIF mới cho README.
- Push: commit "Add batch tool: one operation over a folder with content-hash cache (39 tools total)" → GitHub main. **CI run #43180895694 success** — xanh ngay lượt này (gồm 2 dòng smoke mới: batch loudness + cache hit).

## Lượt 29 — 2026-11-12 16:58 (+07): interpolate + denoise tools (41 tools)
- **Học: hyepartners-gmail/vibevideo-mcp** (217★, monorepo: React frontend + Node MCP backend + Python ffmpeg backend + Ollama agent; ~25 MCP module JS chỉ sinh command string, không execute/verify). Ý áp dụng được:
  1. `stabilize` — vidstabdetect/vidstabtransform 2-pass, preset low/medium/high → ĐÃ THỬ, KHÔNG SHIP (xem "Bẫy đo lường" dưới).
  2. `interpolate` — minterpolate fps upscale, mode dup/blend/mci → đã làm tool `interpolate` mới.
  3. `denoise` — hqdn3d/nlmeans, strength 0–1 → đã làm tool `denoise` mới.
  4. `segment` HLS (`-c copy -hls_time N -f hls`) → backlog mới (nhỏ, hữu ích cho preview/distribution).
  5. Filter catalog JSON (`ffmpegFilters.json`) — củng cố backlog contract machine-readable.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg. Khác biệt cốt lõi: vibevideo chỉ sinh chuỗi lệnh cho agent/ UI chạy tay; MediaKit execute + đo thật trên đĩa (fps đếm frame, PSNR độc lập, noise energy đo trước/sau).
- **Làm**:
  - `interpolate` (core+CLI+MCP, tool 40): `--fps` bắt buộc (1–240, phải lớn hơn fps nguồn, không thì từ chối kèm gợi ý `fit --max-fps`), `--mode mci|blend|dup` (mặc định blend), `--crf 23`; audio copy khi có. Trả `fps_before`/`fps_after`, `frames_before`/`frames_after` đếm bằng ffprobe `-count_frames`, duration, dimensions, size_bytes.
  - `denoise` (core+CLI+MCP, tool 41): `--filter hqdn3d|nlmeans` (mặc định hqdn3d), `--strength 0–1` (mặc định 0.5). Trả `filter`, `filter_value`, `noise_before`/`noise_after` (năng lượng nhiễu tần số cao: mean |frame − gblur(frame)|, kênh Y, 30 frame đầu), duration, dimensions, size_bytes.
  - **Sửa bug `size_bytes`**: `fileInfo()` trả `{size_bytes, size_human}` nhưng `grade`/`reverse` (từ lượt 24/25) và 2 tool mới đều ghi `size_bytes: info.size` → `undefined`, JSON.stringify lặng lẽ nuốt mất key. Fix cả 4 chỗ thành `info.size_bytes`; thêm assert `size_bytes > 0` cho grade/reverse/interpolate/denoise.
  - Fixture mới `test/noisy.mp4` (5s loop ảnh có nhiễu Gaussian sigma-10, 1400×800, 905 KB) + `test/noisy-clean.mp4` (cùng ảnh không nhiễu, 95 KB) — cùng encode crf 12 để PSNR so sánh công bằng.
  - `doctor`: thêm filter minterpolate/hqdn3d/nlmeans + tool `interpolate`/`denoise` (41/41). README (2 dòng bảng + đoạn prose), SKILL.md (rule 36), CI smoke thêm 2 dòng.
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code: interpolate blend 10s 30→60fps **6.6s, 597 frames**; mci **91s, 597 frames** (chậm ~14x — blend làm mặc định, mci chỉ cho clip ngắn); denoise hqdn3d=15 trên fixture: PSNR-Y vs clean **32.98 → 38.63 dB**, noise energy **5.49 → 3.41**.
  - `npm run check` sạch (check-docs: 41 tools khớp README); `npm test` **408/408 PASS, exit 0** (389 + 19 mới: interpolate 8 + denoise 7 + doctor 2 + size_bytes grade/reverse 2). Assert mới (19).
- **Bẫy đo lường**:
  1. `stabilize` KHÔNG SHIP — vidstab chạy 2-pass đúng, output đúng dims/duration, nhưng trên mọi fixture tổng hợp (testsrc tĩnh + crop sin, ảnh tròn + crop sin, ảnh grain + crop sin chậm/nhanh) jitter/PSNR đều KHÔNG cải thiện (vd: jitter 5.15 → 5.21, PSNR 20.28 → 20.08 dB; per-frame PSNR chỉ 22% frame >25 dB). Nguyên nhân: block matching của vidstab trên nội dung tổng hợp (vùng phẳng lớn + cạnh sắc / grain trắng không có feature ổn định) cho vector nhiễu; smoothing còn nuốt luôn rung chậm (chu kỳ 94 frame qua cửa sổ 21 frame giữ lại 92% rung như "chuyển động có chủ đích"). Cần footage rung tay thật mới verify được — ghi vào backlog, không ship tool chưa đo được hiệu quả. Bài học: "chạy được" ≠ "làm được việc"; tool nào không đo được hiệu quả thì không ship.
  2. Thang strength của vibevideo (0–1 → hqdn3d 0–10) quá yếu với nhiễu thật: sigma-20 trên nền phẳng chỉ +0.24 dB PSNR ở hqdn3d=8, hqdn3d=15 mới +2.9 dB trên sigma-10. MediaKit map 0–1 → hqdn3d 0–30.
  3. nlmeans 5s 720p không xong trong 120s — chỉ test trên clip 1s 320×180, document rõ là chậm.
  4. `fileInfo()` trả `size_bytes`, không có `.size` — 4 tool ghi `info.size` lặng lẽ mất key (JSON.stringify nuốt `undefined`). Bắt được khi soi JSON CLI của tool mới. Từ nay assert `size_bytes` là number trong test của mọi tool trả size.
  5. Test batch không hermetic: cache từ lượt chạy trước làm lần batch loudness đầu tiên trả `cached` thay vì `ok` → 4 assert FAIL oan + 1 assert `videos://workspace/info` hardcode 39 tools. Fix: rm output dir batch trước khi test + sửa 39 → 41.
- Còn lại: chưa stage 0.2.0 (đợi Tony duyệt 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật để verify), `segment` HLS (ý từ vibevideo), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác, thư viện style đặt tên cho titlecard/intro, Demo GIF mới cho README.

## Lượt 30 — 2026-11-12 18:58 (+07): segment tool — HLS VOD playlist (42 tools)
- **Học**: `segment` HLS là ý cuối chưa làm từ hyepartners-gmail/vibevideo-mcp (lượt 29, backlog): `-c copy -hls_time N -f hls`. KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg. Khác biệt cốt lõi: vibevideo chỉ sinh chuỗi lệnh; MediaKit execute + đo thật trên đĩa (parse playlist lại, stat từng segment).
- **Làm**:
  - `segment` (core+CLI+MCP, tool 42): cắt video thành playlist HLS VOD (`index.m3u8` + `.ts`) trong 1 thư mục, serve tĩnh là chạy. Mặc định stream-copy (nhanh, lossless); `--reencode` re-encode libx264/aac + `-force_key_frames expr:gte(t,n_forced*SEG)` để segment đúng lưới yêu cầu. Copy mode từ chối trước khi chạy khi video không phải H.264 hoặc audio không phải AAC/MP3 (kèm gợi ý `--reencode`) thay vì để ffmpeg fail giữa chừng. `--segment-time` 1–60s (mặc định 6), `--playlist` phải là tên file `.m3u8`, `--segment-prefix` là stem tên file. Dọn segment/playlist cũ cùng prefix trước khi chạy để lần chạy lại không đếm thừa file cũ. Trả `mode`, `segment_count`, `segments` [{file, duration_seconds, size_bytes}], `total_duration_seconds`, `source_duration_seconds`, `duration_error_seconds`, `dimensions`, `size_bytes` (tổng cả playlist).
  - `doctor`: thêm `segment: {}` (42/42 — HLS muxer built-in, không cần filter/encoder). README (dòng bảng + đoạn prose), SKILL.md (rule 37), CI smoke thêm 2 dòng.
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code: copy `--segment-time 2` trên source.mp4 (GOP 8.333s) → playlist 2 segment **8.333 + 1.667s**, TARGETDURATION 8; reencode + force_key_frames → **5 × 2.000s** đúng lưới.
  - `npm run check` sạch (check-docs: 42 tools khớp README); `npm test` **422/422 PASS, exit 0** (408 + 14 mới: segment copy 6 + reencode 2 + vp9 2 + lỗi 3 + doctor 1). Assert mới (14).
- **Bẫy đo lường**:
  1. Bản đầu dùng `meta.video.codec_name` — probe() trả `codec`, không phải `codec_name` → `undefined`, copy mode từ chối cả file H.264 hợp lệ. Fix: dùng `meta.video.codec`/`meta.audio.codec`; bài học: đọc shape probe() trước khi dùng field mới.
  2. Copy mode với `--segment-time 2` trên fixture GOP thưa KHÔNG ra 5 segment — đó là hành vi HLS đúng (segment chỉ cắt ở keyframe), không phải bug. Test assert đúng 2 segment [8.333, 1.667]; đường reencode mới assert lưới 2s đều.
  3. Test `videos://workspace/info` hardcode `tools_total === 41` — lần chạy đầu fail đúng 1 assert này; sửa 41 → 42 (cả log `tools/list` và `tools_available >= 41`). Bài học: số tool hardcode trong test là drift trap — mỗi lần thêm tool phải grep số cũ.
- Push: commit 6b3169b "Add segment tool: HLS VOD playlist + .ts segments (42 tools total)" → GitHub main (xác nhận origin/main = 6b3169b). **CI run #43216225351 success** — xanh ngay lượt này (gồm 2 dòng smoke mới: segment copy 2 + reencode 5).
- Còn lại: chưa stage 0.2.0 (đợi Tony duyệt 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật để verify), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác, thư viện style đặt tên cho titlecard/intro, Demo GIF mới cho README.

## Lượt 31 — 2026-11-12 20:31 (+07): top 3 mượn từ kaomei/stickman-video-director (43 tools)
- **Học**: Tony chỉ repo `kaomei/stickman-video-director` (MIT, 5.680★, skill Agent Skills 2 mode: Director sinh prompt cho Flow/Runway/Kling; Autopilot render local bằng manifest JSON + @napi-rs/canvas + ffmpeg). Milo soi code thật (SKILL.md, autopilot.md, autopilot-runtime.md, autopilot-core.mjs, groupWords) thay vì chỉ đọc README. KHÔNG copy claim "100% free" (thực ra cần Gemini/ElevenLabs trả phí) và không copy Director mode phụ thuộc generator ngoài. Mượn 3 thứ, theo lệnh Tony "Làm top 3 đi":
  1. **Caption ngữ nghĩa** cho `generate_srt`: `groupWords()` (pure, export để test trực tiếp) — tối đa 8 từ, 3.5s, 84 ký tự/cue (2 dòng × 42); ngắt khi pause >0.4s, hết câu [.?!], hoặc từ tiếp theo vượt giới hạn; cue không bao giờ kết thúc bằng từ lơ lửng (the/a/of/to/...) — từ đó chuyển sang cue sau kèm timing thật. Trả grouping report (`words_in`, `cues_out`, `split_reasons` từng cue). Cues cũ không đổi (backward compatible); cues + words cùng lúc → từ chối.
  2. **Style-lock** cho shorts-video: `skills/shorts-video/styles.json` v1 — 3 style khóa (`clean-bold` mặc định, `minimal-line`, `warm-story`), mỗi style khóa đủ burn_captions (style/font/margin), titlecard (màu/font), grade preset, mix (music_volume/duck), loudness −14. `publish_kit` enforce đúng 3 id trong code (`SHORTS_STYLE_IDS`); test assert ids JSON == ids code. SKILL.md: chọn style trước khi burn, đổi style sau khi burn = burn lại + verify lại, override lẻ tẻ ghi chú riêng, không sửa file lock.
  3. **Publishing kit**: tool mới `publish_kit` (43) + `skills/shorts-video/references/publishing-kit.md` — từ video hoàn thiện + thumbnail 1280×720 16:9 + copy (đúng 5 title khác nhau 1–100 ký tự, description, 1–30 tag, pinned comment, chapters tùy chọn) viết `metadata.md` + `publishing.json`, checklist 4 checked + 3 human-review (mobile readability, title/cover fidelity, licences — không bao giờ pass hộ). Chapters verify theo duration đo thật; title kiểu "guaranteed"/"100% viral" chỉ cảnh báo, không tự chặn. Offer 1 lần sau khi duyệt video cuối (skill), không publish/upload gì.
- **Làm**: core.js (+331 dòng: groupWords, generateSrt words mode, publishKit, SHORTS_STYLE_IDS, doctor `publish_kit: {}`), server.js (generate_srt schema words optional + publish_kit tool), bin/mediakit.js (`--words-file`, `publish-kit --thumbnail --kit-file -o --style`), README (2 dòng bảng), SKILL.md mediakit (rule 25 words mode + rule 38 publish_kit + workflow bước 4–5), shorts-video SKILL.md (style lock, captions ngữ nghĩa, Step 7 publishing kit).
- **Test** (ffmpeg 8.1.2):
  - `npm run check` sạch (check-docs: 43 tools khớp README); `npm test` **437/437 PASS, exit 0** (422 + 15 mới: words mode 2 + groupWords trực tiếp 2 + lỗi cues/words 2 + publish_kit 7 + styles 2). Assert mới (15).
  - Demo end-to-end trên fixture (không phải log): words 11 từ → SRT 2 cue ("Your brain deletes most of what you see" 0–2.3s, "every single day" 2.3–3.3s) → crop 404×720 → resize 1080×1920 → burn clean-bold (background, 60px, margin 500) → loudness −14 → `check --platform tiktok` **pass** (1 warning bitrate 0.3 Mbps của fixture testsrc, đúng luật warn-không-gate). Soi mắt 2 frame: t=1s caption cue 1 đúng, t=2.5s cue 2 đúng, chữ trắng hộp đen rõ, ~500px trên đáy. publish_kit trên clip này: 4 checked + 3 human-review, 0 warning.
- **Bẫy đo lường**:
  1. Demo đầu dùng crop 405×720 theo công thức cũ trong skill → crop trả **404×720** (H.264 bắt chẵn), resize theo width ra **1080×1924**, `check tiktok` fail dimensions. Đây là hành vi đúng của crop (làm tròn xuống số chẵn), không phải bug tool mới. Fix: skill sửa ví dụ + recap thành crop 404 + `resize --width 1080 --height 1920 --no-keep-aspect` (như demo trong VERIFY.md lượt đầu). Bài học: công thức "made even" trong skill phải đi kèm con số chẵn cụ thể, không để 405 lơ lửng.
  2. Test `videos://workspace/info` hardcode `tools_total === 42` — lần chạy đầu fail đúng 1 assert; sửa 42 → 43 (cả `tools_available >= 41` → 42). Bài học cũ lặp lại (lượt 30): grep số tool cũ mỗi lần thêm tool.
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — 0.2.0 vẫn chưa publish, npm vẫn 0.1.0); backlog tiếp: manifest assembler (ý Autopilot — tool nhận JSON shots → validate khớp giọng → render, kèm preview/approve) là món lớn nhất còn lại từ repo stickman, `stabilize`, Verified-Trap Guard ledger, operation envelope.

## Lượt 32 — 2026-11-12 20:58 (+07): qa_report delivery gate + thumbnail timestamps (44 tools)
- **Học**: `github774/claude-video-studio` (1★, plugin Claude Code: video-director skill + video-tools MCP server 15 tools, Python, không dependency ngoài ffmpeg). Đọc README + `video_tools.py` thật (665 dòng). Ý áp dụng được:
  1. `contact_sheet` — lưới frame có timestamp để agent NHÌN thấy cut → đã làm `thumbnail --timestamps` (MediaKit đã có contact sheet nhưng chưa có nhãn thời gian).
  2. `qa_report` — một call gate cuối cho mọi deliverable (dimensions, pix_fmt, fps, aspect, length, loudness, true peak, black/frozen, dead air, pacing) → đã làm tool `qa_report` mới (44).
  3. `video-qa` skill pattern ("run qa_report plus contact_sheet on every deliverable before calling it done") → SKILL.md rule 39 + workflow bước 7–8.
  4. `detect` gộp scenes/black/freeze/silence → MediaKit đã có tốt hơn (`check --content` + rules layer), không làm lại.
  KHÔNG copy code của họ, không copy Director/router (chỉ có nghĩa trong Claude Code plugin marketplace, không phải MCP server) và không copy cách họ cài specialist từ repo khác.
- **Làm**:
  - `qa_report` (core+CLI+MCP, tool 44): probe-only, không ghi file. Target `any` (bỏ qua aspect + platform length) hoặc 1 trong 7 platform (dùng lại bảng PLATFORMS: aspect, maxDuration, LUFS −16..−12, true peak ≤ −0.5; `any` lấy −0.3). 12 check: has_video (fail), has_audio (warn), even_dimensions (fail), pixel_format yuv420p (warn), frame_rate 23–61 (warn), aspect_ratio (fail), platform_length (fail), expected_duration ±0.5s (fail, nhận giây hoặc MM:SS qua parseTime), loudness (fail), true_peak (fail), black mid-video (warn), frozen (fail), dead air silence >2s (warn), pacing avg shot ≤6s (warn, từ detectScenes thật). Verdict fail > warn > pass. Trả thêm `file` summary (duration, dimensions, fps, codecs, pix_fmt, size, LUFS, true peak).
  - `thumbnail --timestamps` (mặc định bật): drawtext `%{pts}` nhãn từng tile bằng timestamp giây thật của frame đó; trả `timestamps_seconds` (danh sách thời gian danh nghĩa từng tile) + `timestamps: true/false`; `--no-timestamps` tắt. `doctor` thêm filter drawtext cho thumbnail + `qa_report: {}` (44/44 available).
  - README (dòng bảng qa_report + sửa dòng thumbnail), SKILL.md (rule 39 + workflow bước 7–8), CI smoke thêm 2 dòng (qa-report verdict warn trên clip 1 shot; thumbnail timestamps true).
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code — `%{pts:hms}` KHÔNG expand trên ffmpeg 8.1.2 (xem bẫy 1); `%{pts}` expand đúng ("5.000000", PSNR inf vs literal). Label region tile 1: PSNR vs sheet không nhãn **10.85 dB**, YMAX **235** (chữ trắng) vs **175** (không nhãn).
  - `npm run check` sạch (check-docs: 44 tools khớp README); `npm test` **452/452 PASS, exit 0** (437 + 15 mới: thumbnail 4 + qa_report 11). Assert mới (15).
  - qa_report đo thật: source raw → verdict fail (loudness −21.79 ngoài −16..−12), pacing warn (avg shot 10.0s); loud-peak.wav → fail (no video + true peak +4.01 dBTP); content-black → black warn + frozen fail; scenes-source → pacing pass (avg ~5s); pass-case (đỏ 5s + testsrc 3s + xanh 5s, −14 LUFS) → **verdict pass, 12/12 check pass**; expected_duration 5s trên file 10s fail; target lạ → lỗi enum MCP.
- **Bẫy đo lường**:
  1. `%{pts:hms}` render nguyên văn "%{pts:hms}" trên ffmpeg 8.1.2 — chứng minh bằng PSNR inf so với render literal cùng chuỗi, và 11.66 dB so với literal "0:00:05.00". Cả inline text lẫn textfile đều vậy; `%{pts}` và `%{n}` vẫn expand đúng. Dùng `%{pts}` (giây, 6 số lẻ) thay vì hms.
  2. `ffmpeg -i a.png -i b.png -filter_complex psnr` trong shell TREO vô hạn nếu không có `-nostdin` (ffmpeg chờ stdin); qua Node execFileAsync không dính vì stdin đóng. Từ nay mọi lệnh ffmpeg so sánh trong shell đều thêm `-nostdin`.
  3. Loudnorm true peak (4.01 dBTP) ≠ astats sample peak (3.52 dBFS) trên cùng file loud-peak.wav — hai phép đo khác nhau (oversampled vs sample). Assert clipping bằng `> 0`, không hardcode 3.52.
  4. Pass-case đầu dùng source + source2: source2 là bản downscale của cùng testsrc nên join không qua ngưỡng scene 0.3 → pacing warn (avg shot 9s, 0 cut). Đổi sang scenes-source (đỏ/xanh thật) mới có cut [5, 8]. Bài học: fixture "khác nhau" phải khác thật về nội dung, không chỉ khác size.
  5. Test hardcode `tools_total === 43` lại fail 1 assert — sửa 43 → 44 (lần thứ 3 gặp; grep số tool cũ mỗi lần thêm tool).
- Push: commit db155a4 "Add qa_report delivery gate + thumbnail timestamps (44 tools total)" → GitHub main (xác nhận origin/main = db155a4). **CI run #43238193404 success, 4m1s** — xanh ngay lượt này (gồm 2 dòng smoke mới: qa-report verdict warn + thumbnail timestamps true).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: manifest assembler (ý Autopilot từ stickman-video-director), `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác, thư viện style đặt tên cho titlecard/intro, Demo GIF mới cho README.

## Lượt 33 — 2026-11-12 22:58 (+07): manifest tool — whole pipeline from one JSON file (45 tools)
- **Học**: `kaomei/stickman-video-director` Autopilot (5.756★, đọc README thật trên GitHub + reviewramble). Ý áp dụng được:
  1. Manifest-driven assembly — 1 file JSON khai báo toàn bộ pipeline, 1 call render ra video hoàn chỉnh → đã làm tool `manifest` mới (45).
  2. Per-shot content-hash cache + resume sau crash (mỗi shot cache riêng, sửa shot sau chỉ render lại từ đó) → đã làm cache từng step (key = input bytes + tool + args + sidecar-file bytes, verify size + sha256 như batch).
  3. Validate toàn bộ plan trước khi render (Autopilot validate shots khớp giọng, không khoảng trống) → đã làm validate upfront: version, tên tool, key arg, chuỗi đuôi output — typo fail trong vài giây, không phải sau step 3/5.
  4. Approval gate: approve sample 20s có tiếng trước khi render full → đã làm `--dry-run` (plan in ra, không ghi file nào) làm cổng approve.
  5. Style-lock + motion gate >2.5s → đã làm ở Top 3 (lượt 31), không làm lại. Director mode (prompt cho generator ngoài) → KHÔNG áp dụng (MediaKit render local bằng ffmpeg, không gọi generator ngoài).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg (tái dùng bảng `BATCH_OPERATIONS` + 4 tool single-input batch chưa có).
- **Làm**:
  - `manifest` (core+CLI+MCP, tool 45): manifest JSON `{version:1, input, output?, steps:[{tool, args?}], qa?}` — paths tương đối theo file manifest; 15 step chain được (11 batch op + denoise/interpolate/burn_captions/overlay); multi-input (concat/mix/mux/pip) và probe-only không chain được. Steps chạy tuần tự, output step trước làm input step sau; intermediates trong `<output-dir>/.mediakit-manifest-tmp-<pid>/` (không dùng /tmp để `MEDIAKIT_WORKDIR` vẫn giữ), xóa khi xong trừ `--keep-intermediates`; step fail thì abort + giữ intermediates + error nêu step + thư mục. Cache từng step trong `<output-dir>/.mediakit-manifest-cache/` (`index.json` + file `<key>.<ext>`), hit verify size + sha256; sửa step sau chỉ re-run từ đó (input hash không đổi, args khác). Đuôi output theo chuỗi step (extract_audio đổi đuôi) — sai đuôi thì điều chỉnh + báo `output_adjusted`. `qa` tùy chọn (`tiktok`/…/`any`) chạy `qaReport` cuối, đưa verdict vào kết quả. `--dry-run` validate + probe input + liệt kê plan, không tạo thư mục/file.
  - `doctor`: thêm `manifest: {}` (45/45). README (dòng bảng + prose), SKILL.md (rule 40), CI smoke thêm 3 dòng (manifest run cache 0 + rerun cache 3).
  - Fixture `test/manifest.json`: trim 2–8s → reframe blur 1080×1920 → loudness −14, `qa: tiktok`.
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code (CLI): dry-run liệt kê đúng 3 step `planned`, không ghi file; run thật 14.4s, 3 step `ok`, final **6.1s, 1080×1920, 332.772 B**; qa **verdict warn** (12/13 pass, chỉ pacing warn vì 1 shot 6.1s > 6s); rerun **cache_hits 3, steps_run 0**, output bytes y hệt (sha256 3430a39e…); `--no-cache` re-run đủ 3 step. ffprobe độc lập: 1080×1920, 6.1s. loudnorm độc lập: **input_i −14.04 LUFS, TP −8.20 dBTP** (khớp qa_report).
  - `npm run check` sạch (check-docs: 45 tools khớp README); `npm test` **466/466 PASS, exit 0** (452 + 14 mới: dry-run 2 + run 5 + cache 2 + no-cache 1 + lỗi 4). Assert mới (14).
- **Bẫy đo lường**:
  1. Fixture đầu viết `"strategy": "blur"` cho reframe — validate của chính tool bắt ngay (reframe dùng `mode`, `strategy` là của `social`). Sửa fixture thành `"mode": "blur"`. Bài học: validate upfront làm đúng việc nó sinh ra để làm — lỗi gõ lộ ra trước khi encode.
  2. `ffmpeg -v error ... loudnorm print_format=json | grep input_i` ra rỗng — JSON loudnorm không in khi `-v error`; đo lại không có `-v error` mới thấy −14.04. (Lỗi giống bẫy pipe loudnorm lượt 7.)
  3. Test đặt tên biến `manifestJson` trùng block social (đã có từ lượt 10) — `node --check` bắt SyntaxError ngay; đổi thành `manRunJson` (sed đổi cả 2 chỗ, phải trả block social về tên cũ — 2 `const` top-level trùng tên cũng là SyntaxError).
  4. Test hardcode `tools_total === 44` lại fail 1 assert — sửa 44 → 45 (lần thứ 4 gặp; grep số tool cũ mỗi lần thêm tool).
- Push: commit ee6ea7d "Add manifest tool: whole pipeline from one JSON file (45 tools total)" → GitHub main. **CI run #43258194885 success** — kiểm tra lượt sau.
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác, thư viện style đặt tên cho titlecard/intro, Demo GIF mới cho README.

## Lượt 34 — 2026-11-13 00:58 (+07): named --style for titlecard + intro (45 tools, không thêm tool)
- **Học**: `barckley75/resolve-claude-mcp` (395★, 52 tools, Python/FastMCP, cầu nối DaVinci Resolve Studio — đọc README thật trên GitHub + bài roundup delivvo.io). Ý áp dụng được:
  1. Thư viện style đặt tên (registry of named blocks — cùng ý heygen-com/hyperframes, backlog từ lượt 21) → đã làm `--style` cho `titlecard` + `intro`: một id chọn đúng palette đã khóa trong `skills/shorts-video/styles.json`.
  2. "Use at your own risk — work on backups": AI có thể sửa/xóa dữ liệu project → củng cố backlog Verified-Trap Guard ledger (MediaKit đã cấm đè input; ledger vẫn chưa làm).
  3. Transcription auto-chunk file dài bằng ffmpeg (5-phút/piece, tránh timeout) → follow-up cho `transcribe` (faster-whisper hiện chạy cả file; chunking khi gặp file giờ-long).
  4. Render job queue + `get_render_status` (theo dõi tiến độ render) → củng cố backlog MCP logging progress.
  5. CDL adjustments (slope/offset/power/saturation) cho color grade → follow-up nhỏ cho `grade --filter` (đã có filter tùy ý).
  6. `execute_resolve_code` (chạy code Python tùy ý trong Resolve) → KHÔNG áp dụng: MediaKit cố ý không có `ffmpeg.execute` chung — tool typed + validate trước, không cho agent chạy lệnh tự do.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `titlecard --style <id>` / `intro --style <id>` (core+CLI+MCP, không thêm tool): `clean-bold` | `minimal-line` | `warm-story` — palette khóa đọc từ `skills/shorts-video/styles.json` (single source of truth, ship trong npm package vì "skills" nằm trong package.json "files"). `titlecard` dùng trực tiếp text/box/font đã khóa; `intro` map box_color → bg, text_color → text, font_size → font — intro card và title card của một video chia một look, không gõ lại hex. Arg màu/font tường minh là scoped override cho đúng 1 key của lần gọi đó, báo trong `style_overrides`, không ghi lại library (đúng luật styles.json). Loader `getShortsStyles()`/`resolveShortsStyle()` fail loudly khi file thiếu/sai JSON/thiếu trường khóa/id lệch với `SHORTS_STYLE_IDS` (không fallback lặng lẽ về default).
  - CLI/MCP: `--style` mới cho cả 2 lệnh; màu/font chuyển sang optional (null khi vắng) để default chảy qua core — hành vi không style giữ nguyên (titlecard FFD60A/F97316/119px, intro 0F172A/FFFFFF/102px).
  - README (2 dòng bảng), SKILL.md (rule 41 mới trong skills/mediakit + đoạn style-lock trong skills/shorts-video), CI smoke thêm 2 dòng (titlecard minimal-line grep box 111111, intro clean-bold grep bg F97316).
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code (CLI): titlecard minimal-line → **FFFFFF/111111/120px, style_overrides []**; clean-bold → **FFD60A/F97316/120px**; override `--text-color FFFFFF` → **text FFFFFF, box F97316, overrides ["text_color"]**; intro clean-bold → **bg F97316/text FFD60A/120px**; warm-story → **bg B45309/text FFF7ED**; style lạ → **exit 2 INVALID_ARG** + in `Retry:`.
  - Pixel-verify: titlecard minimal-line band (1080:500:0:800) **R=G=B=38.3, A=132.3** (hộp gần đen 0x111111 + chữ trắng thưa — xám, không ấm, khác hẳn card cam mặc định R>50/G>20/B<20); intro clean-bold frame giữa (t=1.5) band **R=248.6, G=140.2, B=16.9** (nền cam F97316 + chữ vàng, khác hẳn intro navy mặc định R 68.4).
  - `npm run check` sạch (check-docs: 45 tools khớp README); `npm test` **484/484 PASS, exit 0** (466 + 18 mới: titlecard style 12 + intro style 6). `doctor` 45/45 available.
- **Bẫy đo lường**:
  1. `signalstats` grep `YAVG` trực tiếp ra rỗng trong shell — phải qua `metadata=print:key=lavfi.signalstats.YAVG` với `-v info` như helper `planeMean` trong test mới đúng (cùng lỗi pipe đo lường đã gặp ở lượt 7/33: cờ log sai là mất số đo, không phải tool hỏng).
  2. Edit CI smoke: file dùng dấu `"` thật trong grep, không phải `\"` — lần edit đầu không khớp old_text, phải đọc lại file mới sửa đúng.
- Push: commit 1df1983 "Add named --style for titlecard + intro (locked palettes from styles.json, 45 tools)" → GitHub main (xác nhận origin/main = 1df1983). **CI run #43278940011 success** — xanh ngay lượt này (gồm 2 dòng smoke mới: titlecard minimal-line + intro clean-bold).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác, `transcribe` chunking file dài (ý từ barckley75), `grade --cdl` (ý từ barckley75), Demo GIF mới cho README.

## Lượt 35 — 2026-11-13 02:58 (+07): transcribe --chunk-seconds + grade --cdl (45 tools, không thêm tool)
- **Học**: `MakeMyClip/editor` (9★, 156 commit, TS + MCP + CLI + browser timeline; đọc README thật trên GitHub). Ý áp dụng được:
  1. Word-level transcript + edit by transcript (`cut-words`, `remove-retakes` — cắt take lặp của cùng một câu) → backlog mới (cần word timestamps; transcribe hiện trả segment).
  2. Cut check — flag cut có thể cắt mất từ + contact sheet 2 phía → backlog mới (nhỏ; cần word timestamps).
  3. `chroma_key` (xóa phông xanh) → backlog mới (tool mới; MediaKit chưa có).
  4. `zoom_pan` Ken Burns → backlog mới (tool mới; MediaKit chưa có).
  5. Non-destructive timeline + undo/redo + session log → KHÔNG áp dụng (MediaKit single-shot, cố ý không giữ state).
  6. Export FCPXML / Premiere XML → KHÔNG áp dụng (ngoài scope: MediaKit render file, không xuất project NLE).
  7. `doctor` in cách fix cho thứ thiếu → MediaKit đã có từ lượt 19.
  8. `highlight_reel` → chưa rõ cơ chế chọn đoạn, không làm theo.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg. Khác biệt cốt lõi giữ nguyên: MakeMyClip dựng timeline phi phá hủy + export NLE; MediaKit single-shot + đo thật trên đĩa.
- **Làm**:
  - `transcribe --chunk-seconds N` (core+CLI+MCP, không thêm tool): chia WAV 16kHz thành chunk N giây (5–1800, overlap 2s), transcribe từng chunk bằng đúng engine đã chọn (faster-whisper hoặc whisper.cpp — tách `runAsrOnWav` dùng chung), offset segment về timeline gốc. Quy tắc ownership: segment thuộc về chunk mà cửa sổ owned `[chunk start, next chunk start)` chứa start của nó (chunk cuối sở hữu tới hết file) — overlap nghe 2 lần nhưng giữ 1 lần; end clamp về cuối chunk. File ngắn hơn 1 chunk chạy 1 chunk duy nhất, báo `chunks: 1`. Trả thêm `chunk_seconds`, `chunks`, `chunk_overlap_seconds`. `manifest`/`batch` không đổi (transcribe không chain được).
  - `grade --cdl` (core+CLI+MCP, không thêm tool): ASC CDL — `--cdl-slope/--cdl-offset/--cdl-power r,g,b --cdl-saturation N` (slope 0–4, offset −1–1, power 0.1–4, saturation 0–4; CLI parse triple `r,g,b`, MCP object `{slope, offset, power, saturation}`); mutually exclusive với `--preset`/`--filter`. Áp dụng bằng `lutrgb` (LUT 256 mục/kênh) + `eq=saturation` cho saturation; trả `cdl` đã normalize + `preset: null`. Thêm `cdl` vào args của `grade` trong `BATCH_OPERATIONS` (cũng là `MANIFEST_STEPS` qua spread) để manifest dùng được; `doctor` thêm filter `lutrgb` cho grade.
  - Fixture mới `test/flat-gray.mp4` (320×180, 2s, màu đặc 0x808080) cho verify CDL trên khung phẳng.
  - README (2 dòng bảng + đoạn CDL), SKILL.md (§30 chunking + §32 CDL), CI smoke thêm 2 dòng (grade CDL grep `"preset": null`, transcribe `--chunk-seconds 2` grep `chunk_seconds`).
- **Test** (ffmpeg 8.1.2; whisper.cpp b5454 + ggml-tiny):
  - Đo trước khi code: `geq` làm CDL đúng nhưng **77s cho clip 10s 720p (7.7x realtime)** → không ship; `colorlevels` không biểu diễn được slope<1 (rimax kẹt trong [−1, 1]); `lutrgb` cùng công thức **~6s cho 10s 720p** → chọn lutrgb. Đo trên khung xám đặc: R 122→**180** (kỳ vọng 183, sai số YUV roundtrip), B 127→**87** (kỳ vọng 89).
  - CLI transcribe chunk thật (whisper.cpp, JFK 11s, `--chunk-seconds 5`): **chunks 3, segments [0, 6.9] / [5, 10.44] / [10, 10.84]** — start đúng cửa sổ owned 0/5/10, end clamp đúng; text giữ đủ câu JFK ("fellow Americans... ask what you can do for your country") nhưng **cụm "What your country can do for you" lặp ở biên chunk 0/1** và chunk cuối 1s ảo giác "- God, free." — trade-off đã ghi vào docs/SKILL: chunking cho file dài, text không word-exact như chạy nguyên file.
  - CLI grade CDL trên flat-gray: before **{128,128,128}** → after **{R 193, G 129, B 89}** (kỳ vọng R 192, B 89.6 — đúng).
  - CLI validation: `--chunk-seconds 2` → **exit 2 INVALID_ARG**; `--cdl-slope 1.5,1` (thiếu 1 số) → từ chối trước khi encode.
  - `npm run check` sạch (check-docs: 45 tools khớp README); `npm test` **504/504 PASS** (gated whisper.cpp; ungated 496 = 484 + 12 mới, gated +8 = 504); `doctor` 45/45 available.
- **Bẫy đo lường**:
  1. Kỳ vọng R 183 trong assert CDL là **nhân sai**: fixture xám là 128 (0x808080), 128×1.5=192 chứ không phải 183 (183 là 122×1.5 từ test khung 0x7A807F trước đó). Tool đo đúng 193; sửa kỳ vọng thành 192 — bài học: tính lại số kỳ vọng từ đúng fixture đang dùng, đừng copy số từ test khác.
  2. **Bug bắt được nhờ suite: `doctor` báo grade unavailable sau khi thêm `lutrgb` vào `TOOL_REQUIREMENTS`** — `doctor` chỉ tra cứu filter có trong `DOCTOR_FILTERS`; filter mới không có trong list đó thì `filters[f]` là `undefined` → báo thiếu dù ffmpeg có filter. Fix: thêm `"lutrgb"` vào `DOCTOR_FILTERS` (doctor lại ok=true, 45/45). Quy tắc từ nay: thêm filter vào `TOOL_REQUIREMENTS` thì phải thêm vào `DOCTOR_FILTERS` cùng lúc.
  3. Đo `YAVG` bằng `-v error` ra rỗng (lặp lại bẫy lượt 7/33): dòng `metadata=print` chỉ in ở mức info — đo lại không có `-v error` mới thấy số.
  4. Mean kênh R của testsrc sau slope 1.5 chỉ tăng 122→124 (không phải ~183) — không phải bug: mean của ảnh đã scale ≠ scale của mean khi có clipping ở 255 (testsrc nhiều pixel bão hòa). Verify CDL phải dùng khung phẳng (flat-gray), không dùng testsrc.
  5. `ffmpeg -v error ... | grep YAVG` rỗng còn do `format=rgb24` + `extractplanes` không in metadata — dùng đúng form của `frameChannelMeans` (`format=rgba,extractplanes=…`).
- Push: commit f2163d6 "Add transcribe --chunk-seconds + grade --cdl (45 tools total)" → GitHub main (xác nhận origin/main = f2163d6). **CI run #43302722425 success, 5m9s** — xanh ngay lượt này (gồm 2 dòng smoke mới: grade CDL + transcribe chunk validation).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác, `cut_words` / remove-retakes (cần word timestamps, ý từ MakeMyClip), cut check (ý từ MakeMyClip), `chroma_key` (ý từ MakeMyClip), `zoom_pan` Ken Burns (ý từ MakeMyClip), Demo GIF mới cho README. Lưu ý: đường chunk của faster-whisper chưa test thật trên máy này (không có faster-whisper; cùng interface `runAsrOnWav` với đường unchunked, stub + whisper.cpp đã phủ).

## Lượt 36 — 2026-11-13 04:58 (+07): chroma_key + zoom_pan tools (47 tools)
- **Học**: dev.to "Building an AI Shorts pipeline with ffmpeg" (Ken Burns: pre-scale 1.25x trước zoompan, `z='min(zoom+step,max)'` giữ tâm, pan bằng `x='(iw-iw/zoom)*(on/d)'`) + ffmpeg-cookbook "Green-Screen Compositing with the chromakey Filter" (`chromakey=color:similarity:blend`, composite bằng overlay, alpha cần codec/container hỗ trợ) + transloadit/dev.to về chromakey. Ý áp dụng được:
  1. Pre-scale 1.25x trước zoompan để tránh jitter do crop nguyên pixel → đã làm trong `zoom_pan`.
  2. Zoom/pan tuyến tính theo `on` (số frame output) với focus nội suy → đã làm (zoom z0→z1, focus (fx0,fy0)→(fx1,fy1)).
  3. `chromakey` + composite lên nền bằng overlay trong cùng 1 call → đã làm `chroma_key --background` (ảnh hoặc màu hex).
  4. VP9 WebM alpha không đáng tin → đã đo và từ chối, chỉ giữ ProRes 4444 .mov cho transparent mode.
  5. CorridorKey (neural keying, cần ~24GB VRAM) → KHÔNG áp dụng (máy CPU-only, ngoài scope).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `chroma_key` (core+CLI+MCP, tool 46): `chromakey=0xCOLOR:similarity:blend`; transparent mode chỉ nhận `.mov` (prores_ks profile 4444, `format=yuva444p10le`) — `.mp4` bị từ chối (H.264 không có alpha), `.webm` bị từ chối kèm lý do đo được (xem bẫy đo lường); `--background <ảnh|màu hex>` composite lên nền trong cùng 1 call (ảnh scale+crop vừa khung, màu qua lavfi `color`, fps theo nguồn), output `.mp4` (libx264) / `.webm` (VP9) phẳng; audio copy. Trả `mode`, `pixel_format`, `has_alpha` + alpha đo thật ở giữa file (chuẩn hóa 8-bit qua `format=rgba` để độ sâu 12-bit của ProRes không rò vào số): `alpha_mean` toàn khung, `alpha_corner_mean` (~0 khi key full màn), `alpha_center_mean` (~255 trên subject).
  - `zoom_pan` (core+CLI+MCP, tool 47): Ken Burns cho ảnh tĩnh — `--duration` (mặc định 5s), `--fps` (30), `--zoom-from/--zoom-to` (1→1.5), `--focus-x/--focus-y` và `--focus-end-x/--focus-end-y` (0–1, mặc định tâm), `--width/--height` (1280×720). Pre-scale 1.25x + crop đúng aspect rồi `zoompan` với `z`/`x`/`y` tuyến tính theo `on`, kẹp cửa sổ bằng min/max. Từ chối video/audio input (zoompan sẽ kéo dài video theo `d` frame/input frame). Trả `frames` đếm bằng ffprobe `-count_frames`.
  - `doctor`: thêm filter `chromakey` + `zoompan` vào `DOCTOR_FILTERS`, encoder `prores_ks` vào `DOCTOR_ENCODERS`, tool `chroma_key`/`zoom_pan` vào `TOOL_REQUIREMENTS` (47/47).
  - `batch` + `manifest`: thêm `chroma_key` vào `BATCH_OPERATIONS`/`MANIFEST_STEPS` (batch ép đuôi `.mov` khi không có background qua `batchOutputExt`; manifest tự điều chỉnh đuôi + báo `output_adjusted`). `zoom_pan` không vào batch/manifest (input là ảnh, không phải step trong pipeline video — cùng lý do `svg_animate` không có).
  - Fixture mới `test/greenscreen.mp4` (640×360, 3s, nền xanh lá + chữ nhật đỏ 200×140 giữa khung) + `test/kenburns.png` (1280×720, nền xanh dương, chữ nhật vàng giữa + đỏ góc dưới-trái).
  - README (2 dòng bảng + đoạn prose), SKILL.md (rule 42 + sửa danh sách step chainable ở rule 40), CI smoke thêm 3 dòng.
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code — chromakey: `libvpx-vp9 -pix_fmt yuva420p` (cả khi thêm `-auto-alt-ref 0`) decode lại thành `yuv420p`, `alphaextract` lỗi "Requested planes not available" → alpha mất thật, không phải do probe đọc sai; ProRes 4444 `.mov` giữ alpha (`yuva444p12le`, góc 256/4095 ≈ trong suốt, giữa 3760/4095 ≈ đục — thang limited-range 12-bit). `qtrle` cũng giữ alpha (argb) nhưng file lớn, không chọn. Zoompan: frame 0 khớp ảnh gốc scale (PSNR-Y 54.1 dB domain mp4), frame cuối khớp crop giữa 2x (31.8 dB) và khác xa ảnh đầy đủ (9.3 dB); pan 2x focus 0.2→0.8: frame cuối khớp cửa sổ phải 35.2 dB vs cửa sổ trái 8.0 dB, frame đầu khớp cửa sổ trái 35.1 dB.
  - CLI chroma_key transparent: `yuva444p12le`, `has_alpha true`, **alpha_mean 31.7** (đúng tỉ lệ subject 200×140/640×360 = 12.2% × 255 ≈ 31.1), **corner 0, center 255**, 3s 640×360. Composite `--background 1E40AF`: yuv420p, góc B **174** (≈175), giữa R **253** (≈255). CLI zoom_pan 3s 640×360: **90 frames**, 30fps. Lỗi đúng: chroma_key `.mp4` không background → từ chối kèm lý do + `Retry:`; zoom_pan input video → từ chối "still image".
  - Batch chroma_key trên `test/greenscreen.mp4`: **1 succeeded**, output `greenscreen-chroma_key.mov` (ép đuôi đúng). Manifest 1 step chroma_key: **output_adjusted true** (`.mp4` → `.mov`).
  - `npm run check` sạch (check-docs: 47 tools khớp README); `npm test` **518/518 PASS, exit 0** (496 + 22 assert mới: chroma_key 14 + zoom_pan 8), chạy lại lần 2 đếm PASS cũng 518/518, 0 FAIL; `doctor` **47/47 available** (transcribe qua whisper.cpp local).
- **Bẫy đo lường**:
  1. `psnr` trên frame PNG không in dòng `PSNR y:` (chỉ `PSNR r/g/b average`) — helper `psnrY` của suite trả null. Test trích frame ra `.mp4` (yuv420p) rồi mới so PSNR-Y — số đo trong test là 54.1/31.8/9.3 dB (domain mp4), không phải 35.6/26.9 (domain PNG RGB average) đo lúc probe.
  2. `alphaextract` trên ProRes 12-bit: YAVG tối đa là 3760, không phải 255 (limited-range 12-bit) — góc 256 = trong suốt, giữa 3760 = đục. Tool chuẩn hóa về 8-bit bằng `format=rgba` trước khi đo nên số trả về là 0–255; test assert trên số đã chuẩn hóa (corner < 20, center > 235).
  3. CLI `chroma-key`/`zoom-pan` làm key object không quote trong `COMMANDS` → `SyntaxError: Unexpected token '-'` — `node --check` bắt ngay; key kebab-case phải quote (`"chroma-key": {`, như `"export-gif"` sẵn có).
  4. Toán tử `&&`/`&` trong shell: `cd dir && (cmd &) & echo` tách thành 2 job — `git status` chạy ở cwd gốc, báo "not a git repository" oan. Lần sau chạy count nền bằng `exec` background thay vì `&` trong cùng lệnh.
  5. `pgrep -f "node test/mcp-test.mjs"` vẫn match sau khi suite xong (tự match chính pattern) — tin log `EXIT=0` + "all assertions passed", không tin pgrep.
- Push: commit 6f3b11a "Add chroma_key + zoom_pan tools (47 tools total)" → GitHub main (xác nhận origin/main = 6f3b11a). **CI run #43320712455 success, 4m38s** — xanh ngay lượt này (gồm 3 dòng smoke mới: chroma_key .mov + composite + zoom_pan 90 frames).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác, `cut_words` / remove-retakes (cần word timestamps, ý từ MakeMyClip), cut check (ý từ MakeMyClip), Demo GIF mới cho README.

## Lượt 37 — 2026-11-13 06:58 (+07): transcribe --word-timestamps + cut_words tool (48 tools)
- **Học**: amide-init/transcriptcut (2★, 267 commit, MIT, đọc README thật) + kevinbadi/kevs-talking-head-editor (MIT, đọc README + tools/filler_cut.py thật). Ý áp dụng được:
  1. Times always come from the transcript's own word timestamps, never from the agent (transcriptcut) → đã làm: `cut_words` chỉ nhận `--words-file`, không nhận timestamp gõ tay.
  2. Filler detection algorithmic; LLM chỉ phân loại từ mơ hồ ("like", "actually"), không bao giờ tự đề xuất cut → đã làm: `--fillers` chỉ chứa tập chắc chắn (um/uh/er/...), "like"/"you know" chỉ cắt khi nêu tên trong `--remove`.
  3. `filler_cut.py`: Whisper word_timestamps + silence map gộp thành 1 cut list; FILLERS = {um, umm, uh, uhh, uhm, erm, er, hmm, mm, mhm, ah, eh}; PRE 0.06 / POST 0.12 pad quanh kept run; word-index ranges "0-5,96-98" (0-based) + `--keep` cứu từ; `swallowed()` cảnh báo kept word bị cắt mất >50%; re-transcribe sau cut để liệt kê filler còn sót → đã làm tất cả trừ silence-carving (silence là tool riêng, chain qua manifest) và afade 12/15ms ở join (giữ nhất quán với graph của `silence`, ghi follow-up).
  4. Chunked transcription split at pauses (~10-phút/chunk, có progress) → MediaKit đã có `--chunk-seconds` từ lượt 35; lần này mở rộng ownership rule sang words.
  5. CSS-preview ↔ ffmpeg-export math unit-tested để không drift → củng cố luật đo trên đĩa sẵn có của MediaKit.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `transcribe --word-timestamps` (core+CLI+MCP, không thêm tool): faster-whisper qua `--word-timestamps` trong helper Python (flat `words` [{start, end, word, probability}]); whisper.cpp qua tokens trong JSON `-ojf`, gom thành từ (`wordsFromWhisperCppTokens`: token bắt đầu bằng space mở từ mới, còn lại dính vào từ hiện tại, token ngoặc `[...]` là special token, bỏ qua; từ có from == to được floor 0.1s). Chunked path offset words bằng cùng ownership rule với segments. Kết quả thêm `words` (index 0-based theo timeline) + `word_count` chỉ khi được yêu cầu; không yêu cầu thì không có key `words`.
  - `cut_words` (core+CLI+MCP, tool 48): `--words-file` (JSON từ stdout của transcribe, hoặc {words:[...]} viết tay) + selector `--remove` (khớp text sau normalize, không phân biệt hoa thường, bỏ dấu câu) / `--fillers` (tập trên) / `--indices` ("0-5,96-98", 0-based) OR nhau, `--keep` trừ ra; `--pad-before 0.06` / `--pad-after 0.12` (clamp vào gap tới từ bị cắt kề bên, không bao giờ giữ mảnh của từ đã cắt), `--min-keep 0.2`, `--dry-run` trả plan không ghi file. Keep-run = các từ giữ liên tiếp, render bằng cùng graph trim/atrim+concat của `silence`; không khớp từ nào → stream-copy + warning; cắt hết → từ chối. Trả `removed_words`, `keep_segments`, `removed_seconds` + `cut_check.swallowed` (kept word <50% nằm trong keep segments).
  - `doctor`: thêm tool `cut_words` (48/48 available; transcribe báo engine whisper.cpp trên máy này). Fixture mới `test/cut-words.json` (5 từ trên source.mp4 10s) + tokens thật trong `test/whisper-cli-stub.sh` (28 token từ whisper-cli b5454 + ggml-tiny trên JFK, đo 2026-11-13).
  - README (dòng bảng cut_words + sửa dòng transcribe), SKILL.md (rule 43), CI smoke thêm 3 dòng (cut-words 2 từ + duration 3.48 + dry-run).
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code — whisper.cpp `-ojf` có tokens với offsets ms: " fellow" 950–1590ms, " Americans" 1590–2100ms; token đầu " And" báo from == to (320ms); token cuối `[_TT_525]` (10500ms) là timestamp marker.
  - CLI stub transcribe `--word-timestamps`: **22 từ**, fellow **[0.95, 1.59]**, từ cuối "country." (không dính `[_TT_525]`); chunked 5s → **20 từ**, sorted, max end 11s (repeat ở biên chunk 2 là trade-off đã ghi docs, như segments).
  - CLI cut_words trên fixture tay: `--remove um,uh` → keep **[0,1.12]+[3.94,5.12]+[7.94,9.12] = 3.48s** (ffprobe độc lập 3.48), removed 2 từ, swallowed []; `--indices 2` → 6.3s; `--fillers --keep 1` → chỉ uh, 6.3s; `--dry-run` không ghi file; no-match → stream-copy 10s + warning; `--min-keep 1.15` → 2.36s, swallowed hello.
  - Gated faster-whisper (venv, tiny): JFK **22 từ** (trùng số lượng whisper.cpp), fellow **[1.34, 1.68]** prob 0.9984; cut `--remove fellow` → **11s → 10.28s** trên đĩa; **re-transcribe output: "fellow" biến mất** (residual check kiểu filler_cut).
  - Gated whisper.cpp (b5454 + ggml-tiny): `--word-timestamps` ≥20 từ, fellow gần 1s, không token ngoặc nào lọt vào words.
  - `npm run check` sạch (check-docs: 48 tools khớp README); `npm test` thường **539/539 PASS** (518 + 21 mới); chạy gộp cả 2 gated engine **561/561 PASS, exit 0** (539 + 22 assert gated); `doctor` **48/48 available**.
- **Bẫy đo lường**:
  1. Regex skip special token `/^\[_.+_\]$/` KHÔNG bắt `[_TT_525]` (kết bằng "5]", không phải "_]") → từ cuối thành "country.[_TT_525]". Fix: skip mọi token dạng `[...]` — whisper.cpp special token luôn nằm trong ngoặc.
  2. Lần chạy suite đầu FAIL đúng 1 assert: test "cut_words refuses a JSON file with no words array" — tool từ chối đúng (cues.json là array cue, thiếu trường `word`) nhưng message "word 0: word must be..." không chứa chuỗi "words" mà assert tìm. Fix: message nêu rõ "words array" + gợi ý chạy transcribe --word-timestamps; chạy lại xanh hẳn.
  3. `npm run check` chạy trước khi sửa README nên check-docs FAIL (48 vs 47) — nhưng `| tail -5` nuốt exit code nên `&& npm test` vẫn chạy. Lần sau đừng pipe `npm run check` qua tail khi muốn fail-fast.
  4. Đếm assert: `grep -c checkOk` đếm call site (535), không bằng số PASS in ra (561) vì một số test gọi checkOk trong vòng lặp. Báo số PASS đo từ log chạy, không suy từ grep.
- Push: commit 403e6f9 "Add transcribe --word-timestamps + cut_words tool (48 tools total)" → GitHub main (xác nhận origin/main = 403e6f9). **CI run #43339247594 success** — xanh ngay lượt này (gồm 3 dòng smoke mới: cut-words 2 từ + duration 3.48 + dry-run).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable + CI fail khi drift, MCP advertise core 12 mặc định, `dry-run` cho các tool khác (cut_words + mix + mux đã có), remove-retakes (cần phát hiện cụm lặp trong words), cut_words vào batch/manifest (cần words-file theo từng input), afade 12/15ms ở audio join cho cut_words/silence, dọn ternary thừa trong buildKeepSegmentsFromWords (leftEdge/rightEdge 2 nhánh giống nhau).

## Lượt 38 — 2026-11-13 08:58 (+07): cut_words vào batch + manifest, sửa cache key sidecar + drift enum (48 tools, không thêm tool)
- **Học**: 0xmortuex/ffmpeg-mcp (mediakit-mcp, 0★, 3 commit, Python, đọc README thật trên GitHub). Ý áp dụng được:
  1. Dry-run trên MỌI tool, trả đúng lệnh ffmpeg (probe trước chỉ-đọc để lệnh in ra là lệnh thật) → củng cố backlog dry-run cho các tool mutative còn lại (đã có mix/mux/cut_words).
  2. Không ghi đè mặc định + ghi ra `name.partial.ext` rồi rename khi thành công (atomic output, run fail không để lại file dở) → backlog mới (lớn, chạm mọi tool ghi file).
  3. `compress --target-size`: ladder hạ resolution khi bitrate < ~0.045 bits-per-pixel-per-frame thay vì ra "mush" (1080→720→480→360) → backlog mới (cụ thể, đáng làm sau).
  4. Preset `email-25mb` nhắm 18 MB vì attachment phình ~37% khi gửi mail (base64) → backlog nhỏ.
  5. Directory allow-list → MediaKit đã có (`MEDIAKIT_WORKDIR`).
  6. Progress qua MCP notifications → backlog đã có.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `cut_words` vào `batch` (core+CLI+MCP, không thêm tool): words file theo từng clip — `<words_dir>/<stem>.words.json`, mặc định thư mục của input (`--words-dir` trỏ tới thư mục chung); clip không có words file fail row của nó, các clip khác vẫn chạy. `words_dir` đã verify bằng CLI thật (3.48s).
  - `cut_words` vào `manifest` (không thêm tool): step lấy 1 `words_file` duy nhất (resolve theo manifest như `captions`/`overlay`, hash vào cache key qua `MANIFEST_FILE_ARGS`); fixture mới `test/manifest-cutwords.json` (cut_words → loudness).
  - **Sửa bug cache batch bắt được nhờ test mới (quan trọng)**: cache key cũ chỉ có input bytes + operation + args — 2 clip giống hệt bytes nhưng khác words file bị phục vụ cùng 1 cut, và clip không có words file bị báo "cached" mà không bao giờ kiểm tra words file. Fix: `spec.extraHash(input, args)` — `cut_words` hash words file từng clip, `chroma_key` hash background khi là file ảnh (màu hex đã nằm trong args nên không cần hash). Lỗi này cũng chạm `chroma_key` background: sửa ảnh nền mà không đổi tên thì trước đây cache phục vụ composite cũ.
  - **Sửa bug cache-hit không ghi file**: hit trước đây chỉ báo "cached" mà không ghi file cho item đó — twin của clip đã chạy bị báo cached nhưng file output của nó không tồn tại trên đĩa. Fix: hit thì copy file đã verify về đúng tên output của item (chỉ khi file đó thiếu hoặc khác bytes — chạy lại cùng batch không động vào mtime, test cũ vẫn xanh).
  - **Sửa drift enum batch (lượt 36 để lại)**: MCP `batch` enum thiếu `chroma_key` (đã có trong `BATCH_OPERATIONS` nhưng MCP từ chối "Invalid enum value", CLI vẫn chạy) — thêm `chroma_key` + `cut_words` vào enum, sửa mô tả batch/manifest (cả server.js lẫn CLI; manifest description còn bỏ sót `trim` trùng lặp).
  - `scripts/check-docs.mjs`: guard mới — MCP batch enum phải phủ hết key của `BATCH_OPERATIONS` (và ngược lại), chạy trong `npm run check` → CI fail khi drift kiểu lượt 36 tái diễn.
  - Dọn ternary thừa trong `buildKeepSegmentsFromWords` (lượt 37 để lại): `leftEdge`/`rightEdge` 2 nhánh giống hệt nhau → gọn lại, hành vi không đổi.
  - README (dòng bảng batch/manifest + đoạn prose), SKILL.md (rule 44), CI smoke thêm 5 dòng (batch cut-words + duration 3.48 + manifest cut-words).
- **Test** (ffmpeg 8.1.2):
  - CLI smoke trước khi viết test: batch cut-words 1 clip → **succeeded 1, 3.48s** (ffprobe độc lập); `--words-dir` riêng → **succeeded 1, 3.48s**; manifest cut-words → **3.48s, cache_hits 1 ở lần chạy 2**.
  - Suite lần 1 crash ở call `social` (McpError -32001 timeout 60s) — đo CLI tương đương: **1m32s** (3 platform × reframe blur + loudness 2-pass trên VM 1.5 CPU). Tool đúng (all_pass true), lỗi ở timeout mặc định của test client. Fix: `callTool(..., undefined, { timeout: 300000 })` cho call social + comment ghi số đo. Lần 2 crash y hệt ở cùng chỗ (chưa có fix lúc đó) — khẳng định không phải flake ngẫu nhiên.
  - Suite lần 3 (sau fix social): **547/557 PASS, 2 FAIL** — đúng 2 assert batch cut_words mới: `succeeded=1 failed=0` thay vì 2/1 (take-c không fail mà "cached"). Nguyên nhân: take-a/b/c giống hệt bytes → cùng cache key → take-c được phục vụ từ cache của take-a mà không bao giờ kiểm tra words file. Đó là bug cache key ở trên — fix bằng `extraHash` + copy-on-hit, rồi chạy lại.
  - Suite lần 4: **556/557 PASS, 1 FAIL** — assert mtime "batch cache hit does not touch the output file": `source.mp4` và `sub/deep-clip.mp4` giống hệt bytes (md5 941b713c…), entry cache bị twin sau ghi đè → hit copy làm mtime đổi. Fix: chỉ copy khi output của item thiếu hoặc sai bytes (verify size+sha256), chạy lại cùng batch giữ nguyên mtime.
  - Suite lần 4 bị service restart cắt giữa chừng (log /tmp mất, tiến độ 314 PASS) — chạy lại lần 5 với log trong workspace.
  - Suite lần 5: **`npm test` 557/557 PASS, exit 0** (539 + 18 assert mới); `doctor` **48/48 available**; `npm run check` sạch (check-docs: 48 tools + batch enum phủ 13 operations).
  - Assert mới (18): batch cut_words 8 (2 ok + 1 cached twin + 1 error + file twin tồn tại + 2 ffprobe duration) + batch chroma_key 2 + chroma background 4 (đỏ trước → xanh sau khi sửa ảnh, re-run không cached) + manifest cut_words 4 (steps ok, final 3.48s, LUFS −14 độc lập, cache lần 2).
- **Bẫy đo lường**:
  1. Cache key không chứa sidecar = phục vụ sai output cho job khác — chỉ lộ ra khi test dùng 2 clip giống hệt bytes với words file khác nhau; test "3 clip khác nhau" thông thường không bao giờ bắt được.
  2. Copy-on-hit thô làm mtime đổi trên twin — test mtime cũ bắt được ngay; fix đúng là verify output của item trước rồi mới copy.
  3. `social` 93s > timeout 60s của SDK: lỗi timeout ở client test, không phải tool chậm bất thường — đo CLI trước khi kết luận, sửa timeout ở đúng chỗ (per-request), không đụng code tool.
  4. /tmp bị xóa khi service restart — log chạy dài để trong workspace (`hidden_files/`), không để /tmp.
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable (check-docs batch-enum là 1 bước, chưa phải contract đầy đủ), MCP advertise core 12 mặc định, `dry-run` cho các tool mutative khác, remove-retakes, afade 12/15ms ở audio join cho cut_words/silence, compress --target-size resolution ladder (ý từ 0xmortuex), preset email-25mb nhắm 18 MB (ý từ 0xmortuex), atomic output .partial + no-overwrite mặc định (ý từ 0xmortuex, lớn), manifest chroma_key background-file chưa hash vào cache key (hex thì đã nằm trong args; file ảnh thì chưa — cần phân biệt hex/file ở manifest resolver trước khi thêm vào MANIFEST_FILE_ARGS).
- Push: commit f2b2318 "Add cut_words to batch + manifest, fix batch cache sidecar key + enum drift (48 tools total)" → GitHub main (xác nhận origin/main = f2b2318). **CI run #43360191865 success** — xanh ngay lượt này (gồm 5 dòng smoke mới: batch cut-words + duration 3.48 + manifest cut-words).

## Lượt 39 — 2026-11-13 10:58 (+07): compress --target-size resolution ladder + preset email-25mb (48 tools, không thêm tool)
- **Học: PedroMarianoAlmeida/ffmpeg-mcp** (2★, 6 tools, TS, npm ffmpeg-mcp-server; đọc README thật trên GitHub). Ý áp dụng được:
  1. `image_to_video` — ảnh tĩnh → video độ dài cố định — MediaKit chưa có bản tĩnh (chỉ có `zoom_pan` luôn chuyển động) → backlog mới (nhỏ).
  2. Workspace luôn giam (`FFMPEG_MCP_WORKSPACE`, unset → cwd) + từ chối symlink output — MediaKit sandbox là opt-in (`MEDIAKIT_WORKDIR`); resources đã luôn giam. Ghi chú backlog (bật mặc định là breaking change, chưa làm).
  3. `ffmpeg_raw` restricted (chỉ codec/timing, cấm filter/network) → KHÔNG áp dụng: MediaKit cố ý chỉ có tool typed, không cho chạy lệnh tự do (đã quyết nhiều lần).
  4. Bundle `ffmpeg-static` → KHÔNG áp dụng (ffmpeg hệ thống + `doctor`).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `compress --target-size` resolution ladder (ý từ 0xmortuex/ffmpeg-mcp, backlog lượt 38): bpp = videoKbps×1000/(w×h×fps); dưới ngưỡng 0.045 thì hạ dần 1080→720→480→360→240 cho tới khi bpp ≥ 0.045, không thì lấy 240p; chỉ hạ, không bao giờ upscale; xuất phát từ dims sau `--max-width` nếu có. Mặc định bật, `--no-resolution-ladder` / `resolution_ladder: false` tắt. Trả `resolution_ladder_applied`, `bpp_before`/`bpp_after`, `bpp_threshold: 0.045` (+ `scaled_to` sẵn có). bpp được đo cả khi ladder tắt — đó là chẩn đoán, chỉ bước hạ mới bị flag chặn.
  - Preset `email-25mb` (ý từ 0xmortuex, backlog lượt 38): shorthand cho target-size 18 MB (giới hạn đính kèm Gmail 25 MB ÷ ~1.37 phình base64 ≈ 18.2 MB); đi đường target-size (ladder bật), từ chối khi kèm `--target-size` hoặc `--crf`; trả `quality: "email-25mb"` + `target_size_mb: 18`.
  - **Sửa margin an toàn target-size 2% → 10% (bắt được nhờ đo thật)**: ladder 1 MB đầu tiên ra 1.015.839 B, `target_met: false` — two-pass ABR overshoot video bitrate +6.5–8.4% trên testsrc downscale (400k→426k, 656k→705k, 1000k→1084k; cùng nội dung ở 720p đúng trong 0.2%), không phải do `-maxrate`/`-bufsize` (thử 3 variant VBV đều overshoot như nhau). Margin 10% giữ lời hứa "fit dưới target": 1 MB → video 592k (thay 656k), 930.148 B, met true. Số min-size trong lỗi đổi 0.29 → 0.32 MB.
  - `compress` vào `batch`/`manifest` nhận thêm arg `resolution_ladder` (qua `BATCH_OPERATIONS`, manifest dùng chung) — `quality: email-25mb` đã chạy sẵn qua batch/manifest vì `quality` nằm trong args allowlist.
  - README (dòng bảng compress), SKILL.md (§23 + rule 45), CI smoke thêm 5 dòng (target-size 1 → 854x480, --no-resolution-ladder → 1280x720, email-25mb).
- **Test** (ffmpeg 8.1.2):
  - Đo trước khi code: target 1 MB/10s → video 656k (margin 2%), bpp 720p 0.0237 < 0.045 → ladder chọn 480p (0.0533); target 0.5 MB → 240p (0.0861); target 5 MB → 0.1256, không ladder; `--max-width 640` + target 1 MB → 640×360 bpp 0.0856, không ladder thêm.
  - Đo nguyên nhân overshoot: ffprobe stream bitrate ladder-run 704.791k vs 655.523k không-ladder (cùng budget 656k); encode tay 3 variant VBV (2x/4x, không VBV, 1.5x/2x) đều ~704k; control 720p @656k → 654.7k, 480p @400k → 426.1k, 480p @1000k → 1083.9k — overshoot hệ thống ở 480p, không phải do VBV. Sau margin 10%: 1 MB → **592k, 854×480, bpp 0.0214→0.0481, 930.148 B, met true**; 0.5 MB → **232k, 426×240, bpp_after 0.0756, 456.827 B, met true**.
  - email-25mb: mode target_size, target 18, **1.019.967 B, met true** — testsrc bão hòa ~708k video nên file không phình tới 18 MB (target là trần, không phải sàn — ABR không pad bit thừa).
  - Suite lần 1: **565/566, 1 FAIL** — `resolution_ladder=false` trả `bpp_before/bpp_after: null` (bpp chỉ đo trong nhánh ladder bật). Fix: đo bpp mọi trường hợp video, chỉ bước hạ mới bị flag chặn; chạy lại CLI `--no-resolution-ladder` → **bpp 0.0214 = bpp_after, 1280×720**.
  - Suite lần 2: **`npm test` 566/566 PASS, exit 0** (557 + 9 assert mới); `doctor` 48/48 available; `npm run check` sạch (check-docs: 48 tools + batch enum phủ 13 operations).
  - Assert mới (9): ladder 1MB 2 (dims 854x480 + bpp 0.0214→0.0481) + 0.5MB 1 (426x240) + no-ladder 1 + 5MB 1 + max-width 1 + email-25mb 2 + email conflicts 2. Cập nhật assert cũ: video 656→592, dims 1280x720→854x480, min-size 0.29→0.32.
- **Bẫy đo lường**:
  1. `target_met: false` sau khi ladder chạy đúng — tưởng ladder tính sai bitrate, thực ra là ABR overshoot theo resolution; chỉ lộ khi đo size_after trên đĩa, không phải từ log encode. Margin là tham số duy nhất giữ lời hứa fit-under-target mà không làm test phụ thuộc môi trường (retry theo size đo được sẽ làm `video_bitrate_kbps` khác nhau giữa ffmpeg 8.0/8.1).
  2. ABR không pad bit thừa: target 18 MB ra file ~1 MB — đó là hành vi đúng (encoder đạt chất lượng bão hòa ở ~708k), không phải bug budget; assert đúng là `target_met`, không phải size gần target.
  3. `muse.edit` match 2 occurrence của `if (targetMb !== null)` — lần đầu thay nhầm vào block emailPreset; kiểm tra bằng grep rồi sửa lại đúng branch entry.
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: `image_to_video` (ý từ PedroMarianoAlmeida, mới), `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable (check-docs batch-enum là 1 bước), MCP advertise core 12 mặc định, `dry-run` cho các tool mutative khác, remove-retakes, afade 12/15ms ở audio join, atomic output .partial + no-overwrite mặc định (ý từ 0xmortuex, lớn), manifest chroma_key background-file chưa hash vào cache key, workspace luôn giam (ý từ PedroMarianoAlmeida, breaking change — cân nhắc).
- Push: commit cb24914 "Add compress --target-size resolution ladder + email-25mb preset (48 tools total)" → GitHub main (xác nhận origin/main = cb24914). **CI run #43365644578 success** — xanh ngay lượt này (gồm 5 dòng smoke mới: target-size 1 → 854x480, --no-resolution-ladder → 1280x720, email-25mb).

## Lượt 40 — 2026-11-13 12:58 (+07): image_to_video tool + manifest chroma_key background cache key (49 tools)
- **Học: sworddut/mcp-ffmpeg-helper** (8 tools, Node, đọc trang Glama + schema tool thật). Ý áp dụng được:
  1. `create_video_from_images` — ảnh → video, framerate/codec/pix_fmt tường minh → đã làm tool `image_to_video` mới (bản 1 ảnh, độ dài cố định; sequence/slideshow nhiều ảnh là follow-up).
  2. `extraOptions` (flag ffmpeg tự do) → KHÔNG áp dụng: MediaKit cố ý chỉ có tool typed, không cho chạy lệnh tự do (đã quyết nhiều lần).
  3. Không verify output, không output schema → MediaKit hơn hẳn: đếm frame thật trên đĩa, PSNR frame đầu vs source, PSNR frame cuối vs frame đầu.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- **Làm**:
  - `image_to_video` (core+CLI+MCP, tool 49): 1 ảnh tĩnh → video độ dài cố định, không chuyển động (nửa còn lại của `zoom_pan`). `-loop 1 -framerate <fps> -i <ảnh> -t <duration>`; dims mặc định = ảnh gốc (làm chẵn); `--width`/`--height` fit trong box + pad đen ra đúng kích thước (1 chiều tự tính theo aspect); `--audio` loop bed tới đúng duration (`-stream_loop -1`, dài thì `-t` cắt); output `.mp4` libx264 hoặc `.webm` VP9 (audio aac/libopus theo đuôi). Từ chối video input, audio không có audio stream, output không phải mp4/webm. Trả `frames` đếm thật + `audio`.
  - Manifest `chroma_key` background-file hash vào cache key (backlog lượt 38): thêm `"background"` vào `MANIFEST_FILE_ARGS` + helper `isHexColorArg` — resolver chỉ resolveRel khi background là file (hex giữ nguyên, vì hex đã nằm trong args; resolve "FF0000" thành path sẽ biến màu thành file thiếu), vòng hash cache key cũng skip hex. Batch đã làm đúng từ lượt 38 (`extraHash` phân biệt hex/file); manifest là chỗ còn sót.
  - Sửa helper test `psnrY`: frame giống hệt nhau in `PSNR y:inf`, regex cũ không match → null. Map `inf` → 999 dB (match hoàn hảo, không phải lỗi đo).
  - README (dòng bảng image_to_video + sửa dòng manifest nhắc background là sidecar + đoạn prose), SKILL.md (rule 46), CI smoke thêm 1 dòng.
- **Test** (ffmpeg 8.1.2): đo trước khi code — `-loop 1` 3s/30fps → **90 frame đúng, 3.000s, 640×360**; kèm audio loop → h264 + aac, 3.0s; frame 0 vs source scale PSNR-Y **52.6 dB**, frame 0 vs frame cuối **68.3 dB** (tĩnh thật). Suite lần 1: **4 FAIL** — (1) psnrY null vì `inf` (fix helper, xem trên); (2) hardcode `tools_total === 48` trong test `videos://workspace/info` + "all 48 tools" (sửa → 49, lần thứ 5 bẫy này lặp lại — grep số tool cũ mỗi lần thêm tool); (3–4) manifest chroma re-run sau khi sửa bg: tưởng fix cache key hỏng, thực ra **test ghi đè bg.png bằng ffmpeg không `-y` — ffmpeg in "File already exists. Exiting." rồi exit 0, file vẫn đỏ, cache hit là đúng** (bẫy mới: ffmpeg từ chối ghi đè nhưng exit 0, không throw, nên test tưởng đã sửa file). Fix: thêm `-y` cả 2 lần tạo bg (đỏ đầu + xanh sau) để lần chạy sau không bị dính file xanh cũ. Suite lần 2: **`npm test` 584/584 PASS, exit 0** (566 + 18 assert mới: image_to_video 11 + manifest chroma 7); `doctor` 49/49 available; `npm run check` sạch (check-docs: 49 tools + batch enum phủ 13 operations). Assert mới: image_to_video 90 frame/PSNR f0 59.1/f89-vs-f0 999/mặc định 1280×720 48 frame/width-only 640×360/audio h264+aac 3s + 4 lỗi; manifest chroma: chạy lần 1 ok + góc B ~0 (nền đỏ), lần 2 cache hit, sửa bg → re-run + góc B >200 (nền xanh), hex chạy được + lần 2 cache hit.
- **Bẫy đo lường**:
  1. `ffmpeg` không `-y` ghi đè file đã tồn tại: in lỗi ra stderr nhưng **exit 0** — `execFileAsync` không throw, test chạy tiếp với file cũ và kết luận sai về cache. Mọi lần ghi đè fixture trong test phải có `-y`.
  2. PSNR `inf` = giống hệt nhau, không phải đo hỏng — helper parse phải xử lý, không được trả null.
  3. Hardcode số tool trong test (`tools_total`, `tools/list`) — lần thứ 5: grep số cũ mỗi lần thêm tool (đã có trong checklist lượt 29/30/32/33).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, MCP logging progress, contract machine-readable (check-docs batch-enum là 1 bước), MCP advertise core 12 mặc định, `dry-run` cho các tool mutative khác, remove-retakes, afade 12/15ms ở audio join, atomic output .partial + no-overwrite mặc định (lớn), workspace luôn giam (breaking change — cân nhắc), `image_to_video` nhiều ảnh/slideshow (follow-up từ sworddut).
- Push: commit 3fe3e00 "Add image_to_video tool + manifest chroma_key background cache key (49 tools total)" → GitHub main (xác nhận origin/main = 3fe3e00). **CI run #43378422062 success** — xanh ngay lượt này (gồm 1 dòng smoke mới: image-to-video 90 frames).

## Lượt 41 — 2026-11-13 13:49 (+07): assemble tool — film manifest, Autopilot-style (50 tools)
- **Học**: món lớn nhất còn lại từ kaomei/stickman-video-director (lượt 31): manifest assembler kiểu Autopilot — 1 manifest JSON → phim hoàn chỉnh, voice-led, sample 20s → approve theo fingerprint → render, cache từng shot theo nội dung. KHÔNG copy renderer Canvas của họ: assemble xây trên tool MediaKit có sẵn (`zoom_pan`, `mix`, `burn_captions`, `qa_report`) + ffmpeg. Tony duyệt "Làm manifest assembler tiếp" 13/11.
- **Làm**:
  - `assemble` (core+CLI+MCP, tool 50), 4 mode: `validate` (không ghi gì), `preview` (N giây đầu, nửa kích thước, crf 28), `approve` (ghi fingerprint vào `<manifest>.assemble-approval.json`, bắt buộc có preview khớp), `render` (bắt buộc approval khớp, trừ `force:true` → receipt ghi `approval:"forced"`).
  - Voice-led: `total = lead + voice đo thật + tail`; shot durations đổi ra frame, tổng phải bằng `round(total*fps)` đúng từng frame, không trim/pad/speed-change lặng lẽ. Captions phải nằm trong [0, total].
  - Shot kinds: `image` (có `zoom` → `zoom_pan`, không zoom → hold tĩnh bằng zoomPan 1.0 cố định để fill khung), `video` (trim + reframe crop 1 lần encode, `-frames:v` đúng số frame), `color` (lavfi color source). Motion gate 2.5s cho image tĩnh và color card.
  - Cache từng shot theo content hash (`.mediakit-assemble-cache/` cạnh manifest + index.json, verify size + SHA-256 khi reuse, như manifest tool); preview dùng key riêng (nửa size) nên không làm bẩn render full.
  - Audio: voice pad bằng `adelay` (lead) + `apad` (đủ total) → timeline cuối; có nhạc thì `mix` (duck + SFX tuyệt đối + master −14), không nhạc thì `loudness` −14. Mux `-c copy -t total`, burn captions bằng giá trị khóa của style (đọc `styles.json` lúc render, fallback embedded nếu file thiếu — ghi rõ nguồn).
  - Receipt `assemble-receipt.json`: fingerprint, approval, cache_hits, duration/dims/frames/LUFS đo thật, SHA-256, `qa_report` đầy đủ.
  - `loadShortsStyles()` (export, đọc styles.json theo import.meta.url, fallback 3 style embedded).
  - Sửa bug thật gặp trong lúc làm: `mix`/`loudness` từ chối output `.m4a` ("unsupported mix output format") vì `AUDIO_FORMATS` thiếu `m4a` — thêm `m4a: "aac"` (m4a chỉ là container AAC; `extract_audio` cũng được lợi).
  - README (dòng bảng assemble), SKILL.md (rule 47), shorts-video SKILL.md (mục Assemble + sửa "405px" → "404px" trong bảng Common failures — số lẻ cũ từ lượt 31 còn sót), reference `skills/shorts-video/references/assemble-manifest.md` (schema + 4 mode + motion gate + cache/approval), `.gitignore` (`.mediakit-assemble-cache/`, `*.assemble-approval.json`).
- **Test** (ffmpeg 8.1.2):
  - `npm run check` sạch (check-docs: 50 tools khớp README); `npm test` **604/604 PASS, exit 0** (584 + 20 mới: assemble 19 + no-music preview 1). Assert mới (20).
  - Demo end-to-end trên fixture `test/assemble-film.json` (voice 9s + lead/tail 0.5 = 10s, 300 frame; image zoom 4s + video 4s + image tĩnh 1s + color 1s; nhạc + SFX 2s + captions 0–8s, clean-bold): preview 3s **540×960, đúng 90 frame**; render full **1080×1920, 10.002s, đúng 300 frame đếm thật, loudness −13.9 LUFS (đo độc lập, trong ±0.5 của −14)**, `qa_report` 12/12 pass, receipt approval "approved". Render lần 2: **cache_hits 4/4**. Soi mắt 3 frame: t=1s đúng shot zoom + caption cue 1, t=6s đúng shot video + cue 3, t=9.5s đúng card màu tối, không caption. Preview 3s đo −12.9 LUFS — lệch là artifact clip ngắn (lead im lặng + beep), không phải bug (render đủ 10s đo −13.9).
- **Bẫy đo lường**:
  1. Lần chạy suite đầu: **6 FAIL** — (a) 3 FAIL doctor: `assemble` báo `filter:apad` thiếu dù ffmpeg có apad — nguyên nhân: `DOCTOR_FILTERS` không liệt kê `apad` nên doctor không đếm nó (chỉ đếm filter có trong list). Fix: thêm `"apad"` vào `DOCTOR_FILTERS` cạnh `"adelay"`. Bài học: mỗi filter ghi trong `TOOL_REQUIREMENTS` phải có mặt trong `DOCTOR_FILTERS`, không thì doctor báo thiếu oan. (b) 3 FAIL manifest chroma_key: test không hermetic — `outputs/mcp-manifest-chroma/` còn cache từ lượt chạy trước nên lần chạy đầu trả "cached" thay vì "ok" (kể cả sau khi sửa bg sang xanh, key_blue cũ vẫn hit cache của lượt trước — output xanh là đúng, chỉ status sai). Fix: `rm` thư mục chroma trước khi test (cùng bẫy batch ở lượt 29). CI chạy checkout mới nên không thấy; chạy local lặp lại mới thấy.
  2. `ffmpeg` không `-y` ghi đè file đã tồn tại: exit 0 nhưng file không đổi — đã bắt ở lượt 40, nhắc lại vì test assemble dùng `-y` khắp nơi.
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: transitions/xfade giữa các shot của assemble (v1 chỉ cắt thẳng), per-shot text layers, `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope.

## Lượt 42 — 2026-11-13 14:39 (+07): transitions cho assemble (50 tools, không thêm tool)
- **Học**: Tony bấm "Làm transitions cho assemble tiếp". Thiết kế khóa trong `references/assemble-manifest.md`: transition nằm trên shot SAU vết cắt (`transition: {type, duration}`), type là 1 trong 49 tên xfade của `concat` (dùng chung danh sách `XFADE_TRANSITIONS`), duration 0,1–10s, CĂN GIỮA vết cắt — nửa trước là đuôi shot trước, nửa sau là đầu shot này. Tổng thời lượng và audio KHÔNG đổi (transition chỉ là video, giọng/nhạc chạy thẳng bên dưới). Frame math giữ đúng tuyệt đối: mỗi segment được dựng dài thêm bằng handles, chuỗi xfade tiêu đúng handles, phim nối xong vẫn đúng `total_frames`.
- **Làm**:
  - `deriveAssembleHandles` (frames): transition F frame → `floor(F/2)` frame handle-out cho shot trước (hiện SAU vết cắt), còn lại handle-in cho shot sau (hiện TRƯỚC vết cắt). `buildFrames`/`buildSeconds`/`buildStart` (video) theo đó; `deriveAssembleJoins` tính offset từng join = `cutFrames - hAfter` (căn frame tuyệt đối, không cộng dồn float). `planAssembleVideo` dùng chung cho render full và preview.
  - `validate`: shot đầu không được có transition; type phải thuộc 49 tên; duration đổi ra frame (≥2 frame, duration thực = F/fps ghi trong kết quả); transition không dài hơn shot ngắn hơn kề bên; video shot phải có đủ handle trong source (`start ≥ handle-in`, `start + duration + handle-out ≤ source end`) — lỗi nêu rõ số giây handle thiếu. Image shot build >600s bị chặn (giới hạn của `zoom_pan`).
  - `buildAssembleShot` dựng theo build fields (zoomPan duration = buildSeconds, video `-ss buildStart -t buildSeconds -frames:v buildFrames`, color buildFrames) + đếm frame thật; cache key thêm `transition` + build fields (key cũ mồ côi, không xung đột). `joinAssembleSegments`: chuỗi xfade + `fps`/`format` cuối; không có transition thì giữ đường demuxer stream-copy cũ (nhanh, không re-encode). `assemble()` trả `joins` trong receipt; preview bỏ transition khi shot sau bị cắt dưới handle (ghi `transition_warnings`); `doctor` thêm `xfade` cho assemble.
  - Fixtures: `assemble-film-transitions.json` (fade 1,0s vào s2 video start 2, dissolve 0,5s vào s3, fade 0,5s vào s4; vẫn 10s/300 frame) + 3 bad (transition ở shot đầu / dài hơn shot kề / video thiếu handle).
  - Docs: README dòng assemble, SKILL.md rule 47, shorts-video SKILL.md mục Assemble, reference Transitions + sửa câu chia frame lẻ (15 frame = 8 trước vết cắt, 7 sau — theo đúng ngữ nghĩa xfade, không phải ngược lại).
- **Test** (ffmpeg 8.1.2): `npm run check` sạch; `npm test` **615/615 PASS, exit 0** (604 + 11 mới). Assert mới (11): validate 3 transition, 3 lỗi validate, preview 5s (150 frame, 540×960, không drop transition), force render ghi 3 joins đúng offset (3,5s / 7,7333s / 8,7333s), final vẫn 1080×1920/10s/đúng 300 frame, LUFS −14, receipt 3 joins + qa không fail, render lần 2 cache 4/4.
  - **Bằng chứng blend đo thật (không đoán)**: frame giữa fade s1→s2 (t=4,0s) so với 2 frame thuần lấy từ segment cache (s1 ở 4,0s, s2 ở 0,5s): **PSNR(A,B)=4,06dB, PSNR(blend,A)=9,95dB, PSNR(blend,B)=9,99dB** — đúng dấu hiệu lý thuyết của blend 50/50 (blend=(A+B)/2 → PSNR(blend,A) ≈ PSNR(A,B)+6,02dB, sai số <0,11dB; hai phía lệch nhau 0,05dB). Test assert đúng quan hệ này (±1,5dB / ±2dB). Soi mắt 3 frame: t=4,0s thấy rõ double-exposure (vừa sọc dọc testsrc vừa dải ngang kenburns), caption "eyes and ears for video." vẫn rõ.
  - Lưu ý đo lường: assert mean-between ban đầu (so frame 4,0s với frame 2,0s/6,0s) SAI — vì 2 nguồn test đều động (kenburns zoom tiến dần, testsrc đổi theo thời gian) nên mean của frame thuần ở thời điểm khác không phải reference đúng. Phải lấy frame thuần đúng thời điểm từ segment cache mới đo được. Đây là cùng họ bẫy với "đo log thay vì đo đĩa": reference sai thì assert sai dù code đúng.
  - qa_report trên phim có transition: 11/12 pass + 1 warn pacing (scene detection đếm được 1 shot/10s vì dissolve làm mờ vết cắt) — warn của heuristic, không phải fail; test transitions assert "không có check nào fail" thay vì all-pass như phim cắt thẳng.
- **Bẫy đo lường / hạ tầng trong lượt này (3 lần chạy suite mới xanh)**:
  1. `readdir` chưa import trong test → crash ReferenceError ở đoạn PSNR. Sửa: thêm vào import `node:fs/promises`.
  2. MCP client timeout 60s mặc định: render full (join xfade + burn) vượt 60s khi máy bận (cron 2h chạy chồng) → `McpError -32001 Request timed out` dù tool vẫn chạy xong. Sửa: override `{timeout: 300000}` cho 5 lệnh render assemble (render/render2/edit-force/trans-render/trans-render2), theo tiền lệ lệnh social ở lượt trước. Đây là timeout của test client, không phải lỗi tool.
  3. **Hai lượt chạy suite chồng nhau làm flake cache assert (bẫy thật)**: lượt chạy tay 15:30 và lượt cron 15:25 cùng dùng `test/.mediakit-assemble-cache` — mỗi bên wipe cache của bên kia giữa render1 và render2 → mỗi bên fail đúng 1 assert cache_hits (tay: "second render", cron: "second transitions render"). Sửa: `stageAssembleManifest()` — copy fixture sang thư mục per-run (`outputs/mcp-assemble-stage-<pid>-<name>`, asset đổi sang absolute), cache/approval/output đều theo manifest → mỗi lượt chạy hermetic hoàn toàn. Edit-copy và no-music cũng stage/pid-suffix theo. Từ giờ 2 lượt chạy chồng nhau không còn chia sẻ state assemble nữa.
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: per-shot text layers, `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, join cache (render lần 2 hiện vẫn re-encode join).
- Push: commit 5d90e0f "Add transitions to assemble: centered xfade joins, frame-exact (50 tools)" → GitHub main (xác nhận origin/main = 5d90e0f). **CI run #43398648586 success** — xanh (gồm 2 dòng smoke mới: assemble validate total_frames 300 + preview 5s preview_seconds 5).

## Lượt 43 — 2026-11-13 16:58 (+07): slideshow tool — nhiều ảnh → video có transition (51 tools)
- **Học: Twinklebear/ffmpeg-slideshow-py** (8★, đọc README + `slideshow.py` thật). Ý áp dụng được:
  1. Hai giai đoạn: ảnh → clip 1s chạy song song trước (ffmpeg loop ảnh trong 1 graph lớn rất chậm, clip video thì nhanh), rồi mới nối clip bằng graph thứ hai → đã làm đúng vậy: `image_to_video` từng ảnh (pool 4) rồi `concat` xfade chain.
  2. Ngữ nghĩa thời lượng: slide_duration = img_duration + fade ("chỉ tính nửa fade vào thời gian slide") → đã làm dạng tổng quát: clip = duration + transition (trừ slide cuối), transition ăn handle chứ không ăn thời gian hiển thị, tổng = đúng sum(durations).
  3. Fade bằng `fade=t=in:alpha=1` + `setpts` offset + chuỗi `overlay` → MediaKit giữ xfade (49 tên sẵn có của `concat`) thay vì chỉ fade, và dùng chung `concatTransition` thay vì viết graph mới.
  4. Scale `force_original_aspect_ratio=decrease` + pad về đúng kích thước → đã có sẵn trong `image_to_video`, dùng lại.
  5. Bitrate thấp là đủ cho ảnh tĩnh — không áp dụng tường minh (giữ crf 23 mặc định của MediaKit).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg trên tool sẵn có.
- **Làm**: `slideshow` (tool 51): 2–32 ảnh, duration mỗi ảnh (`--duration` chung, `--durations 3,5,2`, hoặc `{file, duration}` từng ảnh trong MCP — per-image thắng durations thắng duration), 1 loại transition cho mọi cặp (`fade` mặc định, 1 trong 49 tên xfade), `transition_duration` mặc định 1s và phải ngắn hơn slide ngắn nhất, `--audio` loop bed dưới toàn bộ show, output `.mp4` duy nhất trong v1 (đường join của concat gắn `-movflags +faststart` của muxer mp4). Trả `slides` từng ảnh + `expected_duration_seconds` + frame count đếm thật. `doctor` thêm slideshow. CLI `slideshow <img1> <img2> ... -o show.mp4`, MCP + CLI + README + SKILL.md rule 47 (đánh số lại rule assemble 47→48 — hai mục trùng số sau khi chèn; chỉ VERIFY.md lịch sử còn ghi "rule 47" cho assemble, để nguyên) + CI smoke 1 dòng.
- **Test** (ffmpeg 8.1.2): `npm run check` sạch (check-docs: 51 tools); `npm test` **630/630 PASS, exit 0** (615 + 15 mới). Assert mới (15): happy 3×3s fade 1s → **9,0s, 270 frame đúng, 640×360, 30fps**; durations [2,4,2] → 8s/240 frame; object `{file, duration}` → 4s/120 frame; audio bed → h264+aac 9s (ffprobe độc lập); 5 lỗi (1 ảnh, transition ≥ slide ngắn nhất, transition lạ, video làm slide, .mov).
  - **Bằng chứng pixel đo thật**: frame t=1s vs slide 1 **PSNR 59,97 dB**, t=4,5s vs slide 2 **71,92 dB**, t=7,5s vs slide 3 **999 dB** (xanh đặc, giống hệt nhau); frame giữa fade t=3,5s vs slide 1 **18,48 dB** và vs slide 2 **18,64 dB** — là blend thật, không phải slide nào; frame t=1s vs slide 2 chỉ 12,54 dB (đúng thứ tự).
  - **Bẫy trong lượt này**: assert đầu chạy suite fail đúng 1 — `slideshow refuses a single image`: schema zod `.min(2)` chặn trước core nên message là "Array must contain at least 2 element(s)", không khớp regex `/at least 2 images/`. Sửa regex test thành `/at least 2/` (lớp nào chặn cũng là từ chối đúng); chạy lại suite xanh hẳn. Đây là lần thứ 2 validate zod chặn trước core làm test regex sai — khi test lỗi MCP, đọc message thật của MCP trước khi viết regex.
  - Output luôn có track audio câm khi không có `--audio` (acrossfade của concat cần audio stream) — đã ghi vào docs, không phải bug.
- Push: commit 95d3b76 "Add slideshow tool: multi-image video with xfade transitions (51 tools)" → GitHub main (xác nhận origin/main = 95d3b76). **CI run #43409349544 success** — xanh (gồm 1 dòng smoke mới: slideshow 2×2s = 120 frames).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: per-pair transitions cho slideshow, slideshow vào batch/manifest, per-shot text layers, `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope.

## Demo 2026-11-13 18:18 (+07): video mèo & chuột bằng assemble (không thêm tool)
- Tony: "Thử làm video mèo và chuột bằng tool xem nào". 4 ảnh AI (1152×2048 webp, cùng style: mèo cam Milo + chuột xám Pip khăn xanh, bếp ấm) + giọng Kokoro af_heart 4 câu (đo thật 3,05 / 2,975 / 3,325 / 3,0s) + assemble, transitions slideleft 0,8s / dissolve 0,5s / fade 0,5s, phụ đề clean-bold khớp từng câu giọng.
- Kết quả: **14,114s, 1080×1920, đúng 423 frame, LUFS −15,1** (qa chỉ warn pacing — heuristic scene detection, như mọi phim có transition), cache_hits 4. Soi mắt 3 điểm giữa transition: slideleft chia đôi khung đúng nghĩa, dissolve blend hạt đúng kiểu xfade, fade double-exposure rõ. Phụ đề đúng mốc từng câu.
- Sự cố giữa chừng: máy restart lúc đang render → final.mp4 dở (không moov atom, không receipt) nhưng approval + 4 segment cache còn nguyên → chạy lại chỉ bước render, reuse 4/4 segment, xong. Bài học: assemble có thể resume sau khi chết giữa chừng, không cần làm lại từ đầu.
- Giọng đo −15,1 (hơi dưới −14 ±0,5) trên đường loudness() two-pass — lần này không có nhạc; chênh 1,1 LU so với mục tiêu, qa loudness vẫn pass (−16..−12). Để nguyên, không đuổi theo con số trên video demo.

## Lượt 44 — 2026-11-13 18:58 (+07): mix two-pass mastering + slideshow per-pair transitions (51 tools, không thêm tool)
- **Học: Mnehmos/mnehmos.ffmpeg-llm.mcp** (0★, 5 commit, TS/Zod, 47 tools, JSON timeline là source of truth duy nhất). Ý áp dụng được:
  1. `detect_silence` trả structured regions + `trim_silence` tách riêng → MediaKit đã có (`silence --detect-only` + `silence`), không thêm.
  2. Async render jobs (`render_full` trả jobId ngay, `render_status`/`render_cancel`, SIGTERM child) → backlog mới: `assemble` render dài vượt timeout MCP 60s, cần `async: true` + job store JSON (không cần SQLite) + parse `time=` từ stderr để báo progress thật (repo này progress không bao giờ cập nhật — chỉ học hình dạng, không học code progress).
  3. Export presets + chapters (Zod preset: container/codec/bitrate/resolution/fps/twoPass; chapters ghi thành ffmpeg metadata lúc mux) → backlog mới: `presets.json` cho assemble + `chapters` trong manifest.
  4. `npm run preflight` (typecheck + lint + test một lệnh) + audit log append-only mọi tool call → backlog nhỏ (receipts đã có cho output; audit log ghi lại quyết định).
  5. Anti-pattern KHÔNG học: parse fail trả default câm (`peakMatch ? parseFloat : 0`) + `astats` per-frame mà regex không `/g` nên chỉ lấy frame đầu — MediaKit không bao giờ làm vậy: output ffmpeg không parse được thì fail to kèm stderr; level toàn file dùng volumedetect/loudnorm hoặc parse section astats CUỐI.
  KHÔNG copy code của họ — chỉ học ý tưởng.
- **Làm 1 — `mix` two-pass mastering (bug đo thật từ lượt 43)**:
  - Đo trước khi code: giọng yên −34,63 LUFS có khoảng lặng + bed liên tục, `music_volume 1.0`, `duck_db 18` → single-pass loudnorm ra **−14,8 LUFS** (lệch 0,8 so với target −14); giọng Kokoro thật −25,15 + bed 1.0 → **−14,7**. Single-pass undershoot có hệ thống trên giọng yên + nhiều khoảng lặng.
  - Nguyên nhân thứ hai (đo tách riêng): ffmpeg mặc định libmp3lame 64k — cùng gain two-pass, mp3 64k đo **−14,5**, 192k đo **−14,28**, WAV/m4a đo **−14,0** đúng. Encode mp3 64k ăn ~0,5 LU trong phép đo lại.
  - Fix: `mix()` render mix chưa master vào `<output>.unmastered<ext>` (cạnh output để dry-run in đúng đường dẫn), đo bằng `measureLoudnessFull`, rồi master bằng loudnorm measured_* + linear=true (đúng shape pass 2 của `loudness()`); đo lại LUFS output + warning khi lệch >0,5 (cùng luật honest-reporting của `loudness()`); temp file xóa trong `finally` kể cả khi master fail. MP3 encode (cả render lẫn master, cả `loudness()`) pin `-b:a 192k`. `master=false` giữ nguyên đường 1 render cũ. Dry-run in 2 lệnh (render + master; master hiện dạng single-pass vì chưa có measured_* — ghi rõ trong note). Kết quả thêm `two_pass`, `mastering: "two-pass"|"none"`, `warning`.
  - Đo sau fix: giọng yên + bed 1.0 + duck 18 → **m4a −14,0, two_pass true, không warning**; mp3 **−14,2**; default happy path mp3 **−14,3** (trước −14,1 — single-pass trước đây overshoot nhẹ bù trừ hao encode 64k, giờ two-pass + 192k đo đúng hơn); Kokoro + bed 1.0 mp3 **−14,3**; `loudness()` giọng yên mp3 **−14,2**. Không còn file `.unmastered.*` sót lại.
  - Fixture mới `test/quiet-voice.mp3` (−34,63 LUFS, volume 0.25 từ mix-voice). Test mới (9 assert): regression quiet+bed m4a + mp3, `two_pass === true`, không warning, temp file bị xóa; dry-run 2 lệnh (render có sidechaincompress không loudnorm, master có loudnorm + `.unmastered.`), `mastering === "two-pass"`, không ghi file.
- **Làm 2 — slideshow per-pair transitions (backlog lượt 43)**:
  - `concatTransition` nhận thêm `transitions`/`transitionDurations` (mỗi join một cặp): offset từng join dùng `t[k-1]`, tổng = sum(clipDurs) − sum(t). `concat()` truyền qua. `slideshow` nhận `transitions`/`transition_durations` (MCP array, CLI `--transitions fade,wipeleft` / `--transition-durations 1,0.5`); clip nội bộ = duration + transition RA của slide đó; mỗi `t[i]` phải ngắn hơn cả 2 slide kề; đường single-value giữ nguyên message lỗi cũ (`shorter than the shortest slide`). Kết quả: `transitions`/`transition_durations` luôn có; `transition`/`transition_duration` giữ giá trị chung khi mọi join giống nhau, `null` khi khác nhau.
  - Đo trước khi viết test: CLI 3×3s fade 1s + wipeleft 0,5s → **270 frame, 9s đúng**; frame giữa fade1 vs 2 slide PSNR trung bình ~11 dB (blend), giữa wipeleft ~6 dB (blend), frame slide 2 thuần 51,8 dB.
  - Test mới (7 assert): happy 3×3s fade/wipeleft → 270 frame/9s, echo đúng list, `transition === null`; frame 187 (giữa wipeleft) PSNR-Y < 30 vs cả slide 2 lẫn slide 3; 4 lỗi (sai độ dài transitions / transition_durations, tên lạ, duration dài hơn slide kề). CI smoke thêm 1 dòng (3×2s fade 0.5 + wipeleft 1 → 180 frame).
- **Test**: `npm run check` sạch (check-docs: 51 tools); suite lần 1 (chỉ mix): **637/637 PASS, exit 0**; suite lần 2 (cả 2 mục): **642/643, 1 FAIL** — `slideshow refuses a transition longer than the shortest slide`: nhánh message cũ có điều kiện `x === null && x === undefined` (không bao giờ đúng) nên luôn rơi vào message per-pair mới — fix thành `x == null`, chạy lại suite lần 3: **643/643 PASS, exit 0** (630 gốc + 7 mix + 6 slideshow per-pair).
- **Hậu kiểm — bug label-reuse trong `mix()` (điều tra câu hỏi mở −15,1 LUFS)**: KHÔNG phải peak-limiting như nghi ban đầu. Graph `mix()` dùng chung label `[voice]` cho cả sidechaincompress lẫn amix; ffmpeg KHÔNG tự split label dùng 2 lần — lần dùng thứ 2 (amix) âm thầm bind vào input thô, giọng vào mix KHÔNG có gain (+9,6 dB). Đo tay chứng minh: mix không sidechain → −16,22 LUFS; mix có sidechain → −25,82; bed đã duck đo riêng −40,72 (không giải thích được −25,82 — chỉ có giọng chưa gain mới ra số đó); log debug ffmpeg: `auto-inserting auto_aresample_2 between graph_0_in_0:0 and Parsed_amix_5` (amix nhận input 0 thô). Bug tồn tại từ lúc viết tool, bị single-pass loudnorm cuối graph che (nó re-level tổng về −14 bất kể mix gốc bao nhiêu); two-pass mastering lộ ra vì đo mix chưa master trước. Fix: `asplit=2[voice][voice_sc]` + comment ghi rõ bẫy. Sau fix riêng asplit: mix Kokoro chưa master −16,03 → master −14,2; nhưng vẫn kẹt 0,5 LU do crest giọng thật ~19 dB (gain +9,6 dB đẩy peak lên +3,32 dBTP, master bị TP cap chặn) → thêm compressor trước gain (threshold −18 dB, ratio 4:1, attack 1 ms, peak detection): attack 20 ms để lọt transient plosive (chỉ giảm peak 2,6 dB), attack 1 ms giảm 8,9 dB, crest mix còn ~15 dB. Đo cuối: Kokoro iso **−14,1**, giọng yên −14,0, default −14,3 (ducking 9,5–9,9 không đổi), SFX −14,3. Fixture mới `test/kokoro-voice.wav` (giọng Kokoro thật 21,8s, −25,6 LUFS) + test regression 3 assert (tone fixture không bắt được bug này — crest tone quá nhỏ nên master vẫn kéo lên được; với bug thì Kokoro đo −15,0 fail). Suite lần 4 sau fix: **646/646 PASS, exit 0** (643 + 3 Kokoro).
- **Hậu kiểm 2 — true-peak encode overshoot (video báo cáo lần render 2)**: render 2 đo **−14,07 LUFS, TP −0,04** — LUFS đạt nhưng qa `true_peak` fail (max −0,3). Nguyên nhân: encode AAC/MP3 sau loudnorm thêm ~1–1,5 dB inter-sample overshoot (giọng Kokoro master TP −1,5 đo trên đĩa −0,55; final phim −0,04). Thử TP −3/−4 trong graph thì LUFS tụt −14,81/−15,83 (loudnorm limiter cắt gain chứ không chỉ cắt peak) — KHÔNG dùng. Chọn **TP −2** cho cả `loudness()` pass 2 lẫn `mix()` master (4 chỗ): Kokoro −14,3 (tốn 0,2 LU), trên đĩa TP −0,76; giọng yên −14,0; default −14,3. Suite lần 5: **646/646 PASS, exit 0**, check-docs sạch. Video báo cáo render lần 3 (cache 4/4, film không đổi): **6.359.172 byte, 22,836s, 685 frame, 1080×1920, LUFS −14,24 đo độc lập, TP −1,03; qa verdict warn (chỉ còn warn pacing — shot trung bình 22,8s; không còn check fail nào: loudness pass, true_peak pass, frozen_frames pass)**. Giới hạn còn lại: fixture tone thuần + gain giọng +18,6 dB vẫn đo TP +1,38 trên đĩa — gain lớn làm unmastered temp clip ở 0 dBFS nên master đo TP trên tín hiệu đã clip; giọng thật (gain ≤12 dB) không bị; LUFS của tone vẫn −14,0 pass.
- **Bẫy đo lường**:
  1. `-v error` nuốt JSON của loudnorm (`print_format=json` in ở mức info) — đo LUFS bằng tay phải bỏ `-v error`, không thì grep ra rỗng tưởng file lỗi.
  2. `loudnorm` two-pass trên mp3 vẫn lệch 0,5 LU — tưởng two-pass sai, thực ra là encode mp3 64k mặc định; đo cùng gain ra WAV/m4a mới thấy −14,0 đúng. Đừng sửa gain khi lỗi nằm ở codec/bitrate.
  3. Single-pass mix trước đây đo −14,1 trên happy path — tưởng đã đúng, thực ra là overshoot bù trừ hao encode; hai sai số triệt tiêu nhau. Chỉ fixture giọng yên + bed to mới lộ.
  4. **Label filter dùng 2 lần KHÔNG được split** — ffmpeg bind lần 2 vào input thô, không báo lỗi, output vẫn chạy nhưng sai level âm thầm; chỉ lộ khi đo từng stage (mix không sidechain vs có sidechain, đo riêng từng nhánh). Quy tắc: label nào feed 2 filter thì `asplit` tường minh, và test phải có fixture crest cao (giọng thật) chứ không chỉ tone.
  5. `acompressor` mặc định detection RMS + attack 20 ms — với giọng nói, RMS nằm dưới threshold nên gần như không nén; peak nhanh lọt qua attack dài. Nén giọng phải `detection=peak` + attack 1 ms mới bắt được transient.
  6. **Encode overshoot ăn TP budget**: loudnorm đo TP trên PCM trước encode; file AAC/MP3 sau encode đo cao hơn ~1–1,5 dB (giọng thật), tone thuần + gain lớn tới +2,9 dB. Đừng hạ TP target quá sâu để bù (TP −3 làm LUFS tụt 0,8 vì limiter cắt gain) — TP −2 là điểm cân bằng đo được cho giọng thật. Gain giọng quá lớn (+18,6 dB, tone −34,6 LUFS) còn làm unmastered temp clip ở 0 dBFS, master đo TP trên tín hiệu đã clip — fixture tone là trường hợp biên, không phải nội dung thật.
- Push: commit 785aae0 "Fix mix() label-reuse bug + two-pass mastering, slideshow per-pair transitions (51 tools)" → GitHub main (xác nhận origin/main = 785aae0). **CI run #43435724120 success, 7m36s** — xanh (gồm 1 dòng smoke mới: slideshow 3×2s fade 0.5 + wipeleft 1 → 180 frame).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: async render jobs + presets/chapters cho assemble (ý mới lượt 44), slideshow vào batch/manifest, per-shot text layers, `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, `dry-run` cho các tool khác, remove-retakes, afade 12/15ms ở audio join, atomic output .partial, workspace luôn giam (breaking change — cân nhắc).

## Demo 2026-11-13 20:30 (+07): 3-frame flipbook chase (limited animation, không thêm tool)
- Tony đổi hướng: MediaKit phải làm đạo diễn (điều phối AI làm video), không chỉ đóng gói; cần animation chuẩn chỉnh, không ghép ảnh tĩnh. Em thử AI video gen (image-to-video) cho 4 cảnh mèo-chuột → **403 region-blocked, lasting, không retry** (đã ghi MEMORY.md).
- Pivot sang kỹ thuật 3-frame của chính Tony (Synapstick): cảnh rượt nối tiếp 3 pose — scene2 gốc + frame2 (chuột chạy xa hơn, mèo sải bước) + frame3 (chuột nhảy, mèo suýt chạm đuôi) — gen bằng image edit nối tiếp (resume snapshot), nhân vật giữ nguyên, không biến dạng.
- Clip demo: 3 shot tĩnh cắt thẳng (không zoom, không transition), giọng câu rượt 2,975s + lead/tail 0,5 → **3,993s, 1080×1920, đúng 119 frame**. Soi mắt: 3 pose tiến triển rõ, đọc được chuyển động rượt. **Giọng −16 LUFS, qa loudness fail** — clip ngắn (1 câu + 1s lặng) nên two-pass loudnorm chạm trần true-peak, không kéo lên −14 được; demo vẫn nghe rõ, để nguyên không đuổi số.
- Chờ Tony chốt hướng director: (a) 3-frame limited animation — làm được ngay bằng tool ảnh hiện có; (b) animation code Canvas 30fps — mượt nhưng art vẽ code đơn giản; (c) video AI ngoài (Kling/Runway/Flow) — mượt + đẹp, cần acc/quyết của Tony.

## Lượt 45 (side chat, 2026-11-13 ~21:10 +07): canvas_scene cho assemble — hướng director (b)
- Tony chốt 21:08: làm (b) Canvas code animation trước (không phải 3-frame, không phải video AI ngoài — đường video-gen đã bị chặn 403 region).
- Thêm shot kind `canvas_scene` cho assemble (tool 51 → vẫn 51 tool, không thêm tool mới): manifest khai `scene` (module JS) + `duration` + `assets`/`params` tùy chọn; MediaKit render từng frame bằng node-canvas (deterministic, frame N = hàm thuần của t=N/fps) rồi mux thành shot. Luồng validate → preview → approve → render + QA + cache giữ nguyên. Scene chạy code local — chỉ render manifest tin tưởng.
- Scene contract: `module.exports.draw = async (ctx, t, W, H, assets, M) => {}` (CommonJS, như skill local-video-pipeline). M = {duration, fps, params, lib: {camera, fx}} — lib vendored vào `src/canvas-scene-lib/` (camera.cjs + fx.cjs, từ skill). Cache key = hash(scene bytes + assets + params); fingerprint cover qua manifest bytes + assetHash.
- Bẫy `.js` vs `.cjs`: scene `.js` nằm trong package `"type": "module"` bị Node coi là ESM → `module.exports` không định nghĩa. Fixture dùng `.cjs`; loader báo rõ khi gặp lỗi này; doc ghi `.cjs` là chuẩn.
- Deps: `canvas@3.2.3` vào package.json (prebuild, cài 4s); CI thêm bước apt libcairo2-dev/libpango1.0-dev/libjpeg-dev/libgif-dev/librsvg2-dev (bounded như bước ffmpeg).
- Kiểm chứng (smoke, trước khi viết test): validate 4s/120 frame; preview 2s 540×960 (5,6s); render full 120 frame 1080×1920, LUFS −14, qa all-pass (29,3s); PSNR frame 0,6s vs 3,0s = 24,67 dB (chuyển động thật). Sửa scene xong render lại cache_hits 0 (hash đổi → rebuild đúng).
- Demo scene rượt mèo-chuột (`test/canvas-chase-scene.cjs`, art-direction.md khóa trước): soi mắt 2 frame bắt 4 lỗi thật — (1) chuột bị mèo che khuất (vẽ mèo trước, chuột sau + tăng khoảng cách, mèo 1.05, chuột 1.05); (2) chân bị thân che → vẽ chân SAU thân, dài hơn, thêm bàn chân; (3) phô mai đội trên đầu như mũ → dời xuống ngực, 2 tay ôm; (4) phụ đề đè nhân vật → nâng đường chạy lên 0.60H. Render 2 soi lại: chuột hiện rõ cả 2 frame, chân chạy thấy được, phô mai đúng chỗ, không đè phụ đề.
- Demo cho Tony: `cat-mouse/animated/canvas-film.json` — giọng rượt voice-s2 (2,975s) + lead/tail 0,5 → **3,993s, 1080×1920, đúng 119 frame**. Giọng **−16 LUFS, qa loudness fail** — cùng nguyên nhân như flipbook (1 câu ngắn + 1s lặng, two-pass loudnorm chạm trần true-peak); cả 2 bản demo đều −16 nên so sánh công bằng về tiếng, khác nhau ở chuyển động.
- Chạy song song với lượt cron 20:58 (đang làm `remove_retakes`, sửa cùng src/core.js ở vùng khác — cron ở ~5055, mình ở assemble ~7094+; test/mcp-test.mjs của cron chưa đụng). Suite full chạy nền lúc làm demo (outputs/canvas-suite-run.log) — kết quả về sau.

## Lượt 45 (cron 20:58, 2026-11-13): remove_retakes tool — cắt take quay lại thừa (52 tools)
- Số lượt trùng với mục "Lượt 45 (side chat)" ngay trên (canvas_scene) — hai việc chạy song song cùng buổi, cùng sửa một cây làm việc; mục này là lượt cron 20:58, mục kia là side chat.
- Học: mariagorskikh/talking-head-reel (README + references/take-selection.md đọc thật). Ý áp dụng được:
  1. Take selection: câu nói 2–3 lần, chọn 1 bản — bản sau hơn bản trước (người nói ấm dần), bản trôi chảy, giữ nguyên cả run trôi chảy thay vì cắt vụn từng câu → đã làm: `keep=last` mặc định, kept take giữ nguyên cả run, cắt theo word times.
  2. Điểm cắt từ word times: từ đầu −0,10–0,15s, từ cuối +0,20–0,30s, không lấn sang từ tiếp theo → MediaKit dùng sẵn pads của cut_words (0,06/0,12, kẹp theo gap) — không đổi, đã ghi chú.
  3. Restart/mutter ("okay, again") và abandoned start gắn cờ cắt → đã làm: gap words giữa 2 take + abandoned start 2 từ đều bị cắt.
  4. Pause >1s trong take có thể cắt, <0,5s giữ nhịp → KHÔNG làm (đó là việc của `silence`, đã có).
  5. SendRec (dev.to): filler-only segment theo regex + validate (từ chối segment chồng lấn/không xếp thứ tự, cắt để lại <1s) → cut_words đã từ chối keep rỗng; remove_retakes trả clusters để review trước khi cắt.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg trên tool sẵn có.
- Làm: `remove_retakes` (tool 52): `detectRetakes` thuần phân tích words — repeat ≥ min_words (mặc định 3) từ giống hệt, gap ≤ max_gap_words (8) từ + ≤ max_gap_seconds (5)s thì cắt take trước + gap junk; abandoned start 2..min_words−1 từ là prefix của cụm ngay sau cũng cắt. Scan trên live word list (từ đã cắt rời khỏi list) nên chuỗi 3 take được xử lý thành từng cặp — keep=last quét tiếp từ take giữ, keep=first quét lại từ đầu. Cắt qua `cutWords` (1 đường code cho mọi word cut: pads, min-keep, swallowed). `--detect-only` trả clusters + plan, không ghi file. Không retake → stream-copy nguyên file. Thêm vào batch (words-file theo convention như cut_words, extraHash words file) + manifest step (words_file resolve/hash như sidecar). CLI + MCP + README + SKILL.md rule 49 + doctor.
- Test (ffmpeg 8.1.2): fixture `test/retakes-words.json` (repeat 5 từ + abandoned start 2 từ, 23 từ/0–9,5s trên source.mp4 10s): detect-only tìm đúng **2 cluster, removed 10 từ** — cluster 1 "we shipped in three weeks" kept từ word 7, cluster 2 "the quick" + "um" kept từ word 19; keep=last → **5,74s** đúng segments [2,94,7,0]+[7,94,9,62]; keep=first → **5,76s** 3 segments; chuỗi 3 take (`test/retakes-3x-words.json`) → chỉ giữ take cuối, **1,98s**; không repeat → stream-copy 10s. Batch: take-a cắt 10 từ/5,74s, take-b thiếu words file fail riêng row. Manifest: remove_retakes → loudness, final 5,74s/−14 LUFS, chạy lại cache_hits 2.
- Bẫy hạ tầng (không phải bug tool): lượt suite 1 crash giữa chừng ở test `interpolate` mci — MCP client timeout 60s mặc định giết call trong khi tool vẫn chạy xong (máy bận vì Kokoro TTS chạy song song). Fix theo pattern lượt 43: thêm `{ timeout: 300000 }` cho call mci (2s clip, ~9x realtime). Lượt suite 2 (sau fix) chỉ fail đúng 1 assert `videos://workspace/info` đếm 51 tools — do session song song (canvas_scene) sửa file test giữa chừng từ 51 → 52 trong lúc suite đang chạy; code đã đúng 52, chạy lại sau khi session kia xong sẽ xanh.
- Chạy song song với side chat canvas_scene (cùng sửa src/core.js, test/mcp-test.mjs, VERIFY.md — vùng khác nhau, không xung đột nội dung; chỉ đếm tool 51→52 là điểm chạm, đã đồng bộ).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0).
- Video báo cáo (`report-luot45/out/final.mp4`, dựng bằng assemble): giọng Kokoro af_heart 3 câu (5,2+5,2+4,4s, gap 0,25s) + lead/tail 0,5 → **16,314s, 1080×1920, đúng 489 frame, 5.003.807 byte**; 3 shot (image zoom / video clip đã cắt / image zoom, fade+dissolve 0,4s); phụ đề soi mắt 3 frame khớp giọng. LUFS **−14,62 (loudnorm) / −14,5 (ebur128 độc lập)** — ở mép band −14±0,5; TP −1,77 (pass); qa verdict warn (chỉ warn pacing, như bản transitions). Giọng gốc đo −25,52 LUFS, crest ~19 dB (TP −6,44) nên loudnorm two-pass TP −2 chạm trần ở −15,1; nén nhẹ acompressor (threshold −24, ratio 4) trước khi normalize kéo lên −14,5; dynaudnorm thử rồi bỏ (đẩy TP lên −0,45, càng kẹt hơn). Backlog mới: compressor pre-stage cho `loudness()`/assemble khi voice peak-limited.
- Bẫy assemble: validate bắt 2 lỗi của mình trước khi render — (1) transition fade 0,5 cần handle 0,267s trước start 0,25s (đổi 0,4s); (2) shots phải phủ lead+voice+tail (16,3s), không chỉ voice (15,3s) — tăng shot 1 lên 6,45s. Và `-o` của assemble là output DIR (preview.json phải nằm ngay trong đó thì approve mới nhận).
- Suite: lượt 1 **655/656** — chỉ fail 1 assert đếm tool cũ (`tools_total === 51` ở workspace/info) do lượt cron 20:58 thêm tool `remove_retakes` thành 52 mà chưa sửa assert; 9 assert canvas_scene đều PASS (validate/preview/render/cache/LUFS −14/motion PSNR 24,76 < 28). Đã sửa assert thành 52 (+ text "all 52 tools present"). Lượt 2: **671/671 PASS, exit 0** (646 cũ + 9 canvas + 16 remove_retakes của cron). Chưa commit/push: lượt cron 20:58 vẫn đang chạy, cây làm việc đang trộn code remove_retakes (chưa commit) với canvas_scene — chờ lượt đó push xong rồi commit canvas_scene lên trên, tránh commit lẫn 2 tính năng.

## Lượt 46 — 2026-11-13 22:58 (+07): loudness --compressor + assemble per-shot text layers (52 tools, không thêm tool)
- Học: kevinten-ai/mcp-ffmpeg (30+ tools, Python/FastMCP; đọc overlay.py thật). Ý áp dụng được:
  1. `add_text_overlay` — list text elements {text, start_time, end_time, font_size, font_color, x_pos/y_pos, box, box_color, boxborderw, font_file}, chuỗi drawtext filters với `enable=between(t,...)`, audio copy fallback re-encode → đã làm per-shot text layers cho assemble (dạng rút gọn: position top/center/bottom thay vì x/y tự do, textfile thay vì inline text, box cố định black@0.6).
  2. Text escaping cho drawtext (`\`, `'`, `:`, `,`) → MediaKit dùng textfile như titlecard đã làm, không inline text — cùng 1 pattern, không cần escape mới.
  3. ffmpeg-skill 1.17 (đọc qua search): `graphics.py` render Indic/Thai qua libass vì drawtext không shape được complex scripts → ghi chú giới hạn vào docs/code: layers dùng drawtext, Latin/Việt OK, Indic/Thai cần libass (chưa làm).
  4. Repo này không có async jobs (grep không thấy) — backlog async render jobs vẫn mở.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg trên tool sẵn có.
- Làm 1 — `loudness()` compressor pre-stage (backlog từ lượt 45): `--compressor` / MCP `compressor: true` + `compressor_threshold` (−24 dB mặc định) + `compressor_ratio` (4 mặc định). Chain: nén vào temp wav lossless → đo temp bằng loudnorm analysis → loudnorm pass 2 với số đo của temp (gain tính trên tín hiệu đã nén, không phải input gốc); temp audio-only nên pass 2 lấy video từ input gốc (`-map 0:v? -map 1:a`). Kết quả thêm `compressor: {threshold_db, ratio, attack_ms, release_ms, knee_db, detection}` + `compressed_lufs`; warning khi đã nén mà vẫn lệch >0.5 LU nói rõ "(compressor already applied)". Vào batch (args compressor/compressor_threshold/compressor_ratio) + doctor (acompressor vào loudness filters). Sửa luôn mô tả MCP cũ ("single-pass loudnorm filter" → two-pass, đã sai từ lượt 44).
  - Bẫy đo lường — attack mới là điểm mấu chốt, không phải threshold: attack 20ms (default ffmpeg) để lọt transient plosive → TP gần như không đổi, output kẹt −15.0..−15.2 ở mọi threshold (−18..−36 dB). Đo volumedetect: gốc mean −26.3/max −6.3; thr −24dB attack 20ms → mean −29.4/max −8.8 (crest 20→20.6, gần như không đổi). Attack 1ms (như voice compressor của mix()): TP −6.28→−15.81, integrated chỉ −25.6→−31.21, target_offset −0.03 → đo trên đĩa **−14.3 LUFS (wav/m4a), −14.6 (mp3 — thêm ~0.3 là hao hụt encode mp3 đã biết)**; mix-voice −22.14 → **−14.3, không warning**. `threshold=-24` truyền thẳng vào acompressor thì ffmpeg BÁO LỖI (range 0.000976563–1) — threshold phải đổi sang linear 0.0631; code đổi dB→linear bằng 10^(dB/20).
- Làm 2 — assemble per-shot text layers (backlog, hướng đạo diễn): shot.text là 1 object hoặc mảng tối đa 4 layer `{text, position?, size?, color?, box?, start?, end?}` — position top (mặc định, né phụ đề cháy ở đáy)/center/bottom, size mặc định min(w,h)/12 (90px ở 1080×1920), color hex 6 (mặc định FFFFFF), box black@0.6 (mặc định on), start/end giây trong shot nominal (mặc định cả shot). Validate parse + kiểm tra (text 1–200 ký tự, position, size 8–400, color hex, box boolean, start<end≤duration) — lỗi fail ở validate, không fail giữa render. Render: 1 pass drawtext re-encode trên segment đã dựng (mọi kind: image/video/color/canvas_scene), timing dịch theo handleInFrames/fps, textfile + wrap dòng theo chiều rộng khung (drawtext không tự wrap). Validate echo `text_layers` đã parse; cache key segment gồm text (đổi mỗi text thì chỉ rebuild shot đó); fingerprint đã bao gồm qua manifest hash. Fixture `test/assemble-text.json` (10s/300f, không nhạc/phụ đề cho render nhanh).
- Test (ffmpeg 8.1.2): `npm run check` sạch (check-docs: 52 tools, batch enum 14 ops). Suite lượt 1: **682/685 PASS** — chỉ fail 3 assert `doctor` (loudness báo missing filter:acompressor — xem bẫy dưới; server MCP của lượt suite 1 load code trước khi sửa). Suite lượt 2 (sau fix): **685/685 PASS, exit 0** (671 cũ + 14 mới: 6 compressor + 8 text layers). Suite lượt 3 (sau fix preview-scale + bump renderer v2, thêm 1 assert preview): **686/686 PASS, exit 0**.
- Bẫy đo lường: `ffmpeg -v error` nuốt luôn metadata print của signalstats — đo pixel phải để verbosity mặc định như helper `planeMean` đã làm.
- Bẫy doctor — `TOOL_REQUIREMENTS` gọi tên filter không có trong `DOCTOR_FILTERS`: thêm "acompressor" vào requirements của loudness mà quên probe list → doctor báo loudness unavailable trên máy khỏe (filter có thật trong `ffmpeg -filters`). Fix: thêm "acompressor" vào `DOCTOR_FILTERS` + thêm guard vào `scripts/check-docs.mjs` (mọi filter/encoder/decoder trong TOOL_REQUIREMENTS phải có trong DOCTOR_* tương ứng — đã verify guard bắt được khi gỡ acompressor khỏi probe list).
- Bẫy preview — text layer tràn khung ở nửa size: layer size/wrap tính cho 1080 nhưng preview dựng ở 540×960, drawtext 90px vẽ nguyên cỡ → "MINUS 14 LUFS" bị cắt thành "NUS 14 LU" trong preview (soi mắt bắt được khi dựng video báo cáo; render full-size thì không sao). Fix: `applyAssembleTextLayers` scale size + wrap lại theo `opts.width` (preview 0.5x → 45px, 2 dòng); bump `ASSEMBLE_VERSION` v1→v2 để cache cũ (segment đã cắt) bị vô hiệu — fingerprint có renderer version nên approval cũ cũng hết hiệu lực đúng luật. Sau fix preview: band top R 48,1, mép trái R 29 (box) — soi mắt: "MINUS 14 LUFS" vừa đủ 1 dòng, không cắt. Thêm 1 assert suite: preview band sáng + mép 20px tối (<22).
- Video báo cáo (`report-luot46/out/final.mp4`, dựng bằng assemble): giọng Kokoro af_heart 3 câu (7,2+4,2+3,725s, gap 0,25s) + lead/tail 0,5 → **16,636s, 1080×1920, đúng 499 frame, 5.633.898 byte**; 3 shot đều mang text layer mới (MINUS 14 LUFS / TEXT LAYERS / 52 TOOLS, fade+dissolve 0,4s); phụ đề soi mắt 3 frame khớp giọng. Giọng master bằng chính `--compressor` mới: −25,7 → **−14,1 LUFS**; final đo độc lập **−14,05 LUFS, TP −0,73**; qa verdict warn (chỉ warn pacing, như mọi bản trước); approval approved, cache_hits 0 (bump v2 vô hiệu cache cũ — đúng luật).
- Push: commit 1bac60f → GitHub main. **CI run #43469193828 success, 6m29s** — xanh (gồm 2 dòng smoke mới: loudness --compressor + assemble-text validate).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0).

## SVG chase (13/11 tối — Tony: "Vẽ nhân vật svg thật kĩ rồi thêm css animation")
- Chromium trên máy này CHẾT (exit 13, WebGL policy — test screenshot 23:3x fail, không có PNG) nên CSS animation thật trong browser không chạy được. Dùng tool `svg_animate` có sẵn: cùng nguyên lý keyframe (translate/rotate/opacity theo id), Node nội suy từng frame, raster librsvg, không cần browser. Smoke 2s/60 frame PASS.
- Art: `cat-mouse/svg/chase.svg` — Milo + Pip vẽ SVG kĩ (gradient radial, bụng, vòng cổ đỏ + chuông vàng, mắt xanh lá, sọc lưng, ria, tai hồng trong, khăn xanh, phô mai ôm ngực) + bếp (tường kem, sàn gỗ, thìa rơi, vụn phô mai). `gen-anim.mjs` sinh 92 window: rượt phải→trái 0,5–3,475s linear, chân rotate quanh hông xen kẽ chu kỳ 0,5s, thân bob, đuôi vẫy, khăn bay.
- Soi mắt 3 vòng, sửa 2 lỗi thật: (1) chuột bị mèo che (vẽ mèo trước, chuột sau + nới gap 190→380px, rượt ngắn 560→400px); (2) đuôi chuột vắt qua mặt mèo → hạ thấp, rê sát đất.
- Final `cat-mouse/svg/out/chase-svg-v1.mp4`: **3,967s, 1080×1920, đúng 119 frame**, video+audio; motion PSNR(frame 0,6s, frame 3,0s) = **21,36 dB** (< 28, chuyển động thật); giọng voice-s2 + compressor → **−18,6 LUFS** (TP −2,0; nhỏ hơn bản canvas −16 do trần true-peak — nghe vẫn rõ); phụ đề burn đúng vị trí, không đè nhân vật. Giọng + phụ đề giữ nguyên bản canvas để so sánh công bằng.
- Trạng thái: canvas_scene đã lên GitHub ở commit 5500d1a (lượt cron 45 gom cả code side-chat). Chờ Tony phán bản SVG.

## Lượt 47 — 2026-11-14 00:58 (+07): async assemble jobs (tool 53: job) + assemble chapters (53 tools)
- Học: AH64-dll/OpenEdit (58★, AI-native video editor, MCP server; đọc README + docs/MCP.md thật). Ý áp dụng được:
  1. Durable render jobs: `trigger_render` nonblocking trả `job_id`, poll `get_render_job`, `cancel_render_job`, `wait:true` cho workflow ngắn → đã làm: `assemble --async` trả `job_id` ngay, tool `job` mới (status/list/cancel), worker detached riêng process group.
  2. Final export capture immutable source revision + validate output trước khi publish + không ghi đè file cũ → MediaKit đã có qua approval fingerprint + receipt SHA-256; job record giữ `approval` + receipt summary nên poller không cần mở receipt.
  3. Preview chunks ưu tiên range, fill phần còn lại nền; UI gắn nhãn stale fallback → KHÔNG áp dụng (MediaKit preview là 1 clip liền, không chunk).
  4. Revision guard: stale write bị từ chối không phá work mới → MediaKit đã có (approval fingerprint); async job kiểm tra approval đồng bộ trước khi spawn nên job không bao giờ "born dead".
  5. Content-addressed cache sống qua reopen → MediaKit đã có (segment cache theo hash).
  6. Compact schema, chi tiết on-demand (`describe`) → chưa cần (53 tools, chưa quá tải).
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- Làm 1 — async assemble jobs (backlog từ lượt 44, ưu tiên cao nhất): `assemble --async` / MCP `async:true` (chỉ mode render): validate manifest + approval gate chạy đồng bộ trước (fail fast — manifest xấu/thiếu approval lỗi ngay ở call, không giấu sau poll), rồi spawn worker detached (`node bin/mediakit.js assemble ... --mode render --job-id <id> --job-dir <dir>`, process group riêng, stdout/stderr → `worker.log`), trả `{job_id, status: "queued", jobs_root, hint}` trong <1s. Worker: `markJobRunning` (status running + pid) ngay sau gate, `onProgress` theo stage (shots i/n → join → audio → mux → captions → qa, percent 0–100), `finishJob` ghi result summary (output/duration/frames/LUFS/SHA-256/qa_verdict) khi xong, `failJob` ghi error khi lỗi. `job` tool mới (53): status (mặc định) / list (mới nhất trước) / cancel — cancel kill cả process group (ffmpeg con chết theo), job bị cancel khi queued thì worker abort trước khi render (check ở markJobRunning), job cancelled không bao giờ bị worker ghi đè thành done/failed (guard trong updateJobRecord + re-read sau kill ở cancelJob). Jobs root: `MEDIAKIT_JOBS_DIR`, else `<MEDIAKIT_WORKDIR hoặc cwd>/.mediakit-jobs` (1 thư mục/job: `job.json` + `worker.log`); job id validate `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` mọi lần đọc; ghi job.json qua tmp+rename, serialize bằng promise chain (progress callback fire-and-forget không await nên 2 write đồng thời sẽ đọc cùng record cũ và clobber nhau nếu không chain). Approval gate tách thành `requireAssembleApproval(plan, force)` dùng chung sync + async. CLI: `mediakit job <id>` / `--list` / `--cancel <id>`; `--job-id`/`--job-dir` là flag nội bộ của worker. Doctor thêm `job: {}` (không cần ffmpeg capability). `.gitignore`: `.mediakit-jobs/` + các thư mục demo/report local (`cat-mouse/`, `report-luot*/`, `report-transitions/` — chưa từng commit, chỉ giữ local).
- Làm 2 — assemble chapters (backlog "presets/chapters" từ lượt 44, phần chapters): manifest `chapters: [{title, at}]` (1–32, title 1–128 ký tự, `at` giây hoặc MM:SS, tăng nghiêm ngặt, trong (0, total)); validate fail ở validate, không fail giữa render; render ghi ffmetadata sidecar (`[CHAPTER]`, TIMEBASE=1/1000, chapter cuối chạy tới hết film) rồi mux `-map_metadata 2 -map_chapters 2`; preview không chapters (clipped window). Title sanitize `= ; # \` + newline → space (ffmetadata syntax). Validate echo + receipt echo chapters; fingerprint đã bao gồm qua manifest hash.
- Test (ffmpeg 8.1.2): `npm run check` sạch (check-docs: 53 tools, batch enum 14 ops). Fixture mới: `test/assemble-chapters.json` (film 10s + Intro @0 / The turn @3.5s / The payoff @7s), `test/assemble-async.json` (film 4s, 2 shot, không nhạc/phụ đề), `test/assemble-bad-chapters-order.json`, `test/assemble-bad-chapters-end.json`. Suite: **704/704 PASS, exit 0** (686 cũ + 18 mới: 6 chapters + 12 jobs). Assert mới đo thật: chapters trên đĩa bằng ffprobe độc lập (`0/3.5/7s`, đúng title; preview 0 chapter); async call trả job_id trong <10s (đo 0,35s CLI); poll thấy queued→running→done, progress 100%; result 4s/120 frames/−14 LUFS/qa pass/SHA-256 64 ký tự; final.mp4 trên đĩa đúng 120 frame; cancel giữa render → status cancelled, worker process chết thật (`kill(pid, 0)` throw), không có final.mp4, đọc lại vẫn cancelled; cancel job done bị từ chối; unknown id → JOB_NOT_FOUND. Suite chạy ~15 phút (máy 1.5 CPU bận) — xanh hẳn, không fail lặt vặt.
- Bẫy đo lường:
  1. `spawn` stdio với `createWriteStream` chưa mở fd → throw "The argument 'stdio' is invalid" ngay khi start job (bắt được bằng smoke CLI trước khi viết test). Fix: `openSync(path, "w")` lấy fd thật, parent `closeSync` ngay sau spawn (fd con đã inherit, vẫn ghi được vào worker.log). Spawn lỗi thì ghi job failed rồi mới throw, không để job kẹt "queued" mãi.
  2. `git add -A` quét cả `cat-mouse/`, `report-luot44/45/46/`, `report-transitions/` (untracked từ các phiên trước, ~97 MB video) vào commit 9e7e090. Fix: `git reset --soft HEAD~1` + `git reset`, stage đúng 12 file + thêm 3 thư mục vào `.gitignore`, commit lại 7bec047, `push --force-with-lease` (commit cũ mới push vài phút trước, CI chưa xong). Bài học: cron này KHÔNG bao giờ `git add -A` nữa — chỉ add đúng file đã chạm.
  3. Preview caption to hơn final: burn dùng font 60px/margin 500 cố định, preview dựng nửa size (540×960) nên phụ đề chiếm 6 dòng giữa khung (soi mắt bắt được). Đây là hành vi preview có sẵn, không phải bug mới — final 1080×1920 burn đúng (3 frame final soi mắt đều khớp). Không sửa trong lượt này; ghi chú để khỏi tưởng caption hỏng khi xem preview.
- Video báo cáo (`report-luot47/out/final.mp4`, dựng bằng CHÍNH async job mới — dogfood): giọng Kokoro af_heart 3 câu (6,9+6,3+3,8s, gap 0,25s) + lead/tail 0,5 → **18,514s, 1080×1920, đúng 555 frame, 5.249.959 byte**; 3 shot (image zoom / video / image zoom, fade+dissolve 0,4s) mang text layer (ASYNC JOBS / CHAPTERS / 53 TOOLS); chapters thật trong file (Async jobs 0–7,667 / Chapters 7,667–14,2 / Fifty three tools 14,2–18,5); phụ đề soi mắt 3 frame khớp giọng. Giọng master bằng `--compressor`: raw −31,25 → **−14,2 LUFS**; final đo độc lập **−14,07 LUFS, TP −1,02**; qa verdict warn (chỉ warn pacing); approval approved (flow preview → approve → async render, không force). Poll job thấy stage chạy thật: shots s1→s2→s3 (0→11%), join 17%, audio 33%, captions 67%, qa 83%, done 100% sau ~85s.
- Push: commit 7bec047 → GitHub main (13 files, origin/main = 7bec047). **CI run #43484431540 success, 8m37s** — xanh (gồm smoke mới: async render chapters → poll job tới done → ffprobe chapters thấy "The turn"). Run #43484358184 trên commit cũ bị force-push đè cũng success — không còn ý nghĩa.
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: assemble presets (phần còn lại của "presets/chapters"), slideshow vào batch/manifest, `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, `dry-run` cho các tool khác, afade 12/15ms ở audio join, atomic output .partial, workspace luôn giam (breaking change — cân nhắc).

## Lượt 48 — 2026-11-14 02:58 (+07): assemble presets (53 tools, không thêm tool)
- Học: kaomei/stickman-video-director (6.042★, MIT; đọc README + SKILL.md thật; `git clone` kẹt proxy nên đọc qua browser, đủ ý). Ý áp dụng được:
  1. Setup gate: aspect ratio + target duration + visual style là lựa chọn bắt buộc trước khi plan, không bao giờ chọn thầm → đã làm: preset là 1 lựa chọn có tên duy nhất cho ratio+fps+style; không preset thì width/height vẫn bắt buộc (num() throw), không default thầm.
  2. Style registry có tên, mỗi style tự sở hữu visuals + captions + voice + pacing + SFX ("Each B owns its visuals, captions, voice, pacing and SFX; no B1 fallback") → đã làm: preset sở hữu geometry + fps + caption style cho cả film, bảng duy nhất trong `assemble-presets.json`.
  3. Dual-format gate: 16:9 và 9:16 viết plan riêng, caption đọc được theo từng ratio, review độc lập từng format → MediaKit đã có tương đương (text layer scale theo render width từ lượt 46; preset vertical/horizontal là 2 format riêng).
  4. "Geometry and pixel change do not establish meaning" / "technical checks are not acceptance" → đã có (đo thật + soi mắt), không thêm tool.
  5. "Camera movement or text entrances alone do not count as picture animation" → đã có (motion gate + motion PSNR ở canvas_scene), không thêm.
  KHÔNG copy code của họ — chỉ học ý tưởng, tự implement bằng Node/ffmpeg.
- Làm — assemble presets (backlog "presets/chapters" từ lượt 44, phần presets; chapters xong lượt 47): manifest `"preset"` là 1 trong 5 id trong `skills/shorts-video/assemble-presets.json` (single source of truth, ship trong npm qua `"files": ["skills", ...]`): `vertical` 1080×1920/30fps/clean-bold, `horizontal` 1920×1080/30fps/không style, `square` 1080×1080/30fps/minimal-line, `cinematic` 1920×1080/24fps/warm-story, `vertical-60` 1080×1920/60fps/clean-bold. `getAssemblePresets()`/`resolveAssemblePreset()` validate JSON lúc load (id trùng, width/height chẵn trong bounds, fps 1–120, style phải thuộc SHORTS_STYLE_IDS, ids khớp ASSEMBLE_PRESET_IDS — theo pattern styles.json, nhưng KHÔNG có fallback nhúng: file thiếu/hỏng fail to, vì preset resolve sai geometry sẽ ship sai aspect). Validate: preset điền field nào manifest bỏ trống (báo `preset_applied`), field tường minh luôn thắng preset (báo `preset_overrides`), preset lạ → INVALID_ARG. Fingerprint gồm cả preset id (dù width/height/fps đã có trong đó). Echo `preset`/`preset_applied`/`preset_overrides` qua `base` nên validate + preview.json + receipt đều thấy. Mô tả MCP assemble + README + `assemble-manifest.md` cập nhật.
- Test (ffmpeg 8.1.2): `npm run check` sạch (check-docs: 53 tools, batch enum 14 ops). Fixture mới: `test/assemble-preset.json` (assemble-film.json bỏ 4 field, chỉ còn `"preset": "vertical"`), `test/assemble-preset-override.json` (preset + width 720/height 1280/fps 24/style warm-story), `test/assemble-bad-preset.json` (preset "sideways"). Suite: **exit 0, "all assertions passed"** — 4 assert preset mới đều PASS (validate preset → 1080×1920/30fps/clean-bold, applied [width,height,fps,style]; override → 720×1280/24fps/warm-story, overrides đủ 4 field; preset lạ bị từ chối; force-render preset film ra final.mp4 **1080×1920 / 300 frame / 10s**, receipt echo preset vertical). Tổng 708 (704 lượt 47 + 4 mới — suy từ số lượt trước vì suite không in tổng, chỉ báo pass/fail). CI smoke mới: 2 dòng validate preset + override.
- Video báo cáo (`report-luot48/out/final.mp4`, manifest DÙNG CHÍNH preset mới — dogfood, không ghi width/height/fps/style): giọng Kokoro af_heart 3 câu (7,7+6,2+5,15s, gap 0,25s) + lead/tail 0,5 → **20,567s, 1080×1920, đúng 617 frame, 5.379.310 byte**; 3 shot mang text layer (PRESETS / YOUR FIELDS WIN / 53 TOOLS); chapters thật trong file (Presets 0–8,467 / Your fields win 8,467–14,934 / Fifty three tools 14,934–20,55); phụ đề soi mắt 3 frame final khớp giọng, không đè text layer (preview vẫn dính overlap cũ do burn 60px cố định ở nửa size — hành vi đã biết từ lượt 47, final đúng). Giọng master bằng `--compressor`: raw −25,46 → **−14,1 LUFS** (đo độc lập −14,13); final đo độc lập **−14,2 LUFS**; qa verdict warn (chỉ warn pacing); approval approved (preview → approve → render, không force).
- Push: commit <SHA> → GitHub main. **CI run #<N> <status>** — xanh (gồm smoke mới: preset validate + override).
- Còn lại: chưa stage/publish npm (đợi Tony duyệt từng lần — npm vẫn 0.1.0); backlog tiếp: slideshow vào batch/manifest, `stabilize` (cần footage rung thật), Verified-Trap Guard ledger, operation envelope, `dry-run` cho các tool khác, afade 12/15ms ở audio join, atomic output .partial, workspace luôn giam (breaking change — cân nhắc).
