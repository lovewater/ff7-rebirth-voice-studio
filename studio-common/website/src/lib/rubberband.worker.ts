// SPDX-License-Identifier: GPL-2.0-or-later
import { createRubberBand, stretchRubberBand, RUBBERBAND_ASSET, type RubberBandExports } from "./rubberband-core";
let engine: Promise<RubberBandExports> | undefined;
self.onmessage = async (event: MessageEvent<{ samples: Float32Array; sampleRate: number; ratio: number }>) => {
  try {
    engine ??= (async () => {
      const response = await fetch(RUBBERBAND_ASSET);
      if (!response.ok) throw new Error(`Rubber Band WASM 加载失败 (${response.status})`);
      return createRubberBand(await WebAssembly.compile(await response.arrayBuffer()));
    })();
    const { samples, sampleRate, ratio } = event.data;
    const output = stretchRubberBand(await engine, samples, sampleRate, ratio);
    self.postMessage({ samples: output }, { transfer: [output.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
