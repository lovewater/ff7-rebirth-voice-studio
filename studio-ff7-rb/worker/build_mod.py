#!/usr/bin/env python3
"""Build an FF7 Rebirth voice/subtitle overlay and rsync it to the backup share.

Voice edits are written back into the zzz_cn_voice_* packs the game already
plays. A second pak does not win those chunk ids: ~mods share one priority and
the first mounted copy is kept, so both aa_ and zzzz_ were ignored.
Subtitle edits are a separate aa_cn_voice_edit_P because those chunk ids are
not in the voice packs.

Locked lines (line_tts_versions.is_used) are repacked from the locked audio.
Every other line in the selected chapters keeps the source-Chinese uasset.
Subtitle edits on a locked line are written into the official CN TxtRes that
contains that stem; the rest of that TxtRes is left unchanged.

Lines the original Chinese pack never contained (movie banks and any other
locked jp-only asset) are written into zzz_cn_voice_add_P. That pak uses the
game's own chunk ids, which are not in the zzz packs, so it overrides the
Japanese files the same way the subtitle pak overrides TxtRes. A shared bank
keeps every channel except the sliced voice channel.
"""

from __future__ import annotations

import argparse
import array
import ctypes
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cn_iostore import extract_chunk_ids, parse_utoc  # noqa: E402
from extract_txtres import clean_text, find_lang, parse_txtres  # noqa: E402
from fill_regions import SEED, STORY_ORDER  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CN_MODS = ROOT / "work" / "ref-cn-voice" / "End" / "Content" / "Paks" / "~mods"
DATA = ROOT / "studio-ff7-rb" / "website" / "data"
TXTRES_RAW = ROOT / "work" / "txtres-raw" / "CN"
TXTRES_INDEX = ROOT / "work" / "txtres-index.jsonl"
AUDIOMOG = ROOT / "programs" / "bin" / "audiomog" / "AudioMog.dll"
BUILD_ROOT = ROOT / "work" / "mod-build"
SMB_ROOT = Path(os.environ.get("MOD_BACKUP_DIR", str(ROOT / "out" / "mod-backups")))
DSN = os.environ.get("DATABASE_URL", "")
MOD_STEM = "aa_cn_voice_edit_P"
ADD_PACK = "zzz_cn_voice_add_P"
GAME_PAKS = ROOT / "game" / "FINAL FANTASY VII REBIRTH" / "End" / "Content" / "Paks"
MOUNT = "../../../"
# A replacement may run slightly past its subtitle window. Past this, it would
# cover the next line or fall off the bank.
SLICE_OVERRUN_S = 0.08
NONE = 0xFFFFFFFF
BLOCK = 65536
HEADER_BYTES = 144

CHAPTER_RE = re.compile(r"第(\d+)章")


def chapter_map() -> tuple[dict[int, list[str]], list[str]]:
    """Numbered story chapters, plus field regions that sit before the next chapter.

    Regions after the last 第N章 marker (minigames, battle banks, world intel)
    are not part of that chapter.
    """
    names = {code: (SEED.get(code, (None,))[0] or "") for code in STORY_ORDER}
    numbered_at = [i for i, code in enumerate(STORY_ORDER) if CHAPTER_RE.search(names[code])]
    last_numbered = numbered_at[-1] if numbered_at else -1
    groups: dict[int, list[str]] = {}
    extra: list[str] = []
    current: int | None = None
    for i, code in enumerate(STORY_ORDER):
        match = CHAPTER_RE.search(names[code])
        if match:
            current = int(match.group(1))
            groups.setdefault(current, []).append(code)
        elif current is not None and i < last_numbered:
            groups.setdefault(current, []).append(code)
        else:
            extra.append(code)
    return groups, extra


def fstring(text: str) -> bytes:
    raw = text.encode("ascii") + b"\x00"
    return struct.pack("<I", len(raw)) + raw


def read_fstring(data: bytes, i: int) -> tuple[str, str, int, int]:
    start = i
    (ln,) = struct.unpack_from("<i", data, i)
    if ln > 0:
        end = i + 4 + ln
        text = data[i + 4 : end - 1].decode("utf-8")
        return text, "utf-8", start, end
    if ln < 0:
        n = -ln
        end = i + 4 + n * 2
        text = data[i + 4 : end - 2].decode("utf-16le")
        return text, "utf-16", start, end
    return "", "utf-8", start, i + 4


