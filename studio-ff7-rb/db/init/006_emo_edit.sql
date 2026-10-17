-- Edited emotion vs original emotion2vec+ scores. Studio-only.

ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS jp_emo_edit     TEXT,
    ADD COLUMN IF NOT EXISTS jp_emo_edit_p   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_edit     TEXT,
    ADD COLUMN IF NOT EXISTS cn_emo_edit_p   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_edit_vec JSONB,
    ADD COLUMN IF NOT EXISTS cn_emo_edit_vec JSONB;
