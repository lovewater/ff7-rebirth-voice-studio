#!/usr/bin/env python3
"""Evidence-backed Remake chapter/character overlay; never touches audio or locks."""
from __future__ import annotations
import collections,hashlib,json,re,sys
from html.parser import HTMLParser
from pathlib import Path
from build_catalog import PROJECT,WORK,load_metadata,load_text,speaker_facts,clean,actor,speaker_code
SCOPE=WORK/'chapter-refinement'
SOURCE='https://game-scripts-wiki.blogspot.com/2020/04/final-fantasy-vii-remake-transcript.html'
VERSION='remake-chapter-refinement-v1'

class PlainHTML(HTMLParser):
    def __init__(self):super().__init__();self.parts=[];self.skip=0
    def handle_starttag(self,tag,attrs):
        if tag in {'script','style'}:self.skip+=1
        if tag in {'br','p','div','li','h1','h2','h3'}:self.parts.append('\n')
    def handle_endtag(self,tag):
        if tag in {'script','style'}:self.skip=max(0,self.skip-1)
        if tag in {'p','div','li','h1','h2','h3'}:self.parts.append('\n')
    def handle_data(self,data):
        if not self.skip:self.parts.append(data)

def normalized(text):return ''.join(c for c in text.casefold() if c.isalnum())
def canonical_event(path):return re.sub(r'/Voice/(JP|US)/','/Voice/',path.rsplit('/',1)[0])
def parse_transcript(html):
    html=re.sub(r'<h[12]>Chapter\s*(\d+).*?</h[12]>',lambda m:'\n@@CHAPTER_'+m[1]+'@@\n',html,flags=re.S)
    parser=PlainHTML();parser.feed(html);chapter=None;turns=[]
    for line in ''.join(parser.parts).splitlines():
        line=line.strip();heading=re.fullmatch(r'@@CHAPTER_(\d+)@@',line)
        if heading:chapter=int(heading[1]);continue
        if chapter is None:continue
        speech=re.match(r'^([^:\[\]]{1,60}):\s*(.+)',line)
        if speech:turns.append({'chapter':chapter,'actor':speech[1],'normalized':normalized(speech[2]),'turn_index':len(turns)})
    return turns

def exact_anchor(row,turns,min_chars=32,min_words=7,expected_actor=None):
    text=row.get('text_en') or '';body=normalized(text)
    if len(body)<min_chars or len(text.split())<min_words:return None
    matches=[turn for turn in turns if body in turn['normalized']]
    if expected_actor:
        matches=[t for t in matches if normalized(re.sub(r'\s*\(.*?\)','',t['actor']))==normalized(expected_actor)]
    chapters={turn['chapter'] for turn in matches}
    allowed={c['number'] for c in row['extra']['chapter_candidates'] if c['campaign']=='main'}
    if len(chapters)!=1 or not chapters<=allowed:return None
    return {'chapter':next(iter(chapters)),'local_voice_id':row['extra']['source_stem'],'local_stem':row['stem'],'local_text_sha256':hashlib.sha256(body.encode()).hexdigest(),'local_anchor':(row.get('text_zh') or text).replace('\n',' ')[:18],'url':SOURCE,'source_turns':[t['turn_index'] for t in matches],'source_actor':matches[0]['actor'],'match':'exact-normalized-long-sentence' if min_words>=7 else 'exact-normalized-corroborating-sentence','confidence':'high','word_count':len(text.split())}

def joint_scene_anchors(members,turns,speaker_actors):
    """A set of short, actor-matched quotes may identify one scene jointly.

    Intersect occurrences across the whole transcript before considering local
    candidates. One common phrase, or a map name, can never identify a chapter.
    """
    phrases={}
    for row in members:
        text=row.get('text_en') or '';body=normalized(text);expected=speaker_actors.get(row.get('speaker'))
        if not expected or len(body)<10 or len(text.split())<3:continue
        hits=[t for t in turns if body in t['normalized'] and normalized(re.sub(r'\s*\(.*?\)','',t['actor']))==normalized(expected)]
        if hits:phrases.setdefault(body,(row,hits))
    if len(phrases)<3 or sum(len(r['text_en'].split()) for r,_ in phrases.values())<15:return []
    chapters=set.intersection(*[{t['chapter'] for t in hits} for _,hits in phrases.values()])
    if len(chapters)!=1:return []
    chapter=next(iter(chapters));indices=[t['turn_index'] for _,hits in phrases.values() for t in hits if t['chapter']==chapter]
    if max(indices)-min(indices)>60:return []
    proof=[]
    for body,(row,hits) in phrases.items():
        selected=[t for t in hits if t['chapter']==chapter]
        proof.append({'chapter':chapter,'local_voice_id':row['extra']['source_stem'],'local_stem':row['stem'],'local_text_sha256':hashlib.sha256(body.encode()).hexdigest(),'local_anchor':(row.get('text_zh') or row['text_en']).replace('\n',' ')[:18],'url':SOURCE,'source_turns':[t['turn_index'] for t in selected],'source_actor':selected[0]['actor'],'other_occurrence_chapters':sorted({t['chapter'] for t in hits}),'match':'joint-actor-matched-short-scene-quotes','confidence':'high','word_count':len(row['text_en'].split()),'scene_turn_span':[min(indices),max(indices)]})
    return proof

