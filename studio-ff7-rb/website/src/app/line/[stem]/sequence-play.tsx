"use client";

import { reportTtsPlaybackSource } from "@/lib/tts-play-count";

import { useCallback, useEffect, useRef, useState } from "react";

type Item = {
  id: number;
  stem: string;
  speaker: string | null;
  name_zh: string | null;
  text_jp: string | null;
  text_zh: string | null;
  subtitle_italic: boolean;
  current: boolean;
  lockedTtsId: string | null;
  modifiedSubtitle: string | null;
};

type Lang = "jp" | "cn";
type Solo = { stem: string; lang: Lang };

function audioUrl(item: Item, lang: Lang) {
  if (lang === "cn" && item.lockedTtsId) {
    return `/api/lines/${encodeURIComponent(item.stem)}/tts/${item.lockedTtsId}/audio`;
  }
  return `/api/audio/${lang}/${encodeURIComponent(item.stem)}`;
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(), ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function playOne(url: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    audio.preload = "auto";
    const finish = (ok: boolean) => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      signal.removeEventListener("abort", onAbort);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      if (ok) resolve();
    };
    const onEnded = () => finish(true);
    const onError = () => finish(true);
    const onAbort = () => {
      finish(false);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reportTtsPlaybackSource(url);
    void audio.play().catch(() => finish(true));
  });
}

