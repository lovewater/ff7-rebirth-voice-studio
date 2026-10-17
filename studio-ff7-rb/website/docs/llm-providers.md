# 大模型连接与台词改写路由

通用入口是 `src/lib/llm-chat-client.ts` 的 `callChatCompletion`，目前注册三套相互独立的连接：

| modelId | 环境变量前缀 | 用途 |
|---|---|---|
| `primary` | `REWRITE_LLM_` | 原云端连接，负责分类、校字、候选择优、字幕断行和补引号 |
| `volcengine` | `VOLCENGINE_LLM_` | 火山 Agent Plan，负责创作及改写台词 |
| `self-hosted` | `SELF_HOSTED_LLM_` | 自部署开源模型，只在调用方显式选择时使用 |

每套配置都有 `URL`、`MODEL`、`KEY` 三个字段。URL是兼容Chat Completions的基础地址，入口统一追加`/chat/completions`。
实际地址和密钥只写在部署目录受Git忽略的`.env`，通过Compose传给网站，不写进源代码、请求体或访问日志。
普通方舟按量接口的`ARK_API_KEY`和Seed-ASR的`SEEDASR_API_KEY`不作为套餐连接的替代密钥。

## 默认任务路由

`chatModelForTask`把以下任务交给火山，默认模型为`doubao-seed-2.1-pro`：

- `script-rewrite`：自动运行中的五稿改写，以及后续追加候选和重试。
- `fallback-duration-rewrite`：整体TTS线路的第二、三轮按实测时长改稿。
- `manual-rewrite`：详情页手动改写台词。
- `prompt-trial-script-rewrite`：显式使用这个任务名的提示词调试。

其他任务仍走`primary`。特别是`manual-selection`只选已有台词，不创作新台词，因此继续用原连接。
`subtitle-layout`和`subtitle-quotes`只排版或加引号，也不改变台词正文。
调用方显式传入`modelId`时优先使用该连接，以便保持独立实验和本地模型入口。

手动改写接口也使用`rewriteChat`，由统一入口完成模板展开、三位小数处理、模型选择和日志记录。
接口的`configured`根据实际改稿模型检查，不能拿旧连接已配置来掩盖套餐连接缺少密钥。

## 火山连接行为

独立配置及请求参数在`src/lib/llm-volcengine.ts`。沿用原改稿的温度、JSON响应格式、4096输出token上限和关闭思考设置。
套餐连接不发送按量接口的`service_tier=flex`，不使用会改变底层模型的Auto别名。

HTTP 408、429和5xx，以及临时网络失败，可以在调用方允许的次数内重试同一套餐连接。
429参考`Retry-After`等待，最多60秒；401、403、参数错误和用户取消不重试。
日志数据库写入失败时不再请求模型。自动五稿线路传`attempts=1`，继续由原有单稿重试逻辑负责，避免两层重试相乘。
套餐报错不会自动切回原模型、普通方舟按量服务或自部署模型。

## 访问日志与生产配置

三套连接均使用`llm_access_logs`保存实际输入、模型、端点、完整输出、token及耗时。
每次HTTP尝试独立一行，同次调用用`invocation_id`归组；自动流程仍归属于对应`auto_run_id`。
不将套餐AFP额度猜算成API返回的token，也不根据本地估价判断是否已从套餐抵扣；套餐实际扣量以控制台为准。

部署时新增以下配置，三个值由本机环境提供：

```dotenv
VOLCENGINE_LLM_URL=
VOLCENGINE_LLM_MODEL=doubao-seed-2.1-pro
VOLCENGINE_LLM_KEY=
```

线上切换连接需要更新容器环境及构建产物。提示词库仍在每次请求时读取数据库的最新启用版本，不需要为编辑提示词重启服务。
