#!/usr/bin/env bash
# Normalize every track in a source folder to -24 LUFS mono-compatible stereo MP3 and
# drop the result into assets/music. Two-pass loudnorm for accurate targets.
#
#   bash scripts/normalize-music.sh ~/Downloads/royalty-free-tracks
set -euo pipefail
SRC="${1:?usage: normalize-music.sh <source-dir>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/assets/music"
mkdir -p "$OUT"

shopt -s nullglob nocaseglob
for f in "$SRC"/*.{mp3,wav,m4a,flac,ogg}; do
  name="$(basename "${f%.*}" | tr -c 'A-Za-z0-9_.-\n' '_')"
  target="$OUT/$name.mp3"
  [[ -f "$target" ]] && { echo "skip $name (exists)"; continue; }
  echo "normalizing $name"
  stats="$(ffmpeg -hide_banner -nostats -i "$f" -af loudnorm=I=-24:TP=-2:LRA=9:print_format=json -f null - 2>&1 | sed -n '/{/,/}/p')"
  I=$(echo "$stats" | grep '"input_i"' | sed 's/[^0-9.-]//g')
  TP=$(echo "$stats" | grep '"input_tp"' | sed 's/[^0-9.-]//g')
  LRA=$(echo "$stats" | grep '"input_lra"' | sed 's/[^0-9.-]//g')
  TH=$(echo "$stats" | grep '"input_thresh"' | sed 's/[^0-9.-]//g')
  ffmpeg -hide_banner -loglevel error -y -i "$f" \
    -af "loudnorm=I=-24:TP=-2:LRA=9:measured_I=$I:measured_TP=$TP:measured_LRA=$LRA:measured_thresh=$TH:linear=true" \
    -ar 44100 -b:a 192k "$target"
done
echo "tracks in $OUT:"; ls -1 "$OUT"
