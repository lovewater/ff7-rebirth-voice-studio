import { summarizeLlmCalls, type LlmCallMeasurement } from "./llm-metrics-summary";
import { AsyncLocalStorage } from "node:async_hooks";
import { insertLlmLog, completeLlmLog, type LlmLogCompletion } from "./llm-access-log";

const context = new AsyncLocalStorage<{ runId: string; stem: string; calls: LlmCallMeasurement[] }>();
export function withLlmMetrics<T>(runId: string, stem: string, operation: () => Promise<T>) {
  return context.run({ runId, stem, calls: [] }, operation);
}

/** 仅取得当前这次自动运行的数据，独立运行/并发运行之间不串账。
 * finish 在最后补引号等调用完成后取快照，最终主音频一次落库。
 */
export function llmMetricsForRun(runId: string | number) {
  const current = context.getStore();
  return summarizeLlmCalls(current?.runId === String(runId) ? current.calls : []);
}

/** 用量只信接口返回值。统一入口没有保存首token时点，因此这里只报端到端速率，
 * 其中包含网络、排队和预填充耗时，不能冒充模型的纯解码 tokens/s。
 * 自部署模型主动中止时通常收不到最终usage，保留未知，不按已收字符估token。
 */
export function llmUsageMetrics(usage: unknown, elapsedMs: number) {
  const u = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const detail = (key: string) => u[key] && typeof u[key] === "object" ? u[key] as Record<string, unknown> : {};
  const completionTokens = numeric(u.completion_tokens);
  return {
    promptTokens: numeric(u.prompt_tokens), completionTokens, totalTokens: numeric(u.total_tokens),
    cachedTokens: numeric(detail("prompt_tokens_details").cached_tokens),
    reasoningTokens: numeric(detail("completion_tokens_details").reasoning_tokens),
    endToEndOutputTokensPerSecond: completionTokens !== null && elapsedMs > 0 ? completionTokens * 1000 / elapsedMs : null,
  };
}

/** 先保存实际请求快照；手动请求传stem，自动请求从并发隔离上下文取得归属。 */
export async function beginLlmCall(input: Parameters<typeof insertLlmLog>[0]) {
  const current = context.getStore();
  return insertLlmLog({ ...input, runId: current?.runId, stem: input.stem ?? current?.stem });
}

export async function recordLlmCall(input: Omit<LlmLogCompletion, keyof LlmCallMeasurement> & {
  task: string; attempt: number; startedAt: string; elapsedMs: number;
}) {
  const current = context.getStore();
  const metrics = llmUsageMetrics(input.usage, input.elapsedMs);
  // 内存仅保留聚合所需数字，不让完整prompt/response在整场工作流中重复占内存。
  current?.calls.push({ elapsedMs: input.elapsedMs, ...metrics });
  await completeLlmLog({ ...input, ...metrics });
}
