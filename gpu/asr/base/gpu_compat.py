from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import torch


@dataclass(frozen=True)
class GpuRuntimeProfile:
    device: str
    device_index: int
    device_name: str
    capability: tuple[int, int] | None
    is_turing: bool
    dtype_name: str
    torch_dtype: torch.dtype
    attn_implementation: str


def resolve_gpu_runtime_profile(config: dict[str, Any], device_map: str, section: str) -> GpuRuntimeProfile:
    """按 GPU 架构选择 Qwen 运行参数。

    NVIDIA 官方 CUDA GPU 表把图灵核心产品列为 compute capability 7.5。
    这里不按商品名判断，避免把 RTX A2000 这类 Ampere 卡误判成图灵。
    """
    params = config.get(section, {}) if isinstance(config.get(section, {}), dict) else {}
    device_index = cuda_device_index(device_map)
    device_name = ""
    capability = None
    if torch.cuda.is_available() and device_index >= 0:
        device_name = torch.cuda.get_device_name(device_index)
        capability = torch.cuda.get_device_capability(device_index)
    is_turing = capability == (7, 5)

    default_dtype = "float16" if is_turing else "bfloat16"
    default_attn = "sdpa" if is_turing else "flash_attention_2"
    dtype_name = normalized_dtype_name(params.get("dtype", "auto"), default_dtype)
    attn_implementation = str(params.get("attn_implementation") or "auto").strip()
    if not attn_implementation or attn_implementation.lower() == "auto":
        attn_implementation = default_attn

    return GpuRuntimeProfile(
        device=device_map,
        device_index=device_index,
        device_name=device_name,
        capability=capability,
        is_turing=is_turing,
        dtype_name=dtype_name,
        torch_dtype=torch_dtype(dtype_name),
        attn_implementation=attn_implementation,
    )


def cuda_device_index(device_map: str) -> int:
    value = str(device_map or "").strip().lower()
    if not torch.cuda.is_available():
        return -1
    if value.startswith("cuda:"):
        index_text = value.split(":", 1)[1]
        if index_text.isdigit():
            return int(index_text)
    if value == "cuda":
        return torch.cuda.current_device()
    if value == "auto":
        return torch.cuda.current_device()
    return torch.cuda.current_device()


def normalized_dtype_name(value: Any, default: str) -> str:
    name = str(value or "auto").strip().lower()
    if name in {"auto", ""}:
        return default
    if name in {"fp16", "float16", "half"}:
        return "float16"
    if name in {"bf16", "bfloat16"}:
        return "bfloat16"
    if name in {"fp32", "float32"}:
        return "float32"
    return default


def torch_dtype(name: str) -> torch.dtype:
    if name == "float16":
        return torch.float16
    if name == "bfloat16":
        return torch.bfloat16
    if name == "float32":
        return torch.float32
    return torch.float16
