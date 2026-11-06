/** Persisted model IDs retain their original meaning after a default switch. */
export function autoRunStageLabel(kind: string | undefined, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const stage = payload as { stage?: unknown; model?: unknown; allowGapSplit?: unknown };
  const name = stage.model === "grok" ? "Grok 4.7"
    : stage.model === "primary" ? "官方GLM 5.3"
    : stage.model === "volcengine" ? "火山 DeepSeek V4.1 Flash（历史）"
    : stage.model === "self-hosted" ? "自部署模型（历史）" : "";
  if (!name) return "";
  if (kind === "casual") return `${name} · 普通时长单轮`;
  if (kind !== "performance" || ![1, 2, 3].includes(stage.stage as number)) return name;
  const round = stage.model === "grok" ? `第${stage.stage}/3轮` : `第${stage.stage}轮`;
  return `${name} · ${round}${stage.allowGapSplit === true ? " · 允许补切" : ""}`;
}
