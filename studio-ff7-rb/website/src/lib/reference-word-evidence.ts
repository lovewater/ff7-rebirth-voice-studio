import type { KeptFrames } from "./tts-reference";

/** 字轴搜索容错；只放宽既有声学验证的搜索范围，不把ASR时间戳当波形切口。 */
export const JP_WORD_AXIS_TOLERANCE_MS = 220;

/** 波形块只是候选段。进入2/3段硬对齐前，每块都须有原始ASR正文字轴支持。
 * 用buildSpeechReference保留区间逐字映射原字轴；不能拿参考重识别新冒出的字
 * （例如微弱声被转成「あっ」）反过来证明未分类声音是正文。
 * 一个字最多支持一块；跨切口/落在长静音中的字不强分配。utterance数量不作门槛，
 * 所以一个utterance里的真实两/三段仍可通过。缺证据只触发整句降级，不删除声音。
 */
export function referenceWordEvidence(input: {
  sampleRate: number;
  chunks: { start: number; end: number }[];
  kept: KeptFrames[];
  words: { start: number; end: number; text: string }[];
}) {
  const { sampleRate, chunks, kept, words } = input;
  const parts = chunks.map((chunk,index) => ({index:index+1,startMs:chunk.start/sampleRate*1000,
    endMs:chunk.end/sampleRate*1000,wordIndexes:[] as number[],text:""}));
  if (![2,3].includes(chunks.length)) return {pass:true,parts,reason:"不是两/三块波形，不新增分段要求"};
  if (!(sampleRate>0) || !Number.isFinite(sampleRate)) return {pass:false,parts,reason:"参考采样率无效"};
  words.forEach((word,index) => {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end<=word.start
      || !word.text.replace(/[\s\p{P}\p{S}]/gu,"")) return;
    const mapped = kept.flatMap(span => {
      const start=Math.max(word.start*sampleRate/1000,span.sourceStart),end=Math.min(word.end*sampleRate/1000,span.sourceEnd);
      if (!(end>start)) return [];
      return [{start:(span.targetStart+start-span.sourceStart)/sampleRate*1000,end:(span.targetStart+end-span.sourceStart)/sampleRate*1000}];
    });
    // 一个字被删除区间切开时，证据不完整，不用它为两侧块提供正文依据。
    if (mapped.length!==1) return;
    const middle=(mapped[0].start+mapped[0].end)/2;
    const hits=parts.filter(part=>middle>=part.startMs-JP_WORD_AXIS_TOLERANCE_MS && middle<=part.endMs+JP_WORD_AXIS_TOLERANCE_MS);
    if(hits.length!==1)return;
    hits[0].wordIndexes.push(index);hits[0].text+=word.text;
  });
  const unsupported=parts.filter(part=>!part.wordIndexes.length).map(part=>part.index);
  return {pass:unsupported.length===0,parts,reason:unsupported.length
    ? `第${unsupported.join("、")}块波形没有可靠的原始ASR正文对应，禁止据此强制中文分段`
    :"每块波形均有独立原始ASR正文对应（utterance可为一段）"};
}
