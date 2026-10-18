import { readFile } from "node:fs/promises";
import path from "node:path";

export type PauseTrack = {
  key: "jp" | "reference" | "previous" | "result" | "gold";
  label: string;
  id?: string;
  src: string;
  text: string;
  duration: number;
  peaks: number[];
  parts: number;
  rewritten: boolean;
  gap: { start: number; end: number } | null;
};

export type PauseExperimentItem = {
  stem: string;
  speaker: string;
  group: string;
  runId: string | null;
  status: string;
  error: string | null;
  openingDeltaMs: number | null;
  tracks: PauseTrack[];
};

export type PauseExperimentSnapshot = {
  version: string;
  updatedAt: string;
  planned: number;
  completed: number;
  excluded: string[];
  items: PauseExperimentItem[];
};

/** 实验报告由离线脚本更新；请求页面只读取波形摘要，不触发ASR、TTS或模型调用。
 * data不进Git。没有报告时显示准备中，避免构建/部署依赖本机实验数据。
 */
export async function readPauseExperiment(): Promise<PauseExperimentSnapshot | null> {
  try {
    const raw = await readFile(path.join(process.cwd(), "data", "experiments", "pause-alignment-v3", "snapshot.json"), "utf8");
    const snapshot = JSON.parse(raw) as PauseExperimentSnapshot;
    if (snapshot.version !== "pause-alignment-v3" || !Array.isArray(snapshot.items)) return null;
    return snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
