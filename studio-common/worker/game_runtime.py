"""Validate a CPU worker's game, database and mounted audio before any IO job.

Rebirth keeps the legacy entrypoints' optional/default DSNs. A new Remake
instance has no such fallback: its role, database and audio marker must agree.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Mapping
from urllib.parse import parse_qsl, unquote, urlparse

AUDIO_GAME_MARKER = ".ff7-game.json"


@dataclass(frozen=True)
class GameRuntime:
    game_id: str
    database_url: str | None
    audio_root: Path
    priority_region: str | None


def load_game_runtime(
    environ: Mapping[str, str] | None = None,
    *,
    legacy_database_url: str | None = None,
    legacy_audio_root: str = "/app/data",
) -> GameRuntime:
    env = os.environ if environ is None else environ
    primary, alias = env.get("FF7_GAME_ID"), env.get("GAME_ID")
    if primary is not None and alias is not None and primary != alias:
        raise ValueError("FF7_GAME_ID 与 GAME_ID 不一致，拒绝跨游戏运行")
    game_id = primary if primary is not None else alias if alias is not None else "rebirth"
    if game_id not in {"rebirth", "remake"}:
        raise ValueError("未知 FF7_GAME_ID，必须是 rebirth 或 remake")

    database_url = env.get("DATABASE_URL", legacy_database_url)
    audio_path = env.get("AUDIO_DATA_ROOT", legacy_audio_root)
    if game_id == "rebirth" and database_url:
        # Preserve historical experiment DSNs, but reserve the new game's
        # database and role even if an operator forgot FF7_GAME_ID.
        try:
            old_url = urlparse(database_url)
            query = parse_qsl(old_url.query, keep_blank_values=True)
            remake_target = (
                unquote(old_url.path) == "/studio_ff7_remake"
                or unquote(old_url.username or "") == "ff7remake"
                or any(
                    (key.lower() in {"database", "dbname"} and value == "studio_ff7_remake")
                    or (key.lower() in {"user", "username"} and value == "ff7remake")
                    for key, value in query
                )
            )
        except ValueError:
            remake_target = False  # Legacy driver retains its own error handling.
        if remake_target:
            raise ValueError("Rebirth CPU 服务不能连接 Remake 保留的数据库或账号")
    if game_id == "remake":
        # Never accept a caller-provided Rebirth default for a new game.
        database_url = env.get("DATABASE_URL")
        if not database_url:
            raise ValueError("Remake CPU 服务必须显式配置 DATABASE_URL")
        try:
            parsed = urlparse(database_url)
            valid = (
                parsed.scheme in {"postgres", "postgresql"}
                and unquote(parsed.path) == "/studio_ff7_remake"
                and unquote(parsed.username or "") == "ff7remake"
                and parsed.hostname is not None
                and not any(
                    key.lower() in {"database", "dbname", "user", "username"}
                    for key, _ in parse_qsl(parsed.query, keep_blank_values=True)
                )
            )
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("Remake CPU 服务只能使用 studio_ff7_remake 数据库和 ff7remake 账号")
        if not env.get("AUDIO_DATA_ROOT") or not Path(audio_path).is_absolute():
            raise ValueError("Remake CPU 服务必须显式配置绝对 AUDIO_DATA_ROOT")

    audio_root = Path(audio_path).resolve()
    marker = audio_root / AUDIO_GAME_MARKER
    if game_id == "remake" or marker.exists():
        try:
            content = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError("音频目录缺少有效的 .ff7-game.json 游戏标记") from exc
        if not isinstance(content, dict) or content.get("game_id") != game_id:
            raise ValueError("音频目录属于其他游戏，拒绝跨游戏运行")
        if game_id == "remake" and content.get("database") != "studio_ff7_remake":
            raise ValueError("Remake 音频目录的数据库标记不匹配")

    # This is Rebirth's historical scheduling preference, not a shared map id.
    return GameRuntime(game_id, database_url, audio_root, "GOLDE" if game_id == "rebirth" else None)
