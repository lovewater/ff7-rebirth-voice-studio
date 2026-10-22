# TTS 统一入口

网站在 Compose 内只连接 `http://tts-proxy:8810`。主机开发模式使用主机可访问的代理地址。后端迁移或扩容无需修改或重启网站。

在本地 `.env` 填写 `TTS_BACKEND_1`、`TTS_BACKEND_2`，格式为 `主机:端口`。同一推理主机的双卡端口分别为 8811 / 8812。真实地址不写入模板或提交 Git。

```bash
cd studio-ff7-rb
docker compose --profile full up -d tts-proxy
docker compose exec tts-proxy nginx -t
curl -fsS http://127.0.0.1:8810/health
docker compose logs --tail 30 tts-proxy
```

官方 Nginx 镜像启动时将 `nginx.conf.template` 渲染成 `/etc/nginx/conf.d/default.conf`，只替换已声明的环境变量，保留 Nginx 自身变量。代理使用 `least_conn` 和共享 upstream 状态，提供被动故障切换；请求体上限100MB，读超时1200秒，不重放已送达后端的合成 POST。

修改 `.env` 的后端地址后，只重新创建代理：

```bash
docker compose --profile full up -d --no-deps --force-recreate tts-proxy
```

只修改代理模板时可渲染、校验后热加载，保留在途连接：

```bash
docker compose exec tts-proxy /docker-entrypoint.d/20-envsubst-on-templates.sh
docker compose exec tts-proxy nginx -t
# 仅在上一步成功后执行
docker compose exec tts-proxy nginx -s reload
```

网站 `TTS_MAX_INFLIGHT` 默认8，是在途请求预算，与 GPU 数量无关；后端各自串行推理。自动台词任务仍保持4并发。单个 URL 不再强制串行，双卡可并行处理候选。

同一宿主机的双卡共享 speaker 文件，不依赖粘性会话。迁移到不同主机时须同步或共享 speaker 文件；clone 参考音随请求传入。后端部署见 [IndexTTS 配置](../../gpu/tts-official/README.md)。
