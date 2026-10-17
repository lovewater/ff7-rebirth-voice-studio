import os
import sys
import importlib.metadata
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import logging
from contextlib import asynccontextmanager

from base.config_manager import ConfigManager
from base.utils import logger
from base.ttsmanager import TTSManager
from api import routes
from ff7_api import router as ff7_routes

INDEXTTS_UPSTREAM_COMMIT = os.getenv(
    "INDEXTTS_UPSTREAM_COMMIT",
    "ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c",
)
INDEXTTS_MODEL_REVISION = os.getenv(
    "INDEXTTS_MODEL_REVISION",
    "c39ce5ba981572cb187443877ff559dfb246ce63",
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用程序生命周期管理器"""
    # 启动时执行
    logger.info("正在启动 Index-TTS API 服务...")

    # 读取配置
    config_manager = ConfigManager()
    model_path = config_manager.get_model_path()
    # 初始化 TTSManager（默认推理实例）
    try:
        manager = TTSManager.get_instance()
        manager.initialize(
            model_dir = config_manager.get_model_path()
        )
        logger.info("TTSManager 已初始化")
    except Exception as e:
        logger.error(f"TTSManager 初始化失败: {e}")



    yield  # 这里是应用程序的运行时

    # 关闭时执行
    logger.info("正在关闭 Index-TTS API 服务...")



# 创建 FastAPI 应用
app = FastAPI(
    title="Index-TTS API",
    description="语音合成 API 服务",
    lifespan=lifespan
)

# 添加 CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源
    allow_credentials=True,
    allow_methods=["*"],  # 允许所有方法
    allow_headers=["*"],  # 允许所有头
)

# 包含API路由
app.include_router(routes)
app.include_router(ff7_routes)

@app.get("/")
async def root():
    """API 根路径，返回服务状态"""
    #manager = TTSManager()
    return {
        "status": "running",
        #"models": manager.get_proxy_count(),
        "message": "Index-TTS API 服务正在运行"
    }

@app.get("/health")
async def health_check():
    """健康检查接口"""
    manager = TTSManager.get_instance()
    model = manager.get_infer()
    try:
        package_version = importlib.metadata.version("indextts")
    except importlib.metadata.PackageNotFoundError:
        package_version = "unknown"
    native_bf16 = False
    if torch.cuda.is_available():
        try:
            native_bf16 = torch.cuda.is_bf16_supported(including_emulation=False)
        except TypeError:
            native_bf16 = torch.cuda.get_device_capability(0)[0] >= 8
    runtime_precision = getattr(model, "runtime_precision", None)
    if runtime_precision == "bf16":
        precision = "bf16-native" if native_bf16 else "bf16-emulated"
    elif runtime_precision == "fp16" or getattr(model, "dtype", None) == torch.float16:
        precision = "fp16-autocast"
    elif runtime_precision == "fp32":
        precision = "fp32"
    elif getattr(model, "use_bf16", False):
        precision = "bf16-native" if native_bf16 else "bf16-emulated"
    else:
        precision = "fp32"
    device = str(model.device)
    if torch.cuda.is_available():
        capability = ".".join(map(str, torch.cuda.get_device_capability(0)))
        device = f"{device} / {torch.cuda.get_device_name(0)} / cc{capability}"
    return {
        "status": "healthy",
        "models": 1,
        "model_version": str(model.model_version),
        "model_revision": INDEXTTS_MODEL_REVISION,
        "source_revision": INDEXTTS_UPSTREAM_COMMIT,
        "package_version": package_version,
        "precision": precision,
        "bf16_native": native_bf16,
        "device": device,
    }

# 这里可以添加更多的 API 路由...

def main():
    """主函数"""
    try:
        # 读取配置
        config_manager = ConfigManager()
        api_config = config_manager.get_api_config()

        # 获取 API 配置
        host = api_config.get("host", "0.0.0.0")
        port = api_config.get("port", 7999)

        # 启动 FastAPI 服务器
        logger.info(f"正在启动 API 服务器，地址: {host}:{port}")
        uvicorn.run(app, host=host, port=port)
    except Exception as e:
        logger.error(f"启动服务失败: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
