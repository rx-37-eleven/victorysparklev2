# Stained Glass Vectorizer

A browser-based tool that converts black-and-white stained-glass line art
(PNG/JPG) into an SVG where each enclosed region becomes one watertight
closed path -- ready to print, cut, and grind. Entirely client-side: no
image ever leaves the browser.

Built to the spec in `stainedglassvectorizerspec.md`. The pipeline:

- **Stages 0-2** (`src/lib/grayscale.ts`, `threshold.ts`, `morphology.ts`) --
  decode, binarize (Otsu or Sauvola adaptive), close gaps, despeckle.
- **Stages 3-4** (`src/lib/ccl.ts`, `edt.ts`, `pieces.ts`) -- connected-component
  labeling and an exact Euclidean distance transform watershed that claims
  the ink pixel-by-pixel, landing cut lines on the centerline of the drawn
  line regardless of its width.
- **Stage 5** (`src/lib/boundaryGraph.ts`) -- crack-lattice boundary
  extraction into a shared chain graph, so adjacent pieces reference the
  exact same seam data (watertight by construction, not by coincidence).
- **Stage 6** (`src/lib/curveFit.ts`) -- corner detection and Schneider
  Bezier fitting, fit once per chain.
- **Stage 7** (`src/lib/offset.ts`) -- kerf/came offset via Clipper2.
- **Stage 8** (`src/lib/warnings.ts`) -- cuttability warnings (small pieces,
  narrow necks, sharp corners, tight concave curves).
- **Export** (`src/lib/svgExport.ts`) -- the SVG output contract.

`src/lib/pipeline.ts` orchestrates all of the above with per-stage caching;
`src/worker/pipeline.worker.ts` runs it off the main thread.

## Development

```sh
npm install
npm run dev      # local dev server
npm test         # vitest -- synthetic fixtures + invariant checks
npm run build    # type-checks, then builds into ../_site/apps/stained-glass-vectorizer
```

The production build is wired into the parent Eleventy site's build
(`npm run build` at the repo root) and served at
`/apps/stained-glass-vectorizer/`.
