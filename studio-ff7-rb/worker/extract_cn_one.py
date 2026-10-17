#!/usr/bin/env python3
"""Extract one CN-pack line to 320k MP3 under website/data/cn/."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cn_iostore import extract_named  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CN_MODS = ROOT / "game" / "sound-part" / "End" / "Content" / "Paks" / "~mods"
DATA = ROOT / "studio-ff7-rb" / "website" / "data"
AUDIOMOG = ROOT / "programs" / "bin" / "audiomog" / "AudioMog.dll"


def _env() -> dict:
    env = os.environ.copy()
    env["DOTNET_ROOT"] = str(Path.home() / ".dotnet")
    env["PATH"] = str(Path.home() / ".dotnet") + os.pathsep + env.get("PATH", "")
    return env


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--pack", required=True, help="zzz_cn_voice_a_P")
    p.add_argument("--stem", required=True)
    args = p.parse_args()
    out_dir = DATA / "cn"
    out_dir.mkdir(parents=True, exist_ok=True)
    mp3 = out_dir / f"{args.stem}.mp3"
    if mp3.exists() and mp3.stat().st_size > 0:
        print(f"cached {mp3}")
        return 0
    utoc = CN_MODS / f"{args.pack}.utoc"
    data = extract_named(utoc, args.stem + ".uasset")
    raw = out_dir / f"{args.stem}.uasset"
    raw.write_bytes(data)
    subprocess.run(
        [str(Path.home() / ".dotnet" / "dotnet"), str(AUDIOMOG), str(raw)],
        check=True,
        env=_env(),
        cwd=str(AUDIOMOG.parent),
        capture_output=True,
    )
    proj = raw.with_name(raw.stem + "_Project")
    wavs = list(proj.glob("*.wav"))
    if not wavs:
        raise SystemExit("no wav")
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(wavs[0]), "-c:a", "libmp3lame", "-b:a", "320k", "-ac", "1", str(mp3)],
        check=True,
        capture_output=True,
    )
    shutil.rmtree(proj, ignore_errors=True)
    print(f"cn {args.stem} -> {mp3} ({mp3.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
