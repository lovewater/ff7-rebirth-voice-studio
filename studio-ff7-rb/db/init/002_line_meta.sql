-- Studio-only sidecar. Never packed into the voice overlay.

CREATE TABLE IF NOT EXISTS speakers (
    code        TEXT PRIMARY KEY,
    name_zh     TEXT,
    name_jp     TEXT,
    source      TEXT NOT NULL DEFAULT 'txtres',
    note        TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS line_meta (
    stem        TEXT PRIMARY KEY REFERENCES lines(stem) ON DELETE CASCADE,
    actor_zh    TEXT,
    actor_jp    TEXT,
    note        TEXT,
    extra       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS line_meta_actor_zh_idx ON line_meta (actor_zh);
