import collections,unittest,json,tempfile,contextlib
from pathlib import Path
from unittest.mock import patch
import recover_speakers as recovery
from recover_speakers import cue_parts,choose_actor

class SpeakerEvidence(unittest.TestCase):
    def setup_index(self):
        actors=collections.defaultdict(list);bindings=collections.defaultdict(list);blueprints=collections.defaultdict(list)
        binding={'asset':'A/PlannerEvent.uasset','row_id':'cue','voice_id':'tk_map_0010_0010_mn05_0','group':'tk_map_0010','talker':'NPC05'}
        bindings[('A','mn05')]=[binding];actors[('A','npc05')]=[{'chara_spec':'ActorModel','asset':'A/ObjectActor.uasset','row_id':'NPC05'}];specs={'ActorModel':{'chara_id':'NPC05'}};blueprints['ActorModel']=['Character/Mob/ActorModel.uasset'];known={binding['voice_id']:{'mn05'}};definitions={'mn05':{'code':'mn05'}}
        return bindings,actors,specs,blueprints,known,definitions
    def test_complete_same_group_named_actor_and_real_blueprint_is_sufficient(self):
        args=self.setup_index();proof=choose_actor('A','tk_map_0010','mn05',*args)
        self.assertEqual(proof['basis'],'same-cue-group-unique-talker-character-model')
    def test_same_area_can_extend_only_a_unique_character_model(self):
        args=self.setup_index();proof=choose_actor('A','tk_map_0011','mn05',*args)
        self.assertEqual(proof['basis'],'same-area-speaker-code-unique-character-model')
        self.assertIsNone(choose_actor('B','tk_map_0011','mn05',*args))
    def test_ambiguous_model_and_missing_blueprint_never_create_a_person(self):
        args=list(self.setup_index());args[1][('A','npc05')].append({'chara_spec':'AnotherModel'});self.assertIsNone(choose_actor('A','tk_map_0010','mn05',*args))
        args=list(self.setup_index());args[3]['ActorModel']=[];self.assertIsNone(choose_actor('A','tk_map_0010','mn05',*args))
    def test_collective_codes_and_conflicting_existing_voice_assignments_are_rejected(self):
        args=list(self.setup_index());self.assertIsNone(choose_actor('A','tk_map_0010','mbn',*args))
        args[4]['tk_map_0010_0010_mn05_0']={'mn05','another-person'};self.assertIsNone(choose_actor('A','tk_map_0010','mn05',*args))
    def test_copy_suffix_is_a_known_resource_variant_but_unknown_suffix_is_not_guessed(self):
        self.assertEqual(cue_parts('tk_map_0010_0010_mn05_0_copy'),('tk_map_0010','mn05'))
        self.assertIsNone(cue_parts('tk_map_0010_0010_wed_s_0')[1])
    def test_apply_never_overwrites_nonempty_manual_speaker(self):
        class Cursor:
            def fetchone(self):return ('human-choice','asset',{})
        class DB:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def transaction(self):return contextlib.nullcontext()
            def execute(self,query,*args):
                if query.lstrip().startswith('UPDATE '):raise AssertionError('manual speaker overwritten')
                return Cursor()
        with tempfile.TemporaryDirectory() as root,patch.object(recovery,'FOLDER',Path(root)),patch.object(recovery,'connect',return_value=DB()):
            report=recovery.apply({'proposals':[{'stem':'target','speaker':'mn05'}]})
            self.assertEqual(report['summary'],{'kept-existing-speaker':1})
    def test_apply_never_refills_a_speaker_cleared_after_our_previous_assignment(self):
        class Cursor:
            def fetchone(self):return (None,'asset',{})
        class DB:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def transaction(self):return contextlib.nullcontext()
            def execute(self,query,*args):
                if query.lstrip().startswith('UPDATE '):raise AssertionError('cleared speaker refilled')
                return Cursor()
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root);(folder/'applied.json').write_text(json.dumps({'ever_applied_stems':['target'],'results':[]}))
            with patch.object(recovery,'FOLDER',folder),patch.object(recovery,'connect',return_value=DB()):
                report=recovery.apply({'proposals':[{'stem':'target','speaker':'mn05'}]})
            self.assertEqual(report['summary'],{'kept-cleared-after-recovery':1})
            self.assertEqual(report['ever_applied_stems'],['target'])
if __name__=='__main__':unittest.main()
