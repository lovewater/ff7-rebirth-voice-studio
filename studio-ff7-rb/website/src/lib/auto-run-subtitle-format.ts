import { autoRunSubtitle, needsSubtitleLineBreak, validateSubtitleLineBreak } from "./auto-run-subtitle";
import { parseJsonObject, rewriteChat } from "./auto-run-llm";

/** 每次工作流单独缓存：正文与最终字幕相同时不重复请求模型，不跨运行混用旧稿。
 * 标点断行完全由程序处理；无可用标点的长单行才单独调用模型，只负责选择语义切口。
 * 音频朗读稿、拍数、分段提示均保持独立，不把字幕换行反向写回实际 TTS 文本。
 */
export function createAutoRunSubtitleFormatter() {
  const cache = new Map<string, Promise<string>>();
  return async (draft: string) => {
    const source = autoRunSubtitle(draft);
    if (!needsSubtitleLineBreak(source)) return source;
    let pending = cache.get(source);
    if (!pending) {
      pending = (async () => {
        const { content } = await rewriteChat([
          { role: "system", content: [
            "你只负责游戏中文字幕断行，不负责翻译或改写。",
            "输入是超过15个正文字符、没有可用句中标点的单行字幕。请按中文语义分成且仅分成两行，两行字数尽量接近。",
            "不得增删、替换、调序任何文字或标点，不得拆开词语、人名、专名；只能在原文中选择一个换行位置。",
            "只返回 JSON：{\"lines\":[\"第一行原文\",\"第二行原文\"]}，每项内不要再加换行。",
          ].join("\n"), promptKey: "subtitle-layout.system", promptValues: {} },
          { role: "user", content: JSON.stringify({ text: source }), promptKey: "subtitle-layout.input", promptValues: {"input_json": JSON.stringify({ text: source })} },
        ], 0.1, "subtitle-layout");
        return validateSubtitleLineBreak(source, parseJsonObject(content).lines);
      })();
      cache.set(source, pending);
    }
    try { return await pending; }
    catch (error) { cache.delete(source); throw error; }
  };
}
