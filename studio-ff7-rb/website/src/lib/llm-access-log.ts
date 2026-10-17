import { sql } from "./db";
import type { LlmCallMeasurement } from "./llm-metrics-summary";

/** endpoint只保留协议/主机/路径，去掉潜在的userinfo、查询密钥和片段。 */
export function safeLlmEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export async function insertLlmLog(input: {
  invocationId: string; attempt: number; runId?: string; stem?: string; task: string;
  endpoint: string; requestBody: Record<string, unknown>; promptKeys: string[]; startedAt: string;
}) {
  // 请求先落库才花钱调用；数据库不可写时不发送无从回放的收费请求。
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO llm_access_logs(invocation_id,attempt,auto_run_id,stem,task,endpoint,requested_model,prompt_keys,request_body,started_at)
    VALUES (${input.invocationId},${input.attempt},${input.runId ?? null},${input.stem ?? null},${input.task},
      ${safeLlmEndpoint(input.endpoint)},${String(input.requestBody.model ?? "")},${input.promptKeys},
      ${sql.json(JSON.parse(JSON.stringify(input.requestBody)))},${input.startedAt})
    RETURNING id::text
  `;
  return row.id;
}

export type LlmLogCompletion = LlmCallMeasurement & {
  logId: string; model: string; status: "success" | "http-error" | "network-error" | "invalid-json" | "invalid-response" | "truncated"
    | "repetition-detected" | "stream-error" | "timeout" | "cancelled";
  httpStatus: number | null; requestId?: string | null; error?: string;
  responseRaw?: string; responseBody?: unknown; usage?: unknown;
  outputText?: string | null; reasoningText?: string | null; endToEndOutputTokensPerSecond?: number | null;
};

export async function completeLlmLog(row: LlmLogCompletion) {
  const json = (value: unknown) => value === undefined ? null : sql.json(JSON.parse(JSON.stringify(value)));
  await sql`
    UPDATE llm_access_logs SET response_model=${row.model},status=${row.status},
      response_raw=${row.responseRaw ?? null},response_body=${json(row.responseBody)},
      output_text=${row.outputText ?? null},reasoning_text=${row.reasoningText ?? null},usage=${json(row.usage)},
      input_tokens=${row.promptTokens ?? null},output_tokens=${row.completionTokens ?? null},total_tokens=${row.totalTokens ?? null},
      cached_tokens=${row.cachedTokens ?? null},reasoning_tokens=${row.reasoningTokens ?? null},elapsed_ms=${row.elapsedMs ?? null},
      output_tokens_per_second=${row.endToEndOutputTokensPerSecond ?? null},http_status=${row.httpStatus},
      request_id=${row.requestId ?? null},error=${row.error ?? null},completed_at=now()
    WHERE id=${row.logId}
  `;
}
