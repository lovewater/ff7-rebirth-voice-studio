// SPDX-License-Identifier: GPL-2.0-or-later
/** A worker per edit bounds WASM memory lifetime and isolates failures.
 * Transfer a copy: source audio and undo history must never be detached.
 */
export function stretchBrowserSamples(input: Float32Array, sampleRate: number, ratio: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./rubberband.worker.ts", import.meta.url));
    const finish = () => { clearTimeout(timeout); worker.terminate(); };
    const timeout = setTimeout(() => { finish(); reject(new Error("Rubber Band 处理超时")); }, 120000);
    worker.onmessage = (event: MessageEvent<{ samples?: Float32Array; error?: string }>) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.samples instanceof Float32Array) resolve(event.data.samples);
      else reject(new Error("Rubber Band 返回无效音频"));
    };
    worker.onerror = (event) => { finish(); reject(new Error(event.message || "Rubber Band Worker 失败")); };
    worker.onmessageerror = () => { finish(); reject(new Error("Rubber Band Worker 消息读取失败")); };
    const samples = new Float32Array(input);
    try {
      worker.postMessage({ samples, sampleRate, ratio }, [samples.buffer]);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}
