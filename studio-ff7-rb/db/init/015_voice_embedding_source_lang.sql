-- Record which side supplied the timbre reference audio for each embedding.
-- Existing versions were built from website/data/cn, so the backfill is cn.

ALTER TABLE voice_bank_versions
    ADD COLUMN IF NOT EXISTS source_lang TEXT NOT NULL DEFAULT 'cn'
        CHECK (source_lang IN ('jp', 'cn'));
