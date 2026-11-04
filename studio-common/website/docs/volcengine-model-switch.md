# 火山套餐连接切换模型

默认通道已改为火山 DeepSeek V4.1 Flash；原智谱连接名为“官方GLM”（`primary`），仅显式调用。火山连接继续使用现有套餐 URL 和密钥，可在单次调用指定模型，不修改进程环境，因此并发请求不会串模型。省略模型名时读取 `VOLCENGINE_LLM_MODEL`，未配置时使用 `deepseek-v4.1-flash`。

```ts
await callChatCompletion({
  modelId: "volcengine",
  volcengine: { model: "kimi-k3" }, // 也可用 minimax-m3、doubao-seed-2.1-pro
  task: "模型对比实验",
  messages,
});
```

业务提示词入口 `rewriteChat` 的最后一个参数也支持同样的 `{modelId:"volcengine",volcengine:{model:"minimax-m3"}}`。默认关闭思考，保持既有 JSON、温度、输出上限契约；可在单次请求显式设置 `volcengine.thinking`。参数不支持会原样报错，不暗中换模型、换端点或改用按量计费。模型名称不限定死在示例列表内，后续新模型可直接传名称。

连接探测：`node scripts/probe-volcengine-models.cjs kimi-k3 minimax-m3`。仅发送简短JSON测试，复用正式调用日志；不改变默认模型、不启动TTS。真实连接配置从环境或本机ignored Compose .env读取，输出不包含凭据。日志的 requested_model/response_model、输入/输出和token用量保持可追溯。

推理档位可按请求传 `volcengine.reasoningEffort`（none/minimal/low/medium/high/xhigh/max）。显式传思考档且省略thinking时会自动开启思考；不传档位仍沿用旧默认。显式关闭思考与low/high/max冲突时提前报错，防止误以为在测最高档实际却关闭思考。各模型可映射档位，HTTP成功不代表平台一定按原生档位执行；日志完整保存实际请求和返回usage以供验证。


实验调用可单独传 `timeoutMs`（默认120000，允许1至1800000毫秒），用于较高思考档的离线对比，不修改业务默认超时。示例：

```ts
await callChatCompletion({
  modelId: "volcengine",
  volcengine: { model: "kimi-k3", thinking: "enabled", reasoningEffort: "high" },
  task: "改稿离线对比",
  messages,
  maxTokens: 16384,
  timeoutMs: 600000,
});
```

官方依据：Agent Plan 接入指南 <https://docs.volcengine.com/docs/ark/agent-plan-personal-opencode?lang=en> 确认套餐专属Key、套餐端点及Chat/Responses兼容；深度思考文档 <https://docs.volcengine.com/docs/ark/deep-thinking?lang=en> 说明Chat的 `reasoning_effort` 与Responses的 `reasoning.effort`，也明确部分模型会将请求档位映射为等效档位。不能把通用字段说明当成Kimi在套餐中各档精确映射的保证。当前10题实验使用Chat接口，同题同消息、温度及输出上限，仅改变low/high/max；未比较Responses接口。
