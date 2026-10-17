"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { notifyTtsChanged } from "./versions";

export function LineActions({
  stem,
  skipTiming,
  hasJp,
}: {
  stem: string;
  skipTiming: boolean;
  hasJp: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"skip" | "jp" | null>(null);
  const [error, setError] = useState("");

  async function toggleSkip() {
    setBusy("skip");
    setError("");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/flags`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skipTiming: !skipTiming }),
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
    if (!window.confirm("把这句的日文原声锁定为最终版？会替换当前锁。")) return;
    setBusy("jp");
    setError("");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts/lock-jp`, {
        method: "POST",
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
        disabled={busy != null}
        onClick={() => void toggleSkip()}
        className={
          skipTiming
            ? "inline-flex min-h-11 items-center rounded bg-emerald-900 px-3 text-sm text-emerald-100 hover:bg-emerald-800 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
            : "inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
        }
      >
        {busy === "skip" ? "…" : skipTiming ? "取消忽略对时" : "忽略对时"}
      </button>
      <button
        type="button"
        disabled={busy != null || !hasJp}
        onClick={() => void lockJp()}
        title={hasJp ? "用日文原声作为锁定的最终版" : "没有日文配音"}
        className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
      >
        {busy === "jp" ? "…" : "锁日文原声"}
      </button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}
