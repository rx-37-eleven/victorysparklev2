// Stage 4 -- centreline graph.
//
// Turns the one-pixel skeleton into a graph of nodes (line ends and
// junctions) and edges (the runs of line between them), then cleans it up so
// it describes the drawing's lead lines rather than the raster's accidents:
//
//   - junction pixel clusters collapse to a single node, so the three arms of
//     a Y meet at one point instead of at three pixels a step apart;
//   - short dangling branches (thinning artefacts, or genuine dead-end lines,
//     depending on the threshold) are pruned;
//   - a node left with exactly two edges is dissolved and its edges spliced,
//     so the fit runs smoothly through it rather than planting a corner.
//
// Everything downstream -- smoothing, fitting, offsetting -- operates on this
// graph, which is why the centre of the drawn line is the one thing in the
// pipeline that gets fitted, and both cut lines inherit that fit.

export interface Point {
  x: number;
  y: number;
}

export interface CenterlineNode {
  id: number;
  /** Centroid of the node's pixel cluster, in pixel-centre coordinates. */
  x: number;
  y: number;
  /** Incident edge ids. A self-loop lists its edge twice. */
  edges: number[];
  /** True for a node that only ever had one incident edge -- a line end. */
  terminal: boolean;
}

export interface CenterlineEdge {
  id: number;
  a: number;
  b: number;
  /** Polyline from node a to node b, inclusive of both node positions. */
  pts: Point[];
}

export interface CenterlineGraph {
  nodes: (CenterlineNode | null)[];
  edges: (CenterlineEdge | null)[];
}

const NEIGHBOUR_DX = [0, 1, 1, 1, 0, -1, -1, -1];
const NEIGHBOUR_DY = [-1, -1, 0, 1, 1, 1, 0, -1];

function pixelCentre(index: number, width: number): Point {
  const y = Math.floor(index / width);
  return { x: (index % width) + 0.5, y: y + 0.5 };
}

/** Live (non-deleted) nodes and edges, for callers that don't want to filter. */
export function liveNodes(graph: CenterlineGraph): CenterlineNode[] {
  return graph.nodes.filter((n): n is CenterlineNode => n !== null);
}

export function liveEdges(graph: CenterlineGraph): CenterlineEdge[] {
  return graph.edges.filter((e): e is CenterlineEdge => e !== null);
}

