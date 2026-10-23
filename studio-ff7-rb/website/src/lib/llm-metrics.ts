import { sql } from "./db";
import { summarizeLlmCalls, type LlmCallMeasurement } from "./llm-metrics-summary";
import { AsyncLocalStorage } from "node:async_hooks";
import { insertLlmLog, completeLlmLog, type LlmLogCompletion } from "./llm-access-log";

const context = new AsyncLocalStorage<{ runId: string; stem: string; calls: LlmCallMeasurement[] }>();
/** 改稿读取本句参考译文时复用自动运行归属；四并发从各自上下文取得stem。 */
export function currentLlmStem(){return context.getStore()?.stem;}

export function withLlmMetrics<T>(runId: string, stem: string, operation: () => Promise<T>) {
  return context.run({ runId, stem, calls: [] }, operation);
}

/** 仅取得当前这次自动运行的数据，独立运行/并发运行之间不串账。
 * finish 在最后补引号等调用完成后取快照，最终主音频一次落库。
 */
/** clone子请求有独立HTTP上下文；结束时按运行ID从访问日志聚合，包含逐段核字/合并模型，避免只统计主请求而漏账。 */
export async function llmMetricsForRun(runId: string | number) {
  // PostgreSQL bigint默认返回字符串；显式转double再汇总，避免把真实用量当成未知。
  const rows=await sql<LlmCallMeasurement[]>`SELECT input_tokens::double precision AS "promptTokens",output_tokens::double precision AS "completionTokens",
    total_tokens::double precision AS "totalTokens",cached_tokens::double precision AS "cachedTokens",reasoning_tokens::double precision AS "reasoningTokens",elapsed_ms::double precision AS "elapsedMs"
    FROM llm_access_logs WHERE auto_run_id=${runId} AND completed_at IS NOT NULL ORDER BY id`;
  return summarizeLlmCalls(rows);
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
