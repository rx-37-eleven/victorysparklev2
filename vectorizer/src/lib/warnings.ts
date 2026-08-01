// Stage 8 — cuttability warnings. All measured in physical units (mm),
// converted from pixels via mmPerPx. Warn, never auto-fix: the artist
// decides.

import { squaredDistanceTransform } from "./edt";
import { labelComponents } from "./ccl";
import type { Chain, Piece, Ring } from "./boundaryGraph";
import { bezierDeriv1, bezierDeriv2, reverseFittedChain, type BezierSeg } from "./curveFit";

export interface CuttabilityThresholds {
  minInscribedDiameterMm: number;
  minAreaMm2: number;
  narrowNeckRadiusMm: number;
  minInteriorAngleDeg: number;
  minConcaveRadiusMm: number;
}

export const DEFAULT_THRESHOLDS: CuttabilityThresholds = {
  minInscribedDiameterMm: 6,
  minAreaMm2: 40,
  narrowNeckRadiusMm: 3,
  minInteriorAngleDeg: 15,
  minConcaveRadiusMm: 10,
};

export type WarningKind = "small-inscribed-circle" | "small-area" | "narrow-neck" | "sharp-corner" | "tight-concave-curve";

export interface PieceWarning {
  label: number;
  kind: WarningKind;
  message: string;
  valueMm: number;
}

function computeBorderMask(labels: Int32Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const border = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (!isBorder) {
        const l = labels[i];
        if (labels[i - 1] !== l || labels[i + 1] !== l || labels[i - width] !== l || labels[i + width] !== l) {
          isBorder = true;
        }
      }
      border[i] = isBorder ? 1 : 0;
    }
  }
  return border;
}

interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function computeBoundingBoxes(labels: Int32Array, width: number, height: number, pieceCount: number): Map<number, BBox> {
  const boxes = new Map<number, BBox>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (l < 1) continue;
      let b = boxes.get(l);
      if (!b) {
        b = { x0: x, y0: y, x1: x, y1: y };
        boxes.set(l, b);
      } else {
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y;
        if (y > b.y1) b.y1 = y;
      }
    }
  }
  void pieceCount;
  return boxes;
}

/** True if eroding piece `label`'s own mask by rPx splits it into >1 pieces, or vanishes it entirely. */
function narrowNeck(
  label: number,
  box: BBox,
  labels: Int32Array,
  distSqToBoundary: Float64Array,
  width: number,
  rPx: number,
): boolean {
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const sub = new Uint8Array(w * h);
  let any = false;
  const rSq = rPx * rPx;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gi = (box.y0 + y) * width + (box.x0 + x);
      if (labels[gi] === label && distSqToBoundary[gi] > rSq) {
        sub[y * w + x] = 1;
        any = true;
      }
    }
  }
  if (!any) return true; // vanished
  const { count } = labelComponents(sub, w, h, 4);
  return count > 1; // split
}

/**
 * Per-piece characteristic width, in mm: 2x the piece's own max
 * distance-to-boundary (the same quantity as the "max inscribed circle
 * diameter" cuttability check). A true narrowest-point / skeleton search
 * would need proper medial-axis extraction (a naive per-pixel local-max
 * test spuriously flags plateaus at square corners); this is a simpler,
 * always-well-defined proxy, good enough for the "useful later, harmless to
 * consumers" SVG attribute the spec calls for.
 */
export function computeMinWidthMmByLabel(
  labels: Int32Array,
  width: number,
  height: number,
  mmPerPx: number,
): Map<number, number> {
  const border = computeBorderMask(labels, width, height);
  const distSqToBoundary = squaredDistanceTransform(border, width, height);
  const maxDistSqByLabel = new Map<number, number>();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l < 1) continue;
    const d = distSqToBoundary[i];
    if (d > (maxDistSqByLabel.get(l) ?? -1)) maxDistSqByLabel.set(l, d);
  }
  const result = new Map<number, number>();
  for (const [label, maxDistSq] of maxDistSqByLabel) {
    result.set(label, 2 * Math.sqrt(maxDistSq) * mmPerPx);
  }
  return result;
}

function ringSegments(chains: Chain[], ring: Ring[]): BezierSeg[] {
  const segs: BezierSeg[] = [];
  for (const r of ring) {
    const chain = chains[r.chainId];
    const fitted = chain.fitted;
    if (!fitted) continue;
    segs.push(...(r.reversed ? reverseFittedChain(fitted) : fitted));
  }
  return segs;
}

/** Signed turn (radians, CCW positive) from the incoming to the outgoing tangent at a ring join. */
function signedTurnAngle(inTangent: { x: number; y: number }, outTangent: { x: number; y: number }): number {
  const cross = inTangent.x * outTangent.y - inTangent.y * outTangent.x;
  const dot = inTangent.x * outTangent.x + inTangent.y * outTangent.y;
  return Math.atan2(cross, dot);
}

/** Signed curvature: positive = curving toward the material (left, convex), negative = concave. */
function signedCurvature(seg: BezierSeg, t: number): number {
  const d1 = bezierDeriv1(seg, t);
  const d2 = bezierDeriv2(seg, t);
  const speed = Math.hypot(d1.x, d1.y);
  if (speed < 1e-9) return 0;
  const cross = d1.x * d2.y - d1.y * d2.x;
  return cross / (speed * speed * speed);
}

