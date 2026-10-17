"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AbnormalQueueItem, AbnormalQueueSnapshot } from "@/lib/abnormal-queue";
import { shouldAdvanceAbnormalQueue } from "@/lib/abnormal-queue-policy";

export function AbnormalQueue({ item, total, children }: { item: AbnormalQueueItem | null; total: number; children: ReactNode }) {
  const router = useRouter();
  const [poll, setPoll] = useState<{ stem: string | null; total: number; state: string | null; failed: boolean }>();
  const stem = item?.stem ?? null;
  const current = poll?.stem === stem ? poll : null;
  useEffect(() => {
    let active = true, pending = false, switching = false;
    let controller: AbortController | null = null;
    async function check() {
      if (pending || switching) return;
      pending = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch(`/api/abnormal-queue${stem ? `?current=${encodeURIComponent(stem)}` : ''}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('队列刷新失败');
        const result: AbnormalQueueSnapshot = await response.json();
        if (!active) return;
        setPoll({ stem, total: result.total, state: result.current?.reviewState ?? null, failed: false });
        // 不刷新详情本身，不覆盖文本框/波形编辑状态；弹窗仍打开时也先等编辑结束。
        if (shouldAdvanceAbnormalQueue(stem, result.first?.stem ?? null, result.current?.reviewState ?? null)
          && !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) {
          switching = true;
          router.replace(result.first ? `/abnormal?stem=${encodeURIComponent(result.first.stem)}` : '/abnormal');
        }
      } catch {
        if (active) setPoll(previous => ({ stem, total: previous?.total ?? total, state: previous?.state ?? null, failed: true }));
      } finally { clearTimeout(timeout); pending = false; }
    }
    const timer = setInterval(() => void check(), 5000);
    return () => { active = false; clearInterval(timer); controller?.abort(); };
  }, [stem, router, total]);
  return <>
    <section className="mx-auto max-w-[96rem] border-b border-zinc-800 px-3 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="text-base font-semibold">异常处理</h1><span className="text-sm text-zinc-400">待处理 {current?.total ?? total} 条</span>
        {item && <Link href={item.listHref} target="_blank" rel="noopener noreferrer" className="text-sm text-sky-300 hover:underline">
          {item.regionName} · 第 {item.page} 页 · 第 {item.position} 条 ↗
        </Link>}
      </div>
      <p role="status" className={`mt-1 text-xs ${current?.failed ? 'text-amber-300' : 'text-zinc-500'}`}>
        {current?.failed ? '队列检查暂时失败，稍后自动重试，当前编辑保留。' : !item ? '每5秒检查手机新增的人工异常。' : current?.state == null && current ? '当前条目尚未锁定，保留编辑；锁定后自动处理下一条。' : '每5秒检查队列；当前条目锁定且不再异常后，自动切换下一条。'}
      </p>
    </section>
    {item ? children : <main className="mx-auto flex min-h-[60vh] max-w-6xl flex-col items-center justify-center px-6 text-center">
      <span aria-hidden="true" className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-950 text-2xl text-emerald-400">✓</span>
      <h2 className="text-lg font-semibold text-zinc-200">暂无需要修订的异常</h2>
      <p className="mt-2 text-sm text-zinc-500">可以休息一下。手机标记新的异常后，这里会自动显示。</p>
    </main>}
  </>;
}
