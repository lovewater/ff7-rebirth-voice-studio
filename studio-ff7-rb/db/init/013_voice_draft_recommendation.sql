-- Keep the automatic recommendation separate from the user's checkbox state.
-- Every speaker line can be offered for manual selection; recommended rows are
-- listed first and start selected.

ALTER TABLE voice_bank_draft_clips
    ADD COLUMN IF NOT EXISTS recommended BOOLEAN NOT NULL DEFAULT false;
