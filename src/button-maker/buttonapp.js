/* =====================================================================
   PINPRESS — Button Sheet Maker
   ---------------------------------------------------------------------
   This file has two parts:

     1. CONFIG (right below this comment) — every physical measurement
        and tunable number in the app. If you only ever touch one part
        of this file, make it this block.

     2. Everything else — the app logic. You shouldn't need to edit
        below the "DO NOT EDIT BELOW THIS LINE" marker unless you're
        comfortable with JavaScript.

   This file depends on two libraries loaded via <script> tags in
   index.html: Konva (canvas editing) and jsPDF (PDF generation). Both
   are loaded from a CDN with pinned version numbers — see index.html.
   ===================================================================== */

const CONFIG = {
  // --- Page ---
  PAGE: { name: "Letter", widthMM: 215.9, heightMM: 279.4 }, // US Letter
  DPI: 300, // render resolution. Output is fixed at 300 DPI. See notes below.

  // --- Layout spacing ---
  GAP_MM: 2.0,            // minimum gap between neighboring buttons AND from the
                          // printable edge. (~25px at 300 DPI = ~2.1mm; rounded to 2.0)
  EDGE_MARGIN_MM: 12.7,   // 1/2 inch. Applied only when the "full edge margins"
                          // toggle is ON (for printers that can't do edge-to-edge).

  // --- Button definitions ---
  // face = visible metal shell size. punch = graphic size incl. bleed (what the
  // image must fill, and what the layout uses). These punch sizes are COMMON
  // CONVENTIONS for a generic machine — print one test sheet and check it
  // against your own cutter before any bulk run, and correct the numbers
  // below if needed.
  BUTTON_TYPES: {
    round25: {
      label: '25mm round',
      shape: 'circle',
      faceMM:  { d: 25 },
      punchMM: { d: 33 },   // ~1.313" punch (common convention; verify vs. cutter)
    },
    round32: {
      label: '32mm round',
      shape: 'circle',
      faceMM:  { d: 32 },
      punchMM: { d: 38 },   // ~1.5" punch
    },
    round44: {
      label: '44mm round',
      shape: 'circle',
      faceMM:  { d: 44 },
      punchMM: { d: 51 },   // ~2.0" punch (common convention; verify vs. cutter)
    },
    round58: {
      label: '58mm round',
      shape: 'circle',
      faceMM:  { d: 58 },
      punchMM: { d: 70 },   // ~2.75" punch
    },
    heart57: {
      label: '57.5x53mm heart',
      shape: 'heart',
      faceMM:  { w: 57.5, h: 53 }, // finished area
      punchMM: { w: 70,   h: 63 }, // cutting area — this is what the image fills & the layout uses
    },
  },

  // --- Image import limits ---
  MAX_UPLOAD_PX: 6000,    // longest side; larger uploads are downscaled on import
  MAX_UPLOAD_MB: 20,      // reject files larger than this
  PDF_IMAGE_FORMAT: 'PNG',// PNG to preserve transparency outside the shape (esp. hearts)
  // Optional quality knob if you switch to JPEG for round-only sheets:
  // JPEG_QUALITY: 0.92,

  // --- Editor / on-screen UI sizing (doesn't affect print quality) ---
  EDITOR_DISPLAY_MAX_PX: 320,   // on-screen size of the longer side of the editor canvas
  THUMBNAIL_MAX_PX: 160,        // on-screen size of the longer side of each slot thumbnail
  ZOOM_MAX_MULTIPLIER: 4,       // how far a user can zoom in, relative to "cover" scale
};

/* =====================================================================
   DO NOT EDIT BELOW THIS LINE unless you're comfortable with JavaScript.
   ===================================================================== */

// ---------------------------------------------------------------------
// Small helpers for reading punch dimensions regardless of shape.
// ---------------------------------------------------------------------
function punchWmm(type) { return type.shape === 'circle' ? type.punchMM.d : type.punchMM.w; }
function punchHmm(type) { return type.shape === 'circle' ? type.punchMM.d : type.punchMM.h; }

