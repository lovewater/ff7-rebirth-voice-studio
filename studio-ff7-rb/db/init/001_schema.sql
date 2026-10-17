CREATE TABLE IF NOT EXISTS lines (
    id              BIGSERIAL PRIMARY KEY,
    pack            TEXT NOT NULL,
    filename        TEXT NOT NULL,
    stem            TEXT NOT NULL UNIQUE,
    asset_path      TEXT,
    region          TEXT,
    speaker         TEXT,
    kind            TEXT,
    jp_chunk_id     TEXT,
    jp_container    TEXT,
    text_jp         TEXT,
    text_zh         TEXT,
    script          TEXT,
    status          TEXT NOT NULL DEFAULT 'upstream',
    slot_ms         INTEGER,
    cn_ms           INTEGER,
    ours_ms         INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lines_region_idx ON lines (region);
CREATE INDEX IF NOT EXISTS lines_status_idx ON lines (status);
CREATE INDEX IF NOT EXISTS lines_speaker_idx ON lines (speaker);
CREATE INDEX IF NOT EXISTS lines_pack_idx ON lines (pack);

CREATE TABLE IF NOT EXISTS pronunciations (
    id          BIGSERIAL PRIMARY KEY,
    src         TEXT NOT NULL UNIQUE,
    dst         TEXT NOT NULL,
    note        TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status      TEXT NOT NULL DEFAULT 'queued',
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
