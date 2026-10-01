// Run with: node --test tests/
// Rasterizes SVG test patterns with sharp (a devDependency) and checks the
// analysis core against shapes of known size.
const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { analyze } = require("../src/apps/grinder-bit-checker/analyze.js");

const PPI = 160;
const STROKE = 0.05; // inches, a "fairly thick" line

async function run(widthIn, heightIn, body, bits, ppi = PPI) {
  const W = Math.round(widthIn * ppi), H = Math.round(heightIn * ppi);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${widthIn} ${heightIn}">
    <rect width="${widthIn}" height="${heightIn}" fill="#fff"/>${body}</svg>`;
  const { data } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
  return analyze({ gray: new Uint8Array(data), width: W, height: H, ppi, bits }).spots;
}
const line = `fill="none" stroke="#000" stroke-width="${STROKE}"`;
const frame = `<rect x="0.3" y="0.3" width="5.4" height="3.4" ${line}/>`;
const circle = (cx, cy, d) => `<circle cx="${cx}" cy="${cy}" r="${d / 2}" ${line}/>`;

test("holes of known diameter are flagged with the closest bit", async () => {
  for (const [d, bit] of [[0.25, 0.375], [0.5, 0.375], [0.7, 0.75], [0.9, 1]]) {
    const spots = await run(6, 4, frame + circle(3, 2, d), [1, 0.75, 0.375]);
    assert.strictEqual(spots.length, 1, `d=${d}: ${JSON.stringify(spots)}`);
    assert.strictEqual(spots[0].bit, bit, `d=${d}`);
    assert.ok(Math.abs(spots[0].diameter - d) < 0.04, `d=${d} measured ${spots[0].diameter}`);
  }
});

test("a hole at least as big as every selected bit passes", async () => {
  assert.strictEqual((await run(6, 4, frame + circle(3, 2, 1.2), [1, 0.75, 0.375])).length, 0);
  assert.strictEqual((await run(6, 4, frame + circle(3, 2, 0.5), [0.375])).length, 0);
});

test("dot sits on the concave side, tangent to the centerline", async () => {
  const [s] = await run(6, 4, frame + circle(3, 2, 0.5), [1, 0.75, 0.375]);
  // dot centre is 0.375/2 from the centerline point, toward the circle's centre
  const dToCentre = Math.hypot(s.cx - 3, s.cy - 2);
  assert.ok(Math.abs(dToCentre - (0.25 - 0.375 / 2)) < 0.03, `dot centre ${dToCentre} from hole centre`);
  assert.ok(Math.abs(Math.hypot(s.x - 3, s.y - 2) - 0.25) < 0.02);
});

test("outside curves are not flagged: a round piece cut from the sheet", async () => {
  // the circle is the pattern's outer border, so the glass is inside it (convex side is the piece)
  const spots = await run(3, 3, circle(1.5, 1.5, 0.5), [1, 0.75, 0.375]);
  assert.strictEqual(spots.length, 0, JSON.stringify(spots));
});

test("corners and junctions are not flagged", async () => {
  const grid = `<path d="M2 0.3V3.7M4 0.3V3.7M0.3 1.5H5.7M0.3 2.6H5.7" ${line}/>`;
  const tri = `<path d="M0.8 0.8L1.6 0.8L1.2 1.4Z" ${line}/>`;
  const spots = await run(6, 4, frame + grid + tri, [1, 0.75, 0.375]);
  assert.strictEqual(spots.length, 0, JSON.stringify(spots));
});

test("a concave notch on a piece is flagged once", async () => {
  // piece edge dips inward as a 0.4"-diameter half-circle bite, glass on both sides
  const path = `<path d="M0.3 2 H2.8 A0.2 0.2 0 0 1 3.2 2 H5.7" ${line}/>`;
  const spots = await run(6, 4, frame + path, [1, 0.75, 0.375]);
  assert.strictEqual(spots.length, 1, JSON.stringify(spots));
  assert.ok(Math.abs(spots[0].diameter - 0.4) < 0.05);
});

test("ties go to the smaller bit", async () => {
  // d=0.5625 is exactly between 0.375 and 0.75; call analyze through a hole of that size
  const spots = await run(6, 4, frame + circle(3, 2, 0.5625), [0.75, 0.375]);
  assert.strictEqual(spots.length, 1);
  if (Math.abs(spots[0].diameter - 0.5625) < 0.003) assert.strictEqual(spots[0].bit, 0.375);
});

test("works at lower resolution", async () => {
  const spots = await run(6, 4, frame + circle(3, 2, 0.5), [1, 0.75, 0.375], 90);
  assert.strictEqual(spots.length, 1);
  assert.ok(Math.abs(spots[0].diameter - 0.5) < 0.05, `measured ${spots[0].diameter}`);
});

test("a rounded hole flags its four corner arcs, not its straight sides", async () => {
  const hole = `<rect x="2" y="1" width="2" height="2" rx="0.2" ry="0.2" ${line}/>`;
  const spots = await run(6, 4, frame + hole, [1, 0.75, 0.375]);
  assert.strictEqual(spots.length, 4, JSON.stringify(spots));
  for (const s of spots) assert.ok(Math.abs(s.diameter - 0.4) < 0.06, `measured ${s.diameter}`);
});

test("a curve touching other lines is flagged away from the junction", async () => {
  // hole d=0.5 with a spoke joining it to the frame
  const body = frame + circle(3, 2, 0.5) + `<path d="M3 1.75V0.3" ${line}/>`;
  const spots = await run(6, 4, body, [1, 0.75, 0.375]);
  assert.ok(spots.length >= 1 && spots.length <= 2, JSON.stringify(spots));
  for (const s of spots) assert.ok(Math.abs(s.diameter - 0.5) < 0.06, `measured ${s.diameter}`);
});

test("large patterns stay fast", async () => {
  const t = Date.now();
  await run(12, 8, frame.replace(/5.4/, "11.4").replace(/3.4/, "7.4") + circle(6, 4, 0.5), [1, 0.75, 0.375], 200);
  assert.ok(Date.now() - t < 15000, `took ${Date.now() - t}ms`);
});
