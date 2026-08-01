// Stage 6 — simplify and fit Beziers.
//
// Per chain, exactly once: detect corners, split into smooth spans, pre-
// smooth each span (skipping near corners/nodes), then fit each span with
// Schneider's algorithm (Graphics Gems I, 1990): chord-length parameterize,
// least-squares solve for the two interior control points against estimated
// endpoint tangents, a few Newton-Raphson reparameterization passes, and
// recursive subdivision at the point of max error when the fit doesn't meet
// tolerance.

import type { Point, Chain } from "./boundaryGraph";

export interface Vec2 {
  x: number;
  y: number;
}

export interface BezierSeg {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}
function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}
function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}
function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}
function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- Corner detection & span splitting -------------------------------------

/**
 * Turn angle (radians) at each point, using vectors to points `support` px
 * away. Endpoints are always corners. A fixed-window turn-angle test flags a
 * whole neighborhood around a real corner (every index whose window straddles
 * the elbow sees an above-threshold turn), so candidates are collapsed via
 * non-maximum suppression: consecutive above-threshold runs keep only their
 * single sharpest point as the corner.
 */
export function detectCorners(pts: Point[], cornerAngleDeg: number, support: number): boolean[] {
  const n = pts.length;
  const isCorner = new Array(n).fill(false) as boolean[];
  if (n === 0) return isCorner;
  isCorner[0] = true;
  isCorner[n - 1] = true;
  const thresholdRad = (cornerAngleDeg * Math.PI) / 180;
  const k = Math.max(1, Math.round(support));

  const turn = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const iPrev = Math.max(0, i - k);
    const iNext = Math.min(n - 1, i + k);
    if (iPrev === i || iNext === i) continue;
    const v1 = normalize(sub(pts[i], pts[iPrev]));
    const v2 = normalize(sub(pts[iNext], pts[i]));
    if (len(v1) < 1e-9 || len(v2) < 1e-9) continue;
    const cosAngle = clamp(dot(v1, v2), -1, 1);
    turn[i] = Math.acos(cosAngle);
  }

  // Arc length (not index count) is what actually distinguishes "these
  // flagged points are all oversampled views of the same corner" from
  // "these are separate, distinct corners that happen to sit at adjacent
  // indices" -- e.g. a low-vertex-count polygon (a Clipper2 offset result
  // can have as few as 4 points for a square) can have two genuinely
  // different corners at consecutive indices, far apart in space. Only
  // merge a run while it stays within `support` px of its start.
  const arcLen = new Float64Array(n);
  for (let i = 1; i < n; i++) arcLen[i] = arcLen[i - 1] + len(sub(pts[i], pts[i - 1]));

  let runStart = -1;
  const closeRun = (end: number) => {
    let best = runStart;
    for (let j = runStart + 1; j < end; j++) if (turn[j] > turn[best]) best = j;
    isCorner[best] = true;
  };
  for (let i = 1; i < n; i++) {
    const above = i < n - 1 && turn[i] > thresholdRad;
    if (above) {
      if (runStart === -1) {
        runStart = i;
      } else if (arcLen[i] - arcLen[runStart] > k) {
        closeRun(i);
        runStart = i;
      }
    } else if (runStart !== -1) {
      closeRun(i);
      runStart = -1;
    }
  }
  return isCorner;
}

/** Splits at every corner index; chain endpoints are always span boundaries. Consecutive spans share their joint point. */
export function splitIntoSpans(pts: Point[], isCorner: boolean[]): Point[][] {
  const spans: Point[][] = [];
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (isCorner[i]) {
      spans.push(pts.slice(start, i + 1));
      start = i;
    }
  }
  if (start < pts.length - 1) spans.push(pts.slice(start));
  return spans;
}

// --- Pre-smoothing -----------------------------------------------------------

/**
 * Gaussian blur along arc length (lattice points are unit-step apart, so
 * index == arc length here). Skips the first/last 2 points of the span so
 * corners and node endpoints stay exactly pinned, and clamps its window to
 * the span's own points -- it never reads across a corner into a neighbor
 * span.
 */
export function preSmoothSpan(pts: Point[], sigma: number): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = pts.map((p) => ({ x: p.x, y: p.y }));
  if (sigma <= 0 || n < 5) return out;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-(k * k) / (2 * sigma * sigma)));

  for (let i = 2; i <= n - 3; i++) {
    let sx = 0;
    let sy = 0;
    let wsum = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = clamp(i + k, 0, n - 1);
      const w = kernel[k + radius];
      sx += pts[idx].x * w;
      sy += pts[idx].y * w;
      wsum += w;
    }
    out[i] = { x: sx / wsum, y: sy / wsum };
  }
  return out;
}

