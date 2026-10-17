-- 两个可空字段：按自动工作流汇总，仅最终主音频保存；子音频/无 LLM 调用保持 NULL。
ALTER TABLE line_tts_versions ADD COLUMN IF NOT EXISTS llm_tokens JSONB;
ALTER TABLE line_tts_versions ADD COLUMN IF NOT EXISTS llm_speed JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tts_llm_metrics_root_only') THEN
    ALTER TABLE line_tts_versions ADD CONSTRAINT tts_llm_metrics_root_only
      CHECK (parent_tts_id IS NULL OR (llm_tokens IS NULL AND llm_speed IS NULL));
  END IF;
END $$;
COMMENT ON COLUMN line_tts_versions.llm_tokens IS '最终主音频的工作流 LLM 用量：input/output/total/cached/reasoning/calls，未知计数保留 null；推理量属于 output 子集，不重复相加；scope 区分全工作流和历史已记录调用';
COMMENT ON COLUMN line_tts_versions.llm_speed IS '最终主音频的 LLM 请求耗时 elapsed_ms 及输出 token/s；端到端含网络/排队/预填充，按有效请求输出总量÷有效耗时汇总，不是音频语速；无调用为 NULL';
