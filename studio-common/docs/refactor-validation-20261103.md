# Remake 新项目前重构与验证（2026-11-03）

本报告记录初始化空站时的阶段验收。后续用户已复制游戏并授权只读提取，现已完成：69406段日英音频、35180条目录完整入库，详见 [2026-11-04全量验收](remake-extraction-validation-20261104.md)。当前续工请读 [提取说明](../../studio-ff7-remake/worker/AUDIO-EXTRACTION.md) 和 [目录分类](../../studio-ff7-remake/worker/CATALOG.md)，不要把下文的历史“等待游戏/pending/空库”当成当前状态。封包与Win11试听仍未验证。

公共程序已拆出，Remake 空站已在 `http://192.0.2.10:8767` 启动。
Rebirth `8765` 站点持续运行；这次没有重启其六个原容器，也没有移动其运行音频目录。
Remake 实际游戏文件仍未到齐，尚未完成资源提取、回写或封包实测；本报告不把空站准备当作游戏适配完成。

## 当前代码与数据边界

| 项目 | 已落地位置 / 行为 |
|---|---|
| 公共网站 | `studio-common/website/` 是真正迁入的源码和原独立 `.git`，原未提交修改保留 |
| 公共 CPU worker | `studio-common/worker/` 真实文件，Rebirth 原相应路径为兼容软链接 |
| Rebirth 运行数据 | `studio-ff7-rb/website/data/` 原目录、inode 不变；现网容器仍用原镜像 |
| Remake 运行数据 | `studio-ff7-remake/website/data/`，根目录带匹配游戏和数据库的 marker |
| 数据库服务 | 共用现有 PostgreSQL 进程，不另建数据库容器 |
| Remake 数据库 | `studio_ff7_remake` / 受限角色 `ff7remake`，与 Rebirth `studio` / `ff7rb` 分开 |
| 游戏专属实现 | Rebirth IoStore/Zen、章节、中文包覆盖和封包留在 Rebirth；Remake 适配器 pending 且拒绝提取/封包 |
| 私密配置 | 每游戏实际 `.env`、`.private` 留在各自运行目录，不进入公共源码或 Git |

外层 `studio-common` 与 Remake 目录已初始化本地 Git，公共网站仍保留原独立 Git，并被外层 ignore。
本次没有 stage、commit 或 push。发布副本 `git-voice-studio` 不自动同步；后续须按新来源映射并保留既有脱敏配置。

资源差异的工具作者依据及后续真实文件验证步骤见 [resource-adapters.md](resource-adapters.md)。

## Rebirth 连续运行核对

重构前后逐个比较原 `website`、`db`、`mora`、`speech-metrics`、`tts-proxy`、`pgadmin` 的容器 ID 和 `StartedAt`，六个均未变化。
Rebirth 的音频目录 inode 也未变化，没有把运行数据随网站源码搬走。
用户仍可在原站人工重新生成、试听和锁定；新公共源码不是通过热替换影响原容器。
基线保存在 `work/remake-bootstrap-20261103/rebirth-runtime.before.json`，HTTP 核对记录包含原容器未变化的结果。

## 新库、页面与隔离

新库只复制数据库结构，以及每个 key 最新启用的 57 条公共提示词和对应分组，并在新库转换游戏语境。
台词、人物/角色、地图、读音纠正、锁定、音色库和任务历史均为空，没有把 Rebirth 业务记录伪装成 Remake 数据。

实际访问了 `/`、`/lines`、`/voices`、`/prompts`、`/pronunciations`、`/topics`、`/abnormal`、`/api/project`，八处均 HTTP 200。
`/api/project` 报告：

```json
{"game":"remake","status":"awaiting-import","lineCount":0,"extractionReady":false}
```

新站日/中资源提取接口返回 503，不会回落执行 Rebirth worker。
网络连接实测确认 Remake 账号能在自己的库内临时写入、回滚；读取/修改 Rebirth 业务表及在其 public schema 建表均被拒绝，未修改 Rebirth ACL。

网站和 CPU 服务分别验证游戏 ID、数据库/账号和音频 marker；Rebirth 身份同样拒绝误用 Remake 保留库/角色。
GPU 持久音色键有 Remake namespace，Rebirth 旧键保持兼容；中央 LLM 请求只改系统指令中的完整游戏品牌，不改真实台词或普通“重生”字词。

三个真实 Docker 启动负测均以退出码 1 快速失败，未输出密码：

| 错误配置 | 结果 |
|---|---|
| Remake 连接 Rebirth 数据库 | 退出 1 |
| Remake 误绑定 Rebirth 音频目录 | 退出 1 |
| Rebirth 身份连接 Remake 数据库 | 退出 1 |

Next 在这些负测中仍可能先瞬态打印 `Ready`，随后启动校验失败并立即退出；不能仅凭该日志行宣称启动成功。判定依据是最终进程状态、退出码及真实 HTTP 检查。

## 回归与构建

