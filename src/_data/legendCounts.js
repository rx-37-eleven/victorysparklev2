const travelmap = require("./travelmap.json");
const stateNames = require("./stateNames.json");

// Computed Eleventy data: counts how many of the 51 (50 states + DC) fall
// into each legend category, using the same resolution/fallback rules as
// mapRender.js (states with an unrecognized status count toward
// defaultStatus, not toward the invalid key). Depends on the same source
// data as mapRender, so the counts always sum to 51 — see acceptance
// criterion #7 in the build brief.
module.exports = function () {
  const counts = {};
  for (const key of Object.keys(travelmap.legend)) {
    counts[key] = 0;
  }

  for (const code of Object.keys(stateNames)) {
    let status = travelmap.states[code] || travelmap.defaultStatus;
    if (!travelmap.legend[status]) {
      status = travelmap.defaultStatus;
    }
    counts[status] = (counts[status] || 0) + 1;
  }

  return counts;
};
