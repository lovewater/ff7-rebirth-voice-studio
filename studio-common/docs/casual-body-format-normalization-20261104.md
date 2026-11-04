# 普通清理正文的采样格式契约修复

2026-11-04，Remake 200 条试跑中的运行 #100/#101 已启用首尾清理，正文分别是版本 #6281/#6282。它们实际是 IndexTTS 2.0 原生 22050Hz、单声道 PCM16 WAV，而清理参考及原声 PCM 回拼器使用 24000Hz。原代码测长时临时转换到 24k，但核字和最终回拼读取原生文件，导致“普通清理只接受24k单声道PCM16”。正文核字已通过，原有保护正确拒绝了回拼，也未推荐正文半成品；这两条历史失败保持原样。

修复仅影响以后启用清理的普通运行：

1. 原生正文在首次核字前交 `normalizeCasualBodyWav`。非标准 PCM/浮点 WAV 用 FFmpeg 转为 24000Hz、单声道 PCM16；已经是该标准的 WAV 直接复用相同 Buffer 和 SHA，不经浮点解码/编码，避免正数 1LSB 丢失。
2. 需要转换时使用既有派生版本事务另存新文件，不覆盖原生版本、不增加 TTS 请求或额度。保存事务先锁台词、任务及人工状态，再检查源版本的字幕和源文件 SHA；有人修改则停止。
3. 从规范化版本的实际帧数计算时长，独立进行新核字。时长超过预算及既有 1ms 容差时，走原来的正文最多 10% 保调缩短/独立重新核字，或把规范化后的实测秒数交 Grok 压稿重试；格式转换不豁免预算。
4. 核字、后续缩短源和最终回拼都使用规范化版本。回拼继续直接读取与核字 SHA 一致的 WAV 字节，原声首尾 PCM 精确保护不变，不在核字后偷偷重采样。没有启用清理的自然输出不改变采样率策略。

规范化版本的 `conversion_meta.operation` 是 `casual-body-format-normalization`，对应事件同名。保留 `source_id`、`source_audio_sha256`、`normalized_audio_sha256`、`source_format`、`normalized_format`、`duration_before_s`、`duration_after_s`，以及 `normalization.before_verification=true`。格式对象含 `format_tag`、`encoding`、`sample_rate`、`channels`、`bits_per_sample`、`block_align`、实际 `frames` 和 `duration_s`。最终回拼仍保留自己的 `source_id`、正文/核字 SHA；独立质检据此追溯原生→规范化→可选缩短→回拼链路。

CPU 验收使用了两条真实失败 WAV：规范化后正文分别为 47124/37338 帧（1.9635/1.55575 秒），均可在原预算内回拼；源文件未变，规范化后的新 SHA 正确，重复处理标准版本返回原字节，独立拼接验证全 PCM 相等。该验收没有调用 ASR/LLM/TTS，不把旧版核字结论转移到转换产物，也不登记、锁定或改写历史业务记录。取证与独立检查保存在本机 `work/remake-tts200-20261104/qc/format-cpu/`。

回归覆盖真实采样率、PCM24 双声道、float32 WAV、标准 PCM 正负 1LSB、规范化保存的人工/字幕/SHA 竞争、规范化后超预算缩短及压稿重试。相关回归和类型检查的最终结果由本次交付记录确认。
