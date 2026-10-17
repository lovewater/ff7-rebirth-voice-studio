import postgres from "postgres";

const url =
  process.env.DATABASE_URL ??
  "";

const globalForSql = globalThis as unknown as { sql?: ReturnType<typeof postgres> };

export const sql =
  globalForSql.sql ??
  postgres(url, { max: 8, idle_timeout: 20 });

if (process.env.NODE_ENV !== "production") globalForSql.sql = sql;

export type LineRow = {
  id: number;
  pack: string;
  filename: string;
  stem: string;
  asset_path: string | null;
  region: string | null;
  region_name: string | null;
  speaker: string | null;
  kind: string | null;
  dialogue_mode: "scene" | "field" | "mixed" | "unknown" | null;
  jp_chunk_id: string | null;
  status: string;
  text_jp: string | null;
  text_zh: string | null;
  text_en: string | null;
  subtitle_italic: boolean;
  script: string | null;
  name_zh: string | null;
  actor_zh: string | null;
  jp_start_s: number | null;
  jp_end_s: number | null;
  jp_dur_s: number | null;
  jp_speech_s: number | null;
  cn_start_s: number | null;
  cn_end_s: number | null;
  cn_dur_s: number | null;
  cn_speech_s: number | null;
  en_start_s: number | null;
  en_end_s: number | null;
  en_dur_s: number | null;
  en_speech_s: number | null;
  speech_rel: number | null;
  skip_timing: boolean | null;
  flag: "ok" | "warn" | "err" | "pending";
  has_voice: boolean;
  tts_record_id: string | null;
  tts_record_review_state: "candidate" | "locked" | "abnormal" | null;
  tts_record_subtitle: string | null;
  tts_record_text?: string | null;
  tts_record_start_s: number | null;
  tts_record_end_s: number | null;
  tts_record_dur_s: number | null;
  tts_record_speech_s: number | null;
  tts_record_has_raw: boolean | null;
  tts_record_jp_lock: boolean | null;
  tts_record_is_new: boolean | null;
  tts_record_count: number;
  auto_run_status: "running" | "passed" | "failed" | null;
  auto_run_tts_id: string | null;
  auto_run_error: string | null;
  auto_run_locked: boolean | null;
};

export type RegionRow = {
  region: string;
  region_name: string;
  n: number;
  speakers: number;
  warn_n: number;
  err_n: number;
  fixed_n: number;
};
