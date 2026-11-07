import { naturalErhuaEquivalent } from "./spoken-text-review";
import { createHash } from "node:crypto";
import { correctAsrWords, asrComparisonBody, type AsrWordRule, type AsrWordCorrection } from "./asr-word-corrections";

export type CasualSemanticInput = {
  originalChinese:string;originalBodyChinese:string;candidateBodyChinese:string;fullCandidateChinese:string;
  sourceStage:"original"|"rewrite"|"reused-original";
  asr:string;audioSha256:string;pronunciationNotes:string[];literalReading:boolean;dictionaryReading:boolean;naturalErhuaReading?:boolean;
  // Full-line machine translations are references for the same source, never additional dialogue context.
  japaneseChineseTranslation?:string|null;englishChineseTranslation?:string|null;
  japanese:string;english:string|null;sourceEvidence:unknown;context:unknown;properNames:unknown;preservedOriginal:unknown;
  /** Only a verified model-translation baseline with absent actual original Chinese may disable meaning comparison.
   * Actual ASR/reading, timing, component restoration and source/SHA binding remain mandatory.
   */
  checkOriginalMeaning?:boolean;modelTranslationBaseline?:string;modelTranslationSourceHash?:string;
  asrWordRules?:AsrWordRule[];
};
export type CasualSemanticEvidence = {
  version:1;policy:string;passed:boolean;kind:"verbatim"|"reviewed"|"meaning"|"reading"|"uncertain";needsHuman:boolean;
  reason:string;feedback:string;originalHash:string;bodyOriginalHash:string;candidateBodyHash:string;fullCandidateHash:string;
  asrHash:string;audioSha256:string;inputHash:string;review?:Record<string,unknown>;finalAudioSha256?:string;
  readingEquivalence?:'natural-erhua-v1'|'asr-word-corrections-v1';
  asrWordCorrection?:AsrWordCorrection;
  meaningReference?:"original-chinese"|"japanese-translation"|"english-translation";
  originalMeaningChecked?:boolean;modelTranslationBaselineHash?:string;modelTranslationSourceHash?:string;
};
export const casualMeaningBody=(text:string)=>text.replace(/[\s\p{P}\p{S}]/gu,"");
export const casualMeaningHash=(text:string)=>createHash("sha256").update(text).digest("hex");
export function casualQuestionSignature(text:string) {
  let bodyPosition=0;const positions:number[]=[];
  for(const c of text){if(c==='?'||c==='？')positions.push(bodyPosition);else if(!/[\s\p{P}\p{S}]/u.test(c))bodyPosition++;}
  return positions.join(',');
}
function binding(input:CasualSemanticInput) {
  const correction=correctAsrWords(input.candidateBodyChinese,input.asr,input.asrWordRules??[]);
  return {version:1 as const,policy:input.checkOriginalMeaning===false?'model-translation-reading-only-v1':"strict-meaning-reading-bilingual-reference-v3",
    originalMeaningChecked:input.checkOriginalMeaning!==false,
    ...(input.checkOriginalMeaning===false?{modelTranslationBaselineHash:casualMeaningHash(input.modelTranslationBaseline??''),modelTranslationSourceHash:input.modelTranslationSourceHash}:{}),
    originalHash:casualMeaningHash(input.originalChinese),bodyOriginalHash:casualMeaningHash(input.originalBodyChinese),
    candidateBodyHash:casualMeaningHash(input.candidateBodyChinese),fullCandidateHash:casualMeaningHash(input.fullCandidateChinese),
    asrHash:casualMeaningHash(input.asr),audioSha256:input.audioSha256,inputHash:casualMeaningHash(JSON.stringify(input)),
    ...(correction.hits.length?{asrWordCorrection:correction}:{})};
}

/** Only verbatim reading, explicit dictionary equivalence or proven natural erhua can bypass the independent semantic/reading review.
 * Question punctuation is kept in the review input: compact text must not erase a meaningful question.
 */
