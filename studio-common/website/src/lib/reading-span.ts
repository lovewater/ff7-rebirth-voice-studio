import { alignmentDetectionSignal } from "./alignment-transients";
import type { SpeechSplitRegion } from "./speech-segments";

export const READING_SPAN_METRIC_VERSION = "waveform-cn-reading-span-over-jp-reference-v2";
export type ReadingPart = { index: number; startMs: number; endMs: number; spanMs: number };
export type ReadingMeasurement = { startMs: number; endMs: number; readingSeconds: number; gapSeconds: number; parts: ReadingPart[] };

/** 对时专用：忽略孤立微弱凸起后，首尾按原波形峰值5%定位；经过归组/对齐确认的段内停顿全部计时。
 * regions只接受已确认的正文段，不从标点或字数猜切口；段间留白不计入任何一段。
 */
export function measureReadingSpan(input: { samples: Float32Array; sampleRate: number }, regions?: Pick<SpeechSplitRegion, "startSeconds" | "endSeconds">[]): ReadingMeasurement | null {
  const { sampleRate } = input;
  const { samples, peak } = alignmentDetectionSignal(input.samples, sampleRate);
  if (!(sampleRate > 0) || !samples.length) return null;
  if (peak <= 1e-8) return null;
  const ranges = regions ?? [{ startSeconds: 0, endSeconds: samples.length / sampleRate }];
  if (!ranges.length) return null;
  const parts: ReadingPart[] = [];
  let previousEnd = 0;
  for (const range of ranges) {
    if (!Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds) || range.endSeconds <= range.startSeconds) return null;
    let start = Math.max(0, Math.round(range.startSeconds * sampleRate)), end = Math.min(samples.length, Math.round(range.endSeconds * sampleRate));
    if (start < previousEnd || end <= start) return null;
    previousEnd = end;
    end = Math.min(end, samples.length);
    while (start < end && Math.abs(samples[start]) < peak * .05) start++;
    while (end > start && Math.abs(samples[end - 1]) < peak * .05) end--;
    if (end <= start) return null;
    parts.push({ index: parts.length + 1, startMs: start / sampleRate * 1000, endMs: end / sampleRate * 1000, spanMs: (end - start) / sampleRate * 1000 });
  }
  const startMs = parts[0].startMs, endMs = parts[parts.length - 1].endMs;
  const readingSeconds = parts.reduce((sum, part) => sum + part.spanMs, 0) / 1000;
  return { startMs, endMs, readingSeconds, gapSeconds: Math.max(0, (endMs - startMs) / 1000 - readingSeconds), parts };
}

/** 单句比较完整朗读跨度；多段逐段检查，不能由整句平均掩盖相反误差。
 * 多段沿用已有逐段300ms警告容差，最终装配仍须另过50ms总长及结构检查。
 */
export function compareReadingSpans(reference: ReadingMeasurement | null, candidate: ReadingMeasurement | null,
  rule: { low: number; high: number; absoluteToleranceMs?: number; partToleranceMs?: number }) {
  const span = (value: ReadingMeasurement | null) => value ? { start: value.startMs, end: value.endMs,
    span: value.readingSeconds * 1000, envelopeMs: value.endMs - value.startMs, gapMs: value.gapSeconds * 1000 } : null;
  const jpSpan = span(reference), cnSpan = span(candidate);
  const spanRatio = jpSpan && cnSpan ? cnSpan.span / jpSpan.span : null;
  const deltaMs = jpSpan && cnSpan ? cnSpan.span - jpSpan.span : null;
  const absoluteToleranceMs = Math.max(0, rule.absoluteToleranceMs ?? 0);
  const ratioPass = spanRatio !== null && spanRatio >= rule.low - 1e-9 && spanRatio <= rule.high + 1e-9;
  const absolutePass = deltaMs !== null && Math.abs(deltaMs) <= absoluteToleranceMs + 1e-6;
  const countPass = !!reference && !!candidate && reference.parts.length === candidate.parts.length;
  const parts = countPass ? reference!.parts.map((part, index) => {
    const cn = candidate!.parts[index], ratio = cn.spanMs / part.spanMs, deltaMs = cn.spanMs - part.spanMs;
    const tolerance = reference!.parts.length > 1 ? Math.max(0, rule.partToleranceMs ?? 300) : absoluteToleranceMs;
    return { index: index + 1, referenceMs: part.spanMs, candidateMs: cn.spanMs, ratio, deltaMs,
      pass: (ratio >= rule.low - 1e-9 && ratio <= rule.high + 1e-9) || Math.abs(deltaMs) <= tolerance + 1e-6 };
  }) : [];
  return { metricVersion: READING_SPAN_METRIC_VERSION, jpSpan, cnSpan, spanRatio, deltaMs, absoluteToleranceMs,
    ratioPass, absolutePass, enabled: true, parts, partCountPass: countPass,
    pass: countPass && parts.every(part => part.pass) && (ratioPass || absolutePass) };
}
