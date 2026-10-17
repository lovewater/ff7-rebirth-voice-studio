/** 分段口径与日文字幕切分一致：空白（含换行）、Unicode 标点/符号连续出现只算一个分隔。 */
export function scriptClauses(text: string) {
  return text.replace(/\\r\\n|\\n/g, "\n").split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
}

/** 只约束表达偏好，不把段数作为淘汰条件；正文已去掉拟声/环境音。 */
export function performanceSegmentationHint(textJp: string) {
  const clauses = scriptClauses(textJp);
  return [
    `日文参考正文按空格、标点符号及换行分为 ${clauses.length} 段：`,
    ...clauses.map((text, index) => `${index + 1}. ${text}`),
    `中文朗读稿尽量也写成 ${clauses.length} 段，按原顺序逐段对应日文的意思和停顿。`,
    "中文可用空格、标点符号或换行分段；连续分隔符不产生空段。不要把段号写进台词。",
    "这是尽量遵守的偏好，不是硬性段数限制；以忠实原意、中文自然和演出节奏为先，必要时可以调整。不要为了保持原中文行数而违背日文分段。",
  ].join("\n");
}

export const AUTO_BEAT_LOW = 0.85;
export const AUTO_BEAT_HIGH = 1.15;

/** 8～11个日文纯正文字符采用非对称合格带，允许中文稍展开但不能更短。
 * 少于8字仍走既有短句豁免；字数来自日文而非中文，不能增删中文来切换门槛。
 * 这里只改变自动修订的合格门槛，不改变“比”的定义或列表10%/15%提示颜色。
 */
export function compactPerformanceBeatBand(textJp: string | undefined) {
  const characters = textJp == null ? 0 : spokenCharacters(textJp.replace(/\\r\\n|\\n/g, "\n"));
  return characters >= 8 && characters <= 11 ? { low: 0.75, high: 1.10 } : null;
}

export function autoBeatBand(textJp?: string) {
  return compactPerformanceBeatBand(textJp) ?? { low: AUTO_BEAT_LOW, high: AUTO_BEAT_HIGH };
}

/** 检查归一后的拍数“比”，与 CN/JP 音频跨度比是两项独立条件。
 * 短句本来就不算比；服务失败/读数缺失不能假装合格。边界含两端。
 */
export function checkAutoBeat(result: { jp: { status: string }; normalizedRatio: number | null } | null, textJp?: string) {
  const enabled = result?.jp.status !== "short";
  const ratio = result?.normalizedRatio ?? null;
  const known = ratio !== null && Number.isFinite(ratio) && ratio > 0;
  const band = autoBeatBand(textJp);
  return {
    enabled, ratio,
    pass: !enabled || (known && ratio! >= band.low && ratio! <= band.high),
    deviation: !enabled ? 0 : known ? Math.abs(ratio! - 1) : null,
  };
}

export type ShortPerformancePolicy = { jpCharacters: number; min: number; max: number };
export function spokenCharacters(text: string) {
  return [...text.replace(/\[停顿=\d{1,4}\]/g, "").replace(/[\s\p{P}\p{S}]/gu, "")].length;
}

export const MAX_CHINESE_CHARACTERS_PER_SECOND = 3.5;

/** 短句/慢表达的中文上限：max(日文含标点字符数, floor(日文净发声秒数×3.5))。
 * 日文按Unicode字符计数，非引号标点/符号各算一字；不计空白/换行和日中英文引号。
 * 时间必须来自已清理参考的measurePerformanceSpeakingTime，扣掉长静音；不可用文件总长
 * 或含句间长静音的首末发声跨度扩充上限。未知净时长时只用日文字符数，不编造秒数。
 * 中文检查仍用spokenCharacters，标点/空格不算字；上限是容量，不能要求模型凑满。
 */
