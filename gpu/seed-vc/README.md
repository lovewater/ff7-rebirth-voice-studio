# Seed-VC 音色转换对照实验

部署：`chaoran@INFERENCE_HOST:/srv/operator/ff7-seed-vc`，Compose 任务固定宿主 GPU 1（RTX 5080）。
采用官方 `Plachtaa/seed-vc` 的 V1 离线 whisper-small / BigVGAN 路线，仅做音色转换。
这是 V1 模型，文件名里的 `DiT_seed_v2` 不表示用了 V2 的风格转换系统。

源码固定 `51383efd921027683c89e5348211d93ff12ac2a8`。50 diffusion steps，CFG 0.7，length_adjust=1，关闭 F0 条件与移调，固定 seed 20260921。
CFM、vocoder、CampPlus 使用 FP32；Whisper 保留官方 FP16。不要把该精度描述为全 BF16 或全 FP32。
模型自动下载到远端 checkpoints；复用 IndexTTS 已下载的 CAMPPlus 和 22k BigVGAN 辅助权重。

## 搭建与运行

```bash
git -c http.proxy= -c https.proxy= clone https://github.com/Plachtaa/seed-vc.git upstream
git -C upstream checkout 51383efd921027683c89e5348211d93ff12ac2a8
mkdir -p checkpoints data/input
docker compose build
docker compose run --rm --entrypoint python seed-vc /app/run_batch.py
```

`data/jobs.json` 是数组，每项包含 source_id（原 TTS id）、stem、reference_lang（jp/cn）、source/reference（相对 data 的文件路径）、source_sha256/reference_sha256。
输入源音频是已经生成的中文 TTS；参考是同句日文原声或旧包中文 MP3。输出不翻译，也不重写台词。
结果保存到 `data/output/<source_id>-<reference_lang>/`，包括 WAV 和 manifest。
已有完成 manifest 的任务会跳过；换设置时应使用新的数据目录。

修订台先应用 `db/init/016_line_tts_conversion.sql`，再用 `worker/import_seed_vc.mjs OUTPUT_DIR SOURCE_REVISION` 导入。
如果宿主无权写 website/data，可 docker cp 脚本和输出到 website 容器，在容器中设置 WEBSITE_DIR=/app 运行。
导入校验输入哈希、WAV 格式与时序，同一输出重复导入不会新增记录。
每条结果作为新的 line_tts_versions 保存，默认不采用；conversion_meta 保存完整来源和参数，界面显示参考语言与原 TTS id。
删除沿用既有历史删除接口，仅删除该条历史和对应 tts WAV；远端实验缓存独立保留。

## 已生成

| 原 TTS | 旧包中文参考 | 日文原声参考 |
|---|---|---|
| #31 | #38 | #39 |
| #33 | #40 | #41 |
| #35 | #42 | #43 |

六条均 ready，22050 Hz 单声道 PCM16，长度分别约 3.344/5.631/3.344 秒。
#42 有 1 个满幅 PCM 样本，其他五条为 0；这里只做格式、时序与接口验证，音色是否改善以人工对照为准。
运行完容器退出，GPU 显存自动释放。

## 正式音色修复服务

`docker compose up -d` 启动 **8811 GPU 常驻**接口：模型加载一次留在 5080 显存里，请求只做推理。和 IndexTTS 共用 GPU1，用 `/srv/operator/ff7-gpu-lock/inference.lock` 排队，不并发。不要每个请求再 spawn 子进程——加载模型才是 2 秒音频要等 10 秒的原因。

`POST /v1/convert`：`source_wav_b64`（原始中文TTS）、`jp_audio_b64`（该句日语原音）、`embedding_reference_b64`（音色拼接音源）、`embedding_reference_lang`（jp/cn）、`silences`（原始WAV显式停顿起止样本区间）。

- 参考选择按 sf.info 实际总时长：日语 <1.5s 用 embedding 拼接音源，否则用当前日语。
- 返回最终 WAV 与 conversion_meta（参考种类、时长、哈希、模型参数）。
- 原始显式停顿拆开转换，转换后按毫秒数恢复静音。
- 测试：`docker compose exec seed-vc python /service/test_api.py`，覆盖1.5秒边界、非法停顿、失败不降级、停顿传递。
- 网站的每次逐句 TTS 与 embedding 中文示例均经此服务；Vevo 仅保留历史对照，不参与正式流水线。
