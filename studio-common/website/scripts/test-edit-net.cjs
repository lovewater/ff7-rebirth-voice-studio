const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

async function check(relative, netStatus) {
  const events = [];
  const sql = async (strings) => {
    const query = strings.join('?');
    if (query.includes('INSERT INTO')) return [{ id: '99' }];
    if (query.includes('UPDATE line_tts_versions')) { events.push('ready'); return []; }
    return [{ speaker: 'sum', text_jp: 'こんにちは', text_zh: '你好', tts_text: '你好', spoken_text: '你好', subtitle_text: '你好', duration_factor: 1 }];
  };
  sql.json = value => value;
  const file = path.resolve(__dirname, relative);
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = module.paths;
  loaded.require = name => {
    if (name === '@/lib/db') return { sql };
    if (name === '@/lib/tts-gpu') return { wavTiming: () => ({ start: 0, end: 1, duration: 1, speech: 1 }) };
    if (name === 'node:fs/promises') return { mkdir: async () => {}, writeFile: async () => events.push('wav') };
    if (name === '@/lib/speech-metrics-store') return { measureSavedEdit: async (stem, id) => {
      assert.deepEqual(events, ['wav', 'ready']);
      assert.equal(stem, 'test'); assert.equal(id, '99');
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push('measured'); return { netStatus };
    }};
    if (name === 'next/server') return { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } };
    return require(name);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, file);
  const result = await loaded.exports.POST({ json: async () => ({ wavBase64: Buffer.alloc(80).toString('base64') }) }, { params: Promise.resolve({ stem: 'test', id: '1' }) });
  assert.deepEqual(events, ['wav', 'ready', 'measured']);
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  assert.equal(result.body.netStatus, netStatus);
}
(async () => {
  for (const file of ['../src/app/api/lines/[stem]/tts/[id]/edit/route.ts', '../src/app/api/lines/[stem]/tts/edit-cn/route.ts']) {
    await check(file, 'ready');
    await check(file, 'pending');
  }
  console.log('两种音频编辑保存均等待净值计算；补算状态不会误报音频保存失败。');
})().catch(error => { console.error(error); process.exitCode = 1; });
