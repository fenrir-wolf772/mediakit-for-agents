# Publishing Kit — references/publishing-kit.md

One optional finishing step for a finished Short, not a mode of its
own. Adapted from stickman-video-director's Thumbnail & Publishing
Kit, rebuilt on MediaKit tools.

## When to offer and when to stop

- Offer **once**, only after the user confirms the final video is
  satisfactory. A script approval, a sample approval or a successful
  render is not final-video approval.
- If the user declines, defers or says they are done, acknowledge and
  stop. Do not repeat the offer on resume. Reopen it only when the
  user asks, or for a new video.
- An explicit early request can use the approved script. Label the
  result a draft: final timestamps and media-rights checks remain
  pending where evidence is absent.
- Opting in authorizes this finishing task, not a paid call, a
  subscription, or publishing/uploading to any account. `publish_kit`
  publishes nothing — it writes files.

## Reuse the video's approved design

Use the existing brief, script, audience, locked style id from
`styles.json`, palette, and approved images. Do not ask the user to
describe everything again. Preserve the style's drawing/lettering
rules; do not impose one generic thumbnail look across styles.

## What the agent writes (the tool cannot write these)

The agent writes the copy; `publish_kit` only checks it:

1. **Five title variants** — distinct, accurate, covering search
   intent, curiosity and broad appeal. No unsupported numbers,
   monetization guarantees or promises of virality. The tool flags
   hype phrasing ("guaranteed", "100% viral", "get rich", ...) as a
   warning; a flagged title is the agent's call to rewrite, not an
   automatic rejection.
2. **Description and tags** — paste-ready summary, 1–30 tags.
   Timestamps/chapters only from a verified timeline of the final
   cut; omit them or mark them pending otherwise, never estimate
   them from a script.
3. **Pinned comment** — one genuine question inviting discussion,
   without fabricating controversy.

## What the tool checks

`publish_kit` takes the finished video, a 1280×720 16:9 thumbnail,
the copy above, and an output directory, and writes
`metadata.md` + `publishing.json` there:

- Thumbnail is 16:9 and at least 1280px wide (measured with ffprobe).
- Exactly 5 distinct titles, each 1–100 characters.
- Chapter times are inside the measured video duration, in order.
- SHA-256 of the media and the thumbnail is recorded.
- The locked style id is recorded when given; an unknown id is
  refused.

## What stays human-review

The checklist marks these `[ ] HUMAN REVIEW` — the tool never passes
them, because pixels alone cannot prove them:

- Mobile readability / safe zones of the thumbnail.
- Script / title / cover fidelity — the thumbnail shows something
  actually in the video.
- Music / SFX / image licences for everything in the video.

Content-ID and platform monetization eligibility cannot be certified
by this checklist; flag unverified rights, do not claim clearance.

## CLI

```bash
mediakit extract-frame short.mp4 --timestamp 1 -o thumb.png
# thumb.png must be 1280x720 for a landscape video; use `thumbnail`
# or a 1280x720 frame for the kit's cover.
mediakit publish-kit short.mp4 --thumbnail thumb.png --kit-file kit.json -o publishing/ --style clean-bold
```

`kit.json`:

```json
{
  "titles": ["...", "...", "...", "...", "..."],
  "description": "...",
  "tags": ["brain", "psychology"],
  "pinned_comment": "What did you miss?",
  "chapters": [{"time": 0, "label": "The trick"}]
}
```

`chapters` is optional — omit it when the final cut has no verified
timeline. A style change never regenerates the kit's copy; a cover
revision never re-renders the film.
