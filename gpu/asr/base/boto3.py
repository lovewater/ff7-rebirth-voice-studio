import os
from datetime import datetime
import uuid
import mimetypes
import boto3
from botocore.config import Config

class Boto3Client:
    def __init__(self,config:dict):
        self.s3_endpoint_url = config['s3']['s3_endpoint_url']
        self.s3_public_url = config['s3']['s3_public_url']
        self.s3_public_r2_url = config['s3'].get('s3_public_r2_url', '')
        self.prefix = config['s3'].get('prefix', '').strip('/')
        # 创建 boto3 client 时添加代理配置
        s3_config = None
        if config['r2_proxy']['enable']:
            s3_config = Config(
                proxies={
                    'http': config['r2_proxy']['http'],
                    'https': config['r2_proxy']['http']
                }
            )

        s3 = boto3.resource('s3',
            endpoint_url = self.s3_endpoint_url,
            aws_access_key_id = config['s3']['aws_access_key_id'],
            aws_secret_access_key = config['s3']['aws_secret_access_key'],
            config=s3_config
        )

        self.bucket = s3.Bucket(config['s3']['bucket'])

    def _public_url_for_key(self, key: str) -> str:
        key = self._apply_prefix(key)
        base = self.s3_public_r2_url if self.s3_public_r2_url else self.s3_public_url
        return base + key

    def _guess_content_type(self, ext: str, default: str = 'application/octet-stream') -> str:
        ext = (ext or '').lower()
        mapping = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.mp4': 'video/mp4',
            '.wav': 'audio/wav',
            '.mp3': 'audio/mpeg',
            '.flac': 'audio/flac',
            '.ogg': 'audio/ogg',
            '.m4a': 'audio/mp4'
        }
        if ext in mapping:
            return mapping[ext]
        guessed = mimetypes.guess_type(f"file{ext}")[0]
        return guessed or default

    def _apply_prefix(self, key: str) -> str:
        """确保对象Key包含prefix。"""
        if not self.prefix:
            return key
        normalized = key.lstrip('/')
        if normalized.startswith(f"{self.prefix}/"):
            return normalized
        return f"{self.prefix}/{normalized}"

    def object_exists(self, key: str) -> bool:
        try:
            self.bucket.Object(key).load()
            return True
        except Exception:
            return False

    def upload_file(self, file_name: str, content_type: str | None = None):
        year = str(datetime.now().year)
        month = str(datetime.now().month)
        day = str(datetime.now().day)
        ext = os.path.splitext(file_name)[1] or '.jpg'
        key = f"{year}/{month}/{day}/{str(uuid.uuid4())}{ext}"
        key = self._apply_prefix(key)
        final_content_type = content_type or self._guess_content_type(ext, default="image/jpeg")
        extra_args = {"ContentType": final_content_type} if final_content_type else None
        upload_kwargs = {}
        if extra_args:
            upload_kwargs["ExtraArgs"] = extra_args
        self.bucket.upload_file(file_name, key, **upload_kwargs)
        return self._public_url_for_key(key)

    def upload_bytes_to_key(self, data: bytes, key: str, content_type: str | None = None) -> str:
        key = self._apply_prefix(key)
        final_content_type = content_type or self._guess_content_type(os.path.splitext(key)[1])
        put_kwargs = {"Key": key, "Body": data}
        if final_content_type:
            put_kwargs["ContentType"] = final_content_type
        self.bucket.put_object(**put_kwargs)
        return self._public_url_for_key(key)

    def upload_file_to_key(self, file_path: str, key: str, content_type: str | None = None) -> str:
        key = self._apply_prefix(key)
        ext = os.path.splitext(file_path)[1]
        final_content_type = content_type or self._guess_content_type(ext)
        extra_args = {"ContentType": final_content_type} if final_content_type else None
        upload_kwargs = {}
        if extra_args:
            upload_kwargs["ExtraArgs"] = extra_args
        self.bucket.upload_file(file_path, key, **upload_kwargs)
        return self._public_url_for_key(key)

    def get_public_url(self, key: str) -> str:
        return self._public_url_for_key(key)

    def delete_file_by_url(self, url: str):
        # 将公开URL转换为对象key
        key = None
        if url.startswith(self.s3_public_url):
            key = url[len(self.s3_public_url):]
        elif self.s3_public_r2_url and url.startswith(self.s3_public_r2_url):
            key = url[len(self.s3_public_r2_url):]
        else:
            # 兜底：按路径截取
            try:
                from urllib.parse import urlparse
                p = urlparse(url)
                key = p.path.lstrip('/')
            except Exception:
                key = None
        if not key:
            return False
        obj = self.bucket.Object(key)
        obj.delete()
        return True
