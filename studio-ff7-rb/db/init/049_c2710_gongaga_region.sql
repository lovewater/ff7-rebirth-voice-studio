-- 游戏原始CN/Resident_TxtRes：chapter_title_0009=星球守护者，0011=陌生的故乡。
-- CN/8500-GONGE_TxtRes包含C2710主体：抵达贡加加至魔晄炉战斗、蒂法坠入魔晄。
-- 原“第11章·神罗”为未核对seed；只修正显示名称和排序，不改stem、音频或字幕。
-- 2026-10-17 用户要求当前C2710自动批次结束后再应用；已确认321/321且active为空。
UPDATE regions SET
  name_zh = '第9章 · 贡加加',
  note = '已核对游戏CN字幕：主体在8500-GONGE_TxtRes，属第9章“星球守护者”的贡加加主线；开头含神罗和扎克斯插叙。原名“第11章 · 神罗”为未核对占位名。',
  source = 'manual',
  sort_order = 310,
  updated_at = now()
WHERE code = 'C2710';
