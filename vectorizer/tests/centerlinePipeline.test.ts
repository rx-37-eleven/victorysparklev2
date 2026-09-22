import { describe, it, expect } from "vitest";
import { skeletonize } from "../src/lib/skeleton";
import {
  buildCenterlineGraph,
  dissolveDegreeTwoNodes,
  liveEdges,
  liveNodes,
  polylineLength,
  pruneSpurs,
} from "../src/lib/centerline";
import { offsetCurves, strokeOutline } from "../src/lib/stroke";
import { fitChain } from "../src/lib/curveFit";
import { flattenBezierPath } from "../src/lib/offset";
import { PipelineCache, runPipeline, DEFAULT_PARAMS } from "../src/lib/pipeline";

const FIT = { cornerAngleDeg: 55, cornerSupport: 4, smoothingSigma: 1.2, maxError: 1.2 };

/** A rectangular border with one vertical divider -- two glass pieces. */
function twoPaneFixture(width: number, height: number, thickness: number) {
  const ink = new Uint8Array(width * height);
  const set = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) ink[y * width + x] = 1;
  };
  const margin = Math.round(width * 0.07);
  const dividerX = Math.round(width / 2);
  for (let x = margin; x < width - margin; x++) {
    for (let t = 0; t < thickness; t++) {
      set(x, margin + t);
      set(x, height - 1 - margin - t);
    }
  }
  for (let y = margin; y < height - margin; y++) {
    for (let t = 0; t < thickness; t++) {
      set(margin + t, y);
      set(width - 1 - margin - t, y);
      set(dividerX + t, y);
    }
  }
  return { ink, width, height, dividerCentreX: dividerX + (thickness - 1) / 2 + 0.5 };
}

function inkToGray(ink: Uint8Array): Float32Array {
  const gray = new Float32Array(ink.length);
  for (let i = 0; i < ink.length; i++) gray[i] = ink[i] ? 0 : 255;
  return gray;
}

/** Every x where the flattened ring crosses the horizontal line y = atY. */
function crossingsAtY(ring: { x: number; y: number }[], atY: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a.y === b.y) continue;
    if (a.y > atY === b.y > atY) continue;
    xs.push(a.x + ((b.x - a.x) * (atY - a.y)) / (b.y - a.y));
  }
  return xs.sort((p, q) => p - q);
}

describe("skeletonize", () => {
  it("thins a thick line to a single pixel wide", () => {
    const width = 40;
    const height = 20;
    const ink = new Uint8Array(width * height);
    for (let y = 6; y < 13; y++) for (let x = 4; x < 36; x++) ink[y * width + x] = 1;

    const skeleton = skeletonize(ink, width, height);
    for (let x = 8; x < 32; x++) {
      let count = 0;
      for (let y = 0; y < height; y++) if (skeleton[y * width + x]) count++;
      expect(count).toBe(1);
    }
  });

  it("puts the centreline in the middle of the stroke, whatever its width", () => {
    const width = 40;
    const height = 30;
    const ink = new Uint8Array(width * height);
    // A stroke spanning rows 5..14 -- centre row 9.5.
    for (let y = 5; y <= 14; y++) for (let x = 4; x < 36; x++) ink[y * width + x] = 1;

    const skeleton = skeletonize(ink, width, height);
    const rows: number[] = [];
    for (let x = 10; x < 30; x++) {
      for (let y = 0; y < height; y++) if (skeleton[y * width + x]) rows.push(y);
    }
    for (const row of rows) expect(Math.abs(row - 9.5)).toBeLessThanOrEqual(1);
  });

  it("leaves no spurious junction at a right-angle corner", () => {
    const width = 30;
    const height = 30;
    const ink = new Uint8Array(width * height);
    for (let x = 5; x < 25; x++) for (let t = 0; t < 3; t++) ink[(5 + t) * width + x] = 1;
    for (let y = 5; y < 25; y++) for (let t = 0; t < 3; t++) ink[y * width + 5 + t] = 1;

    const graph = buildCenterlineGraph(skeletonize(ink, width, height), width, height);
    // Two line ends and nothing else: the corner must not read as a junction.
    const nodes = liveNodes(graph);
    expect(nodes.length).toBe(2);
    expect(nodes.every((n) => n.edges.length === 1)).toBe(true);
    expect(liveEdges(graph).length).toBe(1);
  });
});

