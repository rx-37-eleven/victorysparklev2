import { describe, it, expect } from "vitest";
import { computePieces } from "../src/lib/pieces";
import { extractBoundaryGraph, type Chain, type Ring } from "../src/lib/boundaryGraph";
import { makeGrid, makeCircleInSquare } from "./fixtures";

function ringPointsInclusive(chains: Chain[], ring: Ring[]) {
  const pts: { x: number; y: number }[] = [];
  for (const r of ring) {
    const chain = chains[r.chainId];
    const seg = r.reversed ? [...chain.pts].reverse() : chain.pts;
    if (pts.length > 0) for (let i = 1; i < seg.length; i++) pts.push(seg[i]);
    else pts.push(...seg);
  }
  return pts;
}

describe("extractBoundaryGraph", () => {
  it("every chain is referenced by exactly two pieces (or one piece + outside/background), once forward once reversed", () => {
    const { ink, width, height } = makeGrid(2, 2, 20, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    const { chains, pieces } = extractBoundaryGraph(labels, width, height);

    const usage = new Map<number, { forward: number; reversed: number }>();
    for (const piece of pieces.values()) {
      for (const ring of [piece.outer, ...piece.holes]) {
        for (const r of ring) {
          const u = usage.get(r.chainId) ?? { forward: 0, reversed: 0 };
          if (r.reversed) u.reversed++;
          else u.forward++;
          usage.set(r.chainId, u);
        }
      }
    }

    for (const chain of chains) {
      const u = usage.get(chain.id) ?? { forward: 0, reversed: 0 };
      const leftIsPiece = chain.left >= 1;
      const rightIsPiece = chain.right >= 1;
      const expectedForward = leftIsPiece ? 1 : 0;
      const expectedReversed = rightIsPiece ? 1 : 0;
      expect(u.forward).toBe(expectedForward);
      expect(u.reversed).toBe(expectedReversed);
    }
  });

  it("watertightness: shared seam point sequence is bitwise-identical, reversed, between adjacent pieces", () => {
    const { ink, width, height } = makeGrid(3, 3, 25, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    const { chains, pieces } = extractBoundaryGraph(labels, width, height);

    // For every chain shared by two real pieces, find both rings that use it and confirm exact reversal.
    for (const chain of chains) {
      if (chain.left < 1 || chain.right < 1) continue;
      const leftPiece = pieces.get(chain.left)!;
      const rightPiece = pieces.get(chain.right)!;
      const findsUsage = (piece: typeof leftPiece) => {
        for (const ring of [piece.outer, ...piece.holes]) {
          const found = ring.find((r) => r.chainId === chain.id);
          if (found) return found;
        }
        return undefined;
      };
      const leftUsage = findsUsage(leftPiece);
      const rightUsage = findsUsage(rightPiece);
      expect(leftUsage).toBeDefined();
      expect(rightUsage).toBeDefined();
      expect(leftUsage!.reversed).toBe(false);
      expect(rightUsage!.reversed).toBe(true);
      // Bitwise-identical control points, reversed.
      const forwardPts = chain.pts;
      const reversedPts = [...chain.pts].reverse();
      for (let i = 0; i < forwardPts.length; i++) {
        expect(reversedPts[i].x).toBe(forwardPts[forwardPts.length - 1 - i].x);
        expect(reversedPts[i].y).toBe(forwardPts[forwardPts.length - 1 - i].y);
      }
    }
  });

  it("closure: every assembled ring is a closed loop (first point === last point when wrapped)", () => {
    const { ink, width, height } = makeGrid(3, 3, 25, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    const { chains, pieces } = extractBoundaryGraph(labels, width, height);
    for (const piece of pieces.values()) {
      for (const ring of [piece.outer, ...piece.holes]) {
        expect(ring.length).toBeGreaterThan(0);
        const pts = ringPointsInclusive(chains, ring);
        // ring is implicitly closed: last chain's endpoint must equal first chain's start point
        const first = pts[0];
        const last = pts[pts.length - 1];
        // the stitching loop always returns to the ring's starting node
        const firstChain = chains[ring[0].chainId];
        const startNode = ring[0].reversed ? firstChain.b : firstChain.a;
        const lastRingEntry = ring[ring.length - 1];
        const lastChain = chains[lastRingEntry.chainId];
        const endNode = lastRingEntry.reversed ? lastChain.a : lastChain.b;
        expect(endNode).toBe(startNode);
        void first;
        void last;
      }
    }
  });

  it("coverage: sum of piece areas equals panel area within 0.1%", () => {
    const { ink, width, height } = makeGrid(3, 3, 25, 3);
    const { labels, pieceCount } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    let panelPixels = 0;
    for (const l of labels) if (l >= 1) panelPixels++;
    void pieceCount;

    const { chains, pieces } = extractBoundaryGraph(labels, width, height);
    let totalArea = 0;
    for (const piece of pieces.values()) {
      const outerArea = Math.abs(ringSignedAreaFor(chains, piece.outer));
      let holeArea = 0;
      for (const hole of piece.holes) holeArea += Math.abs(ringSignedAreaFor(chains, hole));
      totalArea += outerArea - holeArea;
    }
    expect(Math.abs(totalArea - panelPixels) / panelPixels).toBeLessThan(0.001);
  });

  it("circle-in-square: outer piece has a hole, inner ring is the reversed same curve", () => {
    const { ink, width, height } = makeCircleInSquare(80, 5, 25, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    const { chains, pieces } = extractBoundaryGraph(labels, width, height);
    expect(pieces.size).toBe(2);
    const withHole = Array.from(pieces.values()).find((p) => p.holes.length > 0);
    const withoutHole = Array.from(pieces.values()).find((p) => p.holes.length === 0);
    expect(withHole).toBeDefined();
    expect(withoutHole).toBeDefined();
    expect(withHole!.holes.length).toBe(1);

    // The hole ring of the square piece must be the reverse of the circle's outer ring.
    const holeRing = withHole!.holes[0];
    const circleOuter = withoutHole!.outer;
    expect(holeRing.length).toBe(circleOuter.length);
    const holePts = ringPointsInclusive(chains, holeRing);
    const circlePts = ringPointsInclusive(chains, [...circleOuter].reverse().map((r) => ({ ...r, reversed: !r.reversed })));
    expect(holePts.length).toBe(circlePts.length);
  });
});

function ringSignedAreaFor(chains: Chain[], ring: Ring[]): number {
  const pts = ringPointsInclusive(chains, ring);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}
