# MediaKit for Agents

Give your coding agent eyes and ears for media. MediaKit is a small MCP
server + CLI that wraps **ffmpeg** — trim, crop, resize, captions, loudness,
thumbnails, frame grabs, audio extraction, concat, and conversion — so an
agent can actually *work* with video and audio instead of guessing.

> Coding agents are blind and deaf to media. They can read a 10,000-line
> codebase but can't tell you how long a clip is, pull a frame from it, or
> make it vertical. MediaKit fixes that with one install.

## Quickstart

```bash
npx mediakit-for-agents probe clip.mp4
```

Or install it globally:

```bash
npm install -g mediakit-for-agents
mediakit trim clip.mp4 --start 2 --duration 8 -o clip-short.mp4
```

### Use it from Claude Code / Cursor / Codex (MCP)

Add to your MCP config (`.mcp.json` or your client's settings):

```json
{
  "mcpServers": {
    "mediakit": {
      "command": "npx",
      "args": ["-y", "mediakit-for-agents", "mcp"]
    }
  }
}
```

Then ask your agent things like:

- *"How long is this video, and what's its resolution?"*
- *"Make this clip vertical 1080×1920 and burn the captions in."*
- *"Normalize the voiceover to -14 LUFS and pull out the audio as MP3."*

**Requirements:** `ffmpeg` and `ffprobe` on your PATH
([ffmpeg.org/download](https://ffmpeg.org/download.html)). Node 18+.

## Tools

| Tool | What it does | CLI |
|---|---|---|
| `probe` | Duration, dimensions, codecs, streams (ffprobe) | `mediakit probe in.mp4` |
| `trim` | Cut a clip by start + duration/end | `mediakit trim in.mp4 --start 2 --duration 5 -o out.mp4` |
| `crop` | Crop to a rectangle (w, h, x, y) | `mediakit crop in.mp4 --width 720 --height 1280 -o out.mp4` |
| `resize` | Resize, keeping aspect ratio by default | `mediakit resize in.mp4 --width 1080 -o out.mp4` |
| `extract_audio` | Pull the audio track out (mp3/aac/wav/ogg/opus/flac) | `mediakit extract-audio in.mp4 -o out.mp3` |
| `extract_frame` | Grab one frame at a timestamp | `mediakit extract-frame in.mp4 --timestamp 3.5 -o frame.png` |
| `thumbnail` | Contact sheet of N evenly spaced frames | `mediakit thumbnail in.mp4 --frames 6 -o sheet.jpg` |
| `loudness` | Normalize to a loudness target (default −14 LUFS) | `mediakit loudness in.mp3 -o out.mp3` |
| `concat` | Join 2+ files into one (re-encodes, mixed codecs OK) | `mediakit concat a.mp4 b.mp4 -o joined.mp4` |
| `burn_captions` | Burn .srt/.ass/.vtt subtitles into the video | `mediakit burn-captions in.mp4 --captions subs.srt -o out.mp4` |
| `convert` | Change container/codec (omit a codec to stream-copy) | `mediakit convert in.mov -o out.mp4 --video-codec libx264` |

Every tool returns a concise JSON result: output path, size, and the
verified duration/dimensions of what it produced.

## Demo: 16:9 clip → vertical captioned Short

```bash
# 1. Inspect the source
mediakit probe input.mp4

# 2. Center-crop to 9:16, then resize to 1080×1920
mediakit crop input.mp4 --width 720 --height 1280 --x 280 --y 0 -o cropped.mp4
mediakit resize cropped.mp4 --width 1080 -o vertical.mp4

# 3. Burn captions on
mediakit burn-captions vertical.mp4 --captions captions.srt -o short.mp4

# 4. Check the result
mediakit probe short.mp4   # 1080x1920, same duration, captions visible
```

See [`skills/shorts-video/SKILL.md`](skills/shorts-video/SKILL.md) for the
full script → captioned vertical-video workflow.

## Safety

- No shell is ever involved: every ffmpeg call uses `execFile` with an
  argument array, so filenames and user input can't inject commands.
- Outputs are never allowed to overwrite their inputs.
- Inputs are validated (must exist and be readable) before ffmpeg runs.

## Skills included

- [`skills/mediakit/SKILL.md`](skills/mediakit/SKILL.md) — agent-facing
  guide: when to use each tool, re-encode vs stream copy, loudness targets.
- [`skills/shorts-video/SKILL.md`](skills/shorts-video/SKILL.md) — the
  short-form vertical-video workflow (script → 1080×1920 captioned clip).

## License

MIT — see [LICENSE](LICENSE).
