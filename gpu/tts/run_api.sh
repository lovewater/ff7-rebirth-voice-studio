#!/usr/bin/env bash
set -euo pipefail

# Always run this script from the repository root: index-tts-2
cd "$(dirname "$0")"

# Run the FastAPI service via uv's environment
pushd tts_base >/dev/null
#pushd index-tts >/dev/null
exec uv run python ../main/main.py
