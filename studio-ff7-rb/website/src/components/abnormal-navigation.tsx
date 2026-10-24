"use client";
import { createContext, useContext } from "react";
export type AbnormalNavigation = {
  previousHref: string | null; nextHref: string | null; position: number | null; total: number;
  refresh: () => void;
};
export const AbnormalNavigationContext = createContext<AbnormalNavigation | null>(null);
export const useAbnormalNavigation = () => useContext(AbnormalNavigationContext);
