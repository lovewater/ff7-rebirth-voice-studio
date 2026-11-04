import { createHash } from "node:crypto";
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export type ScriptSourceEvent={id:string;stem:string;stage:string;input_hash:string;evidence:unknown};
export type ModelChineseScript={kind:'model-translation';language:'jp'|'en';originalChinese:string|null;sourceText:string;sourceTextSha256:string;
  translation:string;translationSha256:string;translationEventId:string;model:string;sourceAudioPath:string;sourceAudioSha256:string;asrEventId:string|null};
export type ScriptInput={stem:string;text_zh:string|null;text_jp:string|null;text_en:string|null;translate_zh_jp?:string|null;translate_zh_en?:string|null;extra?:unknown};

/** Missing original Chinese is an input-preparation case, not an excluded line.
 * Select a completed model translation whose text/source/event hashes still agree; never write it to lines.text_zh.
 * It is a production baseline, NOT an original Chinese script. Later rewrites therefore have no original-Chinese meaning gate.
 */
export function modelChineseScript(input:ScriptInput,events:ScriptSourceEvent[]) {
  if(input.text_zh?.trim())return null;
  const extra=object(input.extra),prep=object(extra.remake_preprocess);
  if(extra.game_id!=='remake')return null;
  for(const language of ['jp','en'] as const) {
    const sourceText=input[`text_${language}`],translation=input[`translate_zh_${language}`];
    if(!sourceText?.trim()||!translation?.trim())continue;
    const stage=`translate_${language}`,event=events.find(row=>row.stem===input.stem&&row.stage===stage&&row.id===String(object(prep[stage]).event_id));
    if(!event)continue;
    const evidence=object(event.evidence),sourceSha=hash(sourceText);
    if(event.input_hash!==sourceSha||evidence.state!=='translated'||evidence.source_text!==sourceText||evidence.text!==translation||typeof evidence.model!=='string'||!evidence.model)continue;
    const clip=object(object(object(extra.audio_sources)[language]).clip);
    const sourceAudioPath=`${language}/${input.stem}.mp3`;
    if(clip.audio_path!==sourceAudioPath||typeof clip.mp3_sha256!=='string'||!/^[a-f0-9]{64}$/i.test(clip.mp3_sha256))continue;
    if(language==='en') {
      const paired=object(extra.english_pairing);
      if(!['same-single-asset','same-source-asset','verified'].includes(String(paired.status))||paired.en_audio_path!==sourceAudioPath)continue;
    }
    let asrEventId:string|null=null;
    const asrCheckpoint=object(prep.asr);
    if(language==='jp'&&(asrCheckpoint.text_jp_filled===true||asrCheckpoint.original_japanese_subtitle_missing===true)) {
      const asrEvent=events.find(row=>row.stem===input.stem&&row.stage==='asr'&&row.id===String(asrCheckpoint.event_id));
      const asr=object(asrEvent?.evidence);
      if(!asrEvent||asrEvent.input_hash!==clip.mp3_sha256||asr.source_sha256!==clip.mp3_sha256||asr.language!=='Japanese'||asr.state!=='recognized'||asr.text!==sourceText)continue;
      asrEventId=asrEvent.id;
    }
    return {kind:'model-translation',language,originalChinese:input.text_zh,sourceText,sourceTextSha256:sourceSha,
      translation,translationSha256:hash(translation),translationEventId:event.id,model:evidence.model,
      sourceAudioPath,sourceAudioSha256:clip.mp3_sha256,asrEventId} satisfies ModelChineseScript;
  }
  return null;
}

/** Rechecked under the final row lock; an intervening human script/translation edit wins. */
export function modelChineseSourceUnchanged(source:ModelChineseScript,current:Pick<ScriptInput,'text_zh'|'text_jp'|'text_en'|'translate_zh_jp'|'translate_zh_en'>) {
  return current.text_zh===source.originalChinese&&!current.text_zh?.trim()
    &&current[`text_${source.language}`]===source.sourceText&&current[`translate_zh_${source.language}`]===source.translation;
}
