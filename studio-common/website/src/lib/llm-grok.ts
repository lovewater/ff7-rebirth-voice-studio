/** Grok proxy is an independent connection. It must never reuse the GLM/Volcengine key. */
export const GROK_DEFAULT_MODEL = "grok-4.7";
export const GROK_DEFAULT_TIMEOUT_MS = 310000;
export const GROK_MAX_ATTEMPTS = 3;
export const GROK_MAX_RETRY_DELAY_MS = 60000;

export function grokLlmConfig() {
  const base = process.env.GROK_LLM_URL?.trim();
  const key = process.env.GROK_LLM_KEY?.trim();
  const model = process.env.GROK_LLM_MODEL?.trim() || GROK_DEFAULT_MODEL;
  if (!/^[a-zA-Z0-9_.:-]+$/.test(model)) throw new Error("Grok模型名称无效");
  if (base) {
    let url: URL;
    try { url = new URL(base); } catch { throw new Error("Grok接口地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Grok接口地址不允许凭据或查询参数");
    }
  }
  return { base, key, model };
}

export function grokChatBody(input: {
  model: string; messages: { role: string; content: string }[];
  temperature: number; maxTokens: number; json: boolean;
}) {
  return {
    model: input.model, messages: input.messages, temperature: input.temperature,
    max_tokens: input.maxTokens, stream: false, reasoning_effort: "low",
    ...(input.json ? { response_format: { type: "json_object" } } : {}),
  };
}

export function grokRetryableStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Retry-After may be seconds or an HTTP date. Both it and exponential backoff are bounded. */
export function grokRetryDelayMs(status: number, attempt: number, retryAfter: string | null, now = Date.now()) {
  // The single-account proxy cools down for 15s after upstream 5xx; 429 may take longer.
  const exponential = (status === 429 ? 30000 : 15000) * 2 ** Math.min(Math.max(attempt - 1, 0), 5);
  const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
  const date = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now : 0;
  return Math.min(GROK_MAX_RETRY_DELAY_MS, Math.max(exponential, requested));
}

/** Safe metadata for an outer business retry: no provider response or authentication value. */
export class GrokHttpError extends Error {
  readonly code = "http-error";
  readonly retryable: boolean;
  readonly retryAfter: string | null;
  constructor(readonly status: number, retryAfter: string | null) {
    super(`Grok返回 HTTP ${status}`);
    this.name = "GrokHttpError";
    this.retryable = grokRetryableStatus(status);
    const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
    const date = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
    this.retryAfter = Number.isFinite(seconds) && seconds >= 0 ? String(seconds)
      : Number.isFinite(date) ? new Date(date).toUTCString() : null;
  }
}

export class GrokLlmError extends Error {
  constructor(readonly code: "cancelled" | "timeout" | "network-error", message: string) {
    super(message);
    this.name = "GrokLlmError";
  }
}

/** A proxy error may echo authentication material; redact it from replay logs, never log headers. */
export function grokLogText(text: string, key: string | undefined) {
  if (!key) return text;
  for (const secret of new Set([key, JSON.stringify(key).slice(1, -1)])) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text;
}
