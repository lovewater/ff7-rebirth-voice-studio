#!/usr/bin/env python3
"""Online per-game backups with immutable audio objects and protected restore targets."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
DB_CONTAINER = os.environ.get("DB_CONTAINER", "studio-ff7-rb-db-1")
ADMIN = "ff7rb"
NAS_MOUNT = Path(os.environ.get("NAS_MOUNT", "/srv/backups"))
NAS_ROOT = Path(os.environ.get("BACKUP_DEST", str(NAS_MOUNT / "ff7-backup")))
GAMES = {
    "rebirth": {"database": "studio", "role": "ff7rb", "project": "studio-ff7-rb"},
    "remake": {"database": "studio_ff7_remake", "role": "ff7remake", "project": "studio-ff7-remake"},
}
ASSET_DIRECTORIES = ("tts", "embedded")
PROTECTED_DATABASES = {"studio", "studio_ff7_remake", "postgres", "template0", "template1"}
SHA = re.compile(r"^[0-9a-f]{64}$")


def config(game):
    item = dict(GAMES[game])
    item.update(game=game, data=ROOT / item["project"] / "website/data", destination=NAS_ROOT / game)
    return item


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def identifier(value):
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", value):
        raise ValueError("Invalid database identifier")
    return '"' + value + '"'


def query(database, sql):
    return subprocess.check_output(["docker", "exec", "-i", DB_CONTAINER, "psql", "-X", "-U", ADMIN,
        "-d", database, "-At", "-v", "ON_ERROR_STOP=1"], input=sql.encode()).decode().strip()


def hash_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def safe_relative(value):
    p = PurePosixPath(value)
    if not value or p.is_absolute() or any(part in ("", ".", "..") for part in value.split("/")) or "\\" in value:
        raise ValueError("Unsafe asset path")
    if p.parts[0] not in ASSET_DIRECTORIES and value != ".ff7-game.json":
        raise ValueError("Asset outside generated data scope")
    return p


def object_path(destination, sha):
    if not SHA.fullmatch(sha):
        raise ValueError("Invalid object digest")
    return Path(destination) / "objects" / sha[:2] / sha


def verify_data_identity(game, data):
    data = Path(data)
    if data.resolve() != data:
        raise ValueError("Data root cannot alias another project")
    expected = {"game_id": game, "database": GAMES[game]["database"]}
    marker = data / ".ff7-game.json"
    if marker.exists():
        actual = json.loads(marker.read_text())
        if actual.get("game_id") != expected["game_id"] or actual.get("database") != expected["database"]:
            raise ValueError("Data identity belongs to another game")
    elif game != "rebirth":
        raise ValueError("Remake data marker is missing")
    if not (data / "tts").is_dir():
        raise ValueError("TTS source directory is missing")
    return expected


def require_nas():
    mount = subprocess.check_output(["findmnt", "-n", "-t", "cifs", "--target", str(NAS_MOUNT), "-o", "TARGET"], text=True).strip()
    if mount != str(NAS_MOUNT) or not NAS_ROOT.resolve().is_relative_to(NAS_MOUNT):
        raise RuntimeError("NAS CIFS mount is missing; refusing local fallback")


def atomic_json(path, value):
    path = Path(path)
    tmp = path.with_name("." + path.name + "." + secrets.token_hex(8) + ".tmp")
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def put_bytes(destination, payload, token, verify_existing=False):
    sha = hashlib.sha256(payload).hexdigest()
    target = object_path(destination, sha)
    if target.exists():
        if target.stat().st_size != len(payload):
            raise RuntimeError("Existing object has wrong size")
        if verify_existing and hash_file(target) != sha:
            raise RuntimeError("Existing object failed SHA256")
        return sha, False
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name("." + sha + "." + token + ".tmp")
    try:
        temporary.write_bytes(payload)
        if hash_file(temporary) != sha:
            raise RuntimeError("New object failed NAS SHA256 readback")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return sha, True


def store_file(source, relative, destination, token, verify_existing=False):
    safe_relative(relative)
    source = Path(source)
    if source.is_symlink():
        raise ValueError("Generated source must not be a symlink")
    # A user may be editing a file while this online backup is running.
    for attempt in range(3):
        before = source.stat()
        sha = hash_file(source)
        after = source.stat()
        signature = lambda s: (s.st_ino, s.st_dev, s.st_size, s.st_mtime_ns)
        if signature(before) != signature(after):
            continue
        target = object_path(destination, sha)
        created = False
        if target.exists():
            if target.stat().st_size != before.st_size:
                raise RuntimeError("Existing content object has incorrect size")
            if verify_existing and hash_file(target) != sha:
                raise RuntimeError("Existing content object failed SHA256")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name("." + sha + "." + token + "." + secrets.token_hex(8) + ".tmp")
            try:
                shutil.copyfile(source, temporary)
                final = source.stat()
                if signature(before) != signature(final) or hash_file(temporary) != sha:
                    temporary.unlink(missing_ok=True)
                    continue
                temporary.replace(target)
                created = True
            finally:
                temporary.unlink(missing_ok=True)
        return {"path": relative, "sha256": sha, "size": before.st_size, "mtime_ns": before.st_mtime_ns}, created
    raise RuntimeError("Source changed repeatedly during backup: " + relative)


def database_counts(database):
    return json.loads(query(database, """SELECT json_build_object(
      'lines',(SELECT count(*) FROM lines),
      'line_meta',(SELECT count(*) FROM line_meta),
      'tts_rows',(SELECT count(*) FROM line_tts_versions),
      'ready',(SELECT count(*) FROM line_tts_versions WHERE status='ready' AND audio_path IS NOT NULL),
      'locked',(SELECT count(*) FROM line_tts_versions WHERE review_state='locked'),
      'pronunciations',(SELECT count(*) FROM pronunciations),
      'llm_access_logs',(SELECT count(*) FROM llm_access_logs));"""))


def required_paths(database):
    return json.loads(query(database, """SELECT COALESCE(json_agg(DISTINCT p),'[]'::json) FROM (
      SELECT audio_path p FROM line_tts_versions WHERE status='ready' AND audio_path IS NOT NULL
      UNION SELECT raw_audio_path FROM line_tts_versions WHERE status='ready' AND raw_audio_path IS NOT NULL
      UNION SELECT embedding_path FROM voice_bank_versions WHERE status='ready' AND embedding_path IS NOT NULL
      UNION SELECT reference_wav_path FROM voice_bank_versions WHERE status='ready' AND reference_wav_path IS NOT NULL
      UNION SELECT source_wav_path FROM voice_bank_versions WHERE status='ready' AND source_wav_path IS NOT NULL
      UNION SELECT manifest_path FROM voice_bank_versions WHERE status='ready' AND manifest_path IS NOT NULL
      UNION SELECT example_zh_path FROM voice_bank_versions WHERE status='ready' AND example_zh_path IS NOT NULL
      UNION SELECT example_ja_path FROM voice_bank_versions WHERE status='ready' AND example_ja_path IS NOT NULL
    ) t WHERE btrim(p)<>'';"""))


def unfinished_references(database):
    """Keep unfinished/error source metadata in the manifest, without requiring nonexistent outputs."""
    return json.loads(query(database, """SELECT COALESCE(json_agg(row_to_json(r) ORDER BY entity,version_id,field),'[]'::json) FROM (
      SELECT 'line_tts_versions'::text AS entity,t.id::text AS version_id,t.status,v.field,v.path
      FROM line_tts_versions t CROSS JOIN LATERAL (VALUES
        ('audio_path',t.audio_path),('raw_audio_path',t.raw_audio_path)) v(field,path)
      WHERE t.status IS DISTINCT FROM 'ready' AND v.path IS NOT NULL AND btrim(v.path)<>''
      UNION ALL
      SELECT 'voice_bank_versions',t.id::text,t.status,v.field,v.path
      FROM voice_bank_versions t CROSS JOIN LATERAL (VALUES
        ('embedding_path',t.embedding_path),('reference_wav_path',t.reference_wav_path),
        ('source_wav_path',t.source_wav_path),('manifest_path',t.manifest_path),
        ('example_zh_path',t.example_zh_path),('example_ja_path',t.example_ja_path)) v(field,path)
      WHERE t.status IS DISTINCT FROM 'ready' AND v.path IS NOT NULL AND btrim(v.path)<>''
    ) r;"""))


def restore_custom(dump, database):
    # The caller only passes an exclusively created, marked scratch database.
    with Path(dump).open("rb") as f:
        subprocess.run(["docker", "exec", "-i", DB_CONTAINER, "pg_restore", "-U", ADMIN, "-d", database,
            "--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error"], stdin=f, check=True)


class ScratchDatabase:
    def __init__(self, game, purpose="check"):
        self.game = game
        self.token = secrets.token_hex(12)
        self.name = f"ff7_{purpose}_{game}_{self.token}"
        self.marker = f"ff7-studio:{game}:{purpose}:{self.token}"
        self.created = False

    def __enter__(self):
        identifier(self.name)
        if self.name in PROTECTED_DATABASES or query("postgres", f"SELECT count(*) FROM pg_database WHERE datname={literal(self.name)};") != "0":
            raise ValueError("Restore target already exists or is protected")
        query("postgres", f"CREATE DATABASE {identifier(self.name)} OWNER {identifier(ADMIN)};")
        query("postgres", f"COMMENT ON DATABASE {identifier(self.name)} IS {literal(self.marker)};")
        self.created = True
        return self.name

    def __exit__(self, *_):
        if not self.created:
            return
        ownership = json.loads(query("postgres", f"SELECT json_build_object('owner',pg_get_userbyid(datdba),'marker',shobj_description(oid,'pg_database')) FROM pg_database WHERE datname={literal(self.name)};"))
        if ownership != {"owner": ADMIN, "marker": self.marker} or self.name in PROTECTED_DATABASES:
            raise RuntimeError("Scratch ownership changed; refusing DROP")
        query("postgres", f"DROP DATABASE {identifier(self.name)} WITH (FORCE);")


def verify_snapshot(game, snapshot):
    snapshot = Path(snapshot).resolve()
    expected = config(game)["destination"].resolve() / "db"
    if not snapshot.is_relative_to(expected) or snapshot.is_symlink():
        raise ValueError("Snapshot is outside this game's namespace")
    manifest = json.loads((snapshot / "MANIFEST.json").read_text())
    if manifest.get("status") != "complete" or manifest.get("game") != game or manifest.get("database") != GAMES[game]["database"]:
        raise ValueError("Snapshot identity/status does not match the selected game")
    files = json.loads((snapshot / "FILES.json").read_text())
    if files["game"] != game or files["database"] != GAMES[game]["database"]:
        raise ValueError("File manifest belongs to another game")
    if hash_file(snapshot / "FILES.json") != manifest["files_sha256"]:
        raise ValueError("File manifest checksum mismatch")
    seen = set()
    for record in files["files"]:
        safe_relative(record["path"])
        object_path(config(game)["destination"], record["sha256"])
        if record["path"] in seen:
            raise ValueError("Duplicate restore path")
        seen.add(record["path"])
    if ".ff7-game.json" not in seen:
        raise ValueError("Restore identity marker is missing")
    dump = snapshot / manifest["dump"]["filename"]
    if manifest["dump"]["filename"] != GAMES[game]["database"] + ".dump" or hash_file(dump) != manifest["dump"]["sha256"]:
        raise ValueError("Database dump identity/checksum mismatch")
    return manifest, files, dump


def prune_snapshots(game, keep_days, today=None):
    today = today or date.today()
    folder = config(game)["destination"] / "db"
    removed = []
    for day in sorted(folder.iterdir()):
        if day.is_symlink() or not day.is_dir():
            continue
        try:
            d = date.fromisoformat(day.name)
        except ValueError:
            continue
        if (today - d).days <= keep_days:
            continue
        for run in day.iterdir():
            if run.is_symlink() or not run.is_dir() or not run.name.startswith("run-"):
                continue
            try:
                manifest = json.loads((run / "MANIFEST.json").read_text())
            except (FileNotFoundError, ValueError):
                continue
            if manifest.get("game") == game and manifest.get("database") == GAMES[game]["database"] and manifest.get("status") == "complete":
                shutil.rmtree(run)
                removed.append(str(run))
        if not any(day.iterdir()):
            day.rmdir()
    return removed


def backup(game, jobs, keep_days, verify_existing):
    cfg = config(game)
    identity = verify_data_identity(game, cfg["data"])
    require_nas()
    destination = cfg["destination"]
    destination.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(8)
    run_name = "run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + token
    day = destination / "db" / date.today().isoformat()
    day.mkdir(parents=True, exist_ok=True)
    staging = day / (".in-progress-" + run_name)
    staging.mkdir()
    log_file = destination / "backup.log"
    def log(message):
        line = f"[{datetime.now().isoformat(timespec='seconds')}] {game} {message}"
        print(line, flush=True)
        with log_file.open("a") as f:
            f.write(line + "\n")
    log("begin " + run_name)
    try:
        with tempfile.TemporaryDirectory(prefix="ff7-backup-" + game + "-") as temp:
            temp = Path(temp)
            dump = temp / (cfg["database"] + ".dump")
            with dump.open("wb") as f:
                subprocess.run(["docker", "exec", DB_CONTAINER, "pg_dump", "-U", ADMIN, "-d", cfg["database"],
                    "--format=custom", "--no-owner", "--no-acl", "--exclude-table-data=public.llm_access_logs"], stdout=f, check=True)
            with ScratchDatabase(game) as check_db:
                restore_custom(dump, check_db)
                counts = database_counts(check_db)
                references = required_paths(check_db)
                unfinished = unfinished_references(check_db)
                if counts["llm_access_logs"] != 0:
                    raise RuntimeError("Excluded model logs unexpectedly contain rows")
            log("same-dump restore check passed; snapshot counts=" + json.dumps(counts))
            records = []
            created = skipped = 0
            source_files = []
            for directory in ASSET_DIRECTORIES:
                base = cfg["data"] / directory
                if base.exists():
                    source_files.extend(p for p in base.rglob("*") if p.is_file())
            required = set()
            excluded_references = []
            for value in references:
                try:
                    safe_relative(value)
                    required.add(value)
                except ValueError:
                    if PurePosixPath(value).parts and PurePosixPath(value).parts[0] in ("jp", "cn", "en"):
                        excluded_references.append(value)
                    else:
                        raise RuntimeError("Unexpected generated asset reference outside backup scope")
            present = {p.relative_to(cfg["data"]).as_posix() for p in source_files}
            if required - present:
                raise RuntimeError("Dump references missing generated files: " + ", ".join(sorted(required - present)[:10]))
            unstable_unreferenced = []
            with ThreadPoolExecutor(max_workers=jobs) as pool:
                futures = {pool.submit(store_file, p, p.relative_to(cfg["data"]).as_posix(), destination, token, verify_existing): p for p in source_files}
                for i, future in enumerate(as_completed(futures), 1):
                    p = futures[future]
                    try:
                        record, new = future.result()
                    except RuntimeError as e:
                        relative = p.relative_to(cfg["data"]).as_posix()
                        if "Source changed repeatedly" in str(e) and relative not in required:
                            unstable_unreferenced.append(relative)
                            continue
                        raise
                    records.append(record)
                    created += int(new)
                    skipped += int(not new)
                    if i % 1000 == 0 or i == len(futures):
                        log(f"objects {i}/{len(futures)} new={created} existing={skipped}")
            marker_bytes = (json.dumps(identity, sort_keys=True) + "\n").encode()
            marker_sha, marker_new = put_bytes(destination, marker_bytes, token, verify_existing)
            records.append({"path": ".ff7-game.json", "sha256": marker_sha, "size": len(marker_bytes), "mtime_ns": time.time_ns()})
            created += int(marker_new)
            skipped += int(not marker_new)
            records.sort(key=lambda r: r["path"])
            atomic_json(staging / "FILES.json", {"game": game, "database": cfg["database"], "files": records})
            shutil.copyfile(dump, staging / dump.name)
            dump_sha = hash_file(dump)
            if hash_file(staging / dump.name) != dump_sha:
                raise RuntimeError("NAS dump checksum mismatch")
            plain = temp / "snapshot.sql"
            with dump.open("rb") as source, plain.open("wb") as output:
                subprocess.run(["docker", "exec", "-i", DB_CONTAINER, "pg_restore", "--no-owner", "--no-acl", "--file=-"], stdin=source, stdout=output, check=True)
            sql_gz = staging / (cfg["database"] + ".sql.gz")
            with plain.open("rb") as source, gzip.open(sql_gz, "wb", compresslevel=9) as output:
                shutil.copyfileobj(source, output)
            manifest = {"format": "ff7-studio-backup-v2", "status": "complete", "game": game,
                "database": cfg["database"], "run": run_name, "created_utc": datetime.now(timezone.utc).isoformat(),
                "database_snapshot": "one custom pg_dump; plain SQL derived from this same dump",
                "counts": counts, "restore_check": "passed", "files_sha256": hash_file(staging / "FILES.json"),
                "dump": {"filename": dump.name, "sha256": dump_sha, "size": dump.stat().st_size},
                "sql_gzip": {"filename": sql_gz.name, "sha256": hash_file(sql_gz), "size": sql_gz.stat().st_size},
                "audio_objects": {"new": created, "existing": skipped, "files": len(records)},
                "file_verify": {"new_objects": "sha256_readback", "existing_objects": "sha256" if verify_existing else "size_only", "restore": "sha256_required"},
                "excluded": {"original_audio": ["jp", "cn", "en"], "cache": ["metrics", "translation-background"], "table_data": ["public.llm_access_logs"],
                    "original_audio_references": excluded_references, "unstable_unreferenced_files": unstable_unreferenced,
                    "unfinished_references": unfinished,
                    "missing_unfinished_references": [reference for reference in unfinished if reference["path"] not in present]}}
            atomic_json(staging / "MANIFEST.json", manifest)
            published = day / run_name
            staging.rename(published)
            atomic_json(destination / "LATEST.json", {"game": game, "database": cfg["database"], "snapshot": str(published.relative_to(destination))})
            restore_doc = Path(__file__).with_name("RESTORE.md")
            if restore_doc.exists():
                doc_tmp = destination / (".RESTORE." + token + ".tmp")
                doc_tmp.write_text(f"当前备份空间：{game} / {cfg['database']}\n\n" + restore_doc.read_text())
                doc_tmp.replace(destination / "RESTORE.md")
            removed = prune_snapshots(game, keep_days)
            log(f"complete snapshot={published} pruned={len(removed)}; immutable objects are never pruned")
            return published
    except Exception:
        log("FAILED; incomplete directory retained, no complete snapshot published")
        raise


def restore_check(game, snapshot, output=None):
    require_nas()
    manifest, files, dump = verify_snapshot(game, snapshot)
    destination = config(game)["destination"]
    for record in files["files"]:
        source = object_path(destination, record["sha256"])
        if source.stat().st_size != record["size"] or hash_file(source) != record["sha256"]:
            raise ValueError("Audio object failed restore SHA256 check")
        if record["path"] == ".ff7-game.json" and json.loads(source.read_text()) != {"game_id": game, "database": GAMES[game]["database"]}:
            raise ValueError("Restored data marker belongs to another game")
    target_directory = None
    if output is not None:
        target_directory = Path(output).resolve()
        allowed = ROOT / GAMES[game]["project"] / "work"
        if not target_directory.is_relative_to(allowed) or target_directory == allowed or (target_directory.exists() and any(target_directory.iterdir())):
            raise ValueError("Restore output must be an empty subdirectory of this game's work directory")
        target_directory.mkdir(parents=True, exist_ok=True)
        for record in files["files"]:
            target = target_directory / safe_relative(record["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(object_path(destination, record["sha256"]), target)
            if hash_file(target) != record["sha256"]:
                raise ValueError("Restored output checksum mismatch")
            os.utime(target, ns=(record["mtime_ns"], record["mtime_ns"]))
    with ScratchDatabase(game, "restore") as target:
        restore_custom(dump, target)
        counts = database_counts(target)
        if counts != manifest["counts"]:
            raise ValueError("Restored snapshot row counts do not match manifest")
        print(json.dumps({"game": game, "restore_check": "passed", "counts": counts, "verified_objects": len(files["files"]),
            "audio_output": str(target_directory) if target_directory else None, "production_modified": False}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["backup", "restore-check"], nargs="?", default="backup")
    parser.add_argument("--game", choices=GAMES, required=True)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--output", type=Path, help="restore-check: materialize files only in an empty directory under the selected game's work/")
    parser.add_argument("--jobs", type=int, default=5)
    parser.add_argument("--keep-days", type=int, default=30)
    parser.add_argument("--verify-existing", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 5 or args.keep_days < 1:
        parser.error("jobs must be 1..5 and keep-days must be positive")
    cfg = config(args.game)
    if args.dry_run:
        print(json.dumps({"command": args.command, "game": args.game, "database": cfg["database"], "data": str(cfg["data"]), "destination": str(cfg["destination"]), "assets": list(ASSET_DIRECTORIES), "object_format": "sha256", "legacy_backup_untouched": True}, indent=2))
        return
    if args.command == "restore-check":
        if not args.snapshot:
            parser.error("restore-check requires --snapshot")
        restore_check(args.game, args.snapshot, args.output)
        return
    with open(f"/tmp/ff7-backup-{args.game}.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another backup for this game is already running")
        backup(args.game, args.jobs, args.keep_days, args.verify_existing)


if __name__ == "__main__":
    main()
