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
  assert.deepStrictEqual(pts[0], { x: 2, y: 1.5 });
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
