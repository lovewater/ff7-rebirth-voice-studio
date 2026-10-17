-- Per-language timing on studio-only line_meta. Seconds, not packed.

ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS jp_start_s   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_end_s     DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_dur_s     DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_speech_s  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_start_s   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_end_s     DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_dur_s     DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_speech_s  DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS line_meta_jp_speech_idx ON line_meta (jp_speech_s);
CREATE INDEX IF NOT EXISTS line_meta_cn_speech_idx ON line_meta (cn_speech_s);
