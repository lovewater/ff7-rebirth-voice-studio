import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

type Clip = {
  id: string;
  title: string;
  file: string;
  note: string;
};

type Manifest = {
  text: string;
  stem: string;
  speaker: string;
  embedding: string;
  created_at: string;
  clips: Clip[];
  refs: { id: string; title: string; jp: string; en: string; cn?: string }[];
  error?: string;
};

const PACK = "art-8";

function loadManifest(): Manifest | null {
  const file = path.join(process.cwd(), "data", "tts-tests", PACK, "manifest.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

export default function ArtSeedVcTestPage() {
  const data = loadManifest();
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-lg font-semibold text-zinc-100">
        爱丽丝 Seed-VC 对照 · {data?.clips.length ?? 8} 句
      </h1>
      <p className="mt-2 text-sm text-zinc-400">
        台词 {data?.stem ?? "C1910_MAIN_8000_0310_00_art"} · embedding {data?.embedding ?? "art-v17"}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-zinc-200">
        {data?.text ?? "我和妈妈看到过那样的新闻"}
      </p>
      {!data ? (
        <p className="mt-6 text-amber-300">还在生成，过一会儿刷新。</p>
      ) : data.error ? (
        <p className="mt-6 text-red-400">{data.error}</p>
      ) : (
        <>
          <section className="mt-6">
            <h2 className="text-sm font-medium text-zinc-300">Seed-VC 参考原音（这三句的日/中）</h2>
            <div className="mt-2 space-y-3">
              {data.refs.map((row) => (
                <div key={row.id} className="rounded border border-zinc-800 p-3">
                  <div className="text-sm text-zinc-200">{row.title}</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="block text-xs text-zinc-400">
                      日
                      <audio className="mt-1 h-9 w-full" controls preload="none" src={`/api/tts-tests/${PACK}/${row.jp}`} />
                    </label>
                    {row.cn ? (
                      <label className="block text-xs text-zinc-400">
                        中
                        <audio className="mt-1 h-9 w-full" controls preload="none" src={`/api/tts-tests/${PACK}/${row.cn}`} />
                      </label>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="mt-8">
            <h2 className="text-sm font-medium text-zinc-300">{data.clips.length} 句结果</h2>
            <ol className="mt-2 space-y-4">
              {data.clips.map((clip, index) => (
                <li key={clip.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                  <div className="text-sm text-zinc-100">
                    {index + 1}. {clip.title}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{clip.note}</p>
                  <audio
                    className="mt-2 h-9 w-full"
                    controls
                    preload="none"
                    src={`/api/tts-tests/${PACK}/${clip.file}`}
                  />
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </main>
  );
}