def write_fstring(text: str, enc: str) -> bytes:
    if enc == "utf-16":
        raw = text.encode("utf-16le") + b"\x00\x00"
        return struct.pack("<i", -(len(raw) // 2)) + raw
    raw = text.encode("utf-8") + b"\x00"
    return struct.pack("<i", len(raw)) + raw


def parse_dir_index(blob: bytes) -> tuple[str, list[tuple[str, int]]]:
    mount, _enc, _s, i = read_fstring(blob, 0)
    (ndir,) = struct.unpack_from("<I", blob, i)
    i += 4
    dirs = []
    for _ in range(ndir):
        dirs.append(struct.unpack_from("<IIII", blob, i))
        i += 16
    (nfile,) = struct.unpack_from("<I", blob, i)
    i += 4
    files = []
    for _ in range(nfile):
        files.append(struct.unpack_from("<III", blob, i))
        i += 12
    (nstr,) = struct.unpack_from("<I", blob, i)
    i += 4
    strings = []
    for _ in range(nstr):
        text, _enc, _s, i = read_fstring(blob, i)
        strings.append(text)
    found: list[tuple[str, int]] = []

    def walk(didx: int, prefix: list[str]) -> None:
        _name, child, _sib, file0 = dirs[didx]
        f = file0
        while f != NONE:
            name_i, nxt, user = files[f]
            found.append(("/".join(prefix + [strings[name_i]]), user))
            f = nxt
        c = child
        while c != NONE:
            name_i = dirs[c][0]
            walk(c, prefix + [strings[name_i]])
            c = dirs[c][2]

    walk(0, [])
    return mount, found


def iter_pack_assets(utoc: Path) -> dict[str, tuple[bytes, str]]:
    toc = utoc.read_bytes()
    chunks, _blocks, directory = parse_utoc(toc)
    _mount, entries = parse_dir_index(directory)
    out: dict[str, tuple[bytes, str]] = {}
    for rel, user in entries:
        if user >= len(chunks):
            raise RuntimeError(f"{utoc.name} directory user {user} past chunk count")
        cid, _off, length = chunks[user]
        if cid[11] != 2 or length <= 0:
            continue
        stem = Path(rel).name
        if stem.endswith(".uasset"):
            stem = stem[: -len(".uasset")]
        out[stem] = (cid, rel)
    return out


class DirWriter:
    def __init__(self) -> None:
        self.dirs = [[NONE, NONE, NONE, NONE]]
        self.files: list[list[int]] = []
        self.str_index: dict[str, int] = {}
        self.strings: list[str] = []

    def _str(self, text: str) -> int:
        if text not in self.str_index:
            self.str_index[text] = len(self.strings)
            self.strings.append(text)
        return self.str_index[text]

    def add(self, rel: str, user: int) -> None:
        parts = [p for p in rel.split("/") if p]
        self._add(0, parts, user)

    def _add(self, didx: int, parts: list[str], user: int) -> None:
        if len(parts) == 1:
            name = self._str(parts[0])
            new_i = len(self.files)
            self.files.append([name, NONE, user])
            if self.dirs[didx][3] == NONE:
                self.dirs[didx][3] = new_i
            else:
                f = self.dirs[didx][3]
                while self.files[f][1] != NONE:
                    f = self.files[f][1]
                self.files[f][1] = new_i
            return
        want = self._str(parts[0])
        child = self.dirs[didx][1]
        last = None
        while child != NONE and self.dirs[child][0] != want:
            last = child
            child = self.dirs[child][2]
        if child == NONE:
            child = len(self.dirs)
            self.dirs.append([want, NONE, NONE, NONE])
            if last is None:
                self.dirs[didx][1] = child
            else:
                self.dirs[last][2] = child
        self._add(child, parts[1:], user)

    def to_bytes(self) -> bytes:
        out = bytearray()
        out += fstring(MOUNT)
        out += struct.pack("<I", len(self.dirs))
        for name, child, sib, file0 in self.dirs:
            out += struct.pack("<IIII", name, child, sib, file0)
        out += struct.pack("<I", len(self.files))
        for name, nxt, user in self.files:
            out += struct.pack("<III", name, nxt, user)
        out += struct.pack("<I", len(self.strings))
        for text in self.strings:
            out += fstring(text)
        return bytes(out)


def be5(n: int) -> bytes:
    return n.to_bytes(5, "big")


def le5(n: int) -> bytes:
    return n.to_bytes(5, "little")


def container_header(container_id: bytes) -> bytes:
    """Empty UE4.26 IoContainerHeader (version Initial).

    Layout the game actually parses: container id, a discarded package count,
    empty name batches, empty store entries, empty culture map, empty redirects.
    Use the minimal valid layout; source packs also carry an 8-byte name hash seed.
    """
    if len(container_id) != 8:
        raise ValueError("container id must be 8 bytes")
    return container_id + struct.pack("<7I", 0, 0, 0, 0, 0, 0, 0)


_oodle_compress = None


def oodle_compress(data: bytes) -> bytes | None:
    """Kraken when it shrinks. None means the caller stores the block raw."""
    global _oodle_compress
    if _oodle_compress is None:
        lib = ctypes.CDLL(str(ROOT / "programs" / "bin" / "liboo2corelinux64.so.9"))
        fn = lib.OodleLZ_Compress
        fn.restype = ctypes.c_ssize_t
        fn.argtypes = [
            ctypes.c_int, ctypes.c_void_p, ctypes.c_ssize_t, ctypes.c_void_p, ctypes.c_int,
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t,
        ]
        _oodle_compress = fn
    out = ctypes.create_string_buffer(len(data) + 65536)
    n = _oodle_compress(8, data, len(data), out, 4, None, None, None, None, 0)
    if n <= 0 or n >= len(data):
        return None
    return out.raw[:n]


def _append_block(cas: bytearray, blocks: bytearray, stored: bytes, usize: int, method: int) -> None:
    pad = (16 - (len(stored) % 16)) % 16
    off = len(cas)
    cas += stored + (b"\x00" * pad)
    blocks += le5(off)
    blocks += len(stored).to_bytes(3, "little")
    blocks += usize.to_bytes(3, "little")
    blocks += bytes([method])


def _compress_payload(cas: bytearray, blocks: bytearray, payload: bytes) -> bool:
    """Write payload as Oodle blocks. Returns whether any block was compressed."""
    oodle = False
    pos = 0
    while pos < len(payload):
        piece = payload[pos : pos + BLOCK]
        comp = oodle_compress(piece)
        if comp is None:
            _append_block(cas, blocks, piece, len(piece), 0)
        else:
            _append_block(cas, blocks, comp, len(piece), 1)
            oodle = True
        pos += len(piece)
    return oodle


def patch_voice_pack(src_utoc: Path, replacements: dict[bytes, bytes], dest_utoc: Path) -> int:
    """Rewrite one zzz pack. Unchanged chunks keep their original compressed bytes.

    The container header block is copied verbatim. A second pak cannot override
    these chunk ids, so the edited audio has to live in the pack the game loads.
    """
    toc = src_utoc.read_bytes()
    cas = src_utoc.with_suffix(".ucas").read_bytes()
    chunks, blocks, directory = parse_utoc(toc)
    hs = struct.unpack_from("<I", toc, 20)[0]
    if struct.unpack_from("<I", toc, 44)[0] != BLOCK or any(off % BLOCK for _cid, off, _size in chunks):
        raise RuntimeError("source pack does not use independent aligned 64KB chunks")
    if not set(replacements).issubset({cid for cid, _off, _size in chunks}):
        raise RuntimeError("replacement chunk missing from source pack")
    n = len(chunks)
    nb = len(blocks)
    mc = struct.unpack_from("<I", toc, 36)[0]
    ml = struct.unpack_from("<I", toc, 40)[0]
    dsz = len(directory)
    off = hs + n * 12 + n * 10 + nb * 12
    methods = toc[off : off + mc * ml]
    meta_off = off + mc * ml + dsz
    metas = toc[meta_off : meta_off + n * 33]
    if len(metas) != n * 33:
        raise RuntimeError(f"{src_utoc.name} meta table is {len(metas)} bytes, expected {n * 33}")

    new_cas = bytearray()
    new_blocks = bytearray()
    new_offlen = bytearray()
    new_metas = bytearray()
    logical = 0
    replaced = 0
    for index, (cid, src_off, length) in enumerate(chunks):
        logical = (logical + BLOCK - 1) // BLOCK * BLOCK
        payload = replacements.get(cid)
        if payload is None:
            new_offlen += be5(logical) + be5(length)
            if length > 0:
                start = src_off // BLOCK
                end = (src_off + length - 1) // BLOCK
                for block_off, csize, usize, method in blocks[start : end + 1]:
                    _append_block(new_cas, new_blocks, cas[block_off : block_off + csize], usize, method)
            new_metas += metas[index * 33 : (index + 1) * 33]
            logical += length
            continue
        replaced += 1
        new_offlen += be5(logical) + be5(len(payload))
        compressed = _compress_payload(new_cas, new_blocks, payload)
        new_metas += hashlib.sha1(payload).digest() + (b"\x00" * 12) + bytes([1 if compressed else 0])
        logical += len(payload)

    nblocks = len(new_blocks) // 12
    header = bytearray(toc[:hs])
    struct.pack_into("<I", header, 28, nblocks)
    ids = b"".join(cid for cid, _off, _length in chunks)
    out = bytes(header) + ids + bytes(new_offlen) + bytes(new_blocks) + methods + directory + bytes(new_metas)
    dest_utoc.parent.mkdir(parents=True, exist_ok=True)
    dest_utoc.write_bytes(out)
    dest_utoc.with_suffix(".ucas").write_bytes(bytes(new_cas))
    shutil.copyfile(src_utoc.with_suffix(".pak"), dest_utoc.with_suffix(".pak"))
    return replaced


def write_container(chunks: list[tuple[bytes, bytes, str | None]], utoc_path: Path) -> None:
    """chunks: (chunk_id, payload, relative_path or None for the header)."""
    if not chunks or chunks[0][0][11] != 10:
        raise RuntimeError("first chunk must be the container header")
    directory = DirWriter()
    for i, (_cid, _payload, rel) in enumerate(chunks):
        if rel:
            directory.add(rel, i)
    dir_bytes = directory.to_bytes()

    blocks = bytearray()
    cas = bytearray()
    metas = bytearray()
    logical = 0
    nblocks = 0
    any_oodle = False
    off_len = bytearray()
    for _cid, payload, _rel in chunks:
        logical = (logical + BLOCK - 1) // BLOCK * BLOCK
        off_len += be5(logical) + be5(len(payload))
        chunk_oodle = False
        pos = 0
        while pos < len(payload):
            piece = payload[pos : pos + BLOCK]
            comp = oodle_compress(piece)
            if comp is None:
                stored, method = piece, 0
            else:
                stored, method = comp, 1
                chunk_oodle = True
            pad = (16 - (len(stored) % 16)) % 16
            block_off = len(cas)
            cas += stored + (b"\x00" * pad)
            blocks += le5(block_off)
            blocks += len(stored).to_bytes(3, "little")
            blocks += len(piece).to_bytes(3, "little")
            blocks += bytes([method])
            nblocks += 1
            pos += len(piece)
        logical += len(payload)
        any_oodle = any_oodle or chunk_oodle
        digest = hashlib.sha1(payload).digest()
        metas += digest + (b"\x00" * 12) + bytes([1 if chunk_oodle else 0])

    method_bytes = b""
    method_count = 0
    flags = 8
    if any_oodle:
        method_bytes = b"Oodle" + (b"\x00" * 27)
        method_count = 1
        flags = 9
    ids = b"".join(cid for cid, _p, _r in chunks)
    header = bytearray(HEADER_BYTES)
    header[0:16] = b"-==--==--==--==-"
    header[16] = 3
    struct.pack_into("<I", header, 20, HEADER_BYTES)
    struct.pack_into("<I", header, 24, len(chunks))
    struct.pack_into("<I", header, 28, nblocks)
    struct.pack_into("<I", header, 32, 12)
    struct.pack_into("<I", header, 36, method_count)
    struct.pack_into("<I", header, 40, 32)
    struct.pack_into("<I", header, 44, BLOCK)
    struct.pack_into("<I", header, 48, len(dir_bytes))
    struct.pack_into("<I", header, 52, 1)
    header[56:64] = chunks[0][0][:8]
    header[80] = flags
    struct.pack_into("<Q", header, 88, 0xFFFFFFFFFFFFFFFF)

    utoc = bytes(header) + ids + bytes(off_len) + bytes(blocks) + method_bytes + dir_bytes + bytes(metas)
    utoc_path.parent.mkdir(parents=True, exist_ok=True)
    utoc_path.write_bytes(utoc)
    utoc_path.with_suffix(".ucas").write_bytes(bytes(cas))
    pak_src = CN_MODS / "zzz_cn_voice_g_P.pak"
    shutil.copyfile(pak_src, utoc_path.with_suffix(".pak"))


def zen_header_size(data: bytes) -> tuple[int, int, int, int]:
    export_map = struct.unpack_from("<i", data, 44)[0]
    bundle = struct.unpack_from("<i", data, 48)[0]
    graph_off = struct.unpack_from("<i", data, 52)[0]
    graph_size = struct.unpack_from("<i", data, 56)[0]
    header = graph_off + graph_size
    if not (64 <= export_map < bundle <= header <= len(data)):
        raise RuntimeError(f"TxtRes zen header does not look like UE4.26 (header={header})")
    return header, export_map, bundle, 72


def bump_export_size(data: bytes, splice_at: int, delta: int) -> bytes:
    if delta == 0:
        return data
    header, export_map, bundle, entry_size = zen_header_size(data)
    if splice_at < header:
        raise RuntimeError("subtitle bytes sit inside the zen header; refusing to splice")
    buf = bytearray(data)
    nexp = (bundle - export_map) // entry_size
    # UE4.26 lays export blobs back-to-back starting at the zen header.
    # cooked_serial_offset is not what the loader uses to find them.
    pos = header
    hit = None
    for n in range(nexp):
        at = export_map + n * entry_size
        serial_size = struct.unpack_from("<Q", buf, at + 8)[0]
        start, end = pos, pos + serial_size
        if hit is None and start <= splice_at < end:
            struct.pack_into("<Q", buf, at + 8, serial_size + delta)
            hit = n
        elif hit is not None:
            serial_off = struct.unpack_from("<Q", buf, at)[0]
            struct.pack_into("<Q", buf, at, serial_off + delta)
        pos = end
    if hit is None:
        raise RuntimeError("subtitle splice is outside every export")
    return bytes(buf)


def validate_zen_exports(data: bytes) -> None:
    """Validate the complete UE4.26 export stream, not just the embedded audio."""
    header, export_map, bundle, entry_size = zen_header_size(data)
    if (bundle - export_map) % entry_size:
        raise RuntimeError("misaligned Zen export map")
    sizes = [struct.unpack_from("<Q", data, at + 8)[0]
             for at in range(export_map, bundle, entry_size)]
    if sum(sizes) != len(data) - header:
        raise RuntimeError(f"Zen export sizes {sum(sizes)} != payload {len(data) - header}")


def repair_audio_exports(original: bytes, rebuilt: bytes) -> bytes:
    """AudioMog fixes SAB sizes heuristically but may leave Zen sizes stale.

    Restore the source Zen header and apply the actual size delta to the export
    containing the SAB. This also prevents heuristic byte searches from changing
    unrelated header fields. Run on cache hits too, so old caches are repaired.
    """
    validate_zen_exports(original)
    header, _export_map, _bundle, _entry_size = zen_header_size(original)
    sab = original.find(b"sabf", header)
    if sab < 0 or rebuilt.find(b"sabf", header) != sab:
        raise RuntimeError("SAB location changed or missing")
    fixed = original[:header] + rebuilt[header:]
    fixed = bump_export_size(fixed, sab, len(rebuilt) - len(original))
    validate_zen_exports(fixed)
    return fixed


def style_subtitle(new: str, original: str) -> str:
    new = new.replace("\r\n", "\n").replace("\r", "\n")
    if "<br" in original.lower():
        return new.replace("\n", "<br>")
    if "\r\n" in original:
        return new.replace("\n", "\r\n")
    return new


def patch_txtres(data: bytes, replacements: dict[str, str]) -> bytes:
    found = find_lang(data)
    if not found:
        raise RuntimeError("TxtRes has no language marker")
    _lang, i = found
    (pad,) = struct.unpack_from("<I", data, i)
    if pad != 0:
        raise RuntimeError("TxtRes pad after language is not 0")
    i += 4
    (count,) = struct.unpack_from("<I", data, i)
    i += 4
    parts = [data[:i]]
    first_splice = None
    cursor = i
    for _ in range(count):
        entry_at = cursor
        eid, _enc, _s, e1 = read_fstring(data, entry_at)
        text, enc, ts, te = read_fstring(data, e1)
        stem = eid[1:] if eid.startswith("$") else eid
        if stem in replacements:
            styled = style_subtitle(replacements[stem], text)
            blob = write_fstring(styled, enc)
            if blob != data[ts:te]:
                if first_splice is None:
                    first_splice = ts
                parts.append(data[entry_at:ts])
                parts.append(blob)
            else:
                parts.append(data[entry_at:te])
        else:
            parts.append(data[entry_at:te])
        cursor = te
        (nsub,) = struct.unpack_from("<I", data, cursor)
        sub_at = cursor
        cursor += 4
        for _s in range(nsub):
            cursor += 8
            _t, _e, _a, cursor = read_fstring(data, cursor)
        parts.append(data[sub_at:cursor])
    parts.append(data[cursor:])
    new = b"".join(parts)
    if first_splice is None:
        return data
    return bump_export_size(new, first_splice, len(new) - len(data))


def dotnet_env() -> dict[str, str]:
    env = os.environ.copy()
    dotnet = str(Path.home() / ".dotnet")
    env["PATH"] = dotnet + os.pathsep + env.get("PATH", "")
    env["DOTNET_ROOT"] = dotnet
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    env["DOTNET_NOLOGO"] = "1"
    return env


def run_audiomog(path: Path) -> None:
    proc = subprocess.run(
        ["dotnet", str(AUDIOMOG), str(path)],
        cwd=path.parent,
        env=dotnet_env(),
        capture_output=True,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0:
        tail = (proc.stdout + proc.stderr)[-800:]
        raise RuntimeError(f"AudioMog failed on {path.name}: {tail}")


def rebuild_locked(task: tuple[str, int, str, str]) -> str:
    stem, tts_id, audio_rel, uasset_hex = task
    cache = BUILD_ROOT / "cache" / f"{stem}-{tts_id}.uasset"
    src_audio = DATA / audio_rel
    original = bytes.fromhex(uasset_hex)
    if cache.exists() and cache.stat().st_mtime >= src_audio.stat().st_mtime and cache.stat().st_size > 0:
        cached = cache.read_bytes()
        fixed = repair_audio_exports(original, cached)
        if fixed != cached:
            cache.write_bytes(fixed)
        return str(cache)
    with tempfile.TemporaryDirectory(prefix=f"ff7-{stem}-", dir=str(BUILD_ROOT / "tmp")) as tmp:
        folder = Path(tmp)
        (folder / f"{stem}.uasset").write_bytes(original)
        run_audiomog(folder / f"{stem}.uasset")
        project = folder / f"{stem}_Project"
        wavs = sorted(project.glob("*.wav"))
        if not wavs:
            raise RuntimeError(f"{stem}: AudioMog unpacked no wav")
        voice = max(wavs, key=lambda p: p.stat().st_size)
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=sample_rate,channels",
                "-of", "csv=p=0",
                str(voice),
            ],
            capture_output=True, text=True, timeout=30,
        )
        if probe.returncode != 0:
            raise RuntimeError(f"{stem}: ffprobe failed: {probe.stderr[-200:]}")
        rate_s, ch_s = probe.stdout.strip().split(",")
        out_wav = voice
        conv = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(src_audio),
                "-ar", rate_s, "-ac", ch_s,
                "-c:a", "pcm_s16le",
                str(out_wav),
            ],
            capture_output=True, text=True, timeout=60,
        )
        if conv.returncode != 0:
            raise RuntimeError(f"{stem}: ffmpeg failed: {conv.stderr[-300:]}")
        run_audiomog(project / "RebuildSettings.json")
        built = project / f"{stem}.uasset"
        if not built.exists() or built.stat().st_size < 64:
            raise RuntimeError(f"{stem}: AudioMog did not write a uasset")
        data = built.read_bytes()
        if data == original:
            raise RuntimeError(f"{stem}: rebuilt uasset is identical to the source pack")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(repair_audio_exports(original, data))
    return str(cache)


