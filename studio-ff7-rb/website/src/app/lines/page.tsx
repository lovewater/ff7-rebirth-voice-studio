import { originalCnLockedExpr } from "@/lib/line-filters";
import { LINE_PAGE_SIZE } from "@/lib/line-pagination";
import { randomUUID } from "node:crypto";
import { lineListWhere } from "@/lib/line-list-query";
import { MobileListAudio } from "@/components/mobile-list-audio";
import Link from "next/link";
import { Fragment } from "react";
import { sql, type LineRow } from "@/lib/db";
import { countFilteredHealth, healthFlagExpr } from "@/lib/line-filters";
import { DUR_ERR_S, DUR_OK_S, END_ERR_S, END_OK_S, START_ERR_S, START_OK_S } from "@/lib/timing";
import { AutoSubmitForm } from "./auto-submit-form";
import { FilterStatsBar, LiveTr, LiveTtsCount, LiveTtsSubtitle, ToneBox, TtsSnapshotProvider } from "./tts-snapshot";
import { PageJump } from "./page-jump";
import { AutoProcess } from "./auto-process";
import { PlayCell } from "./play-cell";
import { AutoRunMark } from "./auto-run-mark";
import { SpeakerPicker } from "./speaker-picker";
import { NetMetricsProvider } from "./net-metrics-context";
import { getSpeechComparisons } from "@/lib/speech-metrics-store";

export const dynamic = "force-dynamic";

const PAGE_SIZE = LINE_PAGE_SIZE;

const KIND_LABEL: Record<string, string> = {
  对话: "对话",
  旁白: "旁白",
  待处理: "待处理",
  NPC: "NPC",
  战斗: "战斗",
  talk: "对话",
  narrate: "旁白",
  npc: "NPC",
  battle: "战斗",
  cut: "过场",
  pending: "待处理",
};

const KIND_ORDER = ["对话", "旁白", "待处理", "NPC", "战斗"];
const MODE_LABEL: Record<string, string> = {
  scene: "场景演出",
  field: "普通对话",
  mixed: "兼有演出",
  unknown: "待判定",
};
const FLAG_ORDER = ["ok", "warn", "err", "pending"];

const FLAG_LABEL: Record<string, string> = {
  ok: "正常",
  warn: "警告",
  err: "异常",
  pending: "待测",
};

function listParam(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
}

