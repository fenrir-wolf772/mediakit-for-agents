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
- **Style**: exactly one id from `styles.json` — `clean-bold` (default),
  `minimal-line`, or `warm-story`. See Style lock below.

## Style lock

Each style in `styles.json` owns its caption treatment, title card,
grade and mix. Pick one **before** burning captions and record the id
in the project's notes (and in `publish_kit`, which enforces the same
three ids in code).

- Never change a locked value silently: a different font size, caption
  style, grade or music level is a style change, not a tweak.
- Changing the style after captions are burned means re-burning
  captions and re-verifying frames (Step 6). The old render is not
  the new style.
- A user request for one specific value (e.g. bigger type) is a scoped
  override for that video only: record it, do not rewrite `styles.json`.
  The tools report it for you: pass the value explicitly alongside
  `--style <id>` and the result lists it in `style_overrides`.
- `titlecard` and `intro` take the same `--style <id>` — the title card
  uses the style's locked text/box/font directly; the intro maps the
  box colour to its background. No hex values to retype, no drift
  between the two cards.
- Do not import another style's look into this video, and do not fall
  back to a different style because a tool failed — fix the tool call,
  or say what is blocked.

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
  **404×720** (720 × 9/16 = 405, rounded down to even — H.264 needs
  even dimensions, so `crop` reports 404) centered, then resize to
  1080×1920 with an explicit height (`--height 1920 --no-keep-aspect`:
  width-only resize would give 1080×1924 from a 404-wide crop and
  fail `check --platform tiktok`). Upscaling 404 → 1080 softens the
  image; if the source is 1080p or 4K, prefer cropping from the
  full-resolution file.
- If the subject is off-center (talking head on the left), shift `x`
  toward the subject instead of centering blindly. `extract_frame` first
  and look at it.

### Step 3 — Captions (SRT, semantic)
Prefer word timings over hand-written cues. If you have word timings
(Whisper word timestamps, or timings you measured from the voiceover),
pass them to `generate_srt` with `--words-file`: it groups words into
semantic cues — max 8 words, 3.5s, 84 characters per cue; splits on
pauses over 0.4s and on sentence ends; a cue never ends on a stranded
word like "the" or "of". The grouping report comes back in the result,
so you can see why each cue split. Only write cues by hand when you
have no word timings. Either way:
- One idea per cue, ≤ 2 lines, ≤ 42 characters per line.
- Cue boundaries on natural pauses, not mid-word.
- 1–3 seconds per cue for Shorts pacing; never leave a gap with no
  caption while someone is speaking.
- Use the exact spoken words, including filler if it's in the voiceover.

```
1
00:00:00,000 --> 00:00:02,300
Your brain deletes most of what you see

2
00:00:02,300 --> 00:00:03,300
every single day
```

### Step 4 — Burn captions
Use the locked style's `burn_captions` values from `styles.json`
(`clean-bold`: `--style background --font-size 60 --margin-v 500`).
Do not invent a different size or style for this video.
Verify with `extract_frame` at a timestamp where a caption should show —
read the frame and confirm the text is legible, not cut off at the edges,
and not sitting under the platform's UI zone (keep captions in the middle
third vertically when possible; the bottom ~15% is covered by TikTok's
buttons and caption bar on phones).

### Step 5 — Audio
- Voiceover too quiet vs music: `loudness` the voice to −14 LUFS first,
  then mix music underneath at the locked style's level (`clean-bold`:
  music volume 0.3, duck 12 dB; `warm-story`: 0.25, duck 12 dB;
  `minimal-line`: no music bed).
- If the clip has no audio track, that's fine — platforms add music.
  Don't invent an audio track the user didn't ask for.

### Step 6 — Verify before you call it done
1. `probe` the final file: 1080×1920, duration as expected.
2. `extract_frame` at 3 timestamps (start, middle, end): captions visible
   and correct, subject framed, nothing important cropped out.
3. `thumbnail` for a quick whole-clip overview.
4. Record the style id used, so a later re-render or a publishing kit
   for this video names the same style.

### Step 7 — Publishing kit (offer once, after approval)
Only after the user confirms the final video is satisfactory, offer
once to build a publishing kit with `publish_kit` — see
`references/publishing-kit.md`. If they decline or defer, stop; do not
repeat the offer. A sample approval or a successful render is not
final-video approval.

## Assemble a film from a manifest (multi-shot)
When the video is several shots on one voice track, don't run the
steps above shot by shot — write a film manifest and use `assemble`
(schema + rules in `references/assemble-manifest.md`). The voice is
the master clock: shots must cover `lead + voice + tail` exactly
in frames, a still without zoom (and a color card) may last at
most 2.5s, and captions burn with the locked style's values.
The modes run in order: `validate` → `preview` (show it to the
user) → `approve` → `render`. Never approve your own technical
checks — approval means the user saw the preview and said yes.
A render without approval fails loudly unless the user
explicitly asks for `--force`. A shot after the first may carry
`transition: {type, duration}` (one of the 49 xfade names,
centered on the cut, video-only — the audio never moves); a
video shot needs the handle footage in its source.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Captions tiny | font-size 24 on a 1080-wide frame | Use 48–64px for vertical |
| Captions cut off at the sides | Lines too long | ≤ 42 chars/line, split cues |
| Subject's head cropped | Center crop on an off-center subject | Shift crop `x` toward subject |
| Blurry vertical | Upscaled from a 404px-wide crop | Start from 1080p/4K source |
| Audio much quieter than other Shorts | Not normalized | `loudness` to −14 LUFS |
| Captions missing on some lines | SRT cue gap or bad timestamp format | Check `HH:MM:SS,mmm`, no overlaps |

## One-command recap (landscape → vertical captioned Short)

```bash
mediakit probe input.mp4
mediakit crop input.mp4 --width 404 --height 720 --x 438 --y 0 -o cropped.mp4
mediakit resize cropped.mp4 --width 1080 --height 1920 --no-keep-aspect -o vertical.mp4
mediakit burn-captions vertical.mp4 --captions captions.srt --style background --font-size 60 --margin-v 500 -o short.mp4
mediakit probe short.mp4
mediakit extract-frame short.mp4 --timestamp 3 -o check.png
```
