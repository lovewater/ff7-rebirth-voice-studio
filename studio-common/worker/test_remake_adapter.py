"""Verified Remake extraction stays isolated; unverified packaging fails closed."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


class RemakeAdapter(unittest.TestCase):
    def adapter(self):
        path = Path(__file__).resolve().parents[2] / "studio-ff7-remake/worker/adapter.py"
        spec = importlib.util.spec_from_file_location("remake_adapter_under_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def fixture(self, root, game_id="remake"):
        project = Path(root)
        data = project / "website/data"
        data.mkdir(parents=True)
        (data / ".ff7-game.json").write_text(json.dumps({
            "game_id": game_id, "database": "studio_ff7_remake",
        }))
        (project / "work/indexes").mkdir(parents=True)
        (project / "work/indexes/voice-assets.jsonl").write_text("")
        (project / "work/raw-voice").mkdir()
        return project

    def status(self, module):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(module.main(["status"]), 0)
        return json.loads(out.getvalue())

    def test_verified_read_only_extraction_does_not_enable_packaging(self):
        module = self.adapter()
        with tempfile.TemporaryDirectory() as root, mock.patch.object(module, "PROJECT", Path(root)):
            result = self.status(module)
        self.assertEqual(result["game_id"], "remake")
        self.assertEqual(result["resource_adapter"], "legacy-pak-v4-read-only")
        self.assertTrue(result["extract_enabled"])
        self.assertFalse(result["pack_enabled"])
        self.assertFalse(result["full_extraction_complete"])

    def test_complete_status_requires_full_target_and_no_failures(self):
        module = self.adapter()
        with tempfile.TemporaryDirectory() as root:
            project = self.fixture(root)
            for total, complete, errors, expected in [
                (64, True, 0, False), (55351, False, 0, False),
                (55351, True, 1, False), (55351, True, 0, True),
            ]:
                with self.subTest(total=total, complete=complete, errors=errors):
                    (project / "work/extraction-progress.json").write_text(json.dumps({
                        "total_assets": total, "complete": complete, "error_assets": errors,
                    }))
                    with mock.patch.object(module, "PROJECT", project):
                        self.assertEqual(self.status(module)["full_extraction_complete"], expected)

    def test_extraction_dispatches_only_remake_worker_and_caps_parallelism(self):
        module = self.adapter()
        with tempfile.TemporaryDirectory() as root:
            project = self.fixture(root)
            with mock.patch.object(module, "PROJECT", project), mock.patch.object(module.subprocess, "call", return_value=7) as call:
                self.assertEqual(module.main(["extract", "--workers", "99"]), 7)
            call.assert_called_once_with([
                sys.executable, str(project / "worker/extract_voice.py"), "--workers", "4",
            ])

    def test_extraction_rejects_wrong_game_identity_before_dispatch(self):
        module = self.adapter()
        with tempfile.TemporaryDirectory() as root:
            project = self.fixture(root, game_id="rebirth")
            with mock.patch.object(module, "PROJECT", project), mock.patch.object(module.subprocess, "call") as call, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as stopped:
                    module.main(["extract"])
            self.assertEqual(stopped.exception.code, 2)
            call.assert_not_called()

    def test_extraction_rejects_missing_source_cache_before_dispatch(self):
        module = self.adapter()
        with tempfile.TemporaryDirectory() as root:
            project = self.fixture(root)
            (project / "work/indexes/voice-assets.jsonl").unlink()
            with mock.patch.object(module, "PROJECT", project), mock.patch.object(module.subprocess, "call") as call, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as stopped:
                    module.main(["extract"])
            self.assertEqual(stopped.exception.code, 2)
            call.assert_not_called()

    def test_packing_remains_disabled_before_any_worker_dispatch(self):
        module = self.adapter()
        with mock.patch.object(module.subprocess, "call") as call, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                module.main(["pack"])
        self.assertEqual(stopped.exception.code, 2)
        call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