// ---------------------------------------------------------------------
// Heart shape: the official heart silhouette, traced as a 64-point
// polygon (normalized 0..1, x rightward, y downward) and stretched to
// fill whatever w x h punch box is needed. At this point density,
// straight segments render as a smooth curve — no beziers needed. The
// same function draws it for the live editor clip and the export clip,
// so the on-screen and printed shapes always match.
// ---------------------------------------------------------------------
const HEART_POINTS = [
  [0.5107,0.0343], [0.4634,0.0276], [0.4175,0.0131], [0.3707,0.0027],
  [0.323,0.0], [0.2753,0.0041], [0.2287,0.0156], [0.1842,0.0346],
  [0.1428,0.0603], [0.1052,0.0923], [0.0723,0.1298], [0.0446,0.172],
  [0.0228,0.218], [0.0079,0.2671], [0.0004,0.3182], [0.0,0.3699],
  [0.0064,0.4211], [0.0181,0.4713], [0.0335,0.5203], [0.0522,0.5679],
  [0.0738,0.6141], [0.0981,0.6587], [0.1246,0.7017], [0.1533,0.7431],
  [0.1842,0.7826], [0.217,0.8204], [0.2513,0.8564], [0.2874,0.8903],
  [0.3255,0.9217], [0.3656,0.9499], [0.4079,0.974], [0.4527,0.9919],
  [0.4998,1.0], [0.5474,0.9957], [0.5929,0.98], [0.6357,0.957],
  [0.6764,0.9298], [0.7152,0.8995], [0.7521,0.8666], [0.7871,0.8313],
  [0.8201,0.7938], [0.8512,0.7545], [0.8804,0.7135], [0.9075,0.6709],
  [0.9325,0.6267], [0.955,0.5811], [0.9747,0.5339], [0.9899,0.4849],
  [0.998,0.434], [1.0,0.3823], [1.0,0.3305], [0.9987,0.2788],
  [0.9906,0.2279], [0.9722,0.1803], [0.9457,0.1372], [0.9138,0.0987],
  [0.8771,0.0655], [0.8364,0.0384], [0.7925,0.0181], [0.7462,0.0054],
  [0.6986,0.0005], [0.6508,0.0022], [0.6036,0.0107], [0.5576,0.0249],
];

// Draws the heart scaled to fill w x h. Assumes the caller has already
// begun a path (Konva's clipFunc does this for you; for manual offscreen
// rendering, call ctx.beginPath() first — tracePunchShape() does that).
function drawHeartPath(ctx, w, h) {
  ctx.moveTo(HEART_POINTS[0][0] * w, HEART_POINTS[0][1] * h);
  for (let i = 1; i < HEART_POINTS.length; i++) {
    ctx.lineTo(HEART_POINTS[i][0] * w, HEART_POINTS[i][1] * h);
  }
  ctx.closePath();
}

// Traces either shape into a canvas context. Used for clipping (editor,
// export) and for drawing outlines/fills (icons, empty-slot placeholders).
// offsetX/offsetY are supported for both shapes (via translate for the
// heart, since its path is defined directly in 0..w x 0..h).
function tracePunchShape(ctx, shape, w, h, offsetX = 0, offsetY = 0) {
  if (shape === 'circle') {
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.arc(offsetX + w / 2, offsetY + h / 2, r, 0, Math.PI * 2);
    ctx.closePath();
  } else if (shape === 'heart') {
    ctx.beginPath();
    if (offsetX || offsetY) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      drawHeartPath(ctx, w, h);
      ctx.restore();
    } else {
      drawHeartPath(ctx, w, h);
    }
  } else {
    throw new Error('Unknown punch shape: ' + shape);
  }
}

// ---------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------
// Each "instance" is one physical button to be printed:
//   { id, typeKey, imgSource, imgW, imgH, coverScaleMMperPx, transform, lowRes }
//
// transform = { xMM, yMM, scaleMMperPx, rotationDeg }
//   xMM/yMM        — offset of the image's center from the punch box's
//                    center, in millimeters.
//   scaleMMperPx   — how many millimeters one source-image pixel covers.
//                    Storing it this way (rather than a screen-pixel
//                    scale) means the exact same numbers reproduce the
//                    placement at any resolution — comfortable on-screen
//                    editing or full 300dpi export — just by changing
//                    the px-per-mm multiplier used to render it.
//   rotationDeg    — rotation around the image center, in degrees.
const appState = {
  instances: [],
  currentStep: 1,
};

const dom = {};
const quantityInputsByType = {};

let editorState = null; // set while the editor modal is open

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  cacheDom();

  // If Konva or jsPDF failed to load (CDN hiccup, ad blocker, firewall),
  // nothing in this app can work — say so clearly instead of leaving the
  // editor popup stuck or silently doing nothing on upload.
  if (window.__libLoadFailed || typeof Konva === 'undefined' || typeof window.jspdf === 'undefined') {
    const which = window.__libLoadFailed || (typeof Konva === 'undefined' ? 'Konva' : 'jsPDF');
    const banner = document.getElementById('lib-error-banner');
    if (banner) {
      banner.hidden = false;
      banner.textContent = `Couldn't load the ${which} library from the CDN — check your internet connection, ad blocker, or firewall, then reload the page.`;
    }
    return; // nothing else will work without these libraries
  }

  buildQuantityForm();
  wireStaticEvents();
  setupTestPrintBanner();
  goToStep(1);
});

