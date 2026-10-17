"""Boundary regressions for the shared website/CLI beat rules."""
import unittest
from unittest.mock import patch
from mora_core import analyze_pair, japanese_characters, japanese_metrics, japanese_speech_reading, mora_count, punctuation_estimate


class BeatRules(unittest.TestCase):
    def tearDown(self):
        japanese_metrics.cache_clear()
        japanese_speech_reading.cache_clear()

    def test_five_characters_never_call_reader(self):
        with patch("mora_core.japanese_reading") as reader:
            result = analyze_pair("日本語の文。！？\n", "你好。")
        reader.assert_not_called()
        self.assertEqual(result["jp"]["characters"], 5)
        self.assertIsNone(result["jp"]["mora"])
        self.assertIsNone(result["ratio"])

    def test_short_speech_reading_is_opt_in_and_keeps_ratio_disabled(self):
        with patch("mora_core.japanese_reading", return_value=("おとりか", 4, "おとりか", 4, [])):
            speech = japanese_speech_reading("オトリか！")
            ordinary = analyze_pair("オトリか！", "诱饵吗！")
        self.assertEqual(speech, {"status": "ok", "mora": 4, "reading": "おとりか"})
        self.assertEqual(ordinary["jp"]["status"], "short")
        self.assertIsNone(ordinary["jp"]["mora"])
        self.assertIsNone(ordinary["normalizedRatio"])

    def test_uncertain_short_speech_reading_is_not_reliable_rate_evidence(self):
        with patch("mora_core.japanese_reading", return_value=("おとりか", 4, "おとり", 3, [])):
            self.assertEqual(japanese_speech_reading("オトリか！")["status"], "review_reading")

    def test_six_and_seven_characters_are_exempt_including_real_case(self):
        for text in ["これでよしと", "あいうえおかき", "「これでよしと」，！？"]:
            with self.subTest(text=text), patch("mora_core.japanese_reading") as reader:
                result = analyze_pair(text, "这样就可以了")
            reader.assert_not_called()
            self.assertEqual(result["jp"]["status"], "short")
            self.assertIsNone(result["normalizedRatio"])
            self.assertIsNone(result["mark"])

    def test_eight_characters_are_calculated(self):
        with patch("mora_core.japanese_reading", return_value=("あいうえおかきく", 8, "あいうえおかきく", 8, [])):
            result = analyze_pair("あいうえおかきく。", "你好，朋友。")
        self.assertEqual(result["jp"]["units"], 8)
        self.assertEqual(result["jp"]["weightedMora"], 8)
        self.assertEqual(result["jp"]["weightStatus"], "uncalibrated")
        self.assertEqual(result["cn"]["units"], 5.5)
        self.assertAlmostEqual(result["ratio"], 8 / 5.5)

    def test_all_terminal_punctuation_is_free(self):
        for text in ["你好。", "你好……！？」  ", "你好～", "你好。\n"]:
            self.assertEqual(punctuation_estimate(text), 0)

    def test_subtitle_newline_is_not_an_utterance_end(self):
        self.assertEqual(punctuation_estimate("你好。\n朋友。"), 1.5)
        self.assertEqual(punctuation_estimate("你好，朋友。！？"), 1.5)

    def test_name_separator_is_not_a_pause(self):
        self.assertEqual(punctuation_estimate("コスタ・デル・ソル"), 0)
        self.assertEqual(punctuation_estimate("克劳德·斯特莱夫"), 0)
        self.assertEqual(punctuation_estimate("你好，克劳德·斯特莱夫。"), 1.5)
        self.assertEqual(japanese_characters("あ・い"), 2)

    def test_japanese_chinese_and_english_quotes_are_not_pauses(self):
        for text in ['名叫「诱饵作战」哦！', '名叫『诱饵作战』哦！', '名叫“诱饵作战”哦！',
                     '名叫‘诱饵作战’哦！', '名叫"诱饵作战"哦！', "名叫'诱饵作战'哦！",
                     '名叫｢诱饵作战｣哦！', '名叫＂诱饵作战＂哦！']:
            self.assertEqual(punctuation_estimate(text), 0, text)
        self.assertEqual(punctuation_estimate('名叫“诱饵作战”，听好了！'), 1.5)
        self.assertEqual(punctuation_estimate('その名も『オトリ作戦』だ！'), 0)
        self.assertEqual(punctuation_estimate('“等等！”他说'), 1.5)

    def test_quote_only_change_keeps_beats_and_ratio_identical(self):
        with patch("mora_core.japanese_reading", return_value=("あいうえおかきく", 8, "あいうえおかきく", 8, [])):
            a = analyze_pair('あいうえおかきく', '名叫诱饵作战哦')
            b = analyze_pair('あいう『えお』かきく', '名叫“诱饵作战”哦')
        self.assertEqual(a['jp']['units'], b['jp']['units'])
        self.assertEqual(a['cn']['units'], b['cn']['units'])
        self.assertEqual(a['normalizedRatio'], b['normalizedRatio'])

    def test_tts_controls_are_not_han_or_punctuation(self):
        r = analyze_pair("", "你好，[停顿=500]朋友。")
        self.assertEqual(r["cn"], {"han": 4, "punctuation": 1.5, "units": 5.5})
        self.assertEqual(r["jp"]["status"], "missing")

    def test_small_kana_sokuon_nasal_long_vowel(self):
        self.assertEqual(mora_count("キャット"), 3)
        self.assertEqual(mora_count("コーヒー"), 4)
        self.assertEqual(mora_count("にほん"), 3)


if __name__ == "__main__":
    unittest.main()
