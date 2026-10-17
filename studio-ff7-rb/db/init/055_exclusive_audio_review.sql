-- 同一句只能有一个人工结论：锁定和异常相互排斥，candidate为未标记。
-- 历史多标记优先保留已锁定稿，其次最新异常；迁移前应保存人工标记快照。
BEGIN;
WITH ranked AS (
 SELECT id,ROW_NUMBER() OVER(PARTITION BY stem ORDER BY (review_state='locked') DESC,COALESCE(used_at,completed_at,created_at) DESC,id DESC) AS n
 FROM line_tts_versions WHERE review_state IN ('locked','abnormal')
)
UPDATE line_tts_versions v SET review_state='candidate',used_at=NULL FROM ranked r WHERE v.id=r.id AND r.n>1;
CREATE UNIQUE INDEX IF NOT EXISTS line_tts_versions_one_review_idx ON line_tts_versions(stem) WHERE review_state IN ('locked','abnormal');
DROP INDEX IF EXISTS line_tts_versions_one_locked_idx;
COMMIT;
