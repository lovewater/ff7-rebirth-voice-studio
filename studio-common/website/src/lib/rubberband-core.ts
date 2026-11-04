// SPDX-License-Identifier: GPL-2.0-or-later
/** Shared, synchronous DSP. Instantiate only inside a browser Worker or Node. */
export const RUBBERBAND_ASSET = "/vendor/rubberband/rubberband-4.0.0.wasm";
export const RUBBERBAND_OPTIONS = 0x20000000 | 0x00010000 | 0x00100000;
// G: OptionEngineFiner | OptionThreadingNever | OptionWindowShort.
// Offline study/process, short window, pitch scale 1; matches the blind-test winner.
export const STRETCH_ALGORITHM = "rubberband-r3-short-offline-v1";
export type RubberBandExports = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  rb_alloc(bytes: number): number;
  rb_free(pointer: number): void;
  rb_create(rate: number, ratio: number, options: number): number;
  rb_engine(state: number): number;
  rb_destroy(state: number): void;
  rb_run(state: number, input: number, frames: number, output: number, capacity: number): number;
};
export function createRubberBand(module: WebAssembly.Module) {
  const unsupported = () => { throw new Error("Rubber Band WASM called an unsupported system operation"); };
  const instance = new WebAssembly.Instance(module, {
    env: { emscripten_notify_memory_growth: () => {} },
    wasi_snapshot_preview1: {
      proc_exit: unsupported, fd_close: unsupported, fd_seek: unsupported,
      fd_read: unsupported,
      fd_write: (fd: number, iov: number, count: number, written: number) => {
        if (fd !== 1 && fd !== 2) return 8;
        const view = new DataView(wasm.memory.buffer);
        let size = 0, message = "";
        for (let i = 0; i < count; i++) {
          const pointer = view.getUint32(iov + i * 8, true), length = view.getUint32(iov + i * 8 + 4, true);
          message += new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, pointer, length));
          size += length;
        }
        view.setUint32(written, size, true);
        if (message.trim()) console.warn(message.trim());
        return 0;
      },
      environ_sizes_get: (count: number, size: number) => {
        const view = new DataView(wasm.memory.buffer);
        view.setUint32(count, 0, true); view.setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      clock_time_get: (_clock: number, _precision: bigint, result: number) => {
        new DataView(wasm.memory.buffer).setBigUint64(result, BigInt(Date.now()) * BigInt(1000000), true);
        return 0;
      },
    },
  });
  const wasm = instance.exports as unknown as RubberBandExports;
  wasm._initialize();
  return wasm;
}
/** ratio = output/input duration, clamped to the existing [0.4, 2.5] range.
 * Even tiny and near-unity edits have exact rounded lengths; unity is lossless.
 * No speech threshold crop, artificial fade, latency crop or WSOLA fallback.
 */
export function stretchRubberBand(wasm: RubberBandExports, input: Float32Array, sampleRate: number, ratio: number): Float32Array {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("无效的变速比例");
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 192000) throw new Error("无效的采样率");
  for (const sample of input) if (!Number.isFinite(sample)) throw new Error("音频包含无效采样");
  const scale = Math.min(2.5, Math.max(0.4, ratio));
  const frames = input.length ? Math.max(1, Math.round(input.length * scale)) : 0;
  if (!frames || scale === 1) return new Float32Array(input);
  const state = wasm.rb_create(sampleRate, scale, RUBBERBAND_OPTIONS);
  if (!state) throw new Error("Rubber Band 初始化失败");
  let source = 0, dest = 0;
  try {
    if (wasm.rb_engine(state) !== 3) throw new Error("Rubber Band R3 engine is required");
    source = wasm.rb_alloc(input.byteLength);
    // One extra sample accommodates floor vs round upstream duration rounding.
    dest = wasm.rb_alloc((frames + 1) * 4);
    if (!source || !dest) throw new Error("Rubber Band 内存不足");
    new Float32Array(wasm.memory.buffer, source, input.length).set(input);
    const count = wasm.rb_run(state, source, input.length, dest, frames + 1);
    if (count < 0 || Math.abs(count - frames) > 1) throw new Error(`Rubber Band 输出长度异常 (${count}/${frames})`);
    const out = new Float32Array(frames);
    out.set(new Float32Array(wasm.memory.buffer, dest, Math.min(count, frames)));
    for (const sample of out) if (!Number.isFinite(sample)) throw new Error("Rubber Band 输出包含无效采样");
    return out;
  } finally {
    if (dest) wasm.rb_free(dest);
    if (source) wasm.rb_free(source);
    wasm.rb_destroy(state);
  }
}
