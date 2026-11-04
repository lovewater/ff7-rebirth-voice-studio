import unittest,json,tempfile,copy
from pathlib import Path
from unittest.mock import patch
from refine_catalog import parse_transcript,exact_anchor,joint_scene_anchors,propose,may_refine,VERSION,apply_chapter_refinement_overlay,reviewed_levelset_proposals
class RefineTests(unittest.TestCase):
 def row(self,stem,text,event='EV_A_0010',lang='JP'):
  return {'stem':stem,'asset_path':f'End/Sound/Voice/{lang}/Cut/A/{event}/'+stem+'.uexp','region':'SHARED_A','text_en':text,'text_zh':'本地官方字幕','extra':{'chapter_classification':'shared','source_stem':stem,'chapter_candidates':[{'number':3,'campaign':'main'},{'number':4,'campaign':'main'}]}}
 def test_duplicate_quote_in_two_chapters_cannot_be_single_chapter_anchor(self):
  text='This sufficiently long sentence appears in both chapters and must not resolve.'
  turns=parse_transcript('<h2>Chapter 3: A</h2>Cloud: '+text+'<br><h2>Chapter 4: B</h2>Cloud: '+text)
  self.assertIsNone(exact_anchor(self.row('a',text),turns))
 def test_cut_event_expansion_requires_two_distinct_sentences_and_combines_languages(self):
  a='This first sufficiently distinctive sentence belongs to this event alone.';b='This second sufficiently distinctive sentence also belongs to this event.'
  turns=parse_transcript('<h2>Chapter 3: A</h2>Cloud: '+a+'<br>Tifa: '+b)
  rows=[self.row('a',a),self.row('b',b),self.row('en_only','',lang='US')]
  proposals,anchors,groups=propose(rows,turns,{})
  self.assertEqual(set(proposals),{'a','b','en_only'});self.assertEqual(proposals['en_only']['method'],'same-cutscene-event')
  rows[1]['text_en']=a
  proposals,_,groups=propose(rows,turns,{})
  self.assertNotIn('en_only',proposals)
 def test_explicit_nextpe_chain_expands_only_with_matching_source_area(self):
  a='This first sufficiently distinctive sentence belongs to one conversation.';b='This second sufficiently distinctive sentence is in the same conversation.'
  turns=parse_transcript('<h2>Chapter 3: A</h2>Cloud: '+a+'<br>Tifa: '+b)
  rows=[self.row('a',a),self.row('b',b),self.row('c','')]
  for r in rows:r['asset_path']=r['asset_path'].replace('/Cut/A/EV_A_0010/','/Field/A/TK_A/')
  es=[{'$tag':'n1','SoundID':'a','NextPE':'n2'},{'$tag':'n2','SoundID':'b','NextPE':'n3'},{'$tag':'n3','SoundID':'c','NextPE':'None'}]
  proposals,_,_=propose(rows,turns,{'Data/Field/A/PlannerEvent.uasset':es})
  self.assertEqual(proposals['c']['method'],'explicit-nextpe-conversation')
  proposals,_,_=propose(rows,turns,{'Data/Field/OTHER/PlannerEvent.uasset':es})
  self.assertNotIn('c',proposals)
 def test_manual_or_changed_region_and_asset_are_preserved(self):
  rule={'expected_region':'SHARED_A','expected_asset_path':'asset'}
  self.assertTrue(may_refine('SHARED_A','asset',{},rule))
  self.assertFalse(may_refine('CH_0004','asset',{},rule))
  self.assertFalse(may_refine('SHARED_A','other',{},rule))
  self.assertFalse(may_refine('SHARED_A','asset',{'manual_region':'CH_0003'},rule))
  self.assertTrue(may_refine('CH_0003','asset',{'chapter_refinement':{'version':VERSION,'applied_region':'CH_0003'}},rule))
 def test_short_sentence_corroboration_needs_actor_and_fourteen_words(self):
  texts=['This is our final warning.','You cannot keep running forever.','Nobody gets left behind today.']
  turns=parse_transcript('<h2>Chapter 3: A</h2>'+'<br>'.join('Cloud: '+t for t in texts))
  rows=[self.row(str(i),text) for i,text in enumerate(texts)]+[self.row('silent','')]
  for r in rows:r['speaker']='cld'
  proposals,_,_=propose(rows,turns,{}, {'cld':'Cloud'})
  self.assertIn('silent',proposals)
  proposals,_,_=propose(rows,turns,{}, {'cld':'Other'})
  self.assertNotIn('silent',proposals)
 def test_joint_short_quotes_intersect_occurrences_before_candidates(self):
  texts=['We finally made it out.','Where are we?','Where I lived when I was still a child.']
  turns=parse_transcript('<h2>Chapter 3: A</h2>'+'<br>'.join('Cloud: '+t for t in texts)+'<h2>Chapter 4: B</h2>Cloud: Where are we?')
  rows=[self.row(str(i),t) for i,t in enumerate(texts)]
  for r in rows:r['speaker']='cld'
  proof=joint_scene_anchors(rows,turns,{'cld':'Cloud'})
  self.assertEqual({p['chapter'] for p in proof},{3});self.assertEqual(len(proof),3)
  self.assertEqual(joint_scene_anchors(rows[:2],turns,{'cld':'Cloud'}),[])
  repeated=turns+[{**t,'chapter':4,'turn_index':t['turn_index']+20} for t in turns if t['chapter']==3]
  self.assertEqual(joint_scene_anchors(rows,repeated,{'cld':'Cloud'}),[])
 def test_replay_overlay_keeps_audio_and_original_chapter_evidence(self):
  row=self.row('a','');row['extra']['audio_sources']={'jp':{'unchanged':'source'}};original=copy.deepcopy(row['extra']['audio_sources'])
  payload={'version':VERSION,'rules':[{'stem':'a','chapter':3,'expected_region':'SHARED_A','expected_asset_path':row['asset_path']}],'characters':{}}
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'refinement-rules.json').write_text(json.dumps(payload))
   with patch('refine_catalog.SCOPE',root),patch('refine_catalog.PROJECT',root.parent):
    report={'speakers':{}};apply_chapter_refinement_overlay([row],report)
  self.assertEqual(row['region'],'CH_0003');self.assertEqual(row['extra']['audio_sources'],original)
  self.assertEqual(row['extra']['chapter_classification'],'shared');self.assertEqual(row['extra']['chapter_refinement']['original_region'],'SHARED_A')
 def test_reviewed_levelset_needs_two_independent_event_anchors_and_rejects_conflict(self):
  rows=[self.row('a','first','EV_A_0001'),self.row('b','second','EV_A_0002'),self.row('silent','','EV_A_0003')]
  levels=['EV_A_0001','EV_A_0002','EV_A_0003'];asset='Data/Field/A/PlannerLevelSet.uasset';docs={asset:[{'$tag':'finite_bundle','LevelList_Array':levels}]}
  reviewed=[{'asset':asset,'row':'finite_bundle','chapter':3,'expected_level_list':levels}]
  previous={'a':{'chapter':3,'anchors':[{'local_stem':'a','local_text_sha256':'first'}]}}
  self.assertEqual(reviewed_levelset_proposals(rows,docs,previous,reviewed),{})
  previous['b']={'chapter':3,'anchors':[{'local_stem':'b','local_text_sha256':'second'}]}
  self.assertEqual(set(reviewed_levelset_proposals(rows,docs,previous,reviewed)),{'silent'})
  previous['b']['chapter']=4
  with self.assertRaises(ValueError):reviewed_levelset_proposals(rows,docs,previous,reviewed)
  previous['b']['chapter']=3;docs[asset][0]['LevelList_Array']=levels+['EV_A_9999']
  with self.assertRaises(ValueError):reviewed_levelset_proposals(rows,docs,previous,reviewed)
if __name__=='__main__':unittest.main()
