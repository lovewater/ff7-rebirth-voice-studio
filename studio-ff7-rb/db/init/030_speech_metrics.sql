-- Persistent derived measurements and restartable, single-worker queue.
-- Does not change adopted audio, subtitles, or the original beat ratio.
CREATE TABLE IF NOT EXISTS speech_metrics (
    cache_key TEXT PRIMARY KEY,
    audio_path TEXT NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('jp', 'cn')),
    source_text TEXT NOT NULL,
    file_version TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'error')),
    priority INTEGER NOT NULL DEFAULT 0,
    duration_s DOUBLE PRECISION,
    silence_s DOUBLE PRECISION,
    net_speech_s DOUBLE PRECISION,
    unit_count DOUBLE PRECISION,
    units_per_s DOUBLE PRECISION,
    result JSONB,
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    measured_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS speech_metrics_pending_idx
    ON speech_metrics (priority DESC, queued_at) WHERE status = 'pending';
