import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import rewrite_scene_batch as batch


def beat(ratio=1.0, chars=12, status="ok"):
    return {"normalizedRatio": ratio, "ratio": None, "version": "test",
            "jp": {"characters": chars, "status": status}, "cn": {"units": 10}}


def job(id_=1, state="pending"):
    return {"id": id_, "stem": f"line_{id_}", "text_jp": "長い日本語の台詞です", "text_zh": "原文",
            "state": state, "beats": beat(1.5), "selection": {"text": "新字幕", "ttsText": "新字幕"},
            "old_ids": ["10"]}


class FakeDB:
    reviewed = False

    def current(self, stem):
        row = job()
        row.update(stem=stem, kind="对话", subtitle_italic=False, skip_timing=self.reviewed,
                   dialogue_mode="scene", locked=False)
        return row, [{"id": "10", "status": "ready", "heard_at": None, "review_state": "candidate"}]


class FakeApi:
    calls = []

    @staticmethod
    def path(stem, suffix):
        return f"/{stem}/{suffix}"


class BatchTests(unittest.TestCase):
    def test_strict_screening_boundaries_and_body_length(self):
        for ratio in (0.7, 0.8, 1.0, 1.3, None):
            self.assertFalse(batch.eligible(beat(ratio)))
        for ratio in (0.6999, 1.3001):
            self.assertTrue(batch.eligible(beat(ratio, 8)))
            self.assertFalse(batch.eligible(beat(ratio, 7)))

    def test_acceptance_is_normalized_and_inclusive(self):
        for ratio in (0.9, 0.95, 1.0, 1.1):
            self.assertTrue(batch.acceptable(beat(ratio)))
        self.assertFalse(batch.acceptable(beat(0.899)))
        self.assertFalse(batch.acceptable(beat(1.101)))
        self.assertFalse(batch.acceptable(beat(1.0, status="review_reading")))

    def test_user_review_or_changed_source_invalidates_work(self):
        line, _ = FakeDB().current("line_1")
        self.assertTrue(batch.still_eligible(line, job()))
        for key, value in (("locked", True), ("skip_timing", True), ("text_zh", "用户改了"),
                           ("dialogue_mode", "field"), ("subtitle_italic", True)):
            self.assertFalse(batch.still_eligible({**line, key: value}, job()))

    def test_reviewed_line_never_calls_model(self):
        db = FakeDB()
        db.reviewed = True
        result = batch.rewrite(db, FakeApi(), job(), {"low": .7, "high": 1.3, "min_chars": 7})
        self.assertEqual(result["state"], "skipped")

    def test_missing_new_audio_never_deletes_old_candidate(self):
        entry = job(state="generated")
        entry["new_ids"] = ["99"]
        with self.assertRaisesRegex(RuntimeError, "缺失"):
            batch.finish(FakeDB(), FakeApi(), entry)

    def test_ambiguous_tts_is_not_resubmitted_on_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = batch.Journal(Path(folder) / "run.sqlite3")
            self.addCleanup(journal.conn.close)
            journal.save(job(state="tts_submitted"))
            with patch.object(batch, "generate") as generate, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(batch.run(FakeDB(), FakeApi(), journal, 2, 1, {"low": .7, "high": 1.3, "min_chars": 7}), 2)
                generate.assert_not_called()
            self.assertEqual(journal.jobs()[0]["state"], "uncertain")

    def test_generated_resume_finishes_without_new_tts(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = batch.Journal(Path(folder) / "run.sqlite3")
            self.addCleanup(journal.conn.close)
            entry = job(state="generated")
            entry["new_ids"] = ["99"]
            journal.save(entry)
            with patch.object(batch, "generate") as generate, patch.object(batch, "finish", return_value={"state": "done"}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(batch.run(FakeDB(), FakeApi(), journal, 2, 1, {"low": .7, "high": 1.3, "min_chars": 7}), 0)
                generate.assert_not_called()

    def test_pipeline_reports_each_100_actual_completions(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = batch.Journal(Path(folder) / "run.sqlite3")
            self.addCleanup(journal.conn.close)
            for i in range(1, 104):
                journal.save(job(i))
            def rewrite(db, api, entry, bounds):
                if entry["id"] <= 2:
                    return {"state": "skipped"}
                return {"state": "selected"}
            out = io.StringIO()
            with patch.object(batch, "rewrite", side_effect=rewrite), patch.object(batch, "generate", return_value={"ids": ["99"]}), patch.object(batch, "finish", return_value={"state": "done"}), contextlib.redirect_stdout(out):
                self.assertEqual(batch.run(FakeDB(), FakeApi(), journal, 2, 1, {"low": .7, "high": 1.3, "min_chars": 7}), 0)
            self.assertIn('"label": "completed_100"', out.getvalue())
            with contextlib.redirect_stdout(io.StringIO()):
                summary = journal.report("test")
            self.assertEqual(summary["completed"], 101)
            self.assertEqual(summary["skipped_after_plan"], 2)
            self.assertEqual(summary["remaining"], 0)

    def test_repeated_infrastructure_errors_stop_spending(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = batch.Journal(Path(folder) / "run.sqlite3")
            self.addCleanup(journal.conn.close)
            for i in range(20):
                journal.save(job(i))
            with patch.object(batch, "rewrite", side_effect=RuntimeError("service unavailable")) as rewrite, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(batch.run(FakeDB(), FakeApi(), journal, 2, 1, {"low": .7, "high": 1.3, "min_chars": 7}), 2)
            self.assertLessEqual(rewrite.call_count, 4)
            self.assertTrue(any(j["state"] == "pending" for j in journal.jobs()))


if __name__ == "__main__":
    unittest.main()