// Lets the user permanently dismiss the "before a bulk run" reminder. Uses
// localStorage so it stays dismissed across visits; falls back gracefully
// (just dismisses for this page load) if storage isn't available.
function setupTestPrintBanner() {
  let dismissedBefore = false;
  try { dismissedBefore = localStorage.getItem('pinpress-test-banner-dismissed') === '1'; } catch (err) { /* ignore */ }

  if (dismissedBefore) {
    dom.testPrintBanner.hidden = true;
    return;
  }

  dom.testPrintBannerClose.addEventListener('click', () => {
    dom.testPrintBanner.hidden = true;
    try { localStorage.setItem('pinpress-test-banner-dismissed', '1'); } catch (err) { /* ignore */ }
  });
}

function cacheDom() {
  dom.quantityRows = document.getElementById('quantity-rows');
  dom.quantitiesForm = document.getElementById('quantities-form');
  dom.edgeMarginToggle = document.getElementById('edge-margin-toggle');

  dom.testPrintBanner = document.getElementById('test-print-banner');
  dom.testPrintBannerClose = document.getElementById('test-print-banner-close');

  dom.slotsGrid = document.getElementById('slots-grid');
  dom.backToQuantities = document.getElementById('back-to-quantities');
  dom.continueToGenerate = document.getElementById('continue-to-generate');

  dom.backToSlots = document.getElementById('back-to-slots');
  dom.generateBtn = document.getElementById('generate-btn');
  dom.generateSummary = document.getElementById('generate-summary');
  dom.generateWarning = document.getElementById('generate-warning');
  dom.generateStatus = document.getElementById('generate-status');

  dom.stepSections = document.querySelectorAll('.step-card');
  dom.stepBadges = document.querySelectorAll('.step-badge');

  dom.modalOverlay = document.getElementById('editor-modal');
  dom.editorTitle = document.getElementById('editor-title');
  dom.stageContainer = document.getElementById('editor-stage-container');
  dom.zoomSlider = document.getElementById('zoom-slider');
  dom.rotateSlider = document.getElementById('rotate-slider');
  dom.editorUploadInput = document.getElementById('editor-upload-input');
  dom.editorUploadBtn = document.getElementById('editor-upload-btn');
  dom.editorDone = document.getElementById('editor-done');
  dom.editorCancel = document.getElementById('editor-cancel');
  dom.editorClose = document.getElementById('editor-close');

  dom.editorDuplicate = document.getElementById('editor-duplicate');
  dom.duplicateCount = document.getElementById('duplicate-count');
  dom.duplicateMinus = document.getElementById('duplicate-minus');
  dom.duplicatePlus = document.getElementById('duplicate-plus');
  dom.editorDuplicateSuffix = document.getElementById('editor-duplicate-suffix');
}

