// Stage 0 — decode & normalize.

export function toGrayscale(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return gray;
}

// 3x3 median filter — removes JPEG ringing halos without blurring line ends
// the way a Gaussian would.
export function medianFilter3x3(gray: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const window = new Float32Array(9);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = clamp(y + dy, 0, height - 1);
        for (let dx = -1; dx <= 1; dx++) {
          const xx = clamp(x + dx, 0, width - 1);
          window[n++] = gray[yy * width + xx];
        }
      }
      window.sort();
      out[y * width + x] = window[4];
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
