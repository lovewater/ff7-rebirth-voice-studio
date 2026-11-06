import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "./db";
import { audioFileToMonoWav, audioToMonoWav } from "./audio-splice";
import { parseWavPcm16 } from "./tts-gpu";
import { buildSpeechReference } from "./tts-reference";
import { tailBodyAudio, type PreservedTail } from "./preserved-tail";
import { assemblePreserved } from "./auto-run-two-parts";
import { planSpliceAfterTts, type OnoPlan, type TimeSpan } from "./auto-run-onomatopoeia";
import { subtitleRestorePlan, restorePerformanceSubtitle } from "./auto-run-subtitle";
import { extractCasualBodyReference, assembleCasualOriginalEdges, restoreCasualScript, type CasualAudioCleanupPlan } from "./casual-audio-cleanup";
import { decodeWavMono } from "./wav-stretch";
import { alignCasualBodyToReference } from "./casual-body-alignment";
import { needsChineseCutAxis } from "./tts-local-asr";
import { seedAsr, type SeedAsrResult } from "./seed-asr";

export type SplitCloneLine = { stem: string; text_jp: string | null; text_zh: string | null; extra?: unknown };
type Event = { step: string; payload: Record<string, unknown> };
export type SplitCloneContext = {
  runId: string; promptPath: string; original: Buffer; reference: Buffer;
  originalSha256: string; referenceSha256: string; removedSeconds: number;
  sourceScript: string; bodyText: string;
} & ({ kind: "scene"; plan: OnoPlan } | { kind: "casual"; plan: CasualAudioCleanupPlan });
export const splitCloneSummary = (context: SplitCloneContext) => ({ runId: context.runId, bodyText: context.bodyText, removedSeconds: context.removedSeconds });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const textKey = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "");
function samePcm(left: Buffer, right: Buffer) {
  const a = parseWavPcm16(left), b = parseWavPcm16(right);
  return a.sampleRate === b.sampleRate && a.blockAlign === b.blockAlign
    && left.subarray(a.dataOffset, a.dataOffset+a.dataBytes).equals(right.subarray(b.dataOffset,b.dataOffset+b.dataBytes));
}
function spans(value: unknown): TimeSpan[] {
  if (!Array.isArray(value)) throw new Error("缺少AI切分区间");
  return value.map(span => {
    if (!span || !Number.isFinite(span.startMs) || !Number.isFinite(span.endMs) || span.startMs < 0 || span.endMs <= span.startMs)
      throw new Error("AI切分区间无效");
    return span as TimeSpan;
  });
}

/** Only the latest AI run and its registered reference are eligible; no model/ASR is run to show the button. */
export async function loadSplitClone(line: SplitCloneLine, expectedRunId?: string): Promise<SplitCloneContext | null> {
  const [run] = await sql<{ id: string; status: string; reference_audio_path: string | null; reference_text_jp: string | null }[]>`
    SELECT id::text, status, reference_audio_path, reference_text_jp FROM line_auto_runs
    WHERE stem=${line.stem} ORDER BY id DESC LIMIT 1`;
  if (!run || run.status === "running" || (expectedRunId && run.id !== expectedRunId)) return null;
  if (!run.reference_audio_path || !run.reference_audio_path.startsWith(`tts/${line.stem}/`) || run.reference_audio_path.split("/").includes("..")) return null;
  const events = await sql<Event[]>`SELECT step,payload FROM line_auto_run_events WHERE run_id=${run.id}
    AND step IN ('reference','ono','segment','casual-clean-reference','preserved-tail','subtitle-plan') ORDER BY id DESC`;
  const referenceEvent = events.find(event => ["reference","casual-clean-reference"].includes(event.step) && event.payload?.promptPath === run.reference_audio_path);
  if (!referenceEvent) return null;
  const payload = referenceEvent.payload;
  const stageEvents = events.filter(event => event.payload?.stage === payload.stage);
  const root = path.join(process.cwd(), "data");
  const sourceBytes = await readFile(path.join(root,"jp",`${line.stem}.mp3`));
  const original = referenceEvent.step === "casual-clean-reference"
    ? await audioFileToMonoWav(path.join(root,"jp",`${line.stem}.mp3`)) : await audioToMonoWav(sourceBytes);
  const reference = await readFile(path.join(root,run.reference_audio_path));
  const expectedSource = (line.extra as {audio_sources?:{jp?:{clip?:{mp3_sha256?:string}}}} | null)?.audio_sources?.jp?.clip?.mp3_sha256;
  if (expectedSource && hash(sourceBytes) !== expectedSource) return null;
  const [snapshot] = await sql<{jp_text_snapshot:string|null;game_zh_text_snapshot:string|null}[]>`
    SELECT jp_text_snapshot,game_zh_text_snapshot FROM line_tts_versions
    WHERE auto_run_id=${run.id} AND status='ready' ORDER BY id DESC LIMIT 1`;
  if (snapshot && (snapshot.jp_text_snapshot !== line.text_jp || snapshot.game_zh_text_snapshot !== line.text_zh)) return null;
  const sourceLayout=parseWavPcm16(original), referenceLayout=parseWavPcm16(reference);
  const removedSeconds=sourceLayout.frames/sourceLayout.sampleRate-referenceLayout.frames/referenceLayout.sampleRate;
  if (!(removedSeconds > .001)) return null;
  const base={runId:run.id,promptPath:run.reference_audio_path,original,reference,originalSha256:hash(sourceBytes),referenceSha256:hash(reference),removedSeconds};
  if (referenceEvent.step === "casual-clean-reference") {
    const plan = payload.plan as CasualAudioCleanupPlan;
    if (!plan?.enabled || !plan.preserved?.length || hash(reference)!==payload.sha256 || !samePcm(extractCasualBodyReference(original,plan),reference)) return null;
    return {...base,kind:"casual",plan,sourceScript:plan.originalTextZh,bodyText:plan.bodyTextZh};
  }
  const ono=stageEvents.find(event => event.step === "ono" && Array.isArray(event.payload?.speech))?.payload;
  const segment=stageEvents.find(event => event.step === "segment")?.payload;
  if (!ono || !segment || !Array.isArray(segment.segments) || segment.segments.some(span => span.kind === "unknown")) return null;
  const subtitle=stageEvents.find(event => event.step === "subtitle-plan")?.payload;
  const sourceScript=typeof subtitle?.sourceScript === "string" ? subtitle.sourceScript : line.text_zh ?? "";
  const bodyText=typeof ono.cnTtsText === "string" ? ono.cnTtsText : "";
  if (!bodyText.trim()) return null;
  const tail=stageEvents.find(event => event.step === "preserved-tail")?.payload as PreservedTail | undefined;
  const plan:OnoPlan={enabled:ono.enabled===true,reason:String(ono.reason??""),thinking:"",speech:spans(ono.speech),onomatopoeia:spans(ono.onomatopoeia),ambient:spans(ono.ambient),
    cnTtsText:bodyText,originalCnTtsText:bodyText,jpSpeechText:run.reference_text_jp??"",subtitleRestore:subtitleRestorePlan(sourceScript,bodyText),...(tail?{preservedTail:tail}: {})};
  if (!plan.speech.length) return null;
  const body=tail?tailBodyAudio(original,tail):original;
  const built=buildSpeechReference(body,parseWavPcm16(body),{...plan,preservedTail:undefined});
  if (!samePcm(built.audio,reference)) return null;
  const actualSpans=[...plan.speech,...plan.onomatopoeia,...plan.ambient];
  if (actualSpans.some(span=>span.endMs>parseWavPcm16(body).frames/parseWavPcm16(body).sampleRate*1000+1)) return null;
  return {...base,kind:"scene",plan,sourceScript,bodyText};
}

