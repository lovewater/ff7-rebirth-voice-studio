"use client";

import { useEffect, useRef, useState } from "react";
import type { SpeechComparison } from "@/lib/speech-metrics";
import { useInitialNetMetrics } from "./net-metrics-context";

// List pages render both mobile and desktop rows. Share requests and only
// read saved results for visible rows; audio is computed by the background script.
const cache = new Map<string, { at: number; data: SpeechComparison }>();
const pending = new Map<string, Promise<SpeechComparison>>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
function pump() {
  while (running < 2 && queue.length) {
    running++;
    void queue.shift()!().finally(() => { running--; pump(); });
  }
}
function load(stem: string, id: string | undefined, revision: number) {
  const key = JSON.stringify([stem, id, revision]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.data.items.some((i) => i.measurement.pending) ? 1000 : 10000)) return Promise.resolve(hit.data);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const request = new Promise<SpeechComparison>((resolve, reject) => {
    queue.push(async () => {
      try {
        const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/speech-metrics${id ? `?ttsId=${encodeURIComponent(id)}` : ""}`, {
          cache: "no-store", signal: AbortSignal.timeout(15000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "净语速暂不可用");
        cache.set(key, { at: Date.now(), data });
        if (cache.size > 400) cache.delete(cache.keys().next().value!);
        resolve(data);
      } catch (error) { reject(error); }
      finally { pending.delete(key); }
    });
  });
  pending.set(key, request);
  pump();
  return request;
}

export function NetRatio({ stem, id: rawId, enabled }: { stem: string; id?: string; enabled: boolean }) {
  const id = rawId == null ? undefined : String(rawId);
  const initial = useInitialNetMetrics(stem, id);
  const identity = JSON.stringify([stem, id]);
  const anchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([stem, id, revision]);
  const [state, setState] = useState<{ key: string; identity: string; data?: SpeechComparison; error?: string }>();
  useEffect(() => {
    if (!enabled || !anchor.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "150px" });
    observer.observe(anchor.current);
    return () => observer.disconnect();
  }, [enabled]);
  useEffect(() => {
    const refresh = () => setRevision((n) => n + 1);
    window.addEventListener("ff7-tts-changed", refresh);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("ff7-tts-changed");
    if (channel) channel.onmessage = refresh;
    return () => { window.removeEventListener("ff7-tts-changed", refresh); channel?.close(); };
  }, []);
  useEffect(() => {
    if (!enabled || !visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void load(stem, id, revision).then((data) => {
        if (!active) return;
        setState({ key, identity, data });
        if (data.items.some((i) => i.measurement.pending)) timer = setTimeout(refresh, 5000);
      }).catch((error: Error) => {
        if (active) setState((old) => ({ key, identity, data: old?.identity === identity ? old.data : initial, error: error.message }));
      });
    };
    refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, visible, stem, id, revision, key, identity, initial]);
  if (!enabled) return null;
  const current = state?.identity === identity ? state : initial ? { data: initial, error: undefined } : undefined;
  const jp = current?.data?.items.find((item) => item.key === "jp")?.measurement;
  const cn = current?.data?.items.find((item) => item.key === (id ? "tts" : "cn"))?.measurement;
  const value = jp?.rate != null && cn?.rate != null && cn.rate > 0 ? jp.rate / cn.rate : null;
  const error = current?.error || jp?.error || cn?.error;
  const title = [
    "净＝日文净语速÷中文净语速，仅作对照，未归一，不以1为合格标准。",
    "低于各自峰值15%、连续至少200ms的静音整段扣除；中日文标点和空白均不计拍。",
    id ? `中文使用当前版本 #${id} 的音频与朗读稿。` : "中文使用源中文音频与正文。",
    jp?.activeS != null && `日文净发声 ${jp.activeS.toFixed(3)}s，${jp.units ?? "—"} 摩拉，${jp.rate?.toFixed(2) ?? "—"} 摩拉/秒。`,
    cn?.activeS != null && `中文净发声 ${cn.activeS.toFixed(3)}s，${cn.units ?? "—"} 字，${cn.rate?.toFixed(2) ?? "—"} 字/秒。`,
    current && value == null && !error && "短句、读音待核对、缺少正文或无发声时不计算。",
    (jp?.pending || cn?.pending) && "后台排队计算中；已有数值为上次保存的结果。",
    error && `${error}；点击重试。`,
  ].filter(Boolean).join("\n");
  return <span ref={anchor} className="text-zinc-400" title={title}>
    <span className="text-zinc-600"> · </span>
    {error && value == null ? <button type="button" onClick={() => setRevision((n) => n + 1)}>净 —</button>
      : <>净 {current ? (value == null ? (jp?.pending || cn?.pending ? "待算" : "—") : value.toFixed(2)) : "…"}</>}
  </span>;
}
