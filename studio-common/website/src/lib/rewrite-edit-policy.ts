import { calculateAttemptFeedback, type AttemptInput } from "./attempt-feedback";

export type RewriteEditMode = "local-polish" | "timing-rewrite" | "structure-rewrite" | "constraint-rewrite" | "retry-original" | "verify-first";

/** 字数只是本稿时长改写的软参考，不是新增验收门槛。
 * 按同一音频“中文字数×参考朗读跨度/中文朗读跨度”估算，段内停顿计入，
 * 不拿净语速乘整句槽长、不按日文拍数凑字。只对已核字、边界可靠且时长失败的稿给建议；
 * 数字/英文缺少可靠读法、缺测、方向冲突时不猜，短句保留向下取整的更小改动选择。
 */
export function timingCharacterSuggestions(input: AttemptInput) {
  const m = input.measurement;
  if (!m || m.draftId !== input.draftId || !m.audioId || m.text?.pass !== true) return [];
  const feedback = calculateAttemptFeedback(input);
  if (feedback.status === "invalid" || feedback.issues.some(i => i.code.startsWith("text-") && !["text-too-few","text-too-many"].includes(i.code))) return [];
  const valid = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  const compact = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "");
  const estimate = (text: string, original: number | undefined, reference: number | undefined, part?: number) => {
    const body = compact(text);
    if (!/^\p{Script=Han}+$/u.test(body) || !valid(original) || !valid(reference) || original === reference) return null;
    const current = [...body].length, shorter = original > reference;
    if (shorter && current <= 1) return null;
    // 同一稿“应增字”却同时存在过快/字数过多等反馈时，不再发相反的字数建议。
    const conflict = shorter ? ["text-too-few","character-too-few"] : ["text-too-many","character-too-many","speech-too-fast","fast-and-long"];
    if (feedback.issues.some(i => conflict.includes(i.code))) return null;
    const projected = current * reference / original;
    if (!Number.isFinite(projected)) return null;
    const low = shorter ? Math.max(1,Math.min(current-1,Math.floor(projected))) : Math.max(current+1,Math.floor(projected));
    const high = shorter ? Math.max(low,Math.min(current-1,Math.ceil(projected))) : Math.max(low,Math.ceil(projected));
    return { ...(part === undefined ? {} : { part }), current, low, high, deltaLow:low-current, deltaHigh:high-current,
      referenceSeconds:reference, candidateSeconds:original };
  };
  if (m.parts) {
    const p = m.parts;
    // 组装失败不抹去已经核字、对应可靠的逐段测量；切口或段数不符仍不能据此改字。
    if (p.actual !== p.required || p.boundaryPass === false || p.checks.length !== p.required
      || p.texts?.length !== p.required || compact(p.texts.join("")) !== compact(input.script)) return [];
    return p.checks.flatMap(check => {
      if (check.status === "correct" || !Number.isFinite(check.deltaSeconds) || check.deltaSeconds === 0
        || !valid(check.originalSeconds) || !valid(check.referenceSeconds)
        || Math.sign(check.deltaSeconds) !== Math.sign(check.originalSeconds-check.referenceSeconds)) return [];
      const value = estimate(p.texts![check.index-1] ?? "", check.originalSeconds, check.referenceSeconds, check.index);
      return value ? [{...value, timingBasis:"verified-part-span"}] : [];
    });
  }
  const reading = m.readingLength ?? m.netLength;
  if (!reading || reading.pass || !valid(reading.candidateSeconds) || !valid(reading.referenceSeconds)
    || !Number.isFinite(reading.deltaSeconds) || Math.sign(reading.deltaSeconds) !== Math.sign(reading.candidateSeconds-reading.referenceSeconds)) return [];
  const value = estimate(input.script, reading.candidateSeconds, reading.referenceSeconds);
  return value ? [{...value, timingBasis:m.readingLength ? "reading-span" : "legacy-net-speech"}] : [];
}

