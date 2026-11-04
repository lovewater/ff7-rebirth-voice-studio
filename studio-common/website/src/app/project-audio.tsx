"use client";
import { createContext, useContext, type ReactNode } from "react";
const OriginalChineseAudio = createContext(true);
export function ProjectAudioProvider({ hasOriginalChineseAudio, children }: { hasOriginalChineseAudio: boolean; children: ReactNode }) {
  return <OriginalChineseAudio.Provider value={hasOriginalChineseAudio}>{children}</OriginalChineseAudio.Provider>;
}
export function useOriginalChineseAudio() { return useContext(OriginalChineseAudio); }