describe("centreline graph", () => {
  it("finds the junctions of a two-pane panel and nothing else", () => {
    const { ink, width, height } = twoPaneFixture(120, 80, 3);
    const graph = buildCenterlineGraph(skeletonize(ink, width, height), width, height);
    pruneSpurs(graph, 6);
    dissolveDegreeTwoNodes(graph);

    // The divider meets the border at exactly two T-junctions, and the three
    // runs between them (left way round, right way round, divider) are edges.
    expect(liveNodes(graph).length).toBe(2);
    expect(liveEdges(graph).length).toBe(3);
    for (const node of liveNodes(graph)) expect(node.edges.length).toBe(3);
  });

  it("prunes dangling branches shorter than the threshold and keeps longer ones", () => {
    const width = 80;
    const height = 40;
    const ink = new Uint8Array(width * height);
    const set = (x: number, y: number) => { ink[y * width + x] = 1; };
    for (let x = 5; x < 75; x++) for (let t = 0; t < 3; t++) set(x, 20 + t);
    // A stub hanging off the middle, 12px long.
    for (let y = 8; y < 20; y++) for (let t = 0; t < 3; t++) set(40 + t, y);

    const build = () => {
      const g = buildCenterlineGraph(skeletonize(ink, width, height), width, height);
      return g;
    };

    const kept = build();
    pruneSpurs(kept, 5);
    dissolveDegreeTwoNodes(kept);
    const keptLengths = liveEdges(kept).map((e) => polylineLength(e.pts));
    expect(keptLengths.some((l) => l > 8 && l < 18)).toBe(true);

    const trimmed = build();
    pruneSpurs(trimmed, 20);
    dissolveDegreeTwoNodes(trimmed);
    // With the stub gone the remaining line is one unbroken run.
    expect(liveEdges(trimmed).length).toBe(1);
  });

  it("dissolves a node left with two edges so the fit runs through it", () => {
    const width = 80;
    const height = 40;
    const ink = new Uint8Array(width * height);
    const set = (x: number, y: number) => { ink[y * width + x] = 1; };
    for (let x = 5; x < 75; x++) for (let t = 0; t < 3; t++) set(x, 20 + t);
    for (let y = 14; y < 20; y++) for (let t = 0; t < 3; t++) set(40 + t, y);

    const graph = buildCenterlineGraph(skeletonize(ink, width, height), width, height);
    expect(liveEdges(graph).length).toBe(3); // left, right, stub
    pruneSpurs(graph, 20);
    expect(liveEdges(graph).length).toBe(2); // stub gone, junction now a pass-through
    dissolveDegreeTwoNodes(graph);
    expect(liveEdges(graph).length).toBe(1); // spliced into one run
  });
});

describe("offset curves", () => {
  it("places every point of both curves exactly the offset distance from a straight centreline", () => {
    const centre = [
      { x: 10, y: 50 },
      { x: 100, y: 50 },
    ];
    const radius = 4;
    const { left, right } = offsetCurves(centre, {
      radius,
      join: "miter",
      miterLimit: 3,
      cap: "butt",
      arcTolerance: 0.05,
    });

    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    for (const p of left) expect(p.y).toBeCloseTo(50 + radius, 9);
    for (const p of right) expect(p.y).toBeCloseTo(50 - radius, 9);
  });

  it("miters the outer side of a turn to where the two offset lines meet", () => {
    const radius = 4;
    // A square corner: the outer offset lines cross a further radius/cos(45)
    // out along the bisector, so the miter point is radius * sqrt(2) away.
    const { left, right } = offsetCurves(
      [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 50 },
      ],
      { radius, join: "miter", miterLimit: 3, cap: "butt", arcTolerance: 0.05 },
    );

    const corner = { x: 50, y: 10 };
    const distances = [...left, ...right].map((p) => Math.hypot(p.x - corner.x, p.y - corner.y));
    const outermost = Math.max(...distances.filter((d) => d < radius * 3));
    expect(outermost).toBeCloseTo(radius * Math.SQRT2, 6);
  });

  it("falls back to a bevel rather than throwing a spike past the miter limit", () => {
    const radius = 4;
    const centre = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 0, y: 10 },
    ];
    const vertex = centre[1];

    // How far the outline reaches past the vertex, along the outward
    // bisector of the turn -- which is exactly the direction a miter spike
    // would run in, and the one direction the far ends of the arms do not
    // contribute to.
    const unit = (x: number, y: number) => {
      const l = Math.hypot(x, y);
      return { x: x / l, y: y / l };
    };
    const d1 = unit(centre[1].x - centre[0].x, centre[1].y - centre[0].y);
    const d2 = unit(centre[2].x - centre[1].x, centre[2].y - centre[1].y);
    const outward = d1.x * d2.y - d1.y * d2.x >= 0 ? -1 : 1;
    const n1 = { x: outward * -d1.y, y: outward * d1.x };
    const n2 = { x: outward * -d2.y, y: outward * d2.x };
    const bisector = unit(n1.x + n2.x, n1.y + n2.y);

    const reachAlongBisector = (limit: number): number => {
      const { left, right } = offsetCurves(centre, {
        radius,
        join: "miter",
        miterLimit: limit,
        cap: "butt",
        arcTolerance: 0.05,
      });
      return Math.max(
        ...[...left, ...right].map((p) => (p.x - vertex.x) * bisector.x + (p.y - vertex.y) * bisector.y),
      );
    };

    // Generous limit: the miter is allowed, and reaches well past the offset.
    expect(reachAlongBisector(40)).toBeGreaterThan(radius * 4);
    // Tight limit: bevelled instead, so nothing reaches past the offset itself.
    expect(reachAlongBisector(2)).toBeLessThanOrEqual(radius + 1e-6);
  });

  it("closes the ribbon around a straight centreline with the expected area", () => {
    const outline = strokeOutline(
      [
        { x: 10, y: 20 },
        { x: 60, y: 20 },
      ],
      { radius: 3, join: "miter", miterLimit: 3, cap: "butt", arcTolerance: 0.05 },
    );
    let area = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      area += a.x * b.y - b.x * a.y;
    }
    // 50 long, 6 wide.
    expect(Math.abs(area / 2)).toBeCloseTo(300, 4);
  });
});

