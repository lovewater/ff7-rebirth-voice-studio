import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { lineListWhere, listFilterFromParams } from "@/lib/line-list-query";
import { MobileReview, type ReviewLine, type ReviewVersion } from "./review";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params, searchParams }: {
  params: Promise<{ stem: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { stem } = await params;
  if (!/^[\w.\-]+$/.test(stem)) notFound();
  const [line] = await sql<ReviewLine[]>`SELECT l.stem,l.region,l.text_jp,l.text_zh,l.kind,l.subtitle_italic,m.dialogue_mode,
    COALESCE(rg.name_zh,l.region,'未分区') AS region_name,COALESCE(s.name_zh,l.speaker,'未知角色') AS name_zh,
    m.jp_start_s,m.jp_end_s,m.jp_dur_s,m.jp_speech_s,m.cn_start_s,m.cn_end_s,m.cn_dur_s,m.cn_speech_s
    FROM lines l LEFT JOIN regions rg ON rg.code=l.region LEFT JOIN speakers s ON s.code=l.speaker
    LEFT JOIN line_meta m ON m.stem=l.stem WHERE l.stem=${stem}`;
  if (!line) notFound();
  const search = await searchParams;
  const context = new URLSearchParams();
  for (const key of ['region','kind','mode','flag','q','speaker','cast','modified','page','reviewSession']) {
    const value = search[key];
    for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) context.append(key, item);
  }
  if (!context.has('reviewSession') && ![...context.keys()].some(k => k !== 'page' && k !== 'reviewSession')) context.set('region', line.region ?? '');
  const where = lineListWhere(listFilterFromParams(context));
  const [queue, versions] = await Promise.all([
    sql<{ stem: string }[]>`SELECT l.stem FROM lines l LEFT JOIN speakers s ON s.code=l.speaker
      LEFT JOIN regions rg ON rg.code=l.region LEFT JOIN line_meta m ON m.stem=l.stem
      WHERE ${where} ORDER BY COALESCE(rg.sort_order,99999),l.stem`,
    sql<ReviewVersion[]>`SELECT id::text AS id,parent_tts_id::text AS parent_tts_id,review_state,voice_gpu_key,
      subtitle_text,tts_text,start_s,end_s,dur_s,speech_s FROM line_tts_versions
      WHERE stem=${stem} AND status='ready' ORDER BY id DESC`,
  ]);
  return <MobileReview key={stem} line={line} versions={versions} initialQueue={queue.map(r => r.stem)} context={context.toString()} />;
}
