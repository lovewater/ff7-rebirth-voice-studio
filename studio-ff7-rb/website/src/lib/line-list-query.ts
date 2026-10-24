import { lineListSearchExpr } from "./line-list-search";
import { originalCnLockedExpr } from "@/lib/line-filters";
import { sql } from "./db";
import { healthFlagExpr, type LineFilter } from "./line-filters";



export function listFilterFromParams(params: URLSearchParams): LineFilter {
  return {
    region: params.get("region") ?? "", kind: params.get("kind") ?? "", mode: params.get("mode") ?? "",
    flag: params.get("flag") ?? "", q: params.get("q") ?? "",
    speakers: params.getAll("speaker").flatMap(s => s.split(",")).map(s => s.trim()).filter(Boolean),
    onlyCast: ["1", "true"].includes(params.get("cast") ?? ""),
    modifiedOnly: ["1", "true"].includes(params.get("modified") ?? ""),
  };
}

/** 列表数量、列表内容与手机审核队列共用条件，防止下一条与列表顺序不一致。别名固定l/s/rg/m。 */
export function lineListWhere(f: LineFilter) {
  const flagExpr = healthFlagExpr();
  const searchExpr = lineListSearchExpr(f.q);
  return sql`
    (${f.region} = '' OR l.region = ${f.region})
    AND (${f.kind} = '' OR l.kind = ${f.kind})
    AND (${f.mode} = '' OR m.dialogue_mode = ${f.mode})
    AND (${f.speakers.length} = 0 OR l.speaker = ANY(${f.speakers}))
    AND (${f.flag} = ''
      OR (${f.flag} = 'fixed' AND (${originalCnLockedExpr()} OR EXISTS (
        SELECT 1 FROM line_tts_versions tf WHERE tf.stem=l.stem AND tf.status='ready' AND tf.review_state='locked'
      )))
      OR (${f.flag} <> '' AND ${f.flag} <> 'fixed' AND (${flagExpr}) = ${f.flag}))
    AND (NOT ${f.onlyCast} OR EXISTS (SELECT 1 FROM cast_members cm WHERE cm.speaker=l.speaker))
    AND (NOT ${f.onlyCast} OR l.kind = '对话')
    AND (NOT ${f.modifiedOnly} OR EXISTS (SELECT 1 FROM line_tts_versions tm WHERE tm.stem=l.stem AND tm.status='ready'))
    AND (${searchExpr})`;
}
