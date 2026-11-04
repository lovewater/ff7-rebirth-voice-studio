/** 单条改稿请求的重试上限：首次调用之外最多再试三次，即最多四次请求。
 * 只重试失败的这一稿，先前已成功的候选保留；不把五稿整组重跑。
 */
export const MAX_REWRITE_RESPONSE_RETRIES = 3;
export class RewriteDraftUnavailableError extends Error {
  readonly draftNumber: number;
  readonly attempts: number;
  constructor(draftNumber: number, attempts: number, detail: string) {
    super(`第 ${draftNumber} 稿在首次调用及 ${MAX_REWRITE_RESPONSE_RETRIES} 次重试后仍无可用台词：${detail}`);
    this.name = "RewriteDraftUnavailableError";
    this.draftNumber = draftNumber;
    this.attempts = attempts;
  }
}
export type RewriteRetryEvent = { draftNumber: number; failedAttempt: number; nextAttempt: number; maxAttempts: number; error: string; retryDelayMs?: number };

export async function retryRewriteDraft<T>(draftNumber: number, operation: () => Promise<T>, onRetry?: (event: RewriteRetryEvent) => Promise<void>, options: { signal?: AbortSignal } = {}) {
  const maxAttempts = 1 + MAX_REWRITE_RESPONSE_RETRIES;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      // Grok transport ambiguity, cancellation and authentication failures must
      // not become four immediate paid requests. Other providers retain their policy.
      if (error instanceof GrokLlmError || (error instanceof GrokHttpError && !error.retryable)) throw error;
      if (options.signal?.aborted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts) throw new RewriteDraftUnavailableError(draftNumber, attempt, detail);
      const retryDelayMs = error instanceof GrokHttpError ? grokRetryDelayMs(error.status, attempt, error.retryAfter) : undefined;
      await onRetry?.({ draftNumber, failedAttempt: attempt, nextAttempt: attempt + 1, maxAttempts, error: detail,
        ...(retryDelayMs === undefined ? {} : { retryDelayMs }) });
      if (retryDelayMs !== undefined) await delay(retryDelayMs, undefined, { signal: options.signal });
    }
  }
  throw new Error("改稿重试状态异常");
}
import { setTimeout as delay } from "node:timers/promises";
import { GrokHttpError, GrokLlmError, grokRetryDelayMs } from "./llm-grok";
