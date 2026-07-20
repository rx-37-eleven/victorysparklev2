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

   Workflow, in order: upload photos → assign sizes/quantities to each
   photo → align/crop one tile per (photo, size) combination → print.
   The two things people actually think about first — "here are my
   photos" and "how many of each size" — come before the fiddly part
   (nudging an image into place), which matches how people describe the
   job out loud ("I want two 32mm of this one and a heart of that one").

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

  // --- Face-area guide (editor only — NEVER printed) ---
  // During alignment we overlay the visible "face" boundary on top of the
  // punch crop, so a photo that looks perfectly centered doesn't turn out
  // half-swallowed by the shell's crimped edge. See the big comment above
  // drawInstanceImage() for exactly how we guarantee none of this reaches
  // the exported PDF.
  FACE_GUIDE: {
    scrim: 'rgba(0,0,0,0.28)', // dims the bleed ring that gets crimped/hidden
    stroke: '#fff',            // dashed outline traced around the face boundary
    strokeWidth: 2,
    dash: [5, 4],
  },

  // --- Image import limits ---
  MAX_UPLOAD_PX: 6000,    // longest side; larger uploads are downscaled on import
  MAX_UPLOAD_MB: 20,      // reject files larger than this
  PDF_IMAGE_FORMAT: 'PNG',// PNG to preserve transparency outside the shape (esp. hearts)
  // Optional quality knob if you switch to JPEG for round-only sheets:
  // JPEG_QUALITY: 0.92,

  // --- Editor / on-screen UI sizing (doesn't affect print quality) ---
  EDITOR_DISPLAY_MAX_PX: 320,   // on-screen size of the longer side of the editor canvas
  THUMBNAIL_MAX_PX: 160,        // on-screen size of the longer side of each alignment tile
  PHOTO_THUMB_MAX_PX: 140,      // on-screen size of the longer side of a Step 1/2 photo thumbnail
  ZOOM_MAX_MULTIPLIER: 4,       // how far a user can zoom in, relative to "cover" scale
};

/* =====================================================================
   DO NOT EDIT BELOW THIS LINE unless you're comfortable with JavaScript.
   ===================================================================== */

// ---------------------------------------------------------------------
// Small helpers for reading punch/face dimensions regardless of shape.
// ---------------------------------------------------------------------
function punchWmm(type) { return type.shape === 'circle' ? type.punchMM.d : type.punchMM.w; }
function punchHmm(type) { return type.shape === 'circle' ? type.punchMM.d : type.punchMM.h; }

// Face = the visible metal shell once pressed, concentric with the punch.
// Mirrors punchWmm/punchHmm exactly so the two are easy to compare at a glance.
function faceWmm(type) { return type.shape === 'circle' ? type.faceMM.d : type.faceMM.w; }
function faceHmm(type) { return type.shape === 'circle' ? type.faceMM.d : type.faceMM.h; }

