import { parseJsonObject, rewriteChat } from "./auto-run-llm";

export type MissingJapaneseSubtitleDecision = {
  kind: "onomatopoeia" | "speech" | "unknown";
  reason: string;
};

/** 特殊线路只用于官方日文字幕为空的句子，与“有官方字幕但ASR为空”区分。
 * 模型先判断中文是否全拟声，再核对ASR是否存在明确日文正文，不拆片、不改稿、不猜声音。
 * 中文拟声不能证明日文也为拟声；无官方日文字幕时，不能擅自把ASR的普通词句认作误识。
 */
export function missingJapaneseSubtitleMessages(chinese: string, asrText: string) {
  return [{ role: "system" as const, content: [
    "你在处理游戏官方日文音频存在、官方日文字幕为空，但中文字幕存在的特殊句子。",
    "先判断原中文字幕是否整句都是拟声或非正文人声反应，再核对日文ASR是否也支持保留拟声原声。不要翻译、改写、切片或补字幕。",
    "onomatopoeia：中文整句只有笑声、哭声、叹气、喘息、惊叫、呻吟、打嗝等声音表达或独立拟声感叹，且日文ASR为空或也支持拟声，没有明确日文正文证据。",
    "speech：中文或日文ASR包含明确实际正文含义，例如人称、称呼、名词、动作或陈述；即使中文同时或全部是拟声也不能据此保留日文正文原声。unknown：空中文字幕、两边冲突无法判断或信息不足。",
    "日文ASR是本次运行的临时日文原文依据。虽然它可能误识，但这里没有官方日文字幕可纠正它，不能仅因中文是拟声就断言日文ASR错了。日文呈现明确正文时返回speech；证据冲突不能确认则unknown，交fallback。",
    "例如中文唔嗝！而日文ASR行こう。（走吧）是明确正文，应返回speech走fallback，不能猜日文也是打嗝。ASR为空时，中文全拟声可以返回onomatopoeia。",
    "你没有听到音频，不要声称听到了某种声音，也不要根据ASR空白猜测环境音。",
    '只输出JSON：{"kind":"onomatopoeia|speech|unknown","reason":"中文性质以及日文ASR有无正文证据的简短依据"}',
  ].join("\n"), promptKey: "missing-jp-subtitle.system", promptValues: {} }, { role: "user" as const, content: JSON.stringify({
    original_japanese_subtitle_missing: true, chinese_subtitle: chinese, japanese_text_from_seed_asr: asrText,
  }), promptKey: "missing-jp-subtitle.input", promptValues: {"input_json": JSON.stringify({
    original_japanese_subtitle_missing: true, chinese_subtitle: chinese, japanese_text_from_seed_asr: asrText,
  })} }];
}

export async function classifyMissingJapaneseSubtitle(chinese: string, asrText: string): Promise<MissingJapaneseSubtitleDecision> {
  // 只单独请求一次；服务失败/格式错误/unknown全部交回整句三遍TTS，不因分类失败无音频。
  const { content } = await rewriteChat(missingJapaneseSubtitleMessages(chinese, asrText), .1, "missing-jp-subtitle-classification", 1);
  const parsed = parseJsonObject(content);
  if (!["onomatopoeia", "speech", "unknown"].includes(String(parsed.kind)) || typeof parsed.reason !== "string") {
    throw new Error("无日文字幕的中文拟声分类格式无效");
  }
  if (!chinese.trim() && parsed.kind === "onomatopoeia") throw new Error("空中文字幕不能判定为全拟声");
  return parsed as MissingJapaneseSubtitleDecision;
}
