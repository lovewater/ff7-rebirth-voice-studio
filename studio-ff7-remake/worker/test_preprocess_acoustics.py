import array
import hashlib
import math
from pathlib import Path
import tempfile
import unittest
import wave
from preprocess_acoustics import measure, analyze

class AcousticEvidenceTests(unittest.TestCase):
    def test_tiny_signal_is_not_exact_zero(self):
        self.assertFalse(measure([1e-25, 0, 0], 16000, 1)['exact_zero'])

    def test_opposite_stereo_channels_do_not_cancel(self):
        result = measure([.5, -.5] * 100, 16000, 2)
        self.assertFalse(result['exact_zero'])
        self.assertGreater(result['active_s'], 0)

    def test_zero_requires_real_nonempty_decoded_samples(self):
        self.assertTrue(measure([0.] * 16000, 16000, 1)['exact_zero'])
        for samples in [[], [float('nan')], [float('inf')]]:
            with self.assertRaises(ValueError):
                measure(samples, 16000, 1)

    def test_real_ffmpeg_source_file_is_complete_and_sha_bound(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'zero.wav'
            with wave.open(str(file), 'wb') as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(bytes(16000 * 4))
            result = analyze(file)
            self.assertEqual(result['frames'], 16000)
            self.assertEqual(result['channels'], 2)
            self.assertTrue(result['exact_zero'])
            self.assertEqual(result['source_sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
            self.assertFalse(result['linguistic_classification'])

if __name__ == '__main__':
    unittest.main()
