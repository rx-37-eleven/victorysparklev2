# Stained Glass Vectorizer

A browser-based tool that converts black-and-white stained-glass line art
(PNG/JPG) into an SVG where each glass piece is one closed cut path -- ready
to print, cut, and grind. Entirely client-side: no image ever leaves the
browser.

## How it traces

The drawing's lines are the *lead*, not the cut. What gets cut is a pair of
lines running either side of each drawn line, one per neighbouring piece,
with the came or foil sitting in the gap between them. So the pipeline
extracts the centre of every drawn line first, fits that once, and derives
both cut lines from it as exact offsets:

- **Stages 0-2** (`src/lib/grayscale.ts`, `threshold.ts`, `morphology.ts`) --
  decode, binarize (Otsu or Sauvola adaptive), close gaps, despeckle.
- **Stage 3** (`src/lib/skeleton.ts`) -- Zhang-Suen thinning down to a
  one-pixel skeleton running along the middle of every drawn line, whatever
  that line's weight, followed by a simple-point pass that removes the
  two-pixel-thick patches thinning leaves on diagonal runs.
- **Stage 4** (`src/lib/centerline.ts`) -- the skeleton becomes a graph of
  nodes (junctions and line ends) and edges (the runs between them). Junction
  pixel clusters collapse to one node, dangling branches shorter than the
  trim threshold are pruned, and a node left with two edges is dissolved so
  the fit runs smoothly through it instead of planting a corner.
- **Stage 5** (`src/lib/refine.ts`) -- each centreline is re-centred against
  the source *grayscale*. Anti-aliasing along the edge of a drawn line
  records where that edge really fell to a fraction of a pixel, so walking
  out perpendicular to the line and interpolating the threshold crossing on
  each side recovers the true centre rather than the nearest pixel.
- **Stage 6** (`src/lib/curveFit.ts`, `stroke.ts`) -- corner detection and
  Schneider Bezier fitting, run **once**, on the centreline. Then
  `stroke.ts` builds the two curves that run exactly the offset distance
  either side of it, with mitered joins at junctions.
- **Stage 7** (`src/lib/came.ts`) -- the strokes are unioned into the came
  band and subtracted from the panel; what is left is one closed region per
  glass piece, re-fitted to cubics and checked against the exact offset
  polygon before being accepted.
- **Stage 8** (`src/lib/warnings.ts`, `rasterize.ts`) -- the finished pieces
  are rasterized back to labels so the cuttability warnings (small pieces,
  narrow necks, sharp corners, tight concave curves) measure the shape that
  will actually be cut.
- **Export** (`src/lib/svgExport.ts`) -- one `<path>` per piece, absolute
  coordinates, no transforms.

`src/lib/pipeline.ts` orchestrates all of the above with per-stage caching;
`src/worker/pipeline.worker.ts` runs it off the main thread.

### Why the offset is a pipeline input, not an export setting

Offsetting is not a linear operation, so a single SVG cannot be correct at
two finished sizes: at 12in a 0.4mm gap is a much larger fraction of the
drawing than at 30in, corners round differently, and a narrow neck that
survives at one size collapses at the other. Scaling an exported file would
scale the gap with it.

So the panel's finished width is an input. The offset is converted from
millimetres to pixels using it, the geometry is built at that scale, and the
gap between neighbouring pieces comes out at the width you asked for whatever
size the panel is set to. Export once per target size.

The fit tolerance is physical for the same reason -- a tolerance in pixels
would mean a millimetre on a coarse scan and a fifth of that on a fine one.
It is floored at what the trace can actually resolve, since the centreline is
recovered from a pixel grid and asking the fit to track it more closely than
that only makes it chase the wobble.

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

### Known gap

`tests/metrics.test.ts` carries one soft failure: on a deliberately
adversarial 5-point star, 2 of 10 needle-sharp (~40 degree) tips are not
detected as corners. At a corner angle representative of real stained glass
the same fixture scores 10/10. This predates the centreline rework and is
unchanged by it.
