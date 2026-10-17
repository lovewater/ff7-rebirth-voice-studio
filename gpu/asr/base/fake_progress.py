import math
import threading
import time
from typing import Optional, Tuple

from base.reporter import Reporter


def _progress_curve(elapsed: float, total_seconds: float) -> float:
    """平滑曲线：前快后慢，近似 1min->50%、5min->75%。"""
    if total_seconds <= 0:
        return 1.0
    x = max(0.0, min(elapsed / total_seconds, 1.0))
    k = 3.1
    p = 0.94
    base = 1.0 - math.exp(-k * (x ** p))
    max_base = 1.0 - math.exp(-k)
    if max_base <= 0:
        return x
    return min(base / max_base, 1.0)


def _fake_progress_worker(
    task_id: str,
    start_progress: int,
    end_progress: int,
    total_seconds: int,
    interval: int,
    stop_event: threading.Event,
) -> None:
    reporter = Reporter()
    begin = time.perf_counter()
    last_reported = start_progress - 1
    while not stop_event.is_set():
        elapsed = time.perf_counter() - begin
        frac = _progress_curve(elapsed, total_seconds)
        progress = int(round(start_progress + (end_progress - start_progress) * frac))
        if progress > end_progress:
            progress = end_progress
        if progress > last_reported:
            reporter.reportProgress(task_id, progress)
            last_reported = progress
        if elapsed >= total_seconds or progress >= end_progress:
            break
        stop_event.wait(interval)


def start_fake_progress(
    task_id: str,
    start_progress: int = 35,
    end_progress: int = 85,
    total_seconds: int = 600,
    interval: int = 10,
) -> Tuple[Optional[threading.Thread], Optional[threading.Event]]:
    """启动假进度上报线程。"""
    if not task_id:
        return None, None
    stop_event = threading.Event()
    thread = threading.Thread(
        target=_fake_progress_worker,
        args=(task_id, start_progress, end_progress, total_seconds, interval, stop_event),
        daemon=True,
    )
    thread.start()
    return thread, stop_event


def start_wait_progress(
    task_id: str,
    start_progress: int = 16,
    end_progress: int = 34,
    interval: int = 15,
) -> Tuple[Optional[threading.Thread], Optional[threading.Event]]:
    """在等待锁期间每隔一段时间上报进度。"""
    if not task_id:
        return None, None

    stop_event = threading.Event()

    def _worker():
        reporter = Reporter()
        progress = start_progress
        while not stop_event.is_set() and progress <= end_progress:
            reporter.reportProgress(task_id, progress)
            progress += 1
            stop_event.wait(interval)

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()
    return thread, stop_event
