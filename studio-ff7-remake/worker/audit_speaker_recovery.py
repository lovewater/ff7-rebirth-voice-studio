#!/usr/bin/env python3
"""Read-only check of actual speaker assignments and their original game evidence."""
import json,collections
from recover_speakers import PLAN,FOLDER,metadata,digest,connect,filehash,PROJECT

def main():
    plan=json.loads(PLAN.read_text());docs,_,_,_,_=metadata();checked=[];problems=[]
    with connect() as db:
        for entry in plan['proposals']:
            row=db.execute('SELECT l.speaker,l.asset_path,m.extra FROM lines l JOIN line_meta m USING(stem) WHERE l.stem=%s',(entry['stem'],)).fetchone()
            if not row or row[0]!=entry['speaker'] or row[1]!=entry['asset_path'] or row[2].get('speaker_recovery')!=entry['proof']:problems.append({'stem':entry['stem'],'reason':'assignment-or-evidence-changed'});continue
            proof=entry['proof'];source=row[2]['audio_sources']['jp'];assert filehash(PROJECT/'website/data'/source['clip']['audio_path'])==entry['jp_source_identity']['mp3_sha256']
            for binding in proof.get('voice_bindings',[]):assert digest(docs[binding['asset']]['entries'][binding['row_id']])==binding['entry_sha256']
            for model in proof.get('actor_models',[]):
                for definition in model['actor_rows']+[model['character_spec_row']]:assert digest(docs[definition['asset']]['entries'][definition['row_id']])==definition['entry_sha256']
                assert model['blueprints']
            for witness in proof.get('alias_witnesses',[]):
                anchor=db.execute('SELECT l.speaker,m.extra FROM lines l JOIN line_meta m USING(stem) WHERE l.stem=%s',(witness['stem'],)).fetchone();assert anchor[0]==entry['speaker'];clip=anchor[1]['audio_sources']['jp']['clip'];assert clip['pcm_sha256']==source['clip']['pcm_sha256']==witness['pcm_sha256']
            checked.append(entry['stem'])
        remaining=[]
        for stem,extra in db.execute("SELECT l.stem,m.extra FROM lines l JOIN line_meta m USING(stem) WHERE NULLIF(btrim(l.speaker),'') IS NULL"):
            if extra.get('audio_sources',{}).get('jp'):remaining.append(stem)
        overall=db.execute("SELECT count(*) FROM lines WHERE NULLIF(btrim(speaker),'') IS NULL").fetchone()[0]
    summary={'verified_filled_empty_speakers':len(checked),'remaining_real_jp_missing_speaker':len(remaining),'remaining_all_languages_missing_speaker':overall,'new_speaker_definitions':0,'new_inference_calls':0,'problems':len(problems),'complete':not problems}
    (FOLDER/'audit.json').write_text(json.dumps({'summary':summary,'checked_stems':checked,'remaining_real_jp_stems':remaining,'problems':problems},ensure_ascii=False,indent=2)+'\n');print(json.dumps(summary,ensure_ascii=False));return bool(problems)
if __name__=='__main__':raise SystemExit(main())
