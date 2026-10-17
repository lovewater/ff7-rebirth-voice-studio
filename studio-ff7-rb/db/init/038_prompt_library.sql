-- 提示词版本库：同key可以有多个启用版本，运行时只取updated_at最新、同时间id最大的启用版本。
-- 页面第一阶段只读；版本停用时保留历史记录，不覆盖旧文案，不按created_at判断生效。
CREATE TABLE IF NOT EXISTS prompt_templates (
 id bigserial PRIMARY KEY,
 key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9._-]*$'),
 name text NOT NULL,
 "desc" text NOT NULL DEFAULT '',
 prompt text NOT NULL CHECK (length(prompt)>0),
 enable boolean NOT NULL DEFAULT true,
 role text NOT NULL CHECK (role IN ('system','user','assistant')),
 placeholders jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(placeholders)='array'),
 source_path text,
 seed_hash text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prompt_templates_lookup_idx ON prompt_templates (key,enable DESC,updated_at DESC,id DESC);
CREATE OR REPLACE FUNCTION prompt_templates_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=clock_timestamp(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS prompt_templates_updated_at ON prompt_templates;
CREATE TRIGGER prompt_templates_updated_at BEFORE UPDATE ON prompt_templates FOR EACH ROW EXECUTE FUNCTION prompt_templates_touch_updated_at();
COMMENT ON TABLE prompt_templates IS '模型提示词版本：同key取最新启用版本，页面当前只读';
COMMENT ON COLUMN prompt_templates.placeholders IS '占位符名称、中文用途和替换示例；示例不代表实际请求数据';
