#!/usr/bin/env bash

pip install -U uv  --index-url "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"

set -euo pipefail

# Check uv is available
if ! command -v uv >/dev/null 2>&1; then
  echo "[ERROR] 'uv' is not installed. Install it first, e.g.:" >&2
  echo "       curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

# Optional: install system-level dependencies (ffmpeg for mp3 conversion, libsndfile for SoundFile)
# Enable by running: INSTALL_SYSTEM_DEPS=1 ./install_api.sh
apt-get update -y
apt-get install -y ffmpeg libsndfile1

# 1) Install upstream project dependencies (and extras) using Tsinghua mirror
pushd tts_base >/dev/null
uv sync --all-extras --default-index "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"

# 2) Install API-only dependencies into the same uv environment (still inside tts_base)
uv pip install -r ../requirements-api.txt --index-url "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"
popd >/dev/null

echo "[OK] API dependencies installed successfully."
