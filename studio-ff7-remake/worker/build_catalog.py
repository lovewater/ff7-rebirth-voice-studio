#!/usr/bin/env python3
"""Catalog only verified Remake clips; preserve official provenance and unresolved chapter candidates."""
from __future__ import annotations
from pathlib import Path
import collections,json,re,html,sys
ROOT=Path(__file__).resolve().parents[2];PROJECT=ROOT/'studio-ff7-remake';WORK=PROJECT/'work'

def clean(value):
    return re.sub(r'</?i>','',re.sub(r'<br\s*/?>','\n',value,flags=re.I),flags=re.I).replace('\\r\\n','\n').replace('\r\n','\n').strip()
def actor(entry):
    return next((clean(x['text']) for x in entry.get('sub_entries',[]) if x['id'].upper()=='ACTOR'),'')
def speaker_code(stem):
    parts=stem.lstrip('$').split('_');candidate=parts[-2] if len(parts)>1 and parts[-1].isdigit() else parts[-1]
    return candidate.casefold() if re.fullmatch(r'[A-Za-z0-9]{2,11}',candidate or '') and re.search(r'[A-Za-z]',candidate or '') else None

def load_text():
    result=collections.defaultdict(list)
    for file in sorted((WORK/'text-json/Text').glob('*/*.json')):
        d=json.loads(file.read_text());lang=d['language'];area=file.stem.removesuffix('_TxtRes')
        for entry in d.get('entries',[]):
            result[(lang,entry['id'].lstrip('$').casefold())].append({'entry':entry,'asset':str(file.relative_to(WORK/'text-json')),'area':area})
    return result

def choose_text(texts,language,voice_id,area):
    hits=texts.get((language,voice_id.casefold()),[])
    preferred=[h for h in hits if h['area']==area]
    if preferred:hits=preferred
    bodies={clean(h['entry']['text']) for h in hits}
    if len(bodies)>1:return None,{'status':'ambiguous','candidates':[h['asset'] for h in hits]}
    if not hits:return None,{'status':'missing'}
    return hits[0],{'status':'exact','asset':hits[0]['asset'],'id':hits[0]['entry']['id'],'source_area':area,'text_area':hits[0]['area'],'resolution':'same-source-area' if preferred else 'unique-body-global-id'}

def resolve_clip_text(texts,language,voice_ids,area):
    matches=[];unresolved=[]
    for candidate in voice_ids:
        hit,proof=choose_text(texts,language,candidate,area)
        if hit:matches.append((hit,proof))
        elif proof['status']=='ambiguous':unresolved.append({'voice_id':candidate,**proof})
    bodies={clean(hit['entry']['text']) for hit,_ in matches}
    if len(bodies)==1 and not unresolved:return matches[0]
    return None,{'status':'ambiguous-clip' if matches or unresolved else 'missing','candidate_ids':voice_ids,'ambiguous_ids':unresolved,'matching_sources':[proof for _,proof in matches]}

def text_index_audit(texts):
    duplicates=collections.Counter({lang:0 for lang,_ in texts});conflicts=[]
    language_entries=collections.Counter()
    for (lang,_),hits in texts.items():language_entries[lang]+=len(hits)
    for (language,voice_id),hits in texts.items():
        if len(hits)>1:duplicates[language]+=1
        if len({clean(h['entry']['text']) for h in hits})>1:
            conflicts.append({'language':language,'id':voice_id,'candidates':[{'asset':h['asset'],'area':h['area'],'text':clean(h['entry']['text'])} for h in hits]})
    return {'entries':sum(map(len,texts.values())),'entries_by_language':dict(language_entries),'duplicate_ids_by_language':dict(duplicates),'conflicting_bodies_by_language':{lang:sum(c['language']==lang for c in conflicts) for lang in language_entries},'conflicts':conflicts}

