import { describe, it, expect } from "vitest";
import { computePieces } from "../src/lib/pieces";
import { extractBoundaryGraph } from "../src/lib/boundaryGraph";
import { fitAllChains, reverseFittedChain } from "../src/lib/curveFit";
import { makeGrid, makeCircleInSquare, makeDiagonal } from "./fixtures";

const fitParams = { cornerAngleDeg: 55, cornerSupport: 5, smoothingSigma: 1.2, maxError: 1.2 };

describe("end-to-end watertightness (raster -> pieces -> boundary graph -> fitted Beziers)", () => {
  it("both pieces sharing a seam see bitwise-identical control points, reversed", () => {
    const { ink, width, height } = makeGrid(3, 3, 25, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    const { chains, pieces } = extractBoundaryGraph(labels, width, height);
    fitAllChains(chains, fitParams);

    let sharedSeamsChecked = 0;
    for (const chain of chains) {
      if (chain.left < 1 || chain.right < 1) continue; // only interior seams between two real pieces
      expect(pieces.has(chain.left)).toBe(true);
      expect(pieces.has(chain.right)).toBe(true);

      const forward = chain.fitted!;
      const reversed = reverseFittedChain(forward);

      // Bitwise identical: the reversed array, re-reversed, must exactly match the original.
      const rereversed = reverseFittedChain(reversed);
      expect(rereversed).toEqual(forward);

      // And endpoint continuity across the reversal.
      expect(reversed[0].p0).toEqual(forward[forward.length - 1].p3);
      expect(reversed[reversed.length - 1].p3).toEqual(forward[0].p0);
      sharedSeamsChecked++;
    }
    expect(sharedSeamsChecked).toBeGreaterThan(0);
  });

  it("every piece's ring is closed: consecutive fitted segments share exact endpoints, and it wraps", () => {
    const { ink, width, height } = makeCircleInSquare(80, 5, 25, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    const { chains, pieces } = extractBoundaryGraph(labels, width, height);
    fitAllChains(chains, fitParams);

    for (const piece of pieces.values()) {
      for (const ring of [piece.outer, ...piece.holes]) {
        const segs = ring.flatMap((r) => {
          const chain = chains[r.chainId];
          const fitted = chain.fitted!;
          return r.reversed ? reverseFittedChain(fitted) : fitted;
        });
        for (let i = 0; i < segs.length; i++) {
          const next = segs[(i + 1) % segs.length];
          expect(segs[i].p3).toEqual(next.p0);
        }
      }
    }
  });

  it("diagonal line: fitted curve stays straight (no scalloping) across the whole chain", () => {
    const { ink, width, height } = makeDiagonal(80, 80, 30, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: false, minRegionPx: 0 });
    const { chains } = extractBoundaryGraph(labels, width, height);
    fitAllChains(chains, fitParams);

    // The diagonal seam is the one separating two *real* pieces directly;
    // the other chains run along the image border (real piece vs OUTSIDE)
    // and, for a shallow-angle diagonal, are much longer without being
    // straight in the same sense.
    const interiorChains = chains.filter((c) => c.left >= 1 && c.right >= 1);
    expect(interiorChains.length).toBeGreaterThan(0);
    let longest = interiorChains[0];
    for (const c of interiorChains) if (c.pts.length > longest.pts.length) longest = c;
    expect(longest.fitted).toBeDefined();

    // control points should all lie close to the straight line through the endpoints
    const p0 = longest.pts[0];
    const p1 = longest.pts[longest.pts.length - 1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const lineLen = Math.hypot(dx, dy);
    for (const seg of longest.fitted!) {
      for (const cp of [seg.p0, seg.p1, seg.p2, seg.p3]) {
        const cross = Math.abs((cp.x - p0.x) * dy - (cp.y - p0.y) * dx) / lineLen;
        expect(cross).toBeLessThan(2.5);
      }
    }
  });
});
