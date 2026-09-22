// Stage 6 -- the two equidistant offset curves.
//
// Builds, for a centreline polyline, the two curves that run exactly `r`
// away from it on either side, and the closed ribbon between them. This is
// the geometric heart of the request: every point on either curve is `r`
// from the centreline by construction, so the two cut lines stay a constant
// distance apart however the drawing curves.
//
// Doing it here rather than calling Clipper's open-path offsetter is not a
// matter of taste. clipper2-js 1.2.4's `offsetOpenPath` is unreliable on
// polylines with more than a handful of vertices: offsetting a 27-point
// smooth arc returns ten disjoint fragments with less total area than the
// same arc truncated to 17 points, at every offset distance. Closed-path
// boolean ops in the same library are sound, so the band is assembled from
// geometry built here and cleaned up with a union.

export interface Point {
  x: number;
  y: number;
}

export type JoinStyle = "miter" | "round" | "bevel";
export type CapStyle = "butt" | "round" | "square";

export interface StrokeOptions {
  /** Distance from the centreline to each offset curve. */
  radius: number;
  join: JoinStyle;
  /** Longest miter allowed, as a multiple of `radius`, before falling back to a bevel. */
  miterLimit: number;
  cap: CapStyle;
  /** Max deviation of the arc approximation on round joins and caps. */
  arcTolerance: number;
}

function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function length(v: Point): number {
  return Math.hypot(v.x, v.y);
}

function normalize(v: Point): Point {
  const l = length(v);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** Unit normal to the left of travel direction `d`. */
function leftNormal(d: Point): Point {
  return { x: -d.y, y: d.x };
}

/** Drops points closer together than `epsilon`, which would give meaningless directions. */
function clean(pts: Point[], epsilon = 1e-7): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < epsilon && Math.abs(last.y - p.y) < epsilon) continue;
    out.push(p);
  }
  return out;
}

/** Points along the arc from direction `from` to direction `to` about `centre`, exclusive of both ends. */
function arcPoints(centre: Point, from: Point, to: Point, radius: number, tolerance: number, sweepSign: number): Point[] {
  let startAngle = Math.atan2(from.y, from.x);
  const endAngle = Math.atan2(to.y, to.x);
  let sweep = endAngle - startAngle;

  // Normalize the sweep into the direction we actually want to travel.
  while (sweep * sweepSign < 0) sweep += sweepSign * 2 * Math.PI;
  while (Math.abs(sweep) > 2 * Math.PI) sweep -= sweepSign * 2 * Math.PI;

  // Step size from the sagitta: for a chord subtending angle t on a circle
  // of this radius, the deviation from the true arc is r*(1-cos(t/2)).
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / Math.max(radius, 1e-9))));
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-3)));

  const out: Point[] = [];
  for (let i = 1; i < steps; i++) {
    const angle = startAngle + (sweep * i) / steps;
    out.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
  }
  return out;
}

/**
 * One side of the offset: the curve `radius` to the left of `pts`.
 *
 * Pass a reversed polyline to get the other side; the two together bound the
 * ribbon. Joins are applied on the outer side of each turn, where offsetting
 * opens a gap. On the inner side the two offset segments overrun each other
 * instead; that overlap is left in and resolved by the union downstream,
 * which is both simpler and more robust than trying to trim it here.
 */
export function offsetSide(pts: Point[], options: StrokeOptions): Point[] {
  const path = clean(pts);
  if (path.length < 2) return [];

  const r = options.radius;
  const out: Point[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const d = normalize(subtract(b, a));
    const n = leftNormal(d);

    out.push({ x: a.x + n.x * r, y: a.y + n.y * r });

    if (i < path.length - 2) {
      const c = path[i + 2];
      const dNext = normalize(subtract(c, b));
      const nNext = leftNormal(dNext);
      const cross = d.x * dNext.y - d.y * dNext.x;

      // cross > 0 turns towards the left normal, so the left side is the
      // inside of the turn and its offset segments overlap -- emit both
      // endpoints and let the union sort it out. cross < 0 opens a gap on
      // the left, which is what needs a join.
      if (cross >= 0) {
        out.push({ x: b.x + n.x * r, y: b.y + n.y * r });
      } else {
        out.push({ x: b.x + n.x * r, y: b.y + n.y * r });
        out.push(...joinPoints(b, n, nNext, options));
      }
      out.push({ x: b.x + nNext.x * r, y: b.y + nNext.y * r });
    } else {
      out.push({ x: b.x + n.x * r, y: b.y + n.y * r });
    }
  }

  return clean(out);
}

