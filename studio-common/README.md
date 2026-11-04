# FF7 共用修订程序

Rebirth 与 Remake 维护一份公共程序，分别运行网站和 CPU 服务实例。公共流程包含播放、改稿、核字、TTS 接口、对时、人工审核/锁定和指标计算。游戏资源读取/写回通过各自适配层完成。

| 位置 | 职责 |
|---|---|
| `studio-common/website/` | 公共网站源码 |
| `studio-common/worker/` | 公共 CPU 源码、依赖及镜像定义 |
| `studio-common/scripts/` | 带游戏身份的初始化、运维、备份入口 |
| `studio-ff7-rb/` | Rebirth 配置、数据、资源适配与运行目录 |
| `studio-ff7-remake/` | Remake 配置、数据、资源适配与运行目录 |
| 根目录 `programs/`、`gpu/` | 公共二进制工具及推理服务代码 |

两个 `website/` 运行目录保存各自的 `data/`，不再维护两份网站源代码。Rebirth 继续使用原有 `8765` 服务和 `studio` 数据库；Remake 使用独立网站、`studio_ff7_remake` 数据库和受限账号。共享 PostgreSQL 进程与 TTS/ASR 服务，不共享业务数据或 GPU 持久音色 key。

公共 worker 已迁入真实文件，发布副本使用公共路径，历史命令按公共目录执行；原容器不因此重启。公共 CPU 服务各实例读取自己的数据库及音频根，`/health` 带 `game_id`，Remake 的 URI 和目录标记在启动时核验。

Remake 的 legacy pak / uasset / uexp 与 Rebirth 的 IoStore / Zen 使用独立适配层。2026-11-04已完成只读日英原声提取与分类：69406段MP3全部SHA验证、199份完整多声道FLAC与源PCM一致，35180条配对台词已导入独立8767网站；官方CN字幕保留为制作初稿，本作没有原始中文配音。完整结果见 [资源提取验收](docs/remake-extraction-validation-20261104.md)。原样写回、封包重读和Win11试听仍待单独验证，pack继续禁用。

阅读 [资源适配边界与原始来源](docs/resource-adapters.md)、[公共 CPU worker](worker/README.md)。数据库、音频、工作缓存、MOD、增量基线以及 NAS 备份/恢复标识按游戏分开。Rebirth 的历史数据和备份保留。

每日备份入口是 `scripts/backup-studio.py backup --game rebirth|remake`，新快照分别写入 NAS 的 `ff7-backup/rebirth/`、`ff7-backup/remake/`。每份数据库快照携带音频清单和游戏身份，音频采用各游戏目录内的 SHA256 不可变对象；原根目录的旧 Rebirth 备份已按用户要求归入同一游戏目录：历史日期子目录位于 `rebirth/db/`，旧音频镜像位于 `rebirth/data/tts/`，历史 MOD 位于 `rebirth/mod/`；原日志和原恢复说明位于 `rebirth/legacy/`。这些旧格式历史原内容保留，不属于 v2 快照，也不由新保留策略删除。新数据库快照保留 30 天，音频对象不自动垃圾回收。恢复操作见 [RESTORE.md](scripts/RESTORE.md)，不得把一款游戏的清单或 dump 恢复到另一款。

本发布仓库统一管理 website / worker / scripts / docs。每个运行目录真实 `.env`、凭据、数据库、音频、模型和游戏资源不进入 Git。
