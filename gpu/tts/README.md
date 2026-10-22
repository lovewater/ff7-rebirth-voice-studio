# TTS — IndexTTS 2.5

## 当前部署

| 节点 | 地址 | GPU | 精度 | Compose |
|---|---|---|---|---|
| **inference-host 官方 2.0 × 2（正式）** | 网站经 Nginx `http://studio-host:8810`；后端 `inference-host:8811/8812` | GPU1/GPU2 各 22GB 2080 Ti | **fp16-autocast** | `tts-official/docker-compose.sis.yml` |
| RTX 5080（已退出 TTS） | 已停 | RTX 5080 | — | `tts-official/docker-compose.yml` 仅历史参考 |
| inference-host IndexTTS 2.5（已清掉） | 已删 | 同一张 22GB | — | 旧定义已从 `docker-compose.yml` 去掉，该文件现在只有 ASR |
| amd-inference-host（兼容性实验，已停） | 按需启动后 `http://amd-inference-host:8100` | Radeon AI PRO R9700 32GiB / gfx1201 | bf16-native + eager/math 兼容路径 | `docker-compose.amd.yml` |

正式节点是官方 IndexTTS 2.0，说明见 [`tts-official/README.md`](../tts-official/README.md)。下面这份文档其余部分讲的是已停掉的 2.5 兼容接口（`:8000`）。2.5 权重仍在：

- 模型 revision：`c39ce5ba981572cb187443877ff559dfb246ce63`
- 权重目录：`/srv/models/IndexTeam/IndexTTS-2.5`

正式制作走 Nginx 统一入口，后端为 inference-host 双卡官方 2.0。旧 2.5 服务仍停用，不要启动旧接口。2080 Ti 没有原生 BF16，2.0 使用 `INDEXTTS_PRECISION=fp16`（权重 FP32、autocast FP16）；不要用 PyTorch 的模拟 BF16 支持判断代替原生能力。

## 项目里的用法

- **音色基线**：用户自行勾选参考音频；总长不超过 15 秒时只计算一个 embedding，超过 15 秒时均衡拆成多个不超过 15 秒的批次，再对每批 CampPlus style 和 IndexTTS emotion vector 分别求均值。embedding 阶段不需要台词文本。
- **正式合成**：中文文本使用上述平均音色和基础情绪，同时把对应日文原声作为 `emo_audio`；目前示例使用 `emo_alpha=0.5`。
- `duration_factor` 用于向日文说话时长靠拢。
- speaker 名必须是唯一版本键，例如 `red-v2`。服务会在自己的 `/data/speakers` 保存 `<speaker>.pt` 和代表批次 `<speaker>.wav`。

接口：

- `POST /v1/speaker/embed`：`{speaker, audios, audio_ids, target_seconds, gap_seconds, trim_silence}`
- `POST /v1/tts`：`{text, speaker, emo_audio, duration_factor, lang, emo_alpha}`
- `POST /v1/speaker/register`：把修订台保存的 `speaker.pt` 和参考 WAV 注册回当前 GPU，供历史音色版本切换或服务重启后恢复。
- `GET /health`：模型、revision、精度和设备信息

`/v1/tts` 的 `text` 支持显式停顿标记 `[停顿=500]`，单位毫秒，范围 50–5000。服务按标记切分推理并拼入等长静音，标记不会被朗读。响应中的 `spoken_text` 是移除标记后的实际朗读文字，`pause_count` 是停顿数量。

## inference-host AMD 兼容性实验怎么搭

远端代码目录是 `/srv/ff7-rebirth-voice-studio/gpu-amd`。`docker-compose.amd.yml` 使用单独的 `tts/Dockerfile.amd`，不会改动 inference-host 的 NVIDIA 服务。容器当前已停止，镜像、权重和 speaker 文件仍在；这套环境用于复现和比较，不用于制作最终 embedding 或正式台词。

前提：

1. inference-host 已安装可用的 AMD 驱动，宿主机存在 `/dev/kfd` 和 `/dev/dri`。
2. 本机已有基础镜像 `vosr2-runtime:amd-v0.1.0`。该镜像提供 gfx1201 可用的 ROCm PyTorch；当前容器是 `torch 2.15.0a0+rocm10.1.0a20260822`。
3. 权重已经放在 `/srv/models/IndexTeam/IndexTTS-2.5`。
4. `video`、`render` 组在当前主机的 GID 是 44、990；换机器时用 `getent group video render` 检查并修改 compose 的 `group_add`。

同步代码并启动：

```bash
rsync -a --delete \
  --exclude .git --exclude '**/__pycache__' --exclude models \
  /srv/ff7-rebirth-voice-studio/gpu/ \
  inference-host:/srv/ff7-rebirth-voice-studio/gpu-amd/

ssh inference-host 'cd /srv/ff7-rebirth-voice-studio/gpu-amd && \
  docker compose -f docker-compose.amd.yml up -d --build'
```

