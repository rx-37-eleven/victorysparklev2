module.exports = function (eleventyConfig) {
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
