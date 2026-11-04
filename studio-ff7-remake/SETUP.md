# Remake 基础设施

这是一款独立游戏的数据实例，公共流程源代码在 `../studio-common/website` 和 `../studio-common/worker`。Rebirth 网站继续使用既有容器，不因准备 Remake 而重启。

2026-11-03 已完成初始化和独立启动，当前入口为 `http://192.0.2.10:8767`。
首次空站检查曾报告 `game=remake`、`lineCount=0`、`awaiting-import`、`extractionReady=false`。现在真实游戏已复制到根 `game/FINAL FANTASY VII REMAKE/`，本作只读PAK与SAB音频/字幕提取已通过实物验证，已按独立数据库导入目录；当前台词数和导入状态以 `/api/project` 实时结果为准。封包仍禁用，未声称已通过Win11游戏验证。
完整检查结果及首次 NAS 归档的未完成状态见 [重构验证报告](../studio-common/docs/refactor-validation-20261103.md)。

| 项目 | Remake | Rebirth（保留） |
|---|---|---|
| 网站端口 | `8767` | `8765` |
| PostgreSQL 数据库 | `studio_ff7_remake` | `studio` |
| PostgreSQL 角色 | `ff7remake` | `ff7rb` |
| 音频数据 | `studio-ff7-remake/website/data` | `studio-ff7-rb/website/data` |
| 游戏与工作目录 | 根 `game/FINAL FANTASY VII REMAKE/`、本目录 `work/` | 原Rebirth源和工作数据不移动 |
| CPU 分析服务 | `remake-mora`、`remake-speech-metrics` | 原服务不变 |
| NAS 新备份 | `ff7-backup/remake` | `ff7-backup/rebirth`；旧历史仍保留 |

共用既有 PostgreSQL 容器与 TTS Nginx 入口，不新建数据库服务、GPU 服务或另一份模型权重。两个游戏的 CPU 分析服务使用同一份代码，但各自连接自己的数据库和音频目录。Docker 外部网络沿用 `studio-ff7-rb_default`；Remake 服务名均带 `remake-`，不抢旧站的 `db`、`mora`、`website` DNS 别名。

## 初始化

从项目根 `/srv/ff7-sound` 运行：

```bash
python3 studio-ff7-remake/scripts/bootstrap.py --plan
python3 studio-ff7-remake/scripts/bootstrap.py
```

第二个命令会在现有集群中创建受限独立角色和数据库，复制当前数据库**结构**，只把每个 key 最新启用的公共提示词及分组作为初始配置，并在新库替换游戏语境。角色、地图、台词、读音纠正、游戏固定词、音色、音频、锁定和任务历史均不复制。共用流程代码，用户编辑的提示词仍是每游戏各自的数据；私有配置快照写 `.private/bootstrap-prompts.json`，不进入公共源码。

角色没有 Rebirth 业务表读取、修改和 public schema 建表权限，也不继承其他角色；不改旧库的 ACL。已有未知同名角色/数据库会被拒绝，防止接管别人的项目。重跑依据 `.private/bootstrap-state.json` 校验同一集群，已完成后不重新播种、不覆写用户 `.env`。

实际 `.env` 为 600 权限，复用现有站的模型连接配置但使用新的数据库密码。`AUTO_RUN_ORIGIN` 在 Compose 内固定指向新站容器自己的 loopback，不能把子请求发给 Rebirth。数据目录 `.ff7-game.json` 同时注明游戏和数据库；网站与 CPU 服务启动时都检查，错误挂载 Rebirth 音频将被拒绝。

## 单独启动

当前实例已经在运行。以下命令供后续明确需要构建/部署时使用，不是首次使用网站前必须再次执行的步骤。

```bash
cd /srv/ff7-sound/studio-ff7-remake
docker compose build remake-mora remake-website
docker compose up -d
```

此 Compose 没有 `db` 服务，也不会重建 Rebirth 容器。`http://主机:8767/api/project` 可检查游戏身份和导入状态；该接口不输出连接信息或凭据。

已有依赖镜像时，也可按公共 worker README 使用 `Dockerfile.mora.runtime` 派生 CPU 镜像，再 `docker compose up -d --no-build`；不必因新游戏实例而升级 NLP 环境。

游戏尚未导入时网站显示等待状态。现在游戏专属适配器 `worker/adapter.py extract` 已允许经过实物验证的只读JP/US提取，操作命令与完整性核查见 `worker/AUDIO-EXTRACTION.md`，字幕、章节归类与目录导入见 `worker/CATALOG.md`。Remake没有原始中文配音；数据目录不伪造CN音频。提取不调用Rebirth适配器，不启动推理、不改源游戏。写回、最小MOD和Win11往返仍待验证，`adapter.py pack` 持续拒绝执行。

备份和恢复说明见 `../studio-common/scripts/RESTORE.md`。所有 `game/`、`work/`、`website/data/`、`.private/` 和实际 `.env` 均禁止提交。

每天 04:00 CST 的两游戏聚合备份已安装，采用默认增量策略，不附加 `--verify-existing`：所有本机源计算 SHA256，新 NAS 对象写后读回 SHA256，已存在的不可变对象检查大小并在 manifest 标注 `size_only`，不每天重复读取整棵 NAS。恢复始终完整 SHA256；维护巡检才显式使用 `--verify-existing`。

Remake 正式空库快照已完成并发布 LATEST；Rebirth 新 namespace 第一次全媒体归档还在独立 systemd 单元 `ff7-rebirth-backup-seed-20261103.service` 中进行，该次初始 seed 保留 `--verify-existing`，不能把它写成已经完成。旧 NAS 历史已归入 `ff7-backup/rebirth/`：旧格式日期、滚动音频和 MOD 分别位于该目录的 `db/`、`data/`、`mod/`；根日志和旧恢复指南在 `legacy/`，原内容保留。

legacy 宿主 `translate-dialogue` / watchdog 目前仍只绑定 Rebirth 原环境与 state，STOP 保留；这次仅调整到公共源码路径，没有给 Remake 启动翻译后台，也没有自动运行新的翻译 / LLM / TTS 批次。
