/* =====================================================================
   GRINDER BIT CHECKER — page logic
   ---------------------------------------------------------------------
   Upload a pattern, enter its finished size, pick bits, and this page
   hands the pixels to analysis-worker.js (which runs analyze.js off the
   main thread). It then draws the result over the pattern and builds the
   downloads. Everything runs in the browser; no image data leaves it.

   All the tunable numbers are in CONFIG just below.
   ===================================================================== */

const CONFIG = {
  // Bits offered as presets. Colors are Okabe–Ito (color-blind-safe) with
  // black and every blue left out, so dots never disappear into the pattern
  // lines or read as blue.
  BITS: [
    { inches: 1,     label: "1″",   color: "#D55E00" }, // vermillion
    { inches: 0.75,  label: "3/4″", color: "#009E73" }, // bluish green
    { inches: 0.375, label: "3/8″", color: "#CC79A7" }, // reddish purple
  ],
  DOT_ALPHA: 0.55,           // dot opacity, on screen and in exports

  ANALYSIS_MAX_PX: 2400,     // longest side of the raster the analysis sees
  ANALYSIS_MAX_PPI: 400,
  LOW_PPI_WARNING: 60,       // below this, tell the user measurements are coarse

  EXPORT_DPI: 300,
  EXPORT_MAX_PIXELS: 100e6,  // never ask a canvas for more than this
  DPI_BACKOFF: 0.97,         // each failed canvas probe lowers DPI by this factor

  MAX_SIZE_IN: 500,
  ZOOM_MAX: 16,
  CM_PER_IN: 2.54,
};

