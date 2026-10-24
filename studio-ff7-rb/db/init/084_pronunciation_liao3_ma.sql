-- 用户指定“了吗”中的“了”读第三声；仅替换实际发往TTS的输入。
INSERT INTO pronunciations (usage, src, dst, note)
VALUES ('tts_pinyin', '了吗', 'LIAO3吗', '用户指定：了吗读 liǎo ma；仅在合成输入中替换')
ON CONFLICT (usage, src) DO UPDATE
SET dst = EXCLUDED.dst, note = EXCLUDED.note;
