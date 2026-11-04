#!/usr/bin/env python3
"""Read official Remake text assets from indexed legacy paks; never writes game files."""
from pathlib import Path
import hashlib,json,subprocess
from pak_v4 import PakV4
ROOT=Path(__file__).resolve().parents[2]
PROJECT=ROOT/'studio-ff7-remake'
GAME=ROOT/'game/FINAL FANTASY VII REMAKE/End/Content/Paks'
LANGS={'CN','JP','US'}
META={'Chapter','StoryProgress','StoryJump','TalkSpeaker','StoryResident','CutSceneList','CutSceneListLevel','TalkSequence','Story','PlannerEventTalkInfo','TalkGroup','TalkState','Location','LocationResident','PlannerEvent','TalkPlayTrigger','StoryFlag'}
def main():
    index=[json.loads(l) for l in (PROJECT/'work/indexes/pak-files.jsonl').read_text().splitlines()]
    selected=[]
    for row in index:
        path=row['path'];p=Path(path)
        if p.suffix not in {'.uasset','.uexp'}:continue
        is_text=any('/Text/'+lang+'/' in path for lang in LANGS) and p.stem.endswith('_TxtRes')
        is_meta='/DataObject/' in path and p.stem in META
        if is_text or is_meta:selected.append((row,is_text))
    parsers={};manifest=[]
    for row,is_text in selected:
        parser=parsers.setdefault(row['pak'],None)
        if parser is None:parser=parsers[row['pak']]=PakV4(GAME/row['pak'])
        data=parser.read(row['path']);assert data
        dest=PROJECT/'work'/('text-raw' if is_text else 'metadata-raw')/row['path'];dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
        manifest.append({**row,'kind':'text' if is_text else 'metadata','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    (PROJECT/'work/text-assets.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    output=PROJECT/'work/text-json';output.mkdir(exist_ok=True)
    with (PROJECT/'work/text-export.log').open('w') as log:
        subprocess.run([str(ROOT/'programs/bin/ff7r-text-tool'),'-m','export','-f','json','-n','2','-o',str(output),str(PROJECT/'work/text-raw/End/Content/GameContents/Text')],stdout=log,stderr=subprocess.STDOUT,check=True)
    files=list(output.rglob('*.json'));expected=sum(x['kind']=='text' and x['path'].endswith('.uasset') for x in manifest)
    assert len(files)==expected,(len(files),expected)
    total=0
    for file in files:
        doc=json.loads(file.read_text());assert doc['language'] in LANGS;total+=len(doc.get('entries',[]))
    print(json.dumps({'assets':len(manifest),'text_json':len(files),'entries':total}))
if __name__=='__main__':main()
