#!/usr/bin/env python3
"""Load CN catalog JSONL into Postgres."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "work" / "cn-catalog.jsonl"
INDEX = ROOT / "work" / "jp-voice-index.jsonl"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from regions import parse_stem  # noqa: E402

DSN = os.environ.get("DATABASE_URL", "")


def load_jp_index() -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not INDEX.exists():
        return out
    with INDEX.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            out[row["stem"]] = row
    return out


def main() -> int:
    if not CATALOG.exists():
        print(f"missing {CATALOG}", file=sys.stderr)
        return 1
    jp = load_jp_index()
    rows = []
    with CATALOG.open(encoding="utf-8") as fh:
        for line in fh:
            o = json.loads(line)
            meta = parse_stem(o["stem"])
            hit = jp.get(o["stem"], {})
            rows.append(
                (
                    o["pack"],
                    o["filename"],
                    o["stem"],
                    hit.get("path"),
                    meta["region"],
                    meta["speaker"],
                    meta["kind"],
                    hit.get("chunk_id"),
                    hit.get("container"),
                )
            )
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE lines RESTART IDENTITY")
            cur.executemany(
                """
                INSERT INTO lines (
                    pack, filename, stem, asset_path, region,
                    speaker, kind, jp_chunk_id, jp_container
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                rows,
            )
        conn.commit()
    print(f"imported {len(rows)} lines (jp index hits {sum(1 for r in rows if r[7])})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
