// Single source of truth for the regional maps: which countries belong to
// each region, and the lon/lat bounding box the projection is fit to (not
// fit to the countries themselves -- see generate-country-paths.js for why).
// Edit this file to add/remove/re-cut regions, then re-run `npm run maps`
// to regenerate src/_data/regionMaps.json.
//
// Region key order here determines display order on /map/.
//
// Notes on the current split:
// - RU is assigned to Eastern Europe and TR to Asia so neither country is
//   duplicated across regions, even though both straddle a border.
// - Greece/Cyprus, Finland, and the Baltics are all defensibly "Eastern" or
//   "Western" depending who you ask -- this cut puts the Baltics and the
//   ex-Soviet/ex-Yugoslav states in Eastern Europe, and Greece/Cyprus/Finland
//   in Western Europe alongside the rest of the EU/EEA/Nordic countries.
module.exports = {
  "eastern-europe": {
    label: "Eastern Europe",
    bbox: [
      [12, 39],
      [42, 61],
    ],
    countries: [
      "AL", "BA", "BG", "BY", "CZ", "EE", "HR", "HU", "LT", "LV", "MD", "ME",
      "MK", "PL", "RO", "RS", "RU", "SI", "SK", "UA", "XK",
    ],
  },
  "western-europe": {
    label: "Western Europe",
    bbox: [
      [-25, 34],
      [20, 67],
    ],
    countries: [
      "AD", "AT", "BE", "CH", "CY", "DE", "DK", "ES", "FI", "FR", "GB", "GR",
      "IE", "IS", "IT", "LI", "LU", "MC", "MT", "NL", "NO", "PT", "SE", "SM",
      "VA",
    ],
  },
  asia: {
    label: "Asia",
    bbox: [
      [25, -11],
      [150, 56],
    ],
    countries: [
      "AE", "AF", "AM", "AZ", "BD", "BH", "BN", "BT", "CN", "GE", "ID", "IL",
      "IN", "IQ", "IR", "JO", "JP", "KG", "KH", "KP", "KR", "KW", "KZ", "LA",
      "LB", "LK", "MM", "MN", "MV", "MY", "NP", "OM", "PH", "PK", "PS", "QA",
      "SA", "SG", "SY", "TH", "TJ", "TL", "TM", "TR", "TW", "UZ", "VN", "YE",
    ],
  },
  "south-america": {
    label: "South America",
    bbox: [
      [-82, -56],
      [-34, 13],
    ],
    countries: [
      "AR", "BO", "BR", "CL", "CO", "EC", "FK", "GF", "GY", "PE", "PY", "SR",
      "UY", "VE",
    ],
  },
};
