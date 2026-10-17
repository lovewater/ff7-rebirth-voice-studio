-- Classification inferred from the game's voice/event/camera resources.
ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS dialogue_mode TEXT,
    ADD COLUMN IF NOT EXISTS dialogue_evidence JSONB;

CREATE INDEX IF NOT EXISTS line_meta_dialogue_mode_idx
    ON line_meta (dialogue_mode);
