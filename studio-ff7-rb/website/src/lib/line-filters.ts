import { lineListSearchExpr } from "./line-list-search";
import { sql } from "./db";
import { BEAT_VERSION } from "./beats";
import { DUR_ERR_S, DUR_OK_S, END_ERR_S, END_OK_S, START_ERR_S, START_OK_S } from "./timing";

export type LineFilter = {
  region: string;
  kind: string;
  mode: string;
  flag: string;
  speakers: string[];
  q: string;
  onlyCast: boolean;
  modifiedOnly: boolean;
};

export type HealthStats = {
  ok_n: number;
  warn_n: number;
  err_n: number;
  pending_n: number;
  fixed_n: number;
  confirmed_n: number;
  audio_modified_n: number;
  subtitle_modified_n: number;
  audio_edited_n: number;
  jp_original_n: number;
  other_fixed_n: number;
};

export function healthFlagExpr() {
  const beatValid = sql`m.beat_version = ${BEAT_VERSION} AND m.beat_status = 'ok'
    AND m.beat_jp_hash = md5(COALESCE(l.text_jp, ''))
    AND m.beat_cn_hash = md5(COALESCE(l.text_zh, ''))`;
  return sql`
    CASE
      -- 人工异常优先于自动时长/拍数、旁白豁免和旧的人工时间确认。
      -- 同句只有一个人工结论；异常使整句异常，改锁另一条会清除此异常。
      WHEN (SELECT tv.review_state FROM line_tts_versions tv
        WHERE tv.stem=l.stem AND tv.status='ready'
        ORDER BY (tv.review_state<>'candidate') DESC, (tv.parent_tts_id IS NULL) DESC, tv.id DESC
        LIMIT 1) = 'abnormal' THEN 'err'
      WHEN l.kind IS NULL OR l.kind NOT IN ('对话', 'talk')
        OR m.dialogue_mode IS DISTINCT FROM 'scene'
        OR COALESCE(l.subtitle_italic, false) THEN 'ok'
      WHEN EXISTS (
        SELECT 1 FROM line_tts_versions tv
        WHERE tv.stem = l.stem AND tv.status = 'ready' AND tv.review_state = 'locked'
      ) THEN 'ok'
      WHEN m.jp_start_s IS NULL AND m.cn_start_s IS NULL
       AND m.jp_end_s IS NULL AND m.cn_end_s IS NULL
       AND m.jp_dur_s IS NULL AND m.cn_dur_s IS NULL
      THEN 'pending'
      WHEN m.jp_start_s IS NULL OR m.cn_start_s IS NULL
        OR m.jp_end_s IS NULL OR m.cn_end_s IS NULL
        OR m.jp_dur_s IS NULL OR m.cn_dur_s IS NULL
      THEN 'err'
      WHEN ABS(m.jp_start_s - m.cn_start_s) > ${START_ERR_S}
        OR ABS(m.jp_end_s - m.cn_end_s) > ${END_ERR_S}
        OR ABS(m.jp_dur_s - m.cn_dur_s) > ${DUR_ERR_S}
        OR ((${beatValid}) AND m.beat_mark = 'err')
      THEN 'err'
      WHEN ABS(m.jp_start_s - m.cn_start_s) > ${START_OK_S}
        OR ABS(m.jp_end_s - m.cn_end_s) > ${END_OK_S}
        OR ABS(m.jp_dur_s - m.cn_dur_s) > ${DUR_OK_S}
        OR ((${beatValid}) AND m.beat_mark = 'warn')
      THEN 'warn'
      ELSE 'ok'
    END
  `;
}

