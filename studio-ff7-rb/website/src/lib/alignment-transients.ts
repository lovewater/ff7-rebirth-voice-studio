/** 对时专用的孤立微弱凸起规则（2026-10-24，#68172）：
 * 峰值 <= 整句峰值10%，累计超过5%门槛的采样时长 <=20ms，且前后
 * 各有 >=50ms 连续幅度 <=5% 的实际音频，才在检测信号中忽略。
 * 20ms是累计越线时长，不是首末越线点之间的跨度：该例跨度约50ms，
 * 但累计越线仅0.73ms。越线点之间不足50ms的低电平统一归入同一凸起，
 * 避免把一句轻声拆成许多小尖峰后误删；任一条件不符即保留。
 * 首尾不足50ms不能凭空补静音来满足条件。峰值基准固定使用原始整句，
 * 不反复过滤/重算门槛。这里只提供对时检测副本，不改原PCM、不做降噪，
 * 不用于净语速/VAD/ASR或其缓存；按钮与自动拉伸须共用此规则。
 */
export const ALIGNMENT_TRANSIENT_POLICY = "isolated-low-peak-10pct-active-20ms-quiet-50ms-v1";
export function alignmentDetectionSignal(samples: Float32Array, sampleRate: number) {
  let peak = 0;
  for (const x of samples) {
    if (!Number.isFinite(x)) return { samples, peak: 0, ignored: [] as { start: number; end: number; activeSamples: number }[] };
    peak = Math.max(peak, Math.abs(x));
  }
  const ignored: { start: number; end: number; activeSamples: number }[] = [];
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate) || peak <= 1e-8) return { samples, peak, ignored };
  // PCM是Float32，边界同精度比较，避免恰好10%被浮点舍入误判为超标。
  const low = Math.fround(peak * .05), high = Math.fround(peak * .10);
  const quiet = Math.ceil(sampleRate * .05), maximumActive = Math.floor(sampleRate * .02 + 1e-9);
  let start = -1, last = -1, previous = -1, active = 0, eventPeak = 0;
  function finish(next: number) {
    if (start >= 0 && start - previous - 1 >= quiet && next - last - 1 >= quiet
      && active <= maximumActive && eventPeak <= high) ignored.push({ start, end: last + 1, activeSamples: active });
  }
  for (let i = 0; i < samples.length; i++) {
    const amplitude = Math.abs(samples[i]);
    if (amplitude <= low) continue;
    if (start < 0 || i - last - 1 >= quiet) {
      finish(i);
      previous = last; start = i; active = 0; eventPeak = 0;
    }
    last = i; active++; eventPeak = Math.max(eventPeak, amplitude);
  }
  finish(samples.length);
  if (!ignored.length) return { samples, peak, ignored };
  const detection = samples.slice();
  for (const event of ignored) detection.fill(0, event.start, event.end);
  return { samples: detection, peak, ignored };
}