def speaker_facts(texts,index_file=None):
    """Default names from strong official-label consensus, role from this game's assets."""
    tallies=collections.defaultdict(lambda:collections.defaultdict(collections.Counter));samples=collections.defaultdict(list)
    for (lang,voice_id),hits in texts.items():
        code=speaker_code(voice_id)
        if not code:continue
        for hit in hits:
            name=actor(hit['entry'])
            if not name:continue
            tallies[code][lang][name]+=1
            if len(samples[(code,lang,name)])<3:samples[(code,lang,name)].append({'asset':hit['asset'],'id':hit['entry']['id']})
    norm=lambda name:re.sub(r'[^a-z0-9]','',name.casefold())
    asset_roles=collections.defaultdict(list);bank_roles={}
    index_file=index_file or WORK/'indexes/voice-assets.jsonl'
    for line in index_file.read_text().splitlines():
        item=json.loads(line);path=item['path']
        if '/Voice/JP/Character/' not in path:continue
        stem=Path(path).stem
        match=re.fullmatch(r'VO_(PC|NP|EB)\d+_\d+_(.+?)(?:_Standard.*)?',stem)
        if not match:continue
        code,label=match.groups();role='主角' if code=='PC' else '配角'
        evidence={'asset':path,'english_asset_label':label,'role':role,'basis':'this-game-character-player-or-named-character-asset'}
        asset_roles[norm(label)].append(evidence);bank_roles['bank_'+stem.casefold()]=evidence
    facts={}
    for code,langs in tallies.items():
        proof={'method':'official-actor-label-consensus','minimum_nonempty_labels':3,'minimum_share':0.90,'languages':{}}
        winners={}
        for lang,tally in langs.items():
            name,n=tally.most_common(1)[0];total=sum(tally.values());share=n/total
            proof['languages'][lang]={'winner':name,'winner_count':n,'nonempty_count':total,'share':share,'aliases':dict(tally),'samples':samples[(code,lang,name)]}
            if n>=3 and share>=0.90:winners[lang]=name
        english=winners.get('US');roles=asset_roles.get(norm(english or ''),[])
        proven_roles={r['role'] for r in roles}
        role=next(iter(proven_roles)) if len(proven_roles)==1 else None
        facts[code]={'name_zh':winners.get('CN'),'name_jp':winners.get('JP'),'source':'remake-txtres-consensus','role':role,'note':json.dumps(proof,ensure_ascii=False),'role_evidence':{'official_english_actor':english,'character_assets':roles} if role else None}
    for code,asset_proof in bank_roles.items():
        matches=[(k,f) for k,f in facts.items() if norm(json.loads(f['note']).get('languages',{}).get('US',{}).get('winner',''))==norm(asset_proof['english_asset_label']) and f['role']==asset_proof['role']]
        if not matches:continue
        source_code,source=max(matches,key=lambda kv:json.loads(kv[1]['note'])['languages']['US']['winner_count'])
        facts[code]={**source,'note':json.dumps({'method':'character-bank-label-and-official-actor-consensus','source_speaker_code':source_code,'asset':asset_proof,'actor_consensus':json.loads(source['note'])},ensure_ascii=False)}
    return facts

def load_metadata():
    docs={}
    for file in (WORK/'metadata-json').rglob('*.json'):
        d=json.loads(file.read_text());docs[d['source']['path']]=d['uexp']['entries']
    return docs

def voice_reference_facts(docs):
    references=collections.defaultdict(list);counts=collections.Counter()
    for path,entries in docs.items():
        typ=Path(path).stem
        if typ not in {'PlannerEvent','TalkSequence'}:continue
        for entry in entries:
            voice=entry.get('SoundID' if typ=='PlannerEvent' else 'VoiceID');text=entry.get('TextID')
            if not voice or not text or voice=='None' or text=='None':continue
            counts[typ+'_voice_text_pairs']+=1
            if voice.lstrip('$').casefold()!=text.lstrip('$').casefold():counts[typ+'_differing_ids']+=1
            references[voice.lstrip('$').casefold()].append({'asset':path,'row':entry['$tag'],'voice_id':voice,'text_id':text,'talker':entry.get('Talker')})
    return references,dict(counts)