def load_lines(regions: list[str] | None) -> list[dict]:
    # Only chunks that already live in a zzz_cn_voice pack can be swapped.
    # Lines imported from movie banks (pack jp-only) are not in those packs.
    # psycopg treats % as a placeholder, so the LIKE wildcard is doubled.
    clauses = ["l.pack LIKE 'zzz_cn_voice_%%'"]
    args: list = []
    if regions is not None:
        clauses.append("l.region = ANY(%s)")
        args.append(regions)
    where = "WHERE " + " AND ".join(clauses)
    sql = f"""
        SELECT l.stem, l.region, l.pack, l.asset_path, l.text_zh,
               t.id, t.audio_path, t.subtitle_text, t.voice_gpu_key
        FROM lines l
        LEFT JOIN line_tts_versions t
          ON t.stem = l.stem AND t.status = 'ready' AND t.is_used
        {where}
        ORDER BY l.region, l.stem
    """
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, args)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def load_added_lines(regions: list[str] | None) -> list[dict]:
    """Locked lines whose asset is not in any zzz_cn_voice pack."""
    clauses = ["l.pack NOT LIKE 'zzz_cn_voice_%%'"]
    args: list = []
    if regions is not None:
        clauses.append("l.region = ANY(%s)")
        args.append(regions)
    where = "WHERE " + " AND ".join(clauses)
    sql = f"""
        SELECT l.stem, l.region, l.pack, l.asset_path, l.text_zh,
               l.jp_chunk_id, l.jp_container,
               t.id, t.audio_path, t.subtitle_text, t.tts_text, t.voice_gpu_key,
               m.extra
        FROM lines l
        JOIN line_tts_versions t
          ON t.stem = l.stem AND t.status = 'ready' AND t.is_used
        LEFT JOIN line_meta m ON m.stem = l.stem
        {where}
        ORDER BY l.stem
    """
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, args)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def _extra(row: dict) -> dict:
    extra = row.get("extra") or {}
    if isinstance(extra, str):
        extra = json.loads(extra)
    if not isinstance(extra, dict):
        raise RuntimeError(f"{row['stem']}: line_meta.extra is not an object")
    return extra


