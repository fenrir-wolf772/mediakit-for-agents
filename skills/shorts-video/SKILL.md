# Shorts Video — script → 1080×1920 captioned vertical clip

Use this workflow whenever the user wants a short-form vertical video
(YouTube Shorts / TikTok / Reels) built from a script or an existing clip.
All media work goes through the MediaKit tools — never raw ffmpeg shell
commands.

## Inputs you need

- **Script**: the spoken lines, with approximate timing, OR an existing
  landscape video + its voiceover.
- **Target**: 1080×1920, 9:16, 30–60s is the sweet spot.
- **Captions**: SRT you write from the script (see below).

## Workflow

### Step 1 — Source
If you have a landscape video: `probe` it, note resolution and duration.
If you are building from stills/script only: generate or collect the
visuals first (images or a screen recording), then assemble with `concat`.

### Step 2 — Go vertical
Center-crop to 9:16, then resize to 1080×1920:

```
crop:   width = floor(height * 9 / 16) made even, x = (source_width - width) / 2
resize: width 1080 (keep_aspect)
```

Example for a 1280×720 source:
- crop 720×1280 is impossible (source is only 720 tall) — instead crop
  **405×720** (720 × 9/16 = 405) centered, then resize to 1080×1920.
  Upscaling 405 → 1080 softens the image; if the source is 1080p or 4K,
  prefer cropping from the full-resolution file.
- If the subject is off-center (talking head on the left), shift `x`
  toward the subject instead of centering blindly. `extract_frame` first
  and look at it.

### Step 3 — Captions (SRT)
Write the SRT from the script. Rules:
- One idea per cue, ≤ 2 lines, ≤ 42 characters per line.
- Cue boundaries on natural pauses, not mid-word.
- 1–3 seconds per cue for Shorts pacing; never leave a gap with no
  caption while someone is speaking.
- Use the exact spoken words, including filler if it's in the voiceover.

```
1
00:00:00,000 --> 00:00:02,000
Your brain deletes

2
00:00:02,000 --> 00:00:04,500
most of what you see.
```

### Step 4 — Burn captions
`burn_captions` with `--font-size 48` (1080-wide vertical needs big type).
Verify with `extract_frame` at a timestamp where a caption should show —
read the frame and confirm the text is legible, not cut off at the edges,
and not sitting under the platform's UI zone (keep captions in the middle
third vertically when possible; the bottom ~15% is covered by TikTok's
buttons and caption bar on phones).

### Step 5 — Audio
- Voiceover too quiet vs music: `loudness` the voice to −14 LUFS first,
  then mix music underneath at a lower level.
- If the clip has no audio track, that's fine — platforms add music.
  Don't invent an audio track the user didn't ask for.

### Step 6 — Verify before you call it done
1. `probe` the final file: 1080×1920, duration as expected.
2. `extract_frame` at 3 timestamps (start, middle, end): captions visible
   and correct, subject framed, nothing important cropped out.
3. `thumbnail` for a quick whole-clip overview.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Captions tiny | font-size 24 on a 1080-wide frame | Use 48–64px for vertical |
| Captions cut off at the sides | Lines too long | ≤ 42 chars/line, split cues |
| Subject's head cropped | Center crop on an off-center subject | Shift crop `x` toward subject |
| Blurry vertical | Upscaled from a 405px-wide crop | Start from 1080p/4K source |
| Audio much quieter than other Shorts | Not normalized | `loudness` to −14 LUFS |
| Captions missing on some lines | SRT cue gap or bad timestamp format | Check `HH:MM:SS,mmm`, no overlaps |

## One-command recap (landscape → vertical captioned Short)

```bash
mediakit probe input.mp4
mediakit crop input.mp4 --width 405 --height 720 --x 437 --y 0 -o cropped.mp4
mediakit resize cropped.mp4 --width 1080 -o vertical.mp4
mediakit burn-captions vertical.mp4 --captions captions.srt --font-size 48 -o short.mp4
mediakit probe short.mp4
mediakit extract-frame short.mp4 --timestamp 3 -o check.png
```
