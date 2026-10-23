import { subtitleCharacters } from "./auto-run-subtitle";

/** 旧换行只作为排版空白移除，不新增标点；已有标点原样保留。 */
export function flattenSubtitleForReflow(draft: string) {
  const lines = draft.replace(/\[停顿=\d{1,4}\]/gu, "")
    .replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n")
    .split("\n").map(line => line.trim()).filter(Boolean);
  return lines.join("");
}

function cleanBreakEnd(text: string) {
  return text.replace(/[，,。．]+$/u, "").replace(/(?<!\.)\.(?!\.)$/u, "").trimEnd();
}

/** 仅允许移动换行，及用换行替代该处逗号/单句号；问叹号、省略号、引号及其余标点必须保留。 */
export function validateReflowSubtitleLines(source: string, lines: unknown) {
  if (!Array.isArray(lines) || lines.length !== 2 || lines.some(line => typeof line !== "string" || /[\r\n]/u.test(line)))
    throw Error("字幕重新排版必须返回两行原文");
  const [left, right] = (lines as string[]).map(line => line.trim());
  if (!subtitleCharacters(left) || !subtitleCharacters(right)) throw Error("字幕重新排版不能产生空行");
  if (/[.…]$/u.test(left) && /^[.…]/u.test(right)) throw Error("字幕不能拆开省略号");
  const same = source === left + right;
  const separator = ["，", ",", "。", "．", "."].find(mark => source === left + mark + right);
  if (!same && !separator) throw Error("字幕排版改动了原文或语气标点");
  if ((separator === "." && (/\.$/u.test(left) || /^\./u.test(right)))
    || (/[\p{N}]$/u.test(cleanBreakEnd(left)) && /^\p{N}/u.test(right))) throw Error("字幕不能拆开数字或省略号");
  return `${cleanBreakEnd(left)}\n${right}`;
}

const wordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

/** 纯本地字幕排版：优先选择长度均衡的标点断点，标点切口严重偏斜时也可采用词边界。
 * 只移除旧换行、插入新换行；切口逗句号可由换行替代，不增补任何标点或正文。
 * 数字、小数、拉丁单词、省略号及成对标点不在内部拆开。
 */
export function reflowSubtitleLocally(draft: string, options: { preserveBreakPunctuation?: boolean } = {}): string {
  const source = flattenSubtitleForReflow(draft);
  const total = subtitleCharacters(source);
  if (total <= 15) return source;
  const punctuation: { index: number; score: number }[] = [];
  const words: { index: number; score: number }[] = [];
  let quoteDepth = 0;
  for (const token of wordSegmenter.segment(source)) {
    const at = token.index;
    for (const char of token.segment) {
      if (/[“「『（(《【]/u.test(char)) quoteDepth++;
      if (/[”」』）)》】]/u.test(char)) quoteDepth = Math.max(0, quoteDepth - 1);
    }
    const index = at + token.segment.length;
    if (index === source.length) continue;
    const left = source.slice(0, index).trimEnd(), right = source.slice(index).trimStart();
    const a = subtitleCharacters(left), b = subtitleCharacters(right);
    if (!a || !b || /^[\p{P}\p{S}]/u.test(right) || /[（(“「『《【]$/u.test(left)) continue;
    if (/[\p{N}.]$/u.test(left) && /^[\p{N}.]/u.test(right)) continue;
    let score = Math.abs(a - b) / total + (quoteDepth ? 2 : 0);
    if (/[\p{P}\p{S}]$/u.test(left)) punctuation.push({ index, score });
    else {
      if (/(?:的|地|得|把|被|在|和|与|及|对|向|从|将|给|且|或|用)$/u.test(left)) score += 1;
      if (/^(?:的|地|得|了|着|过|吗|呢|吧|啊|呀|么|到|成|来)/u.test(right)) score += 1;
      words.push({ index, score: score + 0.3 });
    }
  }
  const candidates = [...punctuation, ...words];
  const best = candidates.reduce<(typeof candidates)[number] | undefined>((a, b) => !a || b.score < a.score ? b : a, undefined);
  // 单个不可拆的长数字/单词保留整体，不强行切开。
  return best ? `${options.preserveBreakPunctuation ? source.slice(0, best.index).trimEnd() : cleanBreakEnd(source.slice(0, best.index))}\n${source.slice(best.index).trimStart()}` : source;
}

/** 恢复前序临时断行丢掉的原稿逗句号，绝不凭空补标点。
 * 只有正文逐字相同时才能按正文位置对齐；已有标点优先，不改人工正文/引号/语气。
 */
export function restoreSubtitleSourcePunctuation(caption: string, reference?: string): string {
  if (!reference) return caption;
  const body = (text: string) => flattenSubtitleForReflow(text).replace(/[\s\p{P}\p{S}]/gu, "");
  if (body(caption) !== body(reference)) return caption;
  const marks = new Map<number, string>();
  let offset = 0;
  for (const token of flattenSubtitleForReflow(reference).matchAll(/[\p{P}\p{S}\s]+|[^\p{P}\p{S}\s]+/gu)) {
    if (/^[，,。．.]$/u.test(token[0])) marks.set(offset, token[0]);
    else if (!/^[\p{P}\p{S}\s]+$/u.test(token[0])) offset += [...token[0]].length;
  }
  const tokens = [...caption.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n")];
  let result = "";
  offset = 0;
  for (let index = 0; index <= tokens.length; index++) {
    if (index === tokens.length || !/[\s\p{P}\p{S}]/u.test(tokens[index])) {
      const mark = marks.get(offset);
      if (mark) {
        // 同一正文边界有任何现有标点时，不追加原稿标点。
        const trailing = /[\s\p{P}\p{S}]*$/u.exec(result)?.[0] ?? "";
        if (!/[\p{P}\p{S}]/u.test(trailing)) result = result.replace(/\s*$/u, "") + mark + trailing;
      }
      if (index < tokens.length) offset++;
    }
    if (index < tokens.length) result += tokens[index];
  }
  return result;
}
