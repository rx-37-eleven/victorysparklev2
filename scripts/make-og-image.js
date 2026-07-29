// One-off generator for the default social share card.
// Run: node scripts/make-og-image.js
const sharp = require("sharp");
const path = require("path");

const W = 1200, H = 630;

const bg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8e64b5"/>
      <stop offset="55%" stop-color="#d7afed"/>
      <stop offset="100%" stop-color="#fcfaff"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <text x="600" y="470" text-anchor="middle" font-size="76"
        font-family="Georgia, 'Times New Roman', serif" fill="#3d2456">
    Victory Sparkle Co.
  </text>
  <text x="600" y="535" text-anchor="middle" font-size="32"
        font-family="Helvetica, Arial, sans-serif" fill="#5a3d7f">
    Free browser tools for makers
  </text>
</svg>`);

(async () => {
  const logo = await sharp(path.join(__dirname, "../src/images/Vlogo.png"))
    .resize(260, 260, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  await sharp(bg)
    .composite([{ input: logo, top: 90, left: 470 }])
    .png()
    .toFile(path.join(__dirname, "../src/images/og-default.png"));

  console.log("wrote src/images/og-default.png");
})();
