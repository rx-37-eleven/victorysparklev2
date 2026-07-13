const travelmap = require("./travelmap.json");
const stateNames = require("./stateNames.json");

// Computed Eleventy data: for every one of the 50 states + DC, resolves the
// final status/label/color to render on the map, handling two fallback cases
// so a bad edit to travelmap.json can never break the build:
//   1. A state not listed in travelmap.states -> falls back to defaultStatus.
//   2. A state listed with a status key that doesn't exist in legend
//      (e.g. a typo) -> also falls back to defaultStatus, with a console
//      warning during the build so the mistake is easy to spot.
module.exports = function () {
  const result = {};

  for (const code of Object.keys(stateNames)) {
    let status = travelmap.states[code] || travelmap.defaultStatus;

    if (!travelmap.legend[status]) {
      console.warn(
        `[travelmap] "${code}" has status "${status}", which isn't in the legend. Falling back to defaultStatus ("${travelmap.defaultStatus}").`
      );
      status = travelmap.defaultStatus;
    }

    const legendEntry = travelmap.legend[status];

    result[code] = {
      name: stateNames[code],
      status,
      label: legendEntry.label,
      color: legendEntry.color,
    };
  }

  return result;
};
