export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    token_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, thread_id TEXT UNIQUE, thread_state TEXT NOT NULL DEFAULT 'pending',
    source_origin TEXT, source_path TEXT, blocked INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
    client_message_id TEXT NOT NULL, delivery_status TEXT NOT NULL,
    UNIQUE(conversation_id,direction,client_message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS messages_outbox ON messages(delivery_status,id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_tokens ON conversations(token_hash)`,
  `CREATE TABLE IF NOT EXISTS telegram_updates (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS connector_events (
    connector TEXT NOT NULL, event_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(connector,event_id)
  )`,
  `INSERT OR IGNORE INTO connector_events (connector,event_id,created_at)
    SELECT 'telegram',cast(id AS TEXT),created_at FROM telegram_updates`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, expires_at INTEGER NOT NULL, count INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at)`,
] as const;

export const recoveryStatements = [
  "UPDATE messages SET delivery_status='unknown' WHERE delivery_status='sending'",
  "UPDATE conversations SET thread_state='unknown' WHERE thread_state='sending'",
] as const;
