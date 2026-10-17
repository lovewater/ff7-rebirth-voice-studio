-- CampPlus cosine vs a Red XIII (deep) reference embedding. JP audio only.

ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS jp_spk_sim_red DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS line_meta_jp_spk_sim_red_idx ON line_meta (jp_spk_sim_red);
