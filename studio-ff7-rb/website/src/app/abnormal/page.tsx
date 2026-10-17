import { redirect } from "next/navigation";
import LinePage from "@/app/line/[stem]/page";
import { getAbnormalQueue } from "@/lib/abnormal-queue";
import { shouldAdvanceAbnormalQueue } from "@/lib/abnormal-queue-policy";
import { AbnormalQueue } from "./queue";
export const dynamic = "force-dynamic";

export default async function AbnormalPage({ searchParams }: { searchParams: Promise<{ stem?: string }> }) {
  const { stem } = await searchParams;
  const requested = stem && /^[\w.\-]+$/.test(stem) ? stem : null;
  const snapshot = await getAbnormalQueue(requested);
  // 入队时把当前stem固定到URL。否则详情内部router.refresh可能重新取队首，抢走正在编辑的条目。
  if (!requested && snapshot.first) redirect(`/abnormal?stem=${encodeURIComponent(snapshot.first.stem)}`);
  if (requested && !snapshot.current) redirect(snapshot.first ? `/abnormal?stem=${encodeURIComponent(snapshot.first.stem)}` : '/abnormal');
  // 锁定后刷新也应立即离开已修订的条目；队列为空时回到等待页面。
  if (requested && shouldAdvanceAbnormalQueue(requested, snapshot.first?.stem ?? null, snapshot.current?.reviewState ?? null)) {
    redirect(snapshot.first ? `/abnormal?stem=${encodeURIComponent(snapshot.first.stem)}` : '/abnormal');
  }
  // 保存/刷新当前编辑稿时保留其详情，是否换条由轮询的明确锁定条件决定。
  const item = snapshot.current ?? snapshot.first;
  return <AbnormalQueue item={item} total={snapshot.total}>
    {item ? <LinePage key={item.stem} params={Promise.resolve({ stem: item.stem })} /> : null}
  </AbnormalQueue>;
}
