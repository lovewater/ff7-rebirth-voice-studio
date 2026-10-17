import { randomUUID } from "node:crypto";
import type { WordHit } from "./auto-run-rules";

export type SeedUtterance = {
  text: string;
  start: number;
  end: number;
  words: WordHit[];
};

export type SeedAsrLang = "ja-JP" | "zh-CN";

export type SeedAsrResult = {
  text: string;
  language: SeedAsrLang;
  durationMs: number | null;
  status: string;
  message: string;
  utterances: SeedUtterance[];
  words: WordHit[];
  raw: unknown;
};

export type SeedAsrStored = SeedAsrResult & {
  sha256: string;
  path: string;
  at: string;
};

export function seedLangForPath(relative: string, explicitLanguage?: SeedAsrLang): SeedAsrLang {
  // 处理后的日文参考保存在 tts/ 下；显式音频语言优先于目录惯例。
  return explicitLanguage ?? (relative.startsWith("jp/") ? "ja-JP" : "zh-CN");
}

export function seedCacheMatches(stored: SeedAsrStored | null, digest: string, language: SeedAsrLang) {
  if (!stored || stored.sha256 !== digest) return false;
  if (stored.language === language) return true;
  return language === "zh-CN" && !stored.language;
}

function asNumber(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseWords(raw: unknown): WordHit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (Array.isArray(item) && item.length >= 3) {
      return [{ text: String(item[0] ?? ""), start: asNumber(item[1]), end: asNumber(item[2]) }];
    }
    if (item && typeof item === "object") {
      const row = item as { text?: unknown; start_time?: unknown; end_time?: unknown; start?: unknown; end?: unknown };
      return [{
        text: String(row.text ?? ""),
        start: asNumber(row.start_time ?? row.start),
        end: asNumber(row.end_time ?? row.end),
      }];
    }
    return [];
  });
}

function parseUtterances(raw: unknown): SeedUtterance[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = (item ?? {}) as {
      text?: unknown;
      start_time?: unknown;
      end_time?: unknown;
      start?: unknown;
      end?: unknown;
      words?: unknown;
    };
    const words = parseWords(row.words);
    const start = asNumber(row.start_time ?? row.start);
    const end = asNumber(row.end_time ?? row.end);
    return { text: String(row.text ?? ""), start, end, words };
  });
}

export function packSeedAsr(result: SeedAsrResult, sha256: string, audioPath: string): SeedAsrStored {
  return {
    sha256,
    path: audioPath,
    at: new Date().toISOString(),
    language: result.language,
    text: result.text,
    durationMs: result.durationMs,
    status: result.status,
    message: result.message,
    utterances: result.utterances,
    words: result.words,
    raw: result.raw,
  };
}

export function unpackSeedAsr(value: unknown): SeedAsrStored | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.sha256 !== "string" || row.sha256.length < 16) return null;
  if (typeof row.text !== "string") return null;
  const utterances = parseUtterances(row.utterances);
  const words = parseWords(row.words);
  return {
    sha256: row.sha256,
    path: typeof row.path === "string" ? row.path : "",
    at: typeof row.at === "string" ? row.at : "",
    language: row.language === "ja-JP" ? "ja-JP" : row.language === "zh-CN" ? "zh-CN" : "zh-CN",
    text: row.text,
    durationMs: row.durationMs == null ? null : asNumber(row.durationMs),
    status: String(row.status ?? ""),
    message: String(row.message ?? ""),
    utterances,
    words: words.length ? words : utterances.flatMap((item) => item.words),
    raw: row.raw ?? { text: row.text, utterances },
  };
}

export async function seedAsr(
  audioB64: string,
  format: "mp3" | "wav",
  language: SeedAsrLang,
): Promise<SeedAsrResult> {
  const key = process.env.SEEDASR_API_KEY ?? "";
  if (!key) throw new Error("未配置 SEEDASR_API_KEY");
  const url = process.env.SEEDASR_URL
    ?? "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
  const requestId = randomUUID();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Api-Resource-Id": process.env.SEEDASR_RESOURCE_ID ?? "volc.seedasr.auc",
      "X-Api-Key": key,
      "X-Api-Request-Id": requestId,
      "X-Api-Sequence": "-1",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      user: { uid: "ff7rb" },
      audio: { data: audioB64, format, language },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        enable_ddc: false,
        show_utterances: true,
      },
    }),
  });
  const status = response.headers.get("X-Api-Status-Code") ?? String(response.status);
  const message = response.headers.get("X-Api-Message") ?? "";
  if (!response.ok) throw new Error(`Seed-ASR HTTP ${response.status} ${message}`.trim());
  const payload = await response.json() as {
    audio_info?: { duration?: unknown };
    result?: {
      text?: unknown;
      utterances?: unknown;
      additions?: { duration?: unknown };
    };
  };
  const utterances = parseUtterances(payload.result?.utterances);
  const words = utterances.flatMap((row) => row.words);
  const text = String(payload.result?.text ?? utterances.map((row) => row.text).join("")).trim();
  const durationMs = asNumber(payload.audio_info?.duration ?? payload.result?.additions?.duration) || null;
  return {
    text,
    language,
    durationMs,
    status,
    message: message || (status === "20000003" ? "静音/无有效语音" : ""),
    utterances,
    words,
    raw: {
      status,
      message,
      text,
      language,
      utterances: utterances.map((row) => ({
        text: row.text,
        start: row.start,
        end: row.end,
        words: row.words,
      })),
    },
  };
}
