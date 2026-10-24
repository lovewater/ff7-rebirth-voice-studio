"use client";
import { useSyncExternalStore, type ReactNode } from "react";
const query = "(max-width: 767px), (pointer: coarse)";
function subscribe(fn: () => void) {
  const media = window.matchMedia(query); media.addEventListener("change", fn);
  return () => media.removeEventListener("change", fn);
}
export function ResponsiveAbnormalBody({ desktop, mobile }: { desktop: ReactNode; mobile: ReactNode }) {
  const isMobile = useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
  return isMobile ? mobile : <div data-abnormal-desktop>{desktop}</div>;
}
