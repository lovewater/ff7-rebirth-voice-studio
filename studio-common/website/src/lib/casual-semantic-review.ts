import { naturalErhuaEquivalent, NATURAL_ERHUA_HINT } from "./spoken-text-review";
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

export function casualSemanticMessages(input:CasualSemanticInput) {
  const correction=correctAsrWords(input.candidateBodyChinese,input.asr,input.asrWordRules??[]);
  const reviewInput=correction.hits.length?{...input,rawAsr:input.asr,asr:correction.correctedText,asrWordCorrection:correction}:input;
  const correctionHint='用户配置的ASR词语纠错已按当前朗读稿的唯一对应位置应用。asr是核字使用的文字，rawAsr是保留的原始识别，asrWordCorrection记录明确命中。不得仅因已配置的别名再判人名变化或读音不确定；其余漏字、重复、替换仍严格检查。这不会改变TTS稿或字幕。';
  if(input.checkOriginalMeaning===false)return [{role:'system' as const,content:[
    NATURAL_ERHUA_HINT,correctionHint,
    '检查当前中文配音的实际ASR核字及读音风险。没有原始中文；modelTranslationBaseline仅是模型译文制作起稿，不能当原稿。',
    '不要比较当前稿与模型译文、日文或英文是否意思一致，也不要因改稿删改起稿的词语、对象或问句而拒绝；本分支不执行改稿对原中文语义校验。',
    '只比较实际ASR与打算朗读的当前稿是否完整、发音能否逐字或明确同音/发音表对应。实义近音、遗漏和低确定性仍不可放行；你没有听音频，不声称确实读错。',
    'JP保留片段不属于中文body ASR；必须维持既有组件恢复与音频SHA绑定。',
    '输出完整JSON：faithful=true、negationChanged=false、questionChanged=false、entityChanged=false、missingMeaning=[]、addedMeaning=[]、changedMeaning=[]，这些字段表示稿间语义检查不适用；readingEquivalent、needsHuman、readingUncertain、hardReadingRisk为布尔，reason为非空读音证据。',
  ].join('\n')},{role:'user' as const,content:JSON.stringify(reviewInput)}];
  return [{role:"system" as const,content:[
    NATURAL_ERHUA_HINT,correctionHint,
    "独立严格复核游戏普通中文配音。输入是原稿、当前稿、日文/可靠配对英文、日译中和英译中两份机器参考、邻句/人物名、实际新音频ASR与读音疑点；你没有听音频，不能声称读音确实错误。",
    "最终语义验收允许三选一：当前稿与原中文 originalChinese、日译中 japaneseChineseTranslation、英译中 englishChineseTranslation 中任意一份的核心意思接近且完整自然，就可以 faithful=true；不要求同时贴合三份，也不因与原中文措辞或翻译取舍不同而拒绝。输出 meaningReference=original-chinese、japanese-translation 或 english-translation，明确采用实际提供的哪一份，并在reason说明对应含义。缺失的译文不能选。日英原语言辅助理解；两份机器译文可能出错、不是绝对标准，但任一份能支持当前完整核心意图就可以作为通过依据。缺少所有可靠依据才交复核。",
    "以下语义检查均针对所选meaningReference，不是强行对比原中文：逐项检查否定/限定（不、没、只、才、已经等）、有义问句、说话对象/主客体、人物姓名/称谓、数量、条件、动作方向、语气意图。允许自然转述、合理省略和核心意思接近；不能只因字少、符合时长便放行与三份依据都无关、核心动作丢失或语义不闭合的稿。类似‘句够’等语义不闭合残句必须拒绝。",
    "允许中文自然的主语/代词省略与条件句压缩，但必须能从所选参考及可靠说话语境恢复同一主客体，且条件、否定、动作对象不变。不可机械把未复述‘我’判为缺义：例如说话者威胁对方时，‘敢动的话我就开枪！’→‘敢动就开枪！’可保留同一条件和开枪主体；‘我敢动就开枪’或换成他人开枪则不等价。不能用自然省略解释唯一问意、否定、姓名或实义限定被删除，也不能含糊换人。",
    "自然压缩示例：本条日文‘回復して 立て直す’、英文‘Heal up and regroup.’及两份中文参考均表达恢复状态后重整再战时，原稿‘必须治疗才能继续战斗’可自然压缩为‘恢复状态，重新战斗’或‘恢复后再战’；不得仅因未复述‘必须/才能/继续’判为条件丢失。按所选参考判断真正的必要条件、否定或对象是否改变，不因另一份参考的不同措辞重复否决。",
    "readingEquivalent独立比较实际ASR与打算朗读的当前稿：完全同音/明确发音表可等价；实义近音仍需谨慎。‘只能→是能’、‘干劲来了→赶紧来啦’不得仅凭近音一概过。",
    "readingUncertain/hardReadingRisk只判断当前候选稿与其ASR的读音证据，不把脚本相对原稿的省略/语义缺失误填成硬读音风险；脚本缺义写faithful=false及missingMeaning/changedMeaning。",
    "读音证据低确定性时readingUncertain/needsHuman必须true，不宣称ASR证明音频错；不能靠改写原文掩盖随机漏读或读音风险。",
    "保留JP拟声/环境片段不是中文body ASR，不能混入核字或当丢失正文借口；fullCandidateChinese用于检查最后恢复的完整字幕。",
    "只输出完整JSON：meaningReference为上述三项之一；faithful,readingEquivalent,needsHuman,readingUncertain,hardReadingRisk,negationChanged,questionChanged,entityChanged为布尔；missingMeaning,addedMeaning,changedMeaning为字符串数组；reason为非空证据说明。没有风险数组必须[]。只有全部语义忠实、实际ASR可等价且无不确定/风险才允许通过。",
  ].join("\n")},{role:"user" as const,content:JSON.stringify(reviewInput)}];
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