def chunk_id_bytes(hex_id: str) -> bytes:
    raw = bytes.fromhex(hex_id)
    if len(raw) != 12 or raw[11] != 2:
        raise RuntimeError(f"chunk id {hex_id} is not a 12-byte asset id")
    return raw


def rel_in_container(asset_path: str) -> str:
    rel = asset_path
    if rel.startswith(MOUNT):
        rel = rel[len(MOUNT):]
    return rel.lstrip("/")


def group_added(rows: list[dict]) -> dict[tuple[str, str, str], list[dict]]:
    """Group locked missing-pack lines by the game asset they share."""
    groups: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for row in rows:
        extra = _extra(row)
        row = dict(row)
        row["extra"] = extra
        chunk = (row.get("jp_chunk_id") or extra.get("bank_chunk_id") or "").lower()
        container = row.get("jp_container") or ""
        path = row.get("asset_path") or ""
        if not chunk or not container or not path:
            raise RuntimeError(f"{row['stem']} 没有游戏语音块的容器、chunk 或路径")
        groups[(container, chunk, path)].append(row)
    for key, group in groups.items():
        sliced = [r for r in group if r["extra"].get("slice_start_s") is not None]
        if sliced and len(sliced) != len(group):
            stems = [r["stem"] for r in group if r not in sliced]
            raise RuntimeError(f"{key[2]} 里有的句子没有切片时间：{stems}")
        if not sliced and len(group) != 1:
            raise RuntimeError(f"{key[2]} 有 {len(group)} 句共用，但没有切片时间")
    return groups


