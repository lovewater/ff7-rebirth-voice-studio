import { readPauseExperiment } from "@/lib/pause-experiment";
import { PauseReview } from "./review";

export const dynamic = "force-dynamic";
export const metadata = { title: "两节表演 · 40条试听 | FF7配音修订台" };

export default async function Page() {
  const snapshot = await readPauseExperiment();
  if (!snapshot) return <main className="mx-auto max-w-6xl px-4 py-8"><h1 className="text-xl font-semibold">两节表演 · 40条试听</h1><p className="mt-3 text-zinc-400">实验音频与波形正在整理，请稍后刷新。</p></main>;
  return <PauseReview initial={snapshot} />;
}
