# 自部署开源模型调用

统一入口是 `src/lib/llm-chat-client.ts` 的 `callChatCompletion`。已注册 `primary`、`volcengine` 和 `self-hosted` 三套连接：台词改写默认走火山，其余默认走原云端模型；自部署模型仍须显式选择。详见 [大模型连接与台词改写路由](llm-providers.md)。

```ts
import { callChatCompletion } from "@/lib/llm-chat-client";

const result = await callChatCompletion({
  modelId: "self-hosted",
  task: "text-review",
  messages: [
    { role: "system", content: "只输出JSON对象。" },
    { role: "user", content: '请返回 {"ok":true}。' },
  ],
});
// result.content为完整正文，result.thinking为独立思考；失败不会返回半截正文。
```

模板调用仍用 `rewriteChat`，保持原接口；第五个可选参数 `{modelId: "self-hosted"}` 可显式选本地。它使用调用者传入的temperature。直接用通用入口时，本地默认使用官方thinking采样：temperature=1.0、top_p=0.95、top_k=20，medium思考开启并保留思考历史；没有的历史思考不会伪造。

## 配置与并发

网站从 `SELF_HOSTED_LLM_URL`（兼容Chat Completions的基础地址，如`https://inference.example.invalid`）、`SELF_HOSTED_LLM_MODEL`、`SELF_HOSTED_LLM_KEY` 读取配置。密钥在Git忽略的 `.env`，不入代码、请求快照或响应日志。

Compose 不包含部署地址，模型地址、名称和密钥均由环境变量提供。参数改变需要重建网站容器；数据库提示词仍是每次读取，改提示词不用重启。不会为了配置本地模型改变primary的环境变量。

同一网站进程总计最多4路本地调用，包括重试。排队可被调用者的AbortSignal取消；HTTP耗时从取得槽后计算，客户端排队时间不冒充推理耗时。多个网站副本/外部客户端不共享进程内限流，推理服务自身的max-num-seqs负责实际执行槽。

## 重复检测和中止

算法采用 [vLLM的连续n-gram检测思路](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/utils.py)，但做在客户端，兼容不同服务版本。与修改采样概率的repetition_penalty不同，这里发现失控后主动终止。

- 思考和正文各有独立检测器，不跨通道累计；支持`reasoning_content`和`reasoning`字段。
- 按用户最终规则，任意片段**连续重复10次**立即停止；重复9次不停止，没有短词/拟声豁免。正常5个哈能通过，10个哈会停止。
- 空格、换行、制表符等统一为空白字符，所以混合空白连续10个同样触发。
- 片段长度默认检查1～512个Unicode字符；可用 `selfHosted.maxPatternLength` 调整到4096。网络分块、UTF-8字节分块和emoji代理项分块均不影响计数。
- 使用环形缓冲和每种片段长度的匹配计数，每字符O(最大片段长度)，空间有界；不反复扫描整段不断增长的思考。
- 一旦触发，立即`AbortController.abort()`并`reader.cancel()`，让HTTP断开且服务端停止生成。失败半截只记日志，不拼入下一次输入。

SSE读取支持CR/LF/CRLF、多行data、注释心跳、usage末包和`[DONE]`。不按SSE包计重复，不因心跳/role空包误判；注释心跳也不能掩盖长时间没有正文/思考进展。

## 重试和失败

默认**共3次尝试（首发+2次重试）**，每次重新创建控制器、reader、检测器和计数。失败重试使用原prompt和参数，不拼接失败答复、不偷偷改调收费模型。间隔默认250ms、500ms。

重复、网络异常、断流、无效JSON、达到输出上限、HTTP408/429/5xx等可以重试。HTTP400/401等确定性请求错误不重试；用户取消不重试。日志落库失败也不继续发起无记录的调用。

每次HTTP请求默认总上限30分钟；连续120秒没有正文或思考增量则超时。默认输出上限16384 token，包含思考。可通过 `maxTokens`、`attempts` 及 `selfHosted.timeoutMs/idleTimeoutMs/retryDelayMs` 明确调整。上述总时限从取得并发槽后开始；调用者可用`signal`限制整个排队+请求过程。

默认要求JSON对象，完成后检查正文可解析性；普通文本可设 `json:false`。未知或不完整的finish_reason、未收到完成标志、截断输出都不能当作成功。重试耗尽抛 `SelfHostedLlmError`，其 `code` 和 `attempts` 可供业务处理。

## 数据库日志

每次HTTP尝试先保存pending请求，再发送。重试共用invocation_id，attempt递增；每次都独立记录结果，不覆盖前次失败。

`request_body`保存实际发出的`stream:true`与`stream_options.include_usage:true`及全部展开消息，数字仍按统一入口保留最多三位小数。`response_raw`是实际收到的SSE全文，主动停止只包含已收到部分；`response_body`是归并的ChatCompletion，停止时`stream_guard`含通道、模式、次数、字符位置。正文与思考分别完整保存。

新增状态：`repetition-detected`、`stream-error`、`timeout`、`cancelled`，迁移 `db/init/045_llm_stream_guard.sql`。

主动断流通常拿不到最后usage，所以未知token保持NULL，不按字符数估算、不假装0。正常完成使用供应商最终usage，思考token不重复累加。每日备份继续排除这张日志表的数据。

## 验证

- `node --experimental-strip-types --test src/lib/llm-self-hosted.test.cjs`：跨包重复、阈值9/10、空白、思考、emoji、SSE、取消、超时、重试、并发及真实HTTP服务端取消。
- `node --experimental-strip-types scripts/test-llm-access-log.cjs`：真实Postgres事务验证失败/重试/原始SSE/未知token，结束回滚，不产生模型费用。
- 2026-10-17对原99次实验逐字符回放：仅原来2次空白故障触发，正常97次无误拦。对应正文第134、44字符处触发，无需等到16384输出token。
