-- 试听次数：今后按“点击播放”累加，不判断媒体最终是否成功播放。
-- 历史只有 heard_at，无法恢复真实次数；仅首次新增字段时做一次用户指定的概率回填。
-- 字段存在则不再随机赋值，重复执行不会覆盖后续真实点击累计。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'line_tts_versions' AND column_name = 'play_count') THEN
    ALTER TABLE line_tts_versions ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0 CHECK (play_count >= 0);
    WITH sampled AS MATERIALIZED (
      -- 每条只抽一次随机数，四个概率区间分别为 40% / 30% / 20% / 10%。
      SELECT id, random() AS draw FROM line_tts_versions WHERE heard_at IS NOT NULL
    )
    UPDATE line_tts_versions v SET play_count = CASE
      WHEN sampled.draw < 0.4 THEN 1 WHEN sampled.draw < 0.7 THEN 2
      WHEN sampled.draw < 0.9 THEN 3 ELSE 4 END
    FROM sampled WHERE v.id = sampled.id;
  END IF;
END $$;
COMMENT ON COLUMN line_tts_versions.play_count IS '试听播放点击次数；历史已听记录按1/2/3/4=40%/30%/20%/10%一次性随机回填，之后每次点击播放原子+1，不判断播放成功；未听过默认0';
