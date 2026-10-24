"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AbnormalQueueSnapshot } from "@/lib/abnormal-queue";
import { abnormalReplacement, shouldLeaveAbnormalPage } from "@/lib/abnormal-queue-policy";
import { AbnormalNavigationContext } from "@/components/abnormal-navigation";
const href = (stem: string) => `/abnormal?stem=${encodeURIComponent(stem)}`;
const refresh = () => window.dispatchEvent(new Event('ff7-abnormal-refresh'));

export function AbnormalQueue({ snapshot, children }: { snapshot: AbnormalQueueSnapshot; children: ReactNode }) {
  const router = useRouter();
  const stem = snapshot.current?.stem ?? null;
  const [poll, setPoll] = useState<{ stem: string | null; snapshot: AbnormalQueueSnapshot; failed: boolean }>();
  const current = poll?.stem === stem ? poll : null;
  const live = current?.snapshot ?? snapshot;
  useEffect(() => {
    let active = true, pending = false, switching = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      if (pending || switching) return;
      pending = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch(`/api/abnormal-queue${stem ? `?current=${encodeURIComponent(stem)}` : ''}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('异常列表刷新失败');
        const result: AbnormalQueueSnapshot = await response.json();
        if (!active) return;
        setPoll({ stem, snapshot: result, failed: false });
        if (shouldLeaveAbnormalPage(stem, result)) {
          // 弹窗结束后再离开当前页，保留桌面正在核对的内容。
          if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) {
            clearTimeout(retry); retry = setTimeout(() => void check(), 500);
          } else {
            switching = true;
            const next = abnormalReplacement(result);
            router.replace(next ? href(next) : '/abnormal');
          }
        }
      } catch {
        if (active) setPoll(previous => ({ stem, snapshot: previous?.stem === stem ? previous.snapshot : snapshot, failed: true }));
      } finally { clearTimeout(timeout); pending = false; }
    }
    const changed = () => { clearTimeout(retry); retry = setTimeout(() => void check(), 0); };
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('ff7-tts-changed');
    channel?.addEventListener('message', changed);
    window.addEventListener('ff7-tts-changed', changed);
    window.addEventListener('ff7-abnormal-refresh', changed);
    const timer = setInterval(() => void check(), 5000);
    void check();
    return () => { active = false; clearInterval(timer); clearTimeout(retry); controller?.abort(); channel?.close();
      window.removeEventListener('ff7-tts-changed', changed); window.removeEventListener('ff7-abnormal-refresh', changed); };
  }, [stem, router, snapshot]);
  const item = live.current ?? snapshot.current;
  const previousHref = live.previous ? href(live.previous.stem) : null;
  const nextHref = live.next ? href(live.next.stem) : null;
  return <AbnormalNavigationContext.Provider value={{ previousHref, nextHref, position: live.position, total: live.total, refresh }}>
    <section data-abnormal-navigation className="mx-auto max-w-[96rem] shrink-0 border-b border-zinc-800 px-3 py-2 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="text-base font-semibold">异常处理</h1>
          <span className="text-xs text-zinc-400">{live.position == null ? '' : `第 ${live.position} 条 · `}共 {live.total} 条</span></div>
        <div className="flex gap-2" aria-label="异常翻页">
          <button type="button" disabled={!previousHref} onClick={() => previousHref && router.replace(previousHref)} className="min-h-11 rounded border border-zinc-700 px-3 text-sm disabled:opacity-30">上一条</button>
          <button type="button" disabled={!nextHref} onClick={() => nextHref && router.replace(nextHref)} className="min-h-11 rounded border border-zinc-700 px-3 text-sm disabled:opacity-30">下一条</button>
        </div>
      </div>
      {item && <Link href={item.listHref} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-sky-300 hover:underline">{item.regionName} · 列表第 {item.page} 页 ↗</Link>}
      {current?.failed && <p role="status" className="mt-1 text-xs text-amber-300">列表刷新暂时失败，稍后重试。</p>}
    </section>
    {snapshot.current ? children : <main className="mx-auto flex min-h-[60vh] max-w-6xl flex-col items-center justify-center px-6 text-center">
      <h2 className="text-lg font-semibold text-zinc-200">暂无人工异常</h2>
      <p className="mt-2 text-sm text-zinc-500">新增异常后会自动显示。</p>
    </main>}
  </AbnormalNavigationContext.Provider>;
}
