// Sidecar data file for blogpost.njk. Computed here (plain Node, real
// `require`) rather than in Nunjucks front matter, because a templated
// front-matter string auto-escapes HTML once during that pass and then
// again when base.njk outputs {{ title }} / {{ description }} -- corrupting
// any post whose title or excerpt contains a literal "<" or "&". Computing
// in JS means it only ever gets escaped the one time, in the layout.
const { DateTime } = require("luxon");
const site = require("./_data/site.json");

function fallbackTitle(publishedAt) {
  return DateTime.fromISO(publishedAt, { zone: "utc" })
    .setZone(site.blogTimezone || "America/New_York")
    .toFormat("MMMM d, yyyy 'at' h:mm a");
}

module.exports = {
  layout: "base.njk",
  pagination: {
    data: "blogposts",
    size: 1,
  },
  eleventyComputed: {
    permalink: (data) => `/blog/${data.pagination.items[0].slug}/`,
    title: (data) => data.pagination.items[0].title || fallbackTitle(data.pagination.items[0].publishedAt),
    description: (data) => data.pagination.items[0].excerpt,
  },
};
