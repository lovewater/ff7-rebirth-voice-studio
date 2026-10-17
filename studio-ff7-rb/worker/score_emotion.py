#!/usr/bin/env python3
"""Score JP+CN emotion2vec+ for 对话 of cast_members (主角/配角)."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from itertools import cycle
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "studio-ff7-rb" / "website" / "data"
LOG = ROOT / "work" / "score-emotion.log"
DSN = os.environ.get("DATABASE_URL", "")

LABELS = [
    "ANGRY",
    "DISGUSTED",
    "FEARFUL",
    "HAPPY",
    "NEUTRAL",
    "OTHER",
    "SAD",
    "SURPRISED",
    "UNKNOWN",
]


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def vec_from_raw(raw: str | list | dict | None) -> dict[str, float]:
    out = {k: 0.0 for k in LABELS}
    if raw is None:
        return out
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return out
    if isinstance(raw, dict):
        for k, v in raw.items():
            key = str(k).upper()
            if key in out:
                out[key] = float(v)
        return out
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            key = str(item.get("label") or "").upper()
            if key in out:
                out[key] = float(item.get("score") or 0)
    return out


def normalize_vec(vec: dict[str, float]) -> dict[str, float]:
    out = {k: max(0.0, float(vec.get(k) or 0)) for k in LABELS}
    s = sum(out.values())
    if s <= 1e-12:
        out = {k: 0.0 for k in LABELS}
        out["NEUTRAL"] = 1.0
        return out
    out = {k: v / s for k, v in out.items()}
    rounded = {k: round(v, 4) for k, v in out.items()}
    peak = max(LABELS, key=lambda k: rounded[k])
    rounded[peak] = round(rounded[peak] + (1.0 - sum(rounded.values())), 4)
    return rounded


def cosine(a: dict[str, float], b: dict[str, float]) -> float | None:
    dot = sum(a[k] * b[k] for k in LABELS)
    na = math.sqrt(sum(a[k] * a[k] for k in LABELS))
    nb = math.sqrt(sum(b[k] * b[k] for k in LABELS))
    if na < 1e-9 or nb < 1e-9:
        return None
    return dot / (na * nb)


def post_emo(url: str, path: Path, timeout: int = 90) -> dict:
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    body = json.dumps({"audio": b64, "language": "auto"}).encode()
    req = urllib.request.Request(
        url.rstrip("/") + "/emotion",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def score_one(stem: str, url: str) -> tuple[str, dict | None, str]:
    try:
        jp_p = DATA / "jp" / f"{stem}.mp3"
        cn_p = DATA / "cn" / f"{stem}.mp3"
        jp_d = post_emo(url, jp_p) if jp_p.exists() and jp_p.stat().st_size else None
        cn_d = post_emo(url, cn_p) if cn_p.exists() and cn_p.stat().st_size else None
        if not jp_d and not cn_d:
            return stem, None, "no mp3"
        if jp_d and not jp_d.get("success"):
            return stem, None, f"jp:{jp_d.get('message')}"
        if cn_d and not cn_d.get("success"):
            return stem, None, f"cn:{cn_d.get('message')}"
        jp_vec = normalize_vec(vec_from_raw((jp_d or {}).get("raw"))) if jp_d else None
        cn_vec = normalize_vec(vec_from_raw((cn_d or {}).get("raw"))) if cn_d else None
        fields = (
            "angry",
            "disgusted",
            "fearful",
            "happy",
            "neutral",
            "other",
            "sad",
            "surprised",
        )
        row: dict = {"emo_src": "computed"}
        if jp_vec:
            jp_top = max(LABELS, key=lambda k: jp_vec.get(k, 0))
            row["jp_emo"] = jp_top if jp_top != "UNKNOWN" else "NEUTRAL"
            for f in fields:
                row[f"jp_emo_{f}"] = jp_vec.get(f.upper(), 0.0)
        else:
            row["jp_emo"] = None
            for f in fields:
                row[f"jp_emo_{f}"] = None
        if cn_vec:
            cn_top = max(LABELS, key=lambda k: cn_vec.get(k, 0))
            row["cn_emo"] = cn_top if cn_top != "UNKNOWN" else "NEUTRAL"
            for f in fields:
                row[f"cn_emo_{f}"] = cn_vec.get(f.upper(), 0.0)
        else:
            row["cn_emo"] = None
            for f in fields:
                row[f"cn_emo_{f}"] = None
        return stem, row, "ok"
    except Exception as e:
        return stem, None, f"{type(e).__name__}: {e}"


def flush(rows: list[tuple[str, dict]]) -> None:
    if not rows:
        return
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO line_meta (
                    stem, extra, emo_src, jp_emo, cn_emo,
                    jp_emo_angry, jp_emo_disgusted, jp_emo_fearful, jp_emo_happy,
                    jp_emo_neutral, jp_emo_other, jp_emo_sad, jp_emo_surprised,
                    cn_emo_angry, cn_emo_disgusted, cn_emo_fearful, cn_emo_happy,
                    cn_emo_neutral, cn_emo_other, cn_emo_sad, cn_emo_surprised,
                    updated_at
                ) VALUES (
                    %(stem)s, '{}'::jsonb, 'computed', %(jp_emo)s, %(cn_emo)s,
                    %(jp_emo_angry)s, %(jp_emo_disgusted)s, %(jp_emo_fearful)s, %(jp_emo_happy)s,
                    %(jp_emo_neutral)s, %(jp_emo_other)s, %(jp_emo_sad)s, %(jp_emo_surprised)s,
                    %(cn_emo_angry)s, %(cn_emo_disgusted)s, %(cn_emo_fearful)s, %(cn_emo_happy)s,
                    %(cn_emo_neutral)s, %(cn_emo_other)s, %(cn_emo_sad)s, %(cn_emo_surprised)s,
                    now()
                )
                ON CONFLICT (stem) DO UPDATE SET
                    emo_src = 'computed',
                    jp_emo = EXCLUDED.jp_emo,
                    cn_emo = EXCLUDED.cn_emo,
                    jp_emo_angry = EXCLUDED.jp_emo_angry,
                    jp_emo_disgusted = EXCLUDED.jp_emo_disgusted,
                    jp_emo_fearful = EXCLUDED.jp_emo_fearful,
                    jp_emo_happy = EXCLUDED.jp_emo_happy,
                    jp_emo_neutral = EXCLUDED.jp_emo_neutral,
                    jp_emo_other = EXCLUDED.jp_emo_other,
                    jp_emo_sad = EXCLUDED.jp_emo_sad,
                    jp_emo_surprised = EXCLUDED.jp_emo_surprised,
                    cn_emo_angry = EXCLUDED.cn_emo_angry,
                    cn_emo_disgusted = EXCLUDED.cn_emo_disgusted,
                    cn_emo_fearful = EXCLUDED.cn_emo_fearful,
                    cn_emo_happy = EXCLUDED.cn_emo_happy,
                    cn_emo_neutral = EXCLUDED.cn_emo_neutral,
                    cn_emo_other = EXCLUDED.cn_emo_other,
                    cn_emo_sad = EXCLUDED.cn_emo_sad,
                    cn_emo_surprised = EXCLUDED.cn_emo_surprised,
                    updated_at = now()
                """,
                [{"stem": stem, **vals} for stem, vals in rows],
            )
        conn.commit()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--urls",
        default=os.environ.get("EMOTION_URLS", ""),
        help="comma-separated emotion HTTP endpoints",
    )
    ap.add_argument("--workers", type=int, default=9)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    urls = [u.strip() for u in args.urls.split(",") if u.strip()]
    if not urls:
        log("no urls")
        return 2

    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            if args.force:
                cur.execute(
                    """
                    SELECT l.stem FROM lines l
                    JOIN cast_members c ON c.speaker = l.speaker
                    WHERE l.kind = '对话'
                    ORDER BY l.stem
                    """
                )
            else:
                cur.execute(
                    """
                    SELECT l.stem FROM lines l
                    JOIN cast_members c ON c.speaker = l.speaker
                    LEFT JOIN line_meta m ON m.stem = l.stem
                    WHERE l.kind = '对话'
                      AND (m.emo_src IS NULL)
                    ORDER BY l.stem
                    """
                )
            stems = [r[0] for r in cur.fetchall()]
        conn.commit()

    log(f"score-emotion stems={len(stems)} urls={urls} workers={args.workers}")
    ok = fail = 0
    batch: list[tuple[str, dict]] = []
    url_cycle = cycle(urls)
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(score_one, s, next(url_cycle)) for s in stems]
        for n, fut in enumerate(as_completed(futs), 1):
            stem, vals, why = fut.result()
            if vals is None:
                fail += 1
                if fail <= 20 or fail % 50 == 0:
                    log(f"FAIL {stem} {why}")
            else:
                ok += 1
                batch.append((stem, vals))
            if len(batch) >= 50:
                flush(batch)
                batch = []
            if n % 100 == 0 or n == len(stems):
                rate = n / max(time.time() - t0, 1e-6)
                log(f"{n}/{len(stems)} ok={ok} fail={fail} {rate:.1f}/s")
    flush(batch)
    log(f"done ok={ok} fail={fail} {time.time() - t0:.0f}s")
    return 1 if fail and not ok else 0


if __name__ == "__main__":
    raise SystemExit(main())
