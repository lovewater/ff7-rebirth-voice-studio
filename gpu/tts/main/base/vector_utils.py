import io
import base64
import torch
from typing import Any, List, Union, Tuple
import logging

logger = logging.getLogger(__name__)


class VectorSerializer:
    """向量序列化/反序列化工具类，用于PyTorch张量和其他数据的序列化"""

    @staticmethod
    def serialize_to_bytes(data: Any) -> bytes:
        """
        将数据序列化为字节

        Args:
            data: 要序列化的数据（通常是PyTorch张量或张量元组）

        Returns:
            bytes: 序列化后的字节数据
        """
        try:
            buffer = io.BytesIO()
            torch.save(data, buffer)
            return buffer.getvalue()
        except Exception as e:
            logger.error(f"序列化失败: {e}")
            raise ValueError(f"序列化失败: {e}")

    @staticmethod
    def deserialize_from_bytes(data_bytes: bytes) -> Any:
        """
        从字节数据反序列化

        Args:
            data_bytes: 序列化的字节数据

        Returns:
            Any: 反序列化后的数据
        """
        try:
            buffer = io.BytesIO(data_bytes)
            return torch.load(buffer, map_location='cpu')  # 先加载到CPU
        except Exception as e:
            logger.error(f"反序列化失败: {e}")
            raise ValueError(f"反序列化失败: {e}")

    @staticmethod
    def serialize_to_base64(data: Any) -> str:
        """
        将数据序列化为base64字符串

        Args:
            data: 要序列化的数据

        Returns:
            str: base64编码的字符串
        """
        data_bytes = VectorSerializer.serialize_to_bytes(data)
        return base64.b64encode(data_bytes).decode('utf-8')

    @staticmethod
    def deserialize_from_base64(data_b64: str) -> Any:
        """
        从base64字符串反序列化

        Args:
            data_b64: base64编码的字符串

        Returns:
            Any: 反序列化后的数据
        """
        try:
            data_bytes = base64.b64decode(data_b64.encode('utf-8'))
            return VectorSerializer.deserialize_from_bytes(data_bytes)
        except Exception as e:
            logger.error(f"base64反序列化失败: {e}")
            raise ValueError(f"base64反序列化失败: {e}")

    @staticmethod
    def move_to_device(data: Any, device: str = "cuda") -> Any:
        """
        将张量数据移动到指定设备

        Args:
            data: 数据（张量、张量列表、张量元组等）
            device: 目标设备

        Returns:
            Any: 移动到目标设备后的数据
        """
        try:
            if isinstance(data, torch.Tensor):
                return data.to(device)
            elif isinstance(data, (list, tuple)):
                result = []
                for item in data:
                    if isinstance(item, torch.Tensor):
                        result.append(item.to(device))
                    else:
                        result.append(item)
                return type(data)(result)  # 保持原来的类型（list或tuple）
            else:
                return data
        except Exception as e:
            logger.error(f"移动到设备{device}失败: {e}")
            raise ValueError(f"移动到设备{device}失败: {e}")