def chapter_facts(docs,texts):
    chapters={};locations={};area_chapters=collections.defaultdict(set)
    for path,entries in docs.items():
        if path.endswith('/Resident/LocationResident.uasset'):
            locations={e['$tag']:e for e in entries}
    for path,entries in docs.items():
        if not path.endswith('/Resident/Chapter.uasset'):continue
        for e in entries:
            key=e['ChapterNameID']
            if key=='None':continue
            n,_=choose_text(texts,'CN',key.lstrip('$'),'Resident');titlekey=key.replace('chapter_number','chapter_title');t,_=choose_text(texts,'CN',titlekey.lstrip('$'),'Resident')
            if not n or not t or clean(t['entry']['text'])=='<>':continue
            num=int(re.search(r'\d+',n['entry']['text'])[0]);dlc=e['UniqueID']>=21
            title=f'INTERmission 第{num}章 · '+clean(t['entry']['text']) if dlc else f'第{num}章 · '+clean(t['entry']['text'])
            chapters[e['$tag']]={'code':'CH_'+e['$tag'][6:],'name_zh':title,'number':num,'campaign':'intermission' if dlc else 'main','order':200+num if dlc else num,'evidence':{'asset':path,'row':e['$tag'],'name_id':key,'title_id':titlekey},'locations':e['LocationResidentID_Array']}
            for loc in e['LocationResidentID_Array']:
                area_chapters[loc].add(e['$tag'])
                alias=locations.get(loc,{}).get('TruthLocationID')
                if alias and alias!='None':area_chapters[alias].add(e['$tag'])
    return chapters,area_chapters,locations

def category(path,caption):
    if '/Character/' in path:return '战斗语音','unknown','character-voice-bank'
    if '/Cut/' in path:return ('对话' if caption else '无字幕语音'),'scene','cutscene'
    if '/Field/' in path:
        group=path.split('/Field/',1)[1].split('/')[1]
        if group.startswith('BA_'):return '战斗对白','field','battle-talk'
        if group.startswith('PV_'):return '事件对白','unknown','planner-event-talk'
        return ('对话' if caption else '无字幕语音'),'field','field-talk'
    return '待分类','unknown','unclassified'

def usage_facts(path,area,locations):
    location=locations.get(area,{})
    fields={k:location.get(k) for k in ['$tag','Detail','UnuseRelease','HiddenFieldTest'] if k in location}
    reasons=[]
    if location.get('UnuseRelease') or location.get('HiddenFieldTest'):reasons.append('location-metadata-test-or-release-flag')
    if area=='002-IGNOR':reasons.append('source-directory-IGNOR-label-only')
    if re.search(r'/(Test|Tests|Debug)(/|_)',path,re.I):reasons.append('source-directory-test-label-only')
    return {'status':'special-directory-usage-unverified' if reasons else 'no-special-directory-warning','reasons':reasons,'source_area':area,'location_fields':fields,'location_flag_is_not_proof_asset_unused':True}

def content_facts(path,clip,usage):
    users=[x for x in clip.get('users',[]) if isinstance(x,str)]
    action=[x for x in users if re.match(r'(?i)^(atk|damage|guard|avoid|parry|jump|climb|crouch|breath|dead|recover|dodge)(_|$)',x)]
    if usage['status']=='special-directory-usage-unverified':category_name='usage-unverified'
    elif '/Character/' in path:
        category_name='character-action-voice' if action and len(action)==len(users) else 'battle-character-voice' if '/Character/Enemy/' in path else 'character-general-voice'
    elif '/Cut/' in path:category_name='scene-dialogue'
    elif '/Field/' in path:
        group=path.split('/Field/',1)[1].split('/')[1]
        category_name='battle-dialogue' if group.startswith('BA_') else 'announcement' if group.startswith('AN_') else 'planner-event-dialogue' if group.startswith('PV_') else 'map-dialogue'
    else:category_name='unclassified'
    return {'category':category_name,'source_path':path,'action_voice_ids':action,'basis':'source-path-and-explicit-voice-id-names-only'}

def read_journal():
    latest={};file=WORK/'voice-extraction.jsonl'
    # The extractor flushes one newline-terminated record at a time. A bank can
    # have a large JSON record; never decode or accept the in-flight tail.
    records=file.read_bytes().splitlines(keepends=True) if file.exists() else []
    for i,line in enumerate(records):
        if i==len(records)-1 and not line.endswith(b'\n'):continue
        if not line.strip():continue
        try:r=json.loads(line)
        except (json.JSONDecodeError,UnicodeDecodeError) as exc:
            raise ValueError(f'Malformed completed extraction record at line {i+1}') from exc
        latest[(r['language'],r['path'])]=r
    return latest.values()

