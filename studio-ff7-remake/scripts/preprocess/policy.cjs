// Remake-only pure policy. No production env loading and no network side effects.
const crypto=require('node:crypto'),path=require('node:path');
const common=path.resolve(__dirname,'../../..','studio-common/website');
const {parseTranslation,translationTokenLimit}=require(path.join(common,'scripts/translation/output-policy.cjs'));
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)||value instanceof Uint8Array?value:JSON.stringify(value)).digest('hex');
const body=text=>String(text??'').replace(/[\s\p{P}\p{S}]/gu,'');
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
function strictObject(content,keys){let x;try{x=JSON.parse(content);}catch{throw Error('invalid-json');}if(!x||Array.isArray(x)||typeof x!=='object'||Object.keys(x).sort().join()!==[...keys].sort().join())throw Error('invalid-json-fields');return x;}
function parseIndependentTranslation(content,source){
 if(source.trim())return {text:parseTranslation(content,source),state:'translated'};
 const parsed=strictObject(content,['translation']);
 if(parsed.translation!=='')throw Error('empty-source-invented-translation');
 return {text:'',state:'untranslatable_empty'};
}
function parseAsr(value){
 if(value?.success!==true||!Array.isArray(value.results)||value.results.length!==1||typeof value.results[0]?.text!=='string')throw Error('asr-invalid-response');
 const language=value.results[0].language;
 if(language&& !['japanese','ja','日本語'].includes(String(language).toLowerCase()))throw Error('asr-language-mismatch');
 return {text:value.results[0].text,raw:value,language:'Japanese',state:value.results[0].text.trim()?'recognized':'empty'};
}
function performanceKey(e){const asset=e?.voice_asset??'',cut=asset.match(/\/Cut\/([^/]+\/[^/]+)\//);if(cut)return 'cut:'+cut[1];const names=[...new Set((e?.events??[]).map(x=>x.event).filter(Boolean))].sort();return names.length?'event:'+names.join('|'):null;}
// This is a read-only projection: never replace a non-null human/official evidence value in PostgreSQL.
function contextualize(line){
 if(!line||line.dialogue_evidence!=null)return line;
 const sources=line.extra?.audio_sources;
 const asset=line.extra?.audio_extraction?.missing_jp!==true&&nonempty(sources?.jp?.path)?sources.jp.path:nonempty(sources?.en?.path)?sources.en.path:null;
 return asset&&/\/Cut\/[^/]+\/[^/]+\//.test(asset)?{...line,dialogue_evidence:{voice_asset:asset}}:line;
}
function pairingManifest(extra){
 const value=extra?.jp_pairing_unresolved;
 if(extra?.audio_extraction?.jp_pairing_unresolved!==true||!value||value.version!=='jp-whole-cue-pairing-v1'||value.proof?.game_resource_missing!==false)return null;
 const stems=value.jp_candidate_stems,clips=value.jp_candidates;
 if(!Array.isArray(stems)||!stems.length||!Array.isArray(clips)||new Set(stems).size!==stems.length||new Set(clips.map(x=>x?.stem)).size!==clips.length)return null;
 if(stems.some(stem=>typeof stem!=='string'||!/^[\w.-]+$/.test(stem)))return null;
 const candidates=stems.map(stem=>clips.find(clip=>clip?.stem===stem));
 if(candidates.some((clip,i)=>!clip||clip.audio_path!==`jp/${stems[i]}.mp3`||!Array.isArray(value.jp_candidate_paths)||!value.jp_candidate_paths.includes(clip.audio_path)||!/^[a-f0-9]{64}$/i.test(clip.mp3_sha256??'')))return null;
 return {value,stems,candidates,input_hash:hash(value)};
}
function japaneseCandidateState(candidate,sourceSha){
 if(!candidate||candidate.extra?.audio_extraction?.missing_jp===true)return {ready:false,reason:'candidate-jp-missing'};
 const cp=candidate.checkpoints??{},asr=cp.asr,translation=cp.translate_jp,current=candidate.text_jp??'';
 const sourceHash=hash(current);
 if(translation?.input_hash&&translation.input_hash!==sourceHash)return {ready:false,reason:'candidate-translation-source-changed'};
 const official=candidate.origin?.original_japanese_subtitle_missing===false&&nonempty(candidate.origin.text_jp)&&nonempty(current);
 if(official&&nonempty(candidate.translate_zh_jp))return {ready:true,route:'official-japanese-translated',source_sha256:sourceSha,source_text_hash:sourceHash,translation_hash:hash(candidate.translate_zh_jp),translation_event:translation?.event_id??null};
 if(!asr||asr.language!=='Japanese'||!['recognized','empty'].includes(asr.state)||asr.source_sha256!==sourceSha)return {ready:false,reason:'candidate-japanese-asr-pending-or-source-changed'};
 if(current!==(asr.text??''))return {ready:false,reason:'candidate-japanese-text-changed-after-asr'};
 if(asr.state==='empty'&&!nonempty(asr.text)&&translation?.state==='untranslatable_empty'&&translation.input_hash===sourceHash)return {ready:true,route:'japanese-asr-empty-translation-audited',source_sha256:sourceSha,source_text_hash:sourceHash,asr_event:asr.event_id,translation_event:translation.event_id};
 if(asr.state==='recognized'&&nonempty(asr.text)&&nonempty(candidate.translate_zh_jp))return {ready:true,route:'japanese-asr-translated',source_sha256:sourceSha,source_text_hash:sourceHash,translation_hash:hash(candidate.translate_zh_jp),asr_event:asr.event_id,translation_event:translation?.event_id??null};
 return {ready:false,reason:'candidate-japanese-translation-pending'};
}
function samePerformance(a,b){const x=performanceKey(a),y=performanceKey(b);if(!x||!y)return false;if(x.startsWith('cut:')||y.startsWith('cut:'))return x===y;return x.slice(6).split('|').some(x=>y.slice(6).split('|').includes(x));}
function contextFor(rows,index,language){const current=rows[index],col='text_'+language,before=[],after=[];if(current?.dialogue_mode!=='scene')return {before,after};for(const [step,out]of[[-1,before],[1,after]])for(let i=index+step;i>=0&&i<rows.length&&out.length<2;i+=step){const r=rows[i];if(r.dialogue_mode!=='scene'||!samePerformance(current.dialogue_evidence,r.dialogue_evidence))break;if(nonempty(r[col]))out.push({text:r[col]});}return {before:before.reverse(),after};}
function previewIssue(extra){const x=extra?.audio_extraction;return !!(x?.preview_only===true||x?.eligible_for_generation===false||x?.missing_jp===true||x?.channels>2);}
function safeJpPath(root,stem){if(!/^[\w.-]+$/.test(stem)||stem==='.'||stem==='..')throw Error('bad-stem');const file=path.resolve(root,'jp',stem+'.mp3');if(!file.startsWith(path.resolve(root,'jp')+path.sep))throw Error('bad-source-path');return file;}
// Independent acoustic safeguard: require recognizable nonlexical vowel/laughter notation.
// This is intentionally stricter than LLM classification; language-bearing words are never auto-locked.
function compatibleVocalization(text){const t=body(text).normalize('NFKC'),hiragana=t.replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60)).replace(/[ーっ]/g,'');if(/はい|いいえ|いい|おい/.test(hiragana))return false;return t.length>0&&t.length<=160&&/^[あぁアァいぃイィうぅウゥえぇエェおぉオォはハひヒふフへヘほホんンっッーゔヴぐグくクがガぎギげゲごゴわワきキゃャゅュょョぁぃぅぇぉァィゥェォ]+$/u.test(t);}
function isDeletionOnly(fragment,source){const target=[...body(fragment)];let i=0;for(const c of body(source)){if(c===target[i])i++;}return i===target.length;}
function parseDecisions(content,items){const parsed=strictObject(content,['decisions']);if(!Array.isArray(parsed.decisions)||parsed.decisions.length!==items.length)throw Error('classification-count-mismatch');const map=new Map(items.map(x=>[x.stem,x])),seen=new Set();return parsed.decisions.map(raw=>{
 const keys=['stem','kind','speech_text_jp','speech_text_zh','speech_text_en','directly_reusable','reason'];if(!raw||Object.keys(raw).sort().join()!==keys.sort().join())throw Error('classification-fields');const item=map.get(raw.stem);if(!item||seen.has(raw.stem))throw Error('classification-stem-mismatch');seen.add(raw.stem);
 if(!['speech','onomatopoeia','unknown'].includes(raw.kind)||typeof raw.directly_reusable!=='boolean'||!nonempty(raw.reason))throw Error('classification-invalid');
 for(const lang of ['jp','zh','en'])if(typeof raw['speech_text_'+lang]!=='string'||!isDeletionOnly(raw['speech_text_'+lang],item['text_'+lang]??''))throw Error('classification-body-not-deletion');
 return raw;
 });}
