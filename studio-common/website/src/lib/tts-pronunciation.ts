import { inlinePinyinForTts } from "./inline-pinyin";
import dictionary from "./pronunciation/liao3.json";

export type TtsPronunciationRule = { word: string; replacement: string };

/**
 * IndexTTS 2.0 用 LIAO3 直接替换汉字，而非 2.5 的 <了|LIAO3> 标注。
 * 只在 HTTP 合成请求出站时应用：大模型、字幕、ASR 校字、拍数和数据库朗读稿
 * 始终使用原汉字。不能在 normalizeScript 中替换，否则会把一个字算成多个字符。
 * 长词优先，命中后一次消费；不跨空白/停顿符，也不再次处理用户已写的拼音。
 * 得了、明了、知了和独立的不了存在分词歧义，不能全局替换。
 */
export function applyTtsPronunciation(text: string, entries: TtsPronunciationRule[] = dictionary.rules): string {
  text = inlinePinyinForTts(text);
  const rules = [...entries].sort((a, b) => b.word.length - a.word.length);
  let result = "";
  for (let i = 0; i < text.length;) {
    const excluded = dictionary.excludePrefixes.find((word) => text.startsWith(word, i));
    if (excluded) {
      result += excluded;
      i += excluded.length;
      continue;
    }
    // “为了解开/赢得了解放”已排除；未来新出现的“了＋解开/解放…”也保守保留。
    const rule = rules.find(({ word }) => text.startsWith(word, i) && !(
      word === "了解" && /^了解(?:开|放|除|决|救|散|冻|锁|脱|围|压|雇)/.test(text.slice(i))
    ));
    if (rule) {
      result += rule.replacement;
      i += rule.word.length;
    } else {
      result += text[i++];
    }
  }
  return result;
}

/** 只改中文合成接口的 text 字段，不修改调用者对象或注册音色等其他请求。 */
export function ttsPronunciationBody(endpoint: string, body: unknown, entries: TtsPronunciationRule[] = dictionary.rules): unknown {
  if (endpoint !== "/v1/tts" && endpoint !== "/v1/tts/clone") return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  if (typeof request.text !== "string") return body;
  if (request.lang && !/^(zh|zh-cn|chinese)$/i.test(String(request.lang))) return body;
  return { ...request, text: applyTtsPronunciation(request.text, entries) };
}
