import { isPerformanceMode } from "./auto-run-rules";
import type { AutoRunStageIndex } from './auto-run-stage-context';


/** Client stage claims need a matching persisted, server-owned running stage. */
export function validatedCloneStage(requested: unknown, persisted: unknown, requestedModel?: unknown): AutoRunStageIndex | null {
  if(requested===undefined)return null; // Legacy and manual requests cannot enable rescue.
  if(![1,2,3].includes(requested as number))throw new Error('无效的自动运行轮次');
  if(!persisted || typeof persisted!=='object')throw new Error('自动运行轮次尚未开始或已变化');
  const current=persisted as {stage?:unknown;model?:unknown;allowGapSplit?:unknown};
  if(!['grok','primary'].includes(requestedModel as string) || current.stage!==requested || current.model!==requestedModel || current.allowGapSplit!==(requested===3))throw new Error('自动运行轮次尚未开始或已变化');
  return requested as AutoRunStageIndex;
}
export function allowCloneGapSplit(stage: AutoRunStageIndex|null, dialogueMode:string|null, syncToJp:boolean):boolean {
  return stage===3 && isPerformanceMode(dialogueMode) && syncToJp;
}

/** 自动运行仅场景演出对时；手动生成保留既有 field 判定。 */
export function cloneSyncsToJapanese(autoRunId: string | null, dialogueMode: string | null): boolean {
  return autoRunId !== null ? isPerformanceMode(dialogueMode) : dialogueMode !== "field";
}

/** Count never changes timing behavior and cannot override scene/manual generation. */
export function cloneCandidateCount(requested: unknown, autoRunId: string|null, stage: AutoRunStageIndex|null,
  dialogueMode: string|null, feedbackRound: boolean): 1|3 {
  const ordinary=autoRunId!==null && !isPerformanceMode(dialogueMode);
  if(requested!==undefined && (!ordinary || stage!==1 || (requested!==1 && requested!==3)))
    throw new Error("原生候选数量只允许已验证的普通自动运行设置为1或3");
  if(ordinary) {
    if(stage!==1)throw new Error("普通自动运行只允许第一轮");
    return requested===3?3:1;
  }
  return feedbackRound?1:3;
}
