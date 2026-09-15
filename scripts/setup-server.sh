#!/usr/bin/env bash
# Idempotent Ubuntu 22.04/24.04 provisioning for the content factory.
# Re-run freely: every step checks before it installs.
#
#   sudo bash scripts/setup-server.sh            # system + python + rhubarb + fonts + node deps
#   sudo bash scripts/setup-server.sh --no-node  # skip npm install (CI / already done)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RHUBARB_VERSION="1.13.0"
RHUBARB_DIR="/opt/rhubarb"
FONTS_DIR="$ROOT/assets/fonts"
NO_NODE=0
for arg in "$@"; do [[ "$arg" == "--no-node" ]] && NO_NODE=1; done

log() { printf '\n\033[35m>> %s\033[0m\n' "$*"; }
need_root() { if [[ $EUID -ne 0 ]]; then echo "run with sudo"; exit 1; fi; }

need_root

# ---------------------------------------------------------------------------
log "APT: ffmpeg, python, unzip, Chromium runtime libs for Remotion"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ffmpeg curl unzip git ca-certificates python3 python3-pip python3-venv pipx \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 \
  fonts-liberation xdg-utils >/dev/null 2>&1 || \
apt-get install -y -qq \
  ffmpeg curl unzip git ca-certificates python3 python3-pip python3-venv pipx \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
  fonts-liberation xdg-utils

# ---------------------------------------------------------------------------
log "Node.js 22 (NodeSource) if missing"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
node -v

# ---------------------------------------------------------------------------
log "Python packages: edge-tts, faster-whisper, yt-dlp, fonttools"
PIP_FLAGS="--break-system-packages"
python3 -m pip install -q --upgrade $PIP_FLAGS edge-tts faster-whisper fonttools 2>/dev/null || \
python3 -m pip install -q --upgrade edge-tts faster-whisper fonttools
if ! command -v yt-dlp >/dev/null 2>&1; then
  pipx install yt-dlp >/dev/null || python3 -m pip install -q $PIP_FLAGS yt-dlp
  pipx ensurepath >/dev/null 2>&1 || true
fi
ln -sf "$(command -v yt-dlp || echo /root/.local/bin/yt-dlp)" /usr/local/bin/yt-dlp 2>/dev/null || true
yt-dlp --version

# ---------------------------------------------------------------------------
log "Rhubarb Lip Sync $RHUBARB_VERSION (phonetic recognizer needs the res/ dir next to the binary)"
if [[ ! -x "$RHUBARB_DIR/rhubarb" ]]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/rhubarb.zip" \
    "https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v${RHUBARB_VERSION}/Rhubarb-Lip-Sync-${RHUBARB_VERSION}-Linux.zip"
  unzip -q "$tmp/rhubarb.zip" -d "$tmp"
  rm -rf "$RHUBARB_DIR"
  mv "$tmp"/Rhubarb-Lip-Sync-*-Linux "$RHUBARB_DIR"
  chmod +x "$RHUBARB_DIR/rhubarb"
  rm -rf "$tmp"
fi
ln -sf "$RHUBARB_DIR/rhubarb" /usr/local/bin/rhubarb
rhubarb --version

# ---------------------------------------------------------------------------
log "Fonts with Cyrillic coverage: Inter + Unbounded (static TTF instances for Satori)"
mkdir -p "$FONTS_DIR"
# Satori (opentype.js) cannot select variable-font instances, so we need static
# weights. The Google Fonts CSS API serves full static TTFs (all scripts, incl.
# Cyrillic) when asked with a legacy user agent — no fonttools instancing needed.
google_font() { # family-query dest [nth-url]
  local query="$1" dest="$2" nth="${3:-1}"
  [[ -f "$dest" ]] && return 0
  local url
  url="$(curl -fsSL -A 'Mozilla/4.0' "https://fonts.googleapis.com/css2?family=${query}&display=swap" \
        | grep -oE 'https://fonts\.gstatic\.com/[^)]+\.ttf' | sed -n "${nth}p")"
  [[ -n "$url" ]] || { echo "could not resolve font url for $query"; return 1; }
  curl -fsSL -A 'Mozilla/4.0' -o "$dest" "$url"
}
google_font "Unbounded:wght@500"  "$FONTS_DIR/Unbounded-Medium.ttf"
google_font "Inter:wght@400;700"  "$FONTS_DIR/Inter-Regular.ttf" 1
google_font "Inter:wght@400;700"  "$FONTS_DIR/Inter-Bold.ttf"    2
python3 - "$FONTS_DIR" <<'PY'
import sys, pathlib
from fontTools.ttLib import TTFont
probe = "Съешь ещё этих мягких французских булок"
for f in sorted(pathlib.Path(sys.argv[1]).glob("*.ttf")):
    t = TTFont(f); cmap = t.getBestCmap()
    ok = all(ord(c) in cmap for c in probe if c != " ")
    print(f"  {f.name}: weight={t['OS/2'].usWeightClass} cyrillic={'yes' if ok else 'NO'} variable={'fvar' in t}")
    if not ok or 'fvar' in t: sys.exit(f"{f.name} is unusable for Satori (needs static + Cyrillic)")
PY

# ---------------------------------------------------------------------------
if [[ $NO_NODE -eq 0 ]]; then
  log "npm install (Remotion downloads its headless Chromium on first render)"
  cd "$ROOT"
  # npm must not run as root's global; keep ownership sane when invoked via sudo.
  if [[ -n "${SUDO_USER:-}" ]]; then
    sudo -u "$SUDO_USER" npm install --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
fi

# ---------------------------------------------------------------------------
log "Storage tree"
mkdir -p "$ROOT"/storage/{raw,staged,artifacts/carousel,cache}
[[ -n "${SUDO_USER:-}" ]] && chown -R "$SUDO_USER":"$SUDO_USER" "$ROOT/storage" "$FONTS_DIR" || true

cat <<EOF

Done. Next:
  1. cp .env.example .env && edit POSTIZ_API_KEY
  2. npm run sprites:placeholder      # temporary avatar art
  3. put vertical loops in assets/b-roll and tracks in assets/music (scripts/normalize-music.sh)
  4. npm run doctor -- --postiz
EOF
