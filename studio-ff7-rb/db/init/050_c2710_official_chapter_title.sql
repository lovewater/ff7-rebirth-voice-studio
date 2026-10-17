-- 用户指定采用游戏官方章节标题；仅更新名称，保留已核对的顺序和区域归属。
UPDATE regions SET name_zh='第9章 · 星球守护者',source='manual',updated_at=now()
WHERE code='C2710';
