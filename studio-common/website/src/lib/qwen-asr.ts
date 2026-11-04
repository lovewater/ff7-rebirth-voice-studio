import { randomUUID } from "node:crypto";

export type QwenAsrResult = {
  text: string;
  language: string | null;
  alignment?: QwenAlignment;
  raw: unknown;
};

export type QwenAlignmentItem = { text: string; start_time: number; end_time: number };
export type QwenAlignment = {
  model: string;
  status: "ok" | "empty" | "unsupported_language" | "error";
  time_unit: "seconds";
  calc_time?: number;
  items: QwenAlignmentItem[];
  error?: string;
};

function parseAlignment(value: unknown): QwenAlignment {
  const fail = (error: string): QwenAlignment => ({ model: "Qwen/Qwen3-ForcedAligner-0.6B", status: "error", time_unit: "seconds", items: [], error });
  if (!value || typeof value !== "object") return fail("Qwen响应没有返回对齐证据");
  const row = value as Record<string, unknown>;
  if (typeof row.model !== "string" || row.time_unit !== "seconds"
    || !["ok", "empty", "unsupported_language", "error"].includes(String(row.status)) || !Array.isArray(row.items))
    return fail("Qwen对齐响应格式或时间单位无效");
  const items: QwenAlignmentItem[] = [];
  for (const entry of row.items) {
    if (!entry || typeof entry !== "object") return fail("Qwen字词轴格式无效");
    const item = entry as Record<string, unknown>;
    if (typeof item.text !== "string" || typeof item.start_time !== "number" || typeof item.end_time !== "number"
      || !Number.isFinite(item.start_time) || !Number.isFinite(item.end_time)) return fail("Qwen字词轴含无效时间");
    items.push({ text: item.text, start_time: item.start_time, end_time: item.end_time });
  }
  return { model: row.model, status: row.status as QwenAlignment["status"], time_unit: "seconds", items,
    ...(typeof row.calc_time === "number" && Number.isFinite(row.calc_time) ? { calc_time: row.calc_time } : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}) };
}

export async function qwenAsr(audioB64: string, language = "Chinese", options: { useForcedAligner?: boolean } = {}): Promise<QwenAsrResult> {
  const base = (process.env.QWEN_ASR_URL ?? "http://192.0.2.20:8001").replace(/\/$/, "");
  const response = await fetch(`${base}/asr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      task_id: randomUUID(),
      sample_audio: audioB64,
      language,
      ...(options.useForcedAligner ? { use_forced_aligner: true } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Qwen-ASR HTTP ${response.status}`);
  const payload = await response.json() as {
    success?: boolean;
    message?: string;
    results?: { text?: string; language?: string | null; alignment?: unknown }[];
  };
  if (!payload.success) throw new Error(payload.message || "Qwen-ASR 失败");
  const text = (payload.results ?? []).map((row) => row.text ?? "").join("").trim();
  const alignment = options.useForcedAligner
    ? payload.results?.length === 1 ? parseAlignment(payload.results[0].alignment)
      : { model: "Qwen/Qwen3-ForcedAligner-0.6B", status: "error" as const, time_unit: "seconds" as const, items: [], error: "Qwen返回多条或零条结果，不能将单条字轴与聚合文本混用" }
    : undefined;
  return { text, language: payload.results?.[0]?.language ?? null, ...(alignment ? { alignment } : {}), raw: payload };
}
