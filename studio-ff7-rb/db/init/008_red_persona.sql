-- Split Red XIII into two people: 深嗓 red vs 真声 nnk.
-- Game PC banks: VO_PC0004_00_RedXIII / VO_PC0004_01_Nanaki.
-- Re-run worker/apply_red_persona.py after catalog import (stem suffix is still _red).

ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS persona TEXT;

CREATE INDEX IF NOT EXISTS line_meta_persona_idx ON line_meta (persona);

INSERT INTO speakers (code, name_zh, name_jp, source, updated_at) VALUES
    ('nnk', '纳纳基（真声）', 'ナナキ', 'manual', now()),
    ('grm', '迦姆', 'ガルム', 'manual', now()),
    ('pkw', '海盗王', '海賊王', 'manual', now())
ON CONFLICT (code) DO UPDATE SET
    name_zh = EXCLUDED.name_zh,
    name_jp = EXCLUDED.name_jp,
    source = 'manual',
    updated_at = now();

UPDATE speakers
SET name_zh = '赤红XIII（深嗓）', name_jp = 'レッドXIII', source = 'manual', updated_at = now()
WHERE code = 'red';

INSERT INTO cast_members (speaker, role, note) VALUES
    ('nnk', '主角', '赤红真声／星殒之后的纳纳基')
ON CONFLICT (speaker) DO NOTHING;

UPDATE cast_members SET note = '赤红伪装成熟嗓', updated_at = now() WHERE speaker = 'red';

INSERT INTO line_meta (stem, extra, updated_at)
SELECT l.stem, '{}'::jsonb, now()
FROM lines l
WHERE l.speaker IN ('red', 'RedXIII', 'Nanaki')
  AND NOT EXISTS (SELECT 1 FROM line_meta m WHERE m.stem = l.stem);

-- 1. not actually Red
UPDATE line_meta m SET persona = 'not_red', updated_at = now()
FROM lines l
WHERE l.stem = m.stem
  AND l.speaker IN ('red', 'RedXIII', 'Nanaki')
  AND COALESCE(m.actor_zh, '') IN ('迦姆', '海盗王的话语');

-- 2. official PC banks
UPDATE line_meta SET persona = 'redxiii', updated_at = now() WHERE stem = 'VO_PC0004_00_RedXIII';
UPDATE line_meta SET persona = 'nanaki', updated_at = now() WHERE stem = 'VO_PC0004_01_Nanaki';

-- 3. opening narrator wrap = deep voice
UPDATE line_meta m SET persona = 'redxiii', updated_at = now()
FROM lines l
WHERE l.stem = m.stem
  AND l.speaker IN ('red', 'RedXIII')
  AND (m.persona IS NULL OR m.persona = 'unknown')
  AND l.stem LIKE 'C1910_MAIN_0050%';

-- 4. オイラ = Nanaki true voice (exclude 迦姆)
UPDATE line_meta m SET persona = 'nanaki', updated_at = now()
FROM lines l
WHERE l.stem = m.stem
  AND l.speaker IN ('red', 'RedXIII', 'Nanaki')
  AND (m.persona IS NULL OR m.persona = 'unknown')
  AND COALESCE(m.actor_zh, '') <> '迦姆'
  AND l.text_jp ~ 'オイラ';

-- 5. 私 = deep Red XIII
UPDATE line_meta m SET persona = 'redxiii', updated_at = now()
FROM lines l
WHERE l.stem = m.stem
  AND l.speaker IN ('red', 'RedXIII')
  AND (m.persona IS NULL OR m.persona = 'unknown')
  AND l.text_jp ~ '私|わたし';

UPDATE line_meta m SET persona = 'unknown', updated_at = now()
FROM lines l
WHERE l.stem = m.stem
  AND l.speaker IN ('red', 'RedXIII', 'Nanaki')
  AND m.persona IS NULL;

-- Move speaker codes so the rest of the studio treats them as two people.
UPDATE lines l SET speaker = 'nnk', updated_at = now()
FROM line_meta m
WHERE m.stem = l.stem AND m.persona = 'nanaki';

UPDATE lines l SET speaker = 'grm', updated_at = now()
FROM line_meta m
WHERE m.stem = l.stem AND m.persona = 'not_red' AND m.actor_zh = '迦姆';

UPDATE lines l SET speaker = 'pkw', updated_at = now()
FROM line_meta m
WHERE m.stem = l.stem AND m.persona = 'not_red' AND m.actor_zh = '海盗王的话语';

UPDATE lines SET speaker = 'red', updated_at = now()
WHERE speaker = 'RedXIII';

UPDATE lines SET speaker = 'nnk', updated_at = now()
WHERE speaker = 'Nanaki';

-- Draft clips must belong to the bank's speaker.
DELETE FROM voice_bank_draft_clips d
USING voice_banks b, lines l
WHERE d.bank_id = b.id AND d.stem = l.stem AND b.speaker IS DISTINCT FROM l.speaker;
