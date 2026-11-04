import { setTimeout as delay } from "node:timers/promises";
import { beginLlmCall, recordLlmCall } from "./llm-metrics";
import { RepetitionDetector, type RepetitionHit } from "./llm-repetition";
import { consumeLlmSse } from "./llm-sse";

type FailureCode = "repetition-detected" | "stream-error" | "timeout" | "cancelled"
  | "http-error" | "network-error" | "invalid-json" | "invalid-response" | "truncated";
export type SelfHostedCallMeta = {
  invocationId: string; task: string; attempt: number; promptKeys: string[]; stem?: string;
};
export type SelfHostedOptions = {
  maxAttempts?: number; timeoutMs?: number; idleTimeoutMs?: number; retryDelayMs?: number;
  maxPatternLength?: number;
};

export class SelfHostedLlmError extends Error {
  constructor(readonly code: FailureCode, message: string, readonly attempts: number,
    readonly details?: { channel: "content" | "reasoning"; repetition: RepetitionHit }) {
    super(message);
    this.name = "SelfHostedLlmError";
  }
}

/** 本机服务只有四个活跃序列槽。并发限制覆盖整个调用与重试；取消排队不占槽。
 * 使用进程内共享实例，Next不同入口复用同一上限，不让每个入口各自开四路。
 */
class Slots {
  private active = 0;
  private queue: (() => void)[] = [];
  acquire(signal?: AbortSignal | null): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        this.queue = this.queue.filter(item => item !== start);
        reject(new SelfHostedLlmError("cancelled", "自部署模型调用已取消", 0));
      };
      const start = () => {
        signal?.removeEventListener("abort", cancelled);
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.queue.shift()?.();
        });
      };
      if (signal?.aborted) { cancelled(); return; }
      if (this.active < 4) start();
      else { this.queue.push(start); signal?.addEventListener("abort", cancelled, { once: true }); }
    });
  }
}
const shared = globalThis as typeof globalThis & { __ff7SelfHostedLlmSlots?: Slots };
const slots = shared.__ff7SelfHostedLlmSlots ??= new Slots();

function positive(value: number | undefined, fallback: number, max: number) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0 || result > max) throw new Error("自部署模型调用参数无效");
  return result;
}

/** 自部署开源模型适配器：真正流式读取，但向业务返回兼容非流式的Response。
 * 每个HTTP尝试独立记日志；失败半截绝不混进下一次prompt，也不当成功稿返回。
 * 连续重复10次，立即abort HTTP并cancel reader，让服务端停止生成，再从原请求重试。
 * 默认共3次尝试（首发+2次重试），失败抛错；不偷偷改调收费模型。
 */
