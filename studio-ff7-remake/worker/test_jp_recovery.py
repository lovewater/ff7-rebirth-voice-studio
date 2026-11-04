import copy,hashlib,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import jp_recovery as recovery

def source(language,bank,users,pcm='a',index=0):
    return {'path':f'End/Content/GameContents/Sound/Voice/{language}/Character/Enemy/{bank}.uexp','clip':{'users':users,'pcm_sha256':pcm,'channels':1,'sample_rate':48000,'pcm_frames':100,'clip_index':index}}

class RecoveryEvidence(unittest.TestCase):
    def test_unique_generic_label_cannot_cross_character_bank(self):
        en=source('US','Cloud',['damage_01']);jp=source('JP','Tifa',['damage_01'])
        self.assertIsNone(recovery.choose(en,[jp])[0])
    def test_full_voice_id_can_cross_asset_alias_when_pcm_unambiguous(self):
        en=source('US','debug',['ev_sbil0_2842_0160_blt_0']);jp=source('JP','story',['ev_sbil0_2842_0160_blt_0'])
        self.assertEqual(recovery.choose(en,[jp])[0],jp)
    def test_same_bank_additional_copy_alias_does_not_require_equal_slot(self):
        en=source('US','Soldier',['bt294_01_001_dg04_0'],index=0)
        jp=source('JP','Soldier',['bt294_01_001_dg04_0','bt294_01_001_dg04_0_copy'],index=7)
        self.assertEqual(recovery.choose(en,[jp])[0]['clip']['clip_index'],7)
    def test_ambiguous_named_variants_need_exact_pcm_to_disambiguate(self):
        en=source('US','Bird',['tk_slu5a_80_0224_0010_choc4_0'],pcm='different')
        first=source('JP','Bird',en['clip']['users'],pcm='a',index=2);second=source('JP','Bird',en['clip']['users'],pcm='b',index=8)
        self.assertIsNone(recovery.choose(en,[first,second])[0])
        en['clip']['pcm_sha256']='b'
        self.assertEqual(recovery.choose(en,[first,second])[0]['clip']['clip_index'],8)
    @unittest.skipUnless((recovery.WORK/'missing-jp-audit/unpaired-bank-full-graphs.jsonl').exists(),'actual game sequence fixture unavailable')
    def test_actual_interval_sequence_has_named_keyon_at_different_language_materials(self):
        import json
        found={}
        for line in (recovery.WORK/'missing-jp-audit/unpaired-bank-full-graphs.jsonl').read_text().splitlines():
            row=json.loads(line)
            if not row['path'].endswith('/VO_EN0008_00_Vice_Standard_01.uexp'):continue
            tracks={t['index']:t for t in row['tracks']}
            for cue in row['sounds']:
                if cue['name']!='bt241_01_051_ee01_0':continue
                commands=cue['sequences'][0]['commands']
                self.assertEqual(commands[0]['type'],3)
                material=[tracks[c['track_index']]['material_index'] for c in commands if c['type']==2]
                found['jp' if '/Voice/JP/' in row['path'] else 'en']=material
        self.assertEqual(found,{'jp':[173],'en':[51]})
    def test_copy_refuses_to_replace_existing_different_audio(self):
        with tempfile.TemporaryDirectory() as root:
            data=Path(root);(data/'jp').mkdir();original=data/'jp/original.mp3';original.write_bytes(b'original-source');target=data/'jp/target.mp3';target.write_bytes(b'preserve-existing')
            row={'stem':'target','jp_source':{'clip':{'audio_path':'jp/original.mp3','mp3_sha256':hashlib.sha256(original.read_bytes()).hexdigest()}},'target_audio_path':'jp/target.mp3'}
            with patch.object(recovery,'DATA',data):
                with self.assertRaises(ValueError):recovery.prepare_files({'recoveries':[row]})
            self.assertEqual(target.read_bytes(),b'preserve-existing')
if __name__=='__main__':unittest.main()
