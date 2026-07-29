const path = require("path");
const fs = require("fs");
const { DateTime } = require("luxon");
const pluginRss = require("@11ty/eleventy-plugin-rss");
// @11ty/eleventy-img v7 is ESM-only; required via CommonJS interop, the
// callable image-transform function lands on .default rather than being
// the module export itself.
const eleventyImg = require("@11ty/eleventy-img");
const Image = eleventyImg.default;
const site = require("./src/_data/site.js");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPlugin(pluginRss);

  // Copy static assets straight through to the output folder untouched.
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy("src/js");

  // Formats a YYYY-MM-DD date string (e.g. from resources.json) into a
  // human-readable form, e.g. "2026-07-13" -> "July 13, 2026". Used on the
  // resources page so tile dates read naturally without pulling in a date library.
  eleventyConfig.addFilter("readableDate", (dateString) => {
    const date = new Date(`${dateString}T00:00:00`);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  });

  // Blog posts are stored as UTC ISO 8601 strings (e.g.
  // "2026-07-25T14:03:22Z"). postDate converts to the display timezone from
  // site.js (default America/New_York) for on-page reading, e.g.
  // "July 25, 2026 at 10:03 AM". Kept separate from readableDate above --
  // that one is plain-date-only and the resources page depends on its
  // current behavior, so it's left untouched rather than merged with this.
  eleventyConfig.addFilter("postDate", (isoString) => {
    return DateTime.fromISO(isoString, { zone: "utc" })
      .setZone(site.blogTimezone || "America/New_York")
      .toFormat("MMMM d, yyyy 'at' h:mm a");
  });

  // Raw ISO string for <time datetime="..."> and the RSS feed: always UTC,
  // no display timezone conversion, so it stays one unambiguous value.
  eleventyConfig.addFilter("postDateISO", (isoString) => {
    return DateTime.fromISO(isoString, { zone: "utc" }).toISO();
  });

  // eleventy-plugin-rss's date filters (dateToRfc822) want a JS Date, and
  // blogposts.js stores timestamps as ISO strings -- this bridges the two
  // for src/feed.njk.
  eleventyConfig.addFilter("toDate", (isoString) => new Date(isoString));

  // Truncates an array to its first n items -- used to cap the RSS feed at
  // 20 posts without relying on Nunjucks's `slice` filter, which chunks
  // into batches rather than truncating.
  eleventyConfig.addFilter("limit", (arr, n) => (arr || []).slice(0, n));

  // Responsive image shortcode. `src` is a site-root path like
  // "/images/resources/foo.png"; the source file is read from src/ and
  // optimized copies are written to _site/img/.
  //
  // If the source file is missing this returns the same purple sparkle
  // placeholder the resources page already uses, rather than throwing --
  // a bad filename in resources.json must not break the build.
  eleventyConfig.addAsyncShortcode(
    "image",
    async function (src, alt, sizes = "100vw", className = "") {
      const inputPath = path.join("src", src);

      if (!src || !fs.existsSync(inputPath)) {
        console.warn(`[image] missing source, using placeholder: ${src}`);
        return `<div class="${className} resource-tile-placeholder">✨</div>`;
      }

      const metadata = await Image(inputPath, {
        widths: [400, 800, 1200],
        formats: ["webp", "jpeg"],
        outputDir: "./_site/img/",
        urlPath: "/img/",
      });

      return eleventyImg.generateHTML(metadata, {
        alt: alt || "",
        sizes,
        class: className,
        loading: "lazy",
        decoding: "async",
      });
    }
  );

  // Self-contained web apps. Everything under src/apps/ is copied verbatim,
  // so each app keeps its own HTML/CSS/JS and never touches the template
  // engine. To add a new app later: make src/apps/<app-name>/index.html
  // (plus its own css/js) and it will appear at /apps/<app-name>/.
  eleventyConfig.addPassthroughCopy("src/apps");

  return {
    // .html is deliberately NOT a template format: the app pages under
    // src/apps/ are plain HTML and must not be parsed by Nunjucks/Liquid.
    // Site pages use .md / .njk.
    templateFormats: ["md", "njk", "liquid"],

    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
  };
};
