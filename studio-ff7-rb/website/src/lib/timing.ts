export type Timing = {
  start: number | null;
  end: number | null;
  dur: number | null;
  speech: number | null;
};

export type Mark = "ok" | "warn" | "err";

export const START_OK_S = 0.1;
export const START_ERR_S = 0.15;
export const END_OK_S = 0.2;
export const END_ERR_S = 0.4;
export const DUR_OK_S = 0.2;
export const DUR_ERR_S = 0.4;

export const HEALTH_LABEL: Record<Mark, string> = { ok: "正常", warn: "警告", err: "异常" };

function absDiff(a: number | null, b: number | null): number | null {
  if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(a - b);
}

function band(diff: number | null, okS: number, errS: number): Mark {
  if (diff == null) return "err";
  if (diff > errS) return "err";
  if (diff > okS) return "warn";
  return "ok";
}

export function timingMarks(
  jp: Timing,
  other: Timing,
  kind: string | undefined,
  _warn?: number,
  _err?: number,
  skipTiming?: boolean,
): { start: Mark; end: Mark; dur: Mark; speech: Mark } {
  const none: { start: Mark; end: Mark; dur: Mark; speech: Mark } = {
    start: "ok",
    end: "ok",
    dur: "ok",
    speech: "ok",
  };
  if (skipTiming || kind === "旁白" || kind === "narrate") return none;

  return {
    start: band(absDiff(jp.start, other.start), START_OK_S, START_ERR_S),
    end: band(absDiff(jp.end, other.end), END_OK_S, END_ERR_S),
    dur: band(absDiff(jp.dur, other.dur), DUR_OK_S, DUR_ERR_S),
    speech: band(absDiff(jp.speech, other.speech), DUR_OK_S, DUR_ERR_S),
  };
}

export function healthFlag(marks: { start: Mark; end: Mark; dur: Mark; speech: Mark }): Mark {
  const parts: Mark[] = [marks.start, marks.end, marks.dur];
  if (parts.includes("err")) return "err";
  if (parts.includes("warn")) return "warn";
  return "ok";
}

function signedMs(deltaS: number): string {
  const n = Math.round(deltaS * 1000);
  return n > 0 ? `+${n}ms` : `${n}ms`;
}

function worstMs(jp: Timing, other: Timing, marks: { start: Mark; end: Mark; dur: Mark; speech: Mark }) {
  const deltas: number[] = [];
  if (marks.start !== "ok" && jp.start != null && other.start != null) deltas.push(other.start - jp.start);
  if (marks.end !== "ok" && jp.end != null && other.end != null) deltas.push(other.end - jp.end);
  if (marks.dur !== "ok" && jp.dur != null && other.dur != null) deltas.push(other.dur - jp.dur);
  if (!deltas.length) return null;
  return deltas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
}

/** 警告/异常显示 other − JP 的毫秒差（起/止/长里绝对值最大的一项）。 */
export function healthCaption(
  jp: Timing,
  other: Timing,
  kind: string | undefined,
  warn?: number,
  err?: number,
  skipTiming?: boolean,
): { flag: Mark; text: string } {
  const marks = timingMarks(jp, other, kind, warn, err, skipTiming);
  const flag = healthFlag(marks);
  const label = HEALTH_LABEL[flag];
  if (flag === "ok") return { flag, text: label };
  const ms = worstMs(jp, other, marks);
  return { flag, text: ms == null ? label : `${label} ${signedMs(ms)}` };
}
