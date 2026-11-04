import unittest,collections,json,tempfile
from pathlib import Path
from unittest.mock import patch
from build_catalog import choose_text,chapter_facts,category,clean,group_audio_sources,resolve_clip_text,text_index_audit,usage_facts,content_facts,read_journal,speaker_facts,speaker_code
class CatalogTests(unittest.TestCase):
 def test_duplicate_id_is_resolved_only_with_source_area(self):
  texts={('CN','line'):[{'area':'A','asset':'A.json','entry':{'id':'$line','text':'甲'}},{'area':'B','asset':'B.json','entry':{'id':'$line','text':'乙'}}]}
  self.assertEqual(choose_text(texts,'CN','LINE','B')[0]['entry']['text'],'乙')
  self.assertEqual(choose_text(texts,'CN','line','unknown')[1]['status'],'ambiguous')
 def test_chapter_name_ids_are_not_chapter_numbers_and_truth_aliases_are_retained(self):
  texts={}
  for k,t in [('chapter_number_0009','CHAPTER 8'),('chapter_title_0009','甲'),('chapter_number_0014_02','CHAPTER 14'),('chapter_title_0014_02','乙')]:
   texts[('CN',k)]=[{'area':'Resident','asset':'Resident.json','entry':{'id':'$'+k,'text':t}}]
  docs={'x/Resident/Chapter.uasset':[{'$tag':'Chapt_0008','UniqueID':8,'ChapterNameID':'$chapter_number_0009','LocationResidentID_Array':['A']},{'$tag':'Chapt_0014','UniqueID':14,'ChapterNameID':'$chapter_number_0014_02','LocationResidentID_Array':['B']}], 'x/Resident/LocationResident.uasset':[{'$tag':'B','TruthLocationID':'A'}]}
  ch,areas,_=chapter_facts(docs,texts)
  self.assertEqual(ch['Chapt_0008']['number'],8);self.assertEqual(ch['Chapt_0014']['number'],14)
  self.assertEqual(areas['A'],{'Chapt_0008','Chapt_0014'})
 def test_type_evidence_never_claims_all_field_files_are_scene(self):
  self.assertEqual(category('/Voice/JP/Field/A/PV_A/line.uexp',{}),('事件对白','unknown','planner-event-talk'))
  self.assertEqual(category('/Voice/JP/Field/A/BA_A/line.uexp',{}),('战斗对白','field','battle-talk'))
  self.assertEqual(category('/Voice/JP/Character/Player/a.uexp',None)[0],'战斗语音')
 def test_clean_preserves_body_but_removes_subtitle_markup(self):
  self.assertEqual(clean('<i>甲\\r\\n乙</i>'),'甲\n乙')
 def test_bank_pairing_uses_unique_voice_ids_not_material_indices(self):
  def a(lang,clips):
   return {'status':'ready','language':lang,'path':'End/Sound/Voice/'+('JP' if lang=='jp' else 'US')+'/Character/Reno.uexp','clips':[{'stem':lang+str(i),'clip_index':i,'users':users} for i,users in clips]}
  grouped,_=group_audio_sources([a('jp',[(0,['voice_a']),(1,['voice_b'])]),a('en',[(0,['voice_b']),(7,['voice_a'])])])
  self.assertEqual(len(grouped),2)
  voicea=next(g for g in grouped.values() if g['jp'][1]['clip_index']==0)
  self.assertEqual(voicea['en'][1]['clip_index'],7)
 def test_ambiguous_and_unidentified_banks_are_not_paired(self):
  def a(lang):
   return {'status':'ready','language':lang,'path':'End/Sound/Voice/'+('JP' if lang=='jp' else 'US')+'/Character/Reno.uexp','clips':[{'stem':lang+str(i),'clip_index':i,'users':users} for i,users in enumerate([['voice_a'],['voice_a'],[]])]}
  grouped,_=group_audio_sources([a('jp'),a('en')])
  self.assertEqual(len(grouped),6)
  self.assertTrue(all(len(g)==1 for g in grouped.values()))
 def test_build_dedup_requires_identical_pcm_and_keeps_alias_evidence(self):
  def a(path,build,hash):
   return {'status':'ready','language':'jp','path':path,'is_build_pack':build,'clips':[{'stem':path,'clip_index':0,'users':[],'pcm_sha256':hash}]}
  grouped,excluded=group_audio_sources([a('direct',False,'hashA'),a('build',True,'hashA'),a('different',True,'hashB')])
  self.assertEqual(len(grouped),2);self.assertEqual(excluded[0]['aliases'],['direct'])
 def test_clip_caption_resolution_keeps_source_area_and_ambiguity_provenance(self):
  hits=[{'area':area,'asset':area+'.json','entry':{'id':'$same_voice','text':body}} for area,body in [('000-COMON','公共版本'),('220-PSBL0','剧情版本')]]
  texts={('CN','same_voice'):hits}
  hit,proof=resolve_clip_text(texts,'CN',['same_voice'],'220-PSBL0')
  self.assertEqual(hit['entry']['text'],'剧情版本');self.assertEqual(proof['asset'],'220-PSBL0.json')
  hit,proof=resolve_clip_text(texts,'CN',['same_voice'],'002-IGNOR')
  self.assertIsNone(hit);self.assertEqual(proof['status'],'ambiguous-clip')
  self.assertEqual(set(proof['ambiguous_ids'][0]['candidates']),{'000-COMON.json','220-PSBL0.json'})
  self.assertEqual(text_index_audit(texts)['conflicting_bodies_by_language'],{'CN':1})
 def test_test_location_flag_does_not_claim_asset_unused(self):
  usage=usage_facts('/Cut/000-COMON/voice.uexp','000-COMON',{'000-COMON':{'$tag':'000-COMON','UnuseRelease':1,'Detail':'召喚テスト'}})
  self.assertEqual(usage['status'],'special-directory-usage-unverified')
  self.assertTrue(usage['location_flag_is_not_proof_asset_unused']);self.assertNotIn('asset_unused',usage)
  self.assertEqual(usage_facts('/Cut/002-IGNOR/voice.uexp','002-IGNOR',{})['reasons'],['source-directory-IGNOR-label-only'])
 def test_character_action_uses_explicit_voice_id_not_acoustic_emotion(self):
  usage={'status':'no-special-directory-warning'}
  self.assertEqual(content_facts('/Character/Player/Cloud.uexp',{'users':['atk_normal_05']},usage)['category'],'character-action-voice')
  self.assertEqual(content_facts('/Character/Player/Cloud.uexp',{'users':['numeric_001']},usage)['category'],'character-general-voice')
  self.assertEqual(content_facts('/Character/Enemy/Reno.uexp',{'users':['bt302_01_001_ren_0']},usage)['category'],'battle-character-voice')
 def test_live_journal_skips_only_unterminated_tail_including_partial_utf8(self):
  good=json.dumps({'language':'jp','path':'a','status':'ready'}).encode()+b'\n'
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'voice-extraction.jsonl').write_bytes(good+b'{"partial":"'+bytes([0xe4,0xb8]))
   with patch('build_catalog.WORK',root):self.assertEqual(len(list(read_journal())),1)
   (root/'voice-extraction.jsonl').write_bytes(good+b'{bad}\n')
   with patch('build_catalog.WORK',root):
    with self.assertRaises(ValueError):list(read_journal())
 def test_speaker_default_uses_strong_official_consensus_and_game_asset_role(self):
  texts={}
  for lang,name in [('CN','克劳德'),('JP','クラウド'),('US','Cloud')]:
   for i in range(10):texts[(lang,f'ev_x_{i}_cld_0')]=[{'asset':lang+'.json','area':'A','entry':{'id':f'$ev_x_{i}_cld_0','text':'句','sub_entries':[{'id':'ACTOR','text':name}]}}]
  texts[('CN','ev_wrong_cld_0')]=[{'asset':'CN.json','area':'A','entry':{'id':'$ev_wrong_cld_0','text':'句','sub_entries':[{'id':'ACTOR','text':'变装称呼'}]}}]
  with tempfile.TemporaryDirectory() as tmp:
   index=Path(tmp)/'index.jsonl';index.write_text(json.dumps({'path':'End/Sound/Voice/JP/Character/Player/VO_PC0000_00_Cloud.uexp'})+'\n')
   facts=speaker_facts(texts,index)
  self.assertEqual(facts['cld']['name_zh'],'克劳德');self.assertEqual(facts['cld']['role'],'主角')
  proof=json.loads(facts['cld']['note']);self.assertEqual(proof['languages']['CN']['aliases']['变装称呼'],1)
  self.assertEqual(facts['bank_vo_pc0000_00_cloud']['name_zh'],'克劳德')
  self.assertEqual(speaker_code('ba_x_0000_tif'),'tif')
  self.assertEqual(speaker_code('tk_slu5b_0000_0010_5m04_0'),'5m04')
  self.assertEqual(speaker_code('tk_slu5b_0000_0010_5w06_0'),'5w06')
  self.assertIsNone(speaker_code('ev_x_0010_0'))
 def test_weak_actor_consensus_does_not_guess_name_or_role(self):
  texts={}
  for i,name in enumerate(['Cloud']*3+['Other']*3):texts[('US',f'ev_x_{i}_cld_0')]=[{'asset':'US.json','area':'A','entry':{'id':f'$ev_x_{i}_cld_0','text':'句','sub_entries':[{'id':'ACTOR','text':name}]}}]
  with tempfile.TemporaryDirectory() as tmp:
   index=Path(tmp)/'index.jsonl';index.write_text(json.dumps({'path':'End/Sound/Voice/JP/Character/Player/VO_PC0000_00_Cloud.uexp'})+'\n')
   facts=speaker_facts(texts,index)
  self.assertIsNone(facts['cld']['name_zh']);self.assertIsNone(facts['cld']['role'])
if __name__=='__main__':unittest.main()
