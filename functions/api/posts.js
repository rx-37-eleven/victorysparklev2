// GET /api/posts            -> list of published posts, newest first
// GET /api/posts?slug=<x>   -> single published post by slug
//
// Read-only, public, same-origin (blog.html is served from this same Pages
// domain), so no CORS headers are needed.

const DEFAULT_LIMIT = 20;

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");

  if (slug) {
    return getSinglePost(env, slug);
  }
  return getPostList(env, url.searchParams);
}

async function getSinglePost(env, slug) {
  const row = await env.DB.prepare(
    "SELECT slug, title, body_md, created_at, updated_at FROM posts WHERE slug = ? AND status = 'published'"
  )
    .bind(slug)
    .first();

  if (!row) {
    return jsonResponse({ error: "not found" }, 404);
  }

  return jsonResponse({ post: row });
}

async function getPostList(env, searchParams) {
  const limit = clampInt(searchParams.get("limit"), DEFAULT_LIMIT, 1, 100);
  const offset = clampInt(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  const { results } = await env.DB.prepare(
    "SELECT slug, title, excerpt, created_at FROM posts WHERE status = 'published' ORDER BY created_at DESC LIMIT ? OFFSET ?"
  )
    .bind(limit, offset)
    .all();

  return jsonResponse({ posts: results || [] }, 200, { "Cache-Control": "max-age=30" });
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