export default async function LinesPage({
  searchParams,
}: {
  searchParams: Promise<{
    region?: string;
    q?: string;
    page?: string;
    kind?: string;
    mode?: string;
    speaker?: string | string[];
    warn?: string;
    err?: string;
    flag?: string;
    cast?: string;
    modified?: string;
  }>;
}) {
  const sp = await searchParams;
  const region = sp.region ?? "";
  const kind = sp.kind ?? "";
  const mode = sp.mode ?? "";
  const flag = sp.flag ?? "";
  const onlyCast = sp.cast === "1" || sp.cast === "true";
  const modifiedOnly = sp.modified === "1" || sp.modified === "true";
  const speakers = listParam(sp.speaker);
  const q = sp.q ?? "";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const reviewSession = randomUUID();
  const listWhere = lineListWhere({ region, kind, mode, flag, speakers, q, onlyCast, modifiedOnly });
  const flagExpr = healthFlagExpr();
  const healthStats = await countFilteredHealth({
    region,
    kind,
    mode,
    flag: "",
    speakers,
    q,
    onlyCast,
    modifiedOnly,
  });

  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN regions rg ON rg.code = l.region
    LEFT JOIN line_meta m ON m.stem = l.stem
    WHERE ${listWhere}
  `;

  const rows = await sql<LineRow[]>`
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
           ${originalCnLockedExpr()} AS skip_timing,
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
           tv.review_state AS tts_record_review_state,
           tv.subtitle_text AS tts_record_subtitle,
           tv.tts_text AS tts_record_text,
           tv.start_s AS tts_record_start_s,
           tv.end_s AS tts_record_end_s,
           tv.dur_s AS tts_record_dur_s,
           tv.speech_s AS tts_record_speech_s,
           tv.has_raw AS tts_record_has_raw,
           tv.jp_lock AS tts_record_jp_lock,
           tv.is_new AS tts_record_is_new,
           COALESCE(tc.n, 0)::int AS tts_record_count,
           ar.status AS auto_run_status,
           ar.selected_tts_id::text AS auto_run_tts_id,
           ar.error AS auto_run_error,
           (artts.review_state = 'locked') AS auto_run_locked
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN regions rg ON rg.code = l.region
    LEFT JOIN line_meta m ON m.stem = l.stem
    LEFT JOIN LATERAL (
      SELECT id, review_state, subtitle_text, tts_text, start_s, end_s, dur_s, speech_s,
             (raw_audio_path IS NOT NULL) AS has_raw,
             (voice_gpu_key = 'jp-lock' OR conversion_meta->>'pipeline' = 'jp-lock') AS jp_lock,
             (heard_at IS NULL) AS is_new
      FROM line_tts_versions
      WHERE stem = l.stem AND status = 'ready'
      ORDER BY (review_state <> 'candidate') DESC, (parent_tts_id IS NULL) DESC, id DESC
      LIMIT 1
    ) tv ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n
      FROM line_tts_versions
      WHERE stem = l.stem AND status = 'ready'
    ) tc ON true
    LEFT JOIN LATERAL (
      SELECT status, selected_tts_id, error
      FROM line_auto_runs
      WHERE stem = l.stem
      ORDER BY id DESC
      LIMIT 1
    ) ar ON true
    LEFT JOIN line_tts_versions artts ON artts.id = ar.selected_tts_id
    WHERE ${listWhere}
    ORDER BY COALESCE(rg.sort_order, 99999), l.stem
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `;

  const regionOpts = await sql<{ region: string; region_name: string; n: number }[]>`
    SELECT l.region,
           COALESCE(r.name_zh, l.region) AS region_name,
           COUNT(*)::int AS n
    FROM lines l
    LEFT JOIN regions r ON r.code = l.region
    GROUP BY l.region, r.name_zh, r.sort_order
    ORDER BY COALESCE(r.sort_order, 99999), l.region
  `;
  const kindOpts = await sql<{ kind: string; n: number }[]>`
    SELECT kind, COUNT(*)::int AS n FROM lines
    WHERE kind IS NOT NULL AND kind <> ''
      AND (${region} = '' OR region = ${region})
    GROUP BY kind
  `;
  kindOpts.sort(
    (a, b) =>
      (KIND_ORDER.indexOf(a.kind) === -1 ? 99 : KIND_ORDER.indexOf(a.kind)) -
      (KIND_ORDER.indexOf(b.kind) === -1 ? 99 : KIND_ORDER.indexOf(b.kind)),
  );
  const flagOpts = await sql<{ flag: string; n: number }[]>`
    SELECT (${flagExpr}) AS flag, COUNT(*)::int AS n
    FROM lines l
    LEFT JOIN line_meta m ON m.stem = l.stem
    WHERE (${region} = '' OR l.region = ${region})
    GROUP BY 1
  `;
  flagOpts.sort(
    (a, b) =>
      (FLAG_ORDER.indexOf(a.flag) === -1 ? 99 : FLAG_ORDER.indexOf(a.flag)) -
      (FLAG_ORDER.indexOf(b.flag) === -1 ? 99 : FLAG_ORDER.indexOf(b.flag)),
  );
  const speakerOpts = await sql<
    { speaker: string; speaker_name: string; n: number; role: string | null }[]
  >`
    SELECT l.speaker,
           COALESCE(s.name_zh, l.speaker) AS speaker_name,
           COUNT(*)::int AS n,
           c.role
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN cast_members c ON c.speaker = l.speaker
    WHERE l.speaker IS NOT NULL AND l.speaker <> ''
      AND (${region} = '' OR l.region = ${region})
    GROUP BY l.speaker, s.name_zh, c.role
    ORDER BY
      CASE c.role WHEN '主角' THEN 0 WHEN '配角' THEN 1 ELSE 2 END,
      n DESC
  `;
  const leadSpeakers = speakerOpts.filter((s) => s.role === "主角");
  const supportSpeakers = speakerOpts.filter((s) => s.role === "配角");
  const otherSpeakers = speakerOpts.filter((s) => s.role !== "主角" && s.role !== "配角");

  const pages = Math.max(1, Math.ceil(n / PAGE_SIZE));
  const qs = (p: number | string) => {
    const u = new URLSearchParams();
    if (region) u.set("region", region);
    if (kind) u.set("kind", kind);
    if (mode) u.set("mode", mode);
    for (const s of speakers) u.append("speaker", s);
    if (q) u.set("q", q);
    if (flag) u.set("flag", flag);
    if (onlyCast) u.set("cast", "1");
    if (modifiedOnly) u.set("modified", "1");
    u.set("page", String(p));
    return `/lines?${u.toString()}`;
  };
  function reviewHref(stem: string) {
    const context = new URLSearchParams(qs(page).split("?")[1]);
    context.set("reviewSession", reviewSession);
    return `/review/${encodeURIComponent(stem)}?${context}`;
  }
  const netInitial = await getSpeechComparisons(rows
    .filter((r) => (r.kind === "对话" || r.kind === "talk") && r.dialogue_mode === "scene" && !r.subtitle_italic)
    .flatMap((r) => [{ stem: r.stem }, ...(r.tts_record_id == null ? [] : [{ stem: r.stem, id: String(r.tts_record_id) }])]));
  const timingNote = (
    <>
      开始差 ≤{Math.round(START_OK_S * 1000)}ms、结束差 ≤{Math.round(END_OK_S * 1000)}ms、总长差 ≤{Math.round(DUR_OK_S * 1000)}ms 算过关。
      开始差 &gt;{Math.round(START_ERR_S * 1000)}ms、结束差 &gt;{Math.round(END_ERR_S * 1000)}ms、总长差 &gt;{Math.round(DUR_ERR_S * 1000)}ms 算异常。中间是警告。只看绝对毫秒。
      只有明确分类为场景演出的对话计入对时警告/异常；其他类型不显示对时问题。绿色背景表示已处理且通过。
    </>
  );
  function playFor(r: LineRow) {
    const scene = (r.kind === "对话" || r.kind === "talk") && r.dialogue_mode === "scene" && !r.subtitle_italic;
    return (
      <PlayCell
        stem={r.stem}
        jp={{ start: r.jp_start_s, end: r.jp_end_s, dur: r.jp_dur_s, speech: r.jp_speech_s }}
        cn={{ start: r.cn_start_s, end: r.cn_end_s, dur: r.cn_dur_s, speech: r.cn_speech_s }}
        en={{ start: r.en_start_s, end: r.en_end_s, dur: r.en_dur_s, speech: r.en_speech_s }}
        kind={r.kind}
        skipTiming={Boolean(r.skip_timing)}
        timingExempt={!scene}
        beatsEnabled={scene}
        beatTexts={{ jp: r.text_jp, cn: r.text_zh, modified: r.tts_record_text }}
        lockReplacesEdit
        autoRunPassed={r.auto_run_status === "passed" && r.auto_run_locked !== true}
        autoRunFailedTtsId={r.auto_run_status === "failed" ? r.auto_run_tts_id : null}
        autoRunError={r.auto_run_error}
        modified={r.tts_record_id == null ? null : {
          id: r.tts_record_id,
          reviewState: r.tts_record_review_state ?? "candidate",
          jpLock: r.tts_record_jp_lock === true,
          isNew: r.tts_record_is_new === true,
          timing: {
            start: r.tts_record_start_s,
            end: r.tts_record_end_s,
            dur: r.tts_record_dur_s,
            speech: r.tts_record_speech_s,
          },
        }}
      />
    );
  }
  const summaryQuery = (() => {
    const u = new URLSearchParams();
    if (region) u.set("region", region);
    if (kind) u.set("kind", kind);
    if (mode) u.set("mode", mode);
    for (const s of speakers) u.append("speaker", s);
    if (q) u.set("q", q);
    if (onlyCast) u.set("cast", "1");
    if (modifiedOnly) u.set("modified", "1");
    return u.toString();
  })();

  return (
    <main className="mx-auto max-w-[96rem] p-3 pb-24 sm:p-6 sm:pb-6">
      <AutoSubmitForm
        key={[region, kind, mode, flag, modifiedOnly ? "1" : "", onlyCast ? "1" : "", q, speakers.join(",")].join("|")}
        className="mb-4 flex flex-col gap-3"
        action="/lines"
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            name="region"
            defaultValue={region}
            className="min-h-11 flex-1 basis-[calc(50%-0.25rem)] rounded border border-zinc-700 bg-zinc-900 px-2 text-base sm:min-h-0 sm:flex-none sm:basis-auto sm:py-1.5 sm:text-sm"
          >
            <option value="">全部地区</option>
            {regionOpts.map((r) => (
              <option key={r.region} value={r.region}>
                {r.region_name} ({r.n})
              </option>
            ))}
          </select>
          <select
            name="kind"
            defaultValue={kind}
            className="min-h-11 flex-1 basis-[calc(50%-0.25rem)] rounded border border-zinc-700 bg-zinc-900 px-2 text-base sm:min-h-0 sm:flex-none sm:basis-auto sm:py-1.5 sm:text-sm"
          >
            <option value="">全部类型</option>
            {kindOpts.map((k) => (
              <option key={k.kind} value={k.kind}>
                {KIND_LABEL[k.kind] ?? k.kind} ({k.n})
              </option>
            ))}
          </select>
          <select
            name="mode"
            defaultValue={mode}
            className="min-h-11 flex-1 basis-[calc(50%-0.25rem)] rounded border border-zinc-700 bg-zinc-900 px-2 text-base sm:min-h-0 sm:flex-none sm:basis-auto sm:py-1.5 sm:text-sm"
          >
            <option value="">全部演出类型</option>
            {Object.entries(MODE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            name="flag"
            defaultValue={flag}
            className="min-h-11 flex-1 basis-[calc(50%-0.25rem)] rounded border border-zinc-700 bg-zinc-900 px-2 text-base sm:min-h-0 sm:flex-none sm:basis-auto sm:py-1.5 sm:text-sm"
          >
            <option value="">全部状态</option>
            {flagOpts.map((f) => (
              <option key={f.flag} value={f.flag}>
                {FLAG_LABEL[f.flag] ?? f.flag} ({f.n})
              </option>
            ))}
            <option value="fixed">已修复</option>
          </select>
          <select
            name="modified"
            defaultValue={modifiedOnly ? "1" : ""}
            className="min-h-11 flex-1 basis-[calc(50%-0.25rem)] rounded border border-zinc-700 bg-zinc-900 px-2 text-base sm:min-h-0 sm:flex-none sm:basis-auto sm:py-1.5 sm:text-sm"
          >
            <option value="">全部</option>
            <option value="1">有修改的语音</option>
          </select>
          <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0 sm:text-xs">
            <input
              type="checkbox"
              name="cast"
              value="1"
              defaultChecked={onlyCast}
              className="accent-zinc-200"
            />
            仅主角配角对话
          </label>
          <input
            name="q"
            defaultValue={q}
            placeholder="搜 stem / 角色 / 日文 / 中文（回车）"
            className="min-h-11 w-full rounded border border-zinc-700 bg-zinc-900 px-3 text-base sm:w-72 sm:py-1.5 sm:text-sm"
          />
          <Link href="/lines" className="inline-flex min-h-11 items-center px-2 text-sm text-zinc-400 underline sm:min-h-0 sm:py-1.5">
            清除
          </Link>
          <span className="self-center text-sm text-zinc-500">{n} 条</span>
        </div>
        <p className="hidden text-xs text-zinc-500 md:block">{timingNote}</p>
        <details className="text-xs text-zinc-500 md:hidden">
          <summary className="min-h-11 cursor-pointer py-2 text-zinc-400">时长规则</summary>
          <p className="pb-2">{timingNote}</p>
        </details>
        <SpeakerPicker
          leads={leadSpeakers}
          supports={supportSpeakers}
          others={otherSpeakers}
          selected={speakers}
        />
      </AutoSubmitForm>
      <NetMetricsProvider initial={netInitial}>
      <TtsSnapshotProvider
        stems={rows.map((r) => r.stem)}
        initial={Object.fromEntries(rows.map((r) => [r.stem, {
          id: r.tts_record_id,
          reviewState: r.tts_record_review_state ?? "candidate",
          subtitle: r.tts_record_subtitle,
          ttsText: r.tts_record_text,
          count: r.tts_record_count,
          jpLock: r.tts_record_jp_lock === true,
          skipTiming: Boolean(r.skip_timing),
          flag: r.flag,
          isNew: r.tts_record_is_new === true,
          timing: r.tts_record_id == null ? null : {
            start: r.tts_record_start_s,
            end: r.tts_record_end_s,
            dur: r.tts_record_dur_s,
            speech: r.tts_record_speech_s,
          },
        }]))}
      >
      <FilterStatsBar initial={healthStats} query={summaryQuery} active={flag} />
      <div className="space-y-3 md:hidden">
        {rows.map((r) => (
          <ToneBox key={r.stem} stem={r.stem} flag={r.flag} className={`rounded-lg border p-3 ${r.dialogue_mode === "scene" ? "border-emerald-500" : "border-zinc-800"}${r.subtitle_italic ? " italic" : ""}`}>
            <Link href={reviewHref(r.stem)} title={r.stem} className="block break-all font-mono text-xs leading-5 text-sky-300">
              {r.stem}
            </Link>
            <div className={`mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm${r.subtitle_italic ? " italic" : ""}`}>
              <span className="text-zinc-400">{r.region_name}</span>
              <span className="text-zinc-100">
                {r.name_zh}
                {r.speaker && r.speaker !== r.name_zh ? <span className="ml-1 font-mono text-[10px] text-zinc-600">{r.speaker}</span> : null}
              </span>
              <span className="text-zinc-500">{KIND_LABEL[r.kind ?? ""] ?? r.kind}</span>
              {r.kind === "对话" && r.dialogue_mode ? (
                <span className={r.dialogue_mode === "scene" ? "inline-flex items-center rounded border border-emerald-600 bg-emerald-950 px-1.5 py-0.5 font-semibold text-emerald-300" : r.dialogue_mode === "field" ? "text-zinc-500" : "text-sky-400"}>{MODE_LABEL[r.dialogue_mode] ?? r.dialogue_mode}</span>
              ) : null}
            </div>
            <MobileListAudio stem={r.stem} initialId={r.tts_record_id}>
            <div className="mt-2 space-y-1 text-xs leading-5">
              <div className="flex gap-2">
                <span className="w-4 shrink-0 text-zinc-500">日</span>
                <div className={r.text_jp ? `whitespace-pre-wrap text-zinc-200${r.subtitle_italic ? " italic" : ""}` : "text-zinc-600"}>{r.text_jp || "（无日文字幕）"}</div>
              </div>
              <div className="flex gap-2">
                <span className="w-4 shrink-0 text-zinc-500">中</span>
                <div className={r.text_zh ? `whitespace-pre-wrap text-zinc-400${r.subtitle_italic ? " italic" : ""}` : "text-zinc-600"}>{r.text_zh || "（无中文字幕）"}</div>
              </div>
              <LiveTtsSubtitle stem={r.stem} initial={r.tts_record_subtitle} original={r.text_zh} />
            </div>
            </MobileListAudio>
            {r.auto_run_status === "running" ? (
              <div className="mt-3">
                <AutoRunMark
                  status={r.auto_run_status}
                  error={r.auto_run_error}
                />
              </div>
            ) : null}
            <Link href={reviewHref(r.stem)} className="mt-3 flex min-h-11 items-center justify-center rounded bg-sky-900 px-3 text-sm text-sky-100">
              试听 / 审核
            </Link>
            <LiveTtsCount stem={r.stem} initial={r.tts_record_count} />
          </ToneBox>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-zinc-800 md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-2">区域</th>
              <th className="px-3 py-2"></th>
              <th className="px-3 py-2">说话人</th>
              <th className="px-3 py-2">类型</th>
              <th className="px-3 py-2">字幕</th>
              <th className="px-3 py-2">音频</th>
              <th className="px-3 py-2 text-right">TTS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
              <LiveTr
                id={`line-${r.stem}`}
                stem={r.stem}
                flag={r.flag}
                className="border-t border-zinc-800"
              >
                <td colSpan={2} className="w-px px-3 pt-1 pb-0 align-top whitespace-nowrap">
                  <Link href={`/line/${encodeURIComponent(r.stem)}/`} title={r.stem} target="_blank" rel="noopener noreferrer" className="inline-block font-mono text-[10px] leading-4 text-sky-300 hover:underline">
                    {r.stem}
                  </Link>
                </td>
                <td rowSpan={2} className={`align-middle px-3 py-2${r.subtitle_italic ? " italic" : ""}`}>
                  {r.name_zh}
                  {r.speaker && r.speaker !== r.name_zh ? (
                    <span className="ml-1 font-mono text-[10px] text-zinc-600">{r.speaker}</span>
                  ) : null}
                </td>
                <td rowSpan={2} className="align-middle px-3 py-2 text-zinc-500">
                  <div>{KIND_LABEL[r.kind ?? ""] ?? r.kind}</div>
                  {r.kind === "对话" && r.dialogue_mode ? (
                    <div className={`mt-1 whitespace-nowrap text-[11px] ${r.dialogue_mode === "scene" ? "font-semibold text-emerald-400" : r.dialogue_mode === "field" ? "text-zinc-500" : "text-sky-400"}`}>{MODE_LABEL[r.dialogue_mode] ?? r.dialogue_mode}</div>
                  ) : null}
                </td>
                <td rowSpan={2} className="align-middle max-w-sm px-3 py-2 align-middle">
                  <div className="flex gap-1">
                    <span className="w-4 shrink-0 text-zinc-500">日</span>
                    <div className={r.text_jp ? `whitespace-pre-wrap text-xs text-zinc-200${r.subtitle_italic ? " italic" : ""}` : "text-xs text-zinc-600"}>
                      {r.text_jp || "（无日文字幕）"}
                    </div>
                  </div>
                  <div className="mt-1 flex gap-1">
                    <span className="w-4 shrink-0 text-zinc-500">中</span>
                    <div className={r.text_zh ? `whitespace-pre-wrap text-xs text-zinc-400${r.subtitle_italic ? " italic" : ""}` : "text-xs text-zinc-600"}>
                      {r.text_zh || "（无中文字幕）"}
                    </div>
                  </div>
                  <LiveTtsSubtitle stem={r.stem} initial={r.tts_record_subtitle} original={r.text_zh} />
                </td>
                <td rowSpan={2} className="align-middle px-3 py-2">
                  {playFor(r)}
                </td>
                <td rowSpan={2} className="align-middle px-3 py-2 text-right align-middle">
                  <AutoRunMark
                    status={r.auto_run_status}
                    error={r.auto_run_error}
                  />
                  <Link href={`/line/${encodeURIComponent(r.stem)}/#tts`} target="_blank" rel="noopener noreferrer" className="inline-block whitespace-nowrap rounded bg-sky-900 px-2.5 py-1 text-xs text-sky-100 hover:bg-sky-800">TTS / 详情</Link>
                  <LiveTtsCount stem={r.stem} initial={r.tts_record_count} />
                </td>
              </LiveTr>
              <LiveTr
                stem={r.stem}
                flag={r.flag}
              >
                <td className="px-3 py-1 align-middle text-zinc-400" colSpan={2}>{r.region_name}</td>
              </LiveTr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      </TtsSnapshotProvider>
      </NetMetricsProvider>
      <div className="sticky bottom-0 z-20 -mx-3 mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-950 px-3 py-2 text-sm sm:static sm:mx-0 sm:gap-3 sm:border-0 sm:bg-transparent sm:px-0">
        {page > 1 ? <Link href={qs(page - 1)} className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-4">上一页</Link> : null}
        <span className="text-zinc-500">
          {page} / {pages}
        </span>
        {page < pages ? <Link href={qs(page + 1)} className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-4">下一页</Link> : null}
        <PageJump page={page} pages={pages} hrefTemplate={qs("__PAGE__")} />
        <div className="hidden md:block"><AutoProcess
          jobs={rows
            .filter(
              (r) =>
                (r.flag === "warn" || r.flag === "err") &&
                Boolean(r.text_zh?.trim()) &&
                !r.skip_timing &&
                r.tts_record_review_state !== "locked" &&
                r.tts_record_jp_lock !== true,
            )
            .map((r) => ({ stem: r.stem, textZh: r.text_zh!.trim() }))}
        /></div>
      </div>
    </main>
  );
}
