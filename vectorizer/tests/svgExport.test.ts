import { describe, it, expect } from "vitest";
import { computePieces } from "../src/lib/pieces";
import { extractBoundaryGraph } from "../src/lib/boundaryGraph";
import { fitAllChains } from "../src/lib/curveFit";
import { exportSvg } from "../src/lib/svgExport";
import { makeGrid, makeCircleInSquare } from "./fixtures";

const fitParams = { cornerAngleDeg: 55, cornerSupport: 5, smoothingSigma: 1.2, maxError: 1.2 };

function buildGraph(ink: Uint8Array, width: number, height: number) {
  const { labels, pieceCount } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
  const { chains, pieces } = extractBoundaryGraph(labels, width, height);
  fitAllChains(chains, fitParams);
  return { chains, pieces, pieceCount, width, height };
}

describe("exportSvg", () => {
  it("emits one path per piece, stable ids, no transform/style/class/defs", () => {
    const { ink, width, height } = makeGrid(3, 3, 25, 3);
    const { chains, pieces, pieceCount } = buildGraph(ink, width, height);
    const { svg, pieces: metas } = exportSvg(pieces, chains, { widthPx: width, heightPx: height, mmPerPx: 0.5 });

    expect(metas.length).toBe(pieceCount);
    for (let i = 0; i < metas.length; i++) expect(metas[i].id).toBe(`piece-${String(i + 1).padStart(3, "0")}`);

    expect(svg).not.toContain("transform");
    expect(svg).not.toContain("<style");
    expect(svg).not.toContain("class=");
    expect(svg).not.toContain("<defs");
    expect((svg.match(/<path/g) ?? []).length).toBe(pieceCount);
    expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
  });

  it("closure: every subpath ends with Z", () => {
    const { ink, width, height } = makeGrid(2, 2, 20, 3);
    const { chains, pieces } = buildGraph(ink, width, height);
    const { svg } = exportSvg(pieces, chains, { widthPx: width, heightPx: height, mmPerPx: 0.5 });
    const dAttrs = Array.from(svg.matchAll(/\sd="([^"]+)"/g)).map((m) => m[1]);
    expect(dAttrs.length).toBeGreaterThan(0);
    for (const d of dAttrs) {
      const subpaths = d.split("M").filter((s) => s.trim().length > 0);
      for (const sp of subpaths) expect(sp.trim().endsWith("Z")).toBe(true);
    }
  });

  it("holes get fill-rule=evenodd and the piece with a hole has 2 subpaths", () => {
    const { ink, width, height } = makeCircleInSquare(80, 5, 25, 3);
    const { chains, pieces } = buildGraph(ink, width, height);
    const { svg } = exportSvg(pieces, chains, { widthPx: width, heightPx: height, mmPerPx: 0.5 });
    expect(svg).toContain("fill-rule=\"evenodd\"");
    const withHoleMatch = svg.match(/<path[^>]*fill-rule="evenodd"[^>]*\sd="([^"]+)"/);
    expect(withHoleMatch).toBeTruthy();
    const mCount = (withHoleMatch![1].match(/M/g) ?? []).length;
    expect(mCount).toBe(2);
  });

  it("coverage: reported piece areas sum to ~panel area (in px^2 terms, mmPerPx=1)", () => {
    const { ink, width, height } = makeGrid(3, 3, 25, 3);
    const { labels } = computePieces(ink, width, height, { treatEdgeAsBorder: true, minRegionPx: 0 });
    const { chains, pieces } = extractBoundaryGraph(labels, width, height);
    fitAllChains(chains, fitParams);
    const { pieces: metas } = exportSvg(pieces, chains, { widthPx: width, heightPx: height, mmPerPx: 1 });
    let panelPixels = 0;
    for (const l of labels) if (l >= 1) panelPixels++;
    const totalArea = metas.reduce((s, m) => s + m.areaMm2, 0);
    expect(Math.abs(totalArea - panelPixels) / panelPixels).toBeLessThan(0.02); // bezier-flattened, small slack vs raw pixel count
  });

  it("determinism: same input + params -> byte-identical SVG", () => {
    const { ink, width, height } = makeGrid(3, 3, 25, 3);
    const g1 = buildGraph(ink, width, height);
    const g2 = buildGraph(ink, width, height);
    const svg1 = exportSvg(g1.pieces, g1.chains, { widthPx: width, heightPx: height, mmPerPx: 0.5 }).svg;
    const svg2 = exportSvg(g2.pieces, g2.chains, { widthPx: width, heightPx: height, mmPerPx: 0.5 }).svg;
    expect(svg1).toBe(svg2);
  });

  it("falls back to px units (no physical scale) when mmPerPx is null", () => {
    const { ink, width, height } = makeGrid(2, 2, 20, 3);
    const { chains, pieces } = buildGraph(ink, width, height);
    const { svg } = exportSvg(pieces, chains, { widthPx: width, heightPx: height, mmPerPx: null });
    expect(svg).toContain(`width="${width}px"`);
  });
});
