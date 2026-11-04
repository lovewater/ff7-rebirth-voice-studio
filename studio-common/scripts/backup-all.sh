#!/usr/bin/env bash
# One online backup per game, sequentially, so NAS traffic stays at five workers.
set -uo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
status=0
for game in rebirth remake; do
  python3 "$SCRIPT_DIR/backup-studio.py" backup --game "$game" "$@" || status=1
done
exit "$status"
