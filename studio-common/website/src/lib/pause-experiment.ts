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
  gaps?: {start:number;end:number}[];
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
  alignmentStatus?: string;
  partTimings?: {index:number;factor:number;deltaSeconds:number;status:string}[];
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

/** 三段实验独立快照，和原两段实验互不覆盖；只读数据不触发任何推理。 */
export async function readThreePartExperiment():Promise<PauseExperimentSnapshot|null>{
  try{
    const raw=await readFile(path.join(process.cwd(),"data","experiments","three-part-alignment-v1","snapshot.json"),"utf8");
    const snapshot=JSON.parse(raw) as PauseExperimentSnapshot;
    return snapshot.version==='three-part-alignment-v1'&&Array.isArray(snapshot.items)?snapshot:null;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
