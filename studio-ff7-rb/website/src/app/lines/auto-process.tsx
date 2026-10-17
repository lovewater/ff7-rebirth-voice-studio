"use client";

import { useEffect, useRef, useState } from "react";

type Job = { stem: string; textZh: string };

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function progressLine(done: number, total: number, elapsedMs: number) {
  const n = total || 1;
  const pct = Math.min(100, Math.floor((done / n) * 100));
  const filled = Math.round((pct / 100) * 10);
  const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  const elapsed = elapsedMs / 1000;
  const rate = elapsed > 0 && done > 0 ? done / (elapsed / 60) : 0;
  const remain = rate > 0 ? ((n - done) / rate) * 60 : 0;
  const rateText = rate > 0 ? `${rate.toFixed(2)}条/分` : "--条/分";
  return `${pct}%|${bar}| ${done}/${total} [${clock(elapsed)}<${clock(remain)}, ${rateText}]`;
}

export function AutoProcess({ jobs }: { jobs: Job[] }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [now, setNow] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const started = useRef(0);

  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  async function run() {
    if (!jobs.length || busy) return;
    if (
      !window.confirm(
        `将对本页 ${jobs.length} 条未处理的警告/异常做 zero-shot 克隆（已跳过标绿的手动处理）。不自动锁定，可能要较长时间。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setDone(0);
    started.current = Date.now();
    setNow(Date.now());
    setErrors([]);
    const failed: string[] = [];
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      try {
        const response = await fetch(`/api/lines/${encodeURIComponent(job.stem)}/tts/clone`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ttsText: job.textZh, durationFactor: 1 }),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        window.dispatchEvent(new Event("ff7-tts-changed"));
        try {
          const channel = new BroadcastChannel("ff7-tts-changed");
          channel.postMessage({ at: Date.now() });
          channel.close();
        } catch {
          /* ignore */
        }
      } catch (reason) {
        failed.push(`${job.stem}：${reason instanceof Error ? reason.message : String(reason)}`);
      }
      setDone(i + 1);
      setNow(Date.now());
    }
    setBusy(false);
    setErrors(failed);
  }

  const elapsed = (busy ? now : Date.now()) - (started.current || Date.now());
  const line =
    busy || done > 0
      ? progressLine(done, jobs.length, busy ? elapsed : started.current ? Date.now() - started.current : 0)
      : "";

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy || !jobs.length}
        onClick={() => void run()}
        className="inline-flex min-h-11 items-center rounded border border-zinc-700 px-3 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      >
        自动处理
      </button>
      {line ? <span className="font-mono text-xs text-zinc-400">{line}</span> : null}
      {errors.length ? (
        <span className="max-w-xl text-xs text-red-400">{errors.slice(0, 3).join("；")}</span>
      ) : null}
    </span>
  );
}
