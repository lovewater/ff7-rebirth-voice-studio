-- Persistent records for every speaker-embedding build.  Versions are kept
-- without a count limit; generated files live under website/data/embedded.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'voice_bank_versions' AND column_name = 'embed_pt'
    ) THEN
        ALTER TABLE voice_bank_versions RENAME COLUMN embed_pt TO embedding_path;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'voice_bank_versions' AND column_name = 'embed_wav'
    ) THEN
        ALTER TABLE voice_bank_versions RENAME COLUMN embed_wav TO reference_wav_path;
    END IF;
END $$;

ALTER TABLE voice_bank_versions
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('building', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS gpu_speaker_key TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS result_dir TEXT,
    ADD COLUMN IF NOT EXISTS manifest_path TEXT,
    ADD COLUMN IF NOT EXISTS batch_count INT,
    ADD COLUMN IF NOT EXISTS similarity_min DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS similarity_mean DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS similarity_max DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS example_stem TEXT REFERENCES lines(stem) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS example_emo_alpha DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS example_zh_path TEXT,
    ADD COLUMN IF NOT EXISTS example_ja_path TEXT,
    ADD COLUMN IF NOT EXISTS error TEXT,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS voice_bank_versions_status_idx
    ON voice_bank_versions (status, created_at DESC);

ALTER TABLE voice_bank_version_clips
    ADD COLUMN IF NOT EXISTS ordinal INT,
    ADD COLUMN IF NOT EXISTS batch_no INT;

DROP FUNCTION IF EXISTS voice_bank_prune_versions(INT);
