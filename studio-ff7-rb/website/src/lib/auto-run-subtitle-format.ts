import { reflowSubtitleLocally, restoreSubtitleSourcePunctuation } from "./subtitle-reflow";
import { normalizeLockSubtitlePunctuation } from "./final-auto-subtitle";

/** 字幕排版只用本地函数，不调用模型；候选保持已有两行，最终成品/确认草稿重新选切口。 */
export function createAutoRunSubtitleFormatter(options: { reflow?: boolean } = {}) {
  return async (draft: string, reference?: string) => {
    draft = restoreSubtitleSourcePunctuation(draft, reference);
    const clean = draft.replace(/\[停顿=\d{1,4}\]/gu, "")
      .replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n")
      .split("\n").map(line => line.trim()).filter(Boolean).join("\n");
    const source = options.reflow || clean.split("\n").length !== 2 ? reflowSubtitleLocally(clean, { preserveBreakPunctuation: !options.reflow }) : clean;
    if (!source) throw Error("字幕不能为空");
    return options.reflow ? normalizeLockSubtitlePunctuation(source) : source;
  };
}
