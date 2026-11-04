#!/usr/bin/env python3
"""CAS-fill empty Remake speakers from actual cue/actor/model evidence, no inference."""
from __future__ import annotations
import argparse,collections,hashlib,json,re
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb
from build_catalog import PROJECT,WORK,speaker_code,load_text,actor
VERSION='remake-speaker-source-v1';FOLDER=WORK/'speaker-recovery';PLAN=FOLDER/'plan.json'
GENERIC={'mbn','gtn','gya','ava','gyma','copy'}
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def filehash(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path,value):
    path.parent.mkdir(exist_ok=True,parents=True);tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');tmp.replace(path)
def cue_parts(value):
    v=value.lstrip('$').casefold().removesuffix('_copy');parts=v.split('_');code=speaker_code(v)
    return ('_'.join(parts[:-3]) if parts[-1].isdigit() else '_'.join(parts[:-2])),code

def connect():
    state=json.loads((PROJECT/'.private/bootstrap-state.json').read_text());assert (state['database'],state['role'])==('studio_ff7_remake','ff7remake')
    db=psycopg.connect(host='127.0.0.1',port=25432,dbname=state['database'],user=state['role'],password=state['password'],autocommit=True)
    assert db.execute('SELECT current_database(),current_user').fetchone()==('studio_ff7_remake','ff7remake');return db

def metadata():
    docs={};actors=collections.defaultdict(list);bindings=collections.defaultdict(list);specs={};blueprints=collections.defaultdict(list)
    for f in (WORK/'chapter-refinement/logic-metadata/json').rglob('*.json'):
        d=json.loads(f.read_text());path=d['source']['path'];entries=d['uexp']['entries'];assert len(entries)==len({e['$tag'] for e in entries}),'FName collision; do not use lossy metadata'
        docs[path]={'source':d['source'],'entries':{e['$tag']:e for e in entries}};kind=Path(path).stem;area=path.split('/Field/',1)[1].split('/')[0] if '/Field/' in path else 'Resident'
        for e in entries:
            if kind in {'PlannerEventChara','ObjectActor'}:
                item={'asset':path,'row_id':e['$tag'],'actor_name':e.get('ActorName'),'chara_spec':e.get('CharaSpecName') or e.get('CharaSpecId'),'entry_sha256':digest(e)}
                for identity in {e['$tag'],e.get('ActorName')}:
                    if identity and identity!='None':actors[(area,identity.casefold())].append(item)
            elif kind in {'TalkSequence','PlannerEvent'}:
                voice=e.get('VoiceID') or e.get('SoundID');talker=e.get('Talker')
                if not voice or not talker or talker=='None':continue
                group,code=cue_parts(voice);bindings[(area,code)].append({'asset':path,'row_id':e['$tag'],'voice_id':voice,'text_id':e.get('TextID'),'talker':talker,'group':group,'entry_sha256':digest(e)})
            elif kind=='CharaSpec':specs[e['$tag']]={'asset':path,'row_id':e['$tag'],'chara_id':e.get('CharaID'),'contents_model':e.get('ContentsModel'),'entry_sha256':digest(e)}
    for line in (WORK/'indexes/pak-files.jsonl').open():
        row=json.loads(line)
        if '/BluePrint/Character/' in row['path'] and row['path'].endswith('.uasset'):blueprints[Path(row['path']).stem].append(row['path'])
    return docs,actors,bindings,specs,blueprints

def resolve_model(area,talker,actors,specs,blueprints):
    rows=actors[(area,talker.casefold())] or actors[('Resident',talker.casefold())];rows=[r for r in rows if r.get('chara_spec') and r['chara_spec']!='None'];names={r['chara_spec'] for r in rows}
    if len(names)!=1:return None
    name=next(iter(names))
    if name not in specs or not blueprints[name]:return None
    return {'chara_spec':name,'actor_rows':list({(r['asset'],r['row_id']):r for r in rows}.values()),'character_spec_row':specs[name],'blueprints':blueprints[name]}

def choose_actor(area,group,code,bindings,actors,specs,blueprints,known_voices,definitions):
    if code in GENERIC or not code or code not in definitions:return None
    records=[r for r in bindings[(area,code)] if known_voices.get(r['voice_id'].lstrip('$').casefold())=={code}]
    local=[r for r in records if r['group']==group]
    if local and len({r['talker'] for r in local})==1:
        model=resolve_model(area,local[0]['talker'],actors,specs,blueprints)
        if model:return {'basis':'same-cue-group-unique-talker-character-model','voice_bindings':local,'actor_models':[model]}
    models=[]
    for row in records:
        model=resolve_model(area,row['talker'],actors,specs,blueprints)
        if not model:return None
        models.append(model)
    if models and len({m['chara_spec'] for m in models})==1:return {'basis':'same-area-speaker-code-unique-character-model','voice_bindings':records,'actor_models':list({m['chara_spec']:m for m in models}.values())}
    return None