// ---------------------------------------------------------------------
// Heart shape: the official heart silhouette, traced as a 64-point
// polygon (normalized 0..1, x rightward, y downward) and stretched to
// fill whatever w x h box is needed. At this point density, straight
// segments render as a smooth curve — no beziers needed. The same
// function draws it for the live editor clip and the export clip (and
// now the face guide too), so all three shapes always match.
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
// export), for drawing outlines/fills (icons, the face-area guide), and
// for the face guide's scrim.
//
// skipBeginPath lets a caller trace a SECOND shape onto the SAME path
// instead of starting a fresh one — used once, by the face guide, to
// build a "punch shape minus face shape" compound path for an even-odd
// fill (the dimmed bleed ring). Every other call site omits this
// argument, so existing callers (icons, clip functions, export) behave
// exactly as before.
function tracePunchShape(ctx, shape, w, h, offsetX = 0, offsetY = 0, skipBeginPath = false) {
  if (shape === 'circle') {
    const r = Math.min(w, h) / 2;
    if (!skipBeginPath) ctx.beginPath();
    ctx.arc(offsetX + w / 2, offsetY + h / 2, r, 0, Math.PI * 2);
    ctx.closePath();
  } else if (shape === 'heart') {
    if (!skipBeginPath) ctx.beginPath();
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
// photos  — every uploaded image, independent of any button size:
//   { id, name, source, w, h }   source = HTMLImageElement or downscaled canvas
//
// groups  — one entry per (photo, button type) combination that has a
// non-zero quantity. Two copies of the same photo at the same size are
// physically identical, so they share ONE group (and one alignment) and
// are only multiplied out into individual instances at print time:
//   { id, photoId, typeKey, qty, coverScaleMMperPx, transform, lowRes }
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
  photos: [],
  groups: [],
  currentStep: 1,
};

const dom = {};
let editorState = null; // set while the editor modal is open
let _photoIdCounter = 0;
let _groupIdCounter = 0;

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
  dom.testPrintBanner = document.getElementById('test-print-banner');
  dom.testPrintBannerClose = document.getElementById('test-print-banner-close');

  // Step 1 — photos
  dom.dropzone = document.getElementById('photo-dropzone');
  dom.choosePhotosBtn = document.getElementById('choose-photos-btn');
  dom.photoFileInput = document.getElementById('photo-file-input');
  dom.photoGrid = document.getElementById('photo-grid');
  dom.photoErrors = document.getElementById('photo-errors');
  dom.step1Continue = document.getElementById('step1-continue');

  // Step 2 — sizes & quantity per photo
  dom.sizesRows = document.getElementById('sizes-rows');
  dom.step2Totals = document.getElementById('step2-totals');
  dom.step2Warning = document.getElementById('step2-warning');
  dom.backToPhotos = document.getElementById('back-to-photos');
  dom.step2Continue = document.getElementById('step2-continue');

  // Step 3 — align & crop
  dom.groupsGrid = document.getElementById('groups-grid');
  dom.backToSizes = document.getElementById('back-to-sizes');
  dom.step3Continue = document.getElementById('step3-continue');

  // Step 4 — print
  dom.edgeMarginToggle = document.getElementById('edge-margin-toggle');
  dom.generateSummary = document.getElementById('generate-summary');
  dom.generateWarning = document.getElementById('generate-warning');
  dom.backToAlign = document.getElementById('back-to-align');
  dom.generateBtn = document.getElementById('generate-btn');
  dom.generateStatus = document.getElementById('generate-status');

  dom.stepSections = document.querySelectorAll('.step-card');
  dom.stepBadges = document.querySelectorAll('.step-badge');

  // Editor modal
  dom.modalOverlay = document.getElementById('editor-modal');
  dom.editorTitle = document.getElementById('editor-title');
  dom.stageContainer = document.getElementById('editor-stage-container');
  dom.zoomSlider = document.getElementById('zoom-slider');
  dom.rotateSlider = document.getElementById('rotate-slider');
  dom.faceGuideToggle = document.getElementById('face-guide-toggle');
  dom.editorReset = document.getElementById('editor-reset');
  dom.editorDone = document.getElementById('editor-done');
  dom.editorCancel = document.getElementById('editor-cancel');
  dom.editorClose = document.getElementById('editor-close');
}

function goToStep(n) {
  appState.currentStep = n;
  dom.stepSections.forEach((sec, idx) => { sec.hidden = (idx + 1) !== n; });
  dom.stepBadges.forEach((b, idx) => b.classList.toggle('active', (idx + 1) === n));
  if (n === 2) renderSizesStep();
  if (n === 3) renderGroupsGrid();
  if (n === 4) renderGenerateSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// =======================================================================
// Shared file-import helpers (used by Step 1 upload)
// =======================================================================
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

// =======================================================================
// STEP 1 — Upload photos
// =======================================================================
function addPhotoFromFile(file) {
  return new Promise((resolve, reject) => {
    const err = validateFile(file);
    if (err) { reject(new Error(`${file.name}: ${err}`)); return; }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url); // safe once loaded — the decoded image stays usable
      const { source, w, h } = maybeDownscale(img);
      const photo = { id: _photoIdCounter++, name: file.name, source, w, h };
      appState.photos.push(photo);
      resolve(photo);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name}: couldn't be read as an image.`));
    };
    img.src = url;
  });
}

