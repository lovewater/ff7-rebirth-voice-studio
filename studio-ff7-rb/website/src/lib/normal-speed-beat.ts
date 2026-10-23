
export const NORMAL_CHINESE_BEAT_SPEED_LOW = 4.5;
export const NORMAL_CHINESE_BEAT_SPEED_HIGH = 7;
export function normalSpeedIgnoresBeat(rate: number | null | undefined) {
  return typeof rate === "number" && Number.isFinite(rate)
    && rate >= NORMAL_CHINESE_BEAT_SPEED_LOW && rate <= NORMAL_CHINESE_BEAT_SPEED_HIGH;
}

/** 与人工锁定样本/界面 speech-peak15-gap200-v1 同口径：逐采样低于本音频峰值15%，
 * 连续至少200ms的区间整段扣除；短间隙及有声拖音计时，纯静音没有有效语速。
 * 输入必须是去情绪后的实际中文正文候选，不能用整句总长、字幕拍数或日文时长替代。
 * 这是“比”的候选级豁免，不改变分片250/500ms门槛，也不改变原9音节/秒硬上限。
 */
export function measureNormalSpeedBeatExemption(input: { samples: Float32Array; sampleRate: number }, text: string, syllables?: number | null) {
  const { samples, sampleRate } = input;
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw Error("净语速采样率无效");
  const hanCharacters = [...text.matchAll(/\p{Script=Han}/gu)].length;
  const units = syllables != null && Number.isFinite(syllables) && syllables > 0 ? syllables : hanCharacters;
  let peak = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) throw Error("净语速波形包含无效采样");
    peak = Math.max(peak, Math.abs(value));
  }
  const minimum = Math.ceil(sampleRate * .2), threshold = peak * .15;
  let silenceFrames = 0, start: number | null = null;
  if (peak === 0) silenceFrames = samples.length;
  else for (let i = 0; i <= samples.length; i++) {
    const quiet = i < samples.length && Math.abs(samples[i]) < threshold;
    if (quiet && start === null) start = i;
    if (!quiet && start !== null) {
      if (i - start >= minimum) silenceFrames += i - start;
      start = null;
    }
  }
  const netSeconds = (samples.length - silenceFrames) / sampleRate;
  const rate = netSeconds > 0 && units > 0 ? units / netSeconds : null;
  return { exempt: normalSpeedIgnoresBeat(rate), rate, netSeconds, hanCharacters, syllables: units,
    low: NORMAL_CHINESE_BEAT_SPEED_LOW, high: NORMAL_CHINESE_BEAT_SPEED_HIGH,
    metricVersion: "speech-peak15-gap200-v1", peakRatio: .15, minSilenceMs: 200,
    silenceSeconds: silenceFrames / sampleRate, scope: "candidate-emotion-free-body" };
}
