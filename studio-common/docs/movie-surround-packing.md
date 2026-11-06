# 过场对白的多声道封包

部分 MV Voice bank 是六声道混合，日文直达声及混响可能同时出现在 FL/FR/C/SL/SR。仅改中心声道会漏日文。`extra.multichannel_review_required=true` 的条目须走 `movie_surround.py`，不能把审计标记当作已经完成处理。

封包读取真实原始 MovieScene Voice 事件，核对 stem、24000 tick/秒、bank 的30fps起点、导入切片及原WAV SHA。非日文锁的对白窗口同时替换0/1/2/4/5声道，中心使用当前锁定中文PCM，其他声道按原窗口能量比例分布中文；原日文混响随对白清除，**不声称重建原房间混响**。未选窗口、日文锁窗口及LFE在HCA编码之前逐采样保持；LFE包含超过1LSB的内容时拒绝此策略，不能猜作可删对白。

清理尾部以“下一个真实发声事件”为边界，包含没有字幕的原声事件。原中文字幕窗口与其他发声重叠时不能无损分离，默认拒绝。用户明确选择覆盖后，按单句、原WAV SHA及精确起止在 `work/mod-build/movie-overlap-approvals.json` 登记 `action=replace-dialogue-window`；只授权该窗口，不开放其他重叠。无批准、源SHA或区间变化均拒绝。

新策略与原编码缓存分开：未涉及的普通/旧切片编码函数及旧内容缓存身份不变；新多声道计划绑定事件SHA、渲染器SHA和许可记录，整体发布策略更新，旧中心声道缓存不能混用。显式增量遇到旧策略不匹配仍拒绝，不能自行改跑全量。

每个新bank必须经过真正AudioMog/HCA编码、再次解码，核对声道、采样率、采样数及PCM误差；窗口外逐采样一致是**编码前**的承诺，HCA有损重编码不承诺其他压缩字节或解码PCM完全不变。回读误差与逐窗证据记录在缓存sidecar及MOD manifest的 `multichannel_dialogue`。Linux验证不等于Win11实际游戏试听。
