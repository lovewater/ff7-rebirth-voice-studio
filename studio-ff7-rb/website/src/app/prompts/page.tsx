import Link from "next/link";
import { PromptModalProvider, PromptDetailLink } from "./prompt-modal";
import { sql } from "@/lib/db";
export const dynamic = "force-dynamic";
const date = (value: Date) => value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
type ListRow = {
  id: string; key: string; category: string; name: string; enable: boolean; created_at: Date; updated_at: Date;
  current: boolean; group_key: string | null; group_name: string | null; memberships: number;
};
export default async function PromptsPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const requested = (await searchParams).category;
  const category = typeof requested === "string" ? requested.slice(0,128) : "";
  const [categories, rows] = await Promise.all([
    sql<{ category: string; count: number }[]>`SELECT category,count(*)::int AS count FROM prompt_templates GROUP BY category ORDER BY category`,
    sql<ListRow[]>`
      SELECT p.id::text AS id,p.key,p.category,p.name,p.enable,p.created_at,p.updated_at,
        p.id = (SELECT v.id FROM prompt_templates v WHERE v.key=p.key AND v.enable=true ORDER BY v.updated_at DESC,v.id DESC LIMIT 1) AS current,
        g.key AS group_key,g.name AS group_name,
        (SELECT count(*)::int FROM prompt_group_members links WHERE links.prompt_key=p.key) AS memberships
      FROM prompt_templates p LEFT JOIN prompt_group_members m ON m.prompt_key=p.key LEFT JOIN prompt_groups g ON g.key=m.group_key
      WHERE (${category}='' OR p.category=${category})
      ORDER BY g.key ASC NULLS LAST,p.key ASC,p.enable DESC,p.updated_at DESC,p.id DESC
    `,
  ]);
  const groups = new Map<string,{name:string;rows:ListRow[]}>();
  for (const row of rows) {
    const key = row.group_key || "ungrouped";
    if (!groups.has(key)) groups.set(key,{name:row.group_name || "未分组",rows:[]});
    groups.get(key)!.rows.push(row);
  }
  const count = new Set(rows.map(r=>r.id)).size;
  return <PromptModalProvider><main className="mx-auto max-w-6xl space-y-5 p-3 sm:p-6">
    <div><h1 className="text-2xl font-semibold">提示词库</h1><p className="mt-2 text-sm text-zinc-400">按用途关联系统指令、输入模板和后续反馈。每个 key 只使用最新启用版本；本页暂不提供修改。</p></div>
    <nav aria-label="提示词分类" className="flex flex-wrap gap-2">
      {[{category:"",count:categories.reduce((n,g)=>n+g.count,0)},...categories].map(group=><Link key={group.category} href={group.category ? `/prompts?category=${encodeURIComponent(group.category)}` : "/prompts"} aria-current={category===group.category ? "page" : undefined} className={`rounded border px-3 py-2 text-sm ${category===group.category ? "border-sky-700 bg-sky-950 text-sky-200" : "border-zinc-800 text-zinc-400 hover:text-white"}`}>{group.category||"全部"} <span className="text-xs opacity-60">{group.count}</span></Link>)}
    </nav>
    <p className="text-sm text-zinc-500">{count} 个版本 · {groups.size} 组 · 共用模板会在关联组中重复列出；组内按 key、启用优先、更新时间倒序排列</p>
    {[...groups].map(([key,group])=><section key={key} aria-label={group.name} className="space-y-3">
      <h2 className="text-base font-medium text-zinc-200">{group.name}<span className="ml-2 text-xs font-normal text-zinc-500">{group.rows.length} 条关联</span></h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800"><table className="w-full text-left text-sm">
        <thead className="bg-zinc-900 text-zinc-400"><tr>{["Key","名称","分类","状态","更新时间","创建时间"].map(t=><th key={t} className="whitespace-nowrap px-4 py-3 font-medium">{t}</th>)}</tr></thead>
        <tbody className="divide-y divide-zinc-800">{group.rows.map(row=><tr key={row.id} className="hover:bg-zinc-900/60">
          <td className="px-4 py-3 font-mono text-xs"><PromptDetailLink className="text-sky-300 hover:underline" id={row.id}>{row.key}</PromptDetailLink><span className="ml-2 text-zinc-600">#{row.id}</span></td>
          <td className="px-4 py-3"><PromptDetailLink id={row.id} className="hover:text-sky-300">{row.name}</PromptDetailLink>{row.memberships>1 ? <span className="ml-2 whitespace-nowrap text-xs text-zinc-500" title={`用于${row.memberships}个组`}>共用</span> : null}</td>
          <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-400">{row.category}</td>
          <td className={`whitespace-nowrap px-4 py-3 ${row.current ? "text-emerald-300" : "text-zinc-500"}`}>{row.current ? "启用 · 当前生效" : row.enable ? "启用 · 历史版本" : "停用"}</td>
          <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-400">{date(row.updated_at)}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-500">{date(row.created_at)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
    {!rows.length ? <p className="py-8 text-center text-sm text-zinc-500">该分类暂无提示词</p> : null}
  </main></PromptModalProvider>;
}