function lockDecision({line,asr,acoustic,decision}){
 if(previewIssue(line.extra))return {allow:false,reason:'preview-or-missing-jp'};
 // 096: verified original audio may keep an unknown speaker; never invent a person.
 // All nonverbal/acoustic/source guards below still apply; this does not authorize anonymous TTS.
 if(!acoustic?.decoded||!acoustic.frames||acoustic.channels>2)return {allow:false,reason:'unverified-acoustic'};
 if(acoustic.exact_zero===true)return {allow:true,reason:'source-pcm-exact-zero',workflow:'remake-preprocess-silent-original'};
 if(asr?.state!=='recognized'||!nonempty(asr.text))return {allow:false,reason:'empty-or-failed-asr'};
 if(decision?.kind!=='onomatopoeia'||decision.directly_reusable!==true)return {allow:false,reason:'not-confirmed-pure-vocalization'};
 if(['jp','zh','en'].some(lang=>body(decision['speech_text_'+lang])))return {allow:false,reason:'speech-body-present'};
 if(!compatibleVocalization(asr.text))return {allow:false,reason:'needs-manual-vocalization-review'};
 if(!Number.isFinite(acoustic.peak)||acoustic.peak<=0||acoustic.active_s<=0)return {allow:false,reason:'no-confirmed-acoustic-activity'};
 return {allow:true,reason:decision.reason,workflow:'remake-preprocess-pure-vocalization-original'};
}
class Semaphore{constructor(limit){this.limit=limit;this.active=0;this.waiters=[];}async use(fn){if(this.active>=this.limit)await new Promise(resolve=>this.waiters.push(resolve));else this.active++;try{return await fn();}finally{const next=this.waiters.shift();if(next)next();else this.active--;}}}
function renderPrompt(template,values){return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g,(_,key)=>{if(!Object.hasOwn(values,key))throw Error('missing-prompt-value');const x=values[key];return x==null?'':typeof x==='object'?JSON.stringify(x):String(x);});}
module.exports={hash,body,nonempty,strictObject,parseIndependentTranslation,parseAsr,contextFor,contextualize,pairingManifest,japaneseCandidateState,previewIssue,safeJpPath,compatibleVocalization,parseDecisions,lockDecision,Semaphore,renderPrompt,translationTokenLimit};
