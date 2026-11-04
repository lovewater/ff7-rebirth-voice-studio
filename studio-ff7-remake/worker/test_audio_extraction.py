"""Real read-only fixtures: independently decode outputs and check full material coverage."""
import unittest,json,hashlib,subprocess
from pathlib import Path
from pak_v4 import PakV4,ROOT
P=ROOT/'studio-ff7-remake';DATA=P/'website/data'
class ExtractedAudioTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.rows=[json.loads(p.read_text()) for p in (P/'work/audio-manifests').glob('*.json')]
  if not cls.rows:raise unittest.SkipTest('Requires local game/audio manifests excluded from Git')
 def test_bank_keeps_real_indices_and_proves_empty_slots(self):
  r=next(r for r in self.rows if r.get('source_stem')=='VO_EB0003_00_Reno_Standard' and r.get('language')=='jp')
  self.assertEqual(r['status'],'ready');self.assertEqual(r['material_count'],156);self.assertEqual(len(r['clips']),139)
  absent={x['index'] for x in r['empty_materials']};present={x['clip_index'] for x in r['clips']}
  self.assertEqual(absent|present,set(range(156)));self.assertFalse(absent&present)
  self.assertTrue(all(x['codec']=='Dummy' and x['stream_size']==0 and x['channels']==0 for x in r['empty_materials']))
 def test_multichannel_lossless_contains_every_source_pcm_sample(self):
  clips=[x for r in self.rows if r['status']=='ready' for x in r['clips'] if x['channels']>2]
  self.assertGreaterEqual(len(clips),4)
  for c in clips[:4]:
   self.assertFalse(c['eligible_for_generation']);self.assertEqual(c['preview_channels'],2)
   data=subprocess.check_output(['ffmpeg','-v','error','-i',str(DATA/c['lossless_path']),'-f','s16le','-'])
   self.assertEqual(hashlib.sha256(data).hexdigest(),c['pcm_sha256']);self.assertEqual(len(data),c['pcm_frames']*c['channels']*2)
 def test_same_basename_areas_do_not_share_preview_path(self):
  seen={}
  for r in self.rows:
   for c in r.get('clips',[]):
    key=c['audio_path'];owner=(r['path'],c['clip_index'])
    if key in seen:self.assertEqual(seen[key],owner)
    seen[key]=owner
 def test_independent_native_repak_agrees_with_checked_python_reader(self):
  pak=ROOT/'game/FINAL FANTASY VII REMAKE/End/Content/Paks/pakchunk0_s23-WindowsNoEditor.pak';reader=PakV4(pak)
  name='End/Content/GameContents/Sound/Voice/JP/Cut/000-COMON/EV_COMON_0100/ev_comon_0100_0000_chd_0.uexp'
  key=(P/'.private/pak-aes.txt').read_text().strip();native=P/'work/tools/repak-ff7r/target/release/repak'
  self.assertEqual(reader.read(name),subprocess.check_output([str(native),'--aes-key',key,'get',str(pak),name]))
 def test_build_package_is_recorded_as_reference_not_fake_audio(self):
  r=next(r for r in self.rows if r.get('source_type')=='EndAssetPack');self.assertEqual(r['status'],'reference-only');self.assertEqual(r['clips'],[])
if __name__=='__main__':unittest.main()
