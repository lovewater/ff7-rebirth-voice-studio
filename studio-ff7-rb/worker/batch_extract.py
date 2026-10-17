#!/usr/bin/env python3
"""Extract every CN-pack line (CN + JP) to 320k MP3. Skips files that already exist."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import traceback
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cn_iostore import extract_chunk_ids, extract_container  # noqa: E402
from uasset_to_mp3 import uasset_to_mp3  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CN_MODS = ROOT / "game" / "sound-part" / "End" / "Content" / "Paks" / "~mods"
GAME_PAKS = ROOT / "game" / "FINAL FANTASY VII REBIRTH" / "End" / "Content" / "Paks"
DATA = ROOT / "studio-ff7-rb" / "website" / "data"
CATALOG = ROOT / "work" / "cn-catalog.jsonl"
INDEX = ROOT / "work" / "jp-voice-index.jsonl"
EN_INDEX = ROOT / "work" / "en-voice-index.jsonl"
LOG = ROOT / "work" / "batch-extract.log"
WORKERS = max(2, min(6, os.cpu_count() or 4))
JP_BATCH = 200

PACKS = [
    "zzz_cn_voice_g_P",
    "zzz_cn_voice_f_P",
    "zzz_cn_voice_a_P",
    "zzz_cn_voice_b_P",
    "zzz_cn_voice_e_P",
    "zzz_cn_voice_c_P",
    "zzz_cn_voice_d_P",
    "zzz_cn_voice_vo_P",
    "zzz_cn_voice_vo_full_P",
]


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg.rstrip()}"
    print(line, flush=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def convert_job(payload: tuple[bytes, str, str]) -> tuple[str, bool, str]:
    data, stem, kind = payload
    dest = DATA / kind / f"{stem}.mp3"
    if dest.exists() and dest.stat().st_size > 0:
        return stem, True, "cached"
    tmp = Path(tempfile.mkdtemp(prefix="ff7ex-"))
    try:
        uasset = tmp / f"{stem}.uasset"
        uasset.write_bytes(data)
        ok = uasset_to_mp3(uasset, dest)
        return stem, ok, "ok" if ok else "audiomog/ffmpeg failed"
    except Exception as e:
        return stem, False, f"{type(e).__name__}: {e}"
    finally:
        shutil_rm(tmp)


def shutil_rm(p: Path) -> None:
    import shutil

    shutil.rmtree(p, ignore_errors=True)


def batch_cn() -> None:
    DATA.joinpath("cn").mkdir(parents=True, exist_ok=True)
    for pack in PACKS:
        utoc = CN_MODS / f"{pack}.utoc"
        if not utoc.exists():
            log(f"SKIP missing {utoc}")
            continue
        log(f"=== CN {pack} decompress ===")
        chunks, names = extract_container(utoc)
        assets = [c for c in chunks if c.chunk_type == 2]
        jobs = []
        for i, ch in enumerate(assets):
            name = names[i] if i < len(names) else f"{ch.chunk_id.hex()[:16]}.uasset"
            stem = name[: -len(".uasset")] if name.endswith(".uasset") else name
            dest = DATA / "cn" / f"{stem}.mp3"
            if dest.exists() and dest.stat().st_size > 0:
                continue
            if not ch.data:
                log(f"empty {stem}")
                continue
            jobs.append((ch.data, stem, "cn"))
        log(f"{pack}: {len(assets)} assets, {len(jobs)} to encode")
        if not jobs:
            continue
        ok = fail = 0
        with ProcessPoolExecutor(max_workers=WORKERS) as ex:
            futs = [ex.submit(convert_job, j) for j in jobs]
            for n, fut in enumerate(as_completed(futs), 1):
                stem, success, why = fut.result()
                if success:
                    ok += 1
                else:
                    fail += 1
                    log(f"FAIL cn {stem}: {why}")
                if n % 100 == 0 or n == len(jobs):
                    log(f"  {pack} {n}/{len(jobs)} ok={ok} fail={fail}")
        # free RAM from decompressed pack
        del chunks, assets, jobs


def _encode_batch(jobs: list[tuple[bytes, str, str]], label: str) -> tuple[int, int]:
    if not jobs:
        return 0, 0
    ok = fail = 0
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(convert_job, j) for j in jobs]
        for n, fut in enumerate(as_completed(futs), 1):
            stem, success, why = fut.result()
            if success:
                ok += 1
            else:
                fail += 1
                log(f"FAIL {label} {stem}: {why}")
            if n % 100 == 0 or n == len(jobs):
                log(f"  {label} encode {n}/{len(jobs)} ok={ok} fail={fail}")
    return ok, fail


def _batch_lang(kind: str, index_path: Path) -> None:
    DATA.joinpath(kind).mkdir(parents=True, exist_ok=True)
    index = {}
    with index_path.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            index[row["stem"]] = (row["chunk_id"], row.get("container"))
    by_container: dict[str, list[tuple[str, str]]] = defaultdict(list)
    with CATALOG.open(encoding="utf-8") as fh:
        for line in fh:
            stem = json.loads(line)["stem"]
            dest = DATA / kind / f"{stem}.mp3"
            if dest.exists() and dest.stat().st_size > 0:
                continue
            hit = index.get(stem)
            if not hit:
                log(f"no {kind} chunk {stem}")
                continue
            cid, container = hit
            by_container[container or ""].append((stem, cid))
    total = sum(len(v) for v in by_container.values())
    log(f"=== {kind.upper()} {total} to extract in batches of {JP_BATCH} ===")
    done = fail_n = 0
    for container, items in sorted(by_container.items(), key=lambda kv: -len(kv[1])):
        utoc = GAME_PAKS / f"{container}.utoc"
        if not utoc.exists():
            log(f"SKIP missing {utoc}")
            fail_n += len(items)
            continue
        log(f"=== {kind.upper()} {container} {len(items)} remaining ===")
        for i in range(0, len(items), JP_BATCH):
            batch = items[i : i + JP_BATCH]
            wanted = {bytes.fromhex(cid): stem for stem, cid in batch}
            t0 = time.perf_counter()
            blobs = extract_chunk_ids(utoc, wanted)
            log(
                f"  read {len(blobs)}/{len(batch)} in {time.perf_counter()-t0:.2f}s "
                f"({i + 1}-{i + len(batch)}/{len(items)})"
            )
            jobs = [(blobs[stem], stem, kind) for stem, _cid in batch if stem in blobs]
            for stem, _cid in batch:
                if stem not in blobs:
                    fail_n += 1
                    log(f"FAIL {kind} {stem}: not in {container}")
            ok, fail = _encode_batch(jobs, f"{kind} {container}")
            done += ok
            fail_n += fail
            log(f"  {kind} running ok={done} fail={fail_n} left~{total - done - fail_n}")


def batch_jp() -> None:
    _batch_lang("jp", INDEX)


def batch_en() -> None:
    _batch_lang("en", EN_INDEX)


def main() -> int:
    log(f"batch start workers={WORKERS}")
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "cn"):
        batch_cn()
    if which in ("all", "jp"):
        batch_jp()
    if which in ("all", "en"):
        batch_en()
    cn_n = len(list((DATA / "cn").glob("*.mp3"))) if (DATA / "cn").exists() else 0
    jp_n = len(list((DATA / "jp").glob("*.mp3"))) if (DATA / "jp").exists() else 0
    en_n = len(list((DATA / "en").glob("*.mp3"))) if (DATA / "en").exists() else 0
    log(f"done cn_mp3={cn_n} jp_mp3={jp_n} en_mp3={en_n}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc()
        raise
