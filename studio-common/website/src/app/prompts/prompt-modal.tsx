"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PromptDetailData } from "@/lib/prompt-detail";
import { PromptDetailView } from "./prompt-detail-view";

const OpenPrompt = createContext<(id: string) => void>(() => {});

export function PromptDetailLink({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const open = useContext(OpenPrompt);
  return <a href={`/prompts/${id}`} className={className} aria-haspopup="dialog" onClick={event => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(id);
  }}>{children}</a>;
}

export function PromptModalProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<PromptDetailData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const isOpen = id !== null;
  const select = (nextId: string) => {
    if (nextId === id) return;
    setLoading(true);
    setError("");
    setData(null);
    setId(nextId);
  };

  // 原生 dialog 负责焦点限制、Esc 关闭及关闭后恢复焦点，底层列表保留分类和滚动位置。
  useEffect(() => {
    if (!isOpen) return;
    const element = dialog.current!;
    element.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    content.current?.scrollTo(0, 0);
    // 切换同组模板或关闭时取消旧查询，避免慢请求覆盖新详情。
    void fetch(`/api/prompts/${id}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("读取提示词失败，请稍后重试");
        return response.json() as Promise<PromptDetailData>;
      })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id]);

  return <OpenPrompt.Provider value={select}>
    {children}
    <dialog ref={dialog} aria-label="提示词详情" aria-labelledby={data ? "prompt-detail-title" : undefined}
      onCancel={() => setId(null)}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setId(null);
      }}
      style={{ width: "90vw", height: "90dvh", maxWidth: "none", maxHeight: "none" }}
      className="m-auto overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-2xl backdrop:bg-black/70">
      <div className="flex h-full min-w-0 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-3 sm:px-6">
          <span className="text-sm text-zinc-400">提示词详情 · 只读</span>
          <button type="button" autoFocus onClick={() => setId(null)} className="rounded border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800" aria-label="关闭提示词详情">关闭 · Esc</button>
        </header>
        <div ref={content} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-busy={loading}>
          {loading ? <p role="status" className="text-sm text-zinc-400">正在读取提示词…</p> : null}
          {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
          {data ? <PromptDetailView data={data} onSelect={select} /> : null}
        </div>
      </div>
    </dialog>
  </OpenPrompt.Provider>;
}
