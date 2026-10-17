#!/usr/bin/env python3
"""Re-apply Red XIII / Nanaki split. Stem suffix stays _red after catalog import."""

from __future__ import annotations

import os
from pathlib import Path

import psycopg

SQL = Path(__file__).resolve().parents[1] / "db/init/008_red_persona.sql"
DSN = os.environ.get("DATABASE_URL", "")


def main() -> int:
    sql = SQL.read_text()
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            cur.execute(
                """
                SELECT l.speaker, m.persona, count(*)
                FROM lines l
                LEFT JOIN line_meta m ON m.stem = l.stem
                WHERE l.speaker IN ('red', 'nnk', 'grm', 'pkw', 'RedXIII', 'Nanaki')
                   OR m.persona IS NOT NULL
                GROUP BY 1, 2
                ORDER BY 1, 2
                """
            )
            for row in cur.fetchall():
                print(f"{row[0]}\t{row[1]}\t{row[2]}")
        conn.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
