/* =====================================================================
   WATERMARKER — Batch Watermark Images & PDFs
   ---------------------------------------------------------------------
   This file has two parts:

     1. CONFIG (right below this comment) — every tunable limit and
        default in the app.

     2. Everything else — the app logic. You shouldn't need to edit
        below the "DO NOT EDIT BELOW THIS LINE" marker unless you're
        comfortable with JavaScript.

   What this does: upload a transparent watermark PNG, then either a
   batch of images or one PDF, and stamp the watermark onto each at
   whatever position/size/rotation/opacity you place it.

   THE ONE INVARIANT THAT MUST NOT BREAK: every stamp is stored as
   normalized geometry relative to its base image/page --
     { id, cx, cy, widthFrac, rotationDeg, opacity }
   never in screen pixels. stampsToPlacements(stamps, baseW, baseH, wmAspect)
   is the ONLY function that turns that model into concrete pixel/point
   boxes, and it is called from every place a stamp gets drawn: the Konva
   preview, image export, and (after a coordinate-space conversion for
   pdf-lib's bottom-left origin) PDF export. If a screen-pixel number ever
   gets written into a stamp, preview and export will silently disagree.

   This file depends on four libraries loaded via <script> tags in
   index.html: Konva (canvas editing), pdf.js (PDF preview rendering),
   pdf-lib (PDF export), and JSZip (multi-image export). All are loaded
   from a CDN with pinned version numbers.
   ===================================================================== */

const CONFIG = {
  // --- Batch limits ---
  MAX_IMAGES: 40, // most images allowed in the batch slot at once
  MAX_IMAGE_MB: 25, // per-image size cap; larger files are skipped with an error
  MAX_PDF_MB: 100, // PDF size cap
  MAX_PDF_PAGES_PREVIEW: 300, // pages beyond this aren't previewed or exported

  // --- Stamp defaults / ranges ---
  DEFAULT_WIDTH_FRAC: 0.25, // new stamp starts at 25% of the base image width
  MIN_WIDTH_FRAC: 0.01,
  MAX_WIDTH_FRAC: 1.0,
  DEFAULT_OPACITY: 1.0,
  MIN_OPACITY: 0.05,
  DUPLICATE_OFFSET_FRAC: 0.03, // how far a duplicated stamp is nudged, as a fraction of base width/height

  // --- Keyboard nudging ---
  NUDGE_PX: 1, // arrow key, in DISPLAY pixels (converted back to normalized before storing)
  NUDGE_PX_SHIFT: 10, // shift+arrow

  // --- Preview canvas sizing ---
  STAGE_MAX_W: 720, // longest side of the Konva stage frame, in CSS pixels
  STAGE_MAX_H: 560,
  ANCHOR_SIZE_FINE: 9, // Konva.Transformer anchor size, mouse/trackpad
  ANCHOR_SIZE_COARSE: 22, // ...and on touch, per §6's "make anchors >= 20px on coarse pointers"

  // --- PDF preview rendering ---
  PDF_PREVIEW_TARGET_PX: 1100, // longest side of the full-resolution current-page render
  PDF_PREVIEW_MAX_SCALE: 3, // cap on render scale for already-small pages
  PDF_THUMB_TARGET_PX: 130, // longest side of a lazily-rendered filmstrip thumbnail

  // --- Image export ---
  JPEG_QUALITY_DEFAULT: 0.92,
  ZIP_FILENAME: "watermarked-images.zip",

  // --- Tile preset ---
  TILE_MIN_COUNT: 2,
  TILE_MAX_COUNT: 8,
  TILE_DEFAULT_COUNT: 3, // rows == cols == this by default

  // --- Quick-position presets ---
  PRESET_MARGIN_FRAC: 0.04, // inset from the base edge, so an edge/corner preset doesn't bleed off by default
};

/* =====================================================================
   DO NOT EDIT BELOW THIS LINE unless you're comfortable with JavaScript.
   ===================================================================== */

