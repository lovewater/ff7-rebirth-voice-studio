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
    def test_long_exact_zero_padding_can_end_at_next_slice(self):
        samples = frames(2, 10, fill=3)
        place_channel(samples, 2, 10, [
            {"stem": "a", "start": 0, "end": .4, "channel": 1,
             "mono": array.array("h", [7, 7, 0, 0, 0, 0, 0])},
            {"stem": "jp", "start": .4, "end": 1, "channel": 1,
             "keep_japanese": True},
        ])
        self.assertEqual(list(samples[1::2]), [7, 7, 0, 0] + [3] * 6)
        self.assertEqual(list(samples[::2]), [3] * 10)
        # Even a single nonzero sample in the discarded tail must still fail.
        with self.assertRaisesRegex(RuntimeError, "past the open slice"):
            place_channel(frames(1, 10), 1, 10, [
                {"stem": "a", "start": 0, "end": .4, "channel": 0,
                 "mono": array.array("h", [7, 7, 0, 0, 0, 0, 1])},
                {"stem": "jp", "start": .4, "end": 1, "channel": 0,
                 "keep_japanese": True},
            ])

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


class SameStemVariants(unittest.TestCase):
    def entry(self, stem, n, directory="EV", lang="JP"):
        return dict(stem=stem, chunk_id=(n.to_bytes(8, "little") + bytes.fromhex("00000002")).hex(),
                    container="game", path=f"../../../End/Content/Sound/Voice/{lang}/{directory}/{stem}.uasset", size=100)

    def row(self, stem, **kw):
        return dict(stem=stem, region="C3210", pack="zzz_cn_voice_e_P", id=59043,
                    audio_path="locked.wav", voice_gpu_key="generated", **kw)

    def test_all_26_ev_mv_pairs_and_three_reported_stems(self):
        from build_mod import plan_same_stem_variants, rel_in_container
        stems = ["C3210_MAIN_0200_1000_00_rgs", "C3210_MAIN_0300_0100_00_scr",
                 "C3210_MAIN_0300_0300_00_tsu"] + [f"C3210_fixture_{n}" for n in range(23)]
        ev = [self.entry(stem, n+1) for n, stem in enumerate(stems)]
        mv = [self.entry(stem, n+101, "MV") for n, stem in enumerate(stems)]
        known = {bytes.fromhex(e['chunk_id']): ("cn", rel_in_container(e['path'])) for e in ev}
        index = ev + mv + [self.entry(stems[0], 300, "MV", "EN"), self.entry("unknown", 301)]
        aliases, unlocked = plan_same_stem_variants([self.row(stem) for stem in stems], index, known)
        self.assertEqual([e['chunk_id'] for e in aliases], [e['chunk_id'] for e in sorted(mv, key=lambda e:(e['stem'], e['chunk_id'], e['path']))])
        self.assertEqual(len(aliases), 26)
        self.assertEqual(unlocked, [])
        self.assertEqual(plan_same_stem_variants([self.row(stems[0])], index, known, ["OTHER"]), ([], []))
        row = self.row(stems[0]); row['id'] = None
        aliases, unlocked = plan_same_stem_variants([row], index, known)
        self.assertFalse(aliases)
        self.assertEqual(len(unlocked), 1)

    def test_multiple_missing_variants_dedup_and_conflicts(self):
        from build_mod import plan_same_stem_variants
        ev, mv = self.entry("line", 1), self.entry("line", 2, "MV")
        aliases, _ = plan_same_stem_variants([self.row("line")], [ev, mv, mv], {})
        self.assertEqual(len(aliases), 2)
        with self.assertRaisesRegex(RuntimeError, "conflicting JP"):
            plan_same_stem_variants([self.row("line")], [ev, dict(mv, chunk_id=ev['chunk_id'])], {})
        with self.assertRaisesRegex(RuntimeError, "conflicting audio"):
            plan_same_stem_variants([self.row("line"), dict(self.row("line"), id=4)], [ev], {})

    def test_exact_roundtrip_keeps_same_basename_and_rejects_wrong_mv(self):
        from build_mod import write_container, container_header, verify_container, iter_pack_assets
        ev, mv = asset([64])[0], asset([64, 32])[0]
        evcid, mvcid = bytes.fromhex(self.entry("line", 1)['chunk_id']), bytes.fromhex(self.entry("line", 2)['chunk_id'])
        evpath, mvpath = "End/JP/EV/line.uasset", "End/JP/MV/line.uasset"
        header = b"12345678"
        with tempfile.TemporaryDirectory() as folder, patch("build_mod.oodle_compress", return_value=None), \
                patch("build_mod.CN_MODS", Path(folder)):
            (Path(folder) / "zzz_cn_voice_g_P.pak").write_bytes(b"fixture pak")
            utoc = Path(folder) / "test.utoc"
            chunks = [(header + bytes.fromhex("0000000a"), container_header(header), None),
                      (evcid, ev, evpath), (mvcid, mv, mvpath)]
            write_container(chunks, utoc)
            self.assertEqual(len(iter_pack_assets(utoc, full_paths=True)), 2)
            with self.assertRaisesRegex(RuntimeError, "ambiguous"):
                iter_pack_assets(utoc)
            verify_container(utoc, {(evcid, evpath):ev, (mvcid,mvpath):mv})
            with self.assertRaisesRegex(RuntimeError, "mismatch"):
                verify_container(utoc, {(mvcid,mvpath):ev})
            write_container(chunks[:2], utoc)
            with self.assertRaisesRegex(RuntimeError, "missing exact"):
                verify_container(utoc, {(evcid,evpath):ev, (mvcid,mvpath):mv})

    def test_japanese_alias_preserves_its_own_bytes_and_cn_original_refuses_transcode(self):
        from build_mod import preserved_alias_audio
        ev, mv = asset([64])[0], asset([64,32])[0]
        with patch("build_mod.run_audiomog", side_effect=AssertionError("no reencode")):
            self.assertEqual(preserved_alias_audio(dict(stem="line", voice_gpu_key="jp-lock"), ev), ev)
            self.assertEqual(preserved_alias_audio(dict(stem="line", voice_gpu_key="jp-lock"), mv), mv)
            with self.assertRaisesRegex(RuntimeError, "compressed-stream transfer; unsupported"):
                preserved_alias_audio(dict(stem="line", voice_gpu_key="cn-original"), mv)

    def test_locked_rebuild_uses_each_source_layout_and_never_legacy_cache(self):
        import build_mod as b
        import subprocess
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "tmp").mkdir()
            (root / "cache").mkdir()
            (root / "locked.wav").write_bytes(b"selected audio")
            (root / "cache/line-59043.uasset").write_bytes(b"legacy wrong header")
            calls = []
            def audiomog(path):
                path = Path(path)
                if path.suffix == ".uasset":
                    original = path.read_bytes()
                    calls.append(original)
                    project = path.parent / "line_Project"
                    project.mkdir()
                    (project / "line_000.wav").write_bytes(b"probe")
                    (project / "RebuildSettings.json").write_text("{}")
                else:
                    original = (path.parent.parent / "line.uasset").read_bytes()
                    (path.parent / "line.uasset").write_bytes(original + b"new audio bytes!!")
            def command(args, **kw):
                return subprocess.CompletedProcess(args, 0, "32000,1" if args[0] == "ffprobe" else "", "")
            ev, mv = asset([64])[0], asset([64,32])[0]
            with patch.object(b, "BUILD_ROOT", root), patch.object(b, "DATA", root), patch.object(b, "run_audiomog", side_effect=audiomog), patch.object(b.subprocess, "run", side_effect=command):
                first = Path(b.rebuild_locked(("line",59043,"locked.wav",ev.hex())))
                second = Path(b.rebuild_locked(("line",59043,"locked.wav",mv.hex())))
                again = b.rebuild_locked(("line",59043,"locked.wav",ev.hex()))
            self.assertEqual(calls, [ev, mv])
            self.assertEqual(str(first), again)
            self.assertNotEqual(first, second)
            self.assertEqual(first.read_bytes(), repair_audio_exports(ev, ev+b"new audio bytes!!"))
            self.assertEqual(second.read_bytes(), repair_audio_exports(mv, mv+b"new audio bytes!!"))

    def test_source_content_and_audio_content_isolate_all_caches(self):
        from build_mod import source_audio_key
        with tempfile.TemporaryDirectory() as folder:
            wav = Path(folder) / "locked.wav"
            wav.write_bytes(b"audio1")
            ev, mv = asset([64])[0], asset([64, 32])[0]
            first = source_audio_key(ev, [59043, "locked.wav"], [wav])
            self.assertNotEqual(first, source_audio_key(mv, [59043, "locked.wav"], [wav]))
            wav.write_bytes(b"audio2")
            self.assertNotEqual(first, source_audio_key(ev, [59043, "locked.wav"], [wav]))
            # AudioMog output for MV must retain MV's own larger Zen layout.
            _, header = asset([64,32])
            fixed = repair_audio_exports(mv, mv + bytes(16))
            self.assertEqual(fixed[:64], mv[:64])
            self.assertEqual(fixed[header:], mv[header:] + bytes(16))
            validate_zen_exports(fixed)

