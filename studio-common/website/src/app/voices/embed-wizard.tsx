"use client";

import { useMemo, useState } from "react";
import { PlayBtn } from "./play-btn";

export type EnSourceClip = {
  stem: string;
  text_zh: string | null;
  text_en: string | null;
  text_jp: string | null;
  region: string | null;
  region_name: string | null;
  en_dur_s: number | null;
};

type Candidate = { id: string; text: string; dur_s: number; url: string };

function dur(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}s`;
}

export function EmbedWizard({
  speaker,
  slot,
  clips,
  busy,
  onBusy,
  onDone,
  onError,
}: {
  speaker: string;
  slot: number;
  clips: EnSourceClip[];
  busy: boolean;
  onBusy: (value: boolean) => void;
  onDone: (versionId: number) => void;
  onError: (message: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [texts, setTexts] = useState("");
  const [draftId, setDraftId] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [kept, setKept] = useState<string[]>([]);
  const [stepNote, setStepNote] = useState("");

  const pickedClips = useMemo(
    () => clips.filter((clip) => picked.includes(clip.stem)),
    [clips, picked],
  );
  const totalEn = pickedClips.reduce((sum, clip) => sum + (clip.en_dur_s ?? 0), 0);
  const keptRows = candidates.filter((row) => kept.includes(row.id));
  const totalZh = keptRows.reduce((sum, row) => sum + row.dur_s, 0);
  const lineCount = texts.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;

  function toggle(stem: string, on: boolean) {
    setPicked((cur) => (on ? [...cur, stem] : cur.filter((item) => item !== stem)));
  }

  async function generate() {
    onError("");
    onBusy(true);
    setStepNote("");
    try {
      const response = await fetch(`/api/voices/${encodeURIComponent(speaker)}/embed/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stems: picked, texts }),
      });
      const data = (await response.json()) as { error?: string; draftId?: string; candidates?: Candidate[] };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setDraftId(data.draftId ?? "");
      setCandidates(data.candidates ?? []);
      setKept([]);
      setStepNote(`生成了 ${data.candidates?.length ?? 0} 条中文候选，听完勾选地道的`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      onBusy(false);
    }
  }

  async function finalize() {
    onError("");
    onBusy(true);
    try {
      const response = await fetch(`/api/voices/${encodeURIComponent(speaker)}/embed/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftId, candidateIds: kept, slot }),
      });
      const data = (await response.json()) as { error?: string; versionId?: number };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setDraftId("");
      setCandidates([]);
      setKept([]);
      onDone(data.versionId ?? 0);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      onBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-800 p-3">
      <div className="text-sm text-zinc-200">地道中文 embedding</div>
      <p className="mt-1 text-[11px] leading-5 text-zinc-600">
        英文只用来出候选：勾英文音源 → 写中文句子 → 生成一堆中文 → 挑地道的入库。
        中间草稿不进数据库，刷新超过一天会清掉。
      </p>

      <div className="mt-3 text-xs text-zinc-400">1. 勾选英文音源（合计 ≤ 15 秒）</div>
      <p className="mt-1 text-[11px] text-zinc-600">
        已选 {picked.length} 条 · {totalEn.toFixed(2)}s / 15s
        {totalEn > 15 ? "（超限）" : ""}
      </p>
      {clips.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600">这个人物没有带时长的英文台词。</p>
      ) : (
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-zinc-900">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
              <tr>
                <th className="w-8 px-2 py-1"></th>
                <th className="px-2 py-1">英长</th>
                <th className="px-2 py-1">字幕</th>
                <th className="px-2 py-1">试听</th>
              </tr>
            </thead>
            <tbody>
              {clips.map((clip) => {
                const on = picked.includes(clip.stem);
                return (
                  <tr
                    key={clip.stem}
                    className={
                      on
                        ? "border-t border-sky-900 bg-sky-950/70 shadow-[inset_3px_0_0_0_rgb(56,189,248)]"
                        : "border-t border-zinc-900"
                    }
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={busy}
                        onChange={(event) => toggle(clip.stem, event.target.checked)}
                        className="accent-sky-300"
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-400">
                      {dur(clip.en_dur_s)}
                    </td>
                    <td className="max-w-md px-2 py-1.5">
                      <div className="text-zinc-500">{clip.text_en}</div>
                      <div className="text-zinc-300">{clip.text_zh}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <PlayBtn src={`/api/audio/en/${encodeURIComponent(clip.stem)}`} label="英" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <label className="mt-3 block text-xs text-zinc-400">
        2. 中文试读（每行一句，最多 20 行）
        <textarea
          rows={6}
          value={texts}
          disabled={busy}
          onChange={(event) => setTexts(event.target.value)}
          placeholder={"我知道。\n走吧。\n这不是你的错。"}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm leading-6 text-zinc-200"
        />
      </label>
      <div className="mt-2">
        <button
          type="button"
          disabled={busy || picked.length === 0 || totalEn > 15 || lineCount === 0}
          onClick={() => void generate()}
          className="rounded bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600 disabled:opacity-40"
        >
          {busy && !candidates.length ? "生成中文候选中…" : `生成 ${lineCount || ""} 条中文候选`}
        </button>
      </div>

      {candidates.length ? (
        <div className="mt-4">
          <div className="text-xs text-zinc-400">
            3. 挑地道中文（选中 {kept.length} 条 · {totalZh.toFixed(2)}s / 15s）
          </div>
          <ul className="mt-2 space-y-2">
            {candidates.map((row) => {
              const on = kept.includes(row.id);
              return (
                <li
                  key={row.id}
                  className={`flex items-center gap-3 rounded border px-2 py-2 text-xs ${
                    on ? "border-sky-800 bg-sky-950/50" : "border-zinc-800"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy}
                    onChange={(event) =>
                      setKept((cur) =>
                        event.target.checked ? [...cur, row.id] : cur.filter((id) => id !== row.id),
                      )
                    }
                    className="accent-sky-300"
                  />
                  <audio className="h-8 w-48" controls preload="none" src={row.url} />
                  <span className="font-mono text-zinc-500">{dur(row.dur_s)}</span>
                  <span className="text-zinc-200">{row.text}</span>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={busy || kept.length === 0 || totalZh > 15}
            onClick={() => void finalize()}
            className="mt-3 rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
          >
            {busy && candidates.length ? "制作 embedding 中…" : "用选中的制作 embedding"}
          </button>
        </div>
      ) : null}
      {stepNote ? <p className="mt-2 text-xs text-zinc-400">{stepNote}</p> : null}
    </section>
  );
}
