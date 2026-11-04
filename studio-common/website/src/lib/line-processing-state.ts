export type ProcessingState = "active" | "skipped";
export const isLineSkipped=(row:{processing_state?:unknown}|null|undefined)=>row?.processing_state==='skipped';
export const SKIPPED_LINE_MESSAGE='这条已标记为跳过，请先取消跳过再生成';
export function parseProcessingChange(value:unknown) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('状态配置无效');
  const input=value as Record<string,unknown>;
  if(input.state!=='active'&&input.state!=='skipped')throw new Error('状态须为active或skipped');
  if(input.reason!==undefined&&typeof input.reason!=='string')throw new Error('跳过原因须为文字');
  const reason=typeof input.reason==='string'?input.reason.trim():'';
  if(reason.length>500)throw new Error('跳过原因最长500字');
  return {state:input.state as ProcessingState,reason:input.state==='skipped'?(reason||'人工跳过'):null};
}
