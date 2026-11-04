import contextlib
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("shared_backup", Path(__file__).with_name("backup-studio.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def test_game_namespaces_and_restore_paths_cannot_cross(self):
        self.assertNotEqual(backup.config("rebirth")["destination"], backup.config("remake")["destination"])
        self.assertNotEqual(backup.config("rebirth")["database"], backup.config("remake")["database"])
        for path in ["../tts/a.wav", "tts/../a.wav", "/tts/a.wav", "tts\\a.wav", "jp/a.mp3", "tts//a.wav"]:
            with self.assertRaises(ValueError):
                backup.safe_relative(path)
        self.assertEqual(str(backup.safe_relative("embedded/cloud/v1/speaker.pt")), "embedded/cloud/v1/speaker.pt")
        for name in ["studio;drop database studio", "name-hyphen", "x" * 64]:
            with self.assertRaises(ValueError):
                backup.identifier(name)

    def test_marker_rejects_wrong_game_and_shared_data_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp) / "data"
            (data / "tts").mkdir(parents=True)
            with self.assertRaises(ValueError):
                backup.verify_data_identity("remake", data)
            (data / ".ff7-game.json").write_text(json.dumps({"game_id": "rebirth", "database": "studio"}))
            with self.assertRaises(ValueError):
                backup.verify_data_identity("remake", data)
            link = Path(temp) / "other"
            link.symlink_to(data, target_is_directory=True)
            with self.assertRaises(ValueError):
                backup.verify_data_identity("rebirth", link)

    def test_same_filename_edits_keep_both_immutable_objects_and_no_extension_filter(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.pt"
            source.write_bytes(b"first bytes")
            first, new = backup.store_file(source, "embedded/cloud/v1/speaker.pt", root / "nas", "run")
            self.assertTrue(new)
            source.write_bytes(b"second bytes")
            second, new = backup.store_file(source, "embedded/cloud/v1/speaker.pt", root / "nas", "run2")
            self.assertTrue(new)
            self.assertNotEqual(first["sha256"], second["sha256"])
            self.assertEqual(backup.object_path(root / "nas", first["sha256"]).read_bytes(), b"first bytes")
            self.assertEqual(backup.object_path(root / "nas", second["sha256"]).read_bytes(), b"second bytes")

    def test_parallel_duplicate_payloads_do_not_share_temporary_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sources = []
            for n in range(10):
                source = root / f"{n}.json"
                source.write_bytes(b"identical payload")
                sources.append(source)
            with ThreadPoolExecutor(max_workers=5) as pool:
                rows = list(pool.map(lambda p: backup.store_file(p, "tts/test/" + p.name, root / "nas", "same-run"), sources))
            self.assertEqual(len({r[0]["sha256"] for r in rows}), 1)
            self.assertFalse(list((root / "nas").rglob("*.tmp")))

    def test_existing_objects_size_policy_is_explicit_and_optin_hash_catches_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "a.wav"
            source.write_bytes(b"AAAA")
            record, _ = backup.store_file(source, "tts/a.wav", root / "nas", "run")
            target = backup.object_path(root / "nas", record["sha256"])
            target.write_bytes(b"BBBB")
            _, new = backup.store_file(source, "tts/a.wav", root / "nas", "run2")
            self.assertFalse(new)
            with self.assertRaises(RuntimeError):
                backup.store_file(source, "tts/a.wav", root / "nas", "run3", True)

    def test_scratch_databases_are_unique_and_refuse_drop_on_wrong_marker(self):
        databases = {}
        drops = []
        def query(database, sql):
            if "count(*)" in sql:
                return "0"
            if sql.startswith("CREATE DATABASE"):
                name = sql.split('"')[1]
                databases[name] = {"owner": backup.ADMIN, "marker": None}
                return ""
            if sql.startswith("COMMENT ON DATABASE"):
                name = sql.split('"')[1]
                databases[name]["marker"] = sql.split(" IS '")[1][:-2]
                return ""
            if "shobj_description" in sql:
                return json.dumps(databases[sql.split("datname='")[1].split("'")[0]])
            if sql.startswith("DROP DATABASE"):
                name = sql.split('"')[1]
                drops.append(name)
                return ""
            self.fail("Unexpected SQL")
        with patch.object(backup, "query", query):
            with backup.ScratchDatabase("rebirth") as first:
                pass
            with backup.ScratchDatabase("remake") as second:
                pass
            self.assertNotEqual(first, second)
            self.assertEqual(drops, [first, second])
            with self.assertRaises(RuntimeError):
                with backup.ScratchDatabase("remake") as third:
                    databases[third]["marker"] = "somebody-else"
            self.assertNotIn(third, drops)
        self.assertFalse(set(drops) & backup.PROTECTED_DATABASES)

    def test_snapshot_runs_are_immutable_and_database_counts_are_from_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "ff7-sound"
            data = root / "studio-ff7-remake/website/data"
            (data / "tts/test").mkdir(parents=True)
            (data / ".ff7-game.json").write_text(json.dumps({"game_id": "remake", "database": "studio_ff7_remake"}))
            audio = data / "tts/test/1.wav"
            audio.write_bytes(b"first audio")
            building = data / "tts/test/building.wav"
            building.write_bytes(b"unfinished audio still gets archived")
            unfinished = [
                {"entity": "line_tts_versions", "version_id": "pending1", "status": "building", "field": "audio_path", "path": "tts/test/building.wav"},
                {"entity": "voice_bank_versions", "version_id": "pending2", "status": "error", "field": "embedding_path", "path": "embedded/cloud/missing.pt"},
            ]
            counts = {"lines": 1, "tts_rows": 1, "llm_access_logs": 0}
            calls = []
            def fake_run(args, **kwargs):
                calls.append(args)
                if "pg_dump" in args:
                    kwargs["stdout"].write(b"one consistent custom dump")
                elif "pg_restore" in args:
                    kwargs["stdout"].write(b"SQL derived from same custom dump")
                return subprocess.CompletedProcess(args, 0)
            @contextlib.contextmanager
            def scratch(game, purpose="check"):
                yield "ff7_check_remake_fixture"
            def get_counts(database):
                self.assertEqual(database, "ff7_check_remake_fixture")
                return counts
            with patch.object(backup, "ROOT", root), patch.object(backup, "NAS_ROOT", Path(temp) / "nas"), patch.object(backup, "require_nas"), patch.object(backup, "ScratchDatabase", scratch), patch.object(backup, "restore_custom"), patch.object(backup, "database_counts", get_counts), patch.object(backup, "required_paths", return_value=["tts/test/1.wav"]), patch.object(backup, "unfinished_references", return_value=unfinished), patch.object(backup.subprocess, "run", fake_run), contextlib.redirect_stdout(io.StringIO()):
                first = backup.backup("remake", 2, 30, False)
                first_data = (first / "FILES.json").read_bytes()
                audio.write_bytes(b"second audio")
                second = backup.backup("remake", 2, 30, False)
                self.assertNotEqual(first, second)
                self.assertEqual((first / "FILES.json").read_bytes(), first_data)
                a, files, dump = backup.verify_snapshot("remake", first)
                self.assertEqual(a["file_verify"]["existing_objects"], "size_only")
                self.assertEqual(a["excluded"]["unfinished_references"], unfinished)
                self.assertEqual(a["excluded"]["missing_unfinished_references"], [unfinished[1]])
                self.assertIn("tts/test/building.wav", [r["path"] for r in files["files"]])
                record = next(row for row in files["files"] if row["path"].endswith("1.wav"))
                self.assertEqual(backup.object_path(backup.config("remake")["destination"], record["sha256"]).read_bytes(), b"first audio")
                with self.assertRaises(ValueError):
                    backup.verify_snapshot("rebirth", first)
                latest_before_failure = (backup.config("remake")["destination"] / "LATEST.json").read_bytes()
                with patch.object(backup, "required_paths", return_value=["tts/test/missing-ready.wav"]):
                    with self.assertRaisesRegex(RuntimeError, "missing generated files"):
                        backup.backup("remake", 2, 30, False)
                self.assertEqual((backup.config("remake")["destination"] / "LATEST.json").read_bytes(), latest_before_failure)
                restored = root / "studio-ff7-remake/work/restore-first"
                backup.restore_check("remake", first, restored)
                self.assertEqual((restored / "tts/test/1.wav").read_bytes(), b"first audio")
                self.assertEqual((restored / "tts/test/building.wav").read_bytes(), b"unfinished audio still gets archived")
                self.assertEqual(json.loads((restored / ".ff7-game.json").read_text())["game_id"], "remake")
                with self.assertRaises(ValueError):
                    backup.restore_check("remake", first, root / "studio-ff7-rb/website/data")
                with self.assertRaises(ValueError):
                    backup.restore_check("remake", first, restored)
                # Even internally consistent hashes cannot relabel another game's data marker.
                marker = next(row for row in files["files"] if row["path"] == ".ff7-game.json")
                payload = json.dumps({"game_id": "rebirth", "database": "studio"}).encode()
                sha, _ = backup.put_bytes(backup.config("remake")["destination"], payload, "tamper-test")
                marker.update(sha256=sha, size=len(payload))
                backup.atomic_json(first / "FILES.json", files)
                a["files_sha256"] = backup.hash_file(first / "FILES.json")
                backup.atomic_json(first / "MANIFEST.json", a)
                with self.assertRaisesRegex(ValueError, "marker belongs to another game"):
                    backup.restore_check("remake", first)
            self.assertEqual(sum("pg_dump" in args for args in calls), 3, "Exactly one pg_dump per successful or failed run")

    def test_retention_only_prunes_completed_snapshots_in_selected_game_and_never_objects(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(backup, "NAS_ROOT", Path(temp)):
            rb = backup.config("rebirth")["destination"]
            rm = backup.config("remake")["destination"]
            for base, game, database in [(rb, "rebirth", "studio"), (rm, "remake", "studio_ff7_remake")]:
                p = base / "db/2020-01-01/run-old"
                p.mkdir(parents=True)
                (p / "MANIFEST.json").write_text(json.dumps({"status": "complete", "game": game, "database": database}))
                (base / "objects").mkdir()
                (base / "objects/preserve").write_text("audio")
            pending = rm / "db/2020-01-01/.in-progress-test"
            pending.mkdir()
            legacy = Path(temp) / "db/2020-01-01"
            legacy.mkdir(parents=True)
            removed = backup.prune_snapshots("remake", 30, date(2026, 1, 1))
            self.assertEqual(len(removed), 1)
            self.assertTrue((rb / "db/2020-01-01/run-old").exists())
            self.assertTrue((rm / "objects/preserve").exists())
            self.assertTrue(pending.exists())
            self.assertTrue(legacy.exists())


if __name__ == "__main__":
    unittest.main()
