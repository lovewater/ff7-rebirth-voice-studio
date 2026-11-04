import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("remake_bootstrap", Path(__file__).with_name("bootstrap.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def test_plan_is_read_only_and_excludes_rebirth_business_data(self):
        with patch.object(sys, "argv", ["bootstrap.py", "--plan"]), patch.object(bootstrap, "query", side_effect=AssertionError("database access in plan")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                bootstrap.main()
            plan = json.loads(output.getvalue())
        self.assertEqual(plan["new_database"], "studio_ff7_remake")
        self.assertIn("locks", plan["excluded"])
        self.assertIn("pronunciations", plan["excluded"])

    def test_brand_adaptation_does_not_change_ordinary_rebirth_word(self):
        source = "《最终幻想VII 重生》 Final Fantasy VII Rebirth；重生的世界"
        self.assertEqual(bootstrap.remake_prompt(source), "《最终幻想VII 重制版》 Final Fantasy VII Remake；重生的世界")
        self.assertEqual(bootstrap.sql_literal("it's"), "'it''s'")

    def test_full_bootstrap_and_rerun_do_not_mutate_rebirth_or_reseed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "ff7-sound"
            project = root / "studio-ff7-remake"
            project.mkdir(parents=True)
            (root / "studio-common").mkdir()
            calls = []
            state = {"role": False, "database": False, "schema": False, "seeded": False}

            def query(database, sql):
                calls.append((database, sql))
                if database == "studio":
                    self.assertTrue(sql.startswith("SELECT"), "Source database mutation")
                if "pg_control_system" in sql:
                    return "12345"
                if "FROM pg_auth_members" in sql:
                    return "0"
                if "FROM pg_roles WHERE rolname=" in sql and "count(*)" in sql:
                    return str(int(state["role"]))
                if sql.startswith("CREATE ROLE"):
                    state["role"] = True
                    return ""
                if "row_to_json(r)" in sql:
                    return json.dumps({"rolname": "ff7remake", "rolsuper": False, "rolcreatedb": False, "rolcreaterole": False, "rolreplication": False})
                if "FROM pg_database WHERE datname=" in sql and "count(*)" in sql:
                    return str(int(state["database"]))
                if sql.startswith("CREATE DATABASE"):
                    self.assertIn('"studio_ff7_remake"', sql)
                    state["database"] = True
                    return ""
                if sql.startswith("REVOKE ALL ON DATABASE"):
                    self.assertIn('"studio_ff7_remake"', sql)
                    return ""
                if "pg_get_userbyid(datdba)" in sql:
                    return "ff7remake"
                if "FROM pg_tables" in sql:
                    return "24" if state["schema"] else "0"
                if "DROP SCHEMA public" in sql:
                    self.assertEqual(database, "studio_ff7_remake")
                    self.assertIn('SET ROLE "ff7remake"', sql)
                    state["schema"] = True
                    return ""
                if sql == "SELECT count(*) FROM lines;":
                    return "0"
                if sql == "SELECT count(*) FROM prompt_templates;":
                    return str(int(state["seeded"]))
                if "FROM prompt_templates WHERE enable" in sql:
                    return json.dumps([{"key": "rewrite.normal.system", "category": "改稿", "name": "系统", "desc": "", "prompt": "Final Fantasy VII Rebirth", "enable": True, "role": "system", "placeholders": []}])
                if "FROM prompt_groups)" in sql:
                    return json.dumps([{"key": "rewrite", "name": "改稿", "desc": "", "category": "改稿"}])
                if "FROM prompt_group_members)" in sql:
                    return json.dumps([{"group_key": "rewrite", "prompt_key": "rewrite.normal.system", "position": 1}])
                if sql.startswith("BEGIN; SET ROLE") and "INSERT INTO prompt_templates" in sql:
                    self.assertEqual(database, "studio_ff7_remake")
                    self.assertIn("Remake", sql)
                    state["seeded"] = True
                    return ""
                if "has_table_privilege" in sql:
                    return "f"
                if "count(DISTINCT key)" in sql:
                    return "1"
                self.fail("Unexpected SQL: " + sql)

            def output(args, **kwargs):
                if "pg_dump" in args:
                    return b"CREATE SCHEMA public; CREATE TABLE public.lines(stem text);"
                if args[:2] == ["docker", "inspect"]:
                    return json.dumps([{"Config": {"Env": ["REWRITE_LLM_MODEL=glm-5.3", "REWRITE_LLM_KEY=fixture-secret"]}}]).encode()
                self.fail("Unexpected subprocess")

            with patch.object(bootstrap, "ROOT", root), patch.object(bootstrap, "PROJECT", project), patch.object(bootstrap, "query", query), patch.object(bootstrap.subprocess, "check_output", output), patch.object(sys, "argv", ["bootstrap.py"]):
                result = io.StringIO()
                with contextlib.redirect_stdout(result):
                    bootstrap.main()
                self.assertNotIn("fixture-secret", result.getvalue())
                marker = json.loads((project / "website/data/.ff7-game.json").read_text())
                self.assertEqual(marker, {"game_id": "remake", "database": "studio_ff7_remake"})
                self.assertEqual(stat.S_IMODE((project / ".env").stat().st_mode), 0o600)
                seed_count = sum("INSERT INTO prompt_templates" in sql for _, sql in calls)
                before_env = (project / ".env").read_bytes()
                with contextlib.redirect_stdout(io.StringIO()):
                    bootstrap.main()
                self.assertEqual(sum("INSERT INTO prompt_templates" in sql for _, sql in calls), seed_count)
                self.assertEqual((project / ".env").read_bytes(), before_env)
                private_seed = project / ".private/bootstrap-prompts.json"
                self.assertEqual(json.loads(private_seed.read_text())["templates"][0]["prompt"], "Final Fantasy VII Remake")
                self.assertEqual(stat.S_IMODE(private_seed.stat().st_mode), 0o600)
                self.assertFalse((root / "studio-common/db/common-prompts.json").exists())


if __name__ == "__main__":
    unittest.main()
