// Import completed Seed-VC batch output as unselected, deletable TTS history.
// Usage: node worker/import_seed_vc.mjs /absolute/output-directory SOURCE_REVISION
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, readdir, mkdir, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const website = process.env.WEBSITE_DIR || fileURLToPath(new URL('../website/', import.meta.url));
const require = createRequire(path.join(website, 'package.json'));
const sql = require('postgres')(process.env.DATABASE_URL || '');
const [outputDir, revision] = process.argv.slice(2);
if (!outputDir || !/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('output directory and exact source revision required');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function timing(b) {
  if (b.toString('ascii',0,4)!=='RIFF' || b.toString('ascii',8,12)!=='WAVE') throw new Error('Not WAV');
  let rate, channels, align, bits, format, pcm;
  for(let p=12;p+8<=b.length;) {
    const kind=b.toString('ascii',p,p+4), size=b.readUInt32LE(p+4), start=p+8;
    if(start+size>b.length) throw new Error('Truncated WAV');
    if(kind==='fmt ') { format=b.readUInt16LE(start); channels=b.readUInt16LE(start+2);rate=b.readUInt32LE(start+4);align=b.readUInt16LE(start+12);bits=b.readUInt16LE(start+14); }
    if(kind==='data') pcm=b.subarray(start,start+size);
    p=start+size+(size%2);
  }
  if(format!==1 || bits!==16 || channels!==1 || align!==2 || !rate || !pcm?.length) throw new Error('Expected mono PCM16');
  const n=pcm.length/2; let peak=0, clipped=0;
  for(let i=0;i<n;i++){const v=Math.abs(pcm.readInt16LE(i*2));peak=Math.max(peak,v);if(v>=32767)clipped++;}
  if(!peak) throw new Error('Silent output');
  let first=0,last=n-1;
  while(first<n && Math.abs(pcm.readInt16LE(first*2))<peak*.1)first++;
  while(last>=first && Math.abs(pcm.readInt16LE(last*2))<peak*.1)last--;
  return {start:first/rate,end:(last+1)/rate,duration:n/rate,speech:(last+1-first)/rate,peak:peak/32768,clipped,rate};
}
try {
  for(const entry of (await readdir(outputDir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(!entry.isDirectory()) continue;
    const dir=path.join(outputDir,entry.name);
    const meta=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
    if(!['jp','cn'].includes(meta.reference_lang) || !Number.isInteger(meta.source_id) || path.basename(meta.output)!==meta.output) throw new Error('Invalid manifest');
    const [source]=await sql`select * from line_tts_versions where id=${meta.source_id} and status='ready'`;
    if(!source || source.stem!==meta.stem) throw new Error('Source missing or mismatch');
    const sourceBytes=await readFile(path.join(website,'data',source.audio_path));
    const referenceBytes=await readFile(path.join(website,'data',meta.reference_lang,source.stem+'.mp3'));
    if(hash(sourceBytes)!==meta.source_sha256 || hash(referenceBytes)!==meta.reference_sha256) throw new Error('Input hash mismatch');
    const bytes=await readFile(path.join(dir,meta.output)); const t=timing(bytes);
    Object.assign(meta,{source_revision:revision,output_sha256:hash(bytes),source_audio_path:source.audio_path,reference_audio_path:`${meta.reference_lang}/${source.stem}.mp3`,source_engine:{model:source.engine_model_version,precision:source.engine_precision,revision:source.engine_source_revision},timing:t});
    const [old]=await sql`select id from line_tts_versions where status='ready' and conversion_meta->>'output_sha256'=${meta.output_sha256} and conversion_meta->>'source_id'=${String(meta.source_id)} and conversion_meta->>'reference_lang'=${meta.reference_lang}`;
    if(old){console.log(JSON.stringify({source:meta.source_id,reference:meta.reference_lang,id:old.id,existing:true}));continue;}
    let written;
    try {
      const id=await sql.begin(async tx=>{
        const [row]=await tx`insert into line_tts_versions
          (stem,speaker,voice_version_id,voice_gpu_key,tts_text,spoken_text,subtitle_text,jp_text_snapshot,game_zh_text_snapshot,duration_factor,emo_alpha,engine_model_version,engine_model_revision,engine_source_revision,engine_package_version,engine_precision,engine_device,engine_url,conversion_meta)
          values (${source.stem},${source.speaker},${source.voice_version_id},${source.voice_gpu_key},${source.tts_text},${source.spoken_text},${source.subtitle_text},${source.jp_text_snapshot},${source.game_zh_text_snapshot},${source.duration_factor},${source.emo_alpha},${meta.model || 'Seed-VC v1 offline'},${meta.model_revision || 'Plachta/Seed-VC/DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth'},${revision},${meta.torch_version},${meta.precision},${meta.device},${meta.engine_url || 'docker-compose://ff7-seed-vc'},${tx.json(meta)}) returning id`;
        const relative=`tts/${source.stem}/${row.id}.wav`;
        const absolute=path.join(website,'data',relative);
        await mkdir(path.dirname(absolute),{recursive:true});
        await writeFile(absolute,bytes,{flag:'wx'});written=absolute;
        await tx`update line_tts_versions set status='ready',audio_path=${relative},audio_bytes=${bytes.length},start_s=${t.start},end_s=${t.end},dur_s=${t.duration},speech_s=${t.speech},completed_at=now() where id=${row.id}`;
        return row.id;
      });
      console.log(JSON.stringify({source:meta.source_id,reference:meta.reference_lang,id,...t}));
    } catch(e) {if(written)await unlink(written);throw e;}
  }
} finally {await sql.end();}
