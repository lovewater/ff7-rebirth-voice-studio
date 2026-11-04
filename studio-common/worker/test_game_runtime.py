"""Game isolation fails before connecting or scanning the mounted audio tree."""
import json
from pathlib import Path
import tempfile
import unittest

from game_runtime import load_game_runtime


class GameIsolation(unittest.TestCase):
    def test_legacy_rebirth_defaults_are_unchanged(self):
        self.assertIsNone(load_game_runtime({}).database_url)
        runtime = load_game_runtime({}, legacy_database_url="legacy-dsn")
        self.assertEqual(runtime.game_id, "rebirth")
        self.assertEqual(runtime.database_url, "legacy-dsn")
        self.assertEqual(runtime.audio_root, Path("/app/data"))
        self.assertEqual(runtime.priority_region, "GOLDE")
        self.assertEqual(load_game_runtime({"DATABASE_URL": ""}, legacy_database_url="legacy-dsn").database_url, "")

    def test_missing_or_other_game_dsn_never_falls_back(self):
        for dsn in [None, "postgres://ff7rb@db/studio",
                    "postgres://ff7remake@db/studio",
                    "postgres://ff7rb@db/studio_ff7_remake",
                    "postgres://ff7remake@db/studio_ff7_remake/",
                    "postgres://ff7remake@db/studio_ff7_remake?dbname=studio",
                    "postgres://ff7remake@db/studio_ff7_remake?user=ff7rb",
                    "https://ff7remake@db/studio_ff7_remake"]:
            env = {"FF7_GAME_ID": "remake"}
            if dsn is not None:
                env["DATABASE_URL"] = dsn
            with self.subTest(dsn=dsn), self.assertRaises(ValueError) as failure:
                load_game_runtime(env, legacy_database_url="legacy-dsn")
            self.assertNotIn("secret", str(failure.exception))

    def test_explicit_remake_root_and_matching_marker_are_required(self):
        with tempfile.TemporaryDirectory() as folder:
            env = {"FF7_GAME_ID": "remake", "DATABASE_URL": "postgresql://ff7remake@db/studio_ff7_remake"}
            with self.assertRaises(ValueError):
                load_game_runtime(env)
            env["AUDIO_DATA_ROOT"] = folder
            marker = Path(folder) / ".ff7-game.json"
            for content in [None, {}, {"game_id": "rebirth"}, {"game_id": "remake", "database": "studio"}]:
                if content is not None:
                    marker.write_text(json.dumps(content))
                with self.subTest(content=content), self.assertRaises(ValueError):
                    load_game_runtime(env)
            marker.write_text(json.dumps({"game_id": "remake", "database": "studio_ff7_remake"}))
            runtime = load_game_runtime(env)
            self.assertEqual(runtime.game_id, "remake")
            self.assertEqual(runtime.audio_root, Path(folder))
            self.assertEqual(runtime.database_url, env["DATABASE_URL"])
            self.assertIsNone(runtime.priority_region)
            with self.assertRaises(ValueError):
                load_game_runtime({"AUDIO_DATA_ROOT": folder})

    def test_invalid_identity_and_conflicting_alias_are_rejected(self):
        for env in [{"FF7_GAME_ID": ""}, {"GAME_ID": "other"},
                    {"FF7_GAME_ID": "remake", "GAME_ID": "rebirth"}]:
            with self.subTest(env=env), self.assertRaises(ValueError):
                load_game_runtime(env)

    def test_default_rebirth_cannot_scan_the_reserved_remake_database(self):
        for url in ["postgres://ff7rb@db/studio_ff7_remake",
                    "postgres://ff7remake@db/studio",
                    "postgres://ff7rb@db/trial?dbname=studio_ff7_remake",
                    "postgres://ff7rb@db/trial?user=ff7remake"]:
            with self.subTest(url=url), self.assertRaises(ValueError) as failure:
                load_game_runtime({"DATABASE_URL": url})
            self.assertNotIn("secret", str(failure.exception))
        self.assertEqual(load_game_runtime({"DATABASE_URL": "postgres://trial@db/gap_rescue_test"}).game_id, "rebirth")


if __name__ == "__main__":
    unittest.main()
