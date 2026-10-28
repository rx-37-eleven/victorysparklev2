// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("../src/apps/rhinestone-fill-creator/core.js");

function minDistance(pts) {
  let min = Infinity;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return min;
}
const insideArea = (pts, w, h, r) =>
  pts.every((p) => p.x >= r - 1e-9 && p.x <= w - r + 1e-9 && p.y >= r - 1e-9 && p.y <= h - r + 1e-9);

test("ss table maps to millimetres", () => {
  assert.strictEqual(core.ssMm(10), 2.8);
  assert.throws(() => core.ssMm(11));
});

test("grid fill keeps spacing, stays inside, and is centred", () => {
  const w = 4, h = 3, r = core.mmToIn(2.8) / 2, s = core.mmToIn(3.2);
  const pts = core.gridFill(w, h, s, r);
  assert.ok(pts.length > 100);
  assert.ok(insideArea(pts, w, h, r));
  assert.ok(Math.abs(minDistance(pts) - s) < 1e-9);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xs) + Math.max(...xs) - w) < 1e-9);
  assert.ok(Math.abs(Math.min(...ys) + Math.max(...ys) - h) < 1e-9);
});

test("radial fill keeps spacing, stays inside, starts at the centre", () => {
  const w = 4, h = 3, r = core.mmToIn(2.8) / 2, s = core.mmToIn(3.2);
  const pts = core.radialFill(w, h, s, r);
  assert.ok(pts.length > 100);
  assert.ok(insideArea(pts, w, h, r));
  assert.ok(minDistance(pts) >= s - 1e-9, `min ${minDistance(pts)} < ${s}`);
  assert.deepStrictEqual([pts[0].x, pts[0].y], [2, 1.5]);
});

test("fills return nothing when the stone cannot fit", () => {
  assert.strictEqual(core.gridFill(0.05, 3, 0.1, 0.06).length, 0);
  assert.strictEqual(core.radialFill(0.05, 3, 0.1, 0.06).length, 0);
});

test("svg is true size and groups circles by stone size", () => {
  const svg = core.buildSvg({
    width: 8, height: 10, color: false,
    stones: [{ x: 1, y: 1, ss: 10, color: "#fff" }, { x: 2, y: 1, ss: 20, color: "#fff" }, { x: 3, y: 1, ss: 10, color: "#fff" }],
  });
  assert.match(svg, /width="8in" height="10in" viewBox="0 0 768 960"/);
  assert.strictEqual((svg.match(/<circle/g) || []).length, 3);
  assert.match(svg, /<g id="SS10"/);
  assert.match(svg, /<g id="SS20"/);
  // SS10 = 2.8 mm across: r = 1.4 mm = 5.291 svg units at 96/in
  assert.match(svg, /r="5\.291"/);
  assert.doesNotMatch(svg, /fill="#fff"/);
  assert.match(core.buildSvg({ width: 1, height: 1, color: true, stones: [{ x: 0.5, y: 0.5, ss: 10, color: "#abc" }] }), /fill="#abc"/);
});

test("zip is readable by unzip", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfc-"));
  const file = path.join(dir, "a.zip");
  fs.writeFileSync(file, core.makeZip([{ name: "one.svg", text: "<svg>1</svg>\n" }, { name: "two.svg", text: "<svg>22</svg>\n" }]));
  let out;
  try { out = execFileSync("unzip", ["-p", file, "two.svg"]).toString(); }
  catch (e) { if (e.code === "ENOENT") return t.skip("unzip not installed"); throw e; }
  assert.strictEqual(out, "<svg>22</svg>\n");
  execFileSync("unzip", ["-tq", file]);
});

test("grid parity alternates along rows and flips on every row", () => {
  const pts = core.gridFill(2, 2, 0.25, 0.05);
  const byRow = {};
  pts.forEach((p) => { (byRow[p.y.toFixed(6)] = byRow[p.y.toFixed(6)] || []).push(p); });
  const rows = Object.keys(byRow).sort((a, b) => a - b).map((k) => byRow[k].sort((a, b) => a.x - b.x));
  rows.forEach((row, j) => row.forEach((p, i) => assert.strictEqual(p.parity, (i + j) & 1)));
  assert.notStrictEqual(rows[0][0].parity, rows[1][0].parity);
});

test("offset grid is honeycomb: rows shift half a step, neighbours exactly one spacing apart", () => {
  const w = 4, h = 3, r = core.mmToIn(2.8) / 2, s = core.mmToIn(3.2);
  const pts = core.gridFill(w, h, s, r, true);
  assert.ok(pts.length > 100);
  assert.ok(insideArea(pts, w, h, r));
  assert.ok(Math.abs(minDistance(pts) - s) < 1e-9, `min ${minDistance(pts)} vs ${s}`);
  const rowsY = [...new Set(pts.map((p) => p.y.toFixed(6)))].sort((a, b) => a - b);
  const firstX = (y) => Math.min(...pts.filter((p) => p.y.toFixed(6) === y).map((p) => p.x));
  assert.ok(Math.abs(Math.abs(firstX(rowsY[1]) - firstX(rowsY[0])) - s / 2) < 1e-9);
  // no two rows two apart share... i.e. no stone sits directly above a neighbour-row stone
  const row0 = new Set(pts.filter((p) => p.y.toFixed(6) === rowsY[0]).map((p) => p.x.toFixed(6)));
  assert.ok(pts.filter((p) => p.y.toFixed(6) === rowsY[1]).every((p) => !row0.has(p.x.toFixed(6))));
});

test("offset grid still works when the shifted row has no room for an extra stone", () => {
  const r = 0.05, s = 0.25;
  const pts = core.gridFill(0.1 + 3 * s, 1, s, r, true); // exactly 4 columns wide, no spare half step
  assert.ok(insideArea(pts, 0.1 + 3 * s, 1, r));
  assert.ok(minDistance(pts) >= s - 1e-9);
});
