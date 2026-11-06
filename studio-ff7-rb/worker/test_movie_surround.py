import array
import struct
import unittest
from movie_surround import POLICY,VOICE_CHANNELS,event_cues,window_profile,replace_windows


def bank(count=12):
    values=[]
    for n in range(count):
        c=10*(n+1);values.extend([c//2,c*2,c,0,c//2,c])
    return array.array('h',values)


def piece(stem='cn',start=.2,end=.4,stop=.5,mono=(101,203)):
    return dict(stem=stem,start=start,end=end,mono=array.array('h',mono),
                surround=dict(policy=POLICY,channels=list(VOICE_CHANNELS),clear_end_s=stop))


class MovieSurround(unittest.TestCase):
    def test_removes_japanese_from_all_voice_channels_and_preserves_other_pcm(self):
        source=bank();out=array.array('h',source)
        proof=replace_windows(out,6,10,[piece(),dict(stem='jp',start=.5,end=.8,keep_japanese=True)])
        self.assertEqual(out[:12],source[:12]);self.assertEqual(out[5*6:],source[5*6:])
        self.assertEqual(out[3::6],source[3::6])
        self.assertEqual(out[2*6+2:4*6+2:6],array.array('h',[101,203]))
        for ch in VOICE_CHANNELS:
            self.assertEqual(out[4*6+ch],0)
            self.assertNotEqual(out[2*6+ch],source[2*6+ch])
        self.assertEqual(proof[0]['clear_end'],.5)
        self.assertEqual(out[2*6+1],202)

    def test_all_japanese_choices_are_exact_noop(self):
        source=bank();out=array.array('h',source)
        self.assertEqual(replace_windows(out,6,10,[dict(stem='jp',start=0,end=1,keep_japanese=True)]),[])
        self.assertEqual(out,source)

    def test_failure_is_atomic_even_after_an_earlier_valid_piece(self):
        for bad in [piece(start=.6,end=.8,stop=.7),piece(start=.6,end=.8,stop=.9,mono=[3]*10)]:
            source=bank();out=array.array('h',source)
            with self.assertRaises(RuntimeError):replace_windows(out,6,10,[piece(),bad])
            self.assertEqual(out,source)

    def test_refuses_unproven_layout_profile_lfe_and_silent_center(self):
        variants=[(bank(),2,piece()),(bank(),6,{**piece(),'surround':None})]
        noisy=bank();noisy[2*6+3]=2;variants.append((noisy,6,piece()))
        zero=bank();zero[2*6+2]=zero[3*6+2]=0;variants.append((zero,6,piece()))
        for data,channels,p in variants:
            original=array.array('h',data)
            with self.assertRaises(RuntimeError):replace_windows(data,channels,10,[p])
            self.assertEqual(data,original)

    def test_silent_overrun_can_be_discarded_but_voiced_overrun_cannot(self):
        out=bank();replace_windows(out,6,10,[piece(mono=[1,2,3,0,0,0])])
        with self.assertRaises(RuntimeError):replace_windows(bank(),6,10,[piece(mono=[1,2,3,0,0,4])])

    def test_side_gain_clipping_guard_does_not_modify_selected_center(self):
        out=bank();proof=replace_windows(out,6,10,[piece(mono=[30000,30000])])
        self.assertEqual(out[2*6+2],30000);self.assertLessEqual(out[2*6+1],32760)
        self.assertLess(proof[0]['gains'][1],2)

    def test_event_time_array_and_original_identity(self):
        stems=['C3510_MAIN_5400_0100_00_cid','C3510_MAIN_5400_0100_05_cat']
        blob=struct.pack('<IiiI',2,0,24000,2)+b''.join(s.encode()+b'\0'for s in stems)
        self.assertEqual(event_cues(blob),[(stems[0],0),(stems[1],24000)])
        with self.assertRaises(RuntimeError):event_cues(b'no event keys')
        extra=dict(tick_resolution=24000,frame_rate=30,bank_start_frame=0,source_voice_tick=0,
                   slice_start_s=0,slice_end_s=.8,source_audio_sha256='source')
        p=window_profile(extra,stems[0],event_cues(blob),'event-sha')
        self.assertEqual(p['clear_end_s'],1)
        with self.assertRaises(RuntimeError):window_profile(extra,stems[0],[(stems[0],1)],'event-sha')
        with self.assertRaises(RuntimeError):window_profile(extra,stems[0],[(stems[0],0),('other',0)],'event-sha')

    def test_overlap_requires_exact_source_and_interval_bound_choice(self):
        stem='C3510_MAIN_5400_0800_00_cid'
        extra=dict(tick_resolution=24000,frame_rate=30,bank_start_frame=0,source_voice_tick=0,
                   slice_start_s=0,slice_end_s=3,source_audio_sha256='source')
        cues=[(stem,0),('C3510_MAIN_5400_0800_05_cat',48000)]
        with self.assertRaises(RuntimeError):window_profile(extra,stem,cues,'event')
        approval=dict(stem=stem,source_wav_sha256='source',slice_start_s=0,slice_end_s=3,action='replace-dialogue-window')
        p=window_profile(extra,stem,cues,'event',approval)
        self.assertEqual(p['clear_end_s'],3);self.assertEqual(p['overlap_approval'],approval)
        wrong={**approval,'source_wav_sha256':'changed'}
        with self.assertRaises(RuntimeError):window_profile(extra,stem,cues,'event',wrong)


if __name__=='__main__':unittest.main()