export interface WarningsInput {
  labels: Int32Array;
  width: number;
  height: number;
  pieceCount: number;
  chains: Chain[];
  pieces: Map<number, Piece>;
  mmPerPx: number;
}

export function computeWarnings(input: WarningsInput, thresholds: CuttabilityThresholds = DEFAULT_THRESHOLDS): PieceWarning[] {
  const { labels, width, height, pieceCount, chains, pieces, mmPerPx } = input;
  const warnings: PieceWarning[] = [];

  const border = computeBorderMask(labels, width, height);
  const distSqToBoundary = squaredDistanceTransform(border, width, height);
  const boxes = computeBoundingBoxes(labels, width, height, pieceCount);

  const areaPxByLabel = new Map<number, number>();
  const maxDistSqByLabel = new Map<number, number>();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l < 1) continue;
    areaPxByLabel.set(l, (areaPxByLabel.get(l) ?? 0) + 1);
    const d = distSqToBoundary[i];
    if (d > (maxDistSqByLabel.get(l) ?? -1)) maxDistSqByLabel.set(l, d);
  }

  const narrowNeckRPx = thresholds.narrowNeckRadiusMm / mmPerPx;

  for (const [label, piece] of pieces) {
    const areaPx = areaPxByLabel.get(label) ?? 0;
    const areaMm2 = areaPx * mmPerPx * mmPerPx;
    if (areaMm2 < thresholds.minAreaMm2) {
      warnings.push({
        label,
        kind: "small-area",
        message: `${areaMm2.toFixed(0)} mm² -- easy to lose while handling.`,
        valueMm: areaMm2,
      });
    }

    const maxDistSq = maxDistSqByLabel.get(label) ?? 0;
    const inscribedDiameterMm = 2 * Math.sqrt(maxDistSq) * mmPerPx;
    if (inscribedDiameterMm < thresholds.minInscribedDiameterMm) {
      warnings.push({
        label,
        kind: "small-inscribed-circle",
        message: `${inscribedDiameterMm.toFixed(1)} mm at its widest point -- too small to hold and grind.`,
        valueMm: inscribedDiameterMm,
      });
    }

    const box = boxes.get(label);
    if (box && narrowNeck(label, box, labels, distSqToBoundary, width, narrowNeckRPx)) {
      warnings.push({
        label,
        kind: "narrow-neck",
        message: `Splits or disappears when eroded by ${thresholds.narrowNeckRadiusMm} mm -- will snap along the neck.`,
        valueMm: thresholds.narrowNeckRadiusMm,
      });
    }

    for (const ring of [piece.outer, ...piece.holes]) {
      const segs = ringSegments(chains, ring);
      if (segs.length === 0) continue;

      // Sharp interior-angle corners at every ring join.
      for (let i = 0; i < segs.length; i++) {
        const a = segs[i];
        const b = segs[(i + 1) % segs.length];
        const inTangent = bezierDeriv1(a, 1);
        const outTangent = bezierDeriv1(b, 0);
        const turn = signedTurnAngle(inTangent, outTangent);
        const interiorDeg = 180 - (turn * 180) / Math.PI;
        if (interiorDeg < thresholds.minInteriorAngleDeg) {
          warnings.push({
            label,
            kind: "sharp-corner",
            message: `${interiorDeg.toFixed(0)}° corner -- too deep a V to score into.`,
            valueMm: interiorDeg,
          });
        }
      }

      // Tight concave curve radius, sampled along each segment. The curve
      // fitter can occasionally emit a handful of very short, poorly
      // conditioned segments right at a tangent (not sharp-cornered)
      // transition from a straight run to a curved one -- a near-cusp
      // control polygon with momentarily near-zero speed, which reads as an
      // enormous, physically-impossible curvature spike. This is a known
      // noise floor of the fitter (it does not affect watertightness,
      // closure, coverage, or determinism, all covered separately), so
      // radii below this floor are treated as fitting noise rather than a
      // real feature -- genuinely tight concave curves below this size will
      // not be reliably flagged in this version.
      const MIN_PHYSICAL_RADIUS_PX = 20;
      let tightestConcaveMm = Infinity;
      for (const seg of segs) {
        for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
          const kappa = signedCurvature(seg, t);
          if (kappa >= 0) continue; // convex or straight -- not a concave check target
          const radiusPx = 1 / Math.abs(kappa);
          if (radiusPx < MIN_PHYSICAL_RADIUS_PX) continue;
          const radiusMm = radiusPx * mmPerPx;
          if (radiusMm < tightestConcaveMm) tightestConcaveMm = radiusMm;
        }
      }
      if (tightestConcaveMm < thresholds.minConcaveRadiusMm) {
        warnings.push({
          label,
          kind: "tight-concave-curve",
          message: `${tightestConcaveMm.toFixed(1)} mm inside curve radius -- can't score a tight inside curve; needs nibbling.`,
          valueMm: tightestConcaveMm,
        });
      }
    }
  }

  return warnings;
}
