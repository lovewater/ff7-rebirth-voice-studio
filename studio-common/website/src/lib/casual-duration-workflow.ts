/** 非表演专用：起稿最多三条，改稿最多三轮×三条；先整句对齐再核字，按页面“发”限制变速±15%。 */
export const CASUAL_DURATION_RETRIES = 3;
export const CASUAL_ORIGINAL_ATTEMPTS = 3;
export const CASUAL_REWRITE_BATCH_SIZE = 3;
export const CASUAL_DURATION_TOLERANCE_S = .001;
export const CASUAL_DURATION_MIN_RATIO = .85;
export const CASUAL_DURATION_MAX_RATIO = 1.15;
export function casualDurationFits(duration: number, target: number) {
  return Number.isFinite(target) && target > 0 && Number.isFinite(duration) && duration > 0
    && duration <= target + CASUAL_DURATION_TOLERANCE_S + Number.EPSILON * Math.max(1, target, duration) * 4;
}
/** 使用候选采样率向下取整目标帧数，避免四舍五入后超过日文总长。 */
export function casualCompressionPlan(frames: number, sampleRate: number, target: number) {
  if (!Number.isSafeInteger(frames) || frames <= 0 || !Number.isSafeInteger(sampleRate) || sampleRate <= 0
    || !Number.isFinite(target) || target <= 0) return null;
  const targetFrames = Math.floor(target * sampleRate);
  const ratio = targetFrames / frames;
  return targetFrames > 0 && ratio >= CASUAL_DURATION_MIN_RATIO && ratio < 1
    ? { targetFrames, ratio, sourceDuration: frames / sampleRate, targetDuration: targetFrames / sampleRate } : null;
}
export type CasualDurationAttempt = {
  id: string; script: string; duration: number; textPassed: boolean; reason: string;
  pronunciationNotes?: string[]; pronunciationIssueCount?: number; processingSteps?: number; compressionRatio?: number; processingFailed?: boolean;
  verifiedAudioSha256?: string;
  asrText?:string;spokenText?:string;literalReading?:boolean;dictionaryReading?:boolean;naturalErhuaReading?:boolean;sourceStage?:"original"|"rewrite"|"reused-original";
  semanticPassed?:boolean;semanticFeedback?:string;semanticFailureKind?:"meaning"|"reading"|"uncertain";
  componentBodySha256?:string;expectedSubtitle?:string|null;
  semanticEvidence?:import("./casual-semantic-review").CasualSemanticEvidence;
};
export function casualDurationPass(attempt: CasualDurationAttempt, target: number) {
  return casualDurationFits(attempt.duration, target) && attempt.textPassed && !attempt.processingFailed && attempt.semanticPassed!==false;
}
export function compactCasualText(text: string) {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
}
export function casualCharacterBudget(script: string, measured: number, target: number) {
  const count = Array.from(compactCasualText(script)).length;
  return Math.max(1, Math.min(count - 1, Math.floor(count * target / measured * .92)));
}
/** Hard gates first; fewer pronunciation doubts, less processing, then stable generation order. */
export function chooseCasualPassing(attempts: CasualDurationAttempt[], target: number) {
  return attempts.filter(row=>casualDurationPass(row,target)).sort((a,b)=>
    (a.pronunciationIssueCount??a.pronunciationNotes?.length??0)-(b.pronunciationIssueCount??b.pronunciationNotes?.length??0)
    || (a.processingSteps??0)-(b.processingSteps??0)
    || (b.compressionRatio??1)-(a.compressionRatio??1))[0];
}
export async function runCasualDurationWorkflow(input: {
  original: string; target: number;
  attempt: (script: string, round: number, count: 1|3, originalAttempt?: number) => Promise<CasualDurationAttempt | CasualDurationAttempt[]>;
  reuseAttempt?: (index:number)=>Promise<CasualDurationAttempt[]|null>;
  review?: (attempt:CasualDurationAttempt)=>Promise<void>;
  compress?: (previous: CasualDurationAttempt, target: number) => Promise<CasualDurationAttempt | null>;
  rewrite: (previous: CasualDurationAttempt, maxCharacters: number, round: number) => Promise<string>;
  guard: () => Promise<void>;
}) {
  if (!input.original.trim() || !Number.isFinite(input.target) || input.target <= 0)
    throw new Error('原中文字幕或日文音频时长无效');
  let script=input.original,rewriteError:string|null=null;
  const attempts:CasualDurationAttempt[]=[];
  const assess=async (generated:CasualDurationAttempt|CasualDurationAttempt[]) => {
    const batch=Array.isArray(generated)?generated:[generated],effective:CasualDurationAttempt[]=[];
    if(new Set(batch.map(row=>row.id)).size!==batch.length)throw new Error('普通候选ID重复，不能复用核字或源音频');
    // 非表演允许发声区间输出/输入比0.85–1.15；普通音频本来能放下就接受，不强制补满而减速。
    // compress只缩中文首声→末声span（含内部停顿），首尾静音固定；J/T>=.85仅是必要预筛。
    // 准入用(targetFrames−fixedLeading−fixedTrailing)/speechFrames>=.85，不能拿整音频比代替。
    // 例如10总/9发/1静音最低8.65总；处理后按完整总长+新核字判定，JP保留原声不参加缩放。演出不使用此范围。
    for(let attempt of batch) {
      attempts.push(attempt);effective.push(attempt);await input.guard();
      if(attempt.textPassed&&!attempt.processingFailed&&input.review){await input.review(attempt);await input.guard();}
      if(attempt.textPassed && !attempt.processingFailed && attempt.semanticPassed!==false && !casualDurationFits(attempt.duration,input.target)
        && attempt.duration>input.target && input.target/attempt.duration>=CASUAL_DURATION_MIN_RATIO && input.compress) {
        await input.guard();
        let edited:CasualDurationAttempt|null;
        try {edited=await input.compress(attempt,input.target);}
        catch(error) {
          await input.guard();
          // Explicit manual/source interventions stop the run; ordinary per-candidate DSP failures do not discard siblings.
          if(error instanceof Error && error.name==='CasualInterventionError')throw error;
          edited={...attempt,textPassed:false,processingFailed:true,reason:`正文缩短失败：${error instanceof Error?error.message:String(error)}`};
        }
        await input.guard();
        if(edited){attempts.push(edited);effective.push(edited);attempt=edited;
          if(attempt.textPassed&&!attempt.processingFailed&&input.review){await input.review(attempt);await input.guard();}}
      }
    }
    await input.guard();
    return effective;
  };
  let effective:CasualDurationAttempt[]=[];
  if(input.reuseAttempt)for(let index=0;;index++) {
    await input.guard();const reused=await input.reuseAttempt(index);if(reused===null)break;
    const batch=await assess(reused);effective.push(...batch);
    const selected=chooseCasualPassing(batch,input.target);if(selected)return {passed:true,selected,attempts,rewriteError};
  }
  for(let originalAttempt=1;originalAttempt<=CASUAL_ORIGINAL_ATTEMPTS;originalAttempt++) {
    await input.guard();
    const batch=await assess(await input.attempt(script,0,1,originalAttempt));
    effective.push(...batch);
    const selected=chooseCasualPassing(batch,input.target);
    if(selected)return {passed:true,selected,attempts,rewriteError};
  }
  for(let round=1;round<=CASUAL_DURATION_RETRIES;round++) {
    // Only a complete, genuinely overlong reading can justify deleting text.
    const semanticFailure=effective.find(row=>row.textPassed&&!row.processingFailed&&row.semanticFailureKind==='meaning');
    const overlong=effective.filter(row=>row.textPassed && !row.processingFailed
      &&row.semanticFailureKind!=='reading'&&row.semanticFailureKind!=='uncertain'&&Number.isFinite(row.duration)
      && row.duration>input.target && !casualDurationFits(row.duration,input.target)).sort((a,b)=>a.duration-b.duration)[0];
    const feedback=semanticFailure??overlong;
    if(feedback) {
      await input.guard();
      try {
        const budget=semanticFailure?Math.max(Array.from(compactCasualText(input.original)).length,Array.from(compactCasualText(script)).length)
          :casualCharacterBudget(script,feedback.duration,input.target);
        const next=(await input.rewrite(feedback,budget,round)).trim();
        // Meaning repair may restore words or keep the same length. Timing + semantic review, not shrinking text, decides validity.
        if(!next || !compactCasualText(next))throw new Error('改稿为空');
        script=next;
      } catch(error) {
        if(error instanceof Error && error.name==='CasualInterventionError')throw error;
        rewriteError=error instanceof Error?error.message:String(error);break;
      }
    } else if(round===1) break;
    // Failed nuclear checks after a rewrite retry that same script as a new three-candidate batch.
    await input.guard();
    effective=await assess(await input.attempt(script,round,CASUAL_REWRITE_BATCH_SIZE));
    const selected=chooseCasualPassing(effective,input.target);
    if(selected)return {passed:true,selected,attempts,rewriteError};
  }
  const complete=attempts.filter(row=>row.textPassed && !row.processingFailed && row.semanticPassed!==false && Number.isFinite(row.duration) && row.duration>0);
  // A known meaning rejection is never promoted just because it is short. Production semantic mode has no unreviewed fallback.
  const selected=complete.sort((a,b)=>Number(b.semanticPassed===true)-Number(a.semanticPassed===true)||a.duration-b.duration)[0]
    ??(input.review?undefined:attempts[attempts.length-1]);
  return {passed:false,selected,attempts,rewriteError};
}
