#!/usr/bin/env python3
"""edge-tts bridge that also captures word boundaries.

Why not the `edge-tts` CLI: the CLI writes sentence-level SRT, but the karaoke
captions need per-word timings. The Python API streams WordBoundary events with
100-nanosecond offsets, so one synthesis call yields both the MP3 and an exact
word timeline — no Whisper pass on our own audio.

Usage:
    python3 scripts/tts.py --text "..." --voice ru-RU-DmitryNeural \
        --rate +6% --pitch +0Hz --volume +0% \
        --out-audio storage/staged/voice.mp3 --out-words storage/staged/captions.json

stdout: {"audio": "...", "words": N, "durationHint": seconds}
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys


async def synthesize(args: argparse.Namespace) -> dict:
    try:
        import edge_tts  # type: ignore
    except ImportError:
        print("edge-tts is not installed. Run: pip3 install edge-tts", file=sys.stderr)
        sys.exit(2)

    communicate = edge_tts.Communicate(
        args.text,
        args.voice,
        rate=args.rate,
        pitch=args.pitch,
        volume=args.volume,
    )

    words = []
    last_end = 0.0
    with open(args.out_audio, "wb") as audio_file:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_file.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / 10_000_000
                end = start + chunk["duration"] / 10_000_000
                text = str(chunk.get("text", "")).strip()
                if not text:
                    continue
                words.append({"word": text, "start": round(start, 3), "end": round(end, 3)})
                last_end = max(last_end, end)

    with open(args.out_words, "w", encoding="utf-8") as words_file:
        json.dump(words, words_file, ensure_ascii=False, indent=2)

    return {"audio": args.out_audio, "words": len(words), "durationHint": round(last_end, 3)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", default="ru-RU-DmitryNeural")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--volume", default="+0%")
    parser.add_argument("--out-audio", required=True)
    parser.add_argument("--out-words", required=True)
    args = parser.parse_args()

    result = asyncio.run(synthesize(args))
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
