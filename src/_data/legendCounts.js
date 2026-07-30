const travelmap = require("./travelmap.json");
const stateNames = require("./stateNames.json");
const regionMaps = require("./regionMaps.json");
const resolveTravelPlace = require("../../lib/resolveTravelPlace");

// Computed Eleventy data: counts how many places on each map fall into each
// legend category, using the same shared resolution helper as mapRender.js
// so the counts always agree with what's actually drawn/highlighted.
//
//   legendCounts.us["visited"]         -> sums to 51 (50 states + DC)
//   legendCounts["asia"]["visited"]    -> sums to that region's country count
function emptyCounts() {
  const counts = {};
  for (const key of Object.keys(travelmap.legend)) {
    counts[key] = 0;
  }
  return counts;
}

module.exports = function () {
  const result = {};

  const us = emptyCounts();
  for (const code of Object.keys(stateNames)) {
    const { status } = resolveTravelPlace(
      code,
      stateNames[code],
      travelmap.states[code],
      travelmap
    );
    us[status] += 1;
  }
  result.us = us;

  for (const regionKey of Object.keys(regionMaps)) {
    if (regionKey.startsWith("_")) continue;

    const places = regionMaps[regionKey].places;
    const counts = emptyCounts();
    for (const code of Object.keys(places)) {
      const { status } = resolveTravelPlace(
        code,
        places[code].name,
        (travelmap.countries || {})[code],
        travelmap
      );
      counts[status] += 1;
    }
    result[regionKey] = counts;
  }

  return result;
};
