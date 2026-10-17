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
    "CSMOC": ("星殒峡谷", "コスモキャニオン", "第10章地图区域；正式章节标题为峡谷战士，主线演出在C2910和C3010。"),
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
    "C1910": ("第1章 · 英雄萨菲罗斯", None, "开篇米德加序幕、卡姆旅馆讲述五年前尼福尔事件；标题取Resident_TxtRes chapter_title_0001。"),
    "C1920": ("第2章 · 广阔的世界", None, "卡姆清晨至逃离城镇；与C2010同属第2章。"),
    "C2010": ("第2章 · 广阔的世界", None, "格拉斯兰荒野至米德加尔特巨蛇；与C1920同属第2章。"),
    "C2110": ("第3章 · 黑斗篷的去向", None, "秘银矿坑内追踪黑斗篷，出口通往珠诺地区。"),
    "C2120": ("第4章 · 新时代的号炮", None, "下珠诺、普莉希拉及海豚至登上珠诺；与C2210同属第4章。"),
    "C2210": ("第4章 · 新时代的号炮", None, "珠诺阅兵、总裁仪式至登船；与C2120同属第4章。"),
    "C2310": ("第6章 · 太阳乐园", None, "太阳海岸度假至尤菲加入；实际文件前缀C2410，不据文件编号猜章节。"),
    "C2320": ("第5章 · 狂乱的海上旅行", None, "货轮上的女王之血大赛与遇袭；实际文件前缀含C2310和C2320。"),
    "C2410": ("第8章 · 金碟游乐园", None, "初到金碟游乐园；实际文件前缀C2610。"),
    "C2480": ("第8章 · 金碟游乐园", None, "第一次金碟夜游及袭击事件，随后前往科雷陆监狱；实际文件前缀C2620。"),
    "C2510": ("第7章 · 充满懊悔的归乡", None, "科雷陆登山、魔晄炉和矿山途中；与C2520同属第7章。"),
    "C2520": ("第7章 · 充满懊悔的归乡", None, "返回北科雷陆、巴雷特往事与悔恨；与C2510同属第7章。"),
    "C2610": ("第9章 · 星球守护者", None, "历史文件前缀别名；已按实际剧情归到C2410或C2620，当前没有独立台词。"),
    "C2620": ("扎克斯的世界", None, "生命之流一侧。这份文件里只留 0100 那句梦话；金碟约会在 C2480"),
    "C2630": ("第8章 · 金碟游乐园", None, "科雷陆监狱、戴因、陆行鸟赛至离开监狱；仍属第8章。"),
    "C2710": ("第9章 · 星球守护者", None, "贡加加主线前半，含神罗/扎克斯插叙，至蒂法坠入魔晄；CN/8500-GONGE_TxtRes。"),
    "C2810": ("第9章 · 星球守护者", None, "贡加加主线后半：生命之流中的童年回忆、蒂法获救、贡加加谈心至初遇希德乘飞机；CN/8500-GONGE_TxtRes。回忆地名不代表当前章节。"),
    "C2910": ("第10章 · 峡谷战士", None, "抵达星殒峡谷、纳纳奇回乡、布根哈根、送星仪式与战士试炼至义族船；CN/8600-COSME_TxtRes。希德只占开场，原第11章西德为误标。"),
    "C3010": ("第10章 · 峡谷战士", None, "第10章后半，含扎克斯与毕格斯插叙、义族村落及黑魔晶石来历，返回峡谷后飞往尼福尔海姆；CN/8600-COSME与4000-MIDGR。原第13章神殿试炼为误标。"),
    "C3110": ("第11章 · 陌生的故乡", None, "返回重建的尼福尔海姆、尼福尔山及神罗公馆、凯特西终端机、文森特，至准备回金碟找楔石；CN/8700-NIBLE_TxtRes。"),
    "C3210": ("第12章 · 寻找楔石", None, "回金碟寻找楔石，含反神罗广播插叙；原名以开场反神罗代替全章，不准确。"),
    "C3220": ("第12章 · 寻找楔石", None, "第12章扎克斯世界插叙：玛琳告知爱丽丝的命运，扎克斯准备救治克劳德、寻找毕格斯；CN/4000-MIDGR。原第13章回忆为误标。"),
    "C3230": ("第12章 · 寻找楔石", None, "第12章第二次金碟约会、LOVELESS、特别赛、凯特西与楔石，至追踪塔克斯前往神殿。"),
    "C3310": ("第13章 · 古代种的神殿", None, "第13章北上及神殿前段，追踪神罗飞机至进入神殿；CN/8800-FOREE_TxtRes。"),
    "C3320": ("第13章 · 古代种的神殿", None, "第13章古代种神殿中段，分队探索、机关及塔克斯战斗；CN/8800-FOREE_TxtRes。"),
    "C3330": ("第13章 · 古代种的神殿", None, "第13章神殿试炼、伙伴创伤回忆与克劳德的空壳人偶；CN/8800-FOREE_TxtRes。并未抵达忘却之都，原第14章误标。"),
    "C3340": ("第13章 · 古代种的神殿", None, "第13章神殿后段，赛特拉与杰诺瓦历史、黑魔晶石及神殿崩塌；CN/8800-FOREE_TxtRes。原第14章忘却之都误标。"),
    "C3410": ("第14章 · 迈向终结的世界", None, "第14章多世界开场：神罗撤离神殿后的谈话、扎克斯分岔、爱丽丝梦中约会与教堂白魔晶石；CN/4000-MIDGR。宝条仅在开头出现，原第13章宝条为误标。"),
    "C3510": ("第14章 · 迈向终结的世界", None, "第14章世界交会、沉睡森林、忘却之都、最终战及结局；CN/8800-FOREE_TxtRes。"),
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
    "C2620",
    "C2480",
    "GOLDE",
    "GOLDS",
    "UNDRS",
    "C2630",
    "C2610",
    "C2710",
    "C2810",
    "GONGV",
    "GONGM",
    "GONGE",
    "MTR09",
    "C2910",
    "CSMOC",
    "COSME",
    "MTR10",
    "GIZOK",
    "C3010",
    "C3110",
    "NIBLT",
    "NIBLM",
    "NIBLS",
    "NIBLE",
    "MTR11",
    "C3210",
    "C3220",
    "C3230",
    "C3310",
    "C3320",
    "C3330",
    "C3340",
    "TEMPL",
    "CAPTL",
    "C3410",
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
