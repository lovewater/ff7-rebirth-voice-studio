# 大模型访问日志

从切换到数据库日志开始，每次模型 HTTP 尝试（含自部署流式重试）写入 `public.llm_access_logs`。自动运行和手动改稿/择优共用同一个入口，不再追加 `data/metrics/llm-calls.jsonl`。旧 JSONL 已按要求删除，没有用不存在的原始消息补造历史请求。

- `request_body`：实际发送的完整 JSON，包含已经替换占位符的全部 messages、model、temperature、max_tokens、thinking、response_format 等。重放时直接使用这个快照，不要重新读取当前提示词模板；测试私有模型时替换 endpoint、model 和自己的认证信息。
- `response_raw` / `response_body`：原始响应全文及可解析时的完整 JSON，包括错误、全部 choices、供应商附加字段。自部署流式的response_raw保存实际SSE，response_body为归并结果，主动中止时附stream_guard证据。非法 JSON 也保留原文。`output_text`、`reasoning_text` 单独保留第一条 choice 的完整正文和接口实际返回的思考，均不截断。
- `input_tokens`、`output_tokens`、`total_tokens`、`cached_tokens`、`reasoning_tokens`、`usage`：接口返回的实际用量；未知为 NULL，不估算、不重复累加推理 token。
- `requested_model` / `response_model`、`endpoint`、`task`、`prompt_keys`：模型、调用用途及模板 key。实际提示词内容以 request_body 为准。
- `auto_run_id`、`stem`：自动运行的归属。手动改稿有 stem、没有 auto_run_id；日志不随业务记录级联删除。
- `invocation_id`、`attempt`：一次客户端调用的 HTTP 重试共享 invocation_id，每次尝试单独一行；上层业务重新发起改稿是新的 invocation_id。
- `started_at`、`completed_at`、`elapsed_ms`、`output_tokens_per_second`、`http_status`、`request_id`、`status`、`error`：耗时、端到端速度和结果。请求前先保存 pending 快照再发送，进程意外退出的未完成记录仍可追溯。

不保存 Authorization、API 密钥或请求头；endpoint 去掉 userinfo、查询参数和片段。日志表数据不进入每日 custom/plain 数据库备份，但保留结构；主音频的汇总 token/速度字段照常备份。不在本次需求中自动删除数据库日志。

例如取一场自动运行的调用，按原顺序复刻：

```sql
SELECT id, task, invocation_id, attempt, request_body,
       output_text, reasoning_text, input_tokens, output_tokens,
       elapsed_ms, status
FROM llm_access_logs
WHERE auto_run_id = 221
ORDER BY id;
```

`request_body` 可直接作为兼容 Chat Completions 接口的 JSON body，具体私有模型是否支持 thinking/response_format 等参数需在重放实验中适配，并保留原始请求快照不动。相同请求不保证生成同一输出，日志用于比较语义质量、通过率、时延和成本。

验证：`node --experimental-strip-types scripts/test-llm-access-log.cjs` 使用模拟供应商响应与真实 Postgres 事务，验证完整内容入库后回滚，不产生模型费用或测试日志。

自部署模型的流式重复检测、重试、用量未知与状态说明见 [自部署模型调用](self-hosted-llm.md)。
