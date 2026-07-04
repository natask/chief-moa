CREATE TABLE IF NOT EXISTS waitlist (
  email      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source     TEXT,
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist (created_at);
