# IndexTTS 2.0 官方服务

2026-10-23 按用户要求恢复 RTX 5080 正式 TTS：`chaoran@inference.example.invalid:/srv/ff7/ff7-indextts-official`，宿主 GPU1，端口 `8810`，官方 IndexTTS 2.0 BF16。`docker-compose.yml` 默认启动，`restart: unless-stopped`。网站 Nginx 的 upstream 经验证后同时接入该节点与同机 GPU0 的 22GB RTX 2080 Ti（FP16，端口 `8812`）。

同机 GPU0 新 worker 为 `ff7-indextts-2080ti-gpu0`，使用 `docker-compose.2080ti.yml`、`restart: unless-stopped`。复用现有 5080 镜像和 `./models`、`./data`，将支持 FP16 的 `app/main.py` 同步为远端 `app-2080ti/main.py` 并单独挂载；推理锁只在新容器内，不挂共享宿主锁。端口 8812，避免占用旧 Seed-VC 8811。

removebg 原业务已迁出；旧容器已停止、restart=no，远端原 Compose 中增加 `retired-removebg` profile，代码和数据保留。

```bash
# 在 /srv/ff7/ff7-indextts-official，先同步最新 app/main.py 到 app-2080ti/main.py
docker compose -p ff7-indextts-2080ti -f docker-compose.2080ti.yml up -d --no-build
curl -fsS http://127.0.0.1:8812/health
```

下列 inference-host 双卡部署保留作为备用配置，网站代理当前不再向它发送新请求。

网站经独立 Nginx 统一入口访问：Compose 内 `http://tts-proxy:8810`，局域网 `http://inference.example.invalid:8810`。后端地址只在 `studio-ff7-rb/tts-proxy/nginx.conf` 管理，搬迁或扩容后热加载代理即可。网站不保存 GPU 数量和后端地址。

| 后端 | 宿主 GPU | 地址 | 容器 |
|---|---|---|---|
| inference-host | GPU1 22GB 2080 Ti | `inference.example.invalid:8811` | `ff7-indextts-gpu1` |
| inference-host | GPU2 22GB 2080 Ti | `inference.example.invalid:8812` | `ff7-indextts-gpu2` |

部署目录 `/srv/ff7/ff7-indextts-official`。`docker-compose.sis.yml` 启动两份相同镜像，分别只暴露一张卡；模型共用 `/srv/ff7/models/IndexTeam/IndexTTS-2`，音色共用 `./data/speakers`。推理锁位于各容器自身 `/gpu-lock/inference.lock`，不得将两卡挂到同一个锁文件。两个 TTS 和原 GPU0 ASR 均使用 `restart: unless-stopped`。原 `tts-union-test` 已停止且禁用自动重启。

## 部署

修订台 VM 只保留代码，镜像只在 GPU 主机构建，权重只放 GPU 主机。源码固定 `ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c`，带 `patches/apply_patch.py`，来源与原 5080 正式服务一致。

```bash
# 将 app/、patches/、Dockerfile.sis 和 docker-compose.sis.yml 同步到部署目录。
# upstream/ 是上述 revision 的官方 checkout；保持原正式部署的补丁。
cd /srv/ff7/ff7-indextts-official
docker pull inference.example.invalid:5000/ff7-gpu-tts:indextts25-cu128
docker compose -f docker-compose.sis.yml build tts-gpu1
docker compose -f docker-compose.sis.yml up -d --no-build
curl -fsS http://127.0.0.1:8811/health
curl -fsS http://127.0.0.1:8812/health
```

镜像底座提供 PyTorch / torchaudio 2.8.0+cu128；推理源码由 `upstream/` 覆盖。不要从裸 CUDA 底座重复下载依赖。`models/IndexTTS-2/hf_cache/` 需包含 w2v-bert、semantic_codec、campplus、bigvgan 辅助权重。

inference-host 曾有 Docker `inference.example.invalid/20` 网桥覆盖内网地址，导致仓库和共享盘走错路由。已用 `/etc/netplan/99-ff7-model-storage.yaml` 为 `inference.example.invalid/32`（Registry）、`inference.example.invalid/32`（共享盘）指定经 `inference.example.invalid` / `ens18` 的路由，不改变其他项目的 Docker 网络。

## 推理与接口

- `/health` 返回模型 2.0、源码 revision、FP16 autocast 和设备信息。
- 2080 Ti 没有原生 BF16；设置 `INDEXTTS_PRECISION=fp16`，模型权重 FP32、autocast FP16。
- 保留 `use_random=false`、官方文本标准化；关闭 CUDA kernel、DeepSpeed、torch compile。
- `use_qwen_emo=true` 是既有官方模型加载配置；不部署独立 emotion 服务。
- 正式逐句 `POST /v1/tts/clone` 参考音随请求传入，不经过 Seed-VC；参考音不再由后端额外补尾静音，保持原 5080 正式行为。
- `POST /v1/speaker/embed`、`register`、`compare` 继续可用；新音源总时长不超过 15 秒，两个 worker 共享音色文件。
- 旧 `/v1/tts` 的 Seed-VC 流程需要另外配置服务；这次不启动 Seed-VC。

5080 正式使用 `docker-compose.yml`；inference-host 备用使用 `docker-compose.sis.yml`。Nginx 部署与热加载步骤见 `studio-ff7-rb/tts-proxy/README.md`。
