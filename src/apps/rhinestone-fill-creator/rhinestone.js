/* Rhinestone Fill Creator — UI. Geometry, SVG and zip live in core.js.
   All lengths in state are inches; spacing is kept in mm (how stones are sold). */
(function () {
  "use strict";
  var core = window.RhinestoneCore;
  var $ = function (id) { return document.getElementById(id); };

  var PALETTE = [
    { name: "Crystal", hex: "#f7f9fc" }, { name: "Crystal AB", hex: "#d6e6f2" },
    { name: "Jet", hex: "#1c1c22" }, { name: "Silver", hex: "#b9bcc4" },
    { name: "Gold", hex: "#d9a93a" }, { name: "Light Peach", hex: "#f6c1a8" },
    { name: "Rose", hex: "#f2a0c0" }, { name: "Fuchsia", hex: "#d62a82" },
    { name: "Siam Red", hex: "#c8202f" }, { name: "Orange", hex: "#f08a24" },
    { name: "Topaz", hex: "#f0c24a" }, { name: "Peridot", hex: "#a8d44a" },
    { name: "Emerald", hex: "#1f9d6a" }, { name: "Aqua", hex: "#6fc9d8" },
    { name: "Sapphire", hex: "#2a5bc0" }, { name: "Amethyst", hex: "#7a4bb8" },
  ];

  var state = {
    area: { w: 8, h: 10 },
    img: null, // { el, url, ratio, x, y, w, opacity }
    kit: { 10: true },
    activeSS: 10, // size for hand-placed stones
    fillSS: 10, // size for the generated fill
    altSS: 0, // second fill size for checkerboard alternation (0 = none)
    colors: [PALETTE[0].hex], // selected, in selection order
    activeColor: PALETTE[0].hex,
    cycle: false,
    fillMode: "none",
    spacingMM: 3.2,
    manual: [], // [{ x, y, ss, color }]
    fill: [],
    undo: [],
    tool: "place",
    zoom: 60, // css px per inch
  };

  var canvas = $("rf-canvas"), ghost = $("rf-ghost"), ctx = canvas.getContext("2d"), gctx = ghost.getContext("2d");
  var viewport = $("rf-viewport"), stage = $("rf-stage");
  var exportUrls = [];

  function radiusIn(ss) { return core.mmToIn(core.ssMm(ss)) / 2; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmt(n, d) { return String(Math.round(n * Math.pow(10, d)) / Math.pow(10, d)); }

  /* ---------------- colors ---------------- */
  function colorFor(i) {
    if (state.cycle && state.colors.length > 1) return state.colors[i % state.colors.length];
    return state.activeColor;
  }
  var placeCount = 0; // rotates colors for hand-placed stones

  function buildColorUI() {
    var wrap = $("rf-colors");
    wrap.innerHTML = "";
    var all = PALETTE.slice();
    state.colors.forEach(function (hex) {
      if (!all.some(function (p) { return p.hex === hex; })) all.push({ name: hex, hex: hex });
    });
    all.forEach(function (p) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "rf-swatch";
      b.style.background = p.hex;
      b.title = p.name;
      b.setAttribute("aria-label", p.name);
      b.setAttribute("aria-pressed", state.colors.indexOf(p.hex) >= 0 ? "true" : "false");
      b.dataset.active = String(p.hex === state.activeColor);
      b.addEventListener("click", function () { toggleColor(p.hex); });
      wrap.appendChild(b);
    });
  }
  function toggleColor(hex) {
    var i = state.colors.indexOf(hex);
    if (i >= 0 && hex !== state.activeColor) {
      state.activeColor = hex; // selected but not active: make it active
    } else if (i >= 0) {
      if (state.colors.length === 1) return; // keep at least one
      state.colors.splice(i, 1);
      state.activeColor = state.colors[state.colors.length - 1];
    } else {
      state.colors.push(hex);
      state.activeColor = hex;
    }
    buildColorUI();
    refill();
  }

  /* ---------------- sizes ---------------- */
  function buildSizeUI() {
    var wrap = $("rf-sizes");
    wrap.innerHTML = "";
    core.SS_SIZES.forEach(function (s) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "rf-chip";
      b.innerHTML = "SS" + s.ss + "<small>" + s.mm + " mm</small>";
      b.setAttribute("aria-pressed", state.kit[s.ss] ? "true" : "false");
      b.addEventListener("click", function () {
        if (state.kit[s.ss]) {
          if (Object.keys(state.kit).length === 1) return;
          delete state.kit[s.ss];
        } else {
          state.kit[s.ss] = true;
          state.activeSS = s.ss;
        }
        if (!state.kit[state.activeSS]) state.activeSS = kitSizes()[0];
        onFillSizeChanged();
        drawGhost(null);
      });
      wrap.appendChild(b);
    });
    if (!state.kit[state.fillSS]) state.fillSS = kitSizes()[0];
    fillSizeOptions($("rf-active-size"), state.activeSS);
    fillSizeOptions($("rf-fill-size"), state.fillSS);
    if (!state.kit[state.altSS] || state.altSS === state.fillSS) state.altSS = 0;
    fillSizeOptions($("rf-alt-size"), state.altSS, state.fillSS);
  }
  function fillSizeOptions(sel, current, skip) {
    sel.innerHTML = "";
    if (skip) {
      var none = document.createElement("option");
      none.value = 0;
      none.textContent = "None (single size)";
      none.selected = !current;
      sel.appendChild(none);
    }
    kitSizes().forEach(function (ss) {
      if (ss === skip) return;
      var o = document.createElement("option");
      o.value = ss;
      o.textContent = "SS" + ss + " (" + core.ssMm(ss) + " mm)";
      if (ss === current) o.selected = true;
      sel.appendChild(o);
    });
  }
  function kitSizes() {
    return Object.keys(state.kit).map(Number).sort(function (a, b) { return a - b; });
  }
  // Smallest spacing at which stones can't overlap. A checkerboard grid only
  // ever puts unlike sizes side by side, so it can sit tighter than rings can.
  function minSpacingMM() {
    var a = core.ssMm(state.fillSS);
    if (!state.altSS) return a;
    var b = core.ssMm(state.altSS);
    return state.fillMode === "grid" ? (a + b) / 2 : Math.max(a, b);
  }
  function onFillSizeChanged() {
    buildSizeUI();
    var d = minSpacingMM();
    $("rf-spacing").min = d;
    if (state.spacingMM < d) state.spacingMM = d;
    $("rf-spacing").value = state.spacingMM;
    updateSpacingLabel();
    refill();
  }
  function updateSpacingLabel() {
    $("rf-spacing-val").textContent = fmt(state.spacingMM, 2) + " mm (" + fmt(core.mmToIn(state.spacingMM), 3) + " in)";
  }

  /* ---------------- fill ---------------- */
  var fillWarn = "";
  function recomputeFill() {
    fillWarn = "";
    state.fill = [];
    if (state.fillMode === "none") return;
    var s = core.mmToIn(state.spacingMM), r = Math.max(radiusIn(state.fillSS), state.altSS ? radiusIn(state.altSS) : 0);
    if (core.estimateFillCount(state.area.w, state.area.h, s) > 120000) {
      fillWarn = "That would be too many stones to draw. Increase the spacing or shrink the area.";
      return;
    }
    var pts = state.fillMode === "grid"
      ? core.gridFill(state.area.w, state.area.h, s, r)
      : core.radialFill(state.area.w, state.area.h, s, r);
    state.fill = pts.map(function (p, i) { return { x: p.x, y: p.y, ss: state.altSS && p.parity ? state.altSS : state.fillSS, color: colorFor(i) }; });
  }
  var raf = 0;
  function refill() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      recomputeFill();
      draw();
      updateUI();
    });
  }

  function snapshot() { return { manual: state.manual.slice(), fillMode: state.fillMode }; }
  function pushUndo(snap) {
    state.undo.push(snap || snapshot());
    if (state.undo.length > 60) state.undo.shift();
  }
  function undo() {
    var s = state.undo.pop();
    if (!s) return;
    state.manual = s.manual;
    state.fillMode = s.fillMode;
    syncFillRadios();
    recomputeFill();
    draw();
    updateUI();
  }
  function syncFillRadios() {
    document.querySelectorAll('input[name="rf-fill"]').forEach(function (r) { r.checked = r.value === state.fillMode; });
  }
  /* Turn the generated fill into hand-editable stones. */
  function bake() {
    if (!state.fill.length) return false;
    pushUndo();
    state.manual = state.fill.concat(state.manual);
    state.fill = [];
    state.fillMode = "none";
    syncFillRadios();
    return true;
  }

  /* ---------------- drawing ---------------- */
  function sizeCanvases() {
    var cssW = state.area.w * state.zoom, cssH = state.area.h * state.zoom;
    var dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, 8192 / Math.max(cssW, cssH)));
    [canvas, ghost].forEach(function (c) {
      c.style.width = cssW + "px";
      c.style.height = cssH + "px";
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    });
  }
  function paintStones(g, list, k) {
    var lw = 1 / state.zoom;
    g.lineWidth = lw;
    g.strokeStyle = "rgba(30,20,45,0.55)";
    var lastColor = null, lastSS = -1, r = 0;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.ss !== lastSS) { r = radiusIn(s.ss); lastSS = s.ss; }
      if (s.color !== lastColor) { g.fillStyle = s.color; lastColor = s.color; }
      g.beginPath();
      g.arc(s.x, s.y, r, 0, 6.2832);
      g.fill();
      g.stroke();
    }
  }
  function draw() {
    var k = canvas.width / state.area.w;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    var im = state.img;
    if (im) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, state.area.w, state.area.h);
      ctx.clip();
      ctx.globalAlpha = im.opacity;
      ctx.drawImage(im.el, im.x, im.y, im.w, im.w * im.ratio);
      ctx.restore();
    }
    paintStones(ctx, state.fill, k);
    paintStones(ctx, state.manual, k);
  }
  function drawGhost(pos) {
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.clearRect(0, 0, ghost.width, ghost.height);
    if (!pos || state.tool === "image") return;
    var k = ghost.width / state.area.w;
    gctx.setTransform(k, 0, 0, k, 0, 0);
    gctx.lineWidth = 1.5 / state.zoom;
    if (state.tool === "place") {
      gctx.fillStyle = state.activeColor;
      gctx.globalAlpha = 0.6;
      gctx.beginPath();
      gctx.arc(pos.x, pos.y, radiusIn(state.activeSS), 0, 6.2832);
      gctx.fill();
      gctx.globalAlpha = 1;
      gctx.strokeStyle = "#5c2d91";
      gctx.stroke();
    } else {
      var hit = hitTest(pos.x, pos.y);
      if (hit) {
        gctx.strokeStyle = "#c8202f";
        gctx.lineWidth = 2.5 / state.zoom;
        gctx.beginPath();
        gctx.arc(hit.stone.x, hit.stone.y, radiusIn(hit.stone.ss) + 2 / state.zoom, 0, 6.2832);
        gctx.stroke();
      }
    }
  }

  /* ---------------- hit testing and editing ---------------- */
  function hitTest(x, y) {
    var best = null, bestD = Infinity;
    function scan(list, kind) {
      for (var i = list.length - 1; i >= 0; i--) {
        var s = list[i], d = Math.hypot(s.x - x, s.y - y);
        var reach = Math.max(radiusIn(s.ss), 6 / state.zoom);
        if (d <= reach && d < bestD) { best = { kind: kind, index: i, stone: s }; bestD = d; }
      }
    }
    scan(state.manual, "manual");
    scan(state.fill, "fill");
    return best;
  }
  function placeAt(x, y) {
    if (x < 0 || y < 0 || x > state.area.w || y > state.area.h) return;
    pushUndo();
    var color = colorFor(placeCount++);
    state.manual = state.manual.concat([{ x: x, y: y, ss: state.activeSS, color: color }]);
    draw();
    updateUI();
  }
  var gestureSnap = null;
  function deleteAt(x, y) {
    var hit = hitTest(x, y);
    if (!hit) return;
    if (!gestureSnap) gestureSnap = snapshot();
    if (hit.kind === "fill") {
      // Bake the fill without its own undo step (the gesture snapshot covers it).
      // Fill stones go first, so the hit index is still right.
      state.manual = state.fill.concat(state.manual);
      state.fill = [];
      state.fillMode = "none";
      syncFillRadios();
    }
    var next = state.manual.slice();
    next.splice(hit.index, 1);
    state.manual = next;
    draw();
    updateUI();
  }
  function commitGesture() {
    if (gestureSnap) { pushUndo(gestureSnap); gestureSnap = null; updateUI(); }
  }

  function posFromEvent(e) {
    var r = ghost.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * state.area.w, y: (e.clientY - r.top) / r.height * state.area.h };
  }
  var drag = null, tap = null, sweeping = false;
  ghost.addEventListener("pointerdown", function (e) {
    var pos = posFromEvent(e);
    if (state.tool === "image") {
      if (!state.img) return;
      ghost.setPointerCapture(e.pointerId);
      drag = { sx: pos.x, sy: pos.y, ix: state.img.x, iy: state.img.y };
    } else if (e.pointerType === "touch") {
      tap = { cx: e.clientX, cy: e.clientY };
    } else {
      ghost.setPointerCapture(e.pointerId);
      if (state.tool === "place") placeAt(pos.x, pos.y);
      else { sweeping = true; deleteAt(pos.x, pos.y); }
    }
  });
  ghost.addEventListener("pointermove", function (e) {
    var pos = posFromEvent(e);
    if (drag) {
      state.img.x = drag.ix + (pos.x - drag.sx);
      state.img.y = drag.iy + (pos.y - drag.sy);
      syncImageInputs();
      draw();
      return;
    }
    if (sweeping) deleteAt(pos.x, pos.y);
    if (e.pointerType !== "touch") drawGhost(pos);
  });
  ghost.addEventListener("pointerup", function (e) {
    if (tap && Math.hypot(e.clientX - tap.cx, e.clientY - tap.cy) < 8) {
      var pos = posFromEvent(e);
      if (state.tool === "place") placeAt(pos.x, pos.y);
      else { deleteAt(pos.x, pos.y); commitGesture(); }
    }
    tap = null; drag = null; sweeping = false;
    commitGesture();
  });
  ghost.addEventListener("pointercancel", function () { tap = null; drag = null; sweeping = false; commitGesture(); });
  ghost.addEventListener("pointerleave", function () { if (!sweeping) drawGhost(null); });

  /* ---------------- UI sync ---------------- */
  function setStatus(msg) { $("rf-status").textContent = msg || ""; }
  function counts() {
    var by = {}, total = 0;
    state.fill.concat(state.manual).forEach(function (s) { by[s.ss] = (by[s.ss] || 0) + 1; total++; });
    return { by: by, total: total };
  }
  function updateUI() {
    var c = counts();
    var parts = Object.keys(c.by).map(Number).sort(function (a, b) { return a - b; }).map(function (ss) { return "SS" + ss + " × " + c.by[ss]; });
    setStatus(fillWarn || (c.total ? c.total + " stone" + (c.total === 1 ? "" : "s") + " — " + parts.join(", ") : "No stones yet. Choose a fill, or click the canvas to place stones."));
    $("rf-bake").disabled = !state.fill.length;
    $("rf-undo").disabled = !state.undo.length;
    $("rf-clear").disabled = !state.manual.length;
    $("rf-download").disabled = !c.total;
  }
  function setTool(tool) {
    state.tool = tool;
    stage.dataset.tool = tool;
    document.querySelectorAll(".rf-tool").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.tool === tool)); });
    drawGhost(null);
  }

  function setZoom(z) {
    state.zoom = clamp(z, 5, Math.min(400, 8000 / Math.max(state.area.w, state.area.h)));
    sizeCanvases();
    draw();
  }
  function fit() {
    var availW = viewport.clientWidth - 26, availH = viewport.clientHeight - 26;
    setZoom(Math.min(availW / state.area.w, availH / state.area.h));
  }

  /* ---------------- area + image inputs ---------------- */
  function onAreaInput() {
    var w = parseFloat($("rf-area-w").value), h = parseFloat($("rf-area-h").value);
    if (!(w >= 0.25) || !(h >= 0.25)) return;
    state.area.w = Math.min(w, 40);
    state.area.h = Math.min(h, 40);
    sizeCanvases();
    fit();
    refill();
  }
  function syncImageInputs() {
    var im = state.img;
    if (!im) return;
    $("rf-img-w").value = fmt(im.w, 3);
    $("rf-img-x").value = fmt(im.x, 3);
    $("rf-img-y").value = fmt(im.y, 3);
  }
  function placeImage(mode) {
    var im = state.img, aw = state.area.w, ah = state.area.h;
    var scale = mode === "cover" ? Math.max(aw, ah / im.ratio) : Math.min(aw, ah / im.ratio);
    im.w = scale;
    im.x = (aw - im.w) / 2;
    im.y = (ah - im.w * im.ratio) / 2;
    syncImageInputs();
    draw();
  }
  function loadImage(file) {
    var err = $("rf-image-error");
    err.hidden = true;
    if (!file || !/^image\//.test(file.type)) { err.textContent = "That doesn't look like an image file."; err.hidden = false; return; }
    var url = URL.createObjectURL(file), el = new Image();
    el.onload = function () {
      if (state.img) URL.revokeObjectURL(state.img.url);
      var nw = el.naturalWidth || el.width || 1, nh = el.naturalHeight || el.height || 1;
      state.img = { el: el, url: url, ratio: nh / nw, x: 0, y: 0, w: 1, opacity: parseInt($("rf-img-opacity").value, 10) / 100 };
      placeImage("fit");
      $("rf-image-controls").hidden = false;
      $("rf-tool-image").disabled = false;
    };
    el.onerror = function () {
      URL.revokeObjectURL(url);
      err.textContent = "Couldn't read that image. Try a PNG or JPEG.";
      err.hidden = false;
    };
    el.src = url;
  }
  function removeImage() {
    if (!state.img) return;
    URL.revokeObjectURL(state.img.url);
    state.img = null;
    $("rf-image-controls").hidden = true;
    $("rf-tool-image").disabled = true;
    $("rf-image-input").value = "";
    if (state.tool === "image") setTool("place");
    draw();
  }

  /* ---------------- export ---------------- */
  function download(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    exportUrls.push(url);
    return url;
  }
  function doExport() {
    var status = $("rf-export-status"), links = $("rf-export-links");
    exportUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    exportUrls = [];
    links.innerHTML = "";
    var w = state.area.w, h = state.area.h;
    var all = state.fill.concat(state.manual).filter(function (s) { return s.x >= 0 && s.y >= 0 && s.x <= w && s.y <= h; });
    var dropped = state.fill.length + state.manual.length - all.length;
    if (!all.length) { status.textContent = "Nothing to export — no stones sit inside the working area."; return; }
    var color = $("rf-export-color").checked;
    var split = document.querySelector('input[name="rf-export"]:checked').value === "split";
    function svgFor(stones, title) { return core.buildSvg({ width: w, height: h, stones: stones, color: color, title: title }); }
    function addLink(name, blob) {
      var a = document.createElement("a");
      a.textContent = name;
      a.download = name;
      a.href = URL.createObjectURL(blob);
      exportUrls.push(a.href);
      links.appendChild(a);
    }
    var note = dropped ? " (" + dropped + " stone" + (dropped === 1 ? "" : "s") + " outside the area left out.)" : "";
    var sizes = Object.keys(all.reduce(function (m, s) { m[s.ss] = 1; return m; }, {})).map(Number).sort(function (a, b) { return a - b; });
    if (!split || sizes.length === 1) {
      var name = split ? "rhinestones-SS" + sizes[0] + ".svg" : "rhinestones-all.svg";
      var blob = new Blob([svgFor(all, "Rhinestone fill")], { type: "image/svg+xml" });
      download(name, blob);
      addLink(name, blob);
      status.textContent = "Saved " + name + " — " + all.length + " stones, " + fmt(w, 3) + " × " + fmt(h, 3) + " in." + note;
      return;
    }
    var files = sizes.map(function (ss) {
      var stones = all.filter(function (s) { return s.ss === ss; });
      return { name: "rhinestones-SS" + ss + ".svg", text: svgFor(stones, "Rhinestone fill SS" + ss), count: stones.length };
    });
    download("rhinestones-by-size.zip", new Blob([core.makeZip(files)], { type: "application/zip" }));
    files.forEach(function (f) { addLink(f.name, new Blob([f.text], { type: "image/svg+xml" })); });
    status.textContent = "Saved rhinestones-by-size.zip with " + files.length + " files (" + files.map(function (f) { return "SS" + f.name.match(/SS(\d+)/)[1] + " × " + f.count; }).join(", ") + ")." + note + " Individual files:";
  }

  /* ---------------- wiring ---------------- */
  function init() {
    buildSizeUI();
    buildColorUI();
    $("rf-spacing").min = minSpacingMM();
    state.spacingMM = Math.ceil(core.ssMm(state.fillSS) * 1.15 * 20) / 20;
    $("rf-spacing").value = state.spacingMM;
    updateSpacingLabel();
    stage.dataset.tool = "place";

    $("rf-area-w").addEventListener("input", onAreaInput);
    $("rf-area-h").addEventListener("input", onAreaInput);

    $("rf-choose-image").addEventListener("click", function () { $("rf-image-input").click(); });
    $("rf-image-input").addEventListener("change", function (e) { loadImage(e.target.files[0]); });
    viewport.addEventListener("dragover", function (e) { e.preventDefault(); });
    viewport.addEventListener("drop", function (e) {
      e.preventDefault();
      if (e.dataTransfer.files[0]) loadImage(e.dataTransfer.files[0]);
    });
    $("rf-img-w").addEventListener("input", function (e) {
      var v = parseFloat(e.target.value);
      if (state.img && v > 0) { state.img.w = v; draw(); }
    });
    $("rf-img-x").addEventListener("input", function (e) {
      var v = parseFloat(e.target.value);
      if (state.img && isFinite(v)) { state.img.x = v; draw(); }
    });
    $("rf-img-y").addEventListener("input", function (e) {
      var v = parseFloat(e.target.value);
      if (state.img && isFinite(v)) { state.img.y = v; draw(); }
    });
    $("rf-img-opacity").addEventListener("input", function (e) {
      $("rf-img-opacity-val").textContent = e.target.value + "%";
      if (state.img) { state.img.opacity = e.target.value / 100; draw(); }
    });
    $("rf-img-fit").addEventListener("click", function () { placeImage("fit"); });
    $("rf-img-cover").addEventListener("click", function () { placeImage("cover"); });
    $("rf-img-remove").addEventListener("click", removeImage);

    $("rf-active-size").addEventListener("change", function (e) {
      state.activeSS = parseInt(e.target.value, 10);
    });
    $("rf-fill-size").addEventListener("change", function (e) {
      state.fillSS = parseInt(e.target.value, 10);
      onFillSizeChanged();
    });
    $("rf-alt-size").addEventListener("change", function (e) {
      state.altSS = parseInt(e.target.value, 10);
      onFillSizeChanged();
    });
    $("rf-add-color").addEventListener("click", function () {
      var hex = $("rf-custom-color").value.toLowerCase();
      if (state.colors.indexOf(hex) < 0) state.colors.push(hex);
      state.activeColor = hex;
      buildColorUI();
      refill();
    });
    $("rf-cycle").addEventListener("change", function (e) { state.cycle = e.target.checked; refill(); });

    document.querySelectorAll('input[name="rf-fill"]').forEach(function (r) {
      r.addEventListener("change", function () { state.fillMode = r.value; onFillSizeChanged(); });
    });
    $("rf-spacing").addEventListener("input", function (e) {
      state.spacingMM = parseFloat(e.target.value);
      updateSpacingLabel();
      refill();
    });
    $("rf-bake").addEventListener("click", function () {
      if (bake()) { draw(); updateUI(); }
    });

    document.querySelectorAll(".rf-tool").forEach(function (b) {
      b.addEventListener("click", function () { setTool(b.dataset.tool); });
    });
    $("rf-undo").addEventListener("click", undo);
    $("rf-clear").addEventListener("click", function () {
      if (!state.manual.length) return;
      pushUndo();
      state.manual = [];
      draw();
      updateUI();
    });
    $("rf-zoom-in").addEventListener("click", function () { setZoom(state.zoom * 1.25); });
    $("rf-zoom-out").addEventListener("click", function () { setZoom(state.zoom / 1.25); });
    $("rf-zoom-fit").addEventListener("click", fit);
    window.addEventListener("resize", function () { if (viewport.clientWidth) fit(); });
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault();
        undo();
      }
    });
    $("rf-download").addEventListener("click", doExport);

    sizeCanvases();
    fit();
    recomputeFill();
    draw();
    updateUI();
  }
  init();
})();
