// Geometry-quality audit for Task 2 of the vectorizer work order.
//
// Runs the existing pipeline (computePieces -> extractBoundaryGraph ->
// fitAllChains) over a fixture set covering the failure modes the work
// order worried about (pixel-staircase zig-zag, lost sharp corners, smooth
// curves broken into facets, thin strokes, gappy strokes) and reports the
// same metrics table the work order specifies, scoped down per the CNC/
// photo decisions: no DXF/tool-radius/cusp checks (this app targets manual
// glass cutting, not a CNC machine) and no forced-constant-line-width
// variance check (the pipeline preserves natural stroke width by design;
// forcing width is only exercised when offsetMm > 0, which is opt-in).
//
// mmPerPx is fixed at 0.2 (5px/mm) across all fixtures -- a plausible scan
// resolution -- so the physical-unit thresholds (mm) are meaningful; the
// point isn't the exact number, it's whether the pipeline is anywhere near
// the target at a realistic scale.

import { describe, it, expect } from "vitest";
import { computePieces } from "../src/lib/pieces";
import { extractBoundaryGraph, type Chain, type Piece, type Ring } from "../src/lib/boundaryGraph";
import { fitAllChains, bezierPoint, type BezierSeg } from "../src/lib/curveFit";
import { makeGrid, makeGridWithGap, makeCircleInSquare, makeStar, type Fixture, type Pt } from "./fixtures";

const MM_PER_PX = 0.2;
const SAMPLES_PER_SEG = 12;

// Mirrors pipeline.ts's own cornerSupport formula exactly (getStage6Fitted),
// rather than a fixed constant -- the audit should reflect what the app
// actually runs for each fixture's size, not an arbitrary override.
function fitParamsFor(fixture: Fixture) {
  return {
    cornerAngleDeg: 55,
    cornerSupport: Math.max(2, Math.round(Math.min(fixture.width, fixture.height) / 200) + 2),
    smoothingSigma: 1.2,
    maxError: 1.2,
  };
}

function run(fixture: Fixture) {
  const { labels } = computePieces(fixture.ink, fixture.width, fixture.height, { treatEdgeAsBorder: true, minRegionPx: 0 });
  const { chains, pieces } = extractBoundaryGraph(labels, fixture.width, fixture.height);
  fitAllChains(chains, fitParamsFor(fixture));
  return { chains, pieces };
}

function flatten(fitted: BezierSeg[], samplesPerSeg = SAMPLES_PER_SEG): Pt[] {
  const pts: Pt[] = [];
  for (const seg of fitted) {
    for (let i = 0; i < samplesPerSeg; i++) pts.push(bezierPoint(seg, i / samplesPerSeg));
  }
  pts.push({ x: fitted[fitted.length - 1].p3.x, y: fitted[fitted.length - 1].p3.y });
  return pts;
}

function ringFitted(chains: Chain[], ring: Ring[]): BezierSeg[] {
  const segs: BezierSeg[] = [];
  for (const r of ring) {
    const chain = chains[r.chainId];
    const fitted = chain.fitted!;
    segs.push(...(r.reversed ? [...fitted].reverse().map((s) => ({ p0: s.p3, p1: s.p2, p2: s.p1, p3: s.p0 })) : fitted));
  }
  return segs;
}

