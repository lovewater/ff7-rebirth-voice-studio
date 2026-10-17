# Qwen3-Omni Thinking（inference-host GPU1+GPU2）

音频 + 文本混合输入，文本输出，给配音质检用。Thinker-only，不加载 talker。

**现在不要启动。** 22GB 两张卡还在跑别的。空了再 `docker compose up -d`。不要写进开机 `gpu/docker-compose.yml`。

- 权重：`/srv/models/cyankiwi/Qwen3-Omni-30B-A3B-Thinking-AWQ-4bit`（19.08 GiB，已对过大小）
- 镜像：`vllm/vllm-openai:v0.28.0-audio`（官方 0.28.0 加 librosa/soundfile；主线 `vllm serve`，不要 `--omni`）
- 卡：只绑 GPU1、GPU2。GPU0 的 ASR `:8001` 不动。
- API：`https://inference.example.invalid`

## 启动参数（已写进 compose）

| 项 | 值 | 原因 |
|---|---|---|
| `--dtype` | `float16` | 2080 Ti 没有可用的 BF16；仓库 config 写的是 bf16，必须盖掉 |
| `--kv-cache-dtype` | `float16` | 16bit KV。thinking 长生成不要用 fp8 |
| `-tp` | `2` | 两张 22GB，NVLink |
| `--gpu-memory-utilization` | `0.85` | 给音频编码器峰值和碎片留空，别把 22GB 顶满 |
| `--max-model-len` | `24576` | 见下面上下文计算 |
| `--max-num-seqs` | `4` | 最多 4 路并发 |
| `--max-num-batched-tokens` | `8192` | 一段音频 prefill 够用（约 13 token/s） |
| `--limit-mm-per-prompt` | audio 2，image/video 0 | 日文原声 + 中文配音，再加文字 |
| `--enforce-eager` | 开 | SM75 + AWQ + 多模态，先稳再谈图 |
| `--omni` | **不加** | 同包 AWQ 走 `--omni` 会输出 `"0"` |

如果镜像不认 `--kv-cache-dtype float16`，去掉这一项。`--dtype float16` 时 `auto` 也是 16bit KV。

## 上下文怎么算

Thinker 文本：48 层，GQA `32/4` 头，`head_dim=128`。

```
每 token KV（FP16）= 2 × 48 × 4 × 128 × 2 B = 96 KiB
TP=2 后每卡 48 KiB/token
```

权重大约：

- MoE 4bit + scale ≈ 17.2 GB
- 音频塔 FP16 ≈ 1.26 GB（量化 ignore 列表里）
- 视觉塔 FP16 ≈ 0.82 GB（现在不用，vLLM 仍会加载）
- 合计约 **19.3 GB / 两卡**，每卡约 9.7 GB

每卡 22528 MiB，`util=0.85` → 约 19150 MiB 给引擎。扣掉权重、CUDA/NCCL、多模态 workspace 之后，KV 池大约：

实测启动日志：`GPU KV cache size: 176,208 tokens`，`24576` token 满长大约 **7.17x** 并发。4 路很宽裕。

所以：

| 切法 | token | 是否装得下 |
|---|---|---|
| 模型上限 65536 × 1 路 | 65k | 池子够，但 4 路满载会爆 |
| **24576 × 4 路** | **98k** | 按 0.85 估的池子，满载也不靠抢占 |
| 32768 × 4 路 | 131k | 偏紧，4 路同时长 thinking 会抢块 |

compose 用 **24576 × 4**。一条请求里：音频约 13 token/秒（30 秒台词 ≈ 390），剩下给 system + 原文 + thinking。单路还能 think 大约 2 万 token。

第一次真正起来之后看日志里的 `GPU KV cache size: N tokens`。若 N 明显高于 11 万，再把 `--max-model-len` 提到 32768。

## 客户端采样（仓库 generation_config）

```json
{"temperature": 0.6, "top_p": 0.95, "top_k": 20, "max_tokens": 8192}
```

`max_tokens` 客户端自己限；服务端硬顶是 24576（prompt + 新 token）。

质检调用请关 thinking，否则 512 token 会停在 `<think>` 里：

```json
"chat_template_kwargs": {"enable_thinking": false}
```

音频用 `content: [{type: audio_url, audio_url: {url: data:audio/wav;base64,...}}, {type: text, text: "..."}]`，`modalities: ["text"]`。

## 起来之后

```bash
# 在 inference-host，确认 GPU1/2 已经空
cd /srv/ff7-rebirth-voice-studio/gpu/qwen3-omni
docker compose up -d
docker logs -f ff7-gpu-qwen3-omni
```

日志里确认 `dtype=float16`、`kv_cache_dtype` 不是 fp8，以及 KV token 数。
