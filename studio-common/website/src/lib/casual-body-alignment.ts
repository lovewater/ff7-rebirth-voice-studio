import { createHash } from "node:crypto";
import { alignWavToSlot, speechBoundsSamples } from "./audio-splice";
import { decodeWavMono } from "./wav-stretch";
import { ALIGN_SILENCE_RATIO } from "./auto-run-rules";
import { ALIGNMENT_TRANSIENT_POLICY } from "./alignment-transients";

const hash=(audio:Buffer)=>createHash("sha256").update(audio).digest("hex");

/** Same single-slot operation as the editor button, before ASR; never splits clauses. */
export function alignCasualBodyToReference(input:Buffer,reference:Buffer,targetSeconds:number) {
  const jp=decodeWavMono(reference), source=decodeWavMono(input);
  const actualReferenceDuration=jp.samples.length/jp.sampleRate;
  if(!Number.isFinite(targetSeconds) || targetSeconds<=0
    || Math.abs(targetSeconds-actualReferenceDuration)>1/jp.sampleRate+Number.EPSILON*8)
    throw new Error("普通自动对齐预算与实际日文正文参考长度不一致");
  const bounds=speechBoundsSamples(jp.samples,ALIGN_SILENCE_RATIO,jp.sampleRate);
  if(!bounds)throw new Error("实际日文正文参考没有有效开口，不能自动对齐");
  const startSeconds=bounds.start/jp.sampleRate;
  const audio=alignWavToSlot(input,startSeconds,targetSeconds);
  const output=decodeWavMono(audio), sourceSha256=hash(input), alignedSha256=hash(audio);
  return {audio,changed:sourceSha256!==alignedSha256,meta:{version:"casual-single-slot-alignment-v1",
    algorithm:"audio-splice.alignWavToSlot",boundaryPeakRatio:ALIGN_SILENCE_RATIO,transientPolicy:ALIGNMENT_TRANSIENT_POLICY,
    referenceSha256:hash(reference),referenceSampleRate:jp.sampleRate,referenceFrames:jp.samples.length,
    referenceStartFrame:bounds.start,referenceEndFrame:bounds.end,startSeconds,targetSeconds,actualReferenceDuration,
    sourceSampleRate:source.sampleRate,outputSampleRate:output.sampleRate,sourceFrames:source.samples.length,outputFrames:output.samples.length,
    beforeDuration:source.samples.length/source.sampleRate,afterDuration:output.samples.length/output.sampleRate,
    sourceSha256,alignedSha256,bodyOnly:true,segmentAlignment:false}};
}
