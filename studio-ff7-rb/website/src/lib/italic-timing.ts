import { tailBodyAudio, appendPreservedTail, preservedBodyDurationMs } from "./preserved-tail";
import { applyScales, concatWavs, mixSegments, wavDuration } from "./audio-splice";
import { SCALE_LO } from "./auto-run-rules";
import type { OnoPlan, SplicePiece } from "./auto-run-onomatopoeia";
import { decodeWavMono } from "./wav-stretch";

/** 斜体只检查总长上限；一采样仅用于重采样取整，不是允许超长的业务容差。 */
export function italicLengthPass(actual: number, target: number, sampleRate: number) {
  return Number.isFinite(actual) && actual > 0 && Number.isFinite(target) && target > 0
    && sampleRate > 0 && actual <= target + 1 / sampleRate;
}

export function italicCandidateDecision(textOk: boolean, fits: boolean, beatPass: boolean) {
  return !textOk || !fits ? "retry" : beatPass ? "passed" : "review";
}

/** 保留原声和原声衔接间距，短的保持自然时长；过长只在既有90%下限内压缩正文。
 * 不补长、不强制分段对齐，不缩放原声或剪掉发声。压缩后仍超长则由调用方重试。
 */
export function fitItalicAudio(jp: Buffer, tts: Buffer, plan: OnoPlan, pieces: SplicePiece[], target: number) {
  if (!plan.preservedTail) return fitItalicBody(jp, tts, plan, pieces, target);
  const tail = plan.preservedTail, bodyPlan = { ...plan, preservedTail: undefined,
    enabled: plan.onomatopoeia.length > 0 || plan.ambient.length > 0 };
  const packed = fitItalicBody(tailBodyAudio(jp, tail), tts, bodyPlan, pieces, preservedBodyDurationMs(tail) / 1000);
  const restored = appendPreservedTail(jp, packed.audio, tail);
  const d = decodeWavMono(restored.audio), duration = d.samples.length / d.sampleRate;
  return { ...packed, audio: restored.audio, fit: { ...packed.fit, target: duration,
    actual_s: duration, wav_s: duration, body_fit: packed.fit, preserved_tail: restored.metadata } };
}
function fitItalicBody(jp: Buffer, tts: Buffer, plan: OnoPlan, pieces: SplicePiece[], target: number) {
  const packed = mixSegments(jp, tts, plan, pieces, target);
  if (!packed.length) throw new Error("斜体拼接结果为空");
  const total = packed.reduce((sum, part) => sum + part.duration, 0);
  const speech = packed.filter(part => part.kind === "speech" && !part.fixed);
  const speechDuration = speech.reduce((sum, part) => sum + part.duration, 0);
  // 为分片各自重采样的取整预留一采样，绝不裁最终文件来掩盖超长。
  const rate = decodeWavMono(tts).sampleRate;
  const scale = total > target && speechDuration > 0
    ? Math.max(SCALE_LO, Math.min(1, (target - (total - speechDuration) - packed.length / rate) / speechDuration)) : 1;
  const scales = Object.fromEntries(packed.map(part => [part.id, part.kind === "speech" && !part.fixed ? scale : 1]));
  const result = applyScales(packed, scales);
  const audio = concatWavs(result.map(part => part.buffer), 0);
  const actual = wavDuration(audio);
  const ok = italicLengthPass(actual, target, decodeWavMono(audio).sampleRate);
  return { audio, ok, fit: { version: "italic-duration-ceiling-v1", target, actual_s: actual, wav_s: actual,
    packed: total, scales, ok, onlyUpperBound: true, speech_lo: SCALE_LO, speech_hi: 1 } };
}
