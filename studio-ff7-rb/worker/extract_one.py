#!/usr/bin/env python3
"""Extract one JP voice line and encode 320k MP3.

Looks up work/jp-voice-index.jsonl when --path/--name is a stem.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROGRAMS = ROOT / "programs"
BIN = PROGRAMS / "bin"
GAME_PAKS = ROOT / "game" / "FINAL FANTASY VII REBIRTH" / "End" / "Content" / "Paks"
DATA = ROOT / "studio-ff7-rb" / "website" / "data"
INDEX = ROOT / "work" / "jp-voice-index.jsonl"
RETOC = BIN / "retoc"
AUDIOMOG = BIN / "audiomog" / "AudioMog.dll"


def _dotnet() -> str:
    home = Path.home() / ".dotnet" / "dotnet"
    return str(home if home.exists() else "dotnet")


def _env() -> dict[str, str]:
    env = os.environ.copy()
    env["DOTNET_ROOT"] = str(Path.home() / ".dotnet")
    env["PATH"] = str(Path.home() / ".dotnet") + os.pathsep + env.get("PATH", "")
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    return env


def lookup_index(stem: str) -> dict | None:
    if not INDEX.exists():
        return None
    with INDEX.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("stem") == stem:
                return row
    return None


def wav_to_mp3(wav: Path, mp3: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(wav),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "320k",
            "-ac",
            "1",
            str(mp3),
        ],
        check=True,
        capture_output=True,
    )


def _retoc_input(container: str | None) -> Path:
    """Prefer the single utoc that owns the chunk; scanning all Paks is ~10x slower."""
    if container:
        name = container if container.endswith(".utoc") else f"{container}.utoc"
        utoc = GAME_PAKS / name
        if utoc.exists():
            return utoc
    return GAME_PAKS


def extract(
    chunk_id: str,
    name: str,
    dest_kind: str = "jp",
    container: str | None = None,
) -> Path:
    out_dir = DATA / dest_kind
    out_dir.mkdir(parents=True, exist_ok=True)
    mp3 = out_dir / f"{name}.mp3"
    if mp3.exists() and mp3.stat().st_size > 0:
        print(f"cached {mp3}")
        return mp3
    raw = out_dir / f"{name}.uasset"
    subprocess.run(
        [str(RETOC), "get", str(_retoc_input(container)), chunk_id, str(raw)],
        check=True,
        env=_env(),
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [_dotnet(), str(AUDIOMOG), str(raw)],
        check=True,
        env=_env(),
        cwd=str(BIN / "audiomog"),
        capture_output=True,
        text=True,
    )
    sibling = raw.with_name(f"{raw.stem}_Project")
    wavs = list(sibling.glob("*.wav"))
    if not wavs:
        raise SystemExit(f"AudioMog produced no wav next to {raw}")
    wav_to_mp3(wavs[0], mp3)
    shutil.rmtree(sibling, ignore_errors=True)
    wav_copy = out_dir / f"{name}.wav"
    if wav_copy.exists():
        wav_copy.unlink()
    if raw.exists():
        raw.unlink()
    print(f"chunk {chunk_id} -> {mp3} ({mp3.stat().st_size} bytes)")
    return mp3


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--path", help="asset path or stem")
    p.add_argument("--chunk-id")
    p.add_argument("--name")
    p.add_argument("--kind", default="jp", choices=["jp", "cn", "ours"])
    args = p.parse_args()
    if args.chunk_id:
        extract(args.chunk_id, args.name or args.chunk_id, args.kind)
        return 0
    needle = args.path or args.name
    if not needle:
        p.error("need --path, --name or --chunk-id")
    stem = Path(needle).stem
    hit = lookup_index(stem)
    if hit:
        extract(
            hit["chunk_id"],
            args.name or stem,
            args.kind,
            container=hit.get("container"),
        )
        return 0
    print(f"stem {stem} not in index {INDEX}; pass --chunk-id", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
