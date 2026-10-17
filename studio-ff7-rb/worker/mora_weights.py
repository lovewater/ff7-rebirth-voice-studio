"""Experimental mora duration weights; no audio, model calls, or production activation."""
from __future__ import annotations

import math
from collections import defaultdict
from statistics import median

SMALL = frozenset("ぁぃぅぇぉゃゅょゎゕゖ")


def tokenize(reading: str) -> list[str]:
    """Kana reading -> mora tokens. Punctuation breaks attachment, not timing.

    Spelled vowel sequences remain separate morae: do not guess whether おう
    is a long vowel across word boundaries. ー, っ, ん retain separate keys.
    """
    tokens = []
    attach = False
    for raw in reading:
        ch = chr(ord(raw) - 0x60) if "ァ" <= raw <= "ヶ" else raw
        if ch in SMALL:
            if attach:
                tokens[-1] += ch
            continue
        if "ぁ" <= ch <= "ゖ" or ch == "ー":
            tokens.append(ch)
            attach = ch not in "ーっん"
        else:
            attach = False
    return tokens


def weighted_mora(reading: str, weights: dict[str, float] | None = None) -> float:
    weights = weights or {}
    for key, value in weights.items():
        if tokenize(key) != [key] or not math.isfinite(value) or not 0.85 <= value <= 1.15:
            raise ValueError(f"invalid mora weight: {key!r}")
    return sum(weights.get(token, 1.0) for token in tokenize(reading))


def calibrate(rows: list[dict], minimum: int = 30) -> dict:
    """Fit only training rows; evaluate relative segment durations on held-out scenes.

    Input row: {stem, scene, split: train|test, segments: [{kana, duration_s}]}.
    Segments must be manually checked mora boundaries without silence; phrase-final
    and strongly expressive segments should be excluded upstream. Within-utterance
    medians remove much of the speaker/rate scale. This is a candidate, never an
    automatically approved production model.
    """
    if minimum < 1:
        raise ValueError("minimum must be positive")
    seen, scenes, samples, prepared = set(), {}, defaultdict(list), []
    for row in rows:
        stem, scene, split = row["stem"], row["scene"], row["split"]
        if not stem or not scene or stem in seen or split not in ("train", "test"):
            raise ValueError("invalid/duplicate stem or split")
        seen.add(stem)
        if scene in scenes and scenes[scene] != split:
            raise ValueError("same scene in train and test")
        scenes[scene] = split
        segments = row["segments"]
        if len(segments) < 5:
            raise ValueError("need at least five usable morae per utterance")
        for segment in segments:
            kana, duration = segment["kana"], segment["duration_s"]
            if tokenize(kana) != [kana] or not math.isfinite(duration) or duration <= 0:
                raise ValueError("invalid aligned segment")
        scale = median(s["duration_s"] for s in segments)
        values = [(s["kana"], s["duration_s"] / scale) for s in segments]
        prepared.append((split, values))
        if split == "train":
            for kana, relative in values:
                samples[kana].append(relative)
    if set(scenes.values()) != {"train", "test"}:
        raise ValueError("independent train and test scenes required")
    # Shrink toward one and cap corrections: small datasets must not dominate.
    weights = {k: round(max(.85, min(1.15, 1 + (median(v)-1)*len(v)/(len(v)+minimum))), 6)
               for k, v in samples.items() if len(v) >= minimum}
    baseline, candidate = [], []
    for split, values in prepared:
        if split == "test":
            baseline.append(sum(abs(v-1) for k, v in values)/len(values))
            candidate.append(sum(abs(v-weights.get(k, 1)) for k, v in values)/len(values))
    old, new = sum(baseline)/len(baseline), sum(candidate)/len(candidate)
    return {"schema": 1, "status": "experimental", "weights": weights,
            "counts": {k: len(v) for k, v in sorted(samples.items())},
            "validation": {"metric": "utterance_mean_relative_segment_mae",
                           "testUtterances": len(baseline), "baseline": old, "weighted": new,
                           "improvement": (old-new)/old if old else 0},
            "productionApproved": False}


if __name__ == "__main__":
    import argparse
    import json
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="JSON array of checked aligned morae")
    parser.add_argument("output", type=Path, help="experimental weight report (must not exist)")
    parser.add_argument("--minimum", type=int, default=30)
    args = parser.parse_args()
    result = calibrate(json.loads(args.input.read_text()), args.minimum)
    with args.output.open("x") as out:
        json.dump(result, out, ensure_ascii=False, indent=2, allow_nan=False)
        out.write("\n")