(function () {
  "use strict";

  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Keeps an angle within (-180, 180] so the rotation slider and exported
  // rotation always agree on what "45 degrees" means.
  function normalizeAngle(deg) {
    return ((deg % 360) + 540) % 360 - 180;
  }

  // -----------------------------------------------------------------
  // THE shared placement function. See the file header -- every caller
  // that turns a stamp into pixels/points goes through this, whether
  // that's the live Konva preview (baseW/baseH = the on-screen stage
  // size), a full-resolution image export (baseW/baseH = naturalWidth/
  // naturalHeight), or a PDF export (baseW/baseH = the page's viewer-
  // space width/height in points; the caller then maps the returned
  // x/y/w/h through the page-rotation math in the PDF export section).
  // -----------------------------------------------------------------
  function stampsToPlacements(stamps, baseWidth, baseHeight, wmAspect) {
    return stamps.map(function (s) {
      const w = s.widthFrac * baseWidth;
      const h = w * wmAspect;
      return {
        id: s.id,
        x: s.cx * baseWidth,
        y: s.cy * baseHeight,
        w: w,
        h: h,
        rotationDeg: s.rotationDeg,
        opacity: s.opacity,
      };
    });
  }

  // -----------------------------------------------------------------
  // Module state
  // -----------------------------------------------------------------
  const state = {
    watermark: { file: null, img: null, naturalW: 0, naturalH: 0, aspect: 1, objectUrl: null },
    mode: null, // "images" | "pdf" | null
    items: [], // image items (kind:"image") or PDF page items (kind:"pdfpage")
    pdfBytes: null, // pristine ArrayBuffer, untouched by pdf.js, kept for pdf-lib export
    pdfDoc: null, // pdf.js document proxy
    pdfName: null,
    currentIndex: -1,
    selectedStampId: null,
    idCounter: 0,
  };

  const dom = {};
  let editor = null; // Konva stage/layers for the currently-shown item; rebuilt on item switch
  let pdfThumbObserver = null;

  function currentItem() {
    return state.items[state.currentIndex] || null;
  }

  function selectedStamp() {
    const item = currentItem();
    if (!item || !state.selectedStampId) return null;
    return item.stamps.find((s) => s.id === state.selectedStampId) || null;
  }

  function isCoarsePointer() {
    return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  }

  // -----------------------------------------------------------------
  // Error / warning display -- every error surfaces near the relevant
  // control, never alert(), never console-only.
  // -----------------------------------------------------------------
  function showError(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.classList.remove("wm-warning");
  }

  function showWarning(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.classList.add("wm-warning");
  }

  function clearError(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("wm-warning");
  }

  // -----------------------------------------------------------------
  // Boot / library load check
  // -----------------------------------------------------------------
  function waitForPdfJsSettled() {
    if (window.__pdfjs || window.__libLoadFailed === "pdf.js") return Promise.resolve();
    return new Promise((resolve) => {
      window.addEventListener("pdfjs-settled", resolve, { once: true });
    });
  }

  function missingLibName() {
    if (window.__libLoadFailed) return window.__libLoadFailed;
    if (typeof Konva === "undefined") return "Konva";
    if (typeof window.PDFLib === "undefined") return "pdf-lib";
    if (typeof window.JSZip === "undefined") return "JSZip";
    if (!window.__pdfjs) return "pdf.js";
    return null;
  }

  async function init() {
    cacheDom();
    await waitForPdfJsSettled();

    const missing = missingLibName();
    if (missing) {
      showError(
        dom.libErrorBanner,
        `Couldn't load the ${missing} library from the CDN — check your internet connection, ad blocker, or firewall, then reload the page.`
      );
      return; // nothing in this app works without all four libraries
    }

    wireStaticEvents();
    maybeShowWorkspace();
  }

  function cacheDom() {
    dom.libErrorBanner = document.getElementById("wm-lib-error-banner");

    dom.wmDropzone = document.getElementById("wm-wm-dropzone");
    dom.wmChooseBtn = document.getElementById("wm-wm-choose-btn");
    dom.wmFileInput = document.getElementById("wm-wm-file-input");
    dom.wmError = document.getElementById("wm-wm-error");

    dom.srcDropzone = document.getElementById("wm-src-dropzone");
    dom.srcChooseBtn = document.getElementById("wm-src-choose-btn");
    dom.srcFileInput = document.getElementById("wm-src-file-input");
    dom.srcError = document.getElementById("wm-src-error");

    dom.workspace = document.getElementById("wm-workspace");
    dom.previewFrame = document.getElementById("wm-preview-frame");
    dom.stageContainer = document.getElementById("wm-stage-container");
    dom.emptyMessage = document.getElementById("wm-empty-message");

    dom.filmstrip = document.getElementById("wm-filmstrip");

    dom.watermarkThumb = document.getElementById("wm-watermark-thumb");
    dom.watermarkReplaceBtn = document.getElementById("wm-watermark-replace-btn");
    dom.noSelectionHint = document.getElementById("wm-no-selection-hint");
    dom.selectedControls = document.getElementById("wm-selected-controls");
    dom.sizeSlider = document.getElementById("wm-size");
    dom.sizeValue = document.getElementById("wm-size-value");
    dom.rotationSlider = document.getElementById("wm-rotation");
    dom.rotationValue = document.getElementById("wm-rotation-value");
    dom.opacitySlider = document.getElementById("wm-opacity");
    dom.opacityValue = document.getElementById("wm-opacity-value");

    dom.addStampBtn = document.getElementById("wm-add-stamp-btn");
    dom.duplicateBtn = document.getElementById("wm-duplicate-btn");
    dom.deleteBtn = document.getElementById("wm-delete-btn");
    dom.clearBtn = document.getElementById("wm-clear-btn");
    dom.presetGrid = document.getElementById("wm-preset-grid");
    dom.tileSpacingSlider = document.getElementById("wm-tile-spacing");
    dom.tileSpacingValue = document.getElementById("wm-tile-spacing-value");
    dom.tileBtn = document.getElementById("wm-tile-btn");

    dom.applyAllBtn = document.getElementById("wm-apply-all-btn");

    dom.exportImagesPanel = document.getElementById("wm-export-images-panel");
    dom.exportFormat = document.getElementById("wm-export-format");
    dom.jpegQualityRow = document.getElementById("wm-jpeg-quality-row");
    dom.jpegQualitySlider = document.getElementById("wm-jpeg-quality");
    dom.jpegQualityValue = document.getElementById("wm-jpeg-quality-value");
    dom.exportImagesBtn = document.getElementById("wm-export-images-btn");
    dom.exportImagesStatus = document.getElementById("wm-export-images-status");
    dom.exportImagesError = document.getElementById("wm-export-images-error");

    dom.exportPdfPanel = document.getElementById("wm-export-pdf-panel");
    dom.pdfRangeMode = document.getElementById("wm-pdf-range-mode");
    dom.pdfRangeCustomRow = document.getElementById("wm-pdf-range-custom-row");
    dom.pdfRangeCustom = document.getElementById("wm-pdf-range-custom");
    dom.exportPdfBtn = document.getElementById("wm-export-pdf-btn");
    dom.exportPdfStatus = document.getElementById("wm-export-pdf-status");
    dom.exportPdfError = document.getElementById("wm-export-pdf-error");
  }

  function maybeShowWorkspace() {
    const ready = !!state.watermark.img && state.items.length > 0;
    dom.workspace.hidden = !ready;
    dom.exportImagesPanel.hidden = !(ready && state.mode === "images");
    dom.exportPdfPanel.hidden = !(ready && state.mode === "pdf");
    if (ready) updateStampButtonsEnabled();
  }

  // -----------------------------------------------------------------
  // Watermark upload (slot 1)
  // -----------------------------------------------------------------
  function processWatermarkFile(file) {
    clearError(dom.wmError);
    if (!file) return;
    if (file.type !== "image/png") {
      showError(dom.wmError, "Please upload a PNG file for the watermark.");
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        showError(dom.wmError, "This file couldn't be read. Please try a different PNG.");
        URL.revokeObjectURL(url);
        return;
      }
      if (state.watermark.objectUrl) URL.revokeObjectURL(state.watermark.objectUrl);
      state.watermark.objectUrl = url;
      state.watermark.file = file;
      state.watermark.img = img;
      state.watermark.naturalW = img.naturalWidth;
      state.watermark.naturalH = img.naturalHeight;
      state.watermark.aspect = img.naturalHeight / img.naturalWidth;
      dom.watermarkThumb.src = url;

      warnIfOpaque(img);
      maybeShowWorkspace();
      if (editor && currentItem()) {
        rebuildStampNodes(currentItem());
        editor.stage.batchDraw();
      }
    };
    img.onerror = () => {
      showError(dom.wmError, "This file failed to load. Please try a different PNG.");
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  // Per §8: don't reject a non-transparent watermark PNG, just warn --
  // some users legitimately want a solid badge.
  function warnIfOpaque(img) {
    const c = document.createElement("canvas");
    const maxPx = 200;
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let data;
    try {
      data = ctx.getImageData(0, 0, c.width, c.height).data;
    } catch (err) {
      return; // e.g. tainted canvas; not worth failing over
    }
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return; // found a transparent/partial pixel
    }
    showWarning(
      dom.wmError,
      "This PNG doesn't look transparent; it'll cover the area behind it as a solid rectangle."
    );
  }

  // -----------------------------------------------------------------
  // Source upload (slot 2): images XOR a single PDF
  // -----------------------------------------------------------------
  function processSourceFiles(fileList) {
    clearError(dom.srcError);
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const pdfFiles = files.filter((f) => f.type === "application/pdf");
    const imageFiles = files.filter((f) => IMAGE_TYPES.indexOf(f.type) !== -1);
    const otherCount = files.length - pdfFiles.length - imageFiles.length;

    if (pdfFiles.length && imageFiles.length) {
      showError(dom.srcError, "Please choose either images or a single PDF, not both at once.");
      return;
    }
    if (otherCount > 0) {
      showError(dom.srcError, "Some files were skipped — only PNG, JPEG, WEBP images or a PDF are supported.");
    }
    if (pdfFiles.length > 1) {
      showError(dom.srcError, "Please choose only one PDF at a time — using the first one.");
    }

    if (pdfFiles.length) {
      handleIncomingPdf(pdfFiles[0]);
    } else if (imageFiles.length) {
      handleIncomingImages(imageFiles);
    }
  }

  function resetSourceItems() {
    state.items.forEach(releaseItem);
    state.items = [];
    state.currentIndex = -1;
    state.selectedStampId = null;
    state.pdfBytes = null;
    state.pdfDoc = null;
    state.pdfName = null;
    state.mode = null;
    if (editor) {
      editor.stage.destroy();
      editor = null;
    }
    dom.emptyMessage.hidden = false;
  }

  function releaseItem(item) {
    if (item.kind === "image") {
      if (item.source && typeof item.source.close === "function") item.source.close();
      if (item.source && item.source.__objectUrl) URL.revokeObjectURL(item.source.__objectUrl);
    }
  }

  function handleIncomingImages(files) {
    if (state.mode === "pdf" && state.items.length) {
      if (!window.confirm("You already have a PDF loaded. Replace it with these images?")) return;
      resetSourceItems();
    }

    const room = CONFIG.MAX_IMAGES - state.items.length;
    if (files.length > room) {
      showError(dom.srcError, `You can have up to ${CONFIG.MAX_IMAGES} images at once; only adding the first ${room}.`);
      files = files.slice(0, Math.max(0, room));
    }
    if (!files.length) return;

    state.mode = "images";

    // Decode every file in parallel but keep them in SELECTION order, not
    // decode-completion order -- createImageBitmap() timing varies with
    // file size/format, so pushing straight from each .then() would leave
    // the filmstrip in a different order than the user picked, seemingly
    // at random.
    const hadItems = state.items.length > 0;
    Promise.all(
      files.map((file) => {
        if (file.size > CONFIG.MAX_IMAGE_MB * 1024 * 1024) {
          showError(dom.srcError, `${file.name} is larger than ${CONFIG.MAX_IMAGE_MB}MB and was skipped.`);
          return null;
        }
        return loadImageFile(file).catch(() => {
          showError(dom.srcError, `${file.name} couldn't be read and was skipped.`);
          return null;
        });
      })
    ).then((loaded) => {
      loaded.filter(Boolean).forEach((item) => state.items.push(item));
      renderFilmstrip();
      maybeShowWorkspace();
      if (!hadItems && state.items.length) selectItem(0);
    });
  }

  async function loadImageFile(file) {
    let source, w, h;
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
      w = source.width;
      h = source.height;
    } catch (err) {
      // Fallback for browsers that don't support the imageOrientation option.
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
      });
      img.__objectUrl = url;
      source = img;
      w = img.naturalWidth;
      h = img.naturalHeight;
    }
    return {
      id: "img" + state.idCounter++,
      kind: "image",
      file: file,
      name: file.name,
      source: source,
      naturalWidth: w,
      naturalHeight: h,
      stamps: [],
    };
  }

  // -----------------------------------------------------------------
  // PDF loading (pdf.js drives preview; pdf-lib drives export, wired up
  // in a later commit). Per §7's PDF section: pdf.js DETACHES the
  // ArrayBuffer it's handed, so the file's bytes are read once here and
  // a copy (bytes.slice(0)) goes to pdf.js while the pristine original
  // is kept on state.pdfBytes for pdf-lib at export time. Skipping this
  // produces a confusing "detached ArrayBuffer" error, but only once you
  // try to export -- so get it right here, not there.
  // -----------------------------------------------------------------
  function handleIncomingPdf(file) {
    if (state.mode === "images" && state.items.length) {
      if (!window.confirm("You already have images loaded. Replace them with this PDF?")) return;
      resetSourceItems();
    }
    if (file.size > CONFIG.MAX_PDF_MB * 1024 * 1024) {
      showError(dom.srcError, `This PDF is larger than ${CONFIG.MAX_PDF_MB}MB.`);
      return;
    }
    loadPdf(file);
  }

  async function loadPdf(file) {
    let originalBytes;
    try {
      originalBytes = await file.arrayBuffer();
    } catch (err) {
      showError(dom.srcError, "This PDF couldn't be read.");
      return;
    }
    const pdfjsBytes = originalBytes.slice(0); // detached copy; pdf-lib keeps the pristine original

    let doc;
    try {
      doc = await window.__pdfjs.getDocument({ data: pdfjsBytes }).promise;
    } catch (err) {
      if (err && err.name === "PasswordException") {
        showError(dom.srcError, "This PDF is password-protected — remove the password and try again.");
      } else {
        showError(dom.srcError, "This PDF couldn't be read. It may be corrupted or unsupported.");
      }
      return;
    }

    state.mode = "pdf";
    state.pdfBytes = originalBytes;
    state.pdfDoc = doc;
    state.pdfName = file.name;

    const pageCount = Math.min(doc.numPages, CONFIG.MAX_PDF_PAGES_PREVIEW);
    if (doc.numPages > CONFIG.MAX_PDF_PAGES_PREVIEW) {
      showError(
        dom.srcError,
        `This PDF has ${doc.numPages} pages; only previewing and exporting the first ${CONFIG.MAX_PDF_PAGES_PREVIEW}.`
      );
    }

    state.items = [];
    for (let i = 1; i <= pageCount; i++) {
      state.items.push({
        id: "pg" + state.idCounter++,
        kind: "pdfpage",
        pageNumber: i,
        viewportWidth: 0,
        viewportHeight: 0,
        rotate: 0,
        stamps: [],
        included: true,
        thumbDataUrl: null,
      });
    }

    renderFilmstrip();
    maybeShowWorkspace();
    selectItem(0);
  }

  // Renders one PDF page to an offscreen canvas at preview resolution and
  // records its viewer-space size. Per §7.3, placements are normalized
  // against this viewport box -- pdf.js's viewport already folds in the
  // page's /Rotate, which is exactly what lets the SAME normalized
  // cx/cy/widthFrac model work whether or not the page is rotated; only
  // the PDF *export* step (added later) needs to know about rotation
  // explicitly, to map back into pdf-lib's unrotated page space.
  async function renderPdfPageFull(item) {
    const page = await state.pdfDoc.getPage(item.pageNumber);
    const baseVp = page.getViewport({ scale: 1 });
    const scale = Math.min(CONFIG.PDF_PREVIEW_MAX_SCALE, CONFIG.PDF_PREVIEW_TARGET_PX / Math.max(baseVp.width, baseVp.height));
    const vp = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;

    item.renderCanvas = canvas;
    item.viewportWidth = baseVp.width;
    item.viewportHeight = baseVp.height;
    item.rotate = ((page.rotate % 360) + 360) % 360;
    item.__fullRendered = true;
  }

  async function renderPdfThumb(item, canvasEl) {
    try {
      const page = await state.pdfDoc.getPage(item.pageNumber);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = CONFIG.PDF_THUMB_TARGET_PX / Math.max(baseVp.width, baseVp.height);
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.ceil(vp.width));
      c.height = Math.max(1, Math.ceil(vp.height));
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      item.thumbDataUrl = c.toDataURL("image/jpeg", 0.7);
      if (canvasEl.isConnected) drawDataUrlToCanvas(item.thumbDataUrl, canvasEl);
    } catch (err) {
      // Leave the thumbnail blank on failure; the page still works when selected.
    }
  }

  function removeImageItem(idx) {
    const item = state.items[idx];
    if (!item) return;
    releaseItem(item);
    state.items.splice(idx, 1);
    if (state.currentIndex === idx) {
      state.currentIndex = -1;
      state.selectedStampId = null;
    } else if (state.currentIndex > idx) {
      state.currentIndex--;
    }
    renderFilmstrip();
    if (!state.items.length) {
      state.mode = null;
      if (editor) {
        editor.stage.destroy();
        editor = null;
      }
      dom.emptyMessage.hidden = false;
      maybeShowWorkspace();
      return;
    }
    if (state.currentIndex === -1) {
      selectItem(clamp(idx, 0, state.items.length - 1));
    }
    maybeShowWorkspace();
  }

  // -----------------------------------------------------------------
  // Filmstrip
  // -----------------------------------------------------------------
  function refreshFilmstripBadge(item) {
    if (!item) return;
    const el = dom.filmstrip.querySelector(`[data-index="${state.items.indexOf(item)}"] .wm-filmstrip-badge`);
    if (!el) return;
    el.hidden = item.stamps.length === 0;
    el.textContent = String(item.stamps.length);
  }

  function imageThumbDataUrl(item) {
    if (item.__thumbUrl) return item.__thumbUrl;
    const maxPx = 120;
    const scale = Math.min(1, maxPx / Math.max(item.naturalWidth, item.naturalHeight));
    const w = Math.max(1, Math.round(item.naturalWidth * scale));
    const h = Math.max(1, Math.round(item.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(item.source, 0, 0, w, h);
    item.__thumbUrl = c.toDataURL("image/png");
    return item.__thumbUrl;
  }

  function renderFilmstrip() {
    dom.filmstrip.innerHTML = "";
    state.items.forEach((item, idx) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className =
        "wm-filmstrip-item" +
        (idx === state.currentIndex ? " wm-active" : "") +
        (item.kind === "pdfpage" && !item.included ? " wm-excluded" : "");
      el.dataset.index = String(idx);
      el.addEventListener("click", () => selectItem(idx));

      const wrap = document.createElement("div");
      wrap.className = "wm-filmstrip-thumb-wrap";

      if (item.kind === "image") {
        const img = document.createElement("img");
        img.src = imageThumbDataUrl(item);
        img.alt = "";
        wrap.appendChild(img);
      } else {
        const canvas = document.createElement("canvas");
        wrap.appendChild(canvas);
        queuePdfThumb(item, canvas);
      }

      const badge = document.createElement("span");
      badge.className = "wm-filmstrip-badge";
      badge.hidden = item.stamps.length === 0;
      badge.textContent = String(item.stamps.length);
      wrap.appendChild(badge);

      if (item.kind === "image") {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "wm-filmstrip-remove";
        rm.setAttribute("aria-label", "Remove " + item.name);
        rm.textContent = "×";
        rm.addEventListener("click", (e) => {
          e.stopPropagation();
          removeImageItem(idx);
        });
        wrap.appendChild(rm);
      } else {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "wm-filmstrip-toggle";
        toggle.setAttribute("aria-label", item.included ? "Exclude this page from export" : "Include this page in export");
        toggle.textContent = item.included ? "✓" : "×";
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          togglePageIncluded(idx);
        });
        wrap.appendChild(toggle);
      }

      el.appendChild(wrap);

      const label = document.createElement("span");
      label.className = "wm-filmstrip-label";
      label.textContent = item.kind === "image" ? item.name : "Page " + item.pageNumber;
      el.appendChild(label);

      dom.filmstrip.appendChild(el);
    });
  }

  function togglePageIncluded(idx) {
    const item = state.items[idx];
    if (!item) return;
    item.included = !item.included;
    renderFilmstrip();
  }

  // Lazily renders PDF page thumbnails as they scroll into view, per §7.2.
  function queuePdfThumb(item, canvasEl) {
    if (item.thumbDataUrl) {
      drawDataUrlToCanvas(item.thumbDataUrl, canvasEl);
      return;
    }
    canvasEl.dataset.itemId = item.id;
    if (!pdfThumbObserver) {
      pdfThumbObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            pdfThumbObserver.unobserve(entry.target);
            const it = state.items.find((x) => x.id === entry.target.dataset.itemId);
            if (it && !it.thumbDataUrl) renderPdfThumb(it, entry.target);
          });
        },
        { root: dom.filmstrip, rootMargin: "200px" }
      );
    }
    pdfThumbObserver.observe(canvasEl);
  }

  function drawDataUrlToCanvas(dataUrl, canvasEl) {
    const img = new Image();
    img.onload = () => {
      canvasEl.width = img.width;
      canvasEl.height = img.height;
      canvasEl.getContext("2d").drawImage(img, 0, 0);
    };
    img.src = dataUrl;
  }

  // -----------------------------------------------------------------
  // Konva editor
  // -----------------------------------------------------------------
  function baseDims(item) {
    if (item.kind === "image") return { w: item.naturalWidth, h: item.naturalHeight, source: item.source };
    return { w: item.viewportWidth, h: item.viewportHeight, source: item.renderCanvas };
  }

  async function selectItem(idx) {
    if (idx < 0 || idx >= state.items.length) return;
    state.currentIndex = idx;
    state.selectedStampId = null;
    renderFilmstrip();
    const item = state.items[idx];

    if (item.kind === "pdfpage" && !item.__fullRendered) {
      dom.emptyMessage.hidden = false;
      dom.emptyMessage.textContent = "Rendering page…";
      await renderPdfPageFull(item);
    }

    dom.emptyMessage.hidden = true;
    buildOrUpdateEditor(item);
    updateSelectedControlsUI();
    updateStampButtonsEnabled();
  }

  function buildOrUpdateEditor(item) {
    const dims = baseDims(item);
    if (!dims.w || !dims.h) return;

    const availW = Math.max(100, Math.min(CONFIG.STAGE_MAX_W, dom.previewFrame.clientWidth - 4 || CONFIG.STAGE_MAX_W));
    const availH = CONFIG.STAGE_MAX_H;
    const scale = Math.min(availW / dims.w, availH / dims.h, 1) || 1;
    const stageW = Math.max(1, Math.round(dims.w * scale));
    const stageH = Math.max(1, Math.round(dims.h * scale));

    if (!editor) {
      const stage = new Konva.Stage({ container: "wm-stage-container", width: stageW, height: stageH });
      const bgLayer = new Konva.Layer({ listening: false });
      const stampLayer = new Konva.Layer();
      stage.add(bgLayer);
      stage.add(stampLayer);

      const bgImageNode = new Konva.Image({ image: dims.source, x: 0, y: 0, width: stageW, height: stageH });
      bgLayer.add(bgImageNode);

      const transformer = new Konva.Transformer({
        keepRatio: true,
        rotateEnabled: true,
        enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right"],
        anchorSize: isCoarsePointer() ? CONFIG.ANCHOR_SIZE_COARSE : CONFIG.ANCHOR_SIZE_FINE,
        boundBoxFunc: (oldBox, newBox) => (Math.min(newBox.width, newBox.height) < 8 ? oldBox : newBox),
      });
      stampLayer.add(transformer);

      stage.on("click tap", (e) => {
        if (e.target === stage || e.target === bgImageNode) selectStamp(null);
      });

      editor = { stage, bgLayer, stampLayer, bgImageNode, transformer, nodes: new Map() };
    } else {
      editor.stage.width(stageW);
      editor.stage.height(stageH);
      editor.bgImageNode.image(dims.source);
      editor.bgImageNode.width(stageW);
      editor.bgImageNode.height(stageH);
      editor.nodes.forEach((node) => node.destroy());
      editor.nodes.clear();
    }

    rebuildStampNodes(item);
    editor.stage.batchDraw();
  }

  // Rebuilds every stamp node on the current item from its normalized
  // model, via the shared placement function -- called on item switch,
  // add/duplicate/delete, and whenever the stamp list changes shape.
  function rebuildStampNodes(item) {
    editor.nodes.forEach((node) => node.destroy());
    editor.nodes.clear();

    const stageW = editor.stage.width();
    const stageH = editor.stage.height();
    const placements = stampsToPlacements(item.stamps, stageW, stageH, state.watermark.aspect);

    placements.forEach((p) => {
      const node = new Konva.Image({
        image: state.watermark.img,
        x: p.x,
        y: p.y,
        width: p.w,
        height: p.h,
        offsetX: p.w / 2,
        offsetY: p.h / 2,
        rotation: p.rotationDeg,
        opacity: p.opacity,
        draggable: true,
        id: p.id,
      });
      wireStampNodeEvents(node, item);
      editor.stampLayer.add(node);
      editor.nodes.set(p.id, node);
    });

    editor.transformer.moveToTop();
    if (state.selectedStampId && editor.nodes.has(state.selectedStampId)) {
      editor.transformer.nodes([editor.nodes.get(state.selectedStampId)]);
    } else {
      editor.transformer.nodes([]);
    }
  }

  function wireStampNodeEvents(node, item) {
    node.on("click tap", (e) => {
      e.cancelBubble = true;
      selectStamp(node.id());
    });
    node.on("dragmove", () => clampNodeCenter(node));
    node.on("dragend", () => bakeNodeDragToModel(node, item));
    node.on("transformend", () => bakeNodeTransformToModel(node, item));
  }

  // Stamps may bleed off the edge (a legitimate watermark style), but the
  // CENTER is clamped to the base bounds so nothing can be dragged into
  // oblivion, per §6.
  function clampNodeCenter(node) {
    const stageW = editor.stage.width();
    const stageH = editor.stage.height();
    node.x(clamp(node.x(), 0, stageW));
    node.y(clamp(node.y(), 0, stageH));
  }

  function bakeNodeDragToModel(node, item) {
    const stamp = item.stamps.find((s) => s.id === node.id());
    if (!stamp) return;
    clampNodeCenter(node);
    stamp.cx = node.x() / editor.stage.width();
    stamp.cy = node.y() / editor.stage.height();
  }

  // Konva's Transformer changes scaleX/scaleY on the node directly; per
  // §6 this gets baked back into widthFrac (the canonical model) and the
  // node's own scale is reset to 1 so the model stays the single source
  // of truth and scale never silently accumulates across edits.
  function bakeNodeTransformToModel(node, item) {
    const stamp = item.stamps.find((s) => s.id === node.id());
    if (!stamp) return;
    const stageW = editor.stage.width();
    const stageH = editor.stage.height();

    const newWidthPx = node.width() * node.scaleX();
    stamp.widthFrac = clamp(newWidthPx / stageW, CONFIG.MIN_WIDTH_FRAC, CONFIG.MAX_WIDTH_FRAC);
    stamp.rotationDeg = normalizeAngle(node.rotation());
    clampNodeCenter(node);
    stamp.cx = node.x() / stageW;
    stamp.cy = node.y() / stageH;

    applyStampModelToNode(stamp); // re-derives pixel size/position and resets scale to 1
    refreshFilmstripBadge(item);
    updateSelectedControlsUI();
  }

  // Pushes the canonical model back onto a stamp's Konva node -- the
  // inverse of baking a drag/transform back into the model. Used by the
  // sliders and after a transformend so the node's scale never drifts.
  function applyStampModelToNode(stamp) {
    const node = editor.nodes.get(stamp.id);
    if (!node) return;
    const stageW = editor.stage.width();
    const stageH = editor.stage.height();
    const p = stampsToPlacements([stamp], stageW, stageH, state.watermark.aspect)[0];
    node.scale({ x: 1, y: 1 });
    node.width(p.w);
    node.height(p.h);
    node.offsetX(p.w / 2);
    node.offsetY(p.h / 2);
    node.x(p.x);
    node.y(p.y);
    node.rotation(p.rotationDeg);
    node.opacity(p.opacity);
    editor.transformer.forceUpdate();
    editor.stage.batchDraw();
  }

  function selectStamp(id) {
    state.selectedStampId = id;
    if (editor) {
      editor.transformer.nodes(id && editor.nodes.has(id) ? [editor.nodes.get(id)] : []);
      editor.stage.batchDraw();
    }
    updateSelectedControlsUI();
    updateStampButtonsEnabled();
  }

  // -----------------------------------------------------------------
  // Stamp CRUD
  // -----------------------------------------------------------------
  function newStampAtCenter() {
    return {
      id: "st" + state.idCounter++,
      cx: 0.5,
      cy: 0.5,
      widthFrac: CONFIG.DEFAULT_WIDTH_FRAC,
      rotationDeg: 0,
      opacity: CONFIG.DEFAULT_OPACITY,
    };
  }

  function addStamp() {
    const item = currentItem();
    if (!item || !state.watermark.img) return;
    const stamp = newStampAtCenter();
    item.stamps.push(stamp);
    rebuildStampNodes(item);
    editor.stage.batchDraw();
    selectStamp(stamp.id);
    refreshFilmstripBadge(item);
  }

  function duplicateStamp(id) {
    const item = currentItem();
    if (!item) return;
    const src = item.stamps.find((s) => s.id === id);
    if (!src) return;
    const copy = Object.assign({}, src, {
      id: "st" + state.idCounter++,
      cx: clamp(src.cx + CONFIG.DUPLICATE_OFFSET_FRAC, 0, 1),
      cy: clamp(src.cy + CONFIG.DUPLICATE_OFFSET_FRAC, 0, 1),
    });
    item.stamps.push(copy);
    rebuildStampNodes(item);
    editor.stage.batchDraw();
    selectStamp(copy.id);
    refreshFilmstripBadge(item);
  }

  function deleteStamp(id) {
    const item = currentItem();
    if (!item) return;
    item.stamps = item.stamps.filter((s) => s.id !== id);
    if (state.selectedStampId === id) state.selectedStampId = null;
    rebuildStampNodes(item);
    editor.stage.batchDraw();
    updateSelectedControlsUI();
    updateStampButtonsEnabled();
    refreshFilmstripBadge(item);
  }

  function clearPageStamps() {
    const item = currentItem();
    if (!item || !item.stamps.length) return;
    item.stamps = [];
    state.selectedStampId = null;
    rebuildStampNodes(item);
    editor.stage.batchDraw();
    updateSelectedControlsUI();
    updateStampButtonsEnabled();
    refreshFilmstripBadge(item);
  }

  function updateSelectedControlsUI() {
    const stamp = selectedStamp();
    if (!stamp) {
      dom.selectedControls.hidden = true;
      dom.noSelectionHint.hidden = false;
      return;
    }
    dom.selectedControls.hidden = false;
    dom.noSelectionHint.hidden = true;
    const sizePct = Math.round(stamp.widthFrac * 100);
    dom.sizeSlider.value = String(sizePct);
    dom.sizeValue.textContent = sizePct + "%";
    const rot = Math.round(stamp.rotationDeg);
    dom.rotationSlider.value = String(rot);
    dom.rotationValue.textContent = rot + "°";
    const opPct = Math.round(stamp.opacity * 100);
    dom.opacitySlider.value = String(opPct);
    dom.opacityValue.textContent = opPct + "%";
  }

  function updateStampButtonsEnabled() {
    const hasSelection = !!selectedStamp();
    dom.duplicateBtn.disabled = !hasSelection;
    dom.deleteBtn.disabled = !hasSelection;
    const item = currentItem();
    dom.clearBtn.disabled = !item || item.stamps.length === 0;
    dom.tileBtn.disabled = !state.watermark.img || !item;
    dom.applyAllBtn.disabled = !item || item.stamps.length === 0 || state.items.length < 2;
    dom.presetGrid.querySelectorAll(".wm-preset-btn").forEach((btn) => {
      btn.disabled = !hasSelection;
    });
  }

  // -----------------------------------------------------------------
  // Quick-position presets: move the SELECTED stamp to one of nine
  // positions, inset from the edge by PRESET_MARGIN_FRAC so an edge or
  // corner preset doesn't bleed off by default (dragging it further out
  // is still allowed, per §6's "partial bleed is a legitimate style").
  // -----------------------------------------------------------------
  const PRESET_POSITIONS = {
    "top-left": ["top", "left"],
    "top-center": ["top", "center"],
    "top-right": ["top", "right"],
    "middle-left": ["middle", "left"],
    center: ["middle", "center"],
    "middle-right": ["middle", "right"],
    "bottom-left": ["bottom", "left"],
    "bottom-center": ["bottom", "center"],
    "bottom-right": ["bottom", "right"],
  };

  function applyPreset(presetName) {
    const stamp = selectedStamp();
    const item = currentItem();
    const parts = PRESET_POSITIONS[presetName];
    if (!stamp || !item || !parts) return;
    const [vPart, hPart] = parts;
    const dims = baseDims(item);
    const margin = CONFIG.PRESET_MARGIN_FRAC;
    const halfWFrac = stamp.widthFrac / 2;
    const heightPx = stamp.widthFrac * dims.w * state.watermark.aspect;
    const halfHFrac = heightPx / 2 / dims.h;

    stamp.cx = hPart === "left" ? clamp(margin + halfWFrac, 0, 1) : hPart === "right" ? clamp(1 - margin - halfWFrac, 0, 1) : 0.5;
    stamp.cy = vPart === "top" ? clamp(margin + halfHFrac, 0, 1) : vPart === "bottom" ? clamp(1 - margin - halfHFrac, 0, 1) : 0.5;

    applyStampModelToNode(stamp);
  }

  // -----------------------------------------------------------------
  // Tile: replaces this page's stamps with an evenly spaced N x N grid,
  // using the selected stamp (or the first existing one, or a fresh
  // default) as the template for size/rotation/opacity.
  // -----------------------------------------------------------------
  function tileStamps() {
    const item = currentItem();
    if (!item || !state.watermark.img) return;
    const n = clamp(parseInt(dom.tileSpacingSlider.value, 10), CONFIG.TILE_MIN_COUNT, CONFIG.TILE_MAX_COUNT);
    const template = selectedStamp() || item.stamps[0] || newStampAtCenter();

    const newStamps = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        newStamps.push({
          id: "st" + state.idCounter++,
          cx: (col + 0.5) / n,
          cy: (row + 0.5) / n,
          widthFrac: template.widthFrac,
          rotationDeg: template.rotationDeg,
          opacity: template.opacity,
        });
      }
    }

    item.stamps = newStamps;
    state.selectedStampId = null;
    rebuildStampNodes(item);
    editor.stage.batchDraw();
    updateSelectedControlsUI();
    updateStampButtonsEnabled();
    refreshFilmstripBadge(item);
  }

  // -----------------------------------------------------------------
  // Apply to all: copies the current item's stamp list onto every other
  // item, confirming first if that would overwrite existing stamps.
  // -----------------------------------------------------------------
  function applyToAll() {
    const item = currentItem();
    if (!item || !item.stamps.length) return;
    const others = state.items.filter((it) => it !== item);
    if (!others.length) return;

    const hasExisting = others.some((it) => it.stamps.length > 0);
    if (hasExisting) {
      const label = state.mode === "pdf" ? "pages" : "images";
      if (!window.confirm(`Some other ${label} already have stamps. Overwrite them with this one's arrangement?`)) return;
    }

    others.forEach((it) => {
      it.stamps = item.stamps.map((s) => Object.assign({}, s, { id: "st" + state.idCounter++ }));
    });
    renderFilmstrip();
  }

  // -----------------------------------------------------------------
  // Keyboard shortcuts on the selected stamp (ignored while typing)
  // -----------------------------------------------------------------
  const ARROW_DELTAS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

  document.addEventListener("keydown", (e) => {
    if (!editor) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedStampId) {
      e.preventDefault();
      deleteStamp(state.selectedStampId);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && state.selectedStampId) {
      e.preventDefault();
      duplicateStamp(state.selectedStampId);
      return;
    }
    if (ARROW_DELTAS[e.key] && state.selectedStampId) {
      e.preventDefault();
      const stamp = selectedStamp();
      if (!stamp) return;
      const stageW = editor.stage.width();
      const stageH = editor.stage.height();
      const stepPx = e.shiftKey ? CONFIG.NUDGE_PX_SHIFT : CONFIG.NUDGE_PX;
      const [dx, dy] = ARROW_DELTAS[e.key];
      stamp.cx = clamp(stamp.cx + (dx * stepPx) / stageW, 0, 1);
      stamp.cy = clamp(stamp.cy + (dy * stepPx) / stageH, 0, 1);
      applyStampModelToNode(stamp);
    }
  });

  // -----------------------------------------------------------------
  // Static event wiring
  // -----------------------------------------------------------------
  function wireStaticEvents() {
    dom.wmChooseBtn.addEventListener("click", () => dom.wmFileInput.click());
    dom.wmFileInput.addEventListener("change", () => {
      if (dom.wmFileInput.files && dom.wmFileInput.files[0]) processWatermarkFile(dom.wmFileInput.files[0]);
      dom.wmFileInput.value = "";
    });
    dom.watermarkReplaceBtn.addEventListener("click", () => dom.wmFileInput.click());
    wireDropzone(dom.wmDropzone, (files) => files[0] && processWatermarkFile(files[0]));

    dom.srcChooseBtn.addEventListener("click", () => dom.srcFileInput.click());
    dom.srcFileInput.addEventListener("change", () => {
      processSourceFiles(dom.srcFileInput.files);
      dom.srcFileInput.value = "";
    });
    wireDropzone(dom.srcDropzone, (files) => processSourceFiles(files));

    dom.addStampBtn.addEventListener("click", addStamp);
    dom.duplicateBtn.addEventListener("click", () => state.selectedStampId && duplicateStamp(state.selectedStampId));
    dom.deleteBtn.addEventListener("click", () => state.selectedStampId && deleteStamp(state.selectedStampId));
    dom.clearBtn.addEventListener("click", clearPageStamps);

    dom.sizeSlider.addEventListener("input", () => {
      const stamp = selectedStamp();
      if (!stamp) return;
      stamp.widthFrac = clamp(parseInt(dom.sizeSlider.value, 10) / 100, CONFIG.MIN_WIDTH_FRAC, CONFIG.MAX_WIDTH_FRAC);
      dom.sizeValue.textContent = dom.sizeSlider.value + "%";
      applyStampModelToNode(stamp);
    });
    dom.rotationSlider.addEventListener("input", () => {
      const stamp = selectedStamp();
      if (!stamp) return;
      stamp.rotationDeg = parseInt(dom.rotationSlider.value, 10);
      dom.rotationValue.textContent = dom.rotationSlider.value + "°";
      applyStampModelToNode(stamp);
    });
    dom.opacitySlider.addEventListener("input", () => {
      const stamp = selectedStamp();
      if (!stamp) return;
      stamp.opacity = clamp(parseInt(dom.opacitySlider.value, 10) / 100, CONFIG.MIN_OPACITY, 1);
      dom.opacityValue.textContent = dom.opacitySlider.value + "%";
      applyStampModelToNode(stamp);
    });

    dom.presetGrid.addEventListener("click", (e) => {
      const btn = e.target.closest(".wm-preset-btn");
      if (btn && !btn.disabled) applyPreset(btn.dataset.preset);
    });
    dom.tileSpacingSlider.addEventListener("input", () => {
      dom.tileSpacingValue.textContent = `${dom.tileSpacingSlider.value}×${dom.tileSpacingSlider.value}`;
    });
    dom.tileBtn.addEventListener("click", tileStamps);
    dom.applyAllBtn.addEventListener("click", applyToAll);

    window.addEventListener("resize", debounce(() => {
      const item = currentItem();
      if (item) buildOrUpdateEditor(item);
    }, 150));
  }

  function wireDropzone(el, onFiles) {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("wm-drag-over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("wm-drag-over"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("wm-drag-over");
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) onFiles(files);
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      const args = arguments;
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  // -----------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the PDF-loading section (added in a later commit) and
  // for potential debugging; harmless to leave on window.
  window.__watermarkerInternal = { state, stampsToPlacements };
})();
