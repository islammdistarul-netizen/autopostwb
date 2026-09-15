#!/usr/bin/env bash
# One full factory cycle: intel -> produce -> publish. Called by the systemd
# timer (deploy/autopostwb.timer) or cron. Safe to run while another cycle is
# active — the orchestrator's lock file makes the second one exit immediately.
#
#   bash deploy/run-cycle.sh            # real publish
#   bash deploy/run-cycle.sh --dry-run  # everything except the Postiz calls
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a; # shellcheck disable=SC1091
  source .env; set +a
fi

export CF_QUIET="${CF_QUIET:-0}"
mkdir -p storage/cache
LOG="storage/cache/cycle-$(date -u +%Y%m%d).log"

{
  echo "=== cycle start $(date -u +%FT%TZ) args: $* ==="
  npm run --silent run:full -- "$@"
  echo "=== cycle end $(date -u +%FT%TZ) ==="
} 2>&1 | tee -a "$LOG"
