# 官方 IndexTTS 2.0 双卡服务

GPU1/GPU2 两张 22GB 2080 Ti 各运行一份官方 IndexTTS 2.0，使用 FP16 autocast；网站仅访问 Nginx `http://tts-proxy:8810`。后端地址、数量和负载均衡由代理管理，见 [代理部署说明](../../studio-ff7-rb/tts-proxy/README.md)。

## 部署

在推理主机准备 `upstream/` 官方源码与 `models/IndexTTS-2` 权重。固定源码 revision `ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c`，构建时应用 `patches/apply_patch.py`。模型权重、辅助缓存和第三方源码不随仓库分发。

在 `gpu/.env` 本地填写 `INDEXTTS_BASE_IMAGE`（含 PyTorch/torchaudio 2.8.0+cu128 和官方依赖的基础镜像）、`INDEXTTS_MODEL_DIR`（宿主机 IndexTTS 2.0 权重目录）。模型目录需可写，辅助权重保存在其 `hf_cache/` 下。不要从裸 CUDA 底座重复下载依赖。

```bash
cd gpu/tts-official
docker compose --env-file ../.env -f docker-compose.sis.yml build tts-gpu1
docker compose --env-file ../.env -f docker-compose.sis.yml up -d --no-build
curl -fsS http://127.0.0.1:8811/health
curl -fsS http://127.0.0.1:8812/health
```

两个容器分别绑定 GPU1 / GPU2，宿主端口 8811 / 8812，均自动重启。模型共用宿主权重目录，音色共用 `./data/speakers`。每个容器自己的 `/gpu-lock/inference.lock` 独立串行推理；不得给两张卡挂载同一个宿主锁。ASR 保持在 GPU0。

- 2080 Ti 无原生 BF16，设置 `INDEXTTS_PRECISION=fp16`；权重 FP32，autocast FP16。
- 固定 `use_random=false` 和官方文本标准化，关闭 CUDA kernel、DeepSpeed、torch compile。
- `use_qwen_emo=true` 保留官方加载配置；不部署独立 emotion 服务。
- 正式 `/v1/tts/clone` 的参考音随请求传入，不经过 Seed-VC，不额外补参考音尾静音。
- `speaker/embed`、`register`、`compare` 继续可用；新音源总长不超过15秒。
- 旧 `/v1/tts` 的 Seed-VC 流程需要另行配置，本部署不启动 Seed-VC。

迁移时先校验权重并实际验证新后端，再切换代理，最后停旧服务。旧 `docker-compose.yml` 保留历史 5080 配置，默认禁用启动和自动重启，只能通过 `legacy-5080` profile 显式启动。