def audio_identity(asset,clip):
    normalized=re.sub(r'/Voice/(JP|US)/','/Voice/',asset['path'])
    bank='/Character/' in asset['path'] or len(asset.get('clips',[]))>1 or asset.get('is_build_pack')
    users=tuple(sorted(set(str(x).casefold() for x in clip.get('users',[]) if isinstance(x,str))))
    return normalized,bank,users

def group_audio_sources(journal):
    """Pair bank voices only by unique exact internal IDs, never material index."""
    grouped=collections.defaultdict(dict);excluded=[]
    ready=[a for a in journal if a.get('status') in {'ready','ok','extracted'}]
    direct_hashes=collections.defaultdict(lambda:collections.defaultdict(list))
    for asset in ready:
        if not asset.get('is_build_pack'):
            for clip in asset.get('clips',[]):
                if clip.get('pcm_sha256'):direct_hashes[asset['language']][clip['pcm_sha256']].append(clip['stem'])
    user_counts=collections.Counter((a['language'],audio_identity(a,c)[0],audio_identity(a,c)[2]) for a in ready for c in a.get('clips',[]) if audio_identity(a,c)[1])
    for asset in ready:
        for clip in asset.get('clips',[]):
            aliases=direct_hashes[asset['language']].get(clip.get('pcm_sha256'),[]) if asset.get('is_build_pack') else []
            if aliases:
                excluded.append({'path':asset['path'],'language':asset['language'],'clip_index':clip['clip_index'],'reason':'build-clip-pcm-identical-to-direct-source','pcm_sha256':clip['pcm_sha256'],'aliases':aliases});continue
            lang=asset['language'];normalized,bank,users=audio_identity(asset,clip)
            verified_users=bank and users and user_counts[('jp',normalized,users)]==1 and user_counts[('en',normalized,users)]==1
            key=('users',normalized,users) if verified_users else ('single',normalized) if not bank else ('unpaired-bank',lang,clip['stem'].casefold())
            if lang in grouped[key]:raise ValueError('Canonical collision: '+clip['stem'])
            grouped[key][lang]=(asset,clip)
    return grouped,excluded

