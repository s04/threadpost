import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { recoveryStatements, schemaStatements } from "./schema";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export interface Conversation {
  id: string; name: string; status: "open" | "closed"; createdAt: string; updatedAt: string;
  tokenHash: string; threadId: string | null; threadState: string; expiresAt: string;
  sourceOrigin: string | null; sourcePath: string | null; blocked: boolean;
}
export interface Message {
  id: number; conversationId: string; direction: "inbound" | "outbound"; body: string;
  createdAt: string; deliveryStatus: "pending" | "sending" | "sent" | "failed" | "unknown";
  clientMessageId: string;
}
export type MaybePromise<T> = T | Promise<T>;
export interface Storage {
  ready(): MaybePromise<void>;
  close(): MaybePromise<void>;
  bindWorkspace(binding: string): MaybePromise<void>;
  conversation(id: string): MaybePromise<Conversation | null>;
  require(id: string): MaybePromise<Conversation>;
  create(name: string, token?: string, source?: { origin: string | null; path: string | null }): MaybePromise<{ id: string; token: string; status: string }>;
  findByToken(token: string): MaybePromise<Conversation | null>;
  authenticate(id: string, token: string): MaybePromise<Conversation>;
  messages(id: string): MaybePromise<Message[]>;
  message(id: number): MaybePromise<Message | null>;
  findMessage(conversationId: string, direction: "inbound" | "outbound", clientId: string): MaybePromise<Message | null>;
  add(id: string, direction: "inbound" | "outbound", body: string, clientId: string): MaybePromise<Message>;
  list(): MaybePromise<unknown[]>;
  counts(): MaybePromise<{ open: number; closed: number; pending: number; failed: number }>;
  setStatus(id: string, status: string): MaybePromise<Conversation>;
  setBlocked(id: string, blocked: boolean): MaybePromise<Conversation>;
  pending(): MaybePromise<Message[]>;
  delivery(id: number, status: string): MaybePromise<void>;
  thread(id: string, state: string, threadId?: string | null): MaybePromise<void>;
  delete(id: string): MaybePromise<void>;
  receiveReply(connector: string, eventId: string, threadId: string, body: string): MaybePromise<boolean>;
  getSetting(key: string): MaybePromise<string | null>;
  setSetting(key: string, value: string): MaybePromise<void>;
  resetThreads(): MaybePromise<void>;
  saveTelegramSettings(value: string, resetThreads: boolean): MaybePromise<void>;
  consumeQuota(key: string, limit: number, periodMs: number, now?: number): MaybePromise<boolean>;
}
const conversationColumns = `id,name,status,created_at AS createdAt,updated_at AS updatedAt,
 token_hash AS tokenHash,thread_id AS threadId,thread_state AS threadState,expires_at AS expiresAt,
 source_origin AS sourceOrigin,source_path AS sourcePath,blocked`;
const messageColumns = `id,conversation_id AS conversationId,direction,body,created_at AS createdAt,
 delivery_status AS deliveryStatus,client_message_id AS clientMessageId`;
const conversationRow = (row: Conversation | null) => row ? { ...row, blocked: Boolean(row.blocked) } : null;

