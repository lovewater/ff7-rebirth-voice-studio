"""Regression checks for Zen lengths left stale by AudioMog."""
import array
import struct
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from build_mod import place_channel, repair_audio_exports, validate_zen_exports, spoken_subtitle, rebuild_added_bank, added_cache_path


def asset(sizes):
    export_map = 64
    bundle = export_map + 72 * len(sizes)
    header = bundle + 16
    data = bytearray(header + sum(sizes))
    struct.pack_into("<iiii", data, 44, export_map, bundle, bundle, 16)
    pos = 1000
    for i, size in enumerate(sizes):
        struct.pack_into("<QQ", data, export_map + i * 72, pos, size)
        pos += size
    data[header + 8:header + 12] = b"sabf"
    return bytes(data), header


class ZenLengths(unittest.TestCase):
    def test_grow_and_shrink_with_following_export(self):
        for delta in (-16, 32):
            with self.subTest(delta=delta):
                original, header = asset([64, 32])
                body = original[header:header + 64 + delta] if delta < 0 else original[header:header + 64] + bytes(delta)
                rebuilt = original[:header] + body + original[header + 64:]
                with self.assertRaises(RuntimeError):
                    validate_zen_exports(rebuilt)
                fixed = repair_audio_exports(original, rebuilt)
                validate_zen_exports(fixed)
                self.assertEqual(fixed[header:], rebuilt[header:])
                self.assertEqual(struct.unpack_from("<Q", fixed, 72)[0], 64 + delta)
                self.assertEqual(struct.unpack_from("<Q", fixed, 136)[0], 1064 + delta)
                self.assertEqual(repair_audio_exports(original, fixed), fixed)

    def test_reject_missing_sab(self):
        original, _ = asset([64])
        with self.assertRaises(RuntimeError):
            repair_audio_exports(original, original.replace(b"sabf", b"xxxx"))

    def test_restore_header_heuristic_damage(self):
        original, _ = asset([64])
        damaged = bytearray(original)
        damaged[32] = 123
        self.assertEqual(repair_audio_exports(original, bytes(damaged)), original)


def frames(channels, count, fill=1):
    return array.array("h", [fill] * (channels * count))


class PlaceChannel(unittest.TestCase):
    def test_clears_window_then_writes_one_channel(self):
        samples = frames(2, 10, fill=3)
        place_channel(samples, 2, 10, [{
            "stem": "a",
            "start": 0.2,
            "end": 0.6,
            "channel": 1,
            "mono": array.array("h", [7, 7, 7]),
        }])
        voice = [samples[i * 2 + 1] for i in range(10)]
        other = [samples[i * 2] for i in range(10)]
        self.assertEqual(voice, [3, 3, 7, 7, 7, 0, 3, 3, 3, 3])
        self.assertEqual(other, [3] * 10)

    def test_rejects_overlap_and_long_overrun(self):
        samples = frames(1, 10, fill=0)
        with self.assertRaises(RuntimeError):
            place_channel(samples, 1, 10, [
                {"stem": "a", "start": 0.0, "end": 0.5, "channel": 0, "mono": array.array("h", [1])},
                {"stem": "b", "start": 0.4, "end": 0.8, "channel": 0, "mono": array.array("h", [1])},
            ])
        with self.assertRaises(RuntimeError):
            place_channel(frames(1, 10), 1, 10, [
                {
                    "stem": "a",
                    "start": 0.0,
                    "end": 0.2,
                    "channel": 0,
                    "mono": array.array("h", [1, 1, 1, 1, 1]),
                },
                {
                    "stem": "b",
                    "start": 0.3,
                    "end": 0.5,
                    "channel": 0,
                    "mono": array.array("h", [2]),
                },
            ])


class SubtitleInheritance(unittest.TestCase):
    def test_interjection_comes_from_original_when_override_is_empty(self):
        for override in (None, "", "  "):
            self.assertEqual(spoken_subtitle({"subtitle_text": override, "text_zh": "嗯，你说得对", "tts_text": "你说得对"}), "嗯，你说得对")

    def test_explicit_manual_caption_has_priority(self):
        self.assertEqual(spoken_subtitle({"subtitle_text": "嗯，说得没错", "text_zh": "嗯，你说得对", "tts_text": "说得没错"}), "嗯，说得没错")

    def test_missing_original_resource_can_use_tts_caption(self):
        self.assertEqual(spoken_subtitle({"subtitle_text": None, "text_zh": None, "tts_text": "新增台词"}), "新增台词")
        self.assertEqual(spoken_subtitle({"subtitle_text": None, "text_zh": "", "tts_text": "只有声音"}), "")


class PreservedJapaneseAddedBanks(unittest.TestCase):
    def test_all_japanese_locks_copy_original_asset_without_audio_conversion(self):
        original, _ = asset([64])
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "original.uasset"
            cache = Path(folder) / "cache.uasset"
            source.write_bytes(original)
            cache.write_bytes(b"old transcoded cache")
            for slices in ([{"keep_japanese": True}], [{"keep_japanese": True}, {"keep_japanese": True}]):
                with patch("build_mod.run_audiomog", side_effect=AssertionError("must preserve raw Japanese")):
                    result = rebuild_added_bank(("bank", str(source), slices, str(cache)))
                self.assertEqual(Path(result).read_bytes(), original)
                validate_zen_exports(Path(result).read_bytes())

    def test_preserved_slice_is_untouched_and_remains_a_boundary(self):
        samples = frames(2, 10, fill=3)
        place_channel(samples, 2, 10, [
            {"stem":"first", "start":0, "end":.4, "channel":1, "mono":array.array("h", [7]*4)},
            {"stem":"jp", "start":.4, "end":.7, "channel":1, "keep_japanese":True},
            {"stem":"last", "start":.7, "end":1, "channel":1, "mono":array.array("h", [9]*3)},
        ])
        self.assertEqual(list(samples[1::2]), [7]*4+[3]*3+[9]*3)
        self.assertEqual(list(samples[::2]), [3]*10)
        with self.assertRaisesRegex(RuntimeError, "past the open slice"):
            place_channel(frames(1,10), 1, 10, [
                {"stem":"long", "start":0, "end":.4, "channel":0, "mono":array.array("h", [7]*7)},
                {"stem":"jp", "start":.4, "end":1, "channel":0, "keep_japanese":True},
            ])

    def test_cache_distinguishes_original_japanese_from_replacement(self):
        self.assertNotEqual(added_cache_path("bank", [{"keep_japanese": True}]), added_cache_path("bank", [{"keep_japanese": False}]))


if __name__ == "__main__":
    unittest.main()
