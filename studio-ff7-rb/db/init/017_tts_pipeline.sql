-- 台词的业务标识始终是 lines.stem；数字主键仅保留作内部行号。
-- lines(stem) 的 UNIQUE 已提供索引；下列补齐外键反向查找。
CREATE INDEX IF NOT EXISTS voice_bank_draft_clips_stem_idx ON voice_bank_draft_clips(stem);
CREATE INDEX IF NOT EXISTS voice_bank_version_clips_stem_idx ON voice_bank_version_clips(stem);
CREATE INDEX IF NOT EXISTS voice_bank_versions_example_stem_idx ON voice_bank_versions(example_stem);
CREATE INDEX IF NOT EXISTS line_tts_versions_voice_version_idx ON line_tts_versions(voice_version_id);

ALTER TABLE voice_bank_versions ADD COLUMN IF NOT EXISTS source_wav_path TEXT;
-- 旧单批次 reference 本来就是全量已选素材的拼接音频，可直接作为修复参考。
UPDATE voice_bank_versions SET source_wav_path = reference_wav_path
WHERE source_wav_path IS NULL AND batch_count = 1 AND status = 'ready';

ALTER TABLE line_tts_versions
  ADD COLUMN IF NOT EXISTS raw_audio_path TEXT,
  ADD COLUMN IF NOT EXISTS manifest_path TEXT;
CREATE INDEX IF NOT EXISTS line_tts_conversion_source_idx
  ON line_tts_versions ((conversion_meta->>'source_id'))
  WHERE conversion_meta IS NOT NULL;
