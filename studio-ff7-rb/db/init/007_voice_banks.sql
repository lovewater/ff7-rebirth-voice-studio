-- Per-character voice banks. Studio-only, never packed.
-- kind=基准 can have multiple slots (later mapped to emotions).
-- kind in 怒/喜/平/悲/惧/惊 is one slot each; empty until made.
-- A version exists for each embedding build and is retained without a limit.

CREATE TABLE IF NOT EXISTS voice_banks (
    id          SERIAL PRIMARY KEY,
    speaker     TEXT NOT NULL REFERENCES speakers(code) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('基准', '怒', '喜', '平', '悲', '惧', '惊')),
    slot        INT  NOT NULL DEFAULT 1,
    name        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (speaker, kind, slot)
);

CREATE INDEX IF NOT EXISTS voice_banks_speaker_idx ON voice_banks (speaker);

-- Working selection (not a version until embed is built).
CREATE TABLE IF NOT EXISTS voice_bank_draft_clips (
    bank_id   INT  NOT NULL REFERENCES voice_banks(id) ON DELETE CASCADE,
    stem      TEXT NOT NULL REFERENCES lines(stem) ON DELETE CASCADE,
    selected  BOOLEAN NOT NULL DEFAULT true,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bank_id, stem)
);

CREATE TABLE IF NOT EXISTS voice_bank_versions (
    id           SERIAL PRIMARY KEY,
    bank_id      INT NOT NULL REFERENCES voice_banks(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    n_clips      INT NOT NULL DEFAULT 0,
    total_dur_s  DOUBLE PRECISION,
    embed_pt     TEXT,
    embed_wav    TEXT,
    note         TEXT
);

CREATE INDEX IF NOT EXISTS voice_bank_versions_bank_idx
    ON voice_bank_versions (bank_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_bank_version_clips (
    version_id INT  NOT NULL REFERENCES voice_bank_versions(id) ON DELETE CASCADE,
    stem       TEXT NOT NULL REFERENCES lines(stem) ON DELETE CASCADE,
    PRIMARY KEY (version_id, stem)
);
