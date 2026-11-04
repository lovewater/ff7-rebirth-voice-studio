#!/usr/bin/env python3
"""Export only this game's official ACTOR trilingual names for translation."""
import collections,hashlib,json,re
from build_catalog import WORK,load_text,actor,clean
GENERIC=re.compile(r'(?i)(?<![a-z])(resident|officer|soldier|trooper|guard|shop|vendor|dealer|owner|worker|employee|assistant|attendant|announcement|announcer|passenger|boy|girl|woman|man|mother|father|daughter|son|sister|brother|child|children|staff|subordinate|guide|researcher|pilot|receptionist|reporter|collaborator|student|beastmaster|gatekeeper|barker|housemother|doctor|nurse|radio|elevator|arsenal|machine|hologram|commander|captain|bandit|hoodlum|thug|mercenary)(?![a-z])')
GENERIC_EXACT={'Big Bro','Chocobo','Combat Simulator','Console','Corneo Lackey','Counterfeiter','Cowgirl','Customer','DJ','Flametrooper','Flower Peddler','Guest','Honeygirl','Host','Innkeeper','Merchant','New Recruit','News Anchor','Pharmacist','Poet','Research Program','Robot','Server','Shinra Helicopter','Shinra Middle Manager','Singer','Spectator','Stablehand','Teacher','Womanizer',"Middle Manager's Friend","Jessie's Mom"}
def supplement_resident(entries,texts):
    lookup={e['english']:e for e in entries}
    # Explicit person name fields outrank ACTOR display titles/variable honorifics.
    keys=[key for lang,key in texts if lang=='US' and key.startswith('name_') and key!='name_pre']
    keys+= [key for lang,key in texts if lang=='US' and key.startswith('menu_loading_character_') and key.endswith('_title')]
    for key in keys:
        hits={lang:texts.get((lang,key),[]) for lang in ['CN','JP','US']}
        if any(len(v)!=1 or v[0]['area']!='Resident' for v in hits.values()):continue
        values={lang:clean(v[0]['entry']['text']) for lang,v in hits.items()}
        english=values['US'];proper=bool(re.fullmatch(r"[A-Z][A-Za-z'’.-]*(?: [A-Z][A-Za-z'’.-]*){0,3}",english))
        if not proper or english in GENERIC_EXACT or GENERIC.search(english) or english in {'SOLDIER','Stamp','The Turks'}:continue
        proof={'source':'remake-official-Resident-person-name-field','id':key,'assets':{lang:v[0]['asset'] for lang,v in hits.items()},'official_values':values}
        existing=lookup.get(english)
        if existing is None:
            existing={'english':english,'japanese':values['JP'],'chinese':values['CN'],'english_aliases':[english],'matchable':True,'evidence':proof};entries.append(existing);lookup[english]=existing
        else:
            existing.setdefault('official_name_fields',[]).append(proof)
            if key.startswith('name_'):
                existing['japanese']=values['JP'];existing['chinese']=values['CN'];existing['matchable']=True
            elif existing['japanese']!=values['JP'] and existing['chinese'] in values['CN']:
                existing.setdefault('japanese_aliases',[]).append({'text':values['JP'],'verified':True,'evidence':proof})
    # Corneo is a repeated real spoken proper name, not the generic honorific Don.
    entry=lookup.get('Don Corneo');evidence=[]
    if entry:
        for (lang,key),en in texts.items():
            if lang!='US' or len(en)!=1 or not re.search(r'(?<!Don )(?<!Don\u00a0)\bCorneo\b',en[0]['entry']['text']):continue
            cn=texts.get(('CN',key),[]);jp=texts.get(('JP',key),[])
            if len(cn)==len(jp)==1 and '古留根尾' in cn[0]['entry']['text'] and 'コルネオ' in jp[0]['entry']['text']:
                evidence.append({'voice_id':key,'assets':{'US':en[0]['asset'],'CN':cn[0]['asset'],'JP':jp[0]['asset']}})
        if len(evidence)>=3:
            entry['english_aliases'].append('Corneo');entry['verified_english_alias_evidence']={'Corneo':{'matches':len(evidence),'samples':evidence[:5]}}
    entries.sort(key=lambda e:e['english'])

def export():
    texts=load_text();counts=collections.defaultdict(collections.Counter);samples=collections.defaultdict(list)
    for (lang,key),english_hits in texts.items():
        if lang!='US':continue
        cn=texts.get(('CN',key),[]);jp=texts.get(('JP',key),[])
        if len(english_hits)!=1 or len(cn)!=1 or len(jp)!=1:continue
        en_name=actor(english_hits[0]['entry']);cn_name=actor(cn[0]['entry']);jp_name=actor(jp[0]['entry'])
        if not all([en_name,cn_name,jp_name]):continue
        pair=(cn_name,jp_name);counts[en_name][pair]+=1
        if len(samples[(en_name,pair)])<3:samples[(en_name,pair)].append({'voice_id':key,'english_asset':english_hits[0]['asset'],'chinese_asset':cn[0]['asset'],'japanese_asset':jp[0]['asset']})
    entries=[]
    for english,tally in sorted(counts.items()):
        (chinese,japanese),n=tally.most_common(1)[0];total=sum(tally.values());share=n/total
        if n<3 or share<.90:continue
        proper=bool(re.fullmatch(r"[A-Z][A-Za-z'’.-]*(?: [A-Z][A-Za-z'’.-]*){0,3}",english))
        generic=english in GENERIC_EXACT or bool(GENERIC.search(english)) or '&' in english or english in {'Everyone','All','Voice','Unknown','???','NPC','Security'}
        entry={'english':english,'japanese':japanese,'chinese':chinese,'english_aliases':[english],'matchable':proper and not generic,'evidence':{'source':'remake-official-trilingual-ACTOR','winner_count':n,'total_nonempty_triples':total,'share':share,'alternatives':[{'chinese':c,'japanese':j,'count':count} for (c,j),count in tally.most_common()],'samples':samples[(english,(chinese,japanese))]}}
        entries.append(entry)
    supplement_resident(entries,texts)
    revision=hashlib.sha256(json.dumps(entries,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    out={'revision':revision,'game_id':'remake','database':'studio_ff7_remake','entries':entries};dest=WORK/'preprocess/name-glossary.json';dest.parent.mkdir(exist_ok=True,parents=True)
    tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(out,ensure_ascii=False,indent=2));tmp.replace(dest)
    print(json.dumps({'entries':len(entries),'matchable':sum(x['matchable'] for x in entries),'path':str(dest),'revision':revision}));return out
if __name__=='__main__':export()
