-- Independent ASR comparison aliases. Never apply these rows to TTS or subtitles.
CREATE TABLE IF NOT EXISTS asr_word_corrections (
  id SERIAL PRIMARY KEY,
  word TEXT NOT NULL UNIQUE CHECK (length(word) BETWEEN 1 AND 40),
  aliases TEXT[] NOT NULL CHECK (cardinality(aliases) BETWEEN 1 AND 64),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
