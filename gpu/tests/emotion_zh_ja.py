#!/usr/bin/env python3
"""emotion2vec+ on Chinese and Japanese clips."""

from __future__ import annotations

import argparse
import json
import urllib.request


def post(url: str, path: str, language: str) -> dict:
    import base64

    b64 = base64.b64encode(open(path, "rb").read()).decode("ascii")
    body = json.dumps({"audio": b64, "language": language}).encode()
    req = urllib.request.Request(
        url.rstrip("/") + "/emotion", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8002")
    ap.add_argument("--zh", action="append", default=[], help="中文音频")
    ap.add_argument("--ja", action="append", default=[], help="日文音频")
    args = ap.parse_args()
    if not args.zh and not args.ja:
        print("给 --zh 和/或 --ja 音频路径")
        return 2
    fail = 0
    for lang, files in (("zh", args.zh), ("ja", args.ja)):
        for p in files:
            r = post(args.url, p, lang)
            print(
                f"{lang} {p}\n  success={r.get('success')} emotion={r.get('emotion')} "
                f"lang={r.get('language')} event={r.get('event')} text={str(r.get('text'))[:80]}"
            )
            if not r.get("success") or not r.get("emotion"):
                fail += 1
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
