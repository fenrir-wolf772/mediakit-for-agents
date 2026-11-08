# MediaKit — agent skill

You have professional media tools. Use them instead of guessing about a
video or audio file, and instead of writing one-off ffmpeg shell commands.

## When to use MediaKit

- **Before describing or editing media**: `probe` first. Never guess a
  duration, resolution, or codec from a filename.
- **User asks for a cut, a clip, a shorter version**: `trim`.
- **User asks for vertical / square / a different size**: `crop` + `resize`.
- **User asks for the audio, a voiceover, or a soundtrack**: `extract_audio`.
- **User asks "what does it look like at 0:12?"**: `extract_frame`, then
  read the image. For an overview of the whole clip: `thumbnail`.
- **Audio is too quiet/loud or inconsistent**: `loudness` (default −14 LUFS).
- **User asks to join clips**: `concat`.
- **User asks for captions/subtitles on the video**: `burn_captions`.
- **User asks for a different format**: `convert`.

## How to call the tools

Prefer the MCP tools (`probe`, `trim`, `crop`, …) when they are available.
The CLI mirrors them one-to-one if you are in a shell:

```bash
mediakit probe clip.mp4
mediakit trim clip.mp4 --start 2 --duration 8 -o clip-short.mp4
mediakit extract-frame clip.mp4 --timestamp 3.5 -o frame.png
```

Every call returns JSON with the output path, size, and verified
duration/dimensions. If a call fails, read the error — it usually tells you
exactly what was wrong (missing file, crop out of bounds, bad format).

## Rules that save you rework

### 1. Probe before you transform
Always `probe` first. A crop of 720×1280 fails on a 640×360 source; a trim
past the end of the file fails too. The probe result is the ground truth.

### 2. Re-encode vs stream copy (trim)
- **Default trim re-encodes**: frame-accurate cuts at any timestamp.
  Slower, slight quality loss (one generation).
- **`stream_copy: true`**: near-instant and lossless, but cuts only land
  on keyframes — the actual cut point can be up to a few seconds off.
  Use it for rough cuts, previews, or splitting long files; use the
  default for publish-ready clips.

### 3. Crop then resize — in that order
To turn 16:9 into 9:16: first `crop` the center 720×1280 region, then
`resize` to 1080×1920. Resizing first and cropping after wastes pixels;
cropping to the exact final size in one step is fine too if the source is
sharp enough.

### 4. Even dimensions
H.264 (yuv420p) needs even width/height. `resize` with `keep_aspect`
rounds to even automatically. If you `crop` by hand, use even numbers.

### 5. Loudness: −14 LUFS is the default for a reason
YouTube, Spotify, and TikTok all normalize to around −14 LUFS. Normalizing
to −14 means your audio sounds the same loudness as everything else on the
platform. Use −16 LUFS for podcasts, −23 LUFS only for broadcast (EBU R128).
Single-pass loudnorm (what this tool does) is fast and good for speech and
creator audio; it is not sample-exact broadcast mastering.

### 6. Captions must exist before you burn them
`burn_captions` needs a real `.srt`, `.ass`, or `.vtt` file. If the user
only has raw text, write the SRT yourself first (format below), then burn.
Hardcoded captions cannot be turned off later — keep an uncaptioned master.

SRT format (timestamps `HH:MM:SS,mmm`):
```
1
00:00:00,000 --> 00:00:02,500
First line of caption

2
00:00:02,500 --> 00:00:05,000
Second line of caption
```

Keep lines short (≤ 42 chars), max 2 lines per cue, and never let a cue
span a sentence break awkwardly. For vertical video use `--font-size 48`
or larger — 24px is for 720p landscape.

### 7. Concat re-encodes — that's a feature
`concat` re-encodes all parts to one codec, so clips with different
resolutions, codecs, or frame rates join cleanly. It is slower than a
stream-copy concat, but it doesn't fail on mismatched inputs.

### 8. Convert: copy what you don't need to change
`convert` with no codec arguments stream-copies both streams (a fast
re-mux). Pass `--video-codec libx264` only when you actually need to change
the codec. CRF 23 is a good default for H.264; 18–20 for near-lossless,
28+ for small files.

## Workflow: vertical captioned clip from a landscape source

1. `probe` the source.
2. `crop` the center 9:16 region (width = height × 9/16, x centered).
3. `resize` to 1080×1920.
4. Write an SRT from the script/voiceover.
5. `burn_captions` with a large font size.
6. `probe` the result and `extract_frame` at a mid timestamp to verify
   the captions actually render.

See `skills/shorts-video/SKILL.md` for the full scripted workflow.
