import { randomUUID } from "node:crypto";

export type QwenAsrResult = {
  text: string;
  language: string | null;
  raw: unknown;
};

export async function qwenAsr(audioB64: string, language = "Chinese"): Promise<QwenAsrResult> {
  const base = (process.env.QWEN_ASR_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("请配置 QWEN_ASR_URL");
  const response = await fetch(`${base}/asr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      task_id: randomUUID(),
      sample_audio: audioB64,
      language,
    }),
  });
  if (!response.ok) throw new Error(`Qwen-ASR HTTP ${response.status}`);
  const payload = await response.json() as {
    success?: boolean;
    message?: string;
    results?: { text?: string; language?: string | null }[];
  };
  if (!payload.success) throw new Error(payload.message || "Qwen-ASR 失败");
  const text = (payload.results ?? []).map((row) => row.text ?? "").join("").trim();
  return { text, language: payload.results?.[0]?.language ?? null, raw: payload };
}
