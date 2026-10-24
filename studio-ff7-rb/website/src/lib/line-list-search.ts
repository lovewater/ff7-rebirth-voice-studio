import { sql } from "./db";

/** 只搜索列表可见文本。别名与lineListWhere一致：l/s/rg/m。
 * 改/锁字幕必须先按列表的优先级选中唯一展示版本，再匹配subtitle_text。
 * 禁止把ILIKE放进挑选版本的WHERE，否则会从隐藏备选/子音频里挑出“命中的旧稿”。
 * 展示版本通过专用索引直接取首条，避免扫描/排序该句全部历史版本。
 * tts_text是详情页朗读稿，未必是展示字幕；英文、文件路径及其他历史稿均不在范围内。
 */
export function lineListSearchExpr(q: string) {
  if (!q) return sql`true`;
  const like = `%${q}%`;
  return sql`(
    l.stem ILIKE ${like}
    OR l.speaker ILIKE ${like}
    OR COALESCE(s.name_zh, m.actor_zh, l.speaker, '') ILIKE ${like}
    OR COALESCE(rg.name_zh, l.region, '') ILIKE ${like}
    OR l.text_jp ILIKE ${like}
    OR l.text_zh ILIKE ${like}
    OR COALESCE((
      SELECT tq.subtitle_text FROM line_tts_versions tq
      WHERE tq.stem=l.stem AND tq.status='ready'
      ORDER BY (tq.review_state<>'candidate') DESC, (tq.parent_tts_id IS NULL) DESC, tq.id DESC
      LIMIT 1
    ), '') ILIKE ${like}
  )`;
}
