#!/usr/bin/env python3
"""Recover JP playback by evidence-backed, byte-identical aliases; never synthesize."""
from __future__ import annotations
import argparse,collections,copy,hashlib,json,os,re,shutil,uuid
from pathlib import Path
PROJECT=Path(__file__).resolve().parents[1];WORK=PROJECT/'work';DATA=PROJECT/'website/data'
MANIFEST=WORK/'jp-recovery.json';VERSION='jp-source-alias-v1'

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def atomic_json(path,value):
    tmp=path.with_name('.'+path.name+'.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');tmp.replace(path)
def identity(path):return re.sub(r'/Voice/(JP|US)/','/Voice/',path)
def ids(clip):return frozenset(str(x).casefold() for x in clip.get('users',[]) if isinstance(x,str))
def pcm_key(clip):return tuple(clip.get(k) for k in ('pcm_sha256','channels','sample_rate','pcm_frames'))
def source_record(asset,clip):
    return {**{k:asset.get(k) for k in ('pak','path','source_stem','output_stem','asset_sha256','uasset_sha256','is_build_pack')},'clip':clip}
def distinct_pcm(candidates):return {pcm_key(c['clip']) for c in candidates}

def choose(en,jp_sources):
    """No index guessing: exact-bank named references or globally explicit VoiceIDs."""
    users=ids(en['clip']);same=[j for j in jp_sources if identity(j['path'])==identity(en['path'])]
    if not users:return None,'unnamed-material-without-semantic-reference',[]
    named=[j for j in same if users<=ids(j['clip'])]
    if named and len(distinct_pcm(named))==1:
        return sorted(named,key=lambda s:(s['path'],s['clip']['clip_index']))[0],'same-bank-unique-voice-id-reference',named
    matched_pcm=[j for j in named if pcm_key(j['clip'])==pcm_key(en['clip'])]
    if matched_pcm and len(distinct_pcm(matched_pcm))==1:
        return sorted(matched_pcm,key=lambda s:(s['path'],s['clip']['clip_index']))[0],'same-bank-voice-id-and-identical-pcm',matched_pcm
    # Bare atk/damage/guard labels must never cross bank/character boundaries.
    if all(re.fullmatch(r'(?:ev|mv|pv|tk|ba|bt)_[a-z0-9_]+',u) for u in users):
        matches=[j for j in jp_sources if ids(j['clip'])==users]
        if matches and len(distinct_pcm(matches))==1:
            return sorted(matches,key=lambda s:(s['path'],s['clip']['clip_index']))[0],'global-explicit-voice-id-unique-pcm',matches
    return None,'ambiguous-voice-variants' if named else 'no-matching-named-jp-reference',named

def load_sources():
    jp=[]
    for line in (WORK/'voice-extraction.jsonl').open():
        a=json.loads(line)
        if a.get('language')=='jp' and a.get('status')=='ready':jp.extend(source_record(a,c) for c in a['clips'])
    return jp

