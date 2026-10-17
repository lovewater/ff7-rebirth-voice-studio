#!/usr/bin/env python3
"""Set lines.kind to 对话 / 旁白 / 待处理 / NPC / 战斗."""

from __future__ import annotations

import json
import os
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "work" / "jp-voice-index.jsonl"
DSN = os.environ.get("DATABASE_URL", "")


def classify(stem: str, path: str) -> str:
    parts = stem.split("_")
    tok = parts[1] if len(parts) > 1 else ""
    p = path or ""
    if tok == "NPC" or "/NPC_" in p:
        return "NPC"
    if tok == "BOS" or "/Boss" in p or "/Character/" in p:
        return "战斗"
    if tok in ("CDV", "MGV", "PCV") or "WorldReport" in p:
        return "旁白"
    # Red XIII chapter wrap (VO over footage, not lip-sync).
    if (
        len(parts) >= 4
        and parts[1] == "MAIN"
        and parts[-1] == "red"
        and parts[2] in ("0050", "9000")
    ):
        return "旁白"
    return "对话"


def main() -> int:
    idx: dict[str, str] = {}
    with INDEX.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            idx[row["stem"]] = row.get("path") or ""
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT stem FROM lines")
            stems = [r[0] for r in cur.fetchall()]
            rows = [(classify(s, idx.get(s, "")), s) for s in stems]
            cur.executemany("UPDATE lines SET kind = %s, updated_at = now() WHERE stem = %s", rows)
            cur.execute("SELECT kind, COUNT(*) FROM lines GROUP BY 1 ORDER BY 2 DESC")
            print(cur.fetchall())
        conn.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
