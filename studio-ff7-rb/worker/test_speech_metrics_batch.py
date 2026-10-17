import unittest
from unittest.mock import patch
from speech_metrics_batch import ALGORITHM, cache_key, process


class Connection:
    def __init__(self): self.calls=[]
    def execute(self,query,params=None): self.calls.append((query,params))


class Persistence(unittest.TestCase):
    def row(self):
        return dict(audio_path='cn/test.mp3',file_version='123:456:789',language='cn',
                    source_text='你好，[停顿=500]朋友！',cache_key='key')

    def test_saved_fields_and_plain_units(self):
        conn=Connection()
        with patch('speech_metrics_batch.signature',return_value='123:456:789'), patch('speech_metrics_batch.analyze_file',return_value=dict(durationS=2,silenceS=.5,activeS=1.5,status='ok')):
            self.assertTrue(process(conn,self.row()))
        query,params=conn.calls[-1]
        self.assertIn("status='ready'",query)
        self.assertEqual(params[1:6],(2,.5,1.5,4,4/1.5))
        self.assertEqual(params[-3:],('key','123:456:789',ALGORITHM))

    def test_replaced_during_decode_not_saved(self):
        conn=Connection()
        with patch('speech_metrics_batch.signature',side_effect=['123:456:789','new']), patch('speech_metrics_batch.analyze_file',return_value=dict(durationS=2,silenceS=.5,activeS=1.5,status='ok')):
            self.assertFalse(process(conn,self.row()))
        self.assertEqual(conn.calls,[])

    def test_changed_before_decode_requeued(self):
        conn=Connection()
        with patch('speech_metrics_batch.signature',return_value='new'),patch('speech_metrics_batch.analyze_file') as decode:
            self.assertFalse(process(conn,self.row()))
            decode.assert_not_called()
        self.assertIn('file_version=%s',conn.calls[0][0])

    def test_missing_file_is_recorded_not_zero(self):
        conn=Connection()
        row={**self.row(),'file_version':'missing'}
        with patch('speech_metrics_batch.signature',return_value='missing'),patch('speech_metrics_batch.analyze_file',side_effect=FileNotFoundError()):
            self.assertFalse(process(conn,row))
        self.assertIn("status='error'",conn.calls[0][0])
        self.assertEqual(conn.calls[0][1][0],'音频文件不存在')

    def test_cache_key_tracks_text_and_language(self):
        self.assertNotEqual(cache_key('x','cn','甲'),cache_key('x','cn','乙'))
        self.assertNotEqual(cache_key('x','cn','甲'),cache_key('x','jp','甲'))
        self.assertEqual(cache_key('x','cn','甲'),cache_key('x','cn','甲'))

if __name__=='__main__': unittest.main()
