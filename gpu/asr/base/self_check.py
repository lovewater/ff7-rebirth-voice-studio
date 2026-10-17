import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict

from base.model import PredictRequest, TTSResponse, TTSResponseOutput
from base.utils import convert_audio_format, trim_audio_to_max_length


def _prepare_audio_input(file_utils, sample_audio: str) -> str:
    sample_audio = sample_audio.strip()
    if sample_audio.startswith("http://") or sample_audio.startswith("https://"):
        return os.path.abspath(file_utils.get_audio_path_by_url(sample_audio))

    if sample_audio.startswith("data:") and ";base64," in sample_audio:
        header, b64_data = sample_audio.split(";base64,", 1)
        content_type = header.replace("data:", "").strip()
        return os.path.abspath(file_utils.save_audio_base64(b64_data, None, content_type))

    if os.path.exists(sample_audio):
        return os.path.abspath(sample_audio)

    return os.path.abspath(file_utils.save_audio_base64(sample_audio, None, "audio/wav"))


def _run_clone(task_id: str, text: str, format_name: str, demo_path: str, config, file_utils, worker_manager) -> Dict[str, Any]:
    output = TTSResponseOutput()
    clone_start = time.perf_counter()

    download_start = time.perf_counter()
    ref_audio_path = _prepare_audio_input(file_utils, demo_path)
    max_len = config.get("tts_params", {}).get("audio_max_length", 20)
    ref_audio_path, _ = trim_audio_to_max_length(ref_audio_path, float(max_len), file_utils)
    output.download_time = time.perf_counter() - download_start

    asr_resp = worker_manager.asr({"task_id": task_id, "sample_audio": ref_audio_path})
    if not asr_resp.get("success"):
        raise RuntimeError(asr_resp.get("message", "ASR 失败"))
    asr_results = asr_resp.get("results") or []
    if not asr_results:
        raise RuntimeError("ASR 未返回结果")
    ref_text = asr_results[0].get("text", "")
    if not ref_text:
        raise RuntimeError("ASR 结果为空")

    clone_resp = worker_manager.clone(
        {
            "task_id": task_id,
            "ref": {"audio": ref_audio_path, "text": ref_text, "language": "Auto"},
            "syn": {"text": text, "language": "Auto"},
        }
    )
    if not clone_resp.get("success"):
        raise RuntimeError(clone_resp.get("message", "克隆失败"))

    clone_result = clone_resp.get("results") or {}
    clone_audio_path = clone_result.get("audio_path")
    if not clone_audio_path:
        raise RuntimeError("克隆结果缺少音频路径")

    output.calc_time = float(asr_resp.get("calc_time", 0.0)) + float(
        clone_resp.get("calc_time", 0.0)
    )

    final_audio_path = convert_audio_format(clone_audio_path, format_name, file_utils)
    output.audio_size = os.path.getsize(final_audio_path) if os.path.exists(final_audio_path) else 0
    output.s3_url = f"/audio/{os.path.basename(final_audio_path)}"
    output.upload_time = 0.0
    output.success = True
    output.message = "Success!"

    total_time = time.perf_counter() - clone_start
    output.wait_time = max(total_time - output.calc_time - output.upload_time, 0.0)

    payload = PredictRequest(
        task_id=task_id,
        vip=0,
        text=text,
        speed=1,
        format=format_name,
        save_file=True,
        sample_audio=demo_path,
        instruct="",
        upload_to_s3=False,
    )
    response = TTSResponse(input=payload.model_dump(), output=output)
    return response.toDict()


def _run_design(task_id: str, text: str, worker_manager) -> None:
    design_resp = worker_manager.design(
        {"task_id": task_id, "instruct": "中年男子的声音", "syn": {"text": text, "language": "Auto"}}
    )
    if not design_resp.get("success"):
        raise RuntimeError(design_resp.get("message", "设计失败"))
    design_result = design_resp.get("results") or {}
    design_audio_path = design_result.get("audio_path")
    if not design_audio_path:
        raise RuntimeError("设计结果缺少音频路径")


def run_self_check(base_dir: str, config, file_utils, worker_manager) -> Dict[str, Any]:
    task_id = "xxx"
    text = "今天真是一个好天气。"
    format_name = "mp3"
    demo_path = os.path.join(base_dir, "demo.wav")
    if not os.path.exists(demo_path):
        raise FileNotFoundError(f"demo.wav 不存在: {demo_path}")

    with ThreadPoolExecutor(max_workers=2) as executor:
        future_clone = executor.submit(_run_clone, task_id, text, format_name, demo_path, config, file_utils, worker_manager)
        future_design = executor.submit(_run_design, task_id, text, worker_manager)
        for future in as_completed([future_clone, future_design]):
            exc = future.exception()
            if exc:
                raise exc

    return future_clone.result()
