#!/usr/bin/env python3
"""Fill speakers + line_meta from official TxtRes. Studio-only; not packed."""

from __future__ import annotations

import collections
import json
import os
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]
ENTRIES = ROOT / "work" / "txtres-entries.jsonl"
DSN = os.environ.get("DATABASE_URL", "")

SKIP = {"mma", "mfa", "sma", "sfa", "skm", "cln", "dae", "flt"}

ENGLISH = {
    "Cloud": ("克劳德", "クラウド"),
    "Barret": ("巴雷特", "バレット"),
    "Tifa": ("蒂法", "ティファ"),
    "Aerith": ("爱丽丝", "エアリス"),
    "RedXIII": ("赤红XIII", "レッドXIII"),
    "Nanaki": ("纳纳基", "ナナキ"),
    "Yuffie": ("尤菲", "ユフィ"),
    "CaitSith": ("凯特西", "ケット・シー"),
    "Zack": ("扎克斯", "ザックス"),
    "Sephiroth": ("萨菲罗斯", "セフィロス"),
    "Dyne": ("戴因", "ダイン"),
    "Locche": ("罗榭", "ローチェ"),
    "SecuritySoldier": ("警备兵", "警備兵"),
    "CombatSoldier": ("战斗兵", "戦闘兵"),
    "MonoDrive": ("单驱机", "モノドライブ"),
}

GENERIC = {
    "mma": ("男NPC", "男性NPC"),
    "mfa": ("女NPC", "女性NPC"),
    "mmk": ("少年", "少年"),
    "mfk": ("少女", "少女"),
    "skm": ("神罗兵", "神羅兵"),
    "sma": ("男店员", "男性店員"),
    "sfa": ("女店员", "女性店員"),
}


def majority(counter: collections.Counter[str]) -> tuple[str | None, float]:
    if not counter:
        return None, 0.0
    name, n = counter.most_common(1)[0]
    share = n / sum(counter.values())
    return name, share


def load_txtres() -> tuple[dict[str, dict[str, str]], dict[str, collections.Counter], dict[str, collections.Counter]]:
    """Return per-stem actors, and per-speaker vote counters."""
    per_stem: dict[str, dict[str, str]] = {}
    zh_votes: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    jp_votes: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    if not ENTRIES.exists():
        return per_stem, zh_votes, jp_votes
    with ENTRIES.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            stem = row.get("stem")
            actor = (row.get("actor") or "").strip()
            if not stem:
                continue
            slot = per_stem.setdefault(stem, {})
            lang = row.get("lang")
            if actor and actor not in ("？？？？", "????"):
                if lang == "CN":
                    slot.setdefault("actor_zh", actor)
                elif lang == "JP":
                    slot.setdefault("actor_jp", actor)
    return per_stem, zh_votes, jp_votes


def main() -> int:
    per_stem, _zh_unused, _jp_unused = load_txtres()
    zh_votes: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    jp_votes: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)

    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(Path(__file__).resolve().parents[1].joinpath("db/init/002_line_meta.sql").read_text())
            cur.execute("SELECT stem, speaker FROM lines")
            lines = cur.fetchall()
            for stem, speaker in lines:
                if not speaker:
                    continue
                actors = per_stem.get(stem) or {}
                if actors.get("actor_zh"):
                    zh_votes[speaker][actors["actor_zh"]] += 1
                if actors.get("actor_jp"):
                    jp_votes[speaker][actors["actor_jp"]] += 1

            speaker_rows = []
            codes = {speaker for _stem, speaker in lines if speaker}
            for code in codes:
                if code in GENERIC:
                    zh, jp = GENERIC[code]
                    src = "generic"
                elif code in ENGLISH:
                    zh, jp = ENGLISH[code]
                    src = "english"
                elif code in SKIP:
                    continue
                else:
                    zh, zshare = majority(zh_votes[code])
                    jp, jshare = majority(jp_votes[code])
                    if zh == "ＭＡＩ":
                        zh = "MAI"
                    if zshare < 0.55:
                        zh = None
                    if jshare < 0.55:
                        jp = None
                    src = "txtres"
                if zh or jp:
                    speaker_rows.append((code, zh, jp, src))

            cur.executemany(
                """
                INSERT INTO speakers (code, name_zh, name_jp, source, updated_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (code) DO UPDATE SET
                    name_zh = COALESCE(EXCLUDED.name_zh, speakers.name_zh),
                    name_jp = COALESCE(EXCLUDED.name_jp, speakers.name_jp),
                    source = EXCLUDED.source,
                    updated_at = now()
                WHERE speakers.source IS DISTINCT FROM 'manual'
                """,
                speaker_rows,
            )

            meta_rows = []
            for stem, _speaker in lines:
                actors = per_stem.get(stem) or {}
                az, aj = actors.get("actor_zh"), actors.get("actor_jp")
                if az or aj:
                    meta_rows.append((stem, az, aj))
            cur.executemany(
                """
                INSERT INTO line_meta (stem, actor_zh, actor_jp, extra, updated_at)
                VALUES (%s, %s, %s, '{}'::jsonb, now())
                ON CONFLICT (stem) DO UPDATE SET
                    actor_zh = COALESCE(EXCLUDED.actor_zh, line_meta.actor_zh),
                    actor_jp = COALESCE(EXCLUDED.actor_jp, line_meta.actor_jp),
                    updated_at = now()
                """,
                meta_rows,
            )
            cur.execute("SELECT COUNT(*) FROM speakers")
            n_sp = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM line_meta")
            n_meta = cur.fetchone()[0]
        conn.commit()
    print(f"speakers={n_sp} line_meta={n_meta}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
