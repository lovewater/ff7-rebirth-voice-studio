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

export type ShortPerformancePolicy = { jpCharacters: number };
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

/** 自动场景日文正文1～8字（含8字）不设中文字数上下限或目标，不为凑字扩写。
 * 标点和空白不改变门槛；音频校字、实测时长检查仍独立执行。
 */
export function shortPerformancePolicy(textJp: string): ShortPerformancePolicy | null {
  const jpCharacters = spokenCharacters(textJp);
  return jpCharacters > 0 && jpCharacters <= 8 ? { jpCharacters } : null;
}

/** 仅供超过8字的慢速句检查既有中文字数上限。 */
export function checkShortCharacters(policy: { jpCharacters: number; min: number; max: number }, text: string) {
  const characters = spokenCharacters(text);
  return { characters, ...policy, pass: characters >= policy.min && characters <= policy.max };
}

/** 整轮候选都实测偏短/偏长时，即使校字也失败，时长证据仍有效，须调整稿长。
 * 有合适时长或方向相互冲突时，不用一次 ASR 失败推断应增字还是减字。
 */
export const SHORT_NET_SPEAKING_TOLERANCE_MS = 150;

export function shortAudioDirection(ratios: number[], low: number, high: number, absoluteRule?: { referenceSeconds: number; toleranceMs: number }): "longer" | "shorter" | null {
  if (!ratios.length) return null;
  // 有候选落在短句绝对容差内时，不能因比例越界再要求增删字。
  if (absoluteRule && Number.isFinite(absoluteRule.referenceSeconds) && absoluteRule.referenceSeconds > 0
    && Number.isFinite(absoluteRule.toleranceMs) && absoluteRule.toleranceMs >= 0
    && ratios.some(ratio => Number.isFinite(ratio) && ratio > 0
      && Math.abs((ratio - 1) * absoluteRule.referenceSeconds * 1000) <= absoluteRule.toleranceMs + 1e-6)) return null;
  if (ratios.every((ratio) => Number.isFinite(ratio) && ratio > 0 && ratio < low)) return "longer";
  if (ratios.every((ratio) => Number.isFinite(ratio) && ratio > high)) return "shorter";
  return null;
}

export const SLOW_JP_MORA_PER_SECOND = 3;
export type SlowPerformancePolicy = { jpMora: number; speechSeconds: number; moraPerSecond: number; target: number; max?: number;
  durationDirection?: "longer" | "shorter" };

/** 仅有真实、同方向的整轮波形证据才撤掉“一拍一字”偏好。
 * 字数>=摩拉仍短 / 字数<=摩拉仍长（均包含相等），且每条净时长差都超过200ms。
 * 空证据、非法时长、长短混杂或已在容差内均不触发，不能仅因字数猜测音频。
 */
export function slowMoraTargetConflict(policy: SlowPerformancePolicy, text: string,
  rows: { referenceSeconds: number; candidateSeconds: number }[]): "longer" | "shorter" | null {
  if (!rows.length || rows.some(r => !Number.isFinite(r.referenceSeconds) || !Number.isFinite(r.candidateSeconds)
    || r.referenceSeconds <= 0 || r.candidateSeconds <= 0)) return null;
  const characters = spokenCharacters(text);
  if (characters >= policy.jpMora && rows.every(r => r.referenceSeconds-r.candidateSeconds > .2+1e-9)) return "longer";
  if (characters <= policy.jpMora && rows.every(r => r.candidateSeconds-r.referenceSeconds > .2+1e-9)) return "shorter";
  return null;
}

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

/** 中文绝对语速硬上限：正文至少6个汉字才启用，<6字（如“是谁”）情绪短句豁免。
 * 参照C3010_MAIN_0700_1300_00_big原中文约9.25音节/秒，取9.0作为稍保守上限。
 * rate=中文音节/扣情绪与长静音后的净发声秒数；静音不能稀释语速。
 * 此限制独立于拍数比、短/慢句豁免及最终总长，其他指标合格不能覆盖超速。
 */
export const CHINESE_MAX_SYLLABLES_PER_SECOND = 9;
export const CHINESE_SPEED_MIN_HAN = 6;
export function checkChineseSpeakingSpeed(text:string,netSeconds:number|null,syllables?:number|null){
 const hanCharacters=[...text.matchAll(/\p{Script=Han}/gu)].length;
 const units=syllables!=null&&Number.isFinite(syllables)&&syllables>0?syllables:hanCharacters;
 const enabled=hanCharacters>=CHINESE_SPEED_MIN_HAN;
 const rate=netSeconds!=null&&Number.isFinite(netSeconds)&&netSeconds>0?units/netSeconds:null;
 return {enabled,hanCharacters,syllables:units,netSeconds,rate,max:CHINESE_MAX_SYLLABLES_PER_SECOND,
  pass:!enabled||(rate!==null&&rate<=CHINESE_MAX_SYLLABLES_PER_SECOND+1e-9)};
}
