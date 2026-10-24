import type { AbnormalQueueSnapshot } from "./abnormal-queue";

/** 仍在列表时保留当前页；移出后取最近后项，末尾移出时取前项。 */
export function abnormalReplacement(snapshot: AbnormalQueueSnapshot): string | null {
  return snapshot.next?.stem ?? snapshot.previous?.stem ?? snapshot.first?.stem ?? null;
}
export function shouldLeaveAbnormalPage(currentStem: string | null, snapshot: AbnormalQueueSnapshot) {
  if (!currentStem) return snapshot.first !== null;
  return snapshot.current?.reviewState !== "abnormal";
}
