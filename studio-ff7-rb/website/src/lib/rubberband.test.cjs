/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const m = new Module(file); cache.set(file, m);
  m.require = id => id === './rubberband-browser' ? { stretchBrowserSamples: async (...args) => server.stretchSamples(...args) }
    : id.startsWith('./') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id);
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const core = load(__dirname + '/rubberband-core.ts');
const server = load(__dirname + '/rubberband-server.ts');
const bytes = fs.readFileSync(path.join(process.cwd(), 'public', core.RUBBERBAND_ASSET));
const wasm = core.createRubberBand(new WebAssembly.Module(bytes));
const stretch = server.stretchSamples;
test('G uses the exact tested R3 short-window options',()=>{assert.equal(core.RUBBERBAND_OPTIONS,0x20110000);assert.equal(core.STRETCH_ALGORITHM,'rubberband-r3-short-offline-v1');});
const tone = (sr, seconds, hz = 440) => Float32Array.from({ length: Math.round(sr * seconds) }, (_, i) => .4 * Math.sin(2 * Math.PI * hz * i / sr));
function rms(a) { return Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length); }
function frequency(a, sr) {
  const start = Math.round(a.length * .2), end = Math.round(a.length * .8); let crossings = 0;
  for (let i = start + 1; i < end; i++) if (a[i - 1] <= 0 && a[i] > 0) crossings++;
  return crossings * sr / (end - start);
}
test('installed WASM actually constructs R3; R2/missing engine is rejected and resources released', () => {
  const state = wasm.rb_create(24000, 1.2, core.RUBBERBAND_OPTIONS);
  try { assert.equal(wasm.rb_engine(state), 3); } finally { wasm.rb_destroy(state); }
  let deleted = false;
  const fake = { ...wasm, rb_engine: () => 2, rb_destroy: s => { deleted = true; wasm.rb_destroy(s); } };
  assert.throws(() => core.stretchRubberBand(fake, tone(24000, .1), 24000, 1.1), /R3 engine/);
  assert.equal(deleted, true);
});
test('exact rounded lengths, finite PCM and preserved pitch across rates and supported ratios', () => {
  for (const sr of [16000, 22050, 24000, 32000, 44100, 48000]) {
    const input = tone(sr, .4137);
    for (const ratio of [.4, 1/1.2, .85, .999, 1, 1.001, 1.15, 1.2, 2.5]) {
      const out = stretch(input, sr, ratio);
      assert.equal(out.length, Math.round(input.length * ratio));
      assert.ok(out.every(Number.isFinite));
      assert.ok(rms(out) > .15, `${sr}/${ratio}: lost signal`);
      assert.ok(Math.abs(frequency(out, sr) - 440) < 16, `${sr}/${ratio}: shifted pitch`);
    }
  }
});
test('short selections are stretched, unity is lossless, clamps and invalid PCM fail explicitly', () => {
  for (const n of [8, 64, 479, 1199]) for (const ratio of [.4, .85, 1.2, 2.5]) {
    const input = tone(24000, n / 24000);
    assert.equal(stretch(input, 24000, ratio).length, Math.round(n * ratio));
  }
  const input = tone(24000, .2), copy = new Float32Array(input);
  assert.deepEqual(stretch(input, 24000, 1), input);
  stretch(input, 24000, 1.2); assert.deepEqual(input, copy);
  assert.equal(stretch(input, 24000, .1).length, Math.round(input.length * .4));
  assert.equal(stretch(input, 24000, 4).length, Math.round(input.length * 2.5));
  for (const ratio of [NaN, Infinity, 0, -1]) assert.throws(() => stretch(input, 24000, ratio));
  assert.throws(() => stretch(new Float32Array([NaN]), 24000, 1.1));
});
test('full study/process flush preserves speech at both edges and does not repeat tail grains', () => {
  const sr = 24000, input = tone(sr, 1);
  // Distinct end frequencies catch truncation/repeated final grains.
  input.set(tone(sr, .12, 730), input.length - Math.round(sr * .12));
  for (const ratio of [.4, .85, 1.2, 2.5]) {
    const out = stretch(input, sr, ratio), edge = Math.round(sr * Math.max(.03, .035 * ratio)); // 覆盖至少一个短窗，极端压缩时不拿14ms尾窗误判内容丢失。
    assert.ok(rms(out.subarray(0, edge)) > .1, `missing onset ${ratio}`);
    assert.ok(rms(out.subarray(-edge)) > .1, `missing tail ${ratio}`);
    assert.ok(Math.abs(frequency(out.subarray(-Math.round(sr * .09 * ratio)), sr) - 730) < 60, `wrong tail ${ratio}`);
  }
});
test('G manual preview preserves unselected PCM and processes near-unity edits', async () => {
  const edit = load(__dirname + '/audio-edit.ts');
  const ctx = { createBuffer: (_channels, length, sampleRate) => { const a = new Float32Array(length); return { length, sampleRate, duration: length/sampleRate, numberOfChannels: 1, getChannelData: () => a }; } };
  const input = tone(24000, 1), buffer = edit.bufferFromMono(ctx, input, 24000);
  const out = await edit.stretchRange(ctx, buffer, 1.2, .2, .8), samples = out.getChannelData(0);
  assert.equal(out.length, 4800 + Math.round(14400 * 1.2) + 4800);
  assert.deepEqual(samples.subarray(0, 4800), input.subarray(0, 4800));
  assert.deepEqual(samples.subarray(-4800), input.subarray(-4800));
  const target = await edit.stretchToSeconds(ctx, buffer, 1.001);
  assert.equal(target.length, 24024); // 与服务端相同，按G精确处理小比例变化。
});

test('rebuilt WASM header, pinned upstream source and licence match the source distribution', () => {
  const { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
  const vendor = path.join(process.cwd(), 'public/vendor/rubberband');
  const hash = data => createHash('sha256').update(data).digest('hex');
  // Source distribution rebuilds can embed different temporary source paths.
  // Runtime tests above verify the real R3 engine, numerical output and lengths.
  assert.deepEqual([...bytes.subarray(0,8)],[0,97,115,109,1,0,0,0]);
  assert.equal(hash(fs.readFileSync(path.join(vendor, 'rubberband-4.0.0.tar.bz2'))), 'af050313ee63bc18b35b2e064e5dce05b276aaf6d1aa2b8a82ced1fe2f8028e9');
  assert.match(fs.readFileSync(path.join(vendor, 'COPYING'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/);
  assert.match(fs.readFileSync(path.join(vendor, 'NOTICE.txt'), 'utf8'), /GPL-2.0-or-later/);
  assert.ok(fs.existsSync(path.join(vendor, 'short-offline.patch')));
  for (const name of ['rubberband-core.ts', 'rubberband-server.ts', 'rubberband-browser.ts', 'rubberband.worker.ts']) {
    assert.deepEqual(execFileSync('tar', ['xOf', path.join(vendor, 'adapters.tar.gz'), 'src/lib/' + name]), fs.readFileSync(path.join(__dirname, name)));
  }
});
