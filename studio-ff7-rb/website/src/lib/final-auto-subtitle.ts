/** 仅用于自动工作流最终主音频的字幕收尾，必须在拟声恢复、排版和补引号之后调用。
 * 不用于改写提示、实际TTS稿、候选音频或拍数计算，避免把为了停顿保留的换行消掉。
 * 原字幕优先：去掉标点、符号与空白后正文相同，始终沿用游戏原字幕。
 * 返回null表示完全沿用游戏原字幕，数据库subtitle_text清空。
 */
export function finalizeAutoSubtitle(draft: string, original: string): string | null {
  const lines = draft.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n")
    .split("\n").map(line => line.trim()).filter(Boolean);
  let result = lines.join("\n");
  // 严格少于14字；标点计字数，空白/换行不计。只处理已整理成两行的短字幕。
  // 字幕整理不新增标点；短行合并直接连接原文。
  if (lines.length === 2 && [...lines.join("").replace(/\s/gu, "")].length < 14) {
    result = lines.join("");
  }
  // 已经分成两行的改稿也可能以逗号/句号结束第一行，不能只清理程序新拆的长句。
  // 先合并短行，再清理仍保留的换行：合并后的逗号仍承担停顿，不应删除。
  // 只删除换行紧邻的逗号和单个句点；问号、感叹号、引号、省略号等保持原样。
  result = result.replace(/[，,。．]+\n/gu, "\n").replace(/(?<!\.)\.(?!\.)\n/gu, "\n");
  // 清理换行处标点后可能从14降至13字符，仍按最终显示字符数统一合行。
  if (result.includes("\n") && [...result.replace(/\s/gu, "")].length < 14) result = result.replace(/\n/g, "");
  // 最后比较正文；排版或补引号不能绕过原字幕优先规则。
  // 不做同义词、读音、简繁或大小写归一；真正增删/替换正文的改稿必须保留。
  const body = (text: string) => text.replace(/\\r\\n|\\n/g, "\n").replace(/[\s\p{P}\p{S}]/gu, "");
  return body(result) === body(original) ? null : result;
}

/** 锁定确认弹窗的展示草稿：断行后再整理标点，不用于TTS输入。 */
export function normalizeLockSubtitlePunctuation(text: string): string {
  return text.split("\n").map(line => line.trim()
    .replace(/[，,。．]+$/gu, "")
    .replace(/(?<!\.)\.(?!\.)$/gu, "")
    .replace(/[。．]/gu, "，")
    .replace(/(?<![\d.])\.(?![\d.])/gu, "，")
  ).join("\n");
}
