-- 工作流归属与展示层级分开保存；source_id 只说明编辑来源，不能代表整个工作流。
ALTER TABLE line_tts_versions ADD COLUMN IF NOT EXISTS auto_run_id BIGINT;
ALTER TABLE line_tts_versions ADD COLUMN IF NOT EXISTS parent_tts_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS line_tts_versions_stem_id_unique ON line_tts_versions (stem, id);
CREATE UNIQUE INDEX IF NOT EXISTS line_auto_runs_stem_id_unique ON line_auto_runs (stem, id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tts_workflow_same_stem_fk') THEN
    ALTER TABLE line_tts_versions ADD CONSTRAINT tts_workflow_same_stem_fk
      FOREIGN KEY (stem, auto_run_id) REFERENCES line_auto_runs (stem, id) ON DELETE SET NULL (auto_run_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tts_parent_same_stem_fk') THEN
    -- 删除父音频只解除关系；子音频、试听和锁定记录必须保留。
    ALTER TABLE line_tts_versions ADD CONSTRAINT tts_parent_same_stem_fk
      FOREIGN KEY (stem, parent_tts_id) REFERENCES line_tts_versions (stem, id) ON DELETE SET NULL (parent_tts_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tts_parent_not_self') THEN
    ALTER TABLE line_tts_versions ADD CONSTRAINT tts_parent_not_self CHECK (parent_tts_id IS DISTINCT FROM id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS line_tts_versions_auto_run_idx ON line_tts_versions (auto_run_id) WHERE auto_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS line_tts_versions_parent_idx ON line_tts_versions (parent_tts_id) WHERE parent_tts_id IS NOT NULL;
COMMENT ON COLUMN line_tts_versions.auto_run_id IS '生成该音频的自动工作流；候选和拼接产物均登记，不根据时间或相邻编号猜归属';
COMMENT ON COLUMN line_tts_versions.parent_tts_id IS '收折展示的父音频；最终产物为根，其他同工作流音频为子级；删除父级不删除子级';
