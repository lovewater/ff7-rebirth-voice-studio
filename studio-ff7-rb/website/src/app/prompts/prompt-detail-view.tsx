"use client";

import Link from "next/link";
import type { PromptDetailData } from "@/lib/prompt-detail";
import { renderPrompt } from "@/lib/prompt-template";

export function PromptDetailView({ data: { row, related }, onSelect }: { data: PromptDetailData; onSelect?: (id: string) => void }) {
  const groups = new Map<string,Array<(typeof related)[number]>>();
  for (const item of related) {
    if (!groups.has(item.group_key)) groups.set(item.group_key,[]);
    groups.get(item.group_key)!.push(item);
  }
  const example = renderPrompt(row.prompt, Object.fromEntries(row.placeholders.map(p=>[p.name,p.example])));
  const date = (d: string) => new Date(d).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  return <div className="space-y-6">
    <Link href={`/prompts?category=${encodeURIComponent(row.category)}`} className="inline-block py-2 text-sm text-sky-300">← {row.category}</Link>
    <div><h1 id="prompt-detail-title" className="text-2xl font-semibold">{row.name}</h1><p className="mt-2 break-all font-mono text-sm text-zinc-400">{row.key} · #{row.id} · {row.role}</p><Link href={`/prompts?category=${encodeURIComponent(row.category)}`} className="mt-2 inline-block rounded border border-zinc-700 px-2 py-1 text-xs text-sky-300">{row.category}</Link><p className={`mt-2 text-sm ${row.current ? "text-emerald-300" : "text-zinc-500"}`}>{row.current ? "启用 · 当前生效" : row.enable ? "启用 · 历史版本" : "停用"} · 只读</p><p className="mt-2 text-xs text-zinc-500">创建 {date(row.created_at)} · 更新 {date(row.updated_at)}</p></div>
    {groups.size ? <section className="space-y-3"><h2 className="text-lg font-medium">同组提示词</h2>{[...groups].map(([key,items])=><div key={key} className="rounded-lg border border-zinc-800 p-4"><h3 className="text-sm font-medium text-zinc-200">{items[0].group_name}</h3><p className="mt-1 text-xs leading-6 text-zinc-500">{items[0].group_desc}</p><ul className="mt-2 space-y-2">{items.map(item=><li key={item.key} className="text-sm"><Link href={`/prompts/${item.id}`} onClick={event => { if (onSelect && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onSelect(item.id); } }} className={item.id===row.id ? "text-emerald-300" : "text-sky-300 hover:underline"}>{item.name}</Link><span className="ml-2 text-xs text-zinc-500">{item.key} · {item.role}{item.id===row.id ? " · 当前查看" : ""}{!item.enable ? " · 停用" : ""}</span></li>)}</ul></div>)}</section> : null}
    <section><h2 className="mb-3 text-lg font-medium">用途与调用条件</h2><p className="whitespace-pre-wrap text-sm leading-7 text-zinc-300">{row.desc}</p></section>
    <section><h2 className="mb-3 text-lg font-medium">提示词模板</h2><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm leading-7 text-zinc-200">{row.prompt}</pre></section>
    <section><h2 className="mb-3 text-lg font-medium">占位符与替换示例</h2>{row.placeholders.length ? <div className="overflow-x-auto rounded-lg border border-zinc-800"><table className="w-full text-left text-sm"><thead className="bg-zinc-900 text-zinc-400"><tr><th className="p-3">占位符</th><th className="p-3">替换为什么</th><th className="p-3">示例值</th></tr></thead><tbody className="divide-y divide-zinc-800">{row.placeholders.map(p=><tr key={p.name}><td className="p-3 align-top font-mono text-xs text-sky-300">{`{{${p.name}}}`}</td><td className="min-w-48 p-3 align-top text-zinc-300">{p.description}</td><td className="min-w-56 max-w-lg whitespace-pre-wrap break-words p-3 align-top font-mono text-xs text-zinc-400">{typeof p.example === "string" ? p.example : JSON.stringify(p.example,null,2)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-zinc-500">此模板没有动态占位符，启用后按原文发送。</p>}</section>
    {row.placeholders.length ? <details className="rounded-lg border border-zinc-800 p-4"><summary className="cursor-pointer text-sm text-sky-300">查看替换后的示意文本</summary><p className="mt-3 text-xs text-zinc-500">仅用上表的示例值预览，不调用模型；实际值取自对应句子和运行记录。</p><pre className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-zinc-300">{example}</pre></details> : null}
  </div>;
}
