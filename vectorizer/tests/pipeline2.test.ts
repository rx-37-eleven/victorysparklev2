import { describe, it, expect } from "vitest";
import { PipelineCache, runPipeline, DEFAULT_PARAMS, otsuDefault } from "../src/lib/pipeline";
import { makeGrid } from "./fixtures";

function inkToGray(ink: Uint8Array): Float32Array {
  const gray = new Float32Array(ink.length);
  for (let i = 0; i < ink.length; i++) gray[i] = ink[i] ? 0 : 255;
  return gray;
}

describe("runPipeline", () => {
  it("produces the expected piece count end-to-end and a valid SVG", () => {
    const { ink, width, height } = makeGrid(3, 3, 30, 3);
    const cache = new PipelineCache();
    cache.loadSource(inkToGray(ink), width, height, false);
    const params = { ...DEFAULT_PARAMS, threshold: 128, closeGaps: 0, despeckle: 0, minRegionPx: 0, mmPerPx: 1 };
    const result = runPipeline(cache, params);
    expect(result.pieceCount).toBe(9);
    expect(result.svg.svg).toContain("<svg");
    expect((result.svg.svg.match(/<path/g) ?? []).length).toBe(9);
    expect(result.warnings).toBeInstanceOf(Array);
  });

  it("caches upstream stages: changing only smoothing does not recompute binarize/pieces", () => {
    const { ink, width, height } = makeGrid(2, 2, 20, 3);
    const cache = new PipelineCache();
    cache.loadSource(inkToGray(ink), width, height, false);
    const params = { ...DEFAULT_PARAMS, closeGaps: 0, despeckle: 0, minRegionPx: 0, mmPerPx: 1 };
    runPipeline(cache, params);
    const s1ValueBefore = cache.s1.value;
    const s3ValueBefore = cache.s3.value;

    runPipeline(cache, { ...params, smoothingSigma: 3.0 });
    expect(cache.s1.value).toBe(s1ValueBefore); // same object reference -- not recomputed
    expect(cache.s3.value).toBe(s3ValueBefore);
  });

  it("otsuDefault returns a sane threshold for the loaded image", () => {
    const { ink, width, height } = makeGrid(2, 2, 20, 3);
    const cache = new PipelineCache();
    cache.loadSource(inkToGray(ink), width, height, false);
    const t = otsuDefault(cache);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(255);
  });

  it("applies a kerf offset without crashing and reports outcomes", () => {
    const { ink, width, height } = makeGrid(2, 2, 30, 3, 10);
    const cache = new PipelineCache();
    cache.loadSource(inkToGray(ink), width, height, false);
    const params = { ...DEFAULT_PARAMS, closeGaps: 0, despeckle: 0, minRegionPx: 0, mmPerPx: 1, offsetMm: 2 };
    const result = runPipeline(cache, params);
    expect(result.offsetOutcomes.size).toBe(result.pieceCount);
    expect(result.svg.svg).toContain("<svg");
  });
});
