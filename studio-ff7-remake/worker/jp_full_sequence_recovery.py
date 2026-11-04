#!/usr/bin/env python3
"""Supplement JP alias plan using explicit named SAB KeyOn references after loops."""
import argparse,json,hashlib,copy,collections
from jp_recovery import WORK,MANIFEST,VERSION,atomic_json,load_sources,prepare_files,apply_db

def prepare():
    manifest=json.loads(MANIFEST.read_text());graph=WORK/'missing-jp-audit/unpaired-bank-full-user-audit.json';data=json.loads(graph.read_text());by={r['path'].split('/raw-voice/',1)[-1]:r for r in data}
    sources={(r['path'],r['clip']['clip_index']):r for r in load_sources()};catalog={r['stem']:r for r in map(json.loads,(WORK/'voice-catalog.jsonl').read_text().splitlines())};existing={r['stem'] for r in manifest['recoveries']};added=[]
    for pending in manifest['unresolved']:
        if '/Character/' not in pending['en_path']:continue
        en=catalog[pending['stem']]['extra']['audio_sources']['en'];jp_path=pending['en_path'].replace('/Voice/US/','/Voice/JP/');en_graph=by[en['path']];jp_graph=by[jp_path]
        names=en_graph['named_material_users'].get(str(en['clip']['clip_index']),[])
        matches=[int(i) for i,users in jp_graph['named_material_users'].items() if users==names and users]
        if len(matches)!=1:continue
        source=sources[(jp_path,matches[0])];clip=source['clip'];guard={'language':'jp','channels':clip['channels'],'preview_only':clip.get('eligible_for_generation') is False or clip['channels']>2,'eligible_for_generation':clip.get('eligible_for_generation') is not False and clip['channels']<=2,'missing_jp':False,'source_clip_index':clip['clip_index'],'source_path':source['path'],'source_pak':source['pak']}
        added.append({'stem':pending['stem'],'version':VERSION,'method':'full-sequence-same-bank-unique-named-keyon','en_source':en,'jp_source':copy.deepcopy(source),'equivalent_jp_aliases':[{'path':source['path'],'clip_index':clip['clip_index'],'audio_path':clip['audio_path'],'pcm_sha256':clip['pcm_sha256']}],'target_audio_path':'jp/'+pending['stem']+'.mp3','audio_extraction':guard,'full_sequence_evidence':{'graph':str(graph.relative_to(WORK)),'graph_sha256':hashlib.sha256(graph.read_bytes()).hexdigest(),'raw_commands_graph':'missing-jp-audit/unpaired-bank-full-graphs.jsonl','named_cues':names,'en_material_index':en['clip']['clip_index'],'jp_material_index':clip['clip_index'],'matching_basis':'same-named-SoundEntry-full-Sequence-KeyOn-to-track-to-material','material_slot_equality_required':False}})
    if added:
        assert len(added)==21
        manifest['recoveries'].extend(added);stems={r['stem'] for r in added};manifest['unresolved']=[r for r in manifest['unresolved'] if r['stem'] not in stems];manifest['recovered_alias_rows']=len(manifest['recoveries']);manifest['method_counts']=dict(collections.Counter(r['method'] for r in manifest['recoveries']))
    return manifest,len(added)
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--apply',action='store_true');a=p.parse_args();manifest,n=prepare()
    if a.apply:prepare_files(manifest);apply_db(manifest)
    print(json.dumps({'added_full_sequence_aliases':n,'total_alias_rows':manifest['recovered_alias_rows'],'remaining_unresolved':len(manifest['unresolved'])}))
