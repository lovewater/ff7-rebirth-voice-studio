"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TtsReviewState } from "@/lib/tts-review-state";
import { patchTtsWithConfirmation } from "@/lib/tts-lock-client";

export function TtsReviewAction({ stem, id, state, disabled = false, onChanged }: {
  stem: string; id: string; state: TtsReviewState; disabled?: boolean;
  onChanged?: (state: TtsReviewState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function toggle() {
    setBusy(true);
    try {
      const reviewState = state === "abnormal" ? "candidate" : "abnormal";
      const result = await patchTtsWithConfirmation(stem, id, { reviewState });
      if (!result) return;
      onChanged?.(reviewState);
      window.dispatchEvent(new Event("ff7-tts-changed"));
      try {
        const channel = new BroadcastChannel("ff7-tts-changed");
        channel.postMessage({ at: Date.now() }); channel.close();
      } catch { /* 不支持BroadcastChannel时仍更新本页 */ }
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "更新人工状态失败");
    } finally { setBusy(false); }
  }
  return <button type="button" disabled={disabled || busy} onClick={() => void toggle()}
    title={state === "abnormal" ? "取消人工异常，恢复未标记" : "标记这条音频为人工异常；会清除同句其他音频的人工标记"}
    className="inline-flex md:hidden min-h-11 items-center rounded px-3 text-sm text-red-400 hover:bg-red-950 disabled:opacity-40 md:min-h-0 md:px-1.5 md:py-0.5 md:text-[11px]">
    {busy ? "…" : state === "abnormal" ? "取消异常" : "标异常"}
  </button>;
}
