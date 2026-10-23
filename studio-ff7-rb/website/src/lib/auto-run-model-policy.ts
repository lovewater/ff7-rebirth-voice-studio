import { AsyncLocalStorage } from "node:async_hooks";
import { withChatModel } from "./llm-model-context";
export type AutoRunOutcome = {
  status: "passed" | "failed"; error: string | null; selected: string | null;
  options?: { preserveSubtitle?: boolean };
};
const stage = new AsyncLocalStorage<{ outcome?: AutoRunOutcome }>();
/** 轮内只收集最终结果，整项任务保持running，避免切模型期间重复派发同句。 */
export function captureAutoRunOutcome(outcome: AutoRunOutcome) {
  const current = stage.getStore();
  if (!current) return false;
  current.outcome = outcome; return true;
}
export async function runAutoRunModels(input: {
  attempt: () => Promise<void>;
  event: (model: "primary" | "volcengine", outcome?: AutoRunOutcome) => Promise<void>;
  canFallback: () => Promise<boolean>;
  finish: (outcome: AutoRunOutcome) => Promise<void>;
}) {
  for (const model of ["primary", "volcengine"] as const) {
    await withChatModel(model, async () => {
      await input.event(model);
    });
    const current: {outcome?: AutoRunOutcome} = {};
    await withChatModel(model, () => stage.run(current, input.attempt));
    const outcome = current.outcome;
    if (!outcome) throw new Error("模型工作流未返回最终结果，禁止当作通过");
    await input.event(model, outcome);
    if (outcome.status === "passed" || model === "volcengine") {
      await withChatModel(model, () => input.finish(outcome)); return;
    }
    if (!await input.canFallback()) {
      await withChatModel(model, () => input.finish({status:"failed",error:"GLM未通过；期间已人工锁定，停止DeepSeek重跑",selected:null})); return;
    }
  }
}
