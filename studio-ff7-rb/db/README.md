# db

Postgres 模式和迁移。运行时数据在 `data/`，不要提交。

`init/*.sql` 只在空库第一次 `docker compose up` 时自动执行。已经在跑的库要手动：

```bash
psql "$DATABASE_URL" -f init/010_drop_dup_person.sql
```

## 表（现在）

| 表 | 干什么 |
|---|---|
| `lines` | 一条语音：stem、区域、speaker 编码、类型、字幕。人名/地区名不在这张表。 |
| `line_meta` | 时长、`persona`。历史情绪列还在库里。不使用emotion。 |
| `speakers` | 人物编码 → 中文名。改名只改这里。 |
| `cast_members` | 谁算主角/配角（可改，影响人物页） |
| `regions` | 地区编码、中文名、故事顺序 |
| `pronunciations` | TTS 送出前按字替换（壹→一、魔晄炉→魔恍炉 等） |
| `voice_banks` | 每角色多套基准音色 |
| `voice_bank_draft_clips` | 制作前勾选了哪些 stem |
| `voice_bank_versions` | 不限版本数；记录来源、embedding、拼接音源、示例、引擎和路径 |

## 人物编码要注意

- 赤红深嗓 `red`，纳纳基真声 `nnk`（目前按日文「オイラ」等启发式，仍会混）。
- VO_PC 英文后缀（`Sephiroth` 等）已并进 `sep`/`cld`/…，人物列表里不要再出现第二个萨菲罗斯。

## TTS 与台词标识

台词业务标识为 `lines.stem`，所有台词外键都引用 stem，数字 lines.id 不用于关联或页面地址。stem 的 UNIQUE 自带索引；017 迁移补齐 draft/version clips 的 stem、example_stem 及 TTS 的 voice_version_id 索引。历史版本的自增 id 仍用于排序和区分同句的多次生成。

`line_tts_versions` 保存实际 TTS 文字、可选字幕、采用状态、最终四项时长；`conversion_meta` JSONB 保存必需的 Seed-VC 参数与参考来源。`audio_path/raw_audio_path/manifest_path` 对应最终音频、修复前音频、清单。生成失败不计为 ready。`seed_asr` 保存 Seed-ASR 结果（含音频 sha256），同一文件不重复调用。日文原声缓存在 `line_meta.seed_asr`。

`voice_bank_versions.source_wav_path` 保存已选素材拼接音源，供不足 1.5s 日语原音时回退。旧单批次版本的 reference 就是完整拼接音源，017 会回填路径；旧多批次记录不冒充完整拼接音源。新版本总长上限 15s 由前后端和 GPU 解码校验。
