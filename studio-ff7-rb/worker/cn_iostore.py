"""Read UnrealReZen-style IoStore patches (Oodle payload, broken ContainerHeader)."""

from __future__ import annotations

import ctypes
import struct
from dataclasses import dataclass
from pathlib import Path

OODLE_PATH = Path(__file__).resolve().parents[2] / "programs" / "bin" / "liboo2corelinux64.so.9"

_lib = None
_decompress = None


def _oodle():
    global _lib, _decompress
    if _decompress is not None:
        return _decompress
    _lib = ctypes.CDLL(str(OODLE_PATH))
    fn = _lib.OodleLZ_Decompress
    fn.restype = ctypes.c_ssize_t
    fn.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ssize_t,
        ctypes.c_void_p,
        ctypes.c_ssize_t,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_ssize_t,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_ssize_t,
        ctypes.c_int,
    ]
    _decompress = fn
    return fn


def oodle_decompress(blob: bytes, usize: int, *, strict: bool = False) -> bytes:
    if usize == 0:
        return b""
    fn = _oodle()
    out = (ctypes.c_char * usize)()
    n = fn(
        blob,
        len(blob),
        ctypes.byref(out),
        usize,
        0,
        0,
        0,
        None,
        0,
        None,
        None,
        None,
        0,
        3,
    )
    if strict and n != usize:
        raise ValueError(f"Oodle decode returned {n}, expected {usize}")
    if n <= 0:
        if len(blob) >= usize:
            return blob[:usize]
        return b"\x00" * usize
    return bytes(out[:n])


@dataclass
class Chunk:
    chunk_id: bytes
    chunk_type: int
    offset: int
    length: int
    data: bytes = b""


def _be5(b: bytes) -> int:
    return int.from_bytes(b, "big")


def parse_utoc(toc: bytes) -> tuple[list[tuple[bytes, int, int]], list[tuple[int, int, int, int]], bytes]:
    if toc[:16] != b"-==--==--==--==-":
        raise ValueError("not a utoc")
    version = toc[16]
    # 1 Initial, 2 DirectoryIndex (Rebirth), 3 PartitionSize (UnrealReZen).
    # PerfectHash (4+) inserts extra tables we do not skip yet.
    if version >= 4:
        raise ValueError(f"unsupported utoc version {version}")
    header_size = struct.unpack_from("<I", toc, 20)[0]
    n_entries = struct.unpack_from("<I", toc, 24)[0]
    n_blocks = struct.unpack_from("<I", toc, 28)[0]
    block_entry_size = struct.unpack_from("<I", toc, 32)[0]
    method_count = struct.unpack_from("<I", toc, 36)[0]
    method_len = struct.unpack_from("<I", toc, 40)[0]
    dir_index_size = struct.unpack_from("<I", toc, 48)[0]
    if block_entry_size != 12:
        raise ValueError(f"unexpected block entry size {block_entry_size}")

    off = header_size
    ids = toc[off : off + n_entries * 12]
    off += n_entries * 12
    ols = toc[off : off + n_entries * 10]
    off += n_entries * 10
    blocks_off = off
    off += n_blocks * 12
    off += method_count * method_len
    flags = toc[80]
    if flags & 0x4:  # Signed
        raise ValueError("signed toc not supported")
    directory = toc[off : off + dir_index_size]

    chunks = []
    for i in range(n_entries):
        cid = ids[i * 12 : (i + 1) * 12]
        ol = ols[i * 10 : (i + 1) * 10]
        chunks.append((cid, _be5(ol[0:5]), _be5(ol[5:10])))

    blocks = []
    for i in range(n_blocks):
        e = toc[blocks_off + i * 12 : blocks_off + i * 12 + 12]
        offset = int.from_bytes(e[0:5], "little")
        csize = int.from_bytes(e[5:8], "little")
        usize = int.from_bytes(e[8:11], "little")
        method = e[11]
        blocks.append((offset, csize, usize, method))

    return chunks, blocks, directory