def place_channel(frames: array.array, channels: int, rate: int, pieces: list[dict]) -> None:
    """Clear each slice on one channel, then write that line's audio into it.

    Audio may extend past the slice end until the next slice. An overrun past
    SLICE_OVERRUN_S is refused so two lines cannot stack on the same frames.
    """
    if channels < 1 or rate < 1:
        raise RuntimeError(f"bad wav layout channels={channels} rate={rate}")
    if len(frames) % channels:
        raise RuntimeError("wav frame count is not divisible by channel count")
    nframes = len(frames) // channels
    ordered = sorted(pieces, key=lambda piece: float(piece["start"]))
    placed = []
    for piece in ordered:
        start = int(round(float(piece["start"]) * rate))
        end = int(round(float(piece["end"]) * rate))
        channel = int(piece["channel"])
        mono: array.array = piece["mono"]
        stem = piece["stem"]
        if channel < 0 or channel >= channels:
            raise RuntimeError(f"{stem}: voice channel {channel} but wav has {channels}")
        if start < 0 or end < start or start >= nframes:
            raise RuntimeError(f"{stem}: slice {piece['start']}–{piece['end']} is outside the bank")
        placed.append((start, end, channel, mono, stem))
    for index, (start, end, channel, mono, stem) in enumerate(placed):
        nxt = placed[index + 1][0] if index + 1 < len(placed) else nframes
        if end > nxt:
            raise RuntimeError(f"{stem}: slice overlaps the next line")
        limit = min(nxt, nframes)
        for frame in range(start, min(end, nframes)):
            frames[frame * channels + channel] = 0
        writable = min(len(mono), max(0, limit - start))
        dropped = len(mono) - writable
        if dropped > int(SLICE_OVERRUN_S * rate):
            raise RuntimeError(
                f"{stem}: audio runs {dropped / rate:.3f}s past the open slice"
            )
        base = start * channels + channel
        for offset in range(writable):
            frames[base + offset * channels] = mono[offset]


def read_wav_s16(path: Path) -> tuple[array.array, int, int]:
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2:
            raise RuntimeError(f"{path.name} is not 16-bit PCM")
        channels = handle.getnchannels()
        rate = handle.getframerate()
        count = handle.getnframes()
        blob = handle.readframes(count)
        if len(blob) != count * channels * 2:
            raise RuntimeError(f"{path.name} wav length does not match its header")
        samples = array.array("h")
        samples.frombytes(blob)
        if sys.byteorder != "little":
            samples.byteswap()
        return samples, channels, rate


def write_wav_s16(path: Path, samples: array.array, channels: int, rate: int) -> None:
    out = array.array("h", samples)
    if sys.byteorder != "little":
        out.byteswap()
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(out.tobytes())


