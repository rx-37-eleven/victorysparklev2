import { describe, it, expect } from "vitest";
import { fitCurve, fitChain, bezierPoint, detectCorners, splitIntoSpans } from "../src/lib/curveFit";
import type { Point } from "../src/lib/boundaryGraph";

describe("fitCurve", () => {
  it("fits a straight line with near-zero error and exact endpoint pinning", () => {
    const points = Array.from({ length: 21 }, (_, i) => ({ x: i, y: 0 }));
    const segs = fitCurve(points, 0.5);
    expect(segs[0].p0).toEqual({ x: 0, y: 0 });
    expect(segs[segs.length - 1].p3).toEqual({ x: 20, y: 0 });
    for (const p of points) {
      // find closest sampled point on the whole curve
      let minDist = Infinity;
      for (const seg of segs) {
        for (let t = 0; t <= 1; t += 0.02) {
          const q = bezierPoint(seg, t);
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < minDist) minDist = d;
        }
      }
      expect(minDist).toBeLessThan(0.5);
    }
  });

  it("fits a quarter-circle arc within the error tolerance", () => {
    const n = 60;
    const r = 50;
    const points = Array.from({ length: n }, (_, i) => {
      const t = (i / (n - 1)) * (Math.PI / 2);
      return { x: r * Math.cos(t), y: r * Math.sin(t) };
    });
    const eps = 0.5;
    const segs = fitCurve(points, eps);
    for (const p of points) {
      let minDist = Infinity;
      for (const seg of segs) {
        for (let t = 0; t <= 1; t += 0.01) {
          const q = bezierPoint(seg, t);
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < minDist) minDist = d;
        }
      }
      expect(minDist).toBeLessThan(eps * 2); // sampling isn't exhaustive, allow slack
    }
  });
});

describe("detectCorners / splitIntoSpans", () => {
  it("detects a 90-degree corner in an L-shaped polyline", () => {
    const pts: Point[] = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: i, y: 0 });
    for (let i = 1; i <= 10; i++) pts.push({ x: 10, y: i });
    const isCorner = detectCorners(pts, 55, 5);
    expect(isCorner[10]).toBe(true); // the elbow
    expect(isCorner[0]).toBe(true);
    expect(isCorner[pts.length - 1]).toBe(true);

    const spans = splitIntoSpans(pts, isCorner);
    expect(spans.length).toBe(2);
    expect(spans[0][spans[0].length - 1]).toEqual(spans[1][0]); // shared joint
  });

  it("does not mark a gentle, near-straight polyline as having interior corners", () => {
    const n = 40;
    const r = 200;
    const pts: Point[] = Array.from({ length: n }, (_, i) => {
      const t = (i / (n - 1)) * (Math.PI / 4);
      return { x: Math.round(r * Math.cos(t)), y: Math.round(r * Math.sin(t)) };
    });
    const isCorner = detectCorners(pts, 55, 5);
    for (let i = 1; i < n - 1; i++) expect(isCorner[i]).toBe(false);
  });
});

describe("fitChain", () => {
  it("pins fitted endpoints exactly to the chain's node coordinates", () => {
    const pts: Point[] = [];
    for (let i = 0; i <= 8; i++) pts.push({ x: i, y: 0 });
    for (let i = 1; i <= 8; i++) pts.push({ x: 8, y: i });
    const segs = fitChain(pts, { cornerAngleDeg: 55, cornerSupport: 4, smoothingSigma: 1, maxError: 1.2 });
    expect(segs[0].p0).toEqual({ x: pts[0].x, y: pts[0].y });
    const last = pts[pts.length - 1];
    expect(segs[segs.length - 1].p3).toEqual({ x: last.x, y: last.y });
  });

  it("preserves the sharp corner (does not smooth across it)", () => {
    const pts: Point[] = [];
    for (let i = 0; i <= 8; i++) pts.push({ x: i, y: 0 });
    for (let i = 1; i <= 8; i++) pts.push({ x: 8, y: i });
    const segs = fitChain(pts, { cornerAngleDeg: 55, cornerSupport: 4, smoothingSigma: 1, maxError: 1.2 });
    // The corner point (8,0) must appear exactly as a segment boundary (p3 of one seg == p0 of next).
    const cornerSegIndex = segs.findIndex((s) => s.p3.x === 8 && s.p3.y === 0);
    expect(cornerSegIndex).toBeGreaterThanOrEqual(0);
    expect(segs[cornerSegIndex + 1].p0).toEqual({ x: 8, y: 0 });
  });
});
