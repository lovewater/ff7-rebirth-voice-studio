#!/usr/bin/env python3
"""Read-only full Remake DataObject export preparation for chapter control-flow proof."""
import hashlib,json
from pathlib import Path
from pak_v4 import PakV4
from build_catalog import ROOT,WORK
DEST=WORK/'chapter-refinement/logic-metadata'
def main():
    DEST.mkdir(exist_ok=True,parents=True);selected=[];parsers={}
    for line in (WORK/'indexes/pak-files.jsonl').read_text().splitlines():
        item=json.loads(line);path=item['path']
        if '/DataObject/' not in path or Path(path).suffix not in {'.uasset','.uexp'}:continue
        if item['pak'] not in parsers:parsers[item['pak']]=PakV4(ROOT/'game/FINAL FANTASY VII REMAKE/End/Content/Paks'/item['pak'])
        data=parsers[item['pak']].read(path);target=DEST/'raw'/path;target.parent.mkdir(exist_ok=True,parents=True);target.write_bytes(data)
        selected.append({**item,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
    (DEST/'source-manifest.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2));print(json.dumps({'files':len(selected),'assets':sum(x['path'].endswith('.uasset') for x in selected)}))
if __name__=='__main__':main()