// --- Bezier basis ------------------------------------------------------------

function b0(t: number): number {
  const tmp = 1 - t;
  return tmp * tmp * tmp;
}
function b1(t: number): number {
  const tmp = 1 - t;
  return 3 * t * tmp * tmp;
}
function b2(t: number): number {
  const tmp = 1 - t;
  return 3 * t * t * tmp;
}
function b3(t: number): number {
  return t * t * t;
}

export function bezierPoint(seg: BezierSeg, t: number): Vec2 {
  const w0 = b0(t);
  const w1 = b1(t);
  const w2 = b2(t);
  const w3 = b3(t);
  return {
    x: w0 * seg.p0.x + w1 * seg.p1.x + w2 * seg.p2.x + w3 * seg.p3.x,
    y: w0 * seg.p0.y + w1 * seg.p1.y + w2 * seg.p2.y + w3 * seg.p3.y,
  };
}

export function bezierDeriv1(seg: BezierSeg, t: number): Vec2 {
  const tmp = 1 - t;
  return {
    x: 3 * tmp * tmp * (seg.p1.x - seg.p0.x) + 6 * tmp * t * (seg.p2.x - seg.p1.x) + 3 * t * t * (seg.p3.x - seg.p2.x),
    y: 3 * tmp * tmp * (seg.p1.y - seg.p0.y) + 6 * tmp * t * (seg.p2.y - seg.p1.y) + 3 * t * t * (seg.p3.y - seg.p2.y),
  };
}

export function bezierDeriv2(seg: BezierSeg, t: number): Vec2 {
  const tmp = 1 - t;
  return {
    x: 6 * tmp * (seg.p2.x - 2 * seg.p1.x + seg.p0.x) + 6 * t * (seg.p3.x - 2 * seg.p2.x + seg.p1.x),
    y: 6 * tmp * (seg.p2.y - 2 * seg.p1.y + seg.p0.y) + 6 * t * (seg.p3.y - 2 * seg.p2.y + seg.p1.y),
  };
}

// --- Schneider curve fitting --------------------------------------------------

function chordLengthParameterize(points: Vec2[]): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i++) u.push(u[u.length - 1] + len(sub(points[i], points[i - 1])));
  const total = u[u.length - 1];
  return total > 0 ? u.map((v) => v / total) : u.map((_v, i) => i / Math.max(1, points.length - 1));
}

function generateBezier(points: Vec2[], u: number[], tHat1: Vec2, tHat2: Vec2): BezierSeg {
  const first = points[0];
  const last = points[points.length - 1];
  const n = points.length;

  const A: [Vec2, Vec2][] = new Array(n);
  for (let i = 0; i < n; i++) {
    A[i] = [scale(tHat1, b1(u[i])), scale(tHat2, b2(u[i]))];
  }

  const C = [
    [0, 0],
    [0, 0],
  ];
  const X = [0, 0];
  for (let i = 0; i < n; i++) {
    C[0][0] += dot(A[i][0], A[i][0]);
    C[0][1] += dot(A[i][0], A[i][1]);
    C[1][0] = C[0][1];
    C[1][1] += dot(A[i][1], A[i][1]);
    const t = u[i];
    const tmp = sub(points[i], add(scale(first, b0(t) + b1(t)), scale(last, b2(t) + b3(t))));
    X[0] += dot(A[i][0], tmp);
    X[1] += dot(A[i][1], tmp);
  }

  const detC0C1 = C[0][0] * C[1][1] - C[1][0] * C[0][1];
  const detC0X = C[0][0] * X[1] - C[1][0] * X[0];
  const detXC1 = X[0] * C[1][1] - X[1] * C[0][1];

  const alphaL = detC0C1 === 0 ? 0 : detXC1 / detC0C1;
  const alphaR = detC0C1 === 0 ? 0 : detC0X / detC0C1;

  // Arc length (not just chord) is the robust reference for "reasonable"
  // handle length: a near-closed or S-shaped span can have a tiny chord
  // despite covering a lot of ground, and the chord-based epsilon below
  // would then barely constrain anything.
  let arcLength = 0;
  for (let i = 1; i < n; i++) arcLength += len(sub(points[i], points[i - 1]));
  const segLength = len(sub(first, last));
  const epsilon = 1.0e-6 * segLength;

  // Endpoint tangents estimated from just a couple of local points can be a
  // poor global descriptor of a span that sweeps back across itself (e.g. an
  // arc whose start and end both happen to be near-flat spots of a circle
  // despite curving ~180 degrees in between) -- the least-squares solve is
  // technically correct for the (bad) inputs it's given, but produces
  // handles many times longer than the data itself, ballooning the control
  // polygon far outside the span's own bounding region. Reject those and
  // fall back to the standard "chord/3" heuristic rather than trust a
  // numerically "valid" but geometrically nonsensical answer.
  const maxReasonableAlpha = Math.max(arcLength, segLength) * 2;
  const alphasReasonable =
    alphaL >= epsilon && alphaR >= epsilon && alphaL <= maxReasonableAlpha && alphaR <= maxReasonableAlpha;

  if (!alphasReasonable) {
    const dist = segLength / 3;
    return {
      p0: first,
      p1: add(first, scale(tHat1, dist)),
      p2: add(last, scale(tHat2, dist)),
      p3: last,
    };
  }

  return {
    p0: first,
    p1: add(first, scale(tHat1, alphaL)),
    p2: add(last, scale(tHat2, alphaR)),
    p3: last,
  };
}

