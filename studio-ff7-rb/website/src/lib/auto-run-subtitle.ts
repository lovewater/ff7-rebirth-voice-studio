/** 超过十五个正文字符的单行字幕，优先在现有标点后断行。
 * 穷举能使两侧都有正文的标点边界，按两行正文字符数差最小择优；同分取较早位置。
 * 只删除所选换行处的逗号、句号（中英文），其他标点及未选中的标点原样保留。
 * 只有句末标点不算可用断点，交给独立模型分行任务处理。
 */
function splitLongSubtitleAtPunctuation(text: string) {
  if (subtitleCharacters(text) <= 15) return null;
  let best: { text: string; difference: number } | null = null;
  for (const match of text.matchAll(/\p{P}+/gu)) {
    const end = match.index! + match[0].length;
    // 小数点与数字分组逗号属于数值，不是句子的换行边界。
    if (/^[,.]$/u.test(match[0]) && /\p{N}/u.test(text.slice(match.index! - 1, match.index))
      && /\p{N}/u.test(text.slice(end, end + 1))) continue;
    const left = text.slice(0, match.index).trimEnd() + match[0].replace(/[，,。．.]/gu, "");
    const right = text.slice(end).trimStart();
    const a = subtitleCharacters(left), b = subtitleCharacters(right);
    if (!a || !b) continue;
    const difference = Math.abs(a - b);
    if (!best || difference < best.difference) best = { text: `${left.trimEnd()}\n${right}`, difference };
  }
  return best?.text ?? null;
}

export function subtitleCharacters(text: string) {
  return [...text.replace(/[\s\p{P}\p{S}]/gu, "")].length;
}

/** 同步规则已执行后仍是长单行，才需要另调模型；句末标点不能制造空的第二行。 */
export function needsSubtitleLineBreak(text: string) {
  return !text.includes("\n") && subtitleCharacters(text) > 15;
}

/** 模型只能在原字串中插入一个换行，不得增删字、改标点或改变词序。
 * 只容许所选切口两侧的排版空白被 trim；不接受模型顺手改译或凭字数硬切的回退。
 */
export function validateSubtitleLineBreak(source: string, lines: unknown) {
  if (!Array.isArray(lines) || lines.length !== 2 || lines.some((line) => typeof line !== "string" || /[\r\n]/u.test(line))) {
    throw new Error("字幕分行模型必须返回两行原文");
  }
  const parts = (lines as string[]).map((line) => line.trim());
  if (parts.some((line) => subtitleCharacters(line) === 0)) throw new Error("字幕分行模型返回了空行");
  const original = [...source.trim()];
  const sameText = original.some((_, index) => index > 0
    && original.slice(0, index).join("").trimEnd() === parts[0]
    && original.slice(index).join("").trimStart() === parts[1]);
  if (!sameText) throw new Error("字幕分行模型改动了原文，只能插入换行");
  return parts.join("\n");
}

/** 字幕最多两行：长单行优先按标点断行；已有两行不改，更多行只合并相邻旧行。
 * 穷举保留哪个换行，选择两行正文（不含空白/标点/符号）字数差最小的方案；
 * 合并时原行尾没有标点才补中文逗号。相同分数保留较早的换行，结果稳定且幂等。
 * 这是字幕排版规则，与 TTS 参考分段/朗读稿的停顿规则分开处理。
 */
export function twoLineSubtitle(value: string) {
  const lines = value.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n")
    .split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1) return splitLongSubtitleAtPunctuation(lines[0]) ?? lines[0];
  if (lines.length <= 2) return lines.join("\n");
  const counts = lines.map((line) => [...line.replace(/[\s\p{P}\p{S}]/gu, "")].length);
  const total = counts.reduce((sum, count) => sum + count, 0);
  let left = 0, best = 1, difference = Infinity;
  for (let split = 1; split < lines.length; split += 1) {
    left += counts[split - 1];
    const delta = Math.abs(left - (total - left));
    if (delta < difference) { best = split; difference = delta; }
  }
  const join = (parts: string[]) => parts.map((line, index) => (
    index === parts.length - 1 || /\p{P}$/u.test(line) ? line : `${line}，`
  )).join("");
  return `${join(lines.slice(0, best))}\n${join(lines.slice(best))}`;
}

/** 保存改稿原字，去除音频控制标记并按字幕两行规则排版。
 * 不使用 ASR 转写或发音替换后的文字；也不反过来改 TTS 朗读稿和音频。
 */
