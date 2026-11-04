export const PACE_LOW = 0.85;
export const PACE_HIGH = 1.15;
export const PACE_MIN_JP_CHARS = 8;
export const AUTO_RUN_MAX_ROUNDS = 3;
export const SPLICE_GAP_S = 0.2;
export const SCALE_LO = 0.9;
export const SCALE_HI = 1.1;
export const FX_LO = 0.7;
export const FX_HI = 1.3;
export const LENGTH_SLACK_S = 0.2;
export const SILENCE_MIN_RATIO = 0.3;
export const SILENCE_MAX_RATIO = 4;
/** Peak ratio below which auto-align / 起止静音 count as silence. Was 0.10. */
export const ALIGN_SILENCE_RATIO = 0.05;
export const AMBIENT_PEAK = 0.1;
export const AMBIENT_VAD_MS = 200;
export const AMBIENT_MIN_MS = 100;

export function jpBodyChars(text: string | null | undefined) {
  return (text ?? "").replace(/[\s\p{P}\p{S}]/gu, "").length;
}

export function paceEnabled(textJp: string | null | undefined) {
  return jpBodyChars(textJp) > PACE_MIN_JP_CHARS;
}

export type WordHit = { text: string; start: number; end: number };

export function spokenSpanMs(words: WordHit[]) {
  const usable = words.filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  if (!usable.length) return null;
  const start = Math.min(...usable.map((word) => word.start));
  const end = Math.max(...usable.map((word) => word.end));
  return { start, end, span: end - start };
}

export function paceRatio(cnSpanMs: number, jpSpanMs: number) {
  if (!(jpSpanMs > 0) || !(cnSpanMs > 0)) return null;
  return cnSpanMs / jpSpanMs;
}

export function pacePass(ratio: number | null, enabled: boolean) {
  if (!enabled) return { ok: true, ratio };
  if (ratio == null || !Number.isFinite(ratio)) return { ok: false, ratio };
  return { ok: ratio >= PACE_LOW && ratio <= PACE_HIGH, ratio };
}

export function isPerformanceMode(mode: string | null | undefined) {
  return mode === "scene" || mode === "mixed";
}