export function performanceCharacterLimit(textJp: string, speechSeconds: number | null = null) {
  const jpLimitCharacters = [...textJp.replace(/\\r\\n|\\n/g, "\n")
    .replace(/[\s「」『』｢｣“”‘’"'＂＇〝〞〟]/gu, "")].length;
  const durationLimit = speechSeconds !== null && Number.isFinite(speechSeconds) && speechSeconds > 0
    ? Math.floor(speechSeconds * MAX_CHINESE_CHARACTERS_PER_SECOND) : null;
  return { jpLimitCharacters, durationLimit, speechSeconds, max: Math.max(jpLimitCharacters, durationLimit ?? 0) };
}

/** 少于八个纯正文字符仍豁免拍数比；最低字数继续按原合格带推算。
 * 只放宽上限为统一的净时长/日文含标点上限，不用汉字书写长度截断“正确答案”等核心信息。
 * 进入短句线路的判断不受标点数影响，堆标点不能让短句变成普通句。
 */
export function shortPerformancePolicy(textJp: string, normalRatio: number, speechSeconds: number | null = null): ShortPerformancePolicy | null {
  const jpCharacters = spokenCharacters(textJp);
  if (!jpCharacters || jpCharacters >= 8) return null;
  return { jpCharacters, min: Math.min(jpCharacters, Math.max(1, Math.ceil(jpCharacters / (normalRatio * AUTO_BEAT_HIGH)))), max: performanceCharacterLimit(textJp, speechSeconds).max };
}

export function checkShortCharacters(policy: ShortPerformancePolicy, text: string) {
  const characters = spokenCharacters(text);
  return { characters, ...policy, pass: characters >= policy.min && characters <= policy.max };
}

/** 无音频的改稿只能按时长反馈调整字数，不能宣称预测出声音长度。
 * 偏短优先增加一字、偏长优先减少一字；多稿同字数时保留生成顺序，不按拍数比打分。
 */
export function shortRewriteTarget(policy: ShortPerformancePolicy, current: string, direction: "longer" | "shorter" | null) {
  const count = spokenCharacters(current);
  return Math.max(policy.min, Math.min(policy.max, count + (direction === "longer" ? 1 : direction === "shorter" ? -1 : 0)));
}

/** 整轮候选都实测偏短/偏长时，即使校字也失败，时长证据仍有效，须调整稿长。
 * 有合适时长或方向相互冲突时，不用一次 ASR 失败推断应增字还是减字。
 */
export function shortAudioDirection(ratios: number[], low: number, high: number): "longer" | "shorter" | null {
  if (!ratios.length) return null;
  if (ratios.every((ratio) => Number.isFinite(ratio) && ratio > 0 && ratio < low)) return "longer";
  if (ratios.every((ratio) => Number.isFinite(ratio) && ratio > high)) return "shorter";
  return null;
}

export const SLOW_JP_MORA_PER_SECOND = 3;
export type SlowPerformancePolicy = { jpMora: number; speechSeconds: number; moraPerSecond: number; target: number; max?: number };

/** 短句或慢速满足任一条件即可豁免拍数比，慢速分支本身不设日文字数门槛。
 * 只用可靠的纯摩拉数（不含标点停顿拍）÷裁后正文发声秒数；严格 <3，等于3不豁免。
 * 未知读音/时长不能伪装成慢速。慢速改稿目标是中文字符数接近日文摩拉数，
 * 不再除以常规中日归一系数；这是提示和候选排序目标，不是强制逐字翻译或新的淘汰条件。
 */
export function slowPerformancePolicy(jpMora: number | null | undefined, speechSeconds: number | null): SlowPerformancePolicy | null {
  if (jpMora == null || !Number.isFinite(jpMora) || jpMora <= 0 || speechSeconds == null || !Number.isFinite(speechSeconds) || speechSeconds <= 0) return null;
  const moraPerSecond = jpMora / speechSeconds;
  return moraPerSecond < SLOW_JP_MORA_PER_SECOND ? { jpMora, speechSeconds, moraPerSecond, target: Math.round(jpMora) } : null;
}

export type DurationRewritePolicy = {
  target: number; currentCharacters: number; referenceSeconds: number; candidateSeconds: number;
};
/** 正常线路的实测偏短证据。必须先校字通过，避免把漏字/ASR失败当成“台词太短”。
 * 同时超过200ms且不足参考85%才算明显偏短；整轮可校字的候选均偏短才切换，
 * 有可用时长或长短互相冲突时不因单次随机合成豁免比。只看去首尾静音的真实波形，
 * 不使用文件总长、补齐的静音、字数或比值来触发。
 */
export function clearlyShortSpeakingRound(rows: { referenceSeconds: number; candidateSeconds: number }[]) {
  return rows.length > 0 && rows.every(r => Number.isFinite(r.referenceSeconds) && Number.isFinite(r.candidateSeconds)
    && r.referenceSeconds > 0 && r.candidateSeconds > 0
    && r.referenceSeconds - r.candidateSeconds > 0.2 + 1e-9
    && r.candidateSeconds / r.referenceSeconds < 0.85 - 1e-9);
}

/** 建议字数按本轮实测比例推算，仅用于提示与五稿排序，不作为上下限或淘汰条件。 */
export function durationRewritePolicy(script: string, referenceSeconds: number, candidateSeconds: number): DurationRewritePolicy {
  const currentCharacters = spokenCharacters(script);
  return { currentCharacters, referenceSeconds, candidateSeconds,
    target: Math.max(1, Math.round(currentCharacters * referenceSeconds / candidateSeconds)) };
}
