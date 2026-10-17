/** 轮询只在当前条目已明确锁定后换条，取消异常但未锁定也不能抢走编辑页。 */
export function shouldAdvanceAbnormalQueue(currentStem: string | null, firstStem: string | null, currentState: string | null) {
  if (!currentStem) return firstStem !== null;
  return currentState === "locked" && firstStem !== currentStem;
}
