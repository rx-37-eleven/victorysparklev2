import { describe, it, expect } from "vitest";
import { otsuThreshold, binarize } from "../src/lib/threshold";

describe("otsuThreshold", () => {
  it("finds a threshold between two well-separated clusters", () => {
    const gray = new Float32Array(2000);
    for (let i = 0; i < 1000; i++) gray[i] = 20; // dark cluster
    for (let i = 1000; i < 2000; i++) gray[i] = 220; // light cluster
    const t = otsuThreshold(gray);
    expect(t).toBeGreaterThan(20);
    expect(t).toBeLessThan(220);
  });
});

describe("binarize", () => {
  it("ink = gray < threshold, and invert flips it", () => {
    const gray = new Float32Array([10, 250]);
    const ink = binarize(gray, 2, 1, { threshold: 128, adaptive: false, window: 25, invert: false });
    expect(Array.from(ink)).toEqual([1, 0]);
    const inkInv = binarize(gray, 2, 1, { threshold: 128, adaptive: false, window: 25, invert: true });
    expect(Array.from(inkInv)).toEqual([0, 1]);
  });
});
