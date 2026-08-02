/* =====================================================================
   WEEDLINE — Weeding Boundary Generator
   ---------------------------------------------------------------------
   This file has two parts:

     1. CONFIG (right below this comment) — every physical measurement
        and tunable number in the app. If you only ever touch one part
        of this file, make it this block.

     2. Everything else — the app logic. You shouldn't need to edit
        below the "DO NOT EDIT BELOW THIS LINE" marker unless you're
        comfortable with JavaScript and computational geometry.

   What this does: uploads a design image, traces its silhouette, and
   draws a weeding boundary (an offset cut line) around it so the
   leftover vinyl/HTV comes off in one piece. Two modes:

     Bubble — a smooth offset line at a constant distance from the
     design. Computed via an exact Euclidean distance transform +
     marching squares, so separate shapes naturally merge into one
     bubble as the distance grows.

     Angles — a straight-sided polygon with N sides, computed by
     reducing the design's convex hull down to N edges via greedy
     minimum-area edge removal, then offsetting the result outward.

   Everything runs client-side. No image data ever leaves the browser.

   Performance model (this is the whole point of the caching below):
   the distance transform (bubble) and the hull edge-reduction (angles)
   are each computed exactly ONCE per upload. Moving a slider afterward
   only re-runs the cheap final step (marching squares for bubble, an
   array lookup + polygon offset for angles) so both sliders feel
   instant. If you find yourself recomputing the distance transform or
   the hull reduction inside a slider handler, something has gone wrong.
   ===================================================================== */

const CONFIG = {
  // --- Working resolution ---
  WORK_MAX_PX: 1000, // longest side of the image is downscaled to this for
                      // all geometry. Final coordinates are scaled back up
                      // to the original resolution before export.

  // --- Distance sliders (bubble offset / angles offset) ---
  // Range is defined in inches; the millimeter range/step shown when the
  // unit selector is set to mm is the exact metric conversion (25.4mm/in).
  DISTANCE_MAX_IN: 1.0,
  DISTANCE_STEP_IN: 0.01,
  DISTANCE_DEFAULT_IN: 0.25,
  MM_PER_IN: 25.4,

  // --- Angles slider ---
  ANGLES_MIN: 3,
  ANGLES_MAX: 24,
  ANGLES_DEFAULT: 4,

  // --- Design width (real-world scale) ---
  DESIGN_WIDTH_DEFAULT_IN: 4,
  DESIGN_WIDTH_MIN_IN: 0.1,
  DESIGN_WIDTH_MAX_IN: 200,

  // --- Advanced: ink threshold ---
  THRESHOLD_MIN: 1,
  THRESHOLD_MAX: 250,
  THRESHOLD_DEFAULT_ALPHA: 16,
  THRESHOLD_DEFAULT_LUMINANCE: 128,
  // A pixel counts as "meaningfully transparent" for alpha-mode detection
  // if its alpha falls in this partial range, or is fully transparent.
  ALPHA_VARIANCE_LOW: 8,
  ALPHA_VARIANCE_HIGH: 248,

  // --- Advanced: speck filter ---
  SPECKS_MIN_MM2: 0,
  SPECKS_MAX_MM2: 5,
  SPECKS_DEFAULT_MM2: 0.5,

  // --- Marching squares / contour smoothing ---
  RDP_EPSILON_WORK_PX: 0.6, // simplification tolerance, at working resolution
  CATMULL_ROM_TENSION: 0.5, // 0.5 = standard Catmull-Rom
  MIN_LOOP_POINTS: 3,
  ENDPOINT_QUANT: 1e-4, // rounding grid used to hash segment endpoints together

  // --- Angles mode: hull edge reduction guards ---
  MAX_MITER_FACTOR: 4, // shared guard: hull-reduction intersection distance
                        // AND offset miter-length cap, both relative to a
                        // size reference (hull diagonal / offset distance)

  // --- Export ---
  SVG_STROKE_COLOR: "#000000",
  SVG_STROKE_WIDTH: 1,
  COORD_DECIMALS: 2,
};

/* =====================================================================
   DO NOT EDIT BELOW THIS LINE unless you're comfortable with JavaScript.
   ===================================================================== */

