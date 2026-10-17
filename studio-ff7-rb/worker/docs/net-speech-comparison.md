# 净发声语速对照（2026-10-09）

用户指定本功能先作对照，不替换既有“比”、时长字段、报警或自动改写。

## 计算规则

- 解码实际 MP3/WAV 波形；每个文件单独找绝对振幅峰值。
- 样本绝对振幅严格小于该峰值的 15% 算安静；等于阈值仍算发声。
- 连续安静 **至少 200ms** 时，扣除整个区间，包含该区间开头的 200ms。199ms 不扣；不足 200ms 的首尾安静也保留。全零文件净发声为零。
- 多声道保持各声道，不先混成单声道；一个采样帧全部声道低于阈值才算安静，避免反相抵消。
- 净发声秒数 = 文件总秒数 − 合格静音区间之和。
- 日文净语速 = 纯摩拉数 / 日文净发声秒数；中文净语速 = 汉字数 / 中文净发声秒数。标点、空白、字幕换行和 TTS 停顿控制不计拍。
- 日/中净语速商 = 两种净语速相除，不套用 1.33，也不把 1 当标准。读音分歧、缺少正文、日文正文≤5字或纯静音不计算语速商。

这里的 15% 是线性振幅，不是分贝的 15%，也不是功率比例。它是用户指定的宽泛检测方式，不是语义 VAD；呼吸或背景声可能保留，较轻的发声可能被判成静音。工具保留检测区间，便于与试听对照。

## 使用和数据来源

详情页音频播放器下方新增“净发声语速对照”，展示原日文、源中文、选中的 TTS 版本；有 raw_audio_path 才增加原始音频一行，不把成品冒充未对时音频。下拉可切换候选，锁定版本默认优先。TTS 计字使用朗读稿，不使用可能被手工改过的字幕；锁日文版本按日文摩拉计算。

原 JP/CN 在本机存为 MP3，解码 PCM 后测量；TTS 使用现有 WAV。源文件及音量均不改动。解码统一 16kHz/16-bit PCM，时间分辨率为 1/16000 秒。

网页只负责查询及显示，解码在 mora worker 的内部 /speech 接口完成（最多4份音频、最多2个并发分析）。容器只读挂载 data，允许 jp/cn/tts 目录内的 MP3/WAV，路径解析检查防止越界。内存缓存按路径、文件大小、mtime、ctime 失效；无数据库迁移或批量重写。单文件最多10分钟，ffmpeg 超时30秒，缺失音频显示错误而不伪造零秒。

相关文件：worker/speech_activity.py、worker/test_speech_activity.py、worker/mora_server.py；网站 /api/lines/[stem]/speech-metrics 和 speech-comparison.tsx。既有 analyze_timing.py、mora_core 的正式计拍规则保持不变。

```bash
python3 -m unittest discover -s studio-ff7-rb/worker -p test_speech_activity.py
```

## 持久化更新（2026-10-09，覆盖上面的内存缓存部署说明）

数据库迁移 `db/init/030_speech_metrics.sql` 新增 `speech_metrics`：保存总秒数、静音秒数、净发声秒数、正文拍数、每秒语速及完整静音区间；同时记录音频路径、语言、朗读稿、文件指纹、算法版本、状态、失败原因和计算时间。

缓存键包含路径、语言、正文；文件大小/mtime/ctime及算法版本用于失效判断。文本改变产生独立记录；文件或算法改变将同一记录重新排队。没有采用旧结果作为新输入的计算结果；重新计算期间界面可继续显示上次值，并提示后台排队。

网页/API只读持久化结果、检查文件元数据、登记需要计算的任务，不再请求 /speech 解码。列表服务端批量读库并随首屏返回数据；后台刷新保留已有数值。详细页可选TTS版本，排队时每5秒查库，计算完成自动更新。净语速商只需用已存的两个语速相除，不做音频计算。

`speech_metrics_batch.py` 由 `speech-metrics` Compose服务运行：单进程逐个解码，`cpus: 1.0`、nice 10、FFmpeg解码线程1。PG advisory lock防止重复启动计算器；结果逐条提交，重启后跳过已有结果。每60秒扫描新音频/输入变更，当前查看的台词优先。缺失或坏音频记录为error，不当成0秒；错误最多自动重试3次，文件或算法变更可重新排队。文件在解码期间被替换时不写入旧结果。

```bash
# 首次升级先执行030_speech_metrics.sql；全新数据库由init自动建表。
cd studio-ff7-rb
# 构建mora镜像（后台脚本复用该镜像），启动持久化队列消费者
docker compose --profile full build mora website
docker compose --profile full up -d --no-deps --no-build speech-metrics website
# 查看每100次处理/约30秒的数量进度
docker compose logs -f speech-metrics
# 一次性扫描并算完；常驻脚本运行时会拒绝第二个计算进程
docker compose --profile full run --rm --no-deps speech-metrics python -u speech_metrics_batch.py
```

原 `line_meta.*_speech_s`、原“比”、报警、自动改写和音频/字幕采用状态都不改变。数据库持久化为CPU计算缓存，不需要把音频或统计产物提交到Git。
