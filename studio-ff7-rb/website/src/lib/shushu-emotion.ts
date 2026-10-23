/** 整句纯情绪的机械出口，不调用ASR或大模型，不限定角色。
 * 中文：忽略标点/空白/拖音符号后，仅有>=2个咻。
 * 日文：整句只有连续シュシュ类发声（可带ッ/ー、のシュ或引用尾って）。
 * 混有普通正文的一律走原工作流；“シュシュッと出発する”不能整句替换。
 */
export function pureShushuOriginal(japanese: string | null | undefined, chinese: string | null | undefined) {
  const strip = (text: string | null | undefined) => (text ?? "").replace(/\\r\\n|\\n/g," ").replace(/[\s\p{P}\p{S}]/gu, "");
  return /^咻{2,}$/u.test(strip(chinese))
    || /^(?:シュ[ッー]*){2,}(?:の(?:シュ[ッー]*)+)?(?:って)?$/u.test(strip(japanese));
}
