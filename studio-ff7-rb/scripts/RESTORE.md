# Rebirth 备份与恢复

当前公共实现、每游戏 NAS 命名空间、不可变音频对象、保留策略与安全恢复检查，见 [公共恢复说明](../../studio-common/scripts/RESTORE.md)。

本目录的 `backup-studio.sh` 始终只备份 Rebirth 数据库 `studio` 和本目录所属的生成资产，不会备份 Remake。每日聚合入口改用 `studio-common/scripts/backup-all.sh`。

旧备份已统一迁入 `/srv/backups/ff7-backup/rebirth/`：原日期目录位于 `db/原日期名/`，旧滚动音频镜像位于 `data/tts/`，历史 MOD 位于 `mod/`；原根日志和恢复说明保存在 `legacy/`，不覆盖新日志。这些仍是 Rebirth 旧格式历史，不由新 v2 保留策略删除。旧格式没有逐日不可变音频映射，新版恢复检查不会误接受它；恢复旧历史须按公共说明的新路径对应，先在独立临时库和工作目录核对。

恢复默认只使用独立临时数据库和本游戏 `work/` 下的空目录，不自动覆盖正式库或正式音频目录。不要在 Remake 项目中照抄旧的 DROP studio 命令。
