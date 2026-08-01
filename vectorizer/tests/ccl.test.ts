import { describe, it, expect } from "vitest";
import { labelComponents } from "../src/lib/ccl";

describe("labelComponents", () => {
  it("counts simple 4-connected blobs", () => {
    // 5x5, two separate 2x2 blocks (4-connected, diagonal doesn't count)
    const w = 5,
      h = 5;
    const mask = new Uint8Array(w * h);
    const set = (x: number, y: number) => (mask[y * w + x] = 1);
    set(0, 0);
    set(1, 0);
    set(0, 1);
    set(1, 1);
    set(3, 3);
    set(4, 3);
    set(3, 4);
    set(4, 4);
    const { count, areas } = labelComponents(mask, w, h, 4);
    expect(count).toBe(2);
    expect(areas[1]).toBe(4);
    expect(areas[2]).toBe(4);
  });

  it("does not connect diagonal-only pixels at connectivity 4", () => {
    const w = 3,
      h = 3;
    const mask = new Uint8Array(w * h);
    mask[0] = 1; // (0,0)
    mask[4] = 1; // (1,1)
    const { count } = labelComponents(mask, w, h, 4);
    expect(count).toBe(2);
  });

  it("connects diagonal-only pixels at connectivity 8", () => {
    const w = 3,
      h = 3;
    const mask = new Uint8Array(w * h);
    mask[0] = 1; // (0,0)
    mask[4] = 1; // (1,1)
    const { count } = labelComponents(mask, w, h, 8);
    expect(count).toBe(1);
  });

  it("handles a 3x3 grid of 9 cells separated by 1px lines", () => {
    // 10x10: lines at rows/cols 3 and 6 (0-indexed), 3px cell blocks between.
    const w = 10,
      h = 10;
    const ink = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (x === 3 || x === 6 || y === 3 || y === 6) ink[y * w + x] = 1;
    const glass = new Uint8Array(w * h);
    for (let i = 0; i < glass.length; i++) glass[i] = ink[i] ? 0 : 1;
    const { count } = labelComponents(glass, w, h, 4);
    expect(count).toBe(9);
  });
});
