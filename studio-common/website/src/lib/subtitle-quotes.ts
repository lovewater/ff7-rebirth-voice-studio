import { parseJsonObject, rewriteChat } from "./auto-run-llm";

const pairs: [string, string][] = [["「", "」"], ["『", "』"], ["｢", "｣"], ["“", "”"], ["‘", "’"], ['"', '"'], ["'", "'"], ["＂", "＂"], ["＇", "＇"], ["〝", "〞"], ["〝", "〟"]];
const quoteCharacters = new Set(pairs.flat());
const withoutQuotes = (text: string) => [...text].filter((char) => !quoteCharacters.has(char)).join("");

export function hasSubtitleQuotes(text: string) {
  return pairs.some(([open, close]) => {
    const start = text.indexOf(open);
    if (start < 0) return false;
    const end = text.indexOf(close, start + 1);
    return end > start + 1 && /[\p{L}\p{N}]/u.test(text.slice(start + 1, end));
  });
}

export function needsSubtitleQuotes(japanese: string, chinese: string) {
  return hasSubtitleQuotes(japanese) && !hasSubtitleQuotes(chinese);
}

/** 只允许插入成对引号，逐字符核对正文、标点、空白和换行均未改变。
 * 这是最终字幕整理，不修改五稿改写提示词、实际 TTS 稿或已生成的音频。
 */
export function validateSubtitleQuotes(source: string, value: unknown) {
  if (typeof value !== "string" || !hasSubtitleQuotes(value) || withoutQuotes(source) !== withoutQuotes(value)) {
    throw new Error("补引号模型只能给原台词插入引号，不能改字、标点或换行");
  }
  let index = 0;
  const original = [...source];
  for (const char of value) {
    if (char === original[index]) index += 1;
    else if (!quoteCharacters.has(char)) throw new Error("补引号模型改动了原文");
  }
  if (index !== original.length) throw new Error("补引号模型删掉了原文");
  const stack: string[] = [];
  for (const char of value) {
    if (!quoteCharacters.has(char)) continue;
    if (stack.at(-1) === char) { stack.pop(); continue; }
    const open = pairs.find(([mark]) => mark === char);
    if (!open) throw new Error("补引号模型返回了不配对的引号");
    stack.push(open[1]);
  }
  if (stack.length) throw new Error("补引号模型返回了不配对的引号");
  return value;
}

export async function addSubtitleQuotes(japanese: string, chinese: string) {
  if (!needsSubtitleQuotes(japanese, chinese)) return chinese;
  const { content } = await rewriteChat([
    { role: "system", content: [
      "你只负责给已确定的中文字幕补引号，不负责翻译、改写或断行。",
      "日文字幕有引用或强调用的「」/『』等引号，中文台词没有。请找出中文里语义对应的词语或名称，用中文双引号“”括起来。",
      "只允许插入成对引号。原中文字、其他标点、空格、换行及其顺序必须逐字符保持不变。引号不计拍数、不产生额外停顿，不需要调整文字长度。",
      "例如日文その名も『オトリ作戦』だ！、中文名字嘛，就是，诱饵作战！，返回名字嘛，就是，“诱饵作战”！。",
      '只输出 JSON：{"text":"加好引号的原中文台词"}。',
    ].join("\n"), promptKey: "subtitle-quotes.system", promptValues: {} },
    { role: "user", content: JSON.stringify({ japanese, chinese }), promptKey: "subtitle-quotes.input", promptValues: {"input_json": JSON.stringify({ japanese, chinese })} },
  ], 0.1, "subtitle-quotes");
  return validateSubtitleQuotes(chinese, parseJsonObject(content).text);
}