def propose(rows,turns,docs,speaker_actors=None):
    eligible=[r for r in rows if r['extra']['chapter_classification']=='shared']
    anchors={r['stem']:a for r in eligible if (a:=exact_anchor(r,turns))};proposals={};groups=[]
    weak={}
    for row in eligible:
        expected_actor=(speaker_actors or {}).get(row.get('speaker'))
        if row['stem'] not in anchors and expected_actor:
            anchor=exact_anchor(row,turns,16,4,expected_actor)
            if anchor:weak[row['stem']]=anchor
    # Exact long sentence is a direct anchor for that one clip. Never expand a map.
    for stem,anchor in anchors.items():proposals[stem]={'chapter':anchor['chapter'],'method':'exact-web-dialogue','anchors':[anchor]}
    events=collections.defaultdict(list)
    for row in eligible:
        if '/Cut/' in row['asset_path']:events[canonical_event(row['asset_path'])].append(row)
    def expand(members,evidence,basis,group):
        distinct={a['local_text_sha256'] for a in evidence};chapters={a['chapter'] for a in evidence}
        if len(distinct)<2 or len(chapters)!=1:return
        chapter=next(iter(chapters));proof={'chapter':chapter,'method':basis,'group':group,'anchors':evidence}
        accepted=[]
        for row in members:
            if chapter not in {c['number'] for c in row['extra']['chapter_candidates']}:continue
            prior=proposals.get(row['stem'])
            if prior and prior['chapter']!=chapter:raise ValueError('Conflicting chapter proofs: '+row['stem'])
            proposals[row['stem']]=proof;accepted.append(row['stem'])
        groups.append({'group':group,'method':basis,'chapter':chapter,'stems':accepted,'distinct_anchors':len(distinct)})
    for event,members in events.items():
        evidence=[anchors[r['stem']] for r in members if r['stem'] in anchors]
        if len({a['local_text_sha256'] for a in evidence})<2:
            corroboration=[weak[r['stem']] for r in members if r['stem'] in weak]
            combined=evidence+corroboration
            unique={a['local_text_sha256']:a for a in combined}
            if len(unique)>=2 and sum(a['word_count'] for a in unique.values())>=14:evidence=combined
        expand(members,evidence,'same-cutscene-event',event)
        if not all(r['stem'] in proposals for r in members):
            joint=joint_scene_anchors(members,turns,speaker_actors or {})
            expand(members,joint,'same-cutscene-joint-dialogue-anchors',event)
    # Follow actual NextPE links; IDs and directory ordering have no chapter meaning.
    by_voice=collections.defaultdict(list)
    for row in eligible:
        if '/Field/' in row['asset_path']:
            area=row['asset_path'].split('/Field/',1)[1].split('/')[0];by_voice[(area,row['extra']['source_stem'].casefold())].append(row)
    for path,entries in docs.items():
        if not path.endswith('/PlannerEvent.uasset'):continue
        source_area=path.split('/Field/',1)[1].split('/')[0] if '/Field/' in path else 'Resident'
        records={e['$tag'].casefold():e for e in entries};adj=collections.defaultdict(set)
        for key,entry in records.items():
            nxt=entry.get('NextPE','').casefold()
            if nxt in records:adj[key].add(nxt);adj[nxt].add(key)
        seen=set()
        for start in records:
            if start in seen:continue
            stack=[start];component=set()
            while stack:
                key=stack.pop()
                if key in seen:continue
                seen.add(key);component.add(key);stack.extend(adj[key]-seen)
            members={row['stem']:row for key in component for row in by_voice.get((source_area,records[key].get('SoundID','').casefold()),[])}
            evidence=[anchors[r['stem']] for r in members.values() if r['stem'] in anchors]
            if len({a['chapter'] for a in evidence})>1:continue
            if len({a['local_text_sha256'] for a in evidence})<2:
                combined=evidence+[weak[r['stem']] for r in members.values() if r['stem'] in weak]
                unique={a['local_text_sha256']:a for a in combined}
                if len(unique)>=2 and sum(a['word_count'] for a in unique.values())>=14:evidence=combined
            expand(list(members.values()),evidence,'explicit-nextpe-conversation',{'asset':path,'rows':sorted(component)})
    # Declared cutscene continuation is evidence; filesystem number adjacency is not.
    for path,entries in docs.items():
        if not path.endswith('/CutSceneList.uasset') or '/Field/' not in path:continue
        area=path.split('/Field/',1)[1].split('/')[0];records={e['$tag'].casefold():e for e in entries};adj=collections.defaultdict(set)
        for key,entry in records.items():
            for nxt in entry.get('NextCutSceneNameList_Array',[]):
                if nxt.casefold() in records:adj[key].add(nxt.casefold());adj[nxt.casefold()].add(key)
        seen=set()
        for start in records:
            if start in seen:continue
            stack=[start];component=set()
            while stack:
                key=stack.pop()
                if key in seen:continue
                seen.add(key);component.add(key);stack.extend(adj[key]-seen)
            members=[r for event,rs in events.items() if '/Cut/'+area+'/' in event and event.rsplit('/',1)[1].casefold() in component for r in rs]
            known=[proposals[r['stem']] for r in members if r['stem'] in proposals];chapters={p['chapter'] for p in known}
            if len(chapters)!=1:continue
            evidence={a['local_text_sha256']:a for p in known for a in p['anchors']}
            links=[{'from':records[k]['$tag'],'to':nxt} for k in sorted(component) for nxt in records[k].get('NextCutSceneNameList_Array',[]) if nxt.casefold() in component]
            expand([r for r in members if r['stem'] not in proposals],list(evidence.values()),'explicit-next-cutscene-link',{'asset':path,'events':sorted(component),'links':links})
    manual_file=Path(__file__).with_name('chapter_refinement_manual.json')
    manual=json.loads(manual_file.read_text()) if manual_file.exists() else []
    for rule in manual:
        members=[r for event,rs in events.items() if event.endswith(rule['event_suffix']) for r in rs]
        matched=[r for r in members if r['extra']['source_stem']==rule['anchor_voice_id'] and rule['contains_en'] in (r.get('text_en') or '')]
        if not matched:continue
        corroboration=[]
        for quote in rule.get('corroborating_quotes',[]):
            hits=[r for r in members if r['extra']['source_stem']==quote['voice_id'] and quote['contains_en'] in (r.get('text_en') or '')]
            if not hits:raise ValueError('Reviewed scene corroborating quote no longer matches source: '+quote['voice_id'])
            corroboration.append({**quote,'local_stem':hits[0]['stem'],'local_text_sha256':hashlib.sha256(normalized(hits[0]['text_en']).encode()).hexdigest()})
        local=matched[0];anchor={'chapter':rule['chapter'],'local_voice_id':rule['anchor_voice_id'],'local_stem':local['stem'],'local_anchor':(local.get('text_zh') or local['text_en']).replace('\n',' ')[:18],'local_text_sha256':hashlib.sha256(normalized(local['text_en']).encode()).hexdigest(),'url':rule['url'],'match':'reviewed-distinctive-scene-and-independent-chapter-source','confidence':'high','source_context':rule['source_context'],'chapter_source_url':rule.get('chapter_source_url'),'corroborating_quotes':corroboration,'source_boundary_conflict':rule.get('source_boundary_conflict')}
        for row in members:
            if rule['chapter'] not in {c['number'] for c in row['extra']['chapter_candidates']}:continue
            previous=proposals.get(row['stem'])
            if previous and previous['chapter']!=rule['chapter']:raise ValueError('Manual/source conflict '+row['stem'])
            if not previous:proposals[row['stem']]={'chapter':rule['chapter'],'method':'reviewed-independent-scene-anchor','anchors':[anchor],'group':rule['event_suffix'],'content_scope':rule.get('content_scope','story')}
        groups.append({'group':rule['event_suffix'],'chapter':rule['chapter'],'method':'reviewed-independent-scene-anchor','stems':[r['stem'] for r in members]})
    return proposals,anchors,groups

