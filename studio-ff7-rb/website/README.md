# website

FF7 Rebirth 中文配音修订台界面。Next.js 16，独立 git。

开发：

```bash
DATABASE_URL="$DATABASE_URL" \
TTS_URL=https://inference.example.invalid \
npm run dev
# 必须 --webpack，绑 0.0.0.0:8765（见 package.json）
```

改完 client 组件若页面还是旧的，按 PID 重启 Next，不要 `pkill -f`（这台机器上还有别的 Next）。

## 页面

| 路径 | 干什么 |
|---|---|
| `/` | 区域卡片 |
| `/lines` | 逐条：筛选、日/中/改播放、时长，进入单条详情 |
| `/line/{stem}/` | 单句：上方台词与原音，下方 TTS 编辑、生成历史和转换对照；stem 为完整台词标识（如 C2310_MAIN_0800_0700_00_red） |
| `/voices` | 人物单选切换：优先/补选音源 → 制作、试听和删除 embedding 版本 |
| `/pack` | 打包（还不能用） |

音频 API：`/api/audio/{jp,cn}/[stem]`。音色草稿：`/api/voices/[speaker]/…`。不使用emotion。

逐句 TTS：

- 列表右侧进入单条详情，替代原 TTS 弹窗。任何台词可查看详情；当前生成使用 IndexTTS zero-shot clone，不要求角色有 ready embedding。默认用当前台词的日文原音作 prompt，也可选人物预设或前后邻近的同人物日/中原音；当前流程跳过 Seed-VC。
- 历史转换记录显示模型、原 TTS id 和音色参考语言；`#tts-{记录id}` 可定位某条历史。
- 日语原声与日语文字不可修改，日语原声作为情绪参考。实际中文 TTS 文字和字幕改写分别保存；字幕留空表示不改游戏字幕。
- 在文字中写 `[停顿=500]` 可插入 500ms 静音，允许范围 50–5000ms。
- 每次生成新增一条 `line_tts_versions` 记录并保存到 `data/tts/<stem>/<id>.wav`。记录包含 `start_s/end_s/dur_s/speech_s`，页面显示为“起 / 止 / 长 / 说”。
- 新记录的 `is_used` 默认 false。手动勾选后成为该句的模组候选；取消勾选时列表仍试听 id 最新记录。删除历史会同时删除记录与 WAV。
- `/lines` 的“有修改的语音”筛选包含所有 ready TTS 记录；日/中下面的“改”优先显示已勾选版本，否则显示最新版本。

人物页制作 embedding 时可切换“日文 / 中文”音源。开关决定送入 IndexTTS 的实际参考 MP3、时长排序和总长；每个版本在数据库及 manifest 中记录 `source_lang`，版本卡也会标明“日文音源”或“中文音源”。已选原音频总时长不得超过 15 秒，页面、网站 API 和 GPU 解码后均校验；不再自动拆分超长选择。保存 `speaker.pt`、`reference.wav`、拼接音源 `source.wav`、manifest 与中日示例。示例中文也经过 Seed-VC 修复。

默认 TTS 入口为 Compose 内 `http://tts-proxy:8810`。Nginx 管理双卡后端，网站只设置统一入口；主机开发时配置主机可访问的代理地址。后端迁移或扩容无需修改网站代码。部署见 `../tts-proxy/README.md`。

逐句接口为 `/api/lines/[stem]/tts`；单条采用/删除为 `/api/lines/[stem]/tts/[id]`；试听为 `/api/lines/[stem]/tts/[id]/audio`。

正式节点部署说明见 `../../gpu/tts-official/README.md`；旧 NVIDIA 与 AMD 对照环境见 `../../gpu/tts/README.md`。

`data/` 里的 MP3 禁止提交。

逐条列表每条台词占两行：左侧状态/区域上方合并两列仅展示完整 stem（可点击进入详情），下方分别展示状态与区域；stem 行压缩至约 16px，其余文字垂直居中；其余列跨两行，避免新增标识列挤占音频与字幕空间。

## 当前 IndexTTS zero-clone 流程

- 正式逐句生成走 `/api/lines/[stem]/tts/clone`，默认用当前台词对应的日文原音作 prompt，也可选人物预设或前后邻近的同人物原音。
- 不依赖角色 embedding，不经过 Seed-VC，也不需要启动 `INFERENCE_HOST`。
- 场景演出对齐日文起点和说话时长；普通对话优先自然语速。场景演出中文改写应在不改变意思的前提下尽量贴近日文音节数，中文标点通常会占约 1–2 个音节时长，避免用明显拉伸语速补偿大幅差异。
- 每次生成会保存实际朗读文字、prompt、音频、时序和 manifest；生成结果默认不用于模组，试听后手工勾选。删除历史会清理数据库记录、WAV 和 manifest。
- 显式停顿语法为 `[停顿=500]`，范围 50–5000ms。

