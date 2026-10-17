import { setTimeout as delay } from "node:timers/promises";
import { beginLlmCall, recordLlmCall } from "./llm-metrics";
import { loggedSelfHostedChatFetch, type SelfHostedOptions } from "./llm-self-hosted";

export type ChatModelId = "primary" | "self-hosted";
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
/** 注册能力，不在这里指定哪些自动化任务要改用本地模型。调用方显式选modelId。 */
export const CHAT_MODELS = [
  { id: "primary", name: "现用云端模型", transport: "standard" },
  { id: "self-hosted", name: "自部署开源模型", transport: "guarded-stream" },
] as const;

export type ChatCallOptions = {
  messages: ChatMessage[]; modelId?: ChatModelId; temperature?: number; maxTokens?: number;
  task?: string; promptKeys?: string[]; stem?: string; attempts?: number; signal?: AbortSignal;
  json?: boolean; selfHosted?: SelfHostedOptions;
};

/** 只压缩送给模型阅读的数字：模板渲染后的正文、内嵌JSON和历史消息统一四舍五入到最多三位。
 * 不改计算/数据库原值，也不改模型参数、整数ID、版本号或URL；不补无意义的尾零。
 * 放在最终HTTP入口执行，避免某个调用方拼接字符串或回传历史消息时漏掉处理。
 */
export function roundLlmInputText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+|(?<![\w.])[-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=$|[^\w.]|(?:ms|s|Hz|kHz|fps|dB)(?![\w.]))/g, token => {
    if (token.startsWith("http") || !/[.eE]/.test(token)) return token;
    const value = Number(token);
    return Number.isFinite(value) ? String(Number(value.toFixed(3))) : token;
  });
}


/** 通用模型HTTP入口：先统一输入数字精度，按模型适配器调用；现用模型原样记非流式响应。
 * 自部署流式转交独立模块逐次记录，再向业务提供完整的兼容响应。
 * 每个HTTP重试独立一行，同次业务调用共享invocationId。只传业务body，不保存认证头。
 */
export async function loggedChatFetch(url: string, init: RequestInit, meta: {
  invocationId: string; task: string; attempt: number; promptKeys: string[]; stem?: string; modelId?: ChatModelId;
}, selfHostedOptions: SelfHostedOptions = {}) {
  if (typeof init.body !== "string") throw new Error("大模型请求必须提供JSON快照");
  const requestBody = JSON.parse(init.body) as Record<string, unknown>;
  if (Array.isArray(requestBody.messages)) {
    requestBody.messages = requestBody.messages.map(message =>
      message && typeof message.content === "string"
        ? { ...message, content: roundLlmInputText(message.content) } : message);
  }
  // 日志快照与真正发送的请求必须一致；响应和内部精度不受输入压缩影响。
  const requestInit = { ...init, body: JSON.stringify(requestBody) };
  if (meta.modelId === "self-hosted") return loggedSelfHostedChatFetch(url, requestInit, meta, selfHostedOptions);
  const model = String(requestBody.model ?? "");
  const startedAt = new Date().toISOString();
  const logId = await beginLlmCall({ ...meta, endpoint: url, requestBody, startedAt });
  const started = performance.now();
  let response: Response;
  let responseRaw: string;
  try {
    response = await fetch(url, requestInit);
    responseRaw = await response.clone().text();
  } catch {
    await recordLlmCall({ ...meta, logId, model, startedAt, elapsedMs: performance.now() - started,
      httpStatus: null, status: "network-error", error: "network-or-timeout" });
    throw new Error("改写服务网络异常或超时");
  }
  let parsed: { model?: string; usage?: unknown; choices?: { finish_reason?: string; message?: { content?: unknown; reasoning_content?: unknown } }[] } | undefined;
  try { parsed = JSON.parse(responseRaw); } catch { /* 非JSON也保存原文，业务层仍按原有规则报错。 */ }
  const choice = parsed?.choices?.[0];
  const content = choice?.message?.content;
  const reasoning = choice?.message?.reasoning_content;
  const status = !response.ok ? "http-error" : !parsed ? "invalid-json"
    : choice?.finish_reason === "length" ? "truncated" : typeof content !== "string" ? "invalid-response" : "success";
  await recordLlmCall({ ...meta, logId, model: typeof parsed?.model === "string" ? parsed.model : model,
    startedAt, elapsedMs: performance.now() - started, httpStatus: response.status,
    requestId: response.headers.get("x-request-id"), usage: parsed?.usage,
    responseRaw, responseBody: parsed, outputText: typeof content === "string" ? content : null,
    reasoningText: typeof reasoning === "string" ? reasoning : null, status,
    ...(status === "success" ? {} : { error: status }),
  });
  return response;
}


