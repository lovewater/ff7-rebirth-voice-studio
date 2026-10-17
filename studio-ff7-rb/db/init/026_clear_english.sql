-- English audio and subtitles are no longer used. Clear DB copies; MP3s are deleted on disk.

UPDATE lines SET text_en = NULL WHERE text_en IS NOT NULL;

UPDATE line_meta
SET en_start_s = NULL,
    en_end_s = NULL,
    en_dur_s = NULL,
    en_speech_s = NULL
WHERE en_start_s IS NOT NULL
   OR en_end_s IS NOT NULL
   OR en_dur_s IS NOT NULL
   OR en_speech_s IS NOT NULL;
