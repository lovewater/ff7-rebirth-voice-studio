"use client";

import { createContext, useContext, useEffect, useState, type ReactNode, type ComponentProps } from "react";
import Link from "next/link";
import { BeatCount } from "./beat-count";
import { ttsSubtitleDisplay } from "@/lib/tts-subtitle-display";

const TTS_CHANNEL = "ff7-tts-changed";

export function isLockedFlag(value: unknown) {
  return value === true || value === 1 || value === "t" || value === "true";
}

export type HealthStats = {
  ok_n: number;
  warn_n: number;
  err_n: number;
  pending_n: number;
  fixed_n: number;
  confirmed_n: number;
  audio_modified_n: number;
  subtitle_modified_n: number;
  audio_edited_n: number;
  jp_original_n: number;
  other_fixed_n: number;
};

export type TtsSnapshot = {
  id: string | null;
  isUsed: boolean;
  subtitle: string | null;
  ttsText?: string | null;
  count: number;
  jpLock?: boolean;
  skipTiming?: boolean;
  flag?: string;
  isNew?: boolean;
  timing: {
    start: number | null;
    end: number | null;
    dur: number | null;
    speech: number | null;
  } | null;
};

type MapSnap = Record<string, TtsSnapshot>;

const Ctx = createContext<MapSnap | null>(null);

function fingerprint(row: TtsSnapshot) {
  const t = row.timing;
  return [
    row.id ?? "",
    Number(isLockedFlag(row.isUsed)),
    row.subtitle ?? "",
    row.ttsText ?? "",
    row.count,
    row.flag ?? "",
    t?.start ?? "",
    t?.end ?? "",
    t?.dur ?? "",
    t?.speech ?? "",
    Number(Boolean(row.jpLock)),
    Number(Boolean(row.skipTiming)),
    Number(Boolean(row.isNew)),
  ].join("|");
}

function sameMaps(a: MapSnap, b: MapSnap) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (!left || !right) return false;
    if (fingerprint(left) !== fingerprint(right)) return false;
  }
  return true;
}

export function TtsSnapshotProvider({
  stems,
  initial,
  children,
}: {
  stems: string[];
  initial: MapSnap;
  children: ReactNode;
}) {
  const [snap, setSnap] = useState(initial);
  const stemsKey = stems.join(",");

  useEffect(() => {
    setSnap(initial);
  }, [stemsKey]);

  useEffect(() => {
    if (!stemsKey) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch(`/api/lines/tts-snapshot?stems=${encodeURIComponent(stemsKey)}`);
        if (!response.ok) return;
        const data = (await response.json()) as { stems?: MapSnap };
        if (cancelled || !data.stems) return;
        setSnap((prev) => (sameMaps(prev, data.stems!) ? prev : data.stems!));
      } catch {
        /* keep last snapshot */
      }
    };
    void tick();
    const id = window.setInterval(tick, 5000);
    const onVis = () => {
      if (document.visibilityState === "visible") void tick();
    };
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(TTS_CHANNEL);
      channel.onmessage = () => {
        void tick();
      };
    } catch {
      channel = null;
    }
    window.addEventListener(TTS_CHANNEL, tick);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener(TTS_CHANNEL, tick);
      document.removeEventListener("visibilitychange", onVis);
      channel?.close();
    };
  }, [stemsKey]);

  return <Ctx.Provider value={snap}>{children}</Ctx.Provider>;
}

export function useTtsSnapshot(stem: string): TtsSnapshot | undefined {
  return useContext(Ctx)?.[stem];
}

export function LiveTtsBeats({ stem, jp }: { stem: string; jp: string | null }) {
  const live = useTtsSnapshot(stem);
  if (!live?.ttsText || live.jpLock) return null;
  return <BeatCount jp={jp} cn={live.ttsText} label={`${isLockedFlag(live.isUsed) ? "锁定" : "候选"} #${live.id} 拍数`} />;
}

export function LiveTtsSubtitle({
  stem,
  initial,
  original,
}: {
  stem: string;
  initial: string | null;
  original?: string | null;
}) {
  const live = useTtsSnapshot(stem);
  const subtitle = live ? live.subtitle : initial;
  const locked = live ? isLockedFlag(live.isUsed) : false;
  // 日文原声锁只决定使用哪份音频；明确保存的中文字幕覆盖仍须展示。
  const text = ttsSubtitleDisplay({ subtitle, original });
  if (!text) return null;
  return (
    <div className="mt-1 flex gap-1">
      <span className={`w-4 shrink-0 font-medium ${locked ? "text-emerald-400" : "text-sky-400"}`}>
        {locked ? "锁" : "改"}
      </span>
      <div className="whitespace-pre-wrap text-xs text-amber-300">{text}</div>
    </div>
  );
}

export function LiveTtsCount({ stem, initial }: { stem: string; initial: number }) {
  const live = useTtsSnapshot(stem);
  const n = live ? live.count : initial;
  if (n <= 0) return null;
  return <div className="mt-1 text-[10px] text-zinc-600">{n} 条</div>;
}

