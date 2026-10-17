import threading
import time
import uuid
from collections import deque
from typing import Any, Deque, Optional, Tuple


class InferenceTask:
    """封装一次 forward 调用的任务。"""

    def __init__(
        self,
        segment: Any,
        prepare_result: Any,
        generation_kwargs: Optional[dict] = None,
        task_id: Optional[str] = None,
    ) -> None:
        self.task_id = task_id or str(uuid.uuid4())
        self.segment = segment
        self.prepare_result = prepare_result
        self.generation_kwargs = generation_kwargs or {}

        self.result: Optional[Any] = None
        self.wait_time: float = 0.0
        self.error: Optional[Exception] = None
        self.attempts: int = 0
        self.cancelled: bool = False

        self._event = threading.Event()

    def mark_success(self, wait_time: float, result: Any) -> None:
        self.wait_time = wait_time
        self.result = result
        self._event.set()

    def mark_failure(self, err: Exception) -> None:
        self.error = err
        self.attempts += 1

    def cancel(self) -> None:
        self.cancelled = True
        self._event.set()

    def wait(self, timeout: Optional[float] = None) -> bool:
        return self._event.wait(timeout=timeout)

    @property
    def done(self) -> bool:
        return self._event.is_set()


class InferenceTaskQueue:
    """简单的线程安全队列，支持从队尾加入、从队头取出，以及失败时回退到队头。"""

    def __init__(self) -> None:
        self._queue: Deque[InferenceTask] = deque()
        self._cv = threading.Condition()

    def put(self, task: InferenceTask) -> None:
        """放入队尾"""
        with self._cv:
            self._queue.append(task)
            self._cv.notify()

    def put_front(self, task: InferenceTask) -> None:
        """放入队头（用于失败重试）"""
        with self._cv:
            self._queue.appendleft(task)
            self._cv.notify()

    def get(self, timeout: Optional[float] = None) -> Optional[InferenceTask]:
        """从队头取出任务，没有则等待。"""
        end_time = None if timeout is None else time.time() + timeout
        with self._cv:
            while not self._queue:
                remaining = None if end_time is None else end_time - time.time()
                if remaining is not None and remaining <= 0:
                    return None
                self._cv.wait(timeout=remaining)
            return self._queue.popleft()

    def __len__(self) -> int:
        with self._cv:
            return len(self._queue)
