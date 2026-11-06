"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Candidate = { processed: boolean; id: string; attempt: string; state: string; pass: boolean | null; asr: string | null; speech: number | null; duration: number | null; ratio: number | null };
export type DuetLine = { stem: string; region: string; speaker: string | null; text: string; main_stem: string; main_id: string | null; main_speaker: string | null; partial: boolean; selected_original_jp: boolean; selected_id: string | null; selected_state: string | null; candidates: Candidate[] };
const audio = (stem: string, id: string) => `/api/lines/${encodeURIComponent(stem)}/tts/${encodeURIComponent(id)}/audio`;
const seconds = (n: number | null) => n == null ? "—" : `${Number(n).toFixed(2)}s`;

function CandidateAudio({ row, version }: { row: DuetLine; version: Candidate }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const selected = row.selected_id === version.id && row.selected_state === "locked";
  async function choose() {
    setBusy(true);
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(row.stem)}/tts/${version.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewState: "locked", preserveSubtitle: true }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "锁定失败");
      window.dispatchEvent(new Event("ff7-tts-changed"));
      router.refresh();
    } catch (error) { window.alert(error instanceof Error ? error.message : "锁定失败"); }
    finally { setBusy(false); }
  }
  return <div className={`border-l-2 pl-3 ${selected ? "border-emerald-400" : "border-zinc-700"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <span>第 {version.attempt} 遍 · #{version.id} · {version.pass ? "核字及速度通过" : version.processed ? "待试听复核" : "原生音频 · 处理未过"}</span>
      <button disabled={busy || selected} onClick={() => void choose()} className="rounded border border-zinc-700 px-2 py-1 disabled:text-emerald-400">{busy ? "保存中…" : selected ? "已锁定 · 沿用字幕" : "采用 · 沿用字幕"}</button>
    </div>
    <audio controls preload="none" src={audio(row.stem, version.id)} className="mt-2 h-9 w-full" />
    <p className="mt-1 text-xs text-zinc-500">发声 {seconds(version.speech)} · 总长 {seconds(version.duration)}{version.ratio != null ? ` · 处理倍率 ${Number(version.ratio).toFixed(3)}` : ""}</p>
    <details className="mt-1 text-xs text-zinc-400"><summary className="cursor-pointer">查看识别文字</summary><p className="mt-1">{version.asr || "没有识别结果"}</p></details>
  </div>;
}

export function DuetBoard({ rows }: { rows: DuetLine[] }) {
  const [onlyReview, setOnlyReview] = useState(false);
  const locked = rows.filter(row => row.selected_state === "locked").length;
  const original = rows.filter(row => row.selected_state === "locked" && row.selected_original_jp).length;
  const shown = onlyReview ? rows.filter(row => row.selected_state !== "locked") : rows;
  return <>
    <div className="my-5 flex flex-wrap items-center gap-4 border-y border-zinc-800 py-3 text-sm">
      <span>{rows.length} 条补轨 · {locked - original} 条中文已锁 · {original} 条保留原声选择 · {rows.length - locked} 条待复核</span>
      <label className="flex items-center gap-2 text-zinc-400"><input type="checkbox" checked={onlyReview} onChange={e => setOnlyReview(e.target.checked)} />只看待复核</label>
    </div>
    <div className="space-y-8">{shown.map((row, index) => <section key={row.stem} id={row.stem} className="border-b border-zinc-800 pb-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">{index + 1}. {row.main_speaker} ＋ {row.speaker}{row.partial ? " · 后半句跟读" : ""}</h2>
        <Link href={`/line/${row.stem}#tts`} target="_blank" className="text-sm text-sky-400">打开补轨详情 ↗</Link>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-xl leading-relaxed">{row.text}</p>
      <p className="mt-1 break-all font-mono text-[11px] text-zinc-500">{row.stem}</p>
      <div className="mt-4 grid gap-5 md:grid-cols-[1fr_2fr]">
        <div>
          <Link href={`/line/${row.main_stem}#tts`} target="_blank" className="text-sm text-zinc-300">制作时主轨 · {row.main_speaker}{row.main_id ? ` #${row.main_id}` : " 原中文"} ↗</Link>
          <audio controls preload="none" src={row.main_id ? audio(row.main_stem,row.main_id) : `/api/audio/cn/${row.main_stem}`} className="mt-2 h-10 w-full" />
          <p className="mt-2 text-xs leading-5 text-zinc-500">各轨单独试听；游戏中的起播时差保留。补轨没有中文字幕覆盖。</p>
          {row.selected_id && !row.candidates.some(v => v.id === row.selected_id) ? <p className="mt-3 text-sm text-amber-300">已保留另一窗口的选择 #{row.selected_id}，请到详情试听。</p> : null}
        </div>
        <div className="space-y-4">{row.candidates.length ? row.candidates.map(version => <CandidateAudio key={version.id} row={row} version={version} />) : <p className="text-sm text-zinc-400">没有本次补配候选；已有选择优先保留。</p>}</div>
      </div>
    </section>)}</div>
  </>;
}
