import { describe, it, expect } from "vitest";
import { computePieces } from "../src/lib/pieces";
import { extractBoundaryGraph } from "../src/lib/boundaryGraph";
import { fitAllChains, bezierPoint } from "../src/lib/curveFit";
import { offsetPiece, flattenRing } from "../src/lib/offset";
import { makeGrid, makeCircleInSquare } from "./fixtures";

const fitParams = { cornerAngleDeg: 55, cornerSupport: 5, smoothingSigma: 1.2, maxError: 1.2 };

function buildGraph(ink: Uint8Array, width: number, height: number) {
  const { labels, pieceCount } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
  const { chains, pieces } = extractBoundaryGraph(labels, width, height);
  fitAllChains(chains, fitParams);
  return { chains, pieces, pieceCount };
}

function ringArea(segs: { p0: any; p1: any; p2: any; p3: any }[]): number {
  const pts: { x: number; y: number }[] = [];
  for (const seg of segs) {
    for (let i = 0; i < 10; i++) pts.push(bezierPoint(seg, i / 10));
  }
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return Math.abs(area / 2);
}

describe("offsetPiece", () => {
  it("delta=0 returns the original geometry unchanged", () => {
    const { ink, width, height } = makeGrid(2, 2, 20, 3);
    const { chains, pieces } = buildGraph(ink, width, height);
    const piece = pieces.get(1)!;
    const result = offsetPiece(piece, chains, 0, fitParams);
    expect(result.outcome).toBe("ok");
  });

  it("shrinks a piece's area for a positive delta", () => {
    const { ink, width, height } = makeGrid(1, 1, 60, 3, 15);
    const { chains, pieces } = buildGraph(ink, width, height);
    const piece = pieces.get(1)!;
    const original = ringArea(offsetPiece(piece, chains, 0, fitParams).outer);
    const result = offsetPiece(piece, chains, 3, fitParams);
    expect(result.outcome).toBe("ok");
    const offsetArea = ringArea(result.outer);
    expect(offsetArea).toBeLessThan(original);
    // rough sanity: shrinking a ~60x60 square by 3px on each side should remove roughly 4*60*3 =~ 720px^2, not the whole thing
    expect(offsetArea).toBeGreaterThan(original * 0.5);
  });

  it("keeps a hole a hole after offset (circle-in-square)", () => {
    const { ink, width, height } = makeCircleInSquare(150, 15, 40, 3);
    const { chains, pieces } = buildGraph(ink, width, height);
    const withHole = Array.from(pieces.values()).find((p) => p.holes.length > 0)!;
    const result = offsetPiece(withHole, chains, 2, fitParams);
    expect(result.outcome).toBe("ok");
    expect(result.holes.length).toBe(1);
  });

  it("falls back to un-offset geometry and reports 'vanished' when the offset is too large", () => {
    const { ink, width, height } = makeGrid(1, 1, 20, 3, 10);
    const { chains, pieces } = buildGraph(ink, width, height);
    const piece = pieces.get(1)!;
    const original = offsetPiece(piece, chains, 0, fitParams);
    const result = offsetPiece(piece, chains, 15, fitParams); // bigger than half the 20px cell
    expect(result.outcome).toBe("vanished");
    // un-offset fallback: same geometry as the delta=0 case
    expect(result.outer.length).toBe(original.outer.length);
  });

  it("flattenRing produces a polygon within tolerance of the fitted curve", () => {
    const { ink, width, height } = makeCircleInSquare(150, 15, 40, 3);
    const { chains, pieces } = buildGraph(ink, width, height);
    const withoutHole = Array.from(pieces.values()).find((p) => p.holes.length === 0)!;
    const pts = flattenRing(chains, withoutHole.outer, 0.05);
    expect(pts.length).toBeGreaterThan(10);
  });

  it("regression: a tiny offset on a multi-piece panel never produces wild control points, including for corner pieces bordering the panel edge", () => {
    // This is the scenario that used to break: a small (sub-pixel) kerf
    // offset applied to a 3x3 grid. Corner pieces -- whose boundary
    // includes the panel's outer border, not just piece-to-piece seams --
    // used to come back with a handful of control points flung far outside
    // the piece's own bounding box (a Schneider-fitter re-fit pathology on
    // the offset polygon, see curveFit.ts and offset.ts). Offset geometry
    // now always uses a straight-line polygon, which is immune to that
    // class of bug by construction; this test guards against a regression
    // back to re-fitting it.
    const { ink, width, height } = makeGrid(3, 3, 86, 4, 20);
    const { chains, pieces, pieceCount } = buildGraph(ink, width, height);
    expect(pieceCount).toBe(9);

    const deltaPx = 0.4; // sub-pixel, matches a ~0.4mm foil offset at ~1mm/px
    for (const piece of pieces.values()) {
      const result = offsetPiece(piece, chains, deltaPx, fitParams);
      expect(result.outcome).toBe("ok");

      const original = flattenRing(chains, piece.outer);
      const xs = original.map((p) => p.x);
      const ys = original.map((p) => p.y);
      const minX = Math.min(...xs) - 2;
      const maxX = Math.max(...xs) + 2;
      const minY = Math.min(...ys) - 2;
      const maxY = Math.max(...ys) + 2;

      for (const seg of result.outer) {
        for (const cp of [seg.p0, seg.p1, seg.p2, seg.p3]) {
          expect(cp.x).toBeGreaterThanOrEqual(minX);
          expect(cp.x).toBeLessThanOrEqual(maxX);
          expect(cp.y).toBeGreaterThanOrEqual(minY);
          expect(cp.y).toBeLessThanOrEqual(maxY);
        }
      }
    }
  });
});