if __name__ == "__main__":
    unittest.main()


class CompanionSubtitles(unittest.TestCase):
    def test_linked_voice_never_emits_mistaken_override_or_original_text(self):
        from build_mod import packed_subtitle,companion_subtitle_parent
        for row in [dict(stem='child',subtitle_parent_stem='main'),dict(stem='child',extra={'dual_speaker':{'main_stem':'main'}})]:
            row.update(subtitle_text='误存的中文字幕',text_zh='原字幕',tts_text='朗读稿')
            self.assertEqual(companion_subtitle_parent(row),'main')
            self.assertEqual(packed_subtitle(row),'')
            self.assertEqual(row['subtitle_text'],'误存的中文字幕')
        self.assertEqual(packed_subtitle(dict(stem='main',subtitle_text='人工改稿',text_zh='原字幕')),'人工改稿')
        self.assertEqual(packed_subtitle(dict(stem='main',subtitle_parent_stem='main',text_zh='原字幕')),'原字幕')


class OriginalSubtitlePolicy(unittest.TestCase):
    def test_original_cn_required_for_all_tracks_even_with_saved_subtitle_or_draft(self):
        from build_mod import packed_subtitle
        for original in [None, '', '  \n\t', '<i></i><br/>', r'\n']:
            row = dict(stem='ordinary',text_zh=original,subtitle_text='误存字幕',tts_text='制作稿')
            self.assertEqual(packed_subtitle(row),'')
            self.assertEqual(row['subtitle_text'],'误存字幕')
        self.assertEqual(packed_subtitle(dict(stem='ordinary',text_zh='游戏字幕',subtitle_text='修订字幕')),'修订字幕')
        self.assertEqual(packed_subtitle(dict(stem='ordinary',text_zh='游戏字幕',subtitle_text=None)),'游戏字幕')
