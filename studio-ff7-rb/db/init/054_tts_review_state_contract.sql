-- 最后一步：所有网站/worker/备份/打包读写切换review_state且校验锁定集合后执行。
-- 历史迁移保留is_used字样用于旧数据库升级，运行时代码不得再引用旧列。
BEGIN;
DROP TRIGGER IF EXISTS tts_review_state_transition ON line_tts_versions;
DROP FUNCTION IF EXISTS sync_tts_review_state_transition();
DROP INDEX IF EXISTS line_tts_versions_one_used_idx;
ALTER TABLE line_tts_versions DROP COLUMN IF EXISTS is_used;
COMMIT;
