# Rubber Band R3 短窗变速（G）

2026-10-24：七种配置盲听后，用户选择 G。浏览器与服务器统一使用 R3 短窗离线配置。10月20日曾停用的 R3 是标准窗配置，并非本次 G。旧锁定音频不改写。

浏览器手工整段/选区变速与服务器自动整体/逐段变速统一使用自行构建的 Rubber Band **4.0.0** WASM。没有使用 npm `rubberband-wasm@3.3.0`：检查其发布包源码发现虽然暴露 `OptionEngineFiner`，却不提供 `getEngineVersion`，无法满足活动引擎断言。没有 WSOLA 或 ffmpeg atempo 降级路径。

- 公共资源：`public/vendor/rubberband/rubberband-4.0.0.wasm`；Node 从应用 cwd 的同一路径读取，浏览器 Worker 从 `/vendor/rubberband/` 下载。Docker 原有 `COPY . .` 同时包含 WASM、许可证和源码。没有额外 npm 依赖或运行时下载 CDN。
- `rubberband-core.ts`：`OptionEngineFiner | OptionThreadingNever | OptionWindowShort` (`0x20110000`)，Offline、短窗、音高倍率 1。每次非恒等变速创建状态后调用 `getEngineVersion()`，必须为 3。未设置只对 R2 有效的瞬态/相位/检测器选项。
- `bridge.cpp`：设置完整输入时长、1024 采样块上限，完整 study 后从头 process，两个阶段都标记 final；每次 process 都 retrieve，最后确认 available=-1。离线引擎负责首端 padding/延迟补偿，不使用实时补偿方式截掉开头；不施加淡入淡出，不按阈值裁语音，不重复尾粒。
- 比例仍是输出/输入时长，1.2=拉长20%，缩短20%按钮仍为÷1.2；限幅仍为0.4～2.5。目标为 `round(inputFrames * ratio)`，不再跳过 <50ms 或距1不足0.002的变速。上游取整若差1采样，尾端仅修正1采样；更大差异、NaN、错误引擎或加载失败均报错。恒等变速保持PCM原样。
- `wav-stretch.ts` 保持服务端同步API，因此自动对齐、逐段处理、拼接、条件锁定的调用链保持原有控制流。已有逐段85%～115%、布局留白、片段 placement 和字幕规则不变。
- `audio-edit.ts` 的 `stretchDuration/stretchRange/stretchToSeconds` 现在返回 Promise。调用者须 await；编辑弹窗统一等待完成，期间阻止编辑/撤销/保存/关闭，不向undo或源缓冲转移所有权。每次变速独立Worker、超时120s、错误结束Worker，释放其WASM内存。只在后台线程运行DSP，AudioBuffer转单声道及拼回未选区仍在主线程。

## 源码、构建与许可

上游来源：https://breakfastquay.com/files/releases/rubberband-4.0.0.tar.bz2 ，SHA256 `af050313ee63bc18b35b2e064e5dce05b276aaf6d1aa2b8a82ced1fe2f8028e9`。随公共资源提供原始完整源码压缩包、`COPYING`、本项目桥接源码与可重建脚本。使用上游single compilation unit（另加同目录`short-offline.patch`修复短片段离线起始补偿预算，两个表达式），内置FFT/resampler，无外部DSP库、线程或SIMD要求，无fast-math。

Rubber Band源码声明 **GPL-2.0-or-later**（或另购商业授权）。公共资源的 `NOTICE.txt`、COPYING与源码下载须保留；不能把WASM描述为MIT/免授权。使用该库的组合程序若对外分发，须满足GPL相应源码及授权要求，或向上游取得合适商业授权；仅附上库的COPYING并不能替代整个组合程序的分发义务。本次未给项目其它既有代码单方面更换许可证。npm包元数据写GPLv2，实际选择的是上述官方4.0.0源码及其许可。

在已安装 Emscripten 的环境运行 `bash public/vendor/rubberband/build.sh`；工具链版本和实际产物hash记录在同目录NOTICE。若更新上游/编译器，必须重新跑DSP测试、真实音频、浏览器Worker和Docker构建，不能只改版本字符串。

## 验证

`node --test src/lib/rubberband.test.cjs` 覆盖真实WASM R3断言、错误引擎拒绝、多个采样率和比例、保调、首尾不同频率、短选区、近1比例、原PCM不变、选区拼回及异步目标时长。现有分段/组装测试继续覆盖位置、间距和最终等长。真实游戏/生成音频烟测只放工程根目录忽略的 `work/rubberband-r3/`，不提交音频。测试结果与限制见 `work/PROGRESS.md` 的本次条目。

上游API依据：https://breakfastquay.com/rubberband/code-doc/classRubberBand_1_1RubberBandStretcher.html （R3选择/活动引擎检查、Offline study/process、expected duration与首端延迟）。

适配器有修改时运行 `bash scripts/package-rubberband-source.sh` 更新公共源码下载；回归测试会核对包内源码和当前文件。实测53项相关测试通过；5份真实音频15次变速长度准确，ASR一致；10组浏览器/Node输出逐采样一致。生产Docker构建及镜像内6项DSP/许可检查通过。全量既有失败及弹窗既有eslint问题有开工前基线对照，见工程进度记录。已由主 agent 在 running=0 时部署，并验证线上编辑器拉长5%、缩短5%、撤销与关闭；未真人主观听音。

新合成保留 CPU 处理之前的响度匹配 GPU 输出为 `raw_audio_path`，元数据记录阶段及 `stretch_algorithm`，便于后续同源重放。旧数据缺失的源无法追溯补回。
