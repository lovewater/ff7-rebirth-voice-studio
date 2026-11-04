"use client";

import { useEffect, useState } from "react";
import { NORMAL_JP_CN_RATIO, type BeatPair, type BeatResult } from "@/lib/beats";

const cache = new Map<string, BeatResult>();
const pending = new Map<string, Promise<BeatResult>>();
type Job = { key: string; pair: BeatPair; resolve: (r: BeatResult) => void; reject: (e: Error) => void };
let queue: Job[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  timer = undefined;
  const batch = queue.splice(0, 100);
  if (queue.length) timer = setTimeout(() => void flush(), 30);
  try {
    const response = await fetch("/api/beats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairs: batch.map((job) => job.pair) }),
      signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json() as { results?: BeatResult[]; error?: string };
    if (!response.ok || payload.results?.length !== batch.length) {
      throw new Error(payload.error || "拍数计算暂不可用");
    }
    batch.forEach((job, index) => {
      const result = payload.results![index];
      cache.set(job.key, result);
      if (cache.size > 1000) cache.delete(cache.keys().next().value!);
      job.resolve(result);
    });
  } catch (reason) {
    batch.forEach((job) => job.reject(reason instanceof Error ? reason : new Error(String(reason))));
  } finally {
    batch.forEach((job) => pending.delete(job.key));
  }
}

function calculate(pair: BeatPair): Promise<BeatResult> {
  const key = JSON.stringify(pair);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const result = new Promise<BeatResult>((resolve, reject) => {
    queue.push({ key, pair, resolve, reject });
    if (!timer) timer = setTimeout(() => void flush(), 30);
  });
  pending.set(key, result);
  return result;
}

export function useBeats(jp: string | null | undefined, cn: string | null | undefined, enabled: boolean) {
  const key = JSON.stringify({ jp: jp ?? "", cn: cn ?? "" });
  const [state, setState] = useState<{ key: string; result?: BeatResult; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // Editing is debounced; visible list rows are coalesced into batch requests.
    const timeout = setTimeout(() => {
      void calculate({ jp: jp ?? "", cn: cn ?? "" })
        .then((result) => { if (active) setState({ key, result }); })
        .catch((e: Error) => { if (active) setState({ key, error: e.message }); });
    }, 250);
    return () => { active = false; clearTimeout(timeout); };
  }, [key, retry, enabled]);
  return { current: state?.key === key ? state : undefined, retry: () => setRetry((n) => n + 1) };
}

export function beatHealth(health: { flag: "ok" | "warn" | "err"; text: string }, result?: BeatResult, approved = false) {
  if (approved || !result?.mark) return health;
  const rank = { ok: 0, warn: 1, err: 2 };
  return rank[result.mark] > rank[health.flag]
    ? { flag: result.mark, text: result.mark === "err" ? "异常 拍数比" : "警告 拍数比" }
    : health;
}

function beatTooltip(result: BeatResult) {
  const j = result.jp;
  return [
    `比＝（日文拍数÷中文拍数）÷${NORMAL_JP_CN_RATIO.toFixed(2)}；1.00 为标准。大于1表示中文偏短，小于1表示中文偏长。`,
    "偏离1.00超过10%为警告、超过15%为异常（旧比例范围半宽的80% / 120%）。",
    "中文：汉字数 + 句中标点 × 1.5；整句末尾标点不计时，字幕换行不算句末。名字里的间隔点 ·・ 不算停顿。",
    "日文正文（不含标点、空白）<8字符不计算。",
    j.reading && `日文读音：${j.reading}`,
    j.mora != null && `日文 ${j.mora} 拍 + 标点 ${j.punctuation}；中文 ${result.cn.han} 字 + 标点 ${result.cn.punctuation}`,
    j.status === "review_reading" && `读音待核对：另一词典 ${j.alternateMora} 拍（${j.alternateReading}）${j.unknown.length ? `；未知：${j.unknown.join("、")}` : ""}`,
    result.normalizedRatio != null && `未取整的比值：${result.normalizedRatio.toFixed(6)}`,
    "拍数是估算，不代表实际拖音时长。",
  ].filter(Boolean).join("\n");
}

type Props = {
  jp: string | null | undefined;
  cn: string | null | undefined;
  enabled?: boolean;
};

/** Inline after 起/止/长/说. Only uncorrected scene dialogue gets warning colors.
 * Locked/confirmed audio retains the number but is always treated as approved.
 * Row backgrounds and filtering come from the same core's cached source metrics.
 */
export function BeatRatio({ jp, cn, enabled = false, approved = false, compact = false }: Props & { approved?: boolean; compact?: boolean }) {
  const { current, retry } = useBeats(jp, cn, enabled);
  if (!enabled) return null;
  const result = current?.result;
  const mark = approved ? "ok" : result?.mark;
  const color = mark === "err" ? "text-red-400" : mark === "warn" ? "text-amber-300" : "text-zinc-400";
  const value = result?.normalizedRatio;
  return <>
    <span className="text-zinc-600"> · </span>
    {current?.error ? <button type="button" title={`${current.error}；点击重试`} onClick={retry} className="text-zinc-500">比 —</button>
      : <span className={color} title={result ? beatTooltip(result) : "计算中"}>
        比 {result ? (value == null ? "—" : value.toFixed(2)) : "…"}
        {!compact && (result?.jp.status === "short" ? "（<8字）" : result?.jp.status === "review_reading" ? "（待核对）" : "")}
      </span>}
  </>;
}

export function BeatCount({ jp, cn, label = "拍数", enabled = false }: Props & { label?: string }) {
  const { current, retry } = useBeats(jp, cn, enabled);
  if (!enabled) return null;
  const result = current?.result;
  if (current?.error) return <button type="button" onClick={retry}
    className="mt-1 text-[11px] text-zinc-500 underline" title={current.error}>{label}暂不可用 · 重试</button>;
  if (!result) return <div className="mt-1 text-[11px] text-zinc-600">{label}计算中…</div>;
  const j = result.jp;
  return <div className="mt-1 text-[11px] text-zinc-400" title={beatTooltip(result)}>
    {label}：日 {j.units ?? (j.status === "short" ? "<8字，跳过" : "无文本，跳过")} · 中 {result.cn.units}
    {result.normalizedRatio != null ? ` · 比 ${result.normalizedRatio.toFixed(2)}` : ""}
    {j.status === "review_reading" ? " · 读音待核对" : ""}
  </div>;
}

/** Subtitle suffix uses weighted beats, including internal punctuation pauses. */
export function BeatSuffix({ jp, cn, enabled = false, language }: Props & { language: "jp" | "cn" }) {
  const { current, retry } = useBeats(jp, cn, enabled);
  if (!enabled || !(language === "jp" ? jp : cn)) return null;
  if (current?.error) return <button type="button" onClick={retry} title="拍数暂不可用，点击重试" className="text-zinc-500">（—）</button>;
  const result = current?.result;
  const units = language === "jp" ? result?.jp.units : result?.cn.units;
  const value = !result ? "…" : units == null ? "<8字，跳过" : String(units);
  return <span className="text-zinc-500" title={result ? beatTooltip(result) : "拍数计算中"}>（{value}）</span>;
}
