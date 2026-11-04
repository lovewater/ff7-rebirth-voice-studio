#!/usr/bin/env python3
"""Inventory SAB/MAB material headers without decoding; no game/output mutations.

Offsets follow AudioMog's AudioBinaryFileHeader, AudioBinarySectionDeclaration,
and MaterialSection. This is an independent completeness cross-check, not a
replacement decoder or a claim that an audio stream can play.
"""
import collections,json,struct
from pathlib import Path
PROJECT=Path(__file__).resolve().parents[1];WORK=PROJECT/'work';RAW=WORK/'raw-voice'
CODECS=['Dummy','PCM','MSADPCM','OGGVorbis','ATRAC9','XMA2','MSMP3','HCA','SWITCHOPUS']
def probe(data):
 starts=[i for m in (b'sabf',b'mabf') if (i:=data.find(m))>=0]
 if not starts:raise ValueError('no audio binary magic')
 base=min(starts)
 if struct.unpack_from('<H',data,base+6)[0]==0x1000:raise ValueError('unsupported big endian')
 count,descriptor=data[base+8:base+10]
 size=struct.unpack_from('<I',data,base+12)[0]
 if base+size>len(data):raise ValueError('binary file size out of bounds')
 header_size=16+descriptor+16-descriptor%16
 sections={}
 for n in range(count):
  p=base+header_size+n*16
  sections[data[p:p+4]]=base+struct.unpack_from('<I',data,p+8)[0]
 material=sections[b'mtrl'];num=struct.unpack_from('<H',data,material+4)[0]
 entries=[]
 for index in range(num):
  p=material+struct.unpack_from('<I',data,material+16+4*index)[0]
  channel,codec=data[p+4:p+6];rate=struct.unpack_from('<I',data,p+8)[0]
  extra_size,stream_size=struct.unpack_from('<II',data,p+20)
  if p+32+extra_size+stream_size>base+size:raise ValueError('material stream out of binary file bounds')
  entries.append({'index':index,'codec':CODECS[codec] if codec<len(CODECS) else f'unknown:{codec}','stream_size':stream_size,'channels':channel,'sample_rate':rate})
 return {'binary_magic':data[base:base+4].decode(),'version':list(data[base+4:base+6]),'materials':entries}
def main():
 counts=collections.Counter();errors=[];known_matches=0
 with (WORK/'indexes/voice-materials.jsonl').open('w') as out:
  for line in (WORK/'indexes/voice-assets.jsonl').open():
   row=json.loads(line)
   if '/Voice/JP/' not in row['path'] and '/Voice/US/' not in row['path']:continue
   source=RAW/row['path'];data=source.read_bytes()
   try:
    result=probe(data);materials=result['materials']
    sidecar=source.with_name(source.name+'.materials.json')
    if sidecar.exists():
     if json.loads(sidecar.read_text())!=materials:raise ValueError('independent probe differs from AudioMog parser sidecar')
     known_matches+=1
    empty=[m for m in materials if m['codec']=='Dummy' and m['stream_size']==0 and m['channels']==0 and m['sample_rate']==0]
    status='empty-source' if len(empty)==len(materials) else 'audio-source'
    counts['material_slots']+=len(materials);counts['empty_material_slots']+=len(empty);counts['expected_audio_clips']+=len(materials)-len(empty)
    for m in materials:
     counts['codec:'+m['codec']]+=1
     if m not in empty:counts['audio_channels:'+str(m['channels'])]+=1
   except Exception as e:
    if str(e)=='no audio binary magic' and '/Build/' in row['path'] and b'EndAssetPack' in source.with_suffix('.uasset').read_bytes():status='reference-only';result={}
    else:status='error';result={'error':str(e)};errors.append({'path':row['path'],'error':str(e)})
   counts['assets:'+status]+=1
   out.write(json.dumps({**row,'status':status,**result},ensure_ascii=False)+'\n')
 summary={'counts':dict(counts),'audiomog_material_sidecars_matched':known_matches,'errors':errors,'complete':not errors}
 (WORK/'indexes/voice-materials-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n');print(json.dumps(summary,ensure_ascii=False))
 return bool(errors)
if __name__=='__main__':raise SystemExit(main())
