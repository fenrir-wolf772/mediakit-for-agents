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
  between the two cards. The same two tools also take `--brand <id>`
  (same registry as assemble): primary is the title-card box,
  on_primary its text; background is the intro background, text its
  text. Resolution is explicit > brand > style > default, and the
  brand never sets the font size. Your own brand ids come from a
  `MEDIAKIT_BRANDS` file (same shape as `brands.json`): they add to
  the three built-ins and can never redefine one — `doctor` lists
  them under `brands_file`.
- Do not import another style's look into this video, and do not fall
  back to a different style because a tool failed — fix the tool call,
  or say what is blocked.

## Workflow

### Step 1 — Source
If you have a landscape video: `probe` it, note resolution and duration.
`probe` reports the coded size plus `rotation` and the display size —
trust the display size: a phone clip coded 1920×1080 with rotation 90
is a 1080×1920 vertical video, not a landscape one, and `check` judges
it as displayed. If you are building from stills/script only: generate
or collect the visuals first (images or a screen recording), then
assemble with `concat`. When joining clips, `concat` stream-copies
only when the clips are identical down to the video `time_base` and
the display size — a time_base mismatch re-encodes through the
filter graph instead (the concat demuxer copies timestamps verbatim
and stretches the join), and a rotated clip counts at its display
size (720×1280, not the stored 1280×720).

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

### Step 5b — B-roll (optional)
- Cutaways go in with `broll`, not by hand-cutting the main timeline:
  `mediakit broll main.mp4 --clip cutaway.mp4@12@3 -o out.mp4 --audio broll`
  drops the cutaway over 12–15s (fullscreen) and swaps the audio to it
  for that window; `--position bottom-right --scale 0.5` keeps it as a
  PiP instead. The output is exactly the main duration — the main track
  is never re-timed. `--fade 0.5` dissolves in/out; windows must not
  overlap; a window past the end is clamped, not refused. With
  `--audio main` (default) the main audio plays straight through the
  cutaway; with `--audio mix` both play together.

### Step 5c — Fast-forward (optional)
- Dead air and long waits get sped up, not cut: `mediakit fastforward
  in.mp4 --span 5-9@4 -o out.mp4` plays 5–9s at 4x (saves 3s) and burns
  a `">> fast-forward x4"` badge bottom-right on the sped span, so the
  viewer knows the wait was compressed. Spans are repeatable (max 16),
  clamped to the clip, and overlaps collapse onto the previous span's
  end; everything after a span keeps its place and the audio keeps its
  pitch. `--no-badge` skips the badge, `--label` changes its word.

### Step 6 — Verify before you call it done
1. `probe` the final file: 1080×1920, duration as expected.
2. `extract_frame` at 3 timestamps (start, middle, end): captions visible
   and correct, subject framed, nothing important cropped out.
3. `thumbnail` for a quick whole-clip overview.
4. `check --platform tiktok --faststart` when the file goes to the web:
   an MP4 whose moov box sits after mdat makes the player download
   the whole file before the first frame — re-mux with
   `-movflags +faststart` until the rule passes.
5. `release_checkpoint` as the one-command gate once the clip is
   finished — receipt + platform + loudness + clipping + cuts +
   contact sheet in one verdict (`mediakit release-checkpoint
   out.mp4 --manifest film.json --receipt assemble-receipt.json`,
   exit 0 pass / 1 fail); a check with nothing to measure reports
   `skipped`, never a fake pass.
