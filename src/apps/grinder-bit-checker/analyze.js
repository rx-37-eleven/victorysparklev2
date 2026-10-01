/* =====================================================================
   GRINDER BIT CHECKER — analysis core
   ---------------------------------------------------------------------
   Pure computation, no DOM. Loaded by the Web Worker (importScripts) and
   by the Node tests (require), so it exposes itself both ways.

   Pipeline
     1. Binarize: dark pixels are "line", everything else is "glass".
     2. Label the glass regions; any region touching the image edge is
        the outside of the pattern, which is not glass.
     3. Thin the line mask to a 1px centerline (Zhang–Suen), prune spurs,
        and split the centerline into paths at junctions.
     4. Resample each path to 1px spacing and Gaussian-smooth it.
     5. Along each path measure the radius of curvature (circumradius of
        three points ±H apart). Mask out corners (turning concentrated in
        a very short span) and anything near a junction or path end.
     6. A sample is "inside" when the glass region on its convex side is
        real glass. Contiguous tight inside samples form one run; the
        tightest sample of each run becomes one spot.
   ===================================================================== */
(function (root) {
  "use strict";

  // Tuning constants, all in inches so they scale with the piece size.
  var SMOOTH_SIGMA_IN = 0.025;  // Gaussian smoothing of the centerline
  var HALF_WINDOW_IN = 0.075;   // curvature window half-length (H)
  var CORNER_SPAN_IN = 0.05;    // short span used to detect concentrated turning
  var CORNER_MIN_DEG = 25;      // ignore concentrated turns below this
  var CORNER_RATIO = 0.5;       // short-span turn / long-span turn above this = corner
  var CORNER_SIGMA_PX = 1.6;    // light smoothing used only for corner detection
  var WINDOW_STEPS = 4;         // curvature window may grow to this many times H
  var FLAG_TOLERANCE = 0.03;    // a curve within 3% of a bit is treated as fitting it (pixel noise is ~1.5%)
  var MIN_RUN_IN = 0.04;        // ignore runs shorter than this

  function luma(rgba, n) {
    var g = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var a = rgba[i * 4 + 3] / 255;
      var l = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
      g[i] = Math.round(l * a + 255 * (1 - a)); // composite over white
    }
    return g;
  }

  // ---- Euclidean distance transform (Felzenszwalb) ----------------------
  // Distance from each line pixel to the nearest non-line pixel.
  function edt1d(f, n, d, v, z) {
    var k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  function edt(line, W, H) {
    var INF = 1e12;
    var out = new Float32Array(W * H);
    var n = Math.max(W, H);
    var f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    var tmp = new Float64Array(W * H);
    var x, y;
    for (x = 0; x < W; x++) {
      for (y = 0; y < H; y++) f[y] = line[y * W + x] ? INF : 0;
      edt1d(f, H, d, v, z);
      for (y = 0; y < H; y++) tmp[y * W + x] = d[y];
    }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) f[x] = tmp[y * W + x];
      edt1d(f, W, d, v, z);
      for (x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  // ---- connected components of glass (4-connected) ----------------------
  function labelGlass(line, W, H) {
    var lab = new Int32Array(W * H);
    var stack = new Int32Array(W * H);
    var next = 0, outside = [false];
    for (var s = 0; s < W * H; s++) {
      if (line[s] || lab[s]) continue;
      next++;
      var sp = 0, touches = false;
      stack[sp++] = s; lab[s] = next;
      while (sp) {
        var p = stack[--sp], x = p % W, y = (p - x) / W;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
        if (x > 0 && !line[p - 1] && !lab[p - 1]) { lab[p - 1] = next; stack[sp++] = p - 1; }
        if (x < W - 1 && !line[p + 1] && !lab[p + 1]) { lab[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && !line[p - W] && !lab[p - W]) { lab[p - W] = next; stack[sp++] = p - W; }
        if (y < H - 1 && !line[p + W] && !lab[p + W]) { lab[p + W] = next; stack[sp++] = p + W; }
      }
      outside.push(touches);
    }
    return { lab: lab, outside: outside };
  }

  // ---- Zhang–Suen thinning ---------------------------------------------
  function thin(mask, W, H) {
    var m = new Uint8Array(mask);
    var rm = [];
    var changed = true;
    while (changed) {
      changed = false;
      for (var pass = 0; pass < 2; pass++) {
        rm.length = 0;
        for (var y = 1; y < H - 1; y++) {
          for (var x = 1; x < W - 1; x++) {
            var i = y * W + x;
            if (!m[i]) continue;
            var p2 = m[i - W], p3 = m[i - W + 1], p4 = m[i + 1], p5 = m[i + W + 1],
                p6 = m[i + W], p7 = m[i + W - 1], p8 = m[i - 1], p9 = m[i - W - 1];
            var B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            var A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
                    (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
            if (A !== 1) continue;
            if (pass === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
            else { if (p2 * p4 * p8 || p2 * p6 * p8) continue; }
            rm.push(i);
          }
        }
        if (rm.length) { changed = true; for (var k = 0; k < rm.length; k++) m[rm[k]] = 0; }
      }
    }
    return m;
  }

  var DX = [0, 1, 1, 1, 0, -1, -1, -1];
  var DY = [-1, -1, 0, 1, 1, 1, 0, -1];

  // Crossing number: number of 0->1 transitions around the 8-neighbourhood.
  function crossing(m, i, W) {
    var c = 0, last = m[i + DY[7] * W + DX[7]];
    for (var k = 0; k < 8; k++) {
      var cur = m[i + DY[k] * W + DX[k]];
      if (cur && !last) c++;
      last = cur;
    }
    return c;
  }

  // Remove dangling branches shorter than maxLen (spurs from bumpy edges).
  function pruneSpurs(m, W, H, maxLen) {
    for (var round = 0; round < 3; round++) {
      var removedAny = false;
      for (var y = 1; y < H - 1; y++) {
        for (var x = 1; x < W - 1; x++) {
          var i = y * W + x;
          if (!m[i] || crossing(m, i, W) !== 1) continue;
          // walk from this endpoint until a junction
          var path = [i], cur = i, prev = -1, hitJunction = false;
          while (path.length <= maxLen) {
            var nxt = -1, cnt = 0;
            for (var k = 0; k < 8; k++) {
              var j = cur + DY[k] * W + DX[k];
              if (m[j] && j !== prev) { cnt++; if (nxt < 0) nxt = j; }
            }
            if (cnt === 0) break;
            if (cnt > 1 || crossing(m, nxt, W) >= 3) { hitJunction = true; break; }
            prev = cur; cur = nxt; path.push(cur);
          }
          if (hitJunction && path.length <= maxLen) {
            for (var q = 0; q < path.length; q++) m[path[q]] = 0;
            removedAny = true;
          }
        }
      }
      if (!removedAny) break;
    }
  }

  // ---- split skeleton into ordered paths ---------------------------------
  function tracePaths(m, W, H) {
    var junction = new Uint8Array(W * H);
    var jlist = [];
    for (var y = 1; y < H - 1; y++) {
      for (var x = 1; x < W - 1; x++) {
        var i = y * W + x;
        if (m[i] && crossing(m, i, W) >= 3) { junction[i] = 1; jlist.push(i); }
      }
    }
    var body = new Uint8Array(W * H);
    for (i = 0; i < body.length; i++) body[i] = m[i] && !junction[i] ? 1 : 0;

    var ORDER = [0, 2, 4, 6, 1, 3, 5, 7]; // 4-connected steps before diagonals
    function neighbours(p) {
      var out = [];
      for (var kk = 0; kk < 8; kk++) {
        var k = ORDER[kk], j = p + DY[k] * W + DX[k];
        if (body[j]) out.push(j);
      }
      return out;
    }
    function touchesJunction(p) {
      for (var k = 0; k < 8; k++) if (junction[p + DY[k] * W + DX[k]]) return true;
      return false;
    }

    var visited = new Uint8Array(W * H);
    var paths = [];
    function walk(start) {
      var pts = [start], cur = start;
      visited[start] = 1;
      while (true) {
        var ns = neighbours(cur), nxt = -1;
        for (var a = 0; a < ns.length; a++) if (!visited[ns[a]]) { nxt = ns[a]; break; }
        if (nxt < 0) break;
        visited[nxt] = 1; pts.push(nxt); cur = nxt;
      }
      return pts;
    }
    function degree(p) {
      var d = 0;
      for (var k = 0; k < 8; k++) if (body[p + DY[k] * W + DX[k]]) d++;
      return d;
    }
    function emit(pts, closed) {
      if (pts.length < 8) return;
      var xs = new Float64Array(pts.length), ys = new Float64Array(pts.length);
      for (var a = 0; a < pts.length; a++) { xs[a] = pts[a] % W; ys[a] = (pts[a] - xs[a]) / W; }
      var first = pts[0], last = pts[pts.length - 1];
      var jStart = touchesJunction(first), jEnd = touchesJunction(last);
      // a chain whose two ends meet is a closed loop
      if (!closed && !jStart && !jEnd) {
        var dx = xs[0] - xs[xs.length - 1], dy = ys[0] - ys[ys.length - 1];
        if (dx * dx + dy * dy <= 2 && pts.length > 12) closed = true;
      }
      paths.push({ xs: xs, ys: ys, closed: closed, jStart: jStart, jEnd: jEnd });
    }
    // open chains first (start from endpoints), then whatever is left is a loop
    for (var p = W + 1; p < W * H - W - 1; p++) {
      if (body[p] && !visited[p] && degree(p) === 1) emit(walk(p), false);
    }
    for (p = W + 1; p < W * H - W - 1; p++) {
      if (body[p] && !visited[p]) emit(walk(p), false);
    }
    return paths;
  }

  // ---- geometry helpers ---------------------------------------------------
  function resample(xs, ys, closed) {
    var n = xs.length, cum = [0];
    var m = closed ? n + 1 : n;
    for (var i = 1; i < m; i++) {
      var a = i % n, b = i - 1;
      cum.push(cum[i - 1] + Math.hypot(xs[a] - xs[b], ys[a] - ys[b]));
    }
    var total = cum[m - 1], count = Math.max(2, Math.floor(total));
    var rx = new Float64Array(count), ry = new Float64Array(count);
    var seg = 0;
    for (var s = 0; s < count; s++) {
      var t = closed ? s * total / count : s * total / (count - 1);
      while (seg < m - 2 && cum[seg + 1] < t) seg++;
      var a2 = seg % n, b2 = (seg + 1) % n;
      var span = cum[seg + 1] - cum[seg] || 1, u = (t - cum[seg]) / span;
      rx[s] = xs[a2] + (xs[b2] - xs[a2]) * u;
      ry[s] = ys[a2] + (ys[b2] - ys[a2]) * u;
    }
    return { x: rx, y: ry };
  }

  function gaussian(arr, sigma, closed) {
    var r = Math.ceil(sigma * 3), k = new Float64Array(2 * r + 1), sum = 0;
    for (var i = -r; i <= r; i++) { k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); sum += k[i + r]; }
    var n = arr.length, out = new Float64Array(n);
    for (var j = 0; j < n; j++) {
      var acc = 0, wsum = 0;
      for (var t = -r; t <= r; t++) {
        var idx = j + t;
        if (closed) idx = ((idx % n) + n) % n;
        else if (idx < 0 || idx >= n) continue;
        acc += arr[idx] * k[t + r]; wsum += k[t + r];
      }
      out[j] = acc / wsum;
    }
    return out;
  }

  // Least-squares circle (Kåsa) through the points idx..idx+len-1 of a path.
  // Averaging over the window keeps pixel noise from reading as curvature.
  function fitCircle(xs, ys, at, from, to) {
    var N = to - from + 1, mx = 0, my = 0, k;
    for (k = from; k <= to; k++) { mx += xs[at(k)]; my += ys[at(k)]; }
    mx /= N; my /= N;
    var suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, suuv = 0;
    for (k = from; k <= to; k++) {
      var u = xs[at(k)] - mx, v = ys[at(k)] - my;
      suu += u * u; svv += v * v; suv += u * v;
      suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; suuv += u * u * v;
    }
    var det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-9 * (suu + svv) * (suu + svv)) return null;
    var b1 = (suuu + suvv) / 2, b2 = (svvv + suuv) / 2;
    var A = (b1 * svv - b2 * suv) / det, B = (suu * b2 - suv * b1) / det;
    var r2 = A * A + B * B + (suu + svv) / N;
    return { r: Math.sqrt(r2), cx: A + mx, cy: B + my };
  }

  function fitRms(xs, ys, at, from, to, c) {
    var sum = 0;
    for (var k = from; k <= to; k++) {
      var e = Math.hypot(xs[at(k)] - c.cx, ys[at(k)] - c.cy) - c.r;
      sum += e * e;
    }
    return Math.sqrt(sum / (to - from + 1));
  }

  // Distance from (x,y) along (dx,dy) to the first non-line sample (half-pixel steps).
  function edgeDist(line, W, H, x, y, dx, dy, limit) {
    for (var t = 0; t <= limit; t += 0.5) {
      var px = Math.floor(x + dx * t), py = Math.floor(y + dy * t);
      if (px < 0 || py < 0 || px >= W || py >= H || !line[py * W + px]) return t;
    }
    return limit;
  }

  /**
   * analyze({ gray, width, height, ppi, bits, onProgress })
   *   gray   Uint8Array luma, width*height, already stretched to the piece shape
   *   ppi    image pixels per inch
   *   bits   selected bit diameters in inches
   * returns { spots: [{ n, bit, diameter, x, y, cx, cy, minDiameter }] }
   *   x,y     centre of the tightest point on the centerline (inches)
   *   cx,cy   dot centre, on the concave side, tangent to the centerline (inches)
   *   diameter measured curve diameter (inches); bit chosen dot size (inches)
   */
  function analyze(opts) {
    var gray = opts.gray, W = opts.width, H = opts.height, ppi = opts.ppi;
    var bits = opts.bits.slice().sort(function (a, b) { return a - b; });
    var progress = opts.onProgress || function () {};
    var maxBit = bits[bits.length - 1] * (1 - FLAG_TOLERANCE);

    progress("Finding lines…", 0.05);
    var line = new Uint8Array(W * H);
    for (var i = 0; i < line.length; i++) line[i] = gray[i] < 128 ? 1 : 0;
    // a 1px frame of non-line so thinning never touches the array edge
    var lg = labelGlass(line, W, H);

    progress("Measuring line thickness…", 0.2);
    var dist = edt(line, W, H);

    progress("Tracing centerlines…", 0.35);
    var skel = thin(line, W, H);
    var maxHalf = 0;
    for (i = 0; i < skel.length; i++) if (skel[i] && dist[i] > maxHalf) maxHalf = dist[i];
    pruneSpurs(skel, W, H, Math.max(6, Math.round(maxHalf * 1.5 + 4)));
    var paths = tracePaths(skel, W, H);

    progress("Measuring curves…", 0.6);
    var sigma = Math.max(1.5, SMOOTH_SIGMA_IN * ppi);
    var h = Math.max(4, Math.round(HALF_WINDOW_IN * ppi));
    var cs = Math.max(2, Math.round(CORNER_SPAN_IN * ppi));
    var fitTol = Math.max(0.4, 0.0025 * ppi); // px: worst circle-fit residual still treated as one arc
    var minRun = Math.max(3, Math.round(MIN_RUN_IN * ppi));
    var spots = [];

    for (var pi = 0; pi < paths.length; pi++) {
      var P = paths[pi];
      var rs = resample(P.xs, P.ys, P.closed);
      var n = rs.x.length;
      if (n < 2 * h + 3 && !P.closed) continue;
      function at(k) { return P.closed ? ((k % n) + n) % n : k; }
      // The skeleton wobbles by a pixel or two; re-centre every sample on the
      // line's true cross-section (midpoint of the two edges along the normal).
      var rx = rs.x, ry = rs.y;
      for (var iter = 0; iter < 2; iter++) {
        var tx = gaussian(rx, 3, P.closed), ty = gaussian(ry, 3, P.closed);
        var nxr = new Float64Array(n), nyr = new Float64Array(n);
        for (var k = 0; k < n; k++) {
          var a0 = P.closed ? at(k - 2) : Math.max(0, k - 2), a1 = P.closed ? at(k + 2) : Math.min(n - 1, k + 2);
          var ux = tx[a1] - tx[a0], uy = ty[a1] - ty[a0], ul = Math.hypot(ux, uy) || 1;
          var vx = -uy / ul, vy = ux / ul; // unit normal
          var tPos = edgeDist(line, W, H, rx[k], ry[k], vx, vy, maxHalf + 4);
          var tNeg = edgeDist(line, W, H, rx[k], ry[k], -vx, -vy, maxHalf + 4);
          var shift = (tPos - tNeg) / 2;
          nxr[k] = rx[k] + vx * shift; nyr[k] = ry[k] + vy * shift;
        }
        rx = nxr; ry = nyr;
      }
      var sx = gaussian(rx, sigma, P.closed), sy = gaussian(ry, sigma, P.closed);

      // tangent angle, for the corner test
      var lx = gaussian(rs.x, CORNER_SIGMA_PX, P.closed), ly = gaussian(rs.y, CORNER_SIGMA_PX, P.closed);
      var ang = new Float64Array(n);
      for (var k = 0; k < n; k++) {
        var k0 = P.closed ? at(k - 3) : Math.max(0, k - 3), k1 = P.closed ? at(k + 3) : Math.min(n - 1, k + 3);
        ang[k] = Math.atan2(ly[k1] - ly[k0], lx[k1] - lx[k0]);
      }
      function turn(k, half) {
        var d = ang[P.closed ? at(k + half) : k + half] - ang[P.closed ? at(k - half) : k - half];
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
      }

      var valid = new Uint8Array(n), dia = new Float64Array(n), ccx = new Float64Array(n), ccy = new Float64Array(n);
      var corner = new Uint8Array(n);
      var lo = P.closed ? 0 : h, hi = P.closed ? n : n - h;
      var cLo = P.closed ? 0 : h, cHi = P.closed ? n : n - h;
      for (k = lo; k < hi; k++) {
        // Widen the window while one circle still fits it well: long arcs get a
        // low-noise radius, short tight arcs stay local.
        var c = null;
        for (var wi = 1; wi <= WINDOW_STEPS; wi++) {
          var hw2 = h * wi;
          if (P.closed ? 2 * hw2 + 1 > n : (k - hw2 < 0 || k + hw2 >= n)) break;
          var cand = fitCircle(sx, sy, at, k - hw2, k + hw2);
          if (!cand || cand.r > 50 * ppi) break;
          if (wi > 1 && fitRms(sx, sy, at, k - hw2, k + hw2, cand) > fitTol) break;
          c = cand;
        }
        if (!c) continue;
        dia[k] = 2 * c.r / ppi; ccx[k] = c.cx; ccy[k] = c.cy; valid[k] = 1;
      }
      if (opts.debug) opts.debug.push({ sx: sx, sy: sy, dia: dia, closed: P.closed });
      // corners: turning concentrated in the short span relative to the long one
      for (k = cLo; k < cHi; k++) {
        var short = Math.abs(turn(k, cs >> 1)), long = Math.abs(turn(k, h));
        if (short * 180 / Math.PI >= CORNER_MIN_DEG && short >= CORNER_RATIO * long) corner[k] = 1;
      }
      // grow corner mask by the window, and mask the ends near junctions
      var junctionPad = Math.round(maxHalf * 1.5 + 2);
      var bad = new Uint8Array(n);
      for (k = 0; k < n; k++) {
        if (!corner[k]) continue;
        for (var t = -h; t <= h; t++) { var q = k + t; if (P.closed) q = at(q); if (q >= 0 && q < n) bad[q] = 1; }
      }
      if (!P.closed) {
        for (k = 0; k < n; k++) {
          if (P.jStart && k < junctionPad) bad[k] = 1;
          if (P.jEnd && n - 1 - k < junctionPad) bad[k] = 1;
        }
      }

      // convex-side test and run grouping
      var inside = new Uint8Array(n);
      for (k = 0; k < n; k++) {
        if (!valid[k] || bad[k] || dia[k] >= maxBit) continue;
        var nx = ccx[k] - sx[k], ny = ccy[k] - sy[k], nl = Math.hypot(nx, ny);
        nx /= nl; ny /= nl;
        // step toward the convex side (away from centre) until we leave the line
        var px = sx[k], py = sy[k], lab = 0;
        var cxp = Math.round(px), cyp = Math.round(py);
        var hw = (cxp >= 0 && cxp < W && cyp >= 0 && cyp < H) ? dist[cyp * W + cxp] : 3;
        for (var step = Math.max(1, hw - 1); step < hw + 12; step += 1) {
          var qx = Math.round(px - nx * step), qy = Math.round(py - ny * step);
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) { lab = 0; break; }
          var id = qy * W + qx;
          if (!line[id]) {
            // one more pixel out so we are clearly inside the region
            var rx = Math.round(px - nx * (step + 2)), ry = Math.round(py - ny * (step + 2));
            if (rx >= 0 && ry >= 0 && rx < W && ry < H && !line[ry * W + rx]) lab = lg.lab[ry * W + rx];
            else lab = lg.lab[id];
            break;
          }
        }
        if (lab && !lg.outside[lab]) inside[k] = 1;
      }

      // runs of consecutive inside samples
      var startK = 0;
      if (P.closed) {
        var allInside = true;
        for (k = 0; k < n; k++) if (!inside[k]) { allInside = false; startK = k + 1; break; }
        if (allInside) startK = 0;
      }
      var runBest = -1, runLen = 0;
      function flush() {
        if (runBest >= 0 && runLen >= minRun) {
          var d = dia[runBest], bit = bits[0], bestDiff = Infinity;
          for (var b = 0; b < bits.length; b++) {
            var diff = Math.abs(bits[b] - d);
            if (diff < bestDiff - 1e-9) { bestDiff = diff; bit = bits[b]; }
          }
          var nx2 = ccx[runBest] - sx[runBest], ny2 = ccy[runBest] - sy[runBest], l2 = Math.hypot(nx2, ny2);
          nx2 /= l2; ny2 /= l2;
          var rad = bit * ppi / 2;
          spots.push({
            bit: bit, diameter: d,
            x: sx[runBest] / ppi, y: sy[runBest] / ppi,
            cx: (sx[runBest] + nx2 * rad) / ppi, cy: (sy[runBest] + ny2 * rad) / ppi,
            minDiameter: d
          });
        }
        runBest = -1; runLen = 0;
      }
      for (var s = 0; s < n; s++) {
        var kk = P.closed ? (startK + s) % n : s;
        if (inside[kk]) {
          runLen++;
          if (runBest < 0 || dia[kk] < dia[runBest]) runBest = kk;
        } else flush();
      }
      flush();
    }

    // number spots top-to-bottom, left-to-right so the list reads naturally
    spots.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
    for (i = 0; i < spots.length; i++) spots[i].n = i + 1;
    progress("Done", 1);
    return { spots: spots };
  }

  var api = { analyze: analyze, luma: luma };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BitAnalyze = api;
})(typeof self !== "undefined" ? self : globalThis);
