"""Display names for filename prefixes in the CN voice pack."""

REGION_NAMES = {
    "GRASE": "格拉斯兰",
    "JUNOE": "朱诺",
    "JNONT": "朱诺城镇",
    "JNONV": "朱诺村",
    "CORLE": "科雷尔",
    "CORLV": "科雷尔村",
    "GOLDS": "金碟游乐场",
    "GOLDE": "金碟",
    "GONGE": "贡加加",
    "GONGV": "贡加加村",
    "COSME": "宇宙峡谷",
    "COSTT": "宇宙峡谷城镇",
    "CSMOC": "宇宙峡谷",
    "NIBLE": "尼贝尔",
    "NIBLT": "尼贝尔城镇",
    "CHADL": "查德利",
    "WORLD": "世界情报",
    "CARDG": "女王之血卡牌",
    "FERRY": "渡轮",
    "UNDRS": "下层",
    "KALMT": "卡尔姆",
}

SPEAKER_NAMES = {
    "cld": "克劳德",
    "tif": "蒂法",
    "art": "爱丽丝",
    "blt": "巴雷特",
    "bar": "巴雷特",
    "yfi": "尤菲",
    "red": "赤红XIII",
    "nnk": "纳纳基",
    "grm": "迦姆",
    "pkw": "海盗王",
    "cat": "凯特西",
    "cid": "西德",
    "sep": "萨菲罗斯",
    "chd": "查德利",
    "dio": "迪奥",
    "zax": "扎克斯",
    "gil": "吉尔伽美什",
    "eln": "艾莲娜",
    "jny": "约翰尼",
    "bgh": "布根哈根",
    "mma": "男NPC",
    "mfa": "女NPC",
    "mmk": "少年",
    "mfk": "少女",
    "skm": "神罗兵",
    "sma": "男店员",
    "sfa": "女店员",
    "csn": "西斯妮",
    "ruf": "路法斯",
    "vin": "文森特",
    "hjo": "宝条",
    "lud": "路德",
    "ren": "雷诺",
    "tsu": "曾",
    "scr": "史卡蕾特",
    "plm": "帕尔默",
    "hyd": "海德格",
    "rch": "罗榭",
    "kre": "琪里耶",
    "msg": "MAI",
    "mrn": "玛琳",
    "big": "毕格斯",
    "jec": "杰西",
    "dyn": "戴因",
}


# C2610 is the asset prefix, not the place. The file is Gold Saucer cutscenes.
# Three performances are Zack's Midgar interlude (Elmyra, Marlene, the book and materia),
# not Gongaga and not the saucer. A reimport must keep this split.
C2610_ZACK_WORLD = frozenset({
    "C2610_MAIN_3000",
    "C2610_MAIN_3200",
    "C2610_MAIN_3400",
})


# CHADL is not one place. Each quest file is one region's protorelic story.
# 03 is the Corel desert: cactus stones and Kid G's challenge.
CHADL_QUEST_REGION = {
    "01": "MTR02",
    "02": "MTR04",
    "03": "MTR07",
    "04": "MTR09",
    "05": "MTR10",
    "06": "MTR11",
    "07": "MTRGL",
}


def place_region(stem: str) -> str | None:
    if stem.startswith("CHADL_QST_"):
        parts = stem.split("_")
        if len(parts) >= 3 and parts[2] in CHADL_QUEST_REGION:
            return CHADL_QUEST_REGION[parts[2]]
    # The C2310 file is the Shinra-8 Queen's Blood tournament, still at sea
    # on the way to Costa del Sol. It belongs with the chapter 5 ship scenes.
    if stem.startswith("C2310_"):
        return "C2320"
    # The C2410 file is Costa del Sol itself: arrival, Johnny's hotel, the beach,
    # Hojo, and Yuffie joining. The Gold Saucer scenes that share this region
    # code came from C2610 and keep the C2610 stem.
    if stem.startswith("C2410_"):
        return "C2310"
    # C2620_MAIN_0100 is Zack's "真的真的", the dream Cloud wakes from.
    # From 0200 the same file is the chapter 8 Gold Saucer date: the partner
    # visits the hotel, they walk the park, and Dio sends them to the prison.
    if stem.startswith("C2620_"):
        parts = stem.split("_")
        if len(parts) >= 3 and parts[1] == "MAIN" and parts[2].isdigit() and int(parts[2]) >= 200:
            return "C2480"
        return "C2620"
    parts = stem.split("_")
    if len(parts) < 3 or parts[0] != "C2610" or parts[1] != "MAIN":
        return None
    perf = "_".join(parts[:3])
    if perf in C2610_ZACK_WORLD:
        return "C2620"
    return "C2410"


def parse_stem(stem: str) -> dict:
    parts = stem.split("_")
    prefix = parts[0] if parts else ""
    speaker = parts[-1] if parts else ""
    kind = "对话"
    tok = parts[1] if len(parts) > 1 else ""
    if tok == "NPC" or "NPC" in parts:
        kind = "NPC"
    elif tok == "BOS" or any(p.upper().startswith("BTL") or p.lower().startswith("bt") for p in parts):
        kind = "战斗"
    elif tok in ("CDV", "MGV", "PCV"):
        kind = "旁白"
    elif tok == "MAIN" and parts[-1] == "red" and len(parts) > 2 and parts[2] in ("0050", "9000"):
        kind = "旁白"
    return {
        "region": place_region(stem) or prefix,
        "region_name": REGION_NAMES.get(prefix, prefix),
        "speaker": speaker,
        "speaker_name": SPEAKER_NAMES.get(speaker, speaker),
        "kind": kind,
    }