6. Record the style id used, so a later re-render or a publishing kit
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
(schema + rules in `references/assemble-manifest.md`). Start with
`mediakit init <dir>` instead of writing the manifest by hand: it
scaffolds a project that already validates (a 4s vertical film,
two template shots, a placeholder voice to replace, placeholder
captions, and a `CLAUDE.md` with the lifecycle) — edit the scaffold,
don't debug a blank manifest into existence. The voice is
the master clock: shots must cover `lead + voice + tail` exactly
in frames, a still without zoom (and a color card) may last at
most 2.5s, and captions burn with the locked style's values.
The modes run in order: `validate` → `plan` (read the resolved
timeline + `exportable`/`blockers` before you render — a plan that
cannot render says so here) → `preview` (show it to the
user) → `approve` → `render`. `plan --plan-file <path>` writes the
plan to a file; preview/approve/render `--from-plan <path>` refuse
a stale plan (any input changed since the plan was written — the
changed parts are named) and refuse a non-exportable plan at
approve/render, so a film edited after planning cannot slip into
a render unnoticed. Never approve your own technical
checks — approval means the user saw the preview and said yes.
A render without approval fails loudly unless the user
explicitly asks for `--force`. A background render (`--async`)
is gated: at most 2 render jobs may be queued-or-running and at
most 10 may start per minute (env `MEDIAKIT_MAX_JOBS` /
`MEDIAKIT_MAX_JOB_STARTS_PER_MINUTE`) — a refused start creates
no job, so check `mediakit job --admission` first when renders
are already running. While a job runs, `mediakit job <id>` also
reports `estimate_remaining_seconds` (rough upper-bound ETA, null
when too early to tell) with `estimate_basis` naming how it was
derived — `progress-rate` from the rate over the most recent 30s of
the percent history when that window holds at least 2 points, else
the whole-run average rate — a guide for the user, never a promise. Long renders on a busy machine can also
hit the 300s ffmpeg timeout — raise it with
`MEDIAKIT_FFMPEG_TIMEOUT_MS` (60000–3600000). A shot after the first may carry
`transition: {type, duration}` (one of the 58 xfade names — see the
`transitions` tool for the catalog grouped by family,
centered on the cut, video-only — the audio never moves); a
video shot needs the handle footage in its source. For real
animation (not a still with a zoom), use a `canvas_scene` shot:
a JS module that draws every frame in code at 30fps — the
director's path, no AI video account needed. A shot may carry a
`role` (`hook`/`context`/`core`/`payoff` — which beat of the arc
it carries) and alternate takes: `variants` (A/B/C, same kind,
each with its own source fields and an optional `hook` label) with
`selected` (index or label, default 0) picking the one that
renders; a film-level `hook: {shot, start?, end?}` pins the
opening segment, and `diagnose` checks the arc (hook first,
payoff last). Reach for a
built-in scene template first (`"template": "bounce"` +
`params`, registry in `scene-templates.json`: `title-card`,
`bounce`, `slide-in`, `spring-in`, `rings` — browse the shelf
with `mediakit list-templates`, one card per template with its
category, motion, recommended duration and tags, or
`--template <id>` for the full detail — a directing prompt
(what to change, what to keep) plus a ready-to-paste
example shot) and write a custom scene file
only when no template fits — template params merge over
defaults, unknown names fail validate. Each template also declares
`faceSafe` + `timingHint` (only `rings` keeps the frame center clear;
title-card/slide-in/spring-in are hook cards, bounce is a core beat),
and `diagnose` warns when a template is used in the wrong slot or
role. For one channel look
across the whole film, set `"brand"` in the manifest
(`amber-teal`, `warm-story`, `minimal-line`, registry in
`brands.json` — or your own ids from a `MEDIAKIT_BRANDS` file):
its palette fills template colors and text-layer
color/size, and its style fills the caption style when no preset
or explicit style sets one — explicit values always win and are
reported in `brand_overrides`.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Captions tiny | font-size 24 on a 1080-wide frame | Use 48–64px for vertical |
| Captions cut off at the sides | Lines too long | ≤ 42 chars/line, split cues |
| Subject's head cropped | Center crop on an off-center subject | Shift crop `x` toward subject |
| Blurry vertical | Upscaled from a 404px-wide crop | Start from 1080p/4K source |
| Audio much quieter than other Shorts | Not normalized | `loudness` to −14 LUFS |
| Captions missing on some lines | SRT cue gap or bad timestamp format | Check `HH:MM:SS,mmm`, no overlaps |

Every tool error also carries its own fix — read `explain` in the
error body before guessing: `{error, code, retryable,
retry_after_seconds?, retry, explain: {kind, fixes}}`. `kind` is the
primary fix — `retry` (re-issue the identical call; only when
`retryable` is true, after `retry_after_seconds` when named),
`switch` (call a different tool — a missing input points at `find`
with the basename as `query`; an unknown job id points at `job`
`action=list`), `fix-arg` (same tool, corrected argument — a stale
`patch_manifest` names the current `expected_revision`; a bad
argument names the field), `check-env` (run `doctor` — a missing ASR
engine is an install problem, not a call problem), or `none` (no safe
fix is known — an ffmpeg failure or a crashed ASR engine never
suggests retry; read the message instead of re-issuing the call). The
CLI prints the same fixes under the error line (`Fix (<kind>): …`).
Never re-issue a call whose `retryable` is `false` unchanged.

## One-command recap (landscape → vertical captioned Short)

```bash
mediakit probe input.mp4
mediakit crop input.mp4 --width 404 --height 720 --x 438 --y 0 -o cropped.mp4
mediakit resize cropped.mp4 --width 1080 --height 1920 --no-keep-aspect -o vertical.mp4
mediakit burn-captions vertical.mp4 --captions captions.srt --style background --font-size 60 --margin-v 500 -o short.mp4
mediakit probe short.mp4
mediakit extract-frame short.mp4 --timestamp 3 -o check.png
```
