import {readThreePartExperiment} from "@/lib/pause-experiment";
import {PauseReview} from "../pause-alignment/review";
export const dynamic="force-dynamic";
export const metadata={title:"三段表演 · 40条试听 | FF7配音修订台"};
export default async function Page(){const snapshot=await readThreePartExperiment();return snapshot?<PauseReview initial={snapshot} mode={3}/>:<main className="mx-auto max-w-6xl px-4 py-8"><h1 className="text-xl font-semibold">三段表演 · 40条试听</h1><p className="mt-3 text-zinc-400">正在准备40条样本的音频和波形，请稍后刷新。</p></main>;}
