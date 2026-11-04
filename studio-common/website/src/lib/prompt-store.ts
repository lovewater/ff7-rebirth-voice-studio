import { sql } from "./db";
import { renderPrompt, type PromptMessage, type PromptPlaceholder } from "./prompt-template";
export type PromptRow = {
  id: string; key: string; category: string; name: string; desc: string; prompt: string; enable: boolean;
  role: string; placeholders: PromptPlaceholder[]; source_path: string | null; created_at: Date; updated_at: Date;
};

/** 每次模型请求从数据库读，不用进程缓存，版本启停后下一次请求立即生效。
 * 禁止退回代码内置文案掩盖“该key无启用版本”；管理页的当前生效判断使用同一排序。
 * promptKey/promptValues仅供本地绑定，发给模型前一律去掉，历史assistant消息原样保留。
 */
export async function resolvePromptMessages(messages: PromptMessage[]) {
  const keys = [...new Set(messages.map(m => m.promptKey).filter((key): key is string => !!key))];
  const rows = keys.length ? await sql<PromptRow[]>`
    SELECT DISTINCT ON (key) id::text AS id, key, category, name, "desc", prompt, enable, role,
      placeholders, source_path, created_at, updated_at
    FROM prompt_templates WHERE key = ANY(${keys}) AND enable = true
    ORDER BY key ASC, updated_at DESC, id DESC
  ` : [];
  const byKey = new Map(rows.map(r => [r.key, r]));
  return messages.map(message => {
    if (!message.promptKey) return { role: message.role, content: message.content };
    const row = byKey.get(message.promptKey);
    if (!row) throw new Error(`提示词未配置启用版本：${message.promptKey}`);
    if (row.role !== message.role) throw new Error(`提示词角色不匹配：${message.promptKey}`);
    return { role: message.role, content: renderPrompt(row.prompt, message.promptValues || {}) };
  });
}
