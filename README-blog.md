# Blog setup — post by Telegram message

This is a one-time setup. Once it's done, **publishing a post is just sending
a Telegram message** — no editing files, no redeploying the site. The only
deploy you need is the one that ships this code (step 7 below); every post
after that is a database write, not a deploy.

## How it works

```
   Telegram  ──────▶  POST /api/telegram   (Pages Function)  ──────▶  D1 database  (posts)
                                                                       ▲
   Browser   ──────▶  GET /api/posts        (Pages Function)  ────────┘
                     │  /blog/ renders posts client-side
                     └─  (marked + DOMPurify from CDN)
```

- Posts are stored as raw Markdown in a Cloudflare D1 database (table `posts`).
- `/blog/` fetches from `/api/posts` and renders them in the browser.
- You publish by texting the bot; it writes straight to D1.

## Setup checklist

1. **Create the D1 database** (skip if you already have `victory-blog` — the
   `wrangler.toml` in this repo already points at a `database_id`, so this
   is likely already done):
   ```bash
   npx wrangler d1 create victory-blog
   ```
   Copy the `database_id` it prints into `wrangler.toml` under `[[d1_databases]]`.

2. **Apply the schema:**
   ```bash
   npx wrangler d1 migrations apply victory-blog --remote
   ```
   This creates the `posts` table from `migrations/0001_init.sql`.

3. **Confirm the D1 binding.** `wrangler.toml` already binds it as `DB`:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "victory-blog"
   database_id = "..."
   ```
   If the Cloudflare dashboard (Pages project → Settings → Bindings) also has
   a `DB` binding configured, **the dashboard wins** — keep it in one place
   only to avoid confusion.

4. **Telegram bot.** You already created one with `@BotFather` — keep the
   bot token handy for step 6.

5. **Find your numeric Telegram user id.** Message `@userinfobot` and it
   will reply with your id. (Only this id will be allowed to publish.)

6. **Set secrets** on the Pages project — dashboard → your Pages project →
   Settings → Variables and Secrets → add each as a **secret** (not a plain
   variable), or via CLI:
   ```bash
   npx wrangler pages secret put TELEGRAM_BOT_TOKEN
   npx wrangler pages secret put TELEGRAM_SECRET_TOKEN
   npx wrangler pages secret put TELEGRAM_ALLOWED_USER_ID
   ```
   - `TELEGRAM_BOT_TOKEN` — from BotFather.
   - `TELEGRAM_SECRET_TOKEN` — any long random string you make up yourself
     (e.g. `openssl rand -hex 32`). This is separate from the bot token.
   - `TELEGRAM_ALLOWED_USER_ID` — your numeric id from step 5.

7. **Deploy once.** Push this branch / merge it, however this project
   normally deploys to Cloudflare Pages (git push, or
   `npx wrangler pages deploy _site` after `npm run build`). This ships
   `/blog/` and the two Functions (`/api/posts`, `/api/telegram`).
   **This is the only deploy the blog ever needs** — every post after this
   is just a Telegram message.

8. **Register the webhook** so Telegram knows to call your site:
   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://victorysparkle.com/api/telegram" \
     -d "secret_token=<TELEGRAM_SECRET_TOKEN>"
   ```
   Use the *same* values you set as secrets in step 6.

9. **Test it.** Message your bot:
   ```
   /post My first post
   Hello world, this is the body of my first post!
   ```
   You should get a ✅ reply with a link. Visit `victorysparkle.com/blog/`
   to see it appear.

10. **Nav link.** Already there — `/blog/` is linked from the header and
    footer nav (see `src/_includes/base.njk`). Nothing to do here.

## Bot commands

| Command | Effect |
|---|---|
| `/post <title>`<br>`<body...>` | Publishes a post. First line = title, rest = Markdown body. |
| `/draft <title>`<br>`<body...>` | Same, but saved as a draft — never shown on the public site. |
| `/delete <slug>` | Deletes a post. |
| `/list` | Replies with the 10 most recent posts and their slugs. |
| `/help` | Shows this cheat-sheet. |
| Anything else | Posts nothing — replies with a nudge to use `/post` or `/help`. This is deliberate, so a stray message never goes live. |

Every publish/draft/delete gets a confirmation reply, so you always know it
worked — and `/delete <slug>` is your fast undo if a post goes out wrong.

## Security

Two gates on the webhook, both required:

1. The request must carry `X-Telegram-Bot-Api-Secret-Token` matching
   `TELEGRAM_SECRET_TOKEN` (set when you registered the webhook in step 8).
   This stops random traffic hitting the URL.
2. The sender's numeric Telegram id must match `TELEGRAM_ALLOWED_USER_ID`.
   This is the real authorization — only your account can publish.

The read API (`/api/posts`) is public and read-only, and only ever returns
`status = 'published'` posts — drafts are never exposed, even if someone
guesses the slug.

None of the three secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET_TOKEN`,
`TELEGRAM_ALLOWED_USER_ID`) are committed to git — they live only in the
Pages project's secrets.

## Changing the defaults

| Decision | Default | To change it |
|---|---|---|
| Storage | D1 | — |
| Publish channel | Telegram only | Email would need a separate Worker (Email Routing can't target a Pages Function) — not built here. |
| Images in posts | Not supported in v1 (text/Markdown only) | Phase 2: download the Telegram photo via `getFile`, store it in an R2 bucket, reference the R2 URL in the Markdown. |
| Rendering | Client-side (`marked` + `DOMPurify` from CDN) | — |
| Post URL | `/blog/?post=<slug>` | — |

## Ideas for later (not built)

- **Images** — see "Changing the defaults" above.
- **Editing posts** — `/edit <slug>` then send new text.
- **Tags** — a `tags` column plus a `#tag` convention in messages.
- **RSS feed** — a small `functions/feed.xml.js` Function reading from D1.
- **SEO** — posts render client-side, which is fine for humans but not
  ideal for crawlers. If that starts to matter, a Function could
  server-render post HTML for bots while humans keep the fast client
  version.
