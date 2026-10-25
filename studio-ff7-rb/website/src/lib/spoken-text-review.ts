type LexiconEntry = { src: string; dst: string; note: string | null };
export type SpokenReviewInput = { spoken: string; asr: string; lexicon: LexiconEntry[]; pronunciationText?: string };

/** 校字不是重翻译。ASR 的同/近音写法不能证明 TTS 读错；缺字则不放宽。
 * 模型列证据，程序用硬伤数组决定淘汰，用轻微疑点数量决定合格候选的优先级。
 * 不把“意思差不多”当漏字的豁免，也不靠改稿掩盖随机漏读。
 */
export function spokenReviewMessages(input: SpokenReviewInput) {
  return [
    {
      role: "system" as const,
      content: [
        "你在校对游戏中文配音是否完整读出朗读稿。输入只有稿件与ASR文字，不能声称亲耳听到音频。",
        "只输出JSON：pass布尔；missing、extra、repeated、unrelated、pronunciationNotes均为字符串数组；reason一句话；thinking判断依据。没有问题的数组必须为[]。",
        "先按朗读顺序对应两边文字，结合下方发音替换表识别允许的读音写法。忽略标点、空白和非朗读控制标记。",
        "硬伤：missing=缺字/漏句，哪怕只缺一个短字或语气词也淘汰；extra=额外念字；repeated=重复朗读；unrelated=无法用近音解释的替换或明显无关内容。每项指出具体原文与ASR位置。",
        "严禁因整句意思完整、语义相近或轻微吞字而放过缺字。就像→像、用宝物→宝物、啦→完全没有，都属于missing。",
        "容忍同音、近音、声调及轻声差异。它们是对应位置的替代，不是删字或加字；不要因为ASR写法的词义不同就判unrelated。",
        "例如魔晄→魔皇可按同音/替换表通过；珍品→真币、用→有、啦→了属于可容忍的近音或声调差异，记录pronunciationNotes，不淘汰。",
        "完全同音、标点变化、替换表已解释的对应无需记疑点。其余可容忍的读音差异，每个连续差异片段记一条pronunciationNotes，不要把同一片段重复计数。该数组只用于合格候选择优。",
        "ASR没识别出‘就’就是缺字，不能将缺字包装成轻声/声调问题。长短不一的内容需先确认有明确发音替换规则可解释；否则不能凭近音掩盖缺字或多字。",
        "pass只有在四类硬伤数组全空时才为true。全部候选有硬伤时必须全部淘汰，不能为选出一条而放宽标准。",
        "发音替换表（朗读可能按右列发音）：",
        input.lexicon.length ? input.lexicon.map((row) => `${row.src}→${row.dst}${row.note ? `（${row.note}）` : ""}`).join("\n") : "（空）",
      ].join("\n"), promptKey: "text-review.system", promptValues: {"lexicon": input.lexicon.length ? input.lexicon.map((row) => `${row.src}→${row.dst}${row.note ? `（${row.note}）` : ""}`).join("\n") : "（空）"},
    },
    { role: "user" as const, content: `朗读稿：\n${input.spoken}\n\nASR：\n${input.asr || "（空）"}`, promptKey: "text-review.input", promptValues: {"spoken": input.spoken,"asr": input.asr || "（空）"} },
  ];
}

export function parseSpokenReview(parsed: Record<string, unknown>, asr: string) {
  const issues = (name: string) => {
    const value = parsed[name];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`校字模型未返回有效的 ${name} 数组`);
    }
    return [...new Set((value as string[]).map((item) => item.trim()))];
  };
  if (typeof parsed.pass !== "boolean") throw new Error("校字模型未返回 pass 布尔值");
  const missing = issues("missing");
  const extra = issues("extra");
  const repeated = issues("repeated");
  const unrelated = issues("unrelated");
  const pronunciationNotes = issues("pronunciationNotes");
  if (!asr.replace(/[\s\p{P}\p{S}]/gu, "")) missing.push("ASR为空，无法确认完整朗读");
  // 硬伤证据优先于模型汇总布尔值；只有读音疑点不能被汇总布尔值误杀。
  const ok = missing.length + extra.length + repeated.length + unrelated.length === 0;
  return {
    ok, modelPass: parsed.pass, missing, extra, repeated, unrelated, pronunciationNotes,
    pronunciationIssueCount: pronunciationNotes.length,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 1000) : (ok ? "内容完整" : "存在朗读硬伤"),
  };
}

/** 先排硬伤（调用方完成），再按轻微读音疑点择优，最后才比较节奏/时长。 */
export function fewestPronunciationIssues<T extends { pronunciationNotes: string[] }>(candidates: T[]): T[] {
  if (!candidates.length) return [];
  const minimum = Math.min(...candidates.map((row) => row.pronunciationNotes.length));
  return candidates.filter((row) => row.pronunciationNotes.length === minimum);
}

/** 念字硬伤全部未过时，下一轮沿用原稿重合成；有念字合格而跨度不过才走改稿。 */
export function shouldRetrySameScript(textPassedCount: number) {
  return textPassedCount === 0;
}
