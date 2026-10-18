-- dae 的官方姓名来自支线自我介绍 NIBLE_QST_02_0300_2790_00_dae：
-- 中文“呵呵，我叫达耶／是这里的主厨”；日文“ふふん 私はダーエ／ここの料理長よ”。
-- 主线字幕中的“主厨”是称谓，不应作为该角色的唯一姓名。
-- 标记 manual，防止之后重跑角色名导入覆盖已经核实的对应关系。
INSERT INTO speakers (code, name_zh, name_jp, source, note, updated_at)
VALUES ('dae', '达耶', 'ダーエ', 'manual',
        '姓名核对：NIBLE_QST_02_0300_2790_00_dae 官方中日字幕自我介绍；尼福尔海姆主厨。', now())
ON CONFLICT (code) DO UPDATE SET
    name_zh = EXCLUDED.name_zh,
    name_jp = EXCLUDED.name_jp,
    source = EXCLUDED.source,
    note = EXCLUDED.note,
    updated_at = now();
