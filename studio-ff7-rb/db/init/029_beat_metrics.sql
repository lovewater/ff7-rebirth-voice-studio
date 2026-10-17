-- Derived source-audio text metrics only. Never changes TTS adoption or subtitles.
ALTER TABLE line_meta
  ADD COLUMN IF NOT EXISTS beat_jp_hash text,
  ADD COLUMN IF NOT EXISTS beat_cn_hash text,
  ADD COLUMN IF NOT EXISTS beat_version text,
  ADD COLUMN IF NOT EXISTS beat_status text,
  ADD COLUMN IF NOT EXISTS beat_ratio double precision,
  ADD COLUMN IF NOT EXISTS beat_mark text;