def load_logic_metadata():
    root=SCOPE/'logic-metadata';report=json.loads((root/'decode-report.json').read_text())
    assert report.get('decoder')=='fname-number-preserving-v2' and report['parsed']==1111 and not report['errors']
    docs={}
    for file in (root/'json').rglob('*.json'):
        data=json.loads(file.read_text());entries=data['uexp']['entries']
        assert len(entries)==len({e['$tag'] for e in entries}),file
        docs[data['source']['path']]=entries
    return docs

def battle_voice_proposals(rows,docs):
    """Actual battle -> TalkGroup/condition -> state -> sequence -> VoiceID."""
    sets=collections.defaultdict(dict)
    for path,entries in docs.items():
        area=path.split('/Field/',1)[1].split('/')[0] if '/Field/' in path else 'Resident'
        sets[area][Path(path).stem]={e['$tag']:e for e in entries}
    def identify(area,battle):
        names=' '.join(battle.get('BattleCharaSpecID_Array',[]))
        if area=='030-SLUM7' and ('Reno_Pillar' in names or 'Rude_Pillar' in names):return 12,'Reno/Rude pillar battle'
        if area=='080-SLU5B':
            if 'Reno_Standard' in names or 'Rude_Standard' in names:return 8,'Reno/Rude'
            if 'HellHouse_Standard' in names:return 9,'Hell House'
        if area=='090-UNDG6':
            if 'Aps_2ndBattle' in names:return 14,'Abzu rematch'
            if 'Aps_Standard' in names:return 10,'Abzu'
        if area=='120-UNDG7' and 'DeepGroundCommander' in names:return 13,'Failed Experiment'
        if area=='140-SBIL0':
            if 'H0512Sample_Standard' in names:return 16,'Specimen H0512'
            if any(n in names for n in ['Jenova1st','Rufus_Standard','HundredGunner_Standard']):return 17,'Jenova Dreamweaver/Rufus/The Arsenal'
            if any(n in names for n in ['FeelerPraeco_Standard','Sephiroth_Standard']):return 18,'Whisper Harbinger/Sephiroth'
        return None
    guide={8:'budding-bodyguard',9:'the-town-that-never-sleeps',10:'rough-waters',12:'fight-for-survival',13:'a-broken-world',14:'in-search-of-hope',16:'the-belly-of-the-beast',17:'deliverance-from-chaos',18:'destinys-crossroads'}
    by_voice=collections.defaultdict(list)
    for row in rows:
        if row['extra']['chapter_classification']=='shared' and '/Field/' in row['asset_path']:
            area=row['asset_path'].split('/Field/',1)[1].split('/')[0];by_voice[(area,row['extra']['source_stem'].casefold())].append(row)
    found=collections.defaultdict(list)
    for area,tables in sets.items():
        for battle in tables.get('BattleScene',{}).values():
            identity=identify(area,battle)
            if not identity:continue
            number,boss=identity;state_sources=collections.defaultdict(list)
            for groupid in battle.get('TalkGroupID_Array',[]):
                group=tables.get('TalkGroup',{}).get(groupid,{})
                for stateid in group.get('TalkStateID_Array',[]):state_sources[stateid].append({'battle':battle['$tag'],'talk_group':groupid})
            for groupid in battle.get('BattleConditionTriggerGroupId_Array',[]):
                group=tables.get('BattleConditionTriggerGroup',{}).get(groupid,{})
                for triggerid in group.get('BattleConditionTriggerId_Array',[]):
                    condition=tables.get('BattleConditionTrigger',{}).get(triggerid,{})
                    state_sources[condition.get('TalkStateId')].append({'battle':battle['$tag'],'condition_group':groupid,'condition_trigger':triggerid})
            for stateid,chains in state_sources.items():
                state=tables.get('TalkState',{}).get(stateid,{})
                for sequenceid in state.get('SequenceID_Array',[]):
                    sequence=tables.get('TalkSequence',{}).get(sequenceid,{});voice=sequence.get('VoiceID','')
                    for row in by_voice.get((area,voice.casefold()),[]):
                        if number not in {c['number'] for c in row['extra']['chapter_candidates']}:continue
                        proof={'chapter':number,'local_voice_id':voice,'local_stem':row['stem'],'local_anchor':(row.get('text_zh') or row.get('text_en') or '')[:18],'local_text_sha256':hashlib.sha256((row.get('text_en') or '').encode()).hexdigest(),'url':f'https://www.powerpyx.com/final-fantasy-7-vii-remake-chapter-{number}-{guide[number]}-walkthrough/','source_context':boss,'confidence':'high','match':'actual-battle-talk-metadata-and-specific-story-boss-chapter','metadata':{'area':area,'battle_scene':battle['$tag'],'boss_specs':battle['BattleCharaSpecID_Array'],'chains':chains,'talk_state':stateid,'talk_sequence':sequenceid,'voice_id':voice}}
                        found[row['stem']].append(proof)
    return {stem:{'chapter':proofs[0]['chapter'],'method':'explicit-battle-dialogue-chain','anchors':proofs} for stem,proofs in found.items() if len({p['chapter'] for p in proofs})==1}

