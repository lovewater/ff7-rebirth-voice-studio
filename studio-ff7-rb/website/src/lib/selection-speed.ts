import { NORMAL_CHINESE_BEAT_SPEED_LOW, NORMAL_CHINESE_BEAT_SPEED_HIGH } from "./normal-speed-beat";

export type CandidateSpeedMeasurements = {
  netRate?: number | null;
  netSpeechSeconds?: number | null;
  spokenSyllables?: number | null;
  normalizedBeatRatio?: number | null;
  beatBand?: { low: number; high: number };
  beatExempt?: boolean;
  beatExemption?: string | null;
};

/** 最终择优的文字解释，不重算语速/比，不改变合格门槛或候选排序。
 * 净语速高=偏快；归一比低=中文偏长、放进同一时间容易偏快，两者方向相反。
 * 两项同向异常=过快/过慢；仅一项异常=稍快/稍慢；反向异常=奇怪。
 * 比虽单独豁免仍展示诊断；短句/缺测不能伪造比=1或假称两项均正常。
 */
export function selectionSpeed(input: CandidateSpeedMeasurements) {
  const known = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const rate = known(input.netRate) ? input.netRate : null;
  const ratio = known(input.normalizedBeatRatio) ? input.normalizedBeatRatio : null;
  const band = input.beatBand && known(input.beatBand.low) && known(input.beatBand.high)
    && input.beatBand.low <= input.beatBand.high ? input.beatBand : null;
  const netDirection = rate === null ? null : rate < NORMAL_CHINESE_BEAT_SPEED_LOW ? -1 : rate > NORMAL_CHINESE_BEAT_SPEED_HIGH ? 1 : 0;
  const beatDirection = ratio === null || !band ? null : ratio < band.low ? 1 : ratio > band.high ? -1 : 0;
  let description: string;
  if (netDirection !== null && beatDirection !== null && netDirection * beatDirection === -1) description = "语速有点奇怪";
  else if (netDirection !== null && netDirection !== 0 && netDirection === beatDirection) description = netDirection === 1 ? "速度有些过快" : "速度有些过慢";
  else if (netDirection === 1 || beatDirection === 1) description = "速度有些稍快";
  else if (netDirection === -1 || beatDirection === -1) description = "速度有些稍慢";
  else description = netDirection === 0 && beatDirection === 0 ? "语速正常" : "语速数据不足";
  return {
    netSpeech: { rate, unit: "音节/秒", netSeconds: input.netSpeechSeconds ?? null, syllables: input.spokenSyllables ?? null,
      normalRange: { low: NORMAL_CHINESE_BEAT_SPEED_LOW, high: NORMAL_CHINESE_BEAT_SPEED_HIGH },
      status: netDirection === null ? "不可测" : netDirection === 0 ? "正常" : netDirection === 1 ? "偏快" : "偏慢" },
    beat: { normalizedRatio: ratio, normalRange: band,
      status: beatDirection === null ? "不可计算" : beatDirection === 0 ? "正常" : beatDirection === 1 ? "中文偏长" : "中文偏短",
      exempt: input.beatExempt ?? null, exemption: input.beatExemption ?? null },
    speedDescription: description,
    speedEvidenceComplete: netDirection !== null && beatDirection !== null,
    speedMeasurementScope: "candidate-emotion-free-body",
  };
}
