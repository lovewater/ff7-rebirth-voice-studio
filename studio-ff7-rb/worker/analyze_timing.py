#!/usr/bin/env python3
"""Measure leading/trailing silence on JP+CN MP3s and fill line_meta timing.

Samples quieter than 5% of that file's peak amplitude count as silence.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import psycopg

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "studio-ff7-rb" / "website" / "data"
LOG = ROOT / "work" / "analyze-timing.log"
DSN = os.environ.get("DATABASE_URL", "")
SR = 16000
SILENCE_RATIO = 0.05
WORKERS = max(2, min(8, os.cpu_count() or 4))


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def analyze_mp3(path: Path) -> tuple[float, float, float, float] | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    proc = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            str(SR),
            "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        return None
    samples = np.frombuffer(proc.stdout, dtype=np.float32)
    if samples.size == 0:
        return None
    dur = float(samples.size / SR)
    peak = float(np.max(np.abs(samples)))
    if peak <= 1e-8:
        return 0.0, 0.0, dur, 0.0
    idx = np.flatnonzero(np.abs(samples) >= SILENCE_RATIO * peak)
    if idx.size == 0:
        return 0.0, 0.0, dur, 0.0
    start = float(idx[0] / SR)
    end = float((idx[-1] + 1) / SR)
    return start, end, dur, end - start


def job(stem: str, en_only: bool = False) -> tuple[str, dict | None, str]:
    try:
        jp = None if en_only else analyze_mp3(DATA / "jp" / f"{stem}.mp3")
        cn = None if en_only else analyze_mp3(DATA / "cn" / f"{stem}.mp3")
        en = None
        out: dict[str, float | None] = {
            "jp_start_s": None,
            "jp_end_s": None,
            "jp_dur_s": None,
            "jp_speech_s": None,
            "cn_start_s": None,
            "cn_end_s": None,
            "cn_dur_s": None,
            "cn_speech_s": None,
            "en_start_s": None,
            "en_end_s": None,
            "en_dur_s": None,
            "en_speech_s": None,
        }
        if jp:
            out["jp_start_s"], out["jp_end_s"], out["jp_dur_s"], out["jp_speech_s"] = jp
        if cn:
            out["cn_start_s"], out["cn_end_s"], out["cn_dur_s"], out["cn_speech_s"] = cn
        if en:
            out["en_start_s"], out["en_end_s"], out["en_dur_s"], out["en_speech_s"] = en
        if not jp and not cn and not en:
            return stem, None, "no mp3"
        return stem, out, "ok"
    except Exception as e:
        return stem, None, f"{type(e).__name__}: {e}"


def main() -> int:
    force = "--force" in sys.argv
    en_only = "--en" in sys.argv or "--en-only" in sys.argv
    log(f"analyze-timing start workers={WORKERS} force={force} en_only={en_only}")
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(Path(__file__).resolve().parents[1].joinpath("db/init/020_english.sql").read_text())
            if force:
                cur.execute("SELECT stem FROM lines ORDER BY stem")
            elif en_only:
                cur.execute(
                    """
                    SELECT l.stem FROM lines l
                    LEFT JOIN line_meta m ON m.stem = l.stem
                    WHERE m.en_dur_s IS NULL
                    ORDER BY l.stem
                    """
                )
            else:
                cur.execute(
                    """
                    SELECT l.stem FROM lines l
                    LEFT JOIN line_meta m ON m.stem = l.stem
                    WHERE m.jp_dur_s IS NULL AND m.cn_dur_s IS NULL
                    ORDER BY l.stem
                    """
                )
            stems = [r[0] for r in cur.fetchall()]
        conn.commit()
    log(f"{len(stems)} stems to scan")
    ok = fail = 0
    batch: list[tuple[str, dict]] = []

    def flush(rows: list[tuple[str, dict]]) -> None:
        if not rows:
            return
        with psycopg.connect(DSN) as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO line_meta (
                        stem, extra,
                        jp_start_s, jp_end_s, jp_dur_s, jp_speech_s,
                        cn_start_s, cn_end_s, cn_dur_s, cn_speech_s,
                        en_start_s, en_end_s, en_dur_s, en_speech_s,
                        updated_at
                    ) VALUES (
                        %(stem)s, '{}'::jsonb,
                        %(jp_start_s)s, %(jp_end_s)s, %(jp_dur_s)s, %(jp_speech_s)s,
                        %(cn_start_s)s, %(cn_end_s)s, %(cn_dur_s)s, %(cn_speech_s)s,
                        %(en_start_s)s, %(en_end_s)s, %(en_dur_s)s, %(en_speech_s)s,
                        now()
                    )
                    ON CONFLICT (stem) DO UPDATE SET
                        jp_start_s = COALESCE(EXCLUDED.jp_start_s, line_meta.jp_start_s),
                        jp_end_s = COALESCE(EXCLUDED.jp_end_s, line_meta.jp_end_s),
                        jp_dur_s = COALESCE(EXCLUDED.jp_dur_s, line_meta.jp_dur_s),
                        jp_speech_s = COALESCE(EXCLUDED.jp_speech_s, line_meta.jp_speech_s),
                        cn_start_s = COALESCE(EXCLUDED.cn_start_s, line_meta.cn_start_s),
                        cn_end_s = COALESCE(EXCLUDED.cn_end_s, line_meta.cn_end_s),
                        cn_dur_s = COALESCE(EXCLUDED.cn_dur_s, line_meta.cn_dur_s),
                        cn_speech_s = COALESCE(EXCLUDED.cn_speech_s, line_meta.cn_speech_s),
                        en_start_s = COALESCE(EXCLUDED.en_start_s, line_meta.en_start_s),
                        en_end_s = COALESCE(EXCLUDED.en_end_s, line_meta.en_end_s),
                        en_dur_s = COALESCE(EXCLUDED.en_dur_s, line_meta.en_dur_s),
                        en_speech_s = COALESCE(EXCLUDED.en_speech_s, line_meta.en_speech_s),
                        updated_at = now()
                    """,
                    [{"stem": stem, **vals} for stem, vals in rows],
                )
            conn.commit()

    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(job, s, en_only) for s in stems]
        for n, fut in enumerate(as_completed(futs), 1):
            stem, vals, why = fut.result()
            if vals is None:
                fail += 1
                log(f"FAIL {stem}: {why}")
            else:
                ok += 1
                batch.append((stem, vals))
            if len(batch) >= 200:
                flush(batch)
                batch.clear()
            if n % 200 == 0 or n == len(stems):
                log(f"  {n}/{len(stems)} ok={ok} fail={fail}")
    flush(batch)
    log(f"done ok={ok} fail={fail}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
