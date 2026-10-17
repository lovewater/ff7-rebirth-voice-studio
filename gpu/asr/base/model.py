import base64
import os
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class AsrRequest(BaseModel):
    """ASR 请求体。"""

    task_id: str = Field(default="xxx", description="任务ID，未传时默认 xxx。")
    sample_audio: str = Field(..., description="音频输入，支持 URL / data URL base64 / 纯 base64 / 本地文件路径。")
    language: Optional[str] = Field(default=None, description="提示语种，如 Chinese / Japanese，默认自动。")


class AsrResult(BaseModel):
    """单条 ASR 结果。"""

    text: str = Field(default="", description="识别出的文本内容。")
    language: Optional[str] = Field(default=None, description="识别出的语言（模型输出）。")


class AsrResponse(BaseModel):
    """ASR 响应体。"""

    success: bool = Field(default=True, description="接口执行是否成功。")
    message: str = Field(default="ok", description="错误信息或状态说明。")
    calc_time: float = Field(default=0.0, description="ASR 推理耗时（秒，不含锁等待与预处理）。")
    file_path: Optional[str] = Field(default=None, description="本地缓存音频文件绝对路径。")
    results: List[AsrResult] = Field(default_factory=list, description="ASR 识别结果列表。")


class HealthResponse(BaseModel):
    """健康检查响应体。"""

    success: bool = Field(default=True, description="服务是否正常。")
    message: str = Field(default="ok", description="状态说明。")


class CloneRefInput(BaseModel):
    """声音克隆参考输入。"""

    audio: str = Field(..., description="参考音频输入，支持 URL / data URL base64 / 纯 base64 / 本地文件路径。")
    text: str = Field(..., description="参考音频对应文本。")
    language: str = Field(default="Auto", description="参考音频语言，默认 Auto。")


class CloneSynInput(BaseModel):
    """声音克隆合成输入。"""

    text: str = Field(..., description="需要合成的文本内容。")
    language: str = Field(default="Auto", description="合成语言，默认 Auto。")


class CloneRequest(BaseModel):
    """声音克隆请求体。"""

    task_id: str = Field(default="xxx", description="任务ID，未传时默认 xxx。")
    ref: Optional[CloneRefInput] = Field(
        default=None,
        description="参考音频与文本信息（提供 voice_clone_prompt 时可省略）。",
    )
    syn: CloneSynInput = Field(..., description="合成目标文本信息。")
    voice_clone_prompt: Optional[str] = Field(
        default=None,
        description="序列化后的 voice clone prompt（base64）。",
    )


class CloneResult(BaseModel):
    """声音克隆结果。"""

    audio_path: str = Field(..., description="合成音频文件绝对路径。")


class CloneResponse(BaseModel):
    """声音克隆响应体。"""

    success: bool = Field(default=True, description="接口执行是否成功。")
    message: str = Field(default="ok", description="错误信息或状态说明。")
    calc_time: float = Field(default=0.0, description="声音克隆推理耗时（秒，不含锁等待与预处理）。")
    results: Optional[CloneResult] = Field(default=None, description="声音克隆结果。")


class ClonePromptRequest(BaseModel):
    """音色 Prompt 生成请求体。"""

    task_id: str = Field(default="xxx", description="任务ID，未传时默认 xxx。")
    ref: CloneRefInput = Field(..., description="参考音频与文本信息。")


class ClonePromptResult(BaseModel):
    """音色 Prompt 结果。"""

    prompt_base64: str = Field(..., description="序列化后的 prompt base64。")


class ClonePromptResponse(BaseModel):
    """音色 Prompt 响应体。"""

    success: bool = Field(default=True, description="接口执行是否成功。")
    message: str = Field(default="ok", description="错误信息或状态说明。")
    calc_time: float = Field(default=0.0, description="音色生成耗时（秒）。")
    results: Optional[ClonePromptResult] = Field(default=None, description="音色结果。")


