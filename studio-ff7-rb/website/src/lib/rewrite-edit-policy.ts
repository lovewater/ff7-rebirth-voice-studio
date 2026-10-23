import { calculateAttemptFeedback, type AttemptInput } from "./attempt-feedback";

export type RewriteEditMode = "local-polish" | "timing-rewrite" | "structure-rewrite" | "constraint-rewrite" | "retry-original" | "verify-first";

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
    || issues.some(i => i.severity === "error" && ["audio-short", "audio-long", "net-audio-short", "net-audio-long", "assembly-length"].includes(i.code))) mode = "timing-rewrite";
  else if (issues.some(i => i.severity === "error")) mode = "constraint-rewrite";
  else if (feedback.missingChecks.length) mode = "verify-first";
  else if (usable && m.length && m.hardSpeed && (!m.parts || m.parts.checks.length === m.parts.required && m.parts.checks.every(p => Number.isFinite(p.deltaSeconds) && Math.abs(p.deltaSeconds) <= .3000001))) mode = "local-polish";
  else mode = "verify-first";
  return { mode, draftId: input.draftId, audioId: m?.audioId ?? null, script: input.script,
    reasons: [...issues.map(i => i.reason), ...feedback.missingChecks] };
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
  return [
    "【程序裁定的本轮改稿范围】",
    "所有改稿都优先保留原游戏中文字幕中已经准确、自然的核心词语、固定搭配和判断含义。外语及独立译文用于核对语义；另一种译法也成立，不构成替换原表达的理由。增减字数、重组句式不等于顺手换近义词；相同字数的换词不能作为解决长度问题的理由。确需更换核心表达时，在reason或plan中说明原表达的具体问题或必须替换的原因。不新增事实，不漏核心信息。",
    policy ? JSON.stringify({ ...policy, ...(allowRewrite === undefined ? {} : { allowRewrite }) }) : "尚无本轮可用于分档的实测候选；按当前任务明确给出的事实处理，不把旧稿测量套给新稿。",
    allowRewrite === false ? "本轮权限为allowRewrite=false：仅允许调整标点、分行及停顿位置，正文字符及顺序必须保持不变。结构/时长问题只描述失败事实，本轮不授权文字重写；不能因诊断档位而忽略权限。累计三批仍不通过后的结构改稿会由程序放开权限。" : policy ? directions[policy.mode] : "",
    "以上分档只属于列出的稿件与音频。新稿必须重新TTS、核字和实测，不能继承通过状态；原任务allowRewrite=false等正文不可改约束仍须遵守。",
  ].filter(Boolean).join("\n");
}
