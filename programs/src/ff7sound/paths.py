from __future__ import annotations

from pathlib import Path

PROGRAMS_ROOT = Path(__file__).resolve().parents[2]
BIN_DIR = PROGRAMS_ROOT / "bin"
VENDOR_DIR = PROGRAMS_ROOT / "vendor"
SRC_DIR = PROGRAMS_ROOT / "src"

AUDIOMOG_DIR = BIN_DIR / "audiomog"
AUDIOMOG_DLL = AUDIOMOG_DIR / "AudioMog.dll"
VGAUDIO_DIR = BIN_DIR / "vgaudio"
VGAUDIO_DLL = VGAUDIO_DIR / "VGAudioCli.dll"
TEXT_TOOL = BIN_DIR / "ff7r-text-tool"
RETOC = BIN_DIR / "retoc"
REPAK = BIN_DIR / "repak"
VGMSTREAM = BIN_DIR / "vgmstream-cli"
UNREALREZEN_DLL = BIN_DIR / "unrealrezen" / "UnrealReZen.dll"


def which_dotnet() -> Path:
    from shutil import which

    found = which("dotnet")
    if found:
        return Path(found)
    home = Path.home() / ".dotnet" / "dotnet"
    if home.exists():
        return home
    raise FileNotFoundError("dotnet SDK not found. Install .NET 8 or add ~/.dotnet to PATH.")
