# 网站TTS大模型切换Grok（2026-11-04）

两站已部署默认Grok连接，模型grok-4.7。参考根grok-api/使用说明.md。真实密钥只放每游戏私密.env，Compose引用GROK_LLM_URL/KEY/MODEL；Docker用宿主机可达地址。low推理不等于关闭思考。

- 默认连接ID=grok；primary仍为官方GLM、REWRITE_LLM_*不变，火山和自部署仍保留显式连接。没有按错误或未知额度自动跨模型回退。
- 场景三轮全Grok、field单轮，HTTP clone显式传当前模型，服务端核对模型/轮次与已存stage；历史GLM正确显示。24/轮、72/项与第三轮仅最终结构失败才允许补切不变。
- 默认请求超时310秒。Grok临时HTTP错误仅在同连接有界退避，503/5xx等待15→30秒，429更长，Retry-After最多60秒。401/403、取消不回退。已有单稿四次操作重试的路径由外层等待，每次HTTP attempts=1，禁止3×4。
- 注册音色、TTS/ASR引擎、阈值/字幕/词典算法未切换。网站两个容器重建，PG及CPU服务未重启；TTS代理仍停。

## 验证和边界

真实请求只做3次合成文本：宿主代理预检1次、每站容器默认client各1次，均实际返回grok-4.7及合法中文JSON。容器验证使用内存日志sink，不写业务表；同时核对自动stage全Grok/24/24/24/第三轮补切标记。两站改稿GET均configured=true；源台词、音频版本、LLM业务日志计数和running任务数与切换前完全一致。

Provider/client相关90项定向mock、自动路由/外层重试53项聚焦、独立117项mock复审均通过，生产构建与TypeScript通过。扩大历史回归发现旧fixture/旧断言失败，对照旧线上源码也可复现，未把扩展套件宣称全绿，未顺改旧算法。面板已有effect lint问题未在本次改播放器状态逻辑。

部署镜像c4e6f750d5952469ea73271c585474c5d96416f07292abf2601e88f6d06ed5c5。回滚标签ff7-remake-website:before-grok-20261104、ff7-rebirth-website:before-grok-20261104；真实.env前备份各游戏.private/grok-switch-20261104/env-before，不提交/输出。验证快照及具体日志位于根work/grok-switch-20261104/，没有提交或推送。

用户最新要求先讨论不同音频的流程、Seed参与和通过条件，再准备开跑。当前未启动任何实际台词改稿、ASR、TTS或批次。新流程开跑前尚需对齐无中文正文的选稿入口、ASR来源、unknown分类、field全零规则与旧文档比值；详见根work/grok-switch-20261104/FLOWS.md。Qwen-27B已被用户移作他用，本次没有访问/启动它；Qwen-ASR是另一个识别服务，只查健康未发识别任务。
