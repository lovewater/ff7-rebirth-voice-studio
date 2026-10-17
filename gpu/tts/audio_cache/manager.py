import hashlib
import os
import re
import threading
from audio_cache.prepare_cache import PrepareCache
import torch
from typing import Optional, Dict, Any, Tuple, List
from base.utils import download_audio, logger
from base.config_manager import ConfigManager
from audio_cache.cache import BytesCache, CacheItem, SizeBasedCache
from audio_cache.utils import (
    get_cache_key,
    process_audio_from_base64,
    parse_size_limit,
    process_audio_from_file
)

class AudioCacheManager:
    """音频缓存管理器，管理样本缓存和结果缓存"""

    _instance = None
    _initialized = False
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls):
        """获取AudioCacheManager单例实例"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    config_manager = ConfigManager()
                    audio_cache_config = config_manager.get_audio_cache_config()

                    # 解析缓存大小配置
                    sample_size_limit = parse_size_limit(
                        audio_cache_config.get("sample_size_limit", "500MB")
                    )
                    result_size_limit = parse_size_limit(
                        audio_cache_config.get("result_size_limit", "500MB")
                    )
                    prepare_size_limit = parse_size_limit(
                        audio_cache_config.get("prepare_size_limit", "1024MB")
                    )
                    prepare_max_items = audio_cache_config.get("prepare_max_items", 1000)

                    cls._instance = cls(
                        sample_size_limit=sample_size_limit,
                        result_size_limit=result_size_limit,
                        prepare_size_limit=prepare_size_limit,
                        prepare_max_items=prepare_max_items,
                        enabled=audio_cache_config.get("enabled", True)
                    )
        return cls._instance

    def __init__(self, sample_size_limit: int = 500*1024*1024,
                 result_size_limit: int = 500*1024*1024,
                 prepare_size_limit: int = 1024*1024*1024,
                 prepare_max_items: int = 1000,
                 enabled: bool = True):
        """
        初始化音频缓存管理器

        Args:
            sample_size_limit: 样本缓存大小限制（字节）
            result_size_limit: 结果缓存大小限制（字节）
            prepare_size_limit: prepare缓存大小限制（字节）
            prepare_max_items: prepare缓存最大项目数
            enabled: 是否启用缓存
        """
        # 避免重复初始化
        if AudioCacheManager._initialized:
            return

        # 创建样本缓存和结果缓存
        self._sample_cache = BytesCache(
            size_limit=sample_size_limit,
            name="样本缓存",
            enabled=enabled
        )

        self._result_cache = BytesCache(
            size_limit=result_size_limit,
            name="结果缓存",
            enabled=enabled
        )
        self._prepare_cache = PrepareCache(
            max_items=prepare_max_items,
            enabled=enabled
        )

        self._enabled = enabled
        AudioCacheManager._initialized = True

        logger.info(f"初始化音频缓存管理器：已{'启用' if enabled else '禁用'}缓存")

    def process_sample_audio(self, sample_audio: str, sample_text: str = "") -> CacheItem[bytes]:
        """
        处理样本音频输入，支持URL、base64或文件路径格式，带缓存功能

        Args:
            sample_audio: 样本音频URL、base64数据或文件路径
            sample_text: 样本文本（可用于生成缓存键）

        Returns:
            CacheItem[bytes]: 处理后的音频数据缓存项

        Raises:
            ValueError: 如果处理失败
        """
        # 生成缓存键
        cache_key = get_cache_key(sample_audio, sample_text)

        # 尝试从缓存获取
        cached_item = self._sample_cache.get(cache_key)
        if cached_item is not None:
            logger.info(f'从样本缓存中获取音频数据: {cache_key}')
            # 如果有缓存项，检查metadata中是否有ASR结果
            if cached_item.metadata :
                return cached_item

        # 处理空输入
        if not sample_audio:
            raise ValueError("样本音频不能为空")

        # 用于存储处理后的音频和是否被截断的标志
        processed_audio = None
        is_truncated = False
        final_sample_text = sample_text

        # 处理URL
        if sample_audio.startswith('https://') or sample_audio.startswith('http://'):
            audio_data, size, is_truncated = download_audio(sample_audio)
            processed_audio = audio_data

        # 处理base64
        elif re.match(r'^data:audio/[^;]+;base64,', sample_audio):
            audio_data, size, is_truncated = process_audio_from_base64(sample_audio)
            processed_audio = audio_data

        # 尝试作为文件路径处理
        elif re.search(r'\.(wav|mp3|ogg|flac)$', sample_audio, re.IGNORECASE) and len(sample_audio) < 1000:
            try:
                audio_data, size, is_truncated = process_audio_from_file(sample_audio)
                processed_audio = audio_data
            except Exception as e:
                logger.warning(f"尝试作为文件路径处理失败: {e}")
                raise ValueError("无效的音频格式，请提供https URL、base64编码的音频数据或有效的音频文件路径")
        else:
            raise ValueError("无效的音频格式，请提供https URL、base64编码的音频数据或有效的音频文件路径")


        # 准备元数据
        metadata = {
            "original_text": sample_text,
            "sample_text": final_sample_text,
            "is_truncated": is_truncated
        }

        # 保存到缓存并返回
        return self._sample_cache.put(cache_key, processed_audio, metadata)

    def get_tts_result(self, input_key:str, segment: list[str]) -> Optional[bytes]:
        """
        从缓存获取TTS生成结果

        """
        cache_key = get_cache_key(input_key, hashlib.md5(''.join(segment).encode()).hexdigest())
        result_item = self._result_cache.get(cache_key)
        return result_item.data if result_item else None

    def add_tts_result(self, input_key:str, segment: list[str], audio_data: bytes) -> CacheItem[bytes]:
        """
        添加TTS生成结果到缓存
        """
        cache_key = get_cache_key(input_key, hashlib.md5(''.join(segment).encode()).hexdigest())
        metadata = {
            "cache_key": cache_key,
        }
        return self._result_cache.put(cache_key, audio_data, metadata)

    def get_prepare_result(self,
                          sample_item: CacheItem[bytes],
                          emo_item: Optional[CacheItem[bytes]] = None,
                          emo_text: Optional[str] = None,
                          target_device: str = "cuda") -> Optional[tuple]:
        """
        从缓存获取prepare结果

        Args:
            sample_item: 样本缓存项
            emo_item: 情感音频缓存项（可选）
            emo_text: 情感文本（可选）
            target_device: 目标设备（默认cuda）

        Returns:
            Optional[tuple]: 缓存的prepare结果，如果没有命中则返回None
        """
        emo_data = emo_item.data if emo_item else None
        return self._prepare_cache.get(
            sample_audio_data=sample_item.data,
            emo_audio_data=emo_data,
            emo_text=emo_text,
            target_device=target_device
        )

    def add_prepare_result(self,
                          sample_item: CacheItem[bytes],
                          emo_item: Optional[CacheItem[bytes]] = None,
                          emo_text: Optional[str] = None,
                          prepare_result: tuple = None) -> str:
        """
        添加prepare结果到缓存

        Args:
            sample_item: 样本缓存项
            emo_item: 情感音频缓存项（可选）
            emo_text: 情感文本（可选）
            prepare_result: prepare方法的返回结果

        Returns:
            str: 缓存键
        """
        emo_data = emo_item.data if emo_item else None
        return self._prepare_cache.put(
            sample_audio_data=sample_item.data,
            emo_audio_data=emo_data,
            emo_text=emo_text,
            prepare_result=prepare_result
        )

    def clear_sample_cache(self):
        """清空样本缓存"""
        self._sample_cache.clear()

    def clear_result_cache(self):
        """清空结果缓存"""
        self._result_cache.clear()

    def clear_prepare_cache(self):
        """清空prepare缓存"""
        self._prepare_cache.clear()

    def clear_all_caches(self):
        """清空所有缓存"""
        self.clear_sample_cache()
        self.clear_result_cache()
        self.clear_prepare_cache()

    def set_sample_cache_limit(self, size_limit: int):
        """设置样本缓存大小限制"""
        self._sample_cache.set_size_limit(size_limit)

    def set_result_cache_limit(self, size_limit: int):
        """设置结果缓存大小限制"""
        self._result_cache.set_size_limit(size_limit)

    def set_prepare_cache_enabled(self, enabled: bool):
        """设置prepare缓存是否启用"""
        self._prepare_cache.set_enabled(enabled)

    def set_enabled(self, enabled: bool):
        """设置是否启用缓存"""
        self._enabled = enabled
        logger.info(f"{'启用' if enabled else '禁用'}音频缓存")

    def get_stats(self) -> Dict[str, Any]:
        """
        获取缓存统计信息

        Returns:
            Dict[str, Any]: 统计信息
        """
        return {
            "enabled": self._enabled,
            "sample_cache": self._sample_cache.get_stats(),
            "result_cache": self._result_cache.get_stats(),
            "prepare_cache": self._prepare_cache.get_stats()
        }

    @property
    def sample_cache(self) -> BytesCache:
        """获取样本缓存"""
        return self._sample_cache

    @property
    def result_cache(self) -> BytesCache:
        """获取结果缓存"""
        return self._result_cache

    @property
    def prepare_cache(self) -> PrepareCache:
        """获取prepare缓存"""
        return self._prepare_cache

# 兼容旧版API的导出函数
def get_audio_cache():
    """获取AudioCacheManager单例实例"""
    return AudioCacheManager.get_instance()
