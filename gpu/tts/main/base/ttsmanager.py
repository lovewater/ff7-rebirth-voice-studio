import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from base.path_utils import ensure_project_paths, project_root

ensure_project_paths()

from base.config_manager import ConfigManager
from indextts.infer_v2_5 import IndexTTS2
from base.remote_index_tts2 import RemoteIndexTTS2
from base.task_queue import InferenceTask, InferenceTaskQueue
from base.utils import logger

_PROJECT_ROOT = project_root()
_TTS_BASE_DIR = _PROJECT_ROOT / "tts_base"


class TTSManager:
    """
    管理本地/远程的 IndexTTS2 推理实例，并通过生产者-消费者队列并发执行 forward。
    """

    _instance: Optional["TTSManager"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._model: Optional[IndexTTS2] = None
        self._lock = threading.Lock()  # 保留兼容性
        self._init_lock = threading.Lock()

        self._remote_infers: List[RemoteIndexTTS2] = []
        self._remote_loaded = False

        self._task_queue = InferenceTaskQueue()
        self._worker_threads: List[threading.Thread] = []
        self._stop_event = threading.Event()
        self._workers_started = False

    @classmethod
    def get_instance(cls) -> "TTSManager":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = TTSManager()
        return cls._instance

    # ---------------- 本地模型初始化 ---------------- #
    def initialize(
        self,
        cfg_path: Optional[str] = None,
        model_dir: Optional[str] = None,
    ) -> IndexTTS2:
        """初始化（或返回已存在）IndexTTS 2.5 实例。"""
        with self._init_lock:
            if self._model is not None:
                return self._model

            # 从配置获取模型根目录
            model_root = None
            try:
                cm = ConfigManager()
                model_root = cm.get_model_path()
            except Exception:
                model_root = None

            if model_dir is None:
                if isinstance(model_root, dict):
                    model_dir = model_root.get("tts") or next(iter(model_root.values()), None)
                elif isinstance(model_root, str) and model_root:
                    model_dir = model_root

            # 兜底：项目自带 checkpoints
            if not model_dir:
                model_dir = str(_TTS_BASE_DIR / "checkpoints")

            if cfg_path is None:
                cfg_path = os.path.join(model_dir, "config.yaml")

            import torch

            # ROCm gfx1201 currently selects an SDPA kernel that raises
            # hipErrorInvalidValue. The math backend is slower but correct;
            # NVIDIA keeps PyTorch's default backend selection.
            if os.getenv("INDEXTTS_SDPA_BACKEND", "").strip().lower() == "math":
                torch.backends.cuda.enable_flash_sdp(False)
                torch.backends.cuda.enable_mem_efficient_sdp(False)
                torch.backends.cuda.enable_math_sdp(True)

            final_device = "cuda:0"
            cap = torch.cuda.get_device_capability(0) if torch.cuda.is_available() else (0, 0)
            precision_mode = os.getenv("INDEXTTS_PRECISION", "auto").strip().lower()
            if precision_mode not in {"auto", "fp32", "fp16", "bf16"}:
                raise ValueError(
                    "INDEXTTS_PRECISION must be one of auto, fp32, fp16, bf16; "
                    f"got {precision_mode!r}"
                )

            native_bf16 = False
            if torch.cuda.is_available():
                try:
                    native_bf16 = torch.cuda.is_bf16_supported(including_emulation=False)
                except TypeError:
                    native_bf16 = cap[0] >= 8

            if precision_mode == "auto":
                if native_bf16:
                    runtime_precision = "bf16"
                elif torch.cuda.is_available():
                    runtime_precision = "fp16"
                else:
                    runtime_precision = "fp32"
            else:
                runtime_precision = precision_mode

            use_bf16 = runtime_precision == "bf16"
            logger.info(
                f"[TTSManager] 初始化 IndexTTS2.5: cfg={cfg_path}, model_dir={model_dir}, "
                f"precision={runtime_precision}, native_bf16={native_bf16}, "
                f"device={final_device}, cc={cap}"
            )
            self._model = IndexTTS2(
                cfg_path=cfg_path,
                model_dir=model_dir,
                use_bf16=use_bf16,
                device=final_device,
                use_cuda_kernel=False,
                use_deepspeed=False,
                use_qwen_emo=False,
            )
            if runtime_precision == "fp16":
                # IndexTTS controls autocast through this runtime dtype. Keep
                # the stored weights in FP32 and run inference kernels in FP16.
                self._model.dtype = torch.float16
            elif runtime_precision == "fp32":
                self._model.dtype = None
            self._model.runtime_precision = runtime_precision
            logger.info(f"[TTSManager] IndexTTS2.5 precision={runtime_precision}")
            return self._model

    def get_infer(self, name: str = "default") -> IndexTTS2:
        """获取推理实例；若不存在则按默认参数初始化。name参数保留兼容性但不使用。"""
        if self._model is not None:
            return self._model
        # 懒加载
        return self.initialize()

    def get_lock(self, name: str = "default") -> threading.Lock:
        """获取推理实例的线程锁。name参数保留兼容性但不使用。"""
        return self._lock

    def list_models(self) -> Dict[str, str]:
        """返回已加载模型的设备信息。"""
        if self._model is not None:
            try:
                device = getattr(self._model, "device", "cuda")
                return {"default": device}
            except Exception:
                return {"default": "cuda"}
        return {}

    # ---------------- 远程设备管理 ---------------- #
    def _load_remote_infers(self) -> None:
        if self._remote_loaded:
            return
        self._remote_loaded = True

        try:
            configs = ConfigManager().remote_devices_config()
        except Exception as err:
            logger.warning(f"[TTSManager] 读取远程设备配置失败: {err}")
            return

        for idx, cfg in enumerate(configs):
            url = cfg.get("url")
            if not url:
                logger.warning(f"[TTSManager] 忽略无效远程设备配置: {cfg}")
                continue
            name = cfg.get("name") or f"remote-{idx}-{url}"
            timeout = float(cfg.get("timeout", 300))
            self._remote_infers.append(RemoteIndexTTS2(base_url=url, name=name, timeout=timeout))
        if self._remote_infers:
            logger.info(f"[TTSManager] 已加载 {len(self._remote_infers)} 个远程推理节点")

    def _all_infers(self) -> List[Any]:
        # 确保本地模型和远程节点加载完毕
        local = self.get_infer()
        self._load_remote_infers()
        return [local] + list(self._remote_infers)

    def available_infer_count(self) -> int:
        """返回可用的 IndexTTS 数量（含本地+远程）。"""
        count = 0
        for infer in self._all_infers():
            if self._is_infer_available(infer):
                count += 1
        return count

    # ---------------- 任务队列/消费者 ---------------- #
    def _ensure_workers(self) -> None:
        if self._workers_started:
            return
        self._workers_started = True

        for idx, infer in enumerate(self._all_infers()):
            name = "local" if isinstance(infer, CustomIndexTTS2) else getattr(infer, "name", f"worker-{idx}")
            t = threading.Thread(target=self._worker_loop, args=(infer, name), daemon=True)
            t.start()
            self._worker_threads.append(t)

    def _is_infer_available(self, infer: Any) -> bool:
        available_fn = getattr(infer, "is_available", None)
        if callable(available_fn):
            try:
                return bool(available_fn())
            except Exception as err:
                logger.warning(f"[TTSManager] 检查可用性失败: {err}")
                return False
        return True

    def _normalize_forward_result(self, result: Any) -> Tuple[float, Any]:
        if isinstance(result, tuple) and len(result) == 2:
            return result[0], result[1]
        return 0.0, result

    def _worker_loop(self, infer: Any, name: str) -> None:
        while not self._stop_event.is_set():
            task = self._task_queue.get(timeout=0.5)
            if task is None:
                continue
            if task.cancelled or task.done:
                continue

            if not self._is_infer_available(infer):
                # 暂不可用，重新排到队尾并稍作等待
                self._task_queue.put(task)
                time.sleep(0.1)
                continue

            try:
                forward_result = infer.forward(task.segment, *task.prepare_result, **task.generation_kwargs)
                wait_time, wav = self._normalize_forward_result(forward_result)
                task.mark_success(wait_time, wav)
            except Exception as err:
                logger.error(f"[TTSManager][{name}] forward 失败: {err}")
                task.mark_failure(err)
                if not task.cancelled:
                    self._task_queue.put_front(task)
                time.sleep(0.1)

    def submit_task(
        self, segment: Any, prepare_result: Any, generation_kwargs: Optional[Dict[str, Any]] = None
    ) -> InferenceTask:
        """将任务加入队尾并返回任务对象。"""
        self._ensure_workers()
        task = InferenceTask(segment=segment, prepare_result=prepare_result, generation_kwargs=generation_kwargs)
        self._task_queue.put(task)
        return task

    def predict(
        self, segment: Any, prepare_result: Any, generation_kwargs: Optional[Dict[str, Any]] = None, timeout: float = 300.0
    ) -> Tuple[float, Any]:
        """
        同步预测：创建任务并等待完成，超过5分钟（默认）返回超时错误。
        """
        task = self.submit_task(segment, prepare_result, generation_kwargs)
        finished = task.wait(timeout=timeout)
        if not finished or task.result is None:
            task.cancel()
            if task.error:
                raise TimeoutError(f"预测超时或失败: {task.error}")
            raise TimeoutError("预测超时，未能在限定时间内完成")
        return task.wait_time, task.result

    # ---------------- 资源清理 ---------------- #
    def unload(self, name: str = "default") -> bool:
        """卸载模型实例。name参数保留兼容性但不使用。"""
        with self._init_lock:
            if self._model is not None:
                try:
                    self._model = None
                    return True
                except Exception as e:
                    logger.warning(f"[TTSManager] 卸载实例失败: err={e}")
            return False

    def clear(self) -> None:
        """卸载模型实例。"""
        with self._init_lock:
            self._model = None