def load_mono_s16(path: Path, rate: int) -> array.array:
    proc = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(path),
            "-ac", "1", "-ar", str(rate), "-f", "s16le", "pipe:1",
        ],
        capture_output=True,
        timeout=60,
    )
    if proc.returncode != 0 or not proc.stdout:
        tail = proc.stderr.decode("utf-8", "replace")[-300:]
        raise RuntimeError(f"ffmpeg failed on {path.name}: {tail}")
    if len(proc.stdout) % 2:
        raise RuntimeError(f"{path.name}: ffmpeg returned a partial sample")
    samples = array.array("h")
    samples.frombytes(proc.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def rebuild_added_bank(task: tuple[str, str, list[dict], str]) -> str:
    """Splice locked lines into one game bank, or replace a one-line asset."""
    bank_stem, orig_path, slices, cache_path = task
    cache = Path(cache_path)
    original = Path(orig_path).read_bytes()
    sources = [DATA / piece["audio"] for piece in slices]
    if (
        cache.exists()
        and cache.stat().st_size > 0
        and all(cache.stat().st_mtime >= src.stat().st_mtime for src in sources)
    ):
        cached = cache.read_bytes()
        fixed = repair_audio_exports(original, cached)
        if fixed != cached:
            cache.write_bytes(fixed)
        return str(cache)
    with tempfile.TemporaryDirectory(prefix=f"ff7-add-{bank_stem}-", dir=str(BUILD_ROOT / "tmp")) as tmp:
        folder = Path(tmp)
        (folder / f"{bank_stem}.uasset").write_bytes(original)
        run_audiomog(folder / f"{bank_stem}.uasset")
        project = folder / f"{bank_stem}_Project"
        wavs = sorted(project.glob("*.wav"))
        if not wavs:
            raise RuntimeError(f"{bank_stem}: AudioMog unpacked no wav")
        if slices and slices[0].get("start") is not None:
            wav = _bank_wav(wavs, int(slices[0]["channel"]))
            frames, channels, rate = read_wav_s16(wav)
            pieces = []
            for piece in slices:
                pieces.append({
                    "stem": piece["stem"],
                    "start": piece["start"],
                    "end": piece["end"],
                    "channel": piece["channel"],
                    "mono": load_mono_s16(DATA / piece["audio"], rate),
                })
            place_channel(frames, channels, rate, pieces)
            write_wav_s16(wav, frames, channels, rate)
        else:
            if len(slices) != 1:
                raise RuntimeError(f"{bank_stem}: expected one whole-file line")
            wav = max(wavs, key=lambda item: item.stat().st_size)
            _frames, channels, rate = read_wav_s16(wav)
            mono = load_mono_s16(DATA / slices[0]["audio"], rate)
            mixed = array.array("h", [0]) * (len(mono) * channels)
            for index, sample in enumerate(mono):
                for channel in range(channels):
                    mixed[index * channels + channel] = sample
            write_wav_s16(wav, mixed, channels, rate)
        run_audiomog(project / "RebuildSettings.json")
        built = project / f"{bank_stem}.uasset"
        if not built.exists() or built.stat().st_size < 64:
            raise RuntimeError(f"{bank_stem}: AudioMog did not write a uasset")
        data = built.read_bytes()
        if data == original:
            raise RuntimeError(f"{bank_stem}: rebuilt uasset is identical to the game file")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(repair_audio_exports(original, data))
    return str(cache)


def _bank_wav(wavs: list[Path], channel: int) -> Path:
    ranked = []
    for path in wavs:
        _frames, channels, _rate = read_wav_s16(path)
        if channels > channel:
            ranked.append(path)
    if not ranked:
        raise RuntimeError(f"no unpacked wav has channel {channel}")
    return max(ranked, key=lambda path: path.stat().st_size)


def added_cache_path(bank_stem: str, slices: list[dict]) -> Path:
    key = hashlib.sha1(
        json.dumps(slices, ensure_ascii=False, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]
    return BUILD_ROOT / "cache" / f"add-{bank_stem}-{key}.uasset"


def spoken_subtitle(row: dict) -> str:
    return ((row.get("subtitle_text") or row.get("tts_text") or "")).strip()


def index_txtres() -> tuple[dict[str, str], dict[str, dict]]:
    by_name = {}
    with TXTRES_INDEX.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("lang") == "CN":
                by_name[row["name"]] = row
    stem_file: dict[str, str] = {}
    for path in sorted(TXTRES_RAW.glob("*.uasset")):
        parsed = parse_txtres(path.read_bytes())
        name = path.name[: -len(".uasset")]
        for entry in parsed["entries"]:
            stem = entry["stem"]
            if stem and stem not in stem_file:
                stem_file[stem] = name
    return stem_file, by_name


def select_regions(chapters: str, groups: dict[int, list[str]], extra: list[str]) -> tuple[list[int] | None, list[str] | None]:
    if chapters.strip().lower() == "all":
        return None, None
    wanted = []
    for part in chapters.split(","):
        part = part.strip()
        if not part:
            continue
        n = int(part)
        if n not in groups:
            known = ", ".join(str(k) for k in sorted(groups))
            raise SystemExit(f"没有第 {n} 章。已知章节：{known}")
        wanted.append(n)
    if not wanted:
        raise SystemExit("章节参数是空的")
    regions: list[str] = []
    for n in wanted:
        regions.extend(groups[n])
    return wanted, regions


def sh_date() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")


def prune_local_builds(keep_day: str) -> None:
    """Keep only today's local drop. Older dated folders stay on the SMB share."""
    for child in BUILD_ROOT.iterdir():
        if not child.is_dir() or child.name == keep_day:
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", child.name):
            continue
        shutil.rmtree(child)
        print(f"删本地旧包 {child.name}，共享盘仍保留", flush=True)


def next_version(day: str) -> int:
    folder = SMB_ROOT / day
    used = set()
    if folder.is_dir():
        for child in folder.iterdir():
            if child.is_dir() and child.name.isdigit():
                used.add(int(child.name))
    for n in range(5):
        if n not in used:
            return n
    raise SystemExit(f"{folder} 今天的版本 0–4 都已经有了")


def verify_container(utoc: Path, expect: dict[str, bytes]) -> None:
    toc = utoc.read_bytes()
    chunks, _blocks, directory = parse_utoc(toc)
    _mount, entries = parse_dir_index(directory)
    by_stem = {}
    for rel, user in entries:
        stem = Path(rel).stem
        cid, off, length = chunks[user]
        by_stem[stem] = (cid, off, length, rel)
    missing = [stem for stem in expect if stem not in by_stem]
    if missing:
        raise RuntimeError(f"packed container is missing {missing[:5]}")
    stems = list(expect)
    for start in range(0, len(stems), 128):
        wanted = {by_stem[stem][0]: stem for stem in stems[start:start + 128]}
        got = extract_chunk_ids(utoc, wanted, strict=True)
        if set(got) != set(wanted.values()):
            raise RuntimeError("round-trip missing chunks")
        for stem, data in got.items():
            if data != expect[stem]:
                raise RuntimeError(f"round-trip mismatch for {stem}")
            validate_zen_exports(data)


def main() -> int:
    ap = argparse.ArgumentParser(description="修订原中文语音包，并打独立字幕补丁")
    ap.add_argument("--chapters", default="all", help="all，或 1,2 这种章节号")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--no-rsync", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条语音，用来试跑")
    args = ap.parse_args()

    if not CN_MODS.is_dir():
        raise SystemExit(f"找不到中文包：{CN_MODS}")
    if not AUDIOMOG.exists():
        raise SystemExit(f"找不到 AudioMog：{AUDIOMOG}")

    groups, extra = chapter_map()
    chapter_ids, regions = select_regions(args.chapters, groups, extra)
    print("章节划分：", flush=True)
    for n in sorted(groups):
        mark = ""
        if chapter_ids is None or n in chapter_ids:
            mark = "  ← 本次"
        codes = ", ".join(f"{c} {SEED.get(c, ('',))[0] or ''}".strip() for c in groups[n])
        print(f"  第{n}章{mark}: {codes}", flush=True)
    if chapter_ids is None:
        print(f"  另含章节以外 {len(extra)} 个区域", flush=True)

    rows = load_lines(regions)
    if args.limit:
        rows = rows[: args.limit]
    locked = [r for r in rows if r["id"] is not None]
    sub_rows = []
    for r in locked:
        sub = (r["subtitle_text"] or "").strip()
        base = (r["text_zh"] or "").strip()
        if sub and sub != base:
            sub_rows.append(r)
    added = [] if args.limit else load_added_lines(regions)
    added_groups = group_added(added)
    print(
        f"语音 {len(rows)} 条，其中锁定 {len(locked)} 条，锁定且字幕不同 {len(sub_rows)} 条",
        flush=True,
    )
    if added:
        print(
            f"原中文包没有、已经锁定、这次补进的语音 {len(added)} 条，{len(added_groups)} 个游戏语音块",
            flush=True,
        )
    elif args.limit:
        print("试跑不补原包没有的语音", flush=True)
    if not rows and not added:
        raise SystemExit("这个范围里没有台词")

    print("读取中文包目录…", flush=True)
    catalogs: dict[str, dict[str, tuple[bytes, str]]] = {}
    for utoc in sorted(CN_MODS.glob("zzz_cn_voice_*_P.utoc")):
        catalogs[utoc.stem] = iter_pack_assets(utoc)

    known_chunks: dict[bytes, str] = {}
    for pack, catalog in catalogs.items():
        for _stem, (cid, _rel) in catalog.items():
            known_chunks.setdefault(cid, pack)
    for (_container, chunk, path), _group in added_groups.items():
        cid = chunk_id_bytes(chunk)
        if cid in known_chunks:
            raise SystemExit(f"{path} 已经在 {known_chunks[cid]} 里，不能再补一份")

    missing_audio = []
    for r in locked + added:
        if not r["audio_path"] or not (DATA / r["audio_path"]).is_file():
            missing_audio.append(r["stem"])
    if missing_audio:
        raise SystemExit(f"锁定音频文件不在 data 里：{missing_audio[:8]}")

    by_pack: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_pack[r["pack"]].append(r)

    originals: dict[str, bytes] = {}
    chunk_of: dict[str, bytes] = {}
    rel_of: dict[str, str] = {}
    for pack, group in by_pack.items():
        cat = catalogs.get(pack)
        if cat is None:
            raise SystemExit(f"目录里没有包 {pack}")
        utoc = CN_MODS / f"{pack}.utoc"
        wanted = {}
        for r in group:
            hit = cat.get(r["stem"])
            if hit is None:
                raise SystemExit(f"{pack} 里没有 {r['stem']}")
            cid, rel = hit
            chunk_of[r["stem"]] = cid
            rel_of[r["stem"]] = rel
            wanted[cid] = r["stem"]
        print(f"  抽出 {pack} {len(wanted)} 条", flush=True)
        originals.update(extract_chunk_ids(utoc, wanted))
    if len(originals) != len(rows):
        raise SystemExit(f"抽出 {len(originals)} 条，目录有 {len(rows)} 条")

    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    (BUILD_ROOT / "tmp").mkdir(parents=True, exist_ok=True)
    tasks = []
    for r in locked:
        tasks.append((r["stem"], int(r["id"]), r["audio_path"], originals[r["stem"]].hex()))
    rebuilt: dict[str, bytes] = {}
    if tasks:
        print(f"重打包锁定语音 {len(tasks)} 条，并行 {args.jobs}", flush=True)
        workers = max(1, args.jobs)
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(rebuild_locked, task): task[0] for task in tasks}
            done = 0
            for fut in as_completed(futs):
                stem = futs[fut]
                path = fut.result()
                rebuilt[stem] = Path(path).read_bytes()
                done += 1
                if done % 25 == 0 or done == len(tasks):
                    print(f"  语音 {done}/{len(tasks)}", flush=True)

    voice_bytes: dict[str, bytes] = {}
    for r in rows:
        voice_bytes[r["stem"]] = rebuilt.get(r["stem"], originals[r["stem"]])

    added_bytes: dict[str, bytes] = {}
    added_rels: dict[str, str] = {}
    added_cids: dict[str, bytes] = {}
    if added_groups:
        print(f"补原包没有的语音 {len(added_groups)} 块，{len(added)} 句", flush=True)
        src_dir = BUILD_ROOT / "tmp" / "add-src"
        if src_dir.exists():
            shutil.rmtree(src_dir)
        src_dir.mkdir(parents=True)
        by_container: dict[str, dict[bytes, str]] = defaultdict(dict)
        planned: dict[str, tuple[bytes, str, list[dict]]] = {}
        for (container, chunk, path), group in added_groups.items():
            bank = Path(path).name
            if bank.endswith(".uasset"):
                bank = bank[: -len(".uasset")]
            cid = chunk_id_bytes(chunk)
            if bank in planned:
                raise SystemExit(f"语音块 {bank} 出现了两次")
            by_container[container][cid] = bank
            sliced = group[0]["extra"].get("slice_start_s") is not None
            slices = []
            for row in sorted(group, key=lambda item: float(item["extra"].get("slice_start_s") or 0)):
                extra = row["extra"]
                slices.append({
                    "stem": row["stem"],
                    "audio": row["audio_path"],
                    "start": extra.get("slice_start_s") if sliced else None,
                    "end": extra.get("slice_end_s") if sliced else None,
                    "channel": int(extra.get("voice_channel", 4)) if sliced else 0,
                })
            planned[bank] = (cid, rel_in_container(path), slices)
            added_rels[bank] = rel_in_container(path)
            added_cids[bank] = cid
        extracted: dict[str, bytes] = {}
        for container, wanted in by_container.items():
            utoc = GAME_PAKS / f"{container}.utoc"
            if not utoc.is_file():
                raise SystemExit(f"找不到游戏语音容器 {utoc}")
            print(f"  抽出游戏 {container} {len(wanted)} 块", flush=True)
            extracted.update(extract_chunk_ids(utoc, wanted, strict=True))
        missing_banks = sorted(set(planned) - set(extracted))
        if missing_banks:
            raise SystemExit(f"游戏包里没有这些语音块：{missing_banks[:8]}")
        add_tasks = []
        for bank, (_cid, _rel, slices) in planned.items():
            orig = src_dir / f"{bank}.uasset"
            orig.write_bytes(extracted[bank])
            add_tasks.append((bank, str(orig), slices, str(added_cache_path(bank, slices))))
        workers = max(1, args.jobs)
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(rebuild_added_bank, task): task[0] for task in add_tasks}
            for fut in as_completed(futs):
                bank = futs[fut]
                added_bytes[bank] = Path(fut.result()).read_bytes()
                print(f"  补上 {bank}", flush=True)

    text_chunks: list[tuple[bytes, bytes, str]] = []
    subtitle_line_count = 0
    added_spoken = {}
    if not args.limit:
        for row in added:
            text = spoken_subtitle(row)
            if text:
                added_spoken[row["stem"]] = text
    if (sub_rows or added_spoken) and not args.limit:
        print("改字幕…", flush=True)
        stem_file, by_name = index_txtres()
        grouped: dict[str, dict[str, str]] = defaultdict(dict)
        lost = []
        for r in sub_rows:
            name = stem_file.get(r["stem"])
            if not name or name not in by_name:
                lost.append(r["stem"])
                continue
            grouped[name][r["stem"]] = r["subtitle_text"].strip()
        for stem, text in added_spoken.items():
            name = stem_file.get(stem)
            if not name or name not in by_name:
                lost.append(stem)
                continue
            grouped[name][stem] = text
        if lost:
            raise SystemExit(f"这些锁定字幕在中文 TxtRes 里找不到：{lost[:12]}")
        for name, repl in grouped.items():
            meta = by_name[name]
            src = TXTRES_RAW / f"{name}.uasset"
            raw = src.read_bytes()
            current = {e["stem"]: e["text"] for e in parse_txtres(raw)["entries"]}
            unknown = [stem for stem in repl if stem not in current]
            if unknown:
                raise SystemExit(f"{name} 里找不到字幕：{unknown[:8]}")
            repl = {
                stem: text
                for stem, text in repl.items()
                if clean_text(current[stem]) != clean_text(text)
            }
            if not repl:
                continue
            patched = patch_txtres(raw, repl)
            if patched == raw:
                print(f"  {name} 字幕字节没有变化，跳过", flush=True)
                continue
            again = parse_txtres(patched)
            got = {e["stem"]: e["text"] for e in again["entries"]}
            for stem, text in repl.items():
                if clean_text(got.get(stem, "")) != clean_text(text):
                    raise RuntimeError(f"{name} 回读字幕不对：{stem}")
            rel = meta["path"]
            if rel.startswith(MOUNT):
                rel = rel[len(MOUNT) :]
            text_chunks.append((bytes.fromhex(meta["chunk_id"]), patched, rel))
            subtitle_line_count += len(repl)
            print(f"  {name} 改了 {len(repl)} 句", flush=True)
    elif (sub_rows or added) and args.limit:
        print("试跑不改字幕", flush=True)

    by_pack: dict[str, dict[bytes, bytes]] = defaultdict(dict)
    pack_of = {r["stem"]: r["pack"] for r in rows}
    for stem, payload in rebuilt.items():
        by_pack[pack_of[stem]][chunk_of[stem]] = payload

    day = sh_date()
    out_dir = BUILD_ROOT / day / "staging"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    mod_dir = out_dir / "End" / "Content" / "Paks" / "~mods"
    mod_dir.mkdir(parents=True)
    written = []
    for pack, repl in sorted(by_pack.items()):
        src = CN_MODS / f"{pack}.utoc"
        dest = mod_dir / f"{pack}.utoc"
        n = patch_voice_pack(src, repl, dest)
        print(f"写 {pack} ，替换 {n} 句", flush=True)
        verify_container(dest, {stem: voice_bytes[stem] for stem, p in pack_of.items() if p == pack})
        written.append(pack)
    if chapter_ids is None:
        for src_utoc in sorted(CN_MODS.glob("zzz_cn_voice_*_P.utoc")):
            pack = src_utoc.stem
            if pack in written:
                continue
            for ext in (".utoc", ".ucas", ".pak"):
                src = CN_MODS / f"{pack}{ext}"
                if src.is_file():
                    shutil.copy2(src, mod_dir / src.name)
            written.append(pack)
            print(f"原样拷 {pack}", flush=True)

    if added_bytes:
        cid0 = os.urandom(8)
        add_chunks: list[tuple[bytes, bytes, str | None]] = [
            (cid0 + struct.pack("<HBB", 0, 0, 10), container_header(cid0), None)
        ]
        for bank, payload in sorted(added_bytes.items()):
            add_chunks.append((added_cids[bank], payload, added_rels[bank]))
        add_utoc = mod_dir / f"{ADD_PACK}.utoc"
        print(f"写 {ADD_PACK} ，{len(added_bytes)} 块", flush=True)
        write_container(add_chunks, add_utoc)
        verify_container(add_utoc, added_bytes)
        written.append(ADD_PACK)

    subtitle_utoc = None
    if text_chunks:
        cid0 = os.urandom(8)
        chunks: list[tuple[bytes, bytes, str | None]] = [
            (cid0 + struct.pack("<HBB", 0, 0, 10), container_header(cid0), None)
        ]
        for cid, payload, rel in text_chunks:
            chunks.append((cid, payload, rel))
        subtitle_utoc = mod_dir / f"{MOD_STEM}.utoc"
        print(f"写字幕 {subtitle_utoc.name} （{len(text_chunks)} 份）", flush=True)
        write_container(chunks, subtitle_utoc)
        verify_container(subtitle_utoc, {Path(rel).stem: payload for _cid, payload, rel in text_chunks})
        subprocess.run([str(ROOT / "programs/bin/retoc"), "info", str(subtitle_utoc)], check=True)

    manifest = {
        "mod": written,
        "subtitle_mod": MOD_STEM if subtitle_utoc else None,
        "date": day,
        "version": None,
        "chapters": "all" if chapter_ids is None else chapter_ids,
        "regions": regions,
        "voice_files": len(rows),
        "locked_replaced": len(rebuilt),
        "source_cn_copied": len(rows) - len(rebuilt),
        "added_pack": ADD_PACK if added_bytes else None,
        "added_banks": len(added_bytes),
        "added_lines": len(added),
        "subtitle_files": len(text_chunks),
        "subtitle_lines": subtitle_line_count,
        "validation": {
            "rebuilt_zen_exports": len(rebuilt) + len(added_bytes),
            "subtitle_zen_exports": len(text_chunks),
            "strict_oodle_roundtrip": True,
            "game_launch_tested": False,
        },
        "packs": {
            name: (mod_dir / f"{name}.ucas").stat().st_size for name in written
        },
    }
    if not args.no_rsync:
        version = next_version(day)
        manifest["version"] = version
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    install_lines = [
        "FF7 Rebirth 中文语音修订包",
        "这是要覆盖的 zzz_cn_voice 包，不是再叠一个新名字。",
        "",
        "先退出游戏，删掉 ~mods 里的 aa_cn_voice_edit_P 和 zzzz_cn_voice_edit_P。",
        "再用本目录里的同名文件覆盖：",
        "  FINAL FANTASY VII REBIRTH\\End\\Content\\Paks\\~mods\\",
        "复制本目录的 End 到游戏根目录，覆盖同名文件；本目录没有的 zzz 包保留。语音仍选日语。",
        "aa_cn_voice_edit_P 是本次新字幕包：先删除旧版，再复制本次版本，不能漏装。",
    ]
    if added_bytes:
        install_lines.append(
            f"{ADD_PACK} 是原中文包里没有的语音，例如过场 CG。"
            "这个文件也要放进 ~mods，不要当成旧叠包删掉。"
        )
    install_lines.extend([
        "",
        "不要把旧包留在 Paks 的子目录里，游戏会把子目录也扫进去，老声音又会回来。",
        "",
        json.dumps(manifest, ensure_ascii=False),
        "",
    ])
    (out_dir / "安装说明.txt").write_text("\n".join(install_lines), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False), flush=True)
    if args.no_rsync:
        print(f"未同步。本地目录 {out_dir}", flush=True)
        return 0
    dest = SMB_ROOT / day / str(version)
    dest.mkdir(parents=True, exist_ok=True)
    print(f"rsync -> {dest}", flush=True)
    proc = subprocess.run(
        ["rsync", "-avP", f"{out_dir}/", f"{dest}/"],
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(f"rsync 失败，本地包还在 {out_dir}")
    prune_local_builds(day)
    print(f"完成 {dest}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(exc.returncode or 1)
