const resources = require("./resources.json");

// Computed Eleventy data: derives the unique, alphabetically-sorted tag list
// (with counts) from resources.json at build time, so the tag sidebar on
// /resources/ never has to be hand-maintained — add a resource with a new
// tag and it just appears here on the next build.
module.exports = function () {
  const counts = {};

  for (const resource of resources) {
    for (const tag of resource.tags || []) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }

  return Object.keys(counts)
    .sort()
    .map((tag) => ({ tag, count: counts[tag] }));
};
