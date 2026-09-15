#!/usr/bin/env python3
"""faster-whisper bridge for the intelligence and synthesis modules.

Usage:
    python3 scripts/transcribe.py <audio.wav> [--model medium] [--device cpu] \
        [--compute-type int8] [--language ru]

Prints exactly one JSON document to stdout:
    {"language": "ru", "duration": 41.2, "text": "...",
     "words": [{"word": "...", "start": 0.0, "end": 0.3}, ...],
     "segments": [{"start": 0.0, "end": 3.1, "text": "..."}, ...]}

Everything diagnostic goes to stderr so the TypeScript caller can parse stdout blindly.
"""
from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="medium")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="ru")
    parser.add_argument("--beam-size", type=int, default=5)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        print(
            "faster-whisper is not installed. Run: pip3 install faster-whisper",
            file=sys.stderr,
        )
        return 2

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments_iter, info = model.transcribe(
        args.audio,
        language=args.language,
        beam_size=args.beam_size,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
    )

    words = []
    segments = []
    text_parts = []
    for segment in segments_iter:
        segments.append(
            {"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()}
        )
        text_parts.append(segment.text.strip())
        for w in segment.words or []:
            token = w.word.strip()
            if not token:
                continue
            words.append({"word": token, "start": round(w.start, 3), "end": round(w.end, 3)})

    payload = {
        "language": info.language,
        "duration": round(float(info.duration or 0.0), 3),
        "text": " ".join(text_parts).strip(),
        "words": words,
        "segments": segments,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
