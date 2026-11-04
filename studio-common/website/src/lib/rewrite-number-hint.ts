import type { PromptMessage } from "./prompt-template";

/** 只检查改写正文，不把时间、轮次、stem中的2误当字幕。
 * 提示交给模型按语义选“两/二”，禁止程序全局替换破坏编号、年份或其他读法。
 * 在数据库模板展开前追加独立提示，因此自定义改写模板也不能覆盖本条件。
 */
export function withRewriteNumberHint(messages: PromptMessage[]): PromptMessage[] {
  if (!messages.some(m => /^(rewrite\.|fallback-rewrite\.)/.test(m.promptKey || ""))) return messages;
  const texts: string[] = [];
  for (const message of messages) {
    const values = message.promptValues || {};
    for (const key of ["original", "current", "text_jp"]) {
      if (typeof values[key] === "string") texts.push(values[key]);
    }
    if (message.promptKey === "fallback-rewrite.input" && typeof values.input_json === "string") {
      const input = JSON.parse(values.input_json) as { originalChinese?: string; japaneseAsr?: string; previousRounds?: { text?: string }[] };
      texts.push(input.originalChinese || "", input.japaneseAsr || "", ...(input.previousRounds || []).map(r => r.text || ""));
    }
  }
  if (!texts.some(text => /[2２]/u.test(text))) return messages;
  return [...messages, { role: "user", content: "", promptKey: "rewrite.number-two", promptValues: {} }];
}
