import os
import sys
import traceback
import threading
import time

from fastapi import FastAPI
import uvicorn

from qwen_asr import Qwen3ASRModel
from base.config_manager import ConfigManager
from base.fileUtils import FileUtils
from base.gpu_compat import resolve_gpu_runtime_profile
from base.model import AsrRequest, AsrResponse, AsrResult, HealthResponse
from base.reporter import Reporter
from base.server_log import log, format_log
from health import get_health_response

DEFAULT_MODEL_PATH = "/root/autodl-tmp/models/Qwen/Qwen3-ASR-1.7B"
MODEL_PATH = os.getenv("QWEN3_ASR_MODEL_PATH", DEFAULT_MODEL_PATH)
CONFIG_PATH = os.getenv(
    "CONFIG_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
)

app = FastAPI()

_config = None
_file_utils = None
_asr_model = None
_asr_lock = threading.Lock()
_log_prefix = ""
_worker_device = None
_worker_model_path = None


def _get_device_map(config: dict) -> str:
    """从配置中获取ASR设备映射，缺省为auto。"""
    if _worker_device:
        return _worker_device
    if os.getenv("CUDA_VISIBLE_DEVICES"):
        return "cuda:0"
    devices = config.get("devices", {}).get("asr", [])
    if isinstance(devices, list) and devices:
        for device in devices:
            value = str(device).strip()
            if value and not value.startswith(("http://", "https://")):
                return value
    return "auto"


def _init_services() -> None:
    """初始化配置、文件工具和ASR模型（单例）。"""
    global _config, _file_utils, _asr_model, _log_prefix
    if not _log_prefix:
        _log_prefix = os.getenv("WORKER_PREFIX", "asr")
    if _config is None:
        _config = ConfigManager(CONFIG_PATH).get_config()
    if _file_utils is None:
        _file_utils = FileUtils(_config)
    if _asr_model is None:
        device_map = _get_device_map(_config)
        runtime = resolve_gpu_runtime_profile(_config, device_map, "asr_params")
        model_path = _worker_model_path or os.getenv("QWEN3_ASR_MODEL_PATH", DEFAULT_MODEL_PATH)
        cap = ".".join(str(v) for v in runtime.capability) if runtime.capability else "unknown"
        log(
            format_log(
                _log_prefix,
                (
                    f"ASR GPU: name={runtime.device_name or 'unknown'} cc={cap} "
                    f"turing={runtime.is_turing} dtype={runtime.dtype_name} "
                    f"attn={runtime.attn_implementation}"
                ),
            )
        )
        _asr_model = Qwen3ASRModel.from_pretrained(
            model_path,
            dtype=runtime.torch_dtype,
            device_map=device_map,
            attn_implementation=runtime.attn_implementation,
            forced_aligner=None,
            forced_aligner_kwargs=None,
        )


def _prepare_audio_input(sample_audio: str) -> str:
    """解析并缓存输入音频，返回本地绝对路径。"""
    sample_audio = sample_audio.strip()
    if sample_audio.startswith("http://") or sample_audio.startswith("https://"):
        return os.path.abspath(_file_utils.get_audio_path_by_url(sample_audio))

    if sample_audio.startswith("data:") and ";base64," in sample_audio:
        header, b64_data = sample_audio.split(";base64,", 1)
        content_type = header.replace("data:", "").strip()
        return os.path.abspath(_file_utils.save_audio_base64(b64_data, None, content_type))

    if os.path.exists(sample_audio):
        return os.path.abspath(sample_audio)

    try:
        return os.path.abspath(_file_utils.save_audio_base64(sample_audio, None, "audio/wav"))
    except Exception as exc:
        raise ValueError("sample_audio 必须是URL、文件路径或base64音频") from exc


@app.on_event("startup")
def startup_event() -> None:
    """FastAPI 启动时初始化模型与依赖。"""
    _init_services()


@app.post("/asr")
def asr_endpoint(payload: AsrRequest):
    """ASR 推理接口，返回识别结果与音频缓存路径。"""
    try:
        _init_services()
        audio_input = _prepare_audio_input(payload.sample_audio)
        with _asr_lock:
            Reporter().reportProgress(payload.task_id, 10)
            start_time = time.perf_counter()
            results = _asr_model.transcribe(
                audio=audio_input,
                language=payload.language,
                return_time_stamps=False,
            )
            calc_time = time.perf_counter() - start_time
        log(format_log(_log_prefix, f"asr完成，用时{calc_time:.2f}秒，taskid:{payload.task_id}"))
        output = [
            AsrResult(
                text=getattr(r, "text", ""),
                language=getattr(r, "language", None)
            )
            for r in results
        ]
        return AsrResponse(success=True, message="ok", calc_time=calc_time, file_path=audio_input, results=output)
    except Exception as e:
        log(format_log(_log_prefix, f"ASR error: {e}"), stderr=True)
        log(traceback.format_exc(), stderr=True)
        return AsrResponse(success=False, message=str(e), calc_time=0.0, file_path=None, results=[])


@app.get("/health")
def health_endpoint() -> HealthResponse:
    """健康检查接口。"""
    return get_health_response()


def _parse_port() -> int:
    """解析命令行端口参数，未提供则使用默认端口。"""
    if "--port" in sys.argv:
        idx = sys.argv.index("--port")
        if idx + 1 < len(sys.argv):
            try:
                return int(sys.argv[idx + 1])
            except ValueError:
                pass
    if "-p" in sys.argv:
        idx = sys.argv.index("-p")
        if idx + 1 < len(sys.argv):
            try:
                return int(sys.argv[idx + 1])
            except ValueError:
                pass
    if len(sys.argv) >= 2:
        try:
            return int(sys.argv[1])
        except ValueError:
            pass
    return 17000


def _parse_optional_arg(name: str):
    if name in sys.argv:
        idx = sys.argv.index(name)
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    return None


if __name__ == "__main__":
    _worker_device = _parse_optional_arg("--device")
    _worker_model_path = _parse_optional_arg("--model-path")
    config_arg = _parse_optional_arg("--config")
    if config_arg:
        CONFIG_PATH = config_arg
    port = _parse_port()
    uvicorn.run(app, host="0.0.0.0", port=port, access_log=False)
