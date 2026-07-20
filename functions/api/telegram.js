// POST /api/telegram — Telegram webhook. Publishing path for the blog.
//
// Security (both required):
//   1. X-Telegram-Bot-Api-Secret-Token header must match env.TELEGRAM_SECRET_TOKEN.
//   2. The sender's numeric Telegram user id must match env.TELEGRAM_ALLOWED_USER_ID.
//
// Always returns HTTP 200 (even on errors) so Telegram never retries and
// duplicates a post. Errors are reported back to the user via sendMessage
// instead of via the HTTP status.

export async function onRequestPost(context) {
  const { env, request } = context;

  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_SECRET_TOKEN || secretHeader !== env.TELEGRAM_SECRET_TOKEN) {
    // Don't leak anything to unauthenticated callers, and don't touch Telegram.
    return new Response("ok", { status: 200 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  const message = update && update.message;
  const chatId = message && message.chat && message.chat.id;
  const fromId = message && message.from && message.from.id;
  const text = message && typeof message.text === "string" ? message.text.trim() : "";

  if (!chatId || !fromId) {
    return new Response("ok", { status: 200 });
  }

  if (String(fromId) !== String(env.TELEGRAM_ALLOWED_USER_ID)) {
    // Real authorization gate. Silently ignore — don't confirm the bot exists.
    return new Response("ok", { status: 200 });
  }

  try {
    await handleCommand(env, chatId, text);
  } catch (err) {
    await sendMessage(env, chatId, `⚠️ Something went wrong: ${err.message || err}`);
  }

  return new Response("ok", { status: 200 });
}

async function handleCommand(env, chatId, text) {
  if (text.startsWith("/post ") || text === "/post") {
    return publishPost(env, chatId, text.slice("/post".length).trim(), "published");
  }
  if (text.startsWith("/draft ") || text === "/draft") {
    return publishPost(env, chatId, text.slice("/draft".length).trim(), "draft");
  }
  if (text.startsWith("/delete ") || text === "/delete") {
    return deletePost(env, chatId, text.slice("/delete".length).trim());
  }
  if (text === "/list") {
    return listPosts(env, chatId);
  }
  if (text === "/help") {
    return sendMessage(env, chatId, helpText());
  }

  return sendMessage(
    env,
    chatId,
    "Send /post <your text> to publish, or /help for options."
  );
}

async function publishPost(env, chatId, body, status) {
  if (!body) {
    await sendMessage(env, chatId, "That command needs some text after it. Try /help.");
    return;
  }

  const lines = body.split("\n");
  const title = lines[0].trim();
  const bodyMd = lines.length > 1 ? lines.slice(1).join("\n").trim() : title;

  if (!title) {
    await sendMessage(env, chatId, "Couldn't find a title in that message. Try /help.");
    return;
  }

  const slug = await uniqueSlug(env, slugify(title));
  const excerpt = makeExcerpt(bodyMd);
  const now = new Date().toISOString();
  const id = makeId(now);

  await env.DB.prepare(
    `INSERT INTO posts (id, slug, title, body_md, excerpt, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'telegram', ?, ?)`
  )
    .bind(id, slug, title, bodyMd, excerpt, status, now, now)
    .run();

  if (status === "draft") {
    await sendMessage(env, chatId, `📝 Saved as draft: "${title}"\nslug: ${slug}`);
  } else {
    await sendMessage(
      env,
      chatId,
      `✅ Published: "${title}"\nhttps://victorysparkle.com/blog.html?post=${slug}`
    );
  }
}

async function deletePost(env, chatId, slug) {
  if (!slug) {
    await sendMessage(env, chatId, "Usage: /delete <slug>");
    return;
  }

  const existing = await env.DB.prepare("SELECT title FROM posts WHERE slug = ?")
    .bind(slug)
    .first();

  if (!existing) {
    await sendMessage(env, chatId, `No post found with slug "${slug}".`);
    return;
  }

  await env.DB.prepare("DELETE FROM posts WHERE slug = ?").bind(slug).run();
  await sendMessage(env, chatId, `🗑️ Deleted: "${existing.title}" (${slug})`);
}

async function listPosts(env, chatId) {
  const { results } = await env.DB.prepare(
    "SELECT slug, title, status FROM posts ORDER BY created_at DESC LIMIT 10"
  ).all();

  if (!results || results.length === 0) {
    await sendMessage(env, chatId, "No posts yet.");
    return;
  }

  const lines = results.map(
    (p) => `${p.status === "draft" ? "📝" : "✅"} ${p.title} — ${p.slug}`
  );
  await sendMessage(env, chatId, `Recent posts:\n${lines.join("\n")}`);
}

function helpText() {
  return [
    "Blog commands:",
    "/post <title, then a new line, then the body> — publish a post",
    "/draft <same as /post> — save as a draft (not public)",
    "/delete <slug> — delete a post",
    "/list — show the 10 most recent posts",
    "/help — this message",
  ].join("\n");
}

async function uniqueSlug(env, baseSlug) {
  let slug = baseSlug || "post";
  let attempt = 0;
  while (attempt < 20) {
    const existing = await env.DB.prepare("SELECT 1 FROM posts WHERE slug = ?")
      .bind(slug)
      .first();
    if (!existing) return slug;
    attempt += 1;
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return `${baseSlug}-${Date.now()}`;
}

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "post";
}

function makeExcerpt(bodyMd) {
  const plain = bodyMd
    .replace(/[#*_`>[\]!]/g, "")
    .replace(/\(([^)]*)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 160 ? `${plain.slice(0, 157)}...` : plain;
}

function makeId(isoNow) {
  const compact = isoNow.replace(/[-:.TZ]/g, "").slice(0, 15);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${compact}-${suffix}`;
}

async function sendMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
