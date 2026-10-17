import io
import os
import traceback
from typing import Dict, Optional, Tuple

import requests
import soundfile as sf
from base.config_manager import ConfigManager

import numpy as np
import uuid
import subprocess
import tempfile

def get_http_proxy() -> Optional[Dict[str, str]]:
    """
    获取HTTP代理配置

    Returns:
        代理配置字典，如果未启用则返回None
    """
    config_manager = ConfigManager()
    proxy_config = config_manager.get_proxy_config()

    if proxy_config.get("enable", False):
        proxy_url = proxy_config.get("url", "")
        if proxy_url:
            return {
                "http": proxy_url,
                "https": proxy_url
            }
    return None


import logging

def setup_logger():
    """设置日志记录器"""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    return logging.getLogger("tts-api")


logger = setup_logger()

def download_audio(url: str) -> Tuple[bytes, int, bool]:
    """
    从URL下载音频数据

    Args:
        url: 音频URL

    Returns:
        Tuple[bytes, int, bool]: 处理后的音频数据、大小和是否被截断的标志
    """
    retry_count = 0
    max_retries = 4  # 改为最多重试4次
    timeout = 20  # 设置超时时间为20秒

    while retry_count < max_retries:
        try:
            # 偶数次重试(retry_count为奇数)不使用代理
            if retry_count % 2 == 1:
                proxy = None
            else:
                proxy = get_http_proxy()

            # 使用代理配置
            response = requests.get(url, proxies=proxy, timeout=timeout)
            response.raise_for_status()
            audio_data = response.content

            # 从URL中提取格式
            format = None
            if '.' in url:
                ext = url.split('.')[-1].lower()
                if ext in ['mp3', 'wav', 'ogg', 'flac']:
                    format = ext

            # 处理音频格式
            processed_data, is_truncated = convert_audio_ffmpeg(
                audio_data=audio_data,
                format=format,
                sample_rate=get_sample_rate(),
                channels=1
            )
            return processed_data, len(processed_data), is_truncated
        except Exception as e:
            retry_count += 1
            if retry_count >= max_retries:
                logger.error(f"下载音频失败: {url}, 错误: {e}, 已重试{max_retries}次")
                raise
            else:
                logger.warning(f"下载音频失败: {url}, 错误: {e}, 正在进行第{retry_count}次重试")

