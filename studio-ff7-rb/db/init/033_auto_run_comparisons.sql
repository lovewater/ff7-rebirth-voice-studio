-- 自动运行比较必须绑定实际的处理后日文参考，而不是整句日文原声。
-- 原声 ASR 仍保存在 line_meta.seed_asr，不能被这里的参考 ASR 覆盖。
ALTER TABLE line_auto_runs
    ADD COLUMN IF NOT EXISTS reference_audio_path TEXT,
    ADD COLUMN IF NOT EXISTS reference_text_jp TEXT,
    ADD COLUMN IF NOT EXISTS reference_seed_asr JSONB;

CREATE INDEX IF NOT EXISTS line_auto_runs_reference_asr_idx
    ON line_auto_runs ((reference_seed_asr->>'sha256'))
    WHERE reference_seed_asr IS NOT NULL;

-- 同一句可有多次运行、多个 TTS；比较结果属于这次运行和这个候选的组合。
CREATE TABLE IF NOT EXISTS line_auto_run_comparisons (
    run_id BIGINT NOT NULL REFERENCES line_auto_runs(id) ON DELETE CASCADE,
    tts_id BIGINT NOT NULL REFERENCES line_tts_versions(id) ON DELETE CASCADE,
    metric_version TEXT NOT NULL,
    reference_audio_path TEXT NOT NULL,
    reference_sha256 TEXT NOT NULL,
    candidate_audio_path TEXT NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    reference_span_ms DOUBLE PRECISION CHECK (reference_span_ms > 0),
    candidate_span_ms DOUBLE PRECISION CHECK (candidate_span_ms > 0),
    span_ratio DOUBLE PRECISION CHECK (span_ratio > 0),
    span_check_enabled BOOLEAN NOT NULL,
    span_pass BOOLEAN NOT NULL,
    reference_text_jp TEXT NOT NULL,
    candidate_text_cn TEXT NOT NULL,
    beat_version TEXT,
    normalized_beat_ratio DOUBLE PRECISION,
    beat_result JSONB,
    beat_error TEXT,
    measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, tts_id)
);

COMMENT ON COLUMN line_auto_run_comparisons.span_ratio IS
    '音频跨度比例：生成中文ASR首尾跨度 / 实际处理后日文参考ASR首尾跨度；包含句间停顿，不是拍数比';
COMMENT ON COLUMN line_auto_run_comparisons.normalized_beat_ratio IS
    '拍数比：清理后日文正文与该候选实际朗读稿的 normalizedRatio，按 beat_version 对应规则计算；不能用音频时长比代替';
COMMENT ON COLUMN line_auto_runs.reference_seed_asr IS
    '实际送入TTS的日文参考WAV的Seed-ASR，含路径、SHA256、明确ja-JP语言和原始字轴';
COMMENT ON COLUMN line_meta.beat_ratio IS
    '原日文字幕与源中文字幕的归一拍数比缓存；不是音频时长比，也不代表任何未锁定TTS候选';
