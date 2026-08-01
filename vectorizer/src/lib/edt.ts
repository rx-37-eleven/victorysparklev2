// Exact Euclidean distance transform, Felzenszwalb & Huttenlocher (2012):
// one-dimensional lower-envelope-of-parabolas pass down columns, then across
// rows. O(n) total. Chamfer/two-pass approximations are NOT used here because
// their anisotropy would visibly bend cut lines on diagonal strokes.

// Large-but-finite sentinel. Must stay far below Number.MAX_SAFE_INTEGER minus
// the largest possible squared distance so that `INF + q*q` never loses
// precision (float64 has 52 mantissa bits => exact integers up to 2^53).
const INF = 1e9;

// 1D squared distance transform of a sampled function f (Felzenszwalb &
// Huttenlocher, section 2). Returns, for every index q, the transformed value
// d[q] = min_p (q-p)^2 + f[p], and arg[q] = the winning p.
function transform1D(
  f: Float64Array,
  n: number,
  d: Float64Array,
  arg: Int32Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = 0;
    for (;;) {
      const vk = v[k];
      s = (f[q] + q * q - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
      if (s <= z[k]) {
        k--;
      } else {
        break;
      }
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const vk = v[k];
    d[q] = (q - vk) * (q - vk) + f[vk];
    arg[q] = vk;
  }
}

export interface NearestSiteField {
  distSq: Float64Array;
  nearestX: Int32Array;
  nearestY: Int32Array;
}

/**
 * For every pixel, finds the nearest pixel with siteHeight[i] < INF (a
 * "site"), via the two-pass separable EDT. siteHeight lets callers bias which
 * site wins an exact tie (see nearestLabeledSite) — pass all-zero heights for
 * plain unbiased distance.
 */
function nearestSite(isSite: Uint8Array, siteHeight: Float64Array, width: number, height: number): NearestSiteField {
  const df = new Float64Array(width * height);
  const argY = new Int32Array(width * height);

  {
    const f = new Float64Array(height);
    const d = new Float64Array(height);
    const arg = new Int32Array(height);
    const v = new Int32Array(height);
    const z = new Float64Array(height + 1);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const i = y * width + x;
        f[y] = isSite[i] ? siteHeight[i] : INF;
      }
      transform1D(f, height, d, arg, v, z);
      for (let y = 0; y < height; y++) {
        const i = y * width + x;
        df[i] = d[y];
        argY[i] = arg[y];
      }
    }
  }

  const distSq = new Float64Array(width * height);
  const nearestX = new Int32Array(width * height);
  const nearestY = new Int32Array(width * height);

  {
    const f = new Float64Array(width);
    const d = new Float64Array(width);
    const arg = new Int32Array(width);
    const v = new Int32Array(width);
    const z = new Float64Array(width + 1);
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) f[x] = df[rowOff + x];
      transform1D(f, width, d, arg, v, z);
      for (let x = 0; x < width; x++) {
        const i = rowOff + x;
        const winX = arg[x];
        const winY = argY[y * width + winX];
        nearestX[i] = winX;
        nearestY[i] = winY;
        // Recompute the true (unbiased) squared distance from the winning
        // coordinate: `d[x]` includes any siteHeight tie-break bias, which is
        // only meant to influence *which* site wins, not the reported
        // distance (Stage 8 warnings need real physical distances).
        const dx = x - winX;
        const dy = y - winY;
        distSq[i] = dx * dx + dy * dy;
      }
    }
  }

  return { distSq, nearestX, nearestY };
}

/** Plain exact EDT: squared distance from every pixel to the nearest pixel where mask[i] !== 0. */
export function squaredDistanceTransform(mask: Uint8Array, width: number, height: number): Float64Array {
  const zeroHeight = new Float64Array(width * height);
  return nearestSite(mask, zeroHeight, width, height).distSq;
}

export interface LabeledDistanceField {
  distSq: Float64Array;
  nearestLabel: Int32Array;
}

/**
 * Stage 4 watershed: for every pixel where isSite[i] !== 0, finds the nearest
 * such pixel and returns its label. Exact ties (equidistant sites — the
 * medial axis itself) are broken deterministically: lowest label id wins.
 *
 * Tie-break trick: bias each site's transform height by a tiny amount
 * proportional to its (shifted, non-negative) label so that whenever two
 * candidate sites are at the *exact* same true distance, the lower-labeled
 * one wins — while never being large enough to flip the order between two
 * genuinely different integer squared distances (which always differ by at
 * least 1).
 */
export function nearestLabeledSite(
  labels: Int32Array,
  isSite: Uint8Array,
  width: number,
  height: number,
): LabeledDistanceField {
  let maxShifted = 0;
  const shifted = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    if (!isSite[i]) continue;
    const s = labels[i] < 0 ? 0 : labels[i] + 1;
    shifted[i] = s;
    if (s > maxShifted) maxShifted = s;
  }
  const epsilon = 0.4 / (maxShifted + 1);

  const siteHeight = new Float64Array(width * height);
  for (let i = 0; i < labels.length; i++) {
    if (isSite[i]) siteHeight[i] = shifted[i] * epsilon;
  }

  const field = nearestSite(isSite, siteHeight, width, height);
  const nearestLabel = new Int32Array(width * height);
  for (let i = 0; i < nearestLabel.length; i++) {
    const nx = field.nearestX[i];
    const ny = field.nearestY[i];
    nearestLabel[i] = labels[ny * width + nx];
  }
  return { distSq: field.distSq, nearestLabel };
}