| 检查 | 结果 |
|---|---|
| 网站全套 | 720 项：671 通过，49 项原有失败；对照基线无新增失败 |
| 公共 CPU worker | 34 项通过 |
| 游戏身份 / 网站隔离 | 14 项通过 |
| 备份 | 8 项通过 |
| 新库初始化 | 3 项通过 |
| TypeScript / 定向 ESLint / 生产构建 | 通过 |

公共 CPU 的三份核心算法与迁移前源码逐字节一致，没有借重构改变实际 1.33 行为。
它与根文档 1.20 规定的既有冲突记录在资源适配说明中，未据此重算旧数据。
本次部署可使用显式指定旧 CPU 依赖镜像的 `Dockerfile.mora.runtime`，公共源码覆盖后派生新镜像；原 Rebirth 镜像与容器保留。

## NAS 备份、恢复实测与尚在进行的首次归档

新每日入口使用 `studio-common/scripts/backup-all.sh`，计划任务已安装为每天 **04:00 Asia/Shanghai**，依次处理两游戏，采用默认增量校验，**不附加 `--verify-existing`**。
每游戏有独立锁、数据库快照、SHA256 对象、文件清单、日志、保留策略和恢复身份：

- Rebirth：`/srv/backups/ff7-backup/rebirth/`
- Remake：`/srv/backups/ff7-backup/remake/`

后续按用户“现在全是 Rebirth，旧备份迁移”的要求，旧 NAS 根 `db` 日期子目录、`data`、`mod` 统一迁入 `rebirth/db`、`rebirth/data`、`rebirth/mod`，原根日志和恢复说明归档到 `rebirth/legacy`，原文件内容保留、不覆盖新日志。旧格式历史不伪装成 v2 快照，也不由新 v2 保留策略删除。新生成音频、`embedded` 及游戏 marker 纳入备份；原始日/中/英文音频、可重建缓存及 `llm_access_logs` 行数据按原策略排除，日志表结构仍保留。
备份内容和恢复命令见 [RESTORE.md](../scripts/RESTORE.md)。

每日仍对所有本机源文件计算 SHA256，因此同名、同大小、同 mtime 的改动也会发现。
新 CAS 对象在 NAS 写入后完整读回校验 SHA256；已存在的不可变对象仅检查大小，并在 manifest 明确记录 `existing_objects=size_only`。
它们在首次创建时已完成写后校验，不每天重新读回整棵 NAS；恢复时始终逐对象完整 SHA256，维护巡检可显式加 `--verify-existing`。
实际观测 NAS 随机小文件完整核验约 1,000 个 / 3 分钟，对 149,512 个对象每日重复读取会拖至约 8 小时，因此不把这种全读回当作日常增量策略。

真实 NAS 验证使用两份同名、同大小、同 mtime、但内容不同的 WAV：连续两次备份后，各自恢复得到各自精确 SHA256；跨游戏恢复被拒绝。
本地合成测试文件、NAS 专属测试快照及相应对象已清理，保留验证证据及正式空 Remake 快照 / `LATEST.json`，没有把测试音频留在游戏数据中。

**Rebirth 新 namespace 的首次完整媒体归档仍在进行，不能宣称已经全部备完。**
本轮约 149,512 个文件，由独立 systemd 单元 `ff7-rebirth-backup-seed-20261103.service` 持续处理，不依赖当前会话。
这一次初始 seed 仍保留 `--verify-existing` 做完整对象核对；它与每日增量策略不同。
数据库同一 dump 的恢复验证已通过；78,480 条 ready 生成资产引用核查没有缺失，另有 11 条历史未完成引用记录在 manifest，未删除其数据库记录、未伪装成可用音频。
只有媒体归档、清单和校验全部完成，才会原子发布该游戏的新完整快照 / LATEST。

```bash
systemctl status ff7-rebirth-backup-seed-20261103.service
tail -n 20 /srv/ff7-sound/work/remake-bootstrap-20261103/rebirth-first-namespaced-backup.log
```

完整证据目录：`work/remake-bootstrap-20261103/`。其中 `private/` 及各游戏私密配置包含凭据/数据库细节，不发布、不提交。

## 旧宿主翻译任务的边界

每分钟的 legacy `translate-dialogue` / watchdog 路径已改为公共源码，并显式绑定 Rebirth 原环境和 state 路径。
旧 `STOP` 标记保留；fake Node 核对退出 0；没有创建 `studio-common/website/data`，没有启动新的翻译或 LLM 任务。
**这是原 Rebirth 宿主任务的路径兼容，不是已经为 Remake 部署了翻译后台。**
若后续需要 Remake 宿主翻译任务，仍需独立的游戏配置、账号、状态目录及明确的任务范围。

## 下一步

等待 Remake 真实游戏文件到齐，按资源适配说明完成只读探测、样本往返、最小补丁与 Win11 试听，再启用游戏专属提取/封包。
另跟踪 Rebirth 首次 namespaced 媒体归档最终成功状态；当前已完成环境与隔离验证，不等同于完成游戏适配或首次全媒体备份。
