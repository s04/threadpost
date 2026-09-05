import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export interface Conversation {
  id: string; name: string; status: "open" | "closed"; createdAt: string; updatedAt: string;
  tokenHash: string; threadId: string | null; threadState: string; expiresAt: string;
}
export interface Message {
  id: number; conversationId: string; direction: "inbound" | "outbound"; body: string;
  createdAt: string; deliveryStatus: "pending" | "sending" | "sent" | "failed" | "unknown";
  clientMessageId: string;
}
const conversationColumns = `id,name,status,created_at AS createdAt,updated_at AS updatedAt,
 token_hash AS tokenHash,thread_id AS threadId,thread_state AS threadState,expires_at AS expiresAt`;
const messageColumns = `id,conversation_id AS conversationId,direction,body,created_at AS createdAt,
 delivery_status AS deliveryStatus,client_message_id AS clientMessageId`;

export class Store {
  db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        token_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, thread_id TEXT UNIQUE, thread_state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        direction TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
        client_message_id TEXT NOT NULL, delivery_status TEXT NOT NULL,
        UNIQUE(conversation_id,direction,client_message_id)
      );
      CREATE INDEX IF NOT EXISTS messages_outbox ON messages(delivery_status,id);
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_tokens ON conversations(token_hash);
      CREATE TABLE IF NOT EXISTS telegram_updates (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // A crash after submitting a request cannot prove that it was not delivered.
    this.db.exec("UPDATE messages SET delivery_status='unknown' WHERE delivery_status='sending'; UPDATE conversations SET thread_state='unknown' WHERE thread_state='sending'");
  }
  bindWorkspace(binding: string) {
    const existing = this.db.query("SELECT value FROM settings WHERE key='workspace'").get() as { value: string } | null;
    if (existing && existing.value !== binding)
      throw new Error("This database belongs to a different site or connector. Set a new DB_PATH; preserve the old database separately.");
    this.db.query("INSERT OR IGNORE INTO settings (key,value) VALUES ('workspace',?)").run(binding);
  }
  conversation(id: string): Conversation | null {
    return this.db.query(`SELECT ${conversationColumns} FROM conversations WHERE id=?`).get(id) as Conversation | null;
  }
  require(id: string) { const row = this.conversation(id); if (!row) throw new AppError(404, "Conversation not found."); return row; }
  create(name: string, token = secret()) {
    const now = new Date().toISOString();
    const existing = this.db.query("SELECT id,status,expires_at AS expiresAt FROM conversations WHERE token_hash=?").get(hash(token)) as { id: string; status: string; expiresAt: string } | null;
    if (existing) {
      if (existing.expiresAt < now) throw new AppError(401, "This conversation link has expired.");
      return { id: existing.id, token, status: existing.status };
    }
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
    this.db.query("INSERT INTO conversations (id,name,token_hash,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?)")
      .run(id, name || "Visitor", hash(token), now, now, expires);
    return { id, token, status: "open" };
  }
  authenticate(id: string, token: string) {
    const row = this.conversation(id);
    if (!row || hash(token) !== row.tokenHash || row.expiresAt < new Date().toISOString())
      throw new AppError(401, "This conversation link is invalid or expired.");
    return row;
  }
  messages(id: string): Message[] {
    return this.db.query(`SELECT ${messageColumns} FROM messages WHERE conversation_id=? ORDER BY id`).all(id) as Message[];
  }
  message(id: number): Message | null {
    return this.db.query(`SELECT ${messageColumns} FROM messages WHERE id=?`).get(id) as Message | null;
  }
  add(id: string, direction: "inbound" | "outbound", body: string, clientId: string): Message {
    return this.db.transaction(() => {
      const conversation = this.require(id);
      const old = this.db.query(`SELECT ${messageColumns} FROM messages WHERE conversation_id=? AND direction=? AND client_message_id=?`)
        .get(id, direction, clientId) as Message | null;
      if (old) { if (old.body !== body) throw new AppError(409, "This message ID was already used for different text."); return old; }
      if (conversation.status === "closed") throw new AppError(409, "This conversation is closed.");
      const count = this.db.query("SELECT count(*) AS n FROM messages WHERE conversation_id=?").get(id) as { n: number };
      if (count.n >= 2000) throw new AppError(409, "This conversation has reached its message limit.");
      const now = new Date().toISOString();
      const result = this.db.query("INSERT INTO messages (conversation_id,direction,body,created_at,client_message_id,delivery_status) VALUES (?,?,?,?,?,?)")
        .run(id, direction, body, now, clientId, direction === "inbound" ? "pending" : "sent");
      this.db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(now, id);
      return this.message(Number(result.lastInsertRowid))!;
    })();
  }
  list() {
    return this.db.query(`SELECT id,name,status,created_at AS createdAt,updated_at AS updatedAt,
      (SELECT body FROM messages WHERE conversation_id=conversations.id ORDER BY id DESC LIMIT 1) AS lastMessage,
      (SELECT count(*) FROM messages WHERE conversation_id=conversations.id) AS messageCount
      FROM conversations ORDER BY updated_at DESC LIMIT 200`).all();
  }
  counts() {
    return {
      open: (this.db.query("SELECT count(*) AS n FROM conversations WHERE status='open'").get() as any).n,
      closed: (this.db.query("SELECT count(*) AS n FROM conversations WHERE status='closed'").get() as any).n,
      pending: (this.db.query("SELECT count(*) AS n FROM messages WHERE delivery_status IN ('pending','sending')").get() as any).n,
      failed: (this.db.query("SELECT count(*) AS n FROM messages WHERE delivery_status IN ('failed','unknown')").get() as any).n,
    };
  }
  setStatus(id: string, status: string) {
    this.require(id);
    this.db.query("UPDATE conversations SET status=?,updated_at=? WHERE id=?").run(status, new Date().toISOString(), id);
    return this.require(id);
  }
  pending(): Message[] {
    return this.db.query(`SELECT ${messageColumns} FROM messages WHERE delivery_status='pending'
      AND NOT EXISTS (SELECT 1 FROM messages AS earlier WHERE earlier.conversation_id=messages.conversation_id
        AND earlier.direction='inbound' AND earlier.id < messages.id AND earlier.delivery_status != 'sent')
      ORDER BY id LIMIT 25`).all() as Message[];
  }
  delivery(id: number, status: string) { this.db.query("UPDATE messages SET delivery_status=? WHERE id=?").run(status, id); }
  thread(id: string, state: string, threadId: string | null = null) {
    this.db.query("UPDATE conversations SET thread_state=?,thread_id=coalesce(?,thread_id) WHERE id=?").run(state, threadId, id);
  }
  delete(id: string) { this.require(id); this.db.query("DELETE FROM conversations WHERE id=?").run(id); }
}
