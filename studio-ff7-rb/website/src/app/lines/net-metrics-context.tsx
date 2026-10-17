"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { SpeechComparison } from "@/lib/speech-metrics";
const Context = createContext<Record<string, SpeechComparison>>({});
export function NetMetricsProvider({ initial, children }: { initial: Record<string, SpeechComparison>; children: ReactNode }) {
  return <Context.Provider value={initial}>{children}</Context.Provider>;
}
export function useInitialNetMetrics(stem: string, id?: string) {
  return useContext(Context)[JSON.stringify([stem, id])];
}
