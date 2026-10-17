#!/usr/bin/env node
// 通用批量入口：node scripts/run-auto-batch.mjs STEM1 STEM2 ...
// 每句独立，默认4并发；总是forceGenerate=false，由服务端统一跳过已有合适结果。
// skipped是正常完成，不能拿空runId去轮询。监控失败不重复提交，避免后台双重生成。
const stems = [...new Set(process.argv.slice(2))];
if (!stems.length || stems.some(stem => !/^[\w.\-]+$/.test(stem))) {
  console.error("用法：node scripts/run-auto-batch.mjs STEM1 [STEM2 ...]");
  process.exit(1);
}
const base = (process.env.AUTO_RUN_ORIGIN || "http://127.0.0.1:8765").replace(/\/$/, "");
const concurrency = 4;
let next = 0;
async function json(stem, options) {
  const response = await fetch(`${base}/api/lines/${encodeURIComponent(stem)}/auto-run`, { ...options, signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
  return result;
}
async function processStem(stem) {
  const created = await json(stem, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forceGenerate: false }) });
  if (created.skipped) {
    console.log(JSON.stringify({ stem, status: "skipped", selected: created.selectedTtsId, reason: created.reason }));
    return;
  }
  console.log(JSON.stringify({ stem, status: "running", runId: created.id }));
  for (let tick = 0; tick < 360; tick++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const current = await json(stem);
    if (String(current.run?.id) !== String(created.id)) throw Error("监控任务已被另一轮替代，停止监控，未重提");
    if (current.run.status !== "running") {
      console.log(JSON.stringify({ stem, status: current.run.status, runId: created.id, selected: current.run.selected_tts_id, error: current.run.error }));
      return;
    }
  }
  throw Error("监控30分钟超时，后台任务可能仍运行，未重提");
}
await Promise.all(Array.from({ length: Math.min(concurrency, stems.length) }, async () => {
  while (next < stems.length) {
    const stem = stems[next++];
    try { await processStem(stem); }
    catch (error) { console.error(JSON.stringify({ stem, status: "monitor-error", error: String(error) })); process.exitCode = 1; }
  }
}));