// Runs every dropped/selected file through addPhotoFromFile. One bad file
// (wrong type, too large, corrupt) doesn't stop the rest from being added.
async function handlePhotoFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const errors = [];
  for (const file of files) {
    try {
      await addPhotoFromFile(file);
    } catch (err) {
      errors.push(err.message);
    }
  }

  renderPhotoGrid();
  updateStep1ContinueState();
  showPhotoErrors(errors);
}

function showPhotoErrors(errors) {
  if (!errors || errors.length === 0) {
    dom.photoErrors.hidden = true;
    dom.photoErrors.innerHTML = '';
    return;
  }
  dom.photoErrors.hidden = false;
  dom.photoErrors.innerHTML = errors.map(e => `<div>${e}</div>`).join('');
}

// Draws `source` (an HTMLImageElement or downscaled canvas) into a fresh
// canvas at its natural aspect ratio, fit within CONFIG.PHOTO_THUMB_MAX_PX.
// Used by both the Step 1 photo grid and the Step 2 size rows — this step
// is about the photo, not the button, so nothing here is cropped to a shape.
function makePhotoThumbCanvas(photo) {
  const canvas = document.createElement('canvas');
  const maxPx = CONFIG.PHOTO_THUMB_MAX_PX;
  const scale = Math.min(maxPx / photo.w, maxPx / photo.h);
  canvas.width = Math.round(photo.w * scale);
  canvas.height = Math.round(photo.h * scale);
  canvas.getContext('2d').drawImage(photo.source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function renderPhotoGrid() {
  dom.photoGrid.innerHTML = '';
  appState.photos.forEach(photo => {
    const tile = document.createElement('div');
    tile.className = 'slot photo-tile';

    const wrap = document.createElement('div');
    wrap.className = 'slot-canvas-wrap photo-tile-canvas-wrap';
    const canvas = makePhotoThumbCanvas(photo);
    wrap.style.width = canvas.width + 'px';
    wrap.style.height = canvas.height + 'px';
    wrap.appendChild(canvas);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'photo-remove';
    removeBtn.setAttribute('aria-label', `Remove ${photo.name}`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => removePhoto(photo.id));
    wrap.appendChild(removeBtn);

    const nameEl = document.createElement('div');
    nameEl.className = 'slot-label photo-tile-name';
    nameEl.textContent = photo.name;
    nameEl.title = photo.name;

    tile.appendChild(wrap);
    tile.appendChild(nameEl);
    dom.photoGrid.appendChild(tile);
  });
}

// A group is still at its untouched defaults if nothing has been dragged,
// zoomed, or rotated — used to decide whether removing a photo needs a
// confirmation (no point warning about work that was never done).
function isDefaultTransform(group) {
  const t = group.transform;
  return t.xMM === 0 && t.yMM === 0 && t.rotationDeg === 0 &&
    Math.abs(t.scaleMMperPx - group.coverScaleMMperPx) < 1e-9;
}

function removePhoto(photoId) {
  const groups = appState.groups.filter(g => g.photoId === photoId);
  const hasCustomWork = groups.some(g => !isDefaultTransform(g));
  if (hasCustomWork) {
    const ok = confirm("This photo has button(s) you've already positioned. Removing it will lose that work. Continue?");
    if (!ok) return;
  }

  appState.groups = appState.groups.filter(g => g.photoId !== photoId);
  appState.photos = appState.photos.filter(p => p.id !== photoId);

  renderPhotoGrid();
  updateStep1ContinueState();
}

function updateStep1ContinueState() {
  dom.step1Continue.disabled = appState.photos.length === 0;
}

// =======================================================================
// STEP 2 — Sizes & quantity per photo
// =======================================================================
function totalButtonCount() {
  return appState.groups.reduce((sum, g) => sum + (g.qty > 0 ? g.qty : 0), 0);
}

// Changing a quantity edits `qty` on the existing group so alignment work
// is preserved. Setting it to 0 removes the group entirely. Raising it
// from 0 creates a brand new group at the default transform (centered,
// scaled to cover, no rotation) — same as the very first upload used to do.
function updateGroupQty(photoId, typeKey, rawQty) {
  const qty = Math.max(0, Math.floor(Number(rawQty) || 0));
  const existing = appState.groups.find(g => g.photoId === photoId && g.typeKey === typeKey);

  if (qty === 0) {
    if (existing) appState.groups = appState.groups.filter(g => g !== existing);
  } else if (existing) {
    existing.qty = qty;
  } else {
    const photo = appState.photos.find(p => p.id === photoId);
    const type = CONFIG.BUTTON_TYPES[typeKey];
    const coverScaleMMperPx = Math.max(punchWmm(type) / photo.w, punchHmm(type) / photo.h);
    const group = {
      id: _groupIdCounter++,
      photoId, typeKey, qty,
      coverScaleMMperPx,
      transform: { xMM: 0, yMM: 0, scaleMMperPx: coverScaleMMperPx, rotationDeg: 0 },
      lowRes: false,
    };
    recomputeLowRes(group);
    appState.groups.push(group);
  }

  updateStep2Summary();
}

function updateStep2Summary() {
  const total = totalButtonCount();
  const photoCount = new Set(appState.groups.filter(g => g.qty > 0).map(g => g.photoId)).size;
  dom.step2Totals.textContent = total === 0
    ? 'No buttons yet — add a quantity below.'
    : `${total} button${total === 1 ? '' : 's'} across ${photoCount} photo${photoCount === 1 ? '' : 's'}.`;

  const unusedPhotos = appState.photos.filter(photo =>
    !appState.groups.some(g => g.photoId === photo.id && g.qty > 0)
  );
  if (appState.photos.length > 0 && unusedPhotos.length > 0) {
    dom.step2Warning.hidden = false;
    dom.step2Warning.textContent = unusedPhotos.length === 1
      ? `"${unusedPhotos[0].name}" doesn't have any sizes picked yet.`
      : `${unusedPhotos.length} photos don't have any sizes picked yet: ${unusedPhotos.map(p => p.name).join(', ')}.`;
  } else {
    dom.step2Warning.hidden = true;
  }

  dom.step2Continue.disabled = total === 0;
}

function buildTypeIcon(type, sizePx) {
  const w = punchWmm(type), h = punchHmm(type);
  const iconScale = sizePx / Math.max(w, h);
  const iconW = Math.round(w * iconScale), iconH = Math.round(h * iconScale);
  const canvas = document.createElement('canvas');
  canvas.className = 'qty-icon';
  canvas.width = iconW;
  canvas.height = iconH;
  const ctx = canvas.getContext('2d');
  // Canvas fillStyle doesn't read CSS variables — resolve it directly.
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#7C4DCB';
  tracePunchShape(ctx, type.shape, iconW, iconH);
  ctx.fill();
  return canvas;
}

function renderSizesStep() {
  dom.sizesRows.innerHTML = '';

  appState.photos.forEach(photo => {
    const row = document.createElement('div');
    row.className = 'size-row';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'size-row-thumb-wrap';
    thumbWrap.appendChild(makePhotoThumbCanvas(photo));

    const infoWrap = document.createElement('div');
    infoWrap.className = 'size-row-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'size-row-name';
    nameEl.textContent = photo.name;
    nameEl.title = photo.name;
    infoWrap.appendChild(nameEl);

    const typesWrap = document.createElement('div');
    typesWrap.className = 'size-row-types';

    Object.entries(CONFIG.BUTTON_TYPES).forEach(([key, type]) => {
      const existingGroup = appState.groups.find(g => g.photoId === photo.id && g.typeKey === key);
      const currentQty = existingGroup ? existingGroup.qty : 0;
      const faceLabel = type.faceMM.d
        ? `${type.faceMM.d}mm face`
        : `${type.faceMM.w}×${type.faceMM.h}mm face`;

      const typeEl = document.createElement('div');
      typeEl.className = 'size-type';
      typeEl.appendChild(buildTypeIcon(type, 28));

      const typeInfo = document.createElement('div');
      typeInfo.className = 'size-type-info';
      typeInfo.innerHTML = `
        <div class="size-type-label">${type.label}</div>
        <div class="size-type-sub">${faceLabel}</div>
      `;
      typeEl.appendChild(typeInfo);

      const stepper = document.createElement('div');
      stepper.className = 'qty-stepper';
      stepper.innerHTML = `
        <button type="button" class="qty-step-btn qty-minus" aria-label="Decrease ${type.label} quantity for ${photo.name}">−</button>
        <input type="number" class="qty-input" min="0" value="${currentQty}" inputmode="numeric" aria-label="${type.label} quantity for ${photo.name}">
        <button type="button" class="qty-step-btn qty-plus" aria-label="Increase ${type.label} quantity for ${photo.name}">+</button>
      `;
      typeEl.appendChild(stepper);

      const input = stepper.querySelector('.qty-input');
      const commit = () => updateGroupQty(photo.id, key, input.value);
      stepper.querySelector('.qty-minus').addEventListener('click', () => {
        input.value = Math.max(0, Number(input.value) - 1);
        commit();
      });
      stepper.querySelector('.qty-plus').addEventListener('click', () => {
        input.value = Number(input.value) + 1;
        commit();
      });
      input.addEventListener('change', commit);

      typesWrap.appendChild(typeEl);
    });

    infoWrap.appendChild(typesWrap);
    row.appendChild(thumbWrap);
    row.appendChild(infoWrap);
    dom.sizesRows.appendChild(row);
  });

  updateStep2Summary();
}

// =======================================================================
// STEP 3 — Align & crop (one tile per photo+type group)
// =======================================================================
// A single mm-to-px scale shared by every alignment tile, so a 58mm round
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

// Builds the small object drawInstanceImage() actually needs — it only
// ever reads typeKey/imgSource/imgW/imgH/transform, so a group (which
// stores the image one level away, on its photo) can stand in for an
// instance without drawInstanceImage() knowing the difference.
function groupRenderable(group) {
  const photo = appState.photos.find(p => p.id === group.photoId);
  return {
    typeKey: group.typeKey,
    imgSource: photo.source,
    imgW: photo.w,
    imgH: photo.h,
    transform: group.transform,
  };
}

function renderGroupsGrid() {
  dom.groupsGrid.innerHTML = '';
  appState.groups.filter(g => g.qty > 0).forEach(group => {
    const photo = appState.photos.find(p => p.id === group.photoId);
    const type = CONFIG.BUTTON_TYPES[group.typeKey];
    const factor = getThumbnailScale();
    const thumbW = Math.round(punchWmm(type) * factor);
    const thumbH = Math.round(punchHmm(type) * factor);
    const qtyLabel = group.qty > 1 ? ` · ×${group.qty}` : '';

    const tileEl = document.createElement('div');
    tileEl.className = 'slot';
    tileEl.tabIndex = 0;
    tileEl.setAttribute('role', 'button');
    tileEl.setAttribute('aria-label', `Edit alignment for ${type.label}${qtyLabel}, photo ${photo.name}`);
    tileEl.innerHTML = `
      <div class="slot-canvas-wrap" style="width:${thumbW}px;height:${thumbH}px;">
        <canvas width="${thumbW}" height="${thumbH}"></canvas>
        <div class="slot-lowres-badge" hidden>low-res</div>
      </div>
      <div class="slot-label">${type.label}${qtyLabel}<br><span class="slot-photo-name">${photo.name}</span></div>
    `;

    group.thumbCanvasEl = tileEl.querySelector('canvas');
    group.badgeEl = tileEl.querySelector('.slot-lowres-badge');

    const open = () => openEditor(group);
    tileEl.addEventListener('click', open);
    tileEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    dom.groupsGrid.appendChild(tileEl);
    updateGroupTileThumbnail(group);
  });
}

function recomputeLowRes(groupOrInstance) {
  if (!groupOrInstance.transform) { groupOrInstance.lowRes = false; return; }
  const achievedDPI = 25.4 / groupOrInstance.transform.scaleMMperPx;
  groupOrInstance.lowRes = achievedDPI < CONFIG.DPI - 1; // small epsilon for rounding
}

// Shared drawing routine for alignment-tile thumbnails AND the 300dpi PDF
// export. NOTHING decorative goes in here — no face guide, no outlines,
// no scrim. The face guide lives on its own Konva layer in the editor
// (see openEditor()) and is never part of any rendered pixel that reaches
// the PDF, because renderInstanceToDataURL() below calls ONLY this
// function — it never exports from the Konva stage.
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

function updateGroupTileThumbnail(group) {
  const canvas = group.thumbCanvasEl;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const type = CONFIG.BUTTON_TYPES[group.typeKey];
  const w = canvas.width, h = canvas.height;
  const pxPerMM = w / punchWmm(type); // tile canvas is created at the same aspect ratio as the punch
  ctx.clearRect(0, 0, w, h);
  drawInstanceImage(ctx, groupRenderable(group), w, h, pxPerMM);
  group.badgeEl.hidden = !group.lowRes;

  // Optional faint face-boundary hint on the tile itself, so the user can
  // tell at a glance without opening the editor. Drawn AFTER
  // drawInstanceImage() returns, straight onto this on-screen canvas only
  // — this never touches the export path.
  const faceW = faceWmm(type) * pxPerMM;
  const faceH = faceHmm(type) * pxPerMM;
  ctx.save();
  ctx.beginPath();
  tracePunchShape(ctx, type.shape, faceW, faceH, (w - faceW) / 2, (h - faceH) / 2);
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 1;
  ctx.stroke();
  ctx.restore();
}

// =======================================================================
// Editor modal (Konva)
// =======================================================================
function scaleToSliderValue(scale, coverScale) {
  if (!coverScale) return 100;
  return Math.round((scale / coverScale) * 100);
}

function syncImageNodeFromTransform() {
  const es = editorState;
  if (!es) return;
  const t = es.group.transform;
  es.imageNode.x(es.stageW / 2 + t.xMM * es.pxPerMM);
  es.imageNode.y(es.stageH / 2 + t.yMM * es.pxPerMM);
  es.imageNode.rotation(t.rotationDeg);
  const s = t.scaleMMperPx * es.pxPerMM;
  es.imageNode.scale({ x: s, y: s });
}

function openEditor(group) {
  try {
    const photo = appState.photos.find(p => p.id === group.photoId);
    const type = CONFIG.BUTTON_TYPES[group.typeKey];
    const punchW = punchWmm(type), punchH = punchHmm(type);
    const pxPerMM = CONFIG.EDITOR_DISPLAY_MAX_PX / Math.max(punchW, punchH);
    const stageW = Math.round(punchW * pxPerMM);
    const stageH = Math.round(punchH * pxPerMM);
    const backupTransform = { ...group.transform };

    const qtyLabel = group.qty > 1 ? ` · ×${group.qty}` : '';
    dom.editorTitle.textContent = `Edit ${type.label}${qtyLabel} — ${photo.name}`;
    dom.stageContainer.innerHTML = '';

    const stage = new Konva.Stage({ container: dom.stageContainer, width: stageW, height: stageH });
    const imageLayer = new Konva.Layer();
    stage.add(imageLayer);

    const clipGroup = new Konva.Group({
      clipFunc: (ctx) => tracePunchShape(ctx, type.shape, stageW, stageH),
    });
    imageLayer.add(clipGroup);

    const imageNode = new Konva.Image({
      image: photo.source,
      width: photo.w,
      height: photo.h,
      offsetX: photo.w / 2,
      offsetY: photo.h / 2,
      draggable: true,
    });
    clipGroup.add(imageNode);

    // --- Face-area guide: a separate layer ABOVE the image, drawn once and
    // never touched by drag/zoom/rotate. Because it lives on its own Konva
    // layer that nothing ever transforms, it stays fixed relative to the
    // button shape regardless of how the photo underneath is moved — and
    // because it's Konva-only (listening: false, never read by the export
    // path), it can never end up in the PDF. See drawInstanceImage() above
    // for the export-side half of that guarantee.
    const faceW = faceWmm(type) * pxPerMM;
    const faceH = faceHmm(type) * pxPerMM;
    const faceOffsetX = (stageW - faceW) / 2;
    const faceOffsetY = (stageH - faceH) / 2;

    const guideLayer = new Konva.Layer({ listening: false });
    const guideShape = new Konva.Shape({
      listening: false,
      sceneFunc: (context) => {
        // Konva.Context's fill() doesn't reliably forward a fill-rule
        // argument, so we drop to the native 2D context it wraps for the
        // even-odd scrim below (same native-ctx style tracePunchShape()
        // is written for everywhere else in this file).
        const ctx = context._context;

        // Scrim: the ring between the punch and the face, even-odd fill so
        // the interior (the face itself) is left untouched.
        ctx.save();
        ctx.beginPath();
        tracePunchShape(ctx, type.shape, stageW, stageH);
        tracePunchShape(ctx, type.shape, faceW, faceH, faceOffsetX, faceOffsetY, true);
        ctx.fillStyle = CONFIG.FACE_GUIDE.scrim;
        ctx.fill('evenodd');
        ctx.restore();

        // Crisp dashed outline of the face boundary on top.
        ctx.save();
        ctx.beginPath();
        tracePunchShape(ctx, type.shape, faceW, faceH, faceOffsetX, faceOffsetY);
        ctx.lineWidth = CONFIG.FACE_GUIDE.strokeWidth;
        ctx.setLineDash(CONFIG.FACE_GUIDE.dash);
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 1.5;
        ctx.strokeStyle = CONFIG.FACE_GUIDE.stroke;
        ctx.stroke();
        ctx.restore();
      },
    });
    guideLayer.add(guideShape);
    stage.add(guideLayer);

    editorState = {
      group, photo, stage, layer: imageLayer, guideLayer, clipGroup, imageNode,
      backupTransform, pxPerMM, stageW, stageH, type, punchW, punchH,
    };

    imageNode.on('dragmove', () => {
      group.transform.xMM = (imageNode.x() - stageW / 2) / pxPerMM;
      group.transform.yMM = (imageNode.y() - stageH / 2) / pxPerMM;
    });

    syncImageNodeFromTransform();
    imageLayer.draw();

    dom.faceGuideToggle.checked = true;
    guideLayer.visible(true);
    guideLayer.draw();

    dom.zoomSlider.min = 100;
    dom.zoomSlider.max = CONFIG.ZOOM_MAX_MULTIPLIER * 100;
    dom.zoomSlider.value = scaleToSliderValue(group.transform.scaleMMperPx, group.coverScaleMMperPx);
    dom.rotateSlider.value = group.transform.rotationDeg;

    dom.modalOverlay.hidden = false;
  } catch (err) {
    console.error('Failed to open the photo editor:', err);
    alert("Something went wrong opening the photo editor. Check the browser console for details, or reload the page and try again.");
  }
}

function applyZoomFactor(factor) {
  const es = editorState;
  if (!es) return;
  const minScale = es.group.coverScaleMMperPx;
  const maxScale = minScale * CONFIG.ZOOM_MAX_MULTIPLIER;
  let newScale = es.group.transform.scaleMMperPx * factor;
  newScale = Math.min(maxScale, Math.max(minScale, newScale));
  es.group.transform.scaleMMperPx = newScale;
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
  recomputeLowRes(es.group);
  updateGroupTileThumbnail(es.group);
  closeEditor();
}

function handleEditorCancelOrClose() {
  const es = editorState;
  if (!es) return;
  es.group.transform = { ...es.backupTransform };
  updateGroupTileThumbnail(es.group);
  closeEditor();
}

// =======================================================================
// STEP 4 — Print
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

// Expands every group into `qty` individual print instances. Each copy
// gets its OWN cloned transform object (not a shared reference) so the
// packer/exporter can be handed a flat list exactly like it always has,
// with no risk of one instance's placement leaking into another's.
function flattenGroupsToInstances() {
  const instances = [];
  appState.groups.forEach(group => {
    if (group.qty <= 0) return;
    const photo = appState.photos.find(p => p.id === group.photoId);
    for (let i = 0; i < group.qty; i++) {
      instances.push({
        typeKey: group.typeKey,
        imgSource: photo.source,
        imgW: photo.w,
        imgH: photo.h,
        coverScaleMMperPx: group.coverScaleMMperPx,
        transform: { ...group.transform },
        lowRes: group.lowRes,
      });
    }
  });
  return instances;
}

function renderGenerateSummary() {
  const counts = {};
  appState.groups.forEach(g => {
    if (g.qty > 0) counts[g.typeKey] = (counts[g.typeKey] || 0) + g.qty;
  });

  let pageCountLabel;
  try {
    pageCountLabel = String(packInstances(flattenGroupsToInstances(), getPrintableRect()).length);
  } catch (err) {
    pageCountLabel = `— (${err.message})`;
  }

  let html = '<ul class="summary-list">';
  Object.entries(counts).forEach(([key, n]) => {
    html += `<li>${CONFIG.BUTTON_TYPES[key].label}: <strong>${n}</strong></li>`;
  });
  html += `<li class="summary-pages">Estimated pages: <strong>${pageCountLabel}</strong></li></ul>`;
  dom.generateSummary.innerHTML = html;

  // Every group in the photos-first flow always has a photo attached (a
  // group can't exist without one), so there's no "empty slot" state left
  // to warn about here — unlike the old quantities-first flow.
  dom.generateWarning.hidden = true;
  dom.generateBtn.disabled = false;
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

  const instances = flattenGroupsToInstances();

  let pages;
  try {
    pages = packInstances(instances, getPrintableRect());
  } catch (err) {
    dom.generateStatus.textContent = err.message;
    dom.generateBtn.disabled = false;
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: [CONFIG.PAGE.widthMM, CONFIG.PAGE.heightMM] });

  const totalToRender = instances.length;
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
  // Step 1 — photos
  dom.choosePhotosBtn.addEventListener('click', () => dom.photoFileInput.click());
  dom.photoFileInput.addEventListener('change', () => {
    handlePhotoFiles(dom.photoFileInput.files);
    dom.photoFileInput.value = '';
  });
  dom.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dom.dropzone.classList.add('drag-over'); });
  dom.dropzone.addEventListener('dragleave', () => dom.dropzone.classList.remove('drag-over'));
  dom.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropzone.classList.remove('drag-over');
    handlePhotoFiles(e.dataTransfer.files);
  });
  dom.step1Continue.addEventListener('click', () => goToStep(2));

  // Step 2 — sizes & quantity
  dom.backToPhotos.addEventListener('click', () => goToStep(1));
  dom.step2Continue.addEventListener('click', () => goToStep(3));

  // Step 3 — align & crop
  dom.backToSizes.addEventListener('click', () => goToStep(2));
  dom.step3Continue.addEventListener('click', () => goToStep(4));

  // Step 4 — print
  dom.backToAlign.addEventListener('click', () => goToStep(3));
  dom.generateBtn.addEventListener('click', generatePDF);

  // Editor modal
  dom.editorDone.addEventListener('click', handleEditorDone);
  dom.editorCancel.addEventListener('click', handleEditorCancelOrClose);
  dom.editorClose.addEventListener('click', handleEditorCancelOrClose);

  dom.editorReset.addEventListener('click', () => {
    const es = editorState;
    if (!es) return;
    es.group.transform = { xMM: 0, yMM: 0, scaleMMperPx: es.group.coverScaleMMperPx, rotationDeg: 0 };
    syncImageNodeFromTransform();
    es.layer.draw();
    dom.zoomSlider.value = 100;
    dom.rotateSlider.value = 0;
  });

  dom.faceGuideToggle.addEventListener('change', () => {
    const es = editorState;
    if (!es) return;
    es.guideLayer.visible(dom.faceGuideToggle.checked);
    es.guideLayer.draw();
  });

  dom.zoomSlider.addEventListener('input', () => {
    const es = editorState;
    if (!es) return;
    const pct = Number(dom.zoomSlider.value);
    es.group.transform.scaleMMperPx = es.group.coverScaleMMperPx * (pct / 100);
    syncImageNodeFromTransform();
    es.layer.draw();
  });

  dom.rotateSlider.addEventListener('input', () => {
    const es = editorState;
    if (!es) return;
    es.group.transform.rotationDeg = Number(dom.rotateSlider.value);
    syncImageNodeFromTransform();
    es.layer.draw();
  });

  dom.stageContainer.addEventListener('wheel', (e) => {
    if (!editorState) return;
    e.preventDefault();
    applyZoomFactor(e.deltaY < 0 ? 1.05 : 1 / 1.05);
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dom.modalOverlay.hidden) {
      handleEditorCancelOrClose();
    }
  });
}
