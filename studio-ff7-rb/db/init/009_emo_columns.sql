-- Emotion as columns + one status. Drops JSON vec / edit / cosine leftovers.

ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS jp_emo_angry      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_disgusted  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_fearful    DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_happy      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_neutral    DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_other      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_sad        DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_surprised  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_angry      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_disgusted  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_fearful    DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_happy      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_neutral    DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_other      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_sad        DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo_surprised  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS emo_src           TEXT CHECK (emo_src IN ('computed', 'edited'));

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'line_meta' AND column_name = 'jp_emo_vec'
    ) THEN
        UPDATE line_meta SET
            jp_emo_angry     = COALESCE((COALESCE(jp_emo_edit_vec, jp_emo_vec)->>'ANGRY')::float, jp_emo_angry),
            jp_emo_disgusted = COALESCE((COALESCE(jp_emo_edit_vec, jp_emo_vec)->>'DISGUSTED')::float, jp_emo_disgusted),
            jp_emo_fearful   = COALESCE((COALESCE(jp_emo_edit_vec, jp_emo_vec)->>'FEARFUL')::float, jp_emo_fearful),
            jp_emo_happy     = COALESCE((COALESCE(jp_emo_edit_vec, jp_emo_vec)->>'HAPPY')::float, jp_emo_happy),
            jp_emo_neutral   = COALESCE((COALESCE(jp_emo_edit_vec, jp_emo_vec)->>'NEUTRAL')::float, jp_emo_neutral),
            jp_emo_other     = COALESCE((COALESCE(jp_emo_edit_vec, jp_emo_vec)->>'OTHER')::float, jp_emo_other),
            jp_emo_sad       = COALESCE((COALESCE(jp_emo_edit_vec, jp_emo_vec)->>'SAD')::float, jp_emo_sad),
            jp_emo_surprised = COALESCE((COALESCE(jp_emo_edit_vec, jp_emo_vec)->>'SURPRISED')::float, jp_emo_surprised),
            cn_emo_angry     = COALESCE((COALESCE(cn_emo_edit_vec, cn_emo_vec)->>'ANGRY')::float, cn_emo_angry),
            cn_emo_disgusted = COALESCE((COALESCE(cn_emo_edit_vec, cn_emo_vec)->>'DISGUSTED')::float, cn_emo_disgusted),
            cn_emo_fearful   = COALESCE((COALESCE(cn_emo_edit_vec, cn_emo_vec)->>'FEARFUL')::float, cn_emo_fearful),
            cn_emo_happy     = COALESCE((COALESCE(cn_emo_edit_vec, cn_emo_vec)->>'HAPPY')::float, cn_emo_happy),
            cn_emo_neutral   = COALESCE((COALESCE(cn_emo_edit_vec, cn_emo_vec)->>'NEUTRAL')::float, cn_emo_neutral),
            cn_emo_other     = COALESCE((COALESCE(cn_emo_edit_vec, cn_emo_vec)->>'OTHER')::float, cn_emo_other),
            cn_emo_sad       = COALESCE((COALESCE(cn_emo_edit_vec, cn_emo_vec)->>'SAD')::float, cn_emo_sad),
            cn_emo_surprised = COALESCE((COALESCE(cn_emo_edit_vec, cn_emo_vec)->>'SURPRISED')::float, cn_emo_surprised),
            emo_src = CASE
                WHEN jp_emo_edit_vec IS NOT NULL OR cn_emo_edit_vec IS NOT NULL THEN 'edited'
                WHEN jp_emo_vec IS NOT NULL OR cn_emo_vec IS NOT NULL THEN 'computed'
                ELSE emo_src
            END
        WHERE jp_emo_vec IS NOT NULL OR cn_emo_vec IS NOT NULL OR jp_emo_edit_vec IS NOT NULL;
    END IF;
END $$;

DROP INDEX IF EXISTS line_meta_jp_emo_idx;
DROP INDEX IF EXISTS line_meta_cn_emo_idx;

ALTER TABLE line_meta
    DROP COLUMN IF EXISTS jp_emo_p,
    DROP COLUMN IF EXISTS cn_emo_p,
    DROP COLUMN IF EXISTS jp_emo_vec,
    DROP COLUMN IF EXISTS cn_emo_vec,
    DROP COLUMN IF EXISTS emo_cos,
    DROP COLUMN IF EXISTS jp_emo_edit,
    DROP COLUMN IF EXISTS jp_emo_edit_p,
    DROP COLUMN IF EXISTS cn_emo_edit,
    DROP COLUMN IF EXISTS cn_emo_edit_p,
    DROP COLUMN IF EXISTS jp_emo_edit_vec,
    DROP COLUMN IF EXISTS cn_emo_edit_vec;

CREATE INDEX IF NOT EXISTS line_meta_jp_emo_idx ON line_meta (jp_emo);
CREATE INDEX IF NOT EXISTS line_meta_cn_emo_idx ON line_meta (cn_emo);
CREATE INDEX IF NOT EXISTS line_meta_emo_src_idx ON line_meta (emo_src);
CREATE INDEX IF NOT EXISTS line_meta_jp_emo_neutral_idx ON line_meta (jp_emo_neutral);

-- VO_PC English suffixes were a second "萨菲罗斯" with 0 平.
UPDATE lines SET speaker = 'sep' WHERE speaker = 'Sephiroth';
UPDATE lines SET speaker = 'cld' WHERE speaker = 'Cloud';
UPDATE lines SET speaker = 'tif' WHERE speaker = 'Tifa';
UPDATE lines SET speaker = 'art' WHERE speaker = 'Aerith';
UPDATE lines SET speaker = 'blt' WHERE speaker = 'Barret';
UPDATE lines SET speaker = 'yfi' WHERE speaker = 'Yuffie';
UPDATE lines SET speaker = 'cat' WHERE speaker = 'CaitSith';
UPDATE lines SET speaker = 'zax' WHERE speaker = 'Zack';
UPDATE lines SET speaker = 'red' WHERE speaker = 'RedXIII';
UPDATE lines SET speaker = 'nnk' WHERE speaker = 'Nanaki';
