const travelmap = require("./travelmap.json");
const stateNames = require("./stateNames.json");

// Computed Eleventy data: for every one of the 50 states + DC, resolves the
// final status/label/color/tooltip to render on the map, handling two
// fallback cases so a bad edit to travelmap.json can never break the build:
//   1. A state not listed in travelmap.states -> falls back to defaultStatus.
//   2. A state listed with a status key that doesn't exist in legend
//      (e.g. a typo) -> also falls back to defaultStatus, with a console
//      warning during the build so the mistake is easy to spot.
//
// Each entry in travelmap.states may be either a bare status string
// ("visited") or an object ({ "status": "visited", "year": "2019" }).
module.exports = function () {
  const result = {};

  for (const code of Object.keys(stateNames)) {
    const raw = travelmap.states[code];
    const entry = raw && typeof raw === "object" ? raw : { status: raw };

    let status = entry.status || travelmap.defaultStatus;

    if (!travelmap.legend[status]) {
      console.warn(
        `[travelmap] "${code}" has status "${status}", which isn't in the legend. Falling back to defaultStatus ("${travelmap.defaultStatus}").`
      );
      status = travelmap.defaultStatus;
    }

    const legendEntry = travelmap.legend[status];
    const name = stateNames[code];

    // Name only when no year is set; swap to `${name} — ${legendEntry.label}`
    // here to fall back to the status label instead.
    const tooltip = entry.year ? `${name} — ${entry.year}` : name;

    result[code] = {
      name,
      status,
      label: legendEntry.label,
      color: legendEntry.color,
      tooltip,
    };
  }

  return result;
};
