-- Names live in speakers / regions. Drop copies on lines.

INSERT INTO speakers (code, name_zh, source, updated_at)
SELECT l.speaker, MAX(l.speaker_name), 'lines', now()
FROM lines l
WHERE l.speaker IS NOT NULL AND l.speaker <> ''
GROUP BY l.speaker
ON CONFLICT (code) DO NOTHING;

ALTER TABLE lines DROP COLUMN IF EXISTS speaker_name;
ALTER TABLE lines DROP COLUMN IF EXISTS region_name;
