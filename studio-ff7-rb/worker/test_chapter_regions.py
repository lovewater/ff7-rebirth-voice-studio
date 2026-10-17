"""章节重命名不能改变已核对的剧情顺序，也不能把地图打进错误章节的MOD。"""
import re
import unittest

from fill_regions import SEED, STORY_ORDER
from build_mod import chapter_map


class ChapterRegions(unittest.TestCase):
    def test_chapters_cover_one_to_fourteen_without_backtracking(self):
        numbers = [int(m.group(1)) for code in STORY_ORDER
                   if (m := re.search(r"第(\d+)章", SEED.get(code, ("",))[0] or ""))]
        self.assertEqual(numbers, sorted(numbers))
        self.assertEqual(set(numbers), set(range(1, 15)))
        self.assertEqual(len(STORY_ORDER), len(set(STORY_ORDER)))

    def test_flashbacks_and_opening_characters_do_not_determine_chapter(self):
        chapters, _ = chapter_map()
        for chapter, codes in {
            9: ["C2710", "C2810", "GONGV", "GONGM", "GONGE", "MTR09"],
            10: ["C2910", "C3010", "CSMOC", "COSME", "GIZOK", "MTR10"],
            11: ["C3110", "NIBLT", "NIBLM", "NIBLS", "NIBLE", "MTR11"],
            12: ["C3210", "C3220", "C3230"],
            13: ["C3310", "C3320", "C3330", "C3340", "TEMPL", "CAPTL"],
            14: ["C3410", "C3510"],
        }.items():
            for code in codes:
                with self.subTest(chapter=chapter, code=code):
                    self.assertIn(code, chapters[chapter])
                    self.assertEqual(sum(code in group for group in chapters.values()), 1)

    def test_world_intel_and_minigames_are_not_added_to_final_chapter(self):
        chapters, extra = chapter_map()
        for code in ["WORLD", "MTRGL", "CARDG", "PHOTO", "PIANO", "VO"]:
            self.assertIn(code, extra)
            self.assertNotIn(code, chapters[14])

    def test_chapter_titles_come_from_official_cn_resident_fields(self):
        # CN/Resident_TxtRes chapter_title_0001至0014，不能再按开头人物取“西德/宝条”。
        official = ["英雄萨菲罗斯", "广阔的世界", "黑斗篷的去向", "新时代的号炮",
                    "狂乱的海上旅行", "太阳乐园", "充满懊悔的归乡", "金碟游乐园",
                    "星球守护者", "峡谷战士", "陌生的故乡", "寻找楔石",
                    "古代种的神殿", "迈向终结的世界"]
        for code, (name, _, _) in SEED.items():
            if not re.match(r"C\d+$", code):
                continue
            if code == "C2620":
                # 独立的扎克斯世界插叙保留无编号名称，不凭文件编号补一个主线章号。
                self.assertEqual(name, "扎克斯的世界")
                continue
            match = re.fullmatch(r"第(\d+)章 · (.+)", name)
            self.assertIsNotNone(match, code)
            self.assertEqual(match.group(2), official[int(match.group(1)) - 1], code)


if __name__ == "__main__":
    unittest.main()
