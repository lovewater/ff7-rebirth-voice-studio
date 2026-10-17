# 从 SMB 备份还原修订台

备份位置：`/srv/backups/ff7-backup`

- `db/年-月-日/studio.dump`：Postgres 自定义格式（可还原）
- `db/年-月-日/studio.sql.gz`：纯 SQL，备用
- `data/tts/`：我们生成/编辑的配音（wav / 锁日文的 mp3 / json），rsync 增量，不含游戏日文和前人中文包

日文 `website/data/jp`、中文包 `website/data/cn` **不在备份里**。还原后若本机没有这两棵树，需要重新抽取才能播原声；改/锁/字幕/忽略对时都在库和 `data/tts` 里。

模型访问日志 `llm_access_logs` 的**数据不进入每日备份**；两种格式均保留其表结构，恢复后该表为空，后续调用正常写入。主音频上的 token/速度汇总仍随业务数据备份。

## 还原数据库

在 `studio-ff7-rb` 目录：

```bash
docker compose up -d db
# 等 healthy
docker cp /srv/backups/ff7-backup/db/2026-9-23/studio.dump studio-ff7-rb-db-1:/tmp/studio.dump
docker exec -i studio-ff7-rb-db-1 psql -U ff7rb -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'studio' AND pid <> pg_backend_pid();"
docker exec -i studio-ff7-rb-db-1 psql -U ff7rb -d postgres -c "DROP DATABASE IF EXISTS studio;"
docker exec -i studio-ff7-rb-db-1 psql -U ff7rb -d postgres -c "CREATE DATABASE studio OWNER ff7rb;"
docker exec -i studio-ff7-rb-db-1 pg_restore -U ff7rb -d studio --no-owner --exit-on-error /tmp/studio.dump
```

或解压 SQL：`gunzip -c studio.sql.gz | docker exec -i studio-ff7-rb-db-1 psql -U ff7rb -d studio`

## 还原我们生成的音频

```bash
mkdir -p website/data/tts
rsync -a /srv/backups/ff7-backup/data/tts/ website/data/tts/
```

然后 `docker compose --profile full up -d`。