export function autoRunSubtitle(draft: string) {
  const text = twoLineSubtitle(draft.replace(/\[停顿=\d{1,4}\]/g, ""));
  if (!text) throw new Error("自动改稿字幕不能为空");
  return text;
}

export type SubtitleRestore = { bodyCharacters: number; preserved: { at: number; text: string }[] };
const isBodyCharacter = (char: string) => /[\p{L}\p{N}]/u.test(char);

/** 对照清理前后中文稿，记录确实被删除的拟声文字和原位置。
 * 只允许删除，不从 ASR 猜字；标点/空白单独被删除时不当作拟声恢复。
 */
export function subtitleRestorePlan(fullText: string, cleanBody: string): SubtitleRestore {
  const normalize = (text: string) => text.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n").replace(/\[停顿=\d{1,4}\]/g, "");
  const source = [...normalize(fullText)];
  const target = [...normalize(cleanBody)].filter((char) => !/\s/u.test(char));
  if (!target.some(isBodyCharacter)) throw new Error("拟声字幕恢复失败：正文没有可朗读文字");
  const kept = new Set<number>();
  let cursor = 0;
  for (const char of target) {
    while (cursor < source.length && source[cursor].normalize("NFKC") !== char.normalize("NFKC")) cursor += 1;
    if (cursor === source.length) throw new Error("拟声字幕恢复失败：正文不是原字幕的删除结果");
    kept.add(cursor++);
  }
  const preserved: SubtitleRestore["preserved"] = [];
  let bodyCharacters = 0;
  for (let at = 0; at < source.length;) {
    if (kept.has(at)) { if (isBodyCharacter(source[at])) bodyCharacters += 1; at += 1; continue; }
    const start = at;
    while (at < source.length && !kept.has(at)) at += 1;
    const text = source.slice(start, at).join("");
    if ([...text].some(isBodyCharacter)) preserved.push({ at: bodyCharacters, text });
  }
  return { bodyCharacters, preserved };
}

/** 最终字幕先恢复原声拟声，再压成两行。改稿段数可变，只在已有分隔处放回句中拟声，
 * 不为匹配日文段数切开中文词句；句首/句尾拟声始终保持在首尾。
 */
export function restorePerformanceSubtitle(plan: SubtitleRestore, bodyDraft: string) {
  const body = [...bodyDraft.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n").replace(/\[停顿=\d{1,4}\]/g, "").trim()];
  const counts = [0];
  body.forEach((char, index) => counts.push(counts[index] + Number(isBodyCharacter(char))));
  const boundaries = [0, ...body.flatMap((char, index) => /[\s\p{P}\p{S}]/u.test(char) ? [index + 1] : []), body.length];
  const inserts = new Map<number, string[]>();
  for (const part of plan.preserved) {
    const target = plan.bodyCharacters ? part.at / plan.bodyCharacters * counts[body.length] : 0;
    const position = part.at === 0 ? 0 : part.at === plan.bodyCharacters ? body.length
      : boundaries.reduce((best, at) => Math.abs(counts[at] - target) < Math.abs(counts[best] - target) ? at : best, 0);
    inserts.set(position, [...(inserts.get(position) ?? []), part.text]);
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (const [at, parts] of [...inserts].sort(([a], [b]) => a - b)) {
    chunks.push(body.slice(cursor, at).join(""), ...parts);
    cursor = at;
  }
  chunks.push(body.slice(cursor).join(""));
  const full = chunks.filter(Boolean).reduce((text, chunk) => {
    // 改稿可能已在该处写句号/叹号，不再叠加原拟声前的逗号。
    const next = /\p{P}$/u.test(text) ? chunk.replace(/^[，,、；;：:]+/u, "") : chunk;
    return /[\p{L}\p{N}]$/u.test(text) && /^[\p{L}\p{N}]/u.test(next) ? `${text}，${next}` : text + next;
  }, "");
  return autoRunSubtitle(full);
}

/** 独立句首おお与中文哦/哦哦明确对应时，保留原声感叹，不因它有语义就重新 TTS。
 * 必须同时满足独立日文字幕段和中文句首分隔；不把普通词中的音节、ええ等肯定回答泛化成拟声。
 */
export function retainedOhInterjection(firstJapaneseClause: string | undefined, chinese: string) {
  if (firstJapaneseClause !== "おお") return null;
  const match = /^(\s*哦+[，,！!。．.、\s]+)/u.exec(chinese);
  return match ? { prefix: match[0], body: chinese.slice(match[0].length) } : null;
}
