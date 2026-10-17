#!/usr/bin/env python3
"""Extract official JP/CN TxtRes subtitles and join them onto catalog stems.

IoStore zen dumps are not FModel-legacy, so ff7r-text-tool cannot parse them.
IDs inside EndTextResource are `$` + voice stem, e.g.
`$C1910_MAIN_0600_0100_00_blt`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]
PROGRAMS = ROOT / "programs"
BIN = PROGRAMS / "bin"
RETOC = BIN / "retoc"
GAME_PAKS = ROOT / "game" / "FINAL FANTASY VII REBIRTH" / "End" / "Content" / "Paks"
WORK = ROOT / "work"
RAW = WORK / "txtres-raw"
INDEX = WORK / "txtres-index.jsonl"
ENTRIES = WORK / "txtres-entries.jsonl"
DSN = os.environ.get("DATABASE_URL", "")

LANG_MARKERS = ("JP", "CN", "US", "TW", "KR", "DE", "FR", "IT", "ES", "BR", "MX")
TAG_RE = re.compile(r"</?i>", re.I)
BR_RE = re.compile(r"<br\s*/?>", re.I)


def read_fstring(data: bytes, i: int) -> tuple[str, int]:
    if i + 4 > len(data):
        raise ValueError(f"FString header past EOF at {i}")
    (ln,) = struct.unpack_from("<i", data, i)
    if ln == 0:
        return "", i + 4
    if ln > 0:
        end = i + 4 + ln
        if end > len(data) or ln > 1_000_000:
            raise ValueError(f"bad UTF-8 FString len={ln} at {i}")
        raw = data[i + 4 : end]
        if raw[-1:] != b"\x00":
            raise ValueError(f"UTF-8 FString missing NUL at {i}")
        return raw[:-1].decode("utf-8"), end
    n = -ln
    end = i + 4 + n * 2
    if end > len(data) or n > 1_000_000:
        raise ValueError(f"bad UTF-16 FString len={ln} at {i}")
    raw = data[i + 4 : end]
    if raw[-2:] != b"\x00\x00":
        raise ValueError(f"UTF-16 FString missing NUL at {i}")
    return raw[:-2].decode("utf-16le"), end


def find_lang(data: bytes) -> tuple[str, int] | None:
    """Return (lang, offset_after_language_fstring)."""
    hits: list[tuple[int, str, int]] = []
    for lang in LANG_MARKERS:
        needle = struct.pack("<i", len(lang) + 1) + lang.encode("ascii") + b"\x00"
        idx = data.find(needle)
        if idx >= 0:
            hits.append((idx, lang, idx + len(needle)))
    if not hits:
        return None
    hits.sort()
    return hits[0][1], hits[0][2]


def clean_text(s: str) -> str:
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = BR_RE.sub("\n", s)
    s = TAG_RE.sub("", s)
    s = s.replace("\u3000", " ")
    return s.strip()


def parse_txtres(data: bytes) -> dict:
    found = find_lang(data)
    if not found:
        return {"language": None, "entries": []}
    lang, i = found
    if i + 8 > len(data):
        return {"language": lang, "entries": []}
    (pad,) = struct.unpack_from("<I", data, i)
    if pad != 0:
        raise ValueError(f"expected 0 pad after language, got {pad} at {i}")
    i += 4
    (count,) = struct.unpack_from("<I", data, i)
    i += 4
    if count > 200_000:
        raise ValueError(f"unreasonable entry count {count}")
    entries = []
    for n in range(count):
        eid, i = read_fstring(data, i)
        text, i = read_fstring(data, i)
        if i + 4 > len(data):
            raise ValueError(f"EOF reading sub count for {eid}")
        (nsub,) = struct.unpack_from("<I", data, i)
        i += 4
        if nsub > 16:
            raise ValueError(f"bad sub count {nsub} for {eid}")
        actor = ""
        for _ in range(nsub):
            if i + 8 > len(data):
                raise ValueError(f"EOF reading subentry for {eid}")
            (_name_id,) = struct.unpack_from("<I", data, i)
            i += 4
            (_null,) = struct.unpack_from("<I", data, i)
            i += 4
            sub, i = read_fstring(data, i)
            if not actor:
                actor = clean_text(sub)
        entries.append(
            {
                "id": eid,
                "stem": eid[1:] if eid.startswith("$") else eid,
                "text": clean_text(text),
                "actor": actor,
                # <i> wraps off-screen lines. The cleaned text drops the tag.
                "italic": "<i>" in text.lower(),
            }
        )
    return {"language": lang, "entries": entries, "bytes_consumed": i, "file_size": len(data)}


def list_txtres(utoc: Path, lang: str) -> list[dict]:
    proc = subprocess.run(
        [str(RETOC), "list", "--path", "--size", str(utoc)],
        capture_output=True,
        text=True,
    )
    needle = f"Text/{lang}/"
    out = []
    for line in proc.stdout.splitlines():
        if needle not in line or not line.endswith("_TxtRes.uasset"):
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            size = int(parts[3])
        except ValueError:
            continue
        path = parts[4]
        out.append(
            {
                "lang": lang,
                "chunk_id": parts[1],
                "container": parts[0],
                "path": path,
                "size": size,
                "name": Path(path).stem,
            }
        )
    return out


def retoc_get(utoc: Path, chunk_id: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [str(RETOC), "get", str(utoc), chunk_id, str(dest)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        raise RuntimeError(f"retoc get {chunk_id} failed: {proc.stderr[-400:]}")


def extract_lang(lang: str, utoc_name: str) -> list[dict]:
    utoc = GAME_PAKS / utoc_name
    listed = list_txtres(utoc, lang)
    print(f"{lang}: {len(listed)} TxtRes in {utoc_name}", flush=True)
    rows = []
    for i, item in enumerate(listed, 1):
        dest = RAW / lang / f"{item['name']}.uasset"
        if not dest.exists() or dest.stat().st_size != item["size"]:
            retoc_get(utoc, item["chunk_id"], dest)
        data = dest.read_bytes()
        parsed = parse_txtres(data)
        n = len(parsed["entries"])
        print(f"  [{i}/{len(listed)}] {item['name']} size={item['size']} entries={n}", flush=True)
        for e in parsed["entries"]:
            rows.append(
                {
                    "lang": lang,
                    "source": item["name"],
                    "id": e["id"],
                    "stem": e["stem"],
                    "text": e["text"],
                    "actor": e["actor"],
                    "italic": e["italic"],
                }
            )
        with INDEX.open("a", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {
                        **item,
                        "entries": n,
                        "language": parsed.get("language"),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return rows


# Unused draft; 8800-FOREE is the in-game copy (KoiamLa / CAPIT notes).
SKIP_SOURCES = {"8900-CAPIT_TxtRes"}


def merge_by_stem(rows: list[dict]) -> dict[str, dict]:
    """Keep first non-empty text per stem; later files do not overwrite."""
    out: dict[str, dict] = {}
    for r in rows:
        if r.get("source") in SKIP_SOURCES:
            continue
        stem = r["stem"]
        cur = out.get(stem)
        if cur is None:
            out[stem] = r
            continue
        if not cur.get("text") and r.get("text"):
            out[stem] = r
    return out


def import_db(jp: dict[str, dict], cn: dict[str, dict], us: dict[str, dict] | None = None) -> None:
    us = us or {}
    updates = []
    stems = set(jp) | set(cn) | set(us)
    for stem in stems:
        cn_row = cn.get(stem) or {}
        jp_row = jp.get(stem) or {}
        style_row = cn_row if cn_row.get("text") else jp_row
        italic = bool(style_row.get("italic")) if style_row.get("text") else None
        updates.append(
            (
                jp_row.get("text"),
                cn_row.get("text"),
                italic,
                stem,
            )
        )
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                UPDATE lines
                   SET text_jp = COALESCE(%s, text_jp),
                       text_zh = COALESCE(%s, text_zh),
                       subtitle_italic = COALESCE(%s, subtitle_italic),
                       updated_at = now()
                 WHERE stem = %s
                """,
                updates,
            )
            cur.execute(
                """
                SELECT
                  COUNT(*)::int AS n,
                  COUNT(text_jp) FILTER (WHERE text_jp IS NOT NULL AND text_jp <> '')::int AS jp,
                  COUNT(text_zh) FILTER (WHERE text_zh IS NOT NULL AND text_zh <> '')::int AS zh,
                  COUNT(text_en) FILTER (WHERE text_en IS NOT NULL AND text_en <> '')::int AS en
                FROM lines
                """
            )
            n, jp_n, zh_n, en_n = cur.fetchone()
        conn.commit()
    print(f"db lines={n} with JP subtitle={jp_n} CN subtitle={zh_n} EN subtitle={en_n}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-extract", action="store_true", help="reuse work/txtres-raw")
    ap.add_argument("--no-db", action="store_true")
    ap.add_argument("--us-only", action="store_true", help="only extract US subtitles")
    args = ap.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    if not args.skip_extract and not args.us_only:
        INDEX.write_text("", encoding="utf-8")

    jp_rows: list[dict] = []
    cn_rows: list[dict] = []
    us_rows: list[dict] = []
    if args.us_only:
        us_rows = extract_lang("US", "pakchunk1-WindowsNoEditor.utoc")
    else:
        jp_rows = extract_lang("JP", "pakchunk3-WindowsNoEditor.utoc")
        cn_rows = extract_lang("CN", "pakchunk2-WindowsNoEditor.utoc")
        us_rows = extract_lang("US", "pakchunk1-WindowsNoEditor.utoc")

    with ENTRIES.open("w", encoding="utf-8") as fh:
        for r in jp_rows + cn_rows + us_rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    jp = merge_by_stem(jp_rows)
    cn = merge_by_stem(cn_rows)
    us = merge_by_stem(us_rows)
    print(f"unique stems JP={len(jp)} CN={len(cn)} US={len(us)}")

    catalog = WORK / "cn-catalog.jsonl"
    cat_stems = set()
    if catalog.exists():
        with catalog.open(encoding="utf-8") as fh:
            for line in fh:
                cat_stems.add(json.loads(line)["stem"])
        jp_hit = sum(1 for s in cat_stems if s in jp)
        cn_hit = sum(1 for s in cat_stems if s in cn)
        us_hit = sum(1 for s in cat_stems if s in us)
        print(
            f"catalog {len(cat_stems)}: JP match {jp_hit} CN match {cn_hit} US match {us_hit} "
            f"unmatched {len(cat_stems) - len(cat_stems & (set(jp)|set(cn)|set(us)))}"
        )

    if not args.no_db:
        import_db(jp, cn, us)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
