"""uasset -> 320k mono MP3, then delete wav/project/uasset."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUDIOMOG = ROOT / "programs" / "bin" / "audiomog" / "AudioMog.dll"


def _env() -> dict[str, str]:
    env = os.environ.copy()
    env["DOTNET_ROOT"] = str(Path.home() / ".dotnet")
    env["PATH"] = str(Path.home() / ".dotnet") + os.pathsep + env.get("PATH", "")
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    return env


def uasset_to_mp3(uasset: Path, mp3: Path) -> bool:
    if mp3.exists() and mp3.stat().st_size > 0:
        return True
    mp3.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        [str(Path.home() / ".dotnet" / "dotnet"), str(AUDIOMOG), str(uasset)],
        env=_env(),
        cwd=str(AUDIOMOG.parent),
        capture_output=True,
        text=True,
    )
    proj = uasset.with_name(uasset.stem + "_Project")
    wavs = sorted(proj.glob("*.wav")) if proj.exists() else []
    if r.returncode != 0 or not wavs:
        shutil.rmtree(proj, ignore_errors=True)
        return False
    wavs.sort()
    ff = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(wavs[0]),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "320k",
            "-ac",
            "1",
            str(mp3),
        ],
        capture_output=True,
    )
    shutil.rmtree(proj, ignore_errors=True)
    if uasset.exists():
        try:
            uasset.unlink()
        except OSError:
            pass
    return ff.returncode == 0 and mp3.exists()