def build():
    texts=load_text();speaker_defaults=speaker_facts(texts);docs=load_metadata();voice_references,reference_audit=voice_reference_facts(docs);chapters,area_chapters,locations=chapter_facts(docs,texts)
    by_stem=collections.defaultdict(dict);excluded=[]
    journal=list(read_journal())
    asset_statuses=collections.Counter(a.get('status','missing') for a in journal)
    non_playable=[{k:a.get(k) for k in ['pak','path','language','status','reason','is_build_pack']} for a in journal if a.get('status') not in {'ready','ok','extracted'}]
    by_stem,excluded=group_audio_sources(journal)
    rows=[];counts=collections.Counter();speakers={};regions={c['code']:{'name_zh':c['name_zh'],'sort_order':c['order']*100,'note':json.dumps(c['evidence'],ensure_ascii=False)} for c in chapters.values()}
    for _,sources in sorted(by_stem.items()):
        primary=sources.get('jp') or sources.get('en');asset,clip=primary;stem=clip['stem']+('__en' if 'jp' not in sources and audio_identity(asset,clip)[1] else '');path=asset['path'];parts=path.split('/Voice/',1)[1].split('/');area=parts[2] if parts[1] in {'Cut','Field'} else None
        source_id=asset['source_stem'];resolved={};text_evidence={}
        # Never copy a whole asset's caption to every subclip in a multi-entry bank.
        ids=[clip.get('material_name')]
        def strings(value):
            if isinstance(value,str):yield value.lstrip('$')
            elif isinstance(value,dict):
                for v in value.values():yield from strings(v)
            elif isinstance(value,list):
                for v in value:yield from strings(v)
        ids.extend(strings(clip.get('users',[])))
        if len(asset.get('clips',[]))==1:ids.append(source_id)
        ids=list(dict.fromkeys(i for i in ids if i))
        for lang in ['CN','JP','US']:
            resolved[lang],text_evidence[lang]=resolve_clip_text(texts,lang,ids,area)
            if resolved[lang]:
                matched=text_evidence[lang]['id'].lstrip('$').casefold();internal={str(v).lstrip('$').casefold() for v in [clip.get('material_name'),*list(strings(clip.get('users',[])))] if v}
                text_evidence[lang]['voice_binding']={'basis':'clip-internal-voice-id' if matched in internal else 'single-source-asset-stem','source_asset':path,'source_clip_index':clip['clip_index'],'voice_id':matched,'metadata_references':voice_references.get(matched,[])}
        cn=resolved['CN'];jp=resolved['JP'];en=resolved['US'];caption=cn or jp or en
        sp=speaker_code(source_id) if caption else None
        if not sp and '/Character/' in path:sp='bank_'+source_id.casefold()
        if sp and sp not in speakers:speakers[sp]=speaker_defaults.get(sp,{'name_zh':None,'name_jp':None,'source':'remake-txtres','note':None,'role':None,'role_evidence':None})
        candidates=sorted(area_chapters.get(area,set()));campaigns={chapters[c]['campaign'] for c in candidates};campaign=next(iter(campaigns)) if len(campaigns)==1 else 'unknown'
        usage=usage_facts(path,area,locations);content=content_facts(path,clip,usage)
        chapter_classification='not-applicable' if '/Character/' in path else 'usage-unverified' if usage['status']=='special-directory-usage-unverified' else 'single' if len(candidates)==1 else 'shared' if candidates else 'unknown'
        if chapter_classification=='not-applicable':
            region='CHARACTER_VOICE';regions[region]={'name_zh':'角色通用 / 战斗语音（不按章）','sort_order':30000,'note':'Character声库用于多种状态或场景；不计入剧情分章失败。'};counts['chapter_not_applicable']+=1
        elif chapter_classification=='usage-unverified':
            region='USAGE_UNVERIFIED_'+(area or 'OTHER').replace('-','_');regions[region]={'name_zh':'公共/测试目录 · 使用待确认 · '+(area or 'OTHER'),'sort_order':35000,'note':'源目录/Location标记需核实际引用；不证明声音未使用，保留全部资源。'};counts['chapter_usage_unverified']+=1
        elif len(candidates)==1:region=chapters[candidates[0]]['code'];counts['single_chapter']+=1
        elif candidates:
            region='SHARED_'+area.replace('-','_');names=' / '.join(chapters[c]['name_zh'].split(' · ')[0] for c in candidates)
            regions[region]={'name_zh':names+' · 跨章待细分','sort_order':min(chapters[c]['order'] for c in candidates)*100+99,'note':'候选来自Chapter.LocationResidentID与LocationResident.TruthLocationID，不按编号猜章；缺逐句触发证据。'};counts['shared_chapters']+=1
        else:
            region='BATTLE' if '/Character/' in path else 'UNASSIGNED_'+(area or 'OTHER').replace('-','_')
            regions[region]={'name_zh':'战斗语音（跨章节）' if region=='BATTLE' else '未确定章节 · '+(area or '其他'),'sort_order':30000 if region=='BATTLE' else 40000,'note':'未有唯一章节证据，保留实际源路径。'};counts['unknown_chapter']+=1
        kind,mode,typ=category(path,caption)
        if content['category']=='usage-unverified':kind,mode='使用待确认','unknown'
        elif content['category']=='character-action-voice':kind='角色动作语音'
        elif content['category']=='character-general-voice':kind='角色通用语音'
        elif content['category']=='announcement':kind,mode='广播语音','unknown'
        singing=[{'language':lang,'asset':text_evidence[lang].get('asset'),'id':text_evidence[lang].get('id'),'marker':'♪'} for lang,hit in resolved.items() if hit and '♪' in hit['entry']['text']]
        jp_source=sources.get('jp');jc=jp_source[1] if jp_source else None
        preview=bool(jc and (jp_source[0].get('is_build_pack') or jc.get('channels',0)>2 or jc.get('eligible_for_generation') is False or jc.get('special_handling')=='multichannel-preview-only'))
        extra={'game_id':'remake','has_original_chinese_audio':False,'official_text_evidence':text_evidence,'chapter_candidates':[chapters[c] for c in candidates],'chapter_classification':chapter_classification,'resource_usage':usage,'content_classification':content,'performance_tags':{'singing_subtitle_marker':bool(singing),'evidence':singing},'campaign':campaign,'resource_type':typ,'english_pairing':{'status':'verified-user-ids' if 'jp' in sources and 'en' in sources and audio_identity(asset,clip)[1] else 'same-single-asset' if 'jp' in sources and 'en' in sources else 'unpaired','en_audio_path':sources['en'][1]['audio_path'] if 'en' in sources else None},'source_stem':source_id,'audio_sources':{k:{**{field:a.get(field) for field in ['pak','path','source_stem','output_stem','asset_sha256','uasset_sha256','is_build_pack']},'clip':c} for k,(a,c) in sources.items()},'audio_extraction':{'language':'jp','channels':jc.get('channels') if jc else None,'preview_only':preview,'eligible_for_generation':jc is not None and not preview,'missing_jp':jc is None,'source_clip_index':jc.get('clip_index') if jc else None,'source_path':jp_source[0]['path'] if jp_source else None,'source_pak':jp_source[0]['pak'] if jp_source else None}}
        rows.append({'stem':stem,'pack':asset['pak'],'filename':Path(path).name,'asset_path':path,'region':region,'speaker':sp,'kind':kind,'dialogue_mode':mode,'text_zh':clean(cn['entry']['text']) if cn else None,'text_jp':clean(jp['entry']['text']) if jp else None,'text_en':clean(en['entry']['text']) if en else None,'subtitle_italic':bool(cn and '<i>' in cn['entry']['text'].lower()),'actor_zh':actor(cn['entry']) if cn else None,'actor_jp':actor(jp['entry']) if jp else None,'extra':extra,'jp_dur_s':jc.get('duration_s') if jc else None,'en_dur_s':sources['en'][1].get('duration_s') if 'en' in sources else None})
        counts['rows']+=1;counts['caption']+=bool(caption);counts['jp']+=bool(jc);counts['en']+=('en' in sources);counts['preview_only']+=preview;counts['missing_jp']+=not bool(jc);counts['english_paired']+=('en' in sources and 'jp' in sources)
    assert len({r['stem'] for r in rows})==len(rows),'Duplicate catalog stem'
    result={'metadata_voice_reference_audit':reference_audit,'text_index_audit':text_index_audit(texts),'content_categories':dict(collections.Counter(r['extra']['content_classification']['category'] for r in rows)),'asset_statuses':dict(asset_statuses),'non_playable_assets':non_playable,'summary':dict(counts),'regions':regions,'speakers':speakers,'chapters':chapters,'excluded_support_banks':excluded}
    from jp_recovery import apply_recovery_overlay
    apply_recovery_overlay(rows,result)
    from jp_source_absence import apply_absence_overlay
    result["jp_independent_source_absence_rows"]=apply_absence_overlay(rows)
    from jp_pairing_unresolved import apply_pairing_overlay
    result["jp_pairing_unresolved_rows"]=apply_pairing_overlay(rows)
    from refine_catalog import apply_chapter_refinement_overlay
    apply_chapter_refinement_overlay(rows,result)
    with (WORK/'voice-catalog.jsonl').open('w') as f:
        for row in rows:f.write(json.dumps(row,ensure_ascii=False)+'\n')
    (WORK/'classification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));return rows,result

def import_db(rows,report):
    import psycopg
    from psycopg.types.json import Jsonb
    state=json.loads((PROJECT/'.private/bootstrap-state.json').read_text());assert state['role']=='ff7remake' and state['database']=='studio_ff7_remake'
    assert json.loads((PROJECT/'website/data/.ff7-game.json').read_text())=={'game_id':'remake','database':'studio_ff7_remake'}
    with psycopg.connect(host='127.0.0.1',port=25432,dbname=state['database'],user=state['role'],password=state['password']) as conn:
        assert conn.execute('SELECT current_database(),current_user').fetchone()==('studio_ff7_remake','ff7remake')
        for code,r in report['regions'].items():conn.execute("INSERT INTO regions(code,name_zh,source,note,sort_order) VALUES(%s,%s,'remake-assets',%s,%s) ON CONFLICT(code) DO UPDATE SET name_zh=excluded.name_zh,note=excluded.note,sort_order=excluded.sort_order WHERE regions.source<>'manual'",(code,r['name_zh'],r['note'],r['sort_order']))
        for code,s in report['speakers'].items():
            conn.execute("""INSERT INTO speakers(code,name_zh,name_jp,source,note) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(code) DO UPDATE SET name_zh=CASE WHEN NULLIF(speakers.name_zh,'') IS NULL THEN excluded.name_zh ELSE speakers.name_zh END,name_jp=CASE WHEN NULLIF(speakers.name_jp,'') IS NULL THEN excluded.name_jp ELSE speakers.name_jp END,note=COALESCE(NULLIF(speakers.note,''),excluded.note) WHERE speakers.source IN ('remake-txtres','remake-txtres-consensus')""",(code,s['name_zh'],s['name_jp'],s['source'],s['note']))
            if s.get('role'):conn.execute("INSERT INTO cast_members(speaker,role,note) VALUES(%s,%s,%s) ON CONFLICT(speaker) DO NOTHING",(code,s['role'],json.dumps({'source':'remake-game-character-assets-and-official-actor','evidence':s['role_evidence']},ensure_ascii=False)))
        for r in rows:
            conn.execute('''INSERT INTO lines(pack,filename,stem,asset_path,region,speaker,kind,text_zh,text_jp,text_en,subtitle_italic) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(stem) DO UPDATE SET asset_path=excluded.asset_path,region=excluded.region,kind=excluded.kind,speaker=COALESCE(lines.speaker,excluded.speaker),text_jp=COALESCE(lines.text_jp,excluded.text_jp),text_zh=COALESCE(lines.text_zh,excluded.text_zh),text_en=COALESCE(lines.text_en,excluded.text_en)''',tuple(r[k] for k in ['pack','filename','stem','asset_path','region','speaker','kind','text_zh','text_jp','text_en','subtitle_italic']))
            conn.execute('''INSERT INTO line_meta(stem,actor_zh,actor_jp,extra,dialogue_mode,jp_start_s,jp_end_s,jp_dur_s,en_start_s,en_end_s,en_dur_s) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(stem) DO UPDATE SET extra=line_meta.extra||excluded.extra,dialogue_mode=excluded.dialogue_mode,jp_end_s=excluded.jp_end_s,jp_dur_s=excluded.jp_dur_s,en_end_s=excluded.en_end_s,en_dur_s=excluded.en_dur_s''',(r['stem'],r['actor_zh'],r['actor_jp'],Jsonb(r['extra']),r['dialogue_mode'],0 if r['jp_dur_s'] else None,r['jp_dur_s'],r['jp_dur_s'],0 if r['en_dur_s'] else None,r['en_dur_s'],r['en_dur_s']))
        conn.commit()
        assert conn.execute('SELECT count(*) FROM line_meta WHERE cn_start_s IS NOT NULL OR cn_end_s IS NOT NULL OR cn_dur_s IS NOT NULL OR cn_speech_s IS NOT NULL OR cn_emo IS NOT NULL OR cn_emo_angry IS NOT NULL OR cn_emo_disgusted IS NOT NULL OR cn_emo_fearful IS NOT NULL OR cn_emo_happy IS NOT NULL OR cn_emo_neutral IS NOT NULL OR cn_emo_other IS NOT NULL OR cn_emo_sad IS NOT NULL OR cn_emo_surprised IS NOT NULL').fetchone()[0]==0
    print('Imported',len(rows),'verified clips into Remake only')
if __name__=='__main__':
    rows,report=build();print(json.dumps(report['summary'],ensure_ascii=False))
    if '--import' in sys.argv:import_db(rows,report)
