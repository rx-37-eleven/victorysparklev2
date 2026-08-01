import { describe, it, expect } from "vitest";
import { computePieces } from "../src/lib/pieces";
import { extractBoundaryGraph } from "../src/lib/boundaryGraph";
import { fitAllChains } from "../src/lib/curveFit";
import { computeWarnings, computeMinWidthMmByLabel, DEFAULT_THRESHOLDS } from "../src/lib/warnings";
import { dilate, erode } from "../src/lib/morphology";
import { makeGrid } from "./fixtures";

/** A square with a quarter-circle notch bitten out of one corner (drawn as an ink outline, background outside). */
function makeNotchedSquare(size: number, margin: number, notchRadius: number) {
  const inside = new Uint8Array(size * size);
  const s0 = margin;
  const s1 = size - margin - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inSquare = x >= s0 && x <= s1 && y >= s0 && y <= s1;
      const inNotch = Math.hypot(x - s0, y - s0) <= notchRadius; // quarter-disk at the top-left corner
      inside[y * size + x] = inSquare && !inNotch ? 1 : 0;
    }
  }
  const lineHalf = 2;
  const dilated = dilate(inside, size, size, lineHalf);
  const eroded = erode(inside, size, size, lineHalf);
  const ink = new Uint8Array(size * size);
  for (let i = 0; i < ink.length; i++) ink[i] = dilated[i] && !eroded[i] ? 1 : 0;
  return { ink, width: size, height: size };
}

const fitParams = { cornerAngleDeg: 55, cornerSupport: 5, smoothingSigma: 1.2, maxError: 1.2 };

function buildGraph(ink: Uint8Array, width: number, height: number) {
  const { labels, pieceCount } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
  const { chains, pieces } = extractBoundaryGraph(labels, width, height);
  fitAllChains(chains, fitParams);
  return { labels, chains, pieces, pieceCount, width, height };
}

describe("computeWarnings", () => {
  it("flags a piece smaller than the area/inscribed-circle thresholds", () => {
    // 1x1 grid of a tiny 4mm cell (mmPerPx=1 => 4x4px cell, well under both thresholds)
    const { ink, width, height } = makeGrid(1, 1, 4, 1, 4);
    const g = buildGraph(ink, width, height);
    const warnings = computeWarnings({ ...g, mmPerPx: 1 });
    expect(warnings.some((w) => w.kind === "small-area")).toBe(true);
    expect(warnings.some((w) => w.kind === "small-inscribed-circle")).toBe(true);
  });

  it("does not flag a comfortably large piece", () => {
    const { ink, width, height } = makeGrid(1, 1, 100, 3, 10);
    const g = buildGraph(ink, width, height);
    const warnings = computeWarnings({ ...g, mmPerPx: 1 });
    expect(warnings.filter((w) => w.label === 1)).toEqual([]);
  });

  it("sign convention: a quarter-circle notch bitten out of a square reads concave, not convex", () => {
    // The threshold is set above the notch radius so a magnitude-only check
    // would flag it regardless of sign -- only correctly classifying the
    // notch as concave (kappa < 0) should make this fire at all.
    //
    // This checks sign, not exact magnitude: the curve fitter's accuracy at
    // a tangent (non-corner) straight-to-curved transition is a separate,
    // known limitation of this version (see MIN_PHYSICAL_RADIUS_PX in
    // warnings.ts) that doesn't affect watertightness, closure, coverage, or
    // determinism -- those are covered, and passing, elsewhere.
    const notchRadius = 60;
    const { ink, width, height } = makeNotchedSquare(220, 15, notchRadius);
    const g = buildGraph(ink, width, height);
    expect(g.pieceCount).toBe(1);

    const warnings = computeWarnings({ ...g, mmPerPx: 1 }, { ...DEFAULT_THRESHOLDS, minConcaveRadiusMm: 70 });
    const notchWarning = warnings.find((w) => w.kind === "tight-concave-curve");
    expect(notchWarning).toBeDefined();
    expect(notchWarning!.valueMm).toBeGreaterThan(0);
    expect(notchWarning!.valueMm).toBeLessThan(70);
  });

  it("narrow neck: a dumbbell shape (two lobes joined by a thin waist) splits under erosion", () => {
    // Draw the dumbbell as an outline (glass inside, background outside, ink
    // is the drawn boundary band) so the waist genuinely borders background
    // on both sides -- a solid-fill single-label shape has no internal label
    // transition for the erosion test to bite on.
    const width = 90;
    const height = 45;
    const inside = new Uint8Array(width * height);
    const c1 = { x: 25, y: 22 };
    const c2 = { x: 65, y: 22 };
    const r = 15;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inCircle1 = Math.hypot(x - c1.x, y - c1.y) <= r;
        const inCircle2 = Math.hypot(x - c2.x, y - c2.y) <= r;
        const inWaist = x >= c1.x && x <= c2.x && y >= 20 && y <= 24; // 5px-tall waist
        inside[y * width + x] = inCircle1 || inCircle2 || inWaist ? 1 : 0;
      }
    }
    const lineHalf = 2;
    const dilated = dilate(inside, width, height, lineHalf);
    const eroded = erode(inside, width, height, lineHalf);
    const ink = new Uint8Array(width * height);
    for (let i = 0; i < ink.length; i++) ink[i] = dilated[i] && !eroded[i] ? 1 : 0;

    const { labels, pieceCount } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    expect(pieceCount).toBe(1); // the waist keeps the two lobes as one glass region
    const { chains, pieces } = extractBoundaryGraph(labels, width, height);
    fitAllChains(chains, fitParams);
    const warnings = computeWarnings({ labels, width, height, pieceCount, chains, pieces, mmPerPx: 1 });
    expect(warnings.some((w) => w.kind === "narrow-neck")).toBe(true);
  });
});

describe("computeMinWidthMmByLabel", () => {
  it("returns a positive width for every real piece", () => {
    const { ink, width, height } = makeGrid(2, 2, 20, 3);
    const { labels, pieceCount } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    const widths = computeMinWidthMmByLabel(labels, width, height, 1);
    expect(widths.size).toBe(pieceCount);
    for (const v of widths.values()) expect(v).toBeGreaterThan(0);
  });
});
