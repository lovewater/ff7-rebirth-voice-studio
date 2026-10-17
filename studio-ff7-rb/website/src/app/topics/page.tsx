import Link from "next/link";

export default function TopicsPage() {
  return (
    <main className="mx-auto max-w-3xl px-3 py-6 sm:px-6">
      <h1 className="text-xl font-semibold tracking-tight">专题</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-400">按一场戏集中改词、对拍数、生成并对照日文波形。</p>
      <Link href="/topics/junon-rufus" className="mt-4 block rounded-xl border border-zinc-800 px-4 py-4 hover:border-zinc-600">
        <div className="font-medium">珠诺 · 路法斯就职演讲</div>
        <p className="mt-1 text-sm leading-6 text-zinc-400">
          从 C2210 海德格宣布总裁奖，到尤菲刺杀、主角团被路法斯赶走。台词按「比」1.03–1.18 来写，1.00 是标准长度。
        </p>
      </Link>
    </main>
  );
}
