-- 自部署模型流式终止也必须留痕；重试每次独立一行，共用invocation_id。
-- 主动停止通常收不到最终usage，token保持NULL，不用已读字符数冒充真实用量。
ALTER TABLE llm_access_logs DROP CONSTRAINT IF EXISTS llm_access_logs_status_check;
ALTER TABLE llm_access_logs ADD CONSTRAINT llm_access_logs_status_check CHECK
 (status IN ('pending','success','http-error','network-error','invalid-json','invalid-response','truncated',
            'repetition-detected','stream-error','timeout','cancelled'));
COMMENT ON COLUMN llm_access_logs.response_raw IS '原始响应全文。非流式为JSON/错误正文；自部署流式为实际收到的SSE原文，主动终止只保留已收部分';
COMMENT ON COLUMN llm_access_logs.response_body IS '非流式为供应商完整JSON；自部署流式为按SSE归并的ChatCompletion，失败时stream_guard保存停止原因/通道/重复模式';
