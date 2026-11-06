import Link from "next/link";
import { notFound } from "next/navigation";
import { gameProfile } from "@/lib/game-profile";
import { sql } from "@/lib/db";
import { DuetBoard, type DuetLine } from "./board";

export const dynamic = "force-dynamic";

export default async function DuetVoicesPage() {
  if (gameProfile().id !== "rebirth") notFound();
  const rows = await sql<DuetLine[]>`
    SELECT l.stem, l.region, COALESCE(s.name_zh,l.speaker) AS speaker,
      m.extra->'dual_speaker'->>'production_text' AS text,
      m.extra->'dual_speaker'->>'main_stem' AS main_stem,
      m.extra->'dual_speaker'->>'main_tts_id' AS main_id,
      COALESCE(ms.name_zh,ml.speaker) AS main_speaker,
      COALESCE((m.extra->'dual_speaker'->>'partial')::boolean,false) AS partial,
      marked.id::text AS selected_id, marked.review_state AS selected_state,
      COALESCE(marked.voice_gpu_key='jp-lock' OR marked.conversion_meta->>'pipeline'='jp-lock',false) AS selected_original_jp,
      COALESCE(v.items,'[]'::jsonb) AS candidates
    FROM lines l JOIN line_meta m USING(stem)
    LEFT JOIN speakers s ON s.code=l.speaker
    LEFT JOIN lines ml ON ml.stem=m.extra->'dual_speaker'->>'main_stem'
    LEFT JOIN speakers ms ON ms.code=ml.speaker
    LEFT JOIN LATERAL (
      SELECT id,review_state,voice_gpu_key,conversion_meta FROM line_tts_versions
      WHERE stem=l.stem AND review_state IN ('locked','abnormal')
      ORDER BY id DESC LIMIT 1
    ) marked ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',t.id::text,'attempt',t.conversion_meta->>'native_attempt',
        'state',t.review_state,'pass',t.conversion_meta->'quality'->'pass_',
        'asr',t.conversion_meta->'local_asr'->>'text','speech',t.speech_s,'duration',t.dur_s,
        'ratio',t.conversion_meta->'dsp'->'ratio','processed',t.voice_gpu_key='audio-edit') ORDER BY (t.conversion_meta->>'native_attempt')::int) AS items
      FROM (
        SELECT DISTINCT ON (candidate.conversion_meta->>'native_attempt') candidate.*
        FROM line_tts_versions candidate WHERE candidate.stem=l.stem AND candidate.status='ready'
          AND candidate.conversion_meta->>'task'='rebirth-dual-speaker-20261106'
          AND candidate.conversion_meta->>'native_attempt' IN ('1','2','3')
        ORDER BY candidate.conversion_meta->>'native_attempt', (candidate.voice_gpu_key='audio-edit') DESC, candidate.id DESC
      ) t
    ) v ON true
    WHERE m.extra->'dual_speaker'->>'task'='rebirth-dual-speaker-20261106'
    ORDER BY l.region,l.stem
  `;
  return <main className="mx-auto max-w-6xl px-3 py-6 sm:px-6">
    <Link href="/topics" className="text-sm text-zinc-400 hover:text-white">← 专题</Link>
    <h1 className="mt-4 text-2xl font-semibold tracking-tight">同句合声 · 漏轨补配</h1>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">对照原有主轨，逐条试听补入的独立角色语音。文字沿用制作时的主轨；后半句跟读按原词保留。选择补配语音时沿用游戏字幕，不添加中文字幕覆盖。</p>
    <DuetBoard rows={rows} />
  </main>;
}