## 日中拍数显示（2026-09-28）

列表在中文及修改版「起 / 止 / 长 / 说」后显示「比」，悬停显示日中拍数；详情页显示原文、输入中的 TTS 文本（250ms 防抖）和历史 TTS 拍数。悬停可看读音和汉字/标点拆分。读取 `tts_text`，不使用可能不同的字幕改写文本。

网站 TS `/api/beats` 批量转发至 `MORA_URL`（Compose 中 `http://mora:8000`），与 worker CLI 共用 `mora_core.py`。日文正文 ≤5 字跳过；中日文末尾连续标点计 0，句中标点每个 1.5 拍，字幕换行不算句末。计算纯代码，不使用 LLM。仅计算非斜体的「对话－场景演出」。比 = (日文拍数 / 中文拍数) / 1.20，1.00 为正常中心；偏离超过 10% 警告，超过 15% 异常。统计、报警筛选和背景色合并拍数与原有对时等级，已锁定及人工确认条目不报警。绿色表示已锁定或人工确认忽略对时；未修改且正常的行保持默认底色。未锁定候选不视为已修正，源中文仍参与统计。

生产部署：在 `studio-ff7-rb/` 执行 `docker compose --profile full up -d --build mora website`。本机开发可用 mora venv 运行 `worker/mora_server.py`，网站默认访问 `http://127.0.0.1:8000`。

## 自动修正语速

详情页「实际 TTS 文字」旁的按钮打开候选弹窗，前端两条请求队列共调用五次 `/api/lines/[stem]/rewrite`，逐个显示结果。选中只填入输入框，不生成音频、不保存字幕、不改变锁定。关闭会取消尚未完成的前端请求和后续队列。

网站服务环境变量 `REWRITE_LLM_URL` 为 NewSDW-LLM 根地址，当前 Compose 默认 `https://inference.example.invalid`；可选 `REWRITE_LLM_MODEL` 覆盖服务默认模型。请求 `/v1/chat/completions`，每个候选严格一次 LLM 调用，无隐藏重试。模型只看原中文和当前中文，日文由 Python 核心转换为目标拍数，不让模型翻译日文。中文目标为日文拍数÷1.20；字数预算与候选评分均由代码计算。五种改写侧重点及前序候选实测反馈位于 `src/lib/rewrite-prompt.ts`。候选按比值距 1.00 的绝对偏差升序排列，不显示黄色解释行；无有效比值的结果排后。模型不保证意思正确，保留用户选择。

锁定时如需将 TTS 文字同步为字幕，先弹出「确认字幕并锁定」多行编辑框。取消不修改数据，确认以同一个事务保存字幕和锁定状态。服务端首次返回 `409 SUBTITLE_CONFIRMATION_REQUIRED` 与待编辑内容，禁止无确认自动写入；详情、历史记录及列表锁定共用 `tts-lock-client.ts`。已有字幕改写或无需同步时沿用直接锁定。

改写反馈使用更窄的正常范围 **0.92–1.08（含边界）**。本轮每条已完成候选作为 assistant 样例，后接程序计算的比值、偏慢/正常/偏快判定以及增减字数建议，再要求模型“再输出一条”。比值>1.08表示中文偏短、偏慢，应加字；<0.92表示偏长、偏快，应减字；正常时保持长度换一种说法。双并发首两次独立，后续请求带上本轮已完成的全部样例，每轮五次重置，不跨轮累积；列表报警阈值仍沿用原规则。

## Rubber Band 运行资源

G 算法使用 Rubber Band 4.0.0 R3 短窗。仓库只提交 `third_party/rubberband/` 中的桥接源码、补丁、许可和构建脚本；生成的 WASM、上游压缩包和适配器下载包位于 ignored `public/vendor/rubberband/`，不提交二进制。

准备 Emscripten 3.1.6、curl、patch、tar 后，在网站目录执行 `bash third_party/rubberband/build.sh`，再运行测试、Next 构建或 Docker 构建。脚本下载固定版本、核对 SHA256、应用补丁并生成浏览器/Node 共用资源。变更适配器后执行 `bash scripts/package-rubberband-source.sh` 刷新对应源码下载包。完整算法与许可说明见 `docs/rubberband-r3.md`。
