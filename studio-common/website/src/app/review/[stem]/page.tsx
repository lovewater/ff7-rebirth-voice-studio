import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { lineListWhere, listFilterFromParams } from "@/lib/line-list-query";
import { MobileReview } from "./review";
import { loadReviewData } from "@/lib/review-data";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params, searchParams }: {
  params: Promise<{ stem: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { stem } = await params;
  if (!/^[\w.\-]+$/.test(stem)) notFound();
  const { line, versions } = await loadReviewData(stem);
  if (!line) notFound();
  const search = await searchParams;
  const context = new URLSearchParams();
  for (const key of ['region','kind','mode','flag','q','speaker','cast','modified','page','reviewSession']) {
    const value = search[key];
    for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) context.append(key, item);
  }
  if (!context.has('reviewSession') && ![...context.keys()].some(k => k !== 'page' && k !== 'reviewSession')) context.set('region', line.region ?? '');
  const where = lineListWhere(listFilterFromParams(context));
  const queue = await sql<{ stem: string }[]>`SELECT l.stem FROM lines l LEFT JOIN speakers s ON s.code=l.speaker
      LEFT JOIN regions rg ON rg.code=l.region LEFT JOIN line_meta m ON m.stem=l.stem
      WHERE ${where} ORDER BY COALESCE(rg.sort_order,99999),l.stem`;
  return <MobileReview key={stem} line={line} versions={versions} initialQueue={queue.map(r => r.stem)} context={context.toString()} />;
}
