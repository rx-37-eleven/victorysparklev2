/* Rhinestone Fill Creator — pure geometry, SVG and zip helpers.
   No DOM access, so tests/rhinestone-fill-creator.test.js can load it in Node.
   Every length in here is in inches unless the name says otherwise. */
(function (root) {
  "use strict";

  var MM_PER_IN = 25.4;
  var SVG_UNITS_PER_IN = 96; // user units per inch in exported files

  // Nominal stone diameters on the ss ("stone size") scale. Makers differ by a
  // tenth of a millimetre or so; these are the commonly published midpoints.
  var SS_SIZES = [
    { ss: 3, mm: 1.4 }, { ss: 4, mm: 1.6 }, { ss: 5, mm: 1.8 }, { ss: 6, mm: 2.0 },
    { ss: 7, mm: 2.2 }, { ss: 8, mm: 2.4 }, { ss: 9, mm: 2.6 }, { ss: 10, mm: 2.8 },
    { ss: 12, mm: 3.1 }, { ss: 14, mm: 3.5 }, { ss: 16, mm: 3.9 }, { ss: 18, mm: 4.3 },
    { ss: 20, mm: 4.7 }, { ss: 24, mm: 5.3 }, { ss: 30, mm: 6.4 }, { ss: 34, mm: 7.1 },
    { ss: 40, mm: 8.5 },
  ];

  function ssMm(ss) {
    for (var i = 0; i < SS_SIZES.length; i++) if (SS_SIZES[i].ss === ss) return SS_SIZES[i].mm;
    throw new Error("Unknown stone size SS" + ss);
  }
  function mmToIn(mm) { return mm / MM_PER_IN; }

  /* Centres of a square grid of stones, centred in the area. Each stone
     (radius r) lies fully inside the area; spacing is centre to centre. */
  function gridFill(width, height, spacing, radius) {
    var out = [];
    var usableW = width - 2 * radius, usableH = height - 2 * radius;
    if (usableW < 0 || usableH < 0 || spacing <= 0) return out;
    var cols = Math.floor(usableW / spacing + 1e-9) + 1;
    var rows = Math.floor(usableH / spacing + 1e-9) + 1;
    var x0 = radius + (usableW - (cols - 1) * spacing) / 2;
    var y0 = radius + (usableH - (rows - 1) * spacing) / 2;
    for (var j = 0; j < rows; j++)
      for (var i = 0; i < cols; i++) out.push({ x: x0 + i * spacing, y: y0 + j * spacing });
    return out;
  }

  /* Concentric rings around the centre of the area. Ring k has radius
     k * spacing and as many stones as fit with neighbours at least `spacing`
     apart (chord distance), so rings are never closer than spacing either. */
  function radialFill(width, height, spacing, radius) {
    var out = [];
    if (width < 2 * radius || height < 2 * radius || spacing <= 0) return out;
    var cx = width / 2, cy = height / 2;
    var maxR = Math.hypot(cx, cy);
    function inside(x, y) {
      return x >= radius - 1e-9 && x <= width - radius + 1e-9 &&
             y >= radius - 1e-9 && y <= height - radius + 1e-9;
    }
    out.push({ x: cx, y: cy });
    for (var k = 1; k * spacing <= maxR + spacing; k++) {
      var R = k * spacing;
      var n = Math.floor(Math.PI / Math.asin(Math.min(1, spacing / (2 * R))) + 1e-9);
      var offset = k % 2 ? Math.PI / n : 0; // stagger alternate rings
      for (var i = 0; i < n; i++) {
        var a = offset + (i / n) * 2 * Math.PI;
        var x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
        if (inside(x, y)) out.push({ x: x, y: y });
      }
    }
    return out;
  }

  /* Rough upper bound on stone count, so the UI can refuse absurd fills
     before generating them. */
  function estimateFillCount(width, height, spacing) {
    return Math.ceil((width / spacing + 1) * (height / spacing + 1));
  }

  function num(n) { return String(Math.round(n * 1000) / 1000); }
  function escAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

  /* A true-size SVG. width/height carry the physical size in inches; the
     viewBox is 96 units per inch so every app reads it at the same scale.
     stones: [{ x, y, ss, color }] in inches. */
  function buildSvg(opts) {
    var w = opts.width, h = opts.height, stones = opts.stones;
    var bySize = {};
    stones.forEach(function (s) { (bySize[s.ss] = bySize[s.ss] || []).push(s); });
    var sizes = Object.keys(bySize).map(Number).sort(function (a, b) { return a - b; });
    var U = SVG_UNITS_PER_IN;
    var parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + num(w) + 'in" height="' + num(h) +
        'in" viewBox="0 0 ' + num(w * U) + " " + num(h * U) + '">',
      "<title>" + escAttr(opts.title || "Rhinestone fill") + "</title>",
    ];
    sizes.forEach(function (ss) {
      var r = mmToIn(ssMm(ss)) / 2 * U;
      parts.push('<g id="SS' + ss + '" data-diameter-mm="' + ssMm(ss) + '" fill="none" stroke="#000" stroke-width="0.5">');
      bySize[ss].forEach(function (s) {
        var fill = opts.color ? ' fill="' + escAttr(s.color) + '"' : "";
        parts.push('<circle cx="' + num(s.x * U) + '" cy="' + num(s.y * U) + '" r="' + num(r) + '"' + fill + "/>");
      });
      parts.push("</g>");
    });
    parts.push("</svg>");
    return parts.join("\n") + "\n";
  }

  /* ---- minimal store-only zip, for the one-file-per-size download ---- */
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /* files: [{ name, text }] -> Uint8Array of a .zip */
  function makeZip(files) {
    var enc = new TextEncoder();
    var chunks = [], central = [], offset = 0;
    function u16(v) { return [v & 255, (v >> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      var common = [].concat(u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      var local = new Uint8Array([0x50, 0x4b, 3, 4].concat(common));
      chunks.push(local, name, data);
      var cen = [0x50, 0x4b, 1, 2].concat(u16(20), common.slice(0, 26), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(cen), name);
      offset += local.length + name.length + data.length;
    });
    var cenSize = 0;
    central.forEach(function (c) { cenSize += c.length; });
    var end = new Uint8Array([0x50, 0x4b, 5, 6].concat(u16(0), u16(0), u16(files.length), u16(files.length), u32(cenSize), u32(offset), u16(0)));
    var all = chunks.concat(central, [end]);
    var total = 0;
    all.forEach(function (c) { total += c.length; });
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  var api = {
    SS_SIZES: SS_SIZES, ssMm: ssMm, mmToIn: mmToIn, MM_PER_IN: MM_PER_IN,
    gridFill: gridFill, radialFill: radialFill, estimateFillCount: estimateFillCount,
    buildSvg: buildSvg, makeZip: makeZip, crc32: crc32,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RhinestoneCore = api;
})(typeof self !== "undefined" ? self : this);
