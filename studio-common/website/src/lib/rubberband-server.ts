// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRubberBand, stretchRubberBand, RUBBERBAND_ASSET, type RubberBandExports } from "./rubberband-core";
let engine: RubberBandExports | undefined;
/** Lazy loading keeps build/route discovery independent of the runtime cwd. */
export function stretchSamples(input: Float32Array, sampleRate: number, ratio: number): Float32Array {
  engine ??= createRubberBand(new WebAssembly.Module(readFileSync(join(process.cwd(), "public", RUBBERBAND_ASSET))));
  return stretchRubberBand(engine, input, sampleRate, ratio);
}
