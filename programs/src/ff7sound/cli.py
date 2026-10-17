#!/usr/bin/env python3
"""Unpack / pack FF7 Remake and Rebirth audio and text assets."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import __version__
from . import paths


AUDIO_EXTS = {".uexp", ".bytes", ".sab", ".sabf", ".mab", ".mabf", ".uasset"}


def _run(cmd: list[str], cwd: Path | None = None, env: dict | None = None) -> None:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, env=merged, check=True)


def _require(path: Path, hint: str) -> Path:
    if not path.exists():
        raise SystemExit(f"missing tool: {path}\n{hint}")
    return path


def cmd_status(_args: argparse.Namespace) -> int:
    checks = {
        "dotnet": None,
        "AudioMog": paths.AUDIOMOG_DLL,
        "VGAudioCli": paths.VGAUDIO_DLL,
        "ff7r-text-tool": paths.TEXT_TOOL,
        "retoc": paths.RETOC,
        "repak": paths.REPAK,
        "vgmstream-cli": paths.VGMSTREAM,
        "UnrealReZen": paths.UNREALREZEN_DLL,
    }
    try:
        checks["dotnet"] = paths.which_dotnet()
    except FileNotFoundError:
        checks["dotnet"] = Path("(missing)")

    width = max(len(k) for k in checks)
    ok = True
    for name, path in checks.items():
        exists = path is not None and Path(path).exists()
        mark = "ok" if exists else "MISSING"
        if not exists and name != "UnrealReZen":
            ok = False
        print(f"{name:<{width}}  {mark:<7}  {path}")
    print(f"\nprograms root: {paths.PROGRAMS_ROOT}")
    return 0 if ok else 1


def cmd_unpack_audio(args: argparse.Namespace) -> int:
    dll = _require(paths.AUDIOMOG_DLL, "build AudioMog first (see programs/README.md)")
    target = Path(args.file).resolve()
    if not target.exists():
        raise SystemExit(f"file not found: {target}")
    if target.suffix.lower() not in AUDIO_EXTS:
        print(f"warning: {target.suffix} is not a known audio container, still trying", file=sys.stderr)
    _run(
        [str(paths.which_dotnet()), str(dll), str(target)],
        cwd=paths.AUDIOMOG_DIR,
    )
    project = target.with_name(f"{target.stem}_Project")
    if project.is_dir():
        print(f"unpacked -> {project}")
    return 0


def cmd_pack_audio(args: argparse.Namespace) -> int:
    dll = _require(paths.AUDIOMOG_DLL, "build AudioMog first (see programs/README.md)")
    target = Path(args.project).resolve()
    if target.is_dir():
        target = target / "RebuildSettings.json"
    if not target.exists():
        raise SystemExit(f"RebuildSettings.json not found: {target}")
    _run(
        [str(paths.which_dotnet()), str(dll), str(target)],
        cwd=paths.AUDIOMOG_DIR,
    )
    print(f"packed from {target}")
    return 0


def cmd_hca(args: argparse.Namespace) -> int:
    dll = _require(paths.VGAUDIO_DLL, "build VGAudioCli first")
    src = Path(args.input).resolve()
    dst = Path(args.output).resolve() if args.output else None
    if dst is None:
        if src.suffix.lower() == ".wav":
            dst = src.with_suffix(".hca")
        elif src.suffix.lower() == ".hca":
            dst = src.with_suffix(".wav")
        else:
            raise SystemExit("specify --output, or pass a .wav/.hca file")
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [str(paths.which_dotnet()), str(dll), str(src), str(dst)]
    if args.quality:
        cmd.extend(["--hcaquality", args.quality])
    _run(cmd, cwd=paths.VGAUDIO_DIR)
    print(f"{src.name} -> {dst}")
    return 0


def cmd_unpack_text(args: argparse.Namespace) -> int:
    tool = _require(paths.TEXT_TOOL, "build ff7r-text-tool first")
    src = Path(args.file).resolve()
    out = Path(args.outdir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    cmd = [str(tool), "--mode", "export", "--format", args.format, "--outdir", str(out), str(src)]
    if args.ignore_empty:
        cmd.append("--ignore_empty")
    _run(cmd)
    print(f"text exported -> {out}")
    return 0


def cmd_pack_text(args: argparse.Namespace) -> int:
    tool = _require(paths.TEXT_TOOL, "build ff7r-text-tool first")
    table = Path(args.table).resolve()
    asset = Path(args.asset).resolve()
    out = Path(args.outdir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    _run(
        [
            str(tool),
            "--mode",
            "import",
            "--format",
            args.format,
            "--outdir",
            str(out),
            str(table),
            str(asset),
        ]
    )
    print(f"text imported -> {out}")
    return 0


def cmd_unpack_paks(args: argparse.Namespace) -> int:
    retoc = _require(paths.RETOC, "download retoc into programs/bin/")
    paks = Path(args.paks).resolve()
    out = Path(args.outdir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    cmd = [str(retoc)]
    if args.aes:
        cmd.extend(["--aes-key", args.aes])
    cmd.append("to-legacy")
    if args.filter:
        cmd.extend(["--filter", args.filter])
    if args.version:
        cmd.extend(["--version", args.version])
    cmd.extend([str(paks), str(out)])
    _run(cmd)
    print(f"paks unpacked -> {out}")
    return 0


def cmd_pack_mod(args: argparse.Namespace) -> int:
    """Pack a folder of cooked assets back to IoStore (_P.utoc/_P.ucas/_P.pak)."""
    retoc = _require(paths.RETOC, "download retoc into programs/bin/")
    content = Path(args.content).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [str(retoc), "to-zen", str(content), str(out)]
    if args.version:
        cmd.extend(["--version", args.version])
    _run(cmd)
    print(f"mod packed -> {out}")
    return 0


def cmd_play(args: argparse.Namespace) -> int:
    vgm = _require(paths.VGMSTREAM, "build vgmstream-cli first")
    src = Path(args.file).resolve()
    wav = Path(args.output).resolve() if args.output else src.with_suffix(".wav")
    _run([str(vgm), "-o", str(wav), str(src)])
    print(f"decoded -> {wav}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ff7sound",
        description="FF7 Remake/Rebirth unpack and pack tools.",
    )
    p.add_argument("--version", action="version", version=f"ff7sound {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("status", help="show which binaries are built")
    s.set_defaults(func=cmd_status)

    s = sub.add_parser("unpack-audio", help="uasset/uexp/sab/mab -> wav project (AudioMog)")
    s.add_argument("file", help="audio container (.uasset/.uexp/.sab/.mab/...)")
    s.set_defaults(func=cmd_unpack_audio)

    s = sub.add_parser("pack-audio", help="AudioMog project json -> rebuilt container")
    s.add_argument("project", help="RebuildSettings.json or the *_Project folder")
    s.set_defaults(func=cmd_pack_audio)

    s = sub.add_parser("hca", help="wav <-> hca via VGAudio")
    s.add_argument("input")
    s.add_argument("-o", "--output")
    s.add_argument("--quality", default="High", help="HCA quality: Lowest/Low/Middle/High/Highest")
    s.set_defaults(func=cmd_hca)

    s = sub.add_parser("unpack-text", help="*_TxtRes.uasset -> csv/json")
    s.add_argument("file")
    s.add_argument("-o", "--outdir", default="out/text")
    s.add_argument("-f", "--format", choices=["csv", "json"], default="csv")
    s.add_argument("--ignore-empty", action="store_true")
    s.set_defaults(func=cmd_unpack_text)

    s = sub.add_parser("pack-text", help="csv/json + original uasset -> imported uasset")
    s.add_argument("table", help="exported csv/json")
    s.add_argument("asset", help="original *_TxtRes.uasset")
    s.add_argument("-o", "--outdir", default="out/text-imported")
    s.add_argument("-f", "--format", choices=["csv", "json"], default="csv")
    s.set_defaults(func=cmd_pack_text)

    s = sub.add_parser("unpack-paks", help="game Paks folder -> cooked uasset (retoc to-legacy)")
    s.add_argument("paks", help=".../End/Content/Paks")
    s.add_argument("-o", "--outdir", default="out/legacy")
    s.add_argument("--aes", help="AES key hex, if encrypted")
    s.add_argument("--filter", help="path filter, e.g. Sound or Voice")
    s.add_argument("--version", default="UE4_26", help="engine version for Rebirth, e.g. UE4_26")
    s.set_defaults(func=cmd_unpack_paks)

    s = sub.add_parser("pack-mod", help="cooked assets folder -> IoStore _P.utoc (retoc to-zen)")
    s.add_argument("content", help="folder with End/Content/... tree")
    s.add_argument("-o", "--output", required=True, help="output .utoc path, name should end with _P.utoc")
    s.add_argument("--version", default="UE4_26")
    s.set_defaults(func=cmd_pack_mod)

    s = sub.add_parser("play", help="decode any supported audio (hca/sab/wem) to wav")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.set_defaults(func=cmd_play)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except subprocess.CalledProcessError as exc:
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
