"""Shared deterministic beat estimates for the CLI and website (no LLM)."""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
import pyopenjtalk
from fugashi import Tagger
from mora_weights import weighted_mora

BEAT_VERSION = "beats-v5-short8-quotes-free"
# 「比」= (日文拍 ÷ 中文拍) / NORMAL_JP_CN_RATIO。
# 1.00 表示中文拍正好等于日文拍 / 下面这个常数。大于 1 中文偏短，小于 1 中文偏长。
# 界面和改写目标读归一后的「比」。ratio 是还没除的日文拍 ÷ 中文拍，不能当成「比」。
#
# 再改这个常数时按下面的口径重算，不要按单句听感改。网站 beats.ts 的同名常数必须一起改。
# 1. 样本只取主角（cast_members.role = 主角）里列表标成「确认」的原中文：
#    skip_timing，且没有 review_state='locked' 的就绪音频。锁定过的新 TTS 不进样本，那些稿子是对着旧常数改的。
# 2. 去掉日文正文 ≤5 字、没有中文、或两边读音拍数不一致的句子。只留场景演出、非斜体。
# 3. 按中文汉字数取最长的 30%（句数四舍五入；字数相同按 stem）。权重取这些句子
#    「日文拍 ÷ 中文拍」的中位数，不用平均数，也不要先按角色平均再取中位数。
# 2026-10-08 这一次：克劳德、巴雷特、赤红、爱丽丝、尤菲、蒂法共 185 句确认。
# 场景非斜体可算 97 句，最长 30% 是 29 句（12–30 字）。中位数 1.333，记为 1.33。
# 这 29 句在旧常数 1.20 下的「比」中位数是 1.11，四分位大约 1.02–1.41。
# 尤菲没有够长的已确认场景句，没进这 29 句。不限场景的最长 30%（46/154）中位数是 1.36，没有采用。
# 改完后男主角的「比」聚在 1 附近。女主角情绪起伏大，同一套常数下方差更大；不要因此再拆男女两个权重。
# 警告不跟这个常数缩放：归一后的「比」偏离 1 超过 10% 为警告、超过 15% 为异常。
# 这是旧档原始比例 1.05–1.35（中心曾是 1.20，半宽 12.5%）的偏差再乘 80% / 120%。
NORMAL_JP_CN_RATIO = 1.33
WARN_DEVIATION = 0.10
ERROR_DEVIATION = 0.15


def ratio_mark(ratio: float | None) -> str | None:
    if ratio is None:
        return None
    deviation = abs(ratio - 1)
    if deviation > ERROR_DEVIATION + 1e-9:
        return "err"
    if deviation > WARN_DEVIATION + 1e-9:
        return "warn"
    return "ok"

SMALL_KANA = set("ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮヵヶ")
READING_OVERRIDES = {
    # Readings specific to FF7 terminology / colloquial script that general
    # dictionaries can misanalyze. Replace longer entries first.
    "魔晄炉": "まこうろ",
    "魔晄": "まこう",
    "用済み": "ようずみ",
    "炭坑": "たんこう",
    "悲鳴": "ひめい",
}


def to_hiragana(text: str) -> str:
    return "".join(chr(ord(ch) - 0x60) if "ァ" <= ch <= "ヶ" else ch for ch in text)


def mora_count(reading: str) -> int:
    """Count morae: small kana join the preceding kana; っ/ん/ー count one."""
    count = 0
    for ch in to_hiragana(reading):
        if ch in SMALL_KANA:
            continue
        if "ぁ" <= ch <= "ゖ" or ch == "ー":
            count += 1
    return count


def japanese_reading(text: str, tagger: Tagger) -> tuple[str, int, str, int, list[str]]:
    readings: list[str] = []
    unknown: list[str] = []
    for token in tagger(text):
        surface = token.surface
        feature = token.feature
        reading = getattr(feature, "kana", None)
        if not reading or reading == "*":
            # UniDic can omit readings for punctuation/numbers. Kana surfaces
            # remain countable; kanji fallbacks are marked as uncertain.
            reading = surface
            if any("CJK" in unicodedata.name(c, "") for c in surface):
                unknown.append(surface)
        readings.append(reading)
    fugashi_kana = "".join(readings)
    corrected_text = text
    for surface, reading in READING_OVERRIDES.items():
        corrected_text = corrected_text.replace(surface, reading)
    openjtalk_kana = pyopenjtalk.g2p(corrected_text, kana=True)
    return (
        to_hiragana(openjtalk_kana),
        mora_count(openjtalk_kana),
        to_hiragana(fugashi_kana),
        mora_count(fugashi_kana),
        unknown,
    )


