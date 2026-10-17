import os
import subprocess
from typing import Dict, Optional, Tuple

from base.config_manager import ConfigManager


def get_http_proxy() -> Optional[Dict[str, str]]:
    """
    Build proxy configuration for HTTP requests based on r2_proxy settings.
    """
    cfg = ConfigManager().get_config()
    proxy_cfg = cfg.get("r2_proxy", {}) if isinstance(cfg, dict) else {}
    if proxy_cfg.get("enable"):
        proxy_url = proxy_cfg.get("http") or proxy_cfg.get("http")
        if proxy_url:
            return {"http": proxy_url, "http": proxy_url}
    return None


def get_audio_duration(audio_path: str) -> float:
    """使用 ffprobe 获取音频时长（秒）。"""
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"音频文件不存在: {audio_path}")
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {result.stderr.strip()}")
    try:
        return float(result.stdout.strip())
    except Exception as exc:
        raise RuntimeError(f"解析音频时长失败: {result.stdout.strip()}") from exc


def trim_audio_to_max_length(audio_path: str, max_length: float, file_utils) -> Tuple[str, bool]:
    """超过最大时长则截断音频，返回处理后的路径与是否截断。"""
    duration = get_audio_duration(audio_path)
    if duration <= max_length:
        return audio_path, False

    ext = os.path.splitext(audio_path)[1].lstrip(".") or "wav"
    output_path = file_utils.create_audio_cache_path(ext)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        audio_path,
        "-t",
        str(max_length),
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 截断失败: {result.stderr.strip()}")
    return output_path, True


def convert_audio_format(audio_path: str, target_format: str, file_utils) -> str:
    """将音频转为目标格式并返回新路径。"""
    ext = (target_format or "").lstrip(".") or "wav"
    output_path = file_utils.create_audio_cache_path(ext)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        audio_path,
    ]
    if ext.lower() == "mp3":
        # 固定 256kbps 码率，提升稳定听感与兼容性
        #cmd += ["-c:a", "libmp3lame", "-b:a", "256k"]
        # 使用最高 VBR 档位，尽量接近无损的听感
        cmd += ["-c:a", "libmp3lame", "-q:a", "1"]
    cmd.append(output_path)
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 转码失败: {result.stderr.strip()}")
    return output_path
