// Stage 5 — boundary graph extraction.
//
// Works on the crack lattice: vertices at pixel corners, a (W+1)x(H+1) grid.
// A lattice edge exists between two adjacent corners when the two pixels
// flanking it have different labels. Pixels outside the raster are treated
// as a distinct OUTSIDE sentinel so border-touching pieces (when "treat
// image edge as panel border" is off) still get a closed ring along the
// image edge.
//
// Chains are fit ONCE per shared seam and referenced by both adjacent
// pieces (one forward, one reversed) -- this is what keeps adjacent pieces
// watertight: they literally share the same point array.

import type { BezierSeg } from "./curveFit";

export interface Point {
  x: number;
  y: number;
}

export const OUTSIDE = -2;

export interface Chain {
  id: number;
  a: number; // node id (vertex id) at the start
  b: number; // node id at the end
  pts: Point[]; // raw lattice polyline, a -> b, inclusive
  left: number; // label on one side, consistent along the whole chain
  right: number; // label on the other side
  fitted?: BezierSeg[]; // filled in by Stage 6, fitted exactly once per chain
}

export interface Ring {
  chainId: number;
  reversed: boolean;
}

export interface Piece {
  label: number;
  outer: Ring[];
  holes: Ring[][];
}

export interface BoundaryGraph {
  chains: Chain[];
  pieces: Map<number, Piece>;
}

function vertexId(cx: number, cy: number, width: number): number {
  return cy * (width + 1) + cx;
}

function vertexCoord(id: number, width: number): Point {
  const stride = width + 1;
  return { x: id % stride, y: Math.floor(id / stride) };
}

/** For a directed unit-length lattice edge a->b, returns the two flanking pixel indices. */
function edgeSides(ax: number, ay: number, bx: number, by: number): { sideA: [number, number]; sideB: [number, number] } {
  const dx = bx - ax;
  const dy = by - ay;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const sideA: [number, number] = [Math.floor(mx - dy * 0.5), Math.floor(my + dx * 0.5)];
  const sideB: [number, number] = [Math.floor(mx + dy * 0.5), Math.floor(my - dx * 0.5)];
  return { sideA, sideB };
}

export function extractBoundaryGraph(labels: Int32Array, width: number, height: number): BoundaryGraph {
  const labelAt = (x: number, y: number): number => {
    if (x < 0 || x >= width || y < 0 || y >= height) return OUTSIDE;
    return labels[y * width + x];
  };

  const vw = width + 1; // vertex grid width
  const vh = height + 1;

  // hEdge[cy*width+cx] = edge from (cx,cy) to (cx+1,cy) exists (separates pixel(cx,cy-1) above / pixel(cx,cy) below)
  const hEdge = new Uint8Array(vh * width);
  for (let cy = 0; cy < vh; cy++) {
    for (let cx = 0; cx < width; cx++) {
      hEdge[cy * width + cx] = labelAt(cx, cy - 1) !== labelAt(cx, cy) ? 1 : 0;
    }
  }
  // vEdge[cy*vw+cx] = edge from (cx,cy) to (cx,cy+1) exists (separates pixel(cx-1,cy) left / pixel(cx,cy) right)
  const vEdge = new Uint8Array(height * vw);
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < vw; cx++) {
      vEdge[cy * vw + cx] = labelAt(cx - 1, cy) !== labelAt(cx, cy) ? 1 : 0;
    }
  }

  const hasRight = (cx: number, cy: number): boolean => cx < width && hEdge[cy * width + cx] === 1;
  const hasLeft = (cx: number, cy: number): boolean => cx > 0 && hEdge[cy * width + (cx - 1)] === 1;
  const hasDown = (cx: number, cy: number): boolean => cy < height && vEdge[cy * vw + cx] === 1;
  const hasUp = (cx: number, cy: number): boolean => cy > 0 && vEdge[(cy - 1) * vw + cx] === 1;

  function degree(cx: number, cy: number): number {
    let d = 0;
    if (hasRight(cx, cy)) d++;
    if (hasLeft(cx, cy)) d++;
    if (hasDown(cx, cy)) d++;
    if (hasUp(cx, cy)) d++;
    return d;
  }

  function neighborsOf(cx: number, cy: number): Point[] {
    const out: Point[] = [];
    if (hasRight(cx, cy)) out.push({ x: cx + 1, y: cy });
    if (hasLeft(cx, cy)) out.push({ x: cx - 1, y: cy });
    if (hasDown(cx, cy)) out.push({ x: cx, y: cy + 1 });
    if (hasUp(cx, cy)) out.push({ x: cx, y: cy - 1 });
    return out;
  }

  const isNode = new Uint8Array(vw * vh);
  for (let cy = 0; cy < vh; cy++) {
    for (let cx = 0; cx < vw; cx++) {
      const d = degree(cx, cy);
      if (d === 1) {
        throw new Error(`Boundary graph: dangling degree-1 vertex at (${cx},${cy}) -- expected closed boundaries only.`);
      }
      if (d !== 0 && d !== 2) isNode[cy * vw + cx] = 1;
    }
  }

  // Consumed undirected edges, keyed by the smaller-then-larger vertex id pair.
  const consumed = new Set<string>();
  const edgeKey = (u: number, v: number): string => (u < v ? `${u}-${v}` : `${v}-${u}`);

  const chains: Chain[] = [];
  let nextChainId = 0;

  function walkChain(startCx: number, startCy: number, firstNeighbor: Point): Chain {
    const pts: Point[] = [{ x: startCx, y: startCy }];
    let curX = startCx;
    let curY = startCy;
    let nx = firstNeighbor.x;
    let ny = firstNeighbor.y;
    const startId = vertexId(startCx, startCy, width);

    for (;;) {
      pts.push({ x: nx, y: ny });
      consumed.add(edgeKey(vertexId(curX, curY, width), vertexId(nx, ny, width)));
      curX = nx;
      curY = ny;
      const curId = vertexId(curX, curY, width);
      if (isNode[curId] === 1 || curId === startId) break;
      const neighbors = neighborsOf(curX, curY).filter(
        (p) => !consumed.has(edgeKey(curId, vertexId(p.x, p.y, width))),
      );
      if (neighbors.length === 0) break; // closed loop back to start handled above; safety net
      const next = neighbors[0];
      nx = next.x;
      ny = next.y;
    }

    const { sideA, sideB } = edgeSides(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
    const left = labelAt(sideA[0], sideA[1]);
    const right = labelAt(sideB[0], sideB[1]);
    const chain: Chain = {
      id: nextChainId++,
      a: vertexId(pts[0].x, pts[0].y, width),
      b: vertexId(pts[pts.length - 1].x, pts[pts.length - 1].y, width),
      pts,
      left,
      right,
    };
    chains.push(chain);
    return chain;
  }

  // Pass 1: walk every chain that starts at a real node.
  for (let cy = 0; cy < vh; cy++) {
    for (let cx = 0; cx < vw; cx++) {
      if (isNode[cy * vw + cx] !== 1) continue;
      for (const nb of neighborsOf(cx, cy)) {
        const key = edgeKey(vertexId(cx, cy, width), vertexId(nb.x, nb.y, width));
        if (consumed.has(key)) continue;
        walkChain(cx, cy, nb);
      }
    }
  }

  // Pass 2: isolated loops with no node at all (piece entirely enclosed by
  // one other piece, e.g. an island). Designate an arbitrary start vertex as
  // a synthetic node.
  for (let cy = 0; cy < vh; cy++) {
    for (let cx = 0; cx < vw; cx++) {
      const neighbors = neighborsOf(cx, cy);
      for (const nb of neighbors) {
        const key = edgeKey(vertexId(cx, cy, width), vertexId(nb.x, nb.y, width));
        if (consumed.has(key)) continue;
        isNode[cy * vw + cx] = 1; // synthetic node
        walkChain(cx, cy, nb);
      }
    }
  }

  const pieces = assemblePieces(chains);
  return { chains, pieces };
}

