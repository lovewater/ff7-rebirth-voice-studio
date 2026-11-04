import { sql } from "./db";
import type { AsrWordRule } from "./asr-word-corrections";

/** Per-game DB, no global cache or shared mutable state across concurrent runs. */
export async function loadAsrWordRules(): Promise<AsrWordRule[]> {
  return sql<AsrWordRule[]>`SELECT id,word,aliases,enabled,note FROM asr_word_corrections WHERE enabled=true ORDER BY id`;
}
