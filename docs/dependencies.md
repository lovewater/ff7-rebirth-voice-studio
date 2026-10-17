# 外部依赖与运行数据

仓库只包含本工程的代码。以下内容在部署机器单独准备，禁止加入 Git。

- `programs/bin/`：AudioMog、VGAudio、retoc、repak、vgmstream 等工具二进制。
- `programs/vendor/`：构建这些工具时使用的第三方源码。工具来源和命令见 `programs/README.md`。
- `gpu/tts/tts_base/`、各推理服务的 `upstream/`：对应模型的官方源码，按其许可证和版本单独获取。
- `gpu/**/models/`、`checkpoints/`：模型权重与 Hugging Face 缓存。
- `game/`、`work/`、`studio-ff7-rb/website/data/`、`studio-ff7-rb/db/data/`：游戏资源、中间产物、音频与数据库数据。

IndexTTS 上游为 <https://github.com/index-tts/index-tts>。旧版 TTS 包装记录了上游 revision `ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c`；需要使用该包装时，在 `gpu/tts/tts_base/` 或官方服务的 `upstream/` 准备相应源码。不要把上游仓库及其历史加入本仓库。

原部署使用的私有镜像名称和 registry 地址不公开。相关 Dockerfile 改为通过 `BASE_IMAGE` 构建参数接收已经准备好、具备对应 CUDA/PyTorch/模型依赖的基础镜像，例如 `docker build --build-arg BASE_IMAGE="$INDEXTTS_BASE_IMAGE" .`。这不会自动安装完整模型依赖。ASR Compose 使用 `ASR_IMAGE`，官方 TTS Compose 使用 `INDEXTTS_BASE_IMAGE`。

各服务示例中的端口、容器内路径和公开软件源不是生产连接信息；真实机器地址、宿主机挂载路径和访问凭证需要写入部署机器自己的环境配置。历史部署说明已对机器地址和个人路径作替换，文档中的示例不能直接当作已部署环境使用。