function goToStep(n) {
  appState.currentStep = n;
  dom.stepSections.forEach((sec, idx) => { sec.hidden = (idx + 1) !== n; });
  dom.stepBadges.forEach((b, idx) => b.classList.toggle('active', (idx + 1) === n));
  if (n === 3) renderGenerateSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// =======================================================================
// STEP 1 — Quantities
// =======================================================================
function buildQuantityForm() {
  dom.quantityRows.innerHTML = '';
  Object.entries(CONFIG.BUTTON_TYPES).forEach(([key, type]) => {
    const w = punchWmm(type), h = punchHmm(type);
    const iconScale = 40 / Math.max(w, h);
    const iconW = Math.round(w * iconScale), iconH = Math.round(h * iconScale);
    const faceLabel = type.faceMM.d
      ? `${type.faceMM.d}mm face`
      : `${type.faceMM.w}×${type.faceMM.h}mm face`;

    const row = document.createElement('div');
    row.className = 'quantity-row';
    row.innerHTML = `
      <canvas class="qty-icon" width="${iconW}" height="${iconH}"></canvas>
      <div class="qty-info">
        <div class="qty-label">${type.label}</div>
        <div class="qty-sub">${faceLabel} · ${w}×${h}mm punch</div>
      </div>
      <div class="qty-stepper">
        <button type="button" class="qty-step-btn qty-minus" aria-label="Decrease quantity">−</button>
        <input type="number" class="qty-input" min="0" value="0" inputmode="numeric" aria-label="${type.label} quantity">
        <button type="button" class="qty-step-btn qty-plus" aria-label="Increase quantity">+</button>
      </div>
    `;

    const iconCanvas = row.querySelector('.qty-icon');
    const ictx = iconCanvas.getContext('2d');
    ictx.fillStyle = 'var(--color-primary)';
    // Canvas fillStyle doesn't read CSS variables — resolve it directly.
    ictx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#7C4DCB';
    tracePunchShape(ictx, type.shape, iconW, iconH);
    ictx.fill();

    const input = row.querySelector('.qty-input');
    row.querySelector('.qty-minus').addEventListener('click', () => {
      input.value = Math.max(0, Number(input.value) - 1);
    });
    row.querySelector('.qty-plus').addEventListener('click', () => {
      input.value = Number(input.value) + 1;
    });

    quantityInputsByType[key] = input;
    dom.quantityRows.appendChild(row);
  });
}

function buildInstances(counts) {
  const list = [];
  let id = 0;
  Object.entries(counts).forEach(([key, n]) => {
    for (let i = 0; i < n; i++) {
      list.push({
        id: id++,
        typeKey: key,
        imgSource: null,
        imgW: 0,
        imgH: 0,
        coverScaleMMperPx: 0,
        transform: null,
        lowRes: false,
      });
    }
  });
  return list;
}

function instancesMatchCounts(instances, counts) {
  const current = {};
  instances.forEach(inst => { current[inst.typeKey] = (current[inst.typeKey] || 0) + 1; });
  return Object.keys(CONFIG.BUTTON_TYPES).every(key => (current[key] || 0) === (counts[key] || 0));
}

function handleQuantitiesSubmit(e) {
  e.preventDefault();
  const counts = {};
  let total = 0;
  Object.entries(quantityInputsByType).forEach(([key, input]) => {
    const n = Math.max(0, Math.floor(Number(input.value) || 0));
    counts[key] = n;
    total += n;
  });

  if (total === 0) {
    alert('Add at least one button before continuing.');
    return;
  }

  if (!instancesMatchCounts(appState.instances, counts)) {
    const hasPhotos = appState.instances.some(inst => inst.imgSource);
    if (hasPhotos) {
      const ok = confirm("Changing quantities will clear the photos you've already added. Continue?");
      if (!ok) return;
    }
    appState.instances = buildInstances(counts);
    renderSlotsGrid();
  }

  goToStep(2);
}

// =======================================================================
// STEP 2 — Slots grid (assign & edit)
// =======================================================================
// A single mm-to-px scale shared by every slot thumbnail, so a 58mm round
// renders visibly bigger than a 32mm round — rather than each type being
// independently scaled to fill the same box (which made every size look
// the same on screen regardless of its real relative size).
let _thumbnailScale = null;
function getThumbnailScale() {
  if (_thumbnailScale) return _thumbnailScale;
  let maxDim = 0;
  Object.values(CONFIG.BUTTON_TYPES).forEach(type => {
    maxDim = Math.max(maxDim, punchWmm(type), punchHmm(type));
  });
  _thumbnailScale = CONFIG.THUMBNAIL_MAX_PX / maxDim;
  return _thumbnailScale;
}

function renderSlotsGrid() {
  dom.slotsGrid.innerHTML = '';
  appState.instances.forEach((instance, idx) => {
    instance.indexLabel = idx + 1;
    const type = CONFIG.BUTTON_TYPES[instance.typeKey];
    const factor = getThumbnailScale();
    const thumbW = Math.round(punchWmm(type) * factor);
    const thumbH = Math.round(punchHmm(type) * factor);

    const slotEl = document.createElement('div');
    slotEl.className = 'slot';
    slotEl.innerHTML = `
      <div class="slot-canvas-wrap" style="width:${thumbW}px;height:${thumbH}px;">
        <canvas width="${thumbW}" height="${thumbH}"></canvas>
        <div class="slot-upload-hint">+ Add photo</div>
        <div class="slot-lowres-badge" hidden>low-res</div>
      </div>
      <div class="slot-label">${type.label} <span class="slot-number">#${idx + 1}</span></div>
      <input type="file" accept="image/*" hidden>
    `;

    instance.thumbCanvasEl = slotEl.querySelector('canvas');
    instance.uploadHintEl = slotEl.querySelector('.slot-upload-hint');
    instance.badgeEl = slotEl.querySelector('.slot-lowres-badge');
    const fileInput = slotEl.querySelector('input[type=file]');

    slotEl.addEventListener('click', () => {
      if (!instance.imgSource) fileInput.click();
      else openEditor(instance, { isFirstUpload: false });
    });

    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f) handleFileForInstance(instance, f);
      fileInput.value = '';
    });

    slotEl.addEventListener('dragover', (e) => { e.preventDefault(); slotEl.classList.add('drag-over'); });
    slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
    slotEl.addEventListener('drop', (e) => {
      e.preventDefault();
      slotEl.classList.remove('drag-over');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFileForInstance(instance, f);
    });

    dom.slotsGrid.appendChild(slotEl);
    updateSlotThumbnail(instance);
  });
}

function validateFile(file) {
  if (!file.type || !file.type.startsWith('image/')) return 'Please choose an image file.';
  if (file.size > CONFIG.MAX_UPLOAD_MB * 1024 * 1024) {
    return `That image is larger than ${CONFIG.MAX_UPLOAD_MB}MB — choose a smaller file.`;
  }
  return null;
}

// If an uploaded image is bigger than we'll ever need at 300dpi, shrink it
// once on import so we're not carrying huge pixel buffers around in memory
// and embedding more data than the PDF needs.
function maybeDownscale(img) {
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= CONFIG.MAX_UPLOAD_PX) {
    return { source: img, w: img.naturalWidth, h: img.naturalHeight };
  }
  const scale = CONFIG.MAX_UPLOAD_PX / longest;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return { source: canvas, w, h };
}

