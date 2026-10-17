"use client";

import { useEffect, useRef, useState } from "react";
import { notifyTtsChanged } from "./versions";

type EventRow = {
  id: string;
  at: string;
  step: string;
  level: string;
  message: string;
  payload: unknown;
};

type RunRow = {
  id: string;
  kind: "performance" | "casual";
  status: "running" | "passed" | "failed";
  selected_tts_id: string | null;
  error: string | null;
  created_at: string;
};

function thinkingOf(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const thinking = (payload as { thinking?: unknown }).thinking;
  return typeof thinking === "string" ? thinking : "";
}

function extraOf(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const copy = { ...(payload as Record<string, unknown>) };
  delete copy.thinking;
  const keys = Object.keys(copy);
  if (!keys.length) return "";
  try {
    return JSON.stringify(copy);
  } catch {
    return "";
  }
}

export function AutoRunPanel({ stem }: { stem: string }) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const running = run?.status === "running" || starting;

  async function refresh() {
    const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/auto-run`, { cache: "no-store" });
    const data = await response.json() as { run?: RunRow | null; events?: EventRow[]; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const nextRun = data.run ?? null;
    const nextEvents = data.events ?? [];
    setRun(nextRun);
    setEvents(nextEvents);
    return { run: nextRun, events: nextEvents };
  }

  useEffect(() => {
    let active = true;
    void refresh().catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [stem]);

  useEffect(() => {
    if (run?.status !== "running") return;
    let lastCount = events.length;
    let lastSelected = run.selected_tts_id;
    const timer = window.setInterval(() => {
      void refresh().then((next) => {
        const count = next.events.length;
        const selected = next.run?.selected_tts_id ?? null;
        const finished = Boolean(next.run && next.run.status !== "running");
        if (finished || count !== lastCount || selected !== lastSelected) {
          lastCount = count;
          lastSelected = selected;
          notifyTtsChanged();
        }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [stem, run?.status]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  async function start() {
    setStarting(true);
    setError("");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/auto-run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forceGenerate: true }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await refresh();
      notifyTtsChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarting(false);
    }
  }

  const kindLabel = run?.kind === "performance" ? "表演" : run?.kind === "casual" ? "非表演" : "";
  const statusLabel = run?.status === "running" ? "运行中" : run?.status === "passed" ? "通过" : run?.status === "failed" ? (run.selected_tts_id ? "待复核" : "异常") : "";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-zinc-200">自动运行</span>
        <button
          type="button"
          disabled={running}
          onClick={() => void start()}
          className="inline-flex min-h-11 items-center rounded bg-sky-900 px-3 text-sm text-sky-100 hover:bg-sky-800 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
        >
          {running ? "运行中" : "自动运行"}
        </button>
        {kindLabel ? <span className="text-[11px] text-zinc-500">{kindLabel}</span> : null}
        {statusLabel ? (
          <span className={run?.status === "failed" ? "text-[11px] text-red-300" : run?.status === "passed" ? "text-[11px] text-emerald-300" : "text-[11px] text-zinc-400"}>
            {statusLabel}{run?.selected_tts_id ? ` · #${run.selected_tts_id}` : ""}
          </span>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      {run?.error && run.status === "failed" ? <p className="mt-2 text-xs text-red-400">{run.error}</p> : null}
      <div ref={scroller} className="mt-2 min-h-0 flex-1 overflow-y-auto rounded border border-zinc-900 bg-zinc-950 p-2 font-mono text-[11px] leading-5 text-zinc-400">
        {!events.length ? <p className="text-zinc-600">还没有日志</p> : events.map((event) => {
          const thinking = thinkingOf(event.payload);
          const extra = extraOf(event.payload);
          return (
            <div key={event.id} className="mb-2 border-b border-zinc-900 pb-2 last:mb-0 last:border-0 last:pb-0">
              <div className={event.level === "error" ? "text-red-300" : event.level === "think" ? "text-sky-300" : "text-zinc-300"}>
                {new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })} {event.step} {event.message}
              </div>
              {thinking || extra ? (
                <details className="mt-1">
                  <summary className="w-fit cursor-pointer text-zinc-500 hover:text-zinc-300 focus-visible:outline focus-visible:outline-sky-500">
                    详细信息
                  </summary>
                  {thinking ? <pre className="mt-1 whitespace-pre-wrap text-zinc-500">{thinking}</pre> : null}
                  {extra ? <pre className="mt-1 whitespace-pre-wrap break-all text-zinc-600">{extra}</pre> : null}
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
