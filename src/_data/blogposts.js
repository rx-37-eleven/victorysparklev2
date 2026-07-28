// Computed Eleventy data: fetches published posts (and their media) from the
// victory-blog D1 database over Cloudflare's REST API, at BUILD time.
//
// This is the whole point of the design (see the build brief, "Why
// build-time and not runtime"): a Pages Function querying D1 on every
// request would mean cold starts, runtime D1 cost, and — worse — a D1
// outage taking the blog down. Reading D1 here instead means posts render
// to plain static HTML, and if this fetch fails, Eleventy fails the build
// and Cloudflare Pages just keeps serving the last successful deploy. The
// trade-off is that a new post takes a Pages build (~60-90s) to appear
// instead of being instant; that's accepted, not a bug.
require("dotenv").config();
const MarkdownIt = require("markdown-it");

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// Memoized: src/_data/blogpostsForPagination.js also calls this (it needs
// the same list, guaranteed non-empty, to work around Eleventy pagination
// producing zero pages for an empty array -- see that file for why).
// Caching the in-flight promise means that still only costs one D1 round
// trip per build, not two.
let cachedPosts = null;

module.exports = async function () {
  if (!cachedPosts) cachedPosts = fetchBlogposts();
  return cachedPosts;
};

async function fetchBlogposts() {
  const { CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN } = process.env;

  // Someone running `npx @11ty/eleventy --serve` locally with no .env at
  // all is a normal, expected case (not a fetch failure) -- let the rest of
  // the site still build, just without posts.
  if (!CF_ACCOUNT_ID || !CF_D1_DATABASE_ID || !CF_API_TOKEN) {
    console.warn(
      "[blogposts] CF_ACCOUNT_ID / CF_D1_DATABASE_ID / CF_API_TOKEN not set - " +
        "building with zero posts. Set them in .env for local dev, or as Pages build variables in production."
    );
    return [];
  }

  const config = { accountId: CF_ACCOUNT_ID, databaseId: CF_D1_DATABASE_ID, apiToken: CF_API_TOKEN };

  const posts = await d1RestQuery(
    "SELECT id, slug, title, body_md, created_at, updated_at, published_at " +
      "FROM posts WHERE status = 'published' ORDER BY published_at DESC",
    [],
    config
  );

  const mediaByPostId = await fetchMediaForPosts(posts, config);

  return posts.map((post) => {
    const bodyHtml = md.render(post.body_md || "");
    return {
      id: post.id,
      slug: post.slug,
      title: post.title || null,
      bodyHtml,
      excerpt: makeExcerpt(post.body_md || ""),
      createdAt: post.created_at,
      publishedAt: post.published_at,
      updatedAt: post.updated_at,
      url: `/blog/${post.slug}/`,
      media: mediaByPostId[post.id] || [],
    };
  });
}

async function fetchMediaForPosts(posts, config) {
  if (posts.length === 0) return {};

  const placeholders = posts.map(() => "?").join(", ");
  const rows = await d1RestQuery(
    `SELECT id, post_id, kind, url, alt, width, height, sort_order FROM media ` +
      `WHERE post_id IN (${placeholders}) ORDER BY post_id, sort_order`,
    posts.map((p) => p.id),
    config
  );

  const byPostId = {};
  for (const row of rows) {
    if (!byPostId[row.post_id]) byPostId[row.post_id] = [];
    byPostId[row.post_id].push({
      id: row.id,
      kind: row.kind,
      url: row.url,
      alt: row.alt || "",
      width: row.width,
      height: row.height,
    });
  }
  return byPostId;
}

// First ~160 characters of plain text, for <meta name="description"> and
// RSS. Markdown syntax is stripped crudely rather than by rendering to HTML
// and stripping tags -- good enough for a short excerpt, and avoids parsing
// the body twice.
function makeExcerpt(bodyMd) {
  const plain = bodyMd
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\\([\\`*_[\]()#])/g, "$1") // undo entities.js's escaping of literal chars
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\(([^)]*)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 160 ? `${plain.slice(0, 157)}...` : plain;
}

async function attemptQuery(url, options) {
  try {
    const res = await fetch(url, options);
    if (res.ok) {
      const json = await res.json();
      if (!json.success) {
        return { ok: false, retryable: false, error: new Error(`D1 query failed: ${JSON.stringify(json.errors)}`) };
      }
      return { ok: true, data: (json.result && json.result[0] && json.result[0].results) || [] };
    }
    const bodyText = await res.text();
    return { ok: false, retryable: res.status >= 500, error: new Error(`D1 REST returned ${res.status}: ${bodyText}`) };
  } catch (err) {
    // Network-level failure (DNS, connection reset, timeout, ...) -- always worth retrying.
    return { ok: false, retryable: true, error: err };
  }
}

async function d1RestQuery(sql, params, config) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params: params || [] }),
  };

  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const result = await attemptQuery(url, options);
    if (result.ok) return result.data;

    lastError = result.error;
    if (!result.retryable) break;
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }

  // Deliberately not caught anywhere above this: a failed build leaves the
  // previous good deploy live, which is the whole safety property this
  // design is built around. Swallowing this and returning [] instead would
  // silently publish an empty blog.
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