/* ---------------------------------------------------------------------
   DO NOT EDIT BELOW THIS LINE unless you're comfortable with the code.
   --------------------------------------------------------------------- */

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const els = {
    drop: $("gb-dropzone"), choose: $("gb-choose-btn"), file: $("gb-file-input"), uploadError: $("gb-upload-error"),
    workspace: $("gb-workspace"),
    width: $("gb-width"), height: $("gb-height"), unit: $("gb-unit"), lock: $("gb-lock"), stretchNote: $("gb-stretch-note"),
    bits: $("gb-bits"), run: $("gb-run"), status: $("gb-status"),
    downloadPanel: $("gb-download-panel"), download: $("gb-download"), exportStatus: $("gb-export-status"), exportLinks: $("gb-export-links"),
    showDots: $("gb-show-dots"), zoomIn: $("gb-zoom-in"), zoomOut: $("gb-zoom-out"), zoomFit: $("gb-zoom-fit"),
    viewport: $("gb-viewport"), stage: $("gb-stage"), canvas: $("gb-canvas"), overlay: $("gb-overlay"), legend: $("gb-legend"),
    minAngle: $("gb-min-angle"), minAngleValue: $("gb-min-angle-value"),
    spotsPanel: $("gb-spots-panel"), spotsTitle: $("gb-spots-title"), spotsNote: $("gb-spots-note"), spots: $("gb-spots"),
  };

  const state = {
    src: null,         // { img, w, h, name }
    minAngle: 0,
    dismissed: new Set(),
    result: null,      // { spots, size: {w,h} inches, bits: [bit] }
    worker: null,
    busy: false,
    exportUrls: [],
  };

  /* ---------- units & size ---------- */

  const unit = () => els.unit.value;
  const toInches = (v) => (unit() === "cm" ? v / CONFIG.CM_PER_IN : v);
  const fromInches = (v) => (unit() === "cm" ? v * CONFIG.CM_PER_IN : v);
  const round = (v) => String(Math.round(v * 100) / 100);
  const fmtLen = (inches) => unit() === "cm" ? (inches * CONFIG.CM_PER_IN).toFixed(1) + " cm" : inches.toFixed(2) + " in";

  function enteredSize() {
    const w = toInches(parseFloat(els.width.value)), h = toInches(parseFloat(els.height.value));
    if (!(w > 0) || !(h > 0) || w > CONFIG.MAX_SIZE_IN || h > CONFIG.MAX_SIZE_IN) return null;
    return { w, h };
  }

  function selectedBits() {
    return [...els.bits.querySelectorAll("input:checked")].map((i) => CONFIG.BITS[+i.value]);
  }

  function refreshControls() {
    els.run.disabled = state.busy || !state.src || !enteredSize() || selectedBits().length === 0;
    const size = enteredSize();
    els.stretchNote.hidden = !(state.src && size && !els.lock.checked &&
      Math.abs(size.w / size.h / (state.src.w / state.src.h) - 1) > 0.01);
  }

  function onWidthInput() {
    if (els.lock.checked && state.src) {
      const w = parseFloat(els.width.value);
      els.height.value = w > 0 ? round(w * state.src.h / state.src.w) : "";
    }
    sizeChanged();
  }
  function onHeightInput() {
    if (els.lock.checked && state.src) {
      const h = parseFloat(els.height.value);
      els.width.value = h > 0 ? round(h * state.src.w / state.src.h) : "";
    }
    sizeChanged();
  }
  function onUnitChange() {
    const prev = unit() === "cm" ? "in" : "cm"; // value shown before the change
    const k = prev === "in" ? CONFIG.CM_PER_IN : 1 / CONFIG.CM_PER_IN;
    for (const el of [els.width, els.height]) {
      const v = parseFloat(el.value);
      if (v > 0) el.value = round(v * k);
    }
    if (state.result) refreshSpots(); // re-render lengths in the new unit
    refreshControls();
  }
  function sizeChanged() {
    invalidate("Size changed. Check the pattern again.");
    renderPreview();
    refreshControls();
  }

  /* ---------- loading the pattern ---------- */

  function showUploadError(msg) { els.uploadError.textContent = msg; els.uploadError.hidden = !msg; }

  // SVGs without a pixel size (viewBox only) draw at 0x0 in some browsers, so
  // give them an explicit width/height before rasterizing.
  function prepareSvg(text) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.documentElement;
    if (doc.querySelector("parsererror") || svg.localName !== "svg") throw new Error("That SVG file couldn't be read.");
    const num = (v) => (v && !/%/.test(v) ? parseFloat(v) : NaN);
    let w = num(svg.getAttribute("width")), h = num(svg.getAttribute("height"));
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      if (!(w > 0) && !(h > 0)) { w = vb[2]; h = vb[3]; }
      else if (!(w > 0)) w = h * vb[2] / vb[3];
      else if (!(h > 0)) h = w * vb[3] / vb[2];
    }
    if (!(w > 0) || !(h > 0)) throw new Error("That SVG has no size or viewBox, so it can't be measured.");
    if (!svg.getAttribute("viewBox")) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(svg);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That image couldn't be opened."));
      img.src = url;
    });
  }

  async function loadFile(file) {
    showUploadError("");
    if (!file) return;
    const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    const isRaster = /^image\/(png|jpeg)$/.test(file.type);
    if (!isSvg && !isRaster) { showUploadError("Please choose a PNG, JPEG or SVG file."); return; }
    try {
      let url;
      if (isSvg) url = URL.createObjectURL(new Blob([prepareSvg(await file.text())], { type: "image/svg+xml" }));
      else url = URL.createObjectURL(file);
      const img = await loadImage(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error("That image has no size.");
      if (state.src) URL.revokeObjectURL(state.src.url);
      state.src = { img, w, h, url, name: file.name.replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "") || "pattern" };
    } catch (err) {
      showUploadError(err.message);
      return;
    }
    els.workspace.hidden = false;
    invalidate("");
    // keep a size the user already typed; re-derive the other side from the new image
    if (els.lock.checked && els.width.value) onWidthInput(); else sizeChanged();
    renderPreview();
    fitView();
    refreshControls();
  }

  /* ---------- drawing the stretched pattern ---------- */

  // White background, then the pattern stretched to fill the canvas exactly.
  function drawPattern(ctx, W, H) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(state.src.img, 0, 0, W, H);
  }

  function analysisDims(size) {
    const ppi = Math.min(CONFIG.ANALYSIS_MAX_PPI, CONFIG.ANALYSIS_MAX_PX / Math.max(size.w, size.h));
    return { W: Math.max(16, Math.round(size.w * ppi)), H: Math.max(16, Math.round(size.h * ppi)) };
  }

  function renderPreview() {
    if (!state.src) return;
    const size = enteredSize();
    let W, H;
    if (size) ({ W, H } = analysisDims(size));
    else { const k = Math.min(1, 1600 / Math.max(state.src.w, state.src.h)); W = Math.round(state.src.w * k); H = Math.round(state.src.h * k); }
    els.canvas.width = W;
    els.canvas.height = H;
    drawPattern(els.canvas.getContext("2d", { willReadFrequently: true }), W, H);
    state.previewKey = size ? size.w + "x" + size.h : null;
    layoutStage();
  }

  /* ---------- zoom & pan ---------- */

  const view = { k: 1, x: 0, y: 0, fitW: 0, fitH: 0 };
  const pointers = new Map();
  let gesture = null;
  let tap = null;

  function layoutStage() {
    const vw = els.viewport.clientWidth, vh = els.viewport.clientHeight;
    const cw = els.canvas.width, ch = els.canvas.height;
    if (!vw || !vh || !cw) return;
    const s = Math.min(vw / cw, vh / ch);
    view.fitW = cw * s; view.fitH = ch * s;
    els.stage.style.width = view.fitW + "px";
    els.stage.style.height = view.fitH + "px";
    const size = state.result ? state.result.size : (enteredSize() || { w: cw, h: ch });
    els.overlay.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`);
    clampView();
    applyView();
  }
  function clampView() {
    const vw = els.viewport.clientWidth, vh = els.viewport.clientHeight;
    const sw = view.fitW * view.k, sh = view.fitH * view.k;
    view.x = sw <= vw ? (vw - sw) / 2 : Math.min(0, Math.max(vw - sw, view.x));
    view.y = sh <= vh ? (vh - sh) / 2 : Math.min(0, Math.max(vh - sh, view.y));
  }
  function applyView() { els.stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`; }
  function fitView() { view.k = 1; clampView(); applyView(); }
  function zoomAt(factor, cx, cy) {
    const k = Math.min(CONFIG.ZOOM_MAX, Math.max(1, view.k * factor));
    const r = k / view.k;
    view.x = cx - (cx - view.x) * r;
    view.y = cy - (cy - view.y) * r;
    view.k = k;
    clampView(); applyView();
  }
  function centerOf() { return [els.viewport.clientWidth / 2, els.viewport.clientHeight / 2]; }

  function pointerPos(e) {
    const r = els.viewport.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function startGesture() {
    const pts = [...pointers.values()];
    if (pts.length === 1) gesture = { type: "pan", sx: pts[0][0], sy: pts[0][1], x: view.x, y: view.y };
    else if (pts.length >= 2) {
      const [a, b] = pts;
      gesture = { type: "pinch", d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, k: view.k, x: view.x, y: view.y };
    } else gesture = null;
  }
  els.viewport.addEventListener("pointerdown", (e) => {
    els.viewport.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, pointerPos(e));
    tap = pointers.size === 1 ? { id: e.pointerId, pos: pointerPos(e) } : null;
    startGesture();
    els.viewport.classList.add("gb-panning");
  });
  els.viewport.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, pointerPos(e));
    if (!gesture) return;
    const pts = [...pointers.values()];
    if (gesture.type === "pan" && pts.length === 1) {
      view.x = gesture.x + pts[0][0] - gesture.sx;
      view.y = gesture.y + pts[0][1] - gesture.sy;
    } else if (gesture.type === "pinch" && pts.length >= 2) {
      const [a, b] = pts;
      const k = Math.min(CONFIG.ZOOM_MAX, Math.max(1, gesture.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / gesture.d));
      const r = k / gesture.k;
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      // keep the content point under the original pinch centre under the current centre
      view.x = cx - (gesture.cx - gesture.x) * r;
      view.y = cy - (gesture.cy - gesture.y) * r;
      view.k = k;
    }
    clampView(); applyView();
  });
  function endPointer(e) {
    if (tap && e.type === "pointerup" && tap.id === e.pointerId) {
      const [x, y] = pointerPos(e);
      if (Math.hypot(x - tap.pos[0], y - tap.pos[1]) < 6) handleTap(x, y);
    }
    tap = null;
    pointers.delete(e.pointerId);
    startGesture();
    if (!pointers.size) els.viewport.classList.remove("gb-panning");
  }
  els.viewport.addEventListener("pointerup", endPointer);
  els.viewport.addEventListener("pointercancel", endPointer);
  els.viewport.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // plain scrolling still scrolls the page; trackpad pinch arrives as ctrl+wheel
    e.preventDefault();
    const [x, y] = pointerPos(e);
    zoomAt(Math.exp(-e.deltaY * 0.01), x, y);
  }, { passive: false });
  els.zoomIn.addEventListener("click", () => { const [x, y] = centerOf(); zoomAt(1.5, x, y); });
  els.zoomOut.addEventListener("click", () => { const [x, y] = centerOf(); zoomAt(1 / 1.5, x, y); });
  els.zoomFit.addEventListener("click", fitView);
  if ("ResizeObserver" in window) new ResizeObserver(layoutStage).observe(els.viewport);
  else window.addEventListener("resize", layoutStage);

  /* ---------- running the analysis ---------- */

  function setStatus(msg) { els.status.textContent = msg || ""; }

  function invalidate(msg) {
    state.result = null;
    els.overlay.replaceChildren();
    els.spots.replaceChildren();
    els.spotsPanel.hidden = true;
    els.downloadPanel.hidden = true;
    els.showDots.disabled = true;
    clearExportLinks();
    els.exportStatus.textContent = "";
    renderLegend();
    setStatus(msg || "");
  }

  function renderLegend() {
    const bits = state.result ? state.result.bits : selectedBits();
    els.legend.replaceChildren(...bits.map((b) => {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "gb-swatch";
      sw.style.background = b.color;
      li.append(sw, document.createTextNode(b.label + " bit"));
      return li;
    }));
  }

  function runAnalysis() {
    const size = enteredSize(), bits = selectedBits();
    if (!state.src || !size || !bits.length || state.busy) return;
    invalidate("");
    renderPreview();
    const W = els.canvas.width, H = els.canvas.height, ppi = W / size.w;
    const ctx = els.canvas.getContext("2d", { willReadFrequently: true });
    const rgba = ctx.getImageData(0, 0, W, H).data;
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;

    state.busy = true; refreshControls();
    let note = "";
    if (ppi < CONFIG.LOW_PPI_WARNING) note = " This is a large piece, so measurements are less precise.";
    setStatus("Analyzing…" + note);

    let worker;
    try { worker = new Worker("/apps/grinder-bit-checker/analysis-worker.js"); }
    catch (err) { state.busy = false; refreshControls(); setStatus("Your browser couldn't start the analysis worker."); return; }
    state.worker = worker;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") setStatus(m.message + note);
      else if (m.type === "done") {
        worker.terminate(); state.worker = null; state.busy = false;
        state.result = { spots: m.spots, size, bits };
        showResult();
        refreshControls();
      } else if (m.type === "error") {
        worker.terminate(); state.worker = null; state.busy = false;
        setStatus("Something went wrong analyzing that pattern: " + m.message);
        refreshControls();
      }
    };
    worker.onerror = () => {
      worker.terminate(); state.worker = null; state.busy = false;
      setStatus("Something went wrong analyzing that pattern.");
      refreshControls();
    };
    worker.postMessage({ gray, width: W, height: H, ppi, bits: bits.map((b) => b.inches) }, [gray.buffer]);
  }

  /* ---------- showing the result ---------- */

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs) {
    const e = document.createElementNS(SVG_NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  const bitFor = (inches) => CONFIG.BITS.find((b) => b.inches === inches);

  const shownSpots = () => state.result.spots.filter((s) => s.angle >= state.minAngle);
  const activeSpots = () => shownSpots().filter((s) => !state.dismissed.has(s.n));

  function showResult() {
    const { size } = state.result;
    state.dismissed = new Set();
    els.overlay.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`);
    els.showDots.disabled = false;
    renderLegend();
    refreshSpots();
    els.downloadPanel.hidden = false;
    layoutStage();
    fitView();
    els.viewport.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function toggleSpot(s) {
    if (state.dismissed.has(s.n)) state.dismissed.delete(s.n); else state.dismissed.add(s.n);
    refreshSpots();
  }

  // Redraws dots, the list and the status line from state. Cheap, so the
  // slider and toggles call it on every change.
  function refreshSpots() {
    const shown = shownSpots(), active = activeSpots(), total = state.result.spots.length;
    const dots = svgEl("g", { id: "gb-dots" });
    for (const s of shown) {
      if (state.dismissed.has(s.n)) {
        dots.append(svgEl("circle", { cx: s.cx, cy: s.cy, r: s.bit / 2, class: "gb-off-dot" }));
        continue;
      }
      dots.append(svgEl("circle", { cx: s.cx, cy: s.cy, r: s.bit / 2, fill: bitFor(s.bit).color, "fill-opacity": CONFIG.DOT_ALPHA }));
    }
    for (const s of active) {
      const t = svgEl("text", { x: s.cx, y: s.cy, class: "gb-num", "font-size": Math.min(0.35, s.bit * 0.45), "dominant-baseline": "central" });
      t.textContent = s.n;
      dots.append(t);
    }
    els.overlay.replaceChildren(dots);
    dots.style.display = els.showDots.checked ? "" : "none";

    els.spotsPanel.hidden = false;
    els.spotsTitle.textContent = shown.length ? `Flagged spots (${active.length})` : "Flagged spots";
    els.spotsNote.textContent = shown.length
      ? "Each dot is the size of the bit closest to that curve's measured diameter. Uncheck a spot (or tap its dot) to dismiss it; dismissed dots are left out of downloads. Tap a spot's name to zoom to it."
      : total ? "Every spot is hidden by the bend slider." : "Nothing to flag. If you expected something, check the finished size and that the pattern's outer border is drawn.";
    els.spots.replaceChildren(...shown.map((s) => {
      const bit = bitFor(s.bit), off = state.dismissed.has(s.n);
      const li = document.createElement("li");
      li.className = off ? "gb-off" : "";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.className = "gb-spot-toggle"; cb.checked = !off;
      cb.setAttribute("aria-label", `Include spot ${s.n}`);
      cb.addEventListener("change", () => toggleSpot(s));
      const btn = document.createElement("button");
      btn.type = "button";
      const sw = document.createElement("span");
      sw.className = "gb-swatch"; sw.style.background = bit.color;
      const n = document.createElement("span");
      n.className = "gb-spot-n"; n.textContent = "#" + s.n;
      const txt = document.createElement("span");
      txt.textContent = `${bit.label} bit · curve diameter ${fmtLen(s.diameter)} · bend ${Math.round(s.angle)}°`;
      btn.append(sw, n, txt);
      btn.addEventListener("click", () => focusSpot(s));
      li.append(cb, btn);
      return li;
    }));

    const hidden = total - shown.length, dismissed = shown.length - active.length;
    const extra = [hidden ? `${hidden} hidden by the bend slider` : "", dismissed ? `${dismissed} dismissed` : ""].filter(Boolean).join(", ");
    setStatus(!total ? "No inside curves are too tight for the bits you selected."
      : `${active.length} spot${active.length === 1 ? "" : "s"} flagged${extra ? " (" + extra + ")" : ""}.`);
  }

  // Tap on the preview: toggle the nearest visible dot under the finger.
  function handleTap(px, py) {
    if (!state.result || !view.fitW) return;
    const { size } = state.result;
    const ix = (px - view.x) / (view.fitW * view.k) * size.w, iy = (py - view.y) / (view.fitH * view.k) * size.h;
    let best = null, bestD = Infinity;
    for (const s of shownSpots()) {
      const d = Math.hypot(ix - s.cx, iy - s.cy);
      if (d <= s.bit / 2 && d < bestD) { best = s; bestD = d; }
    }
    if (best) toggleSpot(best);
  }

  function focusSpot(s) {
    const { size } = state.result;
    const k = Math.min(CONFIG.ZOOM_MAX, Math.max(3, view.k));
    const px = (s.cx / size.w) * view.fitW * k, py = (s.cy / size.h) * view.fitH * k;
    view.k = k;
    view.x = els.viewport.clientWidth / 2 - px;
    view.y = els.viewport.clientHeight / 2 - py;
    clampView(); applyView();
    for (const old of els.overlay.querySelectorAll(".gb-ring")) old.remove();
    const ring = svgEl("circle", { cx: s.cx, cy: s.cy, r: s.bit / 2 + 0.03, class: "gb-ring" });
    els.overlay.append(ring);
    setTimeout(() => ring.remove(), 2500);
    els.viewport.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /* ---------- export ---------- */

  function clearExportLinks() {
    els.exportLinks.replaceChildren();
    for (const u of state.exportUrls) URL.revokeObjectURL(u);
    state.exportUrls = [];
  }

  function canvasWorks(W, H) {
    try {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const ctx = c.getContext("2d");
      if (!ctx) return false;
      ctx.fillStyle = "#000";
      ctx.fillRect(W - 1, H - 1, 1, 1);
      const ok = ctx.getImageData(W - 1, H - 1, 1, 1).data[3] === 255;
      c.width = c.height = 0; // release the memory now
      return ok;
    } catch (e) { return false; }
  }

  // Highest DPI (up to 300) at which this browser will give us a canvas.
  function pickDpi(size) {
    let dpi = Math.min(CONFIG.EXPORT_DPI, Math.floor(Math.sqrt(CONFIG.EXPORT_MAX_PIXELS / (size.w * size.h))));
    while (dpi >= 10) {
      const W = Math.round(size.w * dpi), H = Math.round(size.h * dpi);
      if (canvasWorks(W, H)) return dpi;
      dpi = Math.floor(dpi * CONFIG.DPI_BACKOFF);
    }
    return 0;
  }

  function makeCanvas(W, H) {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    return c;
  }

  function buildLayers(size, dpi) {
    const W = Math.round(size.w * dpi), H = Math.round(size.h * dpi);
    const pattern = makeCanvas(W, H);
    drawPattern(pattern.getContext("2d"), W, H);
    const dots = makeCanvas(W, H); // transparent background
    const dctx = dots.getContext("2d");
    for (const s of activeSpots()) {
      dctx.fillStyle = hexToRgba(bitFor(s.bit).color, CONFIG.DOT_ALPHA);
      dctx.beginPath();
      dctx.arc(s.cx * (W / size.w), s.cy * (H / size.h), s.bit / 2 * (W / size.w), 0, Math.PI * 2);
      dctx.fill();
    }
    return { W, H, pattern, dots };
  }
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // Canvas PNGs carry no DPI; splice a pHYs chunk in right after IHDR.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function pngWithDpi(canvas, dpi) {
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("This browser couldn't encode the PNG.");
    const src = new Uint8Array(await blob.arrayBuffer());
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21); // length(4) + type(4) + data(9) + crc(4)
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
    dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1; // pixels per metre
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    const insertAt = 33; // 8-byte signature + 25-byte IHDR chunk
    const out = new Uint8Array(src.length + chunk.length);
    out.set(src.subarray(0, insertAt), 0);
    out.set(chunk, insertAt);
    out.set(src.subarray(insertAt), insertAt + chunk.length);
    return new Blob([out], { type: "image/png" });
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    state.exportUrls.push(url);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    return { url, filename };
  }
  function addLink(url, filename, text) {
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.textContent = text;
    els.exportLinks.append(a);
  }

  async function doDownload() {
    if (!state.result || !state.src) return;
    const format = document.querySelector('input[name="gb-format"]:checked').value;
    if (format === "psd" && !window.agPsd) {
      els.exportStatus.textContent = "The PSD library didn't load. Check your connection and reload, or choose the PNG pair.";
      return;
    }
    els.download.disabled = true;
    clearExportLinks();
    els.exportStatus.textContent = "Preparing your files…";
    await new Promise((r) => setTimeout(r, 30)); // let the status paint
    try {
      const { size } = state.result;
      const dpi = pickDpi(size);
      if (!dpi) throw new Error("This device can't make an image of this size at all.");
      const layers = buildLayers(size, dpi);
      const base = state.src.name;
      if (format === "psd") {
        const composite = makeCanvas(layers.W, layers.H);
        const cctx = composite.getContext("2d");
        cctx.drawImage(layers.pattern, 0, 0);
        cctx.drawImage(layers.dots, 0, 0);
        const buf = window.agPsd.writePsd({
          width: layers.W, height: layers.H,
          imageResources: { resolutionInfo: {
            horizontalResolution: dpi, horizontalResolutionUnit: "PPI", widthUnit: "Inches",
            verticalResolution: dpi, verticalResolutionUnit: "PPI", heightUnit: "Inches",
          } },
          children: [ // first child is the bottom layer
            { name: "Pattern", canvas: layers.pattern },
            { name: "Dots", canvas: layers.dots },
          ],
          canvas: composite,
        }, { generateThumbnail: false });
        const f = saveBlob(new Blob([buf], { type: "image/vnd.adobe.photoshop" }), `${base}-bit-check.psd`);
        addLink(f.url, f.filename, "Download " + f.filename + " again");
      } else {
        const [pBlob, dBlob] = await Promise.all([pngWithDpi(layers.pattern, dpi), pngWithDpi(layers.dots, dpi)]);
        const f1 = saveBlob(pBlob, `${base}-pattern.png`);
        addLink(f1.url, f1.filename, "Save " + f1.filename);
        const f2 = { url: URL.createObjectURL(dBlob), filename: `${base}-dots.png` };
        state.exportUrls.push(f2.url);
        addLink(f2.url, f2.filename, "Save " + f2.filename);
        // some browsers (iPad Safari especially) only allow one automatic download per tap
        setTimeout(() => { const a = document.createElement("a"); a.href = f2.url; a.download = f2.filename; document.body.append(a); a.click(); a.remove(); }, 500);
      }
      const px = `${layers.W} × ${layers.H} px`;
      els.exportStatus.textContent = dpi >= CONFIG.EXPORT_DPI
        ? `Saved at ${dpi} DPI, actual size (${px}).`
        : `This device can't make an image that large at 300 DPI, so the export is ${dpi} DPI (${px}). Both layers use the same DPI and size, and it still prints at actual size.`;
    } catch (err) {
      els.exportStatus.textContent = "Couldn't create the download: " + err.message;
    } finally {
      els.download.disabled = false;
    }
  }

  /* ---------- wiring ---------- */

  CONFIG.BITS.forEach((b, i) => {
    const label = document.createElement("label");
    label.className = "gb-check";
    const input = document.createElement("input");
    input.type = "checkbox"; input.value = i; input.checked = true;
    const sw = document.createElement("span");
    sw.className = "gb-swatch"; sw.style.background = b.color;
    label.append(input, sw, document.createTextNode(b.label));
    els.bits.append(label);
  });
  els.bits.addEventListener("change", () => {
    if (state.result) invalidate("Bits changed. Check the pattern again.");
    renderLegend();
    refreshControls();
  });

  els.width.addEventListener("input", onWidthInput);
  els.height.addEventListener("input", onHeightInput);
  els.unit.addEventListener("change", onUnitChange);
  els.lock.addEventListener("change", () => { if (els.lock.checked && els.width.value) onWidthInput(); else refreshControls(); });
  els.run.addEventListener("click", runAnalysis);
  els.minAngle.addEventListener("input", () => {
    state.minAngle = +els.minAngle.value;
    els.minAngleValue.textContent = state.minAngle + "°";
    if (state.result) refreshSpots();
  });
  els.download.addEventListener("click", doDownload);
  els.showDots.addEventListener("change", () => {
    const g = $("gb-dots");
    if (g) g.style.display = els.showDots.checked ? "" : "none";
  });

  els.choose.addEventListener("click", (e) => { e.stopPropagation(); els.file.click(); });
  els.file.addEventListener("change", () => { loadFile(els.file.files[0]); els.file.value = ""; });
  ["dragenter", "dragover"].forEach((t) => els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add("gb-drag-over"); }));
  ["dragleave", "drop"].forEach((t) => els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.remove("gb-drag-over"); }));
  els.drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

  if (window.__libLoadFailed) console.warn(window.__libLoadFailed + " failed to load; PSD export will be unavailable.");
  renderLegend();
})();
