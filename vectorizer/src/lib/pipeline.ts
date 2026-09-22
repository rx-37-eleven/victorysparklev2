// Orchestrates the centreline pipeline with per-stage caching, so moving one
// slider only recomputes that stage and everything downstream of it.
// Framework-free, callable from the worker (and from tests).
//
// The shape of the pipeline changed with the move to centreline tracing.
// It used to label enclosed regions first and let the cut line fall out of
// where two regions met, which meant the centre of a drawn line was never an
// object it could smooth or offset directly. Now the centreline is extracted
// first and fitted once, and both cut lines are offsets of that one fitted
// curve -- which is what makes the gap between two neighbouring pieces a
// constant width instead of whatever two independent fits happened to agree
// on.

import { medianFilter3x3 } from "./grayscale";
import { otsuThreshold, binarize, sauvolaThresholdMap } from "./threshold";
import { morphologicalClose, despeckle } from "./morphology";
import { skeletonize } from "./skeleton";
import {
  buildCenterlineGraph,
  dissolveDegreeTwoNodes,
  liveEdges,
  pruneSpurs,
  type CenterlineGraph,
} from "./centerline";
import { refinePolyline } from "./refine";
import { squaredDistanceTransform } from "./edt";
import { fitChain, type BezierSeg } from "./curveFit";
import { buildCutPieces, type CutPiece } from "./came";
import type { CapStyle } from "./stroke";
import { rasterizeCutPieces } from "./rasterize";
import { exportSvg, type ExportResult } from "./svgExport";
import {
  computeWarnings,
  computeMinWidthMmByLabel,
  DEFAULT_THRESHOLDS,
  type PieceWarning,
  type CuttabilityThresholds,
} from "./warnings";
import { pieceColor } from "./color";
import type { Chain, Piece } from "./boundaryGraph";

export interface PipelineParams {
  invert: boolean;
  cleanUpScan: boolean;
  threshold: number;
  adaptive: boolean;
  adaptiveWindow: number;
  closeGaps: number;
  despeckle: number;
  treatEdgeAsBorder: boolean;

  /**
   * Dangling branches shorter than this are pruned off the centreline. Small
   * values remove thinning whiskers; larger ones also remove genuine lines
   * that dead-end in open space.
   */
  pruneSpurMm: number;
  /** Re-centre the traced centreline against the source grayscale. */
  subpixelRefine: boolean;

  smoothingSigma: number;
  cornerAngleDeg: number;
  /**
   * How far a fitted curve may deviate from the traced geometry, in
   * millimetres. Physical rather than in pixels for the same reason the
   * offset is: a tolerance of "1.2px" means a millimetre on a 600px scan and
   * a fifth of that on a 3000px one, so the same drawing would be fitted to
   * visibly different accuracy depending on how it was scanned.
   */
  fitToleranceMm: number;

  /** Distance from the centreline to EACH cut line. The gap between two pieces is twice this. */
  offsetMm: number;
  /** Longest miter allowed at a junction, as a multiple of the offset. */
  miterLimit: number;
  /** How the band terminates at a line that dead-ends in open space. */
  endCap: CapStyle;
  /** Pieces smaller than this are offcut slivers, not glass. */
  minPieceAreaMm2: number;

  mmPerPx: number | null;
  thresholds: CuttabilityThresholds;
}

export const DEFAULT_PARAMS: PipelineParams = {
  invert: false,
  cleanUpScan: false,
  threshold: 128,
  adaptive: false,
  adaptiveWindow: 25,
  closeGaps: 1,
  despeckle: 4,
  treatEdgeAsBorder: true,
  pruneSpurMm: 1.5,
  subpixelRefine: true,
  smoothingSigma: 1.2,
  cornerAngleDeg: 55,
  fitToleranceMm: 0.1,
  offsetMm: 0.4,
  miterLimit: 3,
  endCap: "round",
  minPieceAreaMm2: 4,
  mmPerPx: null,
  thresholds: DEFAULT_THRESHOLDS,
};

interface Stage<K, V> {
  key: K | null;
  value: V | null;
}

function stage<K, V>(): Stage<K, V> {
  return { key: null, value: null };
}