export function SequencePlay({ stem }: { stem: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [lang, setLang] = useState<Lang | null>(null);
  const [index, setIndex] = useState(-1);
  const [solo, setSolo] = useState<Solo | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/sequence`);
    const data = (await response.json()) as { items?: Item[]; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data.items ?? [];
  }, [stem]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void load()
        .then((list) => { if (!disposed) setItems(list); })
        .catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    };
    refresh();
    window.addEventListener("ff7-tts-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("ff7-tts-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  function beginAbort() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    return controller;
  }

  function clearIfCurrent(controller: AbortController) {
    if (abortRef.current === controller) {
      abortRef.current = null;
      setLang(null);
      setIndex(-1);
      setSolo(null);
    }
  }

  async function start(nextLang: Lang) {
    const controller = beginAbort();
    setSolo(null);
    setLang(nextLang);
    setIndex(-1);
    try {
      const list = await load();
      setItems(list);
      for (let i = 0; i < list.length; i += 1) {
        if (controller.signal.aborted) return;
        setIndex(i);
        await playOne(audioUrl(list[i], nextLang), controller.signal);
        if (i < list.length - 1) await wait(1000, controller.signal);
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      clearIfCurrent(controller);
    }
  }

  async function playSolo(item: Item, nextLang: Lang) {
    if (solo?.stem === item.stem && solo.lang === nextLang && lang == null) {
      stop();
      return;
    }
    const controller = beginAbort();
    setLang(null);
    setIndex(-1);
    setSolo({ stem: item.stem, lang: nextLang });
    try {
      let latest = item;
      if (nextLang === "cn") {
        const list = await load();
        if (controller.signal.aborted) return;
        setItems(list);
        latest = list.find((row) => row.stem === item.stem) ?? item;
      }
      await playOne(audioUrl(latest, nextLang), controller.signal);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      clearIfCurrent(controller);
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setLang(null);
    setIndex(-1);
    setSolo(null);
  }

  const playing = lang != null || solo != null;

  return (
    <div data-sequence-play className="rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-zinc-200">连播</span>
        <button
          type="button"
          disabled={lang != null}
          onClick={() => void start("jp")}
          className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
        >
          日文连播
        </button>
        <button
          type="button"
          disabled={lang != null}
          onClick={() => void start("cn")}
          className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
        >
          中文连播
        </button>
        {playing ? (
          <button
            type="button"
            onClick={stop}
            className="inline-flex min-h-11 items-center rounded bg-red-950 px-3 text-sm text-red-200 hover:bg-red-900 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
          >
            停止
          </button>
        ) : null}
        <span className="text-[11px] text-zinc-600">
          同区域、同类型，按列表顺序取前 3 条和后 2 条，边界处补齐，最多 6 条，间隔 1 秒。左侧原中文，右侧改字幕；点序号开详情，点名字后的按钮单播。中文优先播放锁定版，未锁定播放原中文。
        </span>
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      {items.length ? (
        <ol className="mt-3 space-y-1.5 text-xs">
          {items.map((item, i) => {
            const seqActive = lang != null && i === index;
            const jpActive =
              (seqActive && lang === "jp") || (solo?.stem === item.stem && solo.lang === "jp");
            const cnActive =
              (seqActive && lang === "cn") || (solo?.stem === item.stem && solo.lang === "cn");
            return (
              <li
                key={item.stem}
                data-sequence-item={item.stem}
                className={
                  seqActive
                    ? "rounded border border-sky-800 bg-sky-950/30 px-2 py-1.5"
                    : item.current
                      ? "rounded border border-zinc-700 px-2 py-1.5"
                      : "rounded px-2 py-1.5"
                }
              >
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <a
                    href={`/line/${encodeURIComponent(item.stem)}/#tts`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center font-mono text-xs text-zinc-500 hover:text-sky-300 hover:underline md:min-h-0 md:text-[10px]"
                    title="新窗口打开这条台词"
                  >
                    #{item.id}
                  </a>
                  <span className={`${item.current ? "text-zinc-300" : "text-zinc-500"}${item.subtitle_italic ? " italic" : ""}`}>
                    {item.name_zh || item.speaker}
                  </span>
                  {item.current ? <span className="text-[10px] text-sky-400">当前</span> : null}
                  {item.lockedTtsId ? <span className="text-[10px] text-emerald-400">锁</span> : null}
                  {seqActive ? <span className="text-[10px] text-sky-300">播放中</span> : null}
                  <button type="button" aria-pressed={jpActive} onClick={() => void playSolo(item, "jp")}
                    className={`inline-flex min-h-11 items-center rounded px-2.5 text-xs md:min-h-0 md:py-1 ${jpActive ? "bg-sky-900 text-sky-100" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"}`}>
                    读日文
                  </button>
                  <button type="button" aria-pressed={cnActive} onClick={() => void playSolo(item, "cn")}
                    className={`inline-flex min-h-11 items-center rounded px-2.5 text-xs md:min-h-0 md:py-1 ${cnActive ? "bg-sky-900 text-sky-100" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"}`}>
                    读中文
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <TextHalf
                    label="中"
                    text={item.text_zh}
                    empty="（无中文字幕）"
                    active={cnActive}
                    dim={!item.current}
                    italic={item.subtitle_italic}
                  />
                  {item.modifiedSubtitle ? <TextHalf
                    label="改"
                    text={item.modifiedSubtitle}
                    empty=""
                    active={cnActive}
                    dim={!item.current}
                    italic={item.subtitle_italic}
                    modified
                  /> : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

function TextHalf({
  label,
  text,
  empty,
  active,
  dim,
  italic,
  modified,
}: {
  label: string;
  text: string | null;
  empty: string;
  active: boolean;
  dim: boolean;
  italic?: boolean;
  modified?: boolean;
}) {
  return (
    <div
      className={
        active
          ? "min-w-0 rounded border border-sky-800 bg-sky-950/50 px-2 py-1.5 text-left"
          : "min-w-0 rounded border border-transparent px-2 py-1.5 text-left"
      }
    >
      <span className="mb-0.5 flex items-center gap-1.5 text-[10px] text-zinc-600">
        {label}
        {active ? <span className="text-sky-300">播放中</span> : null}
      </span>
      <span
        className={
          text
            ? `block whitespace-pre-wrap break-words leading-5 ${modified ? "text-amber-300" : dim ? "text-zinc-500" : "text-zinc-200"}${italic ? " italic" : ""}`
            : "block leading-5 text-zinc-600"
        }
      >
        {text || empty}
      </span>
    </div>
  );
}
