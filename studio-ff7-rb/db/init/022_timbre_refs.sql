-- Per-speaker Japanese identity clips for Seed-VC timbre-only conversion.

CREATE TABLE IF NOT EXISTS speaker_timbre_refs (
    speaker   TEXT NOT NULL REFERENCES speakers(code) ON DELETE CASCADE,
    stem      TEXT NOT NULL REFERENCES lines(stem) ON DELETE CASCADE,
    ordinal   INT  NOT NULL DEFAULT 1,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (speaker, stem)
);

CREATE INDEX IF NOT EXISTS speaker_timbre_refs_speaker_idx
    ON speaker_timbre_refs (speaker, ordinal, stem);
