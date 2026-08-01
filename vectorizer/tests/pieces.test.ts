import { describe, it, expect } from "vitest";
import { computePieces } from "../src/lib/pieces";
import { makeGrid, makeGridWithGap, makeCircleInSquare, makeDiagonal } from "./fixtures";

const defaultParams = { treatEdgeAsBorder: true, minRegionPx: 0 };

describe("grid-3x3 fixture", () => {
  it("produces exactly 9 pieces, all roughly congruent", () => {
    const { ink, width, height } = makeGrid(3, 3, 30, 3);
    const { labels, pieceCount } = computePieces(ink, width, height, defaultParams);
    expect(pieceCount).toBe(9);

    // With an odd (3px) line width, the exact center pixel of every seam is
    // a genuine tie between the two flanking pieces, and per spec those ties
    // break toward the lowest label id -- which, under raster-scan labeling,
    // correlates with position (earlier/top-left cells win ties against
    // later/bottom-right ones). So corner/edge cells accumulate a small,
    // bounded, deterministic area bias relative to the interior cell: at
    // most one tied row/column (~1px) per shared seam, and a 3x3 grid cell
    // has at most 2 interior seams. That bias is not itself a bug -- assert
    // it stays within that bound instead of requiring exact equality.
    const areas = new Map<number, number>();
    for (const l of labels) if (l > 0) areas.set(l, (areas.get(l) ?? 0) + 1);
    const values = Array.from(areas.values());
    const maxArea = Math.max(...values);
    const minArea = Math.min(...values);
    const cellSize = 30;
    expect(maxArea - minArea).toBeLessThanOrEqual(2 * cellSize);
  });

  it("puts the boundary on the centerline of the drawn line, independent of line width", () => {
    const margin = 20;
    const thin = makeGrid(3, 3, 30, 1, margin);
    const thick = makeGrid(3, 3, 30, 9, margin);
    const resThin = computePieces(thin.ink, thin.width, thin.height, defaultParams);
    const resThick = computePieces(thick.ink, thick.width, thick.height, defaultParams);

    // Same margin => same coordinate frame for both, so the seam's absolute
    // x position is directly comparable. It should land at the same place
    // regardless of whether the source line was drawn 1px or 9px wide.
    const row = Math.floor(thin.height / 2);
    const seamX = (labels: Int32Array, width: number, fromLabel: number) => {
      for (let x = 1; x < width; x++) {
        const a = labels[row * width + x - 1];
        const b = labels[row * width + x];
        if (a === fromLabel && b !== fromLabel) return x;
      }
      return -1;
    };
    const leftLabelThin = resThin.labels[row * thin.width + margin + 2];
    const leftLabelThick = resThick.labels[row * thick.width + margin + 2];
    const xThin = seamX(resThin.labels, thin.width, leftLabelThin);
    const xThick = seamX(resThick.labels, thick.width, leftLabelThick);
    expect(Math.abs(xThin - xThick)).toBeLessThanOrEqual(1);
  });
});

describe("circle-in-square fixture", () => {
  it("produces exactly 2 pieces", () => {
    const { ink, width, height } = makeCircleInSquare(100, 5, 30, 3);
    const { pieceCount } = computePieces(ink, width, height, defaultParams);
    expect(pieceCount).toBe(2);
  });
});

describe("broken-line fixture", () => {
  it("merges two pieces into one when the gap is unclosed (closeGaps=0 emulated by not closing)", () => {
    const { ink, width, height } = makeGridWithGap(3, 3, 30, 3, 4);
    const { pieceCount } = computePieces(ink, width, height, defaultParams);
    expect(pieceCount).toBe(8);
  });
});

describe("diagonals fixture (EDT isotropy)", () => {
  it("keeps a 45-degree cut line straight (no scalloping)", () => {
    const { ink, width, height } = makeDiagonal(60, 60, 45, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: false, minRegionPx: 0 });
    // Sample the boundary between the two half-plane pieces along several
    // rows; for a straight 45-degree line the seam's x-offset per row should
    // be constant (+-1px for rounding), not wander.
    const offsets: number[] = [];
    for (let y = 10; y < height - 10; y++) {
      let seamX = -1;
      for (let x = 1; x < width; x++) {
        if (labels[y * width + x - 1] !== labels[y * width + x]) {
          seamX = x;
          break;
        }
      }
      if (seamX >= 0) offsets.push(seamX - y);
    }
    const min = Math.min(...offsets);
    const max = Math.max(...offsets);
    expect(max - min).toBeLessThanOrEqual(2);
  });
});
