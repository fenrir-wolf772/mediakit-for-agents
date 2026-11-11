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
