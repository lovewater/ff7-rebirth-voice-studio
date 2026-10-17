"use client";

import { patchTtsWithConfirmation } from "@/lib/tts-lock-client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ModifiedPlay } from "@/app/lines/play-cell";
import type { Timing } from "@/lib/timing";
import { TtsVersionTree } from "@/components/tts-version-tree";
import { AudioEditDialog } from "./audio-edit-dialog";

export const TTS_CHANGED = "ff7-tts-changed";
export const TTS_SUBTITLE_AUTOFILLED = "ff7-tts-subtitle-autofilled";

export type LineTtsVersion = {
  id: string;
  parent_tts_id?: string | null;
  is_used: boolean;
  subtitle_text: string | null;
  start_s: number | null;
  end_s: number | null;
  dur_s: number | null;
  speech_s: number | null;
  jp_lock?: boolean;
  is_new?: boolean;
};

export const TTS_CHANNEL = "ff7-tts-changed";

export function notifyTtsChanged() {
  window.dispatchEvent(new Event(TTS_CHANGED));
  try {
    const channel = new BroadcastChannel(TTS_CHANNEL);
    channel.postMessage({ at: Date.now() });
    channel.close();
  } catch {
    /* older browsers */
  }
}

export function notifySubtitleAutofilled(stem: string, text: string) {
  window.dispatchEvent(new CustomEvent(TTS_SUBTITLE_AUTOFILLED, { detail: { stem, text } }));
}

export function LineVersions({
  stem,
  jp,
  kind,
  warn,
  err,
  initial,
  skipTiming = false,
}: {
  stem: string;
  jp: Timing;
  kind?: string | null;
  warn: number;
  err: number;
  initial: LineTtsVersion[];
  skipTiming?: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const stamp = initial.map((v) => `${v.id}:${v.parent_tts_id ?? ""}:${Number(v.is_used)}:${v.subtitle_text ?? ""}`).join("|");

  useEffect(() => {
    setRows(initial);
  }, [stamp]);

  useEffect(() => {
    let active = true;
    async function load() {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts`, { cache: "no-store" });
      const data = await response.json() as {
        history?: {
          id: string | number;
          parent_tts_id?: string | number | null;
          is_used: boolean;
          subtitle_text: string | null;
          start_s: number | null;
          end_s: number | null;
          dur_s: number | null;
          speech_s: number | null;
          status: string;
          heard_at?: string | null;
          voice_gpu_key?: string | null;
          conversion_meta?: { pipeline?: string } | null;
        }[];
      };
      if (!response.ok || !active) return;
      const next = (data.history ?? [])
        .filter((row) => row.status === "ready")
        .map((row) => ({
          id: String(row.id),
          parent_tts_id: row.parent_tts_id == null ? null : String(row.parent_tts_id),
          is_used: Boolean(row.is_used),
          subtitle_text: row.subtitle_text,
          start_s: row.start_s,
          end_s: row.end_s,
          dur_s: row.dur_s,
          speech_s: row.speech_s,
          jp_lock: row.voice_gpu_key === "jp-lock" || row.conversion_meta?.pipeline === "jp-lock",
          is_new: row.heard_at == null,
        }))
        .sort((a, b) => Number(b.is_used) - Number(a.is_used) || Number(b.id) - Number(a.id));
      setRows(next);
      router.refresh();
    }
    const onChanged = () => { void load(); };
    void load();
    window.addEventListener(TTS_CHANGED, onChanged);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(TTS_CHANNEL);
    if (channel) channel.onmessage = onChanged;
    return () => {
      active = false;
      window.removeEventListener(TTS_CHANGED, onChanged);
      channel?.close();
    };
  }, [stem, router]);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setError("");
    try {
      const result = await patchTtsWithConfirmation(stem, id, body);
      if (!result) return;
      if (typeof body.isUsed === "boolean") {
        const nextUsed = body.isUsed;
        setRows((cur) =>
          cur.map((row) => ({
            ...row,
            is_used: row.id === id ? nextUsed : nextUsed ? false : Boolean(row.is_used),
          })),
        );
      }
      notifyTtsChanged();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`删除 TTS 记录 #${id} 及对应音频？`)) return;
    setBusy(id);
    setError("");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts/${id}`, {
        method: "DELETE",
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setRows((cur) => cur.filter((row) => row.id !== id));
      notifyTtsChanged();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-w-0">
      {!rows.length ? (
        <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-6 text-sm text-zinc-600">
          还没有生成的改。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <TtsVersionTree rows={rows} renderRow={(row, toggle) => (
            <div
              key={row.id}
              className={
                row.is_used
                  ? "rounded-lg border border-sky-900 bg-sky-950/20 px-2 py-1.5"
                  : "rounded-lg border border-zinc-800 px-2 py-1.5"
              }
            >
              <ModifiedPlay
                stem={stem}
                id={row.id}
                timing={{
                  start: row.start_s,
                  end: row.end_s,
                  dur: row.dur_s,
                  speech: row.speech_s,
                }}
                jp={jp}
                kind={kind}
                warn={warn}
                err={err}
                locked={row.is_used}
                jpLock={Boolean(row.jp_lock)}
                isNew={Boolean(row.is_new) && !row.is_used}
                ignored={skipTiming && row.is_used}
                actions={
                  <>
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => setEditing(row.id)}
                      className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 md:min-h-0 md:px-1.5 md:py-0.5 md:text-[11px]"
                    >
                      修改
                    </button>
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => void patch(row.id, { isUsed: !row.is_used })}
                      className={
                        row.is_used
                          ? "inline-flex min-h-11 items-center rounded bg-sky-800 px-3 text-sm text-sky-100 hover:bg-sky-700 disabled:opacity-40 md:min-h-0 md:px-1.5 md:py-0.5 md:text-[11px]"
                          : "inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 md:min-h-0 md:px-1.5 md:py-0.5 md:text-[11px]"
                      }
                    >
                      {row.is_used ? "解锁" : "锁定"}
                    </button>
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => void remove(row.id)}
                      className="inline-flex min-h-11 items-center rounded px-3 text-sm text-red-400 hover:text-red-300 disabled:opacity-40 md:min-h-0 md:px-1.5 md:py-0.5 md:text-[11px]"
                    >
                      删除
                    </button>
                    {toggle}
                  </>
                }
              />
              {row.subtitle_text ? (
                <div className="mt-1 flex gap-2 pl-1 text-[11px] leading-5 text-amber-300">
                  <span className="w-4 shrink-0 font-medium text-sky-400">改</span>
                  <div className="whitespace-pre-wrap">{row.subtitle_text}</div>
                </div>
              ) : null}
            </div>
          )} />
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      {editing ? (
        <AudioEditDialog
          stem={stem}
          sourceId={editing}
          jp={jp}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            notifyTtsChanged();
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
