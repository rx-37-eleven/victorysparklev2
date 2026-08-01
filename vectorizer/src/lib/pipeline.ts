// Orchestrates stages 0-8 with per-stage caching, so moving one slider only
// recomputes that stage and everything downstream of it -- not the whole
// pipeline. Framework-free, callable from the worker (and from tests).

import { medianFilter3x3 } from "./grayscale";
import { otsuThreshold, binarize } from "./threshold";
import { morphologicalClose, despeckle } from "./morphology";
import { computePieces } from "./pieces";
import { extractBoundaryGraph, type Chain, type Piece } from "./boundaryGraph";
import { fitAllChains } from "./curveFit";
import { offsetPiece, type OffsetOutcome } from "./offset";
import { exportSvg, type ExportResult } from "./svgExport";
import { computeWarnings, computeMinWidthMmByLabel, DEFAULT_THRESHOLDS, type PieceWarning, type CuttabilityThresholds } from "./warnings";
import { pieceColor } from "./color";

export interface PipelineParams {
  invert: boolean;
  cleanUpScan: boolean;
  threshold: number;
  adaptive: boolean;
  adaptiveWindow: number;
  closeGaps: number;
  despeckle: number;
  treatEdgeAsBorder: boolean;
  minRegionPx: number;
  smoothingSigma: number;
  cornerAngleDeg: number;
  maxErrorPx: number;
  offsetMm: number;
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
  minRegionPx: 20,
  smoothingSigma: 1.2,
  cornerAngleDeg: 55,
  maxErrorPx: 1.2,
  offsetMm: 0,
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
  s3 = stage<string, { labels: Int32Array; pieceCount: number; distSq: Float64Array }>(); // pieces
  s5 = stage<string, { chains: Chain[]; pieces: Map<number, Piece> }>(); // boundary graph
  s6key: string | null = null; // curve fit params key (mutates s5 chains in place)

  loadSource(gray: Float32Array, width: number, height: number, isJpeg: boolean): void {
    this.sourceGray = gray;
    this.width = width;
    this.height = height;
    this.isJpeg = isJpeg;
    this.s0 = stage();
    this.s1 = stage();
    this.s2 = stage();
    this.s3 = stage();
    this.s5 = stage();
    this.s6key = null;
  }
}

export function otsuDefault(cache: PipelineCache): number {
  if (!cache.sourceGray) return 128;
  return otsuThreshold(cache.sourceGray);
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
  const key = JSON.stringify([params.closeGaps, params.despeckle]);
  if (cache.s2.key === key && cache.s2.value) return cache.s2.value;
  let value = ink;
  if (params.closeGaps > 0) value = morphologicalClose(value, cache.width, cache.height, params.closeGaps);
  if (params.despeckle > 0) value = despeckle(value, cache.width, cache.height, params.despeckle);
  cache.s2 = { key, value };
  return value;
}

function getStage3(cache: PipelineCache, params: PipelineParams) {
  const ink = getStage2(cache, params);
  const key = JSON.stringify([params.treatEdgeAsBorder, params.minRegionPx]);
  if (cache.s3.key === key && cache.s3.value) return cache.s3.value;
  const value = computePieces(ink, cache.width, cache.height, {
    treatEdgeAsBorder: params.treatEdgeAsBorder,
    minRegionPx: params.minRegionPx,
  });
  cache.s3 = { key, value };
  return value;
}

function getStage5(cache: PipelineCache, params: PipelineParams) {
  const pieces3 = getStage3(cache, params);
  const key = cache.s3.key; // stage5 has no params of its own; it depends only on stage3's identity
  if (cache.s5.key === key && cache.s5.value) return cache.s5.value;
  const value = extractBoundaryGraph(pieces3.labels, cache.width, cache.height);
  cache.s5 = { key, value };
  cache.s6key = null; // force refit
  return value;
}

