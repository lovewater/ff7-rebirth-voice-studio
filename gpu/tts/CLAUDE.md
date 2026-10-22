# IndexTTS 2.5 服务维护说明

本目录是 FF7 Rebirth 中文配音修订工程的 IndexTTS 2.5 HTTP 服务。部署、接口和 AMD 实验环境的完整说明见 [`README.md`](README.md)。

## 正式环境

修订台的正式 TTS 不在这里。正式节点是 inference-host 双 22GB 2080 Ti 上的官方 IndexTTS 2.0（FP16），网站只访问 Nginx `http://tts-proxy:8810`（局域网 `studio-host:8810`）。后端为 `inference-host:8811/8812`，见 `../tts-official/README.md`。本文件其余部分是已停用的 IndexTTS 2.5（`:8000`）维护记录。

关机前的 2.5 节点：

- 主机：`inference-host`（TTS 已清掉）
- 地址：`https://inference.example.invalid`
- GPU：RTX 2080 Ti（历史 2.5；现已改跑官方 2.0）
- 精度：`INDEXTTS_PRECISION=fp16`，健康检查应显示 `fp16-autocast`
- 代码：`/srv/ff7-rebirth-voice-studio/gpu`
- 权重：`/srv/models/IndexTeam/IndexTTS-2.5`

不要把修订台 `TTS_URL` 指回这个节点。2080 Ti 没有原生 BF16；不要使用 PyTorch 报告的模拟 BF16。

部署：

```bash
rsync -a --delete --exclude .git --exclude '**/__pycache__' --exclude models \
  /srv/ff7-rebirth-voice-studio/gpu/ inference-host:/srv/ff7-rebirth-voice-studio/gpu/

ssh inference-host 'cd /srv/ff7-rebirth-voice-studio/gpu && docker compose up -d --build tts'
curl -fsS https://inference.example.invalid | python3 -m json.tool
```

## AMD 实验环境

inference-host 的 R9700 服务当前已停止；按需启动后位于 `https://inference.example.invalid`，只保留作 ROCm 兼容性实验。gfx1201 需要 GPT eager attention、其余 math SDPA 和 SoundFile 回退；这条路径比 NVIDIA FP16 慢，不用于正式制作。

## 关键代码

- `main/main.py`：FastAPI 入口和健康检查
- `main/ff7_api.py`：`/v1/speaker/embed`、`/v1/tts`
- `main/base/ttsmanager.py`：模型加载和精度选择
- `tts_base/`：IndexTTS 2.5 推理源码
- `../docker-compose.yml`：NVIDIA 正式服务
- `../docker-compose.amd.yml`、`Dockerfile.amd`：AMD 实验服务

`INDEXTTS_PRECISION` 支持 `fp16`、`bf16`、`fp32`、`auto`。生产 compose 必须显式配置，避免不同 PyTorch 版本的自动探测结果改变运行精度。
