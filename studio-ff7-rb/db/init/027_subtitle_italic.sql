-- Official subtitle <i> markup: the line is shown in italics.
-- In game that is speech from someone who is not on screen.

ALTER TABLE lines
    ADD COLUMN IF NOT EXISTS subtitle_italic BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS lines_subtitle_italic_idx
    ON lines (subtitle_italic)
    WHERE subtitle_italic;
