-- 列表只取唯一展示版本：人工标记优先、主音频优先、同级取最新。
-- 和page.tsx、line-list-search.ts、healthFlagExpr的ORDER BY一致，避免逐句扫描排序历史音频。
-- INCLUDE仅收录短字幕，不索引朗读稿、音频、ASR或conversion_meta等大型详情。
-- CONCURRENTLY允许网站继续播放/锁定/生成；执行此文件时不能包在事务中。
CREATE INDEX CONCURRENTLY IF NOT EXISTS line_tts_versions_list_visible_idx
  ON line_tts_versions (stem, ((review_state <> 'candidate')) DESC, ((parent_tts_id IS NULL)) DESC, id DESC)
  INCLUDE (subtitle_text)
  WHERE status = 'ready';
