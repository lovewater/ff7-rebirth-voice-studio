#!/usr/bin/env python3
"""Describe whole-cue JP materials already present, without guessing subclip pairs."""
import argparse,json,hashlib,collections
from jp_recovery import WORK,PROJECT,DATA,MANIFEST,atomic_json,load_sources,sha
PAIRING=WORK/'jp-pairing-unresolved.json'

def prepare():
    manifest=json.loads(MANIFEST.read_text());graph=WORK/'missing-jp-audit/unpaired-bank-full-user-audit.json';graphs=json.loads(graph.read_text());by={r['path'].split('/raw-voice/',1)[-1]:r for r in graphs};jp=load_sources();rows={r['stem']:r for r in map(json.loads,(WORK/'voice-catalog.jsonl').read_text().splitlines())};entries=[]
    for pending in manifest['unresolved']:
        if pending['reason']!='unnamed-material-without-semantic-reference' or '/Field/' not in pending['en_path']:continue
        en=rows[pending['stem']]['extra']['audio_sources']['en'];jp_path=en['path'].replace('/Voice/US/','/Voice/JP/');g=by[jp_path];names={name for users in g['named_material_users'].values() for name in users}
        assert len(names)==1
        candidates=[]
        for source in jp:
            if source['path']!=jp_path:continue
            c=source['clip'];assert (DATA/c['audio_path']).is_file() and sha(DATA/c['audio_path'])==c['mp3_sha256']
            assert c['stem'] in rows and rows[c['stem']]['extra']['audio_sources']['jp']['clip']['audio_path']==c['audio_path']
            candidates.append({'stem':c['stem'],'audio_path':c['audio_path'],'source_path':source['path'],'clip_index':c['clip_index'],'pcm_sha256':c['pcm_sha256'],'mp3_sha256':c['mp3_sha256'],'duration_s':c['duration_s']})
        assert len(candidates) in {6,8,10}
        proof={'version':'jp-whole-cue-pairing-v1','scope':'jp-materials-present-in-other-rows-without-unique-subclip-pairing','proof':{'whole_cue_name':next(iter(names)),'jp_bank_path':jp_path,'en_bank_path':en['path'],'unique_named_cues':1,'jp_material_count':len(candidates),'en_material_index':en['clip']['clip_index'],'all_jp_materials_have_independent_catalog_rows':True,'game_resource_missing':False,'graph':str(graph.relative_to(WORK)),'graph_sha256':sha(graph),'raw_commands_graph':'missing-jp-audit/unpaired-bank-full-graphs.jsonl','reason':'one-named-whole-cue-references-many-materials-without-per-material-unique-name'},'jp_candidate_stems':[c['stem'] for c in candidates],'jp_candidate_paths':[c['audio_path'] for c in candidates],'jp_candidates':candidates}
        entries.append({'stem':pending['stem'],'en_source':en,'metadata':proof})
    assert len(entries)==42
    result={'unpaired_rows':len(entries),'distinct_existing_jp_materials':len({c['stem'] for r in entries for c in r['metadata']['jp_candidates']}),'entries':entries}
    if PAIRING.exists():
        old=json.loads(PAIRING.read_text())
        if old.get('database_applied'):
            assert old['entries']==entries;result['database_applied']=old['database_applied']
    atomic_json(PAIRING,result);return result

def apply_db(manifest):
    import psycopg
    from psycopg.types.json import Jsonb
    state=json.loads((PROJECT/'.private/bootstrap-state.json').read_text());assert (state['database'],state['role'])==('studio_ff7_remake','ff7remake')
    with psycopg.connect(host='127.0.0.1',port=25432,dbname=state['database'],user=state['role'],password=state['password']) as db:
        assert db.execute('SELECT current_database(),current_user').fetchone()==('studio_ff7_remake','ff7remake')
        for row in manifest['entries']:
            for candidate in row['metadata']['jp_candidates']:
                found=db.execute("SELECT extra->'audio_sources'->'jp'->'clip'->>'audio_path' FROM line_meta WHERE stem=%s",(candidate['stem'],)).fetchone();assert found and found[0]==candidate['audio_path']
            result=db.execute("""UPDATE line_meta SET extra=jsonb_set(jsonb_set(jsonb_set(extra,'{jp_pairing_unresolved}',%s),'{audio_extraction,jp_pairing_unresolved}','true'::jsonb),'{audio_extraction,jp_source_absent}','false'::jsonb) WHERE stem=%s AND extra->'audio_sources'->'jp' IS NULL AND extra->'audio_sources'->'en'=%s AND extra->'audio_extraction'->>'missing_jp'='true'""",(Jsonb(row['metadata']),row['stem'],Jsonb(row['en_source'])))
            if result.rowcount!=1:raise ValueError('Concurrent JP source change; pairing transaction rolled back')
    manifest['database_applied']=len(manifest['entries']);atomic_json(PAIRING,manifest)

def apply_pairing_overlay(rows):
    if not PAIRING.exists():return 0
    manifest=json.loads(PAIRING.read_text())
    if not manifest.get('database_applied'):return 0
    by={r['stem']:r for r in manifest['entries']};n=0
    for row in rows:
        record=by.get(row['stem']);extra=row['extra']
        if not record or extra.get('audio_sources',{}).get('jp'):continue
        assert extra['audio_sources'].get('en')==record['en_source'];extra['jp_pairing_unresolved']=record['metadata'];extra['audio_extraction']['jp_pairing_unresolved']=True;extra['audio_extraction']['jp_source_absent']=False;n+=1
    return n
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--apply',action='store_true');a=p.parse_args();m=prepare()
    if a.apply:apply_db(m)
    print(json.dumps({k:v for k,v in m.items() if k!='entries'}))
