-- Unheard generated clips show as 「新」 until first play.

ALTER TABLE line_tts_versions
    ADD COLUMN IF NOT EXISTS heard_at TIMESTAMPTZ;

UPDATE line_tts_versions
SET heard_at = COALESCE(completed_at, created_at)
WHERE heard_at IS NULL
  AND status = 'ready';
