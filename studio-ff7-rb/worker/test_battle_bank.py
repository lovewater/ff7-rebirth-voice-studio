"""Independent bank slots must never replace neighboring material streams."""
import struct
import unittest

from battle_bank import material_entries, validate_replacements
from build_mod import rebuild_battle_bank


def bank(payloads):
    data = bytearray(80)
    data[:4] = b"sabf"
    data[8] = 1
    data[32:36] = b"mtrl"
    struct.pack_into("<I", data, 40, 48)
    struct.pack_into("<H", data, 52, len(payloads))
    for index, payload in enumerate(payloads):
        offset = len(data)
        struct.pack_into("<I", data, 64 + index * 4, offset - 48)
        data.extend(bytes(32))
        struct.pack_into("<BBHI", data, offset + 4, 1, 7, index, 32000)
        struct.pack_into("<I", data, offset + 24, len(payload))
        data.extend(payload)
    return bytes(data)


class BankIsolation(unittest.TestCase):
    def test_selected_stream_may_change_size_without_touching_neighbors(self):
        validate_replacements(bank([b"first", b"second"]),
                              bank([b"longer first replacement", b"second"]), {0})

    def test_rejects_unselected_stream_change(self):
        with self.assertRaisesRegex(RuntimeError, "Unselected"):
            validate_replacements(bank([b"first", b"second"]),
                                  bank([b"changed", b"oops"]), {0})

    def test_rejects_dropped_slot_and_missing_replacement(self):
        with self.assertRaisesRegex(RuntimeError, "count"):
            validate_replacements(bank([b"one", b"two"]), bank([b"new"]), {0})
        with self.assertRaisesRegex(RuntimeError, "not replaced"):
            validate_replacements(bank([b"same"]), bank([b"same"]), {0})

    def test_rejects_truncated_payload(self):
        with self.assertRaises(RuntimeError):
            material_entries(bank([b"first"])[:-1])

    def test_original_choices_keep_compressed_streams_without_encoding(self):
        original = bank([b"first", b"second"])
        row = {"voice_gpu_key": "jp-lock", "extra": {
            "bank_material_index": 0,
            "original_material_sha256": material_entries(original)[0]["digest"],
        }}
        self.assertEqual(rebuild_battle_bank("test", original, [row]), original)
        row["voice_gpu_key"] = "cn-original"
        self.assertEqual(rebuild_battle_bank("test", original, [row]), original)

    def test_japanese_choice_requires_original_stream_evidence(self):
        row = {"voice_gpu_key": "jp-lock", "extra": {"bank_material_index": 0}}
        with self.assertRaisesRegex(RuntimeError, "verified original Japanese"):
            rebuild_battle_bank("test", bank([b"Chinese replacement"]), [row])


if __name__ == "__main__":
    unittest.main()