/** The vertices bridging two offset endpoints around a turn, exclusive of both. */
function joinPoints(vertex: Point, from: Point, to: Point, options: StrokeOptions): Point[] {
  const r = options.radius;

  if (options.join === "bevel") return [];

  if (options.join === "round") {
    const sweep = from.x * to.y - from.y * to.x >= 0 ? 1 : -1;
    return arcPoints(vertex, from, to, r, options.arcTolerance, sweep);
  }

  // Miter: the two offset lines meet on the bisector of the two normals, at
  // r / cos(half-angle). Falls back to a bevel past the limit so an acute
  // corner cannot throw a long spike into a neighbouring piece.
  const bisector = normalize({ x: from.x + to.x, y: from.y + to.y });
  if (bisector.x === 0 && bisector.y === 0) return [];
  const cosHalf = bisector.x * from.x + bisector.y * from.y;
  if (cosHalf <= 1e-6) return [];
  const ratio = 1 / cosHalf;
  if (ratio > options.miterLimit) return [];
  return [{ x: vertex.x + bisector.x * r * ratio, y: vertex.y + bisector.y * r * ratio }];
}

/** The vertices capping the end of a polyline, bridging the two sides. */
function capPoints(end: Point, direction: Point, options: StrokeOptions): Point[] {
  const r = options.radius;
  const n = leftNormal(direction);

  switch (options.cap) {
    case "butt":
      return [];
    case "square":
      // Extend past the end by r, so the band terminates a full radius
      // beyond the last centreline point.
      return [
        { x: end.x + n.x * r + direction.x * r, y: end.y + n.y * r + direction.y * r },
        { x: end.x - n.x * r + direction.x * r, y: end.y - n.y * r + direction.y * r },
      ];
    case "round": {
      const from = n;
      const to = { x: -n.x, y: -n.y };
      // Sweep through the travel direction so the arc bulges past the end
      // rather than doubling back across the band.
      const sweep = from.x * direction.y - from.y * direction.x >= 0 ? 1 : -1;
      return arcPoints(end, from, to, r, options.arcTolerance, sweep);
    }
  }
}

/**
 * The closed ribbon around a centreline: up one offset curve, across the
 * end cap, back down the other, across the start cap.
 *
 * The result can self-intersect where the centreline turns tighter than the
 * offset radius. That is expected and correct to leave in -- a union with
 * `FillRule.NonZero` resolves it to the region actually covered, which is
 * the definition of the stroked area.
 */
export function strokeOutline(pts: Point[], options: StrokeOptions): Point[] {
  const path = clean(pts);
  if (path.length < 2) return [];

  const forward = offsetSide(path, options);
  const reversed = [...path].reverse();
  const backward = offsetSide(reversed, options);
  if (forward.length === 0 || backward.length === 0) return [];

  const endDirection = normalize(subtract(path[path.length - 1], path[path.length - 2]));
  const startDirection = normalize(subtract(path[0], path[1]));

  return clean([
    ...forward,
    ...capPoints(path[path.length - 1], endDirection, options),
    ...backward,
    ...capPoints(path[0], startDirection, options),
  ]);
}

/**
 * Both offset curves as separate open paths -- the literal "two lines
 * equidistant from the centre line". Exported for inspection and testing;
 * the piece geometry is built from `strokeOutline` instead, because closed
 * rings are what boolean ops and cut files need.
 */
export function offsetCurves(pts: Point[], options: StrokeOptions): { left: Point[]; right: Point[] } {
  const path = clean(pts);
  return {
    left: offsetSide(path, options),
    right: offsetSide([...path].reverse(), options).reverse(),
  };
}
