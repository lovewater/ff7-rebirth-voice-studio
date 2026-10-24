import { sql } from "./db";
import { LINE_PAGE_SIZE } from "./line-pagination";
import type { TtsReviewState } from "./tts-review-state";

type RawItem = { stem: string; region: string | null; regionName: string; offset: number; reviewState: TtsReviewState | null };
export type AbnormalQueueItem = RawItem & { page: number; position: number; listHref: string };
export type AbnormalQueueSnapshot = {
  first: AbnormalQueueItem | null; current: AbnormalQueueItem | null;
  previous: AbnormalQueueItem | null; next: AbnormalQueueItem | null;
  position: number | null; total: number;
};
function location(row: RawItem | null): AbnormalQueueItem | null {
  if (!row) return null;
  const page = Math.floor(row.offset / LINE_PAGE_SIZE) + 1;
  const query = new URLSearchParams(row.region ? { region: row.region, page: String(page) } : { q: row.stem, page: '1' });
  return { ...row, page, position: row.offset % LINE_PAGE_SIZE + 1, listHref: `/lines?${query}#line-${encodeURIComponent(row.stem)}` };
}

/** 实时人工异常列表；按固定台词编号翻页，不记录入队时间或审核快照。
 * 邻项只来自仍异常的条目。当前条目移出后仍用其编号寻找最近的后项/前项。
 */
export async function getAbnormalQueue(currentStem: string | null = null): Promise<AbnormalQueueSnapshot> {
  const [row] = await sql<{
    first: RawItem | null; current: RawItem | null; previous: RawItem | null; next: RawItem | null;
    position: number | null; total: number;
  }[]>`
    WITH flagged AS (
      SELECT DISTINCT l.id,l.stem,l.region,COALESCE(r.name_zh,l.region,'未分区') AS "regionName",v.review_state AS "reviewState"
      FROM line_tts_versions v JOIN lines l ON l.stem=v.stem LEFT JOIN regions r ON r.code=l.region
      WHERE v.status='ready' AND v.review_state='abnormal'
    ), anchor AS (
      SELECT l.id,l.stem,l.region,COALESCE(r.name_zh,l.region,'未分区') AS "regionName",
        (SELECT v.review_state FROM line_tts_versions v WHERE v.stem=l.stem AND v.status='ready'
          AND v.review_state<>'candidate' ORDER BY v.id DESC LIMIT 1) AS "reviewState"
      FROM lines l LEFT JOIN regions r ON r.code=l.region WHERE l.stem=${currentStem}
    ), selected AS (
      SELECT 'first' AS slot,f.* FROM (SELECT * FROM flagged ORDER BY id,stem LIMIT 1) f
      UNION ALL SELECT 'current',a.* FROM anchor a
      UNION ALL SELECT 'previous',f.* FROM (SELECT f.* FROM flagged f,anchor a
        WHERE (f.id,f.stem)<(a.id,a.stem) ORDER BY f.id DESC,f.stem DESC LIMIT 1) f
      UNION ALL SELECT 'next',f.* FROM (SELECT f.* FROM flagged f,anchor a
        WHERE (f.id,f.stem)>(a.id,a.stem) ORDER BY f.id,f.stem LIMIT 1) f
    ), located AS (
      SELECT s.*,(SELECT COUNT(*)::int FROM lines other WHERE other.region IS NOT DISTINCT FROM s.region AND other.stem<s.stem) AS offset
      FROM selected s
    ) SELECT (SELECT row_to_json(f) FROM located f WHERE slot='first') AS first,
      (SELECT row_to_json(f) FROM located f WHERE slot='current') AS current,
      (SELECT row_to_json(f) FROM located f WHERE slot='previous') AS previous,
      (SELECT row_to_json(f) FROM located f WHERE slot='next') AS next,
      (SELECT (SELECT COUNT(*)::int+1 FROM flagged f WHERE (f.id,f.stem)<(a.id,a.stem))
        FROM anchor a WHERE a."reviewState"='abnormal') AS position,
      (SELECT COUNT(*)::int FROM flagged) AS total
  `;
  return { first: location(row?.first ?? null), current: location(row?.current ?? null),
    previous: location(row?.previous ?? null), next: location(row?.next ?? null),
    position: row?.position ?? null, total: row?.total ?? 0 };
}