function handleFileForInstance(instance, file) {
  const err = validateFile(file);
  if (err) { alert(err); return; }

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url); // safe once loaded — the decoded image stays usable
    const { source, w, h } = maybeDownscale(img);
    const type = CONFIG.BUTTON_TYPES[instance.typeKey];

    instance.imgSource = source;
    instance.imgW = w;
    instance.imgH = h;
    instance.coverScaleMMperPx = Math.max(punchWmm(type) / w, punchHmm(type) / h);
    instance.transform = {
      xMM: 0, yMM: 0,
      scaleMMperPx: instance.coverScaleMMperPx, // default: scale to COVER the shape, centered
      rotationDeg: 0,
    };
    recomputeLowRes(instance);
    updateSlotThumbnail(instance);
    openEditor(instance, { isFirstUpload: true });
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert("Couldn't load that image — please try a different file.");
  };
  img.src = url;
}

function recomputeLowRes(instance) {
  if (!instance.imgSource) { instance.lowRes = false; return; }
  const achievedDPI = 25.4 / instance.transform.scaleMMperPx;
  instance.lowRes = achievedDPI < CONFIG.DPI - 1; // small epsilon for rounding
}

// Shared drawing routine: clips to the punch shape and draws the image with
// its saved transform. `pxPerMM` is the only thing that differs between a
// small on-screen thumbnail and a full 300dpi export render.
function drawInstanceImage(ctx, instance, w, h, pxPerMM) {
  const type = CONFIG.BUTTON_TYPES[instance.typeKey];
  tracePunchShape(ctx, type.shape, w, h);
  ctx.save();
  ctx.clip();
  ctx.translate(w / 2 + instance.transform.xMM * pxPerMM, h / 2 + instance.transform.yMM * pxPerMM);
  ctx.rotate(instance.transform.rotationDeg * Math.PI / 180);
  ctx.scale(instance.transform.scaleMMperPx * pxPerMM, instance.transform.scaleMMperPx * pxPerMM);
  ctx.drawImage(instance.imgSource, -instance.imgW / 2, -instance.imgH / 2);
  ctx.restore();
}

function updateSlotThumbnail(instance) {
  const canvas = instance.thumbCanvasEl;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const type = CONFIG.BUTTON_TYPES[instance.typeKey];
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!instance.imgSource) {
    ctx.save();
    ctx.strokeStyle = 'rgba(124, 77, 203, 0.45)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    tracePunchShape(ctx, type.shape, w, h);
    ctx.stroke();
    ctx.restore();
    instance.uploadHintEl.hidden = false;
    instance.badgeEl.hidden = true;
    return;
  }

  instance.uploadHintEl.hidden = true;
  const pxPerMM = w / punchWmm(type); // thumb canvas is created at the same aspect ratio as the punch
  drawInstanceImage(ctx, instance, w, h, pxPerMM);
  instance.badgeEl.hidden = !instance.lowRes;
}

// =======================================================================
// Editor modal (Konva)
// =======================================================================
function snapshotInstance(instance) {
  return {
    imgSource: instance.imgSource,
    imgW: instance.imgW,
    imgH: instance.imgH,
    coverScaleMMperPx: instance.coverScaleMMperPx,
    transform: instance.transform ? { ...instance.transform } : null,
    lowRes: instance.lowRes,
  };
}

function emptySnapshot() {
  return { imgSource: null, imgW: 0, imgH: 0, coverScaleMMperPx: 0, transform: null, lowRes: false };
}

function restoreInstance(instance, snap) {
  instance.imgSource = snap.imgSource;
  instance.imgW = snap.imgW;
  instance.imgH = snap.imgH;
  instance.coverScaleMMperPx = snap.coverScaleMMperPx;
  instance.transform = snap.transform ? { ...snap.transform } : null;
  instance.lowRes = snap.lowRes;
}

function scaleToSliderValue(scale, coverScale) {
  if (!coverScale) return 100;
  return Math.round((scale / coverScale) * 100);
}

function syncImageNodeFromTransform() {
  const es = editorState;
  if (!es) return;
  const t = es.instance.transform;
  es.imageNode.x(es.stageW / 2 + t.xMM * es.pxPerMM);
  es.imageNode.y(es.stageH / 2 + t.yMM * es.pxPerMM);
  es.imageNode.rotation(t.rotationDeg);
  const s = t.scaleMMperPx * es.pxPerMM;
  es.imageNode.scale({ x: s, y: s });
}

