# 公共 CPU worker

这里维护一份与游戏容器格式无关的拍数、音频静音/净语速测量、指标缓存和 HTTP 服务代码。
网站与Compose均直接使用此目录，发布副本不重复维护Rebirth的CPU源码。
现有 Rebirth 容器使用镜像里的旧代码，整理这些源文件不要求停止或重建它。

构建上下文必须是本目录：

```bash
docker build -f Dockerfile.mora -t ff7-studio-shared-mora .
```

已有 CPU 依赖环境时，可用 `Dockerfile.mora.runtime` 仅更新六份公共 Python 源码，
避免建立新游戏实例时顺带升级系统包、NLP 依赖或重新准备字典：

```bash
# BASE_IMAGE 必须指向已核对的本地 CPU 镜像；不提供默认镜像。
docker build --pull=false -f Dockerfile.mora.runtime \
  --build-arg BASE_IMAGE=ff7-studio-mora-deps:local \
  -t ff7-studio-shared-mora .
```

本机基础 tag 应从当前已验证的 CPU 镜像 ID 单独创建，不覆盖正在运行的 Rebirth 镜像/tag或容器。
记录基础镜像 ID 后构建，再通过 Compose 的 `--no-build` 使用派生镜像。
完整 `Dockerfile.mora` 保留给明确需要从空环境安装时使用；运行配置、游戏标记和数据库隔离校验仍完全相同。

每款游戏启动独立 CPU 服务进程，分别传入自己的 `DATABASE_URL`、`AUDIO_DATA_ROOT` 和 `FF7_GAME_ID`。
`GET /health` 返回 `ok` 和 `game_id`；不会显示连接凭据。
Remake 不允许数据库或音频根目录默认值，要求使用 `studio_ff7_remake` / `ff7remake`，
且音频目录必须包含 `.ff7-game.json`：

```json
{"game_id":"remake","database":"studio_ff7_remake"}
```

Rebirth 保留历史默认配置；只要目录存在游戏标记，也必须与当前游戏匹配。
默认 Rebirth 身份同样拒绝连接 Remake 保留的数据库/账号；已有其他隔离试验数据库不受影响。
共享的是程序，指标缓存表、音频文件、游戏地图的处理优先级均属于各自实例。

本次保留实际旧算法中的比例常数 1.33；它与根 AGENTS.md 的 1.20 规定冲突，
已记录为独立待处理项，不在架构重构时改变现网行为。
