import { AsyncLocalStorage } from "node:async_hooks";
import { autoRunStage, currentAutoRunStage, withAutoRunStage, type AutoRunStage } from "./auto-run-stage-context";
import { withChatModel } from "./llm-model-context";
export type AutoRunSourceGuard={textZh:string|null;textJp:string|null;textEn:string|null;translateZhJp:string|null;translateZhEn:string|null};
export type AutoRunOutcome = {
  status: "passed" | "failed"; error: string | null; selected: string | null;
  options?: { preserveSubtitle?: boolean; noModelRetry?: boolean; guardManualStem?: boolean; expectedSource?:AutoRunSourceGuard };
};
const stage = new AsyncLocalStorage<{ outcome?: AutoRunOutcome }>();
/** 轮内只收集最终结果，整项任务保持running，避免切模型期间重复派发同句。 */
export function captureAutoRunOutcome(outcome: AutoRunOutcome) {
  const current = stage.getStore();
  if (!current) return false;
  current.outcome = currentAutoRunStage()?.stopRetry ? { ...outcome, options: {...outcome.options, noModelRetry:true} } : outcome; return true;
}
export async function runAutoRunModels(input: {
  model?: AutoRunStage["model"];
  attempt: () => Promise<void>;
  event: (model: AutoRunStage["model"], outcome?: AutoRunOutcome, stage?: AutoRunStage) => Promise<void>;
  canFallback: () => Promise<boolean>;
  canUseGapSplit?: () => Promise<boolean>;
  finish: (outcome: AutoRunOutcome) => Promise<void>;
}) {
  for (const index of [1, 2, 3] as const) {
    const config = autoRunStage(index, input.model);
    const current: {outcome?: AutoRunOutcome} = {};
    await withAutoRunStage(config, () => withChatModel(config.model, async () => {
      await input.event(config.model, undefined, config);
      await stage.run(current, input.attempt);
      const outcome = current.outcome;
      if (!outcome) throw new Error("模型工作流未返回最终结果，禁止当作通过");
      await input.event(config.model, outcome, config);
      if (outcome.status === "passed" || outcome.options?.noModelRetry || index === 3) {
        await input.finish(outcome); return;
      }
      if (!await input.canFallback()) {
        current.outcome = {status:"failed",error:"期间已人工锁定，停止后续整轮重跑",selected:null,options:{preserveSubtitle:true}};
        await input.finish(current.outcome); return;
      }
      if (index === 2 && !await input.canUseGapSplit?.()) {
        await input.finish(outcome); return;
      }
      current.outcome = undefined; // 明确表示进入下一轮，绝不带入旧稿或候选。
    }));
    if (current.outcome) return;
  }
}
