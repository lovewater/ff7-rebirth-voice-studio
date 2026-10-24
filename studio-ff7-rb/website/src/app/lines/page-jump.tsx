"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function PageJump({
  page,
  pages,
  hrefTemplate,
  pageFlags = {},
}: {
  page: number;
  pages: number;
  hrefTemplate: string;
  pageFlags?: Record<number, "ok" | "warn" | "err">;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  function hrefFor(p: number) {
    return hrefTemplate.replace("__PAGE__", String(p));
  }

  function go(p: number) {
    const n = Math.min(pages, Math.max(1, p));
    setOpen(false);
    if (n !== page) router.push(hrefFor(n));
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const nums = Array.from({ length: pages }, (_, i) => i + 1);

  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-11 items-center rounded border border-zinc-700 px-3 text-zinc-300 hover:bg-zinc-800"
      >
        选页
      </button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onMouseDown={() => setOpen(false)}
          />
          <div className="fixed bottom-6 left-1/2 z-50 max-h-[min(70vh,28rem)] w-[min(92vw,42rem)] -translate-x-1/2 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-3 shadow-xl">
            <form
              className="mb-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                go(Number(new FormData(event.currentTarget).get("p")));
              }}
            >
              <input
                name="p"
                type="number"
                inputMode="numeric"
                min={1}
                max={pages}
                defaultValue={page}
                aria-label="页码"
                className="w-28 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100"
              />
              <button type="submit" className="min-h-11 rounded bg-zinc-800 px-4 text-sm text-zinc-100">
                跳转
              </button>
            </form>
            <div className="flex flex-wrap gap-1">
              {nums.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => go(n)}
                  aria-label={`第${n}页${pageFlags[n] === "err" ? "，包含异常" : pageFlags[n] === "warn" ? "，包含警告" : ""}`}
                  aria-current={n === page ? "page" : undefined}
                  title={pageFlags[n] === "err" ? "包含异常" : pageFlags[n] === "warn" ? "包含警告" : undefined}
                  className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded px-1.5 text-sm md:min-h-8 md:min-w-8 md:text-xs ${
                    pageFlags[n] === "err"
                      ? "text-red-300 [&:hover]:bg-red-300 [&:hover]:text-zinc-950 focus-visible:bg-red-300 focus-visible:text-zinc-950"
                      : pageFlags[n] === "warn"
                        ? "text-amber-300 [&:hover]:bg-amber-300 [&:hover]:text-zinc-950 focus-visible:bg-amber-300 focus-visible:text-zinc-950"
                        : n === page
                          ? "bg-zinc-100 text-zinc-900 [&:hover]:bg-zinc-800 [&:hover]:text-zinc-100"
                          : "text-zinc-400 [&:hover]:bg-zinc-300 [&:hover]:text-zinc-950 focus-visible:bg-zinc-300 focus-visible:text-zinc-950"
                  } ${n === page ? "font-medium ring-1 ring-inset ring-current" : ""}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}
