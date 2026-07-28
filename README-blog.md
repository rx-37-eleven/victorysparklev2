# Blog: Telegram → D1 → static HTML

The blog at `/blog/` is a microblog. Posting is done from Telegram, not
from this repo — this repo only reads the posts back out and renders them.

```
Telegram  ──▶  victory-blog-bot (Worker)  ──▶  D1 database (victory-blog)
                                                       │
                                        Pages build ◀──┤  (this repo reads D1
                                        (this repo)     │   over the REST API
                                                         at BUILD time)
```

`victory-blog-bot` is a separate repo — it owns the Telegram webhook, the
allowlist of who's allowed to post, and all writes to D1. This repo never
writes to D1 and never talks to Telegram; it only reads published posts at
build time via `src/_data/blogposts.js`.

## Why build time, not a runtime API call

This site is a static Eleventy build on Cloudflare Pages. `blogposts.js`
fetches D1 once, during the build, and Eleventy renders the results to
plain static HTML — not a Pages Function querying D1 on every page view.

That means:

- Posts are real static HTML: fast, good for SEO, no cold starts, no
  per-request D1 cost.
- **If the D1 fetch fails, the build fails — on purpose.** `blogposts.js`
  throws rather than falling back to an empty list, so Cloudflare Pages
  just keeps serving the last successful deploy instead of publishing a
  blank blog. A broken `CF_API_TOKEN` should break the build loudly, not
  quietly ship an empty page.
- The trade-off: a new Telegram message takes about 60–90 seconds to
  appear, because a full Pages build has to run first (the bot triggers it
  automatically via a deploy hook). That delay is intentional, not a bug —
  don't "fix" it by adding client-side fetching.

The one case that's expected to return an empty list rather than fail the
build: running `npx @11ty/eleventy --serve` locally with no `.env` at all.
That's treated as "no credentials configured yet," not a fetch failure —
see the warning `blogposts.js` logs when that happens.

## Required Pages build variables

Cloudflare dashboard → Pages → `victorysparkle` → Settings → Variables and
secrets → add these as **build** variables, for both Production and Preview:

| Name | Value | Type |
|---|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account ID | plain |
| `CF_D1_DATABASE_ID` | the `victory-blog` D1 database's ID | plain |
| `CF_API_TOKEN` | API token scoped to D1 on this account | **secret/encrypted** |
| `NODE_VERSION` | `20` | plain |

A missing or invalid `CF_API_TOKEN` fails the Pages build — that's
intentional (see above), not a misconfiguration to work around.

For local development, copy these same three D1 values into a gitignored
`.env` file in the repo root (`CF_ACCOUNT_ID=...`, `CF_D1_DATABASE_ID=...`,
`CF_API_TOKEN=...`). See the `victory-blog-bot` repo's `SETUP.md` for how to
create the database and the token in the first place.

## Local development

```bash
npm install
cp .env.example .env   # fill in the 3 values; .env is gitignored
npm run serve
```

Without a `.env`, the site still builds — `/blog/` just shows "No posts yet"
instead of throwing, per the local-dev exception described above.

## Layout

```
src/_data/blogposts.js              fetches + shapes published posts from D1
src/_data/blogpostsForPagination.js pagination-safe wrapper (see its comment)
src/_data/site.json                 blogTimezone (display timezone for post dates)
src/blog.njk                        /blog/ index, paginated, reverse chronological
src/blogpost.njk + blogpost.11tydata.js   one page per post at /blog/<slug>/
src/feed.njk                        /blog/feed.xml (RSS 2.0)
```

## What this repo does NOT do

- **Write posts.** That's `victory-blog-bot` (Telegram webhook → D1).
- **Serve D1 at runtime.** There's deliberately no `[[d1_databases]]`
  binding in `wrangler.toml` — see the comment there.
- **Photos.** The `media` table exists in D1 already, but the upload path
  (Telegram photo → R2 → `media` row) isn't built yet; see `victory-blog-bot`'s
  README for status.
