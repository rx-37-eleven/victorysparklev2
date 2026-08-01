// Stage 1 — binarize.

export function otsuThreshold(gray: Float32Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    hist[clamp8(Math.round(gray[i]))]++;
  }
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVariance = -1;
  const variances = new Float64Array(256).fill(-1);
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    variances[t] = variance;
    if (variance > maxVariance) maxVariance = variance;
  }
  // Otsu's criterion is flat across any gap between clusters (no pixels take
  // on those intermediate gray values), so several t's can tie for the max.
  // Split the difference rather than picking the first tied t, which would
  // sit right at the edge of the darker cluster instead of between the two.
  let plateauStart = -1;
  let plateauEnd = -1;
  for (let t = 0; t < 256; t++) {
    if (variances[t] === maxVariance) {
      if (plateauStart === -1) plateauStart = t;
      plateauEnd = t;
    }
  }
  return Math.round((plateauStart + plateauEnd) / 2);
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Summed-area tables for O(1) windowed mean/variance, used by Sauvola.
class IntegralImage {
  width: number;
  height: number;
  sum: Float64Array;
  sumSq: Float64Array;

  constructor(gray: Float32Array, width: number, height: number) {
    this.width = width;
    this.height = height;
    // (W+1)x(H+1), row/col 0 are zero padding.
    this.sum = new Float64Array((width + 1) * (height + 1));
    this.sumSq = new Float64Array((width + 1) * (height + 1));
    const stride = width + 1;
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      let rowSumSq = 0;
      for (let x = 0; x < width; x++) {
        const v = gray[y * width + x];
        rowSum += v;
        rowSumSq += v * v;
        const idx = (y + 1) * stride + (x + 1);
        this.sum[idx] = this.sum[idx - stride] + rowSum;
        this.sumSq[idx] = this.sumSq[idx - stride] + rowSumSq;
      }
    }
  }

  // Inclusive window [x0,x1] x [y0,y1], clamped to image bounds.
  windowStats(x0: number, y0: number, x1: number, y1: number): { mean: number; std: number } {
    const stride = this.width + 1;
    x0 = clampi(x0, 0, this.width - 1);
    x1 = clampi(x1, 0, this.width - 1);
    y0 = clampi(y0, 0, this.height - 1);
    y1 = clampi(y1, 0, this.height - 1);
    const a = y0 * stride + x0;
    const b = y0 * stride + (x1 + 1);
    const c = (y1 + 1) * stride + x0;
    const d = (y1 + 1) * stride + (x1 + 1);
    const n = (x1 - x0 + 1) * (y1 - y0 + 1);
    const sum = this.sum[d] - this.sum[b] - this.sum[c] + this.sum[a];
    const sumSq = this.sumSq[d] - this.sumSq[b] - this.sumSq[c] + this.sumSq[a];
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    return { mean, std: Math.sqrt(variance) };
  }
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Sauvola adaptive threshold: T(x,y) = m*(1 + k*(s/R - 1))
export function sauvolaThresholdMap(
  gray: Float32Array,
  width: number,
  height: number,
  window: number,
  k = 0.2,
  R = 128,
): Float32Array {
  const integral = new IntegralImage(gray, width, height);
  const radius = Math.max(1, Math.floor(window / 2));
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { mean, std } = integral.windowStats(x - radius, y - radius, x + radius, y + radius);
      out[y * width + x] = mean * (1 + k * (std / R - 1));
    }
  }
  return out;
}

export interface BinarizeParams {
  threshold: number;
  adaptive: boolean;
  window: number;
  invert: boolean;
}

// ink = 1 (line), 0 (glass).
export function binarize(gray: Float32Array, width: number, height: number, params: BinarizeParams): Uint8Array {
  const ink = new Uint8Array(width * height);
  if (params.adaptive) {
    const tmap = sauvolaThresholdMap(gray, width, height, params.window);
    for (let i = 0; i < gray.length; i++) {
      const isInk = gray[i] < tmap[i];
      ink[i] = (params.invert ? !isInk : isInk) ? 1 : 0;
    }
  } else {
    for (let i = 0; i < gray.length; i++) {
      const isInk = gray[i] < params.threshold;
      ink[i] = (params.invert ? !isInk : isInk) ? 1 : 0;
    }
  }
  return ink;
}
