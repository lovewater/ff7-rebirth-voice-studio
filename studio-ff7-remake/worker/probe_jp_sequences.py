#!/usr/bin/env python3
"""Recheck actual JP/US sequence names and KeyOn-material references, no DB writes."""
import argparse,collections,json,subprocess
from pathlib import Path
from jp_recovery import WORK,PROJECT,load_sources,atomic_json

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--all-jp',action='store_true',help='Also parse names/sequences in every JP audio asset');p.add_argument('--output-dir',type=Path,default=WORK/'missing-jp-recheck');a=p.parse_args()
    if not a.output_dir.resolve().is_relative_to(WORK.resolve()):p.error('Reports must stay in Remake work')
    if a.output_dir.resolve()==(WORK/'missing-jp-audit').resolve():p.error('Keep frozen applied proof separate; use a new recheck directory')
    a.output_dir.mkdir(parents=True,exist_ok=True);jp=load_sources();paths={s['path'] for s in jp if a.all_jp or not s['clip'].get('users')};files=set()
    for path in paths:
        for language in (['JP'] if a.all_jp else ['JP','US']):
            file=WORK/'raw-voice'/path.replace('/Voice/JP/',f'/Voice/{language}/')
            if file.is_file():files.add(str(file))
    listing=a.output_dir/'files.txt';listing.write_text('\n'.join(sorted(files))+'\n');raw=a.output_dir/'sound-graphs.jsonl'
    binary=WORK/'tools/sound-probe/SoundProbe.dll'
    if not binary.is_file():p.error('Build worker/SoundProbe to work/tools/sound-probe first')
    with raw.open('w') as out:subprocess.run([str(Path.home()/'.dotnet/dotnet'),str(binary),'--files-list',str(listing)],stdout=out,check=True)
    reports=[];names=set();errors=[]
    for line in raw.open():
        row=json.loads(line)
        if row['status']!='ok':errors.append(row);continue
        tracks={t['index']:t for t in row['tracks']};users=collections.defaultdict(set)
        for sound in row['sounds']:
            if sound['name']:names.add(sound['name'].casefold())
            for seq in sound['sequences']:
                for command in seq['commands']:
                    track=tracks.get(command.get('track_index'))
                    if track and track['material_index'] is not None:users[track['material_index']].add(sound['name'])
        reports.append({'path':row['path'],'named_material_users':{str(i):sorted(v) for i,v in users.items()},'full_sequences':row['sounds']})
    atomic_json(a.output_dir/'material-users.json',reports)
    result={'parsed_source_assets':len(reports),'unique_named_sound_cues':len(names),'errors':errors,'database_writes':0}
    atomic_json(a.output_dir/'summary.json',result);print(json.dumps(result,ensure_ascii=False));return bool(errors)
if __name__=='__main__':raise SystemExit(main())
