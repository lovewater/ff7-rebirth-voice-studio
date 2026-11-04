#!/usr/bin/env python3
"""Conservative three-valued masks over complete Remake DataObject references."""
from __future__ import annotations
import collections,json,re
from pathlib import Path
from build_catalog import WORK,chapter_facts,load_text
from refine_catalog import load_logic_metadata,canonical_event
UNKNOWN=None

def tri_not(value):return None if value is None else not value
def tri_and(values):
    values=list(values)
    return False if False in values else None if None in values else True
def tri_or(values):
    values=list(values)
    return True if True in values else None if None in values else False

def evaluate_condition(entry,flag_values):
    """Unsupported expression layouts are unknown, never a reason to exclude."""
    types=entry.get('TargetType_Array',[])
    if not types:return None
    count=len(types)
    brackets=[(i,c) for key in ['StartBracket_Array','EndBracket_Array'] for i,value in enumerate(entry.get(key,[])) for c in value if c.strip()]
    # Only an explicitly balanced wrapper around the whole expression is transparent.
    # Inner/mixed bracket-position layouts remain unknown rather than being flattened.
    if brackets:
        if any(c not in '()' for _,c in brackets):return None
        if any((c=='(' and i!=0) or (c==')' and i<3*count-1) for i,c in brackets):return None
        if sum(c=='(' for _,c in brackets)!=sum(c==')' for _,c in brackets):return None
    strings=entry.get('TargetStringArgument_Array',[]);ops=entry.get('ComparisonOperator_Array',[]);right_types=entry.get('RightType_Array',[]);numbers=entry.get('ComparisonValue_Array',[])
    atoms=[];active=[];all_logical=entry.get('LogicalOperator_Array',[])
    compare={'==':lambda a,b:a==b,'!=':lambda a,b:a!=b,'<':lambda a,b:a<b,'<=':lambda a,b:a<=b,'>':lambda a,b:a>b,'>=':lambda a,b:a>=b}
    for i,typ in enumerate(types):
        # The target/right FName operands occupy two slots per expression row.
        name=strings[2*i] if len(strings)>2*i else None
        op=ops[i] if len(ops)>i else None;right_type=right_types[i] if len(right_types)>i else 0
        if typ==0 and not op and name in {None,'None'} and (i>=len(all_logical) or not all_logical[i]):continue
        active.append(i)
        if typ!=1 or name not in flag_values or flag_values[name] is None or op not in compare or right_type!=0 or len(numbers)<=i:
            atoms.append(None);continue
        atoms.append(compare[op](flag_values[name],numbers[i]))
    if not atoms:return None
    if len(atoms)==1:return atoms[0]
    logical=[all_logical[i] if len(all_logical)>i else '' for i in active[:-1]]
    if not all(logical):return None
    if set(logical)=={'&&'}:return tri_and(atoms)
    if set(logical)=={'||'}:return tri_or(atoms)
    # Mixed precedence and bracket-position encoding have not been reverse-engineered.
    return None

def evaluate_definitions(entries,flag_values,negate=False):
    if not entries:return None
    values=[evaluate_condition(entry,flag_values) for entry in entries]
    return tri_or(tri_not(v) if negate else v for v in values)

def current_chapter_flags(docs,chapters):
    entries=next(es for p,es in docs.items() if p.endswith('/Resident/Chapter.uasset'))
    entries={e['$tag']:e for e in entries if e['$tag'] in chapters};known={};proof={}
    for tag,row in entries.items():
        peers=[other for other in entries if chapters[other]['campaign']==chapters[tag]['campaign']]
        for flag in row.get('RaiseStoryFlag_Array',[]):
            # A complete exclusive raise/drop pattern, not the number in a flag name.
            if not (flag.startswith('stfCmnChapter') or flag.startswith('stfCmnP_Chapter')) or not flag.endswith('_Start'):continue
            if not all(flag in entries[other].get('DropStoryFlag_Array',[]) for other in peers if other!=tag):continue
            known[flag]={other:1 if other==tag else 0 if other in peers else None for other in entries}
            proof[flag]={'chapter_row':tag,'display_chapter':chapters[tag]['number'],'campaign':chapters[tag]['campaign'],'raise':tag,'drop':[other for other in peers if other!=tag]}
    return known,proof

def all_strings(value):
    if isinstance(value,str):yield value
    elif isinstance(value,list):
        for item in value:yield from all_strings(item)
    elif isinstance(value,dict):
        for item in value.values():yield from all_strings(item)

