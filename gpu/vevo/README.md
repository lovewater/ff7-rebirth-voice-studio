# Vevo-Timbre 日语原声音色转换对照

部署在 `chaoran@INFERENCE_HOST:/srv/operator/ff7-vevo`，Docker Compose 固定使用宿主 GPU 1（RTX 5080）。
采用官方 Amphion 的 Vevo-Timbre（保留源语音说法、转换音色），不使用 Vevo-Voice 或 Vevo2。
输入为中文 IndexTTS 输出 #31/#33/#35，参考为各自同句日语原声；与 Seed-VC JP 对照使用完全相同的输入。

## 环境与运行

```bash
git -c http.proxy= -c https.proxy= clone https://github.com/open-mmlab/Amphion.git upstream
git -C upstream checkout 26f6883110181f1dbfe95c70a7c7dbaf4de5f42a
mkdir -p checkpoints data/input
docker compose build
docker compose run --rm vevo
```

- CUDA 12.8 / PyTorch 2.8.0（支持 RTX 5080），复用内网基础镜像。
- 当前官方源码的 Llama attention 要求新版接口；附带 requirements 的 transformers 4.41.2 不兼容，实际固定 4.46.3。额外补齐 pyworld。没有修改模型架构或权重。
- `amphion/Vevo` 权重自动下载至 checkpoints/hf，仅下载 vq8192 tokenizer、Vq8192ToMels 和 Vocoder；HuBERT Large 由 torchaudio 下载至 checkpoints/torch。
- PyPI 使用官方源，本机测试比阿里镜像快；Hugging Face 使用 hf-mirror.com。
- 遵循官方示例 32 flow-matching steps、FP32，固定 seed 20260921。输出沿用官方 -25dB RMS 归一化，保存为 24kHz 单声道 PCM16 WAV。
- `data/jobs.json` 是数组：source_id、stem、reference_lang（此次 jp）、source/reference（相对 data 的路径）。
- `data/output/<source_id>-jp/` 保存音频和 manifest（来源哈希、设备、精度、模型及参数）。运行结束自动退出释放显存。

## 导入修订台

使用 `studio-ff7-rb/worker/import_seed_vc.mjs OUTPUT_DIR SOURCE_REVISION`（历史文件名，现已支持 manifest 指定模型）。
脚本校验原 TTS 与 JP 参考哈希，记录起/止/长/说、来源及模型，每条转换创建新的未采用 TTS 历史。
音频保存 `website/data/tts/{stem}/{新id}.wav`，数据库 `conversion_meta` 可追溯。
当宿主目录为 root 所有时，将导入器和输出 docker cp 到网站容器，用 `WEBSITE_DIR=/app` 执行。
页面 `/line/C2310_MAIN_0800_0700_00_red/`、`/line/C2310_MAIN_0800_0900_00_red/`、`/line/C2310_MAIN_4400_0400_00_red/` 分别对应源 TTS #31/#33/#35，可与 Seed-VC 和原音比较，并采用或删除。

## 本次结果

权重 revision 固定为 `7edf4640c400c20542aa39c45b63f60e6c7baba0`。
原 #31 → Vevo #45；原 #33 → #46；原 #35 → #47，均 ready、默认不采用。
三条长度 3.32 / 5.62 / 3.32 秒，零削波样本，四项时长已入库；音色效果由用户试听判断。

当前仅保留本次对照，不接入正式 TTS；正式音色修复使用 Seed-VC。