def boss_cut_proposals(rows,docs):
    """Bind a cinematic to actual unique story-boss animation imports.

    Merely seeing a recurring human actor (Reno, Sephiroth, etc.) is insufficient.
    The reviewed set consists of specific nonhuman encounters, corroborated by
    this game's blueprint and a chapter walkthrough.
    """
    file=SCOPE/'remaining-cut-character-names.json'
    if not file.exists():return {}
    specs={'EB0006_00':(9,'HellHouse','the-town-that-never-sleeps'),'EB0010_00':(13,'DeepGroundCommander','a-broken-world'),'EB0012_00':(16,'H0512Sample','the-belly-of-the-beast'),'EB0014_00':(17,'Jenova1st','deliverance-from-chaos'),'EB0018_00':(17,'HundredGunner','deliverance-from-chaos'),'EB0019_00':(18,'MotorBall','destinys-crossroads'),'EB0020_00':(18,'FeelerPraeco','destinys-crossroads')}
    blueprints=collections.defaultdict(list)
    for line in (WORK/'indexes/pak-files.jsonl').read_text().splitlines():
        path=json.loads(line)['path']
        if '/BluePrint/Character/Enemy/' in path and path.endswith('.uasset'):
            for code,(_,label,_) in specs.items():
                if Path(path).stem.startswith(code+'_'+label+'_Standard'):blueprints[code].append(path)
    events=collections.defaultdict(list)
    for record in json.loads(file.read_text()):events[record['event'].casefold()].append(record)
    result={}
    for event,assets in events.items():
        models={m for asset in assets for name in asset['names'] for m in re.findall(r'EB\d+_\d+',name)}
        matched={code:specs[code] for code in models&specs.keys() if blueprints[code]}
        if len({v[0] for v in matched.values()})!=1:continue
        chapter=next(iter(matched.values()))[0]
        proof={'chapter':chapter,'method':'actual-cut-animation-boss-reference-and-chapter-guide','group':event,'anchors':[],'boss_scene_evidence':{'models':sorted(matched),'source_character_assets':assets,'official_boss_blueprints':{c:blueprints[c] for c in matched},'sources':[{'url':f'https://www.powerpyx.com/final-fantasy-7-vii-remake-chapter-{n}-{slug}-walkthrough/','source_context':label+' specific story encounter in chapter '+str(n)} for n,label,slug in matched.values()]}}
        for row in rows:
            if row['extra']['chapter_classification']!='shared' or '/Cut/' not in row['asset_path'] or row['asset_path'].rsplit('/',2)[1].casefold()!=event:continue
            if chapter in {c['number'] for c in row['extra']['chapter_candidates']}:result[row['stem']]=proof
    return result

