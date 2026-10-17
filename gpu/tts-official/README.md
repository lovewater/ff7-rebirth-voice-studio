# IndexTTS 2.0 官方

这是 FF7 修订台正式 IndexTTS 节点，当前是 **2.0**（`IndexTeam/IndexTTS-2` + `indextts.infer_v2`）。2.5 合成错误偏多，作者侧也退回 2.0。

2026-10-15 起正式节点回到 **RTX 5080**（`INFERENCE_HOST`，BF16 autocast）。修订台 `TTS_URL=https://inference.example.invalid`。部署目录 `chaoran@INFERENCE_HOST:/srv/operator/ff7-indextts-official`，compose 文件是本目录的 `docker-compose.yml`。不要在这张卡上再开 Seed-VC。

inference-host（`INFERENCE_HOST`）不再做 TTS。原先 GPU1 用 `docker-compose.sis.yml` 在 `:8810` 跑官方 IndexTTS 2.0。容器、镜像和 IndexTTS 权重已删。不要在这台机器上重新 build 或 `up` TTS。

逐句克隆 `POST /v1/tts/clone` 不经过 Seed-VC。

## 初始化

```bash
mkdir -p upstream models data
git -c http.proxy= -c https.proxy= clone --depth 1 https://github.com/index-tts/index-tts.git upstream
uv tool install modelscope
modelscope download --model IndexTeam/IndexTTS-2 --local_dir models/IndexTTS-2
docker pull INFERENCE_HOST/ff7-gpu-tts:indextts25-cu128
docker compose build
docker compose up -d
```

`models/` 必须可写。辅助权重在 `models/IndexTTS-2/hf_cache/`（可从 2.5 的 hf_cache 拷过来）。

上面这份 `docker compose build && up` 是 5080 上的步骤，目录是 `chaoran@INFERENCE_HOST:/srv/operator/ff7-indextts-official`。`docker-compose.sis.yml` 是 inference-host 上已废弃的部署，不要再把它当正式节点，也不要在 inference-host 上重新 build。

构建复用从 inference-host 推入内网 Registry 的 `ff7-gpu-tts:indextts25-cu128` 依赖层，其中已包含 PyTorch / torchaudio 2.8.0+cu128 和 IndexTTS 2.5 的依赖。容器的 `PYTHONPATH` 指向全新的官方 `upstream/` checkout，因此不会执行底座中的旧推理源码。不要从裸 `nvidia/cuda` 镜像执行官方完整 `uv sync`：该路径会从海外 CDN 重复下载 PyTorch 与 NVIDIA wheel，在当前链路只有约 1 Mbps。内网 Registry 实测约 956 Mbps；模型权重仍来自本次 ModelScope 下载。

## 推理配置

- 官方源码 revision 在 `/health` 的 `source_revision` 返回。
- 权重来自 ModelScope `IndexTeam/IndexTTS-2`。
- RTX 5080 对 2.0 使用 BF16 autocast（官方 2.0 没有 `use_bf16` 开关）。
- `use_cuda_kernel=false`、`use_deepspeed=false`、`use_torch_compile=false`、`use_qwen_emo=true`。
- TTS 固定 `use_random=false`，保留官方文本标准化。

## 音源与 TTS 流水线

`POST /v1/speaker/embed` 的已选原音频总长必须 ≤15 秒；解码后、去静音前校验，超过返回400。所有素材拼成一个不超过15秒的 WAV，返回 `embedding_pt_b64`、`reference_wav_b64` 和 `source_wav_b64`。旧多批次 embedding 仍可 register 和推理，新制作不再接受超长素材。

`POST /v1/tts` 保留 text/speaker/emo_audio/duration_factor/lang/emo_alpha；新增：

- `repair_reference_audio`：所选音色版本的拼接音源，base64；省略时使用已注册的 speaker WAV。
- `repair_reference_lang`：该拼接音源的 jp/cn 来源。

日语 emo_audio 必须提供。IndexTTS 先使用原生 BF16 合成，然后调用 SEED_VC_URL 的 `/v1/convert`。Seed-VC 按真实文件长度选参考：日语原音 ≥1.5s 用当前句，<1.5s 用 embedding 拼接音源。转换主模型FP32，Whisper保留官方FP16。

`align_start_s`（可选）：日文「起」秒数。Seed-VC 之后按峰值 10% 找到第一声，把开头静音裁掉或补零，使「起」对齐日文。

`align_dur_s`（可选）：日文「长」秒数。只切末尾静音去对齐总长；切完静音仍长于日文则不动尾巴，绝不切说话。

返回最终 `audio_wav_b64`、原始 `raw_audio_wav_b64` 与 `conversion_meta`。Seed-VC 失败整个请求报错，不降级原音。显式 `[停顿=500]` 以样本区间传递，转换各段后重插等长静音。

启动依赖：先在 `/srv/operator/ff7-seed-vc` 执行 `docker compose up -d`（详见 ../seed-vc/README.md），然后启动此 compose。两者使用同一宿主 GPU1，并挂载 `/srv/operator/ff7-gpu-lock` 串行化推理。Seed-VC 单次子进程完成后释放显存，IndexTTS 常驻。

正式源码 `ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c`；`/health` 会返回实际源码、BF16 配置及必需的音色修复服务。
