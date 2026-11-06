import { AsyncLocalStorage } from "node:async_hooks";
export const AUTO_RUN_MODEL = "grok" as const;
export type AutoRunModel = "grok" | "primary";
export type AutoRunStageIndex = 1 | 2 | 3;
export type AutoRunStage = { index: AutoRunStageIndex; model: AutoRunModel; allowGapSplit: boolean; limit: 24; stopRetry?: boolean };
const storage = new AsyncLocalStorage<AutoRunStage>();
export function autoRunStage(index: AutoRunStageIndex, model: AutoRunModel = AUTO_RUN_MODEL): AutoRunStage {
  return { index, model, allowGapSplit: index === 3, limit: 24 };
}
export function currentAutoRunStage() { return storage.getStore(); }
export function withAutoRunStage<T>(stage: AutoRunStage, fn: () => T): T { return storage.run(stage, fn); }

export function stopAutoRunRetries() { const stage = storage.getStore(); if (stage) stage.stopRetry = true; }