def reviewed_levelset_proposals(rows,docs,previous,reviewed_rules=None):
    """Replay a finite reviewed set of small cinematic loading bundles.

    Loading together alone is insufficient. Require independently located
    dialogue in two different actual member events and reject any chapter
    conflict. This is scene inference, never runtime exclusivity proof.
    """
    file=Path(__file__).with_name('chapter_refinement_levelsets.json')
    if reviewed_rules is None:
        if not file.exists():return {}
        reviewed_rules=json.loads(file.read_text())
    events=collections.defaultdict(list);by_stem={r['stem']:r for r in rows};result={}
    for row in rows:
        if row['extra']['chapter_classification']=='shared' and '/Cut/' in row['asset_path']:
            area,event=row['asset_path'].split('/Cut/',1)[1].rsplit('/',2)[:2];events[(area,event.casefold())].append(row)
    for rule in reviewed_rules:
        matches=[e for e in docs.get(rule['asset'],[]) if e['$tag']==rule['row']]
        if len(matches)!=1 or matches[0]['LevelList_Array']!=rule['expected_level_list']:raise ValueError('Reviewed LevelSet source changed: '+rule['row'])
        area=rule['asset'].split('/Field/',1)[1].split('/')[0]
        names={v.casefold() for v in rule['expected_level_list'] if re.fullmatch(r'(EV|MV|LV)_[A-Za-z0-9]+_\d{4}',v)}
        if len(names)>12:raise ValueError('Reviewed cinematic bundle is too broad')
        members=[r for event in names for r in events.get((area,event),[])]
        known=[previous[r['stem']] for r in members if r['stem'] in previous]
        if {p['chapter'] for p in known}!={rule['chapter']}:raise ValueError('Reviewed LevelSet has conflicting chapter evidence: '+rule['row'])
        anchors={a['local_text_sha256']:a for p in known for a in p.get('anchors',[]) if a.get('local_stem') in by_stem and '/Cut/' in by_stem[a['local_stem']]['asset_path'] and by_stem[a['local_stem']]['asset_path'].rsplit('/',2)[1].casefold() in names}
        origins={by_stem[a['local_stem']]['asset_path'].rsplit('/',2)[1].casefold() for a in anchors.values()}
        if len(origins)<2:continue
        proof={'chapter':rule['chapter'],'method':'reviewed-small-levelset-independent-scene-anchors','group':{'asset':rule['asset'],'row':rule['row']},'anchors':list(anchors.values()),'levelset_evidence':{**rule,'independent_anchor_events':sorted(origins)}}
        for row in members:
            if row['stem'] not in previous and rule['chapter'] in {c['number'] for c in row['extra']['chapter_candidates']}:
                if row['stem'] in result and result[row['stem']]['chapter']!=rule['chapter']:raise ValueError('Reviewed LevelSets disagree about '+row['stem'])
                result.setdefault(row['stem'],proof)
    return result

def reviewed_movie_proposals(rows):
    file=Path(__file__).with_name('chapter_refinement_movies.json')
    if not file.exists():return {}
    result={}
    for rule in json.loads(file.read_text()):
        movie=PROJECT.parent/rule['source_movie']
        if movie.stat().st_size!=rule['source_bytes']:raise ValueError('Reviewed source movie size changed')
        with movie.open('rb') as stream:
            if hashlib.file_digest(stream,'sha256').hexdigest()!=rule['source_sha256']:raise ValueError('Reviewed source movie bytes changed')
        for frame in rule['reviewed_frames']:
            if hashlib.sha256((PROJECT/frame['path']).read_bytes()).hexdigest()!=frame['sha256']:raise ValueError('Reviewed source movie frame changed')
        for row in rows:
            if row['extra']['chapter_classification']!='shared' or '/Cut/'+rule['area']+'/'+rule['event']+'/' not in row['asset_path']:continue
            if rule['chapter'] in {c['number'] for c in row['extra']['chapter_candidates']}:
                result[row['stem']]={'chapter':rule['chapter'],'method':'reviewed-original-game-movie-scene','anchors':[],'group':rule['event'],'reviewed_visual_evidence':rule}
    return result

