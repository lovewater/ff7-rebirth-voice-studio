#!/usr/bin/env python3
"""Extract uassets from the existing CN voice IoStore packs."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cn_iostore import extract_container  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CN_MODS = ROOT / "game" / "sound-part" / "End" / "Content" / "Paks" / "~mods"
OUT = ROOT / "work" / "cn-extract"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--pack", default="zzz_cn_voice_vo_P", help="utoc stem without .utoc")
    p.add_argument("-o", "--outdir", default=str(OUT))
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()
    utoc = CN_MODS / f"{args.pack}.utoc"
    if not utoc.exists():
        print(f"missing {utoc}", file=sys.stderr)
        return 1
    chunks, names = extract_container(utoc)
    out = Path(args.outdir) / args.pack
    out.mkdir(parents=True, exist_ok=True)
    n = 0
    assets = [c for c in chunks if c.chunk_type == 2]
    print(f"{utoc.name}: {len(chunks)} chunks, {len(assets)} assets, {len(names)} dir names")
    for i, ch in enumerate(assets):
        if args.limit and i >= args.limit:
            break
        name = names[i] if i < len(names) else f"{ch.chunk_id.hex()[:16]}.uasset"
        dest = out / name
        dest.write_bytes(ch.data)
        n += 1
        print(f"  {len(ch.data):8}  {name}  HCA={ch.data.find(b'HCA')>=0} sabf={b'sabf' in ch.data[:4096]}")
    print(f"wrote {n} files -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
