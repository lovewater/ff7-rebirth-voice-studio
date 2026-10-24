-- 固定术语独立于读音替换：只命中当前中文原稿/改稿后给创作模型提示，不改字幕或TTS读音。
BEGIN;
CREATE TABLE IF NOT EXISTS game_fixed_terms (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term text NOT NULL UNIQUE CHECK (char_length(term) BETWEEN 1 AND 80),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO game_fixed_terms(term,note) VALUES
 ('再结合','游戏固定表达，不得改成同义说法'),
 ('回归星球','游戏固定表达，不得改成同义说法')
ON CONFLICT(term) DO NOTHING;
COMMIT;
