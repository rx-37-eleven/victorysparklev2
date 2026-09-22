// Stage 3 -- thinning.
//
// Reduces the ink mask to a one-pixel-wide skeleton running down the middle
// of every drawn line, whatever that line's width. This replaces the old
// distance-transform watershed as the source of centre geometry: the
// watershed only ever produced a *seam* between two regions as a byproduct
// of claiming ink pixels, which meant the centre of the drawn line was never
// an object the pipeline could smooth, fit, or offset directly. Here it is
// the primary artefact and everything else is derived from it.
//
// Zhang-Suen: two alternating sub-iterations, each marking for deletion the
// contour pixels whose removal cannot break local connectivity or shorten a
// line end, repeated until a full pass changes nothing.

/** Ink pixel neighbour offsets P2..P9, clockwise from north (Zhang-Suen numbering). */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // P2  N
  [1, -1], // P3  NE
  [1, 0], // P4  E
  [1, 1], // P5  SE
  [0, 1], // P6  S
  [-1, 1], // P7  SW
  [-1, 0], // P8  W
  [-1, -1], // P9  NW
];

/**
 * Reads the 8 neighbours of (x,y) into `out` in P2..P9 order. Pixels outside
 * the image count as background, so the image border behaves like empty
 * space rather than wrapping or mirroring.
 */
function readNeighbours(mask: Uint8Array, width: number, height: number, x: number, y: number, out: Uint8Array): void {
  for (let i = 0; i < 8; i++) {
    const nx = x + NEIGHBOURS[i][0];
    const ny = y + NEIGHBOURS[i][1];
    out[i] = nx < 0 || ny < 0 || nx >= width || ny >= height ? 0 : mask[ny * width + nx];
  }
}

/** Number of 0->1 transitions in the cyclic sequence P2,P3,..,P9,P2 (Zhang-Suen's A). */
function transitions(n: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < 8; i++) {
    if (n[i] === 0 && n[(i + 1) % 8] === 1) count++;
  }
  return count;
}

/** Number of ink neighbours (Zhang-Suen's B). */
function neighbourCount(n: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < 8; i++) count += n[i];
  return count;
}

/**
 * Thins `ink` (1 = ink) to a one-pixel-wide 8-connected skeleton.
 *
 * The result preserves the topology of the input: every enclosed region stays
 * enclosed and every line that connected two junctions still does, which is
 * what makes it safe to build the piece graph from it later.
 */
export function thinZhangSuen(ink: Uint8Array, width: number, height: number): Uint8Array {
  const skeleton = Uint8Array.from(ink, (v) => (v ? 1 : 0));
  const n = new Uint8Array(8);
  const doomed: number[] = [];

  // A pixel can only be deleted if it is on the current contour, so each pass
  // need only revisit pixels that are still ink. Bounded to avoid spinning on
  // a pathological input; real line art converges in well under 100 passes.
  for (let pass = 0; pass < 256; pass++) {
    let removedThisPass = 0;

    for (let step = 0; step < 2; step++) {
      doomed.length = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = y * width + x;
          if (!skeleton[index]) continue;

          readNeighbours(skeleton, width, height, x, y, n);

          const b = neighbourCount(n);
          // b < 2 is a line end or an isolated dot -- deleting it would erode
          // the line from its tip. b > 6 is an interior pixel, not a contour.
          if (b < 2 || b > 6) continue;
          // More than one 0->1 transition means this pixel is the only thing
          // joining two separate arms; removing it would break the skeleton.
          if (transitions(n) !== 1) continue;

          // The two step conditions differ only in which corner of the 3x3 is
          // required to touch background, which is what makes the passes
          // alternate between thinning from the NE and from the SW and keeps
          // the skeleton centred rather than drifting to one side.
          const [p2, , p4, , p6, , p8] = n;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }

          doomed.push(index);
        }
      }

      for (const index of doomed) skeleton[index] = 0;
      removedThisPass += doomed.length;
    }

    if (removedThisPass === 0) break;
  }

  return skeleton;
}

