"use client";

export function AutoRunMark({
  status,
}: {
  stem?: string;
  status: "running" | "passed" | "failed" | null;
  ttsId?: string | null;
  locked?: boolean;
  error: string | null;
}) {
  if (status === "running") {
    return <div className="text-xs text-zinc-500">运行中</div>;
  }
  return null;
}
