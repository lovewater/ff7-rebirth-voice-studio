#!/usr/bin/env python3
"""Read-only final completeness audit, independent of extractor completion counter."""
import argparse, collections, hashlib, json
from pathlib import Path
PROJECT=Path(__file__).resolve().parents[1]
WORK=PROJECT/'work'
DATA=PROJECT/'website/data'

def audit(check_hashes=False):
 expected={r['path']:r for line in (WORK/'indexes/voice-assets.jsonl').open() if (r:=json.loads(line)) and ('/Voice/JP/' in r['path'] or '/Voice/US/' in r['path'])}
 header_inventory={r['path']:r for line in (WORK/'indexes/voice-materials.jsonl').open() if (r:=json.loads(line))}
 manifests={}
 problems=[]
 counts=collections.Counter()
 ownership={}
 lossless_ownership=set()
 for filename in (WORK/'audio-manifests').glob('*.json'):
  r=json.loads(filename.read_text());path=r['path']
  if path not in expected:
   problems.append({'path':path,'error':'manifest outside JP/US source inventory'});continue
  if path in manifests:problems.append({'path':path,'error':'duplicate source manifest'})
  manifests[path]=r
  counts['assets:'+r['status']]+=1
  if r.get('pak')!=expected[path]['pak']:problems.append({'path':path,'error':'source pak mismatch'})
  header=header_inventory.get(path,{})
  expected_status={'audio-source':'ready','reference-only':'reference-only','empty-source':'empty-source'}.get(header.get('status'))
  if r['status']!=expected_status:problems.append({'path':path,'error':'status differs from independent source header inventory','expected_status':expected_status})
  if r['status']=='error':problems.append({'path':path,'error':r.get('error','unspecified error')});continue
  if r['status']=='reference-only':
   if r.get('source_type')!='EndAssetPack' or r.get('clips'):problems.append({'path':path,'error':'invalid reference-only proof'})
   continue
  if r['status']=='empty-source':
   if r.get('clips') or r.get('decoded_material_count')!=0:problems.append({'path':path,'error':'invalid empty-source proof'})
  elif r['status']!='ready':problems.append({'path':path,'error':'unknown status'});continue
  clips=r.get('clips',[]);empty=r.get('empty_materials',[])
  source_materials={m['index']:m for m in header.get('materials',[])}
  if r.get('material_count')!=len(source_materials):problems.append({'path':path,'error':'material count differs from independent source header inventory'})
  for m in empty:
   if m!=source_materials.get(m['index']):problems.append({'path':path,'error':'empty proof differs from independent source header inventory'})
  material_indices=[x['clip_index'] for x in clips]+[x['index'] for x in empty]
  if len(material_indices)!=len(set(material_indices)) or set(material_indices)!=set(range(r.get('material_count',-1))):
   problems.append({'path':path,'error':'material index coverage incomplete/duplicate'})
  if any(x.get('codec')!='Dummy' or any(x.get(k)!=0 for k in ('stream_size','channels','sample_rate')) for x in empty):
   problems.append({'path':path,'error':'unproven empty material'})
  counts['empty_materials']+=len(empty)
  for clip in clips:
   audio=clip['audio_path'];owner=(path,clip['clip_index'])
   source_material=source_materials.get(clip['clip_index'],{})
   if clip['channels']!=source_material.get('channels') or clip['sample_rate']!=source_material.get('sample_rate'):problems.append({'path':path,'error':'PCM channels/rate differs from independent source header inventory','audio_path':audio})
   if audio in ownership and ownership[audio]!=owner:problems.append({'path':path,'error':'audio path collision','audio_path':audio})
   ownership[audio]=owner
   target=DATA/audio
   if not target.is_file() or target.stat().st_size!=clip['mp3_bytes']:problems.append({'path':path,'error':'missing/incomplete MP3','audio_path':audio})
   elif check_hashes and hashlib.sha256(target.read_bytes()).hexdigest()!=clip['mp3_sha256']:problems.append({'path':path,'error':'MP3 SHA mismatch','audio_path':audio})
   if clip['pcm_frames']<=0 or clip['duration_s']<=0 or clip['mp3_pcm_frames']<=0:problems.append({'path':path,'error':'invalid decoded duration/frames','audio_path':audio})
   if clip['channels']>2:
    lossless=clip.get('lossless_path')
    if lossless:lossless_ownership.add(lossless)
    if not lossless or not (DATA/lossless).is_file() or clip.get('eligible_for_generation') is not False or clip.get('special_handling')!='multichannel-preview-only':
     problems.append({'path':path,'error':'incomplete multichannel preservation/guard','audio_path':audio})
   counts['clips:'+r['language']]+=1;counts['channels:'+str(clip['channels'])]+=1
   counts['pcm_exact_zero']+=clip['pcm_exact_zero']
 # Registered JP playback aliases reuse proven original materials; never count
 # them as newly extracted source clips.
 from jp_recovery import MANIFEST,validate_alias
 if MANIFEST.exists():
  recovery=json.loads(MANIFEST.read_text())
  if recovery.get('files_verified') and recovery.get('database_applied'):
   for alias in recovery['recoveries']:
    try:
     validate_alias(alias);source=alias['jp_source'];clip=source['clip'];owner=(source['path'],clip['clip_index'])
     if ownership.get(clip['audio_path'])!=owner:raise ValueError('alias original source material is not in full extraction manifest')
     if alias['target_audio_path'] in ownership:raise ValueError('alias conflicts with original material output')
     ownership[alias['target_audio_path']]=owner;counts['recovered_jp_alias_files']+=1
    except Exception as exc:problems.append({'path':alias['target_audio_path'],'error':'JP recovery alias: '+str(exc)})
 missing=sorted(set(expected)-set(manifests))
 actual_mp3={f.relative_to(DATA).as_posix() for language in ('jp','en') for f in (DATA/language).rglob('*.mp3') if f.is_file()}
 actual_flac={f.relative_to(DATA).as_posix() for language in ('jp-lossless','en-lossless') for f in (DATA/language).rglob('*.flac') if f.is_file()}
 orphan_mp3=sorted(actual_mp3-set(ownership));orphan_flac=sorted(actual_flac-lossless_ownership)
 problems.extend({'path':name,'error':'unreferenced MP3 in active audio directory'} for name in orphan_mp3)
 problems.extend({'path':name,'error':'unreferenced FLAC in active audio directory'} for name in orphan_flac)
 counts['mp3_files']=len(actual_mp3);counts['flac_files']=len(actual_flac);counts['unreferenced_mp3_files']=len(orphan_mp3);counts['unreferenced_flac_files']=len(orphan_flac)
 summary={'expected_source_assets':len(expected),'seen_source_assets':len(manifests),'missing_source_assets':len(missing),'counts':dict(counts),'check_mp3_hashes':check_hashes,'problems':len(problems),'complete':not missing and not problems}
 (WORK/'voice-extraction-audit.json').write_text(json.dumps({'summary':summary,'missing_paths':missing,'problems':problems},ensure_ascii=False,indent=2)+'\n')
 return summary
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--hashes',action='store_true');args=parser.parse_args()
 result=audit(args.hashes);print(json.dumps(result,ensure_ascii=False));raise SystemExit(0 if result['complete'] else 1)