(function (root) {
  "use strict";

  // -----------------------------------------------------------------
  // Small math helpers
  // -----------------------------------------------------------------

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  }

  // Shoelace formula. Positive result means the point order is "CCW" in
  // exactly the sense that makes the outward-normal formula in
  // offsetPolygon() (t.y, -t.x) point outward — see the comment there.
  function signedArea(points) {
    let sum = 0;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
  }

  function polygonArea(points) {
    return Math.abs(signedArea(points));
  }

  function triangleArea(a, b, c) {
    return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  }

  // Intersection of infinite lines through (p1,p2) and (p3,p4). Returns
  // null if parallel (or nearly so).
  function lineIntersect(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-9) return null;
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / cross;
    return { x: p1.x + t * d1x, y: p1.y + t * d1y };
  }

  // Even-odd ray casting point-in-polygon test.
  function pointInPolygon(pt, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersects =
        yi > pt.y !== yj > pt.y &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  // -----------------------------------------------------------------
  // 1. Ink mask
  // -----------------------------------------------------------------

  // Inspects alpha channel to decide alpha-mode vs luminance-mode, per
  // spec §5.1: any pixel with meaningfully-partial or fully-zero alpha
  // triggers alpha mode.
  function detectAlphaMode(data, len) {
    for (let i = 3; i < len; i += 4) {
      const a = data[i];
      if (a === 0 || (a > CONFIG.ALPHA_VARIANCE_LOW && a < CONFIG.ALPHA_VARIANCE_HIGH)) {
        return true;
      }
    }
    return false;
  }

  function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // Median luminance of the four corners + four edge midpoints, used to
  // decide whether the background reads as bright or dark in
  // luminance-mode background detection.
  function detectBackgroundLuminance(data, width, height) {
    const samples = [
      [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
      [Math.floor(width / 2), 0], [Math.floor(width / 2), height - 1],
      [0, Math.floor(height / 2)], [width - 1, Math.floor(height / 2)],
    ];
    const lumas = samples.map(([x, y]) => {
      const i = (y * width + x) * 4;
      return luminance(data[i], data[i + 1], data[i + 2]);
    });
    lumas.sort((a, b) => a - b);
    const mid = Math.floor(lumas.length / 2);
    return lumas.length % 2 === 0 ? (lumas[mid - 1] + lumas[mid]) / 2 : lumas[mid];
  }

  // Builds a 1 = ink Uint8Array mask from ImageData at working resolution.
  // `background` is the Advanced override: "auto" | "transparent" | "white" | "black".
  function buildInkMask(imageData, width, height, threshold, background) {
    const data = imageData.data;
    let mode; // "alpha" | "luminance"
    let brightBackground = true;

    if (background === "transparent") {
      mode = "alpha";
    } else if (background === "white") {
      mode = "luminance";
      brightBackground = true;
    } else if (background === "black") {
      mode = "luminance";
      brightBackground = false;
    } else {
      mode = detectAlphaMode(data, data.length) ? "alpha" : "luminance";
      if (mode === "luminance") {
        const medianLuma = detectBackgroundLuminance(data, width, height);
        brightBackground = medianLuma >= 128;
      }
    }

    const mask = new Uint8Array(width * height);
    if (mode === "alpha") {
      for (let p = 0, i = 3; p < mask.length; p++, i += 4) {
        mask[p] = data[i] > threshold ? 1 : 0;
      }
    } else {
      for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        const luma = luminance(data[i], data[i + 1], data[i + 2]);
        mask[p] = brightBackground ? (luma < threshold ? 1 : 0) : (luma > threshold ? 1 : 0);
      }
    }

    return { mask, mode, brightBackground };
  }

  // Iterative (non-recursive) 8-connected flood fill labeling. Returns an
  // array of components, each { pixels: [index,...], value } where value
  // is the mask value (0 or 1) shared by every pixel in the component.
  function labelComponents(mask, width, height) {
    const visited = new Uint8Array(width * height);
    const components = [];
    const stack = new Int32Array(width * height);

    for (let start = 0; start < mask.length; start++) {
      if (visited[start]) continue;
      const value = mask[start];
      visited[start] = 1;
      let sp = 0;
      stack[sp++] = start;
      const pixels = [start];

      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % width;
        const y = (idx / width) | 0;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nIdx = ny * width + nx;
            if (visited[nIdx] || mask[nIdx] !== value) continue;
            visited[nIdx] = 1;
            stack[sp++] = nIdx;
            pixels.push(nIdx);
          }
        }
      }

      components.push({ pixels, value, touchesBorder: false });
    }

    return components;
  }

  // Despeckles the mask in place: drops small ink components (specks) and
  // fills small enclosed background components (pinholes), both by area.
  // Background components that touch the canvas border are never filled
  // (that would flood-fill the entire outside as "ink").
  function despeckle(mask, width, height, minAreaPx) {
    if (minAreaPx <= 0) return mask;
    const components = labelComponents(mask, width, height);

    for (const comp of components) {
      if (comp.pixels.length >= minAreaPx) continue;

      if (comp.value === 1) {
        for (const idx of comp.pixels) mask[idx] = 0;
        continue;
      }

      // value === 0 (background): only fill if fully enclosed, i.e. no
      // pixel of this component touches the mask border.
      let touchesBorder = false;
      for (const idx of comp.pixels) {
        const x = idx % width;
        const y = (idx / width) | 0;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          touchesBorder = true;
          break;
        }
      }
      if (!touchesBorder) {
        for (const idx of comp.pixels) mask[idx] = 1;
      }
    }

    return mask;
  }

  function maskHasInk(mask) {
    for (let i = 0; i < mask.length; i++) if (mask[i]) return true;
    return false;
  }

  // -----------------------------------------------------------------
  // 2. Exact Euclidean distance transform
  //    Felzenszwalb & Huttenlocher, two-pass 1D lower envelope.
  // -----------------------------------------------------------------

  const EDT_INF = 1e9;

  // 1D squared distance transform of `f` (length n). f[i] is the "base"
  // squared height at i (0 for a seed, EDT_INF for a non-seed on the
  // first pass; an already-computed squared distance on the second
  // pass). Returns a plain Array of squared distances.
  function dt1d(f, n) {
    const d = new Array(n);
    const v = new Array(n);
    const z = new Array(n + 1);
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;

    for (let q = 1; q < n; q++) {
      let s;
      for (;;) {
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (s > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }

    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dx = q - v[k];
      d[q] = dx * dx + f[v[k]];
    }
    return d;
  }

  // Two-pass separable EDT of a binary mask. Returns a Float32Array of
  // *linear* (sqrt'd) distances from every pixel to the nearest ink
  // pixel (0 at ink pixels themselves).
  function computeEDT(mask, width, height) {
    const g = new Array(width * height);

    // Pass 1: columns.
    const colBuf = new Array(height);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        colBuf[y] = mask[y * width + x] ? 0 : EDT_INF;
      }
      const colOut = dt1d(colBuf, height);
      for (let y = 0; y < height; y++) g[y * width + x] = colOut[y];
    }

    // Pass 2: rows, using pass-1 output as the base heights.
    const out = new Float32Array(width * height);
    const rowBuf = new Array(width);
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) rowBuf[x] = g[rowOffset + x];
      const rowOut = dt1d(rowBuf, width);
      for (let x = 0; x < width; x++) out[rowOffset + x] = Math.sqrt(rowOut[x]);
    }

    return out;
  }

  // -----------------------------------------------------------------
  // 3. Marching squares
  // -----------------------------------------------------------------

  // Edge-crossing point via linear interpolation between two corner
  // values `a` (at pa) and `b` (at pb) straddling zero.
  function crossingPoint(pa, a, pb, b) {
    const t = a / (a - b);
    return { x: pa.x + t * (pb.x - pa.x), y: pa.y + t * (pb.y - pa.y) };
  }

  function quantKey(pt) {
    const q = CONFIG.ENDPOINT_QUANT;
    return Math.round(pt.x / q) + "_" + Math.round(pt.y / q);
  }

  // Runs marching squares over `field` (a (w+2) x (h+2) Float32Array,
  // already padded by one cell of very-negative values on every side so
  // shapes touching the working-canvas edge still close). Returns an
  // array of closed loops (each an array of {x,y}, in *field-grid*
  // coordinates where (0,0) is the padded field's origin — callers
  // subtract 1 to get working-resolution pixel coordinates).
  function marchingSquaresRaw(field, fw, fh) {
    // Undirected segments: array of [p1, p2] pairs. Direction doesn't
    // matter — loops are exported with fill:none, so winding is never
    // observed visually. What matters is getting the *pairing* of
    // crossing points right per case, which is unambiguous except for
    // the two saddle cases.
    const segments = [];

    for (let j = 0; j < fh - 1; j++) {
      for (let i = 0; i < fw - 1; i++) {
        const v00 = field[j * fw + i];         // top-left
        const v10 = field[j * fw + i + 1];       // top-right
        const v11 = field[(j + 1) * fw + i + 1]; // bottom-right
        const v01 = field[(j + 1) * fw + i];     // bottom-left

        let caseIndex = 0;
        if (v00 >= 0) caseIndex |= 1;
        if (v10 >= 0) caseIndex |= 2;
        if (v11 >= 0) caseIndex |= 4;
        if (v01 >= 0) caseIndex |= 8;

        if (caseIndex === 0 || caseIndex === 15) continue;

        const pTL = { x: i, y: j };
        const pTR = { x: i + 1, y: j };
        const pBR = { x: i + 1, y: j + 1 };
        const pBL = { x: i, y: j + 1 };

        const top = () => crossingPoint(pTL, v00, pTR, v10);
        const right = () => crossingPoint(pTR, v10, pBR, v11);
        const bottom = () => crossingPoint(pBL, v01, pBR, v11);
        const left = () => crossingPoint(pTL, v00, pBL, v01);

        function addSeg(p1, p2) {
          segments.push([p1, p2]);
        }

        switch (caseIndex) {
          case 1: addSeg(left(), top()); break;
          case 2: addSeg(top(), right()); break;
          case 3: addSeg(left(), right()); break;
          case 4: addSeg(right(), bottom()); break;
          case 6: addSeg(top(), bottom()); break;
          case 7: addSeg(left(), bottom()); break;
          case 8: addSeg(bottom(), left()); break;
          case 9: addSeg(bottom(), top()); break;
          case 11: addSeg(right(), bottom()); break;
          case 12: addSeg(right(), left()); break;
          case 13: addSeg(top(), right()); break;
          case 14: addSeg(left(), top()); break;
          case 5: {
            // Saddle: TL + BR inside, TR + BL outside. If the bilinear
            // center is also inside, TL and BR are bridged through the
            // middle, so the boundary instead isolates the two OUTSIDE
            // corners (TR, BL) from that bridge. If the center is
            // outside, TL and BR are two separate inside blobs, so the
            // boundary isolates each INSIDE corner from the rest.
            const center = (v00 + v10 + v11 + v01) / 4;
            if (center >= 0) {
              addSeg(top(), right());
              addSeg(left(), bottom());
            } else {
              addSeg(left(), top());
              addSeg(right(), bottom());
            }
            break;
          }
          case 10: {
            // Saddle: TR + BL inside, TL + BR outside. Same logic as
            // case 5, mirrored.
            const center = (v00 + v10 + v11 + v01) / 4;
            if (center >= 0) {
              addSeg(left(), top());
              addSeg(right(), bottom());
            } else {
              addSeg(top(), right());
              addSeg(left(), bottom());
            }
            break;
          }
          default: break;
        }
      }
    }

    return segments;
  }

  // Links undirected segments into closed loops by matching endpoints
  // (quantized to a small grid so floating-point crossing points that
  // should coincide actually do).
  function linkSegmentsToLoops(segments) {
    const adjacency = new Map(); // key -> [{key, pt}, ...]

    function addNode(key, pt) {
      if (!adjacency.has(key)) adjacency.set(key, { pt, neighbors: [] });
      return adjacency.get(key);
    }

    for (const [p1, p2] of segments) {
      const k1 = quantKey(p1);
      const k2 = quantKey(p2);
      if (k1 === k2) continue; // degenerate zero-length segment
      const n1 = addNode(k1, p1);
      const n2 = addNode(k2, p2);
      n1.neighbors.push(k2);
      n2.neighbors.push(k1);
    }

    const visitedNodes = new Set();
    const loops = [];

    for (const startKey of adjacency.keys()) {
      if (visitedNodes.has(startKey)) continue;

      const loopKeys = [];
      let prevKey = null;
      let curKey = startKey;

      // Walk the chain until we return to the start (closed loop) or run
      // out of unvisited neighbors (open chain — shouldn't happen for a
      // well-formed padded field, but don't crash if it does).
      for (;;) {
        visitedNodes.add(curKey);
        loopKeys.push(curKey);
        const node = adjacency.get(curKey);
        const neighbors = node.neighbors.filter((k) => k !== prevKey || node.neighbors.length === 1);
        let nextKey = null;
        for (const cand of neighbors) {
          if (cand === startKey && loopKeys.length > 2) { nextKey = cand; break; }
          if (!visitedNodes.has(cand)) { nextKey = cand; break; }
        }
        if (nextKey === null) break;
        if (nextKey === startKey) break; // closed the loop
        prevKey = curKey;
        curKey = nextKey;
      }

      if (loopKeys.length >= CONFIG.MIN_LOOP_POINTS) {
        loops.push(loopKeys.map((k) => adjacency.get(k).pt));
      }
    }

    return loops;
  }

  // Classifies loops as outer boundaries vs holes using even-odd
  // containment (robust regardless of each loop's individual winding
  // direction, which undirected chaining does not guarantee): a loop
  // nested inside an odd number of other loops is a hole and is dropped.
  function keepOuterLoops(loops) {
    if (loops.length <= 1) return loops;

    const containment = loops.map(() => 0);
    for (let i = 0; i < loops.length; i++) {
      const testPoint = loops[i][0];
      for (let j = 0; j < loops.length; j++) {
        if (i === j) continue;
        if (pointInPolygon(testPoint, loops[j])) containment[i]++;
      }
    }

    return loops.filter((_, i) => containment[i] % 2 === 0);
  }

  // Full marching-squares pass: builds the padded field from a distance
  // array, contours at F = offsetPx - dist, simplifies + smooths, and
  // returns closed loop paths (Catmull-Rom cubic Bezier point arrays) in
  // *working-resolution pixel* coordinates.
  function marchingSquares(distField, width, height, offsetPx) {
    const fw = width + 2;
    const fh = height + 2;
    const field = new Float32Array(fw * fh);
    field.fill(-EDT_INF); // padding border: always "outside"

    for (let y = 0; y < height; y++) {
      const srcRow = y * width;
      const dstRow = (y + 1) * fw + 1;
      for (let x = 0; x < width; x++) {
        field[dstRow + x] = offsetPx - distField[srcRow + x];
      }
    }

    const segments = marchingSquaresRaw(field, fw, fh);
    let loops = linkSegmentsToLoops(segments);

    // Shift back from padded-field coordinates to working-pixel
    // coordinates (padding added 1 cell of offset on each side).
    loops = loops.map((loop) => loop.map((p) => ({ x: p.x - 1, y: p.y - 1 })));

    return keepOuterLoops(loops);
  }

  // -----------------------------------------------------------------
  // 4. Simplify (RDP) + smooth (Catmull-Rom -> cubic Bezier)
  // -----------------------------------------------------------------

  function perpendicularDistance(pt, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.sqrt(dist2(pt.x, pt.y, lineStart.x, lineStart.y));
    const t = ((pt.x - lineStart.x) * dx + (pt.y - lineStart.y) * dy) / len2;
    const projX = lineStart.x + t * dx;
    const projY = lineStart.y + t * dy;
    return Math.sqrt(dist2(pt.x, pt.y, projX, projY));
  }

  function rdpOpen(points, epsilon) {
    if (points.length < 3) return points.slice();
    let maxDist = -1;
    let maxIndex = 0;
    const first = points[0];
    const last = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const d = perpendicularDistance(points[i], first, last);
      if (d > maxDist) { maxDist = d; maxIndex = i; }
    }
    if (maxDist > epsilon) {
      const left = rdpOpen(points.slice(0, maxIndex + 1), epsilon);
      const right = rdpOpen(points.slice(maxIndex), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  // RDP on a closed loop: treat it as an open path from point 0 back to
  // point 0 (so the seam point is always preserved), simplify, then drop
  // the duplicated closing point.
  function rdpSimplifyClosed(points, epsilon) {
    if (points.length < 4) return points.slice();
    const asOpen = points.concat([points[0]]);
    const simplified = rdpOpen(asOpen, epsilon);
    simplified.pop();
    return simplified.length >= 3 ? simplified : points.slice();
  }

  // Converts a closed polygon into an SVG cubic-bezier path's "d"
  // commands (without the leading "M" — callers prepend that), using a
  // Catmull-Rom spline through every vertex.
  function catmullRomLoopToBezier(points, tension) {
    const n = points.length;
    if (n < 3) return "";
    const round = (v) => Math.round(v * Math.pow(10, CONFIG.COORD_DECIMALS)) / Math.pow(10, CONFIG.COORD_DECIMALS);

    let d = "M " + round(points[0].x) + " " + round(points[0].y) + " ";
    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];

      const c1x = p1.x + (tension * (p2.x - p0.x)) / 3;
      const c1y = p1.y + (tension * (p2.y - p0.y)) / 3;
      const c2x = p2.x - (tension * (p3.x - p1.x)) / 3;
      const c2y = p2.y - (tension * (p3.y - p1.y)) / 3;

      d += "C " + round(c1x) + " " + round(c1y) + " " + round(c2x) + " " + round(c2y) + " " + round(p2.x) + " " + round(p2.y) + " ";
    }
    d += "Z";
    return d;
  }

  function polygonLoopToPath(points) {
    const round = (v) => Math.round(v * Math.pow(10, CONFIG.COORD_DECIMALS)) / Math.pow(10, CONFIG.COORD_DECIMALS);
    if (points.length < 2) return "";
    let d = "M " + round(points[0].x) + " " + round(points[0].y) + " ";
    for (let i = 1; i < points.length; i++) {
      d += "L " + round(points[i].x) + " " + round(points[i].y) + " ";
    }
    d += "Z";
    return d;
  }

  // -----------------------------------------------------------------
  // 5. Convex hull (angles mode)
  // -----------------------------------------------------------------

  // Cheap candidate points: row extremes cover the full hull by
  // themselves; column extremes are added defensively per spec §5.5.
  function gatherHullCandidates(mask, width, height) {
    const points = [];

    for (let y = 0; y < height; y++) {
      let left = -1, right = -1;
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (mask[row + x]) { if (left === -1) left = x; right = x; }
      }
      if (left !== -1) {
        points.push({ x: left, y });
        if (right !== left) points.push({ x: right, y });
      }
    }

    for (let x = 0; x < width; x++) {
      let top = -1, bottom = -1;
      for (let y = 0; y < height; y++) {
        if (mask[y * width + x]) { if (top === -1) top = y; bottom = y; }
      }
      if (top !== -1) {
        points.push({ x, y: top });
        if (bottom !== top) points.push({ x, y: bottom });
      }
    }

    return points;
  }

  function crossProduct(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  // Andrew's monotone chain. Returns a convex hull with NO guarantee on
  // winding direction — callers must normalize via signedArea if it
  // matters (offsetPolygon's outward-normal formula needs a specific
  // sign; see normalizeWinding()).
  function convexHull(points) {
    const pts = points
      .slice()
      .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

    // De-duplicate.
    const uniq = [];
    for (const p of pts) {
      const last = uniq[uniq.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) uniq.push(p);
    }
    if (uniq.length < 3) return uniq;

    const lower = [];
    for (const p of uniq) {
      while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop();
      }
      lower.push(p);
    }

    const upper = [];
    for (let i = uniq.length - 1; i >= 0; i--) {
      const p = uniq[i];
      while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop();
      }
      upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // Ensures signedArea(poly) > 0, i.e. the winding direction that makes
  // offsetPolygon()'s outward-normal formula correct. See the derivation
  // in the comment on offsetPolygon().
  function normalizeWinding(points) {
    return signedArea(points) < 0 ? points.slice().reverse() : points;
  }

  // -----------------------------------------------------------------
  // 6. Greedy edge reduction (hull -> N-gon)
  // -----------------------------------------------------------------

  function boundingBoxDiagonal(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY));
  }

  // Reduces a convex hull to every polygon size from hull.length down to
  // 3 (or until stuck) via greedy minimum-area edge removal, caching
  // every intermediate snapshot. Returns:
  //   { polysByK: Map<k, points[]>, minK, maxK }
  // Lookups for angles outside [minK, maxK] should clamp to the nearest
  // available k (handled by getPolygonForAngleCount()).
  function reduceHullToPolygons(hull) {
    const poly = normalizeWinding(hull);
    const n0 = poly.length;
    const polysByK = new Map();
    polysByK.set(n0, poly.slice());

    if (n0 <= 3) {
      return { polysByK, minK: n0, maxK: n0 };
    }

    const diagonal = boundingBoxDiagonal(poly) || 1;
    const maxIntersectDist = CONFIG.MAX_MITER_FACTOR * diagonal;

    // Doubly linked list over a growing points array. `alive[i]` tracks
    // whether index i is still an active vertex.
    const points = poly.slice();
    const next = new Array(n0);
    const prev = new Array(n0);
    const alive = new Array(n0).fill(true);
    for (let i = 0; i < n0; i++) {
      next[i] = (i + 1) % n0;
      prev[i] = (i - 1 + n0) % n0;
    }

    // cost of removing the edge that starts at vertex `v` (i.e. edge
    // v -> next[v]).
    function edgeCost(v) {
      const p = prev[v];
      const w = next[v];
      const p2 = next[w];
      if (p === w || p2 === v) return { cost: Infinity, point: null }; // degenerate (triangle already)

      const A = points[p], B = points[v]; // prev edge: A -> B
      const D = points[w], E = points[p2]; // next edge: D -> E

      const dirPrev = { x: B.x - A.x, y: B.y - A.y };
      const dirNext = { x: E.x - D.x, y: E.y - D.y };
      const cross = dirPrev.x * dirNext.y - dirPrev.y * dirNext.x;
      const lenPrev = Math.hypot(dirPrev.x, dirPrev.y) || 1;
      const lenNext = Math.hypot(dirNext.x, dirNext.y) || 1;
      if (Math.abs(cross) / (lenPrev * lenNext) < 1e-9) {
        return { cost: Infinity, point: null };
      }

      const I = lineIntersect(A, B, D, E);
      if (!I) return { cost: Infinity, point: null };

      // Parametrize each line in its own forward traversal direction and
      // require the intersection to be a *forward* extension of both
      // (t > 1 beyond B on the A->B line, s < 0 before D on the D->E
      // line) — this is exactly "intersection lies behind the edges"
      // from the spec, and rejects any reflex/degenerate replacement.
      const t = Math.abs(dirPrev.x) > Math.abs(dirPrev.y)
        ? (I.x - A.x) / dirPrev.x
        : (I.y - A.y) / dirPrev.y;
      const s = Math.abs(dirNext.x) > Math.abs(dirNext.y)
        ? (I.x - D.x) / dirNext.x
        : (I.y - D.y) / dirNext.y;
      if (!(t > 1 + 1e-7) || !(s < -1e-7)) {
        return { cost: Infinity, point: null };
      }

      if (Math.hypot(I.x - B.x, I.y - B.y) > maxIntersectDist) {
        return { cost: Infinity, point: null };
      }

      return { cost: triangleArea(B, D, I), point: I };
    }

    const costs = new Map();
    for (let i = 0; i < n0; i++) costs.set(i, edgeCost(i));

    let count = n0;
    let stuck = false;

    while (count > 3) {
      let bestV = -1;
      let bestCost = Infinity;
      for (const [v, c] of costs) {
        if (c.cost < bestCost) { bestCost = c.cost; bestV = v; }
      }
      if (bestV === -1 || !isFinite(bestCost)) { stuck = true; break; }

      const v = bestV;
      const w = next[v];
      const p = prev[v];
      const p2 = next[w];
      const I = costs.get(v).point;

      const newIndex = points.length;
      points.push(I);
      alive.push(true);
      next.push(p2);
      prev.push(p);

      alive[v] = false;
      alive[w] = false;
      costs.delete(v);
      costs.delete(w);
      // The removed edge's OWN cost entry (keyed by v) is gone; also
      // drop w's cost entry (w -> p2 edge) since w no longer exists.

      next[p] = newIndex;
      prev[p2] = newIndex;

      count--;
      costs.set(p, edgeCost(p));
      costs.set(newIndex, edgeCost(newIndex));

      // Snapshot: walk the current loop starting at `p`.
      const snapshot = [];
      let cur = p;
      do {
        snapshot.push(points[cur]);
        cur = next[cur];
      } while (cur !== p);
      polysByK.set(count, snapshot);
    }

    const minK = stuck ? count : 3;
    return { polysByK, minK, maxK: n0 };
  }

  function getPolygonForAngleCount(cache, requestedN) {
    const n = clamp(requestedN, cache.minK, cache.maxK);
    return cache.polysByK.get(n) || cache.polysByK.get(cache.maxK);
  }

  // -----------------------------------------------------------------
  // 7. Polygon offset (angles mode)
  // -----------------------------------------------------------------

  // Offsets a CCW polygon outward by `d`. For a CCW polygon (per the
  // signedArea()/normalizeWinding() convention above — positive signed
  // area, i.e. the winding for which the standard "left of travel is
  // interior" rule holds algebraically for these x,y values) the
  // outward normal of directed edge unit-vector t=(tx,ty) is (ty,-tx):
  // rotating t by -90 deg turns "left of travel" (interior) into
  // "straight ahead", so a further -90 (total -180, i.e. the same as
  // +90) lands on the exterior side — equivalently, (interior-left)
  // rotated a further -90 is the opposite side from interior, which
  // algebraically is (ty,-tx). Every vertex of hull ⊆ every reduced
  // k-gon (edge removal only ever grows the polygon, see §5.6), and this
  // offsets the k-gon outward by d, so clearance from the original
  // design is always >= d.
  function offsetPolygon(poly, d) {
    if (d <= 0) return poly.slice();
    const n = poly.length;
    if (n < 3) return poly.slice();

    // Build each edge's offset line: a point on the line + direction.
    const lines = [];
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const tx = dx / len, ty = dy / len;
      const nx = ty, ny = -tx; // outward normal
      lines.push({
        a: { x: a.x + nx * d, y: a.y + ny * d },
        b: { x: b.x + nx * d, y: b.y + ny * d },
      });
    }

    const maxMiter = CONFIG.MAX_MITER_FACTOR * d;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prevLine = lines[(i - 1 + n) % n];
      const curLine = lines[i];
      const original = poly[i];
      const I = lineIntersect(prevLine.a, prevLine.b, curLine.a, curLine.b);

      if (I && Math.hypot(I.x - original.x, I.y - original.y) <= maxMiter) {
        out.push(I);
      } else {
        // Bevel: use the two raw offset-edge endpoints instead of the
        // (too-far or nonexistent) mitered corner.
        out.push({ x: prevLine.b.x, y: prevLine.b.y });
        out.push({ x: curLine.a.x, y: curLine.a.y });
      }
    }

    return out;
  }

  // -----------------------------------------------------------------
  // 8. Scale helpers
  // -----------------------------------------------------------------

  function unitsToInches(value, unit) {
    return unit === "mm" ? value / CONFIG.MM_PER_IN : value;
  }

  function inchesToUnits(valueIn, unit) {
    return unit === "mm" ? valueIn * CONFIG.MM_PER_IN : valueIn;
  }

  // pxPerUnit at ORIGINAL resolution, where `unit` matches designWidthUnit.
  function computeScale(imageWidthPx, designWidthInUnit) {
    return imageWidthPx / designWidthInUnit;
  }

  function scaleLoop(loop, factor) {
    return loop.map((p) => ({ x: p.x * factor, y: p.y * factor }));
  }

  // -----------------------------------------------------------------
  // Public API (used by the UI section below, and by the Node test
  // harness via module.exports).
  // -----------------------------------------------------------------

  const Geometry = {
    clamp,
    signedArea,
    polygonArea,
    triangleArea,
    lineIntersect,
    pointInPolygon,
    buildInkMask,
    despeckle,
    maskHasInk,
    labelComponents,
    computeEDT,
    marchingSquares,
    rdpSimplifyClosed,
    catmullRomLoopToBezier,
    polygonLoopToPath,
    gatherHullCandidates,
    convexHull,
    normalizeWinding,
    reduceHullToPolygons,
    getPolygonForAngleCount,
    offsetPolygon,
    boundingBoxDiagonal,
    unitsToInches,
    inchesToUnits,
    computeScale,
    scaleLoop,
  };

  root.WeedlineGeometry = Geometry;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Geometry;
  }
})(typeof window !== "undefined" ? window : globalThis);

