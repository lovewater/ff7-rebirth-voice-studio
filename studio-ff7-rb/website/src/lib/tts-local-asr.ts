import type { SeedAsrResult } from "./seed-asr";

/** 本地Qwen只提供文字，不提供字轴。兼容原有拼接/择优数据结构时保留空字轴，
 * 绝不能把整句时长按字符均分后伪装成识别时间。波形测量另放raw.waveform，
 * 时长比较明确使用waveform指标版本；Seed字轴仅最终选定且需分段拼接时获取。
 */
export function localTtsAsr(text: string, raw: unknown, timing: { start: number; end: number; duration: number }): SeedAsrResult {
  return { text, language: "zh-CN", durationMs: Math.round(timing.duration * 1000),
    status: "local-qwen", message: "本地Qwen校字；无识别字轴", words: [], utterances: [],
    raw: { provider: "qwen-local", text, result: raw, waveform: { startMs: timing.start * 1000, endMs: timing.end * 1000, durationMs: timing.duration * 1000 } } };
}

/** 只有保留原声/环境片段且中文自身有多段，才需要中文切口字轴。
 * 无拟声或中文单段，直接整段编辑；避免为校字/选优逐候选调用收费ASR。
 */
export function needsChineseCutAxis(text: string, onomatopoeia: unknown[], ambient: unknown[]) {
  return onomatopoeia.length + ambient.length > 0 && text.split(/[\s\p{P}\p{S}]+/u).filter(Boolean).length > 1;
}
