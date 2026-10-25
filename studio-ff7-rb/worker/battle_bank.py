"""Address individual SQEXSEAD materials without treating a bank as one line."""
import hashlib
import struct


def material_entries(data: bytes) -> list[dict]:
    banks = []
    start = 0
    while (start := data.find(b"sabf", start)) >= 0:
        try:
            count, descriptor = data[start + 8:start + 10]
            header = 16 + descriptor + 16 - descriptor % 16
            sections = {
                data[q:q + 4]: start + struct.unpack_from("<I", data, q + 8)[0]
                for q in range(start + header, start + header + count * 16, 16)
            }
            material = sections[b"mtrl"]
            entries = []
            for index in range(struct.unpack_from("<H", data, material + 4)[0]):
                offset = material + struct.unpack_from("<I", data, material + 16 + index * 4)[0]
                channels, codec, number, rate = struct.unpack_from("<BBHI", data, offset + 4)
                extra, size = struct.unpack_from("<II", data, offset + 20)
                payload = data[offset + 32 + extra:offset + 32 + extra + size]
                if len(payload) != size:
                    raise ValueError("truncated material")
                entries.append(dict(index=index, number=number, channels=channels,
                                    codec=codec, rate=rate, size=size,
                                    digest=hashlib.sha256(payload).hexdigest()))
            banks.append(entries)
        except (KeyError, IndexError, ValueError, struct.error):
            pass
        start += 4
    if len(banks) != 1:
        raise RuntimeError(f"Expected one valid SAB, found {len(banks)}")
    return banks[0]


def validate_replacements(original: bytes, rebuilt: bytes, changed: set[int]) -> None:
    before, after = material_entries(original), material_entries(rebuilt)
    if len(before) != len(after):
        raise RuntimeError("Battle bank material count changed")
    if any(i < 0 or i >= len(before) for i in changed):
        raise RuntimeError("Battle bank material index outside bank")
    for index, (left, right) in enumerate(zip(before, after)):
        for key in ("number", "channels", "rate", "codec"):
            if left[key] != right[key]:
                raise RuntimeError(f"Battle material {index}: {key} changed")
        if index not in changed and left["digest"] != right["digest"]:
            raise RuntimeError(f"Unselected battle material {index} changed")
        if index in changed and (not right["size"] or left["digest"] == right["digest"]):
            raise RuntimeError(f"Selected battle material {index} was not replaced")
