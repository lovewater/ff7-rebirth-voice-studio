# 通用战斗语音逐条审核与回写

`VO_PC*` 资产包含数百个独立 SAB material。逐条审核时保留原整库行，新增稳定的虚拟 stem；其 `lines.pack`、`asset_path`、`jp_chunk_id`、`jp_container` 仍指向真实原库。`line_meta.extra` 必须包含：

- `bank_stem`：原库 stem。
- `bank_material_index`：从 0 起的 material 索引，不能使用事件顺序替代。
- `bank_event_name`：核查时解析出的事件名。
- `original_material_sha256`：原日文 material 的压缩音频数据 SHA-256。

没有游戏字幕的条目，转写和中文译稿仅供审核，不能作为 TxtRes 新字幕写入。无口型的战斗短句使用普通对话自然语速，生成结果统一标人工异常，最终仍由用户锁定。

战斗短句批量合成须与详情页默认 Zero-shot 请求一致：使用本句日文作参考，发送朗读稿、`durationFactor=1`、`promptLang=jp`，不传共享中文 `promptPath`、`preservePromptAudio` 或额外的对齐覆盖参数。参考音频准备、响度匹配及后处理均走站点正式接口。不要因为原声短就擅自替换成其他中文台词；参考输入不同会同时改变音色、语气及响度基准。已人工锁定的版本必须保留。

`build_mod.py` 不把虚拟 stem 当作单独 uasset 查找，也不放进新增容器。只读取其已锁定音频，按 `bank_stem` 合并，回写原中文包的同名语音库。未锁定条目保持原始压缩流；原中文选择保持原始流，日文选择需要原始流指纹验证。整库锁和库内条目锁同时存在会明确拒绝，避免相互覆盖。

重建时只向 AudioMog 提供选中索引的 WAV；回读检查 material 总数、ID、声道、采样率与编码不变，且每个未选中的压缩数据逐字节相同，选中流确实发生替换。随后继续执行既有 Zen 大小修复及容器严格回读校验。