EXEC={'Action','ActionGroup','StateChange','StateTrigger','PlannerEvent','PlannerLevelSet','EnvironmentSet','EnvironmentSetWrapper','TalkGroup','TalkState','TalkSequence','CutSceneList'}

def analyze(docs,rows,prior_rules=None):
    chapters,_,_=chapter_facts(docs,load_text());tags=list(chapters);bit={tag:1<<i for i,tag in enumerate(tags)};all_bits=(1<<len(tags))-1
    flags,flag_proof=current_chapter_flags(docs,chapters);conditions=collections.defaultdict(list);nodes={};by_name=collections.defaultdict(list);by_scope=collections.defaultdict(list);foreign=[]
    for path,entries in docs.items():
        area=path.split('/Field/',1)[1].split('/')[0] if '/Field/' in path else 'Resident';kind=Path(path).stem
        for entry in entries:
            if kind=='StateCondition':conditions[(area,entry['$tag'].casefold())].append(entry)
            if kind in EXEC or kind.startswith('Object'):
                key=(area,kind,entry['$tag'].casefold());nodes[key]=(path,entry);by_name[key[2]].append(key);by_scope[(area,key[2])].append(key)
            else:foreign.append((area,kind,entry))
    def resolve(value,area):
        name=value.casefold();explicit_area=None;kind=None
        match=re.match(r'^(.+?)_(StateChange|StateTrigger|Action|ActionGroup|PlannerEvent|PlannerLevelSet|EnvironmentSet)_(.+)$',value)
        if match:explicit_area,kind,name=match.groups();name=name.casefold()
        if explicit_area:
            selected=by_scope.get((explicit_area,name),[])
            return [k for k in selected if k[1]==kind]
        local=by_scope.get((area,name),[]);resident=by_scope.get(('Resident',name),[])
        return list(set(local+resident)) if local or resident else by_name.get(name,[])
    cond_cache={}
    def condition_mask(name,area,negate=False):
        key=(name.casefold(),area,negate)
        if key in cond_cache:return cond_cache[key]
        candidates=conditions.get((area,name.casefold()),[])+conditions.get(('Resident',name.casefold()),[])
        mask=0
        for tag in tags:
            values={flag:states[tag] for flag,states in flags.items()}
            value=evaluate_definitions(candidates,values,negate)
            if value is not False:mask|=bit[tag]
        cond_cache[key]=mask;return mask
    adjacency=collections.defaultdict(list);incoming=collections.Counter();roots=set();endpoints=collections.defaultdict(list);guards=[]
    by_voice=collections.defaultdict(list);cut_groups=collections.defaultdict(list)
    for row in rows:
        if row['extra']['chapter_classification']!='shared':continue
        path=row['asset_path'];area=path.split('/Voice/',1)[1].split('/')[2]
        by_voice[(area,row['extra']['source_stem'].casefold())].append(row['stem'])
        if '/Cut/' in path:cut_groups[(area,path.rsplit('/',2)[1].casefold())].append(row['stem'])
    for key,(path,entry) in nodes.items():
        area,kind,_=key
        if kind.startswith('Object') or kind=='StateTrigger':roots.add(key)
        start_masks=[]
        if kind=='Action':
            refs=entry.get('StartStateCondition_Array',[]);negations=entry.get('StartStateConditionNot_Array',[])
            for i,ref in enumerate(refs):start_masks.append(condition_mask(ref,area,bool(negations[i]) if len(negations)>i else False))
        # OR is a safe upper bound if the list's conjunction semantics are unknown.
        start_mask=all_bits if not start_masks else 0
        for mask in start_masks:start_mask|=mask
        for prop,value in entry.items():
            if prop=='$tag' or 'StateCondition' in prop:continue
            for index,target in enumerate(value if isinstance(value,list) else [value]):
                if not isinstance(target,str):continue
                mask=start_mask;reason=None
                if kind=='StateChange' and prop=='SwapStateChange_Array':
                    refs=entry.get('SwapStateCondition_Array',[]);negations=entry.get('SwapStateConditionNot_Array',[])
                    if len(refs)==len(entry.get('SwapStateChange_Array',[])) and len(refs)>index:
                        mask&=condition_mask(refs[index],area,bool(negations[index]) if len(negations)>index else False);reason={'condition':refs[index],'negated':bool(negations[index]) if len(negations)>index else False}
                for dest in resolve(target,area):
                    adjacency[key].append((dest,mask,reason));incoming[dest]+=1
                    if mask!=all_bits:guards.append({'from':key,'to':dest,'allowed':[tag for tag in tags if mask&bit[tag]],'condition':reason,'property':prop})
                # Every metadata reference to a voice participates; an unguarded one broadens the union.
                for stem in by_voice.get((area,target.lstrip('$').casefold()),[]):endpoints[stem].append((key,start_mask,prop))
        if kind=='CutSceneList':
            for stem in cut_groups.get((area,entry['$tag'].casefold()),[]):endpoints[stem].append((key,all_bits,'cutscene-list'))
    for area,kind,entry in foreign:
        for value in all_strings(entry):
            roots.update(resolve(value,area))
            for stem in by_voice.get((area,value.lstrip('$').casefold()),[]):endpoints[stem].append((None,all_bits,'unmodeled-'+kind))
    roots.update(key for key in nodes if not incoming[key])
    reach={key:all_bits for key in roots};queue=collections.deque(roots)
    def propagate():
        while queue:
            key=queue.popleft();source=reach[key]
            for dest,mask,_ in adjacency[key]:
                new=source&mask;prior=reach.get(dest,0)
                if new&~prior:reach[dest]=prior|new;queue.append(dest)
    propagate()
    unrooted=[key for key in nodes if key not in reach]
    # Cycles or unknown external entry points cannot be treated as unreachable.
    for key in unrooted:reach[key]=all_bits;queue.append(key)
    propagate()
    proposals=[];counts=collections.Counter();audit=[]
    by_stem={r['stem']:r for r in rows};previous={r['stem']:r for r in (prior_rules or [])}
    for stem,refs in endpoints.items():
        old=by_stem[stem]['extra']['chapter_candidates'];allowed={c['evidence']['row'] for c in old};union=0;paths=[]
        for node,mask,prop in refs:
            value=(reach.get(node,all_bits) if node else all_bits)&mask;union|=value
            paths.append({'node':node,'property':prop,'allowed':[tag for tag in tags if value&bit[tag]]})
        remaining={tag for tag in allowed if union&bit[tag]};counts['referenced_rows']+=1
        if remaining and remaining<allowed:
            counts['narrowable_rows']+=1;counts['unique_rows']+=len(remaining)==1
            proposals.append({'stem':stem,'original_candidates':sorted(allowed),'allowed_candidates':sorted(remaining),'paths':paths,'method':'exclusive-current-chapter-flag-three-valued-all-reference-path-union'})
        elif not remaining:counts['contradictory_or_unreachable_rows']+=1
        prior=previous.get(stem) or by_stem[stem]['extra'].get('chapter_refinement')
        if prior:audit.append({'stem':stem,'web_chapter':prior['chapter'],'allowed_current_chapter_tags':sorted(remaining),'has_unconstrained_reference':any(len(p['allowed'])==len(tags) for p in paths),'web_chapter_excluded_by_known_metadata':not any(chapters[tag]['number']==prior['chapter'] for tag in remaining)})
    audited={a['stem'] for a in audit}
    for stem,prior in previous.items():
        if stem not in audited:audit.append({'stem':stem,'web_chapter':prior['chapter'],'allowed_current_chapter_tags':None,'has_unconstrained_reference':True,'status':'no-modeled-runtime-voice-reference','web_chapter_excluded_by_known_metadata':False})
    counts['previous_rules_audited']=len(audit);counts['previous_rule_runtime_conflicts']=sum(a['web_chapter_excluded_by_known_metadata'] for a in audit)
    return {'method':'conservative-dataobject-reference-overapproximation','metadata_assets':len(docs),'chapter_flag_proof':flag_proof,'nodes':len(nodes),'roots':len(roots),'unrooted_cycle_or_external_nodes':len(unrooted),'guarded_edges':len(guards),'summary':dict(counts),'proposals':proposals,'guard_examples':guards[:100],'prior_web_overlay_audit':audit,'limitations':['Unsupported brackets/mixed logical precedence/missing constants remain unknown.','All object/state-trigger/foreign references and unrooted cycles are unconstrained entries.','A possible chapter mask is not proof that an unknown route actually executes in every allowed chapter.']}

if __name__=='__main__':
    rows=[json.loads(line) for line in (WORK/'voice-catalog.jsonl').read_text().splitlines()]
    prior_file=WORK/'chapter-refinement/refinement-rules.json';prior=json.loads(prior_file.read_text())['rules'] if prior_file.exists() else []
    result=analyze(load_logic_metadata(),rows,prior);out=WORK/'chapter-refinement/chapter-logic-mask-analysis.json';out.write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({key:value for key,value in result.items() if key in ['metadata_assets','nodes','roots','unrooted_cycle_or_external_nodes','guarded_edges','summary']}))