/** 仅从选中的同一条音频给逐段改稿方向，组装失败与分段对应失败分别处理。 */
function partRewriteDirections(input: AttemptInput) {
  const m = input.measurement, p = m?.parts;
  if (!m || m.draftId !== input.draftId || !m.audioId || m.text?.pass !== true || !p
    || p.actual !== p.required || p.boundaryPass === false || p.checks.length !== p.required) return [];
  const checks = Array.from({length:p.required}, (_,i) => p.checks.find(check => check.index === i+1));
  if (checks.some(check => !check || !Number.isFinite(check.deltaSeconds)
    || (check.status !== "correct" && (check.deltaSeconds === 0
      || !Number.isFinite(check.originalSeconds) || !Number.isFinite(check.referenceSeconds)
      || check.originalSeconds! <= 0 || check.referenceSeconds! <= 0
      || Math.sign(check.deltaSeconds) !== Math.sign(check.originalSeconds!-check.referenceSeconds!))))) return [];
  return checks.map(check => ({part:check!.index, direction:check!.status === "correct" ? "keep" as const
    : check!.deltaSeconds > 0 ? "shorten" as const : "lengthen" as const}));
}

/** 只用当前稿的一条真实音频分档，不能拼接多条音频的合格段或借用旧稿结论。 */
export function rewriteEditPolicy(attempts: AttemptInput[], currentScript?: string) {
  if (currentScript !== undefined) attempts = attempts.filter(a => a.script === currentScript);
  const latest = attempts.at(-1);
  if (!latest) return null;
  const candidates = attempts.filter(a => a.draftId === latest.draftId && a.script === latest.script)
    .map(input => ({ input, feedback: calculateAttemptFeedback(input) }));
  const usable = candidates.find(a => a.feedback.status === "accepted") ?? candidates.find(a => a.feedback.status === "warning");
  const reliable = candidates.filter(a => a.input.measurement?.text?.pass === true && a.feedback.status === "rejected");
  const best = usable ?? [...reliable].sort((a, b) => {
    const score = (item: typeof a) => item.feedback.issues.filter(i => i.severity === "error").length * 100
      + item.feedback.issues.filter(i => i.severity === "warning").length;
    return score(a) - score(b);
  })[0] ?? candidates.at(-1)!;
  const { input, feedback } = best;
  const m = input.measurement;
  const issues = feedback.issues;
  let mode: RewriteEditMode;
  if (!m || feedback.status === "invalid" || !m.text) mode = "verify-first";
  else if (!m.text.pass) mode = "retry-original";
  else if ((m.parts && (m.parts.actual !== m.parts.required || m.parts.boundaryPass === false || m.parts.layoutPass === false))
    || issues.some(i => i.code === "assembly-gap")) mode = "structure-rewrite";
  else if (issues.some(i => i.code === "assembly-unknown")) mode = "verify-first";
  else if (m.parts?.checks.some(p => p.status === "error" || Math.abs(p.deltaSeconds) > .3000001)
    || issues.some(i => i.severity === "error" && ["audio-short", "audio-long", "net-audio-short", "net-audio-long", "reading-audio-short", "reading-audio-long", "assembly-length"].includes(i.code))) mode = "timing-rewrite";
  else if (issues.some(i => i.severity === "error")) mode = "constraint-rewrite";
  else if (feedback.missingChecks.length) mode = "verify-first";
  else if (usable && m.length && m.hardSpeed && (!m.parts || m.parts.checks.length === m.parts.required && m.parts.checks.every(p => Number.isFinite(p.deltaSeconds) && Math.abs(p.deltaSeconds) <= .3000001))) mode = "local-polish";
  else mode = "verify-first";
  return { mode, draftId: input.draftId, audioId: m?.audioId ?? null, script: input.script,
    reasons: [...issues.map(i => i.reason), ...feedback.missingChecks], characterSuggestions: timingCharacterSuggestions(input),
    partDirections: partRewriteDirections(input) };
}