def snapshot(db):
    rows=[]
    for stem,speaker,asset,extra in db.execute('SELECT l.stem,l.speaker,l.asset_path,m.extra FROM lines l JOIN line_meta m USING(stem)'):
        rows.append({'stem':stem,'speaker':speaker,'asset_path':asset,'extra':extra})
    definitions={r[0]:{'code':r[0],'name_zh':r[1],'name_jp':r[2],'source':r[3]} for r in db.execute('SELECT code,name_zh,name_jp,source FROM speakers')};return rows,definitions

def prepare():
    docs,actors,bindings,specs,blueprints=metadata()
    with connect() as db:rows,definitions=snapshot(db)
    known=collections.defaultdict(set);witnesses=collections.defaultdict(list);pcm=collections.defaultdict(list)
    baseline=json.loads((FOLDER/'baseline.json').read_text());targets={r['stem'] for r in baseline['rows']};target_rows={r['stem']:r for r in rows if r['stem'] in targets};texts=load_text()
    for row in rows:
        if not row['speaker']:continue
        for source in row['extra'].get('audio_sources',{}).values():
            for voice in {source.get('source_stem',''),*source.get('clip',{}).get('users',[])}:
                if voice:known[voice.casefold()].add(row['speaker']);witnesses[(voice.casefold(),row['speaker'])].append(row['stem'])
        source=row['extra'].get('audio_sources',{}).get('jp')
        if source:
            c=source['clip'];pcm[(c['pcm_sha256'],c['channels'],c['sample_rate'],c['pcm_frames'])].append({'row':row,'source':source})
    previous=json.loads(PLAN.read_text()) if PLAN.exists() else {};previous_by_stem={r['stem']:r for r in previous.get('proposals',[])}
    proposals=[];unresolved=[]
    for row in target_rows.values():
        old=previous_by_stem.get(row['stem'])
        if old and row['speaker']==old['speaker'] and row['extra'].get('speaker_recovery')==old['proof']:
            source=row['extra'].get('audio_sources',{}).get('jp');identity={'path':source['path'],'clip_index':source['clip']['clip_index'],'mp3_sha256':source['clip']['mp3_sha256']} if source else None
            if identity==old['jp_source_identity']:proposals.append(old);continue

        if row['speaker'] and row['extra'].get('speaker_recovery',{}).get('version')!=VERSION:continue
        source=row['extra'].get('audio_sources',{}).get('jp')
        if not source:continue
        path=source['path'];area=path.split('/Field/',1)[1].split('/')[0] if '/Field/' in path else path.split('/Cut/',1)[1].split('/')[0] if '/Cut/' in path else None;group,code=cue_parts(source['source_stem']);proof=choose_actor(area,group,code,bindings,actors,specs,blueprints,known,definitions)
        if proof:
            proof['existing_speaker']=definitions[code];proof['known_voice_id_witnesses']=[{'voice_id':b['voice_id'],'speaker':code,'stems':witnesses[(b['voice_id'].lstrip('$').casefold(),code)][:3]} for b in proof['voice_bindings']]
        elif code not in GENERIC:
            c=source['clip'];matches=pcm[(c['pcm_sha256'],c['channels'],c['sample_rate'],c['pcm_frames'])];alias=[]
            for candidate in matches:
                anchor=candidate['source'];candidate_code=candidate['row']['speaker']
                if candidate_code in GENERIC:continue
                # Require the same complete cue position, not a similar voice or generic PCM reuse.
                prefix=re.sub(r'_[A-Za-z0-9]+_\d+$','',source['source_stem'].rstrip('_'))
                other_prefix=re.sub(r'_[A-Za-z0-9]+_\d+$','',anchor['source_stem'])
                malformed=source['source_stem'].endswith('_') and anchor['source_stem']==source['source_stem']+'0'
                if not malformed and prefix!=other_prefix:continue
                official=[{'language':lang,'asset':h['asset'],'id':anchor['source_stem'],'actor':actor(h['entry'])} for lang in ['CN','JP','US'] for h in texts.get((lang,anchor['source_stem'].casefold()),[]) if actor(h['entry'])]
                if not official:continue
                alias.append({'speaker':candidate_code,'stem':candidate['row']['stem'],'source_path':anchor['path'],'source_stem':anchor['source_stem'],'pcm_sha256':c['pcm_sha256'],'official_actor':official})
            names={r['speaker'] for r in alias}
            if len(names)==1:
                code=next(iter(names));proof={'basis':'same-complete-cue-position-and-identical-pcm-official-actor-alias','alias_witnesses':alias,'existing_speaker':definitions[code]}
        if proof:
            proposals.append({'stem':row['stem'],'speaker':code,'asset_path':row['asset_path'],'jp_source_identity':{'path':source['path'],'clip_index':source['clip']['clip_index'],'mp3_sha256':source['clip']['mp3_sha256']},'proof':{'version':VERSION,'decoder':'fname-number-preserving-v2','source_stem':source['source_stem'],'source_area':area,'source_cue_group':group,'identity_scope':'game-internal-speaker-id-and-actor-model-not-invented-display-name',**proof}})
        else:unresolved.append({'stem':row['stem'],'source_stem':source['source_stem'],'code':code,'reason':'collective-or-mixed-source-code' if code in GENERIC else 'no-unique-cue-actor-model-or-official-alias-chain'})
    result={'version':VERSION,'baseline_real_jp_missing_speaker':len(targets),'proposals':proposals,'unresolved':unresolved,'summary':{'proposed':len(proposals),'unresolved':len(unresolved),'methods':dict(collections.Counter(r['proof']['basis'] for r in proposals))}};write(PLAN,result);return result

