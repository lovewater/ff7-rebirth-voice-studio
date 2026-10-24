import { NORMAL_CHINESE_BEAT_SPEED_LOW, NORMAL_CHINESE_BEAT_SPEED_HIGH } from "./normal-speed-beat";

/** 联合改稿条件，不是新的全局语速上限：
 * 原9音节硬检查已通过且启用，净语速超过“正常区间”上限，同时归一后的拍数比
 * 低于本句已有下限（中文偏长），才要求改短。比值即使单独豁免也保留这项联合作用。
 * 不能把raw ratio或时长比传进来；短句没有可计算的比时传null，不能推算/伪造。
 * 低于正常下限是偏慢，不触发减字；正常范围含边界，直接引用界面同源常量。
 */
export function fastLongPressure(input: {
  netRate: number | null;
  evidenceVerified?: boolean;
  hardSpeed?: { enabled: boolean; pass: boolean };
  beat?: { ratio: number | null; low: number };
}) {
  const rate = input.netRate, ratio = input.beat?.ratio ?? null, low = input.beat?.low ?? null;
  const known = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;
  const triggered = input.evidenceVerified !== false && input.hardSpeed?.enabled === true && input.hardSpeed.pass
    && known(rate) && rate > NORMAL_CHINESE_BEAT_SPEED_HIGH
    && known(ratio) && known(low) && ratio < low;
  return { version: "fast-and-long-rewrite-v1", triggered, rate, normalizedRatio: ratio, beatLow: low,
    normalLow: NORMAL_CHINESE_BEAT_SPEED_LOW, normalHigh: NORMAL_CHINESE_BEAT_SPEED_HIGH };
}

export function fastLongPromptValues() {
  return { normal_low: NORMAL_CHINESE_BEAT_SPEED_LOW, normal_high: NORMAL_CHINESE_BEAT_SPEED_HIGH };
}
