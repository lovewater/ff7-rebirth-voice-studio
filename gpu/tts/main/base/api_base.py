from typing import List, Optional, Union, Literal,Any,Dict
from pydantic import BaseModel, Field

class TTSInput(BaseModel):
    task_id:str = Field('', description='任务id，用于唯一标识一个任务')
    text:str = Field("今天天气真好，阳光明媚，秋高气爽！要不我们出去走走？", description='需要进行tts的文字')
    sample_audio:str = Field('', description='用于生成音频的样本音频地址，或者base64音频内容，10到20秒为佳。不传将自动使用 samples/default.wav 作为默认样本音频。')
    format:Literal["wav", "mp3"] = Field('mp3', description='音频格式，只能为wav或mp3，默认mp3')
    vip: Optional[int] = Field(0, description="任务优先级: 0=普通任务, 大于1是vip，越大优先级越高")
    save_file:bool = Field(True, description='是否保存音频文件，默认是')
    speed:Optional[float] = Field(1.0, description='音频速度，默认1.0')

    emo_ref_audio:str = Field('', description='情感参考音频，用于情感合成，不传则不进行情感合成')
    emo_ref_text:str = Field('', description='情感参考音频的文字内容，不传会自动进行ASR')
    enable_cache:bool = Field(True, description='是否启用缓存，默认启用。测试时可设为False禁用所有缓存')

class TTSResponseOutput(BaseModel):
    calc_time: float = 0
    wait_time: float = 0
    upload_time: float = 0
    audio_size: int = 0
    nsfw_score: float = 0
    download_time: float = 0
    s3_url: str = ""
    success: bool = True
    message: str = "Success!"
    result: list = Field(default_factory=list, description='每段录音生成的结果记录，仅在save_file为True时记录')

class TTSResponse(BaseModel):
    input: Dict[str, Any]
    output: TTSResponseOutput

    def toDict(self) -> Dict[str, Any]:
        """将对象转换为字典，并处理sample_audio字段"""
        result = self.model_dump()

        # 检查input中是否有sample_audio字段，并且是base64字符串
        if "sample_audio" in result["input"] and result["input"]["sample_audio"]:
            # 检查是否以base64头开始
            if result["input"]["sample_audio"].startswith("data:audio") and ";base64," in result["input"]["sample_audio"]:
                result["input"]["sample_audio"] = "#base64_audio"

        # 检查input中是否有emo_ref_audio字段，并且是base64字符串
        if "emo_ref_audio" in result["input"] and result["input"]["emo_ref_audio"]:
            if result["input"]["emo_ref_audio"].startswith("data:audio") and ";base64," in result["input"]["emo_ref_audio"]:
                result["input"]["emo_ref_audio"] = "#base64_audio"

        # 限制text和sample_text字段的长度为100个字符
        if "text" in result["input"] and len(result["input"]["text"]) > 100:
            result["input"]["text"] = f'{result["input"]["text"][:100]}...'

        return result


class VectorPredictInput(BaseModel):
    """向量推理输入模型"""
    prepare_result_b64: str = Field(..., description='infer_instance.prepare()返回的向量数据，base64编码')
    segment_tokens: str = Field(..., description='infer_instance.generatesegments()返回的其中一段向量数据，base64编码')
    task_id: str = Field('', description='任务id，用于唯一标识一个任务')
