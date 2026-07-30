const travelmap = require("./travelmap.json");
const stateNames = require("./stateNames.json");
const regionMaps = require("./regionMaps.json");
const resolveTravelPlace = require("../../lib/resolveTravelPlace");

// Computed Eleventy data: resolves the final status/label/color/tooltip for
// every place drawn on any map, states and countries alike, through the
// same shared helper (see lib/resolveTravelPlace.js) so both fallback
// cases -- an unlisted place, or a status key that's a typo -- behave
// identically and can never break the build.
//
//   mapRender.states["TX"]            -> { name, status, label, color, tooltip }
//   mapRender.regions["asia"]["JP"]   -> same shape
module.exports = function () {
  const states = {};
  for (const code of Object.keys(stateNames)) {
    states[code] = resolveTravelPlace(
      code,
      stateNames[code],
      travelmap.states[code],
      travelmap
    );
  }

  const regions = {};
  for (const regionKey of Object.keys(regionMaps)) {
    if (regionKey.startsWith("_")) continue;

    const places = regionMaps[regionKey].places;
    const regionResult = {};
    for (const code of Object.keys(places)) {
      regionResult[code] = resolveTravelPlace(
        code,
        places[code].name,
        (travelmap.countries || {})[code],
        travelmap
      );
    }
    regions[regionKey] = regionResult;
  }

  return { states, regions };
};