export function polylineLength(pts: Point[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return total;
}

/**
 * Builds the node/edge graph from a thinned skeleton (1 = skeleton pixel).
 *
 * Isolated single pixels are dropped -- they carry no line. Closed loops with
 * no junction anywhere on them (a lone circle, say) get one synthetic node so
 * they can still be represented as an edge from that node back to itself.
 */
export function buildCenterlineGraph(skeleton: Uint8Array, width: number, height: number): CenterlineGraph {
  const size = width * height;
  const degree = new Uint8Array(size);

  const neighbourIndices = (index: number, out: number[]): number => {
    const x = index % width;
    const y = (index - x) / width;
    let count = 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + NEIGHBOUR_DX[k];
      const ny = y + NEIGHBOUR_DY[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (skeleton[ni]) out[count++] = ni;
    }
    return count;
  };

  const scratch: number[] = new Array(8);
  for (let i = 0; i < size; i++) {
    if (skeleton[i]) degree[i] = neighbourIndices(i, scratch);
  }

  // Cluster the non-degree-2 pixels into nodes. Thinning routinely leaves two
  // or three mutually adjacent pixels at a junction; treating each as its own
  // node would produce spurious zero-length edges and split one meeting point
  // into several, so an 8-connected cluster becomes one node.
  const nodeOf = new Int32Array(size).fill(-1);
  const nodes: (CenterlineNode | null)[] = [];
  // The pixels making up each node's cluster, kept from the flood fill below.
  // Re-deriving them by scanning the image per node instead would make edge
  // tracing O(nodes x pixels), which is unnoticeable on a drawing with a
  // handful of junctions and ruinous on a real panel with hundreds.
  const clusterPixels: number[][] = [];
  const queue: number[] = [];

  for (let seed = 0; seed < size; seed++) {
    if (!skeleton[seed] || degree[seed] === 2 || nodeOf[seed] !== -1) continue;
    if (degree[seed] === 0) continue; // isolated speck, carries no line

    const id = nodes.length;
    const cluster: number[] = [];
    queue.length = 0;
    queue.push(seed);
    nodeOf[seed] = id;

    while (queue.length > 0) {
      const current = queue.pop()!;
      cluster.push(current);
      const count = neighbourIndices(current, scratch);
      for (let k = 0; k < count; k++) {
        const next = scratch[k];
        if (degree[next] === 2 || nodeOf[next] !== -1) continue;
        nodeOf[next] = id;
        queue.push(next);
      }
    }

    let sx = 0;
    let sy = 0;
    for (const index of cluster) {
      const p = pixelCentre(index, width);
      sx += p.x;
      sy += p.y;
    }
    nodes.push({ id, x: sx / cluster.length, y: sy / cluster.length, edges: [], terminal: false });
    clusterPixels.push(cluster);
    // A cluster is a line end only if the whole cluster has a single outward
    // arm; that is recomputed from the finished edge lists below.
  }

  const edges: (CenterlineEdge | null)[] = [];
  const consumed = new Uint8Array(size); // degree-2 pixels already walked
  const directPairs = new Set<string>(); // adjacent node pixels in different clusters

  const addEdge = (a: number, b: number, pts: Point[]): void => {
    const id = edges.length;
    edges.push({ id, a, b, pts });
    nodes[a]!.edges.push(id);
    nodes[b]!.edges.push(id);
  };

  /**
   * Walks the degree-2 run starting at `first` (coming from node pixel
   * `from`). Uses its own neighbour buffer: the caller is mid-iteration over
   * *its* buffer when it calls this, so sharing one would have the walk
   * overwrite the caller's remaining neighbours with pixels from wherever the
   * walk happened to end.
   */
  const walkScratch: number[] = new Array(8);
  const walk = (from: number, first: number): { end: number; pts: Point[] } => {
    const pts: Point[] = [pixelCentre(from, width)];
    let previous = from;
    let current = first;

    for (let guard = 0; guard <= size; guard++) {
      consumed[current] = 1;
      pts.push(pixelCentre(current, width));
      const count = neighbourIndices(current, walkScratch);
      let next = -1;
      for (let k = 0; k < count; k++) {
        if (walkScratch[k] !== previous) {
          next = walkScratch[k];
          break;
        }
      }
      if (next === -1) return { end: -1, pts }; // ran out of line (shouldn't happen at degree 2)
      if (nodeOf[next] !== -1) {
        pts.push(pixelCentre(next, width));
        return { end: next, pts };
      }
      previous = current;
      current = next;
    }
    return { end: -1, pts };
  };

  const traceScratch: number[] = new Array(8);
  for (let nodeId = 0; nodeId < nodes.length; nodeId++) {
    for (const index of clusterPixels[nodeId]) {
      // Snapshot rather than iterating the shared buffer: addEdge/walk below
      // both re-enter the neighbour lookup.
      const neighbours = traceScratch.slice(0, neighbourIndices(index, traceScratch));
      for (const neighbour of neighbours) {
        const neighbourNode = nodeOf[neighbour];

        if (neighbourNode === nodeId) continue; // inside the same cluster

        if (neighbourNode !== -1) {
          // Two junctions directly touching: a zero-interior edge. Both ends
          // will find it, so key it by the pixel pair to emit it once.
          const key = index < neighbour ? `${index}:${neighbour}` : `${neighbour}:${index}`;
          if (directPairs.has(key)) continue;
          directPairs.add(key);
          addEdge(nodeId, neighbourNode, [pixelCentre(index, width), pixelCentre(neighbour, width)]);
          continue;
        }

        if (consumed[neighbour]) continue;
        const { end, pts } = walk(index, neighbour);
        if (end === -1) continue;
        addEdge(nodeId, nodeOf[end], pts);
      }
    }
  }

  // Closed loops with no junction have no node to start from, so they are
  // still untouched. Give each one a node at an arbitrary pixel and trace it.
  for (let index = 0; index < size; index++) {
    if (!skeleton[index] || degree[index] !== 2 || consumed[index] || nodeOf[index] !== -1) continue;

    const id = nodes.length;
    const p = pixelCentre(index, width);
    nodes.push({ id, x: p.x, y: p.y, edges: [], terminal: false });
    clusterPixels.push([index]);
    nodeOf[index] = id;

    const count = neighbourIndices(index, traceScratch);
    if (count === 0) continue;
    const first = traceScratch[0];
    const { end, pts } = walk(index, first);
    if (end !== -1) addEdge(id, nodeOf[end], pts);
  }

  // Snap every edge end onto its node's centroid so edges meeting at a
  // junction share an exact coordinate. Without this the three arms of a Y
  // each stop at their own pixel and the offset outlines fail to close.
  for (const edge of edges) {
    if (!edge) continue;
    const a = nodes[edge.a]!;
    const b = nodes[edge.b]!;
    edge.pts[0] = { x: a.x, y: a.y };
    edge.pts[edge.pts.length - 1] = { x: b.x, y: b.y };
  }

  for (const node of nodes) {
    if (node) node.terminal = node.edges.length === 1;
  }

  return { nodes, edges };
}

function detachEdge(graph: CenterlineGraph, edgeId: number): void {
  const edge = graph.edges[edgeId];
  if (!edge) return;
  for (const nodeId of [edge.a, edge.b]) {
    const node = graph.nodes[nodeId];
    if (!node) continue;
    const at = node.edges.indexOf(edgeId);
    if (at !== -1) node.edges.splice(at, 1);
  }
  graph.edges[edgeId] = null;
}

/**
 * Removes dangling branches shorter than `minLengthPx`.
 *
 * A spur is an edge with a degree-1 node at one end. Most are thinning
 * artefacts: a slightly bulbous junction or a blunt line end throws off a
 * short whisker that is not in the drawing at all. Some are real -- a
 * decorative line that stops in open space -- which is why this is a length
 * threshold rather than an unconditional cull.
 *
 * Runs to a fixed point, because removing one spur can expose another.
 */
export function pruneSpurs(graph: CenterlineGraph, minLengthPx: number): number {
  if (minLengthPx <= 0) return 0;
  let removed = 0;

  for (let pass = 0; pass < 64; pass++) {
    let removedThisPass = 0;

    for (const edge of liveEdges(graph)) {
      if (edge.a === edge.b) continue; // a loop is never a dangling branch

      const a = graph.nodes[edge.a];
      const b = graph.nodes[edge.b];
      if (!a || !b) continue;
      const dangling = a.edges.length === 1 || b.edges.length === 1;
      if (!dangling) continue;

      // An edge dangling at *both* ends is an entire isolated stroke, not a
      // whisker off something else. Keeping it lets a standalone short line
      // survive; it will be caught by the piece stage if it bounds nothing.
      if (a.edges.length === 1 && b.edges.length === 1) continue;

      if (polylineLength(edge.pts) >= minLengthPx) continue;

      detachEdge(graph, edge.id);
      removedThisPass++;
    }

    // Drop nodes that no longer carry any edge.
    for (const node of liveNodes(graph)) {
      if (node.edges.length === 0) graph.nodes[node.id] = null;
    }

    removed += removedThisPass;
    if (removedThisPass === 0) break;
  }

  return removed;
}

/**
 * Dissolves nodes left with exactly two edges, splicing those edges into one.
 *
 * This matters for smoothness far more than it looks. A four-way junction
 * that loses two spurs becomes a point the line merely passes through, and if
 * it stays a node the two surviving edges get fitted independently and meet
 * there at a tangent discontinuity -- a visible kink in what the drawing
 * shows as one continuous sweep. Splicing them first means one fit across the
 * whole sweep.
 */
export function dissolveDegreeTwoNodes(graph: CenterlineGraph): number {
  let dissolved = 0;

  for (const node of liveNodes(graph)) {
    if (node.edges.length !== 2) continue;

    const [firstId, secondId] = node.edges;
    if (firstId === secondId) continue; // a self-loop closing on this node

    const first = graph.edges[firstId];
    const second = graph.edges[secondId];
    if (!first || !second) continue;

    // Orient both edges to run *away* from this node, then join them as
    // reverse(first) ++ second so the spliced polyline reads end to end.
    const firstPts = first.a === node.id ? first.pts : [...first.pts].reverse();
    const firstFar = first.a === node.id ? first.b : first.a;
    const secondPts = second.a === node.id ? second.pts : [...second.pts].reverse();
    const secondFar = second.a === node.id ? second.b : second.a;

    // Splicing a pair whose far ends are the same node turns two edges into a
    // self-loop on that node; that is fine, but only if it still has other
    // edges, otherwise the loop loses its only anchor.
    const merged = [...firstPts].reverse();
    merged.pop(); // drop the duplicated shared node position
    merged.push(...secondPts);

    detachEdge(graph, firstId);
    detachEdge(graph, secondId);
    graph.nodes[node.id] = null;

    const id = graph.edges.length;
    graph.edges.push({ id, a: firstFar, b: secondFar, pts: merged });
    graph.nodes[firstFar]!.edges.push(id);
    graph.nodes[secondFar]!.edges.push(id);
    dissolved++;
  }

  return dissolved;
}
