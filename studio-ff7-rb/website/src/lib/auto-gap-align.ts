import { alignSingleGap, gapOnlyAlignmentPlan } from "./gap-only-align";
import { decodeWavMono, encodeWavMono } from "./wav-stretch";
import { parseWavPcm16, wavTiming } from "./tts-gpu";

/** 自动运行的候选预处理，必须在长度淘汰和偏短增字反馈之前执行。
 * 参考使用实际日文输入（删拟声后的参考也可），不能使用额外补尾静音的TTS prompt。
 * 只对两边恰有一个长间隙且正文装得下的情况生效；其余保持原流程。
 * 声音段不拉伸，仅调整首尾和中间静音；这不等于逐字或口型对齐。
 */
export function autoGapAlign(generated: Buffer, reference: Buffer) {
  const jp = decodeWavMono(reference), cn = decodeWavMono(generated);
  const plan = gapOnlyAlignmentPlan(jp, cn);
  if (!plan) return null;
  const samples = alignSingleGap(jp, cn);
  const audio = encodeWavMono(cn.sampleRate, samples);
  // TTS是单声道PCM16时直接拷贝正文原始字节，避免再次量化造成1LSB音量差。
  // 多声道输入沿用共享解码的混音规则，不把交错声道当作单声道直接复制。
  const pcm = parseWavPcm16(generated);
  if (pcm.channels === 1) {
    generated.copy(audio, 44 + plan.leading * 2,
      pcm.dataOffset + plan.cn.start * 2, pcm.dataOffset + plan.cn.gapStart * 2);
    generated.copy(audio, 44 + (plan.leading + plan.firstLength + plan.middle) * 2,
      pcm.dataOffset + plan.cn.gapEnd * 2, pcm.dataOffset + plan.cn.end * 2);
  }
  return {
    audio,
    meta: {
      version: "single-gap-before-rewrite-v1",
      referenceSeconds: jp.samples.length / jp.sampleRate,
      beforeSeconds: cn.samples.length / cn.sampleRate,
      afterSeconds: samples.length / cn.sampleRate,
      referenceSpeechSeconds: wavTiming(reference).speech,
      beforeSpeechSeconds: wavTiming(generated).speech,
      afterSpeechSeconds: wavTiming(audio).speech,
      previousLeadingSeconds: plan.cn.start / cn.sampleRate,
      previousTrailingSeconds: (cn.samples.length - plan.cn.end) / cn.sampleRate,
      leadingSeconds: plan.leading / cn.sampleRate,
      trailingSeconds: plan.trailing / cn.sampleRate,
      previousGapSeconds: (plan.cn.gapEnd - plan.cn.gapStart) / cn.sampleRate,
      gapSeconds: plan.middle / cn.sampleRate,
      speechStretch: 1,
    },
  };
}
