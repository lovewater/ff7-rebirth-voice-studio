#!/usr/bin/env python3
"""Hit inference-host ASR / emotion / TTS with a few random studio lines. Audio stays on this VM; no weights."""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "studio-ff7-rb" / "website" / "data"
DSN = os.getenv("DATABASE_URL", "")


def post_json(url: str, payload: dict, timeout: int = 180) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    data["_sec"] = round(time.perf_counter() - t0, 2)
    return data


def b64_file(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def pick_rows(n: int) -> list[dict]:
    import subprocess

    sql = f"""
    SELECT json_build_object(
      'stem', l.stem,
      'speaker', l.speaker,
      'name', COALESCE(s.name_zh, l.speaker_name, ''),
      'kind', l.kind,
      'zh', left(replace(COALESCE(l.text_zh,''), E'\\n', ' '), 80),
      'jp', left(replace(COALESCE(l.text_jp,''), E'\\n', ' '), 40)
    )
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    WHERE l.kind = '对话' AND length(l.text_zh) BETWEEN 8 AND 40
      AND l.speaker IN ('cld','tif','aer','bar','tfa','art')
    ORDER BY random()
    LIMIT {int(n)};
    """
    out = subprocess.check_output(
        ["psql", DSN, "-A", "-t", "-c", sql],
        text=True,
    )
    rows = []
    for line in out.strip().splitlines():
        if not line.strip():
            continue
        rows.append(json.loads(line))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--asr", default=os.getenv("QWEN_ASR_URL", ""))
    ap.add_argument("--emotion", default=os.getenv("EMOTION_URL", ""))
    ap.add_argument("--tts", default=os.getenv("TTS_URL", ""))
    ap.add_argument("-n", type=int, default=4)
    ap.add_argument("--skip-tts", action="store_true")
    args = ap.parse_args()

    rows = pick_rows(args.n)
    if not rows:
        print("no rows", file=sys.stderr)
        return 2
    print("picked:")
    for r in rows:
        print(f"  {r['stem']}  {r['name']}  {r['zh']}")

    fail = 0
    print("\n=== ASR ===")
    for r in rows:
        p = DATA / "cn" / f"{r['stem']}.mp3"
        try:
            d = post_json(args.asr.rstrip("/") + "/asr", {
                "task_id": r["stem"],
                "sample_audio": b64_file(p),
                "language": "Chinese",
            })
            texts = [x.get("text", "") for x in (d.get("results") or [])]
            print(f"  {r['stem']}  {d.get('success')}  {d['_sec']}s  {' '.join(texts)[:80]}")
            if not d.get("success"):
                fail += 1
        except Exception as e:
            fail += 1
            print(f"  {r['stem']}  FAIL {e}")

    print("\n=== emotion zh+ja ===")
    for r in rows:
        for lang, folder in (("zh", "cn"), ("ja", "jp")):
            p = DATA / folder / f"{r['stem']}.mp3"
            try:
                d = post_json(args.emotion.rstrip("/") + "/emotion", {
                    "audio": b64_file(p),
                    "language": lang,
                }, timeout=120)
                print(
                    f"  {lang} {r['stem']}  {d.get('success')}  {d['_sec']}s  "
                    f"emo={d.get('emotion')} lang={d.get('language')} text={str(d.get('text'))[:60]}"
                )
                if not d.get("success"):
                    fail += 1
            except Exception as e:
                fail += 1
                print(f"  {lang} {r['stem']}  FAIL {e}")

    if args.skip_tts:
        return 1 if fail else 0

    print("\n=== TTS (embed first Cloud clip set, then synth one line) ===")
    cloud = [r for r in rows if r["speaker"] == "cld"]
    refs = cloud[:3] or rows[:3]
    try:
        audios = [b64_file(DATA / "cn" / f"{r['stem']}.mp3") for r in refs]
        d = post_json(args.tts.rstrip("/") + "/v1/speaker/embed", {
            "speaker": refs[0]["speaker"],
            "audios": audios,
        }, timeout=180)
        print(f"  embed {refs[0]['speaker']} n={d.get('n_clips')} {d.get('success')} {d['_sec']}s")
        target = cloud[0] if cloud else rows[0]
        emo = b64_file(DATA / "jp" / f"{target['stem']}.mp3")
        d = post_json(args.tts.rstrip("/") + "/v1/tts", {
            "text": target["zh"],
            "speaker": refs[0]["speaker"],
            "emo_audio": emo,
            "duration_factor": 1.0,
            "lang": "ZH",
            "emo_alpha": 0.8,
        }, timeout=300)
        print(
            f"  tts {target['stem']}  {d.get('success')}  {d['_sec']}s  bytes={d.get('bytes')}"
        )
        if not d.get("success") or not d.get("audio_wav_b64"):
            fail += 1
        else:
            out = Path("/tmp/ff7-tts-try.wav")
            out.write_bytes(base64.b64decode(d["audio_wav_b64"]))
            print(f"  wrote {out}")
    except urllib.error.HTTPError as e:
        fail += 1
        print(f"  TTS FAIL {e.code} {e.read()[:400]!r}")
    except Exception as e:
        fail += 1
        print(f"  TTS FAIL {e}")

    print(f"\nfail={fail}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
