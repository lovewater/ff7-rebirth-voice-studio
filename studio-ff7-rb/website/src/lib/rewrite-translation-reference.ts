import { sql } from "./db";
import type { PromptMessage } from "./prompt-template";

const rewriteTasks = new Set([
  "script-rewrite", "manual-rewrite", "fallback-duration-rewrite",
  "two-parts-repair", "three-parts-repair", "prompt-trial-script-rewrite",
]);
type TranslationReference = {
  text_jp: string | null; text_en: string | null;
  translate_zh_jp: string | null; translate_zh_en: string | null;
};

/** 译文只作措辞/语义参考。原文与译文必须成对，不能把中文翻译当作日文拍数或ASR字轴。
 * 只在创作/改稿时注入，校字、分类、选择、字幕排版和独立翻译都不参与。
 * 不改原始messages中的日文/英文，更不改TTS正文或数据库字幕；无译文时沿用原流程。
 */
export async function withTranslationReferences(messages: PromptMessage[], task: string, stem?: string): Promise<PromptMessage[]> {
  if (!stem || !rewriteTasks.has(task)) return messages;
  const [row] = await sql<TranslationReference[]>`
    SELECT text_jp, text_en, translate_zh_jp, translate_zh_en FROM lines WHERE stem=${stem}
  `;
  if (!row || !(row.text_jp?.trim() && row.translate_zh_jp?.trim()) && !(row.text_en?.trim() && row.translate_zh_en?.trim())) return messages;
  const reference = (label: string, original: string | null, translation: string | null) => {
    if (!original?.trim()) return "";
    return `参考${label}：${original.trim()}${translation?.trim() ? `（${translation.trim()}）` : ""}`;
  };
  const references = [reference("日文", row.text_jp, row.translate_zh_jp), reference("英文", row.text_en, row.translate_zh_en)].filter(Boolean).join("\n");
  return [...messages, { role: "user", content: "", promptKey: "rewrite.translation-reference", promptValues: { references } }];
}