export async function loggedSelfHostedChatFetch(url: string, init: RequestInit, meta: SelfHostedCallMeta,
  options: SelfHostedOptions = {}) {
  if (typeof init.body !== "string") throw new Error("自部署模型请求必须提供JSON快照");
  const source = JSON.parse(init.body) as Record<string, unknown>;
  if (source.n !== undefined && source.n !== 1) throw new Error("自部署流式适配器仅支持n=1");
  const requestBody: Record<string, unknown> = { ...source, stream: true, stream_options: { include_usage: true } };
  const attempts = positive(options.maxAttempts, 3, 10);
  // 本地medium可能思考数分钟，不沿用收费非思考接口120秒总超时。
  const timeoutMs = positive(options.timeoutMs, 30 * 60_000, 3_600_000);
  const idleTimeoutMs = positive(options.idleTimeoutMs, 120_000, 3_600_000);
  const maxPatternLength = positive(options.maxPatternLength, 512, 4096);
  const retryDelayMs = options.retryDelayMs ?? 250;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) throw new Error("重试间隔无效");
  const release = await slots.acquire(init.signal);
  try {
    for (let index = 0; index < attempts; index += 1) {
      if (init.signal?.aborted) throw new SelfHostedLlmError("cancelled", "自部署模型调用已取消", index);
      const attempt = meta.attempt + index;
      const startedAt = new Date().toISOString();
      // 日志写入失败时不请求模型；写完成日志失败时也不继续重试。
      const logId = await beginLlmCall({ ...meta, attempt, endpoint: url, requestBody, startedAt });
      const started = performance.now();
      const controller = new AbortController();
      const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      const abortTimeout = () => controller.abort(new SelfHostedLlmError("timeout", "自部署模型等待超时", index + 1));
      const totalTimer = setTimeout(abortTimeout, timeoutMs);
      let idleTimer = setTimeout(abortTimeout, idleTimeoutMs);
      const progressed = () => { clearTimeout(idleTimer); idleTimer = setTimeout(abortTimeout, idleTimeoutMs); };
      let raw = "", content = "", reasoning = "", finishReason: string | null = null;
      let usage: unknown, model = String(requestBody.model ?? ""), id: unknown, created: unknown;
      let httpStatus: number | null = null, requestId: string | null = null;
      let done = false, retryable = true;
      let failure: SelfHostedLlmError | undefined;
      const detectors = { content: new RepetitionDetector(10, maxPatternLength), reasoning: new RepetitionDetector(10, maxPatternLength) };
      const collect = (channel: "content" | "reasoning", value: unknown) => {
        if (value === undefined || value === null) return;
        if (typeof value !== "string") throw new SelfHostedLlmError("invalid-response", "模型流式文本格式异常", index + 1);
        if (!value) return;
        progressed();
        if (channel === "content") content += value; else reasoning += value;
        const hit = detectors[channel].push(value);
        if (hit) {
          const error = new SelfHostedLlmError("repetition-detected", `模型${channel === "content" ? "正文" : "思考"}连续重复10次`,
            index + 1, { channel, repetition: hit });
          controller.abort(error);
          throw error;
        }
      };
      try {
        const response = await fetch(url, { ...init, body: JSON.stringify(requestBody), signal });
        httpStatus = response.status;
        requestId = response.headers.get("x-request-id");
        if (!response.ok) {
          raw = await response.text();
          retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new SelfHostedLlmError("http-error", `自部署模型返回HTTP ${response.status}`, index + 1);
        }
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
          raw = await response.text();
          throw new SelfHostedLlmError("stream-error", "自部署模型未返回SSE流", index + 1);
        }
        await consumeLlmSse(response.body, data => {
          if (data.trim() === "[DONE]") { done = true; return false; }
          let event: Record<string, unknown>;
          try { event = JSON.parse(data); } catch { throw new SelfHostedLlmError("stream-error", "模型SSE事件JSON异常", index + 1); }
          if (!event || typeof event !== "object" || event.error) throw new SelfHostedLlmError("stream-error", "模型流式服务返回错误", index + 1);
          if (typeof event.model === "string") model = event.model;
          id ??= event.id; created ??= event.created;
          if (event.usage && typeof event.usage === "object") usage = event.usage;
          if (event.choices !== undefined && !Array.isArray(event.choices)) throw new SelfHostedLlmError("stream-error", "模型choices格式异常", index + 1);
          for (const choice of (event.choices ?? []) as Record<string, unknown>[]) {
            if (!choice || (choice.index !== undefined && choice.index !== 0)) throw new SelfHostedLlmError("invalid-response", "模型流返回了意外候选", index + 1);
            const delta = choice.delta;
            if (delta !== undefined && (!delta || typeof delta !== "object")) throw new SelfHostedLlmError("stream-error", "模型delta格式异常", index + 1);
            const fields = (delta ?? {}) as Record<string, unknown>;
            // 两种reasoning字段为兼容别名，同一事件不重复累计；正文与思考独立检测。
            const thought = fields.reasoning_content;
            collect("reasoning", thought === "" ? fields.reasoning ?? thought : thought ?? fields.reasoning);
            collect("content", fields.content);
            if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
            if (finishReason === "repetition" || choice.stop_reason === "repetition_detected") {
              throw new SelfHostedLlmError("repetition-detected", "推理服务检测到连续重复", index + 1);
            }
          }
          return true;
        }, text => { raw += text; });
        if (!done || !finishReason) throw new SelfHostedLlmError("stream-error", "模型SSE提前结束", index + 1);
        if (finishReason === "length") throw new SelfHostedLlmError("truncated", "模型达到输出上限", index + 1);
        if (finishReason !== "stop" || !content.trim()) throw new SelfHostedLlmError("invalid-response", "模型未完成有效回答", index + 1);
        const format = requestBody.response_format as { type?: string } | undefined;
        if (format?.type === "json_object" || format?.type === "json_schema") {
          let parsed: unknown;
          try { parsed = JSON.parse(content); } catch { throw new SelfHostedLlmError("invalid-json", "模型正文不是完整JSON", index + 1); }
          if (format.type === "json_object" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
            throw new SelfHostedLlmError("invalid-json", "模型正文不是JSON对象", index + 1);
          }
        }
      } catch (error) {
        failure = init.signal?.aborted ? new SelfHostedLlmError("cancelled", "自部署模型调用已取消", index + 1)
          : controller.signal.reason instanceof SelfHostedLlmError ? controller.signal.reason
          : error instanceof SelfHostedLlmError ? error
          : new SelfHostedLlmError(httpStatus === null ? "network-error" : "stream-error", "自部署模型网络或流式读取异常", index + 1);
        controller.abort(failure);
      } finally {
        clearTimeout(totalTimer); clearTimeout(idleTimer);
      }
      const aggregated = { id, created, model, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content, reasoning_content: reasoning }, finish_reason: finishReason }],
        ...(usage === undefined ? {} : { usage }),
        ...(failure ? { stream_guard: { code: failure.code, ...failure.details } } : {}) };
      await recordLlmCall({ ...meta, attempt, logId, model, startedAt, elapsedMs: performance.now() - started,
        httpStatus, requestId, status: failure?.code ?? "success", usage,
        responseRaw: raw, responseBody: aggregated, outputText: content, reasoningText: reasoning,
        ...(failure ? { error: failure.message } : {}) });
      if (!failure) return new Response(JSON.stringify(aggregated), { status: 200,
        headers: { "content-type": "application/json", ...(requestId ? { "x-request-id": requestId } : {}) } });
      if (failure.code === "cancelled" || !retryable || index === attempts - 1) throw failure;
      // 只重发原请求；保留随机采样，不拼接半截失败答复，不自动切收费服务。
      try { await delay(retryDelayMs * 2 ** index, undefined, { signal: init.signal ?? undefined }); }
      catch { throw new SelfHostedLlmError("cancelled", "自部署模型调用已取消", index + 1); }
    }
    throw new Error("自部署模型重试状态异常");
  } finally { release(); }
}
