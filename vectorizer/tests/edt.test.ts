import { describe, it, expect } from "vitest";
import { squaredDistanceTransform, nearestLabeledSite } from "../src/lib/edt";

describe("squaredDistanceTransform", () => {
  it("is zero at site pixels", () => {
    const w = 5,
      h = 5;
    const mask = new Uint8Array(w * h);
    mask[2 * w + 2] = 1; // single site at (2,2)
    const d = squaredDistanceTransform(mask, w, h);
    expect(d[2 * w + 2]).toBe(0);
    expect(d[0]).toBe(8); // (2,2) is sqrt(8) from (0,0)
    expect(d[2 * w + 4]).toBe(4); // 2 px away horizontally
  });

  it("matches brute force on a random mask", () => {
    const w = 20,
      h = 17;
    const mask = new Uint8Array(w * h);
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < mask.length; i++) mask[i] = rand() < 0.1 ? 1 : 0;
    mask[0] = 1; // guarantee at least one site
    const d = squaredDistanceTransform(mask, w, h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            if (!mask[yy * w + xx]) continue;
            const dd = (x - xx) * (x - xx) + (y - yy) * (y - yy);
            if (dd < best) best = dd;
          }
        }
        expect(d[y * w + x]).toBe(best);
      }
    }
  });
});

describe("nearestLabeledSite", () => {
  it("breaks exact ties by lowest label id", () => {
    // 1D strip: label 1 at x=0, label 2 at x=4, ink in between (x=1,2,3).
    // x=2 is equidistant (dist 2) from both sites -> must resolve to label 1.
    const w = 5,
      h = 1;
    const labels = new Int32Array([1, 0, 0, 0, 2]);
    const isSite = new Uint8Array([1, 0, 0, 0, 1]);
    const { nearestLabel, distSq } = nearestLabeledSite(labels, isSite, w, h);
    expect(nearestLabel[0]).toBe(1);
    expect(nearestLabel[4]).toBe(2);
    expect(nearestLabel[2]).toBe(1); // tie broken toward lower label
    expect(distSq[2]).toBe(4);
    expect(nearestLabel[1]).toBe(1);
    expect(nearestLabel[3]).toBe(2);
  });

  it("never lets the epsilon bias flip a genuine distance difference", () => {
    // label 5 close (dist 1), label 1 far (dist 3) -> must still pick label 5.
    const w = 5,
      h = 1;
    const labels = new Int32Array([1, 0, 0, 5, 0]);
    const isSite = new Uint8Array([1, 0, 0, 1, 0]);
    const { nearestLabel } = nearestLabeledSite(labels, isSite, w, h);
    expect(nearestLabel[1]).toBe(1);
    expect(nearestLabel[2]).toBe(5);
  });

  it("background label -1 wins ties against a real piece (lowest id)", () => {
    const w = 5,
      h = 1;
    const labels = new Int32Array([-1, 0, 0, 0, 3]);
    const isSite = new Uint8Array([1, 0, 0, 0, 1]);
    const { nearestLabel } = nearestLabeledSite(labels, isSite, w, h);
    expect(nearestLabel[2]).toBe(-1);
  });
});