def character_overlay():
    texts=load_text();facts=speaker_facts(texts);assets=collections.defaultdict(list);by_spec=collections.defaultdict(list);aliases=collections.defaultdict(collections.Counter);alias_samples=collections.defaultdict(list)
    for path,entries in load_metadata().items():
        if Path(path).stem not in {'PlannerEvent','TalkSequence'}:continue
        for entry in entries:
            talker=entry.get('Talker');text_id=entry.get('TextID','').lstrip('$').casefold()
            if not talker or talker=='None' or not text_id or text_id=='none':continue
            hits=texts.get(('US',text_id),[])
            if len(hits)!=1:continue
            name=actor(hits[0]['entry'])
            if not name:continue
            aliases[normalized(talker)][name]+=1
            if len(alias_samples[(normalized(talker),name)])<3:alias_samples[(normalized(talker),name)].append({'asset':path,'row':entry['$tag'],'text_id':text_id})
    for line in (WORK/'indexes/pak-files.jsonl').read_text().splitlines():
        row=json.loads(line);path=row['path']
        if '/BluePrint/Character/' not in path or not path.endswith('_Standard.uasset'):continue
        match=re.search(r'/Character/(Player|NonPlayer)/(?:PC|NP)\d+_\d+_(.+)_Standard\.uasset$',path)
        if not match:continue
        typ,label=match.groups();evidence={'asset':path,'label':label,'role':'主角' if typ=='Player' else '配角'}
        assets[normalized(label)].append(evidence);by_spec[Path(path).stem].append(evidence)
        mapping=aliases.get(normalized(label))
        if mapping:
            english,count=mapping.most_common(1)[0]
            if count>=3 and count/sum(mapping.values())>=.90:assets[normalized(english)].append({**evidence,'explicit_talker_to_ACTOR_alias':{'english':english,'count':count,'all_english_labels':dict(mapping),'metadata_samples':alias_samples[(normalized(label),english)]}})
    glossary_file=WORK/'preprocess/name-glossary.json'
    glossary=json.loads(glossary_file.read_text()) if glossary_file.exists() else {'entries':[]}
    proper={e['english']:e for e in glossary['entries'] if e.get('matchable')}
    for path,entries in load_logic_metadata().items():
        if Path(path).stem!='PlannerEventChara':continue
        for entry in entries:
            talker=entry.get('ActorName') or entry['$tag'];model=entry.get('CharaSpecName');model_assets=by_spec.get(model,[]);mapping=aliases.get(normalized(talker))
            if not model_assets or not mapping:continue
            english,count=mapping.most_common(1)[0]
            if english not in proper or count<3 or count/sum(mapping.values())<.90:continue
            # A conversation may borrow a Player model as a stand-in. Only the
            # player's own canonical actor name identifies that playable role.
            for asset in model_assets:
                if asset['role']=='主角' and normalized(english)!=normalized(asset['label']):continue
                assets[normalized(english)].append({**asset,'explicit_planner_character_model':{'asset':path,'row':entry['$tag'],'actor_name':talker,'character_spec':model,'official_english_actor':english,'alias_count':count,'metadata_samples':alias_samples[(normalized(talker),english)]}})
    result={}
    for code,fact in facts.items():
        proof=json.loads(fact['note']);languages=proof.get('languages',{})
        en=languages.get('US');english_name=en['winner'] if en else '';official=proper.get(english_name)
        if official:
            if not fact.get('name_zh'):fact['name_zh']=official['chinese']
            if not fact.get('name_jp'):fact['name_jp']=official['japanese']
        matches=assets.get(normalized(english_name),[])
        matches=list({(m['asset'],bool(m.get('explicit_talker_to_ACTOR_alias'))):m for m in matches}.values());roles={p['role'] for p in matches}
        if not en or en['winner_count']<3 or en['share']<.90 or len(roles)!=1:continue
        result[code]={**fact,'role':next(iter(roles)),'role_evidence':{'official_english_actor':en['winner'],'character_blueprints':matches,'actor_evidence':proof}}
    return result

def source_speaker_proposals(rows):
    facts=speaker_facts(load_text());rules={};selected_facts={}
    for row in rows:
        previous=row['extra'].get('speaker_refinement',{})
        if row.get('speaker') and not (previous.get('version')==VERSION and previous.get('speaker')==row['speaker']):continue
        extra=row['extra'];source=extra.get('source_stem','');ids=[source]
        for data in extra.get('audio_sources',{}).values():ids.extend(data.get('clip',{}).get('users',[]))
        candidates={code for value in ids if isinstance(value,str) and (code:=speaker_code(value)) in facts and (facts[code].get('name_zh') or facts[code].get('name_jp'))}
        if len(candidates)==1:
            code=next(iter(candidates));selected_facts[code]=facts[code]
            rules[row['stem']]={'speaker':code,'source_asset':row['asset_path'],'basis':'source-voice-id-suffix-and-confirmed-official-ACTOR-code','source_ids':ids,'official_actor_evidence':json.loads(facts[code]['note'])}
        elif extra.get('content_classification',{}).get('category')=='announcement':
            code='source_broadcast_'+re.sub(r'[^a-z0-9_]','_',source.casefold())
            selected_facts[code]={'name_zh':'广播来源 · '+source,'name_jp':None,'source':'remake-source-device','note':json.dumps({'basis':'explicit-AN-announcement-asset','source_asset':row['asset_path']},ensure_ascii=False),'role':None,'role_evidence':None}
            rules[row['stem']]={'speaker':code,'source_asset':row['asset_path'],'basis':'explicit-announcement-device-source-not-person','source_ids':[source]}
    return rules,selected_facts