/**
 * Removes every pixel Zhang-Suen left in that the skeleton does not need.
 *
 * Thinning converges while parts of the skeleton are still two pixels thick.
 * Its two sub-iterations only ever delete from one side at a time, which is
 * what stops it eating a line from both edges at once, but it also means a
 * diagonal run can end up as a chain of 2x2 blocks that neither sub-pass is
 * allowed to touch. On a drawn circle that leaves about two thirds of the
 * skeleton pixels with three or four neighbours instead of two.
 *
 * That is not a cosmetic problem. Everything downstream reads a pixel with
 * more than two neighbours as a junction, so those blocks merge into large
 * "junction" clusters, the tracer walks around them instead of through them,
 * and each cluster's centroid -- which is where the traced polyline's
 * endpoint gets snapped -- can sit a dozen pixels off the line. The result
 * is a centreline that leaps across chords of the curve, and a visibly
 * faceted cut path.
 *
 * The fix is the classic simple-point test: a pixel can go if its own
 * neighbours would still be connected to each other without it, and it is
 * not a line end. Applied sequentially (each test sees the previous
 * removals), this cannot break the skeleton's topology, and it thins the
 * leftover blocks down to a genuine one-pixel path. It subsumes the
 * staircase and corner cases too -- an L corner's two neighbours are
 * diagonal to each other, so they stay connected without it.
 */
export function removeRedundantPixels(skeleton: Uint8Array, width: number, height: number): Uint8Array {
  const out = Uint8Array.from(skeleton);
  const n = new Uint8Array(8);

  // Which ring positions are adjacent to each other, precomputed: two
  // neighbours touch when their offsets differ by at most one step in both
  // axes. Note this is not the same as being adjacent *in the ring* -- N and
  // E are two apart in the ring but are diagonal neighbours.
  const ringAdjacent: boolean[][] = [];
  for (let i = 0; i < 8; i++) {
    ringAdjacent.push([]);
    for (let j = 0; j < 8; j++) {
      ringAdjacent[i].push(
        i !== j &&
          Math.abs(NEIGHBOURS[i][0] - NEIGHBOURS[j][0]) <= 1 &&
          Math.abs(NEIGHBOURS[i][1] - NEIGHBOURS[j][1]) <= 1,
      );
    }
  }

  const stack: number[] = [];
  const seen = new Uint8Array(8);

  for (let pass = 0; pass < 16; pass++) {
    let removed = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (!out[index]) continue;

        readNeighbours(out, width, height, x, y, n);
        const count = neighbourCount(n);
        // One neighbour is a line end; removing it would erode the line from
        // its tip. None is an isolated dot, which carries no line but is not
        // this pass's business either.
        if (count < 2) continue;
        // Eight neighbours means this pixel is interior to a solid block;
        // removing it would punch a hole rather than thin anything.
        if (count === 8) continue;

        // Are the neighbours all reachable from one another without going
        // through this pixel?
        seen.fill(0);
        let first = -1;
        for (let i = 0; i < 8; i++) {
          if (n[i]) {
            first = i;
            break;
          }
        }
        stack.length = 0;
        stack.push(first);
        seen[first] = 1;
        let reached = 1;
        while (stack.length > 0) {
          const current = stack.pop()!;
          for (let i = 0; i < 8; i++) {
            if (!n[i] || seen[i] || !ringAdjacent[current][i]) continue;
            seen[i] = 1;
            reached++;
            stack.push(i);
          }
        }
        if (reached !== count) continue; // this pixel is the only link between two arms

        out[index] = 0;
        removed++;
      }
    }

    if (removed === 0) break;
  }

  return out;
}

/** Thins and removes redundant pixels -- the form the pipeline uses. */
export function skeletonize(ink: Uint8Array, width: number, height: number): Uint8Array {
  return removeRedundantPixels(thinZhangSuen(ink, width, height), width, height);
}
