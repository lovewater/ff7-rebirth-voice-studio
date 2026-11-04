export type ConditionalLockStep = {
  step: number; ratio: number; percent: number; direction: "lengthen" | "shorten";
  duration: number; differenceMs: number;
};

/** 手机条件锁定只向日文完整音频时长靠拢，不做裁剪、补静音或切段。
 * 拉长按时长×(1+p)，缩短沿用编辑器的时长÷(1+p)，p最大20%。
 * 先求恰好对齐所需幅度，再限幅并三等分；第三档不会越过日文目标。
 * 使用实测文件时长，不能用首末发声跨度或数据库中四舍五入的显示值。
 */
export function conditionalLockSteps(duration: number, referenceDuration: number): ConditionalLockStep[] {
  if (!(duration > 0) || !(referenceDuration > 0) || !Number.isFinite(duration) || !Number.isFinite(referenceDuration)) return [];
  if (Math.abs(duration - referenceDuration) < 0.001) return [];
  const direction = duration < referenceDuration ? "lengthen" : "shorten";
  const maximum = Math.min(0.2, direction === "lengthen" ? referenceDuration / duration - 1 : duration / referenceDuration - 1);
  return [1, 2, 3].map(step => {
    const amount = maximum * step / 3;
    const ratio = direction === "lengthen" ? 1 + amount : 1 / (1 + amount);
    const next = duration * ratio;
    return { step, ratio, percent: amount * 100, direction, duration: next, differenceMs: Math.round((next - referenceDuration) * 1000) };
  });
}
