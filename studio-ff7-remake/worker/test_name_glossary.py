import unittest
from export_name_glossary import supplement_resident,GENERIC_EXACT
class NameGlossaryTests(unittest.TestCase):
 def texts(self,key,en,cn,jp,area='Resident'):
  return {(lang,key):[{'area':area,'asset':f'Text/{lang}/{area}_TxtRes.json','entry':{'id':'$'+key,'text':body}}] for lang,body in [('US',en),('CN',cn),('JP',jp)]}
 def test_explicit_resident_names_override_actor_honorific_disagreement(self):
  texts={**self.texts('name_mom','Madam M','玛姆','マム'),**self.texts('menu_loading_character_president_title','President Shinra','神罗总裁','プレジデント神羅'),**self.texts('name_pre','President Shinra','总裁','プレジデント')}
  entries=[];supplement_resident(entries,texts);names={e['english']:e for e in entries}
  self.assertEqual(names['Madam M']['chinese'],'玛姆');self.assertEqual(names['President Shinra']['japanese'],'プレジデント神羅')
 def test_generic_names_never_become_people_even_with_name_field(self):
  texts=self.texts('name_customer','Customer','客人','客');entries=[];supplement_resident(entries,texts)
  self.assertFalse(entries);self.assertTrue({'Customer','Guest','Server','Chocobo',"Jessie's Mom"}<=GENERIC_EXACT)
 def test_corneo_short_name_requires_repeated_trilingual_body_evidence(self):
  texts=self.texts('name_cln','Don Corneo','古留根尾','コルネオ')
  for i in range(3):texts.update(self.texts(f'line_{i}','Where is Corneo?','古留根尾在哪里？','コルネオはどこ？','Area'))
  entries=[];supplement_resident(entries,texts);entry=next(e for e in entries if e['english']=='Don Corneo')
  self.assertIn('Corneo',entry['english_aliases']);self.assertNotIn('Don',entry['english_aliases'])
if __name__=='__main__':unittest.main()
