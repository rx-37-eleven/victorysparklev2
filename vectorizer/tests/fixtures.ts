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

export interface Pt {
  x: number;
  y: number;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / abLenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function pointInPolygon(px: number, py: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Mitered offset of a closed polygon's own edge path: each vertex is pushed
 * along its local bisector by half-width/cos(interior angle/2), the
 * standard miter-join formula. `sign` is +1 for the outward offset, -1 for
 * inward; both use the same local bisector direction, since which side is
 * geometrically "outward" flips at reflex vertices anyway.
 */
function miterOffset(vertices: Pt[], halfWidth: number, sign: 1 | -1): Pt[] {
  const n = vertices.length;
  return vertices.map((v, i) => {
    const prev = vertices[(i - 1 + n) % n];
    const next = vertices[(i + 1) % n];
    const eIn = normalize2(v.x - prev.x, v.y - prev.y);
    const eOut = normalize2(next.x - v.x, next.y - v.y);
    // Right-hand normals of each edge direction (consistent orientation).
    const nIn = { x: eIn.y, y: -eIn.x };
    const nOut = { x: eOut.y, y: -eOut.x };
    let bisector = normalize2(nIn.x + nOut.x, nIn.y + nOut.y);
    if (bisector.x === 0 && bisector.y === 0) bisector = nIn; // 180-degree edge, fall back
    const cosHalfAngle = bisector.x * nIn.x + bisector.y * nIn.y;
    const miterLen = Math.min(halfWidth / Math.max(cosHalfAngle, 0.2), halfWidth * 4); // clamp: avoid runaway spikes on near-reversal vertices
    return { x: v.x + sign * bisector.x * miterLen, y: v.y + sign * bisector.y * miterLen };
  });
}

function normalize2(x: number, y: number): Pt {
  const l = Math.hypot(x, y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: x / l, y: y / l };
}

/**
 * Closed polygon outline (e.g. a star) rasterized as a thick stroke with
 * genuine mitered (sharp) corners -- for sharp-corner tests. Plain
 * distance-to-nearest-edge-segment rasterization implicitly rounds every
 * vertex (radius = half line width), which blunts an acute tip enough to
 * erase it entirely at realistic line widths; this fills between a mitered
 * outward offset and a mitered inward offset instead, so the corner in the
 * raster is actually as sharp as the polygon it's meant to represent.
 */
export function makePolygon(width: number, height: number, vertices: Pt[], lineWidth: number): Fixture {
  const f = blank(width, height);
  const half = lineWidth / 2;
  const outer = miterOffset(vertices, half, 1);
  const inner = miterOffset(vertices, half, -1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (pointInPolygon(px, py, outer) && !pointInPolygon(px, py, inner)) f.ink[y * width + x] = 1;
    }
  }
  return f;
}

/**
 * An n-pointed star: alternating outer/inner vertices, all genuinely sharp
 * (unlike a circle, which has no corners at all). Returns the ground-truth
 * vertex positions alongside the raster so tests can check each one landed
 * a real corner in the fitted output.
 */
export function makeStar(size: number, points: number, outerR: number, innerR: number, lineWidth: number): { fixture: Fixture; vertices: Pt[] } {
  const cx = size / 2;
  const cy = size / 2;
  const vertices: Pt[] = [];
  const n = points * 2;
  for (let i = 0; i < n; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    vertices.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return { fixture: makePolygon(size, size, vertices, lineWidth), vertices };
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
