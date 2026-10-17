-- 先运行worker/migrate_original_cn_reviews.py --apply，把旧忽略登记为原中文锁。
-- 保留旧列供历史脚本只读兼容，但禁止再写true；人工结论唯一来源为review_state。
ALTER TABLE line_meta ADD CONSTRAINT line_meta_skip_timing_retired CHECK (skip_timing IS NOT TRUE);
COMMENT ON COLUMN line_meta.skip_timing IS '已弃用，只能false；确认原中文使用line_tts_versions cn-original锁';
