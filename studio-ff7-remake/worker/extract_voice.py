#!/usr/bin/env python3
"""Read extracted Remake voice pairs; decode every AudioMog material to JP/EN MP3."""
from pathlib import Path
import re,collections
import argparse,concurrent.futures,json,os,subprocess,hashlib,wave,shutil,time,threading,traceback
ROOT=Path(__file__).resolve().parents[2];PROJECT=ROOT/'studio-ff7-remake';WORK=PROJECT/'work';RAW=WORK/'raw-voice';DATA=PROJECT/'website/data'
LOCK=threading.Lock();DONE=0

def run_batch(rows):
 results=[];pending=[]
 for row in rows:
  source=RAW/row['path'];key=hashlib.sha256(row['path'].encode()).hexdigest();record=WORK/'audio-manifests'/f'{key}.json'
  if record.exists():
   old=json.loads(record.read_text())
   if old.get('extractor_version')=='remake-audio-v4' and old.get('status')=='ready' and old.get('output_stem')==row.get('output_stem') and old.get('clips') and all((DATA/x['audio_path']).is_file() and (DATA/x['audio_path']).stat().st_size==x['mp3_bytes'] for x in old['clips']):results.append(old);continue
  blob=source.read_bytes() if source.exists() else b''
  header=source.with_suffix('.uasset').read_bytes() if source.with_suffix('.uasset').exists() else b''
  if '/Build/' in row['path'] and b'EndAssetPack' in header and b'sabf' not in blob and b'mabf' not in blob:
   r={**row,'game_id':'remake','status':'reference-only','source_type':'EndAssetPack','source_stem':source.stem,'language':'jp' if '/Voice/JP/' in row['path'] else 'en','clips':[],'asset_sha256':hashlib.sha256(blob).hexdigest(),'uasset_sha256':hashlib.sha256(header).hexdigest(),'is_build_pack':True}
   record.parent.mkdir(exist_ok=True);record.write_text(json.dumps(r));results.append(r);continue
  pending.append((row,source,key,record))
 if pending:
  env=os.environ|{'DOTNET_ROOT':str(Path.home()/'.dotnet'),'DOTNET_CLI_TELEMETRY_OPTOUT':'1'}
  decoded=subprocess.run([str(Path.home()/'.dotnet/dotnet'),str(WORK/'tools/audio-batch/AudioBatch.dll'),*[str(x[1]) for x in pending]],env=env,cwd=ROOT/'programs/bin/audiomog',capture_output=True,text=True,timeout=300)
  log=WORK/'audio-logs'/f'{pending[0][2]}.log';log.parent.mkdir(exist_ok=True);log.write_text(decoded.stdout+'\n'+decoded.stderr)
  for row,source,key,record in pending:
   record.parent.mkdir(exist_ok=True);base=source.with_name(source.stem+'_Project');clips=[]
   try:
    if not source.is_file() or not source.with_suffix('.uasset').is_file():raise ValueError('Missing uasset/uexp pair')
    wavs=sorted(base.glob('*.wav'),key=lambda p:int(re.search(r'_(\d+)$',p.stem).group(1)));users=(base/'TrackUsers.txt').read_text() if (base/'TrackUsers.txt').exists() else ''
    materials=json.loads(source.with_name(source.name+'.materials.json').read_text())
    empty_materials=[x for x in materials if x['codec']=='Dummy' and x['stream_size']==0 and x['channels']==0 and x['sample_rate']==0]
    expected={x['index'] for x in materials if x not in empty_materials};actual={int(re.search(r'_(\d+)$',x.stem).group(1)) for x in wavs}
    if expected!=actual:raise ValueError(f'AudioMog material coverage mismatch: expected {len(expected)} got {len(actual)}')
    if not wavs:raise ValueError('Zero-material source; record for explicit empty-asset review')
    lang='jp' if '/Voice/JP/' in row['path'] else 'en';prefix=row.get('output_stem',source.stem)
    for wav in wavs:
     index=int(re.search(r'_(\d+)$',wav.stem).group(1))
     stem=prefix if len(wavs)==1 else f'{prefix}__clip{index:04d}'
     with wave.open(str(wav),'rb') as f:
      channels,rate,frames,width=f.getnchannels(),f.getframerate(),f.getnframes(),f.getsampwidth();pcm=f.readframes(frames)
     if frames<=0:raise ValueError('Zero-frame material: '+wav.name)
     lossless=None
     material_users=[]
     for userline in users.splitlines():
      if userline.startswith(wav.stem+'.') and 'users:' in userline:material_users=[v.strip() for v in userline.split('users:',1)[1].split(',') if v.strip()]
     if channels>2:
      lossless=f'{lang}-lossless/{stem}.flac';flac=DATA/lossless;flac.parent.mkdir(exist_ok=True)
      subprocess.run(['ffmpeg','-v','error','-y','-threads','1','-i',str(wav),'-c:a','flac',str(flac)],capture_output=True,check=True,timeout=120)
     decoded=subprocess.check_output(['ffmpeg','-v','error','-i',str(flac),'-f','s16le','-c:a','pcm_s16le','-']) if lossless else None
     if decoded is not None and (width!=2 or hashlib.sha256(decoded).digest()!=hashlib.sha256(pcm).digest()):raise ValueError('Multichannel lossless PCM verification failed')
     preview_channels=min(channels,2)
     target=DATA/lang/(stem+'.mp3');target.parent.mkdir(exist_ok=True);temp=target.with_name('.'+target.name+'.tmp.mp3')
     subprocess.run(['ffmpeg','-v','error','-y','-threads','1','-i',str(wav),'-c:a','libmp3lame','-b:a','320k','-ac',str(preview_channels),'-threads','1',str(temp)],capture_output=True,check=True,timeout=120)
     meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','a:0','-show_entries','stream=sample_rate,channels,duration,nb_frames:format=duration','-of','json',str(temp)]));stream=meta['streams'][0]
     if int(stream['channels'])!=preview_channels or float(meta['format']['duration'])<=0:raise ValueError('Encoded MP3 stream verification failed')
     decoded_mp3=subprocess.check_output(['ffmpeg','-v','error','-threads','1','-i',str(temp),'-f','s16le','-c:a','pcm_s16le','-'])
     mp3_frames=len(decoded_mp3)//(2*preview_channels);mp3_rate=int(stream['sample_rate'])
     if abs(mp3_frames/mp3_rate-frames/rate)>.001+1/max(rate,mp3_rate):raise ValueError('Native decoded MP3 length differs from entire source PCM')
     temp.replace(target)
     clips.append({'stem':stem,'source_stem':source.stem,'clip_index':index,'material_name':wav.stem,'users':material_users,'mp3_pcm_frames':mp3_frames,'mp3_sample_rate':mp3_rate,'audio_path':f'{lang}/{stem}.mp3','channels':channels,'preview_channels':preview_channels,'lossless_path':lossless,'special_handling':'multichannel-preview-only' if channels>2 else None,'eligible_for_generation':channels<=2,'sample_rate':rate,'sample_width':width,'pcm_frames':frames,'source_duration_s':frames/rate,'duration_s':mp3_frames/mp3_rate,'encoder_rounding_ms':1000*(mp3_frames/mp3_rate-frames/rate),'encoded_duration_s':float(meta['format']['duration']),'mp3_bytes':target.stat().st_size,'pcm_sha256':hashlib.sha256(pcm).hexdigest(),'mp3_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'pcm_exact_zero':not any(pcm)})
    result={**row,'extractor_version':'remake-audio-v4','material_count':len(materials),'empty_materials':empty_materials,'decoded_material_count':len(clips),'game_id':'remake','status':'ready','asset_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'uasset_sha256':hashlib.sha256(source.with_suffix('.uasset').read_bytes()).hexdigest(),'source_stem':source.stem,'language':lang,'is_build_pack':'/Build/' in row['path'],'clips':clips,'track_users':users}
    shutil.rmtree(base)
   except Exception as e:result={**row,'game_id':'remake','status':'error','error':str(e),'clips':clips,'log':str(log.relative_to(PROJECT))}
   temp_record=record.with_suffix('.tmp');temp_record.write_text(json.dumps(result,ensure_ascii=False));temp_record.replace(record);results.append(result)
 return results

def main():
 p=argparse.ArgumentParser();p.add_argument('--workers',type=int,default=4);p.add_argument('--limit',type=int);a=p.parse_args()
 rows=[json.loads(s) for s in (WORK/'indexes/voice-assets.jsonl').open() if '/Voice/JP/' in s or '/Voice/US/' in s]
 # Build-pack samples overlap event line assets. Preserve as resources, deduplicate at catalog integration.
 paths=collections.defaultdict(set)
 for row in rows:
  rel=re.sub(r'/Voice/(JP|US)/','/Voice/',row['path']);paths[Path(row['path']).stem.casefold()].add(rel)
 for row in rows:
  stem=Path(row['path']).stem;rel=re.sub(r'/Voice/(JP|US)/','/Voice/',row['path']);row['output_stem']=stem+('__asset'+hashlib.sha256(rel.encode()).hexdigest()[:12] if len(paths[stem.casefold()])>1 else '')
 rows.sort(key=lambda x:('/Build/' in x['path'], '/Character/' in x['path'],x['path']))
 if a.limit:rows=rows[:a.limit]
 (WORK/'audio-manifests').mkdir(exist_ok=True);(WORK/'audio-logs').mkdir(exist_ok=True)
 started=time.time();ready=errors=clips=done=references=0
 with (WORK/'voice-extraction.jsonl').open('w') as out,concurrent.futures.ThreadPoolExecutor(max_workers=min(max(a.workers,1),4)) as pool:
  futures={pool.submit(run_batch,rows[i:i+16]):rows[i:i+16] for i in range(0,len(rows),16)}
  for future in concurrent.futures.as_completed(futures):
   try:batch=future.result()
   except Exception as e:
    batch=[]
    for row in futures[future]:
     r={**row,'status':'error','error':'batch exception: '+str(e),'clips':[]}
     key=hashlib.sha256(row['path'].encode()).hexdigest();(WORK/'audio-manifests'/f'{key}.json').write_text(json.dumps(r));batch.append(r)
   for r in batch:
    out.write(json.dumps(r,ensure_ascii=False)+'\n');done+=1;ready+=r['status']=='ready';errors+=r['status']=='error';references+=r['status']=='reference-only';clips+=len(r.get('clips',[]))
   out.flush();summary={'total_assets':len(rows),'done_assets':done,'ready_assets':ready,'error_assets':errors,'reference_assets':references,'clips':clips,'elapsed_s':round(time.time()-started,1),'complete':done==len(rows)};(WORK/'extraction-progress.json').write_text(json.dumps(summary));print(json.dumps(summary),flush=True)
 return 1 if errors else 0
if __name__=='__main__':raise SystemExit(main())
