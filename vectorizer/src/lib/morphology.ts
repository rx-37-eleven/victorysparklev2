// Stage 2 — gap closing (morphological closing with a disc structuring
// element) and despeckle. Closing is implemented via the exact Euclidean
// distance transform rather than an iterative disc-offset scan: dilation by
// radius r is exactly "within r of a foreground pixel", which is symmetric
// and therefore leaves the medial axis of a line unchanged — an asymmetric
// or square structuring element would shift it, which the spec forbids.

import { squaredDistanceTransform } from "./edt";
import { labelComponents } from "./ccl";

export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const distSq = squaredDistanceTransform(mask, width, height);
  const rSq = radius * radius;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = distSq[i] <= rSq ? 1 : 0;
  return out;
}

export function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const complement = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) complement[i] = mask[i] ? 0 : 1;
  const dilatedComplement = dilate(complement, width, height, radius);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = dilatedComplement[i] ? 0 : 1;
  return out;
}

/** Close gaps: dilate by r, then erode by r. */
export function morphologicalClose(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  return erode(dilate(mask, width, height, radius), width, height, radius);
}

/** Remove ink components smaller than minPx (scanner dust). 8-connected so diagonal specks merge. */
export function despeckle(ink: Uint8Array, width: number, height: number, minPx: number): Uint8Array {
  if (minPx <= 0) return ink.slice();
  const { labels, areas } = labelComponents(ink, width, height, 8);
  const out = ink.slice();
  for (let i = 0; i < out.length; i++) {
    const label = labels[i];
    if (label > 0 && areas[label] < minPx) out[i] = 0;
  }
  return out;
}