export class PipelineCache {
  width = 0;
  height = 0;
  sourceGray: Float32Array | null = null;
  isJpeg = false;

  s0 = stage<string, Float32Array>(); // grayscale + median
  s1 = stage<string, Uint8Array>(); // binarize
  s2 = stage<string, Uint8Array>(); // gap close + despeckle
  s3 = stage<string, Uint8Array>(); // skeleton
  s4 = stage<string, CenterlineGraph>(); // centreline graph, pruned and dissolved
  s5 = stage<string, BezierSeg[][]>(); // refined + fitted centrelines
  s6 = stage<string, CutPiece[]>(); // cut pieces

  loadSource(gray: Float32Array, width: number, height: number, isJpeg: boolean): void {
    this.sourceGray = gray;
    this.width = width;
    this.height = height;
    this.isJpeg = isJpeg;
    this.s0 = stage();
    this.s1 = stage();
    this.s2 = stage();
    this.s3 = stage();
    this.s4 = stage();
    this.s5 = stage();
    this.s6 = stage();
  }
}

export function otsuDefault(cache: PipelineCache): number {
  if (!cache.sourceGray) return 128;
  return otsuThreshold(cache.sourceGray);
}

/** Pixels per millimetre, or 1 when no physical scale has been set yet. */
function pxPerMm(params: PipelineParams): number {
  return params.mmPerPx && params.mmPerPx > 0 ? 1 / params.mmPerPx : 1;
}

/**
 * How accurately the traced centreline can be known at all, in pixels.
 *
 * The centreline is recovered from a pixel grid. Sub-pixel re-centring gets
 * it to roughly a fifth of a pixel on clean line art and rather less on a
 * noisy scan, so a residual wobble of a few tenths of a pixel is the floor,
 * not something a tighter fit can remove. Asking Schneider's fit to track
 * the geometry closer than that just makes it chase the wobble: on a test
 * circle, tightening from 0.5px to 0.12px took the fit from 8 segments to
 * 43 without making it any closer to the real circle.
 */
const TRACE_ACCURACY_FLOOR_PX = 0.4;

/**
 * The fit tolerance in pixels, floored at what the trace can actually
 * resolve. On a high-resolution scan the physical tolerance governs; on a
 * coarse one the floor does, which is the honest answer -- the drawing is
 * not known more precisely than that however the tolerance is set.
 */
function maxErrorPx(params: PipelineParams): number {
  return Math.max(TRACE_ACCURACY_FLOOR_PX, params.fitToleranceMm * pxPerMm(params));
}

function getStage0(cache: PipelineCache, params: PipelineParams): Float32Array {
  const key = JSON.stringify([params.cleanUpScan, cache.isJpeg]);
  if (cache.s0.key === key && cache.s0.value) return cache.s0.value;
  const gray = cache.sourceGray!;
  const value = params.cleanUpScan || cache.isJpeg ? medianFilter3x3(gray, cache.width, cache.height) : gray;
  cache.s0 = { key, value };
  return value;
}

function getStage1(cache: PipelineCache, params: PipelineParams): Uint8Array {
  const gray = getStage0(cache, params);
  const key = JSON.stringify([params.threshold, params.adaptive, params.adaptiveWindow, params.invert]);
  if (cache.s1.key === key && cache.s1.value) return cache.s1.value;
  const value = binarize(gray, cache.width, cache.height, {
    threshold: params.threshold,
    adaptive: params.adaptive,
    window: params.adaptiveWindow,
    invert: params.invert,
  });
  cache.s1 = { key, value };
  return value;
}

function getStage2(cache: PipelineCache, params: PipelineParams): Uint8Array {
  const ink = getStage1(cache, params);
  const key = JSON.stringify([cache.s1.key, params.closeGaps, params.despeckle]);
  if (cache.s2.key === key && cache.s2.value) return cache.s2.value;
  let value = ink;
  if (params.closeGaps > 0) value = morphologicalClose(value, cache.width, cache.height, params.closeGaps);
  if (params.despeckle > 0) value = despeckle(value, cache.width, cache.height, params.despeckle);
  cache.s2 = { key, value };
  return value;
}

