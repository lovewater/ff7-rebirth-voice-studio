#!/usr/bin/env python3
"""Seed regions table from filename prefixes. Does not overwrite source=manual."""

from __future__ import annotations

import os
from pathlib import Path

import psycopg

DSN = os.environ.get("DATABASE_URL", "")

# code -> (name_zh, name_jp, note)
SEED: dict[str, tuple[str, str | None, str]] = {
    "GRASE": ("格拉斯兰", "グラスランド", "开放区"),
    "GRASA": ("格拉斯兰", "グラスランド", "牧场一带"),
    "KALMT": ("卡尔姆", "カーム", ""),
    "SWAMP": ("沼泽", "沼地", "中部沼泽"),
    "MYTHM": ("秘银矿坑", "ミスリル鉱山", ""),
    "JUNOE": ("珠诺地区", "ジュノンエリア", ""),
    "JUNOA": ("侧珠诺", "サイドジュノン", ""),
    "JNONT": ("珠诺上城区", "ジュノン", ""),
    "JNONV": ("珠诺村", "ジュノンの村", ""),
    "JUNOV": ("珠诺", "ジュノン", "战斗过场"),
    "FERRY": ("货轮", "フェリー", "第5章"),
    "COSTT": ("太阳海岸", "コスタ・デル・ソル", ""),
    "COSME": ("星殒地区", "コスモキャニオン", "宇宙峡谷一带"),
    "CSMOC": ("第10章 · 星殒峡谷", "コスモキャニオン", "第10章从星殒峡谷地图算起。C2630 是科雷陆监狱"),
    "CORLE": ("科雷尔地区", "コレル", ""),
    "CORLV": ("北科雷尔村", "北コレル", ""),
    "CORLM": ("科雷尔矿山", "コレル炭鉱", ""),
    "GOLDE": ("金碟", "ゴールドソーサー", ""),
    "GOLDS": ("金碟游乐场", "ゴールドソーサー", ""),
    "UNDRS": ("金碟下层", "ゴールドソーサー地下", "尘暴镇的地图和任务。监狱演出在 C2630"),
    "GONGE": ("贡加加地区", "ゴンガガ", ""),
    "GONGV": ("贡加加村", "ゴンガガ村", ""),
    "GONGM": ("贡加加魔晄炉", "ゴンガガ魔晄炉", ""),
    "GIZOK": ("吉族遗迹", "ギ族の遺跡", ""),
    "NIBLE": ("尼福尔地区", "ニブル", ""),
    "NIBLT": ("尼福尔海姆", "ニブルヘイム", ""),
    "NIBLM": ("神罗公馆", "神羅屋敷", ""),
    "NIBLS": ("尼福尔山", "ニブル山", ""),
    "TEMPL": ("古代种神殿", "古代種の神殿", ""),
    "CAPTL": ("神殿 · 神罗", None, "神殿后段神罗相关过场"),
    "MIDGR": ("米德加", "ミッドガル", ""),
    "CHADL": ("查德利", "チャドリー", "台词已按古代物质任务拆走"),
    "MTR02": ("第2章 · 古代物质", None, "格拉斯兰。盗窃团带着古代物质逃亡"),
    "MTR04": ("第4章 · 古代物质", None, "珠诺区。古代物质被兀鹰堡垒的世界吸收"),
    "MTR07": ("第7章 · 古代物质", None, "科雷尔沙漠的仙人掌岩，以及基德G的挑战"),
    "MTR09": ("第9章 · 古代物质", None, "贡加加。古代物质保存在训练设施的数据里"),
    "MTR10": ("第10章 · 古代物质", None, "星殒峡谷的遗迹群，用来封印古代物质"),
    "MTR11": ("第11章 · 古代物质", None, "尼福尔海姆。黑斗篷身上有古代物质的反应"),
    "MTRGL": ("古代物质 · 吉尔伽美什岛", None, "集齐后出现的岛。源氏套装和吉尔伽美什，不属于某一章"),
    "CARDG": ("女王之血", "クイーンズブラッド", ""),
    "WORLD": ("世界情报", "ワールドレポート", ""),
    "PHOTO": ("拍照", "フォト", "风景拍照任务"),
    "PIANO": ("钢琴", "ピアノ", ""),
    "SHOOT": ("宇宙骑士射击", "シューティング", ""),
    "MOGLE": ("莫古利商店", "モーグリショップ", ""),
    "COMMN": ("吉尔伽美什", "ギルガメッシュ", "传说剑豪战"),
    "VO": ("战斗语音", "バトルVO", "无字幕居多"),
    "MV": ("影片", "ムービー", ""),
    "C1910": ("第1章 · 坠落的英雄", None, "尼福尔海姆回忆"),
    "C1920": ("第2章 · 卡尔姆", None, ""),
    "C2010": ("第2章 · 格拉斯兰", None, ""),
    "C2110": ("第3章 · 追踪黑斗篷", None, ""),
    "C2120": ("第4章 · 下珠诺", None, ""),
    "C2210": ("第4章 · 珠诺", None, "阅兵/上城"),
    "C2310": ("第6章 · 太阳海岸", None, "显示名。文件名 C2410 是太阳海岸演出，归到这里；文件名 C2310 是船上的女王之血，归 C2320"),
    "C2320": ("第5章 · 货轮", None, "货轮遇袭。文件名 C2310 的女王之血大赛也归这里"),
    "C2410": ("第8章 · 金碟", None, "金碟演出。文件名 C2410 已归 C2310；留在这里的是从 C2610 拆来的金碟"),
    "C2480": ("第8章 · 金碟约会", None, "不是文件名。C2620 从 0200 起到送去科雷尔监狱，是第8章夜里的约会。0100 仍归扎克斯的世界"),
    "C2510": ("第7章 · 科雷尔山", None, "离开太阳海岸后的登山，到北科雷尔之前。巴雷特说的是科雷尔魔晄炉，不是贡加加"),
    "C2520": ("第7章 · 北科雷尔", None, ""),
    "C2610": ("第9章 · 贡加加", None, "文件名前缀。台词已按演出拆走：金碟归 C2410，扎克斯世界归 C2620"),
    "C2620": ("扎克斯的世界", None, "生命之流一侧。这份文件里只留 0100 那句梦话；金碟约会在 C2480"),
    "C2630": ("第8章 · 科雷陆监狱", None, "金碟下层的监狱演出，从进门到戴因和逃走。名字跟字幕一样用科雷陆。不是星殒峡谷"),
    "C2710": ("第11章 · 神罗", None, "待核对"),
    "C2810": ("第11章 · 尼福尔海姆", None, "蒂法童年"),
    "C2910": ("第11章 · 西德", None, "待核对"),
    "C3010": ("第13章 · 神殿试炼", None, "毕格斯回忆"),
    "C3110": ("第11章 · 尼福尔海姆", None, "终端机/凯特西"),
    "C3210": ("第12章 · 反神罗", None, "待核对"),
    "C3220": ("第13章 · 回忆", None, "艾米娜/爱丽丝"),
    "C3230": ("第12章 · 金碟约会", None, "LOVELESS"),
    "C3310": ("第13章 · 北上", None, ""),
    "C3320": ("第13章 · 古代种神殿", None, ""),
    "C3330": ("第14章 · 忘却之都", None, ""),
    "C3340": ("第14章 · 忘却之都", None, "赛特拉"),
    "C3410": ("第13章 · 宝条", None, "待核对"),
    "C3510": ("第14章 · 再结合", None, "萨菲罗斯"),
}

