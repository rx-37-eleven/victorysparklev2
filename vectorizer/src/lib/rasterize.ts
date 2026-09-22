// Rasterizes the finished cut pieces back to a label image.
//
// The piece geometry is now vector-first -- pieces come out of a boolean
// operation on offset curves, not out of a labelled raster -- but two things
// downstream still want a label per pixel: the preview's per-piece colouring,
// and the cuttability warnings, whose inscribed-circle and narrow-neck
// measures are distance transforms over the piece's actual filled area.
// Rendering the vectors back to labels keeps those working on exactly the
// shape that will be cut, rather than on the pre-offset regions.

import type { FlatPoint } from "./offset";

export interface RasterizablePiece {
  outerFlat: FlatPoint[];
  holesFlat: FlatPoint[][];
}

interface Edge {
  yMin: number;
  yMax: number;
  xAtYMin: number;
  slope: number; // dx/dy
}

function collectEdges(rings: FlatPoint[][]): Edge[] {
  const edges: Edge[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a.y === b.y) continue; // horizontal edges never cross a scanline centre
      const top = a.y < b.y ? a : b;
      const bottom = a.y < b.y ? b : a;
      edges.push({
        yMin: top.y,
        yMax: bottom.y,
        xAtYMin: top.x,
        slope: (bottom.x - top.x) / (bottom.y - top.y),
      });
    }
  }
  return edges;
}

/**
 * Fills each piece with its own label (1-based, matching the order given).
 * 0 means no piece -- the came band, or outside the panel.
 *
 * Even-odd across the outer ring and its holes together, so a hole is
 * unfilled without needing a second pass. Scanlines are sampled at pixel
 * centres, which is what makes the raster agree with what the SVG shows.
 */
export function rasterizeCutPieces(pieces: RasterizablePiece[], width: number, height: number): Int32Array {
  const labels = new Int32Array(width * height);

  pieces.forEach((piece, index) => {
    const label = index + 1;
    const rings = [piece.outerFlat, ...piece.holesFlat];
    const edges = collectEdges(rings);
    if (edges.length === 0) return;

    let minY = Infinity;
    let maxY = -Infinity;
    for (const edge of edges) {
      if (edge.yMin < minY) minY = edge.yMin;
      if (edge.yMax > maxY) maxY = edge.yMax;
    }

    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(height - 1, Math.ceil(maxY));
    const crossings: number[] = [];

    for (let y = yStart; y <= yEnd; y++) {
      const sampleY = y + 0.5;
      crossings.length = 0;
      for (const edge of edges) {
        // Half-open in y so a vertex shared by two edges is counted once.
        if (sampleY < edge.yMin || sampleY >= edge.yMax) continue;
        crossings.push(edge.xAtYMin + (sampleY - edge.yMin) * edge.slope);
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);

      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const xStart = Math.max(0, Math.ceil(crossings[i] - 0.5));
        const xEnd = Math.min(width - 1, Math.floor(crossings[i + 1] - 0.5));
        const row = y * width;
        for (let x = xStart; x <= xEnd; x++) labels[row + x] = label;
      }
    }
  });

  return labels;
}