export function fastCasualSemanticEvidence(input:CasualSemanticInput):CasualSemanticEvidence|null {
  const correction=correctAsrWords(input.candidateBodyChinese,input.asr,input.asrWordRules??[]);
  const configuredReading=correction.hits.length>0&&asrComparisonBody(correction.correctedText)===asrComparisonBody(input.candidateBodyChinese);
  const erhuaReading=input.naturalErhuaReading===true&&naturalErhuaEquivalent(input.candidateBodyChinese,correction.correctedText);
  const equivalence=configuredReading?{readingEquivalence:'asr-word-corrections-v1' as const}:erhuaReading?{readingEquivalence:'natural-erhua-v1' as const}:{};
  if(input.checkOriginalMeaning===false) {
    if(input.originalChinese.trim()||!input.modelTranslationBaseline?.trim()||!input.modelTranslationSourceHash||input.pronunciationNotes.length||(!input.literalReading&&!input.dictionaryReading&&!erhuaReading&&!configuredReading))return null;
    const preserved=input.preservedOriginal as {prefix?:unknown;suffix?:unknown}|null;
    if(preserved&&typeof preserved.prefix==='string'&&typeof preserved.suffix==='string'
      &&input.fullCandidateChinese!==preserved.prefix+input.candidateBodyChinese+preserved.suffix)return null;
    return {...binding(input),...equivalence,passed:true,kind:'verbatim',needsHuman:false,reason:'无原始中文：仅确认当前成稿被新ASR逐字、按发音表、ASR词语纠错或自然儿化完整读出，不比较改稿与模型译文的意思',feedback:''};
  }
  if(input.sourceStage==='rewrite'||casualMeaningBody(input.originalBodyChinese)!==casualMeaningBody(input.candidateBodyChinese)
    || casualQuestionSignature(input.originalBodyChinese)!==casualQuestionSignature(input.candidateBodyChinese)
    || casualMeaningBody(input.originalChinese)!==casualMeaningBody(input.fullCandidateChinese)
    || casualQuestionSignature(input.originalChinese)!==casualQuestionSignature(input.fullCandidateChinese)
    || input.pronunciationNotes.length || (!input.literalReading&&!input.dictionaryReading&&!erhuaReading&&!configuredReading))return null;
  return {...binding(input),...equivalence,passed:true,kind:"verbatim",needsHuman:false,reason:"原稿正文未改且新ASR逐字、明确发音表、ASR词语纠错或自然儿化对应",feedback:""};
}

/** 终审提示词在 prompt_templates，按 key 取最新启用版本。正文不放在代码里。 */
export function casualSemanticMessages(input:CasualSemanticInput) {
  const correction=correctAsrWords(input.candidateBodyChinese,input.asr,input.asrWordRules??[]);
  const reviewInput=correction.hits.length?{...input,rawAsr:input.asr,asr:correction.correctedText,asrWordCorrection:correction}:input;
  const inputJson=JSON.stringify(reviewInput);
  return [
    {role:"system" as const,content:"",promptKey:input.checkOriginalMeaning===false?"casual-semantic-review.no-original.system":"casual-semantic-review.system"},
    {role:"user" as const,content:inputJson,promptKey:"casual-semantic-review.input",promptValues:{input_json:inputJson}},
  ];
}

