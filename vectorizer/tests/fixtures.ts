// Synthetic test fixtures, generated in code per spec section 8.
// Each returns an `ink` mask (1 = line, 0 = glass) plus width/height.

export interface Fixture {
  ink: Uint8Array;
  width: number;
  height: number;
}

function blank(width: number, height: number): Fixture {
  return { ink: new Uint8Array(width * height), width, height };
}

function drawHLine(f: Fixture, y: number, lineWidth: number, x0 = 0, x1 = f.width - 1): void {
  const half = (lineWidth - 1) / 2;
  const y0 = Math.round(y - half);
  const y1 = Math.round(y + half);
  for (let yy = Math.max(0, y0); yy <= Math.min(f.height - 1, y1); yy++) {
    for (let x = Math.max(0, x0); x <= Math.min(f.width - 1, x1); x++) {
      f.ink[yy * f.width + x] = 1;
    }
  }
}

function drawVLine(f: Fixture, x: number, lineWidth: number, y0 = 0, y1 = f.height - 1): void {
  const half = (lineWidth - 1) / 2;
  const x0 = Math.round(x - half);
  const x1 = Math.round(x + half);
  for (let xx = Math.max(0, x0); xx <= Math.min(f.width - 1, x1); xx++) {
    for (let y = Math.max(0, y0); y <= Math.min(f.height - 1, y1); y++) {
      f.ink[y * f.width + xx] = 1;
    }
  }
}

/**
 * cols x rows grid of square cells, each `cellSize` px, lines `lineWidth` px
 * wide, centered on the grid lines. Surrounded by a `margin`-px band of
 * non-ink outside the frame -- like a real pattern, the outer frame line has
 * background on its far side, so it splits its width with the border-facing
 * pieces exactly like an interior seam does. Without this margin the outer
 * frame's ink has no "far side" to donate half its width to, and edge/corner
 * cells end up larger than interior ones.
 */
export function makeGrid(cols: number, rows: number, cellSize: number, lineWidth: number, margin = lineWidth * 2): Fixture {
  const width = cols * cellSize + lineWidth + margin * 2;
  const height = rows * cellSize + lineWidth + margin * 2;
  const f = blank(width, height);
  for (let c = 0; c <= cols; c++) drawVLine(f, margin + c * cellSize, lineWidth);
  for (let r = 0; r <= rows; r++) drawHLine(f, margin + r * cellSize, lineWidth);
  return f;
}

/** Same grid, but with a gap of `gapPx` cut into one interior vertical line. */
export function makeGridWithGap(
  cols: number,
  rows: number,
  cellSize: number,
  lineWidth: number,
  gapPx: number,
  margin = lineWidth * 2,
): Fixture {
  const f = makeGrid(cols, rows, cellSize, lineWidth, margin);
  const gapCol = Math.floor(cols / 2);
  const x = margin + gapCol * cellSize;
  const gapY0 = Math.floor(f.height / 2 - gapPx / 2);
  const gapY1 = gapY0 + gapPx - 1;
  const lineHalf = (lineWidth - 1) / 2;
  for (let y = gapY0; y <= gapY1; y++) {
    for (let xx = Math.round(x - lineHalf); xx <= Math.round(x + lineHalf); xx++) {
      if (xx >= 0 && xx < f.width && y >= 0 && y < f.height) f.ink[y * f.width + xx] = 0;
    }
  }
  return f;
}

/** A square outer border with a circle inside it -- 2 pieces, one with a hole. */
export function makeCircleInSquare(size: number, margin: number, radius: number, lineWidth: number): Fixture {
  const f = blank(size, size);
  drawHLine(f, margin, lineWidth, margin, size - 1 - margin);
  drawHLine(f, size - 1 - margin, lineWidth, margin, size - 1 - margin);
  drawVLine(f, margin, lineWidth, margin, size - 1 - margin);
  drawVLine(f, size - 1 - margin, lineWidth, margin, size - 1 - margin);

  const cx = size / 2;
  const cy = size / 2;
  const half = lineWidth / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (Math.abs(d - radius) <= half) f.ink[y * f.width + x] = 1;
    }
  }
  return f;
}

/** A single straight diagonal stroke at the given angle (degrees), for EDT isotropy checks. */
export function makeDiagonal(width: number, height: number, angleDeg: number, lineWidth: number): Fixture {
  const f = blank(width, height);
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const half = lineWidth / 2;
  const maxT = Math.hypot(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // perpendicular distance from (x,y) to the line through (cx,cy) with direction (dx,dy)
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const t = px * dx + py * dy;
      if (Math.abs(t) > maxT) continue;
      const perp = Math.abs(px * dy - py * dx);
      if (perp <= half) f.ink[y * width + x] = 1;
    }
  }
  return f;
}
