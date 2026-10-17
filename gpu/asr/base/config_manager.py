import json
import os
import threading
from typing import Any, Dict, List


class ConfigManager:
    """Simple config loader with basic caching."""

    _config_cache: Dict[str, Any] | None = None
    _config_path_cache: str | None = None
    _lock = threading.Lock()
    _default_config: Dict[str, Any] = {
        "file_utils": {
            "quality": 90,
            "cache_path": "/tmp/anyvoice_cache",
            "file_expire_time": 3600,
        },
        "r2_proxy": {"enable": False, "http": "", "ignore": []},
        "devices": {"asr": ["auto"], "clone": ["auto"], "design": ["auto"]},
        "asr_params": {"dtype": "auto", "attn_implementation": "auto"},
        "clone_params": {"dtype": "auto", "attn_implementation": "auto"},
        "design_params": {"dtype": "auto", "attn_implementation": "auto"},
        "tts_params": {"audio_max_length": 20, "clone_mt": True, "infer_timeout": 360},
    }

    def __init__(self, config_path: str = "config.json"):
        self.config_path = os.path.abspath(config_path)
        if (
            ConfigManager._config_cache is None
            or ConfigManager._config_path_cache != self.config_path
        ):
            with ConfigManager._lock:
                if (
                    ConfigManager._config_cache is None
                    or ConfigManager._config_path_cache != self.config_path
                ):
                    loaded = self._load_config()
                    ConfigManager._config_cache = self._deep_merge(
                        ConfigManager._default_config, loaded
                    )
                    ConfigManager._config_path_cache = self.config_path
        self._config = ConfigManager._config_cache or {}

    def _load_config(self) -> Dict[str, Any]:
        if not os.path.exists(self.config_path):
            return {}
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def get_config(self) -> Dict[str, Any]:
        return self._config

    def get_file_utils_config(self) -> Dict[str, Any]:
        return self._config.get("file_utils", {})

    def get_r2_proxy_config(self) -> Dict[str, Any]:
        return self._config.get("r2_proxy", {})

    def get_devices_config(self) -> Dict[str, Any]:
        return self._config.get("devices", {})

    def get_report_server_config(self) -> List[Dict[str, Any]]:
        servers = self._config.get("report_server", [])
        if isinstance(servers, list):
            return servers
        return []

    def _deep_merge(self, base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
        merged = dict(base)
        for key, value in override.items():
            if (
                key in merged
                and isinstance(merged[key], dict)
                and isinstance(value, dict)
            ):
                merged[key] = self._deep_merge(merged[key], value)
            else:
                merged[key] = value
        return merged
