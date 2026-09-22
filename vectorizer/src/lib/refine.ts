// Stage 5 -- subpixel re-centring of the centreline.
//
// Thinning can only ever place the centreline on whole pixels, so a line
// running at a shallow angle comes out as a staircase whose true centre
// wanders up to half a pixel either side of where the skeleton puts it. Fit
// a curve straight to that and the wobble is baked in; offset the result and
// it is amplified, because offsetting turns a small positional error into a
// visible bulge in both cut lines at once. That is the mechanism behind the
// jaggedness the old pipeline showed once any kerf was enabled.
//
// The fix is to recover the sub-pixel position from the source *grayscale*
// rather than the binarized mask. Anti-aliasing along the edge of a drawn
// line encodes where the edge really fell to a fraction of a pixel; walking
// out perpendicular to the line from each skeleton point and interpolating
// the threshold crossing on each side recovers both edges, and the true
// centre is their midpoint. This is the one place in the pipeline that reads
// the grayscale after binarization, and it is worth it.

import type { Point } from "./centerline";

export interface SubpixelOptions {
  /** Stage-0 grayscale, 0..255. */
  gray: Float32Array;
  width: number;
  height: number;
  /** Global threshold, or the per-pixel Sauvola map when adaptive is on. */
  threshold: Float32Array | number;
  invert: boolean;
  /**
   * Per-point cap on how far to search for the stroke edge, in px. Search
   * beyond the stroke's own half-width finds the *next* line over and
   * re-centres onto empty space, so this is normally derived from the
   * distance transform of the ink mask.
   */
  maxSearchPx: number;
  /** Step size along the normal. Smaller is slower and no more accurate than the interpolation. */
  stepPx?: number;
}

/**
 * Signed distance from "ink". Negative inside the stroke, positive outside,
 * zero at the edge -- so a sign change brackets the edge whichever way round
 * `invert` has put the image.
 */
function inkField(value: number, threshold: number, invert: boolean): number {
  return invert ? threshold - value : value - threshold;
}

function bilinear(gray: Float32Array, width: number, height: number, x: number, y: number): number {
  // Grayscale samples sit at pixel centres, so a sample at (x,y) in
  // pixel-centre coordinates interpolates between the four pixels around
  // (x-0.5, y-0.5) in pixel-index space.
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const cx0 = x0 < 0 ? 0 : x0 >= width ? width - 1 : x0;
  const cy0 = y0 < 0 ? 0 : y0 >= height ? height - 1 : y0;
  const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 >= width ? width - 1 : x0 + 1;
  const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 >= height ? height - 1 : y0 + 1;

  const g00 = gray[cy0 * width + cx0];
  const g10 = gray[cy0 * width + cx1];
  const g01 = gray[cy1 * width + cx0];
  const g11 = gray[cy1 * width + cx1];

  return g00 * (1 - tx) * (1 - ty) + g10 * tx * (1 - ty) + g01 * (1 - tx) * ty + g11 * tx * ty;
}

function thresholdAt(options: SubpixelOptions, x: number, y: number): number {
  if (typeof options.threshold === "number") return options.threshold;
  const px = Math.min(options.width - 1, Math.max(0, Math.round(x - 0.5)));
  const py = Math.min(options.height - 1, Math.max(0, Math.round(y - 0.5)));
  return options.threshold[py * options.width + px];
}

/**
 * Distance from `origin` along `+direction` to where the ink field crosses
 * zero, or -1 if no crossing is found inside `maxSearchPx`.
 */
function distanceToEdge(
  origin: Point,
  dirX: number,
  dirY: number,
  options: SubpixelOptions,
  maxSearchPx: number,
): number {
  const step = options.stepPx ?? 0.25;
  let previousT = 0;
  let previousF = inkField(
    bilinear(options.gray, options.width, options.height, origin.x, origin.y),
    thresholdAt(options, origin.x, origin.y),
    options.invert,
  );
  // The skeleton point should be inside the stroke. If it isn't -- a stray
  // pixel, or a threshold the user has since moved -- there is nothing
  // meaningful to centre between.
  if (previousF >= 0) return -1;

  for (let t = step; t <= maxSearchPx; t += step) {
    const x = origin.x + dirX * t;
    const y = origin.y + dirY * t;
    if (x < 0 || y < 0 || x >= options.width || y >= options.height) return -1;

    const f = inkField(bilinear(options.gray, options.width, options.height, x, y), thresholdAt(options, x, y), options.invert);
    if (f >= 0) {
      // Linear interpolation of the crossing between the last inside sample
      // and this outside one. This is where the sub-pixel precision actually
      // comes from: the anti-aliased ramp puts the zero somewhere between
      // two samples, not on either of them.
      const span = f - previousF;
      const frac = span === 0 ? 0 : -previousF / span;
      return previousT + step * frac;
    }
    previousT = t;
    previousF = f;
  }
  return -1;
}

/** Simple 1-2-1 pass over a scalar series, used to settle the shift amounts. */
function smoothSeries(values: number[], passes: number): void {
  for (let pass = 0; pass < passes; pass++) {
    const copy = [...values];
    for (let i = 1; i < values.length - 1; i++) {
      values[i] = (copy[i - 1] + 2 * copy[i] + copy[i + 1]) / 4;
    }
  }
}

/**
 * Re-centres an edge's polyline between the two sides of the drawn stroke.
 *
 * Endpoints are never moved: they sit on a junction node shared with other
 * edges, and moving one edge's copy would tear the graph open. The shift is
 * tapered to zero over the last few points at each end so the correction
 * fades out rather than kinking against the pinned endpoint.
 */
export function refinePolyline(pts: Point[], options: SubpixelOptions, maxSearchByPoint?: number[]): Point[] {
  if (pts.length < 3) return pts.map((p) => ({ x: p.x, y: p.y }));

  const shifts = new Array<number>(pts.length).fill(0);
  const normals: { x: number; y: number }[] = pts.map(() => ({ x: 0, y: 0 }));

  for (let i = 1; i < pts.length - 1; i++) {
    const previous = pts[i - 1];
    const next = pts[i + 1];
    const tx = next.x - previous.x;
    const ty = next.y - previous.y;
    const length = Math.hypot(tx, ty);
    if (length < 1e-9) continue;

    // Left normal of the tangent.
    const nx = -ty / length;
    const ny = tx / length;
    normals[i] = { x: nx, y: ny };

    const limit = maxSearchByPoint?.[i] ?? options.maxSearchPx;
    if (limit <= 0) continue;

    const positive = distanceToEdge(pts[i], nx, ny, options, limit);
    const negative = distanceToEdge(pts[i], -nx, -ny, options, limit);
    // Both edges have to be found for the midpoint to mean anything. Near a
    // junction one side opens into the other line and never crosses inside
    // the limit; leaving those points alone is the right answer.
    if (positive < 0 || negative < 0) continue;

    let shift = (positive - negative) / 2;
    const cap = limit / 2;
    if (shift > cap) shift = cap;
    if (shift < -cap) shift = -cap;
    shifts[i] = shift;
  }

  smoothSeries(shifts, 2);

  // Taper to zero at the pinned ends.
  const taper = Math.min(4, Math.floor(pts.length / 2));
  for (let i = 0; i < taper; i++) {
    const ramp = i / taper;
    shifts[i] *= ramp;
    shifts[pts.length - 1 - i] *= ramp;
  }

  return pts.map((p, i) => ({ x: p.x + normals[i].x * shifts[i], y: p.y + normals[i].y * shifts[i] }));
}
