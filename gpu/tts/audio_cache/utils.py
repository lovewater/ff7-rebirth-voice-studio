from dataclasses import dataclass, field
import os
import re
import io
import traceback
import requests
import base64
import hashlib
import numpy as np
import time
from typing import Any, Dict, Generic, Optional, Tuple, TypeVar
from base.utils import get_http_proxy, logger, convert_audio_ffmpeg, get_sample_rate

    # 定义泛型类型，用于缓存项
T = TypeVar('T')

@dataclass
class CacheItem(Generic[T]):
    """缓存项结构体，包含数据、键、创建时间、更新时间和大小"""
    data: T
    key: str
    created_at: float
    updated_at: float = field(default_factory=time.time)
    size: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def update_access_time(self):
        """更新访问时间"""
        self.updated_at = time.time()

def format_size(size_bytes: int) -> str:
    """
    格式化字节大小为可读字符串

    Args:
        size_bytes: 字节大小

    Returns:
        str: 格式化后的字符串，如 "1.50MB"
    """
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024 or unit == 'TB':
            return f"{size_bytes:.2f}{unit}"
        size_bytes /= 1024

def parse_size_limit(size_str: str) -> int:
    """
    解析大小限制字符串为字节数

    Args:
        size_str: 大小字符串，如 "500MB", "2GB"

    Returns:
        int: 字节数
    """
    # 默认值 500MB
    default_bytes = 500 * 1024 * 1024

    if not isinstance(size_str, str):
        return default_bytes

    # 匹配数字和单位
    match = re.match(r'^(\d+(?:\.\d+)?)\s*([KMGT]?B)$', size_str, re.IGNORECASE)
    if not match:
        logger.warning(f"无效的大小限制格式: {size_str}，使用默认值 500MB")
        return default_bytes

    value, unit = match.groups()
    value = float(value)
    unit = unit.upper()

    # 转换为字节
    if unit == 'B':
        return int(value)
    elif unit == 'KB':
        return int(value * 1024)
    elif unit == 'MB':
        return int(value * 1024 * 1024)
    elif unit == 'GB':
        return int(value * 1024 * 1024 * 1024)
    elif unit == 'TB':
        return int(value * 1024 * 1024 * 1024 * 1024)
    else:
        logger.warning(f"未知的大小单位: {unit}，使用默认值 500MB")
        return default_bytes

def download_audio_from_url(url: str):
    """
    从URL下载音频数据

    Args:
        url: 音频URL

    Returns:
        处理后的音频数据、大小和是否被截断的标志
    """
    try:
        proxy = get_http_proxy()
        print(f'代理配置: {proxy}')
        # 使用代理配置
        response = requests.get(url, proxies=proxy)
        response.raise_for_status()
        audio_data = response.content

        # 从URL中提取格式
        format = None
        if '.' in url:
            ext = url.split('.')[-1].lower()
            if ext in ['mp3', 'wav', 'ogg', 'flac']:
                format = ext

        processed_data, is_truncated = convert_audio_ffmpeg(audio_data, format, sample_rate=get_sample_rate(), channels=1)
        return processed_data, len(processed_data), is_truncated
    except Exception as e:
        logger.error(f"下载音频失败: {url}, 错误: {e}")
        raise

def process_audio_from_base64(base64_data: str) -> Tuple[bytes, int, bool]:
    """
    从base64数据处理音频

    Args:
        base64_data: base64编码的音频数据

    Returns:
        Tuple[bytes, int, bool]: 处理后的音频数据、大小和是否被截断的标志

    Raises:
        ValueError: 如果解码或处理失败
    """
    try:
        # 从base64数据中提取MIME类型
        format = None
        mime_match = re.match(r'^data:(audio/[^;]+);base64,', base64_data)
        if mime_match:
            mime_type = mime_match.group(1)
            if 'mp3' in mime_type:
                format = 'mp3'
            elif 'wav' in mime_type:
                format = 'wav'
            elif 'ogg' in mime_type:
                format = 'ogg'
            elif 'flac' in mime_type:
                format = 'flac'

        audio_data = base64.b64decode(base64_data.split(',')[1])
        processed_data, is_truncated = convert_audio_ffmpeg(audio_data, format, sample_rate=get_sample_rate(), channels=1)
        return processed_data, len(processed_data), is_truncated
    except Exception as e:
        raise ValueError(f"解码或处理base64音频失败: {str(e)}")

def process_audio_from_file(file_path: str) -> Tuple[bytes, int, bool]:
    """
    从文件处理音频

    Args:
        file_path: 音频文件路径

    Returns:
        Tuple[bytes, int, bool]: 处理后的音频数据、大小和是否被截断的标志

    Raises:
        ValueError: 如果读取或处理失败
    """
    try:
        # 从文件路径提取格式
        format = None
        if '.' in file_path:
            ext = file_path.split('.')[-1].lower()
            if ext in ['mp3', 'wav', 'ogg', 'flac']:
                format = ext

        with open(file_path, 'rb') as f:
            audio_data = f.read()
        processed_data, is_truncated = convert_audio_ffmpeg(audio_data, format, sample_rate=get_sample_rate(), channels=1)
        return processed_data, len(processed_data), is_truncated
    except Exception as e:
        raise ValueError(f"读取或处理本地音频文件失败: {str(e)}")

def get_cache_key(text: str, additional_data: str = "") -> str:
    """
    生成缓存键

    Args:
        text: 主要文本
        additional_data: 附加数据

    Returns:
        str: 生成的缓存键
    """
    combined = f"{text}-{additional_data}"
    return hashlib.md5(combined.encode()).hexdigest()
