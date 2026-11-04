#!/usr/bin/env python3
"""Read-only checks of actual catalog, captions, files and the isolated Remake DB."""
from pathlib import Path
import hashlib,json,re,sys
from build_catalog import PROJECT,WORK,clean,load_text,choose_text

def main():
    rows=[json.loads(line) for line in (WORK/'voice-catalog.jsonl').read_text().splitlines()]
    report=json.loads((WORK/'classification.json').read_text());texts=load_text()
    assert len(rows)==len({r['stem'] for r in rows})==report['summary']['rows']
    assert len(report['chapters'])==20
    assert sum(report['summary'].get(k,0) for k in ['single_chapter','shared_chapters','unknown_chapter','chapter_not_applicable','chapter_usage_unverified'])==len(rows)
    assert report['text_index_audit']['entries']==sum(map(len,texts.values()))
    from jp_recovery import MANIFEST,validate_alias,recovery_proof
    recoveries={r['stem']:r for r in json.loads(MANIFEST.read_text()).get('recoveries',[])} if MANIFEST.exists() else {}
    files=0;captions=0;pairings=0;observed_materials=set();alias_rows=0
    for row in rows:
        assert re.fullmatch(r'[\w.\-]+',row['stem']),row['stem']
        extra=row['extra'];jp=extra['audio_sources'].get('jp');en=extra['audio_sources'].get('en');guard=extra['audio_extraction']
        assert isinstance(guard['eligible_for_generation'],bool)
        assert extra['game_id']=='remake' and extra['has_original_chinese_audio'] is False
        if '/Character/' in row['asset_path']:assert extra['chapter_classification']=='not-applicable'
        if extra['resource_usage']['status']=='special-directory-usage-unverified':
            assert row['dialogue_mode']=='unknown'
            assert 'asset_unused' not in extra['resource_usage']
        if not jp or guard['preview_only']:assert guard['eligible_for_generation'] is False
        if jp:assert jp['clip']['stem']==row['stem']
        if extra.get('jp_recovery'):
            recovery=recoveries[row['stem']];validate_alias(recovery);assert extra['jp_recovery']==recovery_proof(recovery);alias_rows+=1
        for language,source in extra['audio_sources'].items():
            clip=source['clip'];material=(source['path'],clip['clip_index'])
            if language=='jp' and extra.get('jp_recovery'):
                assert source['path']==recovery['jp_source']['path'] and clip['clip_index']==recovery['jp_source']['clip']['clip_index']
            else:
                assert material not in observed_materials,material
                observed_materials.add(material)
            path=PROJECT/'website/data'/clip['audio_path'];assert path.is_file(),path
            assert path.stat().st_size==clip['mp3_bytes'],path
            files+=1
        assert extra['english_pairing']['en_audio_path']==(en['clip']['audio_path'] if en else None)
        if extra['english_pairing']['status']=='verified-user-ids':
            assert jp and en
            assert set(map(str.casefold,jp['clip']['users']))==set(map(str.casefold,en['clip']['users']))
            pairings+=1
        for lang,key in [('CN','text_zh'),('JP','text_jp'),('US','text_en')]:
            proof=extra['official_text_evidence'][lang]
            if row[key] is None:continue
            assert proof['status']=='exact'
            chosen,recomputed=choose_text(texts,lang,proof['id'].lstrip('$'),proof['source_area'])
            assert chosen and recomputed['asset']==proof['asset'] and clean(chosen['entry']['text'])==row[key]
            binding=proof['voice_binding'];assert binding['source_asset']==row['asset_path']
            assert binding['voice_id']==proof['id'].lstrip('$').casefold()
            primary=en if extra.get('jp_recovery') else jp or en;clip=primary['clip']
            assert binding['source_clip_index']==clip['clip_index']
            if binding['basis']=='single-source-asset-stem':assert binding['voice_id']==primary['source_stem'].casefold()
            else:assert binding['voice_id'] in {str(v).lstrip('$').casefold() for v in [clip.get('material_name'),*clip.get('users',[])] if v}
            hits=texts[(lang,proof['id'].lstrip('$').casefold())]
            assert any(h['asset']==proof['asset'] and clean(h['entry']['text'])==row[key] for h in hits),(row['stem'],lang)
            captions+=1
    # Deterministic representative file bytes; the extractor separately audits all clips.
    samples=sorted(rows,key=lambda r:hashlib.sha256(r['stem'].encode()).digest())[:24]
    for row in samples:
        for source in row['extra']['audio_sources'].values():
            clip=source['clip'];p=PROJECT/'website/data'/clip['audio_path']
            assert hashlib.sha256(p.read_bytes()).hexdigest()==clip['mp3_sha256'],p
    result={'rows':len(rows),'referenced_audio_files':files,'exact_language_captions':captions,'verified_bank_pairings':pairings,'sha256_sample_rows':len(samples),'verified_jp_alias_rows':alias_rows}
    if '--complete' in sys.argv:
        progress=json.loads((WORK/'extraction-progress.json').read_text())
        expected=sum('/Voice/JP/' in r['path'] or '/Voice/US/' in r['path'] for r in map(json.loads,(WORK/'indexes/voice-assets.jsonl').read_text().splitlines()))
        assert progress['complete'] is True and progress['error_assets']==0,progress
        assert progress['done_assets']==progress['total_assets']==expected
        assert sum(report['asset_statuses'].values())==expected,'Catalog snapshot predates completed extraction; rebuild it first'
        assert not report['asset_statuses'].get('error',0)
        material_probe=[json.loads(line) for line in (WORK/'indexes/voice-materials.jsonl').read_text().splitlines()]
        expected_materials={(asset['path'],m['index']) for asset in material_probe for m in asset.get('materials',[]) if m.get('codec')!='Dummy' and m.get('stream_size',0)>0}
        excluded_materials={(item['path'],item['clip_index']) for item in report['excluded_support_banks']}
        assert not (observed_materials & excluded_materials)
        assert observed_materials|excluded_materials==expected_materials,{'missing_materials':len(expected_materials-(observed_materials|excluded_materials)),'unexpected_materials':len((observed_materials|excluded_materials)-expected_materials)}
        material_summary=json.loads((WORK/'indexes/voice-materials-summary.json').read_text())
        assert material_summary['complete'] is True and not material_summary['errors']
        assert len(expected_materials)==material_summary['counts']['expected_audio_clips']
        result['complete_source_assets']=expected;result['complete_real_materials']=len(expected_materials)
    if '--db' in sys.argv:
        import psycopg
        state=json.loads((PROJECT/'.private/bootstrap-state.json').read_text());assert (state['role'],state['database'])==('ff7remake','studio_ff7_remake')
        assert json.loads((PROJECT/'website/data/.ff7-game.json').read_text())=={'game_id':'remake','database':'studio_ff7_remake'}
        with psycopg.connect(host='127.0.0.1',port=25432,dbname=state['database'],user=state['role'],password=state['password']) as conn:
            assert conn.execute('SELECT current_database(),current_user').fetchone()==('studio_ff7_remake','ff7remake')
            dbstems={r[0] for r in conn.execute('SELECT stem FROM lines')}
            assert {r['stem'] for r in rows}<=dbstems
            assert conn.execute('SELECT count(*) FROM line_meta WHERE cn_start_s IS NOT NULL OR cn_end_s IS NOT NULL OR cn_dur_s IS NOT NULL OR cn_speech_s IS NOT NULL OR cn_emo IS NOT NULL OR cn_emo_angry IS NOT NULL OR cn_emo_disgusted IS NOT NULL OR cn_emo_fearful IS NOT NULL OR cn_emo_happy IS NOT NULL OR cn_emo_neutral IS NOT NULL OR cn_emo_other IS NOT NULL OR cn_emo_sad IS NOT NULL OR cn_emo_surprised IS NOT NULL').fetchone()[0]==0
            assert conn.execute('SELECT count(*) FROM line_meta m LEFT JOIN lines l ON l.stem=m.stem WHERE l.stem IS NULL').fetchone()[0]==0
            assert conn.execute("SELECT count(*) FROM line_meta WHERE extra->>'game_id' IS DISTINCT FROM 'remake'").fetchone()[0]==0
            assert conn.execute("SELECT count(*) FROM line_meta WHERE NOT (extra->'audio_extraction' ? 'eligible_for_generation')").fetchone()[0]==0
            result['db_rows']=len(dbstems);result['database']='studio_ff7_remake';result['cn_audio_fields_nonnull']=0
    print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
