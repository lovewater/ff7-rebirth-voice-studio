-- Some lines do not need lip-sync; reviewers can mark timing as acceptable.

ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS skip_timing BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS line_meta_skip_timing_idx
    ON line_meta (skip_timing)
    WHERE skip_timing;
