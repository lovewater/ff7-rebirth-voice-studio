-- 人物未知也可用本句日文做zero-shot；不伪造人物，仍保留人物外键。
-- 只有带本句参考来源记录的zeroshot-jp及其audio-edit派生可为NULL。
BEGIN;
ALTER TABLE line_tts_versions DROP CONSTRAINT IF EXISTS line_tts_versions_anonymous_original_only;
ALTER TABLE line_tts_versions DROP CONSTRAINT IF EXISTS line_tts_versions_anonymous_audio_policy;
ALTER TABLE line_tts_versions ADD CONSTRAINT line_tts_versions_anonymous_audio_policy CHECK (
  speaker IS NOT NULL OR voice_gpu_key='jp-lock' OR COALESCE((
    voice_gpu_key IN ('zeroshot-jp','audio-edit')
    AND conversion_meta->'anonymous_single_line'->>'version'='anonymous-self-reference-v1'
    AND conversion_meta->'anonymous_single_line'->>'stem'=stem
    AND conversion_meta->'anonymous_single_line'->>'context'='none'
    AND conversion_meta->'anonymous_single_line'->>'source_audio_path'='jp/'||stem||'.mp3'
    AND conversion_meta->'anonymous_single_line'->>'source_audio_sha256' ~ '^[a-f0-9]{64}$'
    AND conversion_meta->'anonymous_single_line'->>'reference_audio_sha256' ~ '^[a-f0-9]{64}$'
    AND (conversion_meta->'anonymous_single_line'->>'reference_audio_path'='jp/'||stem||'.mp3'
      OR starts_with(conversion_meta->'anonymous_single_line'->>'reference_audio_path','tts/'||stem||'/'))
  ),false)
);
COMMENT ON COLUMN line_tts_versions.speaker IS
  '人物可未知：jp-lock原声或带本句JP参考证据的zero-shot/编辑派生允许NULL；不猜人物、不给邻句上下文。';
COMMIT;
