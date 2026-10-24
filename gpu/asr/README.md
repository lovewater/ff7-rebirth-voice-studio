# ASR — Qwen3-ASR-1.7B

inference-host **GPU0（11GB）**，端口 **8001**。镜像 `qwen3-tts:v1.1.4`，权重 `/srv/ff7/models/Qwen/Qwen3-ASR-1.7B`。开机只自动起这个容器。这台机器上的 TTS 镜像和权重已清掉，ASR 保留。不使用emotion。

用来听写、对专名（萨菲罗斯、魔晄炉）。中日都能打。

```
POST :8001/asr
{ "task_id", "sample_audio": "<base64>", "language": "Chinese" }
```

测试：`gpu/tests/asr_cn_terms.py`。
