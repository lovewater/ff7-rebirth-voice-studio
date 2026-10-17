/** 人工选择状态独立于生成status和程序计算的时长/拍数异常。 */
export type TtsReviewState = "candidate" | "locked" | "abnormal";

export function isTtsReviewState(value: unknown): value is TtsReviewState {
  return value === "candidate" || value === "locked" || value === "abnormal";
}

/** 同句只有一个人工结论：锁定/异常互斥，其余音频均为未标记。 */
export function nextTtsReviewState(current: TtsReviewState, target: boolean, next: TtsReviewState): TtsReviewState {
  return target ? next : next !== "candidate" && current !== "candidate" ? "candidate" : current;
}
