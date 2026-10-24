#!/usr/bin/env python3
"""从官方三语TxtRes同ID名字/角色标签建立翻译术语表；不修改字幕和speakers。
输出仅到ignored data/work。角色称呼也保留作查询依据，普通职业标签不触发重译。
"""
import collections,hashlib,json,re,sys,unicodedata
from pathlib import Path
from extract_txtres import ROOT,parse_txtres
RAW=ROOT/'work/txtres-raw'
VOICE=re.compile(r'_\d{4}_\d{4}_\d{2}_[A-Za-z0-9]+$')
# 普通角色职业不能当人名触发，否则Man/Guard等会把大量普通句子重跑。
GENERIC_WORDS=set('7th infantry trooper troopers accessory vendor amusement attendant animal handler announcement assistant auctioneer audience member barker bartender beachgoer bird watcher black robe robes bookstore employee boy card collector shop cast cactuar cactuars cannoneer captain children chicken chickens chicks chocobo tack colosseum receptionist commander adjutant commentator companion concert mc concierge conductor console crew dancer dancers docent dolphin drainage system driver eccentric swordsman elevator operator everyone farmer ferry fool fort condor frog front desk gp trader gatekeeper general store clerk owner gi specter gift girl girls glenn guard guest guide moogle helicopter pilot heliport hiker hotel infodesk inn innkeeper item jockey kalm citizen resident kittens leader little maghnata manager man woman medicine seller mentor militia militiaman mobile officer mooglet mooglets newscaster north corel outdoorsman park parking participants passenger photographer planetologist plushie princess racing radio ranch receptionst reporter researcher resistance fighter fighters resort robed men secretary security seventh shady guy shinra special forces space ranger spectator stall studio stuffed supervisor survey team suspicious swimsuit tack terrified cetra pirate king words shadowblood queen thug thugs ticket tifas dad tonberry robot tournament organizer transmission travel bureau undercity underling user interface usher villager visitor vulture wainwright warlock weapons weaponsmith welcoming committee wheelie youth coalition'.split())
# 这三项无name_*标签，取自明确的官方字幕片段并逐项校验原文；不是采用模型常识音译。
SUPPLEMENTS=[('Nanaki','ナナキ','纳纳奇','C3010_MAIN_3200_0100_00_mma'),('Jenova','ジェノバ','杰诺瓦','C2320_MAIN_1900_2100_00_sep'),('Seto','セト','塞特','C2910_MAIN_7700_0300_00_red')]
def main():
 files={};records={};votes=collections.defaultdict(collections.Counter);jvotes=collections.defaultdict(collections.Counter);evidence=collections.defaultdict(list);entries={}
 for f in sorted((RAW/'US').glob('*.uasset')):
  local={}
  for lang in ['US','CN','JP']:
   p=RAW/lang/f.name
   if p.exists():local[lang]={e['id']:e for e in parse_txtres(p.read_bytes())['entries']}
  files[f.name]=local
  for key,e in local.get('US',{}).items():
   c=local.get('CN',{}).get(key);j=local.get('JP',{}).get(key)
   if not c:continue
   if key.startswith('$name_'):
    records[e['text']]={'english':e['text'],'chinese':c['text'],'japanese':j['text'] if j else '', 'kind':'name-entry','matchable':True,'evidence':[{'file':f.name,'key':key}]}
   if not VOICE.search(e.get('stem','')):continue
   entries[e['stem']]={'en':e['text'],'zh':c['text'],'jp':j['text'] if j else ''}
   en=e.get('actor','').strip();zh=c.get('actor','').strip();jp=(j or {}).get('actor','').strip()
   if not en or not zh or '?' in en or '？' in zh:continue
   votes[en][zh]+=1
   if jp:jvotes[en][jp]+=1
   if len(evidence[en])<3:evidence[en].append({'file':f.name,'key':key})
 for en,counter in votes.items():
  if en in records:continue
  zh,n=counter.most_common(1)[0]
  if n/sum(counter.values())<.8:continue
  jp=jvotes[en].most_common(1)[0][0] if jvotes[en] else ''
  tokens=set(re.findall(r'[a-z0-9]+',en.lower()))
  named=bool(tokens-GENERIC_WORDS) and not any(x in en for x in [' & ',"'s "]) and en not in {'Materia Vendor','Mayor','Mayor of Kalm','Ranch Hand','Sand Giant','Skywheel Attendant','Youth Coalition Members'}
  records[en]={'english':en,'chinese':zh,'japanese':jp,'kind':'actor-label','matchable':named,'evidence':evidence[en],'votes':dict(counter)}
 for en,jp,zh,stem in SUPPLEMENTS:
  r=entries.get(stem,{})
  if en not in r.get('en','') or jp not in r.get('jp','') or zh not in r.get('zh',''):raise ValueError('补充人名缺少官方数据证据: '+en)
  records[en]={'english':en,'chinese':zh,'japanese':jp,'kind':'official-dialogue-name','matchable':True,'evidence':[{'key':'$'+stem,'source':'official-three-language-dialogue'}]}
 # 只派生明确职衔的简称；不把Billy Bob拆成Billy，避免与格林葛林混淆。
 for en,r in records.items():
  aliases=[en]
  alias=re.sub(r'^(?:Don|Mayor|Captain|Doctor|Dr\.|Mr\.|Ms\.|Madam)\s+','',en)
  if alias!=en and len(alias)>=3 and (alias not in records or records[alias]['chinese']==r['chinese']):aliases.append(alias)
  r['english_aliases']=aliases
 rows=sorted(records.values(),key=lambda r:r['english'])
 revision=hashlib.sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
 out={'revision':revision,'entries':rows}
 target=ROOT/'studio-ff7-rb/website/data/translation-background/name-glossary.json';target.write_text(json.dumps(out,ensure_ascii=False,indent=2))
 report=ROOT/'work/translation-name-glossary.md'
 report.write_text('# 官方人名翻译对照\n\n'+f'共{len(rows)}项，{sum(r["matchable"] for r in rows)}项参与人名匹配。\n\n|英文|日文|官方中文|触发重译|来源|\n|---|---|---|---|---|\n'+'\n'.join(f'|{r["english"]}|{r["japanese"]}|{r["chinese"]}|{"是" if r["matchable"] else "否（普通角色标签）"}|{r["kind"]}|' for r in rows)+'\n')
 print(json.dumps({'entries':len(rows),'matchable':sum(r['matchable'] for r in rows),'revision':revision,'catalog':str(target),'report':str(report)},ensure_ascii=False))
if __name__=='__main__':main()
