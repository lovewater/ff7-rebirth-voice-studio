# ff7-gpu

GPU 推理服务代码。修订台 VM 只同步代码，**不存权重和镜像**。

正式 TTS 为两张 22GB 2080 Ti 上各一份官方 IndexTTS 2.0，FP16 autocast。网站经 Nginx `http://tts-proxy:8810` 统一入口访问，后端地址仅在本地 `.env` 设置。5080 已退出 TTS；ASR 保持 GPU0。逐句克隆不经过 Seed-VC。详见 `tts-official/README.md`。

不使用emotion。

| 主机 | 服务 | 地址 | GPU / 精度 | 代码目录 |
|---|---|---|---|---|
| 网站主机 | Nginx TTS 入口 | Compose 内 `http://tts-proxy:8810` | 无 GPU | `studio-ff7-rb/tts-proxy/` |
| inference-host | IndexTTS 2.0 × 2 | 后端地址由本地环境变量配置 | GPU1 / GPU2 22GB 2080 Ti，FP16 | `tts-official/` |
| inference-host | ASR Qwen3-ASR-1.7B | 由本地环境变量配置 | GPU0 11GB | `asr/` |
| inference-host（实验，已停） | TTS IndexTTS 2.5 AMD | 按需启动后 `https://inference.example.invalid` | Radeon AI PRO R9700 32GiB / BF16 native + 兼容路径 | `/srv/ff7-rebirth-voice-studio/gpu-amd` |

权重在两台 GPU 主机各自的 `/srv/models`；TTS 模型目录需可写，以保存辅助缓存。AMD 的 speaker 缓存在 inference-host `/srv/ff7-rebirth-voice-studio/gpu-amd-data/speakers`。

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

ASR 继续使用 `gpu/docker-compose.yml`；双卡 TTS 使用 `tts-official/docker-compose.sis.yml`。先在 GPU 主机准备模型和基础镜像，再按 [官方 TTS 部署说明](tts-official/README.md) 构建并启动。权重和镜像不放在 VM。

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

本目录随统一仓库管理，不提交权重和 `.venv`。
