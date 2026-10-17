-- Persist Seed-ASR so the same audio file is never billed twice.
-- JP original lives on line_meta; each generated clip lives on line_tts_versions.
-- JSON includes sha256 of the audio bytes; a different file must be recognized again.
ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS seed_asr JSONB;

ALTER TABLE line_tts_versions
    ADD COLUMN IF NOT EXISTS seed_asr JSONB;

CREATE INDEX IF NOT EXISTS line_meta_seed_asr_sha256_idx
    ON line_meta ((seed_asr->>'sha256'))
    WHERE seed_asr IS NOT NULL;

CREATE INDEX IF NOT EXISTS line_tts_versions_seed_asr_sha256_idx
    ON line_tts_versions ((seed_asr->>'sha256'))
    WHERE seed_asr IS NOT NULL;