function getStage6Fitted(cache: PipelineCache, params: PipelineParams): { chains: Chain[]; pieces: Map<number, Piece> } {
  const graph = getStage5(cache, params);
  const key = JSON.stringify([params.smoothingSigma, params.cornerAngleDeg, params.maxErrorPx]);
  if (cache.s6key !== key) {
    fitAllChains(graph.chains, {
      cornerAngleDeg: params.cornerAngleDeg,
      cornerSupport: Math.max(2, Math.round(Math.min(cache.width, cache.height) / 200) + 2),
      smoothingSigma: params.smoothingSigma,
      maxError: params.maxErrorPx,
    });
    cache.s6key = key;
  }
  return graph;
}

export interface PieceRenderInfo {
  label: number;
  color: [number, number, number];
}

export interface PipelineResult {
  width: number;
  height: number;
  ink: Uint8Array;
  labels: Int32Array;
  pieceCount: number;
  chains: Chain[];
  pieces: Map<number, Piece>;
  pieceColors: Map<number, [number, number, number]>;
  warnings: PieceWarning[];
  svg: ExportResult;
  offsetOutcomes: Map<number, OffsetOutcome>;
}

/** Runs the pipeline through every stage needed for export/preview. */
export function runPipeline(cache: PipelineCache, params: PipelineParams): PipelineResult {
  const ink = getStage2(cache, params);
  const pieces3 = getStage3(cache, params);
  const graph = getStage6Fitted(cache, params);

  const pieceColors = new Map<number, [number, number, number]>();
  let i = 0;
  for (const label of graph.pieces.keys()) pieceColors.set(label, pieceColor(i++));

  const mmPerPx = params.mmPerPx ?? 1;
  const minWidthByLabel = computeMinWidthMmByLabel(pieces3.labels, cache.width, cache.height, mmPerPx);

  const offsetOutcomes = new Map<number, OffsetOutcome>();
  let exportPieces = graph.pieces;
  let exportChains = graph.chains;
  const deltaPx = params.mmPerPx ? params.offsetMm / params.mmPerPx : 0;
  if (deltaPx > 0) {
    // Offsetting produces its own standalone (non-shared-edge) geometry per
    // piece; rebuild a piece map of single-ring outers/holes for export.
    const offsetChains: Chain[] = [];
    const offsetPiecesMap = new Map<number, Piece>();
    for (const [label, piece] of graph.pieces) {
      const result = offsetPiece(piece, graph.chains, deltaPx, {
        cornerAngleDeg: params.cornerAngleDeg,
        cornerSupport: 4,
        smoothingSigma: params.smoothingSigma,
        maxError: params.maxErrorPx,
      });
      offsetOutcomes.set(label, result.outcome);
      const outerChainId = offsetChains.length;
      offsetChains.push({ id: outerChainId, a: -1, b: -1, pts: [], left: label, right: -2, fitted: result.outer });
      const holeRings = result.holes.map((holeSegs) => {
        const id = offsetChains.length;
        offsetChains.push({ id, a: -1, b: -1, pts: [], left: -2, right: label, fitted: holeSegs });
        return [{ chainId: id, reversed: false }];
      });
      offsetPiecesMap.set(label, {
        label,
        outer: [{ chainId: outerChainId, reversed: false }],
        holes: holeRings,
      });
    }
    exportChains = offsetChains;
    exportPieces = offsetPiecesMap;
  }

  const svg = exportSvg(exportPieces, exportChains, {
    widthPx: cache.width,
    heightPx: cache.height,
    mmPerPx: params.mmPerPx,
    minWidthMmByLabel: minWidthByLabel,
  });

  const warnings = computeWarnings(
    {
      labels: pieces3.labels,
      width: cache.width,
      height: cache.height,
      pieceCount: pieces3.pieceCount,
      chains: graph.chains,
      pieces: graph.pieces,
      mmPerPx,
    },
    params.thresholds,
  );

  return {
    width: cache.width,
    height: cache.height,
    ink,
    labels: pieces3.labels,
    pieceCount: pieces3.pieceCount,
    chains: graph.chains,
    pieces: graph.pieces,
    pieceColors,
    warnings,
    svg,
    offsetOutcomes,
  };
}
