#!/usr/bin/env python3
"""Read-only encrypted PAK index, optionally export JP/US pairs to work cache."""
import argparse,collections,json,os,subprocess
from pathlib import Path
from pak_v4 import PakV4,ROOT,KEY_FILE
PROJECT=ROOT/'studio-ff7-remake';WORK=PROJECT/'work'
GAME=ROOT/'game/FINAL FANTASY VII REMAKE'

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--export',action='store_true',help='Also unpack JP/US original pairs; never writes game files')
 parser.add_argument('--output-indexes',type=Path,default=WORK/'indexes')
 args=parser.parse_args()
 if not args.output_indexes.resolve().is_relative_to(WORK.resolve()):parser.error('Indexes must stay inside the Remake work cache')
 paks=sorted((GAME/'End/Content/Paks').glob('*.pak'))
 if len(paks)!=25:parser.error(f'Expected verified local set of 25 PAKs, got {len(paks)}; inspect source before extracting')
 args.output_indexes.mkdir(parents=True,exist_ok=True)
 index_tmp=args.output_indexes/'pak-files.jsonl.tmp';voice_tmp=args.output_indexes/'voice-assets.jsonl.tmp'
 voice_paks=set();inventory=[];counts=collections.Counter()
 with index_tmp.open('w') as idx,voice_tmp.open('w') as voices:
  for pak in paks:
   reader=PakV4(pak);before=pak.stat()
   for path,entry in reader.entries.items():
    if not path.startswith(('End/','Engine/')) or '..' in Path(path).parts:raise ValueError('Unexpected resource path: '+path)
    row={'pak':pak.name,'path':path};idx.write(json.dumps(row)+'\n');counts['all_resources']+=1
    if path.startswith('End/Content/GameContents/Sound/Voice/') and path.endswith('.uexp'):
     voices.write(json.dumps(row)+'\n');language=path.split('/Voice/',1)[1].split('/',1)[0];counts['voice:'+language]+=1
     if language in ('JP','US'):voice_paks.add(pak)
   after=pak.stat()
   if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('PAK changed while indexing: '+pak.name)
   inventory.append({'pak':pak.name,'bytes':after.st_size,'mtime_ns':after.st_mtime_ns,'mount':reader.mount,'resources':len(reader.entries),'compression_flags':sorted({e['method'] for e in reader.entries.values()})})
 index_tmp.replace(args.output_indexes/'pak-files.jsonl');voice_tmp.replace(args.output_indexes/'voice-assets.jsonl')
 (args.output_indexes/'source-pak-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
 if args.export:
  binary=WORK/'tools/repak-ff7r/target/release/repak'
  if not binary.is_file():parser.error('Run prepare_audio_tools.py to build the isolated legacy-compression fix first')
  destination=WORK/'raw-voice'
  if destination.is_symlink():parser.error('Raw cache must not be a symlink')
  destination.mkdir(parents=True,exist_ok=True)
  key=os.environ.get('FF7_REMAKE_AES_KEY') or KEY_FILE.read_text().strip()
  command=[str(binary),'--aes-key',key,'unpack','-q','-o',str(destination),'-i','End/Content/GameContents/Sound/Voice/JP/','-i','End/Content/GameContents/Sound/Voice/US/',*map(str,sorted(voice_paks))]
  subprocess.run(command,env=os.environ|{'RAYON_NUM_THREADS':'4'},check=True)
 print(json.dumps({'source_game':str(GAME),'counts':dict(counts),'voice_paks':[p.name for p in sorted(voice_paks)],'exported':args.export}))
 return 0
if __name__=='__main__':raise SystemExit(main())
