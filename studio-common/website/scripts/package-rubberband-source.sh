#!/usr/bin/env bash
# Refresh the source download whenever adapters change; regression tests check it.
set -euo pipefail
cd "$(dirname "$0")/.."
tar --sort=name --mtime='UTC 2026-10-20' --owner=0 --group=0 --numeric-owner \
  -czf public/vendor/rubberband/adapters.tar.gz \
  src/lib/rubberband-core.ts src/lib/rubberband-browser.ts \
  src/lib/rubberband-server.ts src/lib/rubberband.worker.ts
