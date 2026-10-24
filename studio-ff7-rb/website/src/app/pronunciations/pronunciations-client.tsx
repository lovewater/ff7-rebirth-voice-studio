"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import GameTermsPanel from "./game-terms-panel";

type Row = { id: number; src: string; dst: string; note: string | null; usage: "reference" | "tts_pinyin" };

export default function PronunciationsPage() {
  const requestedTab=useSearchParams().get("tab");
  const tab=requestedTab==="tts_pinyin"||requestedTab==="game_terms"?requestedTab:"reference";
  const [rows, setRows] = useState<Row[]>([]);
  const [src, setSrc] = useState("");
  const [dst, setDst] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/pronunciations", { cache: "no-store" });
    const data = (await response.json()) as { rows?: Row[]; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setRows(data.rows ?? []);
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/pronunciations", { cache: "no-store" })
      .then(async response => {
        const data = await response.json() as { rows?: Row[]; error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data.rows ?? [];
      })
      .then(items => { if (active) setRows(items); })
      .catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, []);

  async function add() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pronunciations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ src, dst, note, usage: "reference" }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setSrc("");
      setDst("");
      setNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(row: Row) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pronunciations/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ src: row.src, dst: row.dst, note: row.note ?? "" }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!window.confirm("删除这条替换？")) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pronunciations/${id}`, { method: "DELETE" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold">读音替换</h1>
      <div role="tablist" aria-label="词库用途" className="mt-5 flex gap-1 border-b border-zinc-800">
        {([['reference', 'ASR / 大模型参考'], ['tts_pinyin', 'TTS 发音替换'], ['game_terms', '游戏固定表达']] as const).map(([value, label]) => (
          <Link key={value} href={`/pronunciations?tab=${value}`} role="tab" aria-selected={tab === value}
            aria-controls={`panel-${value}`} id={`tab-${value}`} aria-disabled={busy}
            onClick={event => { if(busy)event.preventDefault();else setError(""); }}
            className={`border-b-2 px-4 py-3 text-sm ${tab === value ? 'border-sky-400 text-sky-300' : 'border-transparent text-zinc-400 hover:text-zinc-100'}`}>
            {label}{value!=="game_terms"?<span className="ml-2 text-xs text-zinc-500">{rows.filter(row => row.usage === value).length}</span>:null}
          </Link>
        ))}
      </div>
      {tab === "tts_pinyin" && error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {tab === 'game_terms' ? <GameTermsPanel/> : tab === 'tts_pinyin' ? <>
        <p className="mt-4 text-sm text-zinc-400">仅在发送给 TTS 时指定读音，不进入 ASR／大模型参考。字幕和字数统计保留汉字。</p>
        <div className="mt-4 flex items-center gap-3 rounded border border-sky-900 bg-sky-950/30 p-4 text-sm">
          <span className="text-zinc-200">了解了</span><span className="text-zinc-500">→</span>
          <code className="text-sky-300">LIAO3解了</code><span className="ml-auto text-xs text-zinc-500">LIAO3 = liǎo · 只读词库</span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rows.filter(row => row.usage === 'tts_pinyin').map(row => (
            <article key={row.id} className="rounded border border-zinc-800 bg-zinc-900/50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="text-zinc-100">{row.src}</span><span className="text-zinc-600">→</span><code className="text-sky-300">{row.dst}</code></div>
              <p className="mt-1 text-xs text-zinc-500">了读 liǎo · 第三声</p>
            </article>
          ))}
        </div>
        <p className="mt-4 text-xs leading-6 text-zinc-500">按词匹配，长词优先；“为了解开”“为了得到”等跨词情况保留原文。“得了”“明了”“知了”等有歧义的表达不全局替换。</p>
      </> : <>
      <p className="mt-4 text-sm text-zinc-400">现有替字词库，同时用于 TTS 替字和 ASR／大模型校字参考。不会改游戏字幕，长词优先，保留 [停顿=500]。</p>

      <form
        className="mt-5 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="text-xs text-zinc-400">
          原文
          <input
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            className="mt-1 block w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
            required
          />
        </label>
        <label className="text-xs text-zinc-400">
          换成
          <input
            value={dst}
            onChange={(e) => setDst(e.target.value)}
            className="mt-1 block w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
          />
        </label>
        <label className="text-xs text-zinc-400">
          备注
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 block w-48 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-sky-900 px-3 py-1.5 text-sm text-sky-100 hover:bg-sky-800 disabled:opacity-50"
        >
          新增
        </button>
      </form>
      {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

      <table className="mt-5 w-full text-left text-sm">
        <thead className="text-zinc-500">
          <tr>
            <th className="py-2">原文</th>
            <th>换成</th>
            <th>备注</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.filter(row => row.usage === 'reference').map((row) => (
            <tr key={row.id} className="border-t border-zinc-800">
              <td className="py-2 pr-2">
                <input
                  value={row.src}
                  onChange={(e) =>
                    setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, src: e.target.value } : r)))
                  }
                  className="w-28 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-zinc-100"
                />
              </td>
              <td className="pr-2">
                <input
                  value={row.dst}
                  onChange={(e) =>
                    setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, dst: e.target.value } : r)))
                  }
                  className="w-28 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-zinc-100"
                />
              </td>
              <td className="pr-2">
                <input
                  value={row.note ?? ""}
                  onChange={(e) =>
                    setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, note: e.target.value } : r)))
                  }
                  className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-300"
                />
              </td>
              <td className="whitespace-nowrap text-right">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(row)}
                  className="text-sky-300 hover:underline"
                >
                  保存
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(row.id)}
                  className="ml-3 text-red-400 hover:underline"
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </>}
      </section>
    </main>
  );
}
