import { sql } from "./db";
import { ttsPronunciationBody } from "./tts-pronunciation";

/** 与管理页共用数据库词库，只在真正发起中文 TTS 时读取，绝不传入 ASR/模型参考。 */
export async function prepareTtsPronunciationBody(endpoint: string, body: unknown): Promise<unknown> {
  if (endpoint !== "/v1/tts" && endpoint !== "/v1/tts/clone") return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  if (typeof request.text !== "string" || (request.lang && !/^(zh|zh-cn|chinese)$/i.test(String(request.lang)))) return body;
  const rows = await sql<{ src: string; dst: string }[]>`
    SELECT src, dst FROM pronunciations WHERE usage = 'tts_pinyin' ORDER BY char_length(src) DESC, src
  `;
  return ttsPronunciationBody(endpoint, body, rows.map(row => ({ word: row.src, replacement: row.dst })));
}
