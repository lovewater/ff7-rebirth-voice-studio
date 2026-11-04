#!/usr/bin/env bash
# Compatibility entry point: this directory only backs up Rebirth.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
exec python3 "$ROOT/studio-common/scripts/backup-studio.py" backup --game rebirth "$@"
