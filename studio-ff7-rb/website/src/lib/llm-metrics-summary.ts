/** 音频主记录保存整次工作流的 LLM 统计；候选不分摊、不继承，避免重复计算消耗。
 * 用量仅累计接口实际返回的数据，未知保留 null，不按字数估算，也不把推理 token 再加一次。
 */
export type LlmCallMeasurement = {
  elapsedMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
};
const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function summarizeLlmCalls(calls: LlmCallMeasurement[], scope: "workflow" | "recorded-calls" = "workflow") {
  if (!calls.length) return { tokens: null, speed: null };
  const sum = (key: keyof LlmCallMeasurement) => {
    const values = calls.map((row) => row[key]).filter(known);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  // 速率按有实际输出用量及有效耗时的请求加权，不平均各请求的 token/s。
  // 未知输出量的失败请求计入累计等待时间，但不拿它的耗时稀释已知输出的速度。
  const rated = calls.filter((row) => known(row.completionTokens) && known(row.elapsedMs) && row.elapsedMs > 0);
  const ratedMs = rated.reduce((sum, row) => sum + row.elapsedMs!, 0);
  return {
    tokens: {
      input: sum("promptTokens"), output: sum("completionTokens"), total: sum("totalTokens"),
      cached: sum("cachedTokens"), reasoning: sum("reasoningTokens"), calls: calls.length,
      known_input_calls: calls.filter((row) => known(row.promptTokens)).length,
      known_output_calls: calls.filter((row) => known(row.completionTokens)).length, scope,
    },
    speed: {
      elapsed_ms: sum("elapsedMs"),
      output_tokens_per_second: ratedMs > 0 ? rated.reduce((sum, row) => sum + row.completionTokens!, 0) / (ratedMs / 1000) : null,
      measured_calls: rated.length, measured_elapsed_ms: ratedMs,
      // 包括网络/服务端排队/预填充，流式也只报完整请求口径，不能冒充纯解码或音频语速。
      metric: "end-to-end-output-tokens-per-second-v1",
    },
  };
}
