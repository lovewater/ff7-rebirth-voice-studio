import Link from "next/link";
import { NORMAL_JP_CN_RATIO } from "@/lib/beats";
import { sql } from "@/lib/db";
import { draftFor, sectionOf, TOPIC_SECTIONS, topicOrder } from "@/lib/topics/junon-rufus";
import { Board, type TopicLine } from "./board";

export const dynamic = "force-dynamic";

type Row = {
  stem: string;
  speaker: string | null;
  name: string | null;
  text_jp: string | null;
  text_zh: string | null;
  subtitle_italic: boolean | null;
  dialogue_mode: string | null;
  jp_start_s: number | null;
  jp_speech_s: number | null;
  jp_dur_s: number | null;
  cn_speech_s: number | null;
  latest_id: string | null;
  latest_text: string | null;
  latest_speech: number | null;
  latest_dur: number | null;
  latest_start: number | null;
  latest_factor: number | null;
  latest_review_state: "candidate" | "locked" | "abnormal" | null;
  used_id: string | null;
  used_text: string | null;
  used_speech: number | null;
  used_factor: number | null;
};

function num(value: number | string | null) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export default async function JunonRufusPage() {
  const rows = await sql<Row[]>`
    SELECT l.stem, l.speaker, COALESCE(s.name_zh, l.speaker) AS name,
           l.text_jp, l.text_zh, l.subtitle_italic,
           m.dialogue_mode, m.jp_start_s, m.jp_speech_s, m.jp_dur_s, m.cn_speech_s,
           latest.id::text AS latest_id, latest.tts_text AS latest_text,
           latest.speech_s AS latest_speech, latest.dur_s AS latest_dur,
           latest.start_s AS latest_start, latest.duration_factor AS latest_factor,
           latest.review_state AS latest_review_state,
           used.id::text AS used_id, used.tts_text AS used_text,
           used.speech_s AS used_speech, used.duration_factor AS used_factor
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN line_meta m ON m.stem = l.stem
    LEFT JOIN LATERAL (
      SELECT picked.id, picked.tts_text, picked.speech_s, picked.dur_s, picked.start_s,
             picked.duration_factor, picked.review_state
      FROM line_tts_versions picked
      JOIN LATERAL (
        SELECT tts_text
        FROM line_tts_versions
        WHERE stem = l.stem AND status = 'ready'
        ORDER BY id DESC
        LIMIT 1
      ) newest ON true
      WHERE picked.stem = l.stem
        AND picked.status = 'ready'
        AND picked.tts_text IS NOT DISTINCT FROM newest.tts_text
      ORDER BY
        CASE WHEN m.jp_speech_s IS NULL OR picked.speech_s IS NULL THEN 1 ELSE 0 END,
        abs(picked.speech_s - m.jp_speech_s),
        picked.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT id, tts_text, speech_s, duration_factor
      FROM line_tts_versions
      WHERE stem = l.stem AND status = 'ready' AND review_state = 'locked'
      LIMIT 1
    ) used ON true
    WHERE l.region = 'C2210'
      AND l.stem >= 'C2210_MAIN_6000'
      AND l.stem < 'C2210_MAIN_7300'
  `;

  const lines: TopicLine[] = rows
    .filter((row) => sectionOf(row.stem))
    .sort((a, b) => topicOrder(a.stem) - topicOrder(b.stem) || a.stem.localeCompare(b.stem))
    .map((row) => {
      const draft = draftFor(row.stem, row.text_zh);
      return {
        stem: row.stem,
        speaker: row.speaker ?? "",
        name: row.name ?? row.speaker ?? "",
        section: sectionOf(row.stem)!.id,
        textJp: row.text_jp ?? "",
        textZh: row.text_zh ?? "",
        italic: row.subtitle_italic === true,
        mode: row.dialogue_mode,
        jpStart: num(row.jp_start_s),
        jpSpeech: num(row.jp_speech_s),
        jpDur: num(row.jp_dur_s),
        cnSpeech: num(row.cn_speech_s),
        draft,
        rewritten: draft !== (row.text_zh ?? ""),
        latest: row.latest_id
          ? {
              id: row.latest_id,
              text: row.latest_text ?? "",
              speech: num(row.latest_speech),
              dur: num(row.latest_dur),
              start: num(row.latest_start),
              factor: num(row.latest_factor),
              used: row.latest_review_state === "locked",
            }
          : null,
        used: row.used_id
          ? {
              id: row.used_id,
              text: row.used_text ?? "",
              speech: num(row.used_speech),
              factor: num(row.used_factor),
            }
          : null,
      };
    });

  const fold = (text: string) => text.replace(/[\s\p{P}]+/gu, "");
  const ready = lines.filter((line) => line.latest && fold(line.latest.text) === fold(line.draft)).length;

  return (
    <main className="mx-auto max-w-6xl px-3 py-4 sm:px-6 sm:py-6">
      <p className="text-sm text-zinc-500">
        <Link href="/topics" className="hover:text-zinc-200">专题</Link>
        <span className="mx-2">/</span>
        珠诺 · 路法斯就职
      </p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">路法斯就职演讲到赶走主角团</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        从海德格宣布总裁奖开始，经过路法斯演讲、点名、揭盔、交易，到尤菲刺杀、路法斯把主角团赶走。
        「比」＝（日文拍 ÷ 中文拍）÷ {NORMAL_JP_CN_RATIO.toFixed(2)}。1.00 是标准长度；大于 1 中文偏短，小于 1 中文偏长。
        这一场收在 1.03 到 1.18。短句不凑字。生成用日文零样本，场景演出会把说话段对齐日文。这里先不锁定，听完再锁。
      </p>
      <p className="mt-3 text-sm text-zinc-300">
        {lines.length} 句 · 已改写 {lines.filter((line) => line.rewritten).length} 句 · 最新音频已经是改写稿 {ready} 句
      </p>
      <ol className="mt-4 grid gap-2 text-sm text-zinc-400 sm:grid-cols-2 lg:grid-cols-3">
        {TOPIC_SECTIONS.map((section, index) => (
          <li key={section.id} className="rounded-lg border border-zinc-800 px-3 py-2">
            <a href={`#${section.id}`} className="font-medium text-zinc-200">{index + 1}. {section.title}</a>
            <p className="mt-1 text-xs leading-5">{section.blurb}</p>
          </li>
        ))}
      </ol>
      <Board lines={lines} />
    </main>
  );
}
