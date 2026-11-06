-- Per-game connection configuration; credentials stay in the private database.
BEGIN;
CREATE TABLE IF NOT EXISTS auto_run_settings (
 id smallint PRIMARY KEY CHECK(id=1),
 model text NOT NULL DEFAULT 'grok' CHECK(model IN ('grok','primary')),
 connections jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(connections)='object'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auto_run_settings_events (
 id bigserial PRIMARY KEY,
 previous_model text NOT NULL,
 model text NOT NULL,
 changes jsonb NOT NULL DEFAULT '[]'::jsonb,
 at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN auto_run_settings.connections IS '私密接口配置，含API密钥；禁止日志输出、发布或导出到公共报告';
DO $$ BEGIN
 IF current_database()='studio_ff7_remake' AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ff7remake') THEN
  GRANT SELECT,INSERT,UPDATE ON auto_run_settings TO ff7remake;
  GRANT SELECT,INSERT ON auto_run_settings_events TO ff7remake;
  GRANT USAGE,SELECT ON SEQUENCE auto_run_settings_events_id_seq TO ff7remake;
 END IF;
END $$;
COMMIT;
