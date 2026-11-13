# Assemble — film manifest (references/assemble-manifest.md)

`assemble` turns one declarative film manifest into a finished video:
shots on a voice-led timeline, mixed audio, burned captions, QA and a
receipt. Adapted from stickman-video-director's Autopilot mode, rebuilt
on MediaKit tools (`zoom_pan`, `image_to_video`, `mix`, `mux`,
`burn_captions`, `qa_report`) instead of a Canvas renderer.

This is NOT the `manifest` tool. `manifest` runs a linear edit pipeline
(input → steps → output). `assemble` builds a film from many shots on
one timeline, with the voice as the master clock.

## The four modes

1. **`validate`** — reads the manifest, probes the voice and every
   asset, checks the timeline math. Writes nothing. Run this before
   anything renders; a typo fails here in seconds.
2. **`preview`** — renders the first N seconds (default 20) at half
   resolution, with voice, music, SFX and captions, and writes
   `preview.mp4` + `preview.json` (with the fingerprint). Show the
   preview to the user.
3. **`approve`** — records the fingerprint of the exact manifest +
   voice + assets + captions that the preview shows, in
   `.mediakit-assemble-approval.json` next to the manifest. Requires
   a preview whose fingerprint matches the current files. Never
   approve your own technical checks — approval means a human saw the
   preview and said yes.
4. **`render`** — full-resolution render. Requires a matching
   approval, unless `force` is set (recorded as `approval: "forced"`
   in the receipt — use it only when the user explicitly says so).
   Writes the final video + `assemble-receipt.json` into the output
   directory.

## Voice-led timing (the one rule that matters)

The voice is the master clock. Nothing stretches the voice to fit
pictures — pictures fit the voice:

- `total = lead + voice_duration + tail`, with `voice_duration`
  measured by probe, never assumed.
- Every shot has a `duration`; shot durations are converted to
  frames (`round(duration * fps)`) and their sum must equal
  `total_frames = round(total * fps)` **exactly**. A gap or an
  overlap fails validation with the difference in frames and
  seconds. There is no silent trim, no silent pad, no speed change.
- Captions must lie inside `[0, total]`.

## Manifest schema (version 1)

```json
{
  "version": 1,
  "title": "Why the Moon Is Leaving Us",
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "style": "clean-bold",
  "voice": {"path": "voice.mp3", "lead": 0.5, "tail": 0.8},
  "music": {"path": "bed.mp3", "volume": 0.3, "duck_db": 12},
  "sfx": [{"file": "ding.mp3", "at": 3.2, "volume": 1}],
  "captions": "subs.srt",
  "shots": [
    {"id": "s1", "kind": "image", "source": "frame.png", "duration": 4.2,
     "zoom": {"from": 1.0, "to": 1.15, "focus": [0.5, 0.5], "focus_end": [0.5, 0.4]}},
    {"id": "s2", "kind": "video", "source": "clip.mp4", "start": 2, "duration": 5},
    {"id": "s3", "kind": "image", "source": "still.png", "duration": 1.0},
    {"id": "s4", "kind": "color", "color": "111111", "duration": 1.5}
  ]
}
```

- Paths resolve relative to the manifest file (same as the `manifest`
  tool). `width`/`height` must be even. `fps` 1–120.
- `style` is optional; when given it must be one of the locked ids
  in `styles.json` and it sets the caption burn values.
- `voice` is required: `path` plus `lead`/`tail` in seconds (default
  0). `music` is optional (`volume` 0–1, `duck_db` 0–24). `sfx` is
  optional, at most 16, each `{file, at, volume}` with `at` inside
  the final timeline.
- `captions` is optional (`.srt`/`.ass`/`.vtt`).
- `shots`: 1–64, each with a unique `id` and a `duration` of
  0.5–600s:
  - `image`: `source` is a still. With `zoom` it renders through
    `zoom_pan` (`from`/`to` 1–10, `focus`/`focus_end` as [x, y] in
    0–1). Without `zoom` it holds still through `image_to_video`.
  - `video`: `source` is a video file, `start` (default 0) is where
    the shot begins in the source; `start + duration` must not pass
    the source duration. Reframed (crop) to the manifest size.
  - `color`: `color` is a 6-digit hex (RRGGBB). A solid card —
    for separators and title beats.

## Motion gate

A still picture that does not move is dead air. An `image` shot
without `zoom`, and a `color` shot, may last at most 2.5s — longer
fails validation (`motion-gate`). Split the shot, or give the image
a zoom. Video shots are assumed to move.

## Cache and approval

- Shot segments are cached per shot in
  `.mediakit-assemble-cache/` next to the manifest, keyed by the
  shot + asset bytes + dimensions/fps/preset. A re-render reuses
  unchanged shots (verified by size + SHA-256); editing one shot
  rebuilds only that shot. Preview segments use different keys
  (half size), so a preview never pollutes a full render.
- The fingerprint is SHA-256 over the manifest bytes + voice bytes +
  asset bytes + caption bytes + style values. Any change to any of
  them invalidates the approval, and `render` says exactly what
  changed (manifest / voice / asset / captions).
- The receipt (`assemble-receipt.json`) records the fingerprint,
  the approval status (`approved` / `forced`), per-shot cache hits,
  the measured final duration/dimensions/loudness, and the
  `qa_report` result.

## CLI

```bash
mediakit assemble film.json --mode validate
mediakit assemble film.json --mode preview -o out/ --preview-seconds 20
mediakit assemble film.json --mode approve -o out/
mediakit assemble film.json --mode render -o out/
mediakit assemble film.json --mode render -o out/ --force
```

## Out of scope for v1

Crossfades/transitions between shots (plain cuts), per-shot text
layers (use captions, or a `color` card under a burned caption),
dual-format output (one manifest = one aspect — run `social` after
for the other ratios), and motion detection inside video shots.
