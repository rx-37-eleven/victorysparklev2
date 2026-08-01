// One-time generator: turns world-atlas's 50m TopoJSON into the SVG path
// data committed at src/_data/regionMaps.json. This script is a
// devDependency-only tool -- Cloudflare Pages never runs it, `npm run build`
// only reads the JSON it produces. Re-run with `npm run maps` after editing
// tools/regions.js.
//
// For each region: fit a Mercator projection to the region's lon/lat bbox
// (not to the countries' own extent -- Russia's far east would otherwise
// blow out the Eastern Europe frame), then emit one <path> per listed
// country. A country whose projected bounding box is smaller than ~6px in
// both dimensions gets a <circle> marker instead (same idea as the DC
// marker on the US map), since a sliver that small isn't reliably
// clickable/tappable.
//
// Countries not in a region's list are never drawn, even if they fall
// inside its bbox -- keeps the regional maps as clean/blank as the US map
// outside its 50 states.
const fs = require("fs");
const path = require("path");
const topojson = require("topojson-client");
const d3geo = require("d3-geo");
const countries = require("i18n-iso-countries");
const world = require("world-atlas/countries-50m.json");
const regions = require("./regions.js");

countries.registerLocale(require("i18n-iso-countries/langs/en.json"));

const WIDTH = 900;
const HEIGHT = 600;
const PADDING = 10;
const SMALL_BBOX_PX = 6;
const CIRCLE_RADIUS = 5;
const OUTPUT_PATH = path.join(
  __dirname,
  "..",
  "src",
  "_data",
  "regionMaps.json"
);

// Natural Earth's admin-0 names are mostly good as-is; these are cosmetic
// fixes for a handful that read oddly or are cut off.
const NAME_OVERRIDES = {
  BA: "Bosnia and Herzegovina",
  MK: "North Macedonia",
  VA: "Vatican City",
  FK: "Falkland Islands",
};

function buildCountryIndex() {
  const geo = topojson.feature(world, world.objects.countries);
  const byAlpha2 = {};

  for (const feature of geo.features) {
    const alpha2 = countries.numericToAlpha2(feature.id);
    if (alpha2) byAlpha2[alpha2] = feature;
  }

  // Kosovo has no assigned ISO 3166-1 numeric code, so it isn't reachable
  // via numericToAlpha2 -- match it by name instead.
  const kosovo = geo.features.find((f) => f.properties.name === "Kosovo");
  if (kosovo) byAlpha2.XK = kosovo;

  // French Guiana isn't a separate feature in this dataset -- Natural
  // Earth's "France" admin-0 polygon is a MultiPolygon that includes
  // mainland France plus every overseas department, one ring each. Ring
  // index 9 is the South American landmass (French Guiana); pull it out
  // as its own feature so it can be drawn on the South America map.
  const france = geo.features.find((f) => f.properties.name === "France");
  if (france && france.geometry.coordinates[9]) {
    byAlpha2.GF = {
      type: "Feature",
      properties: { name: "French Guiana" },
      geometry: { type: "Polygon", coordinates: france.geometry.coordinates[9] },
    };
  }

  return byAlpha2;
}

// A MultiPoint of the four corners, not a Polygon ring. d3-geo adaptively
// resamples polygon *edges* along great-circle arcs before projecting --
// for a "constant latitude" edge like (12,61)->(42,61) the geodesic
// between those two points bulges toward the pole at its midpoint, which
// blew the fitted extent up to cover that bulge and left every country
// projected into a tiny corner of the canvas. Points have no edges to
// resample, so this fits to the corners themselves.
function bboxCorners(bbox) {
  const [[lonMin, latMin], [lonMax, latMax]] = bbox;
  return {
    type: "Feature",
    geometry: {
      type: "MultiPoint",
      coordinates: [
        [lonMin, latMin],
        [lonMax, latMin],
        [lonMax, latMax],
        [lonMin, latMax],
      ],
    },
  };
}

function generateRegion(key, region, countryIndex) {
  const projection = d3geo
    .geoMercator()
    .fitExtent(
      [
        [PADDING, PADDING],
        [WIDTH - PADDING, HEIGHT - PADDING],
      ],
      bboxCorners(region.bbox)
    );
  const geoPath = d3geo.geoPath(projection).digits(1);

  const places = {};

  for (const code of region.countries) {
    const feature = countryIndex[code];
    if (!feature) {
      console.warn(
        `[generate-country-paths] "${code}" (region "${key}") has no match in world-atlas/countries-50m -- skipping.`
      );
      continue;
    }

    const name = NAME_OVERRIDES[code] || feature.properties.name;
    const bounds = geoPath.bounds(feature);
    const width = bounds[1][0] - bounds[0][0];
    const height = bounds[1][1] - bounds[0][1];

    if (width < SMALL_BBOX_PX && height < SMALL_BBOX_PX) {
      const [cx, cy] = geoPath.centroid(feature);
      places[code] = {
        name,
        cx: Math.round(cx * 10) / 10,
        cy: Math.round(cy * 10) / 10,
        r: CIRCLE_RADIUS,
      };
    } else {
      places[code] = { name, d: geoPath(feature) };
    }
  }

  return {
    label: region.label,
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    places,
  };
}

function main() {
  const countryIndex = buildCountryIndex();
  const output = {
    _comment:
      "AUTO-GENERATED by tools/generate-country-paths.js from world-atlas's countries-50m TopoJSON -- do not hand-edit. Re-run `npm run maps` after editing tools/regions.js.",
  };

  for (const [key, region] of Object.entries(regions)) {
    output[key] = generateRegion(key, region, countryIndex);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