/** Exact saved full scripts can be reduced safely. Edited scripts are treated as body drafts. */
export function splitCloneBodyText(context: SplitCloneContext, requested: string) {
  if (textKey(requested) === textKey(context.sourceScript)) return context.bodyText;
  let text=requested.trim();
  const restore=context.kind==="scene"?context.plan.subtitleRestore:subtitleRestorePlan(context.sourceScript,context.bodyText);
  for (const part of restore.preserved) {
    if (part.at===0 && text.startsWith(part.text)) text=text.slice(part.text.length).trimStart();
    else if (part.at===restore.bodyCharacters && text.endsWith(part.text)) text=text.slice(0,-part.text.length).trimEnd();
    else if (text.includes(part.text)) throw new Error("请在实际TTS文字中仅保留中文正文；已切出的原声无需重复朗读");
  }
  if (!text.trim()) throw new Error("切分后的中文正文为空");
  return text;
}

/** Reuses the AI workflow's original-preserving assemblers; no new classification or script rewrite. */
export async function assembleSplitClone(context: SplitCloneContext, bodyAudio: Buffer, bodyText: string, cachedAxis?: SeedAsrResult) {
  const body=await audioToMonoWav(bodyAudio);
  if (context.kind==="casual") {
    const aligned=alignCasualBodyToReference(body,context.reference,parseWavPcm16(context.reference).frames/24000);
    const result=assembleCasualOriginalEdges(context.original,aligned.audio,context.plan);
    return {audio:result.audio,metadata:{...result.metadata,bodyAlignment:aligned.meta},restoredText:restoreCasualScript(context.plan,bodyText)};
  }
  const decoded=decodeWavMono(body);
  const axis=cachedAxis ?? (needsChineseCutAxis(bodyText,context.plan.onomatopoeia,context.plan.ambient)
    ? await seedAsr(body.toString("base64"),"wav","zh-CN")
    : {text:bodyText,language:"zh-CN" as const,durationMs:decoded.samples.length/decoded.sampleRate*1000,status:"not-needed",message:"",words:[],utterances:[],raw:null});
  const splice=await planSpliceAfterTts({...context.plan,cnAsr:axis,cnAudio:decoded,cnTtsText:bodyText});
  if (splice.cutMethod==="unreliable-alignment") throw new Error("中文字轴不能可靠定位切口，未将正文当作完整成品");
  const target=parseWavPcm16(context.original);
  const mixed=assemblePreserved(context.original,body,context.plan,splice.pieces,target.frames/target.sampleRate,context.reference);
  if (!mixed.ok) throw new Error("回拼后未通过完整时长检查");
  return {audio:mixed.audio,metadata:{fit:mixed.fit,splice:splice.pieces,cutMethod:splice.cutMethod},restoredText:restorePerformanceSubtitle(context.plan.subtitleRestore,bodyText)};
}