function computeMaxError(points: Vec2[], seg: BezierSeg, u: number[]): { maxError: number; splitPoint: number } {
  let maxDist = 0;
  let splitPoint = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const p = bezierPoint(seg, u[i]);
    const d = sub(p, points[i]);
    const distSq = dot(d, d);
    if (distSq > maxDist) {
      maxDist = distSq;
      splitPoint = i;
    }
  }
  return { maxError: maxDist, splitPoint };
}

function newtonRaphsonRootFind(seg: BezierSeg, point: Vec2, u: number): number {
  const q = bezierPoint(seg, u);
  const qp = bezierDeriv1(seg, u);
  const qpp = bezierDeriv2(seg, u);
  const diff = sub(q, point);
  const numerator = dot(diff, qp);
  const denominator = dot(qp, qp) + dot(diff, qpp);
  if (denominator === 0) return u;
  return clamp(u - numerator / denominator, 0, 1);
}

function reparameterize(points: Vec2[], u: number[], seg: BezierSeg): number[] {
  return points.map((p, i) => newtonRaphsonRootFind(seg, p, u[i]));
}

function computeCenterTangent(points: Vec2[], center: number): Vec2 {
  const v1 = sub(points[center - 1], points[center]);
  const v2 = sub(points[center], points[center + 1]);
  return normalize({ x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 });
}

const MAX_RECURSION_DEPTH = 32;

function fitCubic(points: Vec2[], tHat1: Vec2, tHat2: Vec2, maxErrorSq: number, depth: number): BezierSeg[] {
  const n = points.length;
  if (n === 2) {
    const dist = len(sub(points[1], points[0])) / 3;
    return [
      {
        p0: points[0],
        p1: add(points[0], scale(tHat1, dist)),
        p2: add(points[1], scale(tHat2, dist)),
        p3: points[1],
      },
    ];
  }

  let u = chordLengthParameterize(points);
  let seg = generateBezier(points, u, tHat1, tHat2);
  let { maxError, splitPoint } = computeMaxError(points, seg, u);
  if (maxError < maxErrorSq) return [seg];

  if (maxError < maxErrorSq * 4) {
    for (let i = 0; i < 4; i++) {
      const uPrime = reparameterize(points, u, seg);
      const candidate = generateBezier(points, uPrime, tHat1, tHat2);
      const res = computeMaxError(points, candidate, uPrime);
      u = uPrime;
      seg = candidate;
      maxError = res.maxError;
      splitPoint = res.splitPoint;
      if (maxError < maxErrorSq) return [seg];
    }
  }

  if (depth >= MAX_RECURSION_DEPTH || splitPoint <= 0 || splitPoint >= n - 1) return [seg];

  const centerTangent = computeCenterTangent(points, splitPoint);
  const centerTangentReversed = scale(centerTangent, -1);
  const left = fitCubic(points.slice(0, splitPoint + 1), tHat1, centerTangentReversed, maxErrorSq, depth + 1);
  const right = fitCubic(points.slice(splitPoint), centerTangent, tHat2, maxErrorSq, depth + 1);
  return [...left, ...right];
}

export function fitCurve(points: Vec2[], maxError: number): BezierSeg[] {
  if (points.length < 2) return [];
  if (points.length === 2) {
    return fitCubic(points, normalize(sub(points[1], points[0])), normalize(sub(points[0], points[1])), maxError * maxError, 0);
  }
  const tHat1 = normalize(sub(points[1], points[0]));
  const tHat2 = normalize(sub(points[points.length - 2], points[points.length - 1]));
  return fitCubic(points, tHat1, tHat2, maxError * maxError, 0);
}

