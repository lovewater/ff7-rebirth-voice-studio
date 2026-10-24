#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
site_dir="$(cd "$source_dir/../.." && pwd)"
asset_dir="$site_dir/public/vendor/rubberband"
mkdir -p "$asset_dir"
cp "$source_dir/"{COPYING,NOTICE.txt,bridge.cpp,short-offline.patch} "$asset_dir/"
cd "$asset_dir"
if [ ! -f rubberband-4.0.0.tar.bz2 ]; then
  curl --fail --location --output rubberband-4.0.0.tar.bz2 https://breakfastquay.com/files/releases/rubberband-4.0.0.tar.bz2
fi
echo 'af050313ee63bc18b35b2e064e5dce05b276aaf6d1aa2b8a82ced1fe2f8028e9  rubberband-4.0.0.tar.bz2' | sha256sum -c -
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
tar xf rubberband-4.0.0.tar.bz2 -C "$build_dir"
patch -d "$build_dir/rubberband-4.0.0" -p1 < short-offline.patch
# Run with Emscripten 3.1.6 (Ubuntu noble package 3.1.6~dfsg-7). Builtin FFT/resampler, no threading,
# no SIMD requirement, no fast-math; identical binary for browser and Node.
em++ -O3 -flto -fno-rtti -I"$build_dir/rubberband-4.0.0" \
  "$build_dir/rubberband-4.0.0/single/RubberBandSingle.cpp" bridge.cpp \
  -s STANDALONE_WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
  -s ENVIRONMENT=web,worker,node --no-entry -o rubberband-4.0.0.wasm
sha256sum rubberband-4.0.0.wasm

bash "$site_dir/scripts/package-rubberband-source.sh"