export function rewriteEditInstruction(attempts: AttemptInput[], currentScript?: string, allowRewrite?: boolean) {
  const policy = rewriteEditPolicy(attempts, currentScript);
  const directions: Record<RewriteEditMode, string> = {
    "local-polish": "当前稿已有同一条音频通过已完成的硬检查，结构正确，各段缩放后余差均不超过300ms（单句沿用整体检查）。保留可用稿；若本轮要求改善，只做最小必要的局部增删、移词和自然停顿调整，不推翻原表达，不因追求更接近数值而重写。最终组装等尚未完成的检查仍须实测。",
    "timing-rewrite": "当前稿存在可靠的时长硬失败，不能当作已入围稿。允许对失败分段较大幅度增减文字、移动已有信息、重组句式和重新分配分段内容，优先解决所列长短问题；不要被最小改动限制住。已经合格的部分尽量保留。",
    "structure-rewrite": "全文已核字，但音频分片数、语义切口或段间组装不合格。允许重建断句、重新分配各段语义并作必要的整体改写，先修复目标结构；不能拿错位片段的时长推断哪句话该增字或减字。不要受最小改动限制。",
    "constraint-rewrite": "当前稿尚有其他硬检查失败，尚未入围。根据所列真实失败项调整字数、表达或节奏，允许必要的较大调整；不能把结构或时长合格当成全文已合格，也不能无依据改动无关部分。",
    "retry-original": "当前音频校字未通过，先保持台词按原稿重TTS；漏字、多字或错读不能直接证明正确台词需要重写，不按这条音频增减文字。",
    "verify-first": "当前证据不足以可靠确定改稿幅度，或失败原因尚未明确。先补齐核字、分段及实测检查；若现有流程要求原稿重试，保持原稿。不要凭缺失测量推断应大改或宣称已符合300ms条件。",
  };
  const scopedParts = policy && ["timing-rewrite", "structure-rewrite"].includes(policy.mode)
    && policy.partDirections.some(part => part.direction !== "keep") ? policy.partDirections : [];
  return [
    "【程序裁定的本轮改稿范围】",
    "所有改稿都优先保留原游戏中文字幕中已经准确、自然的核心词语、固定搭配和判断含义。外语及独立译文用于核对语义；另一种译法也成立，不构成替换原表达的理由。增减字数、重组句式不等于顺手换近义词；相同字数的换词不能作为解决长度问题的理由。确需更换核心表达时，在reason或plan中说明原表达的具体问题或必须替换的原因。不新增事实，不漏核心信息。",
    policy ? JSON.stringify({ ...policy, ...(allowRewrite === undefined ? {} : { allowRewrite }) }) : "尚无本轮可用于分档的实测候选；按当前任务明确给出的事实处理，不把旧稿测量套给新稿。",
    allowRewrite === false ? "本轮权限为allowRewrite=false：仅允许调整标点、分行及停顿位置，正文字符及顺序必须保持不变。结构/时长问题只描述失败事实，本轮不授权文字重写；不能因诊断档位而忽略权限。累计三批仍不通过后的结构改稿会由程序放开权限。" : scopedParts.length ? [
      "【本轮逐段改稿任务：优先于整体改写的一般说明】",
      ...scopedParts.map(part => `第${part.part}段：${part.direction === "shorten" ? "实测偏长，本轮精简该段、缩短表达，不得反向扩写。" : part.direction === "lengthen" ? "实测偏短，先调整自然停顿；必要时仅在原句已有含义内补全表达，不新增事实，不重复意思。" : "实测时长已合格，保持该段正文与节奏。"}`),
      "只处理以上失败段；不得为凑段数添加新的句子、事实、推断或解释。组装失败仍须处理，但不能因此忽略可靠的逐段长短证据，也不授权无关的整体扩写。",
      "逐段方向和参考字数是本轮改稿要求，新音频仍须完整核字、实测和组装验收。",
    ].join("\n") : policy ? directions[policy.mode] : "",
    policy?.characterSuggestions.length && allowRewrite !== false ? [
      "【时长改稿参考字数：软建议，不是合格条件】",
      ...policy.characterSuggestions.map(row => `${row.part === undefined ? "本句" : `第${row.part}段`}当前${row.current}字，建议先尝试${row.low === row.high ? row.low : `${row.low}–${row.high}`}字，约${row.deltaLow > 0 ? "增加" : "减少"}${Math.min(Math.abs(row.deltaLow),Math.abs(row.deltaHigh)) === Math.max(Math.abs(row.deltaLow),Math.abs(row.deltaHigh)) ? Math.abs(row.deltaLow) : `${Math.min(Math.abs(row.deltaLow),Math.abs(row.deltaHigh))}–${Math.max(Math.abs(row.deltaLow),Math.abs(row.deltaHigh))}`}字。`),
      "按该稿对应音频的实测时长估算，timingBasis标明朗读跨度或旧版净发声口径，不混用；标点和空白不计字数；不是最低字数或硬上限。优先从更接近原稿字数的一端小幅调整，自然准确时可以偏离建议，不为了凑数增加修饰、重复意思或堆标点。",
      "保留核心含义不等于原词组必须独立保留，允许自然补全或合并表达，避免先说一遍再换个说法重复。所有建议服从本轮修改权限及已有约束；新稿必须重新TTS核字和实测，不能宣称达到该字数就能通过。",
    ].join("\n") : "",
    "以上分档只属于列出的稿件与音频。新稿必须重新TTS、核字和实测，不能继承通过状态；原任务allowRewrite=false等正文不可改约束仍须遵守。",
  ].filter(Boolean).join("\n");
}
