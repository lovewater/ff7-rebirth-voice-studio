const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/app/api/lines/[stem]/tts/[id]/route.ts');
let versions, confirmed, removed, files;
const sql = {
  begin: async (fn) => fn(async (strings) => {
    const query = strings.join('?');
    if (query.includes('SELECT id::text')) return versions;
    if (query.includes('SELECT skip_timing')) return [{skip_timing: confirmed}];
    if (query.includes('SELECT audio_path')) return [{audio_path: 'tts/line/10.wav', raw_audio_path: null, manifest_path: 'tts/line/10.json', status: 'ready'}];
    if (query.includes('DELETE FROM')) { removed++; return []; }
    throw new Error('Unexpected query');
  }),
};
const loaded = new Module(file, module);
loaded.filename = file;
loaded.paths = module.paths;
loaded.require = (name) => {
  if (name === '@/lib/db') return {sql};
  if (name === '@/lib/timing') return {};
  if (name === 'next/server') return {NextResponse: {json: (body, options) => ({body, status: options?.status ?? 200})}};
  if (name === 'node:fs/promises') return {rm: async (name) => files.push(name)};
  return require(name);
};
loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true},
}).outputText, file);
async function run(override = {}, lineConfirmed = false, additional = []) {
  versions = [{id: '10', is_used: false, heard_at: null, status: 'ready', ...override}, ...additional];
  confirmed = lineConfirmed; removed = 0; files = [];
  return loaded.exports.DELETE({nextUrl: new URL('http://local/tts/10?onlyUnreviewed=1')}, {params: Promise.resolve({stem: 'line', id: '10'})});
}
(async () => {
  for (const [override, confirmed, additional] of [
    [{heard_at: '2026-10-08'}, false, []],
    [{is_used: true}, false, []],
    [{status: 'building'}, false, []],
    [{}, true, []],
    [{}, false, [{id: '11', is_used: true, status: 'ready', heard_at: null}]],
  ]) {
    assert.equal((await run(override, confirmed, additional)).status, 409);
    assert.equal(removed, 0);
    assert.equal(files.length, 0);
  }
  assert.equal((await run()).status, 200);
  assert.equal(removed, 1);
  assert.equal(files.length, 2);
  console.log('Batch deletion: protects listened, adopted, building, and confirmed records; only unreviewed deletion succeeds.');
})().catch(error => { console.error(error); process.exitCode = 1; });
