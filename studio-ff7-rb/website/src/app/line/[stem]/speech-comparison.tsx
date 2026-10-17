"use client";

import { useEffect, useState } from "react";
import type { SpeechComparison } from "@/lib/speech-metrics";
import { TTS_CHANGED, TTS_CHANNEL } from "./versions";

function seconds(value: number | null | undefined) {
  return value == null ? "—" : `${value.toFixed(3)}s`;
}

export function SpeechComparisonPanel({ stem, versions, initial }: {
  stem: string;
  initial?: SpeechComparison;
  versions: { id: string; is_used: boolean }[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const id = selected !== null && versions.some((v) => v.id === selected) ? selected : versions[0]?.id;
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([stem, id]);
  const key = JSON.stringify([stem, id, revision]);
  const [state, setState] = useState<{ key: string; identity: string; data?: SpeechComparison; error?: string }>();
  useEffect(() => {
    const saved = (event: Event) => {
      const detail = (event as CustomEvent<{ stem: string; id: string }>).detail;
      if (detail?.stem === stem && /^\d+$/.test(detail.id)) setSelected(detail.id);
    };
    window.addEventListener("ff7-audio-edit-saved", saved);
    return () => window.removeEventListener("ff7-audio-edit-saved", saved);
  }, [stem]);
  useEffect(() => {
    const refresh = () => setRevision((n) => n + 1);
    window.addEventListener(TTS_CHANGED, refresh);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(TTS_CHANNEL);
    if (channel) channel.onmessage = refresh;
    return () => { window.removeEventListener(TTS_CHANGED, refresh); channel?.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const query = id ? `?ttsId=${encodeURIComponent(id)}` : "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { void fetch(`/api/lines/${encodeURIComponent(stem)}/speech-metrics${query}`, {
      signal: controller.signal, cache: "no-store",
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "分析失败");
      if (!controller.signal.aborted) {
        setState({ key, identity, data });
        if ((data as SpeechComparison).items.some((i) => i.measurement.pending)) timer = setTimeout(refresh, 5000);
      }
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setState((old) => ({ key, identity, data: old?.identity === identity ? old.data : (id === versions[0]?.id ? initial : undefined), error: error.message }));
    });
    };
    refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [stem, id, key, identity, initial, versions]);
  const current = state?.identity === identity ? state : id === versions[0]?.id && initial ? { data: initial, error: undefined } : undefined;
  const jpRate = current?.data?.items.find((item) => item.key === "jp")?.measurement.rate;
  return <details className="mt-4 rounded-lg border border-zinc-800 p-3" aria-label="净发声语速对照">
    <summary className="cursor-pointer text-sm text-zinc-200">净发声语速对照</summary>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {versions.length > 0 && <select aria-label="选择对照音频版本" value={id ?? ""}
        onChange={(event) => setSelected(event.target.value)}
        className="min-h-9 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-300">
        {versions.map((v) => <option key={v.id} value={v.id}>版本 #{v.id}{v.is_used ? " · 已锁定" : ""}</option>)}
      </select>}
      <button type="button" onClick={() => setRevision((n) => n + 1)}
        className="min-h-9 px-2 text-xs text-sky-300">刷新对照</button>
    </div>
    {!current && <p className="mt-2 text-xs text-zinc-500" role="status">…</p>}
    {current?.error && <p className="mt-2 text-xs text-red-400" role="alert">{current.error}</p>}
    {current?.data && <>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left text-xs tabular-nums">
          <thead className="text-zinc-500"><tr>
            {["音频", "总时长", "扣除静音", "净发声", "正文拍数", "净语速"].map((label) =>
              <th key={label} className="px-2 py-1 font-normal">{label}</th>)}
          </tr></thead>
          <tbody className="text-zinc-300">{current.data.items.map(({ key: rowKey, label, language, measurement: m }) =>
            <tr key={rowKey} className="border-t border-zinc-800">
              <th scope="row" className="px-2 py-2 font-normal">{label}</th>
              {m.error ? <td colSpan={5} className="px-2 py-2 text-zinc-500">{m.error}</td> : <>
                <td className="px-2 py-2">{seconds(m.durationS)}</td>
                <td className="px-2 py-2" title={`${m.silenceCount ?? 0} 段静音`}>{seconds(m.silenceS)}</td>
                <td className="px-2 py-2">{seconds(m.activeS)}</td>
                <td className="px-2 py-2">{m.units ?? "—"}{m.readingStatus === "review_reading" ? "（读音待核对）" : m.readingStatus === "short" ? "（短句跳过）" : ""}</td>
                <td className="px-2 py-2">{m.rate == null ? (m.pending ? "后台排队中" : m.status === "silent" ? "无发声" : "—") : `${m.rate.toFixed(2)} ${language === "jp" ? "摩拉" : "字"}/秒`}</td>
              </>}
            </tr>)}</tbody>
        </table>
      </div>
      {jpRate != null && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
        {current.data.items.filter((item) => item.language === "cn" && item.measurement.rate != null && item.measurement.rate > 0)
          .map((item) => <span key={item.key}>{item.label} · {(jpRate / item.measurement.rate!).toFixed(3)}</span>)}
      </div>}
      <div className="mt-2 space-y-2 text-xs text-zinc-500">{current.data.items.map((item) => <p key={item.key}>
        {item.label}：{item.measurement.error || (item.measurement.silences?.length
          ? item.measurement.silences.map((s) => `${seconds(s.startS)}–${seconds(s.endS)}`).join("、")
          : "无")}
      </p>)}</div>
    </>}
  </details>;
}