/** Concatenated point sequence for a ring, dropping the duplicate shared vertex between consecutive chains. */
function ringPoints(chains: Chain[], ring: Ring[]): Point[] {
  const pts: Point[] = [];
  for (const r of ring) {
    const chain = chains[r.chainId];
    const segment = r.reversed ? [...chain.pts].reverse() : chain.pts;
    if (pts.length > 0) {
      for (let i = 1; i < segment.length; i++) pts.push(segment[i]);
    } else {
      pts.push(...segment);
    }
  }
  return pts;
}

function ringSignedArea(chains: Chain[], ring: Ring[]): number {
  const pts = ringPoints(chains, ring);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}

function assemblePieces(chains: Chain[]): Map<number, Piece> {
  const byLabel = new Map<number, { chain: Chain; reversed: boolean }[]>();
  for (const chain of chains) {
    addIfPiece(byLabel, chain.left, chain, false);
    addIfPiece(byLabel, chain.right, chain, true);
  }

  const pieces = new Map<number, Piece>();
  for (const [label, instances] of byLabel) {
    const rings = assembleRingsForPiece(instances);
    const withArea = rings.map((ring) => ({ ring, area: ringSignedArea(chains, ring) }));
    withArea.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    // Canonical winding: outer ring positive area, holes negative. fill-rule
    // evenodd doesn't need this for correct rendering, but a consistent
    // orientation is what lets later curvature-based checks (concave vs.
    // convex) tell which side of a curve is "into the glass."
    const outer = withArea.length > 0 ? normalizeWinding(withArea[0].ring, withArea[0].area, true) : [];
    const holes = withArea.slice(1).map((w) => normalizeWinding(w.ring, w.area, false));
    pieces.set(label, { label, outer, holes });
  }
  return pieces;
}

function normalizeWinding(ring: Ring[], area: number, wantPositive: boolean): Ring[] {
  const isPositive = area > 0;
  if (isPositive === wantPositive) return ring;
  return [...ring].reverse().map((r) => ({ chainId: r.chainId, reversed: !r.reversed }));
}

function addIfPiece(
  byLabel: Map<number, { chain: Chain; reversed: boolean }[]>,
  label: number,
  chain: Chain,
  reversed: boolean,
): void {
  if (label < 0) return; // -1 (background) and OUTSIDE are never exported pieces
  pushTo(byLabel, label, { chain, reversed });
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function assembleRingsForPiece(instances: { chain: Chain; reversed: boolean }[]): Ring[][] {
  const byStartNode = new Map<number, { chain: Chain; reversed: boolean }[]>();
  for (const inst of instances) {
    const startNode = inst.reversed ? inst.chain.b : inst.chain.a;
    pushTo(byStartNode, startNode, inst);
  }

  const used = new Set<number>();
  const rings: Ring[][] = [];
  for (const inst of instances) {
    if (used.has(inst.chain.id)) continue;
    const ring: Ring[] = [];
    let current = inst;
    for (;;) {
      used.add(current.chain.id);
      ring.push({ chainId: current.chain.id, reversed: current.reversed });
      const endNode = current.reversed ? current.chain.a : current.chain.b;
      const candidates = byStartNode.get(endNode) ?? [];
      const next = candidates.find((c) => !used.has(c.chain.id));
      if (!next) break;
      current = next;
      if (current.chain.id === ring[0].chainId) break;
    }
    rings.push(ring);
  }
  return rings;
}

export function vertexPoint(id: number, width: number): Point {
  return vertexCoord(id, width);
}
