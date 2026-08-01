import { describe, it, expect } from "vitest";
import { morphologicalClose, despeckle } from "../src/lib/morphology";

describe("dilate/erode", () => {
  it("dilate then erode by the same radius restores a convex blob (idempotent closing)", () => {
    const w = 20,
      h = 20;
    const mask = new Uint8Array(w * h);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) mask[y * w + x] = 1;
    const closed = morphologicalClose(mask, w, h, 3);
    expect(Array.from(closed)).toEqual(Array.from(mask));
  });

  it("closing bridges a gap without shifting the surrounding line's centerline", () => {
    // A vertical 3px-wide line with a 4px vertical gap in the middle.
    const w = 20,
      h = 20;
    const ink = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      if (y >= 9 && y <= 12) continue; // 4px gap
      for (let x = 8; x <= 10; x++) ink[y * w + x] = 1;
    }
    const closedR3 = morphologicalClose(ink, w, h, 3);
    // gap should be fully closed
    for (let y = 9; y <= 12; y++) {
      expect(closedR3[y * w + 9]).toBe(1);
    }
    // centerline (x=9) unaffected in width for untouched rows far from the gap
    for (let y = 0; y < 5; y++) {
      let width_ = 0;
      for (let x = 0; x < w; x++) if (closedR3[y * w + x]) width_++;
      expect(width_).toBe(3);
    }
  });
});

describe("despeckle", () => {
  it("removes small ink components but keeps large ones", () => {
    const w = 10,
      h = 10;
    const ink = new Uint8Array(w * h);
    ink[0] = 1; // 1px speck
    for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) ink[y * w + x] = 1; // 16px block
    const cleaned = despeckle(ink, w, h, 4);
    expect(cleaned[0]).toBe(0);
    expect(cleaned[5 * w + 5]).toBe(1);
  });
});
