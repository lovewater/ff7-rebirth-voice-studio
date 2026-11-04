type Hit = { text: string; start: number; end: number };
type TimedAsr = { words: Hit[]; utterances: Hit[] };
export const AUDIO_SPAN_METRIC_VERSION = "seed-asr-cn-span-over-jp-reference-v1";

export function recognizedSpeechSpan(asr: TimedAsr) {
  const usable = (hits: Hit[]) => hits.filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start);
  const words = usable(asr.words);
  const hits = words.length ? words : usable(asr.utterances);
  if (!hits.length) return null;
  const start = Math.min(...hits.map((row) => row.start));
  const end = Math.max(...hits.map((row) => row.end));
  const span = end - start;
  return Number.isFinite(span) && span > 0 ? { start, end, span } : null;
}

/** 两边必须来自待比较的实际音频 ASR。日文必须是送给 TTS 的处理后参考，
 * 不能拿原声字轴减拟声时长来猜；中文必须是第3/4步保存的候选。
 * 首尾跨度包含内部停顿，缺失数据记 null；开启检查时不能当成 0 或伪装成通过。
 */
export function compareAudioSpans(reference: TimedAsr, candidate: TimedAsr, rule: {
  enabled: boolean; low: number; high: number;
}) {
  const jpSpan = recognizedSpeechSpan(reference);
  const cnSpan = recognizedSpeechSpan(candidate);
  const spanRatio = jpSpan && cnSpan ? cnSpan.span / jpSpan.span : null;
  return {
    metricVersion: AUDIO_SPAN_METRIC_VERSION, jpSpan, cnSpan, spanRatio,
    enabled: rule.enabled,
    pass: rule.enabled ? spanRatio !== null && spanRatio >= rule.low && spanRatio <= rule.high : true,
  };
}

/** 短句拖音常被 ASR 字轴漏算，且尾静音不能用来充时长。
 * 用处理后日文正文和实际保存的中文候选的波形首末发声跨度比较，保留内部停顿。
 * 字轴仍用于校字和切口；持久化单独版本，避免把波形指标冒充 ASR 指标。
 */
export function compareWaveformSpans(reference: { start: number; end: number }, candidate: { start: number; end: number }, rule: { low: number; high: number }) {
  const span = (timing: typeof reference) => Number.isFinite(timing.start) && Number.isFinite(timing.end) && timing.end > timing.start
    ? { start: timing.start * 1000, end: timing.end * 1000, span: (timing.end - timing.start) * 1000 } : null;
  const jpSpan = span(reference), cnSpan = span(candidate);
  const spanRatio = jpSpan && cnSpan ? cnSpan.span / jpSpan.span : null;
  return { metricVersion: "waveform-cn-span-over-jp-reference-v1", jpSpan, cnSpan, spanRatio, enabled: true,
    pass: spanRatio !== null && spanRatio >= rule.low - 1e-9 && spanRatio <= rule.high + 1e-9 };
}

/** 净发声时长比：情绪已经从参考和TTS正文中移除，再扣除双方波形长静音。
 * span字段在本版本明确保存净发声毫秒，start/end只是原包络证据，span!=end-start。
 * 不改变拍数比normalizedRatio公式，也不改变旧版本记录的含义；缺测量不能按总长充数。
 */
export function compareNetSpeakingTimes(reference: { startMs:number;endMs:number;speechSeconds:number;pauseSeconds:number } | null,
 candidate: { startMs:number;endMs:number;speechSeconds:number;pauseSeconds:number } | null,rule:{low:number;high:number;absoluteToleranceMs?:number}) {
 const span=(value:typeof reference)=>value&&Number.isFinite(value.speechSeconds)&&value.speechSeconds>0
   ? {start:value.startMs,end:value.endMs,span:value.speechSeconds*1000,pauseMs:value.pauseSeconds*1000,envelopeMs:value.endMs-value.startMs}:null;
 const jpSpan=span(reference),cnSpan=span(candidate),spanRatio=jpSpan&&cnSpan?cnSpan.span/jpSpan.span:null;
 const deltaMs=jpSpan&&cnSpan?cnSpan.span-jpSpan.span:null;
 const absoluteToleranceMs=Number.isFinite(rule.absoluteToleranceMs)&&rule.absoluteToleranceMs!>=0?rule.absoluteToleranceMs!:0;
 const ratioPass=spanRatio!==null&&spanRatio>=rule.low-1e-9&&spanRatio<=rule.high+1e-9;
 const absolutePass=deltaMs!==null&&Math.abs(deltaMs)<=absoluteToleranceMs+1e-6;
 return {metricVersion:"waveform-cn-net-over-jp-clean-reference-v1",jpSpan,cnSpan,spanRatio,enabled:true,
  deltaMs,absoluteToleranceMs,ratioPass,absolutePass,pass:ratioPass||absolutePass};
}
