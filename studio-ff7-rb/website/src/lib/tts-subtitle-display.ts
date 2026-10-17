function displayText(value: string | null | undefined) {
  return (value ?? "").replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n")
    .split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

/** 音频实际使用的字幕：覆盖字段为空就继承原文，包含已恢复的拟声；不使用朗读稿。 */
export function effectiveTtsSubtitle(input: { subtitle?: string | null; original?: string | null }) {
  return displayText(input.subtitle) || displayText(input.original);
}

/** 只展示当前选中音频明确保存、且与原文不同的字幕覆盖。
 * subtitle_text为空表示沿用原游戏字幕，绝不能退回tts_text/spoken_text：朗读稿可能
 * 去掉拟声、把换行换成句号，或特意保留停顿；它不代表最终字幕，也不应触发“改”。
 * 已明确保存的手工排版/标点修订仍可展示，最终自动改稿的“正文未变”由收尾阶段清空覆盖。
 */
export function ttsSubtitleDisplay(input: { subtitle?: string | null; original?: string | null }) {
  const subtitle = displayText(input.subtitle), original = displayText(input.original);
  return subtitle && subtitle !== original ? subtitle : null;
}