class PredictRequest(BaseModel):
    """TTS 预测请求体。"""

    task_id: str = Field(default="xxx", description="任务ID，未传时默认 xxx。")
    vip: int = Field(default=0, description="VIP 等级（暂未使用）。")
    text: str = Field(..., description="需要合成的文本。")
    language: str = Field(default="Auto", description="合成语言，默认 Auto。")
    speed: float = Field(default=1, description="语速（暂未使用）。")
    format: str = Field(default="mp3", description="输出音频格式。")
    save_file: bool = Field(default=True, description="是否保存文件（暂未使用）。")
    sample_audio: str = Field(default="", description="参考音频输入，支持 URL / data URL base64 / 纯 base64 / 本地文件路径。")
    instruct: str = Field(default="", description="声音设计指令，优先于 sample_audio。")
    upload_to_s3: bool = Field(default=False, description="是否上传到 S3/R2。")


class PredictAsrRequest(BaseModel):
    """ASR 预测请求体（仅ASR）。"""

    audio_url: str = Field(..., description="音频输入，支持 URL / data URL base64 / 纯 base64 / 本地文件路径。")
    task_id: str = Field(default="xxx", description="任务ID，未传时默认 xxx。")


class DesignRequest(BaseModel):
    """声音设计请求体。"""

    task_id: str = Field(default="xxx", description="任务ID，未传时默认 xxx。")
    instruct: str = Field(default="", description="声音设计指令。")
    syn: CloneSynInput = Field(..., description="合成目标文本信息。")


class ASRResponseResult(BaseModel):
    """ASR 结果。"""

    text: str = Field(default="", description="识别文本。")
    language: str = Field(default="", description="识别语言。")


class ASRResponseOutput(BaseModel):
    """ASR 输出体。"""

    calc_time: float = 0
    wait_time: float = 0
    upload_time: float = 0
    nsfw_score: float = 0
    download_time: float = 0
    s3_url: str = ""
    success: bool = True
    message: str = "Success!"
    result: ASRResponseResult = Field(default_factory=ASRResponseResult, description="识别的结果")


class ASRResponse(BaseModel):
    """ASR 响应体。"""

    input: Dict[str, Any]
    output: ASRResponseOutput


class TTSResponseOutput(BaseModel):
    """TTS 输出体。"""

    calc_time: float = Field(default=0.0, description="ASR 与克隆推理耗时总和（秒）。")
    upload_time: float = Field(default=0.0, description="上传耗时（秒）。")
    wait_time: float = Field(default=0.0, description="等待耗时（秒）。")
    audio_size: int = Field(default=0, description="音频文件大小（字节）。")
    nsfw_score: float = Field(default=0.0, description="NSFW 分数（固定 0）。")
    download_time: float = Field(default=0.0, description="下载与处理音频耗时（秒）。")
    s3_url: str = Field(default="", description="上传后的 URL 或本地 /audio 路径。")
    success: bool = Field(default=True, description="是否成功。")
    message: str = Field(default="Success!", description="状态信息。")


class TTSResponse(BaseModel):
    """TTS 响应体。"""

    input: Dict[str, Any]
    output: TTSResponseOutput

    def toDict(self) -> Dict[str, Any]:
        """将对象转换为字典，并处理sample_audio字段。"""

        def _convert(obj):
            if isinstance(obj, BaseModel):
                return {k: _convert(v) for k, v in obj.model_dump().items()}
            if isinstance(obj, dict):
                return {k: _convert(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_convert(v) for v in obj]
            return obj

        result = {"input": _convert(self.input), "output": _convert(self.output)}
        sample_audio = result.get("input", {}).get("sample_audio")
        if isinstance(sample_audio, str) and self._is_base64_audio(sample_audio):
            result["input"]["sample_audio"] = "#base64-audio"
        return result

    @staticmethod
    def _is_base64_audio(value: str) -> bool:
        if value.startswith("data:") and ";base64," in value:
            return True
        if value.startswith("http://") or value.startswith("https://"):
            return False
        if os.path.exists(value):
            return False
        if len(value) < 64:
            return False
        try:
            base64.b64decode(value, validate=True)
            return True
        except Exception:
            return False
