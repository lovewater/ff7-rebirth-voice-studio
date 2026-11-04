import { callChatCompletion } from "./llm-chat-client";
import { acceptedScriptParts } from "./accepted-script-polish";
import { scriptFromPolicyParts, validBodyScript, type BodyScriptPolicy } from "./two-part-script";

/** Optional work after a saved final has passed every hard gate. It creates candidates, never a winner. */
export function acceptedBeatOptimizationGate(input: {
  qualifiedFinal: boolean; ratio: number | null; band: {low:number;high:number};
  shortOrSlow: boolean; availableSlots: number;
}) {
  if(!input.qualifiedFinal)return '尚无最终验收合格成品';
  if(input.shortOrSlow)return '短句或日文慢速沿用原豁免，不为比值扩写';
  if(input.ratio==null||!Number.isFinite(input.ratio)||input.ratio<=0)return '没有可靠的归一拍数比';
  if(input.ratio>=input.band.low&&input.ratio<=input.band.high)return '比已在本句正常区间';
  if(input.availableSlots<3)return '本轮余量不足额外一批三条，保留合格池';
  return null;
}

export type AcceptedBeatOptimizationInput = {
  stem:string; qualifiedFinalId:string; script:string; requiredParts:number; policy:BodyScriptPolicy;
  normalizedRatio:number; textJp:string; textEn:string; originalChinese:string|null;
  japaneseChineseTranslation:string|null; englishChineseTranslation:string|null;
  speaker:string; noOriginalChinese:boolean;
};

export function validateAcceptedBeatParts(parts:unknown,requiredParts:number) {
  if(!Array.isArray(parts)||parts.length!==requiredParts||parts.some(x=>typeof x!=='string'||!x.trim()||/\[停顿|\r|\n/u.test(x)))return null;
  const policy:BodyScriptPolicy=requiredParts>1?'lines':'relaxed';
  const script=requiredParts===1?String(parts[0]).trim():scriptFromPolicyParts(parts,requiredParts,policy);
  return script&&validBodyScript(script,requiredParts,policy)?{script,policy}:null;
}

/** Exactly one proposal and, when actual original Chinese exists, one independent meaning review.
 * No TTS runs here. A successful proposal still has to pass fresh ASR, speed, parts and final assembly.
 * Missing-original mode keeps the previously authorized exception: no neighbor context or meaning comparison.
 */
export async function proposeAcceptedBeatOptimization(input:AcceptedBeatOptimizationInput):Promise<{changed:boolean;script?:string;policy?:BodyScriptPolicy;reason:string;meaningReview?:Record<string,unknown>}> {
  if(!input.qualifiedFinalId)throw Error('缺少已保存的合格成品');
  const originalParts=acceptedScriptParts(input.script,input.requiredParts,input.policy);
  if(!originalParts)return {changed:false,reason:'没有可靠的合格正文分片边界'};
  const request={...input,acceptedParts:originalParts,goal:input.normalizedRatio>1?'适当补足原意、减少拖慢感':'自然精简原意、减少字数负担'};
  const response=await callChatCompletion({task:'accepted-beat-optimization',stem:input.stem,attempts:1,temperature:.2,messages:[
    {role:'system',content:'当前已经有完整验收通过的中文配音，原合格候选会保留。只尝试一份自然、保义的优化稿，让归一拍数比更接近1；这是新增候选，不是自动替换原成品。比=(日文拍÷中文拍)÷1.20，大于1中文偏短，可补足日英原文已有的含义；小于1中文偏长，可自然精简。允许增减字数，保持给定分片数量、顺序及对应含义，不跨片搬句；片内可以保留自然标点。不要为凑比堆标点、重复、填充词或新增事实；保持否定、问意、人物、对象、条件、数量和语气。结合本句日英原文、原中文及两份机器译文，既有准确自然的核心用语尽量保留。无原中文时只用本句模型译文/日英，不加邻句，不把译文伪装原稿。输入为已清理正文，已经保留的原声拟声/环境片段不得加回。不要声称未合成的新稿已通过时长或听感。只输出JSON：parts为恰好指定数量的完整中文字符串数组，reason说明改善；没有自然改善就返回原parts。'},
    {role:'user',content:JSON.stringify(request)},
  ]});
  let draft:Record<string,unknown>;
  try{draft=JSON.parse(response.content);}catch{return {changed:false,reason:'优化稿JSON无效，保留合格池'};}
  const checked=validateAcceptedBeatParts(draft.parts,input.requiredParts);
  if(!checked)return {changed:false,reason:'优化稿分片协议无效，保留合格池'};
  if(checked.script===input.script||JSON.stringify(draft.parts)===JSON.stringify(originalParts))return {changed:false,reason:'模型没有提出新稿，保留合格池'};
  if(!input.noOriginalChinese) {
    const review=await callChatCompletion({task:'accepted-beat-meaning-review',stem:input.stem,attempts:1,temperature:.1,messages:[
      {role:'system',content:'独立检查游戏配音优化稿是否保义。只判断所给文字，不声称听到音频。当前已有合格中文正文，优化稿可增减字数、自然转述，但须保留各片原意、顺序、主客体、人物专名、否定、问意、条件、数量、动作和语气。对照本句原中文、已合格正文、日英原文及其两份参考译文；不得因追求比值而编造剧情、重复或加填充词。不机械要求复述原中文每个字；源文已有的含义可以自然展开。判断每个对应片是否忠实。只输出完整JSON：faithful、needsHuman为布尔；missingMeaning、addedMeaning、changedMeaning为字符串数组（没有则[]）；reason为非空说明。不能确认就needsHuman=true。'},
      {role:'user',content:JSON.stringify({originalChinese:input.originalChinese,acceptedParts:originalParts,candidateParts:draft.parts,japanese:input.textJp,english:input.textEn,japaneseChineseTranslation:input.japaneseChineseTranslation,englishChineseTranslation:input.englishChineseTranslation,speaker:input.speaker})},
    ]});
    let verdict:Record<string,unknown>;
    try{verdict=JSON.parse(review.content);}catch{return {changed:false,reason:'保义审核JSON无效，保留合格池'};}
    const arrays=['missingMeaning','addedMeaning','changedMeaning'];
    if(verdict.faithful!==true||verdict.needsHuman!==false||typeof verdict.reason!=='string'||!verdict.reason.trim()
      ||arrays.some(k=>!Array.isArray(verdict[k])||(verdict[k] as unknown[]).length!==0))return {changed:false,reason:'优化稿保义未通过，保留合格池',meaningReview:verdict};
    return {changed:true,...checked,reason:typeof draft.reason==='string'?draft.reason:'合格后新增优化候选',meaningReview:verdict};
  }
  return {changed:true,...checked,reason:typeof draft.reason==='string'?draft.reason:'合格后新增优化候选',meaningReview:{applicable:false,reason:'无原中文，沿用用户要求不比改稿原意，只用本句资料'}};
}

/** Eligibility has already been checked by the caller. There is deliberately no ratio-based adoption here. */
export function mergeQualifiedOptimizationPool<T extends {clip:{id:string}}>(original:T[],fresh:T[]) {
  const byId=new Map<string,T>();
  for(const item of [...original,...fresh])byId.set(item.clip.id,item);
  return [...byId.values()];
}
