// Stage 3 — label the pieces, and Stage 4 — claim the ink (watershed to the
// medial axis). Combined here because small-region merge sits between them
// and is implemented in terms of the same watershed machinery (see below).

import { labelComponents } from "./ccl";
import { nearestLabeledSite } from "./edt";

export interface PiecesParams {
  treatEdgeAsBorder: boolean;
  minRegionPx: number;
}

export interface PiecesResult {
  /** -1 = background/outside the panel, 1..pieceCount = a glass piece. Every pixel has a label. */
  labels: Int32Array;
  pieceCount: number;
  /** Squared distance to the nearest non-ink pixel at watershed time. Kept for Stage 8 warnings. */
  distSq: Float64Array;
}

export function computePieces(
  ink: Uint8Array,
  width: number,
  height: number,
  params: PiecesParams,
): PiecesResult {
  const n = width * height;
  const glass = new Uint8Array(n);
  for (let i = 0; i < n; i++) glass[i] = ink[i] ? 0 : 1;

  const ccl = labelComponents(glass, width, height, 4);
  const labels = new Int32Array(n);
  labels.set(ccl.labels); // ink pixels are 0 (unlabeled), glass pixels are 1..K

  if (params.treatEdgeAsBorder) {
    const borderLabels = new Set<number>();
    for (let x = 0; x < width; x++) {
      const top = labels[x];
      const bottom = labels[(height - 1) * width + x];
      if (top > 0) borderLabels.add(top);
      if (bottom > 0) borderLabels.add(bottom);
    }
    for (let y = 0; y < height; y++) {
      const left = labels[y * width];
      const right = labels[y * width + width - 1];
      if (left > 0) borderLabels.add(left);
      if (right > 0) borderLabels.add(right);
    }
    if (borderLabels.size > 0) {
      for (let i = 0; i < n; i++) {
        if (labels[i] > 0 && borderLabels.has(labels[i])) labels[i] = -1;
      }
    }
  }

  // Small region merge: components below minRegionPx are noise from line
  // junctions. Rather than picking a single "largest neighbor" for the whole
  // speck, mark them unclaimed (like ink) so the watershed below reassigns
  // every one of their pixels to whichever surviving region is nearest --
  // strictly more watertight than a single per-speck merge target, and it's
  // the same mechanism Stage 4 already needs.
  if (params.minRegionPx > 0) {
    for (let i = 0; i < n; i++) {
      const label = labels[i];
      if (label > 0 && ccl.areas[label] < params.minRegionPx) labels[i] = 0;
    }
  }

  const isSite = new Uint8Array(n);
  for (let i = 0; i < n; i++) isSite[i] = labels[i] !== 0 ? 1 : 0;
  const { distSq, nearestLabel } = nearestLabeledSite(labels, isSite, width, height);

  const final = new Int32Array(n);
  for (let i = 0; i < n; i++) final[i] = isSite[i] ? labels[i] : nearestLabel[i];

  // Compact surviving positive labels to a dense 1..pieceCount range (border
  // exclusion and small-region merge can both leave gaps in the id space).
  const remap = new Map<number, number>();
  let pieceCount = 0;
  for (let i = 0; i < n; i++) {
    const label = final[i];
    if (label <= 0) continue;
    let compact = remap.get(label);
    if (compact === undefined) {
      compact = ++pieceCount;
      remap.set(label, compact);
    }
    final[i] = compact;
  }

  return { labels: final, pieceCount, distSq };
}
