"use client";

import { useEffect, useState } from "react";

type Row = { id: number; src: string; dst: string; note: string | null };

export default function PronunciationsPage() {
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
    void load().catch((e) => setError(String(e)));
  }, []);

  async function add() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pronunciations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ src, dst, note }),
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
      <p className="mt-2 text-sm text-zinc-500">
        送 TTS 前按字替换。更长的原文优先。不会改游戏字幕，只改念出来的字。[停顿=500] 不会被动。
      </p>

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
          {rows.map((row) => (
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
    </main>
  );
}