/** Averages tangent directions at internal (non-corner) subdivision joins so handles stay collinear (G1). */
function enforceG1AtInternalJoins(segs: BezierSeg[]): void {
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    const outTangent = sub(a.p3, a.p2);
    const inTangent = sub(b.p1, b.p0);
    const outLen = len(outTangent);
    const inLen = len(inTangent);
    const outDir = normalize(outTangent);
    const inDir = normalize(inTangent);
    // If the two independently-fit segments' own tangent directions already
    // disagree by more than ~60 degrees, one of them is likely a poorly
    // conditioned fit -- averaging into a single shared direction can then
    // point neither handle the way its own segment actually travels,
    // creating a cusp (near-zero curve speed) and a spurious huge curvature
    // reading. Leave both handles alone rather than "fix" them into a worse
    // shape; it costs G1 continuity at this one join, not correctness.
    if (dot(outDir, inDir) < 0.5) continue;
    const dir = normalize(add(outDir, inDir));
    if (len(dir) < 1e-9) continue;
    a.p2 = sub(a.p3, scale(dir, outLen));
    b.p1 = add(b.p0, scale(dir, inLen));
  }
}

export interface FitChainParams {
  cornerAngleDeg: number;
  cornerSupport: number;
  smoothingSigma: number;
  maxError: number;
}

/** A single cubic segment, reversed: swap endpoints and swap the two handles. */
export function reverseBezierSeg(seg: BezierSeg): BezierSeg {
  return { p0: seg.p3, p1: seg.p2, p2: seg.p1, p3: seg.p0 };
}

/** The reverse of a whole fitted chain: reverse segment order, and reverse each segment. */
export function reverseFittedChain(segs: BezierSeg[]): BezierSeg[] {
  return [...segs].reverse().map(reverseBezierSeg);
}

/**
 * Fits every chain's geometry exactly once, mutating `chain.fitted` in
 * place. Both pieces sharing a seam read the same array (one of them via
 * reverseFittedChain at render/export time) -- this is what keeps them
 * watertight: the shared edge is one piece of data, not two independent
 * fits that could diverge by a fraction of a pixel.
 */
export function fitAllChains(chains: Chain[], params: FitChainParams): void {
  for (const chain of chains) {
    chain.fitted = fitChain(chain.pts, params);
  }
}

/** Fits one chain's raw lattice polyline into one or more smooth spans of cubic Beziers, split at detected corners. */
export function fitChain(pts: Point[], params: FitChainParams): BezierSeg[] {
  const isCorner = detectCorners(pts, params.cornerAngleDeg, params.cornerSupport);
  const spans = splitIntoSpans(pts, isCorner);
  const all: BezierSeg[] = [];
  for (const span of spans) {
    // A span whose two ends are close together relative to how long the
    // span actually is has curled almost all the way back on itself -- a
    // fully closed loop with no real corner anywhere (e.g. an island piece
    // with a synthetic start node), or nearly one (corner detection's
    // lookahead window isn't wraparound-aware, so it can spuriously flag a
    // sliver near the seam and leave the *dominant* span's endpoints close
    // but not bit-identical). Schneider's tangent-constrained least squares
    // assumes an open arc between two genuinely distinct endpoints; handing
    // it a ~360-degree loop degrades to a near-zero effective chord and
    // blows up into dozens of degenerate micro-segments. Splitting such a
    // span at its midpoint first keeps every individual fit to at most
    // ~180 degrees, which is numerically well-behaved.
    let arcLen = 0;
    for (let i = 1; i < span.length; i++) arcLen += len(sub(span[i], span[i - 1]));
    const chordLen = len(sub(span[span.length - 1], span[0]));
    const isNearlyClosedLoop = span.length > 4 && chordLen < arcLen * 0.15;
    const subSpans = isNearlyClosedLoop
      ? [span.slice(0, Math.floor(span.length / 2) + 1), span.slice(Math.floor(span.length / 2))]
      : [span];

    const segs: BezierSeg[] = [];
    for (const sub of subSpans) {
      const smoothed = preSmoothSpan(sub, params.smoothingSigma);
      segs.push(...fitCurve(smoothed, params.maxError));
    }
    segs[0].p0 = { x: span[0].x, y: span[0].y };
    segs[segs.length - 1].p3 = { x: span[span.length - 1].x, y: span[span.length - 1].y };
    enforceG1AtInternalJoins(segs);
    all.push(...segs);
  }
  return all;
}
