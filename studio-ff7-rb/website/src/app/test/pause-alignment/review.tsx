"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AudioPlayButton } from "@/components/audio-play-button";
import { reportTtsPlaybackSource } from "@/lib/tts-play-count";
import type { PauseExperimentSnapshot, PauseTrack } from "@/lib/pause-experiment";

const colors: Record<PauseTrack["key"], string> = {
  jp: "#94a3b8", reference: "#67c4df", previous: "#b4a4dc", result: "#54d49c", gold: "#e8be69",
};

function Wave({ track, maximum }: { track: PauseTrack; maximum: number }) {
  const d = useMemo(() => {
    if (!track.peaks.length) return "";
    const upper = track.peaks.map((peak, index) => `${index},${32 - Math.min(1, Math.max(0, peak)) * 29}`);
    const lower = track.peaks.map((peak, index) => `${index},${32 + Math.min(1, Math.max(0, peak)) * 29}`).reverse();
    return `M${upper.join("L")}L${lower.join("L")}Z`;
  }, [track.peaks]);
  const scale = track.duration / maximum * 1000 / Math.max(1, track.peaks.length - 1);
  return <svg role="img" aria-label={`${track.label}波形，${track.duration.toFixed(2)}秒，${track.parts}节`} viewBox="0 0 1000 64" preserveAspectRatio="none" className="block h-12 w-full rounded bg-zinc-950 sm:h-14">
    <title>{track.label} · {track.duration.toFixed(3)}s · {track.parts}节</title>
    {[0, 1 / 3, 2 / 3, 1].map((ratio) => <line key={ratio} x1={ratio * 1000} x2={ratio * 1000} y1="0" y2="64" stroke="#3f3f46" strokeWidth="1" />)}
    <line x1="0" x2="1000" y1="32" y2="32" stroke="#3f3f46" strokeWidth="1" />
    {track.gap && <rect x={track.gap.start / maximum * 1000} width={(track.gap.end - track.gap.start) / maximum * 1000} y="0" height="64" fill={colors[track.key]} opacity="0.08" />}
    <path d={d} transform={`scale(${scale} 1)`} fill={colors[track.key]} />
  </svg>;
}

