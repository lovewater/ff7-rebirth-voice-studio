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
 * 汇总所有轮次：已校验优先、正文硬伤少优先，短句再比较字符越界数，然后比较跨度与拍数比的合计偏差、读音疑点、总时长。
 * 硬伤数是校字证据条数，不是缺失字数；未知指标排在已知指标之后，相同则保留先生成的。
 */
export function closestFallback<T extends FallbackQuality>(candidates: T[]): T | null {
  const score = (row: T) => [
    row.reviewed ? 0 : 1,
    row.hardIssueCount,
    row.characterDeviation ?? 0,
    (row.paceDeviation ?? Infinity) + (row.beatDeviation === undefined ? 0 : row.beatDeviation ?? Infinity),
    row.pronunciationIssueCount,
    row.durationDeviation ?? Infinity,
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
