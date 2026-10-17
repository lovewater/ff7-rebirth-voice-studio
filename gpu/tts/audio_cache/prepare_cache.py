import hashlib
import threading
import time
import torch
from typing import Optional, Dict, Any, Tuple, Union
from base.utils import logger
from audio_cache.cache import SizeBasedCache
from audio_cache.utils import CacheItem


class PrepareCache:
    """
    用于缓存 infer_instance.prepare 结果的缓存类

    缓存键由以下内容组成：
    - 输入音频的哈希值
    - 情感音频的哈希值（如果有）
    - 情感文本内容

    缓存值：
    - prepare 方法返回的向量结果（转移到CPU后保存）
    """

    def __init__(self, max_items: int = 1000, enabled: bool = True):
        """
        初始化 Prepare 缓存

        Args:
            max_items: 最大缓存项目数量（默认1000）
            enabled: 是否启用缓存
        """
        self._cache: Dict[str, 'PrepareResult'] = {}
        self._access_order: Dict[str, float] = {}  # 记录访问时间，用于LRU
        self._max_items = max_items
        self._enabled = enabled
        self._lock = threading.RLock()

        logger.info(f"初始化Prepare缓存：最大项目数={max_items}，已{'启用' if enabled else '禁用'}缓存")

    def _generate_cache_key(self,
                          sample_audio_data: bytes,
                          emo_audio_data: Optional[bytes] = None,
                          emo_text: Optional[str] = None) -> str:
        """
        根据输入生成缓存键

        Args:
            sample_audio_data: 样本音频数据
            emo_audio_data: 情感音频数据（可选）
            emo_text: 情感文本（可选）

        Returns:
            str: 缓存键
        """
        # 计算样本音频的哈希
        sample_hash = hashlib.md5(sample_audio_data).hexdigest()

        # 计算情感音频的哈希（如果有）
        emo_audio_hash = ""
        if emo_audio_data:
            emo_audio_hash = hashlib.md5(emo_audio_data).hexdigest()

        # 计算情感文本的哈希（如果有）
        emo_text_hash = ""
        if emo_text:
            emo_text_hash = hashlib.md5(emo_text.encode('utf-8')).hexdigest()

        # 组合成最终的缓存键
        cache_key = f"prepare_{sample_hash}_{emo_audio_hash}_{emo_text_hash}"
        return cache_key

    def _move_tensors_to_cpu(self, prepare_result: Tuple) -> Tuple:
        """
        将 prepare 结果中的张量拷贝到 CPU

        Args:
            prepare_result: prepare 方法的返回结果

        Returns:
            Tuple: 拷贝到CPU后的结果
        """
        result = []
        for item in prepare_result:
            if isinstance(item, torch.Tensor):
                # 创建拷贝并移动到CPU，分离计算图
                result.append(item.detach().clone().cpu())
            else:
                result.append(item)
        return tuple(result)

    def _move_tensors_to_device(self, prepare_result: Tuple, device: str = "cuda") -> Tuple:
        """
        将 prepare 结果中的张量拷贝到指定设备

        Args:
            prepare_result: prepare 方法的返回结果
            device: 目标设备（默认cuda）

        Returns:
            Tuple: 拷贝到目标设备后的结果
        """
        result = []
        for item in prepare_result:
            if isinstance(item, torch.Tensor):
                # 创建拷贝并移动到指定设备
                result.append(item.clone().to(device))
            else:
                result.append(item)
        return tuple(result)

    def _cleanup_old_items(self):
        """
        清理最旧的缓存项，实现LRU淘汰策略
        """
        if len(self._cache) <= self._max_items:
            return

        # 按访问时间排序，移除最旧的项目
        sorted_keys = sorted(self._access_order.items(), key=lambda x: x[1])
        items_to_remove = len(self._cache) - self._max_items

        for i in range(items_to_remove):
            key_to_remove = sorted_keys[i][0]
            if key_to_remove in self._cache:
                del self._cache[key_to_remove]
                del self._access_order[key_to_remove]
                logger.debug(f"从Prepare缓存中移除旧项: {key_to_remove}")

    def get(self,
           sample_audio_data: bytes,
           emo_audio_data: Optional[bytes] = None,
           emo_text: Optional[str] = None,
           target_device: str = "cuda") -> Optional[Tuple]:
        """
        从缓存获取 prepare 结果

        Args:
            sample_audio_data: 样本音频数据
            emo_audio_data: 情感音频数据（可选）
            emo_text: 情感文本（可选）
            target_device: 目标设备（默认cuda）

        Returns:
            Optional[Tuple]: 缓存的prepare结果，如果没有命中则返回None
        """
        if not self._enabled:
            return None,None

        cache_key = self._generate_cache_key(sample_audio_data, emo_audio_data, emo_text)

        with self._lock:
            if cache_key in self._cache:
                # 更新访问时间
                self._access_order[cache_key] = time.time()

                # 获取缓存的结果
                prepare_result = self._cache[cache_key]

                # 将张量移动到目标设备并返回
                result = self._move_tensors_to_device(prepare_result.data, target_device)

                logger.info(f"从Prepare缓存中获取结果: {cache_key[:32]}...")
                return cache_key,result

        return None,None

    def put(self,
           sample_audio_data: bytes,
           emo_audio_data: Optional[bytes] = None,
           emo_text: Optional[str] = None,
           prepare_result: Tuple = None) -> str:
        """
        将 prepare 结果添加到缓存

        Args:
            sample_audio_data: 样本音频数据
            emo_audio_data: 情感音频数据（可选）
            emo_text: 情感文本（可选）
            prepare_result: prepare方法的返回结果

        Returns:
            str: 缓存键
        """
        if not self._enabled or prepare_result is None:
            return ""

        cache_key = self._generate_cache_key(sample_audio_data, emo_audio_data, emo_text)

        with self._lock:
            # 将张量移动到CPU
            cpu_result = self._move_tensors_to_cpu(prepare_result)

            # 创建缓存项
            cache_item = PrepareResult(
                data=cpu_result,
                key=cache_key,
                created_at=time.time()
            )

            # 添加到缓存
            self._cache[cache_key] = cache_item
            self._access_order[cache_key] = time.time()

            # 清理旧项目
            self._cleanup_old_items()

            logger.info(f"添加Prepare结果到缓存: {cache_key[:32]}... (缓存大小: {len(self._cache)}/{self._max_items})")

        return cache_key

    def clear(self):
        """清空缓存"""
        with self._lock:
            self._cache.clear()
            self._access_order.clear()
            logger.info("已清空Prepare缓存")

    def get_stats(self) -> Dict[str, Any]:
        """
        获取缓存统计信息

        Returns:
            Dict[str, Any]: 统计信息
        """
        with self._lock:
            return {
                "name": "Prepare缓存",
                "enabled": self._enabled,
                "item_count": len(self._cache),
                "max_items": self._max_items,
                "usage_percent": (len(self._cache) / self._max_items * 100) if self._max_items > 0 else 0
            }

    def set_enabled(self, enabled: bool):
        """设置是否启用缓存"""
        self._enabled = enabled
        logger.info(f"{'启用' if enabled else '禁用'}Prepare缓存")


class PrepareResult:
    """Prepare结果的缓存项"""

    def __init__(self, data: Tuple, key: str, created_at: float):
        self.data = data
        self.key = key
        self.created_at = created_at
