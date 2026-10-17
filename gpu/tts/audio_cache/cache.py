import threading
import time
import gc
import queue
from dataclasses import dataclass, field
from typing import List, Optional, TypeVar, Generic, Callable, Dict, Any
from dataclasses import dataclass, field
import time
from typing import Generic, Literal, Dict, Any, Optional, TypeVar

from audio_cache.utils import CacheItem, format_size, parse_size_limit
from base.utils import  logger

T = TypeVar('T')

class SizeBasedCache(Generic[T]):
    """
    基于大小的缓存实现

    泛型参数T表示缓存的数据类型
    """

    def __init__(self,
                 size_limit: int = 500*1024*1024,
                 name: str = "cache",
                 size_calculator: Callable[[T], int] = len,
                 enabled: bool = True):
        """
        初始化缓存

        Args:
            size_limit: 缓存最大字节大小（默认500MB）
            name: 缓存名称，用于日志
            size_calculator: 计算数据大小的函数
            enabled: 是否启用缓存
        """
        self._cache: List[CacheItem[T]] = []
        self._size_limit = size_limit
        self._current_size = 0
        self._name = name
        self._size_calculator = size_calculator
        self._lock = threading.RLock()  # 使用单一可重入锁替代读锁和写锁
        self._enabled = enabled
        self._cleanup_in_progress = False  # 清理标志

        # 创建清理线程和队列
        self._cleanup_queue = queue.Queue()
        self._cleanup_thread = threading.Thread(target=self._cleanup_worker, daemon=True)
        self._cleanup_thread.start()

        logger.info(f"初始化{self._name}：大小限制={format_size(self._size_limit)}")

    def _cleanup_worker(self):
        """清理线程的工作函数，循环处理清理请求"""
        while True:
            try:
                # 等待清理任务
                _ = self._cleanup_queue.get()

                # 执行缓存清理
                self._do_cleanup_cache()

                # 标记任务完成
                self._cleanup_queue.task_done()
            except Exception as e:
                logger.error(f"缓存清理线程异常: {e}")
                # 继续循环，不让线程退出
                continue

    def set_size_limit(self, size_limit: int):
        """
        设置缓存大小限制

        Args:
            size_limit: 字节大小
        """
        with self._lock:
            old_limit = self._size_limit
            self._size_limit = size_limit
            logger.info(f"{self._name}大小限制从 {format_size(old_limit)} 更改为 {format_size(size_limit)}")

            # 如果新限制小于当前大小，请求清理缓存
            if self._current_size > self._size_limit:
                self._cleanup_cache()

    def set_size_limit_from_str(self, size_str: str):
        """
        从字符串设置缓存大小限制

        Args:
            size_str: 大小字符串，如 "500MB", "2GB"
        """
        size_bytes = parse_size_limit(size_str)
        self.set_size_limit(size_bytes)

    def get(self, key: str) -> Optional[CacheItem[T]]:
        """
        获取缓存项

        Args:
            key: 缓存键

        Returns:
            Optional[CacheItem[T]]: 缓存项，如果不存在则返回None
        """
        if not self._enabled:
            return None

        # 使用单一锁保护读取操作
        with self._lock:
            for i, item in enumerate(self._cache):
                if item.key == key:
                    # 更新访问时间
                    item.update_access_time()

                    # 如果没有清理进行中，则将命中的缓存移到列表头部
                    if not self._cleanup_in_progress:
                        # 直接在当前锁内修改列表
                        self._cache.pop(i)
                        self._cache.insert(0, item)

                    return item
        return None

    def put(self, key: str, data: T, metadata: Dict[str, Any] = None) -> CacheItem[T]:
        """
        添加或更新缓存项

        Args:
            key: 缓存键
            data: 缓存数据
            metadata: 额外的元数据

        Returns:
            CacheItem[T]: 添加的缓存项
        """
        if not self._enabled:
            # 创建一个临时的缓存项但不添加到缓存
            current_time = time.time()
            size = self._size_calculator(data)
            return CacheItem(
                data=data,
                key=key,
                created_at=current_time,
                updated_at=current_time,
                size=size,
                metadata=metadata or {}
            )

        # 使用单一锁保护写操作
        with self._lock:
            # 计算数据大小
            size = self._size_calculator(data)

            # 如果key已存在，先删除旧数据
            for i, item in enumerate(self._cache):
                if item.key == key:
                    self._current_size -= item.size
                    self._cache.pop(i)
                    break

            # 创建新的缓存项
            current_time = time.time()
            cache_item = CacheItem(
                data=data,
                key=key,
                created_at=current_time,
                updated_at=current_time,
                size=size,
                metadata=metadata or {}
            )

            # 添加新数据到头部
            self._cache.insert(0, cache_item)
            self._current_size += size

            # 如果超出大小限制，请求清理缓存
            if self._current_size > self._size_limit:
                self._cleanup_cache()

            return cache_item

    def remove(self, key: str) -> bool:
        """
        从缓存中移除项

        Args:
            key: 缓存键

        Returns:
            bool: 是否成功移除
        """
        if not self._enabled:
            return False

        # 如果清理正在进行，等待完成
        while self._cleanup_in_progress:
            time.sleep(0.01)

        # 使用单一锁保护移除操作
        with self._lock:
            for i, item in enumerate(self._cache):
                if item.key == key:
                    self._current_size -= item.size
                    self._cache.pop(i)
                    return True
            return False

    def clear(self):
        """清空缓存"""
        # 使用单一锁保护清空操作
        with self._lock:
            self._cache.clear()
            self._current_size = 0
            logger.info(f"已清空{self._name}")
            # 强制垃圾回收
            gc.collect()

    def get_stats(self) -> Dict[str, Any]:
        """
        获取缓存统计信息

        Returns:
            Dict[str, Any]: 统计信息
        """
        # 使用单一锁保护统计信息获取
        with self._lock:
            return {
                "name": self._name,
                "enabled": self._enabled,
                "item_count": len(self._cache),
                "current_size": self._current_size,
                "current_size_formatted": format_size(self._current_size),
                "size_limit": self._size_limit,
                "size_limit_formatted": format_size(self._size_limit),
                "usage_percent": (self._current_size / self._size_limit * 100) if self._size_limit > 0 else 0
            }

    def _cleanup_cache(self):
        """
        请求清理缓存，在单独的线程中执行
        """
        # 如果清理已经在进行中，不重复请求
        if self._cleanup_in_progress:
            return

        # 检查是否需要清理
        with self._lock:
            if self._current_size <= self._size_limit:
                return

        # 请求清理（非阻塞）
        try:
            self._cleanup_queue.put_nowait(True)
        except queue.Full:
            # 队列已满，说明已经有清理任务在排队
            logger.debug(f"缓存清理队列已满，跳过本次清理请求")

    def _do_cleanup_cache(self):
        """
        实际执行缓存清理的方法，在单独的线程中调用
        """
        # 再次检查是否需要清理
        with self._lock:
            if self._current_size <= self._size_limit:
                return

        # 设置清理标志
        self._cleanup_in_progress = True

        try:
            # 使用单一锁复制缓存项
            with self._lock:
                # 复制所有缓存项的引用（浅拷贝）
                cached_items = self._cache.copy()

                # 获取当前缓存大小
                old_size = self._current_size

                # 按更新时间（访问时间）排序
                cached_items.sort(key=lambda x: x.updated_at, reverse=True)

                # 计算目标大小（缓存限制的2/3）
                target_size = int(self._size_limit * 2 / 3)

            # 重建缓存列表
            new_cache = []
            new_size = 0
            kept_count = 0

            # 添加排序后的项直到达到目标大小
            for item in cached_items:
                if new_size < target_size:
                    new_cache.append(item)
                    new_size += item.size
                    kept_count += 1
                # 如果一个项都没有保留，至少保留一个
                elif len(new_cache) == 0:
                    new_cache.append(item)
                    new_size += item.size
                    kept_count += 1
                    break
                else:
                    break

            # 使用单一锁，替换缓存并更新大小
            with self._lock:
                # 替换缓存和大小
                self._cache = new_cache
                self._current_size = new_size

            # 记录清理结果
            removed_count = len(cached_items) - kept_count
            if removed_count > 0:
                logger.info(f"从{self._name}中移除了 {removed_count} 个旧项，缓存大小从 {format_size(old_size)} 减少到 {format_size(new_size)}")

            # 手动触发垃圾回收，清理不再引用的项
            gc.collect()

        finally:
            # 完成清理，取消标志
            self._cleanup_in_progress = False

# 字节类型的缓存，可以直接用len获取大小
BytesCache = SizeBasedCache[bytes]
