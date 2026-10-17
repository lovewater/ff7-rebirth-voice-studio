-- Studio-only region dictionary. Never packed. lines.region = regions.code.

CREATE TABLE IF NOT EXISTS regions (
    code        TEXT PRIMARY KEY,
    name_zh     TEXT,
    name_jp     TEXT,
    note        TEXT,
    source      TEXT NOT NULL DEFAULT 'seed',
    sort_order  INTEGER,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE regions ADD COLUMN IF NOT EXISTS sort_order INTEGER;
CREATE INDEX IF NOT EXISTS regions_sort_idx ON regions (sort_order);
