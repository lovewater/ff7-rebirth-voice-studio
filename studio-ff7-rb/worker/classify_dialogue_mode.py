#!/usr/bin/env python3
"""Classify dialogue using the game's event sound and scene assets.

JP PlannerEventSound assets name the voice stems they play. Dialogue/Game
events can mix camera shots and ordinary conversations, so inspect the Shot
asset containing each stem for a cinematic camera. Voices under
Sound/Voice/JP/Cut are staged directly. Reused stems may be marked mixed.
"""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from pathlib import Path

import psycopg

from cn_iostore import extract_chunk_ids, parse_utoc
from build_mod import parse_dir_index

ROOT = Path(__file__).resolve().parents[2]
PAKS = ROOT / "game/FINAL FANTASY VII REBIRTH/End/Content/Paks"
EVIDENCE = ROOT / "work/dialogue-resource-evidence.jsonl"
DSN = os.environ.get("DATABASE_URL", "")
STEM_RE = re.compile(rb"(?:[A-Z0-9]+_)+(?:[0-9]{2,4}_){2,5}[a-zA-Z0-9]+")
EVENT_RE = re.compile(r"PlannerEventSound_(.+)_JP\.uasset$")


def inventory():
    sound_assets: dict[Path, list[tuple[bytes, str]]] = defaultdict(list)
    shot_assets: dict[Path, list[tuple[bytes, str]]] = defaultdict(list)
    staged_sequences: set[str] = set()
    cut_sequences: set[str] = set()
    for utoc in sorted(PAKS.glob("*.utoc")):
        chunks, _blocks, directory = parse_utoc(utoc.read_bytes())
        if not directory:  # global.utoc has no directory index
            continue
        mount, entries = parse_dir_index(directory)
        for rel, user in entries:
            path = mount + rel
            if "/Dialogue/Game/" in path and path.endswith("_Root.uasset"):
                staged_sequences.add(Path(path).name.removesuffix("_Root.uasset"))
            elif "/Cut/Game/" in path and path.endswith("_Voice.uasset"):
                cut_sequences.add(Path(path).name.removesuffix("_Voice.uasset"))
            elif "/PlannerEventSound/JP/" in path and path.endswith("_JP.uasset"):
                sound_assets[utoc].append((chunks[user][0], path))
            elif "/Dialogue/Game/" in path and "/Shot/" in path and path.endswith(".uasset"):
                shot_assets[utoc].append((chunks[user][0], path))
    return sound_assets, shot_assets, staged_sequences, cut_sequences


def event_name(path: str) -> str | None:
    found = EVENT_RE.search(path)
    if not found:
        return None
    # _2 is an asset variant, while the preceding four digits identify the event.
    return re.sub(r"(_[0-9]{4})_[0-9]+$", r"\1", found.group(1))


def classify(path: str | None, events: list[dict], shots: list[dict]) -> str:
    if path and "/Sound/Voice/JP/Cut/" in path:
        return "scene"
    if shots:
        cinematic = [shot["cinematic_camera"] for shot in shots]
        if all(cinematic):
            return "scene"
        if any(cinematic):
            return "mixed"
        return "field"
    if not events:
        return "unknown"
    staged = [event["staged"] for event in events]
    if all(staged):
        return "scene"
    if any(staged):
        return "mixed"
    return "field"


def main() -> None:
    with psycopg.connect(DSN) as conn:
        lines = conn.execute("SELECT stem, kind, asset_path FROM lines").fetchall()
    dialogue = {stem: path for stem, kind, path in lines if kind == "对话"}
    sounds, shot_assets, sequences, cuts = inventory()
    events: dict[str, list[dict]] = defaultdict(list)
    for utoc, assets in sounds.items():
        for start in range(0, len(assets), 128):
            batch = assets[start:start + 128]
            data = extract_chunk_ids(utoc, dict(batch), strict=True)
            for asset, payload in data.items():
                event = event_name(asset)
                if not event:
                    continue
                staged = event in sequences or event.replace("PV_", "EV_", 1) in cuts
                for stem in {match.group().decode("ascii") for match in STEM_RE.finditer(payload)}:
                    if stem in dialogue:
                        events[stem].append({"event": event, "staged": staged, "asset": asset})

    shots: dict[str, list[dict]] = defaultdict(list)
    for utoc, assets in shot_assets.items():
        for start in range(0, len(assets), 128):
            data = extract_chunk_ids(utoc, dict(assets[start:start + 128]), strict=True)
            for asset, payload in data.items():
                cinematic_camera = b"CineCameraActor" in payload or b"MovieSceneCameraCutTrack" in payload
                for stem in {match.group().decode("ascii") for match in STEM_RE.finditer(payload)}:
                    if stem in dialogue:
                        shots[stem].append({"asset": asset, "cinematic_camera": cinematic_camera})

    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    updates = []
    with EVIDENCE.open("w", encoding="utf-8") as out:
        for stem, path in sorted(dialogue.items()):
            sources = events.get(stem, [])
            shot_sources = shots.get(stem, [])
            mode = classify(path, sources, shot_sources)
            evidence = {"voice_asset": path, "events": sources, "shots": shot_sources}
            out.write(json.dumps({"stem": stem, "mode": mode, **evidence}, ensure_ascii=False) + "\n")
            updates.append((mode, json.dumps(evidence, ensure_ascii=False), stem))

    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO line_meta (stem, dialogue_mode, dialogue_evidence)
                   VALUES (%s, %s, %s::jsonb)
                   ON CONFLICT (stem) DO UPDATE SET
                     dialogue_mode = EXCLUDED.dialogue_mode,
                     dialogue_evidence = EXCLUDED.dialogue_evidence,
                     updated_at = now()""",
                [(stem, mode, evidence) for mode, evidence, stem in updates],
            )
        conn.commit()
    counts = {mode: sum(1 for item in updates if item[0] == mode)
              for mode in ("scene", "field", "mixed", "unknown")}
    print(json.dumps({"dialogue": len(updates), **counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
