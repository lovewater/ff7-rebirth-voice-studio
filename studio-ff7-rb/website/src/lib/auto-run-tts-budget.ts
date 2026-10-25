import { sql } from "./db";
import { closestFallback } from "./auto-run-fallback";

export const AUTO_TTS_LIMIT = 30;
export const AUTO_TTS_LIMIT_MESSAGE = "自动任务TTS累计已达30条上限，已强制停止，所选候选待复核";
export class AutoTtsBudgetError extends Error {
  readonly code = "AUTO_TTS_LIMIT";
  constructor() { super(AUTO_TTS_LIMIT_MESSAGE); }
}
export function isAutoTtsBudgetError(error: unknown): boolean {
  return error instanceof AutoTtsBudgetError || (error instanceof Error && error.message.startsWith(AUTO_TTS_LIMIT_MESSAGE));
}

/** GPU调用前按runId持久预占；跨轮次/模型共享，失败调用也占额，拼接/编辑副本不占额。 */
export async function reserveAutoTtsSlots(runId: string, stem: string, requested: number) {
  return sql.begin(async tx => {
    const [run] = await tx`SELECT id FROM line_auto_runs WHERE id=${runId} AND stem=${stem} AND status='running' FOR UPDATE`;
    if (!run) throw new Error("自动运行已结束或不属于这条台词");
    const [usage] = await tx<{used:number}[]>`
      SELECT GREATEST(
        COALESCE((SELECT max((payload->>'used')::int) FROM line_auto_run_events WHERE run_id=${runId} AND step='tts-budget-reserve'),0),
        (SELECT count(*)::int FROM line_tts_versions WHERE auto_run_id=${runId} AND voice_gpu_key LIKE 'zeroshot-%')
      ) AS used`;
    const before = Number(usage?.used ?? 0);
    const count = Math.min(Math.max(0, AUTO_TTS_LIMIT-before), Math.max(0, Math.floor(requested)));
    if (!count) throw new AutoTtsBudgetError();
    const budget = {limit:AUTO_TTS_LIMIT, before, count, used:before+count, exhausted:before+count>=AUTO_TTS_LIMIT};
    await tx`INSERT INTO line_auto_run_events(run_id,step,level,message,payload)
      VALUES(${runId},'tts-budget-reserve','info',${`TTS额度 ${budget.used}/${AUTO_TTS_LIMIT}（本批${count}条）`},${tx.json(budget)})`;
    return budget;
  });
}

type BudgetCandidate = {id:string;dur_s:number|null;target:number|null;conversion_meta: {
  attempt_feedback?: {status?:string;missingChecks?:string[];issues?:{code:string;severity:string}[]};
  duration_review?: {textPassed?:boolean};
  auto_run_gap_alignment?: {parts?:{deltaSeconds:number}[]};
} | null};
/** 不再合成或调用模型，从本任务两轮所有已保存可播放候选中按既有核字优先规则选一条。 */
export function chooseBudgetFallback(rows: BudgetCandidate[]) {
  return closestFallback(rows.map(row => {
    const feedback=row.conversion_meta?.attempt_feedback;
    const reviewed=!!feedback && ["accepted","warning","rejected"].includes(feedback.status??"")
      && !feedback.missingChecks?.some(check=>check.includes("校字"));
    const parts=row.conversion_meta?.auto_run_gap_alignment?.parts;
    return {...row,reviewed:reviewed||row.conversion_meta?.duration_review?.textPassed===true,
      hardIssueCount:feedback?.issues?.filter(issue=>/^text-/.test(issue.code)&&!["text-too-few","text-too-many"].includes(issue.code)).length??0,
      pronunciationIssueCount:0,paceDeviation:null,
      durationDeviation:parts?.length && parts.every(part=>Number.isFinite(part.deltaSeconds))
        ? parts.reduce((sum,part)=>sum+Math.abs(part.deltaSeconds),0)
        : row.dur_s!=null&&row.target!=null?Math.abs(row.dur_s-row.target):null};
  }));
}
export async function autoTtsBudgetFallback(runId: string) {
  const rows=await sql<BudgetCandidate[]>`
    SELECT v.id::text,v.dur_s,m.jp_dur_s AS target,v.conversion_meta
    FROM line_tts_versions v LEFT JOIN line_meta m USING(stem)
    WHERE v.auto_run_id=${runId} AND v.status='ready' AND v.audio_path IS NOT NULL AND v.review_state<>'abnormal'
    ORDER BY v.id`;
  return chooseBudgetFallback(rows);
}
