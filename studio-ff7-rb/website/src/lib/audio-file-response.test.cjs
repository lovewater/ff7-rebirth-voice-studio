/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { audioFileResponse } = require('./audio-file-response.ts');

test('audio HTTP responses support mobile probes, ranges, HEAD and invalid ranges with exact bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ff7-audio-range-'));
  const file = path.join(dir, 'test.mp3');
  const data = Buffer.from('0123456789');
  await writeFile(file, data);
  const response = (range, method = 'GET', extra = {}) => audioFileResponse(new Request('http://test/audio', { method, headers: { ...(range ? { range } : {}), ...extra } }), file, { contentType: 'audio/mpeg', headers: { 'x-reference-kind': 'original' } });
  try {
    for (const [range, status, expected, contentRange] of [
      [null, 200, '0123456789', null], ['bytes=0-1', 206, '01', 'bytes 0-1/10'],
      ['bytes=3-6', 206, '3456', 'bytes 3-6/10'], ['bytes=7-', 206, '789', 'bytes 7-9/10'],
      ['bytes=-3', 206, '789', 'bytes 7-9/10'], ['bytes=-99', 206, '0123456789', 'bytes 0-9/10'],
      ['bytes=8-99', 206, '89', 'bytes 8-9/10'], ['bytes=0-0', 206, '0', 'bytes 0-0/10'],
      ['bytes=10-', 416, '', 'bytes */10'], ['bytes=5-2', 416, '', 'bytes */10'],
      ['bytes=-0', 416, '', 'bytes */10'], ['bytes=-', 416, '', 'bytes */10'],
      ['bytes=9007199254740993-', 416, '', 'bytes */10'],
      ['bytes=0-1,4-5', 200, '0123456789', null], ['items=0-1', 200, '0123456789', null],
    ]) {
      const r = await response(range);
      assert.equal(r.status, status, range);
      assert.equal(r.headers.get('content-range'), contentRange, range);
      assert.equal(r.headers.get('accept-ranges'), 'bytes');
      assert.equal(r.headers.get('content-length'), String(expected.length));
      assert.equal(r.headers.get('x-reference-kind'), 'original');
      assert.equal(await r.text(), expected, range);
    }
    const head = await response(null, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(await head.text(), '');
    const changed = await response('bytes=0-1', 'GET', { 'if-range': '"old"' });
    assert.equal(changed.status, 200);
    assert.equal(await changed.text(), data.toString());
    await writeFile(file, '');
    assert.equal((await response('bytes=0-1')).status, 416);
    const empty = await response(null);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('content-length'), '0');
    assert.equal(await empty.text(), '');
    await rm(file);
    assert.equal((await response(null)).status, 404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
