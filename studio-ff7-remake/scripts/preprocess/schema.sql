-- Apply only through the Remake guarded runner; shared Rebirth schema is untouched.
DO $$ BEGIN IF current_database()<>'studio_ff7_remake' OR current_user<>'ff7remake' THEN RAISE EXCEPTION 'Remake-only schema'; END IF; END $$;
CREATE TABLE IF NOT EXISTS remake_preprocess_jobs (
 stem text PRIMARY KEY REFERENCES lines(stem) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','review_pending','classifying','retry','done','needs_review')),
 phase text NOT NULL DEFAULT 'preprocess' CHECK(phase IN ('preprocess','classify')),
 origin jsonb NOT NULL,
 checkpoints jsonb NOT NULL DEFAULT '{}',
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz,
 completed_at timestamptz,
 error text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remake_preprocess_dispatch ON remake_preprocess_jobs(phase,status,next_attempt_at);
CREATE TABLE IF NOT EXISTS remake_preprocess_events (
 id bigserial PRIMARY KEY,
 stem text NOT NULL REFERENCES remake_preprocess_jobs(stem) ON DELETE CASCADE,
 stage text NOT NULL,
 input_hash text,
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remake_preprocess_events_stem ON remake_preprocess_events(stem,id);
COMMENT ON TABLE remake_preprocess_jobs IS 'Remake 专属 ASR/独立翻译/拟声审查断点，不触发 TTS，不与 Rebirth 后台共用任务';
COMMENT ON TABLE remake_preprocess_events IS '每阶段不可变原始证据；checkpoint只指向当前有效结果，重试不删除历史';
-- Record all review transitions, including lock->candidate, so a human cancelling a choice wins too.
CREATE TABLE IF NOT EXISTS remake_review_revisions (
 stem text PRIMARY KEY REFERENCES lines(stem) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 0
);
CREATE OR REPLACE FUNCTION remake_track_review_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean; target_stem text;
BEGIN
 target_stem=CASE WHEN TG_OP='DELETE' THEN OLD.stem ELSE NEW.stem END;
 IF TG_OP='INSERT' THEN changed=NEW.review_state<>'candidate';
 ELSIF TG_OP='DELETE' THEN changed=OLD.review_state<>'candidate';
 ELSE changed=NEW.review_state IS DISTINCT FROM OLD.review_state OR NEW.subtitle_text IS DISTINCT FROM OLD.subtitle_text;
 END IF;
 IF changed THEN
  INSERT INTO remake_review_revisions(stem,revision) VALUES(target_stem,1)
  ON CONFLICT(stem) DO UPDATE SET revision=remake_review_revisions.revision+1;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS remake_review_revision ON line_tts_versions;
CREATE TRIGGER remake_review_revision AFTER INSERT OR UPDATE OR DELETE ON line_tts_versions FOR EACH ROW EXECUTE FUNCTION remake_track_review_revision();

-- Terminal source-change audit is distinct from successful processing.
ALTER TABLE remake_preprocess_jobs DROP CONSTRAINT IF EXISTS remake_preprocess_jobs_status_check;
ALTER TABLE remake_preprocess_jobs ADD CONSTRAINT remake_preprocess_jobs_status_check CHECK(status IN ('pending','running','review_pending','classifying','retry','done','needs_review'));