# Story / map progression. Gaps of 10 so rows can be moved in pgAdmin.
STORY_ORDER = [
    "MIDGR",
    "C1910",
    "C1920",
    "KALMT",
    "C2010",
    "GRASE",
    "GRASA",
    "MTR02",
    "C2110",
    "SWAMP",
    "MYTHM",
    "C2120",
    "JUNOA",
    "JUNOV",
    "JNONV",
    "JNONT",
    "JUNOE",
    "C2210",
    "MTR04",
    "C2320",
    "FERRY",
    "C2310",
    "COSTT",
    "C2510",
    "C2520",
    "CORLV",
    "CORLM",
    "CORLE",
    "MTR07",
    "C2410",
    "C2480",
    "GOLDE",
    "GOLDS",
    "UNDRS",
    "C2630",
    "C2610",
    "GONGV",
    "GONGM",
    "GONGE",
    "MTR09",
    "CSMOC",
    "COSME",
    "MTR10",
    "GIZOK",
    "C2620",
    "C2710",
    "C2810",
    "C2910",
    "C3110",
    "NIBLT",
    "NIBLM",
    "NIBLS",
    "NIBLE",
    "MTR11",
    "C3210",
    "C3230",
    "C3010",
    "C3220",
    "C3310",
    "C3320",
    "C3410",
    "TEMPL",
    "CAPTL",
    "C3330",
    "C3340",
    "C3510",
    "WORLD",
    "MTRGL",
    "CHADL",
    "CARDG",
    "PHOTO",
    "PIANO",
    "SHOOT",
    "MOGLE",
    "COMMN",
    "VO",
    "MV",
]


def main() -> int:
    schema = Path(__file__).resolve().parents[1] / "db" / "init" / "004_regions.sql"
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(schema.read_text())
            cur.execute("SELECT DISTINCT region FROM lines WHERE region IS NOT NULL AND region <> ''")
            codes = [r[0] for r in cur.fetchall()]
            order_of = {code: (i + 1) * 10 for i, code in enumerate(STORY_ORDER)}
            rows = []
            for code in codes:
                zh, jp, note = SEED.get(code, (None, None, ""))
                sort = order_of.get(code, 9000)
                rows.append((code, zh, jp, note, "seed" if zh else "empty", sort))
            cur.executemany(
                """
                INSERT INTO regions (code, name_zh, name_jp, note, source, sort_order, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (code) DO UPDATE SET
                    name_zh = CASE
                        WHEN regions.source IS DISTINCT FROM 'manual'
                        THEN COALESCE(EXCLUDED.name_zh, regions.name_zh)
                        ELSE regions.name_zh END,
                    name_jp = CASE
                        WHEN regions.source IS DISTINCT FROM 'manual'
                        THEN COALESCE(EXCLUDED.name_jp, regions.name_jp)
                        ELSE regions.name_jp END,
                    note = CASE
                        WHEN regions.source IS DISTINCT FROM 'manual'
                        THEN COALESCE(NULLIF(EXCLUDED.note, ''), regions.note)
                        ELSE regions.note END,
                    source = CASE
                        WHEN regions.source IS DISTINCT FROM 'manual'
                        THEN EXCLUDED.source ELSE regions.source END,
                    sort_order = EXCLUDED.sort_order,
                    updated_at = now()
                """,
                rows,
            )
            cur.execute("SELECT COUNT(*) FILTER (WHERE name_zh IS NOT NULL), COUNT(*) FROM regions")
            named, total = cur.fetchone()
        conn.commit()
    print(f"regions {named}/{total} named")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