如果 inference-host 还没有权重，可以从 inference-host 流式复制；约 11GB，完成后应再校验主要权重哈希：

```bash
ssh inference-host 'tar -C /srv/models -cf - IndexTeam/IndexTTS-2.5' \
  | ssh inference-host 'mkdir -p /srv/models && \
      tar -C /srv/models -xf -'
```

日常管理：

```bash
ssh inference-host 'cd /srv/ff7-rebirth-voice-studio/gpu-amd && \
  docker compose -f docker-compose.amd.yml ps'

ssh inference-host 'docker logs -f --tail 200 ff7-gpu-tts-amd'

ssh inference-host 'cd /srv/ff7-rebirth-voice-studio/gpu-amd && \
  docker compose -f docker-compose.amd.yml restart tts-amd'

ssh inference-host 'cd /srv/ff7-rebirth-voice-studio/gpu-amd && \
  docker compose -f docker-compose.amd.yml down'
```

健康检查：

```bash
curl -fsS https://inference.example.invalid | python3 -m json.tool

ssh inference-host 'docker exec ff7-gpu-tts-amd python -c \
  "import torch; print(torch.cuda.get_device_name(0)); \
   print(torch.cuda.is_bf16_supported(including_emulation=False))"'
```

正常结果应包含 `model_version: 2.5`、`precision: bf16-native`、`bf16_native: true` 和 `AMD Radeon AI PRO R9700`。ROCm 的 PyTorch 仍沿用 `torch.cuda` API，因此 health 里的 `cuda:0`、`cc12.0` 是预期表现。

## AMD 必需的兼容设置

gfx1201 上 PyTorch 自动选择的 GPT SDPA 会报 `hipErrorInvalidValue`，FP32 和 BF16 都能复现，和 BF16 精度无关。AMD compose 因此设置：

- `INDEXTTS_ATTN_IMPLEMENTATION=eager`：GPT 使用 eager attention。
- `INDEXTTS_SDPA_BACKEND=math`：其余 SDPA 使用 math backend。
- `INDEXTTS_PRECISION=bf16`：R9700 显式启用原生 BF16。
- `PYTORCH_ROCM_ARCH=gfx1201`：限定目标架构。

`Dockerfile.amd` 对本地 IndexTTS 包执行 `pip install --no-deps -e`，避免依赖解析把基础镜像里的 ROCm PyTorch 换成 CUDA wheel。ROCm nightly 的 torchaudio/TorchCodec ABI 不匹配时，音频读写自动回退到 SoundFile。

math attention 能正确推理，但速度比 NVIDIA FP16 路径慢，并且这条兼容路径不作为音色质量基准。已验证的赤红 XIII `red-v2`：32 条原始中文、9 个批次，embedding 10.86 秒；生成 9.416 秒示例耗时 33.36 秒，峰值显存约 8.5GiB，0 个削波样本。该版本仅保留作对照。

赤红 XIII 当前保留两个可试听版本：`red-v2` 使用 32 条中文原声和 AMD BF16；`red-v4` 使用同一批 stem 的 32 条日文原声和 NVIDIA FP16，共 11 个批次。人物页会显示每版的“中文音源 / 日文音源”，数据库及 manifest 也记录 `source_lang`。先前的中文 NVIDIA `red-v3` 已从人物页删除。

## 直接调用 AMD 实验 API

下面示例先制作音色，再用日文音频控制中文合成情绪：

```python
import base64
from pathlib import Path

import requests

base = "https://inference.example.invalid"
refs = [Path("ref-01.mp3"), Path("ref-02.mp3")]

embed = requests.post(
    f"{base}/v1/speaker/embed",
    json={
        "speaker": "demo-v1",
        "audios": [base64.b64encode(p.read_bytes()).decode() for p in refs],
        "audio_ids": [p.stem for p in refs],
        "target_seconds": 15,
        "gap_seconds": 0.12,
        "trim_silence": True,
    },
    timeout=600,
)
embed.raise_for_status()

emotion_jp = Path("emotion-ja.mp3")
synth = requests.post(
    f"{base}/v1/tts",
    json={
        "text": "这里填写要生成的中文台词。",
        "speaker": "demo-v1",
        "emo_audio": base64.b64encode(emotion_jp.read_bytes()).decode(),
        "duration_factor": 1.0,
        "lang": "ZH",
        "emo_alpha": 0.5,
    },
    timeout=600,
)
synth.raise_for_status()
Path("result.wav").write_bytes(base64.b64decode(synth.json()["audio_wav_b64"]))
```

## 修订台路由约束

正式入口为 `http://tts-proxy:8810`，后端为双卡官方 IndexTTS 2.0 FP16。真实后端地址只填在本地 `.env`，迁移和扩容不改网站。模板渲染、热加载及代理重建步骤见 [代理说明](../../studio-ff7-rb/tts-proxy/README.md)。

CampPlus 向量也可以用于说话人确认，例如区分赤红 XIII 深嗓和纳纳基真声。
