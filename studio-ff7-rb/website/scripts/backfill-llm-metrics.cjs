/* eslint-disable @typescript-eslint/no-require-imports */
// 只回填确实记录过的调用；历史日志不保证覆盖完整流程，因此明确标记 recorded-calls。
// 默认只预览，--apply 才写入；已有统计、子音频、运行中的任务均不覆盖。
const { summarizeLlmCalls } = require('../src/lib/llm-metrics-summary.ts');
const sql = require('postgres')(process.env.DATABASE_URL || '');
async function main() {
  // 逐次日志现存数据库；不再依赖已删除的单文件追加日志。
  const calls = await sql`SELECT auto_run_id::text AS "runId", stem, started_at AS "startedAt",
    elapsed_ms AS "elapsedMs", input_tokens AS "promptTokens", output_tokens AS "completionTokens",
    total_tokens AS "totalTokens", cached_tokens AS "cachedTokens", reasoning_tokens AS "reasoningTokens"
    FROM llm_access_logs WHERE auto_run_id IS NOT NULL AND completed_at IS NOT NULL`;
  for (const row of calls) for (const key of ['promptTokens','completionTokens','totalTokens','cachedTokens','reasoningTokens']) {
    if (row[key] !== null) row[key] = Number(row[key]);
  }
  const roots = await sql`SELECT r.id::text AS run_id, r.stem, r.created_at, r.completed_at, v.id::text AS audio_id
    FROM line_auto_runs r JOIN line_tts_versions v ON v.id=r.selected_tts_id AND v.auto_run_id=r.id
    WHERE r.status <> 'running' AND v.status='ready' AND v.parent_tts_id IS NULL AND v.llm_tokens IS NULL AND v.llm_speed IS NULL`;
  for (const root of roots) {
    const rows = calls.filter(c => String(c.runId) === root.run_id && c.stem === root.stem
      && Date.parse(c.startedAt) >= +root.created_at && Date.parse(c.startedAt) <= +root.completed_at);
    if (!rows.length) continue;
    const summary = summarizeLlmCalls(rows, 'recorded-calls');
    let written = false;
    if (process.argv.includes('--apply')) {
      const updated = await sql`UPDATE line_tts_versions v SET llm_tokens=${sql.json(summary.tokens)}, llm_speed=${sql.json(summary.speed)}
        WHERE v.id=${root.audio_id} AND v.parent_tts_id IS NULL AND v.llm_tokens IS NULL AND v.llm_speed IS NULL
        AND EXISTS (SELECT 1 FROM line_auto_runs r WHERE r.id=${root.run_id} AND r.selected_tts_id=v.id AND r.status<>'running') RETURNING v.id`;
      written = updated.length === 1;
    }
    console.log(JSON.stringify({ ...root, ...summary, written }));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>sql.end());
