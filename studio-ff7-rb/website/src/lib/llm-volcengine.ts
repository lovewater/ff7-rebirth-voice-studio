/** 火山 Agent Plan 独立配置：与普通方舟按量 API、Seed-ASR、自部署模型均不共用凭据。
 * 地址和密钥必须来自环境变量；缺少配置直接报错，绝不暗中改走原模型或按量计费地址。
 * Agent Plan 按套餐抵扣，不发送按量接口的service_tier=flex，也不使用Auto模型别名。
 */
export function volcengineLlmConfig() {
  return {
    base: process.env.VOLCENGINE_LLM_URL?.trim(),
    key: process.env.VOLCENGINE_LLM_KEY?.trim(),
    model: process.env.VOLCENGINE_LLM_MODEL?.trim() || "doubao-seed-2.1-pro",
  };
}

export function volcengineChatBody(input: {
  model: string; messages: { role: string; content: string }[];
  temperature: number; maxTokens: number; json: boolean;
}) {
  // 只替换模型连接，不改变历史改稿提示词、温度、JSON契约及关闭思考的行为。
  return { model: input.model, messages: input.messages, temperature: input.temperature,
    max_tokens: input.maxTokens, stream: false, thinking: { type: "disabled" },
    ...(input.json ? { response_format: { type: "json_object" } } : {}) };
}
