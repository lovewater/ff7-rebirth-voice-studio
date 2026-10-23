-- 保留旧算法历史：metric_version区分旧包络跨度与新正文净发声，数值不能混为一谈。
COMMENT ON COLUMN line_auto_run_comparisons.span_ratio IS
 '中文/日文时长比，含义由metric_version确定。waveform-cn-net-over-jp-clean-reference-v1用去情绪正文双方扣长静音后的净发声毫秒相除；旧span-v1为含内部停顿的包络跨度。不是拍数比。';
COMMENT ON COLUMN line_auto_run_comparisons.normalized_beat_ratio IS
 '去情绪日文正文与中文实际朗读稿按原拍数规则得到的normalizedRatio；文本拍数公式不含音频静音秒数，不可用净时长比代替。';