def build(output_name='refinement-rules.json'):
    SCOPE.mkdir(exist_ok=True);html=(SCOPE/'blog-script.html').read_text();turns=parse_transcript(html)
    assert {t['chapter'] for t in turns}==set(range(1,19)) and len(turns)>5000,'Incomplete or malformed source transcript cache'
    rows=[json.loads(line) for line in (WORK/'voice-catalog.jsonl').read_text().splitlines()]
    speaker_actors={}
    for code,fact in speaker_facts(load_text()).items():
        proof=json.loads(fact['note']);english=proof.get('languages',{}).get('US',{})
        if english.get('winner_count',0)>=3 and english.get('share',0)>=.90:speaker_actors[code]=english['winner']
    docs=load_logic_metadata();proposals,anchors,groups=propose(rows,turns,docs,speaker_actors)
    for stem,proof in battle_voice_proposals(rows,docs).items():
        if stem in proposals and proposals[stem]['chapter']!=proof['chapter']:raise ValueError('Battle/web chapter conflict '+stem)
        proposals.setdefault(stem,proof)
    for stem,proof in boss_cut_proposals(rows,docs).items():
        if stem in proposals and proposals[stem]['chapter']!=proof['chapter']:raise ValueError('Boss cut/web chapter conflict '+stem)
        proposals.setdefault(stem,proof)
    proposals.update(reviewed_levelset_proposals(rows,docs,proposals))
    for stem,proof in reviewed_movie_proposals(rows).items():
        if stem in proposals:
            if proposals[stem]['chapter']!=proof['chapter']:raise ValueError('Reviewed movie contradicts dialogue inference: '+stem)
            proposals[stem]['reviewed_visual_evidence']=proof['reviewed_visual_evidence']
        else:proposals[stem]=proof
    masks_file=SCOPE/'chapter-logic-mask-analysis.json'
    if masks_file.exists():
        masks=json.loads(masks_file.read_text())
        if masks['metadata_assets']!=len(docs):raise ValueError('Runtime chapter-mask metadata coverage changed; regenerate analysis')
        chapters,_,_=__import__('build_catalog').chapter_facts(docs,load_text())
        for proof in masks['proposals']:
            if len(proof['allowed_candidates'])!=1:continue
            tag=proof['allowed_candidates'][0];chapter=chapters[tag]['number'];stem=proof['stem']
            prior=proposals.get(stem)
            if prior and prior['chapter']!=chapter:raise ValueError('Known current-chapter flag contradicts scene inference: '+stem)
            if prior:prior['runtime_chapter_mask']=proof
            else:proposals[stem]={'chapter':chapter,'method':'exclusive-current-chapter-flag-reference-union','anchors':[],'runtime_chapter_mask':proof}
    by_stem={r['stem']:r for r in rows}
    payload={'version':VERSION,'source':{'url':SOURCE,'cache_sha256':hashlib.sha256(html.encode()).hexdigest(),'parsed_turns':len(turns),'chapter_headings':sorted({t['chapter'] for t in turns})},'summary':{'shared_before':sum(r['extra']['chapter_classification']=='shared' for r in rows),'direct_anchors':len(anchors),'proposed_rows':len(proposals),'cutscene_event_groups':sum(g['method']=='same-cutscene-event' for g in groups),'nextpe_conversations':sum(g['method']=='explicit-nextpe-conversation' for g in groups)},'rules':[{**proof,'stem':stem,'expected_region':by_stem[stem]['extra'].get('chapter_refinement',{}).get('original_region',by_stem[stem]['region']),'expected_asset_path':by_stem[stem]['asset_path']} for stem,proof in sorted(proposals.items())],'groups':groups,'characters':character_overlay()}
    for rule in payload['rules']:
        rule['metadata_decoder']='fname-number-preserving-v2'
        rule['evidence_level']='known-current-chapter-flag-and-conservative-reference-union' if rule.get('runtime_chapter_mask') else 'high-confidence-scene-inference'
        rule['runtime_exclusivity_proven']=False
    speaker_rules,speaker_definitions=source_speaker_proposals(rows);payload['speaker_rules']=speaker_rules;payload['speaker_definitions']=speaker_definitions;payload['summary']['speaker_fill_proposals']=len(speaker_rules)
    payload['summary']['by_chapter']=dict(collections.Counter(p['chapter'] for p in proposals.values()))
    target=SCOPE/output_name;temporary=target.with_suffix(target.suffix+'.tmp')
    temporary.write_text(json.dumps(payload,ensure_ascii=False,indent=2));temporary.replace(target)
    print(json.dumps(payload['summary'],ensure_ascii=False));return payload

def may_refine(region,asset,extra,rule):
    previous=extra.get('chapter_refinement',{})
    if extra.get('manual_region') or extra.get('region_source')=='manual':return False
    allowed={rule['expected_region']}
    if previous.get('version')==VERSION:allowed.add(previous.get('applied_region'))
    return asset==rule['expected_asset_path'] and region in allowed

def apply_chapter_refinement_overlay(rows,report):
    """Replay saved reviewed rules after JP recovery and before base catalog import."""
    file=SCOPE/'refinement-rules.json'
    if not file.exists():return
    payload=json.loads(file.read_text());assert payload['version']==VERSION
    rules={r['stem']:r for r in payload['rules']};applied=0
    for row in rows:
        rule=rules.get(row['stem'])
        if not rule or not may_refine(row['region'],row['asset_path'],row['extra'],rule):continue
        previous=row['extra'].get('chapter_refinement',{});target=f"CH_{rule['chapter']:04d}"
        row['extra']['chapter_refinement']={**rule,'version':VERSION,'original_region':previous.get('original_region',row['region']),'applied_region':target,'original_chapter_candidates':row['extra'].get('chapter_candidates',[])}
        row['region']=target;applied+=1
    for row in rows:
        speaker_rule=payload.get('speaker_rules',{}).get(row['stem'])
        if speaker_rule and not row.get('speaker') and row['asset_path']==speaker_rule['source_asset'] and not row['extra'].get('manual_speaker'):
            row['speaker']=speaker_rule['speaker'];row['extra']['speaker_refinement']={**speaker_rule,'version':VERSION}
            report['speakers'].setdefault(row['speaker'],payload['speaker_definitions'][row['speaker']])
    for code,fact in payload['characters'].items():
        existing=report['speakers'].get(code)
        if existing is None:continue
        for key in ['name_zh','name_jp']:
            if not existing.get(key):existing[key]=fact.get(key)
        if not existing.get('role'):existing['role']=fact['role'];existing['role_evidence']=fact['role_evidence']
    report['chapter_refinement_overlay']={'version':VERSION,'applied':applied,'rules':len(rules),'rule_file':str(file.relative_to(PROJECT))}

