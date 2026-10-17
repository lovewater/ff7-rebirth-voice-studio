-- Per-line TTS history. Every generation is immutable and ordered by its
-- auto-increment id. A line may have one manually selected mod output.

CREATE TABLE IF NOT EXISTS line_tts_versions (
    id                     BIGSERIAL PRIMARY KEY,
    stem                   TEXT NOT NULL REFERENCES lines(stem) ON DELETE CASCADE,
    speaker                TEXT NOT NULL REFERENCES speakers(code) ON DELETE RESTRICT,
    voice_version_id       INT REFERENCES voice_bank_versions(id) ON DELETE SET NULL,
    voice_gpu_key          TEXT NOT NULL,
    tts_text               TEXT NOT NULL CHECK (btrim(tts_text) <> ''),
    spoken_text            TEXT NOT NULL CHECK (btrim(spoken_text) <> ''),
    subtitle_text          TEXT,
    jp_text_snapshot       TEXT,
    game_zh_text_snapshot  TEXT,
    duration_factor        DOUBLE PRECISION NOT NULL DEFAULT 1.0
                               CHECK (duration_factor BETWEEN 0.5 AND 2.0),
    emo_alpha              DOUBLE PRECISION NOT NULL DEFAULT 0.5
                               CHECK (emo_alpha BETWEEN 0.0 AND 1.0),
    audio_path             TEXT,
    audio_bytes            BIGINT,
    start_s                DOUBLE PRECISION,
    end_s                  DOUBLE PRECISION,
    dur_s                  DOUBLE PRECISION,
    speech_s               DOUBLE PRECISION,
    is_used                BOOLEAN NOT NULL DEFAULT false,
    used_at                TIMESTAMPTZ,
    status                 TEXT NOT NULL DEFAULT 'building'
                               CHECK (status IN ('building', 'ready', 'failed')),
    error                  TEXT,
    engine_model_version   TEXT,
    engine_model_revision  TEXT,
    engine_source_revision TEXT,
    engine_package_version TEXT,
    engine_precision       TEXT,
    engine_device          TEXT,
    engine_url             TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at           TIMESTAMPTZ
);

-- The table may already exist when this migration is applied during active
-- development. Preserve the early duration-only value and add the full timing
-- tuple used by the lines page.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'line_tts_versions' AND column_name = 'audio_duration_s'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'line_tts_versions' AND column_name = 'dur_s'
    ) THEN
        ALTER TABLE line_tts_versions RENAME COLUMN audio_duration_s TO dur_s;
    END IF;
END $$;

ALTER TABLE line_tts_versions
    ADD COLUMN IF NOT EXISTS start_s DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS end_s DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS dur_s DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS speech_s DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS line_tts_versions_stem_latest_idx
    ON line_tts_versions (stem, id DESC);

CREATE INDEX IF NOT EXISTS line_tts_versions_speaker_idx
    ON line_tts_versions (speaker, id DESC);

CREATE INDEX IF NOT EXISTS line_tts_versions_status_idx
    ON line_tts_versions (status, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS line_tts_versions_one_used_idx
    ON line_tts_versions (stem)
    WHERE is_used;