def make_plan():
    rows=[json.loads(s) for s in (WORK/'voice-catalog.jsonl').open()];jp=load_sources();recoveries=[];unresolved=[];counts=collections.Counter()
    previous=json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {};previous_by_stem={r['stem']:r for r in previous.get('recoveries',[])}
    baseline=WORK/'missing-jp-audit/db-baseline.json'
    if baseline.exists():original_missing=json.loads(baseline.read_text())['missing']
    elif previous:original_missing=[{'stem':r['stem']} for r in [*previous['recoveries'],*previous['unresolved']]]
    else:original_missing=[{'stem':r['stem']} for r in rows if r['extra']['audio_extraction']['missing_jp']]
    target_stems={r['stem'] for r in original_missing}
    for row in rows:
        if row['stem'] not in target_stems:continue
        en=row['extra']['audio_sources']['en'];source,method,aliases=choose(en,jp)
        if source:
            guard={'language':'jp','channels':source['clip']['channels'],'preview_only':source['clip'].get('eligible_for_generation') is False or source['clip']['channels']>2,'eligible_for_generation':source['clip'].get('eligible_for_generation') is not False and source['clip']['channels']<=2,'missing_jp':False,'source_clip_index':source['clip']['clip_index'],'source_path':source['path'],'source_pak':source['pak']}
            recoveries.append({'stem':row['stem'],'version':VERSION,'method':method,'en_source':en,'jp_source':copy.deepcopy(source),'equivalent_jp_aliases':[{'path':a['path'],'clip_index':a['clip']['clip_index'],'audio_path':a['clip']['audio_path'],'pcm_sha256':a['clip']['pcm_sha256']} for a in aliases],'target_audio_path':'jp/'+row['stem']+'.mp3','audio_extraction':guard})
            counts[method]+=1
        elif previous_by_stem.get(row['stem'],{}).get('full_sequence_evidence'):
            old=previous_by_stem[row['stem']];validate_alias(old);assert old['en_source']==en
            graph=WORK/old['full_sequence_evidence']['graph']
            if sha(graph)!=old['full_sequence_evidence']['graph_sha256']:raise ValueError('Applied sequence evidence changed')
            recoveries.append(old);counts[old['method']]+=1
        else:
            same=[j for j in jp if identity(j['path'])==identity(en['path'])]
            unresolved.append({'stem':row['stem'],'en_path':en['path'],'en_users':sorted(ids(en['clip'])),'reason':method,'same_jp_asset_materials':len(same),'status':'evidence-pending' if same or aliases else 'no-jp-asset-or-voice-id-in-complete-voice-index'})
    result={'version':VERSION,'original_missing_jp_rows':len(target_stems),'original_jp_materials':len(jp),'new_jp_materials':0,'recovered_alias_rows':len(recoveries),'method_counts':dict(counts),'recoveries':recoveries,'unresolved':unresolved}
    if MANIFEST.exists():
        old=json.loads(MANIFEST.read_text())
        if old.get('database_applied'):
            if {r['stem']:r for r in old.get('recoveries',[])}!={r['stem']:r for r in result['recoveries']}:raise ValueError('Refuse to replace already applied recovery identity; preserve and explicitly merge a new plan')
            result['files_verified']=old.get('files_verified',False);result['database_applied']=old['database_applied']
    atomic_json(MANIFEST,result);return result

def alias_source(recovery):
    source=copy.deepcopy(recovery['jp_source']);clip=source['clip'];clip['original_stem']=clip['stem'];clip['original_audio_path']=clip['audio_path'];clip['stem']=recovery['stem'];clip['audio_path']=recovery['target_audio_path'];return source

def recovery_proof(recovery):
    source=recovery['jp_source'];proof={'version':VERSION,'method':recovery['method'],'original_jp_source_path':source['path'],'original_jp_clip_index':source['clip']['clip_index'],'original_jp_audio_path':source['clip']['audio_path'],'original_jp_stem':source['clip']['stem'],'pcm_sha256':source['clip']['pcm_sha256'],'mp3_sha256':source['clip']['mp3_sha256'],'audio_alias_path':recovery['target_audio_path'],'equivalent_jp_aliases':recovery['equivalent_jp_aliases'],'new_material':False}
    if recovery.get('full_sequence_evidence'):proof['full_sequence_evidence']=recovery['full_sequence_evidence']
    return proof

def validate_alias(recovery):
    source=DATA/recovery['jp_source']['clip']['audio_path'];target=DATA/recovery['target_audio_path'];expected=recovery['jp_source']['clip']['mp3_sha256']
    if not source.is_file() or not target.is_file() or sha(source)!=expected or sha(target)!=expected:raise ValueError('JP source/alias bytes mismatch: '+recovery['stem'])
    return True

def prepare_files(manifest):
    for r in manifest['recoveries']:
        source=DATA/r['jp_source']['clip']['audio_path'];target=DATA/r['target_audio_path'];expected=r['jp_source']['clip']['mp3_sha256']
        if sha(source)!=expected:raise ValueError('Original JP source changed: '+str(source))
        if target.exists():
            if sha(target)!=expected:raise ValueError('Refuse to overwrite existing JP audio: '+str(target))
        else:
            temp=target.with_name('.'+target.name+'.'+uuid.uuid4().hex+'.tmp')
            try:
                shutil.copyfile(source,temp)
                with temp.open('rb') as f:os.fsync(f.fileno())
                if sha(temp)!=expected:raise ValueError('Copied JP bytes mismatch')
                temp.replace(target)
            finally:
                if temp.exists():temp.unlink()
        validate_alias(r)
    manifest['files_verified']=True;atomic_json(MANIFEST,manifest)

