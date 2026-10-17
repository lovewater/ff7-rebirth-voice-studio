"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { REWRITE_COUNT, rewritePace, type RewriteCandidate } from "@/lib/rewrite-prompt";

type Slot = { status: "queued" | "running" | "done" | "error"; result?: RewriteCandidate; error?: string };

function RewriteDialog({ stem, text, onSelect, onClose }: {
  stem: string; text: string; onSelect: (text: string) => void; onClose: () => void;
}) {
  const [slots, setSlots] = useState<Slot[]>(Array.from({ length: REWRITE_COUNT }, () => ({ status: "queued" })));
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const controller = new AbortController();
    const previous: { raw: string; text: string }[] = [];
    const update = (index: number, slot: Slot) => {
      if (!controller.signal.aborted) setSlots((old) => old.map((s, i) => i === index ? slot : s));
    };
    async function conversation() {
      for (let attempt = 0; attempt < REWRITE_COUNT && !controller.signal.aborted; attempt += 1) {
        update(attempt, { status: "running" });
        try {
          const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/rewrite`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, attempt, previous: previous.map((item) => ({ ...item })) }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(145000)]),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "改写失败");
          if (previous.some((item) => item.text === result.text)) result.warnings.push("与其他候选重复");
          previous.push({ raw: result.raw, text: result.text });
          update(attempt, { status: "done", result });
        } catch (error) {
          update(attempt, { status: "error", error: error instanceof Error ? error.message : "改写失败" });
        }
      }
    }
    // One conversation, five turns. A delay avoids a duplicate run in development Strict Mode.
    const start = setTimeout(() => { void conversation(); }, 0);
    return () => { clearTimeout(start); controller.abort(); };
  }, [stem, text]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const nodes = panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", key, true); before?.focus(); };
  }, []);
  const complete = slots.filter((s) => s.status === "done" || s.status === "error").length;
  // All acceptable ratios have equal priority; preserve their conversation order.
  const distance = (slot: Slot) => {
    const ratio = slot.result?.beats.normalizedRatio;
    return ratio != null && Number.isFinite(ratio) ? (rewritePace(ratio) === "正常" ? 0 : Math.abs(ratio - 1)) : Infinity;
  };
  const sortedSlots = slots.map((slot, index) => ({ slot, index }))
    .sort((a, b) => distance(a.slot) - distance(b.slot) || a.index - b.index);
  return createPortal(<div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/75 sm:items-center sm:p-4" onClick={(e) => e.stopPropagation()}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="rewrite-title"
      className="max-h-[100dvh] w-full overflow-y-auto rounded-t-xl border border-zinc-700 bg-zinc-950 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl outline-none sm:max-h-[85vh] sm:max-w-2xl sm:rounded-xl sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="rewrite-title" className="text-lg font-medium">自动修正语速</h2>
        <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-4 text-sm text-zinc-300">关闭</button>
      </div>
      <p className="mt-2 text-sm text-zinc-400">连续五轮对话，每轮一条候选。点击后填入实际 TTS 文字。前后文只取本场演出，日文、英文、中文一起对照。拍数由程序重算。</p>
      {slots.find((slot) => slot.result?.scope)?.result?.scope ? <p className="mt-1 text-xs text-zinc-500">{slots.find((slot) => slot.result?.scope)?.result?.scope}</p> : null}
      <div role="status" className="my-4 flex items-center gap-2 text-sm text-sky-300">
        {complete < REWRITE_COUNT ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" /> : null}
        {complete < REWRITE_COUNT ? "正在计算" : "计算完成"} · {complete}/{REWRITE_COUNT}
      </div>
      <div className="space-y-3">
        {sortedSlots.map(({ slot, index }) => {
          const r = slot.result;
          return r ? <button key={index} type="button" onClick={() => onSelect(r.text)}
            className="block w-full rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-left hover:border-sky-500 focus-visible:outline-2 focus-visible:outline-sky-500">
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
              <span>候选 {index + 1}</span><span>日 {r.beats.jp.units} · 中 {r.beats.cn.units} · 目标 {r.target.toFixed(1)} 拍</span>
              <span className={r.beats.mark === "err" ? "text-red-400" : r.beats.mark === "warn" ? "text-amber-300" : "text-zinc-200"}>比 {r.beats.normalizedRatio?.toFixed(2) ?? "—"}</span>
            </div>
            <div className="whitespace-pre-wrap text-sm leading-6 text-zinc-100">{r.text}</div>
            {r.situation || r.problem || r.plan ? <div className="mt-3 space-y-1 text-xs leading-5 text-zinc-400">
              {r.situation ? <p>这句：{r.situation}</p> : null}
              {r.problem ? <p>问题：{r.problem}</p> : null}
              {r.plan ? <p>改法：{r.plan}</p> : null}
              {r.risk ? <p>风险：{r.risk}</p> : null}
            </div> : null}
            {r.warnings.length ? <p className="mt-2 text-xs text-amber-300">{r.warnings.join(" · ")}</p> : null}
          </button> : <div key={index} className="rounded-lg border border-zinc-800 p-4 text-sm text-zinc-500">
            候选 {index + 1} · {slot.status === "error" ? <span className="text-red-400">{slot.error}</span> : slot.status === "running" ? "正在生成…" : "等待计算…"}
          </div>;
        })}
      </div>
    </div>
  </div>, document.body);
}

export function AutoRewriteButton({ stem, text, enabled, onSelect }: {
  stem: string; text: string; enabled: boolean; onSelect: (text: string) => void;
}) {
  const [input, setInput] = useState<string | null>(null);
  return <>
    <button type="button" disabled={!enabled || !text.trim()} onClick={() => setInput(text)}
      title={enabled ? "生成五条中文改写候选" : "仅适用于需要对口型的场景演出"}
      className="inline-flex min-h-11 shrink-0 items-center rounded bg-sky-950 px-3 text-sm text-sky-300 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0 md:px-2 md:py-1 md:text-xs">自动修正语速</button>
    {input !== null ? <RewriteDialog stem={stem} text={input} onClose={() => setInput(null)}
      onSelect={(value) => { onSelect(value); setInput(null); }} /> : null}
  </>;
}