function checkedInteger(value: number, min: number, max: number, name: string) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}无效`);
  return value;
}

/** 通用模型入口。primary默认保持原有非流式行为；self-hosted显式选择，默认medium思考。
 * 输入为已完成模板替换的消息。数字压缩和数据库快照都在最终HTTP入口完成。
 */
export async function callChatCompletion(input: ChatCallOptions) {
  const modelId = input.modelId ?? "primary";
  if (!CHAT_MODELS.some(model => model.id === modelId)) throw new Error("未知大模型");
  const local = modelId === "self-hosted";
  const base = local ? process.env.SELF_HOSTED_LLM_URL : process.env.REWRITE_LLM_URL;
  const key = local ? process.env.SELF_HOSTED_LLM_KEY : process.env.REWRITE_LLM_KEY;
  const model = local ? process.env.SELF_HOSTED_LLM_MODEL : process.env.REWRITE_LLM_MODEL || "glm-5.3";
  if (!base || !model || (!local && !key)) throw new Error(local ? "尚未配置自部署模型地址和名称" : "尚未配置改写服务");
  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("模型接口协议无效");
  const attempts = checkedInteger(input.attempts ?? input.selfHosted?.maxAttempts ?? 3, 1, 10, "请求尝试次数");
  const maxTokens = checkedInteger(input.maxTokens ?? (local ? 16384 : 4096), 1, 131072, "输出上限");
  const temperature = input.temperature ?? (local ? 1 : 0.2);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("模型温度无效");
  const messages = input.messages.map(message => ({ role: message.role, content: message.content }));
  const body = JSON.stringify({ model, messages, temperature,
    ...(local ? { max_completion_tokens: maxTokens, reasoning_effort: "medium", top_p: 0.95, top_k: 20,
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium", preserve_thinking: true } }
      : { max_tokens: maxTokens, thinking: { type: "disabled" } }),
    stream: local,
    ...(input.json === false ? {} : { response_format: { type: "json_object" } }),
  });
  const invocationId = crypto.randomUUID();
  const meta = { invocationId, task: input.task ?? "unspecified", promptKeys: input.promptKeys ?? [], stem: input.stem, modelId };
  const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  let payload: { choices?: { finish_reason?: string; message?: { content?: unknown; reasoning_content?: unknown } }[] } = {};
  // 本地适配器自己负责逐次流式重试；这里不再外套同样的三次HTTP重试。
  for (let attempt = 1; attempt <= (local ? 1 : attempts); attempt += 1) {
    const signal = local ? input.signal : input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
    const response = await loggedChatFetch(url, { method: "POST", headers, cache: "no-store", signal, body },
      { ...meta, attempt }, { ...input.selfHosted, maxAttempts: attempts });
    if (response.ok) {
      try { payload = await response.json(); } catch { throw new Error("改写服务返回 JSON 异常"); }
      break;
    }
    await response.text().catch(() => undefined);
    if (response.status !== 500 || attempt === attempts) throw new Error(`改写服务返回 HTTP ${response.status}`);
    await delay(1500 * attempt, undefined, { signal: input.signal });
  }
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("模型输出被截断");
  const content = choice?.message?.content;
  if (typeof content !== "string") throw new Error("改写服务返回格式异常");
  const thinking = typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : "";
  return { content, thinking };
}
