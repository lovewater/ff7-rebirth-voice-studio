"use client";

import { useEffect, useRef, useState } from "react";
import { conditionalLockSteps } from "@/lib/conditional-lock";

export type ConditionalSource = { source: "jp" | "cn" | "tts"; id?: string; title: string; duration: number | null };

export function ConditionalLockDialog({ stem, source, referenceDuration, italic, onClose, onSelect }: {
  stem: string;
  source: ConditionalSource; referenceDuration: number | null; italic: boolean;
  onClose: () => void; onSelect: (step: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [measured, setMeasured] = useState<{ duration: number; referenceDuration: number } | null>(null);
  const [error, setError] = useState("");
  const duration = measured?.duration ?? source.duration;
  const jpDuration = measured?.referenceDuration ?? referenceDuration;
  const steps = measured ? conditionalLockSteps(measured.duration, measured.referenceDuration) : [];
  const delta = duration != null && jpDuration != null ? Math.round((duration - jpDuration) * 1000) : null;
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const search = new URLSearchParams({ source: source.source });
    if (source.id) search.set("id", source.id);
    void fetch(`/api/lines/${stem}/conditional-lock?${search}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "无法读取时长");
        if (!controller.signal.aborted) setMeasured(result);
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取时长失败"); });
    return () => controller.abort();
  }, [stem, source.source, source.id]);
  return <dialog ref={dialog} aria-label="条件锁定" onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      // 原生dialog的遮罩点击会落到dialog本身；框内空白不算取消。
      const box = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) onClose();
    }} className={`m-auto w-[calc(100vw-1.5rem)] max-w-md rounded-xl border border-zinc-700 bg-zinc-950 p-4 text-zinc-200 backdrop:bg-black/75${italic ? " italic" : ""}`}>
    <h2 className="text-base font-semibold">条件锁定 · {source.title}</h2>
    <p className="mt-2 text-xs leading-5 text-zinc-400">只向日文时长靠拢，最大调整 20%。点选后生成新音频并锁定，原音频保留。</p>
    <p className="mt-2 font-mono text-xs text-zinc-400">当前 {duration?.toFixed(3) ?? "—"}s · 日文 {jpDuration?.toFixed(3) ?? "—"}s</p>
    <p className="mt-1 text-xs text-zinc-400">当前差距：{delta == null ? "暂无数据" : `${delta > 0 ? "长" : delta < 0 ? "短" : "相同 "}${Math.abs(delta)}ms`}</p>
    <div className="mt-4 grid grid-cols-3 gap-2">
      {steps.map(choice => <div key={choice.step}>
        <button type="button" onClick={() => onSelect(choice.step)} className="min-h-12 w-full rounded-lg border border-emerald-800 bg-emerald-950 px-1 text-sm font-medium text-emerald-200 active:bg-emerald-900">
          {choice.direction === "lengthen" ? "拉长" : "缩短"} {Number(choice.percent.toFixed(2))}%
        </button>
        <p className="mt-2 text-center font-mono text-xs text-zinc-400">{choice.duration.toFixed(3)}s</p>
        <p className={`mt-1 text-center text-xs ${Math.abs(choice.differenceMs) <= 200 ? "text-emerald-300" : "text-amber-300"}`}>
          {choice.differenceMs === 0 ? "与日文等长" : `比日文${choice.differenceMs > 0 ? "长" : "短"}${Math.abs(choice.differenceMs)}ms`}
        </p>
      </div>)}
    </div>
    {error ? <p role="alert" className="mt-3 text-sm text-red-300">{error}</p> : !measured ? <p role="status" className="mt-3 text-sm text-zinc-400">正在读取音频时长…</p>
      : !steps.length && <p className="mt-3 text-sm text-zinc-400">已经与日文等长，请直接锁定。</p>}
    {steps[0]?.direction === "shorten" && <p className="mt-3 text-xs text-zinc-500">缩短按加速倍率计算：时长 ÷（1＋百分比）。</p>}
    <p className="mt-4 text-center text-xs text-zinc-500">点击弹窗外关闭，不做任何修改</p>
  </dialog>;
}
