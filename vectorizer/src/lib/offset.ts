// Stage 7 — kerf / grinding offset. Applied per piece, after fitting, before
// export. This intentionally breaks the shared-edge property: the gap it
// opens between pieces is where foil or came goes.

import { ClipperOffset, JoinType, EndType, Path64, Paths64, Point64 } from "clipper2-js";
import type { Piece, Chain, Ring } from "./boundaryGraph";
import { reverseFittedChain, type BezierSeg, type FitChainParams } from "./curveFit";

export interface FlatPoint {
  x: number;
  y: number;
}

// Clipper2 works in integer coordinates; this preserves sub-milli-pixel
// precision (matches the 3-decimal rounding used for SVG output).
const CLIPPER_SCALE = 1000;

function perpDistance(p: FlatPoint, a: FlatPoint, b: FlatPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
}

function lerp(a: FlatPoint, b: FlatPoint, t: number): FlatPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function subdivideCubic(seg: BezierSeg, t: number): [BezierSeg, BezierSeg] {
  const p01 = lerp(seg.p0, seg.p1, t);
  const p12 = lerp(seg.p1, seg.p2, t);
  const p23 = lerp(seg.p2, seg.p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p0123 = lerp(p012, p123, t);
  return [
    { p0: seg.p0, p1: p01, p2: p012, p3: p0123 },
    { p0: p0123, p1: p123, p2: p23, p3: seg.p3 },
  ];
}

/** Adaptive flattening: recursively subdivides until the control handles are within `tolerance` px of the chord. */
function flattenCubic(seg: BezierSeg, tolerance: number, out: FlatPoint[], depth = 0): void {
  const flatness = perpDistance(seg.p1, seg.p0, seg.p3) + perpDistance(seg.p2, seg.p0, seg.p3);
  if (flatness < tolerance || depth > 24) {
    out.push(seg.p3);
    return;
  }
  const [left, right] = subdivideCubic(seg, 0.5);
  flattenCubic(left, tolerance, out, depth + 1);
  flattenCubic(right, tolerance, out, depth + 1);
}

function ringSegments(chains: Chain[], ring: Ring[]): BezierSeg[] {
  const segs: BezierSeg[] = [];
  for (const r of ring) {
    const chain = chains[r.chainId];
    const fitted = chain.fitted;
    if (!fitted) throw new Error(`Chain ${chain.id} has not been fitted yet -- call fitAllChains first.`);
    segs.push(...(r.reversed ? reverseFittedChain(fitted) : fitted));
  }
  return segs;
}

/** Flattens a ring's fitted curve to a polygon at high resolution (spec default: max deviation 0.05px). */
export function flattenRing(chains: Chain[], ring: Ring[], tolerance = 0.05): FlatPoint[] {
  const segs = ringSegments(chains, ring);
  const out: FlatPoint[] = [];
  if (segs.length > 0) out.push(segs[0].p0);
  for (const seg of segs) flattenCubic(seg, tolerance, out);
  return out;
}

function toPath64(pts: FlatPoint[]): Path64 {
  const path = new Path64();
  for (const p of pts) path.push(new Point64(Math.round(p.x * CLIPPER_SCALE), Math.round(p.y * CLIPPER_SCALE)));
  return path;
}

function fromPath64(path: Path64): FlatPoint[] {
  return path.map((p) => ({ x: p.x / CLIPPER_SCALE, y: p.y / CLIPPER_SCALE }));
}

function signedArea(pts: FlatPoint[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}

/** Inward-offsets a set of rings (outer + holes together) by deltaPx, round joins. Negative delta = shrink. */
function clipperOffset(ringsFlat: FlatPoint[][], deltaPx: number): FlatPoint[][] {
  const offset = new ClipperOffset();
  const paths = new Paths64();
  for (const ring of ringsFlat) paths.push(toPath64(ring));
  offset.addPaths(paths, JoinType.Round, EndType.Polygon);
  const solution = new Paths64();
  offset.execute(-deltaPx * CLIPPER_SCALE, solution);
  return solution.map(fromPath64);
}

export type OffsetOutcome = "ok" | "vanished" | "split";

export interface OffsetPieceResult {
  label: number;
  outer: BezierSeg[];
  holes: BezierSeg[][];
  outcome: OffsetOutcome;
}

/**
 * Offsets one piece inward by deltaPx (kerf/came allowance) and re-fits the
 * result to Beziers. If the piece vanishes or splits under offset, per spec
 * it is emitted un-offset (using its original fitted geometry) rather than
 * silently dropped, and the caller is told via `outcome` so it can surface a
 * warning.
 */
export function offsetPiece(piece: Piece, chains: Chain[], deltaPx: number, fitParams: FitChainParams): OffsetPieceResult {
  if (deltaPx <= 0) {
    return {
      label: piece.label,
      outer: ringSegments(chains, piece.outer),
      holes: piece.holes.map((h) => ringSegments(chains, h)),
      outcome: "ok",
    };
  }

  // Flattening tolerance for the Clipper round-trip: a straight-looking
  // Bezier fit is never *exactly* collinear (Schneider's least-squares solve
  // leaves a sub-pixel bow even on dead-straight input), and chasing that at
  // an ultra-tight tolerance produces dozens of near-duplicate points along
  // what's visually a straight line for no benefit -- simplifyPolygon below
  // collapses them again anyway. Matching the tolerance to the pipeline's
  // own fit precision (maxError) keeps the flattened polygon at the
  // resolution the geometry actually has.
  const flattenTolerance = Math.max(0.05, fitParams.maxError * 0.25);
  const outerFlat = flattenRing(chains, piece.outer, flattenTolerance);
  const holesFlat = piece.holes.map((h) => flattenRing(chains, h, flattenTolerance));

  // Cheap, purely-geometric pre-check: a shape contained in a W x H bounding
  // box cannot survive erosion by more than min(W,H)/2 (some point along its
  // shorter axis is always within that distance of its own boundary).
  // Deciding the clear-cut "this definitely vanishes" case this way, rather
  // than always deferring to Clipper2's own result classification, sidesteps
  // an observed clipper2-js quirk where a fresh ClipperOffset instance can
  // occasionally return a different topology for the *same* extreme input
  // depending on unrelated prior calls in the same process -- a library
  // state issue, not something this pipeline's own inputs control.
  const xs = outerFlat.map((p) => p.x);
  const ys = outerFlat.map((p) => p.y);
  const bboxW = Math.max(...xs) - Math.min(...xs);
  const bboxH = Math.max(...ys) - Math.min(...ys);
  if (deltaPx >= Math.min(bboxW, bboxH) / 2) {
    return {
      label: piece.label,
      outer: ringSegments(chains, piece.outer),
      holes: piece.holes.map((h) => ringSegments(chains, h)),
      outcome: "vanished",
    };
  }

  const rawSolution = clipperOffset([outerFlat, ...holesFlat], deltaPx);

  // Offsetting a flattened polygon that's very slightly self-intersecting
  // (a handful of near-cusp fitting artifacts, see curveFit.ts) can produce
  // a scatter of near-zero-area sliver polygons alongside the real result.
  // Those are offsetting noise, not genuinely disjoint pieces -- filter by
  // a minimum area before deciding whether the piece actually split.
  const MIN_MEANINGFUL_AREA_PX2 = 1;
  const solution = rawSolution.filter((r) => Math.abs(signedArea(r)) >= MIN_MEANINGFUL_AREA_PX2);

  const outers = solution.filter((r) => signedArea(r) > 0);
  const holes = solution.filter((r) => signedArea(r) <= 0);

  if (solution.length === 0 || outers.length === 0) {
    return {
      label: piece.label,
      outer: ringSegments(chains, piece.outer),
      holes: piece.holes.map((h) => ringSegments(chains, h)),
      outcome: "vanished",
    };
  }
  if (outers.length > 1) {
    return {
      label: piece.label,
      outer: ringSegments(chains, piece.outer),
      holes: piece.holes.map((h) => ringSegments(chains, h)),
      outcome: "split",
    };
  }

  return {
    label: piece.label,
    outer: polylineAsBeziers(simplifyPolygon(outers[0])),
    holes: holes.map((h) => polylineAsBeziers(simplifyPolygon(h))),
    outcome: "ok",
  };
}

/**
 * Straight-line polygon output for offset geometry, per spec: "Re-fit the
 * offset polygon to Beziers... or emit as a polygon if re-fitting proves
 * unstable. Re-fitting is preferred; polyline output is an acceptable v1
 * fallback." In practice, re-fitting an offset polygon with Schneider's
 * algorithm (see curveFit.ts) is fragile in exactly the way the spec
 * anticipates -- a straight-looking Bezier fit is never perfectly
 * collinear, so flattening it for Clipper and then re-fitting the result
 * can round-trip imperceptible floating-point noise into a visibly wobbly
 * curve, especially for the more complex chains that include the panel's
 * outer border. A correct polygon beats a wrong curve, so this always
 * takes the polyline path rather than gambling on re-fitting per piece.
 */
function simplifyPolygon(pts: FlatPoint[], tolerance = 0.15): FlatPoint[] {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  simplifySegment(pts, 0, pts.length - 1, tolerance, keep);
  const out: FlatPoint[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function simplifySegment(pts: FlatPoint[], first: number, last: number, tolerance: number, keep: Uint8Array): void {
  if (last <= first + 1) return;
  let maxDist = 0;
  let splitAt = -1;
  for (let i = first + 1; i < last; i++) {
    const d = perpDistance(pts[i], pts[first], pts[last]);
    if (d > maxDist) {
      maxDist = d;
      splitAt = i;
    }
  }
  if (maxDist > tolerance && splitAt !== -1) {
    keep[splitAt] = 1;
    simplifySegment(pts, first, splitAt, tolerance, keep);
    simplifySegment(pts, splitAt, last, tolerance, keep);
  }
}

/** Straight "cubic" segments through consecutive polygon vertices -- a Bezier with the handles on the chord itself. */
function polylineAsBeziers(pts: FlatPoint[]): BezierSeg[] {
  const segs: BezierSeg[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p3 = pts[(i + 1) % pts.length];
    segs.push({ p0, p1: lerp(p0, p3, 1 / 3), p2: lerp(p0, p3, 2 / 3), p3 });
  }
  return segs;
}

