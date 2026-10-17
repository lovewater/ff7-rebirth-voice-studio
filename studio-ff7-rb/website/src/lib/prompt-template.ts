export type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  promptKey?: string;
  promptValues?: Record<string, unknown>;
};
export type PromptPlaceholder = { name: string; description: string; example: unknown };

/** 单次替换，不递归解释输入中的{{...}}，避免字幕/ASR内容被当作模板执行。 */
export function renderPrompt(template: string, values: Record<string, unknown>) {
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`提示词缺少占位符：${name}`);
    const value = values[name];
    if (value == null) return "";
    return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** key相同只用最新启用版本；更新时间相同以id较大者为准。停用新版本时可回退到仍启用的旧版。 */
export function latestEnabledPrompts<T extends { id: string; key: string; enable: boolean; updated_at: string | Date }>(rows: T[]) {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (!row.enable) continue;
    const old = result.get(row.key), time = new Date(row.updated_at).getTime();
    if (!old || time > new Date(old.updated_at).getTime() || (time === new Date(old.updated_at).getTime() && BigInt(row.id) > BigInt(old.id))) result.set(row.key, row);
  }
  return result;
}