function openEditor(instance, opts = {}) {
  try {
    const isFirstUpload = !!opts.isFirstUpload;
    const backup = isFirstUpload ? emptySnapshot() : snapshotInstance(instance);

    const type = CONFIG.BUTTON_TYPES[instance.typeKey];
    const punchW = punchWmm(type), punchH = punchHmm(type);
    const pxPerMM = CONFIG.EDITOR_DISPLAY_MAX_PX / Math.max(punchW, punchH);
    const stageW = Math.round(punchW * pxPerMM);
    const stageH = Math.round(punchH * pxPerMM);

    dom.editorTitle.textContent = `Edit ${type.label} — #${instance.indexLabel}`;
    dom.stageContainer.innerHTML = '';

    const stage = new Konva.Stage({ container: dom.stageContainer, width: stageW, height: stageH });
    const layer = new Konva.Layer();
    stage.add(layer);

    const clipGroup = new Konva.Group({
      clipFunc: (ctx) => tracePunchShape(ctx, type.shape, stageW, stageH),
    });
    layer.add(clipGroup);

    const imageNode = new Konva.Image({
      image: instance.imgSource,
      width: instance.imgW,
      height: instance.imgH,
      offsetX: instance.imgW / 2,
      offsetY: instance.imgH / 2,
      draggable: true,
    });
    clipGroup.add(imageNode);

    editorState = { instance, stage, layer, clipGroup, imageNode, backup, isFirstUpload, pxPerMM, stageW, stageH, type, punchW, punchH };

    // How many other slots of this same size are still empty? That's how
    // many additional copies of this photo we could offer to fill in one go.
    const emptySameTypeCount = appState.instances.filter(
      inst => inst !== instance && inst.typeKey === instance.typeKey && !inst.imgSource
    ).length;
    editorState.emptySameTypeMax = emptySameTypeCount;

    if (emptySameTypeCount > 0) {
      dom.editorDuplicate.hidden = false;
      dom.duplicateCount.max = emptySameTypeCount;
      dom.duplicateCount.value = 0;
      dom.editorDuplicateSuffix.textContent = `more empty ${type.label} slot${emptySameTypeCount === 1 ? '' : 's'} (up to ${emptySameTypeCount} available)`;
    } else {
      dom.editorDuplicate.hidden = true;
      dom.duplicateCount.value = 0;
    }

    imageNode.on('dragmove', () => {
      instance.transform.xMM = (imageNode.x() - stageW / 2) / pxPerMM;
      instance.transform.yMM = (imageNode.y() - stageH / 2) / pxPerMM;
    });

    syncImageNodeFromTransform();
    layer.draw();

    dom.zoomSlider.min = 100;
    dom.zoomSlider.max = CONFIG.ZOOM_MAX_MULTIPLIER * 100;
    dom.zoomSlider.value = scaleToSliderValue(instance.transform.scaleMMperPx, instance.coverScaleMMperPx);
    dom.rotateSlider.value = instance.transform.rotationDeg;

    dom.modalOverlay.hidden = false;
  } catch (err) {
    console.error('Failed to open the photo editor:', err);
    alert("Something went wrong opening the photo editor. Check the browser console for details, or reload the page and try again.");
  }
}

function applyZoomFactor(factor) {
  const es = editorState;
  if (!es) return;
  const minScale = es.instance.coverScaleMMperPx;
  const maxScale = minScale * CONFIG.ZOOM_MAX_MULTIPLIER;
  let newScale = es.instance.transform.scaleMMperPx * factor;
  newScale = Math.min(maxScale, Math.max(minScale, newScale));
  es.instance.transform.scaleMMperPx = newScale;
  syncImageNodeFromTransform();
  es.layer.draw();
  dom.zoomSlider.value = scaleToSliderValue(newScale, minScale);
}

function closeEditor() {
  if (editorState) {
    editorState.stage.destroy();
    editorState = null;
  }
  dom.modalOverlay.hidden = true;
}

function handleEditorDone() {
  const es = editorState;
  if (!es) return;
  recomputeLowRes(es.instance);
  updateSlotThumbnail(es.instance);

  const requested = Math.max(0, Math.min(es.emptySameTypeMax, Math.floor(Number(dom.duplicateCount.value) || 0)));
  if (requested > 0) {
    const targets = appState.instances
      .filter(inst => inst !== es.instance && inst.typeKey === es.instance.typeKey && !inst.imgSource)
      .slice(0, requested);
    targets.forEach(target => {
      // Copy the image reference and placement, but give each slot its own
      // transform object so adjusting one later doesn't affect the others.
      target.imgSource = es.instance.imgSource;
      target.imgW = es.instance.imgW;
      target.imgH = es.instance.imgH;
      target.coverScaleMMperPx = es.instance.coverScaleMMperPx;
      target.transform = { ...es.instance.transform };
      target.lowRes = es.instance.lowRes;
      updateSlotThumbnail(target);
    });
  }

  closeEditor();
}

function handleEditorCancelOrClose() {
  const es = editorState;
  if (!es) return;
  restoreInstance(es.instance, es.backup);
  updateSlotThumbnail(es.instance);
  closeEditor();
}

