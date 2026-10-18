import { ALIGN_SILENCE_RATIO } from "./auto-run-rules";

type Wave = { samples: Float32Array; sampleRate: number };
type TwoParts = { start: number; end: number; gapStart: number; gapEnd: number };

/** 只认“有声—一处长静音—有声”，不推断文字或语义，不调用 ASR。
 * 与试听实验相同：10ms窗内全部采样低于全局峰值5%，连续>=250ms算长静音。
 * 首尾留白不算内部停顿；零处/多处内部停顿均不走高级对齐。
 */
export function singleInternalGap({ samples, sampleRate }: Wave): TwoParts | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !samples.length) return null;
  let peak = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return null;
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak <= 1e-8) return null;
  const threshold = peak * ALIGN_SILENCE_RATIO;
  let start = 0, end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const minimum = Math.ceil(sampleRate * 0.25);
  let quietStart: number | null = null;
  const gaps: { start: number; end: number }[] = [];
  for (let at = Math.floor(start / hop) * hop; at < end + hop; at += hop) {
    let quiet = at < samples.length;
    for (let i = at; i < Math.min(at + hop, samples.length); i++) {
      if (Math.abs(samples[i]) >= threshold) { quiet = false; break; }
    }
    if (quiet && quietStart === null) quietStart = at;
    if (!quiet && quietStart !== null) {
      if (at - quietStart >= minimum && quietStart > start && at < end) {
        gaps.push({ start: quietStart, end: at });
        if (gaps.length > 1) return null;
      }
      quietStart = null;
    }
  }
  return gaps.length === 1 ? { start, end, gapStart: gaps[0].start, gapEnd: gaps[0].end } : null;
}

/** 全部长度换算为成品采样数，兼容日中采样率不同。
 * 中间静音=参考总长-参考首尾留白-两段成品声音长度。
 * 若正文已经放不下，不能靠负静音解决，返回null，保留普通自动对齐。
 * 这里只保证首尾和总长，不保证两段正文各自与日文逐段/逐字对齐。
 */
export function gapOnlyAlignmentPlan(reference: Wave, edited: Wave) {
  const jp = singleInternalGap(reference), cn = singleInternalGap(edited);
  if (!jp || !cn) return null;
  const convert = (frames: number) => Math.round(frames * edited.sampleRate / reference.sampleRate);
  const total = convert(reference.samples.length);
  const leading = convert(jp.start);
  const trailing = convert(reference.samples.length - jp.end);
  const firstLength = cn.gapStart - cn.start;
  const secondLength = cn.end - cn.gapEnd;
  const middle = total - leading - trailing - firstLength - secondLength;
  if (middle < 0) return null;
  return { total, leading, trailing, middle, firstLength, secondLength, cn };
}

/** 只复制两段原始PCM，替换三段留白；不拉伸、不归一音量、不修改原数组。 */
export function alignSingleGap(reference: Wave, edited: Wave): Float32Array {
  const plan = gapOnlyAlignmentPlan(reference, edited);
  if (!plan) throw new Error("高级自动对齐需要日中各有一处长停顿，且两段正文能放入日文时长");
  const out = new Float32Array(plan.total);
  out.set(edited.samples.subarray(plan.cn.start, plan.cn.gapStart), plan.leading);
  out.set(edited.samples.subarray(plan.cn.gapEnd, plan.cn.end), plan.leading + plan.firstLength + plan.middle);
  return out;
}
