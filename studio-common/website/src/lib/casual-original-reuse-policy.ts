/** Read-only planning only: no API, database write, generation or selection is performed here. */
export type OriginalReuseCandidate = {
  id:string;stem:string;status:string;reviewState:string;voiceGpuKey:string;
  audioPath:string|null;spokenText:string|null;ttsText?:string|null;subtitleText:string|null;gameZhSnapshot:string|null;
  conversionMeta?:Record<string,unknown>|null;
};
const body=(text:string|null|undefined)=>(text??"").replace(/[\s\p{P}\p{S}]/gu,"");

/** Candidate admission is not a successful ASR/format/timing result. A future execution must copy
 * under line/run/source locks, re-check current source SHA/subtitle, and independently verify the new file.
 * Never import old duration_review/textPassed as proof for a newly processed file.
 */
export function planOriginalCandidateReuse(line:{stem:string;textZh:string|null;hasManualSelection:boolean;cleanupEnabled:boolean;currentTtsTextSent?:string;currentFinalTtsText?:string},candidate:OriginalReuseCandidate) {
  const reject=(reason:string)=>({decision:"not-admitted" as const,reason,sourceId:candidate.id});
  if(line.hasManualSelection)return reject("已有锁定或人工异常，必须保留人工选择");
  if(!body(line.textZh))return reject("当前原稿为空，先准备有来源的中文稿");
  if(candidate.stem!==line.stem)return reject("不是同一条台词的候选");
  if(candidate.status!=="ready"||candidate.reviewState!=="candidate"||!candidate.audioPath)return reject("源版本不是可复制的未标记成品");
  if(candidate.voiceGpuKey==="jp-lock"||candidate.conversionMeta?.pipeline==="jp-lock")return reject("日文原声锁不是已制作中文原稿");
  if(body(candidate.spokenText)!==body(line.textZh))return reject("源正文与当前完整原稿不同，改稿或清理正文不能冒充全文");
  const questions=(text:string|null|undefined)=>(text??"").match(/[?？]/gu)?.length??0;
  if(questions(candidate.spokenText)!==questions(line.textZh)||questions(candidate.ttsText)!==questions(line.textZh))
    return reject("源朗读稿删改了问意标记，不能按未改原稿快通");
  if(candidate.subtitleText!==null&&questions(candidate.subtitleText)!==questions(line.textZh))return reject("源字幕问意标记不同，保留人工文字");
  if(body(candidate.gameZhSnapshot)!==body(line.textZh))return reject("源原稿快照与当前稿不一致或缺失");
  if(candidate.subtitleText!==null && body(candidate.subtitleText)!==body(line.textZh))return reject("源字幕存在不同正文，保留人工文字");
  if(!line.currentTtsTextSent || typeof candidate.conversionMeta?.tts_text_sent!=='string')
    return reject("缺少当前发音规则或源实际TTS发送稿证据，不能复用");
  if(candidate.conversionMeta.tts_text_sent!==line.currentTtsTextSent)
    return reject("源实际发送稿与当前发音规则不一致，保留历史并继续新TTS");
  if(line.currentFinalTtsText&&line.currentFinalTtsText!==line.currentTtsTextSent
    &&candidate.conversionMeta.final_tts_payload_text!==line.currentFinalTtsText)
    return reject("当前末级拼音/手工注音改变载荷，源缺少一致的实际末级发送证据");
  if(!candidate.audioPath.startsWith(`tts/${line.stem}/`)||!/^tts\/[\w.\-]+\/[\w.\-]+\.wav$/.test(candidate.audioPath))
    return reject("源不是已验证路径的独立WAV，需先准备可审计解码副本");
  if(line.cleanupEnabled)return reject("当前有JP保留片段，旧完整音频需闭合的正文提取证据后才能复用");
  return {decision:"candidate-for-dsp" as const,reason:"完整原稿与快照匹配；仅进入独立复制与新核字候选池",sourceId:candidate.id,
    requiresSourceShaUnderLock:true,requiresFreshAsr:true,reusesOldAsr:false,consumesNativeTts:false};
}
