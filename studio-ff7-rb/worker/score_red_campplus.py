#!/usr/bin/env python3
"""Score JP clips of red/nnk against the current Red XIII CampPlus centroid."""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "studio-ff7-rb" / "website" / "data"
SQL = Path(__file__).resolve().parents[1] / "db/init/018_spk_sim.sql"
DSN = os.environ.get("DATABASE_URL", "")
TTS_URL = os.environ.get("TTS_COMPARE_URL", os.environ.get("TTS_URL", ""))


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def latest_red_pt(cur) -> tuple[int, Path]:
    cur.execute(
        """
        SELECT v.id, v.result_dir
        FROM voice_bank_versions v
        JOIN voice_banks b ON b.id = v.bank_id
        WHERE b.speaker = 'red' AND v.status = 'ready' AND v.embedding_path IS NOT NULL
        ORDER BY v.id DESC
        LIMIT 1
        """
    )
    row = cur.fetchone()
    if not row:
        raise SystemExit("no ready red embedding")
    vid, rel = row
    pt = DATA / rel / "speaker.pt" if not Path(rel).is_absolute() else Path(rel) / "speaker.pt"
    if not pt.exists():
        pt = DATA / "embedded" / "red" / f"v{vid}" / "speaker.pt"
    if not pt.exists():
        raise SystemExit(f"missing speaker.pt for red version {vid}: {pt}")
    return vid, pt


def compare(url: str, pt_b64: str, mp3: Path) -> float:
    body = json.dumps(
        {
            "embedding_pt_b64": pt_b64,
            "audio": base64.b64encode(mp3.read_bytes()).decode("ascii"),
        }
    ).encode()
    req = urllib.request.Request(
        url.rstrip("/") + "/v1/speaker/compare",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())
    if not data.get("success"):
        raise RuntimeError(data)
    return float(data["cosine"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(SQL.read_text())
            vid, pt = latest_red_pt(cur)
            cur.execute(
                """
                SELECT l.stem FROM lines l
                LEFT JOIN line_meta m ON m.stem = l.stem
                WHERE l.speaker IN ('red', 'nnk')
                  AND (m.jp_spk_sim_red IS NULL)
                ORDER BY l.stem
                """
            )
            stems = [r[0] for r in cur.fetchall()]
        conn.commit()

    if args.limit:
        stems = stems[: args.limit]
    pt_b64 = base64.b64encode(pt.read_bytes()).decode("ascii")
    log(f"red embedding v{vid} {pt} stems={len(stems)} url={TTS_URL}")

    ok = fail = 0
    batch: list[tuple[str, float]] = []
    t0 = time.time()

    def one(stem: str) -> tuple[str, float | None, str]:
        p = DATA / "jp" / f"{stem}.mp3"
        if not p.exists() or p.stat().st_size < 1000:
            return stem, None, "no jp mp3"
        try:
            return stem, compare(TTS_URL, pt_b64, p), "ok"
        except Exception as e:
            return stem, None, f"{type(e).__name__}: {e}"

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = [ex.submit(one, s) for s in stems]
        for n, fut in enumerate(as_completed(futs), 1):
            stem, score, why = fut.result()
            if score is None:
                fail += 1
                if fail <= 15:
                    log(f"FAIL {stem} {why}")
            else:
                ok += 1
                batch.append((stem, score))
            if len(batch) >= 40:
                flush(batch)
                batch = []
            if n % 50 == 0 or n == len(stems):
                log(f"{n}/{len(stems)} ok={ok} fail={fail} {(n / max(time.time() - t0, 1e-6)):.1f}/s")
    flush(batch)
    log(f"done ok={ok} fail={fail} {time.time() - t0:.0f}s")
    return 0 if ok or not stems else 1


def flush(rows: list[tuple[str, float]]) -> None:
    if not rows:
        return
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO line_meta (stem, extra, jp_spk_sim_red, updated_at)
                VALUES (%s, '{}'::jsonb, %s, now())
                ON CONFLICT (stem) DO UPDATE SET
                    jp_spk_sim_red = EXCLUDED.jp_spk_sim_red,
                    updated_at = now()
                """,
                rows,
            )
        conn.commit()


if __name__ == "__main__":
    raise SystemExit(main())
