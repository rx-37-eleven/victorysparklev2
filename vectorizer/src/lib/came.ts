// Stage 7 -- the two cut lines.
//
// Takes the fitted centreline network and produces the closed cut path for
// every glass piece, by stroking the centreline to a band of constant width
// and subtracting that band from the panel. The band's two sides *are* the
// two cut lines the drawing asks for: every point on them is exactly
// `halfGapPx` from the centreline, because that is what offsetting means.
//
// Deriving the cut lines this way rather than offsetting each piece's own
// traced outline inward (what the pipeline used to do) is what makes the
// constant-width promise hold. Two neighbouring pieces used to be offset
// independently from two independently-fitted copies of the same seam, so
// the gap between them was only as consistent as those two fits agreed. Here
// there is one centreline, one offset operation, and the gap is 2 *
// halfGapPx everywhere by construction.
//
// The band is built in pixel space from a half-gap that the caller has
// already converted out of millimetres using the panel's physical scale, so
// a panel set to 12in and the same panel set to 30in get *different* pixel
// offsets and the same physical one. Offsetting is not a linear operation --
// you cannot render at one size and scale the result -- which is why the
// physical size is an input here rather than a property of the export.

import { Clipper, FillRule, Path64, Paths64, Point64 } from "clipper2-js";
import { bezierPoint, detectCorners, fitCurve, splitIntoSpans, type BezierSeg, type FitChainParams } from "./curveFit";
import { flattenBezierPath, type FlatPoint } from "./offset";
import { strokeOutline, type CapStyle } from "./stroke";

const CLIPPER_SCALE = 1000;

export interface CutGeometryParams {
  /** Distance from the centreline to each cut line, in pixels. */
  halfGapPx: number;
  /** Cap on how far a miter may extend, as a multiple of halfGapPx. */
  miterLimit: number;
  /** How the band terminates at a line that dead-ends in open space. */
  endCap: CapStyle;
  widthPx: number;
  heightPx: number;
  /** Drop the piece that fills the margin outside the drawing's border line. */
  treatEdgeAsBorder: boolean;
  /** Pieces smaller than this are offcut slivers, not glass. */
  minPieceAreaPx2: number;
  fit: FitChainParams;
  /** Max deviation when flattening the fitted centreline for Clipper. */
  flattenTolerance: number;
}

export interface CutPiece {
  outer: BezierSeg[];
  holes: BezierSeg[][];
  areaPx2: number;
  /** Polygon form of the rings, kept for rasterization and area/centroid maths. */
  outerFlat: FlatPoint[];
  holesFlat: FlatPoint[][];
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

/**
 * Strokes the centreline network into the came band: the region within
 * `halfGapPx` of any centreline. Miter joins keep the drawing's sharp
 * corners sharp instead of rounding every junction off to the offset radius.
 */
export function buildCameBand(centrelines: BezierSeg[][], params: CutGeometryParams): Paths64 {
  // A hairline band would be lost to integer rounding; keep a floor well
  // under any real kerf so a zero setting still previews sensibly.
  const radius = Math.max(params.halfGapPx, 0.001);

  const ribbons = new Paths64();
  for (const segs of centrelines) {
    if (segs.length === 0) continue;
    const flat = flattenBezierPath(segs, params.flattenTolerance);
    if (flat.length < 2) continue;
    const outline = strokeOutline(flat, {
      radius,
      join: "miter",
      miterLimit: params.miterLimit,
      cap: params.endCap,
      // Arcs only show up on round joins and caps; matching the flattening
      // tolerance keeps them at the same fidelity as everything else.
      arcTolerance: params.flattenTolerance,
    });
    if (outline.length < 3) continue;
    ribbons.push(toPath64(outline));
  }
  if (ribbons.length === 0) return new Paths64();

  // Ribbons overlap each other at every junction, and each can self-overlap
  // where its centreline turns tighter than the offset radius. NonZero
  // resolves both to the region actually covered by the band.
  return Clipper.Union(ribbons, undefined, FillRule.NonZero);
}

/** Does this ring run along the image border? Those are margin offcuts, not glass. */
function touchesFrame(pts: FlatPoint[], widthPx: number, heightPx: number): boolean {
  const epsilon = 0.01;
  for (const p of pts) {
    if (p.x <= epsilon || p.y <= epsilon || p.x >= widthPx - epsilon || p.y >= heightPx - epsilon) return true;
  }
  return false;
}

/**
 * Splits long edges so no two consecutive points are further apart than
 * `maxSpacing`, without moving any existing point.
 *
 * Schneider's fit only measures its error *at the input points*. That is
 * fine for a dense lattice polyline, where the points are a pixel apart, but
 * an offset ring has wildly mixed density: an arc contributes a point every
 * pixel or two while a straight run contributes exactly two, tens of pixels
 * apart. Between a sparse pair the fit is unconstrained and unmeasured, so
 * it can bow a long way off the true outline and still report itself
 * converged -- which is exactly how a cut path ended up 16px from the offset
 * it was meant to trace. Densifying first costs nothing geometrically (the
 * added points lie on the existing edges) and makes the error check mean
 * what it claims.
 */
function densify(pts: FlatPoint[], maxSpacing: number): FlatPoint[] {
  if (pts.length < 2 || maxSpacing <= 0) return pts;
  const out: FlatPoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(distance / maxSpacing);
    for (let k = 1; k < steps; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
    }
    out.push(b);
  }
  return out;
}