def apply(plan):
    previous=json.loads((FOLDER/'applied.json').read_text()) if (FOLDER/'applied.json').exists() else {}
    ever=set(previous.get('ever_applied_stems',[]))|{r['stem'] for r in previous.get('results',[]) if r['state'] in {'filled-empty-speaker','already-applied'}}
    results=[]
    with connect() as db:
        for entry in plan['proposals']:
            with db.transaction():
                row=db.execute('SELECT l.speaker,l.asset_path,m.extra FROM lines l JOIN line_meta m USING(stem) WHERE l.stem=%s FOR UPDATE OF l,m',(entry['stem'],)).fetchone()
                if not row:results.append({'stem':entry['stem'],'state':'deleted'});continue
                speaker,asset,extra=row
                if speaker and speaker.strip():results.append({'stem':entry['stem'],'state':'already-applied' if speaker==entry['speaker'] and extra.get('speaker_recovery')==entry['proof'] else 'kept-existing-speaker'});continue
                if entry['stem'] in ever:results.append({'stem':entry['stem'],'state':'kept-cleared-after-recovery'});continue
                source=extra.get('audio_sources',{}).get('jp');identity={'path':source['path'],'clip_index':source['clip']['clip_index'],'mp3_sha256':source['clip']['mp3_sha256']} if source else None
                if asset!=entry['asset_path'] or identity!=entry['jp_source_identity'] or extra.get('manual_speaker'):results.append({'stem':entry['stem'],'state':'kept-changed-source-or-manual-speaker'});continue
                assert filehash(PROJECT/'website/data'/source['clip']['audio_path'])==identity['mp3_sha256']
                changed=db.execute("UPDATE lines SET speaker=%s WHERE stem=%s AND NULLIF(btrim(speaker),'') IS NULL RETURNING stem",(entry['speaker'],entry['stem'])).fetchone();assert changed
                db.execute("UPDATE line_meta SET extra=jsonb_set(COALESCE(extra,'{}'::jsonb),'{speaker_recovery}',%s) WHERE stem=%s",(Jsonb(entry['proof']),entry['stem']))
                results.append({'stem':entry['stem'],'state':'filled-empty-speaker','speaker':entry['speaker']});ever.add(entry['stem'])
    report={'version':VERSION,'results':results,'ever_applied_stems':sorted(ever),'summary':dict(collections.Counter(r['state'] for r in results))};write(FOLDER/'applied.json',report);return report

def apply_speaker_recovery_overlay(rows):
    if not PLAN.exists() or not (FOLDER/'applied.json').exists():return 0
    plan=json.loads(PLAN.read_text());applied=json.loads((FOLDER/'applied.json').read_text());stems={r['stem'] for r in applied['results'] if r['state'] in {'filled-empty-speaker','already-applied'}};by={r['stem']:r for r in plan['proposals']};n=0
    for row in rows:
        entry=by.get(row['stem'])
        if not entry or row['stem'] not in stems or row.get('speaker') or row['extra'].get('manual_speaker'):continue
        source=row['extra'].get('audio_sources',{}).get('jp')
        if row['asset_path']!=entry['asset_path'] or not source or source['path']!=entry['jp_source_identity']['path'] or source['clip']['mp3_sha256']!=entry['jp_source_identity']['mp3_sha256']:continue
        row['speaker']=entry['speaker'];row['extra']['speaker_recovery']=entry['proof'];n+=1
    return n
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--apply',action='store_true');a=p.parse_args();plan=json.loads(PLAN.read_text()) if a.apply and PLAN.exists() else prepare()
    print(json.dumps(plan['summary'],ensure_ascii=False))
    if a.apply:print(json.dumps(apply(plan)['summary'],ensure_ascii=False))
