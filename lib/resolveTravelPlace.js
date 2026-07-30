// Shared status -> label/color/tooltip resolution, used by both
// src/_data/mapRender.js and src/_data/legendCounts.js so states and
// countries are always resolved the same way. Handles the same two
// fallback cases either dataset can hit so a bad edit to travelmap.json
// can never break the build:
//   1. A place not listed in travelmap.json -> falls back to defaultStatus.
//   2. A place listed with a status key that doesn't exist in legend
//      (e.g. a typo) -> also falls back to defaultStatus, with a console
//      warning during the build so the mistake is easy to spot.
//
// `raw` is whatever travelmap.json has for this place: undefined, a bare
// status string ("visited"), or an object ({ status, year }).
module.exports = function resolveTravelPlace(code, name, raw, travelmap) {
  const entry = raw && typeof raw === "object" ? raw : { status: raw };
  let status = entry.status || travelmap.defaultStatus;

  if (!travelmap.legend[status]) {
    console.warn(
      `[travelmap] "${code}" has status "${status}", which isn't in the legend. Falling back to defaultStatus ("${travelmap.defaultStatus}").`
    );
    status = travelmap.defaultStatus;
  }

  const legendEntry = travelmap.legend[status];

  // Name only when no year is set; swap to `${name} — ${legendEntry.label}`
  // here to fall back to the status label instead.
  const tooltip = entry.year ? `${name} — ${entry.year}` : name;

  return {
    name,
    status,
    label: legendEntry.label,
    color: legendEntry.color,
    tooltip,
  };
};
