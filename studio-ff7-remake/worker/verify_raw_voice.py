#!/usr/bin/env python3
"""Validate every JP/US extracted pair against its original read-only pak entry."""
from pathlib import Path
import hashlib,json,os
from pak_v4 import PakV4,ROOT
P=ROOT/'studio-ff7-remake';WORK=P/'work';PAKS=ROOT/'game/FINAL FANTASY VII REMAKE/End/Content/Paks'
def main():
 rows=[json.loads(s) for s in (WORK/'indexes/voice-assets.jsonl').open() if '/Voice/JP/' in s or '/Voice/US/' in s];counts={'checked':0,'errors':[]};by_pak={}
 for row in rows:
  by_pak.setdefault(row['pak'],[]).extend(str(Path(row['path']).with_suffix(ext)) for ext in ['.uasset','.uexp'])
 with (WORK/'raw-input-validation.jsonl').open('w') as out:
  for pak,names in sorted(by_pak.items()):
   p=PakV4(PAKS/pak);before=p.path.stat()
   with p.path.open('rb') as f:
    for name in sorted(names,key=lambda n:p.entries[n]['offset']):
     try:
      e=p.entries[name];target=WORK/'raw-voice'/name
      if not target.is_file() or target.stat().st_size!=e['size']:raise ValueError('Raw extraction missing or size mismatch')
      if e['encrypted']:
       expected=p.read(name)
       if hashlib.sha256(target.read_bytes()).digest()!=hashlib.sha256(expected).digest():raise ValueError('Encrypted entry decoded mismatch')
      else:
       h=hashlib.sha1()
       ranges=e['blocks'] if e['method'] else [(e['offset']+53,e['offset']+53+e['size'])]
       prior=e['offset']+53+(4+16*len(e['blocks']) if e['method'] else 0)
       for a,b in ranges:
        if not prior<=a<=b<=p.index_offset:raise ValueError('Source range outside entry payload')
        prior=b;f.seek(a);data=f.read(b-a)
        if len(data)!=b-a:raise ValueError('Truncated compressed source')
        h.update(data)
       if h.hexdigest()!=e['sha1']:raise ValueError('Source compressed SHA1 mismatch')
       if not e['method'] and hashlib.sha1(target.read_bytes()).hexdigest()!=e['sha1']:raise ValueError('Raw stored payload SHA1 mismatch')
      out.write(json.dumps({'pak':pak,'path':name,'size':e['size'],'source_sha1':e['sha1'],'raw_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'status':'verified'})+'\n');counts['checked']+=1
     except Exception as error:counts['errors'].append({'pak':pak,'path':name,'error':str(error)})
     if (counts['checked']+len(counts['errors']))%2000==0:out.flush();print(json.dumps({'checked':counts['checked'],'errors':len(counts['errors'])}),flush=True)
   after=p.path.stat()
   if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('Source pak changed during verification')
 counts['expected']=len(rows)*2;counts['complete']=counts['checked']==counts['expected'] and not counts['errors'];(WORK/'raw-input-validation-summary.json').write_text(json.dumps(counts,indent=2));print(json.dumps(counts));return 0 if counts['complete'] else 1
if __name__=='__main__':raise SystemExit(main())