def apply(payload):
    import psycopg
    from psycopg.types.json import Jsonb
    state=json.loads((PROJECT/'.private/bootstrap-state.json').read_text());assert (state['role'],state['database'])==('ff7remake','studio_ff7_remake')
    assert json.loads((PROJECT/'website/data/.ff7-game.json').read_text())=={'game_id':'remake','database':'studio_ff7_remake'}
    stats=collections.Counter();changes=[]
    with psycopg.connect(host='127.0.0.1',port=25432,dbname=state['database'],user=state['role'],password=state['password']) as conn:
        assert conn.execute('SELECT current_database(),current_user').fetchone()==('studio_ff7_remake','ff7remake')
        for code,fact in payload.get('speaker_definitions',{}).items():
            conn.execute("""INSERT INTO speakers(code,name_zh,name_jp,source,note) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(code) DO UPDATE SET name_zh=COALESCE(NULLIF(speakers.name_zh,''),excluded.name_zh),name_jp=COALESCE(NULLIF(speakers.name_jp,''),excluded.name_jp),note=COALESCE(NULLIF(speakers.note,''),excluded.note) WHERE speakers.source IN ('remake-txtres','remake-txtres-consensus','remake-source-device')""",(code,fact['name_zh'],fact['name_jp'],fact['source'],fact['note']))
        for stem,speaker_rule in payload.get('speaker_rules',{}).items():
            current=conn.execute('SELECT l.speaker,l.asset_path,m.extra FROM lines l JOIN line_meta m ON m.stem=l.stem WHERE l.stem=%s FOR UPDATE OF l,m',(stem,)).fetchone()
            if not current or (current[0] and current[0].strip()) or current[1]!=speaker_rule['source_asset'] or current[2].get('manual_speaker'):continue
            conn.execute("UPDATE lines SET speaker=%s WHERE stem=%s AND (speaker IS NULL OR btrim(speaker)='')",(speaker_rule['speaker'],stem))
            conn.execute('UPDATE line_meta SET extra=extra||%s WHERE stem=%s',(Jsonb({'speaker_refinement':{**speaker_rule,'version':VERSION}}),stem));stats['empty_speakers_filled']+=1
        for rule in payload['rules']:
            current=conn.execute('SELECT l.region,l.asset_path,m.extra FROM lines l JOIN line_meta m ON m.stem=l.stem WHERE l.stem=%s FOR UPDATE OF l,m',(rule['stem'],)).fetchone()
            if not current:stats['missing']+=1;continue
            region,asset,extra=current;previous=extra.get('chapter_refinement',{})
            target=f"CH_{rule['chapter']:04d}"
            if not may_refine(region,asset,extra,rule):stats['preserved_manual_or_changed_region_or_asset']+=1;continue
            if not conn.execute('SELECT 1 FROM regions WHERE code=%s',(target,)).fetchone():raise ValueError('Missing actual chapter '+target)
            if region==target and previous.get('version')==VERSION and previous.get('method')==rule['method'] and previous.get('group')==rule.get('group') and previous.get('metadata_decoder')==rule.get('metadata_decoder') and previous.get('evidence_level')==rule.get('evidence_level') and previous.get('runtime_chapter_mask')==rule.get('runtime_chapter_mask'):
                stats['already_applied']+=1;continue
            proof={**rule,'version':VERSION,'original_region':previous.get('original_region',region),'applied_region':target,'original_chapter_candidates':extra.get('chapter_candidates',[])}
            conn.execute('UPDATE lines SET region=%s WHERE stem=%s',(target,rule['stem']))
            conn.execute("UPDATE line_meta SET extra=extra||%s WHERE stem=%s",(Jsonb({'chapter_refinement':proof}),rule['stem']))
            stats['applied']+=1;changes.append({'stem':rule['stem'],'before':region,'after':target,'method':rule['method']})
        for code,fact in payload['characters'].items():
            r=conn.execute("UPDATE speakers SET name_zh=COALESCE(NULLIF(name_zh,''),%s),name_jp=COALESCE(NULLIF(name_jp,''),%s),note=COALESCE(NULLIF(note,''),%s) WHERE code=%s AND source IN ('remake-txtres','remake-txtres-consensus')",(fact['name_zh'],fact['name_jp'],fact['note'],code));stats['speaker_rows_checked']+=r.rowcount
            r=conn.execute('INSERT INTO cast_members(speaker,role,note) SELECT %s,%s,%s WHERE EXISTS(SELECT 1 FROM speakers WHERE code=%s) ON CONFLICT(speaker) DO NOTHING',(code,fact['role'],json.dumps({'source':VERSION,'evidence':fact['role_evidence']},ensure_ascii=False),code));stats['new_cast_roles']+=r.rowcount
        conn.commit()
    result={'version':VERSION,'stats':dict(stats),'changes':changes};(SCOPE/'refinement-application.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result['stats'],ensure_ascii=False));return result
if __name__=='__main__':
    payload=build()
    if '--apply' in sys.argv:apply(payload)
