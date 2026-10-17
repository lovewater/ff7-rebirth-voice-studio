"""Reference boundary and failure tests; no model/GPU required."""
import base64
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

os.environ["GPU_LOCK_PATH"] = "/tmp/ff7-vc-test.lock"
import numpy as np
import soundfile as sf
from fastapi import HTTPException
import api


def audio(seconds):
    stream = io.BytesIO()
    sf.write(
        stream,
        np.sin(np.arange(round(seconds * 16000)) * 0.1) * 0.1,
        16000,
        format="WAV",
        subtype="PCM_16",
    )
    return base64.b64encode(stream.getvalue()).decode()


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        api.BUNDLE["args"] = object()
        api.BUNDLE["models"] = object()

    def request(self, duration, mode="auto", lang="cn", original_lang="jp"):
        return api.ConvertRequest(
            source_wav_b64=audio(2),
            jp_audio_b64=audio(duration),
            embedding_reference_b64=audio(3),
            embedding_reference_lang=lang,
            original_lang=original_lang,
            reference_mode=mode,
        )

    def fake_job(self, root, _args, _models):
        (root / "repaired.wav").write_bytes((root / "source.wav").read_bytes())
        (root / "result.json").write_text(json.dumps({"model": "test"}))

    def convert(self, req):
        with patch.object(api.seed_convert, "convert_job", self.fake_job):
            return api.convert(req)

    def test_reference_boundary(self):
        for seconds, expected in [(1.499, "embedding_source"), (1.5, "line_original"), (1.501, "line_original")]:
            with self.subTest(seconds=seconds):
                result = self.convert(self.request(seconds))["conversion_meta"]
                self.assertEqual(result["reference_kind"], expected)
                self.assertEqual(result["reference_lang"], "cn" if expected == "embedding_source" else "jp")
                self.assertEqual(result["reference_mode"], "auto")

    def test_original_mode_ignores_short_original(self):
        result = self.convert(self.request(0.4, mode="original"))["conversion_meta"]
        self.assertEqual(result["reference_kind"], "line_original")
        self.assertEqual(result["reference_lang"], "jp")

    def test_native_mode_ignores_long_original(self):
        result = self.convert(self.request(3, mode="native"))["conversion_meta"]
        self.assertEqual(result["reference_kind"], "embedding_source")
        self.assertEqual(result["reference_lang"], "cn")

    def test_english_original_lang(self):
        result = self.convert(self.request(2, mode="original", lang="cn", original_lang="en"))["conversion_meta"]
        self.assertEqual(result["reference_kind"], "line_original")
        self.assertEqual(result["reference_lang"], "en")

    def test_invalid_pause_does_not_run(self):
        req = self.request(2)
        req.silences = [(100, 40000)]
        with patch.object(api.seed_convert, "convert_job") as run, self.assertRaises(HTTPException):
            api.convert(req)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
