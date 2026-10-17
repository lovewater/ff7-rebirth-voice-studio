#!/usr/bin/env python3
"""List .uasset names inside the existing CN voice pack utocs (no Oodle needed).

The directory index stores filenames in plaintext. ContainerHeader is Oodle and
retoc cannot currently decompress those CN patches on Linux.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CN_MODS = ROOT / "work" / "ref-cn-voice" / "End" / "Content" / "Paks" / "~mods"
OUT_DEFAULT = ROOT / "work" / "cn-catalog.jsonl"

NAME_RE = re.compile(rb"[\w.\-]+\.uasset")


def iter_names(utoc: Path) -> list[str]:
    data = utoc.read_bytes()
    found = []
    seen = set()
    for m in NAME_RE.finditer(data):
        name = m.group().decode("ascii")
        if name not in seen:
            seen.add(name)
            found.append(name)
    return found


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("-o", "--output", default=str(OUT_DEFAULT))
    args = p.parse_args()
    if not CN_MODS.is_dir():
        print(f"missing CN mods: {CN_MODS}", file=sys.stderr)
        print("unzip game/sound-part/FF7Rebirth_CN_Voice_v1.3_for1.005_20260830.zip to work/ref-cn-voice/", file=sys.stderr)
        return 1
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    packs = Counter()
    n = 0
    with out.open("w", encoding="utf-8") as fh:
        for utoc in sorted(CN_MODS.glob("zzz_cn_voice_*_P.utoc")):
            pack = utoc.name.replace(".utoc", "")
            names = iter_names(utoc)
            packs[pack] = len(names)
            for name in names:
                stem = name[: -len(".uasset")]
                region = ""
                m = re.search(r"(C\d{4})_", stem)
                fh.write(
                    json.dumps(
                        {
                            "pack": pack,
                            "filename": name,
                            "stem": stem,
                            "chapter_hint": m.group(1) if m else "",
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                n += 1
    print(f"wrote {n} entries -> {out}")
    for pack, c in packs.most_common():
        print(f"  {c:6}  {pack}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