def read_directory_names(directory: bytes) -> list[str]:
    """Best-effort filenames from IoStore directory index blob."""
    import re

    return [m.group().decode("ascii") for m in re.finditer(rb"[\w.\-]+\.uasset", directory)]


def extract_chunk_ids(utoc_path: Path, wanted: dict[bytes, str], *, strict: bool = False) -> dict[str, bytes]:
    """Read many chunks from one utoc/ucas. Returns stem -> decompressed bytes."""
    import mmap

    toc = utoc_path.read_bytes()
    chunks_meta, blocks, _directory = parse_utoc(toc)
    block_size = 65536
    cas_path = utoc_path.with_suffix(".ucas")
    out: dict[str, bytes] = {}
    if not wanted:
        return out
    with cas_path.open("rb") as fh:
        cas = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        cache: dict[int, bytes] = {}

        def get_block(i: int) -> bytes:
            hit = cache.get(i)
            if hit is not None:
                return hit
            offset, csize, usize, method = blocks[i]
            blob = cas[offset : offset + csize]
            if method == 0:
                data = blob[:usize]
            else:
                data = oodle_decompress(bytes(blob), usize, strict=strict)
            if strict and len(data) != usize:
                raise ValueError(f"truncated block {i}")
            piece = bytearray(block_size)
            piece[: len(data)] = data
            raw = bytes(piece)
            cache[i] = raw
            return raw

        for cid, off, length in chunks_meta:
            stem = wanted.get(cid)
            if stem is None or length <= 0:
                continue
            start_b = off // block_size
            end_b = (off + length - 1) // block_size
            buf = bytearray()
            for i in range(start_b, end_b + 1):
                buf += get_block(i)
            local = off - start_b * block_size
            out[stem] = bytes(buf[local : local + length])
        cas.close()
    return out


def extract_named(utoc_path: Path, filename: str) -> bytes:
    toc = utoc_path.read_bytes()
    cas = utoc_path.with_suffix(".ucas").read_bytes()
    chunks_meta, blocks, directory = parse_utoc(toc)
    names = read_directory_names(directory)
    assets = [(cid, off, length) for cid, off, length in chunks_meta if cid[11] == 2]
    try:
        idx = names.index(filename if filename.endswith(".uasset") else filename + ".uasset")
    except ValueError:
        idx = names.index(filename) if filename in names else -1
    if idx < 0 or idx >= len(assets):
        raise FileNotFoundError(filename)
    _, off, length = assets[idx]
    block_size = 65536
    start_b = off // block_size
    end_b = (off + length - 1) // block_size
    buf = bytearray()
    for i in range(start_b, end_b + 1):
        offset, csize, usize, method = blocks[i]
        blob = cas[offset : offset + csize]
        data = blob[:usize] if method == 0 else oodle_decompress(blob, usize)
        piece = bytearray(block_size)
        piece[: len(data)] = data
        buf += piece
    local = off - start_b * block_size
    return bytes(buf[local : local + length])


def extract_container(utoc_path: Path) -> list[Chunk]:
    toc = utoc_path.read_bytes()
    cas = utoc_path.with_suffix(".ucas").read_bytes()
    chunks_meta, blocks, directory = parse_utoc(toc)
    # Unreal maps block i to uncompressed offset i * 65536 even if a
    # block's raw size is smaller (the CN pack's ContainerHeader is 44 bytes).
    block_size = 65536
    stream = bytearray(len(blocks) * block_size)
    for i, (offset, csize, usize, method) in enumerate(blocks):
        blob = cas[offset : offset + csize]
        if method == 0:
            data = blob[:usize]
        else:
            data = oodle_decompress(blob, usize)
        start = i * block_size
        stream[start : start + len(data)] = data
    out = []
    names = read_directory_names(directory)
    name_i = 0
    for cid, off, length in chunks_meta:
        ctype = cid[11]
        data = bytes(stream[off : off + length]) if off + length <= len(stream) else b""
        ch = Chunk(chunk_id=cid, chunk_type=ctype, offset=off, length=length, data=data)
        out.append(ch)
    return out, names
