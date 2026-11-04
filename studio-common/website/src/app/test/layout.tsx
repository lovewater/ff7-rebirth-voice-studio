import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { gameProfile } from "@/lib/game-profile";

export const dynamic = "force-dynamic";

export default function HistoricalExperimentLayout({ children }: { children: ReactNode }) {
  if (gameProfile().id !== "rebirth") notFound();
  return children;
}
