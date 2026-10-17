"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmSubtitle } from "@/lib/tts-lock-client";
import { notifyTtsChanged } from "./versions";

export function LineActions({
  stem,
  skipTiming,
  hasJp,
  originalText,
}: {
  stem: string;
  skipTiming: boolean;
  hasJp: boolean;
  originalText: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"skip" | "jp" | null>(null);
  const [error, setError] = useState("");

  async function toggleSkip() {
    setBusy("skip");
    setError("");
    try {
      // 异常处理页锁原中文也先核对字幕；取消时不能创建音频或切换现有锁。
      const abnormalLock = window.location.pathname === "/abnormal" && !skipTiming;
      const subtitleText = abnormalLock ? await confirmSubtitle((originalText ?? "").replace(/\\n/g, "\n"), (originalText ?? "").replace(/\\n/g, "\n")) : undefined;
      if (subtitleText === null) return;
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/${abnormalLock ? "original-review" : "flags"}`, {
        method: abnormalLock ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(abnormalLock ? { reviewState: "locked", subtitleText } : { skipTiming: !skipTiming }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      notifyTtsChanged();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function lockJp() {
    if (window.location.pathname !== "/abnormal" && !window.confirm("把这句的日文原声锁定为最终版？会替换当前锁。")) return;
    setBusy("jp");
    setError("");
    try {
      const subtitleText = window.location.pathname === "/abnormal" ? await confirmSubtitle((originalText ?? "").replace(/\\n/g, "\n"), (originalText ?? "").replace(/\\n/g, "\n")) : undefined;
      if (subtitleText === null) return;
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts/lock-jp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subtitleText }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      notifyTtsChanged();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy != null || !hasJp}
        onClick={() => void lockJp()}
        title={hasJp ? "用日文原声作为锁定的最终版" : "没有日文配音"}
        className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
      >
        {busy === "jp" ? "…" : "锁日文原声"}
      </button>
      <button
        type="button"
        disabled={busy != null}
        onClick={() => void toggleSkip()}
        className={
          skipTiming
            ? "inline-flex min-h-11 items-center rounded bg-emerald-900 px-3 text-sm text-emerald-100 hover:bg-emerald-800 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
            : "inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
        }
      >
        {busy === "skip" ? "…" : skipTiming ? "取消原中文锁定" : "锁原中文"}
      </button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}
