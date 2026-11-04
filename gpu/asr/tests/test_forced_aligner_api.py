"""CPU-only API contract, failure isolation and shared GPU lock checks."""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock, patch
import sys
import threading
import time

from fastapi.testclient import TestClient


ASR_ROOT = Path(__file__).parents[1]


class ForcedAlignerApiTest(TestCase):
    def setUp(self):
        self.model = Mock()
        self.model.transcribe.return_value = [SimpleNamespace(text="待って", language="Japanese")]
        self.aligner = Mock()
        self.aligner.align.return_value = [[
            SimpleNamespace(text="待っ", start_time=.16, end_time=.40),
            SimpleNamespace(text="て", start_time=.40, end_time=.40),
        ]]
        self.qwen = ModuleType("qwen_asr")
        self.qwen.Qwen3ASRModel = SimpleNamespace(from_pretrained=Mock(return_value=self.model))
        self.qwen.Qwen3ForcedAligner = SimpleNamespace(from_pretrained=Mock(return_value=self.aligner))
        runtime = SimpleNamespace(device="cuda:0", capability=(7, 5), device_name="2080 Ti",
                                  is_turing=True, dtype_name="float16", torch_dtype="fp16",
                                  attn_implementation="sdpa")
        gpu = ModuleType("base.gpu_compat")
        gpu.resolve_gpu_runtime_profile = Mock(return_value=runtime)
        reporter = ModuleType("base.reporter")
        reporter.Reporter = Mock(return_value=SimpleNamespace(reportProgress=Mock()))
        logger = ModuleType("base.server_log")
        logger.log = Mock()
        logger.format_log = lambda prefix, message: message
        uvicorn = ModuleType("uvicorn")
        uvicorn.run = Mock()
        self.modules = patch.dict(sys.modules, {
            "qwen_asr": self.qwen, "uvicorn": uvicorn, "base.gpu_compat": gpu,
            "base.reporter": reporter, "base.server_log": logger,
        })
        self.modules.start()
        self.addCleanup(self.modules.stop)
        sys.path.insert(0, str(ASR_ROOT))
        self.addCleanup(lambda: sys.path.remove(str(ASR_ROOT)))
        spec = importlib.util.spec_from_file_location("asr_aligner_api_under_test", ASR_ROOT / "main_asr.py")
        self.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)
        self.api._config = {}
        self.api._file_utils = object()
        self.api._asr_model = self.model
        self.api._runtime_profile = runtime
        self.api._log_prefix = "test"
        self.api._prepare_audio_input = Mock(return_value="/tmp/test-source.wav")
        self.client = TestClient(self.api.app)
        self.addCleanup(self.client.close)

    def request(self, **fields):
        response = self.client.post("/asr", json={"sample_audio": "fake-audio", **fields})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_default_response_is_legacy_shape_and_does_not_load_aligner(self):
        result = self.request()
        self.assertEqual(set(result), {"success", "message", "calc_time", "file_path", "results"})
        self.assertEqual(result["results"], [{"text": "待って", "language": "Japanese"}])
        self.assertIsNone(self.api._forced_aligner)
        self.qwen.Qwen3ForcedAligner.from_pretrained.assert_not_called()
        self.model.transcribe.assert_called_once_with(audio="/tmp/test-source.wav", language=None,
                                                     return_time_stamps=False)

    def test_explicit_false_keeps_null_language_and_has_no_alignment_field(self):
        self.model.transcribe.return_value = [SimpleNamespace(text="", language=None)]
        result = self.request(use_forced_aligner=False)
        self.assertEqual(result["results"], [{"text": "", "language": None}])
        self.qwen.Qwen3ForcedAligner.from_pretrained.assert_not_called()

    def test_true_serializes_exact_seconds_and_preserves_zero_width(self):
        result = self.request(use_forced_aligner=True, language="Chinese")
        self.assertTrue(result["success"])
        row = result["results"][0]
        self.assertEqual(row["text"], "待って")
        alignment = row["alignment"]
        self.assertEqual(alignment["status"], "ok")
        self.assertEqual(alignment["model"], "Qwen/Qwen3-ForcedAligner-0.6B")
        self.assertEqual(alignment["time_unit"], "seconds")
        self.assertEqual(alignment["items"], [
            {"text": "待っ", "start_time": .16, "end_time": .4},
            {"text": "て", "start_time": .4, "end_time": .4},
        ])
        self.assertNotIn("error", alignment)
        # Model-detected language wins over a caller's hint.
        self.aligner.align.assert_called_once_with(audio="/tmp/test-source.wav", text="待って",
                                                   language="Japanese")
        kwargs = self.qwen.Qwen3ForcedAligner.from_pretrained.call_args.kwargs
        self.assertEqual(kwargs, {"dtype": "fp16", "device_map": "cuda:0", "attn_implementation": "sdpa"})

    def test_false_after_true_does_not_run_aligner_and_true_reuses_loaded_model(self):
        self.request(use_forced_aligner=True)
        self.request(use_forced_aligner=True)
        result = self.request(use_forced_aligner=False)
        self.qwen.Qwen3ForcedAligner.from_pretrained.assert_called_once()
        self.assertEqual(self.aligner.align.call_count, 2)
        self.assertNotIn("alignment", result["results"][0])

    def test_empty_asr_does_not_load_or_call_aligner(self):
        self.model.transcribe.return_value = [SimpleNamespace(text=" \n", language=None)]
        row = self.request(use_forced_aligner=True)["results"][0]
        self.assertEqual(row["text"], " \n")
        self.assertEqual(row["alignment"]["status"], "empty")
        self.assertEqual(row["alignment"]["items"], [])
        self.qwen.Qwen3ForcedAligner.from_pretrained.assert_not_called()

    def test_unsupported_auto_language_keeps_transcript_without_loading_model(self):
        self.model.transcribe.return_value = [SimpleNamespace(text="مرحبا", language="Arabic")]
        result = self.request(use_forced_aligner=True)
        self.assertTrue(result["success"])
        self.assertEqual(result["results"][0]["text"], "مرحبا")
        self.assertEqual(result["results"][0]["alignment"]["status"], "unsupported_language")
        self.qwen.Qwen3ForcedAligner.from_pretrained.assert_not_called()

    def test_missing_detected_language_uses_explicit_language_alias(self):
        self.model.transcribe.return_value = [SimpleNamespace(text="待って", language=None)]
        result = self.request(use_forced_aligner=True, language="ja-JP")
        self.assertEqual(result["results"][0]["alignment"]["status"], "ok")
        self.assertEqual(self.aligner.align.call_args.kwargs["language"], "Japanese")

    def test_missing_detected_and_requested_language_reports_unsupported(self):
        self.model.transcribe.return_value = [SimpleNamespace(text="待って", language=None)]
        row = self.request(use_forced_aligner=True)["results"][0]
        self.assertEqual(row["alignment"]["status"], "unsupported_language")
        self.qwen.Qwen3ForcedAligner.from_pretrained.assert_not_called()

    def test_all_eleven_official_languages_and_common_codes(self):
        pairs = [("Chinese", "zh-CN"), ("English", "en-US"), ("Cantonese", "yue"),
                 ("French", "fr"), ("German", "de"), ("Italian", "it"),
                 ("Japanese", "ja"), ("Korean", "ko"), ("Portuguese", "pt-BR"),
                 ("Russian", "ru"), ("Spanish", "es")]
        for expected, alias in pairs:
            with self.subTest(alias=alias):
                self.model.transcribe.return_value = [SimpleNamespace(text="test", language=alias)]
                row = self.request(use_forced_aligner=True)["results"][0]
                self.assertEqual(row["alignment"]["status"], "ok")
                self.assertEqual(self.aligner.align.call_args.kwargs["language"], expected)

    def test_lazy_load_failure_keeps_asr_and_can_retry_then_false_still_works(self):
        loader = self.qwen.Qwen3ForcedAligner.from_pretrained
        loader.side_effect = [RuntimeError("model missing"), self.aligner]
        first = self.request(use_forced_aligner=True)
        self.assertTrue(first["success"])
        self.assertEqual(first["results"][0]["text"], "待って")
        self.assertEqual(first["results"][0]["alignment"]["status"], "error")
        self.assertEqual(first["results"][0]["alignment"]["error"], "model missing")
        self.assertIsNone(self.api._forced_aligner)
        second = self.request(use_forced_aligner=True)
        self.assertEqual(second["results"][0]["alignment"]["status"], "ok")
        self.assertEqual(loader.call_count, 2)
        self.assertNotIn("alignment", self.request()["results"][0])

    def test_inference_failure_and_empty_alignment_keep_asr_and_report_error(self):
        for failure in [RuntimeError("out of memory"), []]:
            with self.subTest(failure=failure):
                self.aligner.align.side_effect = failure if isinstance(failure, Exception) else None
                self.aligner.align.return_value = failure
                result = self.request(use_forced_aligner=True)
                self.assertTrue(result["success"])
                self.assertEqual(result["results"][0]["text"], "待って")
                self.assertEqual(result["results"][0]["alignment"]["status"], "error")

    def test_nonempty_transcript_without_items_is_not_reported_ok(self):
        self.aligner.align.return_value = [[]]
        row = self.request(use_forced_aligner=True)["results"][0]
        self.assertEqual(row["alignment"]["status"], "error")

    def test_asr_failure_has_legacy_failure_shape_and_does_not_load_aligner(self):
        self.model.transcribe.side_effect = RuntimeError("ASR failed")
        result = self.request(use_forced_aligner=True)
        self.assertEqual(result, {"success": False, "message": "ASR failed", "calc_time": 0.0,
                                  "file_path": None, "results": []})
        self.qwen.Qwen3ForcedAligner.from_pretrained.assert_not_called()

    def test_loading_asr_caps_batch_and_does_not_enable_builtin_aligner(self):
        self.api._asr_model = None
        self.request()
        kwargs = self.qwen.Qwen3ASRModel.from_pretrained.call_args.kwargs
        self.assertEqual(kwargs["max_inference_batch_size"], 1)
        self.assertIsNone(kwargs["forced_aligner"])
        self.assertIsNone(kwargs["forced_aligner_kwargs"])

    def test_concurrent_true_false_requests_never_overlap_gpu_work_or_loading(self):
        counter_lock = threading.Lock()
        state = {"active": 0, "peak": 0}
        def gpu_work(value):
            with counter_lock:
                state["active"] += 1
                state["peak"] = max(state["peak"], state["active"])
            time.sleep(.01)
            with counter_lock:
                state["active"] -= 1
            return value
        self.model.transcribe.side_effect = lambda **kw: gpu_work([SimpleNamespace(text="待って", language="Japanese")])
        self.qwen.Qwen3ForcedAligner.from_pretrained.side_effect = lambda *a, **kw: gpu_work(self.aligner)
        self.aligner.align.side_effect = lambda **kw: gpu_work([[SimpleNamespace(text="待って", start_time=.1, end_time=.5)]])
        def request(i):
            return self.api.asr_endpoint(self.api.AsrRequest(sample_audio="fake", use_forced_aligner=i % 2 == 0))
        with ThreadPoolExecutor(max_workers=8) as pool:
            result = list(pool.map(request, range(12)))
        self.assertTrue(all(r.success for r in result))
        self.assertEqual(state["peak"], 1)
        self.qwen.Qwen3ForcedAligner.from_pretrained.assert_called_once()
        self.assertEqual(self.aligner.align.call_count, 6)


if __name__ == "__main__":
    main()
