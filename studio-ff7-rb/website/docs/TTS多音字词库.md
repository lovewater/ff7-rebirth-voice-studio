# TTS 多音字词库

运行时词库：数据库 `pronunciations` 表中 `usage=tts_pinyin` 的记录；转换：`src/lib/tts-pronunciation.ts`，数据库入口：`tts-pronunciation-db.ts`。`src/lib/pronunciation/liao3.json` 仅作为初始种子和离线测试数据。

读音管理页分为 ASR / 大模型参考（原词库 `usage=reference`，保留编辑）和 TTS 发音替换（`usage=tts_pinyin`，只读卡片展示）。API 同样禁止新增/修改/删除拼音分类。所有旧参考消费者必须带 `WHERE usage='reference'`，避免拼音影响改写或校字。

IndexTTS 2.0 使用汉字与大写拼音声调数字混排，例如“了解了”发送为 `LIAO3解了`，不是 2.5 的 `<了|LIAO3>`。

只在 `/v1/tts`、`/v1/tts/clone` 的中文 HTTP 请求出站时转换，覆盖手动生成、自动运行及人物音色试音。大模型照常输出汉字；数据库 tts_text、spoken_text、字幕、ASR 校字和拍数统计均保持汉字。不能在 normalizeScript 或改写提示词中预先替换，否则字数、拍数、字幕和 ASR 对比会混乱。转换不修改调用者对象。

第一批收录了解、了不起、了不得、不得了、了结、了断、一目了然、了如指掌、直截了当、简单明了、了得及受不了、赢不了、做不了等高置信度用词，预留了却等后续可能出现的词。长词优先，不跨标点、空白或显式停顿标签，已有拼音不重复处理。

实际全文反例：为了解开这个谜、没有人赢得了解放手臂的我、为了得到蜜娜的认可，其中的了解/了得不是一个词，需要排除。下落不明了、你变聪明了、通知了，不能全局按明了/知了替换。不了（婉拒）、夺得了总裁奖也不能全局按不了/得了替换。无法可靠消歧的表达保留原汉字，扩充词库时需检查上下文和补充反例测试。

全文只读审计：`node scripts/audit-liao-pronunciation.cjs > /工程/work/liao-audit.json`。扫描原中文字幕、日英译文及历史 tts_text/spoken_text/subtitle_text，不修改历史数据、音频或人工状态。审计输出含游戏文本，不提交到发布仓库。