describe("curve fitting", () => {
  it("fits a straight run as a single segment", () => {
    const pts = [];
    for (let i = 0; i <= 60; i++) pts.push({ x: 10 + i, y: 30 });
    expect(fitChain(pts, FIT).length).toBe(1);
  });

  it("does not double back on itself along a straight run", () => {
    // A straight run entered through a corner chamfer -- the shape that used
    // to make the tangent-constrained fit bisect until the curve zigzagged.
    const pts = [{ x: 9, y: 10 }];
    for (let i = 0; i <= 60; i++) pts.push({ x: 10, y: 11 + i });
    const flat = flattenBezierPath(fitChain(pts, FIT), 0.05);
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i].y).toBeGreaterThanOrEqual(flat[i - 1].y - 1e-6);
    }
  });
});

describe("runPipeline cut geometry", () => {
  const { ink, width, height, dividerCentreX } = twoPaneFixture(240, 160, 5);

  function run(params: Partial<typeof DEFAULT_PARAMS>) {
    const cache = new PipelineCache();
    cache.loadSource(inkToGray(ink), width, height, false);
    return runPipeline(cache, { ...DEFAULT_PARAMS, closeGaps: 0, despeckle: 0, ...params });
  }

  it("cuts the panel into its two panes", () => {
    const result = run({ mmPerPx: 1, offsetMm: 2 });
    expect(result.pieceCount).toBe(2);
  });

  it("puts the two cut lines equidistant from the centreline", () => {
    const offsetPx = 3;
    const result = run({ mmPerPx: 1, offsetMm: offsetPx });
    const midY = height / 2;

    const xs = result.cutPieces
      .flatMap((piece) => crossingsAtY(piece.outerFlat, midY))
      .sort((a, b) => a - b);
    // Four crossings across the panel: outer-left, divider-left,
    // divider-right, outer-right. The middle two straddle the divider.
    expect(xs.length).toBe(4);
    expect(dividerCentreX - xs[1]).toBeCloseTo(offsetPx, 2);
    expect(xs[2] - dividerCentreX).toBeCloseTo(offsetPx, 2);
    expect(xs[2] - xs[1]).toBeCloseTo(offsetPx * 2, 2);
  });

  /**
   * The point of doing the offset in physical units: the same drawing output
   * at two different finished sizes must leave the same physical gap between
   * neighbouring pieces. Offsetting is not a linear operation, so this only
   * holds because the offset is recomputed in pixels for each size -- it is
   * not something scaling an exported file could achieve.
   */
  it("holds the gap at a constant physical width across finished sizes", () => {
    const offsetMm = 0.4;
    const midY = height / 2;

    const gapMmAt = (finishedWidthInches: number): number => {
      const mmPerPx = (finishedWidthInches * 25.4) / width;
      const result = run({ mmPerPx, offsetMm, minPieceAreaMm2: 0 });
      const xs = result.cutPieces
        .flatMap((piece) => crossingsAtY(piece.outerFlat, midY))
        .sort((a, b) => a - b);
      expect(xs.length).toBe(4);
      return (xs[2] - xs[1]) * mmPerPx;
    };

    const small = gapMmAt(12);
    const large = gapMmAt(30);
    expect(small).toBeCloseTo(offsetMm * 2, 2);
    expect(large).toBeCloseTo(offsetMm * 2, 2);
  });

  it("emits one closed path per piece and no centreline layer", () => {
    const result = run({ mmPerPx: 1, offsetMm: 2 });
    const paths = result.svg.svg.match(/<path/g) ?? [];
    expect(paths.length).toBe(result.pieceCount);
    expect(result.svg.svg).not.toContain("centreline");
    // Every path closes.
    for (const d of result.svg.svg.matchAll(/ d="([^"]+)"/g)) {
      expect(d[1].trim().endsWith("Z")).toBe(true);
    }
  });
});

