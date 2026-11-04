/** 火山 Agent Plan 独立配置：与普通方舟按量 API、Seed-ASR、自部署模型均不共用凭据。
 * 地址和密钥必须来自环境变量；缺少配置直接报错，绝不暗中改走原模型或按量计费地址。
 * Agent Plan 按套餐抵扣，不发送按量接口的service_tier=flex，也不使用Auto模型别名。
 */
/** 同一个套餐连接可按请求选模型；不修改process.env，避免并发实验串模型。 */
export type VolcengineCallOptions = {
  model?: string;
  thinking?: "disabled" | "enabled" | "auto";
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};
export const VOLCENGINE_MODELS = ["deepseek-v4.1-flash", "doubao-seed-2.1-pro", "kimi-k3", "minimax-m3"] as const;

export function volcengineLlmConfig(options: VolcengineCallOptions = {}) {
  const model = options.model === undefined
    ? process.env.VOLCENGINE_LLM_MODEL?.trim() || "deepseek-v4.1-flash"
    : options.model.trim();
  if (!model || !/^[a-zA-Z0-9_.:-]+$/.test(model)) throw new Error("火山模型名称无效");
  return {
    base: process.env.VOLCENGINE_LLM_URL?.trim(),
    key: process.env.VOLCENGINE_LLM_KEY?.trim(),
    model,
  };
}

export function volcengineChatBody(input: {
  model: string; messages: { role: string; content: string }[];
  temperature: number; maxTokens: number; json: boolean; thinking?: VolcengineCallOptions["thinking"]; reasoningEffort?: VolcengineCallOptions["reasoningEffort"];
}) {
  // 省略thinking时维持原来的关闭思考；只有调用者明确指定才调整，不因换模型暗改参数。
  if (input.thinking !== undefined && !["disabled", "enabled", "auto"].includes(input.thinking)) throw new Error("火山思考模式无效");
  const effort=input.reasoningEffort;
  if (effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("火山推理档位无效");
  const off=effort === "none" || effort === "minimal";
  // 未传档位保持旧默认；显式选思考档时必须开启思考，不能被旧disabled默认值盖掉。
  if (effort && ((off && input.thinking === "enabled") || (!off && input.thinking === "disabled"))) throw new Error("火山思考开关与推理档位冲突");
  const thinking=input.thinking ?? (effort && !off ? "enabled" : "disabled");
  return { model: input.model, messages: input.messages, temperature: input.temperature,
    max_tokens: input.maxTokens, stream: false, thinking: { type: thinking },
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(input.json ? { response_format: { type: "json_object" } } : {}) };
}
