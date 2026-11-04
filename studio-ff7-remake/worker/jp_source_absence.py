#!/usr/bin/env python3
"""Record scoped absence of an independently addressable JP Voice resource."""
import argparse,json,hashlib,re
from pathlib import Path
from jp_recovery import PROJECT,WORK,MANIFEST,atomic_json
ABSENCE=WORK/'jp-source-absence.json';SCOPE='no-corresponding-independent-jp-resource-in-installed-game'

def prepare():
    recovery=json.loads(MANIFEST.read_text());graphs=WORK/'missing-jp-audit/all-jp-sound-graphs.jsonl';names=set();n=0
    for line in graphs.open():
        row=json.loads(line);assert row['status']=='ok';n+=1;names.update(s['name'].casefold() for s in row['sounds'] if s['name'])
    assert n==26259
    sources=[json.loads(x) for x in (WORK/'indexes/voice-assets.jsonl').open()];jp_paths={r['path'] for r in sources if '/Voice/JP/' in r['path']};assert len(jp_paths)==27573
    rows={r['stem']:r for r in map(json.loads,(WORK/'voice-catalog.jsonl').read_text().splitlines())}
    index_sha=hashlib.sha256((WORK/'indexes/voice-assets.jsonl').read_bytes()).hexdigest();graph_sha=hashlib.sha256(graphs.read_bytes()).hexdigest();entries=[]
    for unresolved in recovery['unresolved']:
        if unresolved['status']!='no-jp-asset-or-voice-id-in-complete-voice-index':continue
        expected=unresolved['en_path'].replace('/Voice/US/','/Voice/JP/');assert expected not in jp_paths
        assert unresolved['en_users'] and not any(i in names for i in unresolved['en_users'])
        row=rows[unresolved['stem']]
        entries.append({'stem':row['stem'],'en_source':row['extra']['audio_sources']['en'],'proof':{'version':'jp-independent-source-absence-v1','scope':SCOPE,'expected_jp_asset_path':expected,'en_voice_ids':unresolved['en_users'],'jp_asset_path_hits':0,'jp_material_user_hits':0,'jp_named_sound_cue_hits':0,'jp_voice_assets_indexed':27573,'jp_audio_assets_parsed':n,'jp_materials':34612,'jp_named_sound_cues':len(names),'voice_index_sha256':index_sha,'sound_graph_sha256':graph_sha,'voice_index':'indexes/voice-assets.jsonl','sound_graph':'missing-jp-audit/all-jp-sound-graphs.jsonl','named_cue_audit':'missing-jp-audit/all-jp-cue-name-audit.json','whole_scene_japanese_absence_claimed':False}})
    assert len(entries)==355
    result={'scope':SCOPE,'confirmed_independent_resource_absence_rows':len(entries),'pending_unpaired_jp_bank_rows':sum(r['status']=='evidence-pending' for r in recovery['unresolved']),'entries':entries};
    if ABSENCE.exists():
        previous=json.loads(ABSENCE.read_text())
        if previous.get('database_applied'):
            if previous['entries']!=entries:raise ValueError('Applied JP absence evidence changed; explicitly review a new plan')
            result['database_applied']=previous['database_applied']
    atomic_json(ABSENCE,result);return result

def apply_db(manifest):
    import psycopg
    from psycopg.types.json import Jsonb
    state=json.loads((PROJECT/'.private/bootstrap-state.json').read_text());assert (state['database'],state['role'])==('studio_ff7_remake','ff7remake')
    changed=0
    with psycopg.connect(host='127.0.0.1',port=25432,dbname=state['database'],user=state['role'],password=state['password']) as db:
        assert db.execute('SELECT current_database(),current_user').fetchone()==('studio_ff7_remake','ff7remake')
        for row in manifest['entries']:
            result=db.execute("""UPDATE line_meta SET extra=jsonb_set(jsonb_set(extra,'{audio_extraction,jp_source_absent}','true'::jsonb),'{jp_source_absence}',%s) WHERE stem=%s AND extra->'audio_sources'->'jp' IS NULL AND extra->'audio_sources'->'en'=%s AND extra->'audio_extraction'->>'missing_jp'='true'""",(Jsonb(row['proof']),row['stem'],Jsonb(row['en_source'])))
            if result.rowcount!=1:raise ValueError('JP source changed; absence update rolled back: '+row['stem'])
            changed+=1
    manifest['database_applied']=changed;atomic_json(ABSENCE,manifest);return changed

def apply_absence_overlay(rows):
    if not ABSENCE.exists():return 0
    manifest=json.loads(ABSENCE.read_text())
    if not manifest.get('database_applied'):return 0
    if hashlib.sha256((WORK/'indexes/voice-assets.jsonl').read_bytes()).hexdigest()!=manifest['entries'][0]['proof']['voice_index_sha256']:raise ValueError('Installed voice index changed; re-audit scoped JP absence')
    entries={r['stem']:r for r in manifest['entries']};n=0
    for row in rows:
        proof=entries.get(row['stem']);extra=row['extra']
        if not proof or extra.get('audio_sources',{}).get('jp'):continue
        if extra['audio_sources'].get('en')!=proof['en_source']:raise ValueError('English source changed for JP absence overlay')
        extra['audio_extraction']['jp_source_absent']=True;extra['jp_source_absence']=proof['proof'];n+=1
    return n

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--apply',action='store_true');args=p.parse_args();manifest=prepare()
    if args.apply:apply_db(manifest)
    print(json.dumps({k:v for k,v in manifest.items() if k!='entries'},ensure_ascii=False))
