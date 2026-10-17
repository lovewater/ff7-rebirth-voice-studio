import Link from "next/link";
import { notFound } from "next/navigation";
import { sql, type LineRow } from "@/lib/db";
import { healthCaption } from "@/lib/timing";
import { healthFlagExpr } from "@/lib/line-filters";
import { DetailPlay } from "./detail-play";
import { TtsPanel } from "@/app/lines/tts-dialog";
import { LiveTtsSubtitle } from "@/app/lines/tts-snapshot";
import { BeatSuffix } from "@/app/lines/beat-count";
import { LineVersions, type LineTtsVersion } from "./versions";
import { SequenceAutoRun } from "./sequence-auto-run";
import { SpeechComparisonPanel } from "./speech-comparison";
import { comparisonKey, getSpeechComparisons } from "@/lib/speech-metrics-store";
import { LineActions } from "./line-actions";
import { existsSync } from "node:fs";
import path from "node:path";
export const dynamic = "force-dynamic";
export default async function LinePage({ params }: { params: Promise<{ stem: string }> }) {
  const { stem } = await params;
  if (!/^[\w.\-]+$/.test(stem)) notFound();
  const warn = 0.15, err = 0.3;
  const flagExpr = healthFlagExpr();
  const [r] = await sql<LineRow[]>`
    SELECT l.id, l.pack, l.filename, l.stem, l.asset_path, l.region,
           COALESCE(rg.name_zh, l.region) AS region_name,
           l.speaker, l.kind, l.jp_chunk_id, l.status, l.text_jp, l.text_zh, l.text_en, l.script,
           m.dialogue_mode,
           l.subtitle_italic,
           COALESCE(s.name_zh, m.actor_zh, l.speaker) AS name_zh,
           m.actor_zh,
           m.jp_start_s, m.jp_end_s, m.jp_dur_s, m.jp_speech_s,
           m.cn_start_s, m.cn_end_s, m.cn_dur_s, m.cn_speech_s,
           m.en_start_s, m.en_end_s, m.en_dur_s, m.en_speech_s,
           COALESCE(m.skip_timing, false) AS skip_timing,
           CASE
             WHEN m.jp_speech_s IS NULL OR m.cn_speech_s IS NULL THEN NULL
             WHEN GREATEST(m.jp_speech_s, m.cn_speech_s) <= 0 THEN NULL
             ELSE ABS(m.jp_speech_s - m.cn_speech_s)
                  / GREATEST(m.jp_speech_s, m.cn_speech_s)
           END AS speech_rel,
           (${flagExpr}) AS flag,
           EXISTS (
             SELECT 1
             FROM voice_bank_versions vv
             JOIN voice_banks vb ON vb.id = vv.bank_id
             WHERE vb.speaker = l.speaker AND vv.status = 'ready'
               AND vv.gpu_speaker_key IS NOT NULL
               AND vv.embedding_path IS NOT NULL
               AND vv.reference_wav_path IS NOT NULL
           ) AS has_voice,
           tv.id AS tts_record_id,
           tv.is_used AS tts_record_is_used,
           tv.subtitle_text AS tts_record_subtitle, tv.tts_text AS tts_record_text,
           tv.start_s AS tts_record_start_s,
           tv.end_s AS tts_record_end_s,
           tv.dur_s AS tts_record_dur_s,
           tv.speech_s AS tts_record_speech_s,
           tv.has_raw AS tts_record_has_raw,
           tv.jp_lock AS tts_record_jp_lock,
           COALESCE(tc.n, 0)::int AS tts_record_count
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN regions rg ON rg.code = l.region
    LEFT JOIN line_meta m ON m.stem = l.stem
    LEFT JOIN LATERAL (
      SELECT id, (is_used IS TRUE) AS is_used, subtitle_text, tts_text, start_s, end_s, dur_s, speech_s,
             (raw_audio_path IS NOT NULL) AS has_raw,
             (voice_gpu_key = 'jp-lock' OR conversion_meta->>'pipeline' = 'jp-lock') AS jp_lock,
             (heard_at IS NULL) AS is_new
      FROM line_tts_versions
      WHERE stem = l.stem AND status = 'ready'
      ORDER BY is_used DESC, (parent_tts_id IS NULL) DESC, id DESC
      LIMIT 1
    ) tv ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n
      FROM line_tts_versions
      WHERE stem = l.stem AND status = 'ready'
    ) tc ON true
    WHERE l.stem = ${stem}
  `;
  if (!r) notFound();
  const versions = await sql<LineTtsVersion[]>`
    SELECT id::text AS id, parent_tts_id::text AS parent_tts_id, (is_used IS TRUE) AS is_used, subtitle_text,
           start_s, end_s, dur_s, speech_s,
           (raw_audio_path IS NOT NULL) AS has_raw,
           (voice_gpu_key = 'jp-lock' OR conversion_meta->>'pipeline' = 'jp-lock') AS jp_lock,
           (heard_at IS NULL) AS is_new
    FROM line_tts_versions
    WHERE stem = ${stem} AND status = 'ready'
    ORDER BY is_used DESC, id DESC
  `;
  const speechInitial = (await getSpeechComparisons([{ stem, id: versions[0]?.id }]))[comparisonKey(stem, versions[0]?.id)];
  const skipTiming = Boolean(r.skip_timing);
  const health = healthCaption(
    { start: r.jp_start_s, end: r.jp_end_s, dur: r.jp_dur_s, speech: r.jp_speech_s },
    { start: r.cn_start_s, end: r.cn_end_s, dur: r.cn_dur_s, speech: r.cn_speech_s },
    r.kind ?? undefined,
    undefined,
    undefined,
    skipTiming,
  );
  const status = r.flag === "pending" ? "待分析" : health.text;
  const hasJp = existsSync(path.join(process.cwd(), "data", "jp", `${stem}.mp3`));
  const jpTiming = {
    start: r.jp_start_s,
    end: r.jp_end_s,
    dur: r.jp_dur_s,
    speech: r.jp_speech_s,
  };
  return <main className="mx-auto max-w-[96rem] space-y-5 p-3 sm:p-6">
    <nav className="flex flex-wrap items-center gap-2 text-sm text-sky-300">
      <Link href={`/lines?speaker=${encodeURIComponent(r.speaker || "")}`} className="inline-flex min-h-11 items-center px-1">← 台词列表</Link>
      <Link href={`/voices?speaker=${encodeURIComponent(r.speaker || "")}`} className="inline-flex min-h-11 items-center px-1">角色音色库</Link>
    </nav>
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold sm:text-xl">{r.name_zh || r.speaker || "未知角色"} · 台词详情</h1>
        <span className={r.flag === "err" ? "text-sm text-red-300" : r.flag === "warn" ? "text-sm text-amber-300" : "text-sm text-zinc-400"}>{status}{skipTiming ? " · 忽略对时" : ""}</span>
        <LineActions stem={r.stem} skipTiming={skipTiming} hasJp={hasJp} />
      </div>
      <p className="mt-2 text-sm text-zinc-400">
        {r.region_name || "未分区"} · {r.kind || "未知类型"}
        {r.dialogue_mode === "scene" ? " · 场景演出（对时优先）" : null}
        {r.dialogue_mode === "field" ? " · 普通对话（语速优先）" : null}
        {r.dialogue_mode === "mixed" ? " · 兼有场景演出（对时优先）" : null}
        {r.dialogue_mode === "unknown" ? " · 演出类型待判定" : null}
        {" · "}{r.speaker}
      </p>
      <p className="mt-1 break-all font-mono text-xs text-zinc-600">{r.stem}</p>
      <div className="mt-5 grid items-start gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-col gap-1 text-sm md:min-w-72 md:text-xs">
            <div className="flex items-start gap-2">
              <span className="w-4 shrink-0 text-zinc-500">日</span>
              <div className={r.text_jp ? `whitespace-pre-wrap leading-5 text-zinc-200${r.subtitle_italic ? " italic" : ""}` : "leading-5 text-zinc-600"}>
                {r.text_jp || "（无日文字幕）"}
                <BeatSuffix language="jp" jp={r.text_jp} cn={r.text_zh} enabled={(r.kind === "对话" || r.kind === "talk") && r.dialogue_mode === "scene" && !r.subtitle_italic} />
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-4 shrink-0 text-zinc-500">中</span>
              <div className={r.text_zh ? `whitespace-pre-wrap leading-5 text-zinc-400${r.subtitle_italic ? " italic" : ""}` : "leading-5 text-zinc-600"}>
                {r.text_zh || "（无中文字幕）"}
                <BeatSuffix language="cn" jp={r.text_jp} cn={r.text_zh} enabled={(r.kind === "对话" || r.kind === "talk") && r.dialogue_mode === "scene" && !r.subtitle_italic} />
              </div>
            </div>
            <LiveTtsSubtitle stem={r.stem} initial={r.tts_record_subtitle} original={r.text_zh} />
            <div className="flex items-start gap-2">
              <span className="w-4 shrink-0 text-zinc-500">英</span>
              <div className={r.text_en ? `whitespace-pre-wrap leading-5 text-zinc-300${r.subtitle_italic ? " italic" : ""}` : "leading-5 text-zinc-600"}>
                {r.text_en || "（无英文字幕）"}
              </div>
            </div>
          </div>
          <div className="mt-2 overflow-x-auto pb-1">
            <DetailPlay
              stem={r.stem}
              beatsEnabled={(r.kind === "对话" || r.kind === "talk") && r.dialogue_mode === "scene" && !r.subtitle_italic}
              timingExempt={!((r.kind === "对话" || r.kind === "talk") && r.dialogue_mode === "scene" && !r.subtitle_italic)}
              beatTexts={{ jp: r.text_jp, cn: r.text_zh, modified: r.tts_record_text }}
              jp={jpTiming}
              cn={{
                start: r.cn_start_s,
                end: r.cn_end_s,
                dur: r.cn_dur_s,
                speech: r.cn_speech_s,
              }}
              kind={r.kind}
              warn={warn}
              err={err}
              skipTiming={skipTiming}
              modified={r.tts_record_id == null ? null : {
                id: r.tts_record_id,
                isUsed: r.tts_record_is_used === true,
                jpLock: r.tts_record_jp_lock === true,
                timing: {
                  start: r.tts_record_start_s,
                  end: r.tts_record_end_s,
                  dur: r.tts_record_dur_s,
                  speech: r.tts_record_speech_s,
                },
              }}
            />
          </div>
          <SpeechComparisonPanel stem={r.stem} versions={versions} initial={speechInitial} />
        </div>
        <LineVersions
          stem={r.stem}
          jp={jpTiming}
          kind={r.kind}
          warn={warn}
          err={err}
          skipTiming={skipTiming}
          initial={versions}
        />
      </div>
      <SequenceAutoRun stem={r.stem} />
    </section>
    <TtsPanel key={r.stem} stem={r.stem} />
  </main>;
}
