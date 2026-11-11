#!/usr/bin/env python3
"""Transcribe a 16 kHz mono WAV with faster-whisper; print JSON segments.

Reads the WAV with the stdlib `wave` module and feeds a float32 numpy
array to the model, so faster-whisper never touches PyAV — faster-whisper
1.2.1 + PyAV >= 15 breaks in decode_audio (`metadata_errors` was removed
from av.open), and MediaKit already extracts to 16 kHz mono WAV with
ffmpeg, so there is nothing for PyAV to do here.

Usage: asr_faster_whisper.py --wav in.wav [--model tiny] [--language en]
Prints: {"language": "en", "language_probability": 1.0,
"duration_seconds": 11.0, "segments": [{"start": 0.0, "end": 11.0,
"text": "..."}]} — segments are speech only; silence yields [].
"""
import argparse
import json
import sys
import wave

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True, help="16 kHz mono 16-bit WAV")
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--language", default=None,
                    help="ISO 639-1 code, or omit for auto-detect")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    args = ap.parse_args()

    with wave.open(args.wav, "rb") as w:
        if w.getnchannels() != 1 or w.getframerate() != 16000 or w.getsampwidth() != 2:
            print(f"expected 16 kHz mono 16-bit WAV, got {w.getnchannels()}ch "
                  f"{w.getframerate()} Hz {w.getsampwidth() * 8}-bit",
                  file=sys.stderr)
            return 2
        frames = w.readframes(w.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device=args.device,
                         compute_type=args.compute_type)
    segments, info = model.transcribe(audio, language=args.language)
    out = {
        "language": info.language,
        "language_probability": round(info.language_probability, 4),
        "duration_seconds": round(info.duration, 3),
        "segments": [
            {"start": round(s.start, 3), "end": round(s.end, 3),
             "text": s.text.strip()}
            for s in segments
        ],
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
