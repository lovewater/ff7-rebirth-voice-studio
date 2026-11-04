import unittest
from chapter_logic_masks import evaluate_condition,tri_or,tri_and,tri_not
class LogicMaskTests(unittest.TestCase):
 def condition(self,logical='&&'):
  return {'TargetType_Array':[1,1],'TargetStringArgument_Array':['current_flag','None','unknown_flag'],'ComparisonOperator_Array':['==','=='],'ComparisonValue_Array':[1,1],'LogicalOperator_Array':[logical]}
 def test_unknown_or_branch_cannot_exclude_a_chapter(self):
  self.assertIsNone(evaluate_condition(self.condition('||'),{'current_flag':0}))
  self.assertTrue(evaluate_condition(self.condition('||'),{'current_flag':1}))
 def test_false_and_branch_excludes_but_true_and_unknown_does_not(self):
  self.assertFalse(evaluate_condition(self.condition('&&'),{'current_flag':0}))
  self.assertIsNone(evaluate_condition(self.condition('&&'),{'current_flag':1}))
 def test_unsupported_brackets_and_missing_constants_remain_unknown(self):
  c=self.condition();c['StartBracket_Array']=['('];self.assertIsNone(evaluate_condition(c,{'current_flag':0}))
  c={'TargetType_Array':[1],'TargetStringArgument_Array':['current_flag'],'ComparisonOperator_Array':['==']};self.assertIsNone(evaluate_condition(c,{'current_flag':0}))
 def test_balanced_whole_expression_wrapper_preserves_unknown_or(self):
  c=self.condition('||');c['StartBracket_Array']=['('];c['EndBracket_Array']=['','','','','',')']
  self.assertIsNone(evaluate_condition(c,{'current_flag':0}))
  self.assertTrue(evaluate_condition(c,{'current_flag':1}))
 def test_actual_blank_placeholder_row_does_not_erase_following_flag(self):
  c={'TargetType_Array':[0,1,1],'TargetStringArgument_Array':['None','None','chapter13','None','chapter14','None'],'ComparisonOperator_Array':['','==','=='],'ComparisonValue_Array':[0,1,1],'LogicalOperator_Array':['','||'],'StartBracket_Array':['('],'EndBracket_Array':['','','','','','','','','',')']}
  self.assertTrue(evaluate_condition(c,{'chapter13':0,'chapter14':1}))
  self.assertFalse(evaluate_condition(c,{'chapter13':0,'chapter14':0}))
  self.assertIsNone(evaluate_condition(c,{'chapter13':0,'chapter14':None}))
 def test_path_union_preserves_both_chapters_and_unconstrained_route(self):
  chap3=1<<0;chap4=1<<1;allchap=chap3|chap4|(1<<2)
  self.assertEqual(chap3|chap4,3);self.assertEqual(chap3|allchap,allchap)
  self.assertIsNone(tri_not(None));self.assertFalse(tri_and([True,False,None]));self.assertTrue(tri_or([False,True,None]))
if __name__=='__main__':unittest.main()

from unittest.mock import patch
from chapter_logic_masks import analyze,evaluate_definitions
class ActualPathUnionTests(unittest.TestCase):
 def fixture(self,unconstrained=False):
  tags=['Chapt_0003','Chapt_0004','Chapt_0012'];flags=['stfCmnChapter03_Start','stfCmnChapter04_Start','stfCmnChapter12_Start']
  chapters={tag:{'number':n,'campaign':'main'} for tag,n in zip(tags,[3,4,12])}
  chapter_rows=[{'$tag':tag,'RaiseStoryFlag_Array':[flag],'DropStoryFlag_Array':[x for x in flags if x!=flag]} for tag,flag in zip(tags,flags)]
  conditions=[{'$tag':'c'+str(n),'TargetType_Array':[1],'TargetStringArgument_Array':[flag],'ComparisonOperator_Array':['=='],'ComparisonValue_Array':[1]} for n,flag in zip([3,4],flags)]
  actions=[{'$tag':'a'+str(n),'StartStateCondition_Array':['c'+str(n)],'StringArgumentList_Array':['conversation']} for n in [3,4]]
  if unconstrained:actions.append({'$tag':'external_route','StringArgumentList_Array':['conversation']})
  docs={'Data/Resident/Chapter.uasset':chapter_rows,'Data/Resident/StateCondition.uasset':conditions,'Data/Field/A/Action.uasset':actions,'Data/Field/A/PlannerEvent.uasset':[{'$tag':'conversation','SoundID':'voice_a'}]}
  rows=[{'stem':'voice_a','asset_path':'End/Sound/Voice/JP/Field/A/TK/voice_a.uexp','extra':{'source_stem':'voice_a','chapter_classification':'shared','chapter_candidates':[{'number':n,'evidence':{'row':tag}} for tag,n in zip(tags,[3,4,12])]}}]
  return chapters,docs,rows
 def test_two_real_conditional_paths_union_to_two_chapters(self):
  chapters,docs,rows=self.fixture()
  with patch('chapter_logic_masks.chapter_facts',return_value=(chapters,{},{})),patch('chapter_logic_masks.load_text',return_value={}):r=analyze(docs,rows)
  self.assertEqual(r['proposals'][0]['allowed_candidates'],['Chapt_0003','Chapt_0004'])
 def test_unconstrained_extra_route_prevents_false_uniqueness(self):
  chapters,docs,rows=self.fixture(True)
  with patch('chapter_logic_masks.chapter_facts',return_value=(chapters,{},{})),patch('chapter_logic_masks.load_text',return_value={}):r=analyze(docs,rows)
  self.assertEqual(r['proposals'],[])
 def test_negation_applies_before_union_of_ambiguous_definitions(self):
  a={'TargetType_Array':[1],'TargetStringArgument_Array':['flag'],'ComparisonOperator_Array':['=='],'ComparisonValue_Array':[1]}
  b={**a,'ComparisonValue_Array':[0]}
  self.assertTrue(evaluate_definitions([a,b],{'flag':1},True))
