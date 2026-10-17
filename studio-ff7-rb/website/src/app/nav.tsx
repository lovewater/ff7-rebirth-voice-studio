"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

export function Nav() {
  const pathname = usePathname();
  if (pathname.startsWith("/review/")) return null;
  return (
    <header className="border-b border-zinc-800 bg-zinc-950 px-3 py-2 sm:px-6 sm:py-3">
      <div className="mx-auto flex max-w-6xl flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <Link href="/" className="text-sm font-semibold tracking-tight sm:text-base">
          FF7 Rebirth 中文配音修订台
        </Link>
        <nav className="-mx-1 flex gap-1 overflow-x-auto text-sm text-zinc-400">
          <Link href="/" className="shrink-0 whitespace-nowrap rounded px-2.5 py-2 hover:text-white">
            区域
          </Link>
          <Link href="/lines" className="shrink-0 whitespace-nowrap rounded px-2.5 py-2 hover:text-white">
            逐条
          </Link>
          <Link href="/topics" className="shrink-0 whitespace-nowrap rounded px-2.5 py-2 hover:text-white">
            专题
          </Link>
          <Link href="/voices" className="shrink-0 whitespace-nowrap rounded px-2.5 py-2 hover:text-white">
            人物
          </Link>
          <Link href="/pronunciations" className="shrink-0 whitespace-nowrap rounded px-2.5 py-2 hover:text-white">
            读音
          </Link>
          <Link href="/prompts" className="shrink-0 whitespace-nowrap rounded px-2.5 py-2 hover:text-white">
            提示词库
          </Link>
          <Link href="/abnormal" className="shrink-0 whitespace-nowrap rounded px-2.5 py-2 hover:text-white">异常处理</Link>
        </nav>
      </div>
    </header>
  );
}
