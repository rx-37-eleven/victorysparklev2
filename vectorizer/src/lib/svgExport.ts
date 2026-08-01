// Stage 5 (SVG output contract, spec section 5) + Stage 8 scale handling.
//
// Absolute coordinates only (no <transform>), 3-decimal rounding, one <path>
// per piece with holes as additional evenodd subpaths, stable piece-NNN ids
// ordered top-to-bottom then left-to-right by centroid, presentation
// attributes only (no <style>/classes/<defs>).

import type { Chain, Ring, Piece } from "./boundaryGraph";
import { reverseFittedChain, bezierPoint, type BezierSeg } from "./curveFit";

export interface Unit {
  kind: "in" | "cm" | "mm";
}

export function toMm(value: number, unit: Unit["kind"]): number {
  switch (unit) {
    case "in":
      return value * 25.4;
    case "cm":
      return value * 10;
    case "mm":
      return value;
  }
}

function fmt(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  return (rounded === 0 ? 0 : rounded).toString();
}

function flattenSeg(seg: BezierSeg, samplesPerSeg: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < samplesPerSeg; i++) {
    pts.push(bezierPoint(seg, i / samplesPerSeg));
  }
  return pts;
}

function ringSegments(chains: Chain[], ring: Ring[]): BezierSeg[] {
  const segs: BezierSeg[] = [];
  for (const r of ring) {
    const chain = chains[r.chainId];
    const fitted = chain.fitted;
    if (!fitted) throw new Error(`Chain ${chain.id} has not been fitted yet -- call fitAllChains first.`);
    segs.push(...(r.reversed ? reverseFittedChain(fitted) : fitted));
  }
  return segs;
}

function ringFlattenedPoints(chains: Chain[], ring: Ring[], samplesPerSeg = 8): { x: number; y: number }[] {
  const segs = ringSegments(chains, ring);
  const pts: { x: number; y: number }[] = [];
  for (const seg of segs) pts.push(...flattenSeg(seg, samplesPerSeg));
  return pts;
}

function polygonArea(pts: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}

function polygonCentroid(pts: { x: number; y: number }[]): { x: number; y: number } {
  let cx = 0;
  let cy = 0;
  let areaAcc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    areaAcc += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  const area = areaAcc / 2;
  if (Math.abs(area) < 1e-9) {
    const n = Math.max(1, pts.length);
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

function ringPathData(chains: Chain[], ring: Ring[]): string {
  const segs = ringSegments(chains, ring);
  let d = "";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (i === 0) d += `M ${fmt(seg.p0.x)} ${fmt(seg.p0.y)} `;
    d += `C ${fmt(seg.p1.x)} ${fmt(seg.p1.y)} ${fmt(seg.p2.x)} ${fmt(seg.p2.y)} ${fmt(seg.p3.x)} ${fmt(seg.p3.y)} `;
  }
  return d.trim() + " Z";
}

export interface ExportedPieceMeta {
  id: string;
  label: number;
  areaMm2: number;
  minWidthMm: number;
  centroid: { x: number; y: number };
}

export interface ExportOptions {
  widthPx: number;
  heightPx: number;
  mmPerPx: number | null; // null = no physical scale set yet
  minWidthMmByLabel?: Map<number, number>;
}

export interface ExportResult {
  svg: string;
  pieces: ExportedPieceMeta[];
}

export function exportSvg(pieces: Map<number, Piece>, chains: Chain[], options: ExportOptions): ExportResult {
  const mmPerPx = options.mmPerPx ?? 1; // fall back to px==mm numerically if no physical scale set

  const withMeta = Array.from(pieces.values()).map((piece) => {
    const outerPts = ringFlattenedPoints(chains, piece.outer);
    const outerAreaPx = Math.abs(polygonArea(outerPts));
    let holeAreaPx = 0;
    for (const hole of piece.holes) holeAreaPx += Math.abs(polygonArea(ringFlattenedPoints(chains, hole)));
    const areaPx = outerAreaPx - holeAreaPx;
    const centroid = polygonCentroid(outerPts);
    const minWidthMm = options.minWidthMmByLabel?.get(piece.label) ?? 0;
    return { piece, areaPx, centroid, minWidthMm };
  });

  withMeta.sort((a, b) => a.centroid.y - b.centroid.y || a.centroid.x - b.centroid.x);

  const metas: ExportedPieceMeta[] = [];
  const pathEls: string[] = [];
  withMeta.forEach((entry, i) => {
    const id = `piece-${String(i + 1).padStart(3, "0")}`;
    const areaMm2 = entry.areaPx * mmPerPx * mmPerPx;
    metas.push({ id, label: entry.piece.label, areaMm2, minWidthMm: entry.minWidthMm, centroid: entry.centroid });

    const outerD = ringPathData(chains, entry.piece.outer);
    const holesD = entry.piece.holes.map((h) => ringPathData(chains, h));
    const d = [outerD, ...holesD].join(" ");
    const fillRule = entry.piece.holes.length > 0 ? ` fill-rule="evenodd"` : "";
    pathEls.push(
      `    <path id="${id}" data-area-mm2="${areaMm2.toFixed(1)}" data-min-width-mm="${entry.minWidthMm.toFixed(1)}"${fillRule} d="${d}"/>`,
    );
  });

  const widthUnit = options.mmPerPx !== null ? `${fmt((options.widthPx * mmPerPx) / 25.4)}in` : `${options.widthPx}px`;
  const heightUnit = options.mmPerPx !== null ? `${fmt((options.heightPx * mmPerPx) / 25.4)}in` : `${options.heightPx}px`;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="${widthUnit}" height="${heightUnit}"`,
    `     viewBox="0 0 ${options.widthPx} ${options.heightPx}">`,
    `  <g id="pieces" fill="none" stroke="#000000"`,
    `     stroke-width="0.75" stroke-linejoin="round">`,
    ...pathEls,
    `  </g>`,
    `</svg>`,
  ].join("\n");

  return { svg, pieces: metas };
}
