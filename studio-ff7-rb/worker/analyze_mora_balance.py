#!/usr/bin/env python3
"""Estimate Japanese morae and Mandarin timing units for FF7 subtitle alignment.

Japanese readings are produced by OpenJTalk and cross-checked with fugashi /
UniDic Lite. Japanese body text <=5 characters is skipped. Chinese units are
Han characters plus 1.5 per internal punctuation mark; terminal punctuation
does not take time on either side. Shares mora_core.py with the website.
"""

from __future__ import annotations

import argparse
import os
import re
import sys

import psycopg
from fugashi import Tagger


from mora_core import (
    chinese_syllables, clean_text, japanese_characters, japanese_reading,
    mora_count, punctuation_estimate,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--stem", help="analyze one exact line stem")
    scope.add_argument("--id-range", help="inclusive database line IDs, e.g. 13587:13647")
    scope.add_argument("--prefix", help="analyze lines whose stem starts with this text")
    parser.add_argument("--min-ratio", type=float, default=1.05,
                        help="flag below this (Chinese side is long); current default: 1.05")
    parser.add_argument("--max-ratio", type=float, default=1.35,
                        help="flag above this (Japanese side is long); current default: 1.35")
    parser.add_argument("--include-field", action="store_true",
                        help="include field dialogue in diagnostics; it is never a lip-sync CHANGE decision")
    parser.add_argument("--all", action="store_true", help="print all eligible rows, not only flagged rows")
    parser.add_argument("--include-italic", action="store_true",
                        help="include italic subtitles (normally excluded as off-screen speech)")
    parser.add_argument("--version-source", choices=("latest", "used"), default="latest",
                        help="compare latest ready TTS text (default) or currently locked TTS text")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"),
                        help="PostgreSQL URL (defaults to DATABASE_URL)")
    args = parser.parse_args()
    if not args.database_url:
        parser.error("set DATABASE_URL or pass --database-url")

    query = """\
        SELECT l.id, l.stem, COALESCE(l.text_jp, ''), COALESCE(l.text_zh, ''),
               l.subtitle_italic, COALESCE(m.dialogue_mode, 'unknown'), m.dialogue_evidence,
               COALESCE(latest.tts_text, '') AS latest_tts_text,
               COALESCE(active.tts_text, '') AS active_tts_text,
               COALESCE(m.jp_speech_s, 0), COALESCE(m.cn_speech_s, 0),
               latest.speech_s, active.speech_s
        FROM lines l
        LEFT JOIN line_meta m ON m.stem = l.stem
        LEFT JOIN LATERAL (
          SELECT tts_text, speech_s FROM line_tts_versions
          WHERE stem = l.stem AND status = 'ready'
          ORDER BY id DESC LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
          SELECT tts_text, speech_s FROM line_tts_versions
          WHERE stem = l.stem AND status = 'ready' AND is_used IS TRUE
          ORDER BY id DESC LIMIT 1
        ) active ON true
    """
    params: tuple[object, ...]
    if args.stem:
        query += " WHERE l.stem = %s ORDER BY l.id"
        params = (args.stem,)
    elif args.prefix:
        query += " WHERE l.stem LIKE %s ORDER BY l.id"
        params = (args.prefix.replace("%", "\\%").replace("_", "\\_") + "%",)
    else:
        match = re.fullmatch(r"(\d+):(\d+)", args.id_range)
        if not match:
            parser.error("--id-range must be START:END")
        lo, hi = map(int, match.groups())
        if lo > hi:
            parser.error("--id-range START must be <= END")
        query += " WHERE l.id BETWEEN %s AND %s ORDER BY l.id"
        params = (lo, hi)

    tagger = Tagger()
    printed = 0
    total = 0
    short_skipped = 0
    italic_skipped = 0
    field_skipped = 0
    mode_skipped = 0
    mixed_no_camera_skipped = 0
    with psycopg.connect(args.database_url) as conn:
        rows = conn.execute(query, params).fetchall()
    for (line_id, stem, jp, source_zh, subtitle_italic, dialogue_mode, dialogue_evidence, latest_tts, active_tts,
         jp_speech, source_cn_speech, latest_tts_speech, active_tts_speech) in rows:
        if subtitle_italic and not args.include_italic:
            italic_skipped += 1
            continue
        field_line = dialogue_mode == "field"
        if field_line and not args.include_field:
            field_skipped += 1
            continue
        if dialogue_mode not in ("scene", "mixed", "field"):
            mode_skipped += 1
            continue
        if dialogue_mode == "mixed":
            shots = (dialogue_evidence or {}).get("shots", [])
            if not any(shot.get("cinematic_camera") is True for shot in shots):
                mixed_no_camera_skipped += 1
                continue
        total += 1
        jp = clean_text(jp)
        if japanese_characters(jp) <= 5:
            short_skipped += 1
            printed += 1
            print(f"SKIP_SHORT\t{stem}\tJP body characters <=5; no beat calculation")
            continue
        reading, jp_mora, second_reading, second_mora, unknown = japanese_reading(jp, tagger)
        tts_text = latest_tts if args.version_source == "latest" else active_tts
        zh = clean_text(tts_text or source_zh)
        tts_speech = latest_tts_speech if args.version_source == "latest" else active_tts_speech
        cn_speech = tts_speech if tts_speech is not None else source_cn_speech
        zh_syllables = chinese_syllables(zh)
        jp_punctuation = punctuation_estimate(jp)
        zh_punctuation = punctuation_estimate(zh)
        effective_jp = jp_mora + jp_punctuation
        effective_zh = zh_syllables + zh_punctuation
        ratio = effective_jp / effective_zh if effective_zh else float("inf")
        disagreement = abs(jp_mora - second_mora) > 0 or bool(unknown)
        text_ratio_flagged = ratio < args.min_ratio or ratio > args.max_ratio
        speech_ratio = jp_speech / cn_speech if cn_speech else float("inf")
        jp_rate = effective_jp / jp_speech if jp_speech else float("inf")
        cn_rate = effective_zh / cn_speech if cn_speech else float("inf")
        pace_ratio = jp_rate / cn_rate if cn_rate else float("inf")
        # Text unit ratio is the screening criterion. Audio duration and
        # units-per-second are diagnostics only; do not force equal total spans.
        ratio_mismatch = text_ratio_flagged
        if field_line:
            decision = "SKIP_FIELD"
        elif disagreement:
            decision = "REVIEW_READING"
        elif ratio_mismatch and args.version_source == "used" and active_tts_speech is not None:
            decision = "LOCKED_REVIEW"
        elif ratio_mismatch:
            decision = "CHANGE"
        else:
            decision = "KEEP"
        reasons = []
        if ratio_mismatch:
            reasons.append("JP/CN speech-unit ratio outside limits")
        if disagreement:
            reasons.append("Japanese reading uncertain")
        if field_line:
            reasons.append("field dialogue does not require lip-sync review")
        reason_text = "; ".join(reasons) or "text ratio within limits"
        if not (args.all or decision != "KEEP" or text_ratio_flagged):
            continue
        printed += 1
        print(f"{decision}\t{stem}\tJP={jp_mora} mora + {jp_punctuation:g} punctuation"
              f"\tCN={zh_syllables} Han + {zh_punctuation:g} punctuation"
              f"\ttext_ratio={ratio:.2f}"
              f"\tspeech_ratio(JP/CN)={speech_ratio:.2f}"
              f"\tJP_voice={jp_speech:.2f}s\tCN_voice={cn_speech:.2f}s"
              f"\tpace_ratio(JP/CN)={pace_ratio:.2f}"
              f"\ttext_ratio_outside={text_ratio_flagged}\treason={reason_text}")
        print(f"  JP reading: {reading}")
        if abs(jp_mora - second_mora) > 0:
            print(f"  cross-check differs: fugashi={second_mora} mora; reading={second_reading}")
        if unknown:
            print(f"  reading fallback (check manually): {', '.join(unknown)}")
        if tts_text:
            print(f"  CN source: {source_zh}")
            print(f"  CN {args.version_source} TTS: {tts_text}")
        if latest_tts and active_tts and latest_tts != active_tts:
            print(f"  CN locked TTS: {active_tts}")
        else:
            print(f"  CN source: {source_zh}")
    print(f"Rows: {total}; shown: {printed}; field lines skipped: {field_skipped}; "
          f"mixed without cinematic camera skipped: {mixed_no_camera_skipped}; "
          f"unknown-mode lines skipped: {mode_skipped}; italic off-screen lines skipped: {italic_skipped}; "
          f"short Japanese lines skipped: {short_skipped}; terminal punctuation excluded; "
          f"KEEP requires text ratio {args.min_ratio:.2f}–{args.max_ratio:.2f}; "
          f"speech duration and units-per-second ratios are diagnostic only; "
          f"voice durations use active-speech spans")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ImportError as exc:
        print(f"Missing dependency: {exc}. Install worker/requirements-mora.txt", file=sys.stderr)
        raise SystemExit(2)
