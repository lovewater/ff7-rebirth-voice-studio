# ff7-gpu

GPU 推理服务代码，独立 git。修订台 VM 只同步代码，**不存权重和镜像**。

2026-10-23 起正式 TTS 恢复在 `inference.example.invalid` 的 GPU1 RTX 5080 上运行官方 IndexTTS 2.0，BF16 autocast；网站只访问网站主机 Nginx `tts-proxy:8810`（局域网 `inference.example.invalid:8810`）。同机 GPU0 22GB 2080 Ti 另跑一份 FP16，复用已迁走 removebg 的显卡。后端端口为 5080 主机 `8810` / `8812`，地址和扩容只改 `studio-ff7-rb/tts-proxy/nginx.conf`。inference-host 双卡配置保留备用。ASR 仍在 GPU0 11GB。详见 `tts-official/README.md`。inference-host 的 AMD 服务仅保留作实验。

不使用emotion。

| 主机 | 服务 | 地址 | GPU / 精度 | 代码目录 |
|---|---|---|---|---|
| 网站主机 | Nginx TTS 统一入口 | `http://inference.example.invalid:8810` | 无 GPU | `studio-ff7-rb/tts-proxy/` |
| inference-host | IndexTTS 2.0 × 2 | `http://inference.example.invalid:8811` / `:8812` | GPU1 / GPU2 22GB 2080 Ti，FP16 autocast | `/srv/ff7/ff7-indextts-official` |
| inference-host | ASR Qwen3-ASR-1.7B | `http://inference.example.invalid:8001` | GPU0 11GB | `/srv/ff7/ff7-gpu` |
| inference-host（实验，已停） | TTS IndexTTS 2.5 AMD | 按需启动后 `http://inference.example.invalid:8100` | Radeon AI PRO R9700 32GiB / BF16 native + 兼容路径 | `/srv/ff7/ff7-gpu-amd` |

权重在各 GPU 主机的 `/srv/ff7/models`；正式 TTS 的模型目录可写，以保留辅助缓存。AMD 的 speaker 缓存在 inference-host `/srv/ff7/ff7-gpu-amd-data/speakers`。

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

ASR 继续用本目录 `docker-compose.yml`。双卡 TTS 单独用 `tts-official/docker-compose.sis.yml`，详见对应 README。模型、镜像只在 GPU 主机，不下载到 VM。

```bash
rsync -a --exclude .git --exclude '**/__pycache__' --exclude models \
  /srv/ff7/ff7-sound/gpu/ inference-host:/srv/ff7/ff7-gpu/
ssh inference-host 'cd /srv/ff7/ff7-gpu && docker compose up -d asr'
# TTS 的 app/、patches/、Dockerfile.sis、docker-compose.sis.yml 同步到
# /srv/ff7/ff7-indextts-official；upstream 和 models 保留在 GPU 主机。
ssh inference-host 'cd /srv/ff7/ff7-indextts-official && docker compose -f docker-compose.sis.yml up -d --no-build'
```

不要同时启动旧 5080 TTS Compose 或 `tts-union-test` 争抢 GPU。

## 复现 inference-host 兼容性实验

```bash
rsync -a --delete --exclude .git --exclude '**/__pycache__' --exclude models \
  /srv/ff7/ff7-sound/gpu/ inference-host:/srv/ff7/ff7-gpu-amd/

ssh inference-host 'cd /srv/ff7/ff7-gpu-amd && \
  docker compose -f docker-compose.amd.yml up -d --build'

curl -fsS http://inference.example.invalid:8100/health
```

容器名 `ff7-gpu-tts-amd`，镜像 `ff7-gpu-tts:amd-test`，宿主机 8100 映射容器 8000。当前容器已停止，镜像、权重和 speaker 文件保留；该节点不应配置为修订台默认 `TTS_URL`。

## 本地 git

本目录独立 `git init`，不把权重和 `.venv` 提交进去。
