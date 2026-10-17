-- 每次HTTP尝试独立留痕，重试用invocation_id归组；日志不级联依赖业务表，删业务记录仍保留成本证据。
-- 每日备份只排除此表数据，保留表结构。凭据和请求头永不入库。
CREATE TABLE IF NOT EXISTS llm_access_logs (
 id bigserial PRIMARY KEY,
 invocation_id uuid NOT NULL,
 attempt integer NOT NULL CHECK (attempt > 0),
 auto_run_id bigint,
 stem text,
 task text NOT NULL,
 endpoint text NOT NULL,
 requested_model text NOT NULL,
 response_model text,
 prompt_keys text[] NOT NULL DEFAULT '{}',
 request_body jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','http-error','network-error','invalid-json','invalid-response','truncated')),
 response_body jsonb,
 response_raw text,
 output_text text,
 reasoning_text text,
 usage jsonb,
 input_tokens bigint,
 output_tokens bigint,
 total_tokens bigint,
 cached_tokens bigint,
 reasoning_tokens bigint,
 elapsed_ms double precision,
 output_tokens_per_second double precision,
 http_status integer,
 request_id text,
 error text,
 started_at timestamptz NOT NULL,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(invocation_id,attempt)
);
CREATE INDEX IF NOT EXISTS llm_access_logs_run_idx ON llm_access_logs(auto_run_id,id);
CREATE INDEX IF NOT EXISTS llm_access_logs_stem_idx ON llm_access_logs(stem,id DESC);
CREATE INDEX IF NOT EXISTS llm_access_logs_task_time_idx ON llm_access_logs(task,started_at DESC);
CREATE INDEX IF NOT EXISTS llm_access_logs_time_idx ON llm_access_logs(started_at DESC);
COMMENT ON TABLE llm_access_logs IS '大模型逐次访问原始记录，供成本分析和私有模型重放；每日备份排除数据但保留结构';
COMMENT ON COLUMN llm_access_logs.request_body IS '真正发送的完整JSON：替换后的messages、model、temperature、max_tokens、thinking等；复刻时直接使用此快照，不重新读当前提示词。无Authorization等请求头';
COMMENT ON COLUMN llm_access_logs.response_raw IS '接口原始响应全文，含错误/非JSON/截断返回，不做思考和正文截断';
COMMENT ON COLUMN llm_access_logs.response_body IS '有效JSON响应的完整解析结果，保留全部choices及供应商附加字段';
COMMENT ON COLUMN llm_access_logs.output_text IS '第一条choice的原始正文；结构不合法或没有返回时为NULL';
COMMENT ON COLUMN llm_access_logs.reasoning_text IS '供应商实际返回的reasoning_content，完整保存；没返回不能据此推测模型是否思考';
COMMENT ON COLUMN llm_access_logs.input_tokens IS 'usage.prompt_tokens原值；没有返回时NULL，不用字数估算';
COMMENT ON COLUMN llm_access_logs.output_tokens IS 'usage.completion_tokens原值；包含推理token与否遵循供应商用量，不能重复相加';
COMMENT ON COLUMN llm_access_logs.status IS '请求发出前先落pending；完成后写结果，进程意外退出可从pending识别不完整日志';
