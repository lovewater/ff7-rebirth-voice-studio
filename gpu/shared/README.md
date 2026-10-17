# shared

对接约定，没有业务代码。

- **正式 TTS**：`INFERENCE_HOST`，RTX 5080，官方 IndexTTS 2.0，BF16 autocast。权重不要拷到修订台 VM。
- **inference-host**：不再做 TTS（镜像和权重已清）。ASR 在 GPU0 `:8001`。不使用emotion。GPU1/GPU2 是两张 22GB 2080 Ti，中间有 NVLink。
- **inference-host**：AMD IndexTTS 2.5 原生 BF16 兼容性实验，当前已停；按需启动后为 `INFERENCE_HOST`，不用于正式音色制作。
- **本机 VM**：`studio-ff7-rb` 把 mp3/base64 打过去。参考音在 `website/data/{jp,cn}/`。

inference-host 现在的三张卡（不要把 TTS 指回来）：

| GPU | 卡 | 现在 |
|---|---|---|
| 0 | 11GB | Qwen3-ASR `:8001` |
| 1 | 22GB | 与 GPU2 有 NVLink；不再用于 TTS。计划与 GPU2 一起跑 Qwen3-Omni Thinking `:8003`（未启动） |
| 2 | 22GB | 与 GPU1 有 NVLink。不使用emotion |

inference-host 是 Radeon AI PRO R9700 32GiB（gfx1201），代码 `/srv/ff7-rebirth-voice-studio/gpu-amd`，使用独立 `docker-compose.amd.yml`。它需要 eager/math attention 兼容路径；AMD 和 NVIDIA 服务不共享 speaker 缓存。