/** Stage 3 -- thin the ink to a one-pixel skeleton. */
function getStage3(cache: PipelineCache, params: PipelineParams): Uint8Array {
  const ink = getStage2(cache, params);
  const key = cache.s2.key; // no parameters of its own
  if (cache.s3.key === key && cache.s3.value) return cache.s3.value;
  const value = skeletonize(ink, cache.width, cache.height);
  cache.s3 = { key, value };
  return value;
}

/**
 * Stage 4 -- build the centreline graph, prune spurs, dissolve the nodes
 * that pruning left with only two edges.
 *
 * The graph is rebuilt from the cached skeleton whenever the prune threshold
 * changes rather than un-pruned in place, because pruning is destructive and
 * a partially-pruned graph is not a state worth representing.
 */
function getStage4(cache: PipelineCache, params: PipelineParams): CenterlineGraph {
  const skeleton = getStage3(cache, params);
  const key = JSON.stringify([cache.s3.key, params.pruneSpurMm, params.mmPerPx]);
  if (cache.s4.key === key && cache.s4.value) return cache.s4.value;

  const graph = buildCenterlineGraph(skeleton, cache.width, cache.height);
  pruneSpurs(graph, params.pruneSpurMm * pxPerMm(params));
  dissolveDegreeTwoNodes(graph);

  cache.s4 = { key, value: graph };
  return graph;
}

/**
 * Stage 5 -- re-centre each centreline against the grayscale, then fit it.
 *
 * This is the only fit in the pipeline. Both cut lines are offsets of what
 * comes out of here, so smoothing done once here is inherited by both,
 * instead of each cut line being fitted separately and drifting apart.
 */
function getStage5(cache: PipelineCache, params: PipelineParams): BezierSeg[][] {
  const graph = getStage4(cache, params);
  const key = JSON.stringify([
    cache.s4.key,
    params.subpixelRefine,
    params.smoothingSigma,
    params.cornerAngleDeg,
    params.fitToleranceMm,
    params.mmPerPx,
  ]);
  if (cache.s5.key === key && cache.s5.value) return cache.s5.value;

  const fitParams = {
    cornerAngleDeg: params.cornerAngleDeg,
    cornerSupport: Math.max(2, Math.round(Math.min(cache.width, cache.height) / 200) + 2),
    smoothingSigma: params.smoothingSigma,
    maxError: maxErrorPx(params),
  };

  let refineContext: { gray: Float32Array; threshold: Float32Array | number; halfWidth: Float64Array } | null = null;
  if (params.subpixelRefine) {
    const gray = getStage0(cache, params);
    const ink = getStage2(cache, params);
    // Distance from each ink pixel to the nearest non-ink pixel: the stroke's
    // local half-width. Capping the perpendicular search to a little more
    // than that stops the search running past this stroke and re-centring
    // onto the next line over.
    const nonInk = new Uint8Array(ink.length);
    for (let i = 0; i < ink.length; i++) nonInk[i] = ink[i] ? 0 : 1;
    refineContext = {
      gray,
      threshold: params.adaptive
        ? sauvolaThresholdMap(gray, cache.width, cache.height, params.adaptiveWindow)
        : params.threshold,
      halfWidth: squaredDistanceTransform(nonInk, cache.width, cache.height),
    };
  }

  const value: BezierSeg[][] = [];
  for (const edge of liveEdges(graph)) {
    let pts = edge.pts;
    if (refineContext) {
      const limits = pts.map((p) => {
        const px = Math.min(cache.width - 1, Math.max(0, Math.floor(p.x)));
        const py = Math.min(cache.height - 1, Math.max(0, Math.floor(p.y)));
        return Math.sqrt(refineContext!.halfWidth[py * cache.width + px]) + 1.5;
      });
      pts = refinePolyline(pts, {
        gray: refineContext.gray,
        width: cache.width,
        height: cache.height,
        threshold: refineContext.threshold,
        invert: params.invert,
        maxSearchPx: 4,
      }, limits);
    }
    const fitted = fitChain(pts, fitParams);
    if (fitted.length > 0) value.push(fitted);
  }

  cache.s5 = { key, value };
  return value;
}

