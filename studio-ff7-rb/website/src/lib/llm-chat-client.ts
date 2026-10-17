import { setTimeout as delay } from "node:timers/promises";
import { beginLlmCall, recordLlmCall } from "./llm-metrics";
import { loggedSelfHostedChatFetch, type SelfHostedOptions } from "./llm-self-hosted";
import { volcengineChatBody, volcengineLlmConfig } from "./llm-volcengine";

export type ChatModelId = "primary" | "volcengine" | "self-hosted";
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
/** 三套连接独立配置、独立记账；自部署仍只能由调用方显式选择。 */
export const CHAT_MODELS = [
  { id: "primary", name: "现用云端模型", transport: "standard" },
  { id: "volcengine", name: "火山 Agent Plan", transport: "standard" },
  { id: "self-hosted", name: "自部署开源模型", transport: "guarded-stream" },
] as const;

/** 仅创作/改写台词走火山；分类、校字、候选择优、断行和补引号都沿用原连接。
 * 统一按任务路由，覆盖自动五稿、整体fallback和手动改写，避免只改一个按钮漏掉其他路径。
 * 显式指定模型优先，供独立实验和自部署模型调用；配置缺失时不得自动回退。
 */
export function chatModelForTask(task = "unspecified", explicit?: ChatModelId): ChatModelId {
  if (explicit) return explicit;
  return ["script-rewrite", "fallback-duration-rewrite", "manual-rewrite", "prompt-trial-script-rewrite"].includes(task)
    ? "volcengine" : "primary";
}

export function chatModelConfigured(modelId: ChatModelId) {
  if (modelId === "volcengine") { const c = volcengineLlmConfig(); return !!(c.base && c.key && c.model); }
  if (modelId === "self-hosted") return !!(process.env.SELF_HOSTED_LLM_URL && process.env.SELF_HOSTED_LLM_MODEL);
  return !!(process.env.REWRITE_LLM_URL && process.env.REWRITE_LLM_KEY);
}

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

/** 通用模型入口。改稿任务走volcengine，其余默认primary；self-hosted显式选择，默认medium思考。
 * 输入为已完成模板替换的消息。数字压缩和数据库快照都在最终HTTP入口完成。
 */
export async function callChatCompletion(input: ChatCallOptions) {
  const modelId = chatModelForTask(input.task, input.modelId);
  if (!CHAT_MODELS.some(model => model.id === modelId)) throw new Error("未知大模型");
  const local = modelId === "self-hosted";
  const volcengine = modelId === "volcengine";
  const volc = volcengineLlmConfig();
  const base = local ? process.env.SELF_HOSTED_LLM_URL : volcengine ? volc.base : process.env.REWRITE_LLM_URL;
  const key = local ? process.env.SELF_HOSTED_LLM_KEY : volcengine ? volc.key : process.env.REWRITE_LLM_KEY;
  const model = local ? process.env.SELF_HOSTED_LLM_MODEL : volcengine ? volc.model : process.env.REWRITE_LLM_MODEL || "glm-5.3";
  if (!base || !model || (!local && !key)) throw new Error(local ? "尚未配置自部署模型地址和名称"
    : volcengine ? "尚未配置火山 Agent Plan 地址和密钥" : "尚未配置改写服务");
  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("模型接口协议无效");
  const attempts = checkedInteger(input.attempts ?? input.selfHosted?.maxAttempts ?? 3, 1, 10, "请求尝试次数");
  const maxTokens = checkedInteger(input.maxTokens ?? (local ? 16384 : 4096), 1, 131072, "输出上限");
  const temperature = input.temperature ?? (local ? 1 : 0.2);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("模型温度无效");
  const messages = input.messages.map(message => ({ role: message.role, content: message.content }));
  const body = JSON.stringify(volcengine ? volcengineChatBody({ model, messages, temperature, maxTokens, json: input.json !== false }) : { model, messages, temperature,
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
    let response: Response;
    try {
      response = await loggedChatFetch(url, { method: "POST", headers, cache: "no-store", signal, body },
        { ...meta, attempt }, { ...input.selfHosted, maxAttempts: attempts });
    } catch (error) {
      // 火山临时网络失败仍只重试同一套餐连接；取消和数据库写入失败不重复花钱请求。
      if (!volcengine || signal?.aborted || !(error instanceof Error)
        || error.message !== "改写服务网络异常或超时" || attempt === attempts) throw error;
      await delay(1500 * attempt, undefined, { signal: input.signal });
      continue;
    }
    if (response.ok) {
      try { payload = await response.json(); } catch { throw new Error("改写服务返回 JSON 异常"); }
      break;
    }
    await response.text().catch(() => undefined);
    const retryable = volcengine ? response.status === 408 || response.status === 429 || response.status >= 500 : response.status === 500;
    if (!retryable || attempt === attempts) throw new Error(`${volcengine ? "火山 Agent Plan" : "改写服务"}返回 HTTP ${response.status}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    await delay(volcengine && response.status === 429
      ? Math.min(60000, Math.max(5000 * attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0))
      : 1500 * attempt, undefined, { signal: input.signal });
  }
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("模型输出被截断");
  const content = choice?.message?.content;
  if (typeof content !== "string") throw new Error("改写服务返回格式异常");
  const thinking = typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : "";
  return { content, thinking };
}
