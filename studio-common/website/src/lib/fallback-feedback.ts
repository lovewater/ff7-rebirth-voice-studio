/** 降级线路专用：日文无法可靠切段/分类，或正常改稿重试耗尽时，逐轮合成而非原稿机械三遍。
 * 正常线路三轮耗尽后的“已有候选择优”不走这里，避免额外再追加三轮。
 * 每轮保留音频；第二、三轮以真实净发声反馈改稿，字数只建议，不校验上下限。
 */
export type FallbackTiming = { span: number; net: number };
export type FallbackRound<T> = { round: number; text: string; timing: FallbackTiming; value: T };
export function fallbackCharacters(text: string) { return [...text.replace(/\[停顿=\d+\]/gu, "").replace(/[\s\p{P}\p{S}]/gu, "")].length; }

export function fallbackRewriteMessages(original: string, japaneseAsr: string, target: FallbackTiming, rounds: FallbackRound<unknown>[]) {
  const last = rounds[rounds.length - 1];
  const suggestedCharacters = last.timing.net > 0
    ? Math.max(1, Math.round(fallbackCharacters(last.text) * target.net / last.timing.net)) : null;
  const error = last.timing.net - target.net;
  return { suggestedCharacters, messages: [
    { role: "system" as const, content: "你是游戏中文配音台词修订员。根据上一轮TTS实测发声长度改写，让下一轮自然朗读尽量接近日文净发声长度。日文文字参考只使用提供的Seed-ASR识别结果，可能有误；为空时只依据原中文，不编造日文。保留原中文核心意思、语气、人物视角和限定信息，不添加剧情、对象、事实或无意义填充。偏短时增加自然表达的正文字符，偏长时精简。可以使用自然标点停顿，但不要只堆标点代替增加正文。建议字数仅按上一轮实测语速推算，绝非强制要求、上下限或淘汰条件，优先语义准确和中文自然。不必与日文逐字对应。偏差已在200ms内时可保持原稿，避免为微小偏差硬加字。禁止SSML或时长标签。只返回JSON：{\"text\":\"本轮台词\",\"reason\":\"简短改写依据\"}。", promptKey: "fallback-rewrite.system", promptValues: {} },
    { role: "user" as const, content: JSON.stringify({ originalChinese: original, japaneseAsr, target,
      previousRounds: rounds.map(r => ({ round: r.round, text: r.text, characters: fallbackCharacters(r.text), ...r.timing })),
      feedback: Math.abs(error) <= 0.2 ? "发声长度已接近目标，可以保留当前表达；仍优先语义自然。" : error < 0 ? "发声偏短，请增加自然表达的正文字符。" : "发声偏长，请精简正文。",
      suggestedCharacters, suggestionExplanation: "正文字符不含标点。只作参考，不强制。" }), promptKey: "fallback-rewrite.input", promptValues: {"input_json": JSON.stringify({ originalChinese: original, japaneseAsr, target,
      previousRounds: rounds.map(r => ({ round: r.round, text: r.text, characters: fallbackCharacters(r.text), ...r.timing })),
      feedback: Math.abs(error) <= 0.2 ? "发声长度已接近目标，可以保留当前表达；仍优先语义自然。" : error < 0 ? "发声偏短，请增加自然表达的正文字符。" : "发声偏长，请精简正文。",
      suggestedCharacters, suggestionExplanation: "正文字符不含标点。只作参考，不强制。" })} },
  ] };
}

export async function runFallbackFeedback<T>(input: {
  original: string; initial: string; japaneseAsr: string; target: FallbackTiming;
  synthesize: (text: string, round: number) => Promise<{ value: T; timing: FallbackTiming }>;
  rewrite: (prompt: ReturnType<typeof fallbackRewriteMessages>, round: number) => Promise<string>;
  onRewriteError: (error: unknown, round: number) => Promise<void>;
}) {
  const rounds: FallbackRound<T>[] = [];
  let text = input.initial;
  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      try {
        const next = (await input.rewrite(fallbackRewriteMessages(input.original, input.japaneseAsr, input.target, rounds), round)).trim();
        if (!next || !fallbackCharacters(next)) throw new Error("降级改稿为空或没有正文");
        text = next;
      } catch (error) {
        // 降级改稿服务仍可能失效：保留上一份可用稿继续TTS，必须确保有音频产物。
        await input.onRewriteError(error, round);
      }
    }
    try {
      const result = await input.synthesize(text, round);
      rounds.push({ round, text, ...result });
    } catch (error) {
      // 某轮TTS失败不可丢弃前轮；没有任何成功音频才向上抛错，交给已有候选兜底。
      await input.onRewriteError(error, round);
      if (round === 3 && !rounds.length) throw error;
    }
  }
  return rounds;
}
