# ff7-gpu

GPU 推理服务代码，独立 git。修订台 VM 只同步代码，**不存权重和镜像**。

正式 TTS 在 `INFERENCE_HOST`：官方 IndexTTS 2.0，RTX 5080，BF16 autocast。inference-host（`INFERENCE_HOST`）不再做 TTS：TTS 容器、镜像和权重已清掉。现有 GPU0 11GB 2080 Ti，GPU1/GPU2 各 22GB 2080 Ti，两张 22GB 之间 NVLink 约 25.8 GB/s × 2。逐句克隆不经过 Seed-VC。详见 `tts-official/README.md`。inference-host 的 AMD 服务只保留作 ROCm 兼容性实验，不用于正式制作。

不使用emotion。

| 主机 | 服务 | 地址 | GPU / 精度 | 代码目录 |
|---|---|---|---|---|
| INFERENCE_HOST（正式） | IndexTTS 2.0 | `https://inference.example.invalid` | GPU1 RTX 5080 / **BF16 autocast** | `/srv/operator/ff7-indextts-official` |
| inference-host | ASR Qwen3-ASR-1.7B（开机只自动起这个） | `https://inference.example.invalid` | GPU0（11GB） | `/srv/ff7-rebirth-voice-studio/gpu` |
| inference-host（未启动） | Qwen3-Omni Thinking 质检 | 计划 `https://inference.example.invalid` | GPU1+GPU2 22GB TP=2 / FP16 KV | `qwen3-omni/` |
| inference-host（已清掉） | IndexTTS 2.0 / 2.5 / Higgs / CosyVoice | — | 22GB 卡不再用于 TTS | 镜像和权重已删 |
| inference-host（实验，已停） | TTS IndexTTS 2.5 AMD | 按需启动后 `https://inference.example.invalid` | Radeon AI PRO R9700 32GiB / BF16 native + 兼容路径 | `/srv/ff7-rebirth-voice-studio/gpu-amd` |

权重在两台 GPU 主机各自的 `/srv/models`，以只读方式挂进容器。AMD 的 speaker 缓存在 inference-host `/srv/ff7-rebirth-voice-studio/gpu-amd-data/speakers`。

精度选择和 AMD 实验环境的复现说明见 [`tts/README.md`](tts/README.md)。

## 接口

TTS：

- `POST /v1/speaker/embed` `{speaker, audios:[...]}` 多段参考：CampPlus embedding 平均 + 拼接 wav
- `POST /v1/tts` `{text, speaker, emo_audio, duration_factor, lang, emo_alpha}` 日文只进 `emo_audio`
- 兼容旧 `POST /predict`

ASR：`POST /asr` `{sample_audio, language}` language 用 `Chinese` 测专名。

不使用emotion。

测试脚本：`tests/asr_cn_terms.py`、`tests/try_random.py`。

子目录：`tts/` `asr/`；`rate/` 语速还没做；`shared/` 是约定。

## 部署到 inference-host

这台机器不再部署 TTS。不使用emotion。开机只自动起 ASR（`ff7-gpu-asr`，`:8001`）。权重在 inference-host 的 `/srv/models`，镜像也只建在 inference-host。本机 `gpu/` 只同步代码。`docker-compose.yml` 现在只有 ASR。

```bash
rsync -a --delete --exclude .git --exclude '**/__pycache__' --exclude models \
  /srv/ff7-rebirth-voice-studio/gpu/ inference-host:/srv/ff7-rebirth-voice-studio/gpu/

ssh inference-host 'cd /srv/ff7-rebirth-voice-studio/gpu && docker compose up -d asr'
# 正式 TTS 在 5080 的 tts-official/docker-compose.yml。不要在 inference-host 上启动 TTS。
```

## 复现 inference-host 兼容性实验

```bash
rsync -a --delete --exclude .git --exclude '**/__pycache__' --exclude models \
  /srv/ff7-rebirth-voice-studio/gpu/ inference-host:/srv/ff7-rebirth-voice-studio/gpu-amd/

ssh inference-host 'cd /srv/ff7-rebirth-voice-studio/gpu-amd && \
  docker compose -f docker-compose.amd.yml up -d --build'

curl -fsS https://inference.example.invalid
```

容器名 `ff7-gpu-tts-amd`，镜像 `ff7-gpu-tts:amd-test`，宿主机 8100 映射容器 8000。当前容器已停止，镜像、权重和 speaker 文件保留；该节点不应配置为修订台默认 `TTS_URL`。

## 本地 git

本目录独立 `git init`，不把权重和 `.venv` 提交进去。