export function PauseReview({ initial }: { initial: PauseExperimentSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [query, setQuery] = useState("");
  const [showPrevious, setShowPrevious] = useState(true);
  const [showReference, setShowReference] = useState(false);
  const [showGold, setShowGold] = useState(true);
  const [onlyIssues, setOnlyIssues] = useState(false);
  useEffect(() => {
    if (snapshot.completed >= snapshot.planned) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void fetch("/api/experiments/pause-alignment", { cache: "no-store", signal: controller.signal })
        .then((response) => response.ok ? response.json() : null)
        .then((next: PauseExperimentSnapshot | null) => { if (next?.version === initial.version) setSnapshot(next); })
        .catch(() => { /* 离线时保留已显示的报告，下一轮再更新。 */ });
    }, 15000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [snapshot.completed, snapshot.planned, initial.version]);
  const passed = snapshot.items.filter((item) => item.status === "passed").length;
  const visible = snapshot.items.filter((item) => {
    if (onlyIssues && !(item.status === "failed" || Math.abs(item.openingDeltaMs ?? 0) > 300)) return false;
    return `${item.stem} ${item.speaker} ${item.tracks.map((track) => track.text).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  return <main className="mx-auto max-w-6xl px-3 py-5 sm:px-6 sm:py-7">
    <header className="mb-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">两节表演 · 40条试听</h1><span className="text-sm text-zinc-400">完成 {snapshot.completed}/{snapshot.planned} · 程序通过 {passed} · 待复核 {snapshot.items.filter((item) => item.status === "failed").length}</span></div>
      <p className="max-w-4xl text-xs leading-5 text-zinc-400">同一句统一时间刻度，波形振幅按各轨峰值归一。绿色为本轮结果，紫色为上一版，金色为人工参考。程序通过仍需试听判断；点击播放只播放一条，不改变锁定状态。</p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找编号、角色或台词" aria-label="查找实验条目" className="h-9 w-full rounded border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-emerald-500 sm:w-72" />
        <label className="flex items-center gap-2"><input type="checkbox" checked={showPrevious} onChange={(event) => setShowPrevious(event.target.checked)} className="accent-emerald-500" />上一版</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={showGold} onChange={(event) => setShowGold(event.target.checked)} className="accent-emerald-500" />人工参考</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={showReference} onChange={(event) => setShowReference(event.target.checked)} className="accent-emerald-500" />裁后日文参考</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={onlyIssues} onChange={(event) => setOnlyIssues(event.target.checked)} className="accent-amber-500" />仅看待复核／偏移较大</label>
      </div>
      <p className="text-xs text-zinc-500">“まあ／不过”已作为延期案例排除，补入另一条样本。裁后参考从裁剪后的 0 秒开始；第二节偏移以两边首个发声点归一计算，超过 300ms 仅提示复听。</p>
    </header>
    <div className="space-y-4">
      {visible.map((item) => {
        const tracks = item.tracks.filter((track) => (showPrevious || track.key !== "previous") && (showGold || track.key !== "gold") && (showReference || track.key !== "reference"));
        const maximum = Math.max(0.1, ...item.tracks.map((track) => track.duration));
        const index = snapshot.items.indexOf(item) + 1;
        return <section key={item.stem} data-experiment-stem={item.stem} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2.5 sm:px-4">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><span className="text-xs tabular-nums text-zinc-500">{index.toString().padStart(2, "0")}</span><Link href={`/line/${item.stem}#tts`} target="_blank" className="break-all font-mono text-xs text-zinc-200 hover:text-emerald-300">{item.stem}</Link><span className="text-sm text-zinc-300">{item.speaker}</span></div>
            <div className="flex flex-wrap gap-3 text-xs"><span className={item.status === "passed" ? "text-emerald-400" : item.status === "failed" ? "text-amber-300" : "text-zinc-400"}>{item.status === "passed" ? "程序通过" : item.status === "failed" ? "待复核" : item.status === "running" ? "处理中" : "待处理"}</span>{item.openingDeltaMs !== null && <span className={Math.abs(item.openingDeltaMs) > 300 ? "text-amber-300" : "text-zinc-400"}>第二节 {item.openingDeltaMs >= 0 ? "+" : ""}{Math.round(item.openingDeltaMs)}ms</span>}</div>
          </div>
          <div className="space-y-3 p-3 sm:p-4">
            {tracks.map((track) => <div key={track.key} data-track={track.key} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4">
              <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
                <AudioPlayButton src={track.src} onPlayRequest={() => reportTtsPlaybackSource(track.src)} accent={track.key === "result"} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded text-sm" />
                <div className="min-w-0 text-xs leading-5"><p style={{ color: colors[track.key] }}>{track.label}</p><p className="text-zinc-500">{track.id ? `#${track.id} · ` : ""}{track.duration.toFixed(2)}s</p></div>
              </div>
              <div className="min-w-0"><Wave track={track} maximum={maximum} /><p className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 ${track.rewritten ? "text-amber-300" : "text-zinc-400"}`}>{track.text || "（无字幕）"}</p></div>
            </div>)}
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4"><span /><div className="flex justify-between text-[11px] tabular-nums text-zinc-500">{[0, 1 / 3, 2 / 3, 1].map((ratio) => <span key={ratio}>{(ratio * maximum).toFixed(1)}s</span>)}</div></div>
            {!item.tracks.some((track) => track.key === "result") && <p className="text-xs text-zinc-500">本轮结果尚未就绪；页面会在实验进行期间自动更新。</p>}
            {item.error && <p className="border-l-2 border-amber-700 pl-3 text-xs leading-5 text-amber-300/90">{item.error}</p>}
          </div>
        </section>;
      })}
      {!visible.length && <p className="py-12 text-center text-sm text-zinc-500">没有匹配的实验条目。</p>}
    </div>
  </main>;
}
