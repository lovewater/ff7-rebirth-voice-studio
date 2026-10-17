import os
import time
import uuid
import fnmatch
import base64
import hashlib
import mimetypes
from typing import Optional, Tuple
from urllib.parse import urlparse

import requests
from requests.exceptions import RequestException


class FileUtils:
    def __init__(self, config: dict):
        """初始化文件缓存与代理配置。"""
        self.cache_path = config["file_utils"]["cache_path"]
        self.file_expire_time = config["file_utils"]["file_expire_time"]
        self.r2_proxy = config.get(
            "r2_proxy",
            {"enable": False, "http": "", "ignore": []},
        )
        self.audio_cache = {}

        # 清理缓存目录
        if os.path.exists(self.cache_path):
            for file in os.listdir(self.cache_path):
                os.remove(os.path.join(self.cache_path, file))
        os.makedirs(self.cache_path, exist_ok=True)

    def _should_ignore_proxy(self, url: str) -> bool:
        """
        检查URL是否应该忽略代理
        根据r2_proxy配置中的ignore数组进行匹配，使用gitignore风格的模式匹配
        """
        if "ignore" not in self.r2_proxy or not self.r2_proxy["ignore"]:
            return False

        try:
            parsed_url = urlparse(url)
            hostname = parsed_url.hostname
            if not hostname:
                return False

            for pattern in self.r2_proxy["ignore"]:
                if fnmatch.fnmatch(hostname, pattern):
                    print(f"URL {url} 的域名 {hostname} 匹配忽略模式 {pattern}，不使用代理")
                    return True

            return False
        except Exception as e:
            print(f"检查URL代理忽略时出错: {e}")
            return False

    def delete_old_files(self) -> None:
        """清理过期缓存文件。"""
        current_time = time.time()
        expired_files = []
        for filename, info in self.audio_cache.items():
            if current_time - info["create_time"] >= self.file_expire_time:
                expired_files.append(filename)
                file_path = info["path"]
                if os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except Exception:
                        pass

        for filename in expired_files:
            del self.audio_cache[filename]

    def get_request_kwargs(self, url: str) -> dict:
        """根据代理配置生成请求参数。"""
        request_kwargs = {"timeout": 30}
        should_ignore_proxy = self._should_ignore_proxy(url)
        if self.r2_proxy.get("enable") and not should_ignore_proxy:
            request_kwargs["proxies"] = {
                "http": self.r2_proxy.get("http", ""),
                "https": self.r2_proxy.get("http", ""),
            }
        return request_kwargs

    def _filename_from_url(self, url: str) -> str:
        """从URL解析文件名。"""
        parsed_url = urlparse(url)
        filename = os.path.basename(parsed_url.path)
        return filename

    def _guess_extension(self, filename: str, content_type: Optional[str]) -> str:
        """根据文件名或Content-Type推断扩展名。"""
        if filename:
            ext = os.path.splitext(filename)[1].lstrip(".")
            if ext:
                return ext
        if content_type:
            ext = mimetypes.guess_extension(content_type.split(";")[0].strip())
            if ext:
                return ext.lstrip(".")
        return "bin"

    def _save_bytes(self, data: bytes, filename: str) -> Tuple[str, str, int]:
        """保存二进制数据到缓存目录。"""
        file_path = os.path.join(self.cache_path, filename)
        with open(file_path, "wb") as file:
            file.write(data)
        self.audio_cache[filename] = {"path": file_path, "create_time": time.time()}
        return filename, file_path, len(data)

    def save_audio_bytes(self, data: bytes, filename: Optional[str], content_type: Optional[str]) -> str:
        """保存音频字节并返回本地路径。"""
        self.delete_old_files()
        if not filename:
            ext = self._guess_extension(filename, content_type)
            filename = f"{uuid.uuid4()}.{ext}"
        self._save_bytes(data, filename)
        return os.path.join(self.cache_path, filename)

    def save_audio_base64(self, b64_data: str, filename: Optional[str], content_type: Optional[str]) -> str:
        """保存base64音频并返回本地路径。"""
        try:
            audio_bytes = base64.b64decode(b64_data, validate=True)
        except Exception as exc:
            raise ValueError("base64 解码失败") from exc
        return self.save_audio_bytes(audio_bytes, filename, content_type)

    def create_audio_cache_path(self, ext: str = "wav") -> str:
        """生成缓存音频文件路径并登记到缓存。"""
        self.delete_old_files()
        ext = ext.lstrip(".") or "wav"
        filename = f"{hashlib.md5(os.urandom(16)).hexdigest()}.{ext}"
        file_path = os.path.join(self.cache_path, filename)
        self.audio_cache[filename] = {"path": file_path, "create_time": time.time()}
        return file_path

    def register_audio_file(self, file_path: str) -> str:
        """将已有音频文件登记到缓存。"""
        filename = os.path.basename(file_path)
        self.audio_cache[filename] = {"path": file_path, "create_time": time.time()}
        return file_path

    def get_audio_path_by_url(self, url: str) -> str:
        """
        从URL获取音频文件路径：
        1. 先从缓存中查找
        2. 如果缓存中没有，则下载并缓存
        """
        self.delete_old_files()
        try:
            filename = self._filename_from_url(url)
            if filename and filename in self.audio_cache:
                self.audio_cache[filename]["create_time"] = time.time()
                audio_path = self.audio_cache[filename]["path"]
                if os.path.exists(audio_path):
                    print(f"从缓存中加载音频: {filename}")
                    return audio_path

            response = requests.get(url, **self.get_request_kwargs(url))
            response.raise_for_status()
            audio_bytes = response.content
            content_type = response.headers.get("content-type")

            print(f"从网络中下载音频: {filename}")
            return self.save_audio_bytes(audio_bytes, filename, content_type)
        except (RequestException, IOError) as e:
            print(f"Error downloading audio from url: {e}")
            raise
        except Exception as e:
            print(f"Error processing audio url: {e}")
            raise
