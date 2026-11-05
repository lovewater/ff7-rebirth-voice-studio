-- 群体呼声/环境声可能没有单一人物；保留原声不需要虚构人物。
-- 只放开 jp-lock 原声版本，合成版本仍须有合法 speaker，外键保持不变。
BEGIN;
ALTER TABLE line_tts_versions ALTER COLUMN speaker DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='line_tts_versions'::regclass
      AND conname='line_tts_versions_anonymous_original_only') THEN
    ALTER TABLE line_tts_versions ADD CONSTRAINT line_tts_versions_anonymous_original_only
      CHECK (speaker IS NOT NULL OR voice_gpu_key='jp-lock');
  END IF;
END $$;
COMMENT ON COLUMN line_tts_versions.speaker IS
  '人物可未知：仅 jp-lock 原声版本允许 NULL；合成音频仍须合法人物，不伪造群体/环境声归属。';
COMMIT;
