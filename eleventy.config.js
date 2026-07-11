module.exports = function (eleventyConfig) {
  // Copy static assets straight through to the output folder untouched.
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/images");

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
