#!/usr/bin/env python3
"""Delete unheard zeroshot TTS for multiline 中文 and clone again with 换行→句号."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
DATA = os.path.join(ROOT, "website", "data")
WORK = os.path.join(os.path.dirname(ROOT), "work")
DONE = os.path.join(WORK, "regen-linebreak.done")
LOG = os.path.join(WORK, "regen-linebreak.log")
API = os.environ.get("STUDIO_ORIGIN", "http://127.0.0.1:8765")

STEMS_SQL = r"""
SELECT DISTINCT l.stem, replace(replace(l.text_zh, chr(13), ''), chr(10), '<NL>')
FROM lines l
JOIN line_tts_versions v ON v.stem = l.stem
WHERE l.text_zh LIKE '%' || chr(10) || '%'
  AND v.status = 'ready'
  AND v.heard_at IS NULL
  AND NOT v.is_used
  AND v.voice_gpu_key LIKE 'zeroshot-%'
ORDER BY 1
"""


def log(msg: str) -> None:
    line = time.strftime("[%F %T] ") + msg
    print(line, flush=True)
    os.makedirs(WORK, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def psql(query: str) -> list[list[str]]:
    result = subprocess.run(
        ["docker", "exec", "studio-ff7-rb-db-1", "psql", "-U", "ff7rb", "-d", "studio", "-At", "-F", "\t", "-c", query],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.split("\t") for line in result.stdout.splitlines() if line]


def line_pieces(text: str) -> list[str]:
    return [part.strip() for part in text.splitlines() if part.strip()]


def punctuate(text: str) -> str:
    lines = line_pieces(text)
    if len(lines) < 2:
        return text.strip()
    out: list[str] = []
    for i, line in enumerate(lines):
        if i == len(lines) - 1:
            out.append(line)
            continue
        if re.search(r"[。！？，、；：…,.!?;:]$", line) or re.search(r"\[停顿=\d{1,4}\]$", line):
            out.append(line)
        else:
            out.append(f"{line}。")
    return "".join(out)


def load_done() -> set[str]:
    if not os.path.isfile(DONE):
        return set()
    with open(DONE, encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip()}


def mark_done(stem: str) -> None:
    with open(DONE, "a", encoding="utf-8") as fh:
        fh.write(stem + "\n")


def delete_unheard(stem: str, keep_text: str) -> int:
    keep = keep_text.replace("'", "''")
    rows = psql(
        "SELECT id, COALESCE(audio_path,''), COALESCE(raw_audio_path,''), COALESCE(manifest_path,'') "
        "FROM line_tts_versions "
        f"WHERE stem = '{stem}' AND heard_at IS NULL AND NOT is_used "
        "AND voice_gpu_key LIKE 'zeroshot-%' AND status <> 'building' "
        f"AND tts_text IS DISTINCT FROM '{keep}'"
    )
    for _id, audio, raw, manifest in rows:
        for rel in (audio, raw, manifest):
            if not rel:
                continue
            path = os.path.join(DATA, rel)
            subprocess.run(["sudo", "rm", "-f", path], check=False)
        psql(f"DELETE FROM line_tts_versions WHERE id = {_id} AND stem = '{stem}'")
    return len(rows)


def already_punctuated(stem: str, want: str) -> bool:
    rows = psql(
        "SELECT tts_text FROM line_tts_versions "
        f"WHERE stem = '{stem}' AND status = 'ready' AND voice_gpu_key LIKE 'zeroshot-%'"
    )
    return any(row[0] == want for row in rows)


def clone(stem: str, text_zh: str) -> None:
    body = json.dumps({"ttsText": text_zh, "durationFactor": 1}).encode()
    req = urllib.request.Request(
        f"{API}/api/lines/{stem}/tts/clone",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=1200) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {err.code} {detail[:400]}") from err
    if payload.get("error"):
        raise RuntimeError(str(payload["error"]))


def main() -> int:
    jobs = [(row[0], row[1].replace("<NL>", "\n")) for row in psql(STEMS_SQL) if len(row) >= 2]
    done = load_done()
    log(f"multiline unheard zeroshot stems={len(jobs)} already_done={len(done)}")
    failed = 0
    for i, (stem, zh) in enumerate(jobs, start=1):
        want = punctuate(zh)
        if stem in done:
            continue
        try:
            removed = delete_unheard(stem, want)
            if already_punctuated(stem, want):
                mark_done(stem)
                log(f"{i}/{len(jobs)} {stem} deleted={removed} skip-already-punctuated")
                continue
            clone(stem, zh)
            mark_done(stem)
            log(f"{i}/{len(jobs)} {stem} deleted={removed} ok sent={want[:40]}")
        except Exception as exc:
            failed += 1
            log(f"{i}/{len(jobs)} {stem} FAIL {exc}")
    log(f"finished failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
