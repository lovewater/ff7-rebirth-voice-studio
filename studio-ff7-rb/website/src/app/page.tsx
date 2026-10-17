import { originalCnLockedExpr } from "@/lib/line-filters";
import { readdirSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { sql, type RegionRow } from "@/lib/db";
import { healthFlagExpr } from "@/lib/line-filters";

export const dynamic = "force-dynamic";

export default async function Home() {
  const flagExpr = healthFlagExpr();
  const regions = await sql<RegionRow[]>`
    SELECT l.region,
           COALESCE(r.name_zh, l.region) AS region_name,
           COUNT(*)::int AS n,
           COUNT(DISTINCT l.speaker)::int AS speakers,
           COUNT(*) FILTER (WHERE (${flagExpr}) = 'warn')::int AS warn_n,
           COUNT(*) FILTER (WHERE (${flagExpr}) = 'err')::int AS err_n,
           COUNT(*) FILTER (WHERE ${originalCnLockedExpr()} OR EXISTS (
             SELECT 1 FROM line_tts_versions tv
             WHERE tv.stem = l.stem AND tv.status = 'ready' AND tv.review_state = 'locked'
           ))::int AS fixed_n
    FROM lines l
    LEFT JOIN regions r ON r.code = l.region
    LEFT JOIN line_meta m ON m.stem = l.stem
    GROUP BY l.region, r.name_zh, r.sort_order
    ORDER BY COALESCE(r.sort_order, 99999), l.region
  `;
  const totals = await sql<{ n: number; packs: number; jp: number; zh: number }[]>`
    SELECT COUNT(*)::int AS n,
           COUNT(DISTINCT pack)::int AS packs,
           COUNT(*) FILTER (WHERE text_jp IS NOT NULL AND text_jp <> '')::int AS jp,
           COUNT(*) FILTER (WHERE text_zh IS NOT NULL AND text_zh <> '')::int AS zh
    FROM lines
  `;
  const t = totals[0];
  const dataDir = path.join(process.cwd(), "data");
  const countMp3 = (kind: string) => {
    try {
      return readdirSync(path.join(dataDir, kind)).filter((f) => f.endsWith(".mp3")).length;
    } catch {
      return 0;
    }
  };
  const jpN = countMp3("jp");
  const cnN = countMp3("cn");

  return (
    <main className="mx-auto max-w-6xl p-6">
      <p className="text-sm text-zinc-400">
        中文包条目 {t?.n ?? 0} · 分包 {t?.packs ?? 0} · 日语 MP3 {jpN} · 中文 MP3 {cnN}
        {" "}
        · 日文字幕 {t?.jp ?? 0} · 中文字幕 {t?.zh ?? 0}
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {regions.map((r) => {
          const regionHref = `/lines?region=${encodeURIComponent(r.region)}`;
          const statusHref = (flag: string) => `${regionHref}&flag=${flag}`;
          const done = r.warn_n === 0 && r.err_n === 0 && r.fixed_n > 0;
          const working = (r.warn_n > 0 || r.err_n > 0) && r.fixed_n > 0;
          const border = done ? "border-emerald-500" : working ? "border-amber-400" : "border-zinc-800";
          return (
            <article
              key={r.region}
              className={`rounded-lg border bg-zinc-900 p-4 ${border}`}
            >
              <Link href={regionHref} className="block hover:text-zinc-100">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-lg font-medium">
                    {r.region_name}
                    <span className="ml-2 font-mono text-xs text-zinc-500">{r.region}</span>
                  </div>
                  {done ? <span className="shrink-0 text-sm font-medium text-emerald-400">(已完成)</span> : null}
                  {working ? <span className="shrink-0 text-sm font-medium text-amber-300">(进行中)</span> : null}
                </div>
                <div className="mt-2 text-sm text-zinc-400">
                  {r.n} 条 · {r.speakers} 个声线
                </div>
              </Link>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                <RegionStat n={r.n} label="总计" href={regionHref} className="text-zinc-200" />
                <RegionStat n={r.warn_n} label="警告" href={statusHref("warn")} className="text-amber-300" />
                <RegionStat n={r.err_n} label="异常" href={statusHref("err")} className="text-red-300" />
                <RegionStat n={r.fixed_n} label="已修复" href={statusHref("fixed")} className="font-medium text-sky-300" />
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}

function RegionStat({ n, label, href, className }: { n: number; label: string; href: string; className: string }) {
  if (n === 0) {
    return <span className="inline-flex items-center text-zinc-500">{label} 0</span>;
  }
  return (
    <Link href={href} className={`inline-flex min-h-11 items-center sm:min-h-0 ${className}`}>
      {label} {n}
    </Link>
  );
}
