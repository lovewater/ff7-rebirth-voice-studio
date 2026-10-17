import json
import os
from typing import Dict, Any, List
import logging

logger = logging.getLogger(__name__)

class ConfigManager:
    """配置管理器，用于读取和管理配置，单例模式"""

    _instance = None

    # 默认配置
    DEFAULT_CONFIG = {
        "api": {
            "port": 8001,
            "host": "0.0.0.0",
        },
        "model_path": "/workspace/SenseVoice/pretrained_models/SenseVoiceSmall",   # ASR模型路径,
        "audio_cache": {
            "enabled": True,
            "sample_size_limit": "500MB",  # 默认样本缓存大小为500MB
            "result_size_limit": "500MB",  # 默认结果缓存大小为500MB
        },
        # 添加报告服务器配置
        "report_server": [],
        # 添加代理配置
        "proxy": {
            "enable": False,
            "url": ""
        },
        # 添加临时文件夹配置
        "tmp_folder": {
            "path": "./tmp_files"
        },
        "remote_devices": [
            {
            "url": "http://127.0.0.1:8000",
            }
        ]
    }

    def __new__(cls, config_path: str = "config.json"):
        """实现单例模式，并将相对路径的 config.json 固定解析到项目根目录。
        这样即使当前工作目录在 tts_base 下，也能正确读取根目录的 config.json。
        """
        if cls._instance is None:
            cls._instance = super(ConfigManager, cls).__new__(cls)
            # 解析配置文件路径：相对路径一律认为相对项目根目录（base/ 的上一级）
            base_dir = os.path.dirname(os.path.abspath(__file__))
            project_root = os.path.abspath(os.path.join(base_dir, ".."))
            if not os.path.isabs(config_path):
                resolved = os.path.join(project_root, config_path)
            else:
                resolved = config_path
            cls._instance.config_path = resolved
            cls._instance.config = cls._instance._load_config()
        return cls._instance

    def __init__(self, config_path: str = "config.json"):
        """
        初始化配置管理器

        Args:
            config_path: 配置文件路径
        """
        # 由于使用了__new__方法实现单例，这里不需要重复初始化
        pass

    def _load_config(self) -> Dict[str, Any]:
        """
        加载配置文件，如果不存在则创建默认配置

        Returns:
            合并后的配置
        """
        # 如果配置文件存在，读取并合并配置
        if os.path.exists(self.config_path):
            with open(self.config_path, "r", encoding="utf-8") as f:
                user_config = json.load(f)

            # 合并配置
            config = self._merge_configs(self.DEFAULT_CONFIG, user_config)
        else:
            # 使用默认配置
            config = self.DEFAULT_CONFIG

        # 将完整配置写回文件
        self._save_config(config)

        # 记录加载的配置
        logger.info(f"加载配置: {config}")

        return config

    def _merge_configs(self, default_config: Dict[str, Any], user_config: Dict[str, Any]) -> Dict[str, Any]:
        """
        递归合并配置

        Args:
            default_config: 默认配置
            user_config: 用户配置

        Returns:
            合并后的配置
        """
        result = default_config.copy()

        for key, value in user_config.items():
            # 如果是字典，递归合并
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = self._merge_configs(result[key], value)
            else:
                # 否则直接覆盖
                result[key] = value

        return result

    def _save_config(self, config: Dict[str, Any]):
        """
        保存配置到文件

        Args:
            config: 要保存的配置
        """
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
        except OSError as e:
            logger.warning("skip writing %s: %s", self.config_path, e)

    def get_audio_cache_config(self) -> Dict[str, Any]:
        """获取音频缓存配置"""
        cache_config = self.config.get("audio_cache", {})


        # 从sample_count迁移到sample_size_limit
        if "sample_count" in cache_config and "sample_size_limit" not in cache_config:
            # 假设每个样本平均大小约为500KB（可根据实际情况调整）
            estimated_size_mb = cache_config["sample_count"] * 0.5
            cache_config["sample_size_limit"] = f"{estimated_size_mb}MB"
            logger.warning(f"从旧配置迁移: sample_count={cache_config['sample_count']} -> sample_size_limit={cache_config['sample_size_limit']}")

        # 如果没有设置result_size_limit，使用与sample_size_limit相同的值
        if "result_size_limit" not in cache_config and "sample_size_limit" in cache_config:
            cache_config["result_size_limit"] = cache_config["sample_size_limit"]

        return cache_config

    def remote_devices_config(self) -> Dict[str, Any]:
        """获取模型配置"""
        model_config = self.config.get("remote_devices", [])

        # 确保返回的是列表
        if not isinstance(model_config, list):
            model_config = [model_config]

        # 确保每个配置项都是字典
        valid_configs = []
        for config in model_config:
            if isinstance(config, dict):
                valid_configs.append(config)
            else:
                logger.warning(f"忽略无效的模型配置: {config}")

        return valid_configs

    def get_api_config(self) -> Dict[str, Any]:
        """获取 API 配置"""
        return self.config.get("api", {})

    def get_model_path(self) -> str:
        """获取模型路径"""
        return self.config.get("model_path", "")

    def get_report_server_config(self) -> List[Dict[str, Any]]:
        """获取报告服务器配置"""
        report_config = self.config.get("report_server", [])

        # 确保返回的是列表
        if not isinstance(report_config, list):
            report_config = [report_config]

        return report_config

    def get_proxy_config(self) -> Dict[str, Any]:
        """获取代理配置"""
        return self.config.get("proxy", {
            "enable": False,
            "url": ""
        })

    def get_tmp_folder_config(self) -> Dict[str, Any]:
        """获取临时文件夹配置"""
        return self.config.get("tmp_folder", {
            "path": "./tmp_files"
        })
