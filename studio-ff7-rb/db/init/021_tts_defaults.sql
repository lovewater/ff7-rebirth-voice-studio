-- Speaker-level TTS defaults, and English embedding source.

ALTER TABLE speakers
    ADD COLUMN IF NOT EXISTS tts_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE voice_bank_versions
    DROP CONSTRAINT IF EXISTS voice_bank_versions_source_lang_check;

ALTER TABLE voice_bank_versions
    ADD CONSTRAINT voice_bank_versions_source_lang_check
        CHECK (source_lang IN ('jp', 'cn', 'en'));
