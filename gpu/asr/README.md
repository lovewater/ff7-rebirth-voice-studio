# ASR — Qwen3-ASR-1.7B / 可选 ForcedAligner

inference-host **GPU0（11GB）**，端口 **8001**。镜像 `qwen3-tts:v1.1.4`，权重 `/srv/ff7/models/Qwen/Qwen3-ASR-1.7B`。开机只自动起这个容器。这台机器上的 TTS 镜像和权重已清掉，ASR 保留。不使用emotion。

用来听写、对专名（萨菲罗斯、魔晄炉）。中日都能打。

```http
POST :8001/asr
```

```json
{
  "task_id": "example",
  "sample_audio": "<base64>",
  "language": "Japanese",
  "use_forced_aligner": true
}
```

`sample_audio` 沿用 URL、data URL base64、纯 base64、本地文件路径。`language` 可省略自动识别。`use_forced_aligner` 默认 `false`：只识别、不加载或执行对齐器，响应保持原来的字段，不增加 `alignment: null`。首次显式开启时，服务在ASR所在GPU加载 `Qwen3-ForcedAligner-0.6B`，随后常驻复用；之后的普通识别请求仍不执行对齐。

开启后，在原有 `results[]` 每条结果中增加 `alignment`：

```json
{
  "success": true,
  "message": "ok",
  "calc_time": 0.7,
  "file_path": "/app/cache/example.wav",
  "results": [
    {
      "text": "待って",
      "language": "Japanese",
      "alignment": {
        "model": "Qwen/Qwen3-ForcedAligner-0.6B",
        "status": "ok",
        "time_unit": "seconds",
        "calc_time": 0.06,
        "items": [
          { "text": "待っ", "start_time": 0.16, "end_time": 0.4 },
          { "text": "て", "start_time": 0.4, "end_time": 0.56 }
        ]
      }
    }
  ]
}
```

此示例仅说明结构，不代表真实请求的识别/时间结果。所有 `start_time` / `end_time` 相对**输入音频**，单位**秒**；不从首个字重新归零。程序透传模型输出，不过滤零时长词、不另按字数插值。日文默认是分词单位，不承诺逐个汉字；这些时间轴并不证明音频完整读出了某段文字。

`alignment.status`：

|状态|含义|
|---|---|
|`ok`|模型返回时间轴，见 `items`|
|`empty`|ASR没有有效文字，`items=[]`，不调用对齐器；不代表已判定环境音|
|`unsupported_language`|无法确定语言或对齐器不支持该语种，`items=[]`，`error`说明原因|
|`error`|对齐器加载/推理失败，`items=[]`，`error`说明原因|

顶层 `success` 继续表示ASR是否成功。即使ASR成功，对齐也可能失败；需要时间轴的调用者必须另外检查 `alignment.status`，不能将空 `items` 当作可用对齐。对齐失败保留已识别的 `text`，不会静默省略 `alignment`。ASR本身失败仍是原来的 `success=false/results=[]`。

顶层 `calc_time` 保持ASR推理耗时，不含排队、预处理或对齐；`alignment.calc_time` 单独计对齐耗时，首次包括对齐器懒加载。空文本/不支持语种未运行模型时为0。

对齐优先采用ASR识别出的语言，缺失时才使用请求的 `language`。支持 Chinese、English、Cantonese、French、German、Italian、Japanese、Korean、Portuguese、Russian、Spanish，以及常见语言代码（如 `zh-CN` / `ja-JP`）。识别仍支持更多语种，不会因开启对齐而丢弃不支持语种的转写。

两个模型共享同一个进程/GPU推理锁，ASR后再对齐，多请求在GPU内部排队，不并行冲显存。ASR内部 `max_inference_batch_size=1`。2080 Ti 使用FP16 / SDPA；对齐器沿用ASR初始化时的同一设备和精度配置，不使用CPU offload。具体双模型峰值/长音频余量由部署实测确认，不把短句测量当作任意时长或大批量保证。

Compose 已设置容器路径环境变量：

```text
QWEN3_ASR_MODEL_PATH=/root/autodl-tmp/models/Qwen/Qwen3-ASR-1.7B
QWEN3_FORCED_ALIGNER_MODEL_PATH=/root/autodl-tmp/models/Qwen/Qwen3-ForcedAligner-0.6B
```

两份权重都位于GPU主机 `/srv/ff7/models/Qwen/`，通过既有只读模型目录挂载，不下载到网站VM。对齐器不可用不影响默认纯ASR启动；开启请求会明确返回对齐加载失败。

CPU mock与缓存并发回归（不加载模型、不发真实推理）：

```bash
python3 -m unittest discover -s gpu/asr/tests -v
```

既有识别专项：`gpu/tests/asr_cn_terms.py`。本次API能力不改变网站调用方，不启动TTS或生成批次。

2026-11-04 已部署到上述8001服务，并在实际GPU0的11GB 2080 Ti验证：默认/false旧响应、中日开启对齐、自动语种、60秒音频及4个混合并发请求均通过。测试后两模型常驻时，整张GPU占用约6916MiB（6.75GiB），空闲约3907MiB；这是本次工作负载的观测，不是任意时长的峰值保证。独立同架构受限显存测试中，60秒输入的PyTorch峰值分配约6119MiB、保留6682MiB。16项CPU接口/异常隔离/并发回归通过。

部署与资源证据在主工程 `work/asr-alignment-api-20261104/`，原代码备份在GPU主机 `/srv/sourcecode/ff7-asr-alignment-test-20261104/production-before/`。本次只更新ASR容器，网站没有开始传入新参数，Seed流程和TTS保持原状。
