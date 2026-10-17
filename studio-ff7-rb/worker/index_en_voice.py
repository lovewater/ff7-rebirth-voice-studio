#!/usr/bin/env python3
"""Index US (English) voice uassets: stem -> chunk_id."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GAME_PAKS = ROOT / "game" / "FINAL FANTASY VII REBIRTH" / "End" / "Content" / "Paks"
RETOC = ROOT / "programs" / "bin" / "retoc"
OUT = ROOT / "work" / "en-voice-index.jsonl"


def main() -> int:
    env = os.environ.copy()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with OUT.open("w", encoding="utf-8") as fh:
        utocs = sorted(GAME_PAKS.glob("*.utoc"))
        for i, utoc in enumerate(utocs, 1):
            proc = subprocess.run(
                [str(RETOC), "list", "--path", "--size", str(utoc)],
                capture_output=True,
                text=True,
                env=env,
            )
            hits = 0
            for line in proc.stdout.splitlines():
                if "Sound/Voice/US/" not in line or not line.endswith(".uasset"):
                    continue
                parts = line.split()
                if len(parts) < 5:
                    continue
                try:
                    size = int(parts[3])
                except ValueError:
                    continue
                path = parts[4]
                stem = Path(path).stem
                fh.write(
                    json.dumps(
                        {
                            "stem": stem,
                            "chunk_id": parts[1],
                            "container": parts[0],
                            "path": path,
                            "size": size,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                n += 1
                hits += 1
            print(f"[{i}/{len(utocs)}] {utoc.name} en-voice={hits}", flush=True)
    print(f"wrote {n} -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
