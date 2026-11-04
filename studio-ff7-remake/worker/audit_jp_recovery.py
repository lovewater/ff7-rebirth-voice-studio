#!/usr/bin/env python3
"""Read-only verification of JP aliases against source journals, file bytes and DB."""
import json,hashlib,collections
from jp_recovery import PROJECT,WORK,MANIFEST,DATA,VERSION,validate_alias,alias_source,recovery_proof

def main():
    import psycopg
    manifest=json.loads(MANIFEST.read_text());sources={};original_materials=0
    for line in (WORK/'voice-extraction.jsonl').open():
        a=json.loads(line)
        if a.get('language')=='jp' and a['status']=='ready':
            for c in a['clips']:sources[(a['path'],c['clip_index'])]=(a,c);original_materials+=1
    state=json.loads((PROJECT/'.private/bootstrap-state.json').read_text());assert (state['database'],state['role'])==('studio_ff7_remake','ff7remake')
    with psycopg.connect(host='127.0.0.1',port=25432,dbname=state['database'],user=state['role'],password=state['password']) as db:
        assert db.execute('SELECT current_database(),current_user').fetchone()==('studio_ff7_remake','ff7remake')
        checked=[]
        for r in manifest['recoveries']:
            source=r['jp_source'];clip=source['clip'];a,c=sources[(source['path'],clip['clip_index'])]
            assert '/Voice/JP/' in source['path'] and a['language']=='jp'
            assert c['mp3_sha256']==clip['mp3_sha256'] and c['pcm_sha256']==clip['pcm_sha256']
            raw=WORK/'raw-voice'/source['path'];assert hashlib.sha256(raw.read_bytes()).hexdigest()==source['asset_sha256']
            assert hashlib.sha256(raw.with_suffix('.uasset').read_bytes()).hexdigest()==source['uasset_sha256']
            validate_alias(r)
            extra,duration=db.execute('SELECT extra,jp_dur_s FROM line_meta WHERE stem=%s',(r['stem'],)).fetchone()
            assert extra['audio_sources']['jp']==alias_source(r) and extra['jp_recovery']==recovery_proof(r)
            assert extra['audio_sources']['en']==r['en_source'] and extra['audio_extraction']['missing_jp'] is False
            assert abs(float(duration)-clip['duration_s'])<0.000001
            checked.append({'stem':r['stem'],'source_path':source['path'],'source_clip_index':clip['clip_index'],'sha256':clip['mp3_sha256'],'verified':True})
        absence=json.loads((WORK/'jp-source-absence.json').read_text());pairing=json.loads((WORK/'jp-pairing-unresolved.json').read_text())
        for r in absence['entries']:
            extra=db.execute('SELECT extra FROM line_meta WHERE stem=%s',(r['stem'],)).fetchone()[0]
            assert not extra['audio_sources'].get('jp') and extra['audio_sources']['en']==r['en_source']
            assert extra['audio_extraction']['jp_source_absent'] is True and extra['jp_source_absence']==r['proof']
            assert extra['jp_source_absence']['whole_scene_japanese_absence_claimed'] is False
        for r in pairing['entries']:
            extra=db.execute('SELECT extra FROM line_meta WHERE stem=%s',(r['stem'],)).fetchone()[0]
            assert not extra['audio_sources'].get('jp') and extra['audio_sources']['en']==r['en_source']
            assert extra['audio_extraction']['jp_source_absent'] is False and extra['audio_extraction']['jp_pairing_unresolved'] is True
            assert extra['jp_pairing_unresolved']==r['metadata']
            for candidate in r['metadata']['jp_candidates']:
                source=db.execute('SELECT extra FROM line_meta WHERE stem=%s',(candidate['stem'],)).fetchone()[0]['audio_sources']['jp']
                assert source['clip']['audio_path']==candidate['audio_path'] and source['clip']['mp3_sha256']==candidate['mp3_sha256']
                assert hashlib.sha256((DATA/candidate['audio_path']).read_bytes()).hexdigest()==candidate['mp3_sha256']
        missing=db.execute("SELECT count(*) FROM line_meta WHERE (extra->'audio_extraction'->>'missing_jp')::boolean").fetchone()[0]
        tts=db.execute('SELECT count(*) FROM line_tts_versions').fetchone()[0]
    summary={'version':VERSION,'original_jp_materials':original_materials,'new_jp_materials':0,'verified_jp_alias_rows':len(checked),'remaining_missing_jp_rows':missing,'scoped_independent_source_absence_rows':len(absence['entries']),'whole_cue_pairing_unresolved_rows':len(pairing['entries']),'line_tts_version_records':tts,'problems':0,'complete':len(checked)==manifest['recovered_alias_rows']}
    (WORK/'missing-jp-audit/recovery-audit.json').write_text(json.dumps({'summary':summary,'rows':checked},ensure_ascii=False,indent=2)+'\n');print(json.dumps(summary,ensure_ascii=False))
    return 0
if __name__=='__main__':raise SystemExit(main())
