import os
import shlex
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import requests

from base.config_manager import ConfigManager
from base.server_log import log, format_log
from base.process_utils import force_kill_process

class WorkerTimeoutError(RuntimeError):
    def __init__(self, message: str, worker: "WorkerProcess", kind: str):
        super().__init__(message)
        self.worker = worker
        self.kind = kind


@dataclass
class WorkerProcess:
    kind: str
    name: str
    port: int
    device: Optional[str]
    cmd: List[str]
    env: Dict[str, str]
    process: Optional[subprocess.Popen] = None
    in_flight: int = 0
    last_start_time: float = field(default_factory=time.time)
    restart_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def device_key(self) -> str:
        return self.device or "auto"


class WorkerManager:
    """子进程管理与请求调度。"""

    def __init__(self, config_path: str = "config.json"):
        self.config_path = os.path.abspath(config_path)
        self.config = ConfigManager(self.config_path).get_config()
        self.root_dir = os.path.dirname(self.config_path)
        self.base_port = int(self.config.get("python_port", 6006))
        self.workers: List[WorkerProcess] = []
        self._lock = threading.Lock()
        self._running = False
        self._health_thread: Optional[threading.Thread] = None
        self._last_device_used: Dict[str, str] = {}
        self._log_prefix = "main"
        tts_params = self.config.get("tts_params", {}) if isinstance(self.config, dict) else {}
        self._request_timeout = float(tts_params.get("infer_timeout", 360))

    def start(self) -> None:
        """启动所有子进程并开始健康检查。"""
        self._running = True
        self._spawn_workers()
        self._health_thread = threading.Thread(target=self._health_loop, daemon=True)
        self._health_thread.start()
        self._setup_signal_handlers()

    def shutdown(self) -> None:
        """停止健康检查并依次关闭子进程。"""
        self._running = False
        if self._health_thread:
            self._health_thread.join(timeout=1)
        for worker in self.workers:
            self._terminate_worker(worker)

    def asr(self, payload: Dict) -> Dict:
        """调用 ASR 子进程。"""
        return self._request("asr", "/asr", payload)

    def clone(self, payload: Dict, on_timeout=None) -> Dict:
        """调用 Clone 子进程。"""
        return self._request("clone", "/clone", payload, on_timeout=on_timeout)

    def clone_prompt(self, payload: Dict, on_timeout=None) -> Dict:
        """调用 Clone 子进程生成音色 Prompt。"""
        return self._request("clone", "/clone_prompt", payload, on_timeout=on_timeout)

    def design(self, payload: Dict) -> Dict:
        """调用 Design 子进程。"""
        return self._request("design", "/predict", payload)

    def _spawn_workers(self) -> None:
        port = self.base_port + 10000
        devices_cfg = self.config.get("devices", {})
        asr_devices = self._normalize_device_list(devices_cfg.get("asr", []))
        clone_devices = self._normalize_device_list(devices_cfg.get("clone", []))

        for idx, device in enumerate(asr_devices):
            worker = self._build_worker("asr", idx, device, port)
            self._start_worker(worker)
            self.workers.append(worker)
            port += 1

        for idx, device in enumerate(clone_devices):
            worker = self._build_worker("clone", idx, device, port)
            self._start_worker(worker)
            self.workers.append(worker)
            port += 1

        design_devices = self._normalize_device_list(devices_cfg.get("design", []))
        for idx, device in enumerate(design_devices):
            worker = self._build_worker("design", idx, device, port)
            self._start_worker(worker)
            self.workers.append(worker)
            port += 1

    def _build_worker(self, kind: str, idx: int, device: Optional[str], port: int) -> WorkerProcess:
        name = f"{kind}-{idx}"
        if kind == "asr":
            script = "main_asr.py"
        elif kind == "clone":
            script = "main_clone.py"
        elif kind == "design":
            script = "main_design.py"
        else:
            raise ValueError(f"未知 worker 类型: {kind}")
        cmd = [sys.executable, script, "--port", str(port)]
        env = os.environ.copy()
        device_label = "cpu"
        if device:
            env["CUDA_VISIBLE_DEVICES"] = device
            device_label = f"cuda:{device}"
        env["WORKER_PREFIX"] = f"{device_label}-{kind}-{idx}"
        return WorkerProcess(
            kind=kind,
            name=name,
            port=port,
            device=device,
            cmd=cmd,
            env=env,
        )

    def _normalize_device_list(self, devices) -> List[str]:
        if devices is None:
            return []
        if not isinstance(devices, list):
            devices = [devices]
        normalized: List[str] = []
        for entry in devices:
            if isinstance(entry, list):
                raise ValueError("设备配置必须是 cuda:x 格式，且每个子进程仅一张卡")
            entry_str = str(entry).strip()
            if "," in entry_str:
                raise ValueError("设备配置必须是 cuda:x 格式，且每个子进程仅一张卡")
            normalized.append(self._normalize_device_name(entry_str))
        return normalized

    def _normalize_device_name(self, name: str) -> str:
        name = str(name).strip()
        if name.lower() == "auto":
            raise ValueError("设备配置必须是 cuda:x 格式")
        if name.startswith("cuda:"):
            index = name.split("cuda:", 1)[1].strip()
            if not index.isdigit():
                raise ValueError("设备配置必须是 cuda:x 格式")
            return index
        raise ValueError("设备配置必须是 cuda:x 格式")

    def _start_worker(self, worker: WorkerProcess) -> None:
        cmd_display = shlex.join(worker.cmd)
        cuda_visible = worker.env.get("CUDA_VISIBLE_DEVICES", "")
        log(format_log(self._log_prefix, f"{worker.name} 启动端口 {worker.port}"))
        log(format_log(self._log_prefix, f"{worker.name} CMD: {cmd_display}"))
        log(format_log(self._log_prefix, f"{worker.name} CUDA_VISIBLE_DEVICES={cuda_visible}"))
        worker.process = subprocess.Popen(
            worker.cmd,
            cwd=self.root_dir,
            env=worker.env,
        )
        worker.last_start_time = time.time()

    def _terminate_worker(self, worker: WorkerProcess) -> bool:
        killed = False
        if worker.process and worker.process.poll() is None:
            log(format_log(self._log_prefix, f"{worker.name} 正在终止..."))
            worker.process.terminate()
            try:
                worker.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pid = getattr(worker.process, "pid", None)
                if pid:
                    log(format_log(self._log_prefix, f"{worker.name} 强制 kill -9 pid={pid}"), stderr=True)
                killed = force_kill_process(worker.process)
        return killed

    def _restart_worker(self, worker: WorkerProcess) -> None:
        log(format_log(self._log_prefix, f"{worker.name} 健康检查失败，重启中..."))
        killed = self._terminate_worker(worker)
        worker.process = None
        if killed:
            # 强杀后等待2秒，避免进程残留影响重启
            time.sleep(2)
        self._start_worker(worker)


    def restart_worker_until_healthy(self, worker: WorkerProcess) -> None:
        """同步重启并等待健康，失败则10秒后重试直到成功。"""
        if worker is None:
            return
        with worker.restart_lock:
            while True:
                try:
                    # 重启异常时记录日志，避免沉默失败
                    self._restart_worker(worker)
                except Exception as exc:
                    log(format_log(self._log_prefix, f"{worker.name} 重启异常: {exc}"), stderr=True)
                if self._wait_for_health(worker, timeout=10):
                    log(format_log(self._log_prefix, f"{worker.name} 重启成功并恢复健康"))
                    self._release_worker(worker)
                    return
                # 重启失败，延迟后继续重试
                log(format_log(self._log_prefix, f"{worker.name} 重启未成功，10秒后重试..."), stderr=True)
                time.sleep(10)

    def _restart_worker_async(self, worker: WorkerProcess) -> None:
        # 超时重启放到后台线程，避免阻塞当前请求
        thread = threading.Thread(
            target=self.restart_worker_until_healthy,
            args=(worker,),
            daemon=True,
        )
        thread.start()

    def _wait_for_health(self, worker: WorkerProcess, timeout: int = 10) -> bool:
        start = time.time()
        while time.time() - start < timeout:
            if self._check_health_strict(worker):
                return True
            time.sleep(1)
        log(format_log(self._log_prefix, f"{worker.name} 重启后健康检查超时"), stderr=True)
        return False

    def _health_loop(self) -> None:
        while self._running:
            for worker in self.workers:
                if not self._check_health(worker):
                    self._restart_worker(worker)
            time.sleep(10)

    def _check_health(self, worker: WorkerProcess) -> bool:
        if time.time() - worker.last_start_time < 5:
            return True
        if not worker.process or worker.process.poll() is not None:
            return False
        url = f"http://127.0.0.1:{worker.port}/health"
        try:
            resp = requests.get(url, timeout=3.0)
            return resp.status_code == 200
        except Exception:
            return False

    def _check_health_strict(self, worker: WorkerProcess) -> bool:
        if not worker.process or worker.process.poll() is not None:
            return False
        url = f"http://127.0.0.1:{worker.port}/health"
        try:
            resp = requests.get(url, timeout=3.0)
            return resp.status_code == 200
        except Exception:
            return False

    def _request(self, kind: str, path: str, payload: Dict, on_timeout=None) -> Dict:
        worker = self._select_worker(kind)
        url = f"http://127.0.0.1:{worker.port}{path}"
        should_release = True
        try:
            resp = requests.post(url, json=payload, timeout=self._request_timeout)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.Timeout as exc:
            # 超时视为异常状态，交给重启流程接管释放
            should_release = False
            log(format_log(self._log_prefix, f"{worker.name} 请求超时，触发重启"), stderr=True)
            if on_timeout:
                on_timeout(worker)
            else:
                self._restart_worker_async(worker)
            raise WorkerTimeoutError(f"{kind} 超时", worker=worker, kind=kind) from exc
        finally:
            if should_release:
                self._release_worker(worker)

    def _select_worker(self, kind: str) -> WorkerProcess:
        with self._lock:
            candidates = [w for w in self.workers if w.kind == kind]
            if not candidates:
                raise RuntimeError(f"未找到可用的 {kind} worker")
            device_inflight = self._device_inflight_locked()
            min_inflight = min(w.in_flight for w in candidates)
            candidates = [w for w in candidates if w.in_flight == min_inflight]
            min_device_inflight = min(
                device_inflight.get(w.device_key, 0) for w in candidates
            )
            candidates = [
                w for w in candidates if device_inflight.get(w.device_key, 0) == min_device_inflight
            ]
            last_device = self._last_device_used.get(kind)
            worker = None
            if last_device and len(candidates) > 1:
                for w in candidates:
                    if w.device_key != last_device:
                        worker = w
                        break
            if worker is None:
                candidates.sort(key=lambda w: w.name)
                worker = candidates[0]
            worker.in_flight += 1
            self._last_device_used[kind] = worker.device_key
            return worker

    def _release_worker(self, worker: WorkerProcess) -> None:
        with self._lock:
            worker.in_flight = max(0, worker.in_flight - 1)

    def _device_inflight_locked(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for w in self.workers:
            counts[w.device_key] = counts.get(w.device_key, 0) + w.in_flight
        return counts

    def _setup_signal_handlers(self) -> None:
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    def _handle_signal(self, signum, frame) -> None:
        log(format_log(self._log_prefix, "收到退出信号，正在关闭子进程..."))
        self.shutdown()
        sys.exit(0)
