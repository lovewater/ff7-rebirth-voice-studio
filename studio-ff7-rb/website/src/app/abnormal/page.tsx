import { redirect } from "next/navigation";
import LinePage from "@/app/line/[stem]/page";
import { MobileReview } from "@/app/review/[stem]/review";
import { loadReviewData } from "@/lib/review-data";
import { getAbnormalQueue } from "@/lib/abnormal-queue";
import { abnormalReplacement, shouldLeaveAbnormalPage } from "@/lib/abnormal-queue-policy";
import { AbnormalQueue } from "./queue";
import { ResponsiveAbnormalBody } from "./responsive-body";
export const dynamic = "force-dynamic";

export default async function AbnormalPage({ searchParams }: { searchParams: Promise<{ stem?: string }> }) {
  const { stem } = await searchParams;
  const requested = stem && /^[\w.\-]+$/.test(stem) ? stem : null;
  const snapshot = await getAbnormalQueue(requested);
  if (!requested && snapshot.first) redirect(`/abnormal?stem=${encodeURIComponent(snapshot.first.stem)}`);
  if (requested && shouldLeaveAbnormalPage(requested, snapshot)) {
    const next = abnormalReplacement(snapshot);
    redirect(next ? `/abnormal?stem=${encodeURIComponent(next)}` : '/abnormal');
  }
  const item = snapshot.current;
  const review = item ? await loadReviewData(item.stem) : null;
  return <AbnormalQueue snapshot={snapshot}>
    {item && review?.line ? <ResponsiveAbnormalBody
      desktop={<LinePage key={item.stem} params={Promise.resolve({ stem: item.stem })} />}
      mobile={<MobileReview key={item.stem} line={review.line} versions={review.versions} initialQueue={[]} context="" abnormalMode />}
    /> : null}
  </AbnormalQueue>;
}
