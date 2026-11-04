#!/usr/bin/env python3
"""Read-only cut animation references; no audio decode, inference or DB writes."""
import json,re,struct,hashlib
from build_catalog import ROOT,WORK
from pak_v4 import PakV4
from refine_catalog import canonical_event
rows=[json.loads(l) for l in (WORK/'voice-catalog.jsonl').read_text().splitlines()];events={r['asset_path'].rsplit('/',1)[0].rsplit('/',1)[-1].casefold() for r in rows if r['extra']['chapter_classification']=='shared' and '/Cut/' in r['asset_path']}
def names(b):
 if struct.unpack_from('<I',b)[0]!=0x9E2A83C1:raise ValueError('Not a legacy UE package')
 if struct.unpack_from('<iii',b,12)!=(0,0,0):raise ValueError('Unexpected cooked package version')
 pos=28;n=struct.unpack_from('<i',b,pos)[0];pos+=4+(n if n>=0 else -n*2)+4;count,offset=struct.unpack_from('<ii',b,pos);out=[];pos=offset
 for _ in range(count):
  n=struct.unpack_from('<i',b,pos)[0];pos+=4;size=n if n>=0 else -n*2;v=b[pos:pos+size].decode('utf-8' if n>=0 else 'utf-16-le').rstrip('\0');out.append(v);pos+=size+4
 if not 0<count<100000 or pos>len(b):raise ValueError('Invalid name-map bounds')
 return out
packs={};result=[]
for l in (WORK/'indexes/pak-files.jsonl').read_text().splitlines():
 a=json.loads(l);p=a['path'];m=re.search(r'/Cut/Game/[^/]+/([^/]+)/[^/]+_Character\.uasset$',p)
 if not m or m[1].casefold() not in events:continue
 if a['pak'] not in packs:packs[a['pak']]=PakV4(ROOT/'game/FINAL FANTASY VII REMAKE/End/Content/Paks'/a['pak'])
 b=packs[a['pak']].read(p);ns=names(b);selected=[n for n in ns if re.search(r'EB\d+|PC\d+|NP\d+|Battle|Boss',n,re.I)]
 result.append({'event':m[1],'path':p,'sha256':hashlib.sha256(b).hexdigest(),'names':selected})
print(json.dumps({'cut_character_assets':len(result),'events':len({r['event'] for r in result})}))
(WORK/'chapter-refinement/remaining-cut-character-names.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