def apply_db(manifest):
    import psycopg
    from psycopg.types.json import Jsonb
    state=json.loads((PROJECT/'.private/bootstrap-state.json').read_text());assert state['role']=='ff7remake' and state['database']=='studio_ff7_remake'
    assert json.loads((DATA/'.ff7-game.json').read_text())=={'game_id':'remake','database':'studio_ff7_remake'}
    changed=already=0
    with psycopg.connect(host='127.0.0.1',port=25432,dbname=state['database'],user=state['role'],password=state['password']) as db:
        assert db.execute('SELECT current_database(),current_user').fetchone()==('studio_ff7_remake','ff7remake')
        for r in manifest['recoveries']:
            validate_alias(r);row=db.execute('SELECT extra FROM line_meta WHERE stem=%s',(r['stem'],)).fetchone()
            if not row:raise ValueError('Missing stable catalog row: '+r['stem'])
            extra=row[0]
            if extra.get('jp_recovery',{}).get('version')==VERSION:
                if extra.get('audio_sources',{}).get('jp',{}).get('clip',{}).get('audio_path')!=r['target_audio_path']:raise ValueError('Existing recovery changed')
                already+=1;continue
            if extra.get('audio_sources',{}).get('jp') or not extra.get('audio_extraction',{}).get('missing_jp'):raise ValueError('JP source changed; refusing overwrite: '+r['stem'])
            if extra['audio_sources']['en']!=r['en_source']:raise ValueError('English source changed: '+r['stem'])
            guard=extra['audio_extraction']|r['audio_extraction'];duration=r['jp_source']['clip']['duration_s']
            result=db.execute("""UPDATE line_meta SET extra=jsonb_set(jsonb_set(jsonb_set(extra,'{audio_sources,jp}',%s),'{audio_extraction}',%s),'{jp_recovery}',%s),jp_start_s=0,jp_end_s=%s,jp_dur_s=%s WHERE stem=%s AND extra->'audio_sources'->'jp' IS NULL AND extra->'audio_sources'->'en'=%s AND extra->'audio_extraction'=%s""",(Jsonb(alias_source(r)),Jsonb(guard),Jsonb(recovery_proof(r)),duration,duration,r['stem'],Jsonb(r['en_source']),Jsonb(extra['audio_extraction'])))
            if result.rowcount!=1:raise ValueError('Concurrent JP source change; transaction rolled back: '+r['stem'])
            changed+=1
    manifest['database_applied']={'updated':changed,'already_applied':already,'total_registered_alias_rows':len(manifest['recoveries'])};atomic_json(MANIFEST,manifest);return changed,already

def apply_recovery_overlay(rows,report=None):
    if not MANIFEST.exists():return 0
    manifest=json.loads(MANIFEST.read_text())
    if not manifest.get('files_verified') or not manifest.get('database_applied'):return 0
    bystem={r['stem']:r for r in manifest['recoveries']};applied=0
    for row in rows:
        r=bystem.get(row['stem'])
        if not r:continue
        validate_alias(r);extra=row['extra']
        if extra.get('audio_sources',{}).get('en')!=r['en_source']:raise ValueError('Catalog English source changed: '+r['stem'])
        if extra.get('audio_sources',{}).get('jp') and not extra.get('jp_recovery'):continue
        previously_missing=extra['audio_extraction']['missing_jp'];extra['audio_sources']['jp']=alias_source(r);extra['audio_extraction'].update(r['audio_extraction']);extra['jp_recovery']=recovery_proof(r);row['jp_dur_s']=r['jp_source']['clip']['duration_s'];applied+=1
        if report and previously_missing:
            summary=report['summary'];summary['jp']+=1;summary['missing_jp']-=1;summary['english_paired']+=1;summary['preview_only']+=r['audio_extraction']['preview_only']
    if report:report['jp_recovery']={'version':VERSION,'alias_rows':applied,'original_jp_materials':manifest['original_jp_materials'],'new_jp_materials':0}
    return applied

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--apply',action='store_true');args=p.parse_args()
    manifest=json.loads(MANIFEST.read_text()) if args.apply and MANIFEST.exists() else make_plan()
    if args.apply:prepare_files(manifest);apply_db(manifest)
    print(json.dumps({k:v for k,v in manifest.items() if k not in {'recoveries','unresolved'}},ensure_ascii=False))
