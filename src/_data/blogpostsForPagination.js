// Eleventy's pagination produces zero pages (not one empty page) when its
// source array is empty, which would mean /blog/ doesn't exist at all with
// no posts yet -- but the spec calls for a friendly "No posts yet" page
// instead. This wraps blogposts.js's (memoized, so no extra D1 call) result
// in a single placeholder item when the real list is empty, purely so
// pagination always creates at least one page; blog.njk checks for
// `__empty` and renders the friendly message instead of a post.
const blogposts = require("./blogposts.js");

module.exports = async function () {
  const posts = await blogposts();
  return posts.length > 0 ? posts : [{ __empty: true }];
};
