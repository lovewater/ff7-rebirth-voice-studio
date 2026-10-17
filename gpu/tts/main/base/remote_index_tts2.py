import threading
import time
import uuid
from typing import Any, Optional, Tuple

import requests
import torch

from base.utils import logger
from base.vector_utils import VectorSerializer


class RemoteIndexTTS2:
    """
    远程推理包装类，使用 /predict_vector 接口完成 forward 调用。
    记录连续失败次数，连续3次失败后进入3分钟冷却期，在冷却期内不可用。
    """

    def __init__(self, base_url: str, name: str = "", timeout: float = 300.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.name = name or self.base_url
        self.timeout = timeout

        self._forward_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._fail_count = 0
        self._cooldown_until: Optional[float] = None
        self._last_error_ts: Optional[float] = None

    # ---------------- 状态管理 ---------------- #
    def _update_cooldown_locked(self) -> None:
        """定时衰减失败计数，冷却结束时自动减1。"""
        if self._fail_count <= 0 or self._cooldown_until is None:
            return

        now = time.time()
        if now >= self._cooldown_until:
            # 每经过一个冷却周期，错误次数减一
            self._fail_count = max(0, self._fail_count - 1)
            if self._fail_count >= 3:
                # 仍然达不到可用条件，继续冷却
                self._cooldown_until = now + 180
            else:
                self._cooldown_until = None

    def is_available(self) -> bool:
        """是否可用（未处于冷却期）。"""
        with self._state_lock:
            self._update_cooldown_locked()
            if self._fail_count >= 3 and self._cooldown_until and time.time() < self._cooldown_until:
                return False
            return True

    def _record_failure(self, err: Exception) -> None:
        with self._state_lock:
            self._fail_count += 1
            self._last_error_ts = time.time()
            if self._fail_count >= 3:
                # 进入冷却
                if self._cooldown_until is None or self._cooldown_until < self._last_error_ts:
                    self._cooldown_until = self._last_error_ts + 180
                logger.error(
                    f"[RemoteIndexTTS2][{self.name}] 连续失败{self._fail_count}次，暂停使用3分钟: {err}"
                )
            else:
                logger.warning(f"[RemoteIndexTTS2][{self.name}] 请求失败({self._fail_count}): {err}")

    def _record_success(self) -> None:
        with self._state_lock:
            self._fail_count = 0
            self._cooldown_until = None
            self._last_error_ts = None

    # ---------------- 对外接口 ---------------- #
    def forward(self, sent: Any, *prepare_result: Any, **generation_kwargs: Any) -> Tuple[float, Any]:
        """
        调用远程 /predict_vector 完成 forward。
        返回 wait_time（等待锁的时间）和反序列化后的结果。
        """
        if not self.is_available():
            raise RuntimeError(f"Remote infer {self.name} is in cooldown")

        lock_start = time.perf_counter()
        logger.info(f"[RemoteIndexTTS2][{self.name}] 开始请求计算..")
        with self._forward_lock:
            wait_time = time.perf_counter() - lock_start
            payload = {
                "prepare_result_b64": VectorSerializer.serialize_to_base64(prepare_result),
                "segment_tokens": VectorSerializer.serialize_to_base64(sent),
                "task_id": str(uuid.uuid4()),
            }

            # 内网节点，明确不经代理
            proxies = {}
            try:
                resp = requests.post(
                    f"{self.base_url}/predict_vector",
                    json=payload,
                    timeout=self.timeout,
                    proxies=proxies,
                )
                resp.raise_for_status()
                resp_obj = VectorSerializer.deserialize_from_bytes(resp.content)

                # 远端可能返回 (wait_time, wav)；统一提取 wav
                remote_wait = 0.0
                wav_tensor = resp_obj
                if isinstance(resp_obj, tuple) and len(resp_obj) == 2:
                    maybe_wait, maybe_wav = resp_obj
                    if isinstance(maybe_wait, (int, float)):
                        remote_wait = float(maybe_wait)
                    if torch.is_tensor(maybe_wav):
                        wav_tensor = maybe_wav
                if not torch.is_tensor(wav_tensor):
                    raise ValueError(f"远端返回结果类型异常: {type(wav_tensor)}")

                wait_time += remote_wait
                self._record_success()
                return wait_time, wav_tensor
            except Exception as err:
                self._record_failure(err)
                raise
            finally:
                logger.info(f"[RemoteIndexTTS2][{self.name}] 计算结束，用时:{round(time.perf_counter() - lock_start - wait_time,1)}s")
