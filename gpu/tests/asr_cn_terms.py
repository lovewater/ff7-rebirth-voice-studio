#!/usr/bin/env python3
"""Hit Qwen3-ASR with Chinese FF7 proper nouns. Needs a running asr service and wav/mp3 paths."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

TERMS = [
    "克劳德",
    "蒂法",
    "爱丽丝",
    "巴雷特",
    "萨菲罗斯",
    "纳纳基",
    "尤菲",
    "凯特西",
    "尼福尔海姆",
    "珠诺",
    "星殒峡谷",
    "古代种神殿",
    "忘却之都",
    "魔晄",
    "神罗",
]


def post_asr(url: str, path: str, language: str = "Chinese") -> dict:
    import base64

    b64 = base64.b64encode(open(path, "rb").read()).decode("ascii")
    body = json.dumps(
        {"task_id": "ff7-term", "sample_audio": b64, "language": language}
    ).encode()
    req = urllib.request.Request(url.rstrip("/") + "/asr", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8001")
    ap.add_argument("audios", nargs="+", help="中文 mp3/wav，最好含专有名词")
    args = ap.parse_args()
    all_text = []
    for p in args.audios:
        r = post_asr(args.url, p)
        texts = [x.get("text", "") for x in r.get("results") or []]
        joined = " ".join(texts)
        all_text.append(joined)
        print(f"FILE {p}\n  success={r.get('success')} {joined[:200]}\n")
    blob = "\n".join(all_text)
    print("=== 专名命中 ===")
    hit = miss = 0
    for t in TERMS:
        ok = t in blob
        print(("OK " if ok else "NO "), t)
        hit += int(ok)
        miss += int(not ok)
    print(f"hit={hit} miss={miss} (miss 只说明这几条样本里没读到该词，不一定是模型不行)")
    return 0 if miss < len(TERMS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
