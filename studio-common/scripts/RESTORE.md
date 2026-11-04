# 按游戏备份与恢复

公共实现：`studio-common/scripts/backup-studio.py`。每天 04:00 的聚合任务顺序备份 Rebirth、Remake；单个游戏失败不阻止另一个游戏尝试。每游戏单独加锁、日志、临时目录、恢复验证库与保留策略。运行时不停止网站。

## 新备份位置

| 游戏 | 业务数据库 | NAS 根目录 |
|---|---|---|
| Rebirth | `studio` | `/srv/backups/ff7-backup/rebirth/` |
| Remake | `studio_ff7_remake` | `/srv/backups/ff7-backup/remake/` |

每个游戏的结构：

```text
db/YYYY-MM-DD/run-UTC时间-随机ID/
    studio.dump 或 studio_ff7_remake.dump
    studio.sql.gz 或 studio_ff7_remake.sql.gz
    FILES.json
    MANIFEST.json
objects/sha256前两位/完整sha256
LATEST.json
backup.log
```

同一天可有多个成功快照，互不覆盖。只有数据库还原核对、生成资产归档和清单写入全部成功，才发布 `status=complete` 和 `LATEST.json`。失败现场留在 `.in-progress-*`，不作为可用快照。

数据库只有一次 `pg_dump`；备用纯 SQL 由该 custom dump 派生，所以两个格式属于同一数据库快照。业务计数来自还原后的同一 dump，不拿数分钟后仍在变化的线上计数作比较。验证库名称含游戏与随机 ID，带本次专属数据库 COMMENT；只会删除本次创建且 owner/COMMENT 都匹配的验证库，绝不固定复用 `studio_restore_check`。

## 音频与其他文件

备份 `website/data/tts/`、`website/data/embedded/` 内的全部文件，不按扩展名过滤，因此 JSON、声纹 `.pt`、参考音频和示例也会留下。另保存 `.ff7-game.json`；Rebirth 旧站没有此标记时，仅在备份对象中生成身份标记，不改线上目录。

只有数据库快照中 `status=ready` 的音频/音色版本，其已登记生成路径才强制要求存在；可用成品缺文件会使本次备份失败。`building`、`error` 等未完成记录仍完整保留在数据库，已登记但从未产出的路径不会阻断备份，清单会列出 `unfinished_references` 与其中缺失的 `missing_unfinished_references`。这些记录没有被删除或伪装成成功；目录里已经存在的未完成现场文件仍照常归档。

`FILES.json` 把原始相对路径映射到 SHA256 对象。相同内容每天只存一次；同一路径被重新编辑时会产生新对象，旧日数据库仍能配回旧日音频。两个游戏对象空间互不混用，当前不做对象垃圾回收。数据库和对应清单只保留最近 30 天；旧对象保留，沿用“不删远端音频”的策略。

新写对象会从 NAS 读回并校验 SHA256。已存在对象默认仅检查长度，避免每天重读全部音频；清单明确记录 `existing_objects=size_only`，不能把它说成全量远端校验。需要巡检时可加 `--verify-existing`。恢复检查始终逐个对象完整验证 SHA256。

以下内容明确不在每日备份中：

- `jp/`、`cn/`、`en/` 原始游戏音频，可从游戏或原中文包重新提取。
- `metrics/`、`translation-background/` 等可重建缓存。
- `llm_access_logs` 的行数据；其表结构仍保留，主音频上的汇总不丢。
- 游戏本体、模型权重、真实 `.env`、运行凭据和共享盘历史 MOD。

## 手动备份与计划检查

在 `/srv/ff7-sound`：

```bash
python3 studio-common/scripts/backup-studio.py backup --game remake --dry-run
python3 studio-common/scripts/backup-studio.py backup --game remake
studio-common/scripts/backup-all.sh --dry-run
```

`studio-ff7-rb/scripts/backup-studio.sh` 只备 Rebirth，Remake 同名入口只备 Remake。聚合入口才遍历两款游戏。未挂载 CIFS 时直接拒绝，不会误写宿主机的空挂载目录。

## 安全恢复检查

从相应游戏的 `LATEST.json` 找到完整快照路径，显式指定游戏：

```bash
python3 studio-common/scripts/backup-studio.py restore-check \
  --game remake \
  --snapshot /srv/backups/ff7-backup/remake/db/日期/run-实际ID
```

命令会验证游戏名、原数据库名、清单及 dump 摘要、身份对象和所有生成资产 SHA256，再把数据库恢复到本次独立的临时库，核对清单计数；完成后仅删除这个临时库。不会覆盖正式数据库。

要同时把生成文件实际恢复出来，加 `--output`。目标必须是所选游戏 `work/` 下的空子目录：

```bash
python3 studio-common/scripts/backup-studio.py restore-check \
  --game remake \
  --snapshot /srv/backups/ff7-backup/remake/db/日期/run-实际ID \
  --output /srv/ff7-sound/studio-ff7-remake/work/restore-check-实际ID
```

同样不改正式库或正在使用的音频目录。正式灾难恢复应先完成此检查，确认目标游戏及停机窗口，再单独执行正式切换；这里刻意没有可误删另一游戏的通用 `DROP DATABASE` 命令。不要把不透明 `objects` 文件手工扔进音频目录，必须按 `FILES.json` 恢复文件名。

## 旧 Rebirth 备份

2026-11-03 按用户要求，原根目录下的旧备份统一归入 Rebirth：

- 原 `db/日期/` → `rebirth/db/原日期名/`，保留 `studio.dump`、`studio.sql.gz`、`MANIFEST.txt` 等旧文件原内容；不改写日期名，不伪装成 `run-*` / v2 快照。
- 原 `data/tts/` → `rebirth/data/tts/`，仍是一棵旧滚动音频镜像。
- 原 `mod/` → `rebirth/mod/`；后续 Rebirth 封包也发布到此处。
- 原根 `backup.log`、`RESTORE.md` → `rebirth/legacy/`，与新的 `rebirth/backup.log`、`rebirth/RESTORE.md` 分开保留。

绝对路径的共同前缀为 `/srv/backups/ff7-backup/`。旧恢复说明保留的是历史原文，其中旧根路径应按上面的新位置对应，不能照旧路径直接恢复。旧音频缺少逐日内容映射；迁移目录并没有补造不存在的历史字节关系。新恢复检查不会把旧格式误认成 Remake/v2 快照。使用这些历史时，必须按 Rebirth 旧格式先恢复到独立临时库与工作目录核对。

新保留策略仅识别当前游戏、已完成且带合法清单的 `run-*` 快照，不清理旧格式日期目录或历史 MOD。迁移不覆盖、合并或丢弃同名文件；遇到目标冲突须先核对，不能直接替换。