def chinese_syllables(text: str) -> int:
    # Mandarin characters in these subtitles are overwhelmingly Han; Japanese
    # kana and punctuation do not appear in the Chinese translation field.
    return sum(1 for ch in text if "CJK" in unicodedata.name(ch, ""))


def clean_text(text: str) -> str:
    # TTS controls are not spoken characters; subtitle wrapping isn't a pause.
    return re.sub(r"\[停顿=\d{1,4}\]", "", text).replace("\\n", " ").strip()


# Name separators are punctuation, but they are not spoken pauses.
NAME_SEPARATORS = frozenset("・·･‧")
# 引号表示引用/强调，不代表 IndexTTS 停顿；中日英引号两侧均不计拍。
QUOTATION_MARKS = frozenset("「」『』｢｣“”‘’\"'＂＇〝〞〟")


def is_punctuation(ch: str) -> bool:
    return unicodedata.category(ch).startswith("P") or ch in "~～"


def is_pause(ch: str) -> bool:
    return is_punctuation(ch) and ch not in NAME_SEPARATORS and ch not in QUOTATION_MARKS


def japanese_characters(text: str) -> int:
    # 少于8个日文正文字符时豁免比；不是摩拉数，标点和空白不计字数。
    # Punctuation cannot make a
    # short interjection eligible. Long-vowel kana ー remains a body character.
    return sum(not ch.isspace() and not is_punctuation(ch) for ch in clean_text(text))


def punctuation_estimate(text: str) -> float:
    text = clean_text(text)
    # Only the utterance end is free. A subtitle line break is not an ending.
    while text and (text[-1].isspace() or is_punctuation(text[-1])):
        text = text[:-1]
    return sum(is_pause(ch) for ch in text) * 1.5




@lru_cache(maxsize=8192)
def japanese_metrics(text: str) -> dict:
    text = clean_text(text)
    chars = japanese_characters(text)
    if chars < 8:
        return {"status": "short" if chars else "missing", "characters": chars,
                "mora": None, "weightedMora": None, "weightStatus": "uncalibrated",
                "punctuation": None, "units": None,
                "reading": "", "alternateReading": "", "alternateMora": None, "unknown": []}
    reading, mora, alternate, alternate_mora, unknown = japanese_reading(text, get_tagger())
    pauses = punctuation_estimate(text)
    return {"status": "review_reading" if mora != alternate_mora or unknown else "ok",
            "characters": chars, "mora": mora,
            "weightedMora": weighted_mora(reading), "weightStatus": "uncalibrated",
            "punctuation": pauses, "units": mora + pauses,
            "reading": reading, "alternateReading": alternate, "alternateMora": alternate_mora,
            "unknown": unknown}


@lru_cache(maxsize=8192)
def japanese_speech_reading(text: str) -> dict:
    """自动流程测语速专用：短句也要纯摩拉数，但不改变短句“不算比”的通用规则。

    独立返回读音可信度，不能把未知读音当作慢速。此结果不含标点停顿拍，
    也不回填 line_meta 的字幕拍数缓存；只有显式请求才额外计算。
    """
    metrics = japanese_metrics(text)
    if metrics["status"] != "short":
        return {key: metrics[key] for key in ("status", "mora", "reading")}
    reading, mora, alternate, alternate_mora, unknown = japanese_reading(clean_text(text), get_tagger())
    return {"status": "review_reading" if mora != alternate_mora or unknown else "ok",
            "mora": mora, "reading": reading}


@lru_cache(maxsize=1)
def get_tagger() -> Tagger:
    return Tagger()


def analyze_pair(jp: str, cn: str) -> dict:
    jp_metrics = japanese_metrics(jp)
    cn = clean_text(cn)
    han = chinese_syllables(cn)
    pauses = punctuation_estimate(cn)
    units = han + pauses
    ratio = jp_metrics["units"] / units if jp_metrics["units"] is not None and units else None
    normalized = ratio / NORMAL_JP_CN_RATIO if ratio is not None else None
    return {"version": BEAT_VERSION,
            "jp": jp_metrics, "cn": {"han": han, "punctuation": pauses, "units": units},
            "ratio": ratio, "normalizedRatio": normalized,
            "mark": ratio_mark(normalized) if jp_metrics["status"] == "ok" else None,
            "outside": ratio is not None and not 1.05 <= ratio <= 1.35}
