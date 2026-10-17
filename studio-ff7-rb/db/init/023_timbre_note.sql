-- Japanese timbre refs need a human note so TTS can pick one by description.

ALTER TABLE speaker_timbre_refs
    ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
