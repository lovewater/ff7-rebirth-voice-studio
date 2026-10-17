/** 仅用于自动工作流最终主音频的字幕收尾，必须在拟声恢复、排版和补引号之后调用。
 * 不用于改写提示、实际TTS稿、候选音频或拍数计算，避免把为了停顿保留的换行消掉。
 * 返回null表示沿用游戏原字幕，数据库subtitle_text清空，因此界面也不显示“改”。
 */
export function finalizeAutoSubtitle(draft: string, original: string): string | null {
  const lines = draft.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n")
    .split("\n").map(line => line.trim()).filter(Boolean);
  let result = lines.join("\n");
  // 严格少于14字；标点计字数，空白/换行不计。只处理已整理成两行的短字幕。
  // 换行本来承担停顿：移除时若接缝两边均无标点，用逗号接上，不重复已有标点。
  if (lines.length === 2 && [...lines.join("").replace(/\s/gu, "")].length < 14) {
    const separator = /[\p{P}\p{S}]$/u.test(lines[0]) || /^[\p{P}\p{S}]/u.test(lines[1]) ? "" : "，";
    result = `${lines[0]}${separator}${lines[1]}`;
  }
  // 已经分成两行的改稿也可能以逗号/句号结束第一行，不能只清理程序新拆的长句。
  // 先合并短行，再清理仍保留的换行：合并后的逗号仍承担停顿，不应删除。
  // 只删除换行紧邻的逗号和单个句点；问号、感叹号、引号、省略号等保持原样。
  result = result.replace(/[，,。．]+\n/gu, "\n").replace(/(?<!\.)\.(?!\.)\n/gu, "\n");
  // 必须是最后判断：无论最终一行还是两行，只有标点/空白/换行差异就不改字幕。
  // 不做同义词、读音、简繁或大小写归一；真正增删/替换正文的改稿必须保留。
  const body = (text: string) => text.replace(/\\r\\n|\\n/g, "\n").replace(/[\s\p{P}\p{S}]/gu, "");
  return body(result) === body(original) ? null : result;
}