function handleEditorReplacePhoto(file) {
  const es = editorState;
  if (!es) return;
  const err = validateFile(file);
  if (err) { alert(err); return; }

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const { source, w, h } = maybeDownscale(img);

    es.instance.imgSource = source;
    es.instance.imgW = w;
    es.instance.imgH = h;
    es.instance.coverScaleMMperPx = Math.max(es.punchW / w, es.punchH / h);
    es.instance.transform = {
      xMM: 0, yMM: 0,
      scaleMMperPx: es.instance.coverScaleMMperPx,
      rotationDeg: 0,
    };

    es.imageNode.destroy();
    const newNode = new Konva.Image({
      image: source, width: w, height: h,
      offsetX: w / 2, offsetY: h / 2, draggable: true,
    });
    es.clipGroup.add(newNode);
    es.imageNode = newNode;
    newNode.on('dragmove', () => {
      es.instance.transform.xMM = (newNode.x() - es.stageW / 2) / es.pxPerMM;
      es.instance.transform.yMM = (newNode.y() - es.stageH / 2) / es.pxPerMM;
    });

    syncImageNodeFromTransform();
    es.layer.draw();
    dom.zoomSlider.value = 100;
    dom.rotateSlider.value = 0;
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert("Couldn't load that image — please try a different file.");
  };
  img.src = url;
}

// =======================================================================
// STEP 3 — Generate
// =======================================================================
function getPrintableRect() {
  const inset = CONFIG.GAP_MM + (dom.edgeMarginToggle.checked ? CONFIG.EDGE_MARGIN_MM : 0);
  return {
    left: inset,
    top: inset,
    width: CONFIG.PAGE.widthMM - 2 * inset,
    height: CONFIG.PAGE.heightMM - 2 * inset,
  };
}

// Shelf / row-based bin packer. Each instance's bounding box is its punch
// size expanded by GAP_MM on every side, so any two neighboring boxes are
// automatically at least GAP_MM apart, and boxes are GAP_MM from the
// printable edge. This is intentionally simple and reliable rather than
// optimal — true circle/heart nesting would risk overlapping bleed rings,
// which would ruin the print. A future enhancement could mix sizes within
// a row more cleverly, but row-packing by descending height is easy to
// reason about and hard to get wrong.
function packInstances(instances, printable) {
  const boxes = instances.map(instance => {
    const type = CONFIG.BUTTON_TYPES[instance.typeKey];
    return {
      instance,
      w: punchWmm(type) + 2 * CONFIG.GAP_MM,
      h: punchHmm(type) + 2 * CONFIG.GAP_MM,
    };
  });

  const tooBig = boxes.find(b => b.w > printable.width || b.h > printable.height);
  if (tooBig) {
    throw new Error('One button (plus its gap) is larger than the printable area. Turn off "full edge margins" or check the punch sizes in CONFIG.');
  }

  boxes.sort((a, b) => b.h - a.h); // tallest first — improves row efficiency

  const pages = [];
  let i = 0;
  while (i < boxes.length) {
    const placements = [];
    let cursorY = printable.top;

    while (i < boxes.length && cursorY + boxes[i].h <= printable.top + printable.height) {
      let cursorX = printable.left;
      let rowHeight = 0;
      let placedInRow = 0;

      while (i < boxes.length && cursorX + boxes[i].w <= printable.left + printable.width) {
        placements.push({ instance: boxes[i].instance, boxLeft: cursorX, boxTop: cursorY });
        cursorX += boxes[i].w;
        rowHeight = Math.max(rowHeight, boxes[i].h);
        placedInRow++;
        i++;
      }

      if (placedInRow === 0) break; // guarded against above, but just in case
      cursorY += rowHeight;
    }

    pages.push({ placements });
  }

  return pages;
}

function renderGenerateSummary() {
  const counts = {};
  appState.instances.forEach(inst => { counts[inst.typeKey] = (counts[inst.typeKey] || 0) + 1; });
  const unassigned = appState.instances.filter(inst => !inst.imgSource);

  let pageCountLabel;
  try {
    pageCountLabel = String(packInstances(appState.instances, getPrintableRect()).length);
  } catch (err) {
    pageCountLabel = `— (${err.message})`;
  }

  let html = '<ul class="summary-list">';
  Object.entries(counts).forEach(([key, n]) => {
    html += `<li>${CONFIG.BUTTON_TYPES[key].label}: <strong>${n}</strong></li>`;
  });
  html += `<li class="summary-pages">Estimated pages: <strong>${pageCountLabel}</strong></li></ul>`;
  dom.generateSummary.innerHTML = html;

  if (unassigned.length > 0) {
    dom.generateWarning.hidden = false;
    dom.generateWarning.textContent =
      `${unassigned.length} slot${unassigned.length > 1 ? 's' : ''} still need${unassigned.length > 1 ? '' : 's'} a photo — go back and add one before generating the PDF.`;
    dom.generateBtn.disabled = true;
  } else {
    dom.generateWarning.hidden = true;
    dom.generateBtn.disabled = false;
  }
}