/** Distance from `point` to the nearest edge of `polyline`. */
function distanceToPolyline(point: FlatPoint, polyline: FlatPoint[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < polyline.length; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq === 0 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/** How far a run of cubics strays from the polyline it was fitted to. */
function fitDeviation(segs: BezierSeg[], polyline: FlatPoint[], samplesPerSeg = 12): number {
  let worst = 0;
  for (const seg of segs) {
    for (let i = 0; i <= samplesPerSeg; i++) {
      const d = distanceToPolyline(bezierPoint(seg, i / samplesPerSeg), polyline);
      if (d > worst) worst = d;
    }
  }
  return worst;
}

/** Straight cubics through consecutive points -- handles on the chord, so the curve is the chord. */
function polylineAsCubics(pts: FlatPoint[]): BezierSeg[] {
  const segs: BezierSeg[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[i];
    const p3 = pts[i + 1];
    segs.push({
      p0,
      p1: { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
      p2: { x: p0.x + (2 * (p3.x - p0.x)) / 3, y: p0.y + (2 * (p3.y - p0.y)) / 3 },
      p3,
    });
  }
  return segs;
}

/**
 * Re-fits a closed offset ring to cubics, span by span, keeping a fit only
 * where it provably tracks the ring it came from.
 *
 * Two things differ from the centreline fit. Corner support is one vertex:
 * the centreline is a dense lattice polyline where a corner has to be
 * measured across several pixels to see past the staircase, but an offset
 * ring's vertices are already the geometry, and a straight run contributes
 * exactly two of them -- looking several vertices either side reaches past
 * the corner and finds nothing, which leaves the whole ring as one span
 * fitted by two cubics that bulge far off the true outline. And there is no
 * pre-smoothing: smoothing belongs on the centreline, which is traced from
 * pixels and genuinely noisy, whereas this ring is exact geometry produced
 * by offsetting and smoothing it again would pull the cut line off the
 * constant width it was built to hold.
 *
 * The check afterwards is the important part. The polygon coming out of the
 * boolean op is already correct -- it is the offset, to within the
 * flattening tolerance -- so a fit is only ever an attempt to say the same
 * thing more smoothly. Schneider's fit is reliable on most spans and
 * occasionally is not: on a long thin sliver it can report itself converged
 * while sitting over a centimetre off the polyline it was handed. Measuring
 * the fitted curve against its own source and falling back to the exact
 * polyline when it strays keeps that from ever reaching the cut file. The
 * cost of a fallback is a faceted span, which is what the old pipeline
 * emitted for *every* span; the benefit is that a piece can never be cut to
 * the wrong shape.
 */
function refitRing(ring: FlatPoint[], params: FitChainParams): BezierSeg[] {
  // fitCurve works on an open polyline, so close the ring by repeating the
  // first point. The seam then lands on a real vertex rather than mid-curve.
  const closed = [...ring, { x: ring[0].x, y: ring[0].y }];
  const spans = splitIntoSpans(closed, detectCorners(closed, params.cornerAngleDeg, 1));

  // Allow a little more than the fit's own target before rejecting, since
  // maxError is what the fit aims at, not a bound it guarantees.
  const acceptable = Math.max(params.maxError * 1.5, 0.1);

  const out: BezierSeg[] = [];
  for (const span of spans) {
    if (span.length < 2) continue;
    if (span.length === 2) {
      out.push(...polylineAsCubics(span));
      continue;
    }

    // Fit the densified span so the error check has something to bite on
    // between the sparse vertices of a straight run.
    const dense = densify(span, Math.max(params.maxError * 2, 1));
    const fitted = fitCurve(dense, params.maxError);
    if (fitted.length === 0) {
      out.push(...polylineAsCubics(span));
      continue;
    }
    // Pin the ends to the ring's own vertices so consecutive spans stay
    // joined and the ring stays closed.
    fitted[0].p0 = { x: span[0].x, y: span[0].y };
    fitted[fitted.length - 1].p3 = { x: span[span.length - 1].x, y: span[span.length - 1].y };

    out.push(...(fitDeviation(fitted, dense) <= acceptable ? fitted : polylineAsCubics(span)));
  }

  return out;
}

/** Drops the repeated vertices Clipper emits, which would wreck tangent estimation in the re-fit. */
function dedupe(pts: FlatPoint[]): FlatPoint[] {
  const out: FlatPoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) out.pop();
    else break;
  }
  return out;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(pts: FlatPoint[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;
}

/** Crossing-number test. Rings here are separated by the came band, so no point lands on an edge. */
function pointInRing(point: FlatPoint, ring: FlatPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Majority vote over a few vertices, so one coincident point cannot flip the answer. */
function ringInsideRing(inner: FlatPoint[], outer: FlatPoint[]): boolean {
  const samples = [0, Math.floor(inner.length / 3), Math.floor((2 * inner.length) / 3)];
  let votes = 0;
  for (const index of samples) {
    if (pointInRing(inner[index], outer)) votes++;
  }
  return votes >= 2;
}

interface RawRing {
  pts: FlatPoint[];
  area: number;
  absArea: number;
  bounds: Bounds;
  parent: number;
  depth: number;
}

/**
 * Works out which rings are pieces and which are holes inside them.
 *
 * clipper2-js 1.2.4 ships a broken `executePolyTree` -- it returns false and
 * leaves the tree empty -- so the nesting that would normally come free from
 * the PolyTree is reconstructed here from the flat path list. Depth counts
 * how many rings enclose a given ring: even depth is a piece, odd depth is a
 * hole in the piece that immediately encloses it, and a ring at depth 2 is an
 * island sitting inside a hole, which is a piece in its own right.
 */
function nestRings(rings: RawRing[]): void {
  for (let i = 0; i < rings.length; i++) {
    let best = -1;
    let bestArea = Infinity;
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue;
      if (rings[j].absArea <= rings[i].absArea) continue;
      if (!boundsContain(rings[j].bounds, rings[i].bounds)) continue;
      if (!ringInsideRing(rings[i].pts, rings[j].pts)) continue;
      if (rings[j].absArea < bestArea) {
        bestArea = rings[j].absArea;
        best = j;
      }
    }
    rings[i].parent = best;
  }

  for (let i = 0; i < rings.length; i++) {
    let depth = 0;
    let cursor = rings[i].parent;
    for (let guard = 0; guard < rings.length && cursor !== -1; guard++) {
      depth++;
      cursor = rings[cursor].parent;
    }
    rings[i].depth = depth;
  }
}

/**
 * Builds every glass piece's closed cut path from the fitted centreline
 * network.
 *
 * The panel is the whole image rectangle minus the came band. When the
 * drawing has an outer border line, the leftover margin outside it comes
 * back as one more region; `treatEdgeAsBorder` drops it, which is what makes
 * the outermost pieces stop at the border line's inner cut line.
 */
export function buildCutPieces(centrelines: BezierSeg[][], params: CutGeometryParams): CutPiece[] {
  const band = buildCameBand(centrelines, params);
  if (band.length === 0) return [];

  const panel = new Paths64();
  panel.push(
    toPath64([
      { x: 0, y: 0 },
      { x: params.widthPx, y: 0 },
      { x: params.widthPx, y: params.heightPx },
      { x: 0, y: params.heightPx },
    ]),
  );

  const solution = Clipper.Difference(panel, band, FillRule.NonZero);

  const rings: RawRing[] = [];
  for (const path of solution) {
    const pts = dedupe(fromPath64(path));
    if (pts.length < 3) continue;
    const area = signedArea(pts);
    const absArea = Math.abs(area);
    // Offsetting a curve leaves occasional zero-area slivers where two
    // offset edges meet exactly; they are not regions.
    if (absArea < 1e-6) continue;
    rings.push({ pts, area, absArea, bounds: boundsOf(pts), parent: -1, depth: 0 });
  }
  if (rings.length === 0) return [];

  nestRings(rings);

  const pieces: CutPiece[] = [];
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    if (ring.depth % 2 !== 0) continue; // a hole, not a piece

    const holeRings = rings.filter((candidate, index) => index !== i && candidate.parent === i && candidate.depth % 2 === 1);
    const areaPx2 = ring.absArea - holeRings.reduce((sum, hole) => sum + hole.absArea, 0);

    if (areaPx2 < params.minPieceAreaPx2) continue;
    if (params.treatEdgeAsBorder && touchesFrame(ring.pts, params.widthPx, params.heightPx)) continue;

    pieces.push({
      outer: refitRing(ring.pts, params.fit),
      holes: holeRings.map((hole) => refitRing(hole.pts, params.fit)),
      areaPx2,
      outerFlat: ring.pts,
      holesFlat: holeRings.map((hole) => hole.pts),
    });
  }

  return pieces;
}
