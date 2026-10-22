# shared

对接约定，没有业务代码。

- **正式 TTS 入口**：网站 Compose 内 `http://tts-proxy:8810`，局域网 `http://studio-host:8810`。Nginx 管理所有后端地址和负载均衡，网站只知道统一入口。
- **TTS 后端**：inference-host GPU1 / GPU2 各一份官方 IndexTTS 2.0，FP16 autocast，端口 `8811` / `8812`；共享模型和音色文件，独立推理锁。模型权重不要拷到 VM。
- **ASR**：inference-host GPU0 11GB，`:8001`，保持不变。
- **5080**：不再承担 TTS。`tts-union-test` 已停且禁用自动重启，双 22GB 卡用于 FF7。
- **amd-inference-host**：AMD IndexTTS 2.5 实验当前已停，按需启动后 `amd-inference-host:8100`，不作为正式入口。
- **本机 VM**：修订台向代理发送 MP3/base64，参考音在 `website/data/{jp,cn}/`；不存权重和镜像。

不使用独立 emotion 服务。正式 `/v1/tts/clone` 不经过 Seed-VC。

后端部署见 `tts-official/README.md`；代理扩容与热加载见 `studio-ff7-rb/tts-proxy/README.md`。
