-- Single-line ASR auto-run journal. Never adopts audio (is_used stays false).
CREATE TABLE IF NOT EXISTS line_auto_runs (
    id              BIGSERIAL PRIMARY KEY,
    stem            TEXT NOT NULL REFERENCES lines(stem) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('performance', 'casual')),
    status          TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
    selected_tts_id BIGINT REFERENCES line_tts_versions(id) ON DELETE SET NULL,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS line_auto_runs_stem_idx
    ON line_auto_runs (stem, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS line_auto_runs_one_running_idx
    ON line_auto_runs (stem) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS line_auto_run_events (
    id      BIGSERIAL PRIMARY KEY,
    run_id  BIGINT NOT NULL REFERENCES line_auto_runs(id) ON DELETE CASCADE,
    at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    step    TEXT NOT NULL,
    level   TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'think', 'asr', 'result', 'error')),
    message TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS line_auto_run_events_run_idx
    ON line_auto_run_events (run_id, id);