/* =====================================================================
   UI wiring. Only runs in a real browser (guarded below) so the pure
   geometry above stays unit-testable in plain Node via require().
   ===================================================================== */

if (typeof window !== "undefined" && typeof document !== "undefined") {
  (function () {
    "use strict";

    function init() {
      const G = window.WeedlineGeometry;
      const root = document.getElementById("weedline-app");
      if (!root) return; // not on the Weedline page

      const dropzone = document.getElementById("wl-dropzone");
      const fileInput = document.getElementById("wl-file-input");
      const chooseBtn = document.getElementById("wl-choose-btn");
      const uploadError = document.getElementById("wl-upload-error");

      const canvas = document.getElementById("wl-canvas");
      const ctx = canvas.getContext("2d");
      const emptyMessage = document.getElementById("wl-empty-message");

      const modeBubble = document.getElementById("wl-mode-bubble");
      const modeAngles = document.getElementById("wl-mode-angles");
      const distanceSlider = document.getElementById("wl-distance");
      const distanceValue = document.getElementById("wl-distance-value");
      const anglesGroup = document.getElementById("wl-angles-group");
      const anglesSlider = document.getElementById("wl-angles");
      const anglesValue = document.getElementById("wl-angles-value");

      const designWidthInput = document.getElementById("wl-design-width");
      const unitSelect = document.getElementById("wl-unit");

      const backgroundSelect = document.getElementById("wl-background");
      const thresholdSlider = document.getElementById("wl-threshold");
      const thresholdValue = document.getElementById("wl-threshold-value");
      const specksSlider = document.getElementById("wl-specks");
      const specksValue = document.getElementById("wl-specks-value");

      const exportBoundaryBtn = document.getElementById("wl-export-boundary");
      const exportBothBtn = document.getElementById("wl-export-both");
      const exportPngBtn = document.getElementById("wl-export-png");

      const ALL_CONTROLS = [
        modeBubble, modeAngles, distanceSlider, anglesSlider, designWidthInput,
        unitSelect, backgroundSelect, thresholdSlider, specksSlider,
        exportBoundaryBtn, exportBothBtn, exportPngBtn,
      ];

      const PREVIEW_STROKE_COLOR = "#5a3d7f";
      const PREVIEW_HALO_COLOR = "#ffffff";

      const state = {
        mode: "bubble",
        unit: "in",
        distanceIn: CONFIG.DISTANCE_DEFAULT_IN,
        angles: CONFIG.ANGLES_DEFAULT,
        designWidthIn: CONFIG.DESIGN_WIDTH_DEFAULT_IN,
        background: "auto",
        threshold: CONFIG.THRESHOLD_DEFAULT_ALPHA,
        thresholdTouched: false,
        specksMm2: CONFIG.SPECKS_DEFAULT_MM2,

        fileName: null,
        objectUrl: null,
        originalImage: null,
        originalWidthPx: 0,
        originalHeightPx: 0,
        originalFullResCanvas: null,

        workCanvas: null,
        workWidth: 0,
        workHeight: 0,
        mask: null,
        detectedMode: null,

        distField: null, // bubble cache
        hull: null,
        hullCache: null, // angles cache

        lastLoopsForExport: null,
        rafPending: false,
        hasDesign: false,
      };

      // ---------------------------------------------------------------
      // Small formatting helpers
      // ---------------------------------------------------------------

      function fmt(v, decimals) {
        return v.toFixed(decimals);
      }

      function distanceStepForUnit(unit) {
        return unit === "mm" ? 0.25 : CONFIG.DISTANCE_STEP_IN;
      }

      function distanceMaxForUnit(unit) {
        return unit === "mm" ? Math.round(CONFIG.DISTANCE_MAX_IN * CONFIG.MM_PER_IN * 100) / 100 : CONFIG.DISTANCE_MAX_IN;
      }

      function updateDistanceSliderRange() {
        const unit = state.unit;
        distanceSlider.min = "0";
        distanceSlider.max = String(distanceMaxForUnit(unit));
        distanceSlider.step = String(distanceStepForUnit(unit));
        distanceSlider.value = String(G.inchesToUnits(state.distanceIn, unit));
        distanceValue.textContent = fmt(G.inchesToUnits(state.distanceIn, unit), unit === "mm" ? 2 : 2) + " " + unit;
      }

      function updateDesignWidthInputRange() {
        const unit = state.unit;
        designWidthInput.min = String(G.inchesToUnits(CONFIG.DESIGN_WIDTH_MIN_IN, unit));
        designWidthInput.max = String(G.inchesToUnits(CONFIG.DESIGN_WIDTH_MAX_IN, unit));
        designWidthInput.value = fmt(G.inchesToUnits(state.designWidthIn, unit), 2);
      }

      function updateAnglesValueLabel() {
        anglesValue.textContent = String(state.angles);
      }

      function updateThresholdLabel() {
        thresholdValue.textContent = String(state.threshold);
      }

      function updateSpecksLabel() {
        specksValue.textContent = fmt(state.specksMm2, 1) + " mm²";
      }

      function updateCanvasAriaLabel() {
        if (!state.hasDesign) {
          canvas.setAttribute("aria-label", "No design uploaded yet");
          return;
        }
        const distDisplay = fmt(G.inchesToUnits(state.distanceIn, state.unit), 2) + " " + state.unit;
        const label = state.mode === "bubble"
          ? "Preview: bubble weeding boundary at " + distDisplay + " offset"
          : "Preview: " + state.angles + "-sided angles boundary at " + distDisplay + " offset";
        canvas.setAttribute("aria-label", label);
      }

      // ---------------------------------------------------------------
      // Enable / disable
      // ---------------------------------------------------------------

      function setControlsEnabled(enabled) {
        for (const el of ALL_CONTROLS) el.disabled = !enabled;
        if (!enabled) {
          anglesGroup.hidden = true;
        }
      }

      function updateAnglesAvailability() {
        // Availability depends only on the (always-computed) hull, not on
        // the lazily-built reduction cache -- checking hullCache here
        // would wrongly read as "unavailable" until the user has already
        // switched to angles mode once.
        const available = !!(state.hull && state.hull.length >= 3);
        modeAngles.disabled = !available || !state.hasDesign;
        if (!available && state.mode === "angles") {
          setMode("bubble");
        }
      }

      // ---------------------------------------------------------------
      // Upload handling
      // ---------------------------------------------------------------

      const ACCEPTED_TYPES = ["image/png", "image/svg+xml", "image/jpeg", "image/webp"];

      function showUploadError(message) {
        uploadError.textContent = message;
        uploadError.hidden = false;
      }

      function clearUploadError() {
        uploadError.hidden = true;
        uploadError.textContent = "";
      }

      function processFile(file) {
        clearUploadError();
        if (!file) return;

        if (ACCEPTED_TYPES.indexOf(file.type) === -1) {
          showUploadError("Unsupported file type. Please upload a PNG, SVG, JPEG, or WEBP image.");
          return;
        }

        if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = URL.createObjectURL(file);
        state.fileName = file.name;

        const img = new Image();
        img.onload = function () {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (!w || !h) {
            showUploadError("This file couldn't be read. Please try a different image.");
            return;
          }
          state.originalImage = img;
          state.originalWidthPx = w;
          state.originalHeightPx = h;

          const fullRes = document.createElement("canvas");
          fullRes.width = w;
          fullRes.height = h;
          fullRes.getContext("2d").drawImage(img, 0, 0, w, h);
          state.originalFullResCanvas = fullRes;

          rebuildFromUpload();
        };
        img.onerror = function () {
          showUploadError("This file failed to load. Please try a different image.");
        };
        img.src = state.objectUrl;
      }

      chooseBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files[0]) processFile(fileInput.files[0]);
      });
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("wl-drag-over");
      });
      dropzone.addEventListener("dragleave", () => dropzone.classList.remove("wl-drag-over"));
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("wl-drag-over");
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files[0]) processFile(files[0]);
      });

      // ---------------------------------------------------------------
      // Mask / cache pipeline
      // ---------------------------------------------------------------

      function workPxPerMm() {
        const designWidthMm = G.inchesToUnits(state.designWidthIn, "mm");
        return state.workWidth / designWidthMm;
      }

      function rebuildFromUpload() {
        const iw = state.originalWidthPx, ih = state.originalHeightPx;
        const scale = Math.min(1, CONFIG.WORK_MAX_PX / Math.max(iw, ih));
        const workW = Math.max(1, Math.round(iw * scale));
        const workH = Math.max(1, Math.round(ih * scale));

        const workCanvas = document.createElement("canvas");
        workCanvas.width = workW;
        workCanvas.height = workH;
        const wctx = workCanvas.getContext("2d");
        wctx.clearRect(0, 0, workW, workH);
        wctx.drawImage(state.originalImage, 0, 0, workW, workH);

        state.workCanvas = workCanvas;
        state.workWidth = workW;
        state.workHeight = workH;

        canvas.width = workW;
        canvas.height = workH;

        rebuildMask();
      }

      function rebuildMask() {
        const wctx = state.workCanvas.getContext("2d");
        const imageData = wctx.getImageData(0, 0, state.workWidth, state.workHeight);

        // First pass just to learn which mode applies (alpha vs
        // luminance) -- mode detection doesn't depend on the threshold
        // value, only the final ink comparison does. If the user hasn't
        // deliberately set a threshold yet, swap in the mode-appropriate
        // default and rebuild the mask with THAT threshold, so the very
        // first upload doesn't get built against last mode's default
        // (e.g. alpha's 16 leaking into a luminance-mode image).
        let result = G.buildInkMask(imageData, state.workWidth, state.workHeight, state.threshold, state.background);

        if (!state.thresholdTouched) {
          const modeDefault = result.mode === "alpha" ? CONFIG.THRESHOLD_DEFAULT_ALPHA : CONFIG.THRESHOLD_DEFAULT_LUMINANCE;
          if (modeDefault !== state.threshold) {
            state.threshold = modeDefault;
            thresholdSlider.value = String(state.threshold);
            updateThresholdLabel();
            result = G.buildInkMask(imageData, state.workWidth, state.workHeight, state.threshold, state.background);
          }
        }

        const pxPerMm = workPxPerMm();
        const minAreaPxWork = state.specksMm2 * pxPerMm * pxPerMm;
        G.despeckle(result.mask, state.workWidth, state.workHeight, minAreaPxWork);

        state.mask = result.mask;
        state.detectedMode = result.mode;

        invalidateCaches();

        if (!G.maskHasInk(state.mask)) {
          state.hasDesign = false;
          emptyMessage.textContent = "No design detected. Try adjusting the threshold under Advanced.";
          emptyMessage.hidden = false;
          setControlsEnabled(false);
          updateCanvasAriaLabel();
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          return;
        }

        state.hasDesign = true;
        emptyMessage.hidden = true;
        setControlsEnabled(true);
        // The hull itself is cheap (same cost as building the mask) and
        // availability of angles mode depends on it, so compute it right
        // away regardless of which mode is active. The expensive greedy
        // edge-reduction cache stays lazy -- only built when angles mode
        // is actually used (ensureReductionCache, called from
        // ensureActiveModeCache / render).
        ensureHull();
        updateAnglesAvailability();
        ensureActiveModeCache();
        scheduleRender();
      }

      function invalidateCaches() {
        state.distField = null;
        state.hull = null;
        state.hullCache = null;
      }

      function ensureBubbleCache() {
        if (!state.distField) {
          state.distField = G.computeEDT(state.mask, state.workWidth, state.workHeight);
        }
      }

      function ensureHull() {
        if (state.hull !== null) return;
        const candidates = G.gatherHullCandidates(state.mask, state.workWidth, state.workHeight);
        state.hull = G.convexHull(candidates);
      }

      function ensureReductionCache() {
        ensureHull();
        if (state.hullCache !== null) return;
        state.hullCache = state.hull.length >= 3 ? G.reduceHullToPolygons(state.hull) : null;
      }

      function ensureActiveModeCache() {
        if (state.mode === "bubble") ensureBubbleCache();
        else ensureReductionCache();
      }

      // ---------------------------------------------------------------
      // Render
      // ---------------------------------------------------------------

      function currentOffsetWorkPx() {
        return state.distanceIn * (state.workWidth / state.designWidthIn);
      }

      function scheduleRender() {
        if (state.rafPending) return;
        state.rafPending = true;
        requestAnimationFrame(() => {
          state.rafPending = false;
          render();
        });
      }

      function render() {
        if (!state.hasDesign) return;
        const offsetPx = Math.max(0, currentOffsetWorkPx());
        let pathD = "";

        if (state.mode === "bubble") {
          ensureBubbleCache();
          const loops = G.marchingSquares(state.distField, state.workWidth, state.workHeight, offsetPx);
          const simplified = loops.map((loop) => G.rdpSimplifyClosed(loop, CONFIG.RDP_EPSILON_WORK_PX));
          state.lastLoopsForExport = simplified;
          pathD = simplified.map((loop) => G.catmullRomLoopToBezier(loop, CONFIG.CATMULL_ROM_TENSION)).join(" ");
        } else {
          ensureReductionCache();
          if (state.hullCache) {
            const poly = G.getPolygonForAngleCount(state.hullCache, state.angles);
            const offsetPoly = G.offsetPolygon(poly, offsetPx);
            state.lastLoopsForExport = [offsetPoly];
            pathD = G.polygonLoopToPath(offsetPoly);
          } else {
            state.lastLoopsForExport = [];
          }
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(state.workCanvas, 0, 0);

        if (pathD) {
          const path2d = new Path2D(pathD);
          ctx.lineJoin = "round";
          ctx.strokeStyle = PREVIEW_HALO_COLOR;
          ctx.lineWidth = 4;
          ctx.stroke(path2d);
          ctx.strokeStyle = PREVIEW_STROKE_COLOR;
          ctx.lineWidth = 2;
          ctx.stroke(path2d);
        }

        updateCanvasAriaLabel();
      }

      // ---------------------------------------------------------------
      // Controls wiring
      // ---------------------------------------------------------------

      function setMode(mode) {
        state.mode = mode;
        modeBubble.checked = mode === "bubble";
        modeAngles.checked = mode === "angles";
        anglesGroup.hidden = mode !== "angles";
        if (state.hasDesign) {
          ensureActiveModeCache();
          scheduleRender();
        }
      }

      modeBubble.addEventListener("change", () => { if (modeBubble.checked) setMode("bubble"); });
      modeAngles.addEventListener("change", () => { if (modeAngles.checked) setMode("angles"); });

      distanceSlider.addEventListener("input", () => {
        state.distanceIn = G.unitsToInches(parseFloat(distanceSlider.value), state.unit);
        distanceValue.textContent = fmt(parseFloat(distanceSlider.value), 2) + " " + state.unit;
        scheduleRender();
      });

      anglesSlider.addEventListener("input", () => {
        state.angles = parseInt(anglesSlider.value, 10);
        updateAnglesValueLabel();
        scheduleRender();
      });

      designWidthInput.addEventListener("input", () => {
        const v = parseFloat(designWidthInput.value);
        if (!isFinite(v) || v <= 0) return;
        state.designWidthIn = G.unitsToInches(v, state.unit);
        scheduleRender();
      });

      unitSelect.addEventListener("change", () => {
        state.unit = unitSelect.value;
        updateDistanceSliderRange();
        updateDesignWidthInputRange();
      });

      backgroundSelect.addEventListener("change", () => {
        state.background = backgroundSelect.value;
        if (state.hasDesign) rebuildMask();
      });

      thresholdSlider.addEventListener("input", () => {
        state.threshold = parseInt(thresholdSlider.value, 10);
        state.thresholdTouched = true;
        updateThresholdLabel();
        if (state.hasDesign) rebuildMask();
      });

      specksSlider.addEventListener("input", () => {
        state.specksMm2 = parseFloat(specksSlider.value);
        updateSpecksLabel();
        if (state.hasDesign) rebuildMask();
      });

      // ---------------------------------------------------------------
      // Export
      // ---------------------------------------------------------------

      function baseFilename() {
        const name = state.fileName || "design";
        return name.replace(/\.[^.]+$/, "");
      }

      function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      function exportScaleFactor() {
        return state.originalWidthPx / state.workWidth;
      }

      function pathDataForExport() {
        const factor = exportScaleFactor();
        const loops = (state.lastLoopsForExport || []).map((loop) => G.scaleLoop(loop, factor));
        if (state.mode === "bubble") {
          return loops.map((loop) => G.catmullRomLoopToBezier(loop, CONFIG.CATMULL_ROM_TENSION)).join(" ");
        }
        return loops.map((loop) => G.polygonLoopToPath(loop)).join(" ");
      }

      function buildSvgDocument(includeDesign) {
        const unit = state.unit;
        const widthVal = G.inchesToUnits(state.designWidthIn, unit);
        const aspect = state.originalHeightPx / state.originalWidthPx;
        const heightVal = widthVal * aspect;
        const round2 = (v) => Math.round(v * 100) / 100;
        const pathD = pathDataForExport();

        let imageTag = "";
        if (includeDesign && state.originalFullResCanvas) {
          const dataUrl = state.originalFullResCanvas.toDataURL("image/png");
          imageTag = '<image href="' + dataUrl + '" x="0" y="0" width="' + state.originalWidthPx + '" height="' + state.originalHeightPx + '" />\n  ';
        }

        return (
          '<svg xmlns="http://www.w3.org/2000/svg" width="' + round2(widthVal) + unit + '" height="' + round2(heightVal) + unit + '" ' +
          'viewBox="0 0 ' + state.originalWidthPx + " " + state.originalHeightPx + '">\n  ' +
          imageTag +
          '<path d="' + pathD + '" fill="none" stroke="' + CONFIG.SVG_STROKE_COLOR + '" stroke-width="' + CONFIG.SVG_STROKE_WIDTH + '" />\n' +
          "</svg>\n"
        );
      }

      exportBoundaryBtn.addEventListener("click", () => {
        const blob = new Blob([buildSvgDocument(false)], { type: "image/svg+xml" });
        downloadBlob(blob, baseFilename() + "-boundary.svg");
      });

      exportBothBtn.addEventListener("click", () => {
        const blob = new Blob([buildSvgDocument(true)], { type: "image/svg+xml" });
        downloadBlob(blob, baseFilename() + "-boundary-design.svg");
      });

      exportPngBtn.addEventListener("click", () => {
        canvas.toBlob((blob) => {
          if (!blob) return;
          downloadBlob(blob, baseFilename() + "-preview.png");
        }, "image/png");
      });

      // ---------------------------------------------------------------
      // Initial state
      // ---------------------------------------------------------------

      setControlsEnabled(false);
      updateDistanceSliderRange();
      updateDesignWidthInputRange();
      updateAnglesValueLabel();
      updateThresholdLabel();
      updateSpecksLabel();
      updateCanvasAriaLabel();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  })();
}