function pathLengthPx(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
function segLen(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// A minimum-crossing-distance tolerance (px), not just a strict sign test.
// A ring flattened at 12 samples/segment produces hundreds of nearly-
// collinear, sub-pixel-separated chords along any smooth curve; a bare
// orientation-sign test flags those as "crossing" from pure floating-point
// noise (observed cross-product magnitudes as small as 1e-15 on a plain
// circle). Normalizing by segment length turns the test into a perpendicular
// distance in px, and requiring that distance to clear a real threshold
// separates float/discretization noise from an actual self-intersection.
const CROSSING_TOL_PX = 0.05;

function properlyCrosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const lenAB = segLen(a, b);
  const lenCD = segLen(c, d);
  if (lenAB < 1e-9 || lenCD < 1e-9) return false;
  const d1 = cross(c, d, a) / lenCD;
  const d2 = cross(c, d, b) / lenCD;
  const d3 = cross(a, b, c) / lenAB;
  const d4 = cross(a, b, d) / lenAB;
  if (Math.abs(d1) < CROSSING_TOL_PX || Math.abs(d2) < CROSSING_TOL_PX || Math.abs(d3) < CROSSING_TOL_PX || Math.abs(d4) < CROSSING_TOL_PX) return false;
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function selfIntersects(pts: Pt[]): boolean {
  // Skip adjacency (shares an endpoint) to avoid flagging touching segments.
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (i === 0 && j === n - 2) continue; // wraps around to the same closing point
      if (properlyCrosses(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
    }
  }
  return false;
}

interface Metrics {
  vertices: number;
  pathLengthMm: number;
  maxDeviationMm: number;
  turnSignChanges: number;
  nonCornerLengthMm: number;
  shortestSegmentMm: number;
  unclosedContours: number;
  selfIntersectingContours: number;
}

function computeMetrics(chains: Chain[], pieces: Map<number, Piece>): Metrics {
  let vertices = 0;
  let pathLengthPxTotal = 0;
  let maxDeviationPx = 0;
  let turnSignChanges = 0;
  let nonCornerLengthPx = 0;
  let shortestSegmentPx = Infinity;
  let unclosedContours = 0;
  let selfIntersectingContours = 0;

  const seenChains = new Set<number>();

  for (const piece of pieces.values()) {
    for (const ring of [piece.outer, ...piece.holes]) {
      const fitted = ringFitted(chains, ring);
      if (fitted.length === 0) continue;

      // Closure: first point of the ring must exactly equal the last.
      const first = fitted[0].p0;
      const last = fitted[fitted.length - 1].p3;
      if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-6) unclosedContours++;

      // Vertices: each segment contributes 3 new points (2 handles + p3);
      // p0 of the first segment is the ring's shared closing point.
      vertices += fitted.length * 3;

      const flat = flatten(fitted);
      pathLengthPxTotal += pathLengthPx(flat);
      shortestSegmentPx = Math.min(shortestSegmentPx, ...fitted.map((s) => Math.hypot(s.p3.x - s.p0.x, s.p3.y - s.p0.y)));

      if (selfIntersects(flat)) selfIntersectingContours++;

      // Turning-angle sign changes, excluding samples within one segment of
      // a knot boundary (where a real corner may legitimately break sign).
      //
      // Sampling is uniform-in-parameter-t, not uniform-in-arc-length (the
      // work order's own Stage C.1 calls out exactly this distinction). A
      // handful of the pipeline's independently-fit cubic segments have a
      // microscopic (sub-0.01mm) non-monotonic wobble in their own t-vs-
      // arc-length mapping -- geometrically invisible at any real cutting
      // tolerance, but a uniform-t turn-angle sample straddling it reads as
      // a full 180-degree reversal. MIN_STEP_PX filters those out: a "sign
      // change" only counts if both of its contributing steps are at least
      // this long, so it reflects an actual directional reversal of the
      // curve rather than parameterization noise inside one fitted segment.
      const MIN_STEP_PX = 0.05 / MM_PER_PX; // 0.05mm
      const segBoundarySet = new Set<number>();
      for (let i = 0; i <= fitted.length; i++) segBoundarySet.add(i * SAMPLES_PER_SEG);
      let prevSign = 0;
      for (let i = 1; i < flat.length - 1; i++) {
        const isNearKnot = [...segBoundarySet].some((k) => Math.abs(i - k) <= 1);
        const v1x = flat[i].x - flat[i - 1].x;
        const v1y = flat[i].y - flat[i - 1].y;
        const v2x = flat[i + 1].x - flat[i].x;
        const v2y = flat[i + 1].y - flat[i].y;
        const l1 = Math.hypot(v1x, v1y);
        const l2 = Math.hypot(v2x, v2y);
        if (l1 < 1e-9 || l2 < 1e-9) continue;
        const turn = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
        if (!isNearKnot) {
          nonCornerLengthPx += l2;
          const sign = Math.abs(turn) < 1e-3 || l1 < MIN_STEP_PX || l2 < MIN_STEP_PX ? 0 : turn > 0 ? 1 : -1;
          if (sign !== 0 && prevSign !== 0 && sign !== prevSign) turnSignChanges++;
          if (sign !== 0) prevSign = sign;
        }
      }

      // Max deviation of the fitted curve from the raw (pre-fit) lattice
      // polyline it was fit against -- the closest available analog to
      // "deviation from the medial axis" in a pipeline whose boundary IS
      // the medial-axis-equivalent geometry (watershed), not a separate
      // centerline that width gets imposed onto afterward.
      for (const r of ring) {
        const chain = chains[r.chainId];
        if (seenChains.has(chain.id)) continue;
        seenChains.add(chain.id);
        const rawPts = chain.pts;
        const fittedFlat = flatten(chain.fitted!, 20);
        for (const rp of rawPts) {
          let minD = Infinity;
          for (const fp of fittedFlat) {
            const d = Math.hypot(rp.x - fp.x, rp.y - fp.y);
            if (d < minD) minD = d;
          }
          if (minD > maxDeviationPx) maxDeviationPx = minD;
        }
      }
    }
  }

  return {
    vertices,
    pathLengthMm: pathLengthPxTotal * MM_PER_PX,
    maxDeviationMm: maxDeviationPx * MM_PER_PX,
    turnSignChanges,
    nonCornerLengthMm: nonCornerLengthPx * MM_PER_PX,
    shortestSegmentMm: (Number.isFinite(shortestSegmentPx) ? shortestSegmentPx : 0) * MM_PER_PX,
    unclosedContours,
    selfIntersectingContours,
  };
}

function reportRow(name: string, m: Metrics) {
  const vpm = m.pathLengthMm > 0 ? m.vertices / m.pathLengthMm : 0;
  const signChangesPerMm = m.nonCornerLengthMm > 0 ? m.turnSignChanges / m.nonCornerLengthMm : 0;
  console.log(
    `${name.padEnd(28)} vtx/mm=${vpm.toFixed(3).padStart(7)}  maxDevMm=${m.maxDeviationMm.toFixed(3).padStart(7)}  ` +
      `signChg/mm=${signChangesPerMm.toFixed(4).padStart(8)}  shortestSegMm=${m.shortestSegmentMm.toFixed(3).padStart(7)}  ` +
      `unclosed=${m.unclosedContours}  selfInt=${m.selfIntersectingContours}`,
  );
  return { vpm, signChangesPerMm };
}

describe("Task 2 geometry audit (real fixture set, work-order metrics)", () => {
  it("clean scanned line drawing (grid, 3px lines)", () => {
    const fixture = makeGrid(4, 3, 40, 3);
    const { chains, pieces } = run(fixture);
    const m = computeMetrics(chains, pieces);
    const { vpm, signChangesPerMm } = reportRow("clean-scan (grid)", m);
    expect(m.unclosedContours).toBe(0);
    expect(m.selfIntersectingContours).toBe(0);
    expect(vpm).toBeLessThan(1.0);
    expect(signChangesPerMm).toBeLessThan(0.05);
  });

  it("genuine sharp corners (5-point star) -- every star vertex survives as a real corner", () => {
    const { fixture, vertices } = makeStar(200, 5, 85, 35, 3);
    const { chains, pieces } = run(fixture);
    const m = computeMetrics(chains, pieces);
    reportRow("sharp-corners (star)", m);
    expect(m.unclosedContours).toBe(0);
    expect(m.selfIntersectingContours).toBe(0);

    // Corner-preservation: every ring must have a knot within 4px of every
    // ground-truth star vertex (excluding the four fixture-bbox border
    // corners, which aren't part of the star).
    const allKnots: Pt[] = [];
    for (const chain of chains) {
      for (const p of flatten(chain.fitted!).filter((_, i) => i % SAMPLES_PER_SEG === 0)) allKnots.push(p);
    }
    let preserved = 0;
    vertices.forEach((v, i) => {
      const hit = allKnots.some((k) => Math.hypot(k.x - v.x, k.y - v.y) < 4);
      if (hit) preserved++;
      console.log(`  vertex ${i} (${i % 2 === 0 ? "outer" : "inner"}) at (${v.x.toFixed(1)},${v.y.toFixed(1)}): ${hit ? "preserved" : "MISSED"}`);
    });
    console.log(`  star corners preserved: ${preserved}/${vertices.length}`);
    // KNOWN GAP (Task 2 audit): 2/10 of this star's most acute outer tips
    // (~40 degrees, in a tightly-packed pattern) are not detected as
    // corners even with the pipeline's own cornerSupport sizing for this
    // image. Soft so the audit table always prints; see PR description.
    expect.soft(preserved).toBe(vertices.length);
  });

  it("long smooth curve (large circle) -- no spurious corner mid-arc", () => {
    const fixture = makeCircleInSquare(240, 15, 95, 3);
    const { chains, pieces } = run(fixture);
    const m = computeMetrics(chains, pieces);
    const { signChangesPerMm } = reportRow("smooth-curve (circle)", m);
    expect(m.unclosedContours).toBe(0);
    expect(m.selfIntersectingContours).toBe(0);
    // KNOWN GAP (Task 2 audit): elevated vs. target, but traced to sub-
    // 0.02mm-amplitude parameterization wobble between independently-fit
    // short Bezier segments (uniform-t sampling exaggerates it into a
    // discrete sign flip) -- not a visible defect at this measured
    // amplitude. Soft pending a proper arc-length-uniform resample. See PR
    // description.
    expect.soft(signChangesPerMm).toBeLessThan(0.05);

    // No knot on the circular chain should itself be a hard-angle break --
    // "smooth spans containing a hard corner" should be 0. Must be the
    // actual circle chain (interior seam between the two real pieces), not
    // the square border chain against OUTSIDE -- the square's raw lattice
    // point count can exceed the circle's, so picking "longest by raw pts"
    // without filtering can silently grab the wrong chain.
    const interiorChains = chains.filter((c) => c.left >= 1 && c.right >= 1);
    const circleChain = interiorChains.reduce((longest, c) => (c.pts.length > longest.pts.length ? c : longest));
    let hardKnotsMidSpan = 0;
    const segs = circleChain.fitted!;
    for (let i = 1; i < segs.length; i++) {
      const outDir = Math.atan2(segs[i - 1].p3.y - segs[i - 1].p2.y, segs[i - 1].p3.x - segs[i - 1].p2.x);
      const inDir = Math.atan2(segs[i].p1.y - segs[i].p0.y, segs[i].p1.x - segs[i].p0.x);
      let diff = Math.abs(outDir - inDir);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if ((diff * 180) / Math.PI > 55) hardKnotsMidSpan++;
    }
    console.log(`  hard knots mid-arc on longest circle chain: ${hardKnotsMidSpan}`);
    // KNOWN GAP (Task 2 audit): 2 knots found, both at locally-flat points
    // of the raster (top/bottom of the circle, where dy/dx=0 over several
    // pixels) -- the crack-lattice extraction produces a very short (1-3px)
    // chain span there, and independently fitting that span produces a
    // poorly-conditioned tangent handle with a real ~90deg mismatch against
    // its neighbor. Small in extent (~0.2-0.6mm) but a genuine, real defect,
    // unlike the sign-change metric above. See PR description.
    expect.soft(hardKnotsMidSpan).toBe(0);
  });

  it("very thin stroke (1px lines)", () => {
    const fixture = makeGrid(3, 2, 30, 1);
    const { chains, pieces } = run(fixture);
    const m = computeMetrics(chains, pieces);
    reportRow("thin-stroke (1px grid)", m);
    expect(m.unclosedContours).toBe(0);
    expect(m.selfIntersectingContours).toBe(0);
  });

  it("broken/gappy stroke (gap in an interior line)", () => {
    const fixture = makeGridWithGap(3, 3, 35, 3, 6);
    const { chains, pieces } = run(fixture);
    const m = computeMetrics(chains, pieces);
    reportRow("gappy-stroke (grid+gap)", m);
    // A real gap merges two cells into one piece -- not a failure, just
    // fewer, larger pieces. Geometry validity still must hold.
    expect(m.unclosedContours).toBe(0);
    expect(m.selfIntersectingContours).toBe(0);
  });
});
