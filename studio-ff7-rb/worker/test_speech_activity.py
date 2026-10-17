import tempfile
import unittest
from pathlib import Path
from speech_activity import measure, safe_path


class SpeechActivity(unittest.TestCase):
    def test_exact_200ms_and_short_pause(self):
        result = measure([100] * 100 + [0] * 199 + [100] * 100 + [0] * 200 + [100] * 100, 1000)
        self.assertAlmostEqual(result['activeS'], .499)
        self.assertAlmostEqual(result['silenceS'], .2)
        self.assertEqual(result['silences'], [{'startS': .399, 'endS': .599}])

    def test_relative_peak_and_strict_threshold(self):
        for scale in (1, 20):
            result = measure([100*scale] * 100 + [14*scale] * 200 + [15*scale] * 200, 1000)
            self.assertAlmostEqual(result['activeS'], .3)
            self.assertAlmostEqual(result['silenceS'], .2)

    def test_leading_and_trailing_and_whole_run(self):
        result = measure([0] * 250 + [100] * 300 + [0] * 400, 1000)
        self.assertAlmostEqual(result['activeS'], .3)
        self.assertEqual(result['silenceCount'], 2)
        self.assertAlmostEqual(result['durationS'], result['silenceS'] + result['activeS'])

    def test_stereo_no_phase_cancellation(self):
        self.assertAlmostEqual(measure([100, -100] * 300, 1000, 2)['activeS'], .3)
        self.assertAlmostEqual(measure([0, 100] * 300, 1000, 2)['activeS'], .3)

    def test_silent_empty_and_invalid_layout(self):
        self.assertEqual(measure([0] * 10, 1000)['activeS'], 0)
        self.assertEqual(measure([0] * 1000, 1000)['status'], 'silent')
        for samples, rate, channels in (([], 1000, 1), ([1], 0, 1), ([1], 1000, 2)):
            with self.assertRaises(ValueError):
                measure(samples, rate, channels)

    def test_path_boundary_and_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'jp').mkdir()
            (root/'jp'/'escape.wav').symlink_to('/tmp/outside.wav')
            self.assertEqual(safe_path(root, 'jp/line.mp3'), root/'jp'/'line.mp3')
            for path in ('/etc/passwd', '../jp/test.wav', 'jp/../../test.wav', 'jp/escape.wav', 'jp/x.txt'):
                with self.assertRaises(ValueError):
                    safe_path(root, path)


if __name__ == '__main__':
    unittest.main()