// Renders one instance to a full-resolution PNG data URL for the PDF —
// exactly punch_size_in_mm converted to pixels at CONFIG.DPI, and no larger.
function renderInstanceToDataURL(instance) {
  const type = CONFIG.BUTTON_TYPES[instance.typeKey];
  const exportPxPerMM = CONFIG.DPI / 25.4;
  const w = Math.round(punchWmm(type) * exportPxPerMM);
  const h = Math.round(punchHmm(type) * exportPxPerMM);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  drawInstanceImage(canvas.getContext('2d'), instance, w, h, exportPxPerMM);
  return canvas.toDataURL('image/png');
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

async function generatePDF() {
  dom.generateBtn.disabled = true;
  dom.generateStatus.hidden = false;
  dom.generateStatus.textContent = 'Laying out your sheet…';
  await nextFrame();

  let pages;
  try {
    pages = packInstances(appState.instances, getPrintableRect());
  } catch (err) {
    dom.generateStatus.textContent = err.message;
    dom.generateBtn.disabled = false;
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: [CONFIG.PAGE.widthMM, CONFIG.PAGE.heightMM] });

  const totalToRender = appState.instances.length;
  let rendered = 0;

  for (let p = 0; p < pages.length; p++) {
    if (p > 0) doc.addPage([CONFIG.PAGE.widthMM, CONFIG.PAGE.heightMM]);
    for (const placement of pages[p].placements) {
      dom.generateStatus.textContent = `Rendering button ${rendered + 1} of ${totalToRender}…`;
      await nextFrame(); // let the status text repaint before the (synchronous) render below

      const dataUrl = renderInstanceToDataURL(placement.instance);
      const type = CONFIG.BUTTON_TYPES[placement.instance.typeKey];
      const imgX = placement.boxLeft + CONFIG.GAP_MM;
      const imgY = placement.boxTop + CONFIG.GAP_MM;
      doc.addImage(dataUrl, CONFIG.PDF_IMAGE_FORMAT, imgX, imgY, punchWmm(type), punchHmm(type));
      rendered++;
    }
  }

  dom.generateStatus.textContent =
    `Done — ${pages.length} page${pages.length > 1 ? 's' : ''}, ${totalToRender} button${totalToRender > 1 ? 's' : ''}. Starting download…`;
  doc.save('buttons.pdf');
  dom.generateBtn.disabled = false;
}

// =======================================================================
// Wire up events that don't depend on dynamically-created content
// =======================================================================
function wireStaticEvents() {
  dom.quantitiesForm.addEventListener('submit', handleQuantitiesSubmit);
  dom.backToQuantities.addEventListener('click', () => goToStep(1));
  dom.continueToGenerate.addEventListener('click', () => goToStep(3));
  dom.backToSlots.addEventListener('click', () => goToStep(2));
  dom.generateBtn.addEventListener('click', generatePDF);

  dom.editorDone.addEventListener('click', handleEditorDone);
  dom.editorCancel.addEventListener('click', handleEditorCancelOrClose);
  dom.editorClose.addEventListener('click', handleEditorCancelOrClose);

  dom.zoomSlider.addEventListener('input', () => {
    const es = editorState;
    if (!es) return;
    const pct = Number(dom.zoomSlider.value);
    es.instance.transform.scaleMMperPx = es.instance.coverScaleMMperPx * (pct / 100);
    syncImageNodeFromTransform();
    es.layer.draw();
  });

  dom.rotateSlider.addEventListener('input', () => {
    const es = editorState;
    if (!es) return;
    es.instance.transform.rotationDeg = Number(dom.rotateSlider.value);
    syncImageNodeFromTransform();
    es.layer.draw();
  });

  dom.stageContainer.addEventListener('wheel', (e) => {
    if (!editorState) return;
    e.preventDefault();
    applyZoomFactor(e.deltaY < 0 ? 1.05 : 1 / 1.05);
  }, { passive: false });

  dom.editorUploadBtn.addEventListener('click', () => dom.editorUploadInput.click());
  dom.editorUploadInput.addEventListener('change', () => {
    const f = dom.editorUploadInput.files[0];
    if (f) handleEditorReplacePhoto(f);
    dom.editorUploadInput.value = '';
  });

  function clampDuplicateCount() {
    const max = editorState ? editorState.emptySameTypeMax : 0;
    const v = Math.max(0, Math.min(max, Math.floor(Number(dom.duplicateCount.value) || 0)));
    dom.duplicateCount.value = v;
  }
  dom.duplicateMinus.addEventListener('click', () => {
    dom.duplicateCount.value = Number(dom.duplicateCount.value) - 1;
    clampDuplicateCount();
  });
  dom.duplicatePlus.addEventListener('click', () => {
    dom.duplicateCount.value = Number(dom.duplicateCount.value) + 1;
    clampDuplicateCount();
  });
  dom.duplicateCount.addEventListener('change', clampDuplicateCount);
}
