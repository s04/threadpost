ALTER TABLE conversations ADD COLUMN source_origin TEXT;
ALTER TABLE conversations ADD COLUMN source_path TEXT;
ALTER TABLE conversations ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
