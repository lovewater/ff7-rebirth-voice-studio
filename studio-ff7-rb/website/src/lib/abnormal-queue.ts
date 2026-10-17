import { sql } from "./db";
import { LINE_PAGE_SIZE } from "./line-pagination";
import type { TtsReviewState } from "./tts-review-state";

type RawItem = { stem: string; region: string | null; regionName: string; offset: number; reviewState: TtsReviewState | null };
export type AbnormalQueueItem = RawItem & { page: number; position: number; listHref: string };
export type AbnormalQueueSnapshot = { first: AbnormalQueueItem | null; current: AbnormalQueueItem | null; total: number };
function location(row: RawItem | null): AbnormalQueueItem | null {
  if (!row) return null;
  const page = Math.floor(row.offset / LINE_PAGE_SIZE) + 1;
  const query = new URLSearchParams(row.region ? { region: row.region, page: String(page) } : { q: row.stem, page: '1' });
  return { ...row, page, position: row.offset % LINE_PAGE_SIZE + 1, listHref: `/lines?${query}#line-${encodeURIComponent(row.stem)}` };
}

/** 一条SQL取得队首与当前结论，避免跨查询读到不一致状态。只处理人工异常，
 * 不把程序的时长/拍数报警混入；固定lines.id升序取第一句，不抢占正在编辑的其他句。 */
export async function getAbnormalQueue(currentStem: string | null = null): Promise<AbnormalQueueSnapshot> {
  const [row] = await sql<{ first: RawItem | null; current: RawItem | null; total: number }[]>`
    WITH flagged AS (
      SELECT l.id,l.stem,l.region,COALESCE(r.name_zh,l.region,'未分区') AS "regionName",v.review_state AS "reviewState"
      FROM line_tts_versions v JOIN lines l ON l.stem=v.stem LEFT JOIN regions r ON r.code=l.region
      WHERE v.status='ready' AND v.review_state='abnormal'
    ), first_issue AS (
      SELECT f.*,(SELECT COUNT(*)::int FROM lines other WHERE other.region IS NOT DISTINCT FROM f.region AND other.stem<f.stem) AS offset
      FROM (SELECT * FROM flagged ORDER BY id,stem LIMIT 1) f
    ), current_line AS (
      SELECT l.stem,l.region,COALESCE(r.name_zh,l.region,'未分区') AS "regionName",
        (SELECT v.review_state FROM line_tts_versions v WHERE v.stem=l.stem AND v.status='ready' AND v.review_state<>'candidate' LIMIT 1) AS "reviewState",
        (SELECT COUNT(*)::int FROM lines other WHERE other.region IS NOT DISTINCT FROM l.region AND other.stem<l.stem) AS offset
      FROM lines l LEFT JOIN regions r ON r.code=l.region WHERE l.stem=${currentStem}
    ) SELECT (SELECT row_to_json(f) FROM first_issue f) AS first,
      (SELECT row_to_json(c) FROM current_line c) AS current,(SELECT COUNT(*)::int FROM flagged) AS total
  `;
  return { first: location(row?.first ?? null), current: location(row?.current ?? null), total: row?.total ?? 0 };
}
