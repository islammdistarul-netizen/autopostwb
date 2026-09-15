#!/usr/bin/env bash
# Pull vertical stock loops from Pexels (free API) into assets/b-roll, re-encoded
# to 1080x1920 30fps H.264 without audio so Remotion/OffthreadVideo decodes them fast.
#
#   PEXELS_API_KEY=... bash scripts/fetch-broll.sh "gym workout" 6
set -euo pipefail
QUERY="${1:?usage: fetch-broll.sh <query> [count]}"
COUNT="${2:-5}"
: "${PEXELS_API_KEY:?PEXELS_API_KEY is required (https://www.pexels.com/api/)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/assets/b-roll"
mkdir -p "$OUT"

json="$(curl -fsSL -H "Authorization: $PEXELS_API_KEY" \
  "https://api.pexels.com/videos/search?query=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$QUERY")&orientation=portrait&size=medium&per_page=$COUNT")"

python3 - "$json" <<'PY' | while read -r id url; do
import json, sys
data = json.loads(sys.argv[1])
for v in data.get("videos", []):
    files = [f for f in v.get("video_files", []) if f.get("height", 0) >= f.get("width", 0)]
    files.sort(key=lambda f: abs((f.get("height") or 0) - 1920))
    if files:
        print(v["id"], files[0]["link"])
PY
  target="$OUT/pexels_${id}.mp4"
  [[ -f "$target" ]] && { echo "skip $id"; continue; }
  echo "fetching $id"
  tmp="$(mktemp --suffix=.mp4)"
  curl -fsSL -o "$tmp" "$url"
  ffmpeg -hide_banner -loglevel error -y -i "$tmp" -an \
    -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" \
    -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -movflags +faststart "$target"
  rm -f "$tmp"
done
echo "loops in $OUT:"; ls -1 "$OUT"
