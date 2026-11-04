#!/usr/bin/env python3
"""Initialize an isolated Remake database and data root without changing Rebirth data.

The database service is reused. Only its read-only schema and latest enabled
prompt configuration are copied; game rows, locks, lexicons and assets are not.
No containers are stopped/rebuilt and no inference is requested.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "studio-ff7-remake"
SOURCE_DATABASE = "studio"
DATABASE = "studio_ff7_remake"
ROLE = "ff7remake"
GAME = "remake"
DB_CONTAINER = "studio-ff7-rb-db-1"


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def sql_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    return "'" + str(value).replace("'", "''") + "'"


def query(database, sql):
    return subprocess.check_output([
        "docker", "exec", "-i", DB_CONTAINER, "psql", "-X", "-U", "ff7rb",
        "-d", database, "-At", "-v", "ON_ERROR_STOP=1",
    ], input=sql.encode()).decode().strip()


def write_private(path, text):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(path, 0o600)


def remake_prompt(text):
    text = text.replace("Rebirth", "Remake").replace("REBIRTH", "REMAKE")
    return re.sub(r"(最终幻想\s*(?:VII|7)[\s：:]*)重生", r"\1重制版", text)


def row_insert(table, row):
    columns = ",".join('"' + key + '"' for key in row)
    values = ",".join(sql_literal(value) for value in row.values())
    return f"INSERT INTO {table}({columns}) VALUES({values});\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", action="store_true", help="Show the plan without creating files/roles/databases")
    args = parser.parse_args()
    assert PROJECT.parent == ROOT and (ROOT / "studio-common").is_dir()
    assert DATABASE != SOURCE_DATABASE and ROLE != "ff7rb"
    if args.plan:
        print(json.dumps({"game": GAME, "shared_database_service": DB_CONTAINER,
            "new_database": DATABASE, "new_role": ROLE, "data": str(PROJECT / "website/data"),
            "schema_only_source": SOURCE_DATABASE, "seed": ["latest enabled prompt per key", "prompt groups and memberships"],
            "excluded": ["lines", "regions", "speakers", "pronunciations", "game_fixed_terms", "voice banks", "audio", "locks", "job history"]}, ensure_ascii=False, indent=2))
        return

    private = PROJECT / ".private"
    private.mkdir(mode=0o700, exist_ok=True)
    state_path = private / "bootstrap-state.json"
    cluster = query("postgres", "SELECT system_identifier::text FROM pg_control_system();")
    if state_path.exists():
        state = json.loads(state_path.read_text())
        assert state["cluster"] == cluster and state["database"] == DATABASE and state["role"] == ROLE, "Bootstrap state does not match this cluster/game"
    else:
        assert query("postgres", f"SELECT count(*) FROM pg_roles WHERE rolname={sql_literal(ROLE)};") == "0", "Role already exists; do not adopt unknown credentials"
        assert query("postgres", f"SELECT count(*) FROM pg_database WHERE datname={sql_literal(DATABASE)};") == "0", "Database already exists; do not adopt another project"
        state = {"cluster": cluster, "database": DATABASE, "role": ROLE, "password": secrets.token_urlsafe(36), "complete": False}
        write_private(state_path, json.dumps(state, indent=2))

    if query("postgres", f"SELECT count(*) FROM pg_roles WHERE rolname={sql_literal(ROLE)};") == "0":
        query("postgres", f'CREATE ROLE "{ROLE}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD {sql_literal(state["password"])};')
    role = json.loads(query("postgres", f"SELECT row_to_json(r) FROM (SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname={sql_literal(ROLE)}) r;"))
    assert not any(role[k] for k in ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication"]), "Unexpected privileged role"
    if query("postgres", f"SELECT count(*) FROM pg_database WHERE datname={sql_literal(DATABASE)};") == "0":
        query("postgres", f'CREATE DATABASE "{DATABASE}" OWNER "{ROLE}" TEMPLATE template0 ENCODING \'UTF8\';')
        query("postgres", f'REVOKE ALL ON DATABASE "{DATABASE}" FROM PUBLIC;')
    owner = query("postgres", f"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname={sql_literal(DATABASE)};")
    assert owner == ROLE, "Refuse to modify database owned by another project"

    tables = int(query(DATABASE, "SELECT count(*) FROM pg_tables WHERE schemaname='public';"))
    schema = ROOT / "studio-common/db/schema.sql"
    schema.parent.mkdir(parents=True, exist_ok=True)
    if tables == 0:
        dumped = subprocess.check_output([
            "docker", "exec", DB_CONTAINER, "pg_dump", "-U", "ff7rb", "-d", SOURCE_DATABASE,
            "--schema-only", "--schema=public", "--no-owner", "--no-acl", "--no-comments",
        ]).decode()
        schema.write_text(dumped)
        # This is the guarded, known-empty NEW database only. A failed transaction rolls back.
        query(DATABASE, f'BEGIN; SET ROLE "{ROLE}"; DROP SCHEMA public;\n' + dumped + "\nCOMMIT;")
    assert int(query(DATABASE, "SELECT count(*) FROM pg_tables WHERE schemaname='public';")) >= 20, "New schema incomplete"

    if not state.get("complete"):
        # Never initialize a project that has already started accumulating user data.
        assert query(DATABASE, "SELECT count(*) FROM lines;") == "0", "Project already has lines; refuse bootstrap seed"
        existing = int(query(DATABASE, "SELECT count(*) FROM prompt_templates;"))
        if existing == 0:
            prompts = json.loads(query(SOURCE_DATABASE, "SELECT json_agg(p ORDER BY key) FROM (SELECT DISTINCT ON (key) key,category,name,\"desc\",prompt,enable,role,placeholders FROM prompt_templates WHERE enable ORDER BY key,updated_at DESC,id DESC) p;"))
            groups = json.loads(query(SOURCE_DATABASE, "SELECT json_agg(p ORDER BY key) FROM (SELECT key,name,\"desc\",category FROM prompt_groups) p;"))
            members = json.loads(query(SOURCE_DATABASE, "SELECT json_agg(p ORDER BY group_key,prompt_key) FROM (SELECT group_key,prompt_key,position FROM prompt_group_members) p;"))
            keys = {p["key"] for p in prompts}
            seed = f'BEGIN; SET ROLE "{ROLE}";\n'
            for row in groups:
                seed += row_insert("prompt_groups", row)
            for row in prompts:
                row["prompt"] = remake_prompt(row["prompt"])
                row["source_path"] = "bootstrap-adapted-config"
                row["seed_hash"] = hashlib.sha256((GAME + "\n" + row["key"] + "\n" + row["prompt"]).encode()).hexdigest()
                seed += row_insert("prompt_templates", row)
            for row in members:
                if row["prompt_key"] in keys:
                    seed += row_insert("prompt_group_members", row)
            seed += "COMMIT;"
            query(DATABASE, seed)
            # Prompt bodies are user-editable project data, not publishable shared source.
            write_private(private / "bootstrap-prompts.json", json.dumps({"source_game": "rebirth", "target_game": GAME,
                "source": "latest enabled templates adapted only in the new database", "templates": prompts,
                "groups": groups, "members": [m for m in members if m["prompt_key"] in keys]}, ensure_ascii=False, indent=2) + "\n")

    # Rebirth tables remain inaccessible to the new role; no existing database ACLs change.
    denied = query(SOURCE_DATABASE, f"SELECT has_table_privilege({sql_literal(ROLE)},'lines','SELECT') OR has_table_privilege({sql_literal(ROLE)},'line_tts_versions','UPDATE') OR has_schema_privilege({sql_literal(ROLE)},'public','CREATE');")
    assert denied == "f", "New role unexpectedly has Rebirth privileges"
    assert query("postgres", f"SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname={sql_literal(ROLE)});") == "0", "New role unexpectedly inherits other roles"

    data = PROJECT / "website/data"
    data.mkdir(parents=True, exist_ok=True)
    assert data.resolve() == data and not data.is_symlink(), "Data root cannot alias another game"
    marker = data / ".ff7-game.json"
    identity = {"game_id": GAME, "database": DATABASE}
    if marker.exists():
        assert json.loads(marker.read_text()) == identity, "Existing data marker belongs to another game"
    else:
        assert not any(data.iterdir()), "Refuse to mark a nonempty unknown data directory"
        marker.write_text(json.dumps(identity, indent=2) + "\n")
    for name in ["tts", "embedded", "jp", "cn", "en", "metrics", "translation-background"]:
        (data / name).mkdir(exist_ok=True)
    for name in ["game", "work"]:
        (PROJECT / name).mkdir(exist_ok=True)

    env_path = PROJECT / ".env"
    if not env_path.exists():
        inspection = json.loads(subprocess.check_output(["docker", "inspect", "studio-ff7-rb-website-1"]))[0]
        original_env = dict(v.split("=", 1) for v in inspection["Config"]["Env"] if "=" in v)
        selected = ["TTS_URL", "TTS_URLS", "TTS_MAX_INFLIGHT", "REWRITE_LLM_URL", "REWRITE_LLM_MODEL", "REWRITE_LLM_KEY", "VOLCENGINE_LLM_URL", "VOLCENGINE_LLM_MODEL", "VOLCENGINE_LLM_KEY", "SELF_HOSTED_LLM_URL", "SELF_HOSTED_LLM_MODEL", "SELF_HOSTED_LLM_KEY", "QWEN_ASR_URL", "SEEDASR_API_KEY", "SEEDASR_RESOURCE_ID"]
        env = {"COMPOSE_PROJECT_NAME": "studio-ff7-remake", "FF7_GAME_ID": GAME,
            "DATABASE_URL": f"postgres://{ROLE}:{state['password']}@db:5432/{DATABASE}"}
        env.update({k: original_env[k] for k in selected if k in original_env})
        assert env.get("REWRITE_LLM_MODEL") == "glm-5.3", "Unexpected primary LLM model"
        def dotenv(value):
            assert "\n" not in value and "\r" not in value
            return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
        write_private(env_path, "# Local runtime credentials. Never publish.\n" + "".join(k + "=" + dotenv(v) + "\n" for k, v in env.items()))
    state["complete"] = True
    write_private(state_path, json.dumps(state, indent=2))
    print(json.dumps({"game": GAME, "database": DATABASE, "role": ROLE, "schema_ready": True,
        "prompt_keys": int(query(DATABASE, "SELECT count(DISTINCT key) FROM prompt_templates;")),
        "lines": int(query(DATABASE, "SELECT count(*) FROM lines;")), "rebirth_privileges": False,
        "data_marker": str(marker), "env_created": str(env_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
