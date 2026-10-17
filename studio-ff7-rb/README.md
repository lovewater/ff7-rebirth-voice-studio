# studio-ff7-rb

配音修订台后端。网站在 `website/`（另一个 git）。

```
studio-ff7-rb/
  docker-compose.yml   db + pgAdmin（默认），website/worker 用 profile
  db/init/             建表 SQL，按编号顺序
  db/data/             Postgres 数据盘（gitignore）
  worker/              抽取、字幕、时长
  website/             Next.js 修订界面
```

## 进展

库和界面已经能筛 2.7 万句、听日/中、看时长。不使用emotion。人物页保留参考音频筛选及 embedding 管理；但逐句配音当前正式流程是 IndexTTS zero-clone，不依赖这些 embedding，也不使用 Seed-VC。

`/lines` 点击 stem 或 TTS 进入 `/line/{stem}/` 管理逐句 TTS。当前走 zero-clone：默认直接用当前台词对应的日文原音作 prompt，也可选人物预设或前后邻近的同人物原版日/中音频。无需 ready embedding，跳过 Seed-VC。中文合成文字可修改，并支持 `[停顿=500]`。每次生成都写入 `line_tts_versions`，包括实际朗读文字、prompt、引擎信息、文件路径，以及与日/中音频同口径的 `起 / 止 / 长 / 说` 四项时序。生成结果默认不用于模组，试听后手工勾选；同一句最多勾选一个版本。删除历史会同时删除数据库记录、WAV 和 manifest。封包不在这里做。

人物页制作 embedding 可在“日文 / 中文”音源间切换。每个版本把实际来源写入数据库和 manifest，页面会直接标明来源，便于同角色对照。

## 端口

| 服务 | 端口 |
|---|---|
| 网站 Next | 8765（`website/` 里 `npm run dev`，绑 0.0.0.0） |
| Postgres | 25432 |
| pgAdmin | 8766，环境变量 `PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD` |

```bash
docker compose up -d                              # 库 + pgAdmin
docker compose --profile full up -d --build website
```

正式 TTS 是 `https://inference.example.invalid`，跑在 RTX 5080 上，官方 IndexTTS 2.0 zero-shot clone，BF16 autocast。inference-host 不再用于 TTS（镜像和权重已清）。逐句接口为 `/api/lines/[stem]/tts/clone`，默认使用当前句日文音频做 zero-clone prompt；无需 ready embedding，不经过 Seed-VC。部署说明见 `../gpu/tts-official/README.md`。

台词关联统一使用 `lines.stem`（已有唯一索引），无依赖 lines.id 的外键；017 迁移补齐所有关联外键缺少的索引。编辑中文 TTS 台词时，在不改变意思的前提下让中日发音音节数尽量接近；中文标点会形成停顿，估算时可按每个标点约 1–2 个音节时长考虑，避免依靠明显拉伸语速补偿大幅差异。

升级现有库：

```bash
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U ff7rb -d studio < db/init/017_tts_pipeline.sql
docker compose --profile full up -d --build website
```
