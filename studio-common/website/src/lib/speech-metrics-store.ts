import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sql } from "./db";
import { BEAT_VERSION } from "./beats";
import type { SpeechComparison, SpeechMeasurement } from "./speech-metrics";

export const NET_METRICS_VERSION = `speech-peak15-gap200-v1:${BEAT_VERSION}`;
export type SpeechRequest = { stem: string; id?: string };
type Source = { key: string; label: string; language: "jp" | "cn"; text: string; path: string };

export function comparisonKey(stem: string, id?: string) { return JSON.stringify([stem, id]); }
export function speechCacheKey(audioPath: string, language: string, text: string) {
  return createHash("sha256").update(`${audioPath}\0${language}\0${text}`).digest("hex");
}
async function fingerprint(relative: string) {
  const root = path.resolve(process.cwd(), "data");
  const target = path.resolve(root, relative);
  if (!/^(jp|cn|tts)\//.test(relative) || !target.startsWith(root + path.sep) || !/\.(wav|mp3)$/i.test(target)) {
    throw new Error("Invalid speech audio path");
  }
  try {
    const resolved = await realpath(target);
    if (!resolved.startsWith(root + path.sep)) throw new Error("Invalid speech audio symlink");
    const info = await stat(resolved, { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** Read saved metrics and enqueue changed/missing inputs. Never decode audio. */
export async function getSpeechComparisons(requests: SpeechRequest[], computeNow = false): Promise<Record<string, SpeechComparison>> {
  if (!requests.length) return {};
  const stems = [...new Set(requests.map((r) => r.stem))];
  const ids = [...new Set(requests.flatMap((r) => r.id ? [r.id] : []))];
  const [lines, versions] = await Promise.all([
    sql<{ stem: string; text_jp: string | null; text_zh: string | null }[]>`
      SELECT stem,text_jp,text_zh FROM lines WHERE stem=ANY(${stems})`,
    sql<{ id: string; stem: string; audio_path: string | null; raw_audio_path: string | null; tts_text: string | null; jp_lock: boolean }[]>`
      SELECT id::text,stem,audio_path,raw_audio_path,tts_text,
        (voice_gpu_key='jp-lock' OR conversion_meta->>'pipeline'='jp-lock') AS jp_lock
      FROM line_tts_versions WHERE id=ANY(${ids}::bigint[]) AND stem=ANY(${stems}) AND status='ready'`,
  ]);
  const byStem = new Map(lines.map((r) => [r.stem, r]));
  const byId = new Map(versions.map((r) => [r.id, r]));
  const groups = new Map<string, Source[]>();
  for (const { stem, id } of requests) {
    const line = byStem.get(stem);
    const record = id ? byId.get(id) : undefined;
    if (!line || (id && (!record || record.stem !== stem))) continue;
    const sources: Source[] = [
      { key: "jp", label: "日文原声", language: "jp", text: line.text_jp ?? "", path: `jp/${stem}.mp3` },
      { key: "cn", label: "源中文", language: "cn", text: line.text_zh ?? "", path: `cn/${stem}.mp3` },
    ];
    if (record) {
      const language = record.jp_lock ? "jp" as const : "cn" as const;
      const text = record.jp_lock ? line.text_jp ?? "" : record.tts_text || line.text_zh || "";
      if (record.audio_path) sources.push({ key: "tts", label: `版本 #${id}${record.jp_lock ? "（日文）" : ""}`, language, text, path: record.audio_path });
      if (record.raw_audio_path) sources.push({ key: "raw", label: `版本 #${id} 原始音频`, language, text, path: record.raw_audio_path });
    }
    groups.set(comparisonKey(stem, id), sources);
  }
  const inputs = new Map<string, Source>();
  for (const sources of groups.values()) for (const source of sources) {
    inputs.set(speechCacheKey(source.path, source.language, source.text), source);
  }
  if (!inputs.size) return {};
  const records = await Promise.all([...inputs].map(async ([key, source]) => ({
    cache_key: key, audio_path: source.path, language: source.language, source_text: source.text,
    file_version: await fingerprint(source.path), algorithm_version: NET_METRICS_VERSION, priority: 100,
  })));
  await sql`INSERT INTO speech_metrics ${sql(records, "cache_key", "audio_path", "language", "source_text", "file_version", "algorithm_version", "priority")}
    ON CONFLICT(cache_key) DO UPDATE SET file_version=excluded.file_version,algorithm_version=excluded.algorithm_version,
      status='pending',last_error=NULL,attempts=0,queued_at=now(),next_attempt_at=now(),priority=100
    WHERE speech_metrics.file_version IS DISTINCT FROM excluded.file_version
       OR speech_metrics.algorithm_version IS DISTINCT FROM excluded.algorithm_version`;
  const keys = [...inputs.keys()];
  await sql`UPDATE speech_metrics SET priority=100 WHERE cache_key=ANY(${keys}) AND status='pending' AND priority<100`;
  if (computeNow) {
    // Only explicit audio saves take this path; page reads remain database-only.
    const ready = await sql<{ cache_key: string }[]>`
      SELECT cache_key FROM speech_metrics WHERE cache_key=ANY(${keys}) AND status='ready'`;
    const done = new Set(ready.map((r) => r.cache_key));
    const missing = records.filter((r) => !done.has(r.cache_key));
    for (let offset = 0; offset < missing.length; offset += 4) {
      const batch = missing.slice(offset, offset + 4);
      try {
        const response = await fetch(`${process.env.MORA_URL ?? "http://127.0.0.1:8000"}/speech`, {
          method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ items: batch.map((r) => ({ path: r.audio_path, language: r.language, text: r.source_text })) }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`speech worker ${response.status}`);
        const data = await response.json() as { results?: SpeechMeasurement[] };
        if (data.results?.length !== batch.length) throw new Error("invalid speech worker response");
        for (const [index, record] of batch.entries()) {
          const result = data.results[index];
          if (!["ok", "silent"].includes(result.status) || result.version !== "speech-peak15-gap200-v1"
              || !Number.isFinite(result.activeS) || !Number.isFinite(result.durationS)
              || !Number.isFinite(result.silenceS)) continue;
          if (await fingerprint(record.audio_path) !== record.file_version) continue;
          await sql`UPDATE speech_metrics SET status='ready',result=${sql.json(result)},
            duration_s=${result.durationS!},silence_s=${result.silenceS!},net_speech_s=${result.activeS!},
            unit_count=${result.units ?? null},units_per_s=${result.rate ?? null},
            measured_at=now(),last_error=NULL,attempts=attempts+1
            WHERE cache_key=${record.cache_key} AND file_version=${record.file_version}
              AND algorithm_version=${NET_METRICS_VERSION}`;
        }
      } catch (error) {
        // Audio has already been saved. Keep its queued job for recovery;
        // do not turn a transient measurement failure into a failed audio save.
        console.error("Immediate saved-audio measurement deferred", error);
      }
    }
  }
  const stored = await sql<{ cache_key: string; status: string; result: SpeechMeasurement | null; last_error: string | null }[]>`
    SELECT cache_key,status,result,last_error FROM speech_metrics WHERE cache_key=ANY(${keys})`;
  const saved = new Map(stored.map((r) => [r.cache_key, r]));
  return Object.fromEntries([...groups].map(([key, sources]) => [key, { items: sources.map((source) => {
    const row = saved.get(speechCacheKey(source.path, source.language, source.text));
    const measurement: SpeechMeasurement = row?.status === "ready" && row.result ? row.result
      : row?.status === "error" ? { ...row.result, status: "error", error: row.last_error || "音频分析失败" }
      : { ...row?.result, status: row?.result?.status ?? "pending", pending: true };
    return { key: source.key, label: source.label, language: source.language, measurement };
  }) }]));
}

/** Called after the new WAV and ready record have been committed. */
export async function measureSavedEdit(stem: string, id: string) {
  try {
    const comparison = (await getSpeechComparisons([{ stem, id: String(id) }], true))[comparisonKey(stem, String(id))];
    const required = comparison?.items.filter((i) => i.key === "jp" || i.key === "tts");
    const ready = required?.length === 2 && required.every((i) => !i.measurement.pending && ["ok", "silent"].includes(i.measurement.status));
    return { netStatus: ready ? "ready" as const : "pending" as const };
  } catch (error) {
    console.error("Saved audio measurement will be recovered by background scan", error);
    return { netStatus: "pending" as const };
  }
}