/**
 * The polygon that comes out of the boolean op is the offset, to within the
 * flattening tolerance. Re-fitting it to cubics is only ever an attempt to
 * say the same thing more smoothly, so the fitted outline must not wander
 * off it -- that would mean cutting the piece to a different shape than the
 * offset the artist asked for.
 */
describe("fitted cut paths track the exact offset", () => {
  /** A panel with curved lines, junctions, holes and one very acute corner. */
  function curvedFixture(width: number, height: number) {
    const gray = new Float32Array(width * height).fill(255);
    const stamp = (x: number, y: number, halfWidth: number) => {
      for (let py = Math.floor(y - halfWidth - 1); py <= Math.ceil(y + halfWidth + 1); py++) {
        for (let px = Math.floor(x - halfWidth - 1); px <= Math.ceil(x + halfWidth + 1); px++) {
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
          const value = 255 * (1 - Math.max(0, Math.min(1, halfWidth + 0.5 - d)));
          if (value < gray[py * width + px]) gray[py * width + px] = value;
        }
      }
    };
    const line = (x0: number, y0: number, x1: number, y1: number, hw: number) => {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 3);
      for (let i = 0; i <= steps; i++) stamp(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, hw);
    };
    const circle = (cx: number, cy: number, r: number, hw: number) => {
      const steps = Math.ceil(2 * Math.PI * r * 3);
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        stamp(cx + Math.cos(a) * r, cy + Math.sin(a) * r, hw);
      }
    };

    const margin = 25;
    line(margin, margin, width - margin, margin, 3);
    line(width - margin, margin, width - margin, height - margin, 3);
    line(width - margin, height - margin, margin, height - margin, 3);
    line(margin, height - margin, margin, margin, 3);
    circle(width / 2, height / 2, Math.min(width, height) * 0.3, 2);
    circle(width / 2, height / 2, Math.min(width, height) * 0.13, 2);
    // Diagonals into the panel corners: a very acute junction where the
    // spoke meets the two border arms.
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const a = Math.atan2(dy, dx);
      const r = Math.min(width, height) * 0.3;
      line(width / 2 + Math.cos(a) * r, height / 2 + Math.sin(a) * r, width / 2 + dx * (width / 2 - margin), height / 2 + dy * (height / 2 - margin), 2);
    }
    return gray;
  }

  function distanceToPolygon(point: { x: number; y: number }, ring: { x: number; y: number }[]): number {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy;
      let t = lengthSq === 0 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
    }
    return best;
  }

  it("keeps every fitted ring within a fraction of a pixel of its offset polygon", () => {
    const width = 600;
    const height = 600;
    const cache = new PipelineCache();
    cache.loadSource(curvedFixture(width, height), width, height, false);
    const result = runPipeline(cache, {
      ...DEFAULT_PARAMS,
      mmPerPx: (20 * 25.4) / width,
      offsetMm: 1.2,
      pruneSpurMm: 3,
    });

    expect(result.pieceCount).toBeGreaterThan(5);

    let worst = 0;
    for (const piece of result.cutPieces) {
      for (const point of flattenBezierPath(piece.outer, 0.1)) {
        worst = Math.max(worst, distanceToPolygon(point, piece.outerFlat));
      }
    }
    expect(worst).toBeLessThan(1);
  });

  it("keeps the piece count and geometry stable when only the panel size changes", () => {
    const width = 600;
    const height = 600;
    const gray = curvedFixture(width, height);

    const countAt = (inches: number): number => {
      const cache = new PipelineCache();
      cache.loadSource(gray, width, height, false);
      return runPipeline(cache, {
        ...DEFAULT_PARAMS,
        mmPerPx: (inches * 25.4) / width,
        offsetMm: 0.4,
        pruneSpurMm: 3,
      }).pieceCount;
    };

    // The drawing has not changed, so neither should the set of pieces --
    // only the physical size of the gap between them.
    expect(countAt(12)).toBe(countAt(30));
  });
});
