export type FallbackQuality = {
  reviewed: boolean;
  hardIssueCount: number;
  pronunciationIssueCount: number;
  paceDeviation: number | null;
  beatDeviation?: number | null;
  characterDeviation?: number;
  durationDeviation: number | null;
};

/** 仅在正常筛选没有结果时使用，不放宽“通过”标准。
 * 净发声时长比与拍数“比”是独立维度，各自在正常筛选中按原阈值/豁免判断。
 * 全轮均不合格后，先保留已校验、正文硬伤最少的，再只按实际时长误差（秒）择优。
 * 禁止把拍数比偏差与时长比偏差相加，也不让字符越界或轻微读音疑点覆盖时长选择。
 * durationDeviation必须与本次实际参考匹配：场景正文用去情绪参考的净发声差，整句降级用整句发声跨度差。
 * 硬伤数是校字证据条数，不是缺失字数；未知时长排在已知之后，时长相同再比较读音疑点，仍同分保留较早的。
 */
export function closestFallback<T extends FallbackQuality>(candidates: T[]): T | null {
  const score = (row: T) => [
    row.reviewed ? 0 : 1,
    row.hardIssueCount,
    typeof row.durationDeviation === "number" && Number.isFinite(row.durationDeviation) ? row.durationDeviation : Infinity,
    row.pronunciationIssueCount,
  ];
  return candidates.reduce<T | null>((best, row) => {
    if (!best) return row;
    const a = score(row), b = score(best);
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? row : best;
    }
    return best;
  }, null);
}
