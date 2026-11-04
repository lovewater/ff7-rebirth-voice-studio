import { createHash } from "node:crypto";
import { stretchWav } from "./wav-stretch";
import { parseWavPcm16, wavTiming } from "./tts-gpu";
import { ALIGN_SILENCE_RATIO } from "./auto-run-rules";
import { CASUAL_DURATION_MIN_RATIO, CASUAL_DURATION_MAX_RATIO } from "./casual-duration-workflow";

/** 页面“发”=首声→末声跨度，包含句中停顿，不是净VAD。
 * 仅非表演：固定首尾静音PCM，变速范围±15%。10秒总/9秒发/1秒静音，最多缩至8.65秒。
 * targetSpeechFrames=总预算帧−固定两端帧；不能用总长比J/T代替发声比例。
 */
export function planCasualSpeechCompression(frames:number,sampleRate:number,bounds:{start:number;end:number},target:number) {
  if(!Number.isSafeInteger(frames)||frames<=0||!Number.isSafeInteger(sampleRate)||sampleRate<=0
    || !Number.isSafeInteger(bounds.start)||!Number.isSafeInteger(bounds.end)||bounds.start<0||bounds.end>frames||bounds.end<=bounds.start
    || !Number.isFinite(target)||target<=0)return null;
  const speechFrames=bounds.end-bounds.start,leadingFrames=bounds.start,trailingFrames=frames-bounds.end;
  const targetFrames=Math.floor(target*sampleRate),targetSpeechFrames=targetFrames-leadingFrames-trailingFrames;
  const ratio=targetSpeechFrames/speechFrames;
  if(targetSpeechFrames<=0||ratio<CASUAL_DURATION_MIN_RATIO||ratio>=1)return null;
  return {sourceFrames:frames,sampleRate,leadingFrames,speechFrames,trailingFrames,targetFrames,targetSpeechFrames,ratio,
    sourceDuration:frames/sampleRate,targetDuration:targetFrames/sampleRate,speechDuration:speechFrames/sampleRate,
    targetSpeechDuration:targetSpeechFrames/sampleRate,leadingDuration:leadingFrames/sampleRate,trailingDuration:trailingFrames/sampleRate,
    totalRatio:targetFrames/frames};
}
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
function wav(pcm:Buffer,sr:number) {
  const out=Buffer.alloc(44+pcm.length);out.write("RIFF");out.writeUInt32LE(out.length-8,4);out.write("WAVEfmt ",8);out.writeUInt32LE(16,16);
  out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(sr,24);out.writeUInt32LE(sr*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
  out.write("data",36);out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);return out;
}
/** 页面“发”使用wavTiming原PCM的5%首末跨度（不应用按钮专用瞬态滤波）。
 * Interior pauses move with this span; only external PCM is fixed. JP preserved effects never enter this function.
 */
export function compressCasualSpeech(input:Buffer,target:number) {
  const parsed=parseWavPcm16(input),timing=wavTiming(input);
  if(parsed.channels!==1||parsed.blockAlign!==2)throw new Error("普通发声区间缩短需要单声道PCM16");
  if(!(timing.speech>0)||!Number.isFinite(timing.start)||!Number.isFinite(timing.end))return null;
  const bounds={start:Math.round(timing.start*parsed.sampleRate),end:Math.round(timing.end*parsed.sampleRate)};
  const plan=planCasualSpeechCompression(parsed.frames,parsed.sampleRate,bounds,target);
  if(!plan)return null;
  const pcm=input.subarray(parsed.dataOffset,parsed.dataOffset+parsed.frames*2);
  const head=pcm.subarray(0,plan.leadingFrames*2),tail=pcm.subarray((plan.leadingFrames+plan.speechFrames)*2);
  const speech=wav(pcm.subarray(plan.leadingFrames*2,(plan.leadingFrames+plan.speechFrames)*2),parsed.sampleRate);
  const stretched=stretchWav(speech,plan.ratio),got=parseWavPcm16(stretched);
  if(got.sampleRate!==parsed.sampleRate||got.channels!==1||got.blockAlign!==2||got.frames!==plan.targetSpeechFrames)
    throw new Error("普通发声缩短帧数与发声目标不一致");
  const audio=wav(Buffer.concat([head,stretched.subarray(got.dataOffset,got.dataOffset+got.frames*2),tail]),parsed.sampleRate);
  const output=parseWavPcm16(audio),body=audio.subarray(output.dataOffset);
  if(output.frames!==plan.targetFrames || !body.subarray(0,head.length).equals(head)||!body.subarray(body.length-tail.length).equals(tail))
    throw new Error("普通发声缩短后的总长或固定静音PCM验证失败");
  return {audio,plan,metadata:{version:"casual-speech-span-compression-v2",allowedSpeechRatio:{min:CASUAL_DURATION_MIN_RATIO,max:CASUAL_DURATION_MAX_RATIO},definition:"first-to-last-speech-span-including-internal-pauses",
    boundaryPeakRatio:ALIGN_SILENCE_RATIO,boundaryPolicy:"wavTiming-raw-peak",externalSilencePcmExact:true,leadingPcmSha256:hash(head),trailingPcmSha256:hash(tail),
    sourceAudioSha256:hash(input),outputAudioSha256:hash(audio),...plan}};
}