export async function countFilteredHealth(f: LineFilter): Promise<HealthStats> {
  const flagExpr = healthFlagExpr();
  const searchExpr = lineListSearchExpr(f.q);
  const [row] = await sql<HealthStats[]>`
    SELECT
      COUNT(*) FILTER (WHERE x.flag = 'ok')::int AS ok_n,
      COUNT(*) FILTER (WHERE x.flag = 'warn')::int AS warn_n,
      COUNT(*) FILTER (WHERE x.flag = 'err')::int AS err_n,
      COUNT(*) FILTER (WHERE x.flag = 'pending')::int AS pending_n,
      COUNT(*) FILTER (WHERE x.fixed_category IS NOT NULL)::int AS fixed_n,
      COUNT(*) FILTER (WHERE x.fixed_category = 'confirmed')::int AS confirmed_n,
      COUNT(*) FILTER (WHERE x.fixed_category = 'audio_modified')::int AS audio_modified_n,
      COUNT(*) FILTER (WHERE x.fixed_category = 'subtitle_modified')::int AS subtitle_modified_n,
      COUNT(*) FILTER (WHERE x.fixed_category = 'audio_edited')::int AS audio_edited_n,
      COUNT(*) FILTER (WHERE x.fixed_category = 'jp_original')::int AS jp_original_n,
      COUNT(*) FILTER (WHERE x.fixed_category = 'other')::int AS other_fixed_n
    FROM (
      SELECT (${flagExpr}) AS flag,
        CASE
          WHEN tv.voice_gpu_key = 'cn-original' THEN 'confirmed'
          WHEN tv.id IS NULL THEN NULL
          WHEN NULLIF(BTRIM(tv.subtitle_text), '') IS NOT NULL
            AND BTRIM(tv.subtitle_text) <> BTRIM(COALESCE(l.text_zh, ''))
            THEN 'subtitle_modified'
          WHEN tv.voice_gpu_key = 'jp-lock' OR tv.conversion_meta->>'pipeline' = 'jp-lock'
            THEN 'jp_original'
          WHEN tv.voice_gpu_key IN ('cn-edit', 'audio-edit')
            OR tv.conversion_meta->>'pipeline' IN ('cn-edit', 'audio-edit')
            THEN 'audio_edited'
          WHEN tv.voice_gpu_key IN ('zeroshot-jp', 'zeroshot-cn')
            OR tv.conversion_meta->>'pipeline' = 'jp-zeroshot'
            THEN 'audio_modified'
          ELSE 'other'
        END AS fixed_category
      FROM lines l
      LEFT JOIN speakers s ON s.code = l.speaker
      LEFT JOIN regions rg ON rg.code = l.region
      LEFT JOIN line_meta m ON m.stem = l.stem
      LEFT JOIN LATERAL (
        SELECT id, subtitle_text, voice_gpu_key, conversion_meta
        FROM line_tts_versions
        WHERE stem = l.stem AND status = 'ready' AND review_state = 'locked'
        LIMIT 1
      ) tv ON true
      WHERE (${f.region} = '' OR l.region = ${f.region})
        AND (${f.kind} = '' OR l.kind = ${f.kind})
        AND (${f.mode} = '' OR m.dialogue_mode = ${f.mode})
        AND (${f.speakers.length} = 0 OR l.speaker = ANY(${f.speakers}))
        AND (
          ${f.flag} = ''
          OR (${f.flag} = 'fixed' AND (
            ${originalCnLockedExpr()}
            OR EXISTS (
              SELECT 1 FROM line_tts_versions tf
              WHERE tf.stem = l.stem AND tf.status = 'ready' AND tf.review_state = 'locked'
            )
          ))
          OR (${f.flag} <> '' AND ${f.flag} <> 'fixed' AND (${flagExpr}) = ${f.flag})
        )
        AND (NOT ${f.onlyCast} OR EXISTS (SELECT 1 FROM cast_members cm WHERE cm.speaker = l.speaker))
        AND (NOT ${f.onlyCast} OR l.kind = '对话')
        AND (NOT ${f.modifiedOnly} OR EXISTS (
          SELECT 1 FROM line_tts_versions tm
          WHERE tm.stem = l.stem AND tm.status = 'ready'
        ))
        AND (${searchExpr})
    ) x
  `;
  return row ?? {
    ok_n: 0, warn_n: 0, err_n: 0, pending_n: 0, fixed_n: 0,
    confirmed_n: 0, audio_modified_n: 0, subtitle_modified_n: 0,
    audio_edited_n: 0, jp_original_n: 0, other_fixed_n: 0,
  };
}

/** 旧skipTiming响应/props暂作兼容别名，只表达“原中文已锁”，不再读取旧豁免列。 */
export function originalCnLockedExpr() {
  return sql`EXISTS (SELECT 1 FROM line_tts_versions original_cn WHERE original_cn.stem=l.stem
    AND original_cn.status='ready' AND original_cn.review_state='locked' AND original_cn.voice_gpu_key='cn-original')`;
}
