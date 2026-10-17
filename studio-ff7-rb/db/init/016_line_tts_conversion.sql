-- Optional provenance for derived voice-conversion results. Original IDs and
-- input hashes survive deletion of the source history entry.
ALTER TABLE line_tts_versions
    ADD COLUMN IF NOT EXISTS conversion_meta JSONB;
