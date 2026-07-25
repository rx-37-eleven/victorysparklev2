CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,              -- timestamp-based unique id, e.g. 20260704T142530-a1b2
  slug        TEXT UNIQUE NOT NULL,          -- url-safe, derived from title
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL,                 -- raw markdown as received (source of truth)
  excerpt     TEXT,                          -- first ~160 chars of plain text, for the list view
  status      TEXT NOT NULL DEFAULT 'published',  -- 'published' | 'draft'
  source      TEXT,                          -- 'telegram'
  created_at  TEXT NOT NULL,                 -- ISO 8601 UTC
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_status  ON posts (status);