export class Store implements Storage {
  db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; ${schemaStatements.join(";")}`);
    const columns = new Set((this.db.query("PRAGMA table_info(conversations)").all() as { name: string }[]).map(row => row.name));
    if (!columns.has("source_origin")) this.db.exec("ALTER TABLE conversations ADD COLUMN source_origin TEXT");
    if (!columns.has("source_path")) this.db.exec("ALTER TABLE conversations ADD COLUMN source_path TEXT");
    if (!columns.has("blocked")) this.db.exec("ALTER TABLE conversations ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0");
    // A crash after submitting a request cannot prove that it was not delivered.
    this.db.exec(recoveryStatements.join(";"));
  }
  ready() {}
  close() { this.db.close(); }
  bindWorkspace(binding: string) {
    const existing = this.db.query("SELECT value FROM settings WHERE key='workspace'").get() as { value: string } | null;
    if (existing && existing.value !== binding)
      throw new Error("This database belongs to a different site or connector. Set a new DB_PATH; preserve the old database separately.");
    this.db.query("INSERT OR IGNORE INTO settings (key,value) VALUES ('workspace',?)").run(binding);
  }
  conversation(id: string): Conversation | null {
    return conversationRow(this.db.query(`SELECT ${conversationColumns} FROM conversations WHERE id=?`).get(id) as Conversation | null);
  }
  require(id: string) { const row = this.conversation(id); if (!row) throw new AppError(404, "Conversation not found."); return row; }
  create(name: string, token = secret(), source: { origin: string | null; path: string | null } = { origin: null, path: null }) {
    const now = new Date().toISOString();
    const existing = this.db.query("SELECT id,status,expires_at AS expiresAt FROM conversations WHERE token_hash=?").get(hash(token)) as { id: string; status: string; expiresAt: string } | null;
    if (existing) {
      if (existing.expiresAt < now) throw new AppError(401, "This conversation link has expired.");
      return { id: existing.id, token, status: existing.status };
    }
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
    this.db.query("INSERT INTO conversations (id,name,token_hash,created_at,updated_at,expires_at,source_origin,source_path) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, name || "Visitor", hash(token), now, now, expires, source.origin, source.path);
    return { id, token, status: "open" };
  }
  findByToken(token: string) {
    return conversationRow(this.db.query(`SELECT ${conversationColumns} FROM conversations WHERE token_hash=?`).get(hash(token)) as Conversation | null);
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
  findMessage(conversationId: string, direction: "inbound" | "outbound", clientId: string) {
    return this.db.query(`SELECT ${messageColumns} FROM messages WHERE conversation_id=? AND direction=? AND client_message_id=?`)
      .get(conversationId, direction, clientId) as Message | null;
  }
  add(id: string, direction: "inbound" | "outbound", body: string, clientId: string): Message {
    return this.db.transaction(() => {
      const conversation = this.require(id);
      if (direction === "inbound" && conversation.blocked) throw new AppError(403, "This conversation is blocked.");
      const old = this.findMessage(id, direction, clientId);
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
      (SELECT count(*) FROM messages WHERE conversation_id=conversations.id) AS messageCount,
      source_origin AS sourceOrigin,source_path AS sourcePath,blocked,
      (SELECT max(id) FROM messages WHERE conversation_id=conversations.id AND direction='inbound') AS lastInboundId
      FROM conversations ORDER BY updated_at DESC LIMIT 200`).all().map((row: any) => ({ ...row, blocked: Boolean(row.blocked) }));
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
  setBlocked(id: string, blocked: boolean) {
    this.require(id);
    this.db.query("UPDATE conversations SET blocked=?,updated_at=? WHERE id=?").run(blocked ? 1 : 0, new Date().toISOString(), id);
    return this.require(id);
  }
  pending(): Message[] {
    return this.db.query(`SELECT ${messageColumns} FROM messages WHERE delivery_status='pending'
      AND EXISTS (SELECT 1 FROM conversations WHERE conversations.id=messages.conversation_id AND conversations.blocked=0)
      AND NOT EXISTS (SELECT 1 FROM messages AS earlier WHERE earlier.conversation_id=messages.conversation_id
        AND earlier.direction='inbound' AND earlier.id < messages.id AND earlier.delivery_status != 'sent')
      ORDER BY id LIMIT 25`).all() as Message[];
  }
  delivery(id: number, status: string) { this.db.query("UPDATE messages SET delivery_status=? WHERE id=?").run(status, id); }
  thread(id: string, state: string, threadId: string | null = null) {
    this.db.query("UPDATE conversations SET thread_state=?,thread_id=coalesce(?,thread_id) WHERE id=?").run(state, threadId, id);
  }
  delete(id: string) { this.require(id); this.db.query("DELETE FROM conversations WHERE id=?").run(id); }
  receiveReply(connector: string, eventId: string, threadId: string, body: string) {
    return this.db.transaction(() => {
      if (this.db.query("SELECT event_id FROM connector_events WHERE connector=? AND event_id=?").get(connector, eventId)) return false;
      const row = this.db.query("SELECT id FROM conversations WHERE thread_id=?").get(threadId) as { id: string } | null;
      if (!row) return false;
      if (this.require(row.id).blocked) return false;
      this.setStatus(row.id, "open");
      this.add(row.id, "outbound", body, `provider-${connector}-${eventId}`);
      this.db.query("INSERT INTO connector_events (connector,event_id,created_at) VALUES (?,?,?)")
        .run(connector, eventId, new Date().toISOString());
      return true;
    })();
  }
  getSetting(key: string) {
    return (this.db.query("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | null)?.value || null;
  }
  setSetting(key: string, value: string) {
    this.db.query("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  resetThreads() { this.db.query("UPDATE conversations SET thread_id=NULL,thread_state='pending'").run(); }
  saveTelegramSettings(value: string, resetThreads: boolean) {
    this.db.transaction(() => {
      this.setSetting("telegram_config", value);
      if (resetThreads) this.resetThreads();
    })();
  }
  consumeQuota(key: string, limit: number, periodMs: number, now = Date.now()) {
    if (!key || key.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(periodMs) || periodMs < 1)
      throw new Error("Invalid quota parameters.");
    return this.db.transaction(() => {
      this.db.query("DELETE FROM rate_limits WHERE expires_at<=?").run(now);
      const row = this.db.query(`INSERT INTO rate_limits (key,window_start,expires_at,count)
        SELECT ?,?,?,1 WHERE EXISTS (SELECT 1 FROM rate_limits WHERE key=?) OR (SELECT count(*) FROM rate_limits)<10000
        ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count`).get(key, now, now + periodMs, key) as { count: number } | null;
      return Boolean(row && row.count <= limit);
    })();
  }
}
