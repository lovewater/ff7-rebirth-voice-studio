-- 尤菲日文情绪过满时用这条普莉希拉中文当参考音色（人物页勾选接口不允许跨人物，故硬写入）。
INSERT INTO speaker_timbre_refs (speaker, stem, ordinal, note)
VALUES ('yfi', 'C2120_MAIN_1100_0300_00_prs', 1, '特挑中文')
ON CONFLICT (speaker, stem) DO UPDATE SET
  note = EXCLUDED.note,
  ordinal = EXCLUDED.ordinal;
