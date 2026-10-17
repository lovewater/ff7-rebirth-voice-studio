-- TTS 送出前按字替换。更长的 src 优先（代码里排序）。

INSERT INTO pronunciations (src, dst, note) VALUES
    ('壹', '一', '大写数字'),
    ('贰', '二', '大写数字'),
    ('叁', '三', '大写数字'),
    ('肆', '四', '大写数字'),
    ('伍', '五', '大写数字'),
    ('陆', '六', '大写数字'),
    ('柒', '七', '大写数字'),
    ('捌', '八', '大写数字'),
    ('玖', '九', '大写数字'),
    ('拾', '十', '大写数字'),
    ('魔晄炉', '魔恍炉', 'IndexTTS 不认晄')
ON CONFLICT (src) DO UPDATE SET
    dst = EXCLUDED.dst,
    note = COALESCE(EXCLUDED.note, pronunciations.note);
