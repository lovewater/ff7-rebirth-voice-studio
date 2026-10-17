-- 第一步：新增三态并迁移历史。旧服务尚在运行时临时双向同步，避免切换丢锁。
BEGIN;
ALTER TABLE line_tts_versions ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'candidate';
UPDATE line_tts_versions SET review_state=CASE WHEN is_used THEN 'locked' ELSE 'candidate' END;
ALTER TABLE line_tts_versions ADD CONSTRAINT line_tts_versions_review_state_check
  CHECK(review_state IN ('candidate','locked','abnormal'));
CREATE UNIQUE INDEX line_tts_versions_one_locked_idx ON line_tts_versions(stem) WHERE review_state='locked';
COMMENT ON COLUMN line_tts_versions.review_state IS '人工选择状态：candidate待选、locked锁定、abnormal人工异常；与生成status及自动质量判定独立';
CREATE OR REPLACE FUNCTION sync_tts_review_state_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.is_used AND NEW.review_state='candidate' THEN NEW.review_state='locked';
    ELSE NEW.is_used=(NEW.review_state='locked'); END IF;
  ELSIF NEW.review_state IS DISTINCT FROM OLD.review_state THEN
    NEW.is_used=(NEW.review_state='locked');
  ELSIF NEW.is_used IS DISTINCT FROM OLD.is_used THEN
    NEW.review_state=CASE WHEN NEW.is_used THEN 'locked' ELSE 'candidate' END;
  END IF;
  IF NEW.review_state<>'locked' THEN NEW.used_at=NULL;
  ELSE NEW.used_at=COALESCE(NEW.used_at,now()); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tts_review_state_transition BEFORE INSERT OR UPDATE ON line_tts_versions
FOR EACH ROW EXECUTE FUNCTION sync_tts_review_state_transition();
COMMIT;