function toneBg(flag: string, healthy: boolean) {
  // Green = explicitly approved by locking OR ignoring timing.
  // Red/amber = unresolved issue. Unmodified normal/ordinary dialogue stays neutral.
  if (healthy) return "bg-emerald-950/35";
  if (flag === "err") return "bg-red-950/40";
  if (flag === "warn") return "bg-amber-950/30";
  return "";
}

function lineSurface(live: TtsSnapshot | undefined, flag: string) {
  // Locking or ignoring timing is an explicit override, so the row stays green
  // even when the measured timing still differs from Japanese.
  const locked = isLockedFlag(live?.isUsed);
  const healthy = locked || live?.skipTiming === true;
  const tone = healthy ? "ok" : live?.flag ?? flag;
  return toneBg(tone, healthy);
}

export function ToneBox({
  stem,
  flag,
  className,
  children,
}: {
  stem: string;
  flag: string;
  className?: string;
  children: ReactNode;
}) {
  const live = useTtsSnapshot(stem);
  return <article className={[className, lineSurface(live, flag)].filter(Boolean).join(" ")}>{children}</article>;
}

export function LiveTr({
  stem,
  flag,
  className,
  ...rest
}: ComponentProps<"tr"> & {
  stem: string;
  flag: string;
  warn?: number;
  err?: number;
}) {
  const live = useTtsSnapshot(stem);
  return <tr className={[className, lineSurface(live, flag)].filter(Boolean).join(" ")} {...rest} />;
}

function statusHref(query: string, status: string, active: string) {
  const params = new URLSearchParams(query);
  params.delete("page");
  if (active === status) params.delete("flag");
  else params.set("flag", status);
  const next = params.toString();
  return next ? `/lines?${next}` : "/lines";
}

function StatusLink({
  href,
  active,
  className,
  children,
}: {
  href: string;
  active: boolean;
  className: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`inline-flex min-h-11 items-center rounded px-2 sm:min-h-0 sm:px-1.5 sm:py-0.5 ${
        active ? "bg-zinc-800 ring-1 ring-zinc-600" : "hover:bg-zinc-900"
      } ${className}`}
    >
      {children}
    </Link>
  );
}

export function FilterStatsBar({
  initial,
  query,
  active,
}: {
  initial: HealthStats;
  query: string;
  active: string;
}) {
  const [stats, setStats] = useState(initial);
  useEffect(() => {
    setStats(initial);
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch(`/api/lines/health-summary?${query}`);
        if (!response.ok) return;
        const data = (await response.json()) as HealthStats;
        if (!cancelled) setStats(data);
      } catch {
        /* keep last */
      }
    };
    void tick();
    const id = window.setInterval(tick, 5000);
    const onVis = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const onChanged = () => {
      void tick();
    };
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("ff7-tts-changed");
      channel.onmessage = onChanged;
    } catch {
      channel = null;
    }
    window.addEventListener("ff7-tts-changed", onChanged);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("ff7-tts-changed", onChanged);
      channel?.close();
    };
  }, [query]);
  return (
    <div className="mb-2 space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusLink href={statusHref(query, "ok", active)} active={active === "ok"} className="text-emerald-300">正常 {stats.ok_n}</StatusLink>
        <StatusLink href={statusHref(query, "warn", active)} active={active === "warn"} className="text-amber-300">警告 {stats.warn_n}</StatusLink>
        <StatusLink href={statusHref(query, "err", active)} active={active === "err"} className="text-red-300">异常 {stats.err_n}</StatusLink>
        <StatusLink href={statusHref(query, "fixed", active)} active={active === "fixed"} className="font-medium text-sky-300">已修复 {stats.fixed_n}</StatusLink>
        {stats.pending_n > 0 ? (
          <StatusLink href={statusHref(query, "pending", active)} active={active === "pending"} className="text-zinc-500">待测 {stats.pending_n}</StatusLink>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-zinc-600">已修复 =</span>
        <span className="text-zinc-300" title="保留原作者中文配音，人工确认并忽略对时">确认 {stats.confirmed_n}</span>
        <span className="text-zinc-600">+</span>
        <span className="text-zinc-300" title="使用新生成的 TTS 配音">音频修改 {stats.audio_modified_n}</span>
        <span className="text-zinc-600">+</span>
        <span className="text-zinc-300" title="字幕与原文不同；同时修改配音的台词也计在这里">字幕修改 {stats.subtitle_modified_n}</span>
        <span className="text-zinc-600">+</span>
        <span className="text-zinc-300" title="手动编辑原中文配音或生成音频">音频编辑 {stats.audio_edited_n}</span>
        <span className="text-zinc-600">+</span>
        <span className="text-zinc-300" title="锁定使用日文原声">日文原声 {stats.jp_original_n}</span>
        {stats.other_fixed_n > 0 ? <span className="text-zinc-600">+</span> : null}
        {stats.other_fixed_n > 0 ? <span className="text-zinc-300">其他修复 {stats.other_fixed_n}</span> : null}
      </div>
    </div>
  );
}
