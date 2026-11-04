-- A line-level decision, independent of retained audio versions and review locks.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS processing_state TEXT NOT NULL DEFAULT 'active'
  CHECK (processing_state IN ('active','skipped'));
ALTER TABLE lines ADD COLUMN IF NOT EXISTS skip_reason TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS lines_processing_state_stem_idx ON lines(processing_state,stem);
CREATE TABLE IF NOT EXISTS line_processing_events (
  id BIGSERIAL PRIMARY KEY,
  stem TEXT NOT NULL REFERENCES lines(stem) ON DELETE CASCADE,
  from_state TEXT NOT NULL CHECK (from_state IN ('active','skipped')),
  to_state TEXT NOT NULL CHECK (to_state IN ('active','skipped')),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
