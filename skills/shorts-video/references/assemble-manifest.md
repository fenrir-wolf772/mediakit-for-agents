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
  "chapters": [
    {"title": "Intro", "at": 0},
    {"title": "The turn", "at": 3.5},
    {"title": "The payoff", "at": 7}
  ],
  "shots": [
    {"id": "s1", "kind": "image", "source": "frame.png", "duration": 4.2,
     "zoom": {"from": 1.0, "to": 1.15, "focus": [0.5, 0.5], "focus_end": [0.5, 0.4]}},
    {"id": "s2", "kind": "video", "source": "clip.mp4", "start": 2, "duration": 5},
    {"id": "s3", "kind": "image", "source": "still.png", "duration": 1.0},
    {"id": "s4", "kind": "color", "color": "111111", "duration": 1.5,
     "text": {"text": "THE MOON IS LEAVING", "position": "top", "start": 0.5, "end": 1.5}}
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
- `chapters` is optional: 1–32 named markers `{title, at}` with
  `at` in seconds or `MM:SS`, strictly increasing, inside the
  film (`0 <= at < total`). On render they become real MP4
  chapters in `final.mp4` (the last chapter runs to the film
  end); a preview carries no chapters — it is a clipped window,
  so chapter times would not line up. Titles are 1–128
  characters; `= ; # \` and newlines in a title become spaces
  (ffmetadata syntax).
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
  - `canvas_scene`: `scene` is a JS module that draws every frame
    in code (Canvas 2D) — see Canvas scenes below. Real 30fps
    motion, not a still: the director's animation path. Use a
    `.cjs` file — a `.js` scene under a `"type": "module"`
    package is treated as ESM and `module.exports` is not defined
    there (the loader says so when it happens).
  - Any shot after the first may carry `transition: {type,
    duration}` — see Transitions below.
  - Any shot may carry `text` — one text layer object, or an array
    of up to 4: `{text, position?, size?, color?, box?, start?,
    end?}`. A drawtext lower-third / title timed inside the shot:
    `text` is 1–200 characters (long lines wrap to fit the frame);
    `position` is `top` (default — clear of the burned captions,
    which sit near the bottom), `center` or `bottom`; `size` is
    pixels (default min(width, height)/12 — 90px at 1080×1920);
    `color` is a 6-digit hex (default white); `box` draws the
    black@0.6 box behind the text (default on); `start`/`end` are
    seconds inside the nominal shot (default the whole shot) and
    are validated against the shot duration. Layers render in a
    second pass over the built segment, so they work on every shot
    kind (image / video / color / canvas_scene) and are part of
    the segment cache key — changing only the text rebuilds just
    that shot. Latin and Vietnamese shape correctly; complex
    scripts (Indic, Thai) need libass, which layers do not use.

## Motion gate

A still picture that does not move is dead air. An `image` shot
without `zoom`, and a `color` shot, may last at most 2.5s — longer
fails validation (`motion-gate`). Split the shot, or give the image
a zoom. Video shots are assumed to move.

## Transitions

A shot after the first may carry a `transition` — the join from
the previous shot into this one:

```json
{"id": "s2", "kind": "video", "source": "clip.mp4", "start": 2, "duration": 5,
 "transition": {"type": "fade", "duration": 1.0}}
```

- `type` is one of the 49 xfade names `concat` accepts
  (`fade`, `dissolve`, `wipeleft`, `slideleft`, `circleopen`, … —
  the same list, so the two tools agree).
- `duration` is 0.1–10s. It is centered on the cut: half of it
  shows the tail of the previous shot, half the head of this one.
- The total duration does NOT change, and the audio does NOT
  change — transitions are video-only, the voice and music run
  straight underneath. The frame math stays exact: the joined
  video still has exactly `total_frames`.
- How it stays exact: every shot segment is built longer by its
  handles (half the transition on each side), and the xfade
  chain consumes exactly the handles. The duration is converted
  to frames first (`F = round(duration × fps)`), so a 0.5s
  transition at 30fps is 15 frames — 8 before the cut (the next
  shot's incoming handle) and 7 after (the previous shot's
  outgoing handle).
- Rules, all enforced at `validate` time:
  - The first shot cannot have a transition (there is no cut
    before it).
  - The transition must not be longer than the shorter adjacent
    shot.
  - A `video` shot needs the handle footage to exist in its
    source: `start` must be at least the incoming handle before
    the shot, and `start + duration + outgoing handle` must not
    pass the source end. Image and color shots have no such
    limit (their content is generated).
- In a `preview`, a transition is dropped (hard cut, with a
  warning) when its cut falls outside the preview window, or
  when the next shot is clipped below its handle.
- v1 limits: the join itself is not cached (a second render
  reuses the shot segments but re-encodes the join), and there
  is no audio crossfade — the voice timeline is never touched.

## Canvas scenes

A `canvas_scene` shot is code that draws the shot, frame by
frame, in Node with Canvas 2D — the same deterministic pipeline
as the `local-video-pipeline` skill (frame N is a pure function
of `t = N/fps`, no realtime capture, no dropped frames). This is
the director's animation path: smooth 30fps motion for things a
still image cannot do, with no AI video account and no browser.

```json
{"id": "chase", "kind": "canvas_scene", "scene": "chase-scene.js",
 "duration": 3.975,
 "assets": {"bg": "kitchen.png"},
 "params": {"speed": 1.2}}
```

- `scene` is a JS module path (relative to the manifest, like
  every other path). It must export `draw` (CommonJS, same
  contract as the pipeline skill):

  ```js
  // chase-scene.js
  module.exports.draw = async (ctx, t, W, H, assets, M) => {
    // ctx: Canvas 2D context, t: seconds (0..duration), W/H: pixels
    // assets: {name: Image} from the shot's `assets` map
    // M: {duration, fps, params, lib: {camera, fx}}
  };
  ```

  `M.lib.camera` (`shot`/`at`/`apply`, virtual 2D camera) and
  `M.lib.fx` (`ease`/`prog`/`fade`/`pop`/`slide`,
  `makeParticles`/`positions`, `transition`/`drawTransition`,
  `glow`) are vendored into MediaKit from the pipeline skill —
  the scene works with no other dependency. `M.params` is the
  shot's `params` object, so one scene file serves many shots.
  The scene must be deterministic: same `t` ⇒ same frame. No
  `Math.random()`, no `Date.now()` — use `fx.rng(seed)` for
  randomness. A scene that reads the clock or the network is a
  bug, not a feature.
- `assets` (optional) maps names to still-image paths, loaded
  with `loadImage` and handed to `draw` as `assets`. Each must
  be a still image (same probe as an `image` shot).
- `params` (optional) must be a plain JSON object.
- `duration` is 0.5–60s. Rendering costs real CPU (one PNG per
  frame at full size), so keep scenes short — a film is made of
  many short canvas shots, not one long one.
- The motion gate does NOT apply: a canvas scene is assumed to
  move by construction. The author owns the motion; the suite
  proves it by measuring frame-to-frame change on the demo
  scene (two frames 2s apart must differ — PSNR below 25 dB).
- Transitions work like `image` shots: the content is
  generated, so there is no source-handle limit. In a preview,
  a clipped canvas shot renders from `t = 0` for the clipped
  frames.
- The scene runs as local code with the user's privileges — a
  manifest you did not write can run arbitrary JS in its scene
  modules. Only render manifests you trust, the same as any
  code you run.
- Needs the `canvas` npm package (installed with MediaKit).
  If it is missing, `validate` passes but the build fails with
  a clear message telling you to install it.

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
  the measured final duration/dimensions/loudness, the chapters,
  and the `qa_report` result.

## Async renders (jobs)

A full render takes minutes, so the MCP call does not have to
wait for it. `assemble --async` / `async:true` (render mode
only) validates the manifest and the approval gate
synchronously, then returns a `job_id` immediately and renders
in a detached worker process. Poll it with the `job` tool:

- `job {job_id, action: "status"}` — `queued` → `running`
  (with `progress: {stage, percent}` + the live `pid`) → `done`
  (with `result`: output, duration, frames, LUFS, SHA-256, QA
  verdict) or `failed` (with `error`). Poll every 2s — a render
  takes minutes, not seconds.
- `job {action: "list"}` — all jobs, newest first.
- `job {job_id, action: "cancel"}` — stops a queued or running
  job. The worker is its own process group, so the kill takes
  the ffmpeg children with it; a job cancelled while queued is
  never rendered, and a cancelled job stays cancelled — the
  worker never overwrites it with done/failed afterwards.
- Cancelling a terminal job (`done` / `failed` / `cancelled`) is
  refused; an unknown id is `JOB_NOT_FOUND`.
- Jobs live under `MEDIAKIT_JOBS_DIR`, else
  `<workdir>/.mediakit-jobs`, one directory per job (`job.json` +
  `worker.log` — the worker's stdout/stderr, including the
  receipt JSON it printed).

## CLI

```bash
mediakit assemble film.json --mode validate
mediakit assemble film.json --mode preview -o out/ --preview-seconds 20
mediakit assemble film.json --mode approve -o out/
mediakit assemble film.json --mode render -o out/
mediakit assemble film.json --mode render -o out/ --force
mediakit assemble film.json --mode render -o out/ --force --async
mediakit job <job-id>            # status
mediakit job --list              # all jobs, newest first
mediakit job --cancel <job-id>   # stop a queued/running job
```

## Out of scope for v1

Dual-format output (one manifest = one aspect — run `social`
after for the other ratios), and motion detection inside video
shots.