/** Fail closed for missing schema, uncertainty, semantic loss, or substantive reading risk. */
export function parseCasualSemanticEvidence(parsed:Record<string,unknown>,input:CasualSemanticInput):CasualSemanticEvidence {
  const changed=input.sourceStage==='rewrite'||casualMeaningBody(input.originalBodyChinese)!==casualMeaningBody(input.candidateBodyChinese)
    ||casualQuestionSignature(input.originalBodyChinese)!==casualQuestionSignature(input.candidateBodyChinese);
  const uncertain=(reason:string):CasualSemanticEvidence=>({...binding(input),passed:false,kind:"uncertain",needsHuman:true,reason,feedback:reason,review:parsed});
  const booleans=["faithful","readingEquivalent","needsHuman","readingUncertain","hardReadingRisk","negationChanged","questionChanged","entityChanged"];
  if(booleans.some(key=>typeof parsed[key]!=="boolean"))return uncertain("语义终审布尔证据不完整，不能自动锁定");
  const arrays=["missingMeaning","addedMeaning","changedMeaning"];
  if(arrays.some(key=>!Array.isArray(parsed[key])||(parsed[key] as unknown[]).some(value=>typeof value!=="string"||!value.trim())))
    return uncertain("语义终审风险数组无效，不能自动锁定");
  if(typeof parsed.reason!=="string"||!parsed.reason.trim())return uncertain("语义终审缺少证据说明，不能自动锁定");
  const questionCue=(text:string)=>/[?？吗呢]|是否|能不能|要不要|可不可以|怎么|为何|为什么|什么|哪|谁|几|多少|何时/u.test(text);
  const checkMeaning=input.checkOriginalMeaning!==false;
  if(!checkMeaning&&(input.originalChinese.trim()||!input.modelTranslationBaseline?.trim()||!input.modelTranslationSourceHash))return uncertain('缺少可信的缺原中文模型译稿分支，不能跳过原中文语义校验');
  // A translation may be the accepted semantic basis. Do not force the original Chinese question
  // onto a declarative source translation; the chosen reference must actually exist in this request.
  const requestedReference=typeof parsed.meaningReference==='string'?parsed.meaningReference:'original-chinese';
  if(checkMeaning&&!['original-chinese','japanese-translation','english-translation'].includes(requestedReference))return uncertain('语义依据类型无效');
  const referenceText=requestedReference==='japanese-translation'?input.japaneseChineseTranslation
    :requestedReference==='english-translation'?input.englishChineseTranslation:input.originalBodyChinese;
  if(checkMeaning&&!referenceText?.trim())return uncertain('审核选择的中文语义依据不存在，不能通过');
  const lostQuestion=checkMeaning&&/[?？]/u.test(referenceText??'')&&!questionCue(input.candidateBodyChinese);
  const preserved=input.preservedOriginal as {prefix?:unknown;suffix?:unknown}|null;
  const badRestoration=preserved&&typeof preserved.prefix==='string'&&typeof preserved.suffix==='string'
    && input.fullCandidateChinese!==preserved.prefix+input.candidateBodyChinese+preserved.suffix;
  const meaningLoss=badRestoration||(checkMeaning&&(lostQuestion||parsed.faithful!==true||parsed.negationChanged||parsed.questionChanged||parsed.entityChanged
    ||arrays.some(key=>(parsed[key] as string[]).length>0)));
  const readingRisk=parsed.readingEquivalent!==true||parsed.readingUncertain||parsed.hardReadingRisk;
  const passed=!meaningLoss&&!readingRisk&&parsed.needsHuman===false;
  // Identical intended words cannot be repaired by deleting text; uncertain reading retries the same script.
  const kind=passed?"reviewed":changed&&meaningLoss?"meaning":readingRisk||!changed?"reading":"uncertain";
  const feedback=[...(lostQuestion?["原稿问意标记消失且当前稿无问句证据"]:[]),...(badRestoration?["保留片段文字恢复不闭合或重复"]:[]),parsed.reason,...arrays.flatMap(key=>parsed[key] as string[])].join("；");
  return {...binding(input),...(checkMeaning?{meaningReference:requestedReference as NonNullable<CasualSemanticEvidence['meaningReference']>}:{}),passed,kind,needsHuman:!passed,reason:parsed.reason,feedback,review:parsed};
}

export function semanticEvidenceMatchesFinal(evidence:CasualSemanticEvidence|undefined,original:string,fullCandidate:string,
  finalAudioSha256:string,reviewedBodySha256:string) {
  return evidence?.passed===true&&evidence.needsHuman===false&&evidence.originalHash===casualMeaningHash(original)
    &&evidence.fullCandidateHash===casualMeaningHash(fullCandidate)&&evidence.audioSha256===reviewedBodySha256
    &&(evidence.finalAudioSha256??evidence.audioSha256)===finalAudioSha256;
}