def convert_audio_ffmpeg(audio_data: bytes, format: str = None, sample_rate: int = 16000,
                         channels: int = 1) -> Tuple[bytes, bool]:
    """
    使用ffmpeg将音频转换为指定格式、采样率和声道数

    Args:
        audio_data: 原始音频数据
        format: 输入音频格式（可选，如'mp3'，'wav'等）
        sample_rate: 目标采样率，默认16000Hz
        channels: 目标声道数，默认1（单声道）

    Returns:
        Tuple[bytes, bool]: 处理后的音频数据和是否被截断的标志

    Raises:
        ValueError: 如果音频处理失败
    """
    try:
        # 获取临时文件夹配置
        tmp_folder_config = ConfigManager().get_tmp_folder_config()
        tmp_dir = tmp_folder_config.get("path", "./tmp_files") if tmp_folder_config.get("enable", True) else None

        # 确保临时目录存在
        if tmp_dir and not os.path.exists(tmp_dir):
            os.makedirs(tmp_dir, exist_ok=True)

        # 生成唯一文件名
        unique_id_in = str(uuid.uuid4())
        unique_id_out = str(uuid.uuid4())

        # 创建临时文件来保存音频数据
        if tmp_dir:
            temp_in_path = os.path.join(tmp_dir, f"{unique_id_in}{f'.{format}' if format else '.audio'}")
            with open(temp_in_path, 'wb') as temp_in:
                temp_in.write(audio_data)
        else:
            with tempfile.NamedTemporaryFile(suffix=f'.{format}' if format else '.audio', delete=False) as temp_in:
                temp_in.write(audio_data)
                temp_in_path = temp_in.name

        # 创建临时文件来保存转换后的WAV数据
        temp_out_path = os.path.join(os.path.dirname(temp_in_path), f"{unique_id_out}.wav")

        # 使用ffmpeg将音频转换为指定采样率和声道的WAV
        try:
            # 执行ffmpeg命令
            cmd = [
                'ffmpeg',
                '-y',  # 覆盖输出文件
                '-i', temp_in_path,  # 输入文件
                '-ar', str(sample_rate),  # 设置采样率
                '-ac', str(channels),  # 设置声道数
                '-f', 'wav',  # 输出格式为wav
                temp_out_path  # 输出文件路径
            ]

            # 打印完整命令
            cmd_str = ' '.join(cmd)
            logger.info(f"执行ffmpeg命令: {cmd_str}")
            logger.info(f"临时文件信息: 输入={temp_in_path}({os.path.exists(temp_in_path)}, {os.path.getsize(temp_in_path) if os.path.exists(temp_in_path) else 0}字节), 输出={temp_out_path}")

            # 执行命令，捕获输出
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            _, stderr = process.communicate()

            if process.returncode != 0:
                logger.error(f"ffmpeg转换失败: {stderr.decode('utf-8', errors='replace')}")
                raise ValueError(f"ffmpeg转换失败，返回码: {process.returncode}")

            # 读取转换后的WAV文件
            with open(temp_out_path, 'rb') as f:
                converted_audio_data = f.read()

            # 使用soundfile解析WAV数据，以便进行后续处理
            with io.BytesIO(converted_audio_data) as audio_buffer:
                waveform, sr = sf.read(audio_buffer)

            # 验证音频数据有效性
            if waveform.size == 0:
                raise ValueError("音频数据为空")

            # 确保音频是float32类型
            samples = np.array(waveform, dtype=np.float32)

            # 验证音频数据有效性，确保没有NaN或无穷大的值
            if not np.all(np.isfinite(samples)):
                logger.warning("音频包含NaN或无穷大的值，将替换为0")
                samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)

            # 确保音频长度足够，至少有1秒
            min_length = sample_rate  # 最少1秒音频
            if len(samples) < min_length:
                logger.warning(f"音频过短 ({len(samples)} 样本)，将填充至 {min_length} 样本")
                padded_samples = np.zeros(min_length, dtype=np.float32)
                padded_samples[:len(samples)] = samples
                samples = padded_samples

            # 如果音频太长，进行裁剪
            max_length = int(9.9 * sample_rate)
            is_truncated = False
            if len(samples) > max_length:
                logger.warning(f"音频过长 ({len(samples)/sample_rate:.2f} 秒)，将裁剪至 10 秒")
                samples = samples[:max_length]
                is_truncated = True

            # 将处理后的音频数据保存为bytes
            output_buffer = io.BytesIO()
            sf.write(output_buffer, samples, sample_rate, format='WAV')
            output_buffer.seek(0)
            processed_audio_data = output_buffer.read()

            # 清理临时文件
            try:
                if os.path.exists(temp_in_path):
                    os.remove(temp_in_path)
                if os.path.exists(temp_out_path):
                    os.remove(temp_out_path)
            except Exception as e:
                logger.warning(f"清理临时文件失败: {e}")

            return processed_audio_data, is_truncated

        except Exception as e:
            # 清理临时文件
            try:
                if os.path.exists(temp_in_path):
                    os.remove(temp_in_path)
                if os.path.exists(temp_out_path):
                    os.remove(temp_out_path)
            except:
                pass
            raise e

    except Exception as e:
        traceback.print_exc()
        raise ValueError(f"处理音频格式失败: {e}")


def get_sample_rate() -> int:
    """获取采样率"""
    return 24000
def get_result_sample_rate() -> int:
    """获取结果采样率"""
    return 24000

def convert_audio_format(input_path: str, output_path: str, target_format: str) -> bool:
    """
    使用ffmpeg转换音频格式

    Args:
        input_path: 输入文件路径
        output_path: 输出文件路径
        target_format: 目标格式 ('wav' 或 'mp3')

    Returns:
        bool: 转换是否成功
    """
    try:
        cmd = [
            'ffmpeg',
            '-y',  # 覆盖输出文件
            '-i', input_path,  # 输入文件
            '-f', target_format,  # 输出格式
        ]

        if target_format == 'mp3':
            cmd.extend(['-codec:a', 'libmp3lame', '-b:a', '128k'])

        cmd.append(output_path)

        # 执行命令
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        _, stderr = process.communicate()

        if process.returncode != 0:
            logger.error(f"音频格式转换失败: {stderr.decode('utf-8', errors='replace')}")
            return False

        return True
    except Exception as e:
        logger.error(f"音频格式转换异常: {e}")
        return False
