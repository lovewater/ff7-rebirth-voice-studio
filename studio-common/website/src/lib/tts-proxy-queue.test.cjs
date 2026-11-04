/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner loads the isolated scheduler. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function scheduler(env = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'tts-gpu.ts'), 'utf8')
    .split('export const PAUSE_RE')[0].replace(/^import .*;\n/gm, '');
  const context = { exports: {}, process: { env }, Map, Promise, Number, Error };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

test('default routing uses one stable proxy endpoint', () => {
  const api = scheduler();
  assert.equal(api.TTS_URL, 'http://tts-proxy:8810');
  assert.deepEqual(Array.from(api.TTS_URLS), ['http://tts-proxy:8810']);
});

for (const [value, limit] of [['2', 2], ['invalid', 8], ['0', 8], [undefined, 8]]) {
  test(`one proxy supports parallel requests, bounds queues and releases errors: ${value}`, async () => {
    const api = scheduler({ TTS_MAX_INFLIGHT: value });
    let active = 0, peak = 0;
    const gates = [];
    const jobs = Array.from({ length: limit + 3 }, (_, i) => api.withTts([], async (url) => {
      assert.equal(url, 'http://tts-proxy:8810');
      peak = Math.max(peak, ++active);
      await new Promise(resolve => gates.push(resolve));
      active--;
      if (i === 1) throw new Error('expected synthesis failure');
      return i;
    }));
    const settled = Promise.allSettled(jobs);
    assert.equal(peak, limit);
    for (let i = 0; i < jobs.length; i++) {
      assert.ok(gates.length, 'a queued request must acquire a released slot');
      gates.shift()();
      await new Promise(resolve => setImmediate(resolve));
    }
    const results = await settled;
    assert.equal(peak, limit);
    assert.equal(active, 0);
    assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  });
}

test('explicit empty configuration fails instead of waiting forever', async () => {
  await assert.rejects(scheduler({ TTS_URL: '', TTS_URLS: '' }).withTts([], async () => null), /TTS_URL/);
});