/** Stage 6 -- stroke the centrelines and subtract, giving each piece's closed cut path. */
function getStage6(cache: PipelineCache, params: PipelineParams): CutPiece[] {
  const centrelines = getStage5(cache, params);
  const key = JSON.stringify([
    cache.s5.key,
    params.offsetMm,
    params.miterLimit,
    params.endCap,
    params.treatEdgeAsBorder,
    params.minPieceAreaMm2,
    params.mmPerPx,
  ]);
  if (cache.s6.key === key && cache.s6.value) return cache.s6.value;

  const scale = pxPerMm(params);
  const value = buildCutPieces(centrelines, {
    halfGapPx: params.offsetMm * scale,
    miterLimit: params.miterLimit,
    endCap: params.endCap,
    widthPx: cache.width,
    heightPx: cache.height,
    treatEdgeAsBorder: params.treatEdgeAsBorder,
    minPieceAreaPx2: params.minPieceAreaMm2 * scale * scale,
    fit: {
      cornerAngleDeg: params.cornerAngleDeg,
      cornerSupport: Math.max(2, Math.round(Math.min(cache.width, cache.height) / 200) + 2),
      smoothingSigma: params.smoothingSigma,
      maxError: maxErrorPx(params),
    },
    flattenTolerance: 0.05,
  });

  cache.s6 = { key, value };
  return value;
}

export interface PipelineResult {
  width: number;
  height: number;
  ink: Uint8Array;
  skeleton: Uint8Array;
  labels: Int32Array;
  pieceCount: number;
  centrelines: BezierSeg[][];
  cutPieces: CutPiece[];
  pieceColors: Map<number, [number, number, number]>;
  warnings: PieceWarning[];
  svg: ExportResult;
}

/**
 * Presents the cut pieces in the shape the warning stage expects.
 *
 * Each piece contributes one chain per ring and references them as a
 * single-chain ring, since offset pieces are disjoint by construction -- they
 * are separated by the came band, so there is no shared-edge bookkeeping to
 * do and nothing for two pieces to disagree about.
 */
function asChainGraph(pieces: CutPiece[]): { chains: Chain[]; pieceMap: Map<number, Piece> } {
  const chains: Chain[] = [];
  const pieceMap = new Map<number, Piece>();

  pieces.forEach((piece, index) => {
    const label = index + 1;
    const outerId = chains.length;
    chains.push({ id: outerId, a: -1, b: -1, pts: [], left: label, right: -2, fitted: piece.outer });
    const holes = piece.holes.map((holeSegs) => {
      const id = chains.length;
      chains.push({ id, a: -1, b: -1, pts: [], left: -2, right: label, fitted: holeSegs });
      return [{ chainId: id, reversed: false }];
    });
    pieceMap.set(label, { label, outer: [{ chainId: outerId, reversed: false }], holes });
  });

  return { chains, pieceMap };
}

/** Runs the pipeline through every stage needed for export/preview. */
export function runPipeline(cache: PipelineCache, params: PipelineParams): PipelineResult {
  const ink = getStage2(cache, params);
  const skeleton = getStage3(cache, params);
  const centrelines = getStage5(cache, params);
  const cutPieces = getStage6(cache, params);

  const labels = rasterizeCutPieces(cutPieces, cache.width, cache.height);
  const { chains, pieceMap } = asChainGraph(cutPieces);

  const pieceColors = new Map<number, [number, number, number]>();
  for (let i = 0; i < cutPieces.length; i++) pieceColors.set(i + 1, pieceColor(i));

  const mmPerPx = params.mmPerPx ?? 1;
  const minWidthByLabel = computeMinWidthMmByLabel(labels, cache.width, cache.height, mmPerPx);

  const svg = exportSvg(pieceMap, chains, {
    widthPx: cache.width,
    heightPx: cache.height,
    mmPerPx: params.mmPerPx,
    minWidthMmByLabel: minWidthByLabel,
  });

  const warnings = computeWarnings(
    {
      labels,
      width: cache.width,
      height: cache.height,
      pieceCount: cutPieces.length,
      chains,
      pieces: pieceMap,
      mmPerPx,
    },
    params.thresholds,
  );

  return {
    width: cache.width,
    height: cache.height,
    ink,
    skeleton,
    labels,
    pieceCount: cutPieces.length,
    centrelines,
    cutPieces,
    pieceColors,
    warnings,
    svg,
  };
}
